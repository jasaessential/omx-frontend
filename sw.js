/**
 * Order My Xerox - JASA V2 Service Worker
 * Pages and same-origin code (JS / CSS / JSON) are fetched network-first, so a
 * deploy reaches users on their next load without bumping ?v= tags or the cache
 * name; the cache is only the offline fallback. Bumping CACHE_NAME is still how
 * a change to this file shows the "Update" card (app.js).
 */

const CACHE_NAME    = 'jasa-v2-shell-v6';
const RUNTIME_CACHE = 'jasa-v2-runtime-v6';

const SHELL_FILES = [
    'offline.html',
    'index.html',
    'login.html',
    'categories.html',
    'cart.html',
    'orders.html',
    'xerox-order.html',
    'profile.html',
    'manifest.json',
    'styles.css',
    'app.js',
    'head-cache.js',
    'firebase-init.js',
    'env-config.js',
    'favicon.ico',
    'assets/icons/android/launchericon-192x192.png',
    'assets/icons/android/launchericon-512x512.png',
];

const SKIP_HOSTS = [
    'firestore.googleapis.com',
    'firebase.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'fcmregistrations.googleapis.com',
    'supabase.co',
    'workers.dev',
    'lottie.host',
    'r2.dev',                   // Cloudflare R2 product images — always fetch live
    'r2.cloudflarestorage.com', // R2 direct storage endpoint
];

const CDN_HOSTS = [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
];

// ════ INSTALL ═════════════════════════════════════════════════════════════════
// Do NOT skipWaiting on install — wait for user to tap "Update" on index page.
self.addEventListener('install', (evt) => {
    evt.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(SHELL_FILES).catch(() => {}))
        // No self.skipWaiting() here — the update card in app.js handles it
    );
});

// ════ ACTIVATE ════════════════════════════════════════════════════════════════
self.addEventListener('activate', (evt) => {
    evt.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(k => k !== CACHE_NAME && k !== RUNTIME_CACHE)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// ════ FETCH ═══════════════════════════════════════════════════════════════════
self.addEventListener('fetch', (evt) => {
    const req = evt.request;
    if (req.method !== 'GET') return;

    let url;
    try { url = new URL(req.url); } catch { return; }

    if (url.protocol === 'chrome-extension:') return;
    if (SKIP_HOSTS.some(h => url.hostname.includes(h))) return;

    if (req.mode === 'navigate') {
        evt.respondWith(networkFirstNavigate(req, url));
        return;
    }
    if (req.destination === 'image') {
        evt.respondWith(staleWhileRevalidate(req));
        return;
    }
    if (CDN_HOSTS.some(h => url.hostname.includes(h))) {
        evt.respondWith(cacheFirst(req));
        return;
    }
    if (url.hostname === self.location.hostname) {
        const isCode = ['script', 'style', 'manifest'].includes(req.destination)
            || /\.(m?js|css|json)$/.test(url.pathname);
        evt.respondWith(isCode ? networkFirst(req) : cacheFirst(req));
        return;
    }
});

// ─── Strategies ───────────────────────────────────────────────────────────────
async function networkFirstNavigate(req, url) {
    try {
        const res = await fetch(req);
        if (res.ok) {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(req, res.clone());
        }
        return res;
    } catch {
        return (
            await caches.match(req) ||
            await caches.match(url.pathname) ||
            await caches.match('offline.html') ||
            new Response('Offline', { status: 503 })
        );
    }
}

/* Fresh code when online; cached copy if the network fails or takes > 4s */
async function networkFirst(req) {
    const cache = await caches.open(RUNTIME_CACHE);
    try {
        const res = await Promise.race([
            fetch(req),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
        ]);
        if (res.ok) cache.put(req, res.clone());
        return res;
    } catch {
        return (await caches.match(req)) || new Response('Offline', { status: 503 });
    }
}

async function cacheFirst(req) {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
        const res   = await fetch(req);
        const cache = await caches.open(RUNTIME_CACHE);
        if (res.ok) cache.put(req, res.clone());
        return res;
    } catch {
        return new Response('Offline', { status: 503 });
    }
}

async function staleWhileRevalidate(req) {
    const cache  = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(req);
    const fetchP = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
    }).catch(() => cached);
    return cached || fetchP;
}

