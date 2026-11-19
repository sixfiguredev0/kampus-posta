// Notification sign-ups. Vercel keeps, per account: the devices (Web Push subscriptions) and a sealed box with the
// TU login that only the VM push worker can open. Every change is forwarded to the worker immediately.
import { createHash, timingSafeEqual } from 'node:crypto';
import { MailError } from './mail.mjs';
import { sealForWorker } from './push-crypto.mjs';
import { syncWorker } from './push-sync.mjs';
import { get, put, remove } from './store.mjs';

const day = 86_400_000;
const keep = 90 * day; // dropped after 90 days without a sign-in, so stale passwords do not linger
const maxDevices = 5;
const indexKey = 'push:index';
const recordKey = account => 'push:' + account;
// Only the browsers' own push services; anything else would let a caller make the worker POST to arbitrary hosts.
const pushHosts = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

export function pushEnabled() {
  return Boolean(process.env.PUSH_WORKER_PUBLIC_KEY && process.env.NEXT_PUBLIC_VAPID_KEY && process.env.PUSH_SYNC_SECRET);
}

function check(test, code = 'invalid_request', status = 400) {
  if (!test) throw new MailError(code, status);
}

export function validSubscription(sub) {
  let url;
  try { url = new URL(sub?.endpoint); } catch { return false; }
  const b64 = /^[A-Za-z0-9_-]+={0,2}$/;
  return url.protocol === 'https:' && pushHosts.test(url.hostname) && sub.endpoint.length <= 1000
    && typeof sub.keys?.p256dh === 'string' && b64.test(sub.keys.p256dh) && sub.keys.p256dh.replace(/=+$/, '').length === 87
    && typeof sub.keys?.auth === 'string' && b64.test(sub.keys.auth) && sub.keys.auth.replace(/=+$/, '').length === 22;
}

const workerView = record => ({ box: record.box, devices: record.devices.map(({ endpoint, keys }) => ({ endpoint, keys })) });

async function save(account, record) {
  record.touched = Date.now();
  await put(recordKey(account), record, Date.now() + keep);
  return syncWorker(account, record.status === 'auth_failed' ? null : workerView(record));
}

async function index() {
  return (await get(indexKey)) || [];
}

export async function pushStatus(session, endpoint) {
  const record = await get(recordKey(session.account));
  return {
    enabled: pushEnabled(), vapidKey: process.env.NEXT_PUBLIC_VAPID_KEY || null,
    devices: record?.devices.length || 0, status: record?.status || null,
    thisDevice: Boolean(endpoint && record?.devices.some(device => device.endpoint === endpoint)),
  };
}

export async function subscribe(session, subscription) {
  check(pushEnabled(), 'push_disabled', 503);
  check(validSubscription(subscription), 'invalid_subscription');
  const accounts = await index();
  if (!accounts.includes(session.account)) {
    check(accounts.length < Number(process.env.PUSH_MAX_ACCOUNTS || 25), 'push_full', 429);
    await put(indexKey, [...accounts, session.account]);
  }
  const record = (await get(recordKey(session.account))) || { devices: [] };
  const device = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, added: Date.now() };
  record.devices = [...record.devices.filter(item => item.endpoint !== device.endpoint), device].slice(-maxDevices);
  record.box = sealForWorker(process.env.PUSH_WORKER_PUBLIC_KEY, session.account, { user: session.user, password: session.password });
  record.status = null;
  return { synced: await save(session.account, record), devices: record.devices.length };
}

export async function unsubscribe(account, endpoint) {
  check(typeof endpoint === 'string' && endpoint.length <= 1000);
  const record = await get(recordKey(account));
  if (!record) return { synced: true, devices: 0 };
  record.devices = record.devices.filter(device => device.endpoint !== endpoint);
  if (record.devices.length) return { synced: await save(account, record), devices: record.devices.length };
  await remove(recordKey(account));
  await put(indexKey, (await index()).filter(item => item !== account));
  return { synced: await syncWorker(account, null), devices: 0 };
}

// A new sign-in carries the current password: reseal it so notifications survive a password change, and re-enable
// an account the worker disabled after a failed IMAP login.
export async function refreshOnLogin(session) {
  if (!pushEnabled()) return;
  const record = await get(recordKey(session.account));
  if (!record) return;
  record.box = sealForWorker(process.env.PUSH_WORKER_PUBLIC_KEY, session.account, { user: session.user, password: session.password });
  record.status = null;
  await save(session.account, record);
}

function workerAuthorized(request) {
  const expected = process.env.PUSH_WORKER_TOKEN;
  const header = request.headers.get('authorization') || '';
  if (!expected || expected.length < 32 || !header.startsWith('Bearer ')) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(expected));
}

// Worker-only endpoints: the full account list (after a worker restart) and rare problem reports.
export async function serveWorker(request, action) {
  const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!pushEnabled() || !process.env.PUSH_WORKER_TOKEN) return reply({ error: 'push_disabled' }, 503);
  if (!workerAuthorized(request)) return reply({ error: 'unauthorized' }, 401);
  if (action === 'accounts') {
    const accounts = [];
    const kept = [];
    for (const account of await index()) {
      const record = await get(recordKey(account));
      if (!record) continue;
      kept.push(account);
      if (record.status !== 'auth_failed') accounts.push({ account, record: workerView(record) });
    }
    await put(indexKey, kept);
    return reply({ accounts });
  }
  if (action === 'report') {
    const body = await request.json().catch(() => ({}));
    if (typeof body.account !== 'string' || !/^[a-f0-9]{64}$/.test(body.account)) return reply({ error: 'invalid_request' }, 400);
    const record = await get(recordKey(body.account));
    if (!record) return reply({ ok: true });
    if (body.event === 'auth_failed') {
      record.status = 'auth_failed';
      await put(recordKey(body.account), record, Date.now() + keep);
    } else if (body.event === 'gone' && typeof body.endpoint === 'string') {
      record.devices = record.devices.filter(device => device.endpoint !== body.endpoint);
      if (record.devices.length) await put(recordKey(body.account), record, Date.now() + keep);
      else {
        await remove(recordKey(body.account));
        await put(indexKey, (await index()).filter(item => item !== body.account));
      }
    } else return reply({ error: 'invalid_request' }, 400);
    return reply({ ok: true });
  }
  return reply({ error: 'not_found' }, 404);
}
