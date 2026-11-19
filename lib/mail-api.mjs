import { randomBytes, randomUUID } from 'node:crypto';
import { get as getBlob, del } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import { accountId, config, get, purgeExpired, put, remove, sessionHash } from './store.mjs';
import { composeMail, MailError, makeMailbox, messageLimit, probe } from './mail.mjs';
import { opsReport, opsViewer } from './ops.mjs';
import { pushStatus, refreshOnLogin, subscribe, unsubscribe } from './push.mjs';

const cookieName = 'tu_mail_session';
const day = 86_400_000;
const fileLimit = 18_000_000;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const responseHeaders = { 'Cache-Control': 'private, no-store' };

function json(data, status = 200) {
  return Response.json(data, { status, headers: responseHeaders });
}

function check(test, code = 'invalid_request', status = 400) {
  if (!test) throw new MailError(code, status);
}

function authenticationFailure(error) {
  return error.authenticationFailed || error.code === 'EAUTH' || error.responseCode === 535;
}

function requireId(value) {
  check(typeof value === 'string' && uuidPattern.test(value));
  return value;
}

function folderName(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\0\r\n]/.test(value));
  return value;
}

function messageRef(body) {
  check(typeof body.epoch === 'string' && /^\d{1,21}$/.test(body.epoch));
  check(Number.isSafeInteger(body.uid) && body.uid > 0);
  return [folderName(body.folder), body.epoch, body.uid];
}

function sessionKey(request) {
  const entry = request.headers.get('cookie')?.split('; ').find(item => item.startsWith(cookieName + '='));
  const value = entry?.slice(cookieName.length + 1);
  return value && /^[\w-]{43}$/.test(value) ? 'session:' + sessionHash(value) : null;
}

function sessionCookie(value, secure, age) {
  return cookieName + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + age + (secure ? '; Secure' : '');
}

function allowedOrigin(request, mode) {
  const origin = request.headers.get('origin');
  if (process.env.MAIL_ORIGIN) return origin === process.env.MAIL_ORIGIN;
  if (mode === 'hosted') return false;
  // Local mode runs on 3000 (default launcher) or 3001 (side-by-side copy).
  return ['3000', '3001'].some(port => ['http://tusmail.localhost:', 'http://localhost:', 'http://127.0.0.1:'].some(host => origin === host + port));
}

async function authSession(request) {
  const key = sessionKey(request);
  const session = key && await get(key);
  if (!session) throw new MailError('session_expired', 401);
  if (Date.now() - session.touched > 300_000) {
    const now = Date.now();
    session.touched = now;
    const updated = await put(key, session, Math.min(session.created + day * 7, now + day), 'update');
    if (!updated) throw new MailError('session_expired', 401);
  }
  return session;
}

function normalizeDraft(body) {
  const names = ['to', 'cc', 'bcc', 'subject', 'text', 'inReplyTo'];
  const limits = [8000, 8000, 8000, 400, 200000, 402];
  const draft = {};
  names.forEach((name, i) => {
    const value = body[name] ?? '';
    check(typeof value === 'string' && value.length <= limits[i]);
    draft[name] = value;
  });
  const files = body.files ?? [];
  check(Array.isArray(files) && files.length <= 20);
  draft.files = files.map(file => {
    check(file && typeof file.name === 'string' && file.name.length > 0 && file.name.length <= 255
      && Number.isInteger(file.size) && file.size >= 0 && file.size <= fileLimit);
    return { id: requireId(file.id), name: file.name.replace(/[\0\r\n]/g, ''), size: file.size };
  });
  const refs = body.references ?? [];
  check(Array.isArray(refs) && refs.length <= 30 && refs.every(ref => typeof ref === 'string' && ref.length <= 402));
  draft.references = refs;
  return draft;
}

const attachmentKey = (account, id) => 'outgoing/' + account + '/' + id;

function uidList(body) {
  check(Array.isArray(body.uids) && body.uids.length > 0 && body.uids.length <= 200 && body.uids.every(uid => Number.isSafeInteger(uid) && uid > 0));
  check(typeof body.epoch === 'string' && /^\d{1,21}$/.test(body.epoch));
  return [folderName(body.folder), body.epoch, body.uids];
}

