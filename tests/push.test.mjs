import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.MAIL_MODE = 'local';
process.env.MAIL_DATA_DIRECTORY = await mkdtemp(join(tmpdir(), 'campus-push-test-'));
process.env.APP_KEY = Buffer.alloc(32, 9).toString('base64');
const crypto = await import('../lib/push-crypto.mjs');
const keys = crypto.workerKeyPair();
process.env.PUSH_WORKER_PUBLIC_KEY = keys.publicKey;
process.env.NEXT_PUBLIC_VAPID_KEY = 'B' + 'A'.repeat(86);
process.env.PUSH_SYNC_SECRET = 's'.repeat(40);
process.env.PUSH_WORKER_TOKEN = 't'.repeat(40);
process.env.PUSH_MAX_ACCOUNTS = '2';
delete process.env.MAIL_PROXY;
const { serveMail } = await import('../lib/mail-api.mjs');
const { serveWorker, refreshOnLogin } = await import('../lib/push.mjs');
const { createWorker, payloadFor, syncHandler } = await import('../push/worker.mjs');
const { accountId } = await import('../lib/store.mjs');

const subscription = n => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/device-' + n, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });

test('sealed boxes open only with the worker key and the same account', () => {
  const box = crypto.sealForWorker(keys.publicKey, 'acct-1', { user: 'a@tu-sofia.bg', password: 'p' });
  assert.deepEqual(crypto.openSealed(keys.privateKey, 'acct-1', box), { user: 'a@tu-sofia.bg', password: 'p' });
  assert.throws(() => crypto.openSealed(keys.privateKey, 'acct-2', box));
  assert.throws(() => crypto.openSealed(crypto.workerKeyPair().privateKey, 'acct-1', box));
  const parts = box.split('.');
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => crypto.openSealed(keys.privateKey, 'acct-1', parts.join('.')));
  assert.notEqual(crypto.sealForWorker(keys.publicKey, 'acct-1', {}), crypto.sealForWorker(keys.publicKey, 'acct-1', {}));
});

test('sync signatures reject tampering and stale messages', () => {
  const body = JSON.stringify({ ts: Date.now(), account: 'x' });
  const signature = crypto.signBody('k'.repeat(40), body);
  assert.ok(crypto.verifyBody('k'.repeat(40), body, signature));
  assert.ok(!crypto.verifyBody('k'.repeat(40), body.replace('x', 'y'), signature));
  assert.ok(!crypto.verifyBody('j'.repeat(40), body, signature));
  assert.ok(!crypto.verifyBody('k'.repeat(40), body, signature, Date.now() + 120_000));
});

