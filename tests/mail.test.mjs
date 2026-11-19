import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { cleanHtml, composeMail, makeMailbox, messageLimit, readText } from '../lib/mail.mjs';

const attachment = Buffer.alloc(5_000_007, 173);

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.server || server).address().port;
}

function fakeImap(commands) {
  return net.createServer(socket => {
    socket.write('* OK [CAPABILITY IMAP4rev1] Fixture ready\r\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const [, tag, command] = line.match(/^(\S+)\s+(.*)$/) || [];
        if (!command) continue;
        commands.push(command);
        const ok = () => socket.write(tag + ' OK Complete\r\n');
        if (/^CAPABILITY/i.test(command)) {
          socket.write('* CAPABILITY IMAP4rev1\r\n');
          ok();
        } else if (/^LOGIN/i.test(command)) {
          ok();
        } else if (/^LIST "" ""$/i.test(command)) {
          socket.write('* LIST (\\Noselect) "/" ""\r\n');
          ok();
        } else if (/^(LIST|LSUB)/i.test(command)) {
          socket.write('* LIST () "/" "INBOX"\r\n* LIST (\\Sent) "/" "Sent"\r\n* LIST (\\Trash) "/" "Trash"\r\n');
          ok();
        } else if (/^EXAMINE/i.test(command)) {
          socket.write('* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 77] UID validity\r\n* OK [UIDNEXT 2] Next uid\r\n' + tag + ' OK [READ-ONLY] Examined\r\n');
        } else if (/^SELECT/i.test(command)) {
          socket.write('* FLAGS (\\Seen \\Flagged \\Deleted)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 77] UID validity\r\n* OK [UIDNEXT 2] Next uid\r\n' + tag + ' OK [READ-WRITE] Selected\r\n');
        } else if (/^UID STORE/i.test(command)) {
          socket.write('* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n');
          ok();
        } else if (/^UID COPY/i.test(command)) {
          ok();
        } else if (/^(UID )?EXPUNGE/i.test(command)) {
          socket.write('* 1 EXPUNGE\r\n');
          ok();
        } else if (/^UID SEARCH/i.test(command)) {
          socket.write('* SEARCH 1\r\n');
          ok();
        } else if (/BODY\.PEEK\[TEXT\]/i.test(command)) {
          socket.write('* 1 FETCH (UID 1 BODY[TEXT]<0> {13}\r\nHello fixture)\r\n');
          ok();
        } else if (/^UID FETCH/i.test(command)) {
          const fields = 'UID 1 FLAGS () INTERNALDATE "01-Nov-2026 10:00:00 +0000" '
            + 'ENVELOPE ("Sun, 01 Nov 2026 10:00:00 +0000" "Fixture" (("Tester" NIL "test" "tu-sofia.bg")) NIL NIL NIL NIL NIL NIL "<fixture@tu-sofia.bg>") '
            + 'BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 13 1)';
          socket.write('* 1 FETCH (' + fields + ')\r\n');
          ok();
        } else if (/^LOGOUT/i.test(command)) {
          socket.end('* BYE\r\n' + tag + ' OK Logged out\r\n');
        } else {
          socket.write(tag + ' BAD Unexpected command\r\n');
        }
      }
    });
  });
}

test('loopback IMAP lists and opens with EXAMINE and PEEK; SMTP receives the complete attachment', async t => {
  const commands = [];
  const received = [];
  const imap = fakeImap(commands);
  const smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    onAuth: (auth, session, done) => done(null, { user: auth.username }),
    onData(stream, session, done) {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => { received.push(Buffer.concat(chunks)); done(); });
    },
  });
  const imapPort = await listen(imap);
  const smtpPort = await listen(smtp);
  t.after(() => Promise.all([new Promise(resolve => imap.close(resolve)), new Promise(resolve => smtp.close(resolve))]));
  const mailbox = makeMailbox({ user: 'student@tu-sofia.bg', password: 'fixture' }, {
    imap: { host: '127.0.0.1', port: imapPort, secure: false, doSTARTTLS: false },
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true },
  });
  const { messages } = await mailbox.list('INBOX');
  assert.equal(messages[0].unread, true);
  assert.equal(messages[0].subject, 'Fixture');
  const message = await mailbox.read('INBOX', '77', 1);
  assert.equal(message.text, 'Hello fixture');
  assert.equal(message.unread, true);
  assert.equal(commands.filter(command => /^EXAMINE/i.test(command)).length, 2);
  assert.ok(commands.some(command => /BODY\.PEEK\[TEXT\]/i.test(command)));
  assert.ok(!commands.some(command => /^SELECT|STORE|EXPUNGE/i.test(command)));
  const draft = await composeMail({
    from: 'student@tu-sofia.bg', to: 'recipient@example.test', cc: '', bcc: 'private@example.test',
    subject: 'Прикачен файл', text: 'Проверка', date: new Date(0), messageId: '<fixture@tu-sofia.bg>',
    files: [{ name: 'файл.bin', content: attachment }],
  });
  const submitted = await mailbox.submit(draft.raw, draft.envelope);
  assert.deepEqual(submitted.accepted, ['recipient@example.test', 'private@example.test']);
  assert.equal(received.length, 1);
  const parsed = await simpleParser(received[0]);
  assert.equal(parsed.subject, 'Прикачен файл');
  assert.deepEqual(parsed.attachments[0].content, attachment);
  assert.equal(parsed.bcc, undefined);
  assert.equal((await simpleParser(draft.sentRaw)).bcc?.value[0].address, 'private@example.test');
});

