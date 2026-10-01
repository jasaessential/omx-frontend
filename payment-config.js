/* ═══════════════════════════════════════════════
   JASA V2 — payment-config.js
   Admin-only page to manage global payment settings.

   Flow:
   1. Auth guard — must be admin role (checked via
      Firestore users/{uid}.roles, same as all other
      admin pages).
   2. Load current config — tries KV worker first
      (GET /api/config/payment), falls back to
      Firestore directly on miss.
   3. Admin edits and saves:
      a. Write to Firestore /config/payment  (source of truth)
      b. POST /api/config/payment to worker  (busts + rewrites KV)
   4. User-side cache (localStorage "jasa_payment_config")
      is keyed on `version`. Every save increments version,
      so stale user caches self-invalidate on next checkout load.

   KV key:  v2.2_config_payment   (no TTL — manual control)
   LS key:  jasa_payment_config   (12-hr TTL + version check)
   ═══════════════════════════════════════════════ */

import { auth, db }           from './firebase-init.js';
import { WORKER_URL, getAdminToken, initAppConfig }
                               from './env-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    doc, getDoc, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

/* ════ CONSTANTS ════ */
const DEFAULT_CONFIG = {
    mode:                 'both',
    onlineDepositPercent: 30,
    applyToCart:          true,
    applyToXerox:         true,
    version:              1,
};

/* ════ STATE ════ */
let currentUser   = null;
let adminIdToken  = null;
let loadedConfig  = null;   // config as fetched from KV / Firestore
let isSaving      = false;

/* ════ ELEMENT REFS ════ */
const $ = id => document.getElementById(id);