// Labels live in this app (TU's support for IMAP keywords is unknown). They are keyed by Message-ID,
// which survives moves between folders, and keep a small snapshot so a label view can list them.
const labelColors = ['blue', 'sky', 'teal', 'green', 'amber', 'orange', 'rose', 'violet'];
const presetLabels = [['Учебни', 'blue'], ['Администрация', 'amber'], ['Събития', 'green'], ['Лични', 'rose']];
const isMessageId = value => typeof value === 'string' && /^<[^<>\s]{1,400}>$/.test(value);

async function labelDefs(account) {
  const key = 'labels:' + account;
  let defs = await get(key);
  if (!defs) {
    defs = presetLabels.map(([name, color]) => ({ id: randomUUID(), name, color }));
    await put(key, defs);
  }
  return defs;
}

const labelledKey = account => 'labelled:' + account;
// shortcut: one record per account with read-modify-write; concurrent label edits from two tabs can race. Upgrade to per-message rows if that shows up.
async function labelled(account) {
  return (await get(labelledKey(account))) || {};
}

function labelName(value) {
  check(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 40 && !/[\0-\x1f]/.test(value), 'invalid_label');
  return value.trim();
}

function snapshot(message) {
  check(message && isMessageId(message.messageId));
  const [folder, epoch, uid] = messageRef(message);
  check(typeof message.subject === 'string' && message.subject.length <= 400 && typeof message.date === 'string' && message.date.length <= 40);
  const from = Array.isArray(message.from) ? message.from.slice(0, 1).map(entry => ({
    name: String(entry?.name || '').slice(0, 200), address: String(entry?.address || '').slice(0, 320),
  })) : [];
  return { subject: message.subject, from, date: message.date, folder, epoch, uid };
}

// Keeps label snapshots pointing at messages this app moved; `uidMap` comes from COPYUID when the server supports it.
async function relocateLabels(account, folder, epoch, uids, result) {
  const map = await labelled(account);
  let changed = false;
  for (const entry of Object.values(map)) {
    if (entry.snap.folder !== folder || entry.snap.epoch !== epoch || !uids.includes(entry.snap.uid)) continue;
    entry.snap = result ? { ...entry.snap, folder: result.folder, epoch: result.epoch, uid: result.uidMap?.[entry.snap.uid] ?? null } : { ...entry.snap, uid: null };
    changed = true;
  }
  if (changed) await put(labelledKey(account), map);
}

async function readOutgoing(account, files, mode) {
  check(files.reduce((sum, file) => sum + file.size, 0) <= fileLimit, 'message_too_large', 413);
  const resolved = [];
  for (const file of files) {
    const path = attachmentKey(account, file.id);
    let content;
    if (mode === 'hosted') {
      const blob = await getBlob(path, { access: 'private', useCache: false });
      check(blob?.stream, 'attachment_expired', 409);
      if (blob.blob?.size > fileLimit || (blob.blob?.size != null && blob.blob.size !== file.size)) {
        throw new MailError('invalid_attachment');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of blob.stream) {
        size += chunk.length;
        check(size <= file.size, 'invalid_attachment');
        chunks.push(chunk);
      }
      content = Buffer.concat(chunks);
    } else {
      const local = await get(path);
      check(local, 'attachment_expired', 409);
      content = Buffer.from(local, 'base64');
    }
    check(content.length === file.size, 'invalid_attachment');
    resolved.push({ name: file.name, content });
  }
  return resolved;
}

async function deleteOutgoing(account, file, mode) {
  const path = attachmentKey(account, file.id);
  if (mode === 'hosted') return del(path);
  return remove(path);
}

