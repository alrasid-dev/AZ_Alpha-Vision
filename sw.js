const CACHE_NAME = 'az-alpha-shell-v3';
const APP_URL = './';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([APP_URL, './index.html'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('az-alpha-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text?.() || '' }; }
  const title = data.title || 'AZ Alpha Vision — تنبيه تعليمي';
    const direction = data.direction === 'up' ? 'up' : data.direction === 'down' ? 'down' : 'neutral';
    const options = {
      body: data.body || 'وصلت إشارة تعليمية جديدة من الماسح.',
      icon: data.icon || './icon-192.png',
      badge: data.badge || './icon-192.png',
      tag: data.tag || `az-signal-${Date.now()}`,
      data: { url: data.url || './#signals', direction, alertType: data.alertType || 'general' },
      color: data.color || (direction === 'up' ? '#76d6a2' : direction === 'down' ? '#e98c91' : '#6bd8d0'),
      requireInteraction: false,
      renotify: false,
    };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/#signals';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if ('focus' in client) { client.navigate(url); return client.focus(); }
    }
    return clients.openWindow(url);
  }));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // لا يمكن للعامل تحديث قاعدة البيانات وحده بلا هوية مستخدم؛ يطلب من أي صفحة مفتوحة إعادة المزامنة بأمان.
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    clientList.forEach((client) => client.postMessage({ type: 'az-push-subscription-change' }));
  }));
});

