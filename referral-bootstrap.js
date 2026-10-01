/* ═══════════════════════════════════════════════
   JASA V2 — referral-bootstrap.js
   Called from auth-header.js on every page once a user is signed in.

   1. Applies a referral code the user arrived with (?ref=CODE on the login page,
      or typed into the register form) — saved in localStorage 'jasa_pending_ref'
      so it survives the redirect that follows sign-up.
   2. Makes sure the user has their own referral code. Existing accounts that
      pre-date the referral program get one the first time they open the app.

   Both steps run in the background and never block or break the page.
   ═══════════════════════════════════════════════ */
import { PAYMENT_SERVER_URL } from './env-config.js';

const base = () => (window.__JASA_SERVER || PAYMENT_SERVER_URL).replace(/\/$/, '');
const PENDING_KEY = 'jasa_pending_ref';
const RETRY_MS = 10 * 60 * 1000;

let running = false;

function toast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;' +
        'background:#111827;color:#fff;padding:10px 16px;border-radius:12px;font:700 13px/1.3 inherit;' +
        'font-family:inherit;max-width:calc(100vw - 32px);text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.3);';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
}

async function call(user, method, path, body) {
    const idToken = await user.getIdToken();
    const res = await fetch(`${base()}/api/referral/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return data;
}

const cacheGet = () => { try { return JSON.parse(localStorage.getItem('jasa_user_cache') || 'null'); } catch (_) { return null; } };
function cacheSetCode(uid, code) {
    try {
        const c = cacheGet();
        if (c && c.uid === uid) { c.referralCode = code; localStorage.setItem('jasa_user_cache', JSON.stringify(c)); }
    } catch (_) {}
}

export async function bootstrapReferral(user) {
    if (!user || running) return;
    running = true;
    try {
        /* 1 ── a code the user arrived with */
        let pending = null;
        try { pending = localStorage.getItem(PENDING_KEY); } catch (_) {}
        if (pending) {
            try {
                const r = await call(user, 'POST', 'apply', { code: pending });
                try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
                const bonus = r.reward?.refereeReward;
                toast(bonus > 0 ? `Referral code applied — ₹${bonus} added to your wallet!` : 'Referral code applied!');
            } catch (e) {
                /* profile not written yet → keep it and retry on the next page load; anything else is final */
                if (!/profile not found/i.test(e.message) && e.status !== 401 && e.status !== 500 && e.status !== undefined) {
                    try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
                    toast(e.message);
                }
            }
        }

        /* 2 ── the user's own code (also back-fills accounts created before referrals existed) */
        const cached = cacheGet();
        if (cached && cached.uid === user.uid && !cached.referralCode) {
            const key = `jasa_ref_try_${user.uid}`;
            const last = Number(localStorage.getItem(key) || 0);
            if (Date.now() - last > RETRY_MS) {
                localStorage.setItem(key, String(Date.now()));
                try { const r = await call(user, 'GET', 'me'); cacheSetCode(user.uid, r.code); }
                catch (e) { console.warn('[referral] code bootstrap:', e.message); }
            }
        }
    } finally {
        running = false;
    }
}
