/**
 * Order My Xerox - JASA V2 Service Worker
 * NO-CACHE MODE: this worker caches nothing. Every page, script, style, image
 * and API call goes straight to the network, so each load is fresh.
 * It is kept only for PWA / TWA install, push notifications and background sync.
 * On activate it deletes EVERY Cache Storage entry left by older versions
 * (jasa-v2-shell-v*, jasa-v2-runtime-v*, ...) and takes control at once.
 */

const SW_VERSION = 'jasa-v2-nocache-v8';

// ════ INSTALL ═════════════════════════════════════════════════════════════════
// No precache. Activate immediately so old caching workers are replaced on the
// next visit without waiting for every tab to close.
self.addEventListener('install', () => {
    self.skipWaiting();
});

// ════ ACTIVATE ════════════════════════════════════════════════════════════════
self.addEventListener('activate', (evt) => {
    evt.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.map(k => caches.delete(k))))
            .catch(() => {})
            .then(() => self.clients.claim())
    );
});

// ════ FETCH ═══════════════════════════════════════════════════════════════════
// Only page navigations are handled, and only to show a small offline notice
// when the network is down. Everything else is not intercepted at all (the
// browser fetches it normally, following the no-store headers in _headers).
const OFFLINE_HTML = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Offline - Order My Xerox</title>'
    + '<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;'
    + 'min-height:100vh;margin:0;background:#f8fafc;color:#0f172a;text-align:center;padding:24px}'
    + 'button{margin-top:16px;padding:12px 24px;border:0;border-radius:10px;background:#e11d48;color:#fff;font-size:16px}</style>'
    + '</head><body><div><h1>You are offline</h1><p>Check your internet connection and try again.</p>'
    + '<button onclick="location.reload()">Retry</button></div></body></html>';

self.addEventListener('fetch', (evt) => {
    const req = evt.request;
    if (req.method !== 'GET' || req.mode !== 'navigate') return;
    evt.respondWith(
        fetch(req).catch(() => new Response(OFFLINE_HTML, {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        }))
    );
});

// ════ MESSAGE ═════════════════════════════════════════════════════════════════
// Kept for compatibility: a page may still post SKIP_WAITING.
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

/* No-cache mode: nothing to pre-fetch; just tell open pages to refresh their data. */
async function periodicRefreshProducts() {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'PERIODIC_SYNC', tag: 'refresh-products' }));
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