async function send(session, mailbox, draft, attempt, mode) {
  const key = 'send:' + session.account + ':' + requireId(attempt);
  const previous = await get(key);
  if (previous) return publicSend(previous);
  const files = await readOutgoing(session.account, draft.files, mode);
  const date = new Date();
  const messageId = '<' + attempt + '.' + session.account.slice(0, 12) + '@tu-sofia.bg>';
  const { raw, sentRaw, envelope } = await composeMail({ ...draft, from: session.user, date, messageId, files });
  const record = { status: 'sending', messageId, created: +date, files: draft.files };
  if (!await put(key, record, +date + 30 * day, 'claim')) return publicSend(await get(key));
  const copyKey = 'mime:' + key;
  await put(copyKey, sentRaw.toString('base64'), +date + day);
  let result;
  try {
    result = await mailbox.submit(raw, envelope);
  } catch (error) {
    const revoked = authenticationFailure(error);
    record.status = revoked || (error.responseCode >= 400 && error.responseCode < 600) ? 'failed' : 'unknown';
    await put(key, record, +date + 30 * day, 'update');
    await remove(copyKey);
    if (revoked) throw error;
    return publicSend(record);
  }
  record.status = 'copy_pending';
  record.accepted = result.accepted;
  record.rejected = result.rejected;
  await put(key, record, +date + 30 * day, 'update');
  return copySent(session, mailbox, key, mode, true);
}

function publicSend(message) {
  const status = message.status === 'sending' && Date.now() - message.created > 180_000 ? 'unknown' : message.status;
  return { status, accepted: message.accepted || [], rejected: message.rejected || [] };
}

async function copySent(session, mailbox, key, mode, first = false) {
  const lock = 'lock:' + key;
  if (!await put(lock, true, Date.now() + 240_000, 'claim')) return publicSend(await get(key));
  try {
    const record = await get(key);
    check(record, 'missing_send', 404);
    if (record.status !== 'copy_pending') return publicSend(record);
    const copyKey = 'mime:' + key;
    const mime = await get(copyKey);
    if (!mime) return { ...publicSend(record), status: 'copy_expired' };
    try {
      await mailbox.saveSent(Buffer.from(mime, 'base64'), record.messageId, first);
    } catch {
      return publicSend(record);
    }
    record.status = record.rejected.length ? 'partial' : 'sent';
    await put(key, record, record.created + 30 * day, 'update');
    await Promise.allSettled([remove(copyKey), ...record.files.map(file => deleteOutgoing(session.account, file, mode))]);
    return publicSend(record);
  } finally {
    await remove(lock);
  }
}

