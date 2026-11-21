/* ═══════════════════════════════════════════════════════════════════
   OMX — order notifications on this device (website, installed PWA and
   the Play Store app, which is the same site in a Trusted Web Activity).

   - After sign-in, if notifications are not decided yet, a small card
     offers "Turn on". Staff see "a ping for every new order", customers
     "live updates on your orders".
   - With permission, the FCM token is saved to users/{uid}.fcmTokens.
     The omx-api Worker (cf/notify.js) sends the pushes.
   - Pushes arriving while the app is open show as a notification too,
     with a short chime for new orders.
   Loaded by auth-header.js (every signed-in page) and order-details.js.
   ═══════════════════════════════════════════════════════════════════ */

import { app, auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getMessaging, getToken, onMessage, isSupported }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js';
import { doc, getDoc, setDoc, arrayUnion } from './cf-firestore.js';

const SW_SCOPE = '/firebase-cloud-messaging-push-scope';
const DISMISS_KEY = 'omxPushAskLater';
const STAFF_ROLES = ['admin', 'seller', 'employee'];
let _messaging = null;
let _reg = null;
let _listening = false;

async function supported() {
    try {
        return 'Notification' in window && 'serviceWorker' in navigator && await isSupported();
    } catch (_) { return false; }
}

async function swRegistration() {
    if (_reg) return _reg;
    _reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: SW_SCOPE, updateViaCache: 'none' });
    return _reg;
}

async function saveToken(user) {
    const reg = await swRegistration();
    _messaging = _messaging || getMessaging(app);
    const token = await getToken(_messaging, { serviceWorkerRegistration: reg });
    if (!token) return null;
    const key = 'omxPushToken:' + user.uid;
    if (localStorage.getItem(key) !== token) {
        await setDoc(doc(db, 'users', user.uid), { fcmTokens: arrayUnion(token), notificationsEnabled: true }, { merge: true });
        localStorage.setItem(key, token);
    }
    listenForeground();
    return token;
}

/**
 * Turn on order notifications for the signed-in user.
 * ask=false: only refreshes the token when permission was already given.
 * Returns 'granted' | 'default' | 'denied' | 'unsupported' | 'signed-out' | 'error'.
 */
export async function enableOrderPush({ ask = false } = {}) {
    if (!(await supported())) return 'unsupported';
    const user = auth.currentUser;
    if (!user) return 'signed-out';
    let perm = Notification.permission;
    if (perm === 'default' && ask) perm = await Notification.requestPermission();
    if (perm !== 'granted') return perm;
    try { await saveToken(user); return 'granted'; }
    catch (e) { console.warn('[push] could not turn on notifications:', e.code || e.message); return 'error'; }
}

/* ── pushes while the app is open ─────────────────────────────────── */

function chime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [880, 1175].forEach((f, i) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.frequency.value = f; o.type = 'sine';
            g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
            g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.18 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.35);
            o.connect(g).connect(ctx.destination);
            o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.4);
        });
    } catch (_) { /* no audio */ }
}

function listenForeground() {
    if (_listening || !_messaging) return;
    _listening = true;
    onMessage(_messaging, async payload => {
        const d = payload.data || {};
        const n = payload.notification || {};
        const title = d.title || n.title || 'Order My Xerox';
        const body = d.body || n.body || '';
        if (d.kind === 'new_order') chime();
        try {
            const reg = await swRegistration();
            await reg.showNotification(title, {
                body, tag: d.tag || 'omx', renotify: true,
                icon: '/assets/icons/android/launchericon-192x192.png',
                badge: '/assets/icons/android/launchericon-96x96.png',
                data: { url: d.url || '/orders.html' },
                requireInteraction: d.kind === 'new_order',
            });
        } catch (_) { /* permission revoked meanwhile */ }
        window.dispatchEvent(new CustomEvent('omx-push', { detail: { title, body, ...d } }));
    });
}

/* ── the "turn on" card ───────────────────────────────────────────── */

function askedRecently() {
    const t = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return Date.now() - t < 3 * 24 * 3600 * 1000;
}

function showCard(isStaff) {
    if (document.getElementById('omxPushCard')) return;
    const card = document.createElement('div');
    card.id = 'omxPushCard';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Turn on notifications');
    card.innerHTML = `
        <div class="omxp-icon" aria-hidden="true">🔔</div>
        <div class="omxp-text">
            <strong>${isStaff ? 'Get a ping for every new order' : 'Track your orders live'}</strong>
            <span>${isStaff ? 'New orders reach you even when the app is closed.' : 'We’ll tell you when your order is confirmed, ready and delivered.'}</span>
        </div>
        <div class="omxp-actions">
            <button type="button" class="omxp-later">Later</button>
            <button type="button" class="omxp-on">Turn on</button>
        </div>`;
    const style = document.createElement('style');
    style.textContent = `
        #omxPushCard{position:fixed;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom));z-index:9999;
          max-width:460px;margin:0 auto;display:flex;gap:12px;align-items:center;flex-wrap:wrap;
          background:#fff;border:1px solid #e3e8f0;border-radius:14px;padding:14px 16px;
          box-shadow:0 10px 30px rgba(20,40,80,.16);font-family:inherit;animation:omxpIn .25s ease-out}
        #omxPushCard .omxp-icon{font-size:26px;line-height:1}
        #omxPushCard .omxp-text{flex:1;min-width:180px;display:flex;flex-direction:column;gap:2px}
        #omxPushCard .omxp-text strong{font-size:15px;color:#1b2533}
        #omxPushCard .omxp-text span{font-size:13px;color:#5b6676}
        #omxPushCard .omxp-actions{display:flex;gap:8px;margin-left:auto}
        #omxPushCard button{border:0;border-radius:10px;padding:9px 14px;font-size:14px;font-weight:600;cursor:pointer}
        #omxPushCard .omxp-later{background:#f2f4f8;color:#435064}
        #omxPushCard .omxp-on{background:#2D8CF0;color:#fff}
        @keyframes omxpIn{from{transform:translateY(16px);opacity:0}to{transform:none;opacity:1}}`;
    document.head.appendChild(style);
    document.body.appendChild(card);
    const close = () => card.remove();
    card.querySelector('.omxp-later').onclick = () => { localStorage.setItem(DISMISS_KEY, String(Date.now())); close(); };
    card.querySelector('.omxp-on').onclick = async () => {
        close();
        const r = await enableOrderPush({ ask: true });
        if (r !== 'granted') localStorage.setItem(DISMISS_KEY, String(Date.now()));
    };
}

async function boot(user) {
    if (!user || !(await supported())) return;
    if (Notification.permission === 'granted') { enableOrderPush(); return; }
    if (Notification.permission !== 'default' || askedRecently()) return;
    let isStaff = false;
    try {
        const s = await getDoc(doc(db, 'users', user.uid));
        const d = s.exists() ? s.data() : {};
        const roles = d.roles || [d.role || 'user'];
        isStaff = roles.some(r => STAFF_ROLES.includes(r));
    } catch (_) { /* show the customer text */ }
    setTimeout(() => showCard(isStaff), 2500);
}

if (!window.__omxPushBooted) {
    window.__omxPushBooted = true;
    onAuthStateChanged(auth, user => { boot(user).catch(() => {}); });
}
window.omxEnableOrderPush = enableOrderPush;
