/* ═══════════════════════════════════════════════
   JASA V2 — cart.js
   Cart: localStorage "jasa_cart"
   Shops: Firestore "shops" collection
   Orders: writes to "orders" + "order_status"
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import { WORKER_URL, PAYMENT_SERVER_URL } from './env-config.js';
import {
    collection, getDocs, doc, getDoc,
    setDoc, updateDoc, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { validateCoupon, redeemCoupon, releaseCoupon, calcDiscount, splitDiscount }
    from './coupon-client.js';
import { quoteOrder, priceChanged, cancelUnpaidOrders } from './order-quote-client.js';
import { loadWalletConfig, loadWalletBalance, computeWalletUse, walletBlockReason,
         redeemWallet, releaseWallet, syncWallet, inr }
    from './wallet-client.js';

/* ════ STATE ════ */
const CART_KEY = 'jasa_cart';
let allShops      = [];
let selectedShops = { stationary:'', books:'', electronic:'', posters:'' };
let checkedIds    = new Set();
let isFirstRender = true;
let userProfile   = { fullName:'', mobileNumber:'', altMobiles:[], addresses:[] };
let selAddrIdx    = 0;
let currentUser   = null;
let selectedFulfillment = 'delivery'; // 'delivery' | 'pickup'

/* ════ COUPON ════
   appliedCoupon = { code, name, type, value, maxDiscount, minOrderAmount }
   The server re-validates on redeem; this only drives live totals.        */
let appliedCoupon = null;

const selectedShopIds = () => Object.values(selectedShops).filter(Boolean);
const couponDiscountFor = sub => calcDiscount(appliedCoupon, sub);

function renderCouponBox(sub = 0) {
    const entry   = document.getElementById('couponEntry');
    const applied = document.getElementById('couponApplied');
    if (!entry || !applied) return;
    entry.style.display   = appliedCoupon ? 'none' : 'flex';
    applied.style.display = appliedCoupon ? 'flex' : 'none';
    if (!appliedCoupon) return;

    const disc = couponDiscountFor(sub);
    setText('couponAppliedCode', appliedCoupon.code);
    setText('couponAppliedMsg', disc > 0
        ? `You save ₹${disc.toLocaleString('en-IN')}`
        : `Add ₹${Math.max(0, appliedCoupon.minOrderAmount - sub).toLocaleString('en-IN')} more to use this coupon`);
}

function setCouponError(msg) { setText('couponErr', msg || ''); }

window.applyCoupon = async function() {
    const input = document.getElementById('couponInput');
    const btn   = document.getElementById('couponApplyBtn');
    const code  = (input?.value || '').trim().toUpperCase();
    if (!code) { setCouponError('Enter a coupon code.'); return; }
    if (!currentUser) { setCouponError('Please sign in to use a coupon.'); return; }

    const items = getCart().filter(i => checkedIds.has(i.id));
    const sub   = items.reduce((s, i) => s + i.price * i.qty, 0);
    if (!sub) { setCouponError('Select items in your cart first.'); return; }

    setCouponError('');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
        const res = await validateCoupon(currentUser, {
            code, subtotal: sub, orderType: 'product', shopIds: selectedShopIds(),
        });
        appliedCoupon = {
            code: res.code, name: res.name, type: res.type, value: res.value,
            maxDiscount: res.maxDiscount, minOrderAmount: res.minOrderAmount,
        };
        if (input) input.value = '';
        showToast(`Coupon ${res.code} applied!`, 'success');
        renderSummary(getCart());
    } catch (e) {
        setCouponError(e.message);
    } finally {
        btn.disabled = false; btn.textContent = 'Apply';
    }
};

window.removeCoupon = function() {
    appliedCoupon = null;
    setCouponError('');
    renderSummary(getCart());
    const items = getCart().filter(i => checkedIds.has(i.id));
    if (items.length && document.getElementById('checkoutSheet')?.classList.contains('open')) {
        fillCheckoutSheet(items);
        renderPaymentOptions();
    }
};

/* Redeem on the server right before writing orders. Returns the per-group
   discount array, or throws after dropping the coupon from the UI.         */
async function redeemForOrder(groupList, checkoutId, paymentMode = 'cod') {
    if (!appliedCoupon) return groupList.map(() => 0);
    const sub = groupList.reduce((s, g) => s + g.subtotal, 0);
    try {
        const r = await redeemCoupon(currentUser, {
            code: appliedCoupon.code, groupOrderId: checkoutId, subtotal: sub,
            orderType: 'product', shopIds: selectedShopIds(), paymentMode,
        });
        return splitDiscount(groupList.map(g => g.subtotal), r.discount);
    } catch (e) {
        appliedCoupon = null;
        renderSummary(getCart());
        e.isCoupon = true;
        throw e;
    }
}

/* ════ WALLET ════
   walletCfg = admin settings (config/wallet), walletBalance = wallets/{uid}.balance.
   The server re-checks every limit in /api/wallet/redeem; this drives live totals. */
let walletCfg     = null;
let walletBalance = 0;
let useWallet     = true;

const walletUseFor = gross => useWallet ? computeWalletUse(walletCfg, walletBalance, gross, 'product') : 0;

async function loadWalletState() {
    if (!currentUser) return;
    [walletCfg, walletBalance] = await Promise.all([loadWalletConfig(), loadWalletBalance(currentUser)]);
}

/* Order total before the wallet, for whatever is ticked in the cart right now */
function checkoutGross() {
    const items = getCart().filter(i => checkedIds.has(i.id));
    let sub = 0, delivery = 0;
    const catTotals = {};
    items.forEach(i => {
        sub += i.price * i.qty;
        const c = (i.category || '').toLowerCase();
        catTotals[c] = (catTotals[c] || 0) + i.price * i.qty;
    });
    if (selectedFulfillment !== 'pickup') {
        Object.keys(catTotals).forEach(cat => {
            const fee = getDeliveryFee(cat, catTotals[cat]);
            if (fee !== null) delivery += fee;
        });
    }
    return sub - couponDiscountFor(sub) + delivery;
}

function renderWalletBlock(gross) {
    const el = document.getElementById('coWalletBlock');
    if (!el) return;
    if (!currentUser || !walletCfg?.enabled || !(walletCfg.applyToProducts)) { el.style.display = 'none'; el.innerHTML = ''; return; }

    const reason = walletBlockReason(walletCfg, walletBalance, gross, 'product');
    const canUse = !reason;
    const use    = canUse ? computeWalletUse(walletCfg, walletBalance, gross, 'product') : 0;
    el.style.display = 'block';
    el.innerHTML = `
    <div class="co-wallet ${canUse && useWallet ? 'co-wallet--on' : ''} ${canUse ? '' : 'co-wallet--off'}">
        <div class="co-wallet-icon"><i class="fa-solid fa-wallet"></i></div>
        <div class="co-wallet-body">
            <div class="co-wallet-title">Use wallet balance <span class="co-wallet-bal">${inr(walletBalance)}</span></div>
            <div class="co-wallet-sub">${canUse
                ? (useWallet ? `Paying ${inr(use)} from your wallet` : `You can use up to ${inr(use)} on this order`)
                : reason}</div>
        </div>
        <label class="co-switch">
            <input type="checkbox" ${canUse && useWallet ? 'checked' : ''} ${canUse ? '' : 'disabled'}
                   onchange="toggleWallet(this.checked)">
            <span class="co-switch-track"></span>
        </label>
    </div>`;
}

window.toggleWallet = function(on) {
    useWallet = !!on;
    const items = getCart().filter(i => checkedIds.has(i.id));
    if (items.length) { fillCheckoutSheet(items); }
};

/* Reserve wallet money on the server right before writing orders. Returns the wallet
   share of each shop group (same order as groupList). Call AFTER coupons are redeemed. */
async function redeemWalletForOrder(groupList, checkoutId, paymentMode) {
    const payables = groupList.map(g => g.subtotal - g.discount + g.deliveryFee);
    const gross    = payables.reduce((s, a) => s + a, 0);
    if (!useWallet || computeWalletUse(walletCfg, walletBalance, gross, 'product') <= 0) return groupList.map(() => 0);
    try {
        const r = await redeemWallet(currentUser, {
            groupOrderId: checkoutId, orderTotal: gross, orderType: 'product', paymentMode,
        });
        return splitDiscount(payables, r.amount);
    } catch (e) {
        useWallet = false;
        loadWalletState().then(() => { renderPaymentOptions(); });
        e.isWallet = true;
        throw e;
    }
}

window.selectCartFulfillment = function(type) {
    selectedFulfillment = type;
    const isPickup = type === 'pickup';

    const devEl = document.getElementById('coFulDelivery');
    const picEl = document.getElementById('coFulPickup');
    if (devEl) {
        devEl.classList.toggle('selected', !isPickup);
        const rad = devEl.querySelector('input'); if (rad) rad.checked = !isPickup;
    }
    if (picEl) {
        picEl.classList.toggle('selected', isPickup);
        const rad = picEl.querySelector('input'); if (rad) rad.checked = isPickup;
    }

    const addrSec = document.getElementById('coAddressSection');
    if (addrSec) {
        addrSec.style.display = isPickup ? 'none' : 'block';
    }

    const cart  = getCart();
    const items = cart.filter(i => checkedIds.has(i.id));
    if (items.length) {
        fillCheckoutSheet(items);
    }
};

