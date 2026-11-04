// 푸시 알림을 받아서 폰에 띄우고, 누르면 사이트를 연다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || '새 메일', {
    body: data.body || '',
    tag: data.tag,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('navigate' in w) { await w.navigate(url); return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
