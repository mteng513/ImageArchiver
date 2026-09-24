// App-shell cache. Only same-origin app files are cached; B2 requests and
// decrypted images never pass through here.
const VERSION = 'v0.3.3';
const SHELL = ['./', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/app.js', 'js/core.js', 'js/crypto.js', 'js/images.js', 'js/log.js', 'js/s3.js', 'js/store.js', 'js/ui.js', 'js/util.js', 'js/viewer.js',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Network first (so updates arrive), cache as the offline fallback.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
