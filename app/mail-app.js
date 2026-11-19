'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowUpRight, Archive, Check, ChevronDown, CircleHelp, FilePen,
  FileText, FolderInput, Forward, Inbox, Keyboard, LoaderCircle, LogOut, Mail, MailOpen, Monitor, Moon,
  Paperclip, Plus, RefreshCw, Reply, ReplyAll, Search, Send, Settings2, ShieldAlert, Star, Sun, Tag,
  Trash2, TriangleAlert, X,
} from 'lucide-react';
import { upload } from '@vercel/blob/client';
import { mergeFirstPage } from './list-merge.mjs';
import PdfPreview from './pdf-preview';

const blank = { to: '', cc: '', bcc: '', subject: '', text: '', files: [], inReplyTo: '', references: [] };
const errors = {
  invalid_recipients: 'Проверете адресите на получателите.',
  invalid_message: 'Проверете дължината и съдържанието на писмото.',
  attachment_expired: 'Приложението е изтекло. Прикачете го отново.',
  message_too_large: 'Писмото или приложението надвишава допустимия размер.',
  folder_changed: 'Папката е обновена. Презаредете списъка.',
  missing_message: 'Писмото вече не е в тази папка.',
  try_later: 'Изчакайте малко и опитайте отново.',
  login_denied: 'TU Sofia не прие имейла или паролата.',
  connection_failed: 'Няма връзка с пощенските сървъри на TU Sofia. Опитайте отново.',
  session_expired: 'Сесията изтече. Влезте отново.',
  live_disabled: 'Връзката с TU Sofia не е включена на този сървър.',
  missing_trash: 'Не открихме папка „Кошче“ в пощата ви.',
  already_trash: 'Писмото вече е в „Кошче“.',
  not_trash: 'Изтриване завинаги е възможно само от „Кошче“.',
  move_failed: 'TU Sofia не премести писмата. Опитайте отново.',
  invalid_label: 'Проверете името на етикета. Може да е зает.',
  too_many_labels: 'Достигнахте лимита за етикетирани писма.',
  push_disabled: 'Известията още не са включени на сървъра.',
  push_full: 'Местата за известия са заети. Опитайте по-късно.',
  invalid_subscription: 'Браузърът върна неочакван абонамент за известия.',
};
const labelColors = { blue: '#4F7CFF', sky: '#38BDF8', teal: '#2DD4BF', green: '#4ADE80', amber: '#FBBF24', orange: '#FB923C', rose: '#FB7185', violet: '#A78BFA' };
const day = new Intl.DateTimeFormat('bg-BG', { day: 'numeric', month: 'short', timeZone: 'Europe/Sofia' });
const longDate = new Intl.DateTimeFormat('bg-BG', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Sofia' });
const clock = new Intl.DateTimeFormat('bg-BG', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Sofia' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' });
// Today's mail shows the time; older mail shows the date.
const rowDate = value => {
  const date = new Date(value);
  return dayKey.format(date) === dayKey.format(new Date()) ? clock.format(date) : day.format(date);
};

function errorText(error) {
  return errors[error.message] || 'Възникна проблем. Опитайте отново.';
}