// ════ MESSAGE ═════════════════════════════════════════════════════════════════
// The update banner in app.js posts SKIP_WAITING when the user taps "Update".
self.addEventListener('message', (evt) => {
    if (evt.data && evt.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// ════ BACKGROUND SYNC ═════════════════════════════════════════════════════════
const IDB_NAME  = 'jasa-sync-db';
const IDB_STORE = 'pending_orders';

self.addEventListener('sync', (evt) => {
    if (evt.tag === 'sync-pending-orders') {
        evt.waitUntil(syncPendingOrders());
    }
    if (evt.tag === 'refresh-products' || evt.tag === 'refresh-orders') {
        evt.waitUntil(
            self.clients.matchAll({ includeUncontrolled: true }).then(clients =>
                clients.forEach(c => c.postMessage({ type: 'PERIODIC_SYNC', tag: evt.tag }))
            )
        );
    }
});

self.addEventListener('periodicsync', (evt) => {
    if (evt.tag === 'refresh-products') evt.waitUntil(periodicRefreshProducts());
    if (evt.tag === 'refresh-orders') {
        evt.waitUntil(
            self.clients.matchAll({ includeUncontrolled: true }).then(clients =>
                clients.forEach(c => c.postMessage({ type: 'PERIODIC_SYNC', tag: 'refresh-orders' }))
            )
        );
    }
});

async function periodicRefreshProducts() {
    const cache = await caches.open(RUNTIME_CACHE);
    const pages = ['index.html', 'categories.html', 'xerox-order.html'];
    await Promise.allSettled(pages.map(async p => {
        try { const r = await fetch(p); if (r.ok) await cache.put(p, r); } catch (_) {}
    }));
}

function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE))
                db.createObjectStore(IDB_STORE, { keyPath: 'localId' });
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
    });
}

async function syncPendingOrders() {
    const db  = await openIDB();
    const all = await new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });

    if (!all || !all.length) return;

    for (const record of all) {
        try {
            const { localId, payload } = record;
            const res = await fetch(
                `https://firestore.googleapis.com/v1/projects/${payload._projectId}/databases/(default)/documents/${payload._collection}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload._firestoreDoc) }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await new Promise((resolve, reject) => {
                const tx  = db.transaction(IDB_STORE, 'readwrite');
                const req = tx.objectStore(IDB_STORE).delete(localId);
                req.onsuccess = () => resolve();
                req.onerror   = () => reject(req.error);
            });
            const clients = await self.clients.matchAll({ includeUncontrolled: true });
            clients.forEach(c => c.postMessage({ type: 'SYNC_RESULT', tag: 'sync-pending-orders', status: 'success', localId }));
            self.registration.showNotification('Order Placed!', {
                body:  'Your pending order was submitted successfully.',
                icon:  'assets/icons/android/launchericon-192x192.png',
                badge: 'assets/icons/android/launchericon-96x96.png',
                data:  { url: 'orders.html' },
            });
        } catch (err) {
            console.error('[SW] Order sync failed:', err.message);
            const clients = await self.clients.matchAll({ includeUncontrolled: true });
            clients.forEach(c => c.postMessage({ type: 'SYNC_RESULT', tag: 'sync-pending-orders', status: 'failed', localId: record.localId, error: err.message }));
            throw err;
        }
    }
}

// ════ PUSH ════════════════════════════════════════════════════════════════════
self.addEventListener('push', (evt) => {
    let title = 'Order My Xerox', body = '', path = 'index.html', image = null;
    if (evt.data) {
        try {
            const d = evt.data.json();
            title = d.notification && d.notification.title || d.title || title;
            body  = d.notification && d.notification.body  || d.body  || body;
            path  = d.data && d.data.url || d.url || path;
            image = d.notification && d.notification.image || d.data && d.data.image || null;
        } catch { body = evt.data.text(); }
    }
    const opts = {
        body, vibrate: [200, 100, 200],
        icon:  'assets/icons/android/launchericon-192x192.png',
        badge: 'assets/icons/android/launchericon-96x96.png',
        data:  { url: path }, tag: 'jasa-notification', renotify: true,
    };
    if (image) opts.image = image;
    evt.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (evt) => {
    evt.notification.close();
    if ('clearAppBadge' in self.navigator) self.navigator.clearAppBadge().catch(() => {});
    const path     = evt.notification.data && evt.notification.data.url || 'index.html';
    const fullPath = self.location.origin + '/' + path.replace(/^\//, '');
    evt.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            const existing = list.find(c => c.url === fullPath || c.url.includes(path));
            if (existing) return existing.focus();
            return clients.openWindow(fullPath);
        })
    );
});
