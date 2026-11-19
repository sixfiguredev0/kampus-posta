// Кампус Поща mail relay: an HTTP CONNECT tunnel to TU's mail servers only.
// TU drops traffic from AWS (where Vercel runs); this lets the app's IMAPS/SMTP sockets leave from a host TU accepts.
// The tunnel carries TLS end to end (IMAPS, SMTP STARTTLS), so the relay never sees mail or passwords.
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const secret = process.env.RELAY_SECRET || '';
if (secret.length < 32) throw new Error('RELAY_SECRET must be at least 32 characters');
const port = Number(process.env.RELAY_PORT || 8993);
const host = process.env.RELAY_HOST || '0.0.0.0';
const targets = new Set((process.env.RELAY_TARGETS || 'tusmail.tu-sofia.bg:993,smtp.tu-sofia.bg:27').split(',').map(value => value.trim().toLowerCase()));
const maxOpen = Number(process.env.RELAY_MAX_OPEN || 40);
const maxPerMinute = Number(process.env.RELAY_MAX_PER_MINUTE || 120);
const idleMs = 5 * 60_000;
const expected = Buffer.from('Basic ' + Buffer.from('kampus:' + secret).toString('base64'));

let open = 0;
let windowStart = Date.now();
let windowCount = 0;

function authorized(header) {
  const given = Buffer.from(header || '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function refuse(socket, code, text) {
  socket.end('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\n\r\n');
}

export function createRelay() {
  const server = http.createServer((request, response) => {
    response.writeHead(405, { Connection: 'close' }).end();
  });
  server.on('connect', (request, client, head) => {
    client.on('error', () => {});
    if (!authorized(request.headers['proxy-authorization'])) return refuse(client, 407, 'Proxy Authentication Required');
    const target = String(request.url || '').toLowerCase();
    if (!targets.has(target)) return refuse(client, 403, 'Forbidden');
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); windowCount = 0; }
    if (open >= maxOpen || ++windowCount > maxPerMinute) return refuse(client, 429, 'Too Many Requests');
    const [targetHost, targetPort] = target.split(':');
    open++;
    let closed = false;
    const upstream = net.connect({ host: targetHost, port: Number(targetPort) });
    const close = () => {
      if (closed) return;
      closed = true;
      open--;
      client.destroy();
      upstream.destroy();
    };
    upstream.setTimeout(idleMs, close);
    client.setTimeout(idleMs, close);
    upstream.once('error', () => { if (!client.writableEnded) refuse(client, 502, 'Bad Gateway'); close(); });
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    client.once('close', close);
    upstream.once('close', close);
  });
  return server;
}

// Start only when run directly (systemd); tests import createRelay().
if (process.argv[1]?.endsWith('relay.mjs')) {
  createRelay().listen(port, host, () => console.log('kampus-relay listening on ' + host + ':' + port + ' for ' + [...targets].join(', ')));
}