async function request(action, body = {}) {
  const multipart = body instanceof FormData;
  const response = await fetch('/api/mail/' + action, {
    method: 'POST', cache: 'no-store',
    ...(multipart ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (response.ok && action === 'attachment') return response.blob();
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'service_unavailable');
    error.status = response.status;
    throw error;
  }
  return data;
}

const messageRef = item => ({ folder: item.folder, uid: item.uid, epoch: item.epoch });
// A message opened from a notification, before its row is loaded: enough to read it by folder + epoch + UID.
const linkedMessage = (folder, epoch, uid) => ({ id: JSON.stringify([folder, epoch, uid]), folder, epoch, uid, subject: '', from: [], to: [], cc: [], date: new Date().toISOString() });
// Short UI sounds (made with ElevenLabs). Created once on first use; autoplay refusals are ignored.
const sounds = {};
function play(name) {
  if (typeof Audio === 'undefined') return;
  // The whoosh is mastered about 4x quieter than the chime; these volumes even them out.
  sounds[name] ||= Object.assign(new Audio('/sounds/' + name + '.mp3'), { volume: name === 'sent' ? 0.7 : 0.3, preload: 'auto' });
  sounds[name].currentTime = 0;
  sounds[name].play().catch(() => {});
}
const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const iosBrowserTab = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches;
function vapidBytes(key) {
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
const person = list => list?.[0]?.name || list?.[0]?.address || 'Неизвестен подател';
const initials = value => value.split(/[\s@._-]+/).map(word => word.match(/[\p{L}\p{N}]/u)?.[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
const special = (folder, use, pattern) => folder?.specialUse === use || pattern.test(folder?.path || '');
const isSent = folder => special(folder, '\\Sent', /^sent$/i);
const isTrash = folder => special(folder, '\\Trash', /^(trash|deleted( items| messages)?|кошче)$/i);
const isArchive = folder => special(folder, '\\Archive', /^archive$/i);
const isDrafts = folder => special(folder, '\\Drafts', /^drafts$/i);
const isJunk = folder => special(folder, '\\Junk', /^(junk|spam)$/i);
const mobileLayout = () => window.matchMedia('(max-width: 700px)').matches;
const presetNames = { inbox: 'Входящи', sent: 'Изпратени', archive: 'Архив', drafts: 'Чернови', junk: 'Спам', trash: 'Кошче' };
function folderLabel(folder) {
  return presetNames[folder.specialUse?.replace('\\', '').toLowerCase()] || presetNames[folder.path.toLowerCase()] || folder.name;
}
function folderIcon(folder) {
  if (folder.path === 'INBOX') return Inbox;
  if (isSent(folder)) return Send;
  if (isArchive(folder)) return Archive;
  if (isTrash(folder)) return Trash2;
  if (isDrafts(folder)) return FilePen;
  if (isJunk(folder)) return ShieldAlert;
  return Mail;
}
function bytes(size) {
  if (size == null) return '';
  return size >= 1_000_000 ? (size / 1_000_000).toFixed(1) + ' MB' : Math.max(1, Math.round(size / 1000)) + ' KB';
}
const plural = (count, one, many) => count + ' ' + (count === 1 ? one : many);
const groupByFolder = items => [...items.reduce((map, item) => {
  const key = item.folder + '\n' + item.epoch;
  if (!map.has(key)) map.set(key, { folder: item.folder, epoch: item.epoch, items: [] });
  map.get(key).items.push(item);
  return map;
}, new Map()).values()].map(group => ({ ...group, uids: group.items.map(item => item.uid) }));
const snapshotOf = item => ({ messageId: item.messageId, subject: item.subject || '', from: item.from || [], date: item.date, folder: item.folder, epoch: item.epoch, uid: item.uid });

function IconButton({ icon: Icon, label, onClick, disabled, className = '', pressed, filled }) {
  return <button type="button" className={'icon-button ' + className} title={label} aria-label={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}>
    <Icon size={18} strokeWidth={1.8} fill={filled ? 'currentColor' : 'none'} /></button>;
}

function fileKind(name) {
  return (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'файл').toUpperCase();
}

function Avatar({ label, index = 0, large }) {
  return <span aria-hidden="true" className={'avatar avatar-' + (index % 5) + (large ? ' avatar-large' : '')}>{initials(label)}</span>;
}

function LabelChip({ label }) {
  return <span className="label-chip" style={{ '--chip': labelColors[label.color] || labelColors.blue }}>{label.name}</span>;
}

function MessageBody({ message, theme }) {
  const frameRef = useRef(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let observer;
    function measure() {
      observer?.disconnect();
      const body = frame.contentDocument?.body;
      if (!body) return;
      const fit = () => { frame.style.height = Math.min(12000, body.scrollHeight + 2) + 'px'; };
      fit();
      observer = new ResizeObserver(fit);
      observer.observe(body);
    }
    frame.addEventListener('load', measure);
    measure();
    return () => {
      observer?.disconnect();
      frame.removeEventListener('load', measure);
    };
  }, [message.html, theme]);
  if (!message.html) return <div className="message-plain">{message.text || 'Писмото няма текст.'}</div>;
  const dark = theme === 'dark';
  // The CSP below blocks fonts, so mail HTML uses the system face in the app's palette.
  const css = 'html{color-scheme:' + (dark ? 'dark' : 'light') + '}body{display:flow-root;margin:0;color:' + (dark ? '#D7DEEB' : '#1E293B') +
    ';font:16px/1.7 "Segoe UI Variable Text","Segoe UI",Roboto,"Noto Sans",system-ui,sans-serif;overflow-wrap:anywhere}p{margin:0 0 14px}blockquote{margin:18px 0;padding:12px 16px;border-left:2px solid ' +
    (dark ? '#4F7CFF' : '#1D4ED8') + ';background:' + (dark ? 'rgba(79,124,255,.09)' : '#EAF0FF') + ';border-radius:0 12px 12px 0}a{color:' + (dark ? '#A9C2FF' : '#1E40AF') +
    ';text-underline-offset:2px}pre{white-space:pre-wrap}table{max-width:100%;border-collapse:collapse}td,th{padding:4px}hr{border:0;border-top:1px solid ' + (dark ? 'rgba(255,255,255,.08)' : '#DCE3EE') + '}';
  const doc = '<!doctype html><html lang="bg"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><style>' + css + '</style><body>' + message.html;
  // The server sanitizes every message; the sandbox has no scripts and the CSP blocks remote content.
  return <iframe ref={frameRef} className="mail-html" title="Съдържание на писмото" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} />;
}

const shortcutList = [
  ['C', 'Ново писмо'], ['/', 'Търсене'], ['↑ ↓', 'Към предишното или следващото писмо'], ['Enter', 'Отвори писмото'],
  ['X', 'Избери писмото'], ['Shift + клик', 'Избери поредица'], ['S', 'Звезда'], ['U', 'Маркирай като непрочетено'],
  ['Shift + I', 'Маркирай като прочетено'], ['E', 'Архивирай'], ['#', 'Изтрий'], ['L', 'Етикет'], ['Ctrl + Enter', 'Изпрати'], ['Esc', 'Затвори или махни избора'],
];

export default function MailApp({ mode }) {
  const [account, setAccount] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const [folders, setFolders] = useState([]);
  const [folder, setFolder] = useState('INBOX');
  const [labels, setLabels] = useState([]);
  const [labelView, setLabelView] = useState(null);
  const [labelDraft, setLabelDraft] = useState(null);
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [selected, setSelected] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [filter, setFilter] = useState('all');
  const [menu, setMenu] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [markRead, setMarkRead] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const soundRef = useRef(false);
  soundRef.current = soundOn;
  const [push, setPush] = useState({ ready: false, on: false, busy: false, note: '' });
  const [composeKind, setComposeKind] = useState('');
  const [pendingFiles, setPendingFiles] = useState([]);
  const [mobileRead, setMobileRead] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [stamp, setStamp] = useState(null);
  const [stale, setStale] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [theme, setTheme] = useState('dark');
  const [systemDark, setSystemDark] = useState(true);
  const [density, setDensity] = useState('comfortable');
  const [panel, setPanel] = useState('');
  const [toast, setToast] = useState('');
  const [preview, setPreview] = useState(null);
  const [loginError, setLoginError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [composer, setComposer] = useState(null);
  const [ccVisible, setCcVisible] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sendState, setSendState] = useState(null);
  const [composeError, setComposeError] = useState('');
  const [intro, setIntro] = useState(true);
  const searchInput = useRef(null);
  const list = useRef(null);
  const restoredPosition = useRef(0);
  const selectedButton = useRef(null);
  const generation = useRef(0);
  const readGeneration = useRef(0);
  const filesGeneration = useRef(0);
  const saving = useRef(Promise.resolve());
  const pendingSend = useRef(false);
  const activeAttempt = useRef(null);
  const glow = useRef(null);
  const orb = useRef(null);
  const anchor = useRef(null);
  const keyHandler = useRef(null);
  const rowsRef = useRef(rows);
  const cursorRef = useRef(cursor);
  const loadedView = useRef('');
  rowsRef.current = rows;
  cursorRef.current = cursor;
  const themeValue = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  const signedOut = useCallback(message => {
    generation.current++;
    readGeneration.current++;
    setAccount(null);
    setRows([]);
    setFolders([]);
    setLabels([]);
    setSelected(null);
    setComposer(null);
    setChecked(new Set());
    setLabelView(null);
    setLoginError(message || '');
  }, []);

  const call = useCallback(async (action, body) => {
    try { return await request(action, body); }
    catch (error) {
      if (error.status === 401) signedOut(errors.session_expired);
      throw error;
    }
  }, [signedOut]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    setTheme(localStorage.getItem('campus-theme') || 'dark');
    setDensity(localStorage.getItem('campus-density') || 'comfortable');
    setMarkRead(localStorage.getItem('campus-mark-read') !== 'off');
    setSoundOn(localStorage.getItem('campus-sounds') === 'on');
    request('session').then(setAccount).catch(() => {}).finally(() => setRestoring(false));
    const popstate = () => showList();
    window.addEventListener('popstate', popstate);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('popstate', popstate);
    };
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = themeValue; }, [themeValue]);

  // Notifications: register the service worker after sign-in and read whether this device is subscribed.
  useEffect(() => {
    if (!account || !pushSupported()) return;
    let live = true;
    (async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js');
        const subscription = await registration.pushManager.getSubscription();
        const status = await request('push-status', { endpoint: subscription?.endpoint || null });
        if (!live) return;
        setPush({
          ready: status.enabled, on: status.thisDevice, busy: false,
          note: status.status === 'auth_failed' ? 'Паролата за TU се е сменила. Влезте отново, за да продължат известията.' : '',
          vapidKey: status.vapidKey,
        });
      } catch {}
    })();
    return () => { live = false; };
  }, [account]);

  // Open a message from a notification: ?open=folder:epoch:uid on a fresh tab, or a message from the service worker.
  useEffect(() => {
    if (!account) return;
    const params = new URLSearchParams(location.search);
    const target = params.get('open')?.match(/^(.+):(\d{1,21}):(\d+)$/);
    if (target) {
      history.replaceState(history.state, '', location.pathname);
      openMessage(linkedMessage(target[1], target[2], Number(target[3])));
    }
    if (!('serviceWorker' in navigator)) return;
    const handler = event => {
      const data = event.data;
      if (data?.type === 'open-message' && typeof data.folder === 'string' && /^\d{1,21}$/.test(data.epoch) && Number.isSafeInteger(data.uid)) {
        openMessage(linkedMessage(data.folder, data.epoch, data.uid));
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
    // openMessage is recreated every render; the listener only needs the signed-in account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);
  useEffect(() => {
    const handler = event => keyHandler.current?.(event);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), toast.action ? 8000 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 260);
    return () => clearTimeout(timer);
  }, [query]);

  const refreshFolders = useCallback(() => call('folders').then(setFolders).catch(() => {}), [call]);

  useEffect(() => {
    if (!account) return;
    generation.current++;
    readGeneration.current++;
    filesGeneration.current++;
    loadedView.current = '';
    setFolder('INBOX');
    setLabelView(null);
    setSelected(null);
    setRows([]);
    setChecked(new Set());
    setMobileRead(false);
    setStamp(null);
    setReading(false);
    refreshFolders();
    call('labels').then(data => setLabels(data.labels)).catch(() => {});
  }, [account?.account, call, refreshFolders]);

  const refresh = useCallback(async (next = null) => {
    if (!account) return;
    const token = ++generation.current;
    const view = [folder, search, filter, labelView].join('\n');
    setBusy(true);
    try {
      const page = labelView ? await call('label-list', { label: labelView })
        : await call('list', { folder, query: search, cursor: next, filter: filter === 'all' ? '' : filter });
      if (token !== generation.current) return;
      if (next) {
        setRows(current => [...new Map([...current, ...page.messages].map(row => [row.id, row])).values()]);
        setCursor(page.cursor);
      } else {
        // Background refreshes of the same view keep older pages loaded with "Зареди още".
        const sameView = loadedView.current === view && !labelView;
        // A background refresh of Входящи that brings a newer unread message plays the chime (once).
        if (sameView && soundRef.current && folder === 'INBOX' && !search) {
          const newest = Math.max(0, ...rowsRef.current.map(row => row.uid || 0));
          if (newest && page.messages.some(row => row.uid > newest && row.unread)) play('new-mail');
        }
        const merged = sameView ? mergeFirstPage(rowsRef.current, cursorRef.current, page) : page;
        setRows(merged.rows || merged.messages);
        setCursor(merged.cursor);
        if (!labelView) refreshFolders();
      }
      loadedView.current = view;
      setStale('');
      setStamp(new Date());
    } catch (error) {
      if (token === generation.current) {
        setStale(errorText(error));
        if (error.message === 'folder_changed') setCursor(null);
      }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }, [account, call, folder, search, filter, labelView, refreshFolders]);

  useEffect(() => {
    setCursor(null);
    refresh();
    return () => { generation.current++; };
  }, [refresh]);
  useEffect(() => {
    let last = Date.now();
    const tick = interval => {
      if (document.visibilityState === 'visible' && Date.now() - last >= interval) {
        last = Date.now();
        refresh();
      }
    };
    const focus = () => tick(2500);
    const interval = setInterval(() => tick(55000), 60000);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [refresh]);

  function resetView() {
    if (history.state?.reader) history.replaceState(null, '');
    readGeneration.current++;
    setReading(false);
    setRows([]);
    setSelected(null);
    setChecked(new Set());
    setMenu(null);
    setMobileRead(false);
    list.current?.scrollTo({ top: 0 });
  }

  function changeFolder(next) {
    if (next === folder && !labelView) return;
    resetView();
    setLabelView(null);
    setFilter('all');
    setFolder(next);
  }

  function openLabel(id) {
    if (id === labelView) return;
    resetView();
    setLabelView(id);
  }

  async function openMessage(item, button) {
    restoredPosition.current = list.current?.scrollTop || 0;
    if (button) selectedButton.current = button;
    const token = ++readGeneration.current;
    // A history entry makes the phone's system back gesture return to the list instead of leaving the app.
    if (mobileLayout() && !history.state?.reader) history.pushState({ reader: true }, '');
    setMobileRead(true);
    setSelected(item);
    if (item.moved || item.uid == null) {
      setSelected({ ...item, bodyError: 'Писмото е преместено или изтрито извън Кампус Поща.' });
      return;
    }
    setReading(true);
    try {
      const data = await call('read', { ...messageRef(item), markRead });
      if (token !== readGeneration.current) return;
      setSelected({ ...data, id: item.id });
      setRows(current => current.map(row => row.id === item.id ? { ...row, unread: data.unread, labels: data.labels } : row));
      if (item.unread && !data.unread) refreshFolders();
    } catch (error) {
      if (token === readGeneration.current) {
        setSelected(current => current?.id === item.id ? { ...current, bodyError: errorText(error) } : current);
      }
    } finally {
      if (token === readGeneration.current) setReading(false);
    }
  }

  function returnToList() {
    if (history.state?.reader) history.back();
    else showList();
  }

  function showList() {
    setMobileRead(false);
    requestAnimationFrame(() => {
      list.current?.scrollTo({ top: restoredPosition.current });
      selectedButton.current?.focus({ preventScroll: true });
    });
  }

  // ---- Selection and mailbox actions ----
  const activeFolder = folders.find(item => item.path === folder) || { path: folder, name: folder };
  const archiveFolder = folders.find(isArchive);
  const trashFolder = folders.find(isTrash);
  const activeLabel = labels.find(item => item.id === labelView);
  const currentRows = rows;

  function toggleCheck(item, index, range) {
    const start = anchor.current;  // read before the updater runs; it runs after anchor moves
    setChecked(current => {
      const next = new Set(current);
      if (range && start != null) {
        const [from, to] = [start, index].sort((a, b) => a - b);
        currentRows.slice(from, to + 1).forEach(row => next.add(row.id));
      } else if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    anchor.current = index;
  }

  function targets() {
    if (checked.size) return currentRows.filter(row => checked.has(row.id));
    return selected && !selected.bodyError ? [selected] : [];
  }

  function patchRows(ids, patch) {
    setRows(current => current.map(row => ids.has(row.id) ? { ...row, ...patch(row) } : row));
    setSelected(current => current && ids.has(current.id) ? { ...current, ...patch(current) } : current);
  }

  async function setFlag(kind, items) {
    items = items.filter(item => item.uid != null && !item.moved);
    if (!items.length) return;
    const ids = new Set(items.map(item => item.id));
    const patch = { read: { unread: false }, unread: { unread: true }, star: { starred: true }, unstar: { starred: false } }[kind];
    const flags = { read: { add: ['\\Seen'] }, unread: { remove: ['\\Seen'] }, star: { add: ['\\Flagged'] }, unstar: { remove: ['\\Flagged'] } }[kind];
    const before = new Map(items.map(item => [item.id, { unread: item.unread, starred: item.starred }]));
    patchRows(ids, () => patch);
    try {
      for (const group of groupByFolder(items)) await call('flags', { folder: group.folder, epoch: group.epoch, uids: group.uids, ...flags });
      if (kind === 'read' || kind === 'unread') refreshFolders();
    } catch (error) {
      patchRows(ids, row => before.get(row.id));
      setToast({ text: errorText(error), error: true });
    }
  }

  async function moveTo(kind, items, target) {
    items = items.filter(item => item.uid != null && !item.moved);
    if (!items.length) return;
    const ids = new Set(items.map(item => item.id));
    const before = rowsRef.current;
    setRows(current => current.filter(row => !ids.has(row.id)));
    setChecked(new Set());
    setMenu(null);
    if (selected && ids.has(selected.id)) {
      setSelected(null);
      if (mobileRead) returnToList();
    }
    try {
      const results = [];
      for (const group of groupByFolder(items)) {
        const result = kind === 'trash'
          ? await call('trash', { folder: group.folder, epoch: group.epoch, uids: group.uids })
          : await call('move', { folder: group.folder, epoch: group.epoch, uids: group.uids, target });
        results.push({ group, result });
      }
      const name = kind === 'trash' ? 'Кошче' : folderLabel(folders.find(item => item.path === target) || { path: target, name: target });
      setToast({ text: plural(items.length, 'писмо е преместено', 'писма са преместени') + ' в „' + name + '“.', action: { label: 'Отмени', run: () => undoMove(results) } });
      refreshFolders();
    } catch (error) {
      setRows(before);
      setToast({ text: errorText(error), error: true });
    }
  }

  async function undoMove(results) {
    setToast('');
    try {
      let missing = 0;
      for (const { group, result } of results) {
        const uids = group.uids.map(uid => result.uidMap?.[uid]).filter(Boolean);
        missing += group.uids.length - uids.length;
        if (uids.length && result.epoch) await call('move', { folder: result.folder, epoch: result.epoch, uids, target: group.folder });
      }
      setToast(missing ? { text: 'Част от писмата не можаха да се върнат. Потърсете ги в целевата папка.', error: true } : 'Преместването е отменено.');
      refresh();
    } catch (error) { setToast({ text: errorText(error), error: true }); }
  }

  function deleteForever(items) {
    items = items.filter(item => item.uid != null);
    if (!items.length) return;
    setConfirm({
      title: 'Изтриване завинаги',
      text: plural(items.length, 'писмо ще бъде изтрито', 'писма ще бъдат изтрити') + ' от сървъра на TU Sofia. Това не може да се отмени.',
      action: 'Изтрий завинаги',
      run: async () => {
        const ids = new Set(items.map(item => item.id));
        try {
          for (const group of groupByFolder(items)) await call('delete-forever', { folder: group.folder, epoch: group.epoch, uids: group.uids });
          setRows(current => current.filter(row => !ids.has(row.id)));
          setChecked(new Set());
          if (selected && ids.has(selected.id)) setSelected(null);
          setToast(plural(items.length, 'писмо е изтрито', 'писма са изтрити') + ' завинаги.');
          refreshFolders();
        } catch (error) { setToast({ text: errorText(error), error: true }); }
      },
    });
  }

  function remove(items) {
    if (isTrash(activeFolder) && !labelView) deleteForever(items);
    else moveTo('trash', items);
  }

  async function applyLabel(label, items, on) {
    items = items.filter(item => item.messageId && item.uid != null && !item.moved);
    if (!items.length) {
      setToast({ text: 'Това писмо не може да получи етикет.', error: true });
      return;
    }
    try {
      const result = await call('label', { op: on ? 'add' : 'remove', label: label.id, messages: items.map(snapshotOf) });
      const ids = new Set(items.map(item => item.id));
      patchRows(ids, row => ({ labels: result.labels[row.messageId] || [] }));
      if (!on && labelView === label.id) setRows(current => current.filter(row => !ids.has(row.id)));
    } catch (error) { setToast({ text: errorText(error), error: true }); }
  }

  async function createLabel(event) {
    event.preventDefault();
    const name = labelDraft?.trim();
    if (!name) { setLabelDraft(null); return; }
    const colors = Object.keys(labelColors);
    try {
      const data = await call('labels', { op: 'create', name, color: colors[labels.length % colors.length] });
      setLabels(data.labels);
      setLabelDraft(null);
    } catch (error) { setToast({ text: errorText(error), error: true }); }
  }

  function deleteLabel(label) {
    setConfirm({
      title: 'Изтриване на етикет',
      text: 'Етикетът „' + label.name + '“ ще бъде махнат от всички писма. Самите писма остават.',
      action: 'Изтрий етикета',
      run: async () => {
        try {
          const data = await call('labels', { op: 'delete', id: label.id });
          setLabels(data.labels);
          if (labelView === label.id) changeFolder('INBOX');
          setRows(current => current.map(row => ({ ...row, labels: (row.labels || []).filter(id => id !== label.id) })));
        } catch (error) { setToast({ text: errorText(error), error: true }); }
      },
    });
  }

  function toggleStar(items) {
    setFlag(items.every(item => item.starred) ? 'unstar' : 'star', items);
  }

  keyHandler.current = event => {
    if (event.key === 'Escape') {
      if (menu) setMenu(null);
      else if (checked.size) setChecked(new Set());
      setPanel('');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      searchInput.current?.focus();
      return;
    }
    const target = event.target;
    if (!account || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')
      || target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const focusedRow = target.closest?.('.message-row');
    const focusedItem = focusedRow && currentRows.find(row => row.id === focusedRow.dataset.id);
    const items = targets().length ? targets() : focusedItem ? [focusedItem] : [];
    const key = event.key;
    const run = action => { event.preventDefault(); action(); };
    if (key === '/') run(() => searchInput.current?.focus());
    else if (key === 'c') run(() => newMessage());
    else if (key === '?') run(() => setShortcuts(true));
    else if (key === 'x' && focusedItem) run(() => toggleCheck(focusedItem, currentRows.indexOf(focusedItem)));
    else if (!items.length) return;
    else if (key === 's') run(() => toggleStar(items));
    else if (key === 'u') run(() => setFlag('unread', items));
    else if (key === 'I') run(() => setFlag('read', items));
    else if (key === 'e' && archiveFolder && !isArchive(activeFolder)) run(() => moveTo('archive', items, archiveFolder.path));
    else if (key === '#' || key === 'Delete') run(() => remove(items));
    else if (key === 'l') run(() => setMenu({ kind: 'label', scope: checked.size ? 'bulk' : 'reader' }));
  };

  // ---- Attachments, preferences, session ----
  async function loadFile(message, file, show) {
    try {
      const blob = await call('attachment', { ...messageRef(message), part: file.part });
      const url = URL.createObjectURL(blob);
      if (show) {
        setPreview({ url, name: file.name, type: blob.type });
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }
    } catch (error) { setToast({ text: errorText(error), error: true }); }
  }

  async function uploadFile(file) {
    if (file.size > 18_000_000) throw new Error('message_too_large');
    const id = crypto.randomUUID();
    if (mode === 'hosted') {
      await upload('outgoing/' + account.account + '/' + id, file, { access: 'private', handleUploadUrl: '/api/mail/blob-upload' });
    } else {
      const form = new FormData();
      form.set('id', id);
      form.set('file', file);
      await request('upload-local', form);
    }
    return { id, name: file.name, size: file.size };
  }

  function changeTheme(value) {
    setTheme(value);
    localStorage.setItem('campus-theme', value);
  }
  function changeDensity(value) {
    setDensity(value);
    localStorage.setItem('campus-density', value);
  }
  function changeMarkRead(value) {
    setMarkRead(value);
    localStorage.setItem('campus-mark-read', value ? 'on' : 'off');
  }

  function changeSound(value) {
    setSoundOn(value);
    localStorage.setItem('campus-sounds', value ? 'on' : 'off');
    if (value) play('new-mail');
  }

  async function changePush(value) {
    setPush(current => ({ ...current, busy: true, note: '' }));
    try {
      const registration = await navigator.serviceWorker.ready;
      if (value) {
        if (await Notification.requestPermission() !== 'granted') {
          setPush(current => ({ ...current, busy: false, note: 'Браузърът блокира известията. Разрешете ги от настройките на сайта.' }));
          return;
        }
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(push.vapidKey) });
        const result = await call('push-subscribe', { subscription: subscription.toJSON() });
        setPush(current => ({ ...current, on: true, busy: false, note: result.synced ? 'Готово. Ще получите известие за всяко ново писмо във Входящи.' : 'Записано. Известията ще започнат до няколко минути.' }));
      } else {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await call('push-unsubscribe', { endpoint: subscription.endpoint });
          await subscription.unsubscribe();
        }
        setPush(current => ({ ...current, on: false, busy: false, note: '' }));
      }
    } catch (error) {
      setPush(current => ({ ...current, busy: false, note: errorText(error) }));
    }
  }

  async function connect(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setLoginError('');
    setConnecting(true);
    try {
      const connected = await request('login', { user: data.get('user'), password: data.get('password') });
      setAccount(connected);
      setComposer(null);
    } catch (error) { setLoginError(errorText(error)); }
    finally { setConnecting(false); }
  }

  async function signOut() {
    try {
      // Signing out stops notifications on this device; other devices keep theirs.
      if (push.on) {
        const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
        if (subscription) await request('push-unsubscribe', { endpoint: subscription.endpoint }).then(() => subscription.unsubscribe()).catch(() => {});
        setPush(current => ({ ...current, on: false }));
      }
      await request('logout');
      setPanel('');
      signedOut('');
    } catch (error) { setToast({ text: errorText(error), error: true }); }
  }

  // ---- Compose and send (attempt IDs and copy-only retries unchanged) ----
  const attemptKey = 'campus-mail-attempt-' + (account?.account || 'none');
  const saveDraft = useCallback(draft => {
    saving.current = saving.current.catch(() => {}).then(() => call('draft', { draft }));
    return saving.current;
  }, [call]);

  useEffect(() => {
    if (!composer || sendState || pendingSend.current) return;
    const timer = setTimeout(() => saveDraft(composer).catch(error => setComposeError(errorText(error))), 450);
    return () => clearTimeout(timer);
  }, [composer, saveDraft, sendState]);

  async function newMessage(kind) {
    if (composer || !account) return;
    setComposeError('');
    setSendState(null);
    setCcVisible(false);
    const pending = localStorage.getItem(attemptKey);
    setComposeKind(pending ? '' : kind || '');
    if (pending || !kind) {
      const saved = await call('draft').catch(() => ({}));
      setComposer({ ...blank, ...saved.draft });
      setCcVisible(Boolean(saved.draft?.cc || saved.draft?.bcc));
      activeAttempt.current = pending;
      if (pending) {
        const result = await call('send-status', { attempt: pending }).catch(() => ({ status: 'unknown' }));
        handleSendResult(result);
      }
      return;
    }

    const sender = selected.replyTo?.length ? selected.replyTo : selected.from;
    const isForward = kind === 'forward';
    const recipients = sender.map(value => value.address).filter(Boolean);
    const seen = new Set([...recipients, account.user].map(value => value.toLowerCase()));
    const extra = [];
    if (kind === 'replyAll') {
      for (const address of [...selected.to, ...selected.cc]) {
        if (!address.address || seen.has(address.address.toLowerCase())) continue;
        seen.add(address.address.toLowerCase());
        extra.push(address.address);
      }
    }
    const prefix = isForward ? 'Fwd: ' : 'Re: ';
    const quote = selected.text || new DOMParser().parseFromString(selected.html || '', 'text/html').body.textContent;
    setComposer({
      ...blank, to: isForward ? '' : recipients.join(', '), cc: extra.join(', '),
      subject: selected.subject.toLowerCase().startsWith(prefix.toLowerCase()) ? selected.subject : prefix + selected.subject,
      text: '\n\nНа ' + longDate.format(new Date(selected.date)) + ' ' + person(selected.from) + ' написа:\n' + quote.split('\n').map(line => '> ' + line).join('\n'),
      inReplyTo: isForward ? '' : selected.messageId, references: isForward ? [] : [...(selected.references || []), selected.messageId].filter(Boolean).slice(-30),
    });
    setCcVisible(Boolean(extra.length));
    if (isForward && selected.files?.length) {
      setUploading(true);
      setPendingFiles(selected.files.map(file => file.name));
      const staged = [];
      const failed = [];
      for (const file of selected.files) {
        try {
          const blob = await call('attachment', { ...messageRef(selected), part: file.part });
          staged.push(await uploadFile(new File([blob], file.name, { type: blob.type })));
        } catch { failed.push(file.name); }
        setPendingFiles(names => names.slice(1));
      }
      // Keep what was attached; one failure must not drop every forwarded file.
      setComposer(current => current && ({ ...current, files: [...current.files, ...staged] }));
      if (failed.length) setComposeError('Не успяхме да прикачим: ' + failed.join(', ') + '. Прикачете ги ръчно или изпратете без тях.');
      setUploading(false);
    }
  }

  function changeField(name, value) {
    setComposer(current => ({ ...current, [name]: value }));
  }

  async function addFiles(event) {
    const additions = Array.from(event.currentTarget.files);
    event.currentTarget.value = '';
    if (!additions.length) return;
    const combined = [...composer.files, ...additions];
    if (combined.length > 20 || combined.reduce((sum, file) => sum + file.size, 0) > 18_000_000) {
      setComposeError(errors.message_too_large);
      return;
    }
    setComposeError('');
    setUploading(true);
    setPendingFiles(additions.map(file => file.name));
    const version = ++filesGeneration.current;
    try {
      for (const file of additions) {
        const attachment = await uploadFile(file);
        if (version === filesGeneration.current) setComposer(current => current && ({ ...current, files: [...current.files, attachment] }));
        setPendingFiles(names => names.slice(1));
      }
    } catch (error) { setComposeError(errorText(error)); }
    finally {
      setUploading(false);
      setPendingFiles([]);
    }
  }

  async function removeFile(id) {
    setComposer(current => ({ ...current, files: current.files.filter(file => file.id !== id) }));
    await call('discard-file', { id }).catch(() => {});
  }

  function handleSendResult(result) {
    setSendState(result);
    if (result.status === 'sent') {
      localStorage.removeItem(attemptKey);
      activeAttempt.current = null;
      setComposer(null);
      setToast('Писмото е изпратено.');
      if (soundRef.current) play('sent');
      saveDraft(null).catch(() => {});
      refresh();
    }
    if (result.status === 'failed') {
      activeAttempt.current = null;
      localStorage.removeItem(attemptKey);
      setComposeError('TU Sofia отказа изпращането. Проверете получателите и опитайте отново.');
      setSendState(null);
    }
  }

  async function sendDraft(event) {
    event.preventDefault();
    if (uploading || pendingSend.current || activeAttempt.current) return;
    setComposeError('');
    const attempt = crypto.randomUUID();
    activeAttempt.current = attempt;
    localStorage.setItem(attemptKey, attempt);
    pendingSend.current = true;
    setSendState({ status: 'sending' });
    try {
      await saveDraft(composer);
      handleSendResult(await call('send', { attempt, draft: composer }));
    } catch (error) {
      // Only a definite client-side rejection frees the attempt; anything else stays "unknown" and is never resent automatically.
      if (error.status >= 400 && error.status < 500) {
        activeAttempt.current = null;
        localStorage.removeItem(attemptKey);
        setSendState(null);
        setComposeError(errorText(error));
      } else {
        setSendState({ status: 'unknown' });
      }
    } finally { pendingSend.current = false; }
  }

  async function updateSend(copy) {
    if (!activeAttempt.current || pendingSend.current) return;
    pendingSend.current = true;
    try {
      const result = await call(copy ? 'retry-copy' : 'send-status', { attempt: activeAttempt.current });
      handleSendResult(result);
    } catch (error) { setComposeError(errorText(error)); }
    finally { pendingSend.current = false; }
  }

  function clearAttempt() {
    localStorage.removeItem(attemptKey);
    activeAttempt.current = null;
    setSendState(null);
    setComposeError('');
    setComposer({ ...blank });
    saveDraft(null).catch(() => {});
  }

  async function closeCompose() {
    if (uploading || pendingSend.current) return;
    if (!sendState) await saveDraft(composer).catch(() => {});
    setComposer(null);
  }

  // ---- Motion ----
  // The page-load entrance plays once; later folder switches and refreshes render without it.
  useEffect(() => {
    const timer = setTimeout(() => setIntro(false), 1400);
    return () => clearTimeout(timer);
  }, []);

  // The background orb wanders to a new random spot every 16s (CSS eases the move); it stays put for reduced motion.
  useEffect(() => {
    const element = orb.current;
    if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const spread = range => (Math.random() * 2 - 1) * range;
    const wander = () => { element.style.transform = 'translate(' + spread(32) + 'vw, ' + spread(28) + 'vh) scale(' + (0.85 + Math.random() * 0.4) + ')'; };
    const first = setTimeout(wander, 60);
    const timer = setInterval(wander, 16000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, []);

  // One glow bar glides to the open message instead of each row toggling its own highlight.
  useLayoutEffect(() => {
    const bar = glow.current;
    if (!bar) return;
    function place() {
      const row = list.current?.querySelector('.message-row.selected');
      if (!row) { bar.style.opacity = '0'; return; }
      const hidden = bar.style.opacity !== '1';
      if (hidden) bar.style.transition = 'none';
      bar.style.transform = 'translateY(' + row.offsetTop + 'px)';
      bar.style.height = row.offsetHeight + 'px';
      bar.style.opacity = '1';
      if (hidden) { bar.getBoundingClientRect(); bar.style.transition = ''; }
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [selected?.id, rows, density, mobileRead, search, checked]);

  function listKeys(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...list.current.querySelectorAll('.row-open')];
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
  }

  // ---- Render ----
  const folderName = activeLabel ? activeLabel.name : folderLabel(activeFolder);
  const sentFolder = isSent(activeFolder) && !labelView;
  const selectedIndex = Math.max(0, rows.findIndex(row => row.id === selected?.id));
  const toastData = toast && (typeof toast === 'string' ? { text: toast } : toast);
  const sendTone = { sending: 'info', copy_pending: 'info' }[sendState?.status] || 'warn';
  const statusText = sendState && {
    sending: 'Изпращане… Не затваряйте прозореца.',
    unknown: 'Не знаем дали TU Sofia е приела писмото. Проверете „Изпратени“, преди да изпратите отново.',
    copy_pending: 'TU Sofia прие писмото. Копието в „Изпратени“ още не е запазено.',
    copy_expired: 'TU Sofia прие писмото. Временното копие за „Изпратени“ е изтекло и няма да бъде запазено.',
    partial: 'TU Sofia прие писмото само за част от получателите. Отказани: ' + sendState.rejected?.join(', '),
  }[sendState.status];
  const composeTitle = { reply: 'Отговор', replyAll: 'Отговор до всички', forward: 'Препращане' }[composeKind] || 'Ново писмо';
  const draftBytes = composer?.files.reduce((sum, file) => sum + file.size, 0) || 0;
  const status = stale ? 'Не е обновено' : stamp ? 'Обновено в ' + clock.format(stamp) : busy ? 'Зареждане…' : '';
  const emptyText = busy ? 'Зареждане…' : stale ? 'Пощата е недостъпна в момента.'
    : labelView ? 'Няма писма с този етикет.'
    : search ? (cursor ? 'Няма съвпадения сред последните писма.' : 'Няма писма с такъв подател или тема.')
    : filter === 'unread' ? 'Няма непрочетени писма.' : filter === 'starred' ? 'Няма писма със звезда.' : 'Папката е празна.';
  const loadingList = busy && !currentRows.length;
  const unseen = activeFolder.unseen;
  const bulk = targets();
  const menuItems = menu?.scope === 'bulk' ? currentRows.filter(row => checked.has(row.id)) : selected ? [selected] : [];
  const inTrash = isTrash(activeFolder) && !labelView;
  const canArchive = archiveFolder && !isArchive(activeFolder);
  const labelById = id => labels.find(item => item.id === id);

  const menuPanel = menu && <>
    <div className="menu-scrim" onClick={() => setMenu(null)} />
    <div className={'menu menu-' + menu.scope} role="menu" aria-label={menu.kind === 'label' ? 'Етикети' : 'Премести в'}>
      <h2>{menu.kind === 'label' ? 'Етикет' : 'Премести в'}</h2>
      {menu.kind === 'label' ? labels.map(label => {
        const on = menuItems.length > 0 && menuItems.every(item => item.labels?.includes(label.id));
        return <button key={label.id} role="menuitemcheckbox" aria-checked={on} onClick={() => applyLabel(label, menuItems, !on)}>
          <i className="label-dot" style={{ '--dot': labelColors[label.color] }} /><span>{label.name}</span>{on && <Check size={15} />}</button>;
      }) : folders.filter(item => item.path !== folder || labelView).map(item => {
        const Icon = folderIcon(item);
        return <button key={item.path} role="menuitem" onClick={() => isTrash(item) ? moveTo('trash', menuItems) : moveTo('move', menuItems, item.path)}><Icon size={16} /><span>{folderLabel(item)}</span></button>;
      })}
      {menu.kind === 'label' && !labels.length && <p className="muted">Създайте етикет от страничното меню.</p>}
    </div>
  </>;

  if (restoring || !account) {
    return <div className={'mail-app signin-app' + (intro ? ' intro' : '')}>
      <div className="aurora" aria-hidden="true"><i ref={orb} /></div>
      <header className="signin-top">
        <a className="brand" href="/" aria-label="Кампус Поща – начало">
          <img className="brand-mark" src="/logo.png" alt="" width={36} height={36} />
          <span className="brand-name">Кампус <strong>Поща</strong></span>
        </a>
        <IconButton icon={themeValue === 'dark' ? Sun : Moon} label={themeValue === 'dark' ? 'Светла тема' : 'Тъмна тема'} className="theme-toggle" onClick={() => changeTheme(themeValue === 'dark' ? 'light' : 'dark')} />
      </header>
      <main className="signin-main">
        {restoring ? <div className="signin-card signin-loading" role="status"><LoaderCircle size={22} className="spin" /> Проверка на сесията…</div> :
          <form className="signin-card login-form" onSubmit={connect}>
            <h1>Влезте с пощата на ТУ</h1>
            <p>Използвайте имейла и паролата за поща на ТУ – София. Паролата отива само към пощенските сървъри на ТУ и се пази криптирана, докато сте влезли.</p>
            <label>Имейл<input name="user" type="email" autoComplete="username" placeholder="име@tu-sofia.bg" required autoFocus /></label>
            <label>Парола<input name="password" type="password" autoComplete="current-password" required /></label>
            {loginError && <div className="banner danger" role="alert"><TriangleAlert size={16} /><span>{loginError}</span></div>}
            <button className="primary" disabled={connecting}>{connecting ? <><LoaderCircle size={16} className="spin" /> Свързване…</> : 'Влез'}</button>
            <a className="signin-help" href="/">Какво е Кампус Поща и какво се пази?</a>
          </form>}
      </main>
    </div>;
  }

  return (
    <div className={'mail-app ' + (density === 'compact' ? 'compact ' : '') + (mobileRead ? 'mobile-reading ' : '') + (checked.size ? 'selecting ' : '') + (intro ? 'intro' : '')}>
      <div className="aurora" aria-hidden="true"><i ref={orb} /></div>
      <header className="topbar">
        <div className="brand-wrap">
          <a className="brand" href="/" aria-label="Кампус Поща – начало">
            <img className="brand-mark" src="/logo.png" alt="" width={36} height={36} />
            <span className="brand-name">Кампус <strong>Поща</strong><small>Технически университет – София</small></span>
          </a>
        </div>
        <div className="top-search">
          <Search size={18} strokeWidth={1.8} />
          <input ref={searchInput} value={query} onChange={event => setQuery(event.target.value)} maxLength={256} type="search" enterKeyHint="search" disabled={Boolean(labelView)}
            aria-label={'Търси по подател или тема в „' + folderName + '“'} placeholder={labelView ? 'Търсенето работи в папките' : 'Подател или тема в „' + folderName + '“'} />
          {query ? <IconButton icon={X} label="Изчисти търсенето" onClick={() => { setQuery(''); searchInput.current?.focus(); }} /> : <kbd>Ctrl K</kbd>}
        </div>
        <div className="top-actions">
          <IconButton icon={themeValue === 'dark' ? Sun : Moon} label={themeValue === 'dark' ? 'Светла тема' : 'Тъмна тема'} className="theme-toggle" onClick={() => changeTheme(themeValue === 'dark' ? 'light' : 'dark')} />
          <IconButton icon={Settings2} label="Настройки" className={panel === 'appearance' ? 'active' : ''} onClick={() => setPanel(panel === 'appearance' ? '' : 'appearance')} />
          <button className="profile-button" aria-label="Профил" aria-expanded={panel === 'account'} onClick={() => setPanel(panel === 'account' ? '' : 'account')}><Avatar label={account.user} /><ChevronDown size={13} /></button>
        </div>
        {panel && <div className="popover" role="group" aria-label={panel === 'appearance' ? 'Настройки' : 'Профил'}>
          {panel === 'appearance' ? <>
            <h2>Тема</h2>
            <div className="choice-row">{[[Moon, 'dark', 'Тъмна'], [Sun, 'light', 'Светла'], [Monitor, 'system', 'Системна']].map(([Icon, value, label]) =>
              <button key={value} aria-pressed={theme === value} className={theme === value ? 'active' : ''} onClick={() => changeTheme(value)}><Icon size={15} />{label}</button>)}</div>
            <h2>Плътност на списъка</h2>
            <div className="choice-row">{[['comfortable', 'Удобна'], ['compact', 'Компактна']].map(([value, label]) =>
              <button key={value} aria-pressed={density === value} className={density === value ? 'active' : ''} onClick={() => changeDensity(value)}>{label}</button>)}</div>
            <h2>Четене</h2>
            <label className="switch-row"><input type="checkbox" role="switch" checked={markRead} onChange={event => changeMarkRead(event.target.checked)} /><span>Маркирай като прочетено при отваряне</span></label>
            <label className="switch-row"><input type="checkbox" role="switch" checked={soundOn} onChange={event => changeSound(event.target.checked)} /><span>Звуци при ново писмо и изпращане</span></label>
            {push.ready && <>
              <h2>Известия</h2>
              {iosBrowserTab()
                ? <p className="popover-note">На iPhone известията работят, когато добавите Кампус Поща към началния екран (Сподели → Добави към началния екран) и я отворите оттам.</p>
                : <label className="switch-row"><input type="checkbox" role="switch" checked={push.on} disabled={push.busy} onChange={event => changePush(event.target.checked)} /><span>Известия за нова поща на това устройство</span></label>}
              {push.note && <p className="popover-note" role="status">{push.note}</p>}
            </>}
            <button className="quiet-button" onClick={() => { setPanel(''); setShortcuts(true); }}><Keyboard size={16} /> Клавишни комбинации</button>
          </> : <>
            <h2>{account.user}</h2>
            <a className="quiet-button" href="https://tusmail.tu-sofia.bg/" target="_blank" rel="noreferrer"><ArrowUpRight size={16} /> Официална поща на ТУ</a>
            <button className="quiet-button" onClick={signOut}><LogOut size={16} /> Изход</button>
          </>}
        </div>}
      </header>

      <main className="workspace">
        <aside className="sidebar" aria-label="Папки и етикети">
          <button className="primary compose" onClick={() => newMessage()}><Plus size={18} /> Ново писмо</button>
          <div className="sidebar-scroll">
            <nav className="folder-nav" aria-label="Папки">
              {folders.map(item => {
                const Icon = folderIcon(item);
                const active = item.path === folder && !labelView;
                const count = !isSent(item) && !isTrash(item) && !isDrafts(item) && item.unseen > 0 ? item.unseen : 0;
                return <button className={active ? 'folder active' : 'folder'} aria-current={active ? 'page' : undefined} key={item.path} onClick={() => changeFolder(item.path)}>
                  <Icon size={17} /><span>{folderLabel(item)}</span>{count > 0 &&
                    <span className="folder-count">{count}<span className="sr-only"> непрочетени</span></span>}
                </button>;
              })}
            </nav>
            <div className="sidebar-section"><h2>Етикети</h2><IconButton icon={Plus} label="Нов етикет" onClick={() => setLabelDraft('')} /></div>
            <nav className="label-nav" aria-label="Етикети">
              {labels.map(label => <div className="label-item" key={label.id}>
                <button className={labelView === label.id ? 'folder active' : 'folder'} aria-current={labelView === label.id ? 'page' : undefined} onClick={() => openLabel(label.id)}>
                  <i className="label-dot" style={{ '--dot': labelColors[label.color] }} /><span>{label.name}</span></button>
                <IconButton icon={X} label={'Изтрий етикета ' + label.name} className="label-delete" onClick={() => deleteLabel(label)} />
              </div>)}
              {labelDraft !== null && <form className="label-new" onSubmit={createLabel}>
                <input value={labelDraft} onChange={event => setLabelDraft(event.target.value)} maxLength={40} placeholder="Име на етикета" aria-label="Име на новия етикет" autoFocus
                  onBlur={event => { if (!event.target.value.trim()) setLabelDraft(null); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setLabelDraft(null); } }} />
              </form>}
            </nav>
          </div>
          <div className="sidebar-footer">
            <a href="https://tusmail.tu-sofia.bg/" target="_blank" rel="noreferrer"><CircleHelp size={16} /> Поща на ТУ <ArrowUpRight size={13} /></a>
            <div className="connection"><i />Свързано с TU Sofia</div>
          </div>
        </aside>

        <section className="list-panel" aria-label="Списък с писма">
          <div className="list-heading">
            <div>
              <div className="folder-select">
                {activeLabel && <i className="label-dot large" style={{ '--dot': labelColors[activeLabel.color] }} />}
                <h1>{folderName}</h1>
                <select aria-label="Избери папка или етикет" value={labelView ? 'label:' + labelView : folder}
                  onChange={event => event.target.value.startsWith('label:') ? openLabel(event.target.value.slice(6)) : changeFolder(event.target.value)}>
                  {folders.map(item => <option key={item.path} value={item.path}>{folderLabel(item)}</option>)}
                  {labels.length > 0 && <optgroup label="Етикети">{labels.map(label => <option key={label.id} value={'label:' + label.id}>{label.name}</option>)}</optgroup>}
                </select><ChevronDown size={16} />
              </div>
              <div className={'list-meta' + (stale ? ' is-stale' : '')} aria-live="polite">{status}</div>
            </div>
            <IconButton icon={RefreshCw} label="Провери за нови писма" className={busy ? 'spinning' : ''} onClick={() => refresh()} disabled={busy} />
            <IconButton icon={Plus} label="Ново писмо" className="mobile-compose" onClick={() => newMessage()} />
          </div>
          {checked.size > 0 ? <div className="bulk-bar" role="toolbar" aria-label="Действия с избраните писма">
            <IconButton icon={X} label="Махни избора" onClick={() => setChecked(new Set())} />
            <strong>{checked.size} избрани</strong>
            {checked.size < currentRows.length && <button className="quiet-button select-all" onClick={() => setChecked(new Set(currentRows.map(row => row.id)))}>Избери всички {currentRows.length}</button>}
            <span className="bulk-actions">
              {!labelView && <IconButton icon={MailOpen} label="Маркирай като прочетени" onClick={() => setFlag('read', bulk)} />}
              {!labelView && <IconButton icon={Mail} label="Маркирай като непрочетени" onClick={() => setFlag('unread', bulk)} />}
              {!labelView && <IconButton icon={Star} label="Звезда" onClick={() => toggleStar(bulk)} />}
              <IconButton icon={Tag} label="Етикет" className={menu?.kind === 'label' && menu.scope === 'bulk' ? 'active' : ''} onClick={() => setMenu({ kind: 'label', scope: 'bulk' })} />
              <IconButton icon={FolderInput} label="Премести" className={menu?.kind === 'move' && menu.scope === 'bulk' ? 'active' : ''} onClick={() => setMenu({ kind: 'move', scope: 'bulk' })} />
              {canArchive && <IconButton icon={Archive} label="Архивирай" onClick={() => moveTo('archive', bulk, archiveFolder.path)} />}
              <IconButton icon={Trash2} label={inTrash ? 'Изтрий завинаги' : 'Изтрий'} className="danger" onClick={() => remove(bulk)} />
            </span>
            {menu?.scope === 'bulk' && menuPanel}
          </div> : labelView ? <div className="filters"><span className="search-scope">Писмата с етикет се пазят в Кампус Поща.</span></div> :
            <div className="filters" role="group" aria-label="Филтър">
              {[['all', 'Всички'], ['unread', 'Непрочетени'], ['starred', 'Със звезда']].map(([value, label]) =>
                <button key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => { setFilter(value); setRows([]); setChecked(new Set()); }}>
                  {label}{value === 'unread' && unseen > 0 && <span className="chip-count">{unseen}</span>}</button>)}
              {search && <span className="search-scope">Търсене: „{search}“</span>}
            </div>}
          {stale && rows.length > 0 && <div className="banner warn" role="status"><TriangleAlert size={16} /><span>{stale}{stamp && ' Показани са писмата от ' + clock.format(stamp) + '.'}</span>
            <button className="quiet-button" onClick={() => refresh()} disabled={busy}>Опитай пак</button></div>}
          <div className="message-list" ref={list} aria-busy={busy} onKeyDown={listKeys}>
            {currentRows.map((item, index) => {
              const label = sentFolder ? person(item.to) : person(item.from);
              const isSelected = selected?.id === item.id;
              const isChecked = checked.has(item.id);
              const rowLabels = (item.labels || []).map(labelById).filter(Boolean);
              return <div key={item.id} data-id={item.id} className={'message-row' + (isSelected ? ' selected' : '') + (item.unread ? ' unread' : '') + (isChecked ? ' checked' : '')}>
                <button type="button" className="row-check" aria-pressed={isChecked} aria-label={(isChecked ? 'Махни избора: ' : 'Избери: ') + (item.subject || 'Без тема')}
                  onClick={event => toggleCheck(item, index, event.shiftKey)}>
                  <Avatar label={label} index={index} /><span className="check-mark" aria-hidden="true"><Check size={15} strokeWidth={3} /></span>
                </button>
                <button type="button" className="row-open" onClick={event => event.shiftKey || checked.size ? toggleCheck(item, index, event.shiftKey) : openMessage(item, event.currentTarget)} aria-current={isSelected ? 'true' : undefined}>
                  <span className="row-sender">{sentFolder && <span className="row-to">До </span>}{label}</span>
                  <time className="row-date" dateTime={item.date}>{rowDate(item.date)}</time>
                  <span className="row-subject">{item.subject || 'Без тема'}</span>
                  <span className="row-flags">{item.attachment && <Paperclip size={14} aria-label="Има приложение" />}{item.unread && <i className="unread-dot" />}{item.unread && <span className="sr-only">Непрочетено</span>}</span>
                  {(rowLabels.length > 0 || labelView) && <span className="row-labels">
                    {labelView && <span className="row-folder">{item.moved ? 'Преместено' : folderLabel(folders.find(entry => entry.path === item.folder) || { path: item.folder, name: item.folder })}</span>}
                    {rowLabels.map(entry => <LabelChip key={entry.id} label={entry} />)}</span>}
                </button>
                {!labelView && <button type="button" className={'row-star' + (item.starred ? ' on' : '')} aria-pressed={Boolean(item.starred)}
                  aria-label={item.starred ? 'Махни звездата' : 'Отбележи със звезда'} onClick={() => toggleStar([item])}>
                  <Star size={16} strokeWidth={1.8} fill={item.starred ? 'currentColor' : 'none'} /></button>}
              </div>;
            })}
            {loadingList && Array.from({ length: 6 }, (_, index) => <div className="skeleton-row" key={'skeleton-' + index} aria-hidden="true"><i /><i /><i /></div>)}
            {!currentRows.length && !loadingList && <div className="list-placeholder">
              {stale ? <TriangleAlert size={24} /> : search ? <Search size={24} /> : labelView ? <Tag size={24} /> : <Inbox size={24} />}
              <strong>{emptyText}</strong>
              {search && !busy && <span>Търсим само по подател и тема в „{folderName}“.{cursor ? ' Заредете още, за да проверим по-стари писма.' : ''}</span>}
              {labelView && !busy && <span>Изберете писма и натиснете „Етикет“, за да ги добавите тук.</span>}
              {stale && !busy && <button className="quiet-button" onClick={() => refresh()}>Опитай пак</button>}
            </div>}
            {cursor && <button className="more-button" onClick={() => refresh(cursor)} disabled={busy}>{busy ? 'Зареждане…' : 'Зареди още'} <ChevronDown size={14} /></button>}
            <span className="select-glow" ref={glow} aria-hidden="true" />
          </div>
        </section>

        <section className="reader" aria-label="Четене на писмо">
          {selected ? <>
            <div className="reader-toolbar">
              <IconButton icon={ArrowLeft} label="Към списъка" className="reader-back" onClick={returnToList} />
              <div className="toolbar-folder">{folderName}</div>
              <div className="reader-icons">
                <IconButton icon={Reply} label="Отговори" className="reply-icon" disabled={reading || Boolean(selected.bodyError)} onClick={() => newMessage('reply')} />
                <IconButton icon={ReplyAll} label="Отговори на всички" className="reply-icon" disabled={reading || Boolean(selected.bodyError)} onClick={() => newMessage('replyAll')} />
                <IconButton icon={Forward} label="Препрати" className="reply-icon" disabled={reading || Boolean(selected.bodyError)} onClick={() => newMessage('forward')} />
                <span className="toolbar-divider" aria-hidden="true" />
                <IconButton icon={Star} label={selected.starred ? 'Махни звездата' : 'Звезда'} className={selected.starred ? 'starred' : ''} pressed={Boolean(selected.starred)} filled={selected.starred}
                  disabled={reading || Boolean(selected.bodyError)} onClick={() => toggleStar([selected])} />
                <IconButton icon={Mail} label="Маркирай като непрочетено" disabled={reading || Boolean(selected.bodyError) || selected.unread} onClick={() => setFlag('unread', [selected])} />
                <IconButton icon={Tag} label="Етикет" className={menu?.scope === 'reader' ? 'active' : ''} disabled={reading || Boolean(selected.bodyError)} onClick={() => setMenu({ kind: 'label', scope: 'reader' })} />
                {canArchive && <IconButton icon={Archive} label="Архивирай" disabled={reading || Boolean(selected.bodyError)} onClick={() => moveTo('archive', [selected], archiveFolder.path)} />}
                <IconButton icon={Trash2} label={inTrash ? 'Изтрий завинаги' : 'Изтрий'} className="danger" disabled={reading || Boolean(selected.bodyError)} onClick={() => remove([selected])} />
              </div>
              {menu?.scope === 'reader' && menuPanel}
            </div>
            <article className="letter" key={selected.id}>
              <h2>{selected.subject || 'Без тема'}</h2>
              {selected.labels?.length > 0 && <div className="letter-labels">{selected.labels.map(labelById).filter(Boolean).map(entry => <LabelChip key={entry.id} label={entry} />)}</div>}
              <div className="letter-sender"><Avatar label={person(selected.from)} index={selectedIndex} large />
                <div className="letter-who"><strong>{person(selected.from)}</strong><small>{selected.from?.[0]?.address || ''}</small></div>
                <time dateTime={selected.date}>{longDate.format(new Date(selected.date))}</time>
              </div>
              {selected.to?.length > 0 && <p className="letter-recipients"><span>До: {selected.to.map(value => value.name || value.address).join(', ')}</span>
                {selected.cc?.length > 0 && <span>Копие: {selected.cc.map(value => value.name || value.address).join(', ')}</span>}</p>}
              <div className="letter-body">
                {reading ? <div className="skeleton-body" role="status"><span className="sr-only">Зареждане на писмото…</span><i /><i /><i /><i /></div> : selected.bodyError ?
                  <div className="banner warn"><TriangleAlert size={16} /><span>{selected.bodyError}</span>{!selected.moved && <button className="quiet-button" onClick={() => openMessage(selected)}>Опитай пак</button>}</div> :
                  <>{selected.truncated && <div className="banner info"><TriangleAlert size={16} /><span>Писмото е много дълго и е показано съкратено. Пълният текст е в TUSmail.</span></div>}
                    <MessageBody message={selected} theme={themeValue} /></>}
              </div>
              {!reading && selected.files?.length > 0 && <div className="files">
                <h3>Приложения <span>{selected.files.length}</span></h3>
                {selected.files.map(file => <div className="file" key={file.part}>
                  <span className="file-glyph" aria-hidden="true">{fileKind(file.name)}</span>
                  <span className="file-name"><strong title={file.name}>{file.name}</strong><small>{bytes(file.size)}</small></span>
                  {file.preview && <button className="quiet-button" onClick={() => loadFile(selected, file, true)}><FileText size={15} /> Преглед</button>}
                  <IconButton icon={ArrowDownToLine} label={'Изтегли ' + file.name} onClick={() => loadFile(selected, file, false)} />
                </div>)}
              </div>}
              {!reading && !selected.bodyError && <div className="reply-bar">
                <button className="reply-button" onClick={() => newMessage('reply')}><Reply size={16} /> Отговори</button>
                {selected.to?.length + (selected.cc?.length || 0) > 1 && <button className="reply-button" onClick={() => newMessage('replyAll')}><ReplyAll size={16} /> На всички</button>}
                <button className="reply-button" onClick={() => newMessage('forward')}><Forward size={16} /> Препрати</button>
              </div>}
            </article>
          </> : <div className="reader-empty"><span><MailOpen size={28} /></span><h2>Изберете писмо</h2>
            <p>{markRead ? 'Отвореното писмо се маркира като прочетено и в TUSmail.' : 'Отварянето не променя статуса „непрочетено“ в TUSmail.'} Натиснете ? за клавишни комбинации.</p></div>}
        </section>
      </main>

      {toastData && <div className={'toast' + (toastData.error ? ' error' : '')} role={toastData.error ? 'alert' : 'status'}>
        {toastData.error ? <TriangleAlert size={17} /> : <Check size={17} />}<span>{toastData.text}</span>
        {toastData.action && <button className="toast-action" onClick={toastData.action.run}>{toastData.action.label}</button>}</div>}

      {confirm && <Modal label={confirm.title} close={() => setConfirm(null)}>
        <div className="confirm">
          <h2>{confirm.title}</h2>
          <p>{confirm.text}</p>
          <div className="confirm-actions">
            <button className="quiet-button" data-autofocus onClick={() => setConfirm(null)}>Отказ</button>
            <button className="primary danger" onClick={() => { const run = confirm.run; setConfirm(null); run(); }}>{confirm.action}</button>
          </div>
        </div>
      </Modal>}

      {shortcuts && <Modal label="Клавишни комбинации" close={() => setShortcuts(false)}>
        <div className="shortcuts">
          <h2>Клавишни комбинации</h2>
          <dl>{shortcutList.map(([keys, text]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{text}</dd></div>)}</dl>
        </div>
      </Modal>}

      {composer && <Modal label={composeTitle} close={closeCompose} sheet>
        <form className="composer" onSubmit={sendDraft} onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit(); }
        }}>
          <div className="composer-title"><h2>{composeTitle}</h2><small>От: {account.user}</small></div>
          <fieldset disabled={Boolean(sendState)}>
            <label className="address-line"><span>До</span><input value={composer.to} onChange={e => changeField('to', e.target.value)} aria-label="До" type="text" inputMode="email" autoComplete="email" maxLength={8000} placeholder="адрес@tu-sofia.bg, …" data-autofocus={composeKind === 'reply' || composeKind === 'replyAll' ? undefined : true} />
              <button className="field-toggle" type="button" aria-expanded={ccVisible} onClick={() => setCcVisible(!ccVisible)}>Копие</button></label>
            {ccVisible && <>
              <label className="address-line"><span>Копие</span><input value={composer.cc} onChange={e => changeField('cc', e.target.value)} aria-label="Копие (CC)" inputMode="email" maxLength={8000} /></label>
              <label className="address-line"><span>Скрито</span><input value={composer.bcc} onChange={e => changeField('bcc', e.target.value)} aria-label="Скрито копие (BCC)" inputMode="email" maxLength={8000} /></label>
            </>}
            <label className="address-line"><span>Тема</span><input value={composer.subject} onChange={e => changeField('subject', e.target.value)} aria-label="Тема" maxLength={400} /></label>
            <textarea value={composer.text} onChange={e => changeField('text', e.target.value)} aria-label="Текст на писмото" placeholder="Напишете писмото си…" maxLength={200000}
              data-autofocus={composeKind === 'reply' || composeKind === 'replyAll' ? true : undefined} />
            {(composer.files.length > 0 || pendingFiles.length > 0) && <ul className="draft-files" aria-label="Прикачени файлове">
              {composer.files.map(file => <li key={file.id}><span className="file-glyph small" aria-hidden="true">{fileKind(file.name)}</span>
                <span className="file-name"><strong title={file.name}>{file.name}</strong><small>{bytes(file.size)}</small></span>
                <IconButton icon={X} label={'Махни ' + file.name} onClick={() => removeFile(file.id)} /></li>)}
              {pendingFiles.map((name, index) => <li key={'pending-' + index} className="pending"><LoaderCircle size={16} className="spin" />
                <span className="file-name"><strong>{name}</strong><small>Прикачване…</small></span></li>)}
            </ul>}
            {draftBytes > 0 && <small className="draft-total">Общо {bytes(draftBytes)} от 18 MB</small>}
          </fieldset>
          {composeError && <div className="banner danger" role="alert"><TriangleAlert size={16} /><span>{composeError}</span></div>}
          {statusText && sendState.status !== 'sending' && <div className={'banner ' + sendTone} role="status">{sendTone === 'info' ? <Send size={16} /> : <TriangleAlert size={16} />}<span>{statusText}</span></div>}
          <div className="composer-actions">
            {sendState?.status === 'sending' && <button type="button" className="primary is-sending" disabled aria-live="polite"><LoaderCircle size={16} className="spin" /> {statusText}</button>}
            {!sendState && <><button className="primary" disabled={uploading} aria-keyshortcuts="Control+Enter"><Send size={16} /> Изпрати</button>
              <label className={'attach-button' + (uploading ? ' disabled' : '')}><Paperclip size={17} /> {uploading ? 'Прикачване…' : 'Прикачи'}<input type="file" multiple disabled={uploading} onChange={addFiles} /></label>
              <small className="autosave">Черновата се пази автоматично.</small></>}
            {sendState?.status === 'copy_pending' && <button type="button" className="primary" onClick={() => updateSend(true)}>Запази копие в „Изпратени“</button>}
            {['sending', 'unknown', 'copy_pending'].includes(sendState?.status) && <button type="button" className="quiet-button" onClick={() => updateSend(false)}><RefreshCw size={16} /> Провери статуса</button>}
            {['unknown', 'partial', 'copy_expired'].includes(sendState?.status) && <button type="button" className="quiet-button" onClick={clearAttempt}>Ново празно писмо</button>}
          </div>
        </form>
      </Modal>}

      {preview && <Modal label={preview.name} close={() => setPreview(null)} wide><div className="preview"><h2>{preview.name}</h2>
        {preview.type.startsWith('image/') ? <img src={preview.url} alt={preview.name} /> : <PdfPreview url={preview.url} />}
        <a className="quiet-button" href={preview.url} download={preview.name}><ArrowDownToLine size={16} /> Изтегли файла</a></div></Modal>}
    </div>
  );
}

function Modal({ label, close, children, wide, sheet }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element.showModal();
    const target = element.querySelector('[data-autofocus]');
    target?.focus();
    if (target?.tagName === 'TEXTAREA') { target.setSelectionRange(0, 0); target.scrollTop = 0; }
    return () => {
      if (element.open) element.close();
      opener?.focus?.({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} aria-label={label} className={'modal ' + (wide ? 'wide' : '') + (sheet ? ' sheet' : '')}
    onCancel={event => { event.preventDefault(); close(); }}>
    <IconButton icon={X} label="Затвори" className="modal-close" onClick={close} />{children}
  </dialog>;
}