/* ════ PAYMENT CONFIG STATE ════
   Fetched fresh from KV on every checkout open — no localStorage cache.
   selectedPayMethod: 'COD' | 'razorpay' | 'partial' | 'partial_full'
     partial_full = user tapped "pay full" link inside the partial card    */
let _payConfig        = null;   // { mode, onlineDepositPercent, applyToCart }
let selectedPayMethod = 'COD';  // default until config is loaded

/* Fetch payment config directly from KV worker — no localStorage */
async function fetchPaymentConfig() {
    try {
        const res = await fetch(`${WORKER_URL}/api/config/payment`, {
            signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
            const json = await res.json();
            if (json && json.mode) { _payConfig = json; return json; }
        }
    } catch (_) { /* network issue — fall through to default */ }
    // Safe default: show both so checkout is never blocked
    _payConfig = { mode: 'both', onlineDepositPercent: 30, applyToCart: true };
    return _payConfig;
}

/* Effective mode for cart — if applyToCart is false, always COD */
function effectivePayMode() {
    if (!_payConfig) return 'cod_only';
    if (_payConfig.applyToCart === false) return 'cod_only';
    return _payConfig.mode || 'both';
}

const CAT_CFG = {
    stationary: { label:'Stationary', icon:'fa-solid fa-pen-ruler',   color:'#22c55e' },
    books:      { label:'Books',       icon:'fa-solid fa-book-open',   color:'#f59e0b' },
    electronic: { label:'Kits',        icon:'fa-solid fa-microchip',   color:'#a855f7' },
    posters:    { label:'Wall Posters', icon:'fa-solid fa-image',      color:'#ec4899' },
};

/* ════ INIT ════ */
onAuthStateChanged(auth, user => {
    currentUser = user;
    if (user) syncWallet(user).then(r => { if (r) walletBalance = r.balance; });
    if (user) {
        const raw = localStorage.getItem('jasa_user_cache');
        if (raw) try { Object.assign(userProfile, JSON.parse(raw)); } catch(_){}
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    await fetchShops();
    renderCart();
    /* Silently refresh stale / missing cart item images from KV-backed cache */
    refreshCartImages();
    window.addEventListener('cartUpdated', renderCart);
    window.addEventListener('storage', e => { if(e.key===CART_KEY) renderCart(); });
});

/* ════ CART HELPERS ════ */
function getCart() { try{ return JSON.parse(localStorage.getItem(CART_KEY)||'[]'); }catch{ return []; } }
function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    window.dispatchEvent(new CustomEvent('cartUpdated', { detail: cart }));
}
function esc(s){ return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

/* ════ SHOPS ════ */
async function fetchShops() {
    /* 1. localStorage cache (24h TTL) */
    const CACHE_KEY = 'global_shops_data_v1';
    try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
            const { data, timestamp, ttl } = JSON.parse(cached);
            if (Date.now() - timestamp < (ttl || 86400000) && data?.length) {
                allShops = data; return;
            }
        }
    } catch (_) {}
    /* 2. Worker edge cache */
    try {
        const res = await fetch(`${WORKER_URL}/api/shops/all`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            const json  = await res.json();
            const shops = json.shops || json.data || [];
            if (shops.length) {
                localStorage.setItem(CACHE_KEY, JSON.stringify({ data: shops, timestamp: Date.now(), ttl: 86400000 }));
                allShops = shops; return;
            }
        }
    } catch (_) {}
    /* 3. Firestore fallback */
    try {
        const snap = await getDocs(collection(db,'shops'));
        allShops = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    } catch(e) { console.warn('Shops fetch failed:',e); }
}

function getDeliveryFee(cat, subtotal) {
    const shopId = selectedShops[cat];
    if (!shopId) return null; // not selected
    const shop = allShops.find(s => s.id === shopId);
    if (!shop) return 0;
    const rules = shop.deliveryPrices?.others || [];
    const rule  = rules.find(r => subtotal >= (r.min||0) && (r.max==null || subtotal <= r.max));
    return rule ? (Number(rule.fee)||0) : 0;
}

function getFreeThreshold(shopId) {
    const shop = allShops.find(s => s.id === shopId);
    const rules = shop?.deliveryPrices?.others || [];
    const fr = rules.find(r => Number(r.fee)===0);
    return fr ? (fr.min||0) : null;
}

/* ════ SERVER QUOTE ════
   Prices the checkout on the server (POST /api/orders/quote) and puts the
   returned lines, subtotal and delivery fee into `groups` — Firestore rules
   only accept orders that match the quote. If the total differs from what the
   customer was shown, the cart prices are refreshed and the customer confirms
   the new total before the order goes ahead.                                 */
async function applyServerQuote(groups, checkoutId, isPickup) {
    const shown = Object.values(groups).reduce((s, g) => s + g.subtotal + g.deliveryFee, 0);
    let q;
    try {
        q = await quoteOrder(currentUser, {
            groupOrderId: checkoutId, type: 'product', isPickup,
            groups: Object.entries(groups).map(([shopId, g]) => ({ shopId, items: g.items })),
        });
    } catch (e) { e.isQuote = true; throw e; }

    q.groups.forEach(qg => Object.assign(groups[qg.shopId], {
        items: qg.items, subtotal: qg.subtotal, deliveryFee: qg.deliveryFee,
    }));
    if (priceChanged(shown, q.subtotal + q.deliveryFee)) {
        const fresh = new Map(q.groups.flatMap(g => g.items).map(i => [i.id, i]));
        saveCart(getCart().map(i => fresh.has(i.id) ? { ...i,
            price: fresh.get(i.id).price, originalPrice: fresh.get(i.id).originalPrice,
            discountPercent: fresh.get(i.id).discountPercent } : i));
        renderCart();
        const now = q.subtotal + q.deliveryFee;
        const ok  = await showConfirm('Price updated',
            `The current total for these items is ₹${now.toFixed(2)} (you saw ₹${shown.toFixed(2)}). Place the order at the new price?`);
        if (!ok) {
            const err = new Error('Order not placed. Please check the updated prices.');
            err.isQuote = true;
            throw err;
        }
    }
}

/* ════ RENDER CART ════ */
function renderCart() {
    const cart = getCart();
    const empty   = document.getElementById('cartEmpty');
    const content = document.getElementById('cartContent');
    const countEl = document.getElementById('cartCountText');

    if (isFirstRender) { cart.forEach(i => checkedIds.add(i.id)); isFirstRender = false; }

    if (!cart.length) {
        if(empty)   empty.style.display   = 'block';
        if(content) content.style.display = 'none';
        if(countEl) countEl.textContent   = '0 items';
        return;
    }
    if(empty)   empty.style.display   = 'none';
    if(content) content.style.display = 'block';
    if(countEl) countEl.textContent   = `${cart.length} item${cart.length!==1?'s':''}`;

    renderGrid(cart);
    renderSummary(cart);
}

function renderGrid(cart) {
    const grid = document.getElementById('cartGrid');
    if (!grid) return;
    grid.innerHTML = cart.map(item => {
        const selected  = checkedIds.has(item.id);
        const itemTotal = item.price * item.qty;
        /* Support both 'img' (categories/item-details) and 'imageUrl' (home-categories) */
        const img = item.img || item.imageUrl || '';
        const imgHtml = img
            ? `<img src="${img}" alt="${esc(item.name)}" loading="lazy"
                   id="cart-img-${item.id}"
                   onerror="cartImgError(this,'${item.id}')">`
            : `<i class="fa-solid fa-box cart-no-img" id="cart-img-${item.id}"></i>`;
        return `
        <div class="cart-item-card ${selected?'selected':''}" id="ci-${item.id}">
            <div class="cart-check-wrap">
                <div class="cart-check" onclick="toggleCheck('${item.id}')">
                    <i class="fa-solid fa-check"></i>
                </div>
            </div>
            <button class="cart-remove-btn" onclick="confirmRemove('${item.id}','${esc(item.name)}')">
                <i class="fa-solid fa-trash-can"></i>
            </button>
            <div class="cart-item-img">
                ${imgHtml}
            </div>
            <div class="cart-item-body">
                <a href="item-details.html?id=${item.id}" class="cart-item-name">${item.name}</a>
                <div class="cart-item-price">
                    ₹${item.price.toLocaleString('en-IN')}
                    ${item.originalPrice&&item.originalPrice>item.price
                        ? `<span class="cart-item-original">₹${item.originalPrice.toLocaleString('en-IN')}</span>` : ''}
                </div>
                <div class="cart-qty">
                    <button class="cart-qty-btn" onclick="changeQty('${item.id}',${item.qty-1})">
                        <i class="fa-solid fa-minus"></i>
                    </button>
                    <span class="cart-qty-num">${item.qty}</span>
                    <button class="cart-qty-btn" onclick="changeQty('${item.id}',${item.qty+1})">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
                <div class="cart-item-sub">
                    <span class="cart-item-sub-label">Subtotal</span>
                    <span class="cart-item-sub-val">₹${itemTotal.toLocaleString('en-IN')}</span>
                </div>
            </div>
        </div>`;
    }).join('');
}

