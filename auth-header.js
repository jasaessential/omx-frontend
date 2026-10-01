/* ═══════════════════════════════════════════════
   auth-header.js
   Watches Firebase auth → swaps header between
   Login button (guest) and circular profile icon
   (logged-in) with a random accent color.

   CACHE STRATEGY:
   - Instant render from localStorage (no flash)
   - Firestore re-fetch only if cache is older than
     5 minutes OR uid changed OR roles are missing
   - Seller/employee shop sync only when stale
   ═══════════════════════════════════════════════ */

import { auth, db }           from './firebase-init.js';
import { onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { bootstrapReferral } from './referral-bootstrap.js';

/* ── Cache TTL: only re-fetch Firestore if older than 5 minutes ── */
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/* ── Color palette ── */
const COLORS = [
    { color: '#2D8CF0', bg: '#e8f2fe' },
    { color: '#10b981', bg: '#d1fae5' },
    { color: '#f59e0b', bg: '#fef3c7' },
    { color: '#ef4444', bg: '#fee2e2' },
    { color: '#8b5cf6', bg: '#ede9fe' },
    { color: '#ec4899', bg: '#fce7f3' },
    { color: '#06b6d4', bg: '#cffafe' },
    { color: '#f97316', bg: '#ffedd5' },
];

function pickColor(uid = '') {
    const sum = [...uid].reduce((a, c) => a + c.charCodeAt(0), 0);
    return COLORS[sum % COLORS.length];
}

const loginBtn   = document.getElementById('headerLoginBtn');
const avatarWrap = document.getElementById('headerAvatarWrap');

/* ── Instant pre-render from localStorage cache (no Firebase delay) ── */
(function applyFromCache() {
    try {
        const raw  = localStorage.getItem('jasa_user_cache');
        const user = raw ? JSON.parse(raw) : null;
        if (user && user.uid) {
            const { color, bg } = pickColor(user.uid);
            if (avatarWrap) {
                avatarWrap.style.setProperty('--av-color', color);
                avatarWrap.style.setProperty('--av-bg',    bg);
                avatarWrap.style.display = 'flex';
            }
            if (loginBtn) loginBtn.style.display = 'none';
        }
    } catch (_) {}
})();

/* ── Firebase confirms / overrides the cached state ── */
onAuthStateChanged(auth, async (user) => {
    if (user) {
        /* Apply avatar color immediately */
        const { color, bg } = pickColor(user.uid);
        if (avatarWrap) {
            avatarWrap.style.setProperty('--av-color', color);
            avatarWrap.style.setProperty('--av-bg',    bg);
            avatarWrap.style.display = 'flex';
        }
        if (loginBtn) loginBtn.style.display = 'none';

        /* Referral: apply a code the user arrived with + make sure they own a code.
           Delayed so the profile doc / cache have had time to be written. */
        setTimeout(() => bootstrapReferral(user).catch(() => {}), 2500);

        /* Read existing cache */
        let cached = null;
        try {
            const raw = localStorage.getItem('jasa_user_cache');
            cached = raw ? JSON.parse(raw) : null;
        } catch(_) {}

        /* ── TTL CHECK: skip Firestore if cache is fresh for this user ──
           Re-fetch if:
           1. No cache at all
           2. Cache belongs to a different uid
           3. Cache has no _cachedAt timestamp (old format)
           4. Cache is older than 5 minutes
           5. Cache is missing roles (could break sidebar access links)
        ── */
        const cacheAge    = cached?._cachedAt ? Date.now() - cached._cachedAt : Infinity;
        const wrongUser   = !cached || cached.uid !== user.uid;
        const missingRoles= !cached?.roles && !cached?.role;
        const stale       = cacheAge > USER_CACHE_TTL;

        if (!wrongUser && !missingRoles && !stale) {
            /* Cache is fresh — just render sidebar, skip Firestore entirely */
            if (typeof window.refreshSidebarAuth === 'function') window.refreshSidebarAuth();
            return;
        }

        /* ── Fetch from Firestore (cache miss or TTL expired) ── */
        try {
            if (db) {
                const snap = await getDoc(doc(db, 'users', user.uid));
                if (snap.exists()) {
                    const userData = snap.data();
                    const fullData = {
                        fullName: user.displayName || (user.email ? user.email.split('@')[0] : 'User'),
                        email: user.email || '',
                        userId: '',
                        ...userData,
                        uid: user.uid,
                        _cachedAt: Date.now()  // timestamp for TTL check
                    };

                    /* Sync userShops for sellers/employees */
                    const roles = userData.roles || [userData.role || 'user'];
                    if (roles.includes('seller') || roles.includes('employee')) {
                        try {
                            const { collection: col, query: qry, where, getDocs: gd }
                                = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
                            const shopsRef = col(db, 'shops');
                            let userShops = [];
                            if (roles.includes('seller')) {
                                const os = await gd(qry(shopsRef, where('owners', 'array-contains', user.uid)));
                                os.forEach(d => userShops.push({ shopId: d.id, role: 'owner', name: d.data().name }));
                            }
                            if (roles.includes('employee')) {
                                const es = await gd(qry(shopsRef, where('employees', 'array-contains', user.uid)));
                                es.forEach(d => {
                                    if (!userShops.find(s => s.shopId === d.id))
                                        userShops.push({ shopId: d.id, role: 'employee', name: d.data().name });
                                });
                            }
                            fullData.userShops = userShops;
                        } catch (se) { console.warn('[auth-header] userShops sync failed:', se); }
                    }

                    localStorage.setItem('jasa_user_cache', JSON.stringify(fullData));
                } else if (wrongUser) {
                    /* No Firestore doc — write minimal fallback */
                    const fallbackData = {
                        fullName: user.displayName || (user.email ? user.email.split('@')[0] : 'User'),
                        email: user.email || '',
                        uid: user.uid,
                        userId: '',
                        _cachedAt: Date.now()
                    };
                    localStorage.setItem('jasa_user_cache', JSON.stringify(fallbackData));
                }
                if (typeof window.refreshSidebarAuth === 'function') window.refreshSidebarAuth();
            }
        } catch (e) {
            console.warn('[auth-header] Firestore user fetch error:', e);
            /* On fetch failure, stamp the cache so we don't hammer Firestore */
            if (cached && cached.uid === user.uid) {
                cached._cachedAt = Date.now();
                localStorage.setItem('jasa_user_cache', JSON.stringify(cached));
            } else if (wrongUser) {
                localStorage.setItem('jasa_user_cache', JSON.stringify({
                    fullName: user.displayName || (user.email?.split('@')[0] || 'User'),
                    email: user.email || '', uid: user.uid, userId: '',
                    _cachedAt: Date.now()
                }));
            }
            if (typeof window.refreshSidebarAuth === 'function') window.refreshSidebarAuth();
        }
    } else {
        /* Guest — clear stale cache */
        localStorage.removeItem('jasa_user_cache');
        if (loginBtn)   loginBtn.style.display   = '';
        if (avatarWrap) avatarWrap.style.display  = 'none';
    }

    if (typeof window.refreshSidebarAuth === 'function') {
        window.refreshSidebarAuth();
    }
});
