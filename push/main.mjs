// Entry point for the kampus-push systemd service on the VM. Wires the worker core to ImapFlow, web-push, the
// Кампус Поща API and the service's private state directory, and listens for sync messages on 127.0.0.1:8994 only.
import http from 'node:http';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import webpush from 'web-push';
import { openSealed } from '../lib/push-crypto.mjs';
import { createWorker, syncHandler } from './worker.mjs';

const env = name => {
  if (!process.env[name]) throw new Error(name + ' is required');
  return process.env[name];
};
const privateKey = env('PUSH_PRIVATE_KEY');
const secret = env('PUSH_SYNC_SECRET');
const token = env('PUSH_WORKER_TOKEN');
const api = env('PUSH_API_URL').replace(/\/$/, '');
const dir = env('STATE_DIRECTORY');
webpush.setVapidDetails(api, env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));

const readJson = name => { try { return JSON.parse(readFileSync(dir + '/' + name, 'utf8')); } catch { return {}; } };
const writeJson = (name, value) => {
  writeFileSync(dir + '/' + name + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(dir + '/' + name + '.tmp', dir + '/' + name);
};
const log = (...args) => console.log(...args);

async function callApi(action, body = {}) {
  const response = await fetch(api + '/api/push/' + action, {
    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  });
  if (!response.ok) throw new Error('api ' + action + ' ' + response.status);
  return response.json();
}

const worker = createWorker({
  openBox: (account, box) => openSealed(privateKey, account, box),
  async connectImap({ user, password }) {
    const client = new ImapFlow({
      host: process.env.IMAP_HOST || 'tusmail.tu-sofia.bg', port: 993, secure: true, auth: { user, pass: password },
      logger: false, maxIdleTime: 25 * 60_000, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 35 * 60_000,
    });
    client.on('error', error => log('imap socket', error?.code || error?.message));
    await client.connect();
    return client;
  },
  sendPush: (device, payload) => webpush.sendNotification(device, JSON.stringify(payload), { TTL: 86_400, urgency: 'high', timeout: 10_000 }),
  report: body => callApi('report', body),
  state: readJson('state.json'),
  saveState: state => writeJson('state.json', state),
  log,
});

const saveRecords = () => writeJson('records.json', worker.records());
// Start from what is on disk at once, then take the API's list as the truth (retry until it answers).
for (const [account, record] of Object.entries(readJson('records.json'))) worker.upsert(account, record);
(async function reload(delay = 60_000) {
  try {
    const { accounts } = await callApi('accounts');
    worker.replaceAll(accounts);
    saveRecords();
    log('loaded', accounts.length, 'accounts from the API');
  } catch (error) {
    log('account reload failed, retrying:', error.message);
    setTimeout(() => reload(Math.min(delay * 2, 30 * 60_000)), delay);
  }
})();

http.createServer(syncHandler(worker, secret, saveRecords)).listen(8994, '127.0.0.1', () => log('kampus-push listening on 127.0.0.1:8994'));
setInterval(() => log('status', JSON.stringify(worker.stats())), 30 * 60_000).unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { worker.close(); process.exit(0); });