/* ════ IMAGE REFRESH ════
   Fetches fresh image URLs from sessionStorage category caches
   (populated by the Cloudflare Worker KV cache) and patches
   both the live DOM and the persisted cart in localStorage.
   Also handles the 'imageUrl' vs 'img' key mismatch from home-categories.js.
   ════════════════════════ */
async function refreshCartImages() {
    const cart = getCart();
    if (!cart.length) return;

    const CATEGORIES = ['stationary', 'books', 'electronic', 'posters'];
    const CACHE_TTL  = 3600000; // 1 hour

    /* Build a lookup map: itemId → freshImageUrl from every cached category */
    const freshMap = {};

    /* 1. Walk existing sessionStorage category caches (zero network cost) */
    for (const cat of CATEGORIES) {
        try {
            const raw = sessionStorage.getItem(`jasa_v2_cat_${cat}`);
            if (!raw) continue;
            const { data, ts } = JSON.parse(raw);
            if (Date.now() - ts > CACHE_TTL) continue; // stale — skip
            if (!Array.isArray(data)) continue;
            data.forEach(it => {
                if (!freshMap[it.id]) {
                    const url = it.images?.find(i => i.isPrimary)?.url
                        || it.images?.[0]?.url
                        || it.image || it.imageUrl || it.img || '';
                    if (url) freshMap[it.id] = url;
                }
            });
        } catch (_) {}
    }

    /* 2. For cart items still missing a URL, try the Worker / KV endpoint */
    const missingCats = new Set(
        cart
            .filter(i => !freshMap[i.id] && !(i.img || i.imageUrl))
            .map(i => (i.category || '').toLowerCase())
            .filter(c => CATEGORIES.includes(c))
    );

    for (const cat of missingCats) {
        try {
            const res = await fetch(`${WORKER_URL}/api/items?category=${cat}`, {
                cache: 'no-cache', signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) continue;
            const json  = await res.json();
            const items = json.items || json.data || [];
            if (!items.length) continue;
            /* Cache for future use */
            try {
                sessionStorage.setItem(
                    `jasa_v2_cat_${cat}`,
                    JSON.stringify({ data: items, ts: Date.now() })
                );
            } catch (_) {}
            items.forEach(it => {
                if (!freshMap[it.id]) {
                    const url = it.images?.find(i => i.isPrimary)?.url
                        || it.images?.[0]?.url
                        || it.image || it.imageUrl || it.img || '';
                    if (url) freshMap[it.id] = url;
                }
            });
        } catch (_) {}
    }

    /* 3. Patch cart items that are missing or have a mismatched image key */
    let cartChanged = false;
    const patchedCart = cart.map(item => {
        const currentImg = item.img || item.imageUrl || '';
        const freshUrl   = freshMap[item.id] || '';
        if (!currentImg && freshUrl) {
            cartChanged = true;
            return { ...item, img: freshUrl };
        }
        /* Normalise: if only imageUrl exists, copy it to img */
        if (!item.img && item.imageUrl) {
            cartChanged = true;
            return { ...item, img: item.imageUrl };
        }
        return item;
    });

    if (cartChanged) {
        /* Save silently without dispatching cartUpdated to avoid re-render loop */
        try { localStorage.setItem(CART_KEY, JSON.stringify(patchedCart)); } catch (_) {}
    }

    /* 4. Update DOM images that are currently broken or empty */
    patchedCart.forEach(item => {
        const imgEl = document.getElementById(`cart-img-${item.id}`);
        if (!imgEl) return;
        const freshUrl = freshMap[item.id] || item.img || item.imageUrl || '';
        if (!freshUrl) return;
        /* Only patch <img> elements; if it's an icon, replace it */
        if (imgEl.tagName === 'IMG') {
            /* Only update src if the current one is empty or already broken */
            if (!imgEl.src || imgEl.naturalWidth === 0) {
                imgEl.src = freshUrl;
            }
        } else {
            /* Replace icon placeholder with a real image */
            const newImg = document.createElement('img');
            newImg.src = freshUrl;
            newImg.alt = item.name || '';
            newImg.loading = 'lazy';
            newImg.id = `cart-img-${item.id}`;
            newImg.onerror = function() { cartImgError(this, item.id); };
            imgEl.replaceWith(newImg);
        }
    });
}

/* onerror handler for cart item images:
   Hides the broken <img> and swaps in a fallback icon,
   then tries to recover the URL from the category cache. */
window.cartImgError = function(imgEl, itemId) {
    /* Prevent infinite error loops */
    imgEl.onerror = null;
    /* Swap to icon placeholder */
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-box cart-no-img';
    icon.id = `cart-img-${itemId}`;
    imgEl.replaceWith(icon);
    /* Try to recover from sessionStorage caches */
    const CATEGORIES = ['stationary', 'books', 'electronic', 'posters'];
    const CACHE_TTL  = 3600000;
    for (const cat of CATEGORIES) {
        try {
            const raw = sessionStorage.getItem(`jasa_v2_cat_${cat}`);
            if (!raw) continue;
            const { data, ts } = JSON.parse(raw);
            if (Date.now() - ts > CACHE_TTL) continue;
            if (!Array.isArray(data)) continue;
            const found = data.find(it => it.id === itemId);
            if (!found) continue;
            const freshUrl = found.images?.find(i => i.isPrimary)?.url
                || found.images?.[0]?.url || '';
            if (!freshUrl) continue;
            /* Restore image with fresh URL */
            const newImg = document.createElement('img');
            newImg.src = freshUrl;
            newImg.alt = '';
            newImg.loading = 'lazy';
            newImg.id = `cart-img-${itemId}`;
            icon.replaceWith(newImg);
            /* Patch localStorage so the fresh URL persists */
            try {
                const cart = getCart();
                const ci   = cart.find(i => i.id === itemId);
                if (ci) { ci.img = freshUrl; localStorage.setItem(CART_KEY, JSON.stringify(cart)); }
            } catch (_) {}
            return;
        } catch (_) {}
    }
};

function renderSummary(cart) {
    const checkedItems = cart.filter(i => checkedIds.has(i.id));
    let subtotal = 0, totalQty = 0;
    const catTotals = { stationary:0, books:0, electronic:0, posters:0 };
    const activeCats = new Set();

    let itemRowsHtml = '';
    checkedItems.forEach(item => {
        const line = item.price * item.qty;
        subtotal  += line; totalQty += item.qty;
        const cat  = (item.category||'').toLowerCase();
        if (catTotals.hasOwnProperty(cat)) { catTotals[cat]+=line; activeCats.add(cat); }
        itemRowsHtml += `
        <div class="sum-item-row">
            <span class="sum-item-name">${item.name} ×${item.qty}</span>
            <span class="sum-item-amt">₹${line.toLocaleString('en-IN')}</span>
        </div>`;
    });

    const subtotalEl  = document.getElementById('subtotalLabel');
    const subtotalVal = document.getElementById('subtotalVal');
    const deliveryEl  = document.getElementById('deliveryVal');
    const totalEl     = document.getElementById('totalVal');
    const nudgeEl     = document.getElementById('deliveryNudge');
    const rowsEl      = document.getElementById('summaryItemRows');
    if(rowsEl)      rowsEl.innerHTML    = itemRowsHtml;
    if(subtotalEl)  subtotalEl.textContent = `Subtotal (${totalQty} item${totalQty!==1?'s':''})`;
    if(subtotalVal) subtotalVal.textContent = `₹${subtotal.toLocaleString('en-IN')}`;

    // Delivery fee totals
    let totalDelivery = 0;
    let allSelected = true;
    activeCats.forEach(cat => {
        const fee = getDeliveryFee(cat, catTotals[cat]);
        if (fee === null) { allSelected = false; }
        else { totalDelivery += fee; }
    });

    if (!activeCats.size || !allSelected) {
        if(deliveryEl) { deliveryEl.textContent = activeCats.size ? 'Select shop' : '—'; deliveryEl.className='cart-sum-val cart-sum-delivery'; }
        if(nudgeEl) nudgeEl.innerHTML = '';
    } else {
        if(deliveryEl) {
            deliveryEl.textContent  = totalDelivery === 0 ? 'FREE' : `₹${totalDelivery.toLocaleString('en-IN')}`;
            deliveryEl.className    = `cart-sum-val ${totalDelivery===0?'co-primary':'cart-sum-delivery'}`;
        }
        // Nudge
        let nudgeHtml = '';
        if (totalDelivery > 0 && nudgeEl) {
            activeCats.forEach(cat => {
                const shopId = selectedShops[cat];
                const thresh = getFreeThreshold(shopId);
                if (thresh && catTotals[cat] < thresh) {
                    const rem = thresh - catTotals[cat];
                    nudgeHtml += `<div class="cart-nudge">
                        <i class="fa-solid fa-gift"></i>
                        Add ₹${rem.toLocaleString('en-IN')} more in ${CAT_CFG[cat]?.label||cat} for FREE delivery!
                    </div>`;
                }
            });
        } else if (totalDelivery === 0 && nudgeEl) {
            nudgeHtml = `<div class="cart-nudge success"><i class="fa-solid fa-circle-check"></i> You've got FREE delivery!</div>`;
        }
        if(nudgeEl) nudgeEl.innerHTML = nudgeHtml;
    }

    const couponDisc = couponDiscountFor(subtotal);
    const discRow = document.getElementById('discountRow');
    if (discRow) discRow.style.display = couponDisc > 0 ? '' : 'none';
    if (couponDisc > 0) {
        setText('discountLabel', `Coupon (${appliedCoupon.code})`);
        setText('discountVal', `-₹${couponDisc.toLocaleString('en-IN')}`);
    }
    renderCouponBox(subtotal);

    const finalTotal = subtotal - couponDisc + totalDelivery;
    if(totalEl) totalEl.textContent = `₹${finalTotal.toLocaleString('en-IN')}`;

    renderShopSelectors(activeCats);
}

function renderShopSelectors(activeCats) {
    const wrap = document.getElementById('shopSelectors');
    if (!wrap || !activeCats.size) { if(wrap) wrap.innerHTML=''; return; }

    let html = `<div class="shop-selector-wrap"><div class="shop-selector-head"><i class="fa-solid fa-store" style="color:var(--primary);margin-right:6px;"></i>Select Delivery Shop</div>`;

    activeCats.forEach(cat => {
        const cfg    = CAT_CFG[cat] || { label: cat, icon:'fa-solid fa-store', color:'' };
        const shopId = selectedShops[cat];
        const shop   = allShops.find(s => s.id === shopId);
        const hasShop = !!shop;

        // Build selected shop mini-card when a shop is chosen
        let shopPreview = '';
        if (hasShop) {
            const rules    = shop.deliveryPrices?.others || [];
            const freeRule = rules.find(r => Number(r.fee) === 0);
            const areas    = (shop.areas || []).slice(0, 3);
            const moreAreas = (shop.areas || []).length > 3 ? `<span class="cs-area cs-area-more">+${shop.areas.length - 3}</span>` : '';
            const areasHtml = areas.map(a => `<span class="cs-area">${a}</span>`).join('');

            shopPreview = `
            <div class="cs-selected-preview">
                <div class="cs-preview-head">
                    <div class="cs-preview-icon"><i class="fa-solid fa-store"></i></div>
                    <div class="cs-preview-info">
                        <div class="cs-preview-name">${shop.name}</div>
                        <div class="cs-preview-addr"><i class="fa-solid fa-location-dot"></i> ${shop.address || 'Local Centre'}</div>
                    </div>
                    <div class="cs-preview-check"><i class="fa-solid fa-circle-check"></i></div>
                </div>
                ${areasHtml ? `<div class="cs-preview-areas"><i class="fa-solid fa-motorcycle cs-areas-icon"></i>${areasHtml}${moreAreas}</div>` : ''}
                ${freeRule ? `<div class="cs-preview-free"><i class="fa-solid fa-gift"></i> FREE delivery above ₹${freeRule.min.toLocaleString('en-IN')}</div>` : ''}
                <button class="cs-change-btn" onclick="openShopSheet('${cat}')"><i class="fa-solid fa-arrows-rotate"></i> Change Shop</button>
            </div>`;
        }

        html += `
        <div class="cs-selector-block">
            <div class="cs-selector-label">
                <i class="${cfg.icon}" style="color:${cfg.color};"></i>
                <span>${cfg.label}</span>
                ${hasShop ? '<span class="cs-label-badge">Selected</span>' : '<span class="cs-label-required">Required</span>'}
            </div>
            ${hasShop ? shopPreview : `
            <div class="cs-empty-row" onclick="openShopSheet('${cat}')">
                <div class="cs-empty-icon"><i class="fa-solid fa-store"></i></div>
                <div class="cs-empty-text">
                    <div class="cs-empty-title">Select a shop</div>
                    <div class="cs-empty-sub">Tap to choose your delivery shop</div>
                </div>
                <i class="fa-solid fa-chevron-right cs-chevron"></i>
            </div>`}
        </div>`;
    });

    html += `</div>`;
    wrap.innerHTML = html;
}

/* ════ CART ACTIONS ════ */
window.toggleCheck = function(id) {
    if (checkedIds.has(id)) checkedIds.delete(id);
    else checkedIds.add(id);
    const card = document.getElementById(`ci-${id}`);
    if (card) card.classList.toggle('selected', checkedIds.has(id));
    renderSummary(getCart());
};

window.changeQty = function(id, qty) {
    if (qty < 1) return;
    const cart = getCart();
    const item = cart.find(i => i.id === id);
    if (item) { item.qty = qty; saveCart(cart); }
};

window.confirmRemove = function(id, name) {
    showConfirm(`Remove "${name}"?`, 'This item will be removed from your cart.')
        .then(ok => { if (ok) { removeItem(id); } });
};

function removeItem(id) {
    const cart = getCart().filter(i => i.id !== id);
    checkedIds.delete(id);
    saveCart(cart);
}

/* ════ SHOP SHEET ════ */
let _openShopCat = '';

window.openShopSheet = function(cat) {
    _openShopCat = cat;
    const cfg     = CAT_CFG[cat] || { label: cat };
    const titleEl = document.getElementById('shopSheetTitle');
    const bodyEl  = document.getElementById('shopSheetBody');
    if (titleEl) titleEl.textContent = `Select ${cfg.label} Shop`;

    const serviceMap = { electronic:'Electronics', books:'Books', stationary:'Stationary', posters:'Posters' };
    const req        = (serviceMap[cat]||cat).toLowerCase();
    const shops      = allShops.filter(s =>
        (s.services||[]).some(sv => sv.toLowerCase() === req)
    );

    if (!shops.length) {
        bodyEl.innerHTML = `<p style="text-align:center;padding:36px 20px;font-size:.82rem;color:var(--txt3);font-weight:600;"><i class="fa-solid fa-store-slash" style="font-size:1.8rem;display:block;margin-bottom:10px;color:var(--border2);"></i>No shops available for this category right now.</p>`;
    } else {
        bodyEl.innerHTML = shops.map(shop => {
            const sel      = shop.id === selectedShops[cat];
            const rules    = shop.deliveryPrices?.others || [];
            const freeRule = rules.find(r => Number(r.fee) === 0);
            const areas    = (shop.areas || []).slice(0, 3);
            const moreAreas = (shop.areas || []).length > 3 ? `<span class="css-area css-area-more">+${shop.areas.length - 3}</span>` : '';
            const areasHtml = areas.map(a => `<span class="css-area">${a}</span>`).join('');

            // Delivery tiers
            const tierRows = rules.length ? rules.map(r => {
                const isFree = Number(r.fee) === 0;
                const range  = r.max != null
                    ? `₹${Number(r.min).toLocaleString('en-IN')} – ₹${Number(r.max).toLocaleString('en-IN')}`
                    : `₹${Number(r.min).toLocaleString('en-IN')}+`;
                return `<div class="css-tier-row">
                    <span class="css-tier-range">${range}</span>
                    <span class="css-tier-fee ${isFree ? 'free' : ''}">${isFree ? 'FREE 🎉' : `₹${Number(r.fee).toLocaleString('en-IN')} delivery`}</span>
                </div>`;
            }).join('') : '';

            const mobileNums = Array.isArray(shop.mobileNumbers) ? shop.mobileNumbers : (shop.phone ? [shop.phone] : []);
            const callBtns   = mobileNums.slice(0, 1).map(num => {
                const clean = num.toString().replace(/[^\d+]/g, '');
                return `<button class="css-call-btn" onclick="event.stopPropagation();window.location.href='tel:${clean}'">
                    <i class="fa-solid fa-phone"></i> Call <span class="css-num">${num}</span>
                </button>`;
            }).join('');

            return `
            <div class="css-shop-card ${sel ? 'selected' : ''}" onclick="selectShop('${cat}','${shop.id}')">
                <div class="css-card-head">
                    <div class="css-card-icon ${sel ? 'selected' : ''}"><i class="fa-solid fa-store"></i></div>
                    <div class="css-card-info">
                        <div class="css-card-name">${shop.name}</div>
                        <div class="css-card-addr"><i class="fa-solid fa-location-dot"></i> ${shop.address || 'Local Centre'}</div>
                    </div>
                    <div class="css-radio ${sel ? 'checked' : ''}">
                        ${sel ? '<i class="fa-solid fa-circle-check"></i>' : ''}
                    </div>
                </div>
                ${areasHtml ? `
                <div class="css-areas">
                    <i class="fa-solid fa-motorcycle css-areas-icon"></i>
                    ${areasHtml}${moreAreas}
                </div>` : ''}
                ${freeRule ? `<div class="css-free-badge"><i class="fa-solid fa-gift"></i> FREE delivery above ₹${freeRule.min.toLocaleString('en-IN')}</div>` : ''}
                ${tierRows ? `<div class="css-tiers">${tierRows}</div>` : ''}
                ${shop.notes ? `<div class="css-notes"><i class="fa-solid fa-circle-info"></i> ${shop.notes}</div>` : ''}
                ${callBtns ? `<div class="css-actions">${callBtns}</div>` : ''}
            </div>`;
        }).join('');
    }
    openSheet('shopBackdrop','shopSheet');
};

window.closeShopSheet = function() { closeSheet('shopBackdrop','shopSheet'); };

window.selectShop = function(cat, shopId) {
    selectedShops[cat] = shopId;
    closeShopSheet();
    renderCart();
};

/* ════ CHECKOUT SHEET ════ */
window.validateAndProceed = function() {
    if (!currentUser) {
        showToast('Please sign in to place an order.', 'error');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }
    const cart  = getCart();
    const items = cart.filter(i => checkedIds.has(i.id));
    if (!items.length) { showToast('Select at least one item to checkout.', 'error'); return; }

    const activeCats = new Set(items.map(i => (i.category||'').toLowerCase())
        .filter(c => CAT_CFG.hasOwnProperty(c)));

    // Find which categories are missing a shop
    const missingCats = [];
    activeCats.forEach(cat => { if (!selectedShops[cat]) missingCats.push(cat); });

    if (missingCats.length) {
        const label = missingCats.map(c => CAT_CFG[c]?.label || c).join(', ');
        showToast(`Select a shop for: ${label}`, 'error');

        // Highlight each missing selector block with error state + scroll to first one
        let firstEl = null;
        missingCats.forEach((cat, idx) => {
            // Flash the cs-empty-row or cs-selector-block red
            const blocks = document.querySelectorAll('.cs-selector-block');
            blocks.forEach(block => {
                // Match by checking the label text inside
                const labelEl = block.querySelector('.cs-selector-label span');
                if (labelEl && labelEl.textContent.trim().toLowerCase() === (CAT_CFG[cat]?.label||cat).toLowerCase()) {
                    const emptyRow = block.querySelector('.cs-empty-row');
                    if (emptyRow) {
                        emptyRow.classList.add('error-shake');
                        setTimeout(() => emptyRow.classList.remove('error-shake'), 700);
                    }
                    if (idx === 0) firstEl = block;
                }
            });
        });

        if (firstEl) {
            setTimeout(() => firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
        }
        return;
    }

    fillCheckoutSheet(items);
    openSheet('checkoutBackdrop','checkoutSheet');
    loadWalletState().then(() => {
        const cur = getCart().filter(i => checkedIds.has(i.id));
        if (cur.length && document.getElementById('checkoutSheet')?.classList.contains('open')) fillCheckoutSheet(cur);
    });
};

window.closeCheckoutSheet = function() { closeSheet('checkoutBackdrop','checkoutSheet'); };

function fillCheckoutSheet(items) {
    // Build per-category totals
    let sub = 0, delivery = 0;
    const catTotals = {};
    items.forEach(i => {
        sub += i.price * i.qty;
        const c = (i.category||'').toLowerCase();
        if (!catTotals[c]) catTotals[c] = 0;
        catTotals[c] += i.price * i.qty;
    });
    if (selectedFulfillment === 'pickup') {
        delivery = 0;
    } else {
        Object.keys(catTotals).forEach(cat => {
            const fee = getDeliveryFee(cat, catTotals[cat]);
            if (fee !== null) delivery += fee;
        });
    }
    const couponDisc = couponDiscountFor(sub);
    const gross = sub - couponDisc + delivery;
    const walletUse = walletUseFor(gross);
    const total = gross - walletUse;

    const coWalRow = document.getElementById('coWalletRow');
    if (coWalRow) coWalRow.style.display = walletUse > 0 ? '' : 'none';
    if (walletUse > 0) setText('coWalletUsed', `-${inr(walletUse)}`);
    renderWalletBlock(gross);

    const coDiscRow = document.getElementById('coDiscountRow');
    if (coDiscRow) coDiscRow.style.display = couponDisc > 0 ? '' : 'none';
    if (couponDisc > 0) {
        setText('coDiscountLabel', `Coupon (${appliedCoupon.code})`);
        setText('coDiscount', `-₹${couponDisc.toLocaleString('en-IN')}`);
    }

    setText('coSubtotal', `₹${sub.toLocaleString('en-IN')}`);
    setText('coDelivery', selectedFulfillment === 'pickup' ? 'FREE (Pickup)' : (delivery === 0 ? 'FREE 🎉' : `₹${delivery.toLocaleString('en-IN')}`));
    setText('coTotal',    `₹${total.toLocaleString('en-IN')}`);

    // Build per-shop summary rows inside checkout sheet
    const shopLineEl = document.getElementById('coShopLine');
    if (shopLineEl) {
        const rows = Object.keys(catTotals).map(cat => {
            const shop     = allShops.find(s => s.id === selectedShops[cat]);
            const cfg      = CAT_CFG[cat] || { label: cat, icon: 'fa-solid fa-store', color: '' };
            const fee      = getDeliveryFee(cat, catTotals[cat]);
            const feeLabel = fee === 0 ? '<span style="color:#16a34a;font-weight:800;">FREE</span>'
                           : fee > 0   ? `₹${fee.toLocaleString('en-IN')} delivery`
                           : '—';
            return `
            <div class="co-shop-row">
                <div class="co-shop-row-left">
                    <div class="co-shop-row-icon">
                        <i class="${cfg.icon}" style="color:${cfg.color};"></i>
                    </div>
                    <div class="co-shop-row-info">
                        <div class="co-shop-row-cat">${cfg.label}</div>
                        <div class="co-shop-row-name">
                            <i class="fa-solid fa-circle-check" style="color:#16a34a;font-size:.65rem;margin-right:3px;"></i>
                            ${shop ? shop.name : '—'}
                        </div>
                    </div>
                </div>
                <div class="co-shop-row-fee">${feeLabel}</div>
            </div>`;
        }).join('');

        shopLineEl.innerHTML = `
        <div class="co-shop-summary">
            <div class="co-shop-summary-title">
                <i class="fa-solid fa-store"></i> Shops &amp; Delivery
            </div>
            ${rows}
        </div>`;
    }

    renderContactSelect();
    renderAddressList();

    // Fetch payment config fresh from KV — no localStorage — then render options
    const payBlock = document.getElementById('coPaymentBlock');
    if (payBlock) payBlock.innerHTML = '';
    fetchPaymentConfig().then(() => renderPaymentOptions());
}

function renderContactSelect() {
    const primary   = document.getElementById('coMobile');
    const alternate = document.getElementById('coAltMobile');
    const newForm   = document.getElementById('newContactForm');
    if (!primary || !alternate) return;

    const nums = [];
    if (userProfile.mobileNumber) nums.push(userProfile.mobileNumber);
    (userProfile.altMobiles||[]).forEach(n => { if (!nums.includes(n)) nums.push(n); });

    if (!nums.length) {
        primary.innerHTML = '<option value="">No number saved</option>';
        alternate.innerHTML = '<option value="">— None —</option>';
        if (newForm) newForm.style.display = 'block';
    } else {
        primary.innerHTML   = nums.map(n => `<option value="${n}">${n}</option>`).join('');
        alternate.innerHTML = '<option value="">— None —</option>'
            + nums.map(n => `<option value="${n}">${n}</option>`).join('');
        if (newForm) newForm.style.display = 'none';
    }
}

function renderAddressList() {
    const listEl  = document.getElementById('coAddressList');
    const newForm = document.getElementById('newAddressForm');
    const addrs   = userProfile.addresses || [];
    if (!listEl) return;
    if (!addrs.length) {
        listEl.innerHTML = '';
        if (newForm) newForm.style.display = 'block';
        return;
    }
    if (newForm) newForm.style.display = 'none';
    listEl.innerHTML = addrs.map((a, i) => `
    <div class="co-addr-card ${i===selAddrIdx?'selected':''}" onclick="selectAddr(${i})">
        <input type="radio" name="coAddr" ${i===selAddrIdx?'checked':''}>
        <div>
            <div class="co-addr-label"><i class="fa-solid fa-location-dot" style="color:var(--primary);margin-right:5px;"></i>${a.label||'Home'}</div>
            <div class="co-addr-text">${a.street}, ${a.city}${a.pincode?' — '+a.pincode:''}</div>
        </div>
    </div>`).join('');
}

window.selectAddr = function(i) { selAddrIdx = i; renderAddressList(); };

window.toggleNewContact = function() {
    const f = document.getElementById('newContactForm');
    if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
};
window.toggleNewAddress = function() {
    const f = document.getElementById('newAddressForm');
    if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
};

window.saveNewMobile = async function() {
    const input = document.getElementById('newMobileInput');
    const num   = (input?.value||'').trim();
    if (!/^[6-9]\d{9}$/.test(num)) { showToast('Enter a valid 10-digit mobile number.', 'error'); return; }
    if (!userProfile.mobileNumber) userProfile.mobileNumber = num;
    else {
        if (!userProfile.altMobiles) userProfile.altMobiles = [];
        if (!userProfile.altMobiles.includes(num)) userProfile.altMobiles.push(num);
    }
    if (currentUser) {
        try {
            await updateDoc(doc(db,'users',currentUser.uid), {
                mobileNumber: userProfile.mobileNumber,
                altMobiles:   userProfile.altMobiles
            });
        } catch(_) {}
    }
    if (input) input.value = '';
    renderContactSelect();
};

window.saveNewAddress = async function() {
    const street  = document.getElementById('coAddrStreet')?.value.trim();
    const city    = document.getElementById('coAddrCity')?.value.trim();
    if (!street||!city) { showToast('Street and City are required.','error'); return; }
    const addr = {
        label:   document.getElementById('coAddrLabel')?.value.trim() || 'Home',
        street, city,
        pincode: document.getElementById('coAddrPincode')?.value.trim() || ''
    };
    if (!userProfile.addresses) userProfile.addresses = [];
    userProfile.addresses.push(addr);
    selAddrIdx = userProfile.addresses.length - 1;
    if (currentUser) {
        try { await updateDoc(doc(db,'users',currentUser.uid), { addresses: userProfile.addresses }); } catch(_){}
    }
    ['coAddrLabel','coAddrStreet','coAddrCity','coAddrPincode'].forEach(id => {
        const el = document.getElementById(id); if(el) el.value='';
    });
    renderAddressList();
};

/* ════ PAYMENT OPTIONS RENDER ════ */
function renderPaymentOptions() {
    const block = document.getElementById('coPaymentBlock');
    if (!block) return;

    // Recalculate totals fresh each time
    const cart  = getCart();
    const items = cart.filter(i => checkedIds.has(i.id));
    let sub = 0, delivery = 0;
    const catTotals = {};
    items.forEach(i => {
        const line = i.price * i.qty;
        sub += line;
        const c = (i.category || '').toLowerCase();
        if (!catTotals[c]) catTotals[c] = 0;
        catTotals[c] += line;
    });
    if (selectedFulfillment === 'pickup') {
        delivery = 0;
    } else {
        Object.keys(catTotals).forEach(cat => {
            const fee = getDeliveryFee(cat, catTotals[cat]);
            if (fee !== null) delivery += fee;
        });
    }
    const grossAmount = sub - couponDiscountFor(sub) + delivery;
    const totalAmount = grossAmount - walletUseFor(grossAmount);

    const mode = effectivePayMode();
    const pct  = _payConfig?.onlineDepositPercent ?? 30;
    const depositAmt = Math.ceil(totalAmount * pct / 100);
    const balanceAmt = totalAmount - depositAmt;
    const fmt = n => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    if (mode === 'cod_only') {
        selectedPayMethod = 'COD';
        block.innerHTML = '';
        updatePlaceOrderBtn(totalAmount);
        return;
    }

    if (mode === 'online_only') {
        selectedPayMethod = 'razorpay';
        block.innerHTML = `
        <div class="co-payment-block">
            <div class="co-payment-label"><i class="fa-solid fa-lock"></i> Payment Required</div>
            <div class="co-pay-banner">
                <div class="co-pay-banner-icon"><i class="fa-solid fa-credit-card"></i></div>
                <div class="co-pay-banner-body">
                    <div class="co-pay-banner-title">To place this order, pay ${fmt(totalAmount)} now</div>
                    <div class="co-pay-banner-sub">Full payment required to confirm · Secured via Razorpay</div>
                </div>
            </div>
        </div>`;
        updatePlaceOrderBtn(totalAmount);
        return;
    }

    if (mode === 'both') {
        if (!selectedPayMethod || selectedPayMethod === 'partial' || selectedPayMethod === 'partial_full') {
            selectedPayMethod = 'COD'; // default for 'both'
        }
        block.innerHTML = `
        <div class="co-payment-block">
            <div class="co-payment-label"><i class="fa-solid fa-wallet"></i> How would you like to pay?</div>
            <div class="co-pay-cards">

                <div class="co-pay-card ${selectedPayMethod === 'COD' ? 'co-pay-card--active' : ''}"
                     onclick="selectPayMethod('COD', ${totalAmount})">
                    <div class="co-pay-card-row">
                        <div class="co-pay-radio"><div class="co-pay-radio-dot"></div></div>
                        <div class="co-pay-card-icon co-pay-card-icon--cod">
                            <i class="fa-solid fa-money-bill-wave"></i>
                        </div>
                        <div class="co-pay-card-body">
                            <div class="co-pay-card-title">Cash on Delivery</div>
                            <div class="co-pay-card-sub">Pay when your order arrives</div>
                        </div>
                        <div class="co-pay-card-amount">${fmt(totalAmount)}</div>
                    </div>
                </div>

                <div class="co-pay-card ${selectedPayMethod === 'razorpay' ? 'co-pay-card--active' : ''}"
                     onclick="selectPayMethod('razorpay', ${totalAmount})">
                    <div class="co-pay-card-row">
                        <div class="co-pay-radio"><div class="co-pay-radio-dot"></div></div>
                        <div class="co-pay-card-icon co-pay-card-icon--online">
                            <i class="fa-solid fa-credit-card"></i>
                        </div>
                        <div class="co-pay-card-body">
                            <div class="co-pay-card-title">Pay Online Now</div>
                            <div class="co-pay-card-sub">Secured via Razorpay</div>
                        </div>
                        <div class="co-pay-card-amount">${fmt(totalAmount)}</div>
                    </div>
                </div>

            </div>
        </div>`;
        updatePlaceOrderBtn(totalAmount);
        return;
    }

    if (mode === 'partial_online') {
        // COD is NOT an option — admin explicitly requires a deposit
        if (!selectedPayMethod || selectedPayMethod === 'COD' || selectedPayMethod === 'razorpay') {
            selectedPayMethod = 'partial';
        }
        block.innerHTML = `
        <div class="co-payment-block">
            <div class="co-payment-label"><i class="fa-solid fa-percent"></i> Deposit required to confirm order</div>
            <div class="co-pay-cards">

                <div class="co-pay-card co-pay-card--active"
                     onclick="selectPayMethod('partial', ${totalAmount})">
                    <div class="co-pay-card-row">
                        <div class="co-pay-card-icon co-pay-card-icon--partial">
                            <i class="fa-solid fa-percent"></i>
                        </div>
                        <div class="co-pay-card-body">
                            <div class="co-pay-card-title">Pay ${pct}% now to confirm</div>
                            <div class="co-pay-card-sub">${fmt(balanceAmt)} pending — collected on delivery</div>
                        </div>
                        <div class="co-pay-card-amount">${fmt(depositAmt)} now</div>
                    </div>
                    <div class="co-pay-partial-detail" style="display:flex;">
                        <div class="co-pay-split-row co-pay-split-now">
                            <span>Pay now (${pct}% deposit)</span>
                            <strong>${fmt(depositAmt)}</strong>
                        </div>
                        <div class="co-pay-split-row co-pay-split-later">
                            <span>Pay on delivery</span>
                            <strong>${fmt(balanceAmt)}</strong>
                        </div>
                        <div class="co-pay-split-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:6px;">
                            <span>Total order value</span>
                            <strong>${fmt(totalAmount)}</strong>
                        </div>
                        <div class="co-pay-full-link"
                             onclick="event.stopPropagation();selectPayMethod('partial_full', ${totalAmount})">
                            <i class="fa-solid fa-circle-up"></i>
                            or pay full ${fmt(totalAmount)} online instead
                        </div>
                    </div>
                </div>

            </div>
        </div>`;
        updatePlaceOrderBtn(totalAmount);
    }
}

/* Select a payment method and re-render the block + button */
window.selectPayMethod = function(method, totalAmount) {
    selectedPayMethod = method;
    renderPaymentOptions();
};

/* Update the Place Order button label + icon based on selected method */
function updatePlaceOrderBtn(totalAmount) {
    const btn = document.getElementById('placeOrderBtn');
    if (!btn) return;
    const fmt = n => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const mode = effectivePayMode();
    const pct  = _payConfig?.onlineDepositPercent ?? 30;
    const depositAmt = Math.ceil(totalAmount * pct / 100);

    if (mode === 'partial_online') {
        if (selectedPayMethod === 'partial_full') {
            btn.innerHTML = `<i class="fa-solid fa-lock"></i> Pay ${fmt(totalAmount)} &amp; Place Order`;
        } else {
            btn.innerHTML = `<i class="fa-solid fa-percent"></i> Pay ${fmt(depositAmt)} &amp; Confirm Order`;
        }
    } else if (mode === 'cod_only' || selectedPayMethod === 'COD') {
        btn.innerHTML = '<i class="fa-solid fa-box-open"></i> Place Order (COD)';
    } else if (selectedPayMethod === 'razorpay' || mode === 'online_only') {
        btn.innerHTML = `<i class="fa-solid fa-lock"></i> Pay ${fmt(totalAmount)} &amp; Place Order`;
    } else if (selectedPayMethod === 'partial') {
        btn.innerHTML = `<i class="fa-solid fa-percent"></i> Pay ${fmt(depositAmt)} &amp; Confirm Order`;
    } else if (selectedPayMethod === 'partial_full') {
        btn.innerHTML = `<i class="fa-solid fa-lock"></i> Pay ${fmt(totalAmount)} &amp; Place Order`;
    }
    btn.disabled = false;
}

/* ════ PROCESS CHECKOUT → PLACE ORDER ════
   Routes to COD (direct Firestore) or Razorpay based on selectedPayMethod.
   This replaces the old monolithic placeOrder() that was always Razorpay-only.
   ════════════════════════════════════════════════════════════════════════════════ */
window.placeOrder = async function() {
    const primary  = document.getElementById('coMobile')?.value;
    const alt      = document.getElementById('coAltMobile')?.value || '';
    const isPickup = selectedFulfillment === 'pickup';
    const address  = isPickup ? null : (userProfile.addresses||[])[selAddrIdx];

    if (!primary) { showToast('Please select a contact number.','error'); return; }
    if (!isPickup && !address) { showToast('Please select a delivery address.','error'); return; }

    const mode = effectivePayMode();

    // ── COD path: direct Firestore write, no Razorpay ──
    // Guard: COD is never allowed in partial_online or online_only
    if (mode === 'cod_only' || (selectedPayMethod === 'COD' && mode !== 'partial_online' && mode !== 'online_only')) {
        await placeOrderCOD({ primary, alt, address });
        return;
    }

    // ── Razorpay / partial path ──
    const btn = document.getElementById('placeOrderBtn');
    btn.disabled  = true;
    btn.innerHTML = '<span class="cart-spin"></span> Preparing Payment…';

    let couponRedeemedFor = null;   // groupOrderId to release if payment never completes
    let walletRedeemedFor = null;
    let paymentCaptured   = false;
    let placedOrders      = [];     // { id, shopId } — cancelled if payment is abandoned
    let rzpOpened         = false;

    try {
        const cart       = getCart();
        const items      = cart.filter(i => checkedIds.has(i.id));
        const checkoutId = genOrderId();

        /* ── Group items by shop & calculate totals ── */
        const groups = {};
        items.forEach(item => {
            const cat    = (item.category||'').toLowerCase();
            const shopId = selectedShops[cat] || 'unknown';
            const shop   = allShops.find(s => s.id === shopId);
            if (!groups[shopId]) groups[shopId] = { items:[], shopName: shop?.name||'Unknown', shopAddress: shop?.address||'', shopLocationLink: shop?.locationLink||'', subtotal:0, deliveryFee:0 };
            groups[shopId].items.push(item);
            groups[shopId].subtotal += item.price * item.qty;
        });
        Object.entries(groups).forEach(([shopId, grp]) => {
            if (isPickup) {
                grp.deliveryFee = 0;
            } else {
                const cat = (grp.items[0]?.category||'').toLowerCase();
                const fee = getDeliveryFee(cat, grp.subtotal);
                grp.deliveryFee = fee !== null ? fee : 0;
            }
        });
        await applyServerQuote(groups, checkoutId, isPickup);

        const groupList = Object.values(groups);
        const groupDiscounts = await redeemForOrder(groupList, checkoutId, 'online');
        if (appliedCoupon) couponRedeemedFor = checkoutId;
        const couponCode = appliedCoupon?.code || null;
        groupList.forEach((g, i) => { g.discount = groupDiscounts[i]; });

        const groupWallet = await redeemWalletForOrder(groupList, checkoutId, 'online');
        groupList.forEach((g, i) => { g.wallet = groupWallet[i]; });
        if (groupWallet.some(w => w > 0)) walletRedeemedFor = checkoutId;

        const grandTotal = groupList.reduce((sum, g) => sum + g.subtotal - g.discount - g.wallet + g.deliveryFee, 0);
        const uid        = currentUser?.uid || 'guest';

        const pct        = _payConfig?.onlineDepositPercent ?? 30;
        const depositAmt = Math.ceil(grandTotal * pct / 100);
        const balanceAmt = grandTotal - depositAmt;

        let chargeAmount, payMethod;
        if (selectedPayMethod === 'partial') {
            chargeAmount = depositAmt;
            payMethod    = 'partial';
        } else {
            chargeAmount = grandTotal;
            payMethod    = 'razorpay';
        }

        /* ── Write orders to Firestore (pre-payment) ── */
        const jasaOrderIds   = [];
        const firestoreWrites = [];
        Object.entries(groups).forEach(([shopId, grp]) => {
            const orderRef = doc(collection(db,'orders'));
            jasaOrderIds.push(orderRef.id);

            firestoreWrites.push(setDoc(orderRef, {
                userId:          uid,
                userName:        userProfile.fullName || 'Customer',
                groupOrderId:    checkoutId,
                type:            'product',
                shopId,
                shopName:        grp.shopName,
                shopAddress:     grp.shopAddress,
                shopLocationLink: grp.shopLocationLink,
                fulfillmentType:  isPickup ? 'pickup' : 'delivery',
                fulfillmentLabel: isPickup ? 'Pick Myself' : 'Delivery',
                isPickup:         isPickup,
                deliveryMode:     isPickup ? 'pickup' : 'delivery',
                items:           grp.items,
                subtotal:        grp.subtotal,
                deliveryFee:     grp.deliveryFee,
                couponCode,
                discountAmount:  grp.discount,
                walletAmount:    grp.wallet,
                totalAmount:     grp.subtotal - grp.discount - grp.wallet + grp.deliveryFee,
                deliveryAddress: isPickup ? null : address,
                contacts:        { mobile: primary, altMobile: alt },
                createdAt:       serverTimestamp(),
                paymentMethod:   payMethod,
                paymentStatus:   'pending',
                amountPaid:      0,
                balanceDue:      payMethod === 'partial' ? balanceAmt : 0,
                status:          'Pending',
            }));

            firestoreWrites.push(setDoc(doc(db,'order_status', orderRef.id), {
                status: 'Pending', paymentStatus: 'pending',
                userId: uid, shopId,
                updatedAt: serverTimestamp(), lastUpdatedBy: 'user',
            }));

            if (allShops.some(s => s.id === shopId)) {
                updateDoc(doc(db,'shops',shopId), { newOrdersCount: increment(1) }).catch(() => {});
            }
        });
        await Promise.all(firestoreWrites);
        placedOrders = jasaOrderIds.map((id, i) => ({ id, shopId: Object.keys(groups)[i] }));

        /* ── Create Razorpay order via Node backend ── */
        const serverBase = window.__JASA_SERVER || PAYMENT_SERVER_URL;
        let idToken = '';
        try { idToken = await currentUser.getIdToken(); } catch (e) { console.warn('[cart] ID token:', e.message); }

        const createRes = await fetch(`${serverBase}/api/payment/create-order`, {
            method:  'POST',
            headers: {
                'Content-Type':    'application/json',
                'Authorization':   idToken ? `Bearer ${idToken}` : '',
                'x-server-secret': window.__JASA_SERVER_SECRET || '',
            },
            body: JSON.stringify({
                jasaOrderIds, groupOrderId: checkoutId,
                amount: chargeAmount,
                userId: uid, userEmail: currentUser?.email || '',
                userName: userProfile.fullName || 'Customer',
            }),
        });

        if (!createRes.ok) {
            const err = await createRes.json().catch(()=>({}));
            const msg = err.error || `Payment server error (${createRes.status})`;
            throw new Error(msg.includes('not configured')
                ? 'Online payment is not available yet. Please try again later.'
                : msg);
        }

        const { razorpayOrderId, amount: rzpAmount, currency, keyId } = await createRes.json();

        /* ── Open Razorpay modal ── */
        btn.innerHTML = '<span class="cart-spin"></span> Opening Payment…';

        await new Promise((resolve, reject) => {
            const options = {
                key: keyId, amount: rzpAmount, currency,
                name:        'JASA Essential',
                description: payMethod === 'partial'
                    ? `Deposit ${pct}% — Order ${checkoutId}`
                    : `Order ${checkoutId}`,
                order_id: razorpayOrderId,
                prefill: {
                    name:    userProfile.fullName || 'Customer',
                    email:   currentUser?.email   || '',
                    contact: primary,
                },
                theme: { color: '#2D8CF0' },

                handler: async function(response) {
                    paymentCaptured = true;
                    btn.innerHTML = '<span class="cart-spin"></span> Verifying Payment…';
                    try {
                        const verifyRes = await fetch(`${serverBase}/api/payment/verify`, {
                            method:  'POST',
                            headers: {
                                'Content-Type':    'application/json',
                                'Authorization':   idToken ? `Bearer ${idToken}` : '',
                                'x-server-secret': window.__JASA_SERVER_SECRET || '',
                            },
                            body: JSON.stringify({
                                razorpay_order_id:   response.razorpay_order_id,
                                razorpay_payment_id: response.razorpay_payment_id,
                                razorpay_signature:  response.razorpay_signature,
                                jasaOrder: {
                                    userId:          uid,
                                    userName:        userProfile.fullName || 'Customer',
                                    groupOrderId:    checkoutId,
                                    shopGroups:      Object.entries(groups).map(([shopId, grp]) => ({
                                        shopId,
                                        shopName:    grp.shopName,
                                        items:       grp.items,
                                        subtotal:    grp.subtotal,
                                        deliveryFee: grp.deliveryFee,
                                    })),
                                    subtotal:        Object.values(groups).reduce((s,g) => s + g.subtotal, 0),
                                    deliveryFee:     Object.values(groups).reduce((s,g) => s + g.deliveryFee, 0),
                                    couponCode,
                                    discountAmount:  Object.values(groups).reduce((s,g) => s + g.discount, 0),
                                    walletAmount:    Object.values(groups).reduce((s,g) => s + g.wallet, 0),
                                    totalAmount:     grandTotal,
                                    deliveryAddress: address,
                                    contacts:        { mobile: primary, altMobile: alt },
                                },
                            }),
                        });

                        if (!verifyRes.ok) {
                            const err = await verifyRes.json().catch(()=>({}));
                            throw new Error(err.error || 'Payment verification failed');
                        }

                        // /api/payment/verify has already stamped paymentStatus, amountPaid and
                        // balanceDue on every order (customers may not write those fields)

                        const remaining = cart.filter(i => !checkedIds.has(i.id));
                        localStorage.setItem(CART_KEY, JSON.stringify(remaining));
                        window.dispatchEvent(new CustomEvent('cartUpdated'));
                        closeCheckoutSheet();
                        showToast(`Payment confirmed! Order ${checkoutId} placed.`, 'success');
                        setTimeout(() => window.location.href = 'orders.html', 1800);
                        resolve();
                    } catch(verifyErr) {
                        console.error('Verify error:', verifyErr);
                        showToast('Payment done but verification failed. Contact support.', 'error');
                        reject(verifyErr);
                    }
                },

                modal: {
                    ondismiss: function() {
                        if (!paymentCaptured) cancelUnpaidOrders(placedOrders);
                        showToast('Payment cancelled.', 'error');
                        btn.disabled = false;
                        renderPaymentOptions();
                        reject(new Error('dismissed'));
                    }
                },
            };

            const rzp = new window.Razorpay(options);
            rzp.on('payment.failed', function(response) {
                console.error('[Razorpay] Payment failed:', response.error);
                showToast(`Payment failed: ${response.error.description}`, 'error');
                btn.disabled = false;
                renderPaymentOptions();
                reject(new Error(response.error.description));
            });
            rzpOpened = true;
            rzp.open();
        });

    } catch(e) {
        if (!rzpOpened && placedOrders.length) await cancelUnpaidOrders(placedOrders);
        if (couponRedeemedFor && !paymentCaptured) await releaseCoupon(currentUser, couponRedeemedFor);
        if (walletRedeemedFor && !paymentCaptured) await releaseWallet(currentUser, walletRedeemedFor);
        if (e.message !== 'dismissed') {
            console.error('Order/payment failed:', e);
            showToast(e.message || 'Payment failed. Please try again.', 'error');
        }
        const btn2 = document.getElementById('placeOrderBtn');
        if (btn2) { btn2.disabled = false; renderPaymentOptions(); }
    }
};

/* ════ PLACE ORDER — COD PATH ════
   Writes orders directly to Firestore (no Razorpay).
   Mirrors the xerox placeOrder() COD flow.
   ════════════════════════════════ */
async function placeOrderCOD({ primary, alt, address }) {
    if (!currentUser) {
        showToast('Please sign in to place an order.', 'error');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }

    const btn = document.getElementById('placeOrderBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="cart-spin"></span> Placing Order…'; }

    let couponRedeemedFor = null;
    let walletRedeemedFor = null;

    try {
        const cart       = getCart();
        const items      = cart.filter(i => checkedIds.has(i.id));
        const checkoutId = genOrderId();
        const uid        = currentUser.uid;
        const isPickup   = selectedFulfillment === 'pickup';

        /* Group items by shop */
        const groups = {};
        items.forEach(item => {
            const cat    = (item.category||'').toLowerCase();
            const shopId = selectedShops[cat] || 'unknown';
            const shop   = allShops.find(s => s.id === shopId);
            if (!groups[shopId]) groups[shopId] = { items:[], shopName: shop?.name||'Unknown', shopAddress: shop?.address||'', shopLocationLink: shop?.locationLink||'', subtotal:0, deliveryFee:0 };
            groups[shopId].items.push(item);
            groups[shopId].subtotal += item.price * item.qty;
        });
        Object.entries(groups).forEach(([shopId, grp]) => {
            if (isPickup) {
                grp.deliveryFee = 0;
            } else {
                const cat = (grp.items[0]?.category||'').toLowerCase();
                const fee = getDeliveryFee(cat, grp.subtotal);
                grp.deliveryFee = fee !== null ? fee : 0;
            }
        });
        await applyServerQuote(groups, checkoutId, isPickup);

        const groupList = Object.values(groups);
        const groupDiscounts = await redeemForOrder(groupList, checkoutId, 'cod');
        if (appliedCoupon) couponRedeemedFor = checkoutId;
        const couponCode = appliedCoupon?.code || null;
        groupList.forEach((g, i) => { g.discount = groupDiscounts[i]; });

        const groupWallet = await redeemWalletForOrder(groupList, checkoutId, 'cod');
        groupList.forEach((g, i) => { g.wallet = groupWallet[i]; });
        if (groupWallet.some(w => w > 0)) walletRedeemedFor = checkoutId;

        /* Write one order doc per shop */
        const writes = [];
        Object.entries(groups).forEach(([shopId, grp]) => {
            const orderRef   = doc(collection(db,'orders'));
            const orderTotal = grp.subtotal - grp.discount - grp.wallet + grp.deliveryFee;

            writes.push(setDoc(orderRef, {
                userId:          uid,
                userName:        userProfile.fullName || 'Customer',
                groupOrderId:    checkoutId,
                type:            'product',
                shopId,
                shopName:        grp.shopName,
                shopAddress:     grp.shopAddress,
                shopLocationLink: grp.shopLocationLink,
                fulfillmentType:  isPickup ? 'pickup' : 'delivery',
                fulfillmentLabel: isPickup ? 'Pick Myself' : 'Delivery',
                isPickup:         isPickup,
                deliveryMode:     isPickup ? 'pickup' : 'delivery',
                items:           grp.items,
                subtotal:        grp.subtotal,
                deliveryFee:     grp.deliveryFee,
                couponCode,
                discountAmount:  grp.discount,
                walletAmount:    grp.wallet,
                totalAmount:     orderTotal,
                deliveryAddress: isPickup ? null : address,
                contacts:        { mobile: primary, altMobile: alt },
                createdAt:       serverTimestamp(),
                paymentMethod:   'COD',
                paymentStatus:   'cod',
                amountPaid:      0,
                balanceDue:      orderTotal,
                status:          'Pending',
            }));

            writes.push(setDoc(doc(db,'order_status', orderRef.id), {
                status: 'Pending', paymentStatus: 'pending',
                userId: uid, shopId,
                updatedAt: serverTimestamp(), lastUpdatedBy: 'user',
            }));

            if (allShops.some(s => s.id === shopId)) {
                updateDoc(doc(db,'shops',shopId), { newOrdersCount: increment(1) }).catch(() => {});
            }
        });

        await Promise.all(writes);

        const remaining = cart.filter(i => !checkedIds.has(i.id));
        localStorage.setItem(CART_KEY, JSON.stringify(remaining));
        window.dispatchEvent(new CustomEvent('cartUpdated'));
        closeCheckoutSheet();
        showToast(`Order ${checkoutId} placed successfully!`, 'success');
        setTimeout(() => window.location.href = 'orders.html', 1600);

    } catch(e) {
        console.error('[cart] COD order failed:', e);
        if (couponRedeemedFor) await releaseCoupon(currentUser, couponRedeemedFor);
        if (walletRedeemedFor) await releaseWallet(currentUser, walletRedeemedFor);
        showToast(e.isCoupon || e.isWallet || e.isQuote ? e.message : 'Order failed. Please try again.', 'error');
        const btn2 = document.getElementById('placeOrderBtn');
        if (btn2) { btn2.disabled = false; renderPaymentOptions(); }
    }
}


function genOrderId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let r = '';
    for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random()*chars.length)];
    return `JASA-${r}`;
}