/* ════ TOAST ════ */
let _toastTimer = null;
function toast(msg, type = 'info') {
    const el = $('pcToast');
    if (!el) return;
    clearTimeout(_toastTimer);
    el.textContent  = msg;
    el.className    = `pc-toast ${type} show`;
    _toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ════ AUTH GUARD ════ */
onAuthStateChanged(auth, async user => {
    if (!user) {
        window.location.replace('index.html');
        return;
    }
    currentUser = user;

    // ── Fast pre-check from localStorage (avoids Firestore round-trip on re-visit) ──
    try {
        const cached = localStorage.getItem('jasa_user_cache');
        if (cached) {
            const cd = JSON.parse(cached);
            const cr = cd.roles || (cd.role ? [cd.role] : []);
            if (cr.length > 0 && !cr.includes('admin')) {
                showAuthError();
                return;
            }
        }
    } catch (_) {}

    // ── Live Firestore role check ──
    try {
        const snap  = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { showAuthError(); return; }

        const data  = snap.data();
        const roles = data.roles || (data.role ? [data.role] : []);
        if (!roles.includes('admin')) { showAuthError(); return; }

        // Fetch admin token (cached in env-config for 1 hr)
        adminIdToken = await user.getIdToken();

        // Show page immediately — don't wait for initAppConfig which hits an external server
        showPage();

        // Load app config in background (non-blocking; only needed for KV worker calls)
        initAppConfig().catch(err =>
            console.warn('[payment-config] initAppConfig failed (non-fatal):', err.message)
        );

        await window.loadCurrentConfig();

    } catch (err) {
        console.error('[payment-config] auth error:', err.message);
        showAuthError();
    }
});

function showPage() {
    $('pcLoading').style.display    = 'none';
    $('pcAuthError').style.display  = 'none';
    $('pcCard').style.display       = 'block';
}

function showAuthError() {
    $('pcLoading').style.display    = 'none';
    $('pcAuthError').style.display  = 'flex';
    $('pcCard').style.display       = 'none';
}

/* ════ LOAD CONFIG ════ */
// Tries KV worker → falls back to Firestore directly.
// KV is fast (edge), Firestore is the fallback.
window.loadCurrentConfig = async function loadCurrentConfig() {
    const saveBtn = $('pcSaveBtn');
    if (saveBtn) saveBtn.disabled = true;

    try {
        let config = null;

        // ── 1. Try KV worker ──────────────────────────
        try {
            const resp = await fetch(`${WORKER_URL}/api/config/payment`, {
                signal: AbortSignal.timeout(5000)
            });
            if (resp.ok) {
                const json = await resp.json();
                if (json && json.mode) {
                    config = json;
                    updateKvStatusBadge('KV cache — live', false);
                }
            }
        } catch (kvErr) {
            console.warn('[payment-config] KV fetch failed, falling back to Firestore:', kvErr.message);
        }

        // ── 2. Fallback: Firestore directly ───────────
        if (!config) {
            const snap = await getDoc(doc(db, 'config', 'payment'));
            config     = snap.exists() ? snap.data() : { ...DEFAULT_CONFIG };
            updateKvStatusBadge('KV miss — loaded from Firestore', true);
        }

        loadedConfig = { ...DEFAULT_CONFIG, ...config };
        applyConfigToUI(loadedConfig);

    } catch (err) {
        console.error('[payment-config] loadCurrentConfig error:', err);
        toast('Failed to load config. Check console.', 'error');
        // Still apply defaults so UI is not broken
        loadedConfig = { ...DEFAULT_CONFIG };
        applyConfigToUI(loadedConfig);
    } finally {
        const saveBtn = $('pcSaveBtn');
        if (saveBtn) saveBtn.disabled = false;
    }
}

/* ════ APPLY CONFIG → UI ════ */
function applyConfigToUI(cfg) {
    // Mode radio + card highlight
    const radio = document.querySelector(`input[name="paymentMode"][value="${cfg.mode}"]`);
    if (radio) {
        radio.checked = true;
        updateModeCards(cfg.mode);
    }

    // Deposit percent — always set (only visible when partial_online is active)
    const depInput = $('pcDepositInput');
    if (depInput) {
        depInput.value = cfg.onlineDepositPercent ?? 30;
    }
    updateDepositPreview();

    // Scope toggles
    $('scopeCart').checked  = cfg.applyToCart  !== false;
    $('scopeXerox').checked = cfg.applyToXerox !== false;

    // Live badge
    updateLiveBadge(cfg.mode);

    // Meta row
    if (cfg.updatedAt) {
        const date = cfg.updatedAt?.toDate
            ? cfg.updatedAt.toDate()
            : new Date(cfg.updatedAt);
        $('pcMetaText').textContent =
            `Last saved ${date.toLocaleString()} by ${cfg.updatedBy || 'admin'}  ·  v${cfg.version ?? 1}`;
        $('pcMetaRow').style.display = 'flex';
    }
}

/* ════ SAVE CONFIG ════ */
window.saveConfig = async function() {
    if (isSaving) return;
    isSaving = true;

    const btn = $('pcSaveBtn');
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    try {
        const mode    = document.querySelector('input[name="paymentMode"]:checked')?.value;
        if (!mode) {
            toast('Please select a payment mode.', 'error');
            isSaving     = false;
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
            return;
        }

        // Parse once — used for both validation and the payload
        const depositValue = parseInt($('pcDepositInput').value, 10) || 30;
        if (mode === 'partial_online') {
            if (depositValue < 1 || depositValue > 99) {
                toast('Deposit % must be between 1 and 99.', 'error');
                isSaving     = false;
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
                return;
            }
        }

        const newVersion = (loadedConfig?.version ?? 0) + 1;

        // Always store the deposit value regardless of mode —
        // switching back to partial_online restores the last-set %.

        const payload = {
            mode,
            onlineDepositPercent: depositValue,
            applyToCart:          $('scopeCart').checked,
            applyToXerox:         $('scopeXerox').checked,
            version:              newVersion,
            updatedBy:            currentUser.uid,
        };

        // ── 1. Write to Firestore (source of truth) ──
        await setDoc(doc(db, 'config', 'payment'), {
            ...payload,
            updatedAt: serverTimestamp(),
        });

        // ── 2. Bust + rewrite KV cache via worker ────
        await pushToKv(payload);

        // ── 3. Update local state ────────────────────
        loadedConfig = { ...payload, updatedAt: new Date() };
        updateLiveBadge(mode);
        $('pcMetaText').textContent =
            `Last saved ${new Date().toLocaleString()} by you  ·  v${newVersion}`;
        $('pcMetaRow').style.display = 'flex';
        updateKvStatusBadge('KV updated ✓', false);

        toast('Payment config saved and KV cache updated!', 'success');

    } catch (err) {
        console.error('[payment-config] save error:', err);
        toast(`Save failed: ${err.message}`, 'error');
    } finally {
        isSaving     = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
    }
};

/* ── Push config to KV via worker (POST /api/config/payment) ── */
async function pushToKv(payload) {
    // Get fresh admin token
    const freshToken = await getAdminToken(adminIdToken);

    const resp = await fetch(`${WORKER_URL}/api/config/payment`, {
        method:  'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${freshToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Worker KV write failed (${resp.status}): ${text}`);
    }
    return resp.json();
}

/* ════ BUST KV CACHE ════ */
// Called by the "bust" button — deletes the KV key so next
// user fetch re-reads from Firestore via the worker.
window.bustKvCache = async function() {
    const btn = $('pcBustBtn');
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const freshToken = await getAdminToken(adminIdToken);
        const resp = await fetch(`${WORKER_URL}/api/cache/clear?type=payment`, {
            method:  'DELETE',
            headers: { 'Authorization': `Bearer ${freshToken}` },
            signal:  AbortSignal.timeout(6000),
        });

        if (!resp.ok) throw new Error(`${resp.status}`);
        updateKvStatusBadge('KV cache cleared', true);
        toast('KV cache busted — next user load will refetch from Firestore.', 'success');
    } catch (err) {
        toast(`Cache bust failed: ${err.message}`, 'error');
    } finally {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
    }
};

/* ════ UI HELPERS ════ */

// Highlight the active mode card
function updateModeCards(mode) {
    document.querySelectorAll('.pc-mode-card').forEach(card => {
        card.classList.toggle('pc-mode-card--active', card.dataset.mode === mode);
    });
}

// Show/hide deposit section — no longer needed (inline inside card)
// kept as no-op so any old references don't throw
function toggleDepositSection(_mode) {}

// Update the live badge text + colour
function updateLiveBadge(mode) {
    const labels = {
        cod_only:       'COD Only',
        online_only:    'Online Only',
        both:           'COD + Online',
        partial_online: 'Partial Deposit',
    };
    const colors = {
        cod_only:       '#10b981',
        online_only:    '#2D8CF0',
        both:           '#f59e0b',
        partial_online: '#8b5cf6',
    };
    const label = $('pcLiveLabel');
    const badge = $('pcLiveBadge');
    if (label) label.textContent = labels[mode] ?? mode;
    if (badge) {
        const dot = badge.querySelector('.pc-live-dot');
        if (dot) dot.style.background = colors[mode] ?? '#2D8CF0';
    }
}

// Update KV status text in the info box
function updateKvStatusBadge(text, stale) {
    const el = $('pcKvStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = stale ? 'var(--warning, #f59e0b)' : 'var(--success, #10b981)';
}

// Live preview for deposit %
function updateDepositPreview() {
    const pct    = parseInt($('pcDepositInput')?.value, 10) || 30;
    const sample = 500;
    const now    = Math.round(sample * pct / 100);
    const later  = sample - now;
    const nowEl  = $('pcDepNow');
    const latEl  = $('pcDepLater');
    if (nowEl)  nowEl.textContent  = `₹${now}`;
    if (latEl)  latEl.textContent  = `₹${later}`;
}

/* ════ WIRE UP EVENTS ════ */
document.addEventListener('DOMContentLoaded', () => {

    // Mode card clicks — clicking the card label also checks the radio
    document.querySelectorAll('.pc-mode-card').forEach(card => {
        card.addEventListener('click', () => {
            const mode = card.dataset.mode;
            const radio = document.querySelector(`input[name="paymentMode"][value="${mode}"]`);
            if (radio) radio.checked = true;
            updateModeCards(mode);
            updateLiveBadge(mode);
        });
    });

    // Deposit input → live preview
    const depInput = $('pcDepositInput');
    if (depInput) {
        depInput.addEventListener('input', updateDepositPreview);
    }
});

/* ═══════════════════════════════════════════════
   USER-SIDE CACHE HELPER (exported for use in
   cart.js and xerox-order.js)

   Usage:
     import { getPaymentConfig } from './payment-config.js';
     const cfg = await getPaymentConfig();
     // cfg.mode, cfg.onlineDepositPercent, cfg.version, etc.

   Cache rules:
   - localStorage key: "jasa_payment_config"
   - 12-hour TTL  OR  version mismatch → re-fetch from KV
   - KV miss → worker reads Firestore automatically
   ═══════════════════════════════════════════════ */
const LS_KEY        = 'jasa_payment_config';
const CACHE_TTL_MS  = 12 * 60 * 60 * 1000;   // 12 hours

export async function getPaymentConfig() {

    // ── 1. Read localStorage ──────────────────────
    let local = null;
    try {
        const raw = localStorage.getItem(LS_KEY);
        local = raw ? JSON.parse(raw) : null;
    } catch (_) {}

    const age = local?._cachedAt ? Date.now() - local._cachedAt : Infinity;

    // ── 2. If cache is within 12 hrs, do a cheap version check ──
    if (local && age < CACHE_TTL_MS) {
        try {
            const vResp = await fetch(
                `${WORKER_URL}/api/config/payment/version`,
                { signal: AbortSignal.timeout(3000) }
            );
            if (vResp.ok) {
                const { version } = await vResp.json();
                if (version === local.version) {
                    return local;   // ✅ fresh — use localStorage
                }
                // version mismatch — fall through to full fetch
            }
        } catch (_) {
            // version check failed (offline?) — use local cache as-is
            if (local) return local;
        }
    }

    // ── 3. Full fetch from KV ─────────────────────
    try {
        const resp = await fetch(
            `${WORKER_URL}/api/config/payment`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const fresh = await resp.json();

        // Write to localStorage with timestamp
        const toCache = { ...fresh, _cachedAt: Date.now() };
        try { localStorage.setItem(LS_KEY, JSON.stringify(toCache)); } catch (_) {}

        return fresh;
    } catch (fetchErr) {
        console.warn('[getPaymentConfig] KV fetch failed:', fetchErr.message);
        // Return stale local cache rather than crashing checkout
        if (local) return local;
        // Last resort default — never blocks checkout
        return { ...DEFAULT_CONFIG };
    }
}

/* Clear local payment config cache (call on logout) */
export function clearPaymentConfigCache() {
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
}
