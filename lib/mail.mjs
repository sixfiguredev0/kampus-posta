import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { simpleParser } from 'mailparser';
import sanitizeHtml from 'sanitize-html';

export const messageLimit = 25_000_000;
const pageSize = 25;
const previewTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

export class MailError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function cleanHtml(html) {
  return sanitizeHtml(html, {
    allowedTags: ['p','div','span','br','strong','b','em','i','u','s','blockquote','pre','code','ul','ol','li','a','table','thead','tbody','tr','td','th','hr','h1','h2','h3','h4'],
    allowedAttributes: { a: ['href', 'target', 'rel'], td: ['colspan'], th: ['colspan'] },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false,
    transformTags: { a: (tagName, attributes) => ({ tagName, attribs: { ...attributes, target: '_blank', rel: 'noopener noreferrer' } }) },
  });
}

const defaultEndpoints = {
  imap: { host: 'tusmail.tu-sofia.bg', port: 993, secure: true },
  smtp: { host: 'smtp.tu-sofia.bg', port: 27, secure: false, requireTLS: true },
};

function flattenParts(part, embedded = false) {
  if (!part) return [];
  const special = embedded || part.disposition === 'attachment' || part.type === 'message/rfc822';
  if (part.childNodes?.length && !special) return part.childNodes.flatMap(child => flattenParts(child));
  const inlineFile = part.disposition === 'inline' && !part.type?.startsWith('text/');
  return [{ ...part, attachment: special || inlineFile || Boolean(part.dispositionParameters?.filename || part.parameters?.name) }];
}

function filenames(part) {
  return part.dispositionParameters?.filename || part.parameters?.name || 'приложение';
}

function identity(folder, epoch, uid) {
  return JSON.stringify([folder, epoch, uid]);
}

function mapMessage(folder, epoch, item) {
  const header = item.envelope || {};
  return {
    id: identity(folder, epoch, item.uid), uid: item.uid, folder, epoch,
    from: header.from || [], to: header.to || [], cc: header.cc || [], replyTo: header.replyTo || [],
    subject: header.subject || '', date: (item.internalDate || header.date || new Date(0)).toISOString(),
    unread: !item.flags?.has('\\Seen'), starred: Boolean(item.flags?.has('\\Flagged')), attachment: flattenParts(item.bodyStructure).some(part => part.attachment),
    messageId: header.messageId || '', inReplyTo: header.inReplyTo || '',
  };
}

// Very long bodies are cut at `limit` bytes instead of failing the whole message.
export async function readText(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    chunks.push(chunk);
    if (size > limit) break;
  }
  const buffer = Buffer.concat(chunks);
  return { text: buffer.subarray(0, limit).toString('utf8'), truncated: buffer.length > limit };
}

const batchLimit = 200;
function uidSet(uids) {
  if (!Array.isArray(uids) || !uids.length || uids.length > batchLimit || !uids.every(uid => Number.isSafeInteger(uid) && uid > 0)) {
    throw new MailError('invalid_request');
  }
  return uids.join(',');
}

function specialFolder(folders, use, pattern) {
  return folders.find(folder => folder.specialUse === use) || folders.find(folder => pattern.test(folder.path));
}

