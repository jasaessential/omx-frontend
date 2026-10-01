/* ═══════════════════════════════════════════════
   JASA V2 — wallet-client.js
   Shared by cart.js, xerox-order.js, wallet.js, orders.js …

   Settings live in Firestore config/wallet (public read). The balance lives in
   wallets/{uid} (owner read). All money movement goes through /api/wallet/*
   — the server re-checks every limit, this file only mirrors the maths so the
   checkout can show live totals.
   ═══════════════════════════════════════════════ */
import { db } from './firebase-init.js';
import { PAYMENT_SERVER_URL } from './env-config.js';
import { doc, getDoc }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

const base = () => (window.__JASA_SERVER || PAYMENT_SERVER_URL).replace(/\/$/, '');
const num  = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
export const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
export const inr    = n => `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/* ── Config ─────────────────────────────────── */
export function normaliseWalletConfig(raw = {}) {
    return {
        enabled:             raw.enabled === true,
        cashbackPercent:     Math.min(100, Math.max(0, num(raw.cashbackPercent))),
        minOrderForCashback: Math.max(0, num(raw.minOrderForCashback)),
        maxCashbackPerOrder: Math.max(0, num(raw.maxCashbackPerOrder)),
        minOrderToUse:       Math.max(0, num(raw.minOrderToUse)),
        minBalanceToUse:     Math.max(0, num(raw.minBalanceToUse)),
        maxUsePercent:       Math.min(100, Math.max(0, num(raw.maxUsePercent, 50))),
        maxUsePerOrder:      Math.max(0, num(raw.maxUsePerOrder)),
        applyToProducts:     raw.applyToProducts !== false,
        applyToXerox:        raw.applyToXerox !== false,
    };
}

let _cfg = null, _cfgAt = 0;
export async function loadWalletConfig(force = false) {
    if (!force && _cfg && Date.now() - _cfgAt < 120000) return _cfg;
    try {
        const snap = await getDoc(doc(db, 'config', 'wallet'));
        _cfg = normaliseWalletConfig(snap.exists() ? snap.data() : {});
    } catch (e) {
        console.warn('[wallet] config load failed:', e.message);
        _cfg = _cfg || normaliseWalletConfig({});
    }
    _cfgAt = Date.now();
    return _cfg;
}

export async function loadWalletBalance(user) {
    if (!user) return 0;
    try {
        const snap = await getDoc(doc(db, 'wallets', user.uid));
        return snap.exists() ? round2(snap.data().balance) : 0;
    } catch (e) {
        console.warn('[wallet] balance load failed:', e.message);
        return 0;
    }
}

/* ── Maths (mirror of walletCore.computeUsable) ── */
export function computeWalletUse(cfg, balance, payable, orderType = 'product') {
    if (!cfg?.enabled) return 0;
    if (orderType === 'xerox' ? !cfg.applyToXerox : !cfg.applyToProducts) return 0;
    payable = round2(payable); balance = round2(balance);
    if (payable <= 1 || balance <= 0) return 0;
    if (payable < cfg.minOrderToUse) return 0;
    if (balance < cfg.minBalanceToUse) return 0;
    let cap = payable * cfg.maxUsePercent / 100;
    if (cfg.maxUsePerOrder > 0) cap = Math.min(cap, cfg.maxUsePerOrder);
    cap = Math.min(cap, payable - 1);
    return Math.max(0, Math.floor(Math.min(balance, cap) * 100) / 100);
}

/** Human reason the wallet can't be used right now ('' when it can). */
export function walletBlockReason(cfg, balance, payable, orderType = 'product') {
    if (!cfg?.enabled) return 'Wallet is not available right now.';
    if (orderType === 'xerox' ? !cfg.applyToXerox : !cfg.applyToProducts) {
        return `Wallet can't be used on ${orderType === 'xerox' ? 'xerox' : 'product'} orders.`;
    }
    if (balance <= 0) return 'Your wallet is empty.';
    if (balance < cfg.minBalanceToUse) return `You need at least ${inr(cfg.minBalanceToUse)} in your wallet to use it.`;
    if (payable < cfg.minOrderToUse) return `Wallet can be used on orders of ${inr(cfg.minOrderToUse)} or more.`;
    if (computeWalletUse(cfg, balance, payable, orderType) <= 0) return 'Wallet cannot be used on this order.';
    return '';
}

/* ── Server calls ───────────────────────────── */
async function call(user, path, body) {
    if (!user) throw new Error('Please sign in to use your wallet.');
    const idToken = await user.getIdToken();
    let res;
    try {
        res = await fetch(`${base()}/api/wallet/${path}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body:    JSON.stringify(body || {}),
            signal:  AbortSignal.timeout(30000),
        });
    } catch (_) {
        throw new Error('Could not reach the server. Please try again in a few seconds.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Wallet error (${res.status})`);
    return data;
}

/** Reserve wallet money for a checkout. Returns { amount } — the server's final figure. */
export const redeemWallet = (user, { groupOrderId, orderTotal, orderType, paymentMode }) =>
    call(user, 'redeem', { groupOrderId, orderTotal, orderType, paymentMode });

/** Give a reservation back after a failed/cancelled payment. Never throws. */
export async function releaseWallet(user, groupOrderId) {
    try { await call(user, 'release', { groupOrderId }); }
    catch (e) { console.warn('[wallet] release failed:', e.message); }
}

/** Ask the server to credit cashback / refunds / referral rewards that are due. Throttled; never throws. */
export async function syncWallet(user, { force = false } = {}) {
    if (!user) return null;
    const key = `jasa_wallet_sync_${user.uid}`;
    try {
        const last = Number(sessionStorage.getItem(key) || 0);
        if (!force && Date.now() - last < 60000) return null;
        sessionStorage.setItem(key, String(Date.now()));
    } catch (_) {}
    try { return await call(user, 'sync', {}); }
    catch (e) { console.warn('[wallet] sync failed:', e.message); return null; }
}

/* ── Labels used by the wallet page ─────────── */
export const SOURCE_LABEL = {
    cashback:          { label: 'Cashback',        icon: 'fa-solid fa-coins',         tone: 'in'  },
    referral_referrer: { label: 'Referral bonus',  icon: 'fa-solid fa-user-plus',     tone: 'in'  },
    referral_referee:  { label: 'Welcome bonus',   icon: 'fa-solid fa-gift',          tone: 'in'  },
    admin_adjust:      { label: 'Adjustment',      icon: 'fa-solid fa-sliders',       tone: 'adj' },
    order_payment:     { label: 'Used on order',   icon: 'fa-solid fa-bag-shopping',  tone: 'out' },
    order_refund:      { label: 'Order refund',    icon: 'fa-solid fa-rotate-left',   tone: 'in'  },
    usage_release:     { label: 'Returned',        icon: 'fa-solid fa-rotate-left',   tone: 'in'  },
};