export async function serveMail(request, context, createMailbox = makeMailbox) {
  const mode = config();
  const { action } = await context.params;
  if (action === 'reachability') return json(await probe());
  if (mode === 'off') return json({ error: 'live_disabled' }, 503);
  let session;
  try {
    if (action !== 'blob-upload') check(allowedOrigin(request, mode), 'origin_denied', 403);
    if (action === 'blob-upload') {
      check(mode === 'hosted', 'live_disabled', 503);
      const response = await handleUpload({
        request, body: await request.json(),
        onBeforeGenerateToken: async pathname => {
          check(allowedOrigin(request, mode), 'origin_denied', 403);
          const owner = await authSession(request);
          const prefix = 'outgoing/' + owner.account + '/';
          check(pathname.startsWith(prefix));
          requireId(pathname.slice(prefix.length));
          return { addRandomSuffix: false, allowOverwrite: false, maximumSizeInBytes: fileLimit, validUntil: Date.now() + 120_000, ttlDays: 1 };
        },
        onUploadCompleted: async () => {},
      });
      return json(response);
    }
    if (action === 'login') {
      const body = await request.json();
      const user = typeof body.user === 'string' && body.user.trim().toLowerCase();
      check(typeof user === 'string' && /^[a-z\d._+-]+@tu-sofia\.bg$/.test(user) && user.length <= 128, 'login_denied', 401);
      check(typeof body.password === 'string' && body.password.length > 0 && body.password.length < 512, 'login_denied', 401);
      // "*" admits every address that passed the @tu-sofia.bg check above; a list restricts sign-in to those addresses.
      const approved = (process.env.TU_ALLOWED_USERS || '').toLowerCase().split(',').map(value => value.trim());
      if (process.env.TU_ALLOWED_USERS && !approved.includes('*')) check(approved.includes(user), 'login_denied', 401);
      await purgeExpired();
      const account = accountId(user);
      const throttle = 'login:' + account + ':' + Math.floor(Date.now() / 12000);
      check(await put(throttle, true, Date.now() + 12000, 'claim'), 'try_later', 429);
      const credentials = { user, password: body.password };
      try {
        await createMailbox(credentials).verify();
      } catch (error) {
        if (authenticationFailure(error)) throw new MailError('login_denied', 401);
        throw new MailError('connection_failed', 502);
      }
      const old = sessionKey(request);
      if (old) await remove(old);
      const id = randomBytes(32).toString('base64url');
      const now = Date.now();
      await put('session:' + sessionHash(id), { ...credentials, account, created: now, touched: now }, now + day);
      // Notifications must never block sign-in.
      await refreshOnLogin({ ...credentials, account }).catch(() => {});
      const response = json({ user, account, mode });
      response.headers.set('Set-Cookie', sessionCookie(id, mode === 'hosted', 7 * 86400));
      return response;
    }
    if (action === 'logout') {
      const key = sessionKey(request);
      if (key) await remove(key);
      const response = json({ success: true });
      response.headers.set('Set-Cookie', sessionCookie('', mode === 'hosted', 0));
      return response;
    }
    session = await authSession(request);
    if (action === 'session') return json({ user: session.user, account: session.account, mode });
    if (action === 'push-status' || action === 'push-subscribe' || action === 'push-unsubscribe') {
      const body = await request.json().catch(() => ({}));
      if (action === 'push-status') return json(await pushStatus(session, typeof body.endpoint === 'string' ? body.endpoint : null));
      if (action === 'push-subscribe') return json(await subscribe(session, body.subscription));
      return json(await unsubscribe(session.account, body.endpoint));
    }
    if (action === 'ops') {
      check(opsViewer(session.user), 'ops_denied', 403);
      return json(await opsReport());
    }
    const mailbox = createMailbox(session);
    if (action === 'folders') return json(await mailbox.folders());
    if (action === 'upload-local') {
      check(mode === 'local', 'invalid_request');
      const length = Number(request.headers.get('content-length'));
      check(length > 0 && length <= fileLimit + 4096, 'message_too_large', 413);
      const form = await request.formData();
      const id = requireId(form.get('id'));
      const file = form.get('file');
      check(file instanceof File && file.size <= fileLimit, 'message_too_large', 413);
      await put(attachmentKey(session.account, id), Buffer.from(await file.arrayBuffer()).toString('base64'), Date.now() + day);
      return json({ id });
    }
    const body = await request.json();
    if (action === 'list') {
      const folder = folderName(body.folder);
      check(typeof body.query === 'string' && body.query.length <= 256 && !/[\r\n\0]/.test(body.query));
      if (body.cursor) {
        check(Number.isSafeInteger(body.cursor.before) && body.cursor.before >= 1 && typeof body.cursor.epoch === 'string');
      }
      const filter = body.filter ?? '';
      check(['', 'unread', 'starred'].includes(filter));
      const page = await mailbox.list(folder, { ...body.cursor, query: body.query, filter });
      const map = await labelled(session.account);
      for (const message of page.messages) message.labels = map[message.messageId]?.labels || [];
      return json(page);
    }
    if (action === 'read') {
      const message = await mailbox.read(...messageRef(body), { markRead: body.markRead === true });
      message.labels = (await labelled(session.account))[message.messageId]?.labels || [];
      return json(message);
    }
    if (action === 'flags') {
      const allowed = ['\\Seen', '\\Flagged'];
      const add = body.add ?? [];
      const drop = body.remove ?? [];
      check(Array.isArray(add) && Array.isArray(drop) && [...add, ...drop].every(flag => allowed.includes(flag)) && add.length + drop.length > 0);
      return json(await mailbox.setFlags(...uidList(body), { add, remove: drop }));
    }
    if (action === 'move' || action === 'trash') {
      const [folder, epoch, uids] = uidList(body);
      const result = action === 'trash' ? await mailbox.trash(folder, epoch, uids) : await mailbox.move(folder, epoch, uids, folderName(body.target));
      await relocateLabels(session.account, folder, epoch, uids, result);
      return json(result);
    }
    if (action === 'delete-forever') {
      const [folder, epoch, uids] = uidList(body);
      const result = await mailbox.deleteForever(folder, epoch, uids);
      const map = await labelled(session.account);
      for (const [messageId, entry] of Object.entries(map)) {
        if (entry.snap.folder === folder && entry.snap.epoch === epoch && uids.includes(entry.snap.uid)) delete map[messageId];
      }
      await put(labelledKey(session.account), map);
      return json(result);
    }
    if (action === 'labels') {
      const key = 'labels:' + session.account;
      let defs = await labelDefs(session.account);
      if (body.op === 'create') {
        const name = labelName(body.name);
        check(labelColors.includes(body.color) && defs.length < 30 && !defs.some(item => item.name.toLowerCase() === name.toLowerCase()), 'invalid_label');
        defs = [...defs, { id: randomUUID(), name, color: body.color }];
      } else if (body.op === 'rename' || body.op === 'delete') {
        check(defs.some(item => item.id === body.id), 'invalid_label');
        if (body.op === 'rename') {
          const name = labelName(body.name);
          defs = defs.map(item => item.id === body.id ? { ...item, name, color: labelColors.includes(body.color) ? body.color : item.color } : item);
        } else {
          defs = defs.filter(item => item.id !== body.id);
          const map = await labelled(session.account);
          for (const [messageId, entry] of Object.entries(map)) {
            entry.labels = entry.labels.filter(id => id !== body.id);
            if (!entry.labels.length) delete map[messageId];
          }
          await put(labelledKey(session.account), map);
        }
      } else check(!body.op || body.op === 'list');
      if (body.op) await put(key, defs);
      return json({ labels: defs });
    }
    if (action === 'label') {
      check((body.op === 'add' || body.op === 'remove') && Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 200);
      check((await labelDefs(session.account)).some(item => item.id === body.label), 'invalid_label');
      const map = await labelled(session.account);
      for (const message of body.messages) {
        const snap = snapshot(message);
        const entry = map[message.messageId] || { labels: [], snap };
        entry.snap = snap;
        entry.labels = body.op === 'add' ? [...new Set([...entry.labels, body.label])] : entry.labels.filter(id => id !== body.label);
        if (entry.labels.length) map[message.messageId] = entry;
        else delete map[message.messageId];
      }
      check(Object.keys(map).length <= 5000, 'too_many_labels', 409);
      await put(labelledKey(session.account), map);
      return json({ labels: Object.fromEntries(body.messages.map(message => [message.messageId, map[message.messageId]?.labels || []])) });
    }
    if (action === 'label-list') {
      check(typeof body.label === 'string');
      const map = await labelled(session.account);
      const messages = Object.entries(map).filter(([, entry]) => entry.labels.includes(body.label)).map(([messageId, entry]) => ({
        id: JSON.stringify([entry.snap.folder, entry.snap.epoch, entry.snap.uid ?? messageId]), messageId, labels: entry.labels,
        ...entry.snap, to: [], cc: [], replyTo: [], unread: false, starred: false, moved: entry.snap.uid == null,
      })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return json({ messages, cursor: null });
    }
    if (action === 'attachment') {
      check(typeof body.part === 'string' && /^\d+(\.\d+)*$/.test(body.part));
      const file = await mailbox.file(...messageRef(body), body.part);
      const type = file.preview ? file.type : 'application/octet-stream';
      const name = file.name.replace(/[\r\n\0]/g, '').toWellFormed();
      return new Response(file.body, { headers: {
        ...responseHeaders, 'Content-Type': type, 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(/'/g, '%27'),
      } });
    }
    if (action === 'draft') {
      const key = 'draft:' + session.account;
      if (body.draft === null) await remove(key);
      else if (body.draft) await put(key, normalizeDraft(body.draft), Date.now() + 30 * day);
      return json({ draft: await get(key) });
    }
    if (action === 'discard-file') {
      await deleteOutgoing(session.account, { id: requireId(body.id) }, mode);
      return json({ success: true });
    }
    if (action === 'send') return json(await send(session, mailbox, normalizeDraft(body.draft), body.attempt, mode));
    if (action === 'send-status' || action === 'retry-copy') {
      const key = 'send:' + session.account + ':' + requireId(body.attempt);
      const record = await get(key);
      check(record, 'missing_send', 404);
      return json(action === 'retry-copy' ? await copySent(session, mailbox, key, mode) : publicSend(record));
    }
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof MailError) return json({ error: error.code }, error.status);
    if (authenticationFailure(error)) {
      const key = sessionKey(request);
      if (key) await remove(key);
      const response = json({ error: 'session_expired' }, 401);
      response.headers.set('Set-Cookie', sessionCookie('', mode === 'hosted', 0));
      return response;
    }
    return json({ error: 'service_unavailable' }, 502);
  }
}