export function makeMailbox(credentials, endpoints = defaultEndpoints) {
  const auth = { user: credentials.user, pass: credentials.password };
  // TU drops traffic from AWS (Vercel); MAIL_PROXY routes both sockets through the CONNECT relay in relay/relay.mjs.
  const proxy = endpoints.proxy ?? process.env.MAIL_PROXY;
  const transport = nodemailer.createTransport({
    ...endpoints.smtp, auth, logger: false, debug: false, ...(proxy && { proxy }),
    connectionTimeout: 12000, greetingTimeout: 20000, socketTimeout: 45000,
    disableFileAccess: true, disableUrlAccess: true,
  });

  async function connect(work) {
    const client = new ImapFlow({
      ...endpoints.imap, auth, logger: false, disableAutoIdle: true, ...(proxy && { proxy }),
      connectionTimeout: 12000, greetingTimeout: 15000, socketTimeout: 45000,
    });
    client.on('error', () => {});
    try {
      await client.connect();
      return await work(client);
    } finally {
      if (client.usable) await client.logout().catch(() => client.close());
      else client.close();
    }
  }

  // Reads EXAMINE the folder (read-only); explicit user actions (flags, move, delete) SELECT it.
  async function withFolder(folder, epoch, work, write = false) {
    return connect(async client => {
      const lock = await client.getMailboxLock(folder, { readOnly: !write });
      try {
        if (!write && !client.mailbox.readOnly) throw new MailError('readonly_required', 502);
        const currentEpoch = String(client.mailbox.uidValidity);
        if (epoch && currentEpoch !== epoch) throw new MailError('folder_changed', 409);
        return await work(client, currentEpoch);
      } finally {
        lock.release();
      }
    });
  }

  return {
    verify: () => Promise.all([connect(client => client.list()), transport.verify()]),
    // Real unread counts come from IMAP STATUS, not from whatever rows happen to be loaded.
    folders: () => connect(async client => (await client.list({ statusQuery: { unseen: true } }))
      .filter(folder => !folder.flags.has('\\Noselect'))
      .map(({ path, name, specialUse, status }) => ({ path, name, specialUse, unseen: status?.unseen ?? null }))),
    list(folder, { query = '', before, epoch, filter = '' } = {}) {
      return withFolder(folder, epoch, async (client, currentEpoch) => {
        let highest = before ? before - 1 : Number(client.mailbox.uidNext) - 1;
        const ids = [];
        for (let step = 0; highest > 0 && step < 12 && ids.length < pageSize; step++) {
          const low = Math.max(1, highest - 1999);
          const criteria = { uid: low + ':' + highest };
          if (query) criteria.or = [{ subject: query }, { from: query }];
          if (filter === 'unread') criteria.seen = false;
          if (filter === 'starred') criteria.flagged = true;
          const results = await client.search(criteria, { uid: true });
          if (results) ids.push(...results.sort((a, b) => b - a));
          highest = low - 1;
        }
        const batch = ids.slice(0, pageSize);
        const data = batch.length ? await client.fetchAll(batch.join(','), {
          uid: true, envelope: true, internalDate: true, flags: true, bodyStructure: true,
        }, { uid: true }) : [];
        const nextBefore = ids.length > pageSize ? batch.at(-1) : highest + 1;
        return {
          messages: data.sort((a, b) => b.uid - a.uid).map(item => mapMessage(folder, currentEpoch, item)),
          cursor: nextBefore > 1 ? { before: nextBefore, epoch: currentEpoch } : null,
        };
      });
    },
    read(folder, epoch, uid, { markRead = false } = {}) {
      return withFolder(folder, epoch, async (client, currentEpoch) => {
        const item = await client.fetchOne(String(uid), {
          uid: true, envelope: true, internalDate: true, flags: true, bodyStructure: true, headers: ['references'],
        }, { uid: true });
        if (!item) throw new MailError('missing_message', 404);
        const parts = flattenParts(item.bodyStructure);
        const textPart = parts.find(part => part.type === 'text/plain' && !part.attachment);
        const htmlPart = parts.find(part => part.type === 'text/html' && !part.attachment);
        async function getBody(part) {
          if (!part) return { text: '', truncated: false };
          const file = await client.download(String(uid), part.part || '1', { uid: true, maxBytes: 1_000_001 });
          return file.content ? readText(file.content, 1_000_000) : { text: '', truncated: false };
        }
        const plain = await getBody(textPart);
        const rich = await getBody(htmlPart);
        const html = cleanHtml(rich.text);
        const message = mapMessage(folder, currentEpoch, item);
        // Bodies are downloaded with PEEK; marking read is a separate, explicit STORE.
        if (markRead && message.unread) {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          message.unread = false;
        }
        return {
          ...message, text: plain.text, html, truncated: plain.truncated || rich.truncated,
          references: (item.headers?.toString().match(/<[^<>\s]+>/g) || []).slice(-30),
          files: parts.filter(part => part.attachment).map(part => ({
            part: part.part || '1', name: filenames(part), type: part.type || 'application/octet-stream',
            size: part.size, preview: previewTypes.has(part.type),
          })),
        };
      }, markRead);
    },
    async setFlags(folder, epoch, uids, { add = [], remove = [] } = {}) {
      const range = uidSet(uids);
      return withFolder(folder, epoch, async client => {
        if (add.length) await client.messageFlagsAdd(range, add, { uid: true });
        if (remove.length) await client.messageFlagsRemove(range, remove, { uid: true });
        return { success: true };
      }, true);
    },
    // Moves keep working without the MOVE extension (imapflow falls back to COPY + \Deleted + EXPUNGE).
    async move(folder, epoch, uids, target) {
      const range = uidSet(uids);
      return withFolder(folder, epoch, async client => {
        if (target === folder) throw new MailError('invalid_request');
        const result = await client.messageMove(range, target, { uid: true });
        if (!result) throw new MailError('move_failed', 502);
        return { folder: target, epoch: result.uidValidity ? String(result.uidValidity) : null, uidMap: Object.fromEntries(result.uidMap || []) };
      }, true);
    },
    async trash(folder, epoch, uids) {
      const trash = await connect(async client => specialFolder(await client.list(), '\\Trash', /^(trash|deleted( items| messages)?|кошче)$/i));
      if (!trash) throw new MailError('missing_trash', 409);
      if (trash.path === folder) throw new MailError('already_trash', 409);
      return this.move(folder, epoch, uids, trash.path);
    },
    // Permanent deletion is only possible from the Trash folder itself.
    async deleteForever(folder, epoch, uids) {
      const range = uidSet(uids);
      const trash = await connect(async client => specialFolder(await client.list(), '\\Trash', /^(trash|deleted( items| messages)?|кошче)$/i));
      if (!trash || trash.path !== folder) throw new MailError('not_trash', 409);
      return withFolder(folder, epoch, async client => {
        await client.messageDelete(range, { uid: true });
        return { success: true };
      }, true);
    },
    async file(folder, epoch, uid, requestedPart) {
      let metadata;
      const { Readable, PassThrough } = await import('node:stream');
      const out = new PassThrough();
      out.on('error', () => {});
      const ready = Promise.withResolvers();
      void withFolder(folder, epoch, async client => {
        const item = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
        const part = flattenParts(item?.bodyStructure).find(value => value.attachment && (value.part || '1') === requestedPart);
        if (!part) throw new MailError('missing_attachment', 404);
        if (part.size > messageLimit) throw new MailError('message_too_large', 413);
        const data = await client.download(String(uid), requestedPart, { uid: true, maxBytes: messageLimit });
        if (!data.content) throw new MailError('missing_attachment', 404);
        metadata = { name: filenames(part), type: part.type || 'application/octet-stream', preview: previewTypes.has(part.type) };
        ready.resolve();
        const { pipeline } = await import('node:stream/promises');
        await pipeline(data.content, out);
      }).catch(error => {
        ready.reject(error);
        out.destroy(error);
      });
      await ready.promise;
      return { ...metadata, body: Readable.toWeb(out) };
    },
    async submit(raw, envelope) {
      const result = await transport.sendMail({ raw, envelope });
      return { accepted: result.accepted, rejected: result.rejected };
    },
    saveSent(raw, messageId, waitForAutoCopy = false) {
      return connect(async client => {
        const folders = await client.list();
        const sent = folders.find(folder => folder.specialUse === '\\Sent')
          || folders.find(folder => folder.path.toLowerCase() === 'sent');
        if (!sent) throw new MailError('missing_sent_folder', 502);
        const exists = async () => {
          const lock = await client.getMailboxLock(sent.path, { readOnly: true });
          try {
            const hits = await client.search({ header: { 'Message-ID': messageId } }, { uid: true });
            return Boolean(hits?.length);
          } finally {
            lock.release();
          }
        };
        if (await exists()) return;
        if (waitForAutoCopy) {
          await new Promise(resolve => setTimeout(resolve, 900));
          if (await exists()) return;
        }
        // A successful APPEND means the server stored the copy; a lagging search must not trigger a second append.
        await client.append(sent.path, raw, ['\\Seen']);
      });
    },
  };
}

