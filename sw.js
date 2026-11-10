// Sajesson Guide service worker v3 — works offline.
// v2 behaviour kept (network-first pages, cached shell, push notifications) and added:
//  - the Supabase script + Bengali font are cached, so the app starts offline
//  - file images/thumbnails are cached when seen once, so they show offline
//  - Supabase login / database / downloads are never touched
const VER = 'sajesson-v3';
const IMG = 'sajesson-img-v1';
const SHELL = ['./', 'index.html', 'manifest.json', 'splash-anim.webp', 'icon-192.png', 'icon-512.png', 'maskable-512.png'];
// outside files the page needs to start (same URLs as in index.html)
const LIBS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4',
  'https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap'
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const IMG_MAX_ITEMS = 250;            // keep at most this many images
const IMG_MAX_BYTES = 2.5 * 1024 * 1024; // skip single images bigger than this

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VER).then(c => Promise.all([
      ...SHELL.map(u => c.add(u).catch(() => {})),
      ...LIBS.map(u => c.add(new Request(u, { mode: 'cors' })).catch(() => {}))
    ])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VER && k !== IMG).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimImages(cache) {
  const ks = await cache.keys();
  if (ks.length > IMG_MAX_ITEMS) await Promise.all(ks.slice(0, ks.length - IMG_MAX_ITEMS).map(k => cache.delete(k)));
}

// File pictures from Supabase storage. Cached by path (the changing ?token= is ignored),
// so a picture seen once is still there offline even after its link expired.
async function imageHandler(ev, req, url) {
  const cache = await caches.open(IMG);
  const key = new Request(url.origin + url.pathname);
  const hit = await cache.match(key);
  if (hit) return hit;
  let res;
  try { res = await fetch(url.href, { mode: 'cors', credentials: 'omit' }); }
  catch (_) { return fetch(req); }
  if (res && res.ok) {
    const type = res.headers.get('content-type') || '';
    const len = Number(res.headers.get('content-length') || 0);
    if (/^image\//.test(type) && (!len || len <= IMG_MAX_BYTES)) {
      ev.waitUntil(cache.put(key, res.clone()).then(() => trimImages(cache)).catch(() => {}));
    }
  }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Supabase: only plain pictures are cached. Login, database, downloads and everything else go straight to the network.
  if (url.origin !== self.location.origin) {
    if (url.hostname.endsWith('.supabase.co')) {
      if (req.destination === 'image' && !req.headers.get('range') &&
          /\/storage\/v1\/object\/(sign|public)\//.test(url.pathname)) {
        e.respondWith(imageHandler(e, req, url));
      }
      return;
    }
    // Script + font files the page needs: from cache first, refreshed in the background.
    if (CDN_HOSTS.includes(url.hostname)) {
      e.respondWith((async () => {
        const cache = await caches.open(VER);
        const hit = await cache.match(req, { ignoreVary: true });
        const net = fetch(req).then(res => {
          if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
          return res;
        }).catch(() => null);
        if (hit) { e.waitUntil(net); return hit; }
        return (await net) || Response.error();
      })());
    }
    return;
  }

  // Pages: network first (updates show immediately). Offline, or if the network is very slow, the saved page opens.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(VER);
      const net = fetch(req).then(res => {
        if (res && res.ok) cache.put('index.html', res.clone());
        return res;
      });
      net.catch(() => {});
      const saved = () => cache.match('index.html').then(r => r || cache.match('./'));
      try {
        return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4500))]);
      } catch (_) {
        const r = await saved();
        return r || net;
      }
    })());
    return;
  }

  // Static files (animation, icons, manifest): instant from cache, refresh in background.
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(VER).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// Push notifications: show a notification when the server sends one.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(String(d.title || 'সাজেশন গাইড').slice(0, 80), {
    body: String(d.body || 'নতুন ফাইল যোগ হয়েছে').slice(0, 160),
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'new-file',
    renotify: true,
    data: { url: './' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL('./', self.location.href).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
          
