(function () {
    /* ═══════════════════════════════════════════════
       JASA V2 — head-cache.js
       Runs immediately in <head> before any module loads.
       Purpose:
         1. Apply stored theme instantly (no flash)
         2. Inject cached user identity into sidebar (no auth flash)
         3. No-cache mode: wipe local data caches on every load
         4. Register Service Worker
         5. Offline redirect guard
       ═══════════════════════════════════════════════ */

    /* ── 1. INSTANT THEME (must run first — prevents white flash) ── */
    try {
        var THEME_KEY = 'jasa_theme';
        var mode = localStorage.getItem(THEME_KEY) || 'light';
        var effective = mode === 'device'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : mode;
        document.documentElement.setAttribute('data-theme', effective);
    } catch (_) {}

    /* ── 2. NO-CACHE MODE — wipe every on-device data cache on EVERY load ──
       The app runs without caches for now: pages, code and data are always
       fetched fresh. This runs before any other script on the page, so no
       page can read a stale copy left by an older version (or by a file that
       still writes one). Kept: sign-in, cart, theme, saved location / PIN,
       referral hand-off, wall-builder drafts, seller filters, wallet throttle.
       Exposed as window.jasaClearDataCaches() for the profile / admin pages. */
    var KEEP_EXACT = {
        'jasa_user_cache': 1, 'jasa_cart': 1, 'jasa_theme': 1,
        'jasa_xerox_location_v3': 1, 'jasa_xerox_pin_v1': 1, 'jasa_pending_ref': 1
    };
    var KEEP_PREFIX = ['firebase', 'jasa_ref_try_', 'jasa_wall_', 'so_filter_', 'jasa_wallet_sync_'];
    var CLEAR_EXACT = {
        'global_shops_data_v1': 1, 'jasa_orders_cache': 1, 'jasa_payment_config': 1,
        'jasa_xerox_config_v1': 1, 'jasa_xerox_shops_v1': 1, 'jasa_xerox_shops_v2': 1,
        'jasa_cache_version': 1
    };
    var CLEAR_PREFIX = [
        'jasa_v2_',            /* jasa_v2_cat_ / _hcat_ / _item_ / _catver_ (catalog copies) */
        'ao_shops_v', 'global_shops_data', 'jasa_xerox_config_v', 'jasa_xerox_shops_v',
        'jasa_pr_history_', 'jasa_sq_history_',
        'user_contact_', 'jasa_contact_'
    ];
    var CLEAR_PATTERN = /(_cache$|_cache_|cache_v\d|_data_v\d)/i;

    function isDataCacheKey(k) {
        if (!k || KEEP_EXACT[k]) return false;
        var i;
        for (i = 0; i < KEEP_PREFIX.length; i++) if (k.indexOf(KEEP_PREFIX[i]) === 0) return false;
        if (CLEAR_EXACT[k]) return true;
        for (i = 0; i < CLEAR_PREFIX.length; i++) if (k.indexOf(CLEAR_PREFIX[i]) === 0) return true;
        return CLEAR_PATTERN.test(k);
    }

    function wipeStore(store) {
        var n = 0;
        try {
            var keys = [];
            for (var i = 0; i < store.length; i++) keys.push(store.key(i));
            keys.forEach(function (k) {
                if (isDataCacheKey(k)) { store.removeItem(k); n++; }
            });
        } catch (_) {}
        return n;
    }

    function jasaClearDataCaches() {
        var n = wipeStore(localStorage) + wipeStore(sessionStorage);
        /* Cache Storage left by older service workers */
        try {
            if (window.caches && caches.keys) {
                caches.keys().then(function (names) {
                    names.forEach(function (name) { caches.delete(name); });
                }).catch(function () {});
            }
        } catch (_) {}
        /* Old Firestore offline copy (IndexedDB "firestore/..."); firebase-init.js
           now uses a memory-only cache. Sign-in, push and pending-order databases
           are left alone. */
        try {
            if (window.indexedDB && indexedDB.databases) {
                indexedDB.databases().then(function (dbs) {
                    (dbs || []).forEach(function (d) {
                        if (d && d.name && d.name.indexOf('firestore/') === 0) {
                            try { indexedDB.deleteDatabase(d.name); } catch (_) {}
                        }
                    });
                }).catch(function () {});
            }
        } catch (_) {}
        return n;
    }
    window.jasaClearDataCaches = jasaClearDataCaches;
    try { jasaClearDataCaches(); } catch (_) {}

    /* ── 3. OFFLINE GUARD ── */
    function handleOffline() {
        var p = window.location.pathname;
        if (p.indexOf('login') >= 0 || p.indexOf('offline') >= 0) return;
        /* Only redirect if we have a stored user (logged-in users need protection) */
        try {
            if (localStorage.getItem('jasa_user_cache')) {
                window.location.href = 'login.html?offline=1';
            }
        } catch (_) {}
    }
    window.addEventListener('offline', handleOffline);

    /* ── 4. SERVICE WORKER REGISTRATION ── */
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            // Inject manifest link if not already present
            if (!document.querySelector('link[rel="manifest"]')) {
                var mLink = document.createElement('link');
                mLink.rel  = 'manifest';
                mLink.href = 'manifest.json';
                document.head.appendChild(mLink);
            }

            // Register main SW
            navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
                try { reg.update().catch(function () {}); } catch (_) {}
                // no-cache SW: activates immediately (skipWaiting), no update banner needed
                console.log('[JASA-V2 SW] Registered:', reg.scope);
            }).catch(function (err) {
                console.warn('[JASA-V2 SW] Registration failed:', err);
            });

            // Firebase Messaging SW (background push) gets its own scope: registering it on "/"
            // as well replaced sw.js (one worker per scope). omx-push.js uses this same scope.
            navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope', updateViaCache: 'none' }).catch(function () {});

            /* Background sync helper exposed globally */
            window.jasaRequestSync = function (tag) {
                if ('serviceWorker' in navigator && 'SyncManager' in window) {
                    navigator.serviceWorker.ready.then(function (reg) {
                        reg.sync.register(tag).catch(function () {});
                    });
                }
            };

            /* Handle messages from SW */
            navigator.serviceWorker.addEventListener('message', function (evt) {
                if (!evt.data) return;
                if (evt.data.type === 'SYNC_RESULT' && evt.data.status === 'success') {
                    window.dispatchEvent(new CustomEvent('jasa-sync-result', { detail: evt.data }));
                }
            });

            /* Check and show pending sync banner (uses background-sync.js) */
            import('./background-sync.js')
                .then(function (mod) { mod.checkAndShowPendingBanner(); })
                .catch(function () {});
        });
    }

    /* ── 5. INSTANT USER IDENTITY PRE-RENDER ─────────────────────
       If the user is already cached in localStorage we can immediately
       hide the Login button and show the avatar ring — preventing the
       visible flash of the Login state for logged-in users.
       This duplicates the logic in auth-header.js but runs before
       any module is parsed, so it fires synchronously.
    ─────────────────────────────────────────────────────────────── */
    document.addEventListener('DOMContentLoaded', function () {
        try {
            var raw = localStorage.getItem('jasa_user_cache');
            if (!raw) return;
            var user = JSON.parse(raw);
            if (!user || !user.uid) return;

            /* Deterministic color from UID (same palette as auth-header.js) */
            var COLORS = [
                { color: '#2D8CF0', bg: '#e8f2fe' },
                { color: '#10b981', bg: '#d1fae5' },
                { color: '#f59e0b', bg: '#fef3c7' },
                { color: '#ef4444', bg: '#fee2e2' },
                { color: '#8b5cf6', bg: '#ede9fe' },
                { color: '#ec4899', bg: '#fce7f3' },
                { color: '#06b6d4', bg: '#cffafe' },
                { color: '#f97316', bg: '#ffedd5' },
            ];
            var sum = user.uid.split('').reduce(function (a, c) { return a + c.charCodeAt(0); }, 0);
            var palette = COLORS[sum % COLORS.length];

            /* Apply avatar colours and show avatar, hide login btn */
            var avatarWrap = document.getElementById('headerAvatarWrap');
            var loginBtn   = document.getElementById('headerLoginBtn');
            if (avatarWrap) {
                avatarWrap.style.setProperty('--av-color', palette.color);
                avatarWrap.style.setProperty('--av-bg',    palette.bg);
                avatarWrap.style.display = 'flex';
            }
            if (loginBtn) loginBtn.style.display = 'none';
        } catch (_) {}
    });

})();