// Checks only that TU's servers answer with a greeting from where this code runs. No login, no credentials.
// The detail says why a port failed: "timeout" (silently dropped, typical of a firewall), a socket code such as
// ECONNREFUSED/ENOTFOUND, or "greeting" (connected but the server said something unexpected).
export async function probe(endpoints = defaultEndpoints) {
  const proxy = endpoints.proxy ?? process.env.MAIL_PROXY;
  // Through the relay the probe checks the same path the mail clients use; the relay's address is never reported.
  const raw = (host, port) => proxy ? tunnel(proxy, host, port) : net.connect({ host, port });
  const greet = async (open, expect) => {
    const started = Date.now();
    let socket;
    try { socket = await open(); } catch (error) { return { ok: false, reason: error.code || 'proxy', ms: Date.now() - started }; }
    return new Promise(resolve => {
      const finish = (ok, reason) => { socket.destroy(); resolve({ ok, reason, ms: Date.now() - started, via: proxy ? 'relay' : 'direct' }); };
      socket.setTimeout(8000, () => finish(false, 'timeout'));
      socket.once('error', error => finish(false, error.code || 'error'));
      socket.once('data', chunk => finish(expect.test(chunk.toString()), expect.test(chunk.toString()) ? 'ok' : 'greeting'));
    });
  };
  const [imap, smtp] = await Promise.all([
    greet(async () => tls.connect({ socket: await raw(endpoints.imap.host, endpoints.imap.port), servername: endpoints.imap.host }), /^\* OK/),
    greet(() => raw(endpoints.smtp.host, endpoints.smtp.port), /^220/),
  ]);
  return { imap: imap.ok, smtp: smtp.ok, detail: { imap, smtp, region: process.env.VERCEL_REGION || 'local' } };
}

