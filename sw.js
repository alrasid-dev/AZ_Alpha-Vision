const CACHE_NAME = 'az-alpha-shell-v8';
const APP_URL = './';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([APP_URL, './index.html', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

function directionAccent(direction) {
  if (direction === 'up') return { emoji: '🟢', color: '#12b76a' };
  if (direction === 'down') return { emoji: '🔴', color: '#f04438' };
  return { emoji: '⚪', color: '#98a2b3' };
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text?.() || '' }; }

  const direction = data.direction === 'up' ? 'up' : data.direction === 'down' ? 'down' : 'neutral';
  const accent = directionAccent(direction);
  const silent = Boolean(data.silent);
  const alertType = data.alertType || 'general';

  // عناوين مركّزة للجوال — تجنّب تجميع رموز كثيرة في سطر واحد قبيح
  let title = data.title || 'AZ Alpha Vision — تنبيه تعليمي';
  if (!String(title).includes('🟢') && !String(title).includes('🔴') && !String(title).includes('⚪') && direction !== 'neutral') {
    title = `${accent.emoji} ${title}`;
  }

  const body = data.body || 'وصلت إشارة تعليمية جديدة.';
  const tag = data.tag || `az-${alertType}-${Date.now()}`;

  const options = {
    body,
    icon: data.icon || './icon-192.png',
    badge: data.badge || './icon.svg',
    image: data.image || undefined,
    tag,
    data: {
      url: data.url || './#signals',
      direction,
      alertType,
      silent,
      color: accent.color,
    },
    // وضع صامت: يظهر الإشعار الملون على شاشة الهاتف بدون صوت/اهتزاز
    silent,
    vibrate: silent ? [] : [80, 40, 80],
    renotify: !silent,
    requireInteraction: Boolean(data.requireInteraction),
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || './#signals';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if ('focus' in client) { client.navigate(url); return client.focus(); }
    }
    return clients.openWindow(url);
  }));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    clientList.forEach((client) => client.postMessage({ type: 'az-push-subscription-change' }));
  }));
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'az-pulse') event.waitUntil(Promise.resolve());
});
