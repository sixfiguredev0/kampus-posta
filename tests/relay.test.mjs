import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { makeMailbox } from '../lib/mail.mjs';

// Minimal IMAP fixture: enough for login and folder listing.
const imap = net.createServer(socket => {
  socket.write('* OK [CAPABILITY IMAP4rev1] Fixture ready\r\n');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\r\n')) {
      const line = buffer.slice(0, buffer.indexOf('\r\n'));
      buffer = buffer.slice(line.length + 2);
      const [, tag, command] = line.match(/^(\S+)\s+(.*)$/) || [];
      if (!command) continue;
      if (/^LIST "" ""$/i.test(command)) socket.write('* LIST (\\Noselect) "/" ""\r\n');
      else if (/^(LIST|LSUB)/i.test(command)) socket.write('* LIST () "/" "INBOX"\r\n* LIST (\\Trash) "/" "Trash"\r\n');
      else if (/^CAPABILITY/i.test(command)) socket.write('* CAPABILITY IMAP4rev1\r\n');
      if (/^LOGOUT/i.test(command)) socket.end('* BYE\r\n' + tag + ' OK\r\n');
      else socket.write(tag + ' OK Done\r\n');
    }
  });
});
await new Promise(resolve => imap.listen(0, '127.0.0.1', resolve));
const target = '127.0.0.1:' + imap.address().port;

const secret = 'test-secret-'.padEnd(40, 'x');
process.env.RELAY_SECRET = secret;
process.env.RELAY_TARGETS = target;
const { createRelay } = await import('../relay/relay.mjs');
const relay = createRelay();
await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
const relayPort = relay.address().port;

function connect(path, auth) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: relayPort, method: 'CONNECT', path,
      headers: auth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(auth).toString('base64') } : {} });
    request.once('connect', (response, socket, head) => {
      if (head?.length) socket.unshift(head);
      resolve({ status: response.statusCode, socket });
    });
    request.once('error', reject);
    request.end();
  });
}

test.after(() => { relay.close(); imap.close(); });

test('relay requires the secret and only tunnels to allowlisted targets', async () => {
  const anonymous = await connect(target);
  assert.equal(anonymous.status, 407);
  anonymous.socket.destroy();
  const wrong = await connect(target, 'kampus:not-the-secret');
  assert.equal(wrong.status, 407);
  wrong.socket.destroy();
  const elsewhere = await connect('example.com:25', 'kampus:' + secret);
  assert.equal(elsewhere.status, 403);
  elsewhere.socket.destroy();

  const allowed = await connect(target, 'kampus:' + secret);
  assert.equal(allowed.status, 200);
  const greeting = await new Promise(resolve => allowed.socket.once('data', chunk => resolve(chunk.toString())));
  assert.match(greeting, /^\* OK/);
  allowed.socket.destroy();
});

test('the IMAP client reaches the mailbox through the relay via its proxy option', async () => {
  const [host, port] = target.split(':');
  const mailbox = makeMailbox({ user: 'student@tu-sofia.bg', password: 'fixture' }, {
    imap: { host, port: Number(port), secure: false, doSTARTTLS: false },
    smtp: { host: '127.0.0.1', port: 9, secure: false, ignoreTLS: true },
    proxy: 'http://kampus:' + encodeURIComponent(secret) + '@127.0.0.1:' + relayPort,
  });
  const folders = await mailbox.folders();
  assert.deepEqual(folders.map(folder => folder.path), ['INBOX', 'Trash']);
});