test('mailbox actions: mark read on open, flags, move, trash, and permanent delete only from Trash', async t => {
  const commands = [];
  const imap = fakeImap(commands);
  const port = await listen(imap);
  t.after(() => new Promise(resolve => imap.close(resolve)));
  const mailbox = makeMailbox({ user: 'student@tu-sofia.bg', password: 'fixture' }, {
    imap: { host: '127.0.0.1', port, secure: false, doSTARTTLS: false },
    smtp: { host: '127.0.0.1', port: 9, secure: false, ignoreTLS: true },
  });
  const since = () => commands.splice(0);

  const opened = await mailbox.read('INBOX', '77', 1, { markRead: true });
  assert.equal(opened.unread, false);
  let sent = since();
  assert.ok(sent.some(command => /^SELECT/i.test(command)) && sent.some(command => /BODY\.PEEK\[TEXT\]/i.test(command)));
  assert.ok(sent.some(command => /^UID STORE 1 \+FLAGS.*\\Seen/i.test(command)));

  await mailbox.setFlags('INBOX', '77', [1], { add: ['\\Flagged'], remove: ['\\Seen'] });
  sent = since();
  assert.ok(sent.some(command => /^UID STORE 1 \+FLAGS.*\\Flagged/i.test(command)));
  assert.ok(sent.some(command => /^UID STORE 1 -FLAGS.*\\Seen/i.test(command)));

  // No MOVE capability in this fixture: the move falls back to COPY + \Deleted + EXPUNGE.
  await mailbox.trash('INBOX', '77', [1]);
  sent = since();
  assert.ok(sent.some(command => /^UID COPY 1 "?Trash"?$/i.test(command)));
  assert.ok(sent.some(command => /EXPUNGE/i.test(command)));

  await assert.rejects(mailbox.deleteForever('INBOX', '77', [1]), { code: 'not_trash' });
  await mailbox.deleteForever('Trash', '77', [1]);
  assert.ok(since().some(command => /\\Deleted/i.test(command)));
  await assert.rejects(mailbox.setFlags('INBOX', '77', [], { add: ['\\Seen'] }), { code: 'invalid_request' });
});

test('very long bodies are truncated instead of failing the message', async () => {
  const { Readable } = await import('node:stream');
  const result = await readText(Readable.from([Buffer.alloc(700_000, 65), Buffer.alloc(700_000, 66)]), 1_000_000);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 1_000_000);
  assert.deepEqual(await readText(Readable.from([Buffer.from('кратко')]), 1_000_000), { text: 'кратко', truncated: false });
});

test('message sanitization drops external resources and active content', () => {
  const output = cleanHtml('<p>Hello<img src="https://example.test/pixel"><a href="javascript:alert(1)">link</a><script>bad()</script><a href="https://tu-sofia.bg">TU</a></p>');
  assert.equal(output, '<p>Hello<a target="_blank" rel="noopener noreferrer">link</a><a href="https://tu-sofia.bg" target="_blank" rel="noopener noreferrer">TU</a></p>');
});

test('encoded limit includes base64 expansion', async () => {
  await assert.rejects(composeMail({
    from: 'student@tu-sofia.bg', to: 'recipient@example.test', cc: '', bcc: '',
    subject: 'Size', text: '', date: new Date(0), messageId: '<fixture@tu-sofia.bg>',
    files: [{ name: 'large.bin', content: Buffer.alloc(messageLimit * 0.76) }],
  }), { code: 'message_too_large' });
});