test('subscribing seals the login, syncs the worker, and keeps accounts apart', async () => {
  // A real worker sync endpoint on 127.0.0.1:8994 (no MAIL_PROXY in tests), recording what it receives.
  const received = [];
  const fakeWorker = { upsert: (account, record) => received.push({ account, record }) };
  const server = http.createServer(syncHandler(fakeWorker, process.env.PUSH_SYNC_SECRET));
  await new Promise(resolve => server.listen(8994, '127.0.0.1', resolve));
  try {
    const createMailbox = () => ({ async verify() {} });
    async function call(action, body = {}, cookie) {
      return serveMail(new Request('http://tusmail.localhost:3000/api/mail/' + action, {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Origin: 'http://tusmail.localhost:3000', ...(cookie ? { Cookie: cookie } : {}) },
      }), { params: { action } }, createMailbox);
    }
    const login = async (user, password) => (await call('login', { user, password })).headers.get('set-cookie').split(';')[0];
    const first = await login('first@tu-sofia.bg', 'one');
    const second = await login('second@tu-sofia.bg', 'two');
    const third = await login('third@tu-sofia.bg', 'three');

    assert.equal((await call('push-subscribe', { subscription: subscription(1) })).status, 401);
    assert.equal((await call('push-subscribe', { subscription: { ...subscription(1), endpoint: 'https://evil.example/x' } }, first)).status, 400);
    assert.equal((await call('push-subscribe', { subscription: { ...subscription(1), keys: { p256dh: 'short', auth: 'A'.repeat(22) } } }, first)).status, 400);

    const ok = await (await call('push-subscribe', { subscription: subscription(1) }, first)).json();
    assert.deepEqual(ok, { synced: true, devices: 1 });
    const firstAccount = accountId('first@tu-sofia.bg');
    const synced = received.at(-1);
    assert.equal(synced.account, firstAccount);
    assert.deepEqual(crypto.openSealed(keys.privateKey, firstAccount, synced.record.box), { user: 'first@tu-sofia.bg', password: 'one' });
    assert.equal(synced.record.devices[0].endpoint, subscription(1).endpoint);

    const status = await (await call('push-status', { endpoint: subscription(1).endpoint }, first)).json();
    assert.equal(status.thisDevice, true);
    assert.equal(status.vapidKey, process.env.NEXT_PUBLIC_VAPID_KEY);

    // The second account cannot remove the first account's device.
    assert.equal((await call('push-subscribe', { subscription: subscription(2) }, second)).status, 200);
    await call('push-unsubscribe', { endpoint: subscription(1).endpoint }, second);
    assert.equal((await (await call('push-status', { endpoint: subscription(1).endpoint }, first)).json()).thisDevice, true);
    // The account cap (2 in this test) holds for a third account.
    assert.equal((await (await call('push-subscribe', { subscription: subscription(3) }, third)).json()).error, 'push_full');

    // A new sign-in reseals the new password.
    await refreshOnLogin({ user: 'first@tu-sofia.bg', password: 'changed', account: firstAccount });
    assert.equal(crypto.openSealed(keys.privateKey, firstAccount, received.at(-1).record.box).password, 'changed');

    // The worker reports a dead device and a rejected login; the API list reflects both.
    const worker = (action, body, token = process.env.PUSH_WORKER_TOKEN) => serveWorker(new Request('http://x/api/push/' + action, {
      method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer ' + token },
    }), action);
    assert.equal((await worker('accounts', {}, 'wrong'.repeat(10))).status, 401);
    assert.equal((await (await worker('accounts', {})).json()).accounts.length, 2);
    await worker('report', { account: accountId('second@tu-sofia.bg'), event: 'gone', endpoint: subscription(2).endpoint });
    await worker('report', { account: firstAccount, event: 'auth_failed' });
    assert.equal((await (await worker('accounts', {})).json()).accounts.length, 0);
    assert.equal((await (await call('push-status', {}, first)).json()).status, 'auth_failed');

    // Turning it off on the last device deletes the record and tells the worker to drop the account.
    assert.equal((await (await call('push-unsubscribe', { endpoint: subscription(1).endpoint }, first)).json()).devices, 0);
    assert.deepEqual(received.at(-1), { account: firstAccount, record: null });
    // Now there is room for the third account.
    assert.equal((await call('push-subscribe', { subscription: subscription(3) }, third)).status, 200);
  } finally {
    server.close();
  }
});

