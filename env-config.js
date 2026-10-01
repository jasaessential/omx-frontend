/* ═══════════════════════════════════════════════
   JASA V2 — env-config.js
   Config is loaded from the Node backend once,
   then stored on window.__JASA_CONFIG so all
   imports can read it synchronously after that.

   Secrets (ADMIN_SECRET_KEY, CLOUDINARY_API_SECRET,
   RAZORPAY keys) never appear in this file.
   ═══════════════════════════════════════════════ */

// ── Switch this to your deployed URL when going to production ──
// Production:  'https://server-bc02.onrender.com'
// Local dev:   'http://127.0.0.1:3001'
export const SERVER_URL = 'https://server-bc02.onrender.com';

/* Convenience alias used by cart.js / payment flow */
export const PAYMENT_SERVER_URL = SERVER_URL;

/* ── Internal loader ────────────────────────────
   loadConfig() fetches once and caches on window.
   All exported helpers call this first.

   Render free-tier servers spin down after inactivity
   and can take 15-25 s to cold-start. We use a 30 s
   timeout and retry once after a 3 s pause so the
   first page load always succeeds without user action.
   ─────────────────────────────────────────────── */
let _inflightFetch = null;

async function _fetchConfig(base, timeoutMs) {
    const r = await fetch(`${base}/api/config/public`, {
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
    return r.json();
}

async function loadConfig() {
    // Already loaded — return immediately
    if (window.__JASA_CONFIG) return window.__JASA_CONFIG;
    // Deduplicate concurrent calls
    if (_inflightFetch) return _inflightFetch;

    const base = window.__JASA_SERVER || SERVER_URL;

    _inflightFetch = (async () => {
        // ── Attempt 1: 30 s (covers Render cold-start) ──
        try {
            _notifyWake('connecting');
            const data = await _fetchConfig(base, 30000);
            window.__JASA_CONFIG = data;
            _notifyWake('ready');
            _inflightFetch = null;
            return data;
        } catch (err1) {
            // ── Attempt 2: wait 3 s then try once more ──
            _notifyWake('retrying');
            await new Promise(r => setTimeout(r, 3000));
            try {
                const data = await _fetchConfig(base, 30000);
                window.__JASA_CONFIG = data;
                _notifyWake('ready');
                _inflightFetch = null;
                return data;
            } catch (err2) {
                _notifyWake('failed');
                _inflightFetch = null;
                console.error('[env-config] Failed to load config from server:', err2.message);
                throw err2;
            }
        }
    })();

    return _inflightFetch;
}

/* ── Wake-up status broadcast ────────────────────
   Dispatches a CustomEvent so any page can show a
   "server waking up…" banner without coupling to
   this module directly.
   ─────────────────────────────────────────────── */
function _notifyWake(status) {
    try {
        window.dispatchEvent(new CustomEvent('jasa:server-wake', { detail: { status } }));
    } catch (_) {}
}

/* ── Sync read helpers ───────────────────────────
   Use these ONLY after the page has called
   initAppConfig() (done in head-cache.js / config.js).
   They read from the window cache — no await needed.
   ─────────────────────────────────────────────── */
function _get(path) {
    const cfg = window.__JASA_CONFIG;
    if (!cfg) {
        console.warn('[env-config] Config not yet loaded. Call initAppConfig() first.');
        return undefined;
    }
    return path.split('.').reduce((o, k) => o?.[k], cfg);
}

export const FIREBASE_CONFIG   = new Proxy({}, {
    get: (_, key) => _get(`firebase.${key}`)
});
export const CLOUDINARY_CONFIG = new Proxy({}, {
    get: (_, key) => _get(`cloudinary.${key}`)
});
export const SUPABASE_CONFIG   = new Proxy({}, {
    get: (_, key) => _get(`supabase.${key}`)
});
export const R2_CONFIG         = new Proxy({}, {
    get: (_, key) => _get(`r2.${key}`)
});

/* WORKER_URL is used directly in template literals — make it a getter */
Object.defineProperty(window, 'WORKER_URL_SYNC', {
    get: () => _get('workerUrl') || '',
    configurable: true,
});

/* ── WORKER_URL — hardcoded, always available instantly ── */
export const WORKER_URL = 'https://jasa-backend-worker.jasaessential3.workers.dev';

/* ── Legacy exports kept for compatibility ── */
export function getWorkerUrlSync() { return WORKER_URL; }

/* ── initAppConfig ───────────────────────────────
   Call this ONCE, as early as possible (head-cache.js).
   Resolves when config is ready; all sync reads work after this.
   ─────────────────────────────────────────────── */
export async function initAppConfig() {
    const cfg = await loadConfig();
    return cfg;
}

/* ── Named async getters (preferred for new code) ── */
export async function getFirebaseConfig()   { return (await loadConfig()).firebase;   }
export async function getCloudinaryConfig() { return (await loadConfig()).cloudinary; }
export async function getSupabaseConfig()   { return (await loadConfig()).supabase;   }
export async function getR2Config()         { return (await loadConfig()).r2;         }
export async function getWorkerUrl()        { return WORKER_URL; } // just return the constant

/* ── Admin token helper ──────────────────────────
   Admin calls to the Worker and the upload server carry the admin's own
   Firebase ID token; both verify it and check the user's role. (There is no
   shared admin key any more — it used to be handed to admin browsers.)
   Kept as a function so existing callers don't change.
   ─────────────────────────────────────────────── */
export async function getAdminToken(idToken) {
    if (!idToken) throw new Error('Please sign in again.');
    return idToken;
}
