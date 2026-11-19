import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

process.env.MAIL_MODE = 'local';
process.env.MAIL_DATA_DIRECTORY = await mkdtemp(join(tmpdir(), 'campus-mail-test-'));
process.env.APP_KEY = Buffer.alloc(32, 42).toString('base64');
const { serveMail } = await import('../lib/mail-api.mjs');

test('portal isolates account state and handles uncertain sends and Sent-copy retries', async () => {
  const file = Buffer.alloc(5_000_013, 29);
  const message = {
    id: 'fixture-message', uid: 1, epoch: '77', folder: 'INBOX', subject: 'Проверка', unread: true,
    messageId: '<m1@tu-sofia.bg>', date: '2026-11-01T10:00:00.000Z', from: [{ name: 'Тест', address: 't@tu-sofia.bg' }],
  };
  let submits = 0;
  let copies = 0;
  const flagCalls = [];
  const createMailbox = () => ({
    async verify() {},
    async list() { return { messages: [{ ...message }], cursor: null }; },
    async read(folder, epoch, uid, options) { return { ...message, unread: !options?.markRead, text: 'Здравейте' }; },
    async setFlags(folder, epoch, uids, flags) { flagCalls.push([uids, flags]); return { success: true }; },
    async move(folder, epoch, uids, target) { return { folder: target, epoch: '88', uidMap: { 1: 41 } }; },
    async trash(folder, epoch, uids) { return this.move(folder, epoch, uids, 'Trash'); },
    async deleteForever() { return { success: true }; },
    async file() { return { name: 'проверка.bin', type: 'application/octet-stream', preview: false, body: ReadableStream.from([file]) }; },
    async submit(raw, envelope) {
      submits++;
      if (submits === 2) throw Object.assign(new Error('socket closed after DATA'), { code: 'ECONNECTION' });
      return { accepted: envelope.to, rejected: [] };
    },
    async saveSent() {
      copies++;
      if (copies === 1) throw new Error('IMAP temporarily unavailable');
    },
  });

  async function call(action, body = {}, cookie, origin = 'http://tusmail.localhost:3000') {
    const request = new Request('http://tusmail.localhost:3000/api/mail/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    return serveMail(request, { params: { action } }, createMailbox);
  }
  async function login(user) {
    const result = await call('login', { user, password: 'fixture' });
    assert.equal(result.status, 200);
    const cookie = result.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    return cookie.split(';')[0];
  }
  const first = await login('first@tu-sofia.bg');
  const second = await login('second@tu-sofia.bg');
  const listing = { folder: 'INBOX', query: '' };
  assert.equal((await call('list', listing)).status, 401);
  assert.equal((await call('list', listing, first, 'http://elsewhere.test')).status, 403);
  assert.equal((await call('session', {}, first, 'http://tusmail.localhost:3001')).status, 200);
  assert.equal((await call('session', {}, first, 'http://tusmail.localhost:3002')).status, 403);
  // Reading preserves TU's unread flag unless the reader explicitly asks to mark it read.
  assert.equal((await (await call('read', message, first)).json()).unread, true);
  assert.equal((await (await call('read', { ...message, markRead: true }, first)).json()).unread, false);

  // Flags: only \Seen and \Flagged, at most 200 UIDs per call.
  const ref = { folder: 'INBOX', epoch: '77', uids: [1] };
  assert.equal((await call('flags', { ...ref, add: ['\\Flagged'] }, first)).status, 200);
  assert.deepEqual(flagCalls.at(-1), [[1], { add: ['\\Flagged'], remove: [] }]);
  assert.equal((await call('flags', { ...ref, add: ['\\Deleted'] }, first)).status, 400);
  assert.equal((await call('flags', { ...ref, uids: Array.from({ length: 201 }, (_, i) => i + 1), add: ['\\Seen'] }, first)).status, 400);

  // Labels are per account: presets exist, one account cannot use or see another account's labels.
  const firstLabels = (await (await call('labels', {}, first)).json()).labels;
  const secondLabels = (await (await call('labels', {}, second)).json()).labels;
  assert.equal(firstLabels.length, 4);
  assert.ok(firstLabels.every(label => !secondLabels.some(other => other.id === label.id)));
  const study = firstLabels[0].id;
  assert.equal((await call('label', { op: 'add', label: study, messages: [message] }, first)).status, 200);
  assert.equal((await call('label', { op: 'add', label: study, messages: [message] }, second)).status, 400);
  assert.deepEqual((await (await call('list', listing, first)).json()).messages[0].labels, [study]);
  assert.deepEqual((await (await call('list', listing, second)).json()).messages[0].labels, []);
  assert.equal((await (await call('label-list', { label: study }, second)).json()).messages.length, 0);

  // Moving a labelled message keeps the label pointing at its new folder and UID.
  const moved = await (await call('move', { ...ref, target: 'Archive' }, first)).json();
  assert.deepEqual(moved, { folder: 'Archive', epoch: '88', uidMap: { 1: 41 } });
  const labelledRows = (await (await call('label-list', { label: study }, first)).json()).messages;
  assert.equal(labelledRows[0].folder, 'Archive');
  assert.equal(labelledRows[0].uid, 41);

  const downloaded = await call('attachment', { ...message, part: '2' }, first);
  assert.equal(downloaded.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), file);
  await call('draft', { draft: { to: 'one@example.test', text: 'Draft' } }, first);
  assert.equal((await (await call('draft', {}, second)).json()).draft, null);

  const draft = { to: 'one@example.test', subject: 'Test', text: 'Hello' };
  const attempt = randomUUID();
  const accepted = await (await call('send', { attempt, draft }, first)).json();
  assert.equal(accepted.status, 'copy_pending');
  assert.equal((await call('send-status', { attempt }, second)).status, 404);
  const repeated = await (await call('send', { attempt, draft }, first)).json();
  assert.equal(repeated.status, 'copy_pending');
  const copied = await (await call('retry-copy', { attempt }, first)).json();
  assert.equal(copied.status, 'sent');
  assert.equal(submits, 1);
  assert.equal(copies, 2);

  const interrupted = randomUUID();
  assert.equal((await (await call('send', { attempt: interrupted, draft }, first)).json()).status, 'unknown');
  assert.equal((await (await call('send', { attempt: interrupted, draft }, first)).json()).status, 'unknown');
  assert.equal(submits, 2);

  assert.equal((await call('logout', {}, first)).status, 200);
  assert.equal((await call('session', {}, first)).status, 401);
  assert.equal((await call('session', {}, second)).status, 200);
});

test('TU_ALLOWED_USERS: "*" admits any @tu-sofia.bg address, a list restricts, other domains never pass', async () => {
  const login = (user, allowed) => {
    process.env.TU_ALLOWED_USERS = allowed;
    return serveMail(new Request('http://tusmail.localhost:3000/api/mail/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://tusmail.localhost:3000' },
      body: JSON.stringify({ user, password: 'fixture' }),
    }), { params: { action: 'login' } }, () => ({ async verify() {} }));
  };
  try {
    assert.equal((await login('anyone@tu-sofia.bg', '*')).status, 200);
    assert.equal((await login('someone@gmail.com', '*')).status, 401);
    assert.equal((await login('other@tu-sofia.bg', 'only@tu-sofia.bg')).status, 401);
    assert.equal((await login('only@tu-sofia.bg', 'only@tu-sofia.bg')).status, 200);
  } finally {
    delete process.env.TU_ALLOWED_USERS;
  }
});
