const CACHE_NAME = 'az-alpha-shell-v1';
const APP_URL = './';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([APP_URL, './index.html'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text?.() || '' }; }
  const title = data.title || 'AZ Alpha Vision — تنبيه تعليمي';
  const options = {
    body: data.body || 'وصلت إشارة تعليمية جديدة من الماسح.',
    icon: data.icon || './icon.svg',
    badge: data.badge || './icon.svg',
    tag: data.tag || `az-signal-${Date.now()}`,
    data: { url: data.url || './#signals' },
    requireInteraction: false,
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

self.addEventListener('pushsubscriptionchange', () => {
  // إعادة الاشتراك تتم عند فتح الموقع عبر app.js إذا انتهت صلاحية الاشتراك.
});

