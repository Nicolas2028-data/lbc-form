// LBC Care Service Worker (v1 - 2026-09-06)
// 目的: 静的アセット(HTML/JS/CSS/JSON)を network-first + cache fallback で提供し、
//       iPad で offline 中も UI が起動できるようにする(送信は online に戻ってから)。

const CACHE_NAME = 'lbc-static-v1';
const STATIC_ASSETS = [
  './',
  './questionnaire.html',
  './treatment-record.html',
  './dashboard.html',
  './i18n/i18n.js',
  './i18n/ja.json',
  './i18n/es.json',
  './i18n/pt.json',
  './js/common.js',
  './body-diagram.png',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // GAS API・face-api CDN・cdn.jsdelivr は絶対にキャッシュしない(常に network)
  if (url.hostname === 'script.google.com' ||
      url.hostname === 'cdn.jsdelivr.net' ||
      url.hostname.endsWith('.google.com') ||
      url.hostname === 'api.notion.com') {
    return; // ネットワーク直接
  }

  // 同一オリジンの GET のみ対応(POST は素通り)
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 200 OK のみキャッシュ更新
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
