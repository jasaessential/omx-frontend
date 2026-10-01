(function () {
    /* ═══════════════════════════════════════════════
       JASA V2 — head-cache.js
       Runs immediately in <head> before any module loads.
       Purpose:
         1. Apply stored theme instantly (no flash)
         2. Inject cached user identity into sidebar (no auth flash)
         3. Clear stale local caches on version bump
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

    /* ── 2. CACHE VERSION — bump to bust all local data caches ── */
    var CACHE_VERSION = '2';
    try {
        var storedVer = localStorage.getItem('jasa_cache_version');
        if (storedVer !== CACHE_VERSION) {
            /* Wipe all JASA sessionStorage category caches */
            var toRemove = [];
            for (var i = 0; i < sessionStorage.length; i++) {
                var k = sessionStorage.key(i);
                if (k && (k.indexOf('jasa_v2_') === 0)) toRemove.push(k);
            }
            toRemove.forEach(function (k) { sessionStorage.removeItem(k); });

            /* Wipe stale localStorage shop + product caches */
            var lsRemove = [];
            for (var j = 0; j < localStorage.length; j++) {
                var lk = localStorage.key(j);
                if (lk && (
                    lk.indexOf('ao_shops_v') === 0 ||
                    lk.indexOf('global_shops_data') >= 0
                )) {
                    lsRemove.push(lk);
                }
            }
            lsRemove.forEach(function (k) { localStorage.removeItem(k); });

            localStorage.setItem('jasa_cache_version', CACHE_VERSION);
        }
    } catch (_) {}

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
            navigator.serviceWorker.register('sw.js').then(function (reg) {
                // update detection now handled by initSWUpdateBanner() in app.js
                console.log('[JASA-V2 SW] Registered:', reg.scope);
            }).catch(function (err) {
                console.warn('[JASA-V2 SW] Registration failed:', err);
            });

            // Register Firebase Messaging SW (for background push)
            navigator.serviceWorker.register('firebase-messaging-sw.js').catch(function () {});

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
