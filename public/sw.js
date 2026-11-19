// Кампус Поща service worker: shows new-mail notifications and opens the message on tap. No caching, no fetch handler.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || 'Кампус Поща';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Ново писмо',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.uid ? 'mail-' + data.epoch + '-' + data.uid : (data.tag || 'kampus'),
    data: { folder: data.folder || 'INBOX', epoch: data.epoch || null, uid: data.uid || null },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { folder, epoch, uid } = event.notification.data || {};
  const target = '/mail' + (uid ? '?open=' + encodeURIComponent([folder, epoch, uid].join(':')) : '');
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(client => new URL(client.url).pathname === '/mail');
    if (open) {
      await open.focus();
      if (uid) open.postMessage({ type: 'open-message', folder, epoch: String(epoch), uid: Number(uid) });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
