// Tells the push worker on the VM about a changed account. The worker listens only on 127.0.0.1:8994; Vercel
// reaches it through the mail relay it already uses (CONNECT 127.0.0.1:8994), so the VM opens no new port.
import http from 'node:http';
import net from 'node:net';
import { tunnel } from './mail.mjs';
import { signBody } from './push-crypto.mjs';

const workerHost = '127.0.0.1';
const workerPort = 8994;

// record: { box, devices } or null to drop the account. Resolves true when the worker confirmed it.
export async function syncWorker(account, record, { proxy = process.env.MAIL_PROXY, secret = process.env.PUSH_SYNC_SECRET } = {}) {
  if (!secret) return false;
  const body = JSON.stringify({ ts: Date.now(), account, record });
  try {
    const socket = proxy ? await tunnel(proxy, workerHost, workerPort) : net.connect({ host: workerHost, port: workerPort });
    return await new Promise(resolve => {
      const request = http.request({
        createConnection: () => socket, host: workerHost, port: workerPort, method: 'POST', path: '/sync',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Kampus-Signature': signBody(secret, body), Connection: 'close' },
      }, response => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.setTimeout(8000, () => request.destroy());
      request.once('error', () => resolve(false));
      request.end(body);
    });
  } catch {
    // A missed sync is recovered when the worker next reloads all accounts from /api/push/accounts.
    return false;
  }
}