/* ════ CONFIRM DIALOG ════ */
function showConfirm(title, msg) {
    return new Promise(resolve => {
        const ov  = document.getElementById('confirmOverlay');
        const yes = document.getElementById('confirmYes');
        const no  = document.getElementById('confirmNo');
        setText('confirmTitle', title);
        setText('confirmMsg', msg);
        ov.classList.add('active');
        const cleanup = (v) => { ov.classList.remove('active'); yes.onclick=null; no.onclick=null; resolve(v); };
        yes.onclick = () => cleanup(true);
        no.onclick  = () => cleanup(false);
        ov.addEventListener('click', e => { if(e.target===ov) cleanup(false); }, { once:true });
    });
}

/* ════ SHEET HELPERS ════ */
function openSheet(bdId, sheetId) {
    document.getElementById(bdId)?.classList.add('show');
    requestAnimationFrame(() => document.getElementById(sheetId)?.classList.add('open'));
}
function closeSheet(bdId, sheetId) {
    document.getElementById(sheetId)?.classList.remove('open');
    document.getElementById(bdId)?.classList.remove('show');
}

/* ════ TOAST ════ */
let toastTimer;
function showToast(msg, type='success') {
    const el = document.getElementById('cartToast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.className   = `cat-toast ${type}`;
    el.classList.add('show');
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ════ UTIL ════ */
function setText(id, val) { const el=document.getElementById(id); if(el) el.textContent=val; }