// Fake IMAP client: just enough of ImapFlow for the worker.
function fakeImap(mailbox) {
  const client = new EventEmitter();
  client.mailbox = null;
  client.closed = false;
  client.mailboxOpen = async (path, options) => {
    assert.equal(options.readOnly, true);
    client.mailbox = { uidValidity: mailbox.uidValidity, uidNext: mailbox.messages.length ? mailbox.messages.at(-1).uid + 1 : 1 };
  };
  client.fetch = async function* (range) {
    const low = Number(range.split(':')[0]);
    const matching = mailbox.messages.filter(message => message.uid >= low);
    // IMAP returns the highest message for "n:*" even when n is above it.
    yield* (matching.length ? matching : mailbox.messages.slice(-1));
  };
  client.close = () => { if (!client.closed) { client.closed = true; client.emit('close'); } };
  return client;
}
const mail = (uid, name, subject) => ({ uid, envelope: { from: [{ name, address: 'x@tu-sofia.bg' }], subject } });
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('the worker notifies only about new mail, caps bursts, survives reconnects and drops dead devices', async () => {
  const mailbox = { uidValidity: 500, messages: [mail(1, 'Стар', 'old'), mail(2, 'Стар', 'old')] };
  const sent = [];
  const reports = [];
  const clients = [];
  const timers = [];
  let rejectLogin = false;
  const device = { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: {} };
  const deadDevice = { endpoint: 'https://fcm.googleapis.com/fcm/send/dead', keys: {} };
  const state = {};
  const worker = createWorker({
    openBox: (account, box) => ({ user: box, password: 'p' }),
    connectImap: async () => {
      if (rejectLogin) throw Object.assign(new Error('auth'), { authenticationFailed: true });
      const client = fakeImap(mailbox);
      clients.push(client);
      return client;
    },
    sendPush: async (target, payload) => {
      if (target.endpoint === deadDevice.endpoint) throw Object.assign(new Error('gone'), { statusCode: 410 });
      sent.push(payload);
    },
    report: async body => reports.push(body),
    state,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  const account = 'a'.repeat(64);
  worker.upsert(account, { box: 'me', devices: [device, deadDevice] });
  await settle();
  assert.equal(sent.length, 0, 'mail already in INBOX is not announced');
  assert.equal(state[account].lastUid, 2);

  mailbox.messages.push(mail(3, 'Учебен отдел', 'График'));
  clients.at(-1).emit('exists');
  await settle();
  assert.deepEqual(sent, [payloadFor(mail(3, 'Учебен отдел', 'График'), 500)]);
  assert.deepEqual(reports, [{ account, event: 'gone', endpoint: deadDevice.endpoint }], 'a 410 device is dropped and reported once');

  // A burst of five: one summary for the two oldest, then the three newest.
  for (let uid = 4; uid <= 8; uid++) mailbox.messages.push(mail(uid, 'Подател ' + uid, 'Тема ' + uid));
  clients.at(-1).emit('exists');
  await settle();
  assert.equal(sent.length, 5);
  assert.equal(sent[1].body, '+2 нови писма във Входящи');
  assert.deepEqual(sent.slice(2).map(item => item.uid), [6, 7, 8]);

  // Connection drops; mail arrives meanwhile; the reconnect announces it once.
  clients.at(-1).close();
  mailbox.messages.push(mail(9, 'Докато бях офлайн', 'x'));
  assert.equal(timers.length, 1);
  timers.shift()();
  await settle();
  assert.equal(sent.length, 6);
  assert.equal(sent.at(-1).uid, 9);
  clients.at(-1).emit('exists');
  await settle();
  assert.equal(sent.length, 6, 'no duplicate after reconnect');

  // A rejected login stops the account, reports it, and sends one "sign in again" notice.
  rejectLogin = true;
  clients.at(-1).close();
  timers.shift()();
  await settle();
  assert.deepEqual(reports.at(-1), { account, event: 'auth_failed' });
  assert.match(sent.at(-1).body, /Влезте отново/);
  assert.equal(timers.length, 0, 'no retries after a rejected login');

  // A new box (new password from the API) starts it again without replaying old mail.
  rejectLogin = false;
  worker.upsert(account, { box: 'me-again', devices: [device] });
  await settle();
  assert.equal(sent.length, 7);
  assert.equal(worker.stats().connected, 1);

  worker.upsert(account, null);
  assert.equal(worker.stats().accounts, 0);
  assert.equal(state[account], undefined);
});

test('a rebuilt mailbox (new UIDVALIDITY) starts from now instead of replaying', async () => {
  const mailbox = { uidValidity: 1, messages: [mail(1, 'a', 'a')] };
  const sent = [];
  const state = { ['b'.repeat(64)]: { uidValidity: '999', lastUid: 0 } };
  const worker = createWorker({
    openBox: () => ({}), connectImap: async () => fakeImap(mailbox), sendPush: async (d, p) => sent.push(p),
    report: async () => {}, state, setTimer: () => 0, clearTimer: () => {},
  });
  worker.upsert('b'.repeat(64), { box: 'x', devices: [{ endpoint: 'e', keys: {} }] });
  await settle();
  assert.equal(sent.length, 0);
  assert.deepEqual(state['b'.repeat(64)], { uidValidity: '1', lastUid: 1 });
});