// Opens an HTTP CONNECT tunnel, the same mechanism ImapFlow and Nodemailer use with their `proxy` option.
export function tunnel(proxyUrl, host, port) {
  const proxy = new URL(proxyUrl);
  const credentials = Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
  return new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: host + ':' + port, headers: { 'Proxy-Authorization': 'Basic ' + credentials } });
    request.setTimeout(8000, () => request.destroy(Object.assign(new Error('proxy timeout'), { code: 'proxy_timeout' })));
    request.once('connect', (response, socket, head) => {
      // Bytes that arrived with the 200 (often the server greeting) come separately; put them back on the stream.
      if (head?.length) socket.unshift(head);
      if (response.statusCode === 200) return resolve(socket);
      socket.destroy();
      reject(Object.assign(new Error('proxy refused'), { code: 'proxy_' + response.statusCode }));
    });
    request.once('error', reject);
    request.end();
  });
}

export function parseRecipients(value) {
  if (typeof value !== 'string' || value.length > 8000 || /[\r\n]/.test(value)) throw new MailError('invalid_recipients');
  const recipients = addressparser(value, { flatten: true });
  if (value.trim() && (!recipients.length || recipients.some(entry => !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(entry.address || '')))) {
    throw new MailError('invalid_recipients');
  }
  return recipients;
}

export async function composeMail({ from, to, cc, bcc, subject, text, files, messageId, inReplyTo, references, date }) {
  const sender = parseRecipients(from);
  const recipients = [parseRecipients(to), parseRecipients(cc), parseRecipients(bcc)];
  const envelope = { from: sender[0]?.address, to: [...new Set(recipients.flat().map(value => value.address))] };
  if (sender.length !== 1 || !envelope.to.length || envelope.to.length > 40) throw new MailError('invalid_recipients');
  if (typeof subject !== 'string' || subject.length > 400 || /[\r\n]/.test(subject) || typeof text !== 'string' || text.length > 200000) throw new MailError('invalid_message');
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const headers = {
    from, to: recipients[0], cc: recipients[1], subject, text, messageId, date,
    inReplyTo: validMessageId(inReplyTo) ? inReplyTo : undefined,
    references: Array.isArray(references) ? references.filter(validMessageId).slice(-30) : [],
    attachments: files.map(file => ({ filename: file.name, content: file.content })),
    disableFileAccess: true, disableUrlAccess: true,
  };
  const { message: raw } = await composer.sendMail(headers);
  if (raw.length > messageLimit) throw new MailError('message_too_large', 413);
  const { message: sentRaw } = recipients[2].length
    ? await composer.sendMail({ ...headers, bcc: recipients[2], keepBcc: true })
    : { message: raw };
  return { raw, sentRaw, envelope };
}

function validMessageId(value) {
  return typeof value === 'string' && /^<[^<>\s]{1,400}>$/.test(value);
}
