// Кампус Поща push worker core. One IMAP connection per subscribed account waits (IDLE) on INBOX; new mail becomes
// a Web Push notification with the sender and subject. Every outside effect (IMAP, push, reports to the API, disk)
// is injected, so tests drive this with fakes. main.mjs wires the real ones.
import { verifyBody } from '../lib/push-crypto.mjs';

const firstRetry = 5_000;
const lastRetry = 5 * 60_000;
const burst = 3; // separate notifications per batch of new mail; the rest become one summary

export function createWorker({ openBox, connectImap, sendPush, report, state = {}, saveState = () => {}, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const accounts = new Map();

  function upsert(account, record) {
    const existing = accounts.get(account);
    if (!record) {
      if (existing) stop(existing);
      accounts.delete(account);
      delete state[account];
      saveState(state);
      return;
    }
    // Same credentials: only the device list changed, keep the live connection.
    if (existing && existing.box === record.box && !existing.stopped) {
      existing.devices = record.devices;
      return;
    }
    let creds;
    try { creds = openBox(account, record.box); } catch {
      log('cannot open box for', account.slice(0, 8));
      return;
    }
    if (existing) stop(existing);
    const entry = { account, box: record.box, devices: [...record.devices], creds, client: null, backoff: firstRetry, stopped: false, timer: null, queue: Promise.resolve() };
    accounts.set(account, entry);
    run(entry);
  }

  function stop(entry) {
    entry.stopped = true;
    clearTimer(entry.timer);
    const client = entry.client;
    entry.client = null;
    client?.close();
  }

  function retry(entry) {
    if (entry.stopped || entry.timer) return;
    entry.client = null;
    entry.timer = setTimer(() => { entry.timer = null; run(entry); }, entry.backoff);
    entry.backoff = Math.min(entry.backoff * 2, lastRetry);
  }

  async function run(entry) {
    if (entry.stopped) return;
    let client;
    try {
      client = await connectImap(entry.creds);
      if (entry.stopped) return client.close();
      entry.client = client;
      client.on('exists', () => schedule(entry));
      client.on('close', () => { if (entry.client === client) retry(entry); });
      await client.mailboxOpen('INBOX', { readOnly: true });
      const uidValidity = String(client.mailbox.uidValidity);
      const saved = state[entry.account];
      // First connection, or the mailbox was rebuilt: start from now, never notify about old mail.
      if (!saved || saved.uidValidity !== uidValidity) {
        state[entry.account] = { uidValidity, lastUid: Number(client.mailbox.uidNext) - 1 };
        saveState(state);
      }
      entry.backoff = firstRetry;
      schedule(entry); // mail that arrived while disconnected
      await entry.queue;
    } catch (error) {
      if (error?.authenticationFailed) return authFailed(entry);
      log('imap error for', entry.account.slice(0, 8), error?.code || error?.message);
      if (client && entry.client === client) client.close();
      retry(entry);
    }
  }

  function schedule(entry) {
    entry.queue = entry.queue.then(() => check(entry)).catch(error => log('check failed', error?.message));
    return entry.queue;
  }

  async function check(entry) {
    const client = entry.client;
    const saved = state[entry.account];
    if (!client || !saved || entry.stopped) return;
    const found = [];
    // Envelope only: UID FETCH ENVELOPE never sets \Seen, so nothing is marked read in TU.
    const seen = Date.now();
    for await (const message of client.fetch(saved.lastUid + 1 + ':*', { uid: true, envelope: true, internalDate: true }, { uid: true })) {
      if (message.uid > saved.lastUid) found.push(message);
    }
    if (!found.length) return;
    found.sort((a, b) => a.uid - b.uid);
    saved.lastUid = found.at(-1).uid;
    saveState(state);
    const shown = found.slice(-burst);
    if (found.length > burst) {
      await notify(entry, { title: 'Кампус Поща', body: '+' + (found.length - burst) + ' нови писма във Входящи', tag: 'kampus-summary', folder: 'INBOX' });
    }
    for (const message of shown) {
      const started = Date.now();
      await notify(entry, payloadFor(message, saved.uidValidity));
      // Where time goes: TU storing the mail → this worker hearing of it → the push service accepting it.
      const arrived = message.internalDate ? new Date(message.internalDate).getTime() : null;
      log('notified', entry.account.slice(0, 8), 'uid', message.uid, arrived ? 'heard ' + Math.round((seen - arrived) / 1000) + 's after TU stored it,' : '', 'push accepted in ' + (Date.now() - started) + 'ms');
    }
  }

  async function notify(entry, payload) {
    for (const device of [...entry.devices]) {
      try {
        await sendPush(device, payload);
      } catch (error) {
        // 404/410: the browser dropped this subscription for good.
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          entry.devices = entry.devices.filter(item => item.endpoint !== device.endpoint);
          await report({ account: entry.account, event: 'gone', endpoint: device.endpoint }).catch(() => {});
        } else log('push failed', error?.statusCode || error?.message);
      }
    }
  }

  async function authFailed(entry) {
    stop(entry);
    log('login rejected for', entry.account.slice(0, 8));
    await report({ account: entry.account, event: 'auth_failed' }).catch(() => {});
    await notify(entry, { title: 'Кампус Поща', body: 'Влезте отново в Кампус Поща, за да получавате известия.', tag: 'kampus-login' });
  }

  // Replace the whole set (after a restart, from the API): start new accounts, drop missing ones.
  function replaceAll(list) {
    const wanted = new Set(list.map(item => item.account));
    for (const account of accounts.keys()) if (!wanted.has(account)) upsert(account, null);
    for (const item of list) upsert(item.account, item.record);
  }

  return {
    upsert, replaceAll, check: account => schedule(accounts.get(account)),
    records: () => Object.fromEntries([...accounts].map(([account, entry]) => [account, { box: entry.box, devices: entry.devices }])),
    stats: () => ({ accounts: accounts.size, connected: [...accounts.values()].filter(entry => entry.client).length }),
    close: () => accounts.forEach(stop),
  };
}

export function payloadFor(message, uidValidity) {
  const from = message.envelope?.from?.[0];
  return {
    title: (from?.name || from?.address || 'Ново писмо').slice(0, 120),
    body: (message.envelope?.subject || '(без тема)').slice(0, 200),
    folder: 'INBOX', epoch: String(uidValidity), uid: message.uid,
  };
}

// HTTP handler for 127.0.0.1:8994/sync: the API's signed "this account changed" message.
export function syncHandler(worker, secret, onChange = () => {}) {
  return (request, response) => {
    if (request.method !== 'POST' || request.url !== '/sync') return response.writeHead(404).end();
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 64_000) request.destroy();
    });
    request.on('end', () => {
      if (!verifyBody(secret, body, request.headers['x-kampus-signature'])) return response.writeHead(401).end();
      const { account, record } = JSON.parse(body);
      const validRecord = record === null || (record && typeof record.box === 'string' && Array.isArray(record.devices) && record.devices.length <= 5);
      if (!/^[a-f0-9]{64}$/.test(account) || !validRecord) return response.writeHead(400).end();
      worker.upsert(account, record);
      onChange();
      response.writeHead(200).end();
    });
  };
}
