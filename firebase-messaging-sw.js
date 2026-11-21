/**
 * JASA V2 - Firebase Messaging Service Worker
 * Handles background push messages when app tab is closed or not focused.
 * Standalone file - does NOT import sw.js to avoid double listeners.
 */

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');
importScripts('env-config-sw.js'); // provides: var FIREBASE_CONFIG = {...}

firebase.initializeApp(FIREBASE_CONFIG);

/* ── No-cache mode: take over at once and delete any Cache Storage left by
      older caching service workers (this worker caches nothing). ── */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (evt) {
    evt.waitUntil(
        caches.keys()
            .then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
            .catch(function () {})
            .then(function () { return self.clients.claim(); })
    );
});
const messaging = firebase.messaging();

/* ── Background push (tab closed / not focused) ── */
messaging.onBackgroundMessage(function(payload) {
    console.log('[FCM SW] Background message:', payload);

    /* Order pushes from the omx-api Worker are data-only (title/body/url/tag/kind
       in data); marketing pushes carry a notification block. */
    var data  = payload.data || {};
    var title = data.title || (payload.notification && payload.notification.title) || 'Order My Xerox';
    var body  = data.body  || (payload.notification && payload.notification.body)  || '';
    var url   = data.url || 'index.html';
    var image = (payload.notification && payload.notification.image)
             || (payload.data && payload.data.image)
             || null;

    var opts = {
        body:    body,
        icon:    'assets/icons/android/launchericon-192x192.png',
        badge:   'assets/icons/android/launchericon-96x96.png',
        data:    { url: url },
        vibrate: [200, 100, 200],
        tag:     data.tag || 'jasa-fcm',
        renotify: true,
        requireInteraction: data.kind === 'new_order'   // staff: stays until tapped
    };
    if (image) opts.image = image;

    return self.registration.showNotification(title, opts);
});

/* ── Notification click - open / focus the relevant page ── */
self.addEventListener('notificationclick', function(evt) {
    evt.notification.close();

    var path     = (evt.notification.data && evt.notification.data.url) || 'index.html';
    var fullPath = self.location.origin + (path.startsWith('/') ? path : '/' + path);

    evt.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
            var existing = list.find(function(c) {
                return c.url === fullPath || c.url.indexOf(path) !== -1;
            });
            if (existing) return existing.focus();
            return clients.openWindow(fullPath);
        })
    );
});
