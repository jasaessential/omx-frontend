/* ═══════════════════════════════════════════════
   JASA V2 — xerox-order.js
   Xerox ordering flow:
     1. Upload files (PDF/image) → PDF.js page count
     2. Configure per-doc: paper, color, format,
        ratio, binding, lamination, quantity
     3. Upload to R2 (signed URL) or mark later/whatsapp
     4. Select shop → delivery fee calculation
     5. Checkout: contact + address → place order
   Firebase collections: orders, order_status, shops
   ═══════════════════════════════════════════════ */

import { auth, db } from './firebase-init.js';
import { WORKER_URL, PAYMENT_SERVER_URL, initAppConfig } from './env-config.js';
import { getUploadTarget } from './secure-files.js';
import {
    collection, getDocs, doc, getDoc, setDoc,
    updateDoc, serverTimestamp, increment, query, where
} from "./cf-firestore.js";
import { onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { createMapPicker, getCurrentPosition, haversineKm, hasCoords, shopCoords, APPROX_LOCATION_M } from './geo-map.js';
import { quoteOrder, priceChanged, cancelUnpaidOrders } from './order-quote-client.js';
import { validateCoupon, redeemCoupon, releaseCoupon, calcDiscount }
    from './coupon-client.js';
import { loadWalletConfig, loadWalletBalance, computeWalletUse, walletBlockReason,
         redeemWallet, releaseWallet, syncWallet, inr }
    from './wallet-client.js';

/* ════ STATE ════ */
let uploadedFiles  = [];   // { id, fileObj, name, type, pages, config, prices, uploadStatus, uploadedUrl, xhr, uploadProgress, uploadSpeed, uploadETA }
let xeroxConfig    = { paper: [], binding: [], lamination: [] };
let allShops       = [];   // location-filtered, used by main page
let allShopsRaw    = [];   // all xerox shops unfiltered, used by step-4 picker
let allShopsAll    = [];   // every active shop (any service) — only used to find the default shop
let selectedShopId = null;
let userProfile    = { fullName: '', mobileNumber: '', altMobiles: [], addresses: [] };
let selAddrIdx     = 0;
let currentUser    = null;

/* ════ COUPON ════
   appliedCoupon = { code, name, type, value, maxDiscount, minOrderAmount }
   Not allowed on orders with a manual estimate (final price unknown).
   The server re-validates on redeem; this only drives live totals.        */
let appliedCoupon = null;

function xeroxCouponBase() {
    calculatePrices();
    let subtotal = 0, hasEstimate = false;
    uploadedFiles.forEach(f => {
        if (f.config.colorMode === 'custom') hasEstimate = true;
        else subtotal += f.prices.final;
    });
    return { subtotal, hasEstimate };
}

function xeroxCouponDiscount() {
    if (!appliedCoupon) return 0;
    const { subtotal, hasEstimate } = xeroxCouponBase();
    return hasEstimate ? 0 : calcDiscount(appliedCoupon, subtotal);
}

function renderCouponBox() {
    const entry   = document.getElementById('couponEntry');
    const applied = document.getElementById('couponApplied');
    if (!entry || !applied) return;
    entry.style.display   = appliedCoupon ? 'none' : 'flex';
    applied.style.display = appliedCoupon ? 'flex' : 'none';
    if (!appliedCoupon) return;

    const { subtotal, hasEstimate } = xeroxCouponBase();
    const disc = xeroxCouponDiscount();
    const msg = document.getElementById('couponAppliedMsg');
    const code = document.getElementById('couponAppliedCode');
    if (code) code.textContent = appliedCoupon.code;
    if (msg) msg.textContent = hasEstimate
        ? 'Not applicable on orders needing a manual estimate'
        : disc > 0
            ? `You save ₹${disc.toFixed(2)}`
            : `Add ₹${Math.max(0, appliedCoupon.minOrderAmount - subtotal).toFixed(2)} more to use this coupon`;
}

function setCouponError(msg) {
    const el = document.getElementById('couponErr');
    if (el) el.textContent = msg || '';
}

function refreshCheckoutTotals() {
    renderCheckoutSummary();
    renderPaymentOptions();
}

window.applyCoupon = async function() {
    const input = document.getElementById('couponInput');
    const btn   = document.getElementById('couponApplyBtn');
    const code  = (input?.value || '').trim().toUpperCase();
    if (!code) { setCouponError('Enter a coupon code.'); return; }
    if (!currentUser) { setCouponError('Please sign in to use a coupon.'); return; }

    const { subtotal, hasEstimate } = xeroxCouponBase();
    if (hasEstimate) { setCouponError('Coupons cannot be used on orders that need a manual estimate.'); return; }
    if (!subtotal) { setCouponError('Add a document first.'); return; }

    setCouponError('');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
        const res = await validateCoupon(currentUser, {
            code, subtotal, orderType: 'xerox', shopIds: selectedShopId ? [selectedShopId] : [],
        });
        appliedCoupon = {
            code: res.code, name: res.name, type: res.type, value: res.value,
            maxDiscount: res.maxDiscount, minOrderAmount: res.minOrderAmount,
        };
        if (input) input.value = '';
        showToast(`Coupon ${res.code} applied!`, 'success');
        refreshCheckoutTotals();
    } catch (e) {
        setCouponError(e.message);
    } finally {
        btn.disabled = false; btn.textContent = 'Apply';
    }
};

window.removeCoupon = function() {
    appliedCoupon = null;
    setCouponError('');
    refreshCheckoutTotals();
};

/* Redeem on the server right before writing the order. Returns the discount.
   On failure the coupon is dropped from the UI and the error is tagged.    */
async function redeemForOrder(subtotal, groupOrderId, paymentMode = 'cod') {
    if (!appliedCoupon) return 0;
    if (xeroxCouponBase().hasEstimate) {
        appliedCoupon = null;
        refreshCheckoutTotals();
        const err = new Error('Coupons cannot be used on orders that need a manual estimate.');
        err.isCoupon = true;
        throw err;
    }
    try {
        const r = await redeemCoupon(currentUser, {
            code: appliedCoupon.code, groupOrderId, subtotal,
            orderType: 'xerox', shopIds: selectedShopId ? [selectedShopId] : [], paymentMode,
        });
        return r.discount;
    } catch (e) {
        appliedCoupon = null;
        refreshCheckoutTotals();
        e.isCoupon = true;
        throw e;
    }
}

/* ════ WALLET ════
   Same model as the cart: walletCfg = config/wallet, walletBalance = wallets/{uid}.
   Not usable on orders that need a manual estimate (final price unknown).
   The server re-checks every limit in /api/wallet/redeem.                     */
let walletCfg     = null;
let walletBalance = 0;
let useWallet     = true;

const walletUseFor = gross =>
    (useWallet && !xeroxCouponBase().hasEstimate) ? computeWalletUse(walletCfg, walletBalance, gross, 'xerox') : 0;

async function loadWalletState() {
    if (!currentUser) return;
    [walletCfg, walletBalance] = await Promise.all([loadWalletConfig(), loadWalletBalance(currentUser)]);
}

function renderWalletBlock(gross, hasEstimate) {
    const el = document.getElementById('coWalletBlock');
    if (!el) return;
    if (!currentUser || !walletCfg?.enabled || !walletCfg.applyToXerox) { el.style.display = 'none'; el.innerHTML = ''; return; }

    const reason = hasEstimate
        ? 'Wallet cannot be used on orders that need a manual estimate.'
        : walletBlockReason(walletCfg, walletBalance, gross, 'xerox');
    const canUse = !reason;
    const use    = canUse ? computeWalletUse(walletCfg, walletBalance, gross, 'xerox') : 0;
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
    refreshCheckoutTotals();
};

/* Reserve wallet money on the server right before writing the order (call AFTER the coupon).
   Returns the amount actually reserved (0 when the wallet is off / not applicable). */
async function redeemWalletForOrder(gross, groupOrderId, paymentMode) {
    if (walletUseFor(gross) <= 0) return 0;
    try {
        const r = await redeemWallet(currentUser, { groupOrderId, orderTotal: gross, orderType: 'xerox', paymentMode });
        return r.amount;
    } catch (e) {
        useWallet = false;
        loadWalletState().then(() => refreshCheckoutTotals());
        e.isWallet = true;
        throw e;
    }
}

/* ════ LOCATION STATE ════ */
let allStates         = [];
let allDistricts      = [];
let allCities         = [];
let selectedStateId    = null;
let selectedDistrictId = null;
let selectedCityId    = null;
let selectedOrderType = null;
let selectedPlaceType = null;
let selectedPickerShopId = null;   // shop chosen in the picker (step 4)
let landingShopTypeFilter = 'all'; // 'all' | 'shop' | 'college'  — landing filter bar
let isOthersState     = false;     // true when user selected "Others" at state level
let isOthersDistrict  = false;     // true when user selected "Others" at district level
let isOthersCity      = false;     // true when user selected "Others" at city level
let othersFastPath    = false;     // true when "Others" skipped steps 2-4 (no shops assigned to it)
let _wizardShopsReady = null;      // promise for the wizard's initial fetchShops()
let _xeroxCfgReady    = null;      // promise for the wizard's initial fetchXeroxConfig()
let otherShopsConfig  = null;      // { stationary, books, xerox, kits } — admin-set fallback shops
const LOCATION_KEY    = 'jasa_xerox_location_v3';
const PIN_KEY         = 'jasa_xerox_pin_v1';

/* ════ MAP PIN ════
   The customer's pinned position (GPS or map). With a pin: shops that have coordinates
   are sorted nearest-first and show their distance; delivery is limited to each shop's
   radius. With a pin and no state picked, only shops whose radius covers the pin are listed. */
/* A saved pin is only trusted for PIN_MAX_AGE_MS: an old pin (another day, another
   place) silently used as the origin made every distance wrong. Pins saved before
   this change have no `at` and are dropped. */
const PIN_MAX_AGE_MS = 12 * 60 * 60 * 1000;
let userPin = null;
try {
    const p = JSON.parse(localStorage.getItem(PIN_KEY) || 'null');
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.at) && Date.now() - p.at < PIN_MAX_AGE_MS) {
        userPin = { lat: p.lat, lng: p.lng };
    } else if (p) {
        localStorage.removeItem(PIN_KEY);
    }
} catch (_) {}
let locMapCtl = null;                 // map picker controller (step 1)
/* True once the pin was set during this page visit (GPS, map tap, drag or search).
   A pin restored from localStorage is not "fresh": opening the map then asks the
   device for the current position instead of showing that old spot. */
let pinFreshThisVisit = false;
let _locating = false;
const shopDistKm = new Map();         // shopId -> km from the pin (kept out of the shop objects/caches)
const DEFAULT_RADIUS_KM = 10;         // a shop's delivery radius when the admin set none
const NEARBY_RADIUS_KM  = 15;         // shops further than this from the customer are not "nearby" (pickup)
const MAX_SHOPS_LISTED  = 10;         // the shop step lists at most this many (nearest first)
/* Shown when no shop is nearby or the customer's location is unknown. There is no
   id/flag for it in the shop data, so it is found by name (case/space-insensitive),
   then by the admin's "Others" fallback xerox shop (KV other-shops config). */
const DEFAULT_SHOP_NAME = 'OrderMyXerox India';
const shopRadius = s => Number(s.serviceRadiusKm) > 0 ? Number(s.serviceRadiusKm) : DEFAULT_RADIUS_KM;
/* km from the customer's pin to a shop, or null (no pin / shop not pinned) */
const kmToShop = s => { const c = userPin && shopCoords(s); return c ? haversineKm(userPin, c) : null; };

/* ════ PAYMENT CONFIG STATE ════ */
// Fetched fresh from KV on every checkout open — no localStorage cache.
// selectedPayMethod: 'COD' | 'razorpay' | 'partial' | 'partial_full'
//   partial_full = user tapped "pay full" link inside the partial card
let _payConfig         = null;  // { mode, onlineDepositPercent, applyToXerox }
let selectedPayMethod  = 'COD'; // default until config is loaded

/* Fetch other-shops (fallback) config from KV — used when user picks "Others" */
async function fetchOtherShopsConfig() {
    try {
        const res = await fetch(`${WORKER_URL}/api/config/other-shops`, {
            signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
            const json = await res.json();
            otherShopsConfig = json;
        }
    } catch (_) { /* non-fatal */ }
}

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
    // Safe default: show both options so checkout is never blocked
    _payConfig = { mode: 'both', onlineDepositPercent: 30, applyToXerox: true };
    return _payConfig;
}

/* Effective mode for xerox — if applyToXerox is false, always COD */
function effectivePayMode() {
    if (!_payConfig) return 'cod_only';
    if (_payConfig.applyToXerox === false) return 'cod_only';
    return _payConfig.mode || 'both';
}

/* ════ AUTH ════ */
onAuthStateChanged(auth, user => {
    currentUser = user;
    if (user) syncWallet(user).then(r => { if (r) walletBalance = r.balance; });
    if (user) {
        const raw = localStorage.getItem('jasa_user_cache');
        if (raw) { try { Object.assign(userProfile, JSON.parse(raw)); } catch(_){} }
    }
});

/* ════ INIT ════ */
document.addEventListener('DOMContentLoaded', async () => {
    initLocationPicker();
});

/* ════ LOCATION PICKER ════ */
async function initLocationPicker() {
    /* Check if user already confirmed location + order type this session */
    try {
        const saved = localStorage.getItem(LOCATION_KEY);
        if (saved) {
            const { stateId, districtId, cityId, orderType, placeType, shopId, othersState, othersDistrict, othersCity } = JSON.parse(saved);
            if ((stateId || userPin) && orderType && placeType && shopId) {
                selectedStateId      = stateId || null;
                selectedDistrictId   = districtId || null;
                selectedCityId       = cityId || null;
                selectedOrderType    = orderType;
                selectedPlaceType    = placeType;
                selectedPickerShopId = shopId;
                isOthersState        = !!othersState;
                isOthersDistrict     = !!othersDistrict;
                isOthersCity         = !!othersCity;
                hideLocationOverlay();
                await initMainPage();
                return;
            }
        }
    } catch (_) {}

    /* Show in-page picker, hide landing + config content */
    document.getElementById('xoLocationOverlay').style.display  = 'block';
    document.getElementById('xoLanding').style.display          = 'none';
    document.getElementById('xoConfigSection').style.display    = 'none';
    document.getElementById('xoAddMoreBtn').style.display       = 'none';

    /* Pre-fetch shops and xerox config in the background while the user
       fills in steps 1-3, so allShops is ready when step 4 is shown.
       Both calls are fire-and-forget here — errors are handled inside them. */
    _xeroxCfgReady    = fetchXeroxConfig();
    _wizardShopsReady = fetchShops();
    fetchOtherShopsConfig();

    /* Upload comes first: the customer adds documents and sets print options,
       then gives the location and picks the shop last. */
    showWizardStep('upload');
    _xeroxCfgReady.then(() => { if (_inStep5()) renderStep5(); });

    /* Fetch locations: worker edge cache first, Firestore fallback */
    try {
        await loadLocationOptions();
    } catch (err) {
        console.error('[Location] fetch failed:', err);
        hideLocationOverlay();
        await initMainPage();
    }
}

/* State / district / city lists for the location step (worker edge cache first,
   Firestore fallback). Throws when neither answers. */
async function loadLocationOptions() {
    let locationsLoaded = false;

    /* 1. Try Cloudflare Worker edge cache */
    try {
        const res = await fetch(`${WORKER_URL}/api/locations/all`, {
            signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
            const json = await res.json();
            if (json.states?.length) {
                allStates    = [...json.states]          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                allDistricts = [...(json.districts || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                allCities    = [...(json.cities || [])]   .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                locationsLoaded = true;
            }
        }
    } catch (_) { /* worker unavailable — fall through */ }

    /* 2. Firestore fallback */
    if (!locationsLoaded) {
        const [statesSnap, districtsSnap, citiesSnap] = await Promise.all([
            getDocs(collection(db, 'states')),
            getDocs(collection(db, 'districts')),
            getDocs(collection(db, 'cities'))
        ]);
        allStates    = statesSnap.docs   .map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        allDistricts = districtsSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        allCities    = citiesSnap.docs   .map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    const stateSelect = document.getElementById('xoStateSelect');
    stateSelect.innerHTML =
        '<option value="">— Select your state —</option>' +
        allStates.map(s => `<option value="${h(s.id)}">${h(s.name)}</option>`).join('') +
        '<option value="__others__">Others</option>';

    if (!stateSelect._wired) {
        stateSelect._wired = true;
        stateSelect.addEventListener('change', onStateChange);
    }
}

/* ── Step 1 map: GPS button + draggable/zoomable map ── */
function paintPinText() {
    const el = document.getElementById('xoPinText');
    if (!el) return;
    if (!userPin) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = 'flex';
    el.innerHTML = `<i class="fa-solid fa-location-dot"></i> Location pinned (${userPin.lat.toFixed(4)}, ${userPin.lng.toFixed(4)}) <button type="button" onclick="clearPin()">Clear</button>`;
}

function setPin(p) {
    userPin = { lat: Math.round(p.lat * 1e5) / 1e5, lng: Math.round(p.lng * 1e5) / 1e5 };
    pinFreshThisVisit = true;
    try { localStorage.setItem(PIN_KEY, JSON.stringify({ ...userPin, at: Date.now() })); } catch (_) {}
    paintPinText();
    refreshStep1();
}

window.clearPin = function() { clearPin(false); };
function clearPin(silent) {
    userPin = null;
    try { localStorage.removeItem(PIN_KEY); } catch (_) {}
    shopDistKm.clear();
    locMapCtl?.setValue(null);
    paintPinText();
    if (!silent) refreshStep1();
}

window.useMyLocation = async function() {
    const btn = document.getElementById('xoUseGpsBtn');
    if (btn) btn.disabled = true;
    _locating = true;
    try {
        const p = await getCurrentPosition();
        setPin(p);
        locMapCtl?.setValue(userPin, 17);
        /* Wi-Fi / IP based fixes (most laptops) can be kilometres off — that made
           shop distances look wrong. Ask the customer to fix the pin on the map. */
        if (p.accuracy > APPROX_LOCATION_M) {
            showToast(`Your device gave only a rough location (within about ${(p.accuracy / 1000).toFixed(1)} km). Drag the pin to your exact spot for correct distances.`, 'warning');
            const host = document.getElementById('xoMapHost');
            if (host && host.style.display === 'none') window.toggleLocationMap();
        }
    } catch (e) {
        showToast(e.message || 'Could not get your location.', 'error');
        const host = document.getElementById('xoMapHost');
        if (host && host.style.display === 'none') window.toggleLocationMap();   // fall back to picking on the map
    } finally {
        _locating = false;
        if (btn) btn.disabled = false;
    }
};

/* Opening the map: get the device's current position rather than showing a pin
   saved on an earlier visit. Quiet on failure (the saved pin, if any, stays and
   the customer can tap the map). A tap/drag made while waiting wins over GPS. */
async function refreshPinOnMapOpen() {
    if (pinFreshThisVisit || _locating) return;
    _locating = true;
    try {
        const p = await getCurrentPosition();
        if (pinFreshThisVisit) return;
        setPin(p);
        locMapCtl?.setValue(userPin, 17);
        if (p.accuracy > APPROX_LOCATION_M) {
            showToast(`Your device gave only a rough location (within about ${(p.accuracy / 1000).toFixed(1)} km). Drag the pin to your exact spot for correct distances.`, 'warning');
        }
    } catch (_) { /* permission denied / no fix: keep the map as it is */ }
    finally { _locating = false; }
}

window.toggleLocationMap = async function() {
    const host = document.getElementById('xoMapHost');
    const lbl  = document.getElementById('xoToggleMapLbl');
    if (!host) return;
    const open = host.style.display === 'none';
    host.style.display = open ? 'block' : 'none';
    if (lbl) lbl.textContent = open ? 'Hide map' : (userPin ? 'Change on map' : 'Pick on map');
    if (!open) return;
    if (!locMapCtl) {
        locMapCtl = await createMapPicker(host, {
            value: userPin,
            height: 280,
            onChange: p => setPin(p)
        });
    } else {
        locMapCtl.invalidate();
    }
    /* show the xerox shops that have a pin, so customers can see what is around */
    locMapCtl.setShops(allShopsRaw.filter(s => hasCoords(s)));
    refreshPinOnMapOpen();
};

document.addEventListener('DOMContentLoaded', () => { paintPinText(); if (userPin) refreshStep1(); });

/* Step 1 now holds location + shop type + delivery/pickup (old steps 2 & 3).
   Reveal the preference cards once a location is complete and gate the Next button. */
function hasCompleteLocation() {
    if (!selectedStateId && userPin) return true;   // map-only location
    return !!(selectedStateId && (
        isOthersState ||
        (selectedDistrictId && (isOthersDistrict || selectedCityId))
    ));
}
function refreshStep1() {
    const prefs = document.getElementById('xoStep1Prefs');
    const btn   = document.getElementById('xoLocationConfirmBtn');
    const ok    = hasCompleteLocation();
    const anyOthers = isOthersState || isOthersDistrict || isOthersCity;
    if (prefs) prefs.style.display = ok ? 'block' : 'none';
    /* "Others" may take the fast path, so it only needs the location.
       The button stays clickable so a click explains what is missing. */
    setSoftDisabled(btn, !(ok && (anyOthers || (selectedPlaceType && selectedOrderType))));
    updateWizardStepCounts();
}

/* A "not ready yet" look for a button that stays clickable — clicking it runs the
   validation, which shows a toast and points at the missing field. */
function setSoftDisabled(btn, pending) {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.toggle('xo-btn-pending', !!pending);
}

/* Validation feedback: toast + scroll to + highlight the field (and focus it if it can take focus). */
function flagField(el, msg, type = 'warning') {
    if (msg) showToast(msg, type);
    if (!el) return;
    el.classList.remove('xo-field-error');
    void el.offsetWidth;                       /* restart the shake animation */
    el.classList.add('xo-field-error');
    setTimeout(() => el.classList.remove('xo-field-error'), 2200);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusable = el.matches('select, input, button, textarea') ? el : el.querySelector('select:not([disabled]), input:not([type=hidden]):not([disabled])');
    if (focusable && focusable.offsetParent !== null) { try { focusable.focus({ preventScroll: true }); } catch (_) {} }
}

function onStateChange() {
    const stateId        = document.getElementById('xoStateSelect').value;
    const districtField  = document.getElementById('xoDistrictField');
    const districtSelect = document.getElementById('xoDistrictSelect');
    const cityField      = document.getElementById('xoCityField');
    const confirmBtn     = document.getElementById('xoLocationConfirmBtn');

    /* Reset downstream state */
    selectedDistrictId = null;
    selectedCityId     = null;
    isOthersState      = false;
    isOthersDistrict   = false;
    isOthersCity       = false;
    setSoftDisabled(confirmBtn, true);
    cityField.style.display     = 'none';
    districtField.style.display = 'none';
    refreshStep1();

    if (!stateId) {
        selectedStateId = null;
        return;
    }

    /* ── "Others" at state level → skip straight to file upload ── */
    if (stateId === '__others__') {
        selectedStateId    = '__others__';
        isOthersState      = true;
        refreshStep1();
        return;
    }

    selectedStateId = stateId;

    const districts = allDistricts.filter(d => d.stateId === stateId);
    districtSelect.innerHTML =
        '<option value="">— Select your district —</option>' +
        districts.map(d => `<option value="${d.id}">${d.name}</option>`).join('') +
        '<option value="__others__">Others</option>';

    districtField.style.display = 'block';
    districtSelect.onchange = onDistrictChange;
}

function onDistrictChange() {
    const districtId  = document.getElementById('xoDistrictSelect').value;
    const cityField   = document.getElementById('xoCityField');
    const citySelect  = document.getElementById('xoCitySelect');
    const confirmBtn  = document.getElementById('xoLocationConfirmBtn');

    isOthersCity = false;
    cityField.style.display = 'none';
    selectedCityId = null;
    setSoftDisabled(confirmBtn, true);
    refreshStep1();

    if (!districtId) {
        selectedDistrictId = null;
        isOthersDistrict   = false;
        return;
    }

    /* ── "Others" at district level → skip city, enable Next straight away ── */
    if (districtId === '__others__') {
        selectedDistrictId = '__others__';
        isOthersDistrict   = true;
        refreshStep1();
        return;
    }

    isOthersDistrict   = false;
    selectedDistrictId = districtId;

    const cities = allCities.filter(c => c.districtId === districtId);
    citySelect.innerHTML =
        '<option value="">— Select your city —</option>' +
        cities.map(c => `<option value="${c.id}">${c.name}</option>`).join('') +
        '<option value="__others__">Others</option>';

    cityField.style.display = 'block';

    citySelect.onchange = () => {
        if (citySelect.value === '__others__') {
            selectedCityId  = '__others__';
            isOthersCity    = true;
        } else {
            selectedCityId  = citySelect.value || null;
            isOthersCity    = false;
        }
        refreshStep1();
    };
}

/* Helper to safely extract location array/string/object values into flat lowercase string array */
function extractLocationValues(val) {
    if (!val) return [];
    if (Array.isArray(val)) {
        const res = [];
        for (const item of val) {
            if (typeof item === 'string' || typeof item === 'number') {
                res.push(String(item).trim().toLowerCase());
            } else if (item && typeof item === 'object') {
                if (item.id) res.push(String(item.id).trim().toLowerCase());
                if (item.name) res.push(String(item.name).trim().toLowerCase());
                if (item.value) res.push(String(item.value).trim().toLowerCase());
            }
        }
        return res;
    }
    if (typeof val === 'string' || typeof val === 'number') {
        return [String(val).trim().toLowerCase()];
    }
    if (typeof val === 'object') {
        const res = [];
        if (val.id) res.push(String(val.id).trim().toLowerCase());
        if (val.name) res.push(String(val.name).trim().toLowerCase());
        Object.keys(val).forEach(k => res.push(String(k).trim().toLowerCase()));
        return res;
    }
    return [];
}

/* Helper to extract and normalize place type ('shop' vs 'college') from shop document */
function extractShopPlaceType(s) {
    if (!s) return 'shop';
    if (s.isCollege === true || s.isCampus === true) return 'college';
    const raw = s.shopType || s.placeType || s.type || 'shop';
    const str = String(raw).trim().toLowerCase();
    if (str.includes('college') || str.includes('campus') || str.includes('university')) return 'college';
    return 'shop';
}

/* Helper to check if a shop document offers Xerox service and is active */
function isXeroxShop(s) {
    if (!s) return false;

    // 1. Status check: must be active (or legacy docs with no status field)
    if (s.status && String(s.status).toLowerCase() !== 'active') return false;

    // 2. Services check: xerox must be explicitly listed
    if (Array.isArray(s.services) && s.services.length > 0) {
        return s.services.some(sv => String(sv).trim().toLowerCase().includes('xerox'));
    }
    if (typeof s.services === 'string' && s.services.trim() !== '') {
        return s.services.toLowerCase().includes('xerox');
    }

    // 3. No services field at all — fall back to xerox-specific config/pricing as proof
    if (s.xeroxConfig || s.paperConfig || s.deliveryPrices?.xerox) return true;

    // 4. Has a services field but it's empty array or empty string → not a xerox shop
    return false;
}

/* ── "Others" location keys (must match manage-shops.js) ──
     state    → "__others__"
     district → "__others__:<stateId>"
     city     → "__others__:<districtId>" */
function othersKeyForSelection(stateId, districtId, cityId) {
    if (stateId === '__others__')    return { field: 'states',    key: '__others__' };
    if (districtId === '__others__') return { field: 'districts', key: `__others__:${stateId}` };
    if (cityId === '__others__')     return { field: 'cities',    key: `__others__:${districtId}` };
    return null;
}

function shopHasOthersKey(s, sel) {
    if (!sel) return false;
    return extractLocationValues(s[sel.field]).includes(sel.key.toLowerCase());
}

/* True when at least one active xerox shop is explicitly assigned to this "Others" key */
function hasAssignedOthersShops(key) {
    if (!key || !Array.isArray(allShopsRaw)) return false;
    return allShopsRaw.some(s => isXeroxShop(s) && shopHasOthersKey(s, key));
}

/* Core shop filter matching engine aligned with manage-shops and manage-xerox storage */
function matchShopWithFilters(s, filters = {}) {
    // 1. Xerox service & active status check
    if (!isXeroxShop(s)) return false;

    // Resolve filter parameters (use overrides if provided, else current user selection)
    const stateId    = filters.stateId    !== undefined ? filters.stateId    : selectedStateId;
    const districtId = filters.districtId !== undefined ? filters.districtId : selectedDistrictId;
    const cityId     = filters.cityId     !== undefined ? filters.cityId     : selectedCityId;
    const placeType  = filters.placeType  !== undefined ? filters.placeType  : selectedPlaceType;
    const orderType  = filters.orderType  !== undefined ? filters.orderType  : selectedOrderType;

    /* ── Map pin ────────────────────────────────────────────────────────── */
    if (userPin) {
        const d = kmToShop(s);
        if (!stateId) {
            /* Map-only location: the shop must have a pin and be near — within its
               delivery radius for delivery, within NEARBY_RADIUS_KM for pickup */
            if (d === null) return false;
            const reach = orderType === 'delivery' ? shopRadius(s) : NEARBY_RADIUS_KM;
            if (d > reach) return false;
        } else if (orderType === 'delivery' && d !== null && d > shopRadius(s)) {
            /* Delivery cannot reach this far (pickup is still allowed) */
            return false;
        }
    }

    /* ── "Others" handling ──────────────────────────────────────────────── */
    /* When state, district OR city is "others", only the admin-configured fallback
       xerox shop should appear. We check if this shop is that fallback. */
    const useOthersState    = stateId    === '__others__';
    const useOthersDistrict = districtId === '__others__';
    const useOthersCity     = cityId     === '__others__';

    if (useOthersState || useOthersDistrict || useOthersCity) {
        /* Shops the admin explicitly assigned to this "Others" bucket in
           Manage Shops. If none are assigned, fall back to the single
           KV-configured "other shops" xerox shop. */
        const key = othersKeyForSelection(stateId, districtId, cityId);
        if (!shopHasOthersKey(s, key)) {
            const fallbackId = otherShopsConfig?.xerox || null;
            if (!fallbackId || s.id !== fallbackId) return false;
            if (hasAssignedOthersShops(key)) return false;
        }
        /* Still apply place-type and order-type filters */
        if (placeType) {
            const shopPlaceType = extractShopPlaceType(s);
            if (shopPlaceType !== String(placeType).trim().toLowerCase()) return false;
        }
        if (orderType === 'delivery' && s.homeDelivery !== true) return false;
        return true;
    }

    // Resolve location objects for string/name matching on legacy data
    const stateObj    = stateId    ? allStates.find(st => st.id === stateId) : null;
    const districtObj = districtId ? allDistricts.find(d => d.id === districtId) : null;
    const cityObj     = cityId     ? allCities.find(c => c.id === cityId) : null;

    const stateName    = (stateObj?.name    || '').trim().toLowerCase();
    const districtName = (districtObj?.name || '').trim().toLowerCase();
    const cityName     = (cityObj?.name     || '').trim().toLowerCase();

    // --- State Check ---
    const shopStateVals = [
        ...extractLocationValues(s.states),
        ...extractLocationValues(s.state)
    ];
    const servesState = !stateId || shopStateVals.length === 0 || shopStateVals.some(v => {
        return v === String(stateId).toLowerCase() || (stateName && v === stateName);
    });
    if (!servesState) return false;

    // --- City Check ---
    const shopCityVals = [
        ...extractLocationValues(s.cities),
        ...extractLocationValues(s.city)
    ];
    const servesCity = !cityId || shopCityVals.length === 0 || shopCityVals.some(v => {
        return v === String(cityId).toLowerCase() || (cityName && v === cityName);
    });
    if (!servesCity) return false;

    // --- District Check ---
    const shopDistrictVals = [
        ...extractLocationValues(s.districts),
        ...extractLocationValues(s.district)
    ];
    const servesDistrict = !districtId || shopDistrictVals.length === 0 || shopDistrictVals.some(v => {
        return v === String(districtId).toLowerCase() || (districtName && v === districtName);
    }) || (cityId && shopCityVals.length > 0 && servesCity); // explicit city match implies district

    if (!servesDistrict) return false;

    // --- Place Type Check ('shop' vs 'college') ---
    if (placeType) {
        const shopPlaceType = extractShopPlaceType(s);
        const targetType    = String(placeType).trim().toLowerCase();
        if (shopPlaceType !== targetType) return false;
    }

    // --- Order / Delivery Check ---
    // ALL shops support pickup — never filter out for pickup.
    // Only shops explicitly marked homeDelivery === true appear under delivery.
    if (orderType === 'delivery' && s.homeDelivery !== true) return false;

    return true;
}

/* Calculate matching shop count given arbitrary filter overrides */
function getMatchingShopsCount(overrideFilters = {}) {
    if (!allShopsRaw) return 0;
    return allShopsRaw.filter(s => matchShopWithFilters(s, overrideFilters)).length;
}

/* Update shop counts across all wizard steps in real time */
function updateWizardStepCounts() {
    if (!allShopsRaw) return;

    // Step 1 badge & next button count
    if (hasCompleteLocation()) {
        const bothPicked = !!(selectedPlaceType && selectedOrderType);
        const step1Count = getMatchingShopsCount(bothPicked ? {} : { placeType: null, orderType: null });
        const badge = document.getElementById('xoStep1ShopBadge');
        const def = step1Count ? null : findDefaultShop();
        if (badge) {
            badge.style.display = 'block';
            badge.innerHTML = def
                ? `<i class="fa-solid fa-store" style="margin-right:4px;"></i> No shop nearby yet — you can order from ${h(def.name || DEFAULT_SHOP_NAME)}`
                : `<i class="fa-solid fa-store" style="margin-right:4px;"></i> ${step1Count} shop${step1Count === 1 ? '' : 's'} available${userPin && !selectedStateId ? ` within ${NEARBY_RADIUS_KM} km` : ' in this area'}`;
            badge.style.color = step1Count > 0 ? 'var(--primary, #2D8CF0)' : (def ? '#d97706' : '#ef4444');
        }
        const btn1 = document.getElementById('xoLocationConfirmBtn');
        const shown = Math.min(step1Count, MAX_SHOPS_LISTED) || (def ? 1 : 0);
        if (btn1) btn1.innerHTML = `Next: pick shop (${shown}) <i class="fa-solid fa-arrow-right"></i>`;
    }

    // Step 2 counts (Shop vs College)
    const shopCount    = getMatchingShopsCount({ placeType: 'shop',    orderType: null });
    const collegeCount = getMatchingShopsCount({ placeType: 'college', orderType: null });

    const subShop = document.getElementById('xoSubShop');
    if (subShop) subShop.innerHTML = `Standalone xerox center · <strong style="color:${shopCount > 0 ? '#16a34a' : '#ef4444'}">${shopCount} shop${shopCount === 1 ? '' : 's'}</strong>`;

    const subCollege = document.getElementById('xoSubCollege');
    if (subCollege) subCollege.innerHTML = `Pickup only · Shop inside/near college · <strong style="color:${collegeCount > 0 ? '#16a34a' : '#ef4444'}">${collegeCount} shop${collegeCount === 1 ? '' : 's'}</strong>`;

    if (selectedPlaceType) {
        const selCount = selectedPlaceType === 'college' ? collegeCount : shopCount;
        const btn2 = document.getElementById('xoStep2NextBtn');
        if (btn2) btn2.innerHTML = `Next (${selCount} shop${selCount === 1 ? '' : 's'}) <i class="fa-solid fa-arrow-right"></i>`;
    }

    // Step 3 counts (Delivery vs Pickup)
    const delivCount  = getMatchingShopsCount({ orderType: 'delivery' });
    const pickupCount = getMatchingShopsCount({ orderType: 'pickup' });

    const subDelivery = document.getElementById('xoSubDelivery');
    if (subDelivery) subDelivery.innerHTML = `Deliver to your address · <strong style="color:${delivCount > 0 ? '#16a34a' : '#ef4444'}">${delivCount} offer delivery</strong>`;

    const subPickup = document.getElementById('xoSubPickup');
    if (subPickup) subPickup.innerHTML = `Collect from shop directly · <strong style="color:${pickupCount > 0 ? '#16a34a' : '#ef4444'}">${pickupCount} available for pickup</strong>`;

    if (selectedOrderType) {
        const selCount = selectedOrderType === 'delivery' ? delivCount : pickupCount;
        const btn3 = document.getElementById('xoStep3NextBtn');
        if (btn3) btn3.innerHTML = `Next (${selCount} shop${selCount === 1 ? '' : 's'}) <i class="fa-solid fa-arrow-right"></i>`;
    }
}

window.confirmLocation = async function() {
    const anyOthers   = isOthersState || isOthersDistrict || isOthersCity;
    const hasLocation = hasCompleteLocation();
    if (!hasLocation || !selectedPlaceType || !selectedOrderType || !selectedPickerShopId) return;

    const state    = isOthersState ? null : allStates.find(s => s.id === selectedStateId);
    const district = (isOthersState || isOthersDistrict) ? null : allDistricts.find(d => d.id === selectedDistrictId);
    const city     = (isOthersState || isOthersDistrict || isOthersCity || !selectedCityId)
        ? null : allCities.find(c => c.id === selectedCityId);

    const displayName = anyOthers ? 'Others'
        : (city?.name || district?.name || state?.name || (userPin ? 'Pinned location' : ''));

    try {
        localStorage.setItem(LOCATION_KEY, JSON.stringify({
            stateId:      selectedStateId,
            districtId:   selectedDistrictId,
            cityId:       selectedCityId,
            shopId:       selectedPickerShopId,
            stateName:    isOthersState    ? 'Others' : (state?.name    || ''),
            districtName: isOthersDistrict ? 'Others' : (district?.name || ''),
            cityName:     displayName,
            placeType:    selectedPlaceType,
            orderType:    selectedOrderType,
            othersState:    isOthersState,
            othersDistrict: isOthersDistrict,
            othersCity:     isOthersCity
        }));
    } catch (_) {}

    hideLocationOverlay();
    await initMainPage();
};

/* ════ WIZARD STEPS ════
   Upload first, shop last (same order as the mobile app):
     1 'upload'   #xoLocStep5 (dot xoStep5Dot) — documents + print options
     2 'location' #xoLocStep1 (dot xoStep1Dot) — where + shop type + delivery/pickup
     3 'shop'     #xoLocStep4 (dot xoStep4Dot) — nearest shops → review & checkout
   The panel/dot ids are historical; only their order on screen changed.       */
const WIZARD_STEPS = [
    { key: 'upload',   panel: 'xoLocStep5', dot: 'xoStep5Dot', caption: 'Upload & print options' },
    { key: 'location', panel: 'xoLocStep1', dot: 'xoStep1Dot', caption: 'Your location' },
    { key: 'shop',     panel: 'xoLocStep4', dot: 'xoStep4Dot', caption: 'Choose your shop' },
];

function showWizardStep(key, scroll = false) {
    const idx = Math.max(0, WIZARD_STEPS.findIndex(s => s.key === key));
    WIZARD_STEPS.forEach((s, i) => {
        if (i === idx) { _showStep(s.panel); _markActive(s.dot); }
        else { _hideStep(s.panel); if (i < idx) _markDone(s.dot); else _markIdle(s.dot); }
    });
    const cap = document.getElementById('xoStepCaption');
    if (cap) cap.textContent = `Step ${idx + 1} of ${WIZARD_STEPS.length} · ${WIZARD_STEPS[idx].caption}`;
    if (scroll) document.getElementById('xoLocationCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const isPendingUpload = f => ['pending', 'uploading', 'paused'].includes(f.uploadStatus);

/* Upload step is complete: at least one file, every file uploaded / marked
   "later" / WhatsApp, and the doc settings are valid. Shows what is missing. */
function checkUploadStep() {
    if (!uploadedFiles.length) {
        flagField(document.getElementById('xoS5UploadZone'), 'Add at least one document to print.');
        return false;
    }
    const pending = uploadedFiles.map((f, i) => ({ f, i })).filter(({ f }) => isPendingUpload(f));
    if (pending.length) {
        pending.forEach(({ i }) => {
            const row = document.getElementById(`s5UploadRow-${i}`);
            if (row) { row.classList.add('error'); setTimeout(() => row.classList.remove('error'), 1600); }
        });
        const busy = pending.some(({ f }) => f.uploadStatus === 'uploading');
        flagField(document.getElementById(`s5UploadRow-${pending[0].i}`) || document.getElementById('xoS5UploadRows'),
            busy ? 'Please wait for the upload to finish.'
                 : `"${h(pending[0].f.name)}": tap Upload Now, Upload Later or Send via WhatsApp.`);
        return false;
    }
    return checkDocConfigs();
}

/* Step 1 (upload) → Step 2 (location) */
window.goFromUploadToLocation = function() {
    if (!checkUploadStep()) return;
    showWizardStep('location', true);
    refreshStep1();
};

/* Step 2 → Step 1. Files and settings are kept. */
window.goBackToUpload = function() {
    /* A shop picked on step 3 now drives the paper list — keep the settings valid for it */
    if (selectedPickerShopId && shopById(selectedPickerShopId)) {
        const changed = fitDocsToShop(selectedPickerShopId);
        if (changed.length) showToast(`Changed for the shop you picked: ${h(changed.join('; '))}.`, 'info');
    }
    showWizardStep('upload', true);
    renderStep5();
};

/* Step 2 (location) → Step 3 (shop list) */
window.goToStep2 = async function() {
    const anyOthers = isOthersState || isOthersDistrict || isOthersCity;

    if (!hasCompleteLocation()) {
        const target = !selectedStateId ? 'xoStateWrap'
                     : (!isOthersState && !selectedDistrictId) ? 'xoDistrictWrap'
                     : 'xoCityWrap';
        flagField(document.getElementById(target),
            'Tap "Use my location", pick your spot on the map, or choose your state, district and city.');
        return;
    }

    othersFastPath = false;
    if (anyOthers) {
        /* Shops assigned to this "Others" bucket in Manage Shops → normal list.
           None assigned → only the KV-configured fallback shop (or the default shop). */
        if (!allShopsRaw?.length && _wizardShopsReady) {
            try { await _wizardShopsReady; } catch (_) {}
        }
        const key = othersKeyForSelection(selectedStateId, selectedDistrictId, selectedCityId);
        if (!hasAssignedOthersShops(key)) {
            othersFastPath = true;
            if (!selectedPlaceType) selectedPlaceType = 'shop';
            if (!selectedOrderType) { selectedOrderType = 'pickup'; window.selectedOrderType = 'pickup'; }
            if (!otherShopsConfig) await fetchOtherShopsConfig();
            window.goToStep4();
            return;
        }
    }

    if (!selectedPlaceType) {
        flagField(document.getElementById('xoOptShop')?.parentElement, 'Choose the type of place: Xerox Shop or College / Campus.');
        return;
    }
    if (!selectedOrderType) {
        flagField(document.getElementById('xoOptDelivery')?.parentElement, 'Choose Home Delivery or Pick Up Myself.');
        return;
    }
    window.goToStep4();
};

/* → Step 3: shop list (a shop picked earlier stays picked if it is still listed) */
window.goToStep4 = function() {
    showWizardStep('shop', true);
    renderStep4Shops();
};

/* Step 3 → Step 2 */
window.goToStep3Back = function() {
    showWizardStep('location', true);
    refreshStep1();
};

/* Step 3 → review & checkout (shop chosen last) */
window.confirmLocationAndProceed = function() {
    /* Documents must still be complete (they were checked on step 1) */
    if (!uploadedFiles.length || uploadedFiles.some(isPendingUpload)) {
        showWizardStep('upload', true);
        renderStep5();
        checkUploadStep();
        return;
    }
    const shop = selectedPickerShopId ? shopById(selectedPickerShopId) : null;
    if (!shop) {
        selectedPickerShopId = null;
        flagField(document.getElementById('xoPickerShopList'), 'Please choose a shop for your order.');
        return;
    }
    if (selectedOrderType === 'delivery' && shop.homeDelivery !== true) {
        flagField(document.getElementById('xoPickerShopList'),
            `${h(shop.name || 'This shop')} offers pickup only. Go back and choose "Pick Up Myself", or pick another shop.`);
        return;
    }

    /* Papers / finishes this shop doesn't offer are switched to ones it does */
    const changed = fitDocsToShop(selectedPickerShopId);
    if (changed.length) {
        showToast(`${h(shop.name || 'This shop')} doesn't offer every option you chose, so we changed: ${h(changed.join('; '))}. Check the summary.`, 'info');
    }
    if (!checkDocConfigs() || !checkCollegeMinOrder()) return;

    /* Save location to localStorage then boot the main page behind the wizard */
    const anyOthers  = isOthersState || isOthersDistrict || isOthersCity;
    const state      = isOthersState ? null : allStates.find(s => s.id === selectedStateId);
    const district   = (isOthersState || isOthersDistrict) ? null : allDistricts.find(d => d.id === selectedDistrictId);
    const city       = (isOthersState || isOthersDistrict || isOthersCity || !selectedCityId)
        ? null : allCities.find(c => c.id === selectedCityId);
    const displayCity = anyOthers ? 'Others' : (city?.name || district?.name || state?.name || (userPin ? 'Pinned location' : ''));
    try {
        localStorage.setItem(LOCATION_KEY, JSON.stringify({
            stateId:      selectedStateId,
            districtId:   selectedDistrictId,
            cityId:       selectedCityId,
            shopId:       selectedPickerShopId,
            stateName:    isOthersState    ? 'Others' : (state?.name    || ''),
            districtName: isOthersDistrict ? 'Others' : (district?.name || ''),
            cityName:     displayCity,
            placeType:    selectedPlaceType,
            orderType:    selectedOrderType,
            othersState:    isOthersState,
            othersDistrict: isOthersDistrict,
            othersCity:     isOthersCity
        }));
    } catch (_) {}
    hideLocationOverlay();
    /* Restore all state vars (same as initMainPage does) then go straight to checkout */
    selectedShopId       = selectedPickerShopId;
    window.selectedOrderType = selectedOrderType;
    window.selectedPlaceType = selectedPlaceType;
    /* Re-compute active config from shop, recalculate prices, open checkout */
    const shopCfg = getShopXeroxConfig(selectedPickerShopId);
    xeroxConfig.paper      = shopCfg.paper;
    xeroxConfig.binding    = shopCfg.binding;
    xeroxConfig.lamination = shopCfg.lamination;
    /* allShops must be populated — it was fetched during wizard init */
    allShops = filterShopsByLocation(allShopsRaw);
    calculatePrices();
    initFileInput();   /* the main page's "Add Files" button needs its input wired */
    /* Show the main page sections (landing hidden, config visible) */
    const landingEl   = document.getElementById('xoLanding');
    const configEl    = document.getElementById('xoConfigSection');
    const fabEl       = document.getElementById('xoAddMoreBtn');
    const shopSelEl   = document.getElementById('xoShopSelector');
    const proceedEl   = document.getElementById('xoProceedFooter');
    const landShopsEl = document.getElementById('xoLandingShops');
    if (landingEl)   landingEl.style.display   = 'none';
    if (configEl)    configEl.style.display    = 'block';
    if (fabEl)       fabEl.style.display       = 'flex';
    if (shopSelEl)   shopSelEl.style.display   = 'block';
    if (proceedEl)   proceedEl.style.display   = 'block';
    if (landShopsEl) landShopsEl.style.display = 'none';
    renderDocCards();
    renderFinalSummary();
    renderShopSelector();
    openCheckoutSheet();
};

/* ── Step helpers ── */
function _markDone(dotId)   { const d = document.getElementById(dotId); if (d) { d.classList.remove('active'); d.classList.add('done'); } }
function _markActive(dotId) { const d = document.getElementById(dotId); if (d) { d.classList.remove('done'); d.classList.add('active'); } }
function _markIdle(dotId)   { const d = document.getElementById(dotId); if (d) { d.classList.remove('active','done'); } }
function _showStep(id)      { const el = document.getElementById(id); if (el) { el.style.display = 'block'; el.classList.add('xo-step-in'); } }
function _hideStep(id)      { const el = document.getElementById(id); if (el) { el.style.display = 'none'; el.classList.remove('xo-step-in'); } }

/* ════ STEP 5 HELPERS ════ */

/**
 * getShopXeroxConfig(shopId)
 * Returns a merged { paper, binding, lamination } config object for the given shop.
 *
 * Admin stores shop.xeroxConfig as a map:
 *   xeroxConfig.paper[<globalPaperId>]      = { enabled, bwPrices, colorPrices,
 *                                               colorOptions, formatOptions, ratioOptions,
 *                                               bindingOptions, laminationOptions }
 *   xeroxConfig.binding[<globalBindingId>]  = { enabled, price }
 *   xeroxConfig.lamination[<globalLamId>]   = { enabled, price }
 *
 * This function resolves that map against the global arrays and returns:
 *   paper[]      — only enabled papers, with shop prices/options merged in
 *   binding[]    — only enabled bindings, with shop price merged in
 *   lamination[] — only enabled laminations, with shop price merged in
 *
 * Falls back to the full global arrays if the shop has no map-based config.
 * Still handles legacy formats (xeroxConfig as array, shop.paperConfig array).
 */
function getShopXeroxConfig(shopId) {
    const shop   = allShopsRaw.find(s => s.id === shopId) || {};
    const global = xeroxConfig;

    if (!shop.xeroxConfig) {
        /* No shop-level config at all — legacy paperConfig array or pure global */
        if (Array.isArray(shop.paperConfig) && shop.paperConfig.length) {
            return { paper: shop.paperConfig, binding: global.binding, lamination: global.lamination };
        }
        return { paper: global.paper, binding: global.binding, lamination: global.lamination };
    }

    const xc = shop.xeroxConfig;

    /* ── Legacy: xeroxConfig stored as a plain array of paper objects ── */
    if (Array.isArray(xc)) {
        return { paper: xc, binding: global.binding, lamination: global.lamination };
    }

    /* ── Legacy: sub-arrays stored directly (old pre-map format) ── */
    if (Array.isArray(xc.paper) || Array.isArray(xc.binding) || Array.isArray(xc.lamination)) {
        return {
            paper:      Array.isArray(xc.paper)      && xc.paper.length      ? xc.paper      : global.paper,
            binding:    Array.isArray(xc.binding)    && xc.binding.length    ? xc.binding    : global.binding,
            lamination: Array.isArray(xc.lamination) && xc.lamination.length ? xc.lamination : global.lamination,
        };
    }

    /* ── Current map-based format set by manage-xerox admin ── */
    const paperMap      = (typeof xc.paper      === 'object' && !Array.isArray(xc.paper))      ? xc.paper      : {};
    const bindingMap    = (typeof xc.binding    === 'object' && !Array.isArray(xc.binding))    ? xc.binding    : {};
    const laminationMap = (typeof xc.lamination === 'object' && !Array.isArray(xc.lamination)) ? xc.lamination : {};

    const hasAnyPaperEntry      = Object.keys(paperMap).length      > 0;
    const hasAnyBindingEntry    = Object.keys(bindingMap).length    > 0;
    const hasAnyLaminationEntry = Object.keys(laminationMap).length > 0;

    /* Paper — filter to enabled entries and merge shop prices + options onto global item */
    const paper = hasAnyPaperEntry
        ? global.paper
            .filter(p => paperMap[p.id]?.enabled === true)
            .map(p => {
                const shopP = paperMap[p.id];
                return {
                    ...p,
                    /* Override prices with shop-specific values if set */
                    bwPrices:    (shopP.bwPrices    && (shopP.bwPrices.frontOnly    || shopP.bwPrices.frontBack))    ? shopP.bwPrices    : p.bwPrices,
                    colorPrices: (shopP.colorPrices && (shopP.colorPrices.frontOnly || shopP.colorPrices.frontBack)) ? shopP.colorPrices : p.colorPrices,
                    /* Merge shop option overrides — each key replaces the matching global options sub-object */
                    _shopOptions: {
                        color:      shopP.colorOptions      || null,
                        format:     shopP.formatOptions     || null,
                        ratio:      shopP.ratioOptions      || null,
                        binding:    shopP.bindingOptions    || null,
                        lamination: shopP.laminationOptions || null,
                    },
                };
            })
        : global.paper;

    /* Binding — filter to enabled entries and apply shop price */
    const binding = hasAnyBindingEntry
        ? global.binding
            .filter(b => bindingMap[b.id]?.enabled === true)
            .map(b => {
                const shopB = bindingMap[b.id];
                return {
                    ...b,
                    price: (shopB.price != null) ? shopB.price : b.price,
                };
            })
        : global.binding;

    /* Lamination — filter to enabled entries and apply shop price */
    const lamination = hasAnyLaminationEntry
        ? global.lamination
            .filter(l => laminationMap[l.id]?.enabled === true)
            .map(l => {
                const shopL = laminationMap[l.id];
                return {
                    ...l,
                    price: (shopL.price != null) ? shopL.price : l.price,
                };
            })
        : global.lamination;

    return { paper, binding, lamination };
}

/**
 * renderStep5()
 * Builds the shop banner and (re)renders docs + upload rows inside #xoLocStep5.
 * Called every time step 5 becomes visible.
 */
function renderStep5() {
    const shop    = selectedPickerShopId ? shopById(selectedPickerShopId) : null;
    const shopCfg = getShopXeroxConfig(selectedPickerShopId);

    /* ── Note banner: the shop is chosen after this step ── */
    const banner = document.getElementById('xoS5ShopBanner');
    if (banner) {
        banner.innerHTML = shop ? `
        <div class="xo-s5-banner-icon"><i class="fa-solid fa-store"></i></div>
        <div class="xo-s5-banner-body">
            <div class="xo-s5-banner-name">Prices at ${h(shop.name || 'your shop')}</div>
            <div class="xo-s5-banner-addr"><i class="fa-solid fa-circle-info"></i> You can still change the shop in step 3.</div>
        </div>` : `
        <div class="xo-s5-banner-icon"><i class="fa-solid fa-file-circle-plus"></i></div>
        <div class="xo-s5-banner-body">
            <div class="xo-s5-banner-name">Add your documents</div>
            <div class="xo-s5-banner-addr"><i class="fa-solid fa-circle-info"></i> Choose colour, sides and copies. Prices are standard rates — you'll pick the nearest shop in step 3.</div>
        </div>`;
    }

    /* Wire up the upload-step file input (once). The config is read at pick time,
       so a shop chosen later (or the price list arriving late) is respected. */
    const inp = document.getElementById('xoS5FileInput');
    if (inp && !inp._s5Wired) {
        inp._s5Wired = true;
        inp.addEventListener('change', async e => {
            if (e.target.files.length > 0) await handleFilesStep5(e.target.files, getShopXeroxConfig(selectedPickerShopId));
            e.target.value = '';
        });
    }

    /* Drag & drop files onto the upload zone (wired once; reads the current shop's config at drop time) */
    const zone = document.getElementById('xoS5UploadZone');
    if (zone && !zone._dropWired) {
        zone._dropWired = true;
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('xo-s5-drag'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('xo-s5-drag'));
        zone.addEventListener('drop', async e => {
            e.preventDefault();
            zone.classList.remove('xo-s5-drag');
            if (!currentUser && !localStorage.getItem('jasa_user_cache')) { window.triggerUploadStep5(); return; }
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length) await handleFilesStep5(files, getShopXeroxConfig(selectedPickerShopId));
        });
    }

    renderStep5Docs(shopCfg);
    renderStep5UploadRows();
    updateStep5Summary(shopCfg);
}

/* Re-wire the step-5 file input whenever shopCfg changes (e.g. user goes back and picks a different shop) */
window.triggerUploadStep5 = function() {
    if (!currentUser && !localStorage.getItem('jasa_user_cache')) {
        showToast('Please sign in to upload documents.', 'error');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }
    document.getElementById('xoS5FileInput')?.click();
};

async function handleFilesStep5(files, shopCfg) {
    const overlay = document.getElementById('xoLoadingOverlay');
    if (overlay) overlay.style.display = 'flex';
    /* Files can be picked before the price list has loaded — wait for it so each
       file starts with a real paper type */
    if (!shopCfg?.paper?.length && _xeroxCfgReady) {
        try { await _xeroxCfgReady; } catch (_) {}
        shopCfg = getShopXeroxConfig(selectedPickerShopId);
    }
    try {
        for (const file of Array.from(files)) {
            const pages = await getPdfPageCount(file);
            uploadedFiles.push({
                id:            'doc-' + Date.now() + Math.random().toString(36).substr(2, 5),
                fileObj:       file,
                name:          file.name,
                type:          file.type.split('/')[1]?.toUpperCase() || 'FILE',
                pages,
                uploadStatus:  'pending',
                uploadedUrl:   '',
                uploadProgress: 0,
                uploadSpeed:   '',
                uploadETA:     '',
                prices:        { perPage: 0, binding: 0, lamination: 0, final: 0 },
                config: {
                    paperId:           shopCfg.paper[0]?.id || '',
                    color:             'bw',
                    format:            pages === 1 ? 'frontOnly' : 'both',
                    ratio:             '1:1',
                    bindingId:         'none',
                    laminationId:      'none',
                    quantity:          1,
                    colorPages:        '',
                    instructions:      '',
                    _showInstructions: false
                }
            });
        }
    } finally {
        if (overlay) overlay.style.display = 'none';
    }
    renderStep5Docs(shopCfg);
    renderStep5UploadRows();
    updateStep5Summary(shopCfg);
    showToast(`${files.length} file${files.length > 1 ? 's' : ''} added.`, 'success');
}

/**
 * renderStep5Docs(shopCfg)
 * Renders per-doc config cards inside #xoS5DocCards using shopCfg (not global xeroxConfig).
 * Reuses the same buildDocCard() logic but passes shopCfg through a temporary override.
 */
function renderStep5Docs(shopCfg) {
    const container = document.getElementById('xoS5DocCards');
    if (!container) return;

    if (!uploadedFiles.length) {
        container.innerHTML = '';
        return;
    }

    /* Temporarily override global xeroxConfig with shop-specific config for rendering */
    const saved = { paper: xeroxConfig.paper, binding: xeroxConfig.binding, lamination: xeroxConfig.lamination };
    xeroxConfig.paper      = shopCfg.paper;
    xeroxConfig.binding    = shopCfg.binding;
    xeroxConfig.lamination = shopCfg.lamination;

    calculatePrices(); /* prices now use shop config */
    container.innerHTML = buildCombinedBookCard() + uploadedFiles.map((f, i) => buildDocCard(f, i)).join('');

    /* Restore global config */
    xeroxConfig.paper      = saved.paper;
    xeroxConfig.binding    = saved.binding;
    xeroxConfig.lamination = saved.lamination;
    afterDocsRender(container);
}

/**
 * renderStep5UploadRows()
 * Renders upload rows inside #xoS5UploadRows (reuses buildUploadRow).
 * Row IDs use prefix s5UploadRow- so confirmLocationAndProceed can find them.
 */
function renderStep5UploadRows() {
    const list = document.getElementById('xoS5UploadRows');
    if (!list) return;
    if (!uploadedFiles.length) { list.innerHTML = ''; return; }

    /* buildUploadRow uses uploadRow-{i} as its element ID; we post-process to rename */
    list.innerHTML = uploadedFiles.map((f, i) => {
        let html = buildUploadRow(f, i);
        /* Rename the id so step-5 validation can target s5UploadRow-{i} */
        html = html.replace(`id="uploadRow-${i}"`, `id="s5UploadRow-${i}"`);
        return html;
    }).join('');
}

/**
 * updateStep5Summary(shopCfg)
 * Updates the subtotal strip and enables/disables the Proceed button.
 */
function updateStep5Summary(shopCfg) {
    const summaryEl  = document.getElementById('xoS5Summary');
    const subtotalEl = document.getElementById('xoS5SubtotalBar');
    const proceedBtn = document.getElementById('xoStep5ProceedBtn');

    if (!uploadedFiles.length) {
        if (summaryEl)  summaryEl.style.display  = 'none';
        setSoftDisabled(proceedBtn, true);
        return;
    }

    /* Calc with shop config */
    const saved = { paper: xeroxConfig.paper, binding: xeroxConfig.binding, lamination: xeroxConfig.lamination };
    xeroxConfig.paper      = shopCfg.paper;
    xeroxConfig.binding    = shopCfg.binding;
    xeroxConfig.lamination = shopCfg.lamination;
    calculatePrices();
    xeroxConfig.paper      = saved.paper;
    xeroxConfig.binding    = saved.binding;
    xeroxConfig.lamination = saved.lamination;

    const subtotal     = uploadedFiles.reduce((s, f) => s + f.prices.final, 0);
    const hasEstimate  = uploadedFiles.some(f => f.config.colorMode === 'custom');
    const allHandled   = uploadedFiles.every(f =>
        f.uploadStatus === 'uploaded' || f.uploadStatus === 'later' || f.uploadStatus === 'whatsapp'
    );

    /* Delivery nudge from shop rules (only once a shop is picked) */
    const shop       = (selectedPickerShopId && shopById(selectedPickerShopId)) || {};
    const xeroxRules = shop.deliveryPrices?.xerox || [];
    const freeRule   = xeroxRules.find(r => r.fee === 0);
    const isFree     = freeRule && subtotal >= freeRule.min;
    const nudge      = freeRule && !isFree && !hasEstimate
        ? `<span class="xo-s5-nudge"><i class="fa-solid fa-circle-info"></i> Add ₹${(freeRule.min - subtotal).toFixed(2)} more for FREE delivery</span>`
        : '';

    if (subtotalEl) subtotalEl.innerHTML = `
        <div class="xo-s5-subtotal-row">
            <span class="xo-s5-subtotal-label">${shop.id ? 'Subtotal' : 'Estimated subtotal'}</span>
            <span class="xo-s5-subtotal-val">${hasEstimate ? '<em>Estimate pending</em>' : `₹${subtotal.toFixed(2)}`}</span>
        </div>
        ${nudge}
        ${shop.id ? '' : '<div class="xo-s5-file-count">Standard rates — the final price is set by the shop you pick in step 3.</div>'}
        <div class="xo-s5-file-count">${uploadedFiles.length} file${uploadedFiles.length !== 1 ? 's' : ''} · ${uploadedFiles.filter(f => f.uploadStatus === 'uploaded').length} uploaded</div>`;

    if (summaryEl) summaryEl.style.display = 'block';

    /* Looks ready only when every file has been handled (a click explains what is missing) */
    setSoftDisabled(proceedBtn, !allHandled);
}

/* ════ SHOP CHOICES (step 3 list + the shop modal) ════
   Up to MAX_SHOPS_LISTED xerox shops matching the location / place type /
   delivery choice. With a pin they are sorted nearest first and limited to shops
   within NEARBY_RADIUS_KM (or a delivery shop's own radius); when an area is
   chosen too, that area's shops without a map pin follow. Nothing found (or the
   "Others" bucket has no shop) → the default shop "OrderMyXerox India".
   Returns { list, isDefault, reason } — reason: '' | 'no-pin' | 'none-near' | 'none-area'. */
function nearestShopChoices() {
    let list;
    if (othersFastPath) {
        const fb = otherShopsConfig?.xerox ? shopById(otherShopsConfig.xerox) : null;
        list = fb ? [fb] : [];
    } else {
        list = filterShopsByLocation(allShopsRaw);      /* fills shopDistKm, nearest first */
        if (userPin) {
            const near = list.filter(s => {
                if (!shopDistKm.has(s.id)) return false;
                const d = shopDistKm.get(s.id);
                return d <= NEARBY_RADIUS_KM || (selectedOrderType === 'delivery' && d <= shopRadius(s));
            });
            const unpinned = selectedStateId ? list.filter(s => !shopDistKm.has(s.id)) : [];
            list = [...near, ...unpinned];
        }
        list = list.slice(0, MAX_SHOPS_LISTED);
    }
    if (list.length) return { list, isDefault: false, reason: userPin || othersFastPath ? '' : 'no-pin' };
    const def = findDefaultShop();
    if (def && userPin && !shopDistKm.has(def.id)) { const d = kmToShop(def); if (d !== null) shopDistKm.set(def.id, d); }
    return { list: def ? [def] : [], isDefault: !!def, reason: userPin ? 'none-near' : 'none-area' };
}

/* The default shop: by name (case / spacing / punctuation ignored), then the admin's
   "Others" fallback xerox shop. Only active shops; xerox shops are preferred. */
function findDefaultShop() {
    const norm   = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(DEFAULT_SHOP_NAME);
    const active = s => !s.status || String(s.status).toLowerCase() === 'active';
    const pools  = [allShopsRaw, allShopsAll.filter(active)];
    for (const pool of pools) { const hit = pool.find(s => norm(s.name) === target); if (hit) return hit; }
    for (const pool of pools) { const hit = pool.find(s => norm(s.name).includes(target)); if (hit) return hit; }
    const fb = otherShopsConfig?.xerox;
    return fb ? (pools[0].find(s => s.id === fb) || pools[1].find(s => s.id === fb) || null) : null;
}

/* A shop by id from any list we hold (the default / fallback shop may not be in the filtered list) */
function shopById(id) {
    if (!id) return null;
    return allShops.find(s => s.id === id) || allShopsRaw.find(s => s.id === id) || allShopsAll.find(s => s.id === id) || null;
}

/* Explains the list on step 3 */
function shopListNote({ list, isDefault, reason }) {
    if (!list.length) return '';
    const shop = list[0];
    if (isDefault) {
        const why = reason === 'none-near'
            ? `No xerox shop within ${NEARBY_RADIUS_KM} km of your location yet.`
            : 'No xerox shop found for this area yet.';
        const tip = reason === 'none-area' ? ' Go back and tap "Use my location" to look for the nearest shops.' : '';
        const pickupOnly = selectedOrderType === 'delivery' && shop.homeDelivery !== true
            ? ` This shop offers pickup only — go back and choose "Pick Up Myself".` : '';
        return `<i class="fa-solid fa-circle-info"></i> <span>${h(why)} You can order from <b>${h(shop.name || DEFAULT_SHOP_NAME)}</b>.${h(tip + pickupOnly)}</span>`;
    }
    if (reason === 'no-pin') {
        return `<i class="fa-solid fa-location-crosshairs"></i> <span>Shops for your area. Go back and tap "Use my location" to sort them by distance.</span>`;
    }
    if (userPin && !othersFastPath) {
        return `<i class="fa-solid fa-route"></i> <span>${list.length === 1 ? 'The nearest shop' : `The ${list.length} nearest shops`} within ${NEARBY_RADIUS_KM} km of your pinned location.</span>`;
    }
    return '';
}

/* Render the shop choices into the step-3 list */
function renderStep4Shops() {
    const list = document.getElementById('xoPickerShopList');
    if (!list) return;
    const noteEl   = document.getElementById('xoPickerNote');
    const countEl  = document.getElementById('xoPickerCount');
    const countNum = document.getElementById('xoPickerCountNum');
    const nextBtn  = document.getElementById('xoStep4NextBtn');

    /* Show loading state while shops are still being fetched */
    if (!_shopsLoaded && !allShopsRaw.length) {
        list.innerHTML = `
            <div class="xo-picker-loading">
                <div class="xo-shops-spinner"></div>
                <span>Loading shops…</span>
            </div>`;
        if (countEl) countEl.style.display = 'none';
        if (noteEl)  noteEl.style.display  = 'none';
        /* Retry once shops are loaded */
        const waitForShops = setInterval(() => {
            const s4 = document.getElementById('xoLocStep4');
            if (!s4 || s4.style.display === 'none') { clearInterval(waitForShops); return; }
            if (_shopsLoaded || allShopsRaw.length) { clearInterval(waitForShops); renderStep4Shops(); }
        }, 300);
        return;
    }

    const choice = nearestShopChoices();
    const shops  = choice.list;

    /* Keep an earlier pick only while it is still offered; a single shop is picked for the customer */
    if (selectedPickerShopId && !shops.some(s => s.id === selectedPickerShopId)) selectedPickerShopId = null;
    if (!selectedPickerShopId && shops.length === 1) selectedPickerShopId = shops[0].id;
    setSoftDisabled(nextBtn, !selectedPickerShopId);

    const note = shopListNote(choice);
    if (noteEl) {
        noteEl.innerHTML     = note;
        noteEl.style.display = note ? 'flex' : 'none';
        noteEl.classList.toggle('xo-picker-note--warn', choice.isDefault);
    }
    if (countEl)  countEl.style.display = 'flex';
    if (countNum) countNum.textContent  = shops.length;

    if (!shops.length) {
        list.innerHTML = `
            <div class="xo-picker-empty">
                <i class="fa-solid fa-store-slash"></i>
                <div class="xo-picker-empty-title">No shops found</div>
                <div class="xo-picker-empty-sub">
                    ${selectedOrderType === 'delivery'
                        ? 'No shops offer home delivery in your area yet. Go back and select "Pick Up Myself".'
                        : (userPin ? `No xerox shop within ${NEARBY_RADIUS_KM} km of your pinned location yet. Try a different spot, or choose your state / district / city instead.` : 'No shops available in your area yet.')}
                </div>
            </div>`;
        renderPickerTotal();
        return;
    }

    list.innerHTML = shops.map((s, idx) => {
        const xeroxRules = s.deliveryPrices?.xerox || [];
        const freeRule   = xeroxRules.find(r => r.fee === 0);
        const offersDelivery = s.homeDelivery === true;
        const delivBadge = offersDelivery
            ? `<span class="xo-picker-badge xo-picker-badge--delivery">
                   <i class="fa-solid fa-truck-fast"></i> Delivery
                   ${s.deliveryTime ? '· ' + h(s.deliveryTime) : ''}
               </span>`
            : `<span class="xo-picker-badge xo-picker-badge--pickup">
                   <i class="fa-solid fa-store"></i> Pickup only
               </span>`;
        const freeBadge = freeRule
            ? `<span class="xo-picker-badge xo-picker-badge--free">
                   <i class="fa-solid fa-gift"></i> Free above ₹${h(freeRule.min)}
               </span>` : '';
        const defBadge = choice.isDefault ? `<span class="xo-picker-badge xo-picker-badge--free"><i class="fa-solid fa-star"></i> Default shop</span>` : '';
        const svcs = (Array.isArray(s.services) ? s.services : [])
            .map(sv => `<span class="xo-picker-svc">${h(sv)}</span>`).join('');
        const isSelected = s.id === selectedPickerShopId;
        return `
        <div class="xo-picker-shop ${isSelected ? 'selected' : ''}" role="radio" aria-checked="${isSelected}" tabindex="0"
             onclick="selectPickerShop('${esc(s.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectPickerShop('${esc(s.id)}');}">
            <div class="xo-picker-shop-radio ${isSelected ? 'checked' : ''}"></div>
            <div class="xo-picker-shop-body">
                <div class="xo-picker-shop-name">${h(s.name)}${distBadge(s, idx === 0 && !choice.isDefault && shops.length > 1)}</div>
                <div class="xo-picker-shop-addr">
                    <i class="fa-solid fa-location-dot"></i> ${h(s.address || 'Local Center')}
                    ${s.locationLink ? `<br><a href="${h(s.locationLink)}" target="_blank" rel="noopener" onclick="event.stopPropagation();" style="color:var(--primary); font-weight:600; text-decoration:none; display:inline-block; margin-top:4px;"><i class="fa-solid fa-map-location-dot"></i> View on Map</a>` : ''}
                </div>
                <div class="xo-picker-badges">
                    ${defBadge}${delivBadge}${freeBadge}
                </div>
                ${svcs ? `<div class="xo-picker-svcs">${svcs}</div>` : ''}
            </div>
        </div>`;
    }).join('');
    renderPickerTotal();
}

/* "3 files · ₹42.00 at <shop>" under the list, with the picked shop's prices */
function renderPickerTotal() {
    const el = document.getElementById('xoPickerTotal');
    if (!el) return;
    const shop = selectedPickerShopId ? shopById(selectedPickerShopId) : null;
    if (!shop || !uploadedFiles.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    calculatePrices();   /* selectedShopId is unset in the wizard, so this uses the picked shop */
    const subtotal = uploadedFiles.reduce((s, f) => s + (f.prices?.final || 0), 0);
    el.innerHTML = `
        <span>${uploadedFiles.length} file${uploadedFiles.length === 1 ? '' : 's'} at <b>${h(shop.name || 'this shop')}</b>${selectedOrderType === 'delivery' ? ' <small>+ delivery</small>' : ''}</span>
        <strong>₹${subtotal.toFixed(2)}</strong>`;
    el.style.display = 'flex';
}

window.selectPickerShop = function(id) {
    selectedPickerShopId = id;
    /* Re-render list so radio states, the button and the total update */
    renderStep4Shops();
};

/* Mark the delivery/pickup cards; College is pickup-only so delivery is locked while it is chosen */
function paintOrderType(type) {
    document.getElementById('xoOptDelivery')?.classList.toggle('selected', type === 'delivery');
    document.getElementById('xoOptPickup')?.classList.toggle('selected',   type === 'pickup');
    document.getElementById('xoRadioDelivery')?.classList.toggle('checked', type === 'delivery');
    document.getElementById('xoRadioPickup')?.classList.toggle('checked',   type === 'pickup');
}

/* Select place type */
window.selectPlaceType = function(type) {
    selectedPlaceType = type;
    if (type === 'college') {
        selectedOrderType = 'pickup';
        window.selectedOrderType = 'pickup';
        paintOrderType('pickup');
    }
    document.getElementById('xoOptDelivery')?.classList.toggle('xo-delivery-card--locked', type === 'college');
    document.getElementById('xoOptShop')?.classList.toggle('selected',    type === 'shop');
    document.getElementById('xoOptCollege')?.classList.toggle('selected', type === 'college');
    document.getElementById('xoRadioShop')?.classList.toggle('checked',    type === 'shop');
    document.getElementById('xoRadioCollege')?.classList.toggle('checked', type === 'college');
    refreshStep1();
};

/* Select delivery type */
window.selectOrderType = function(type) {
    if (type === 'delivery' && selectedPlaceType === 'college') {
        showToast('College shops are pickup only.', 'warning');
        return;
    }
    selectedOrderType        = type;
    window.selectedOrderType = type;
    paintOrderType(type);
    refreshStep1();
};

function hideLocationOverlay() {
    const overlay = document.getElementById('xoLocationOverlay');
    if (overlay) overlay.style.display = 'none';
}

/* ════ MAIN PAGE INIT (runs after location confirmed) ════ */
async function initMainPage() {
    try {
        const saved = localStorage.getItem(LOCATION_KEY);
        if (saved) {
            const { stateId, districtId, cityId, cityName, orderType, placeType, shopId, othersState, othersDistrict, othersCity } = JSON.parse(saved);
            /* Restore ALL location state vars so filters work correctly */
            selectedStateId      = stateId    || null;
            selectedDistrictId   = districtId || null;
            selectedCityId       = cityId     || null;
            selectedOrderType    = orderType  || null;
            selectedPlaceType    = placeType  || null;
            isOthersState        = !!othersState;
            isOthersDistrict     = !!othersDistrict;
            isOthersCity         = !!othersCity;
            window.selectedOrderType = orderType || null;
            window.selectedPlaceType = placeType || null;
            /* Pre-select the shop the user chose in step 4 */
            if (shopId) {
                selectedShopId       = shopId;
                selectedPickerShopId = shopId;
            }
            const label = document.getElementById('xoLocationLabel');
            if (label) {
                const displayCity = (isOthersState || isOthersDistrict || isOthersCity) ? 'Others' : (cityName || '');
                const placeIcon = placeType === 'college' ? '🎓' : '🏪';
                const typeIcon  = orderType === 'pickup'  ? '🛍️' : '🚚';
                label.textContent = `${placeIcon} ${typeIcon} ${displayCity}`;
            }
        }
    } catch (_) {}

    await Promise.all([ fetchXeroxConfig(), fetchShops(), fetchOtherShopsConfig() ]);
    initFileInput();
}

/* Allow user to re-pick location */
window.changeLocation = function() {
    try { localStorage.removeItem(LOCATION_KEY); } catch(_) {}
    selectedStateId      = null;
    selectedDistrictId   = null;
    selectedCityId       = null;
    selectedPlaceType    = null;
    selectedOrderType    = null;
    selectedPickerShopId = null;
    selectedShopId       = null;
    isOthersState        = false;
    isOthersDistrict     = false;
    isOthersCity         = false;
    window.selectedOrderType = null;
    clearPin(true);

    /* Reset selects */
    const stateSelect    = document.getElementById('xoStateSelect');
    const districtSelect = document.getElementById('xoDistrictSelect');
    const citySelect     = document.getElementById('xoCitySelect');
    const districtField  = document.getElementById('xoDistrictField');
    const cityField      = document.getElementById('xoCityField');
    const confirmBtn     = document.getElementById('xoLocationConfirmBtn');
    if (stateSelect)    stateSelect.value    = '';
    if (districtSelect) districtSelect.value = '';
    if (citySelect)     citySelect.value     = '';
    if (districtField)  districtField.style.display = 'none';
    if (cityField)      cityField.style.display     = 'none';
    if (confirmBtn)     setSoftDisabled(confirmBtn, true);

    /* Reset all steps: the wizard starts again at upload */
    const prefsEl = document.getElementById('xoStep1Prefs');
    if (prefsEl) prefsEl.style.display = 'none';
    document.getElementById('xoOptDelivery')?.classList.remove('xo-delivery-card--locked');

    /* Reset all card selections */
    ['xoOptShop','xoOptCollege','xoOptDelivery','xoOptPickup'].forEach(id =>
        document.getElementById(id)?.classList.remove('selected'));
    ['xoRadioShop','xoRadioCollege','xoRadioDelivery','xoRadioPickup'].forEach(id =>
        document.getElementById(id)?.classList.remove('checked'));
    setSoftDisabled(document.getElementById('xoStep4NextBtn'), true);
    setSoftDisabled(document.getElementById('xoStep5ProceedBtn'), true);
    othersFastPath = false;
    /* Clear any files added during a previous wizard session */
    uploadedFiles.length = 0;

    /* Show in-page picker again, hide landing content */
    const overlay = document.getElementById('xoLocationOverlay');
    if (overlay) {
        overlay.classList.remove('xo-location-hide');
        overlay.style.display = 'block';
    }
    document.getElementById('xoLanding').style.display       = 'none';
    document.getElementById('xoConfigSection').style.display = 'none';
    document.getElementById('xoAddMoreBtn').style.display    = 'none';
    showWizardStep('upload');
    renderStep5();
    /* Returning visitors skipped the location lists on load — fetch them now */
    if (!allStates.length) loadLocationOptions().catch(e => console.error('[Location] fetch failed:', e));
};

/* Config and shops are always fetched fresh (no copy kept on the device). */

async function fetchXeroxConfig() {
    const applyConfig = cfg => {
        xeroxConfig.paper      = cfg.paper;
        xeroxConfig.binding    = cfg.binding    || [];
        xeroxConfig.lamination = cfg.lamination || [];
    };

    /* 1. Cloudflare Worker KV cache (always fetched, so price changes show at once) */
    let workerReached = false;
    try {
        const res = await fetch(`${WORKER_URL}/api/config/xerox`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
            workerReached = true;
            const json = await res.json();
            const cfg  = json.config || json;
            if (cfg.paper?.length || cfg.binding?.length) {
                const bySort = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
                applyConfig({
                    paper:      (cfg.paper      || []).sort(bySort),
                    binding:    (cfg.binding    || []).sort(bySort),
                    lamination: (cfg.lamination || []).sort(bySort),
                });
                return;
            }
        }
    } catch (_) { /* Worker unavailable — fall through */ }

    /* 3. Firestore fallback */
    try {
        const [pSnap, bSnap, lSnap] = await Promise.all([
            getDocs(collection(db, 'xerox_config_paper')),
            getDocs(collection(db, 'xerox_config_binding')),
            getDocs(collection(db, 'xerox_config_lamination'))
        ]);
        xeroxConfig.paper      = pSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        xeroxConfig.binding    = bSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        xeroxConfig.lamination = lSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    } catch (e) { console.warn('xerox config fetch failed:', e); }
}

/* Shops for the page; _shopsLoaded flips once every source has been tried, so the
   shop step can stop showing "Loading…" even when nothing could be fetched. */
let _shopsLoaded = false;
async function fetchShops(forceFresh = false) {
    try { await _fetchShops(forceFresh); }
    finally {
        _shopsLoaded = true;
        const step4 = document.getElementById("xoLocStep4");
        if (step4 && step4.style.display !== "none") renderStep4Shops();
    }
}
async function _fetchShops(forceFresh = false) {
    /* 2. Cloudflare Worker KV cache */
    try {
        const res = await fetch(`${WORKER_URL}/api/shops/all?_t=${Date.now()}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
            const json  = await res.json();
            let rawList = [];
            if (Array.isArray(json)) rawList = json;
            else if (Array.isArray(json.shops)) rawList = json.shops;
            else if (Array.isArray(json.data)) rawList = json.data;
            else if (json.shops?.shops && Array.isArray(json.shops.shops)) rawList = json.shops.shops;

            if (rawList.length) {
                const xeroxOnly = rawList.filter(s => isXeroxShop(s));
                if (xeroxOnly.length > 0) {
                    allShopsAll = rawList;
                    allShopsRaw = xeroxOnly;
                    allShops    = filterShopsByLocation(xeroxOnly);
                    renderLandingShops();
                    updateWizardStepCounts();
                    const step4 = document.getElementById('xoLocStep4');
                    if (step4 && step4.style.display !== 'none') renderStep4Shops();
                    return;
                }
            }
        }
    } catch (_) { /* Worker unavailable — fall through */ }

    /* 3. Firestore fallback — fetch all shops */
    try {
        const snap  = await getDocs(collection(db, 'shops'));
        allShopsAll = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const shops = allShopsAll.filter(s => isXeroxShop(s));
        if (shops.length > 0) {
        }
        allShopsRaw = shops;
        allShops    = filterShopsByLocation(shops);
    } catch (e) { console.warn('shops fetch failed:', e); }

    renderLandingShops();
    updateWizardStepCounts();
    /* Re-render step-4 picker if the user is already on that step */
    const step4 = document.getElementById('xoLocStep4');
    if (step4 && step4.style.display !== 'none') renderStep4Shops();
}

/* Filter shops to those serving the user's selected city/district/state, place type, and order delivery type */
function filterShopsByLocation(shops) {
    if (!Array.isArray(shops)) return [];
    const list = shops.filter(s => matchShopWithFilters(s));
    shopDistKm.clear();
    if (userPin) {
        list.forEach(s => { const d = kmToShop(s); if (d !== null) shopDistKm.set(s.id, d); });
        /* nearest first; shops without a pin keep their order after the ones with a distance */
        list.sort((a, b) => (shopDistKm.has(a.id) ? shopDistKm.get(a.id) : Infinity) - (shopDistKm.has(b.id) ? shopDistKm.get(b.id) : Infinity));
    }
    return list;
}

/* "850 m" / "2.4 km" / "18 km" — straight-line distance from the customer's pin */
function fmtDistance(km) {
    if (km < 1) return `${Math.max(10, Math.round(km * 1000 / 10) * 10)} m`;
    return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/* Distance label + nearest badge for the shop list */
function distBadge(s, isFirst) {
    if (!shopDistKm.has(s.id)) return '';
    const km = shopDistKm.get(s.id);
    return `<span class="xo-picker-dist" title="Straight-line distance from your pinned location"><i class="fa-solid fa-route"></i> ${fmtDistance(km)}</span>${isFirst ? '<span class="xo-picker-nearest">Nearest</span>' : ''}`;
}


/* ════ FILE INPUT ════ */
function initFileInput() {
    const input = document.getElementById('xoFileInput');
    if (!input || input._wired) return;
    input._wired = true;
    input.addEventListener('change', async e => {
        if (e.target.files.length > 0) await handleFiles(e.target.files);
        e.target.value = '';
    });
}

window.triggerUpload = function() {
    if (!currentUser && !localStorage.getItem('jasa_user_cache')) {
        showToast('Please sign in to upload documents.', 'error');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }
    document.getElementById('xoFileInput')?.click();
};

async function getPdfPageCount(file) {
    if (!file.name.toLowerCase().endsWith('.pdf') && !file.type.includes('pdf')) return 1;
    try {
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        return pdf.numPages;
    } catch(e) { return 1; }
}

async function handleFiles(files) {
    const overlay = document.getElementById('xoLoadingOverlay');
    if (overlay) overlay.style.display = 'flex';
    try {
        for (const file of Array.from(files)) {
            const pages = await getPdfPageCount(file);
            uploadedFiles.push({
                id:     'doc-' + Date.now() + Math.random().toString(36).substr(2, 5),
                fileObj: file,
                name:   file.name,
                type:   file.type.split('/')[1]?.toUpperCase() || 'FILE',
                pages,
                uploadStatus: 'pending',
                uploadedUrl:  '',
                uploadProgress: 0,
                uploadSpeed: '',
                uploadETA:   '',
                prices: { perPage: 0, binding: 0, lamination: 0, final: 0 },
                config: {
                    paperId:        xeroxConfig.paper[0]?.id || '',
                    color:          'bw',
                    format:         pages === 1 ? 'frontOnly' : 'both',
                    ratio:          '1:1',
                    bindingId:      'none',
                    laminationId:   'none',
                    quantity:       1,
                    colorPages:     '',
                    instructions:   '',
                    _showInstructions: false
                }
            });
        }
    } finally {
        if (overlay) overlay.style.display = 'none';
    }
    updateUIState();
    renderDocCards();
    showToast(`${files.length} file${files.length > 1 ? 's' : ''} added.`, 'success');
}

/* ════ UI STATE ════ */
function updateUIState() {
    const landing     = document.getElementById('xoLanding');
    const configSec   = document.getElementById('xoConfigSection');
    const fab         = document.getElementById('xoAddMoreBtn');
    const shopSel     = document.getElementById('xoShopSelector');
    const proceedBar  = document.getElementById('xoProceedFooter');
    const landingShops = document.getElementById('xoLandingShops');
    const hasFiles    = uploadedFiles.length > 0;

    landing.style.display      = hasFiles ? 'none'  : 'block';
    configSec.style.display    = hasFiles ? 'block' : 'none';
    fab.style.display          = hasFiles ? 'flex'  : 'none';
    if (shopSel)      shopSel.style.display      = hasFiles ? 'block' : 'none';
    if (proceedBar)   proceedBar.style.display   = hasFiles ? 'block' : 'none';
    // Landing shops: visible only when no files selected
    if (landingShops) landingShops.style.display = hasFiles ? 'none'  : 'block';
}

/* ════ MIXED COLOUR PAGES ════
   color: 'mixed' prints the pages listed in config.colorPages in colour and the
   rest in B&W. The list is free text ("1, 3, 5-8") so it is parsed on every use. */

/* Parse "1, 3, 5-8" into sorted unique page numbers within 1..maxPage.
   Tokens that are not numbers/ranges or fall outside the file go to `invalid`. */
function parsePageList(text, maxPage) {
    const set = new Set(), invalid = [];
    String(text || '')
        .replace(/\s*-\s*/g, '-')
        .split(/[,\s]+/)
        .filter(Boolean)
        .forEach(tok => {
            const m = tok.match(/^(\d+)(?:-(\d+))?$/);
            if (!m) { invalid.push(tok); return; }
            let a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
            if (a > b) [a, b] = [b, a];
            if (a < 1 || b > maxPage) { invalid.push(tok); return; }
            for (let p = a; p <= b; p++) set.add(p);
        });
    return { pages: [...set].sort((x, y) => x - y), invalid };
}

/* [1,2,3,7,9,10] → "1-3, 7, 9-10" */
function formatPageList(pages) {
    const out = [];
    for (let i = 0; i < pages.length; i++) {
        let j = i;
        while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
        out.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
        i = j;
    }
    return out.join(', ');
}

/* Valid colour pages of a mixed-mode file (empty for any other mode) */
function colorPagesOf(f) {
    return f.config.color === 'mixed' ? parsePageList(f.config.colorPages, f.pages).pages : [];
}

/* Human label for a doc's colour setting, e.g. "Mixed (colour p. 1, 24)" */
function colorText(cfg) {
    if (cfg.color === 'color') return 'Color';
    if (cfg.color === 'mixed') return `Mixed (colour p. ${cfg.colorPages || '—'})`;
    return 'B&W';
}

/* Binding name for a doc ('' when none). Works on live configs and on stored order
   configs, where the book placeholder has already been resolved into bindingSet. */
function bindingText(cfg) {
    if (cfg.bindingId === COMBINED_BINDING) return `${combinedBinding()?.name || 'Binding'} (combined book)`;
    if (!cfg.bindingId || cfg.bindingId === 'none') return '';
    const name = xeroxConfig.binding.find(b => b.id === cfg.bindingId)?.name || '';
    return cfg.bindingSet ? `${name || 'Binding'} (combined book)` : name;
}

/* Options allowed for a colour mode. Mixed prints on both machines, so it only
   gets the options both B&W and colour allow (or colour's, if they share none). */
function selectionFor(color, bwSel, colorSel) {
    if (color === 'color') return colorSel;
    if (color === 'mixed') {
        const both = bwSel.filter(v => colorSel.includes(v));
        return both.length ? both : colorSel;
    }
    return bwSel;
}

/* ════ COMBINED BOOK ════
   Files whose bindingId is COMBINED_BINDING are bound together as one book.
   The book's binding is charged once per copy, on the first file of the book,
   and every file in it prints `combinedBook.copies` times.                    */
const COMBINED_BINDING = '__combined';
let combinedBook = {
    enabled:    false,   // "Combine files into one book" switch
    pickerOpen: false,   // file-picker dropdown open?
    bindingId:  '',
    copies:     1,
    order:      [],      // doc ids, top → bottom
};

/* Book members in binding order. Files newly added to the book go to the end. */
function combinedMembers() {
    const pos = id => { const i = combinedBook.order.indexOf(id); return i === -1 ? Infinity : i; };
    const members = uploadedFiles
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => f.config.bindingId === COMBINED_BINDING)
        .sort((a, b) => (pos(a.f.id) - pos(b.f.id)) || (a.i - b.i))
        .map(({ f }) => f);
    combinedBook.order = members.map(f => f.id);
    return members;
}

/* Binding types offered by the active shop */
function activeBindingList() {
    const shopId = selectedShopId || selectedPickerShopId;
    return (shopId ? getShopXeroxConfig(shopId) : xeroxConfig).binding || [];
}

/* The book's binding type — falls back to the shop's first one if the saved id
   is not offered (e.g. after switching shop). */
function combinedBinding() {
    const list = activeBindingList();
    return list.find(b => b.id === combinedBook.bindingId) || list[0] || null;
}

/* ════ PRINT OPTIONS (per paper) ════
   A paper's option set (color / format / ratio / binding / lamination) comes from
   the shop's overrides (paper._shopOptions) or the global paper.options.
   Each is { enabled, selection } or { enabled, bw:{selection}, color:{selection} }.
   An option that is switched off — or saved with an empty selection, which the
   shop pricing form does whenever the admin leaves it unticked — does NOT restrict
   the customer; it just isn't a shop-specific limit.                           */
function activeOptCfg() {
    const id = selectedShopId || selectedPickerShopId;
    return id ? getShopXeroxConfig(id) : xeroxConfig;
}
function resolvePaper(paperId, cfg = activeOptCfg()) {
    return cfg.paper.find(p => p.id === paperId) || xeroxConfig.paper.find(p => p.id === paperId) || null;
}
function paperOpt(paper, key) {
    return (paper?._shopOptions || {})[key] || (paper?.options || {})[key] || null;
}
/* Allowed values of an option for a colour panel ('bw' | 'color'), or `fallback` when unrestricted */
function optSelection(opt, panel, fallback) {
    if (!opt || opt.enabled === false) return fallback;
    const sel = opt[panel]?.selection ?? opt.selection;
    return Array.isArray(sel) && sel.length ? sel : fallback;
}

/* Which colour modes a file may use on this paper.
   Colour needs a colour price — but before a shop is picked the standard rates
   are only an estimate, so colour stays selectable (the shop's own price applies
   when it is picked). B&W is always kept when colour is not possible, so the
   customer is never left without a choice. Mixed needs 2+ pages. */
function colorModesFor(paper, pages) {
    const sel     = optSelection(paperOpt(paper, 'color'), 'x', ['bw', 'color']);
    const cp      = paper?.colorPrices || {};
    const priced  = Number(cp.frontOnly) > 0 || Number(cp.frontBack) > 0;
    const shopSet = !!(selectedShopId || selectedPickerShopId);
    const colourPossible = priced || !shopSet;
    const color = sel.includes('color') && colourPossible;
    const bw    = sel.includes('bw') || !color;
    return { bw, color, mixed: pages > 1 && colourPossible, priced };
}

/* Snap a file's colour, format and ratio to what `paper` allows (after a paper or shop change) */
function snapDocOptions(f, paper) {
    const c = f.config;
    const modes = colorModesFor(paper, f.pages);
    if (!modes[c.color]) c.color = modes.bw ? 'bw' : 'color';
    const fmt = selectionFor(c.color,
        optSelection(paperOpt(paper, 'format'), 'bw',    ['frontOnly', 'both']),
        optSelection(paperOpt(paper, 'format'), 'color', ['frontOnly', 'both']));
    if (!fmt.includes(c.format)) c.format = fmt[0] || 'frontOnly';
    if (f.pages === 1) c.format = 'frontOnly';
    const rat = selectionFor(c.color,
        optSelection(paperOpt(paper, 'ratio'), 'bw',    ['1:1', '1:2']),
        optSelection(paperOpt(paper, 'ratio'), 'color', ['1:1', '1:2']));
    if (!rat.includes(c.ratio)) c.ratio = rat[0] || '1:1';
}

/* Pages per side, in words (config.ratio stays '1:1' / '1:2' — the values the server prices) */
function ratioText(ratio) {
    return ratio === '1:2' ? '2 pages per side' : '1 page per side';
}

/* The shop is picked after the options: move every file onto papers / bindings /
   laminations this shop offers. Returns short descriptions of what changed. */
function fitDocsToShop(shopId) {
    const cfg = getShopXeroxConfig(shopId);
    const changes = [];
    const nameOf = (list, id) => list.find(x => x.id === id)?.name || xeroxConfig.paper.find(x => x.id === id)?.name || 'previous';
    const prevShop = selectedPickerShopId, prevSel = selectedShopId;
    selectedPickerShopId = shopId; selectedShopId = null;      /* colorModesFor() looks at the picked shop */
    try {
        uploadedFiles.forEach((f, i) => {
            const c = f.config, label = `Doc ${i + 1}`;
            const before = { color: c.color, format: c.format, ratio: c.ratio };
            if (cfg.paper.length && !cfg.paper.some(p => p.id === c.paperId)) {
                const from = nameOf(xeroxConfig.paper, c.paperId);
                c.paperId = cfg.paper[0].id;
                changes.push(`${label} paper ${from} → ${cfg.paper[0].name || 'available paper'}`);
            }
            const paper = cfg.paper.find(p => p.id === c.paperId) || xeroxConfig.paper.find(p => p.id === c.paperId);
            if (paper) snapDocOptions(f, paper);
            if (before.color !== c.color)   changes.push(`${label} ${colorText({ color: before.color, colorPages: c.colorPages })} → ${colorText(c)}`);
            if (before.format !== c.format) changes.push(`${label} ${c.format === 'both' ? 'front & back' : 'front only'}`);
            if (before.ratio !== c.ratio)   changes.push(`${label} ${ratioText(c.ratio)}`);
            if (c.bindingId && c.bindingId !== 'none' && c.bindingId !== COMBINED_BINDING && !cfg.binding.some(b => b.id === c.bindingId)) {
                c.bindingId = 'none';
                changes.push(`${label} binding removed`);
            }
            if (c.laminationId && c.laminationId !== 'none' && !cfg.lamination.some(l => l.id === c.laminationId)) {
                c.laminationId = 'none';
                changes.push(`${label} lamination removed`);
            }
        });
    } finally {
        selectedPickerShopId = prevShop; selectedShopId = prevSel;
    }
    return changes;
}

/* ════ PRICING ENGINE ════ */

/* Shop rate for one print: frontOnly is per side, frontBack is per sheet */
function rateFor(priceObj, format) {
    const p = priceObj || {};
    return format === 'both' ? (p.frontBack ?? p.frontOnly ?? 0) : (p.frontOnly ?? 0);
}

/* Printing cost of one copy (no binding / lamination).
   Pages go `ratio` per side and 1 or 2 sides per sheet; a side is colour if any
   page on it is colour. A duplex sheet is charged the B&W rate, the colour rate,
   or — when one side is colour and the other B&W — the average of the two.
   A blank back counts as the same as its front, so all-B&W / all-colour docs
   cost exactly ceil(pages / pagesPerSheet) × rate, as before.                 */
function printCost(pages, isColorPage, ratio, format, bwRate, colorRate) {
    const perSide = ratio === '1:2' ? 2 : 1;
    const sides   = Math.ceil(pages / perSide);
    const colorSide = s => {
        for (let p = s * perSide + 1; p <= Math.min((s + 1) * perSide, pages); p++) {
            if (isColorPage(p)) return true;
        }
        return false;
    };
    let cost = 0;
    if (format === 'both') {
        for (let s = 0; s < sides; s += 2) {
            const front = colorSide(s);
            const back  = s + 1 < sides ? colorSide(s + 1) : front;
            cost += front && back ? colorRate : (front || back) ? (bwRate + colorRate) / 2 : bwRate;
        }
    } else {
        for (let s = 0; s < sides; s++) cost += colorSide(s) ? colorRate : bwRate;
    }
    return cost;
}

function calculatePrices() {
    /* Use shop-specific config if a shop is selected, otherwise fall back to global */
    const shopId  = selectedShopId || selectedPickerShopId;
    const cfg4prc = shopId ? getShopXeroxConfig(shopId) : xeroxConfig;
    const members = combinedMembers();
    const book    = members.length ? combinedBinding() : null;

    uploadedFiles.forEach(f => {
        const cfg     = f.config;
        const paper   = cfg4prc.paper.find(p => p.id === cfg.paperId)
                     || xeroxConfig.paper.find(p => p.id === cfg.paperId); /* global fallback */
        if (!paper) { f.prices = { perPage:0, binding:0, lamination:0, final:0, colorPages:0 }; return; }

        /* Every file in the book prints as many times as the book */
        const inBook = cfg.bindingId === COMBINED_BINDING;
        if (inBook) cfg.quantity = combinedBook.copies;

        const bwRate    = rateFor(paper.bwPrices,    cfg.format);
        const colorRate = rateFor(paper.colorPrices, cfg.format);
        const colorSet  = new Set(colorPagesOf(f));
        const isColorPage = cfg.color === 'color' ? () => true : p => colorSet.has(p);

        const binding     = inBook
            ? (members[0] === f ? book : null)   /* book binding charged once, on its first file */
            : (cfg4prc.binding.find(b => b.id === cfg.bindingId)
               || xeroxConfig.binding.find(b => b.id === cfg.bindingId));
        const lamination  = (cfg4prc.lamination.find(l => l.id === cfg.laminationId)
                          || xeroxConfig.lamination.find(l => l.id === cfg.laminationId));
        const bindPrice   = binding    ? (binding.price    || 0) : 0;
        const lamPrice    = lamination ? (lamination.price || 0) : 0;

        f.prices.perPage    = cfg.color === 'color' ? colorRate : bwRate;
        f.prices.colorRate  = colorRate;
        f.prices.colorPages = colorSet.size;
        f.prices.binding    = bindPrice;
        f.prices.lamination = lamPrice;
        f.prices.final = (printCost(f.pages, isColorPage, cfg.ratio, cfg.format, bwRate, colorRate)
                          + bindPrice + lamPrice) * cfg.quantity;
    });
}

/* Re-render the doc cards + totals for whichever screen is showing */
function rerenderDocs() {
    if (_inStep5()) {
        const shopCfg = getShopXeroxConfig(selectedPickerShopId);
        renderStep5Docs(shopCfg);
        renderStep5UploadRows();
        updateStep5Summary(shopCfg);
    } else {
        renderDocCards();
    }
}

/* False (with a toast + highlight) when a doc can't be ordered as configured:
   a mixed-colour file with no colour pages, or a book with fewer than 2 files. */
function checkDocConfigs() {
    if (combinedBook.enabled && combinedMembers().length < 2) {
        showToast('Tick at least 2 files to combine, or turn off "Combine files".', 'warning');
        const book = [...document.querySelectorAll('.xo-book-card')].find(el => el.offsetParent !== null);
        if (book) {
            book.classList.add('error');
            setTimeout(() => book.classList.remove('error'), 1600);
            book.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return false;
    }
    const i = uploadedFiles.findIndex(f => f.config.color === 'mixed' && !colorPagesOf(f).length);
    if (i === -1) return true;
    showToast(`Doc ${i + 1}: enter the pages to print in colour.`, 'warning');
    const card = document.getElementById(`docCard-${i}`);
    if (card) {
        card.classList.add('error');
        setTimeout(() => card.classList.remove('error'), 1600);
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return false;
}

/* Config as stored on the order: the colour-page list is normalised and the
   combined-book placeholder is replaced by the real binding plus the book
   layout, so the shop knows what to print in colour and what to bind together. */
function orderConfig(f) {
    const cfg = { ...f.config };
    if (cfg.color === 'mixed') {
        const pages = colorPagesOf(f);
        cfg.colorPages     = formatPageList(pages);
        cfg.colorPageCount = pages.length;
    }
    if (cfg.bindingId === COMBINED_BINDING) {
        const members = combinedMembers();
        cfg.bindingId = combinedBinding()?.id || 'none';
        cfg.bindingSet = {
            position:   members.indexOf(f) + 1,
            size:       members.length,
            chargedHere: members[0] === f,
            files:      members.map(m => m.name),
        };
    }
    return cfg;
}

/* Documents as stored on the order. `price` is a placeholder — the server sets it. */
function buildOrderDocuments() {
    return uploadedFiles.map(f => {
        const cfg    = orderConfig(f);
        const pName  = xeroxConfig.paper.find(p => p.id === cfg.paperId)?.name || 'Standard';
        let uploadedUrl = '';
        if (f.uploadStatus === 'uploaded')      uploadedUrl = f.uploadedUrl || f.config.selectedUrl || '';
        else if (f.uploadStatus === 'whatsapp') uploadedUrl = 'pending_whatsapp';
        else if (f.uploadStatus === 'later')    uploadedUrl = 'pending_later';
        return {
            fileOrderId: genId(), name: f.name, pages: f.pages,
            uploadedUrl, uploadStatus: f.uploadStatus, price: f.prices.final,
            configDescription: `${f.pages} pgs | ${pName} | ${colorText(cfg).toUpperCase()} | Qty:${cfg.quantity}`,
            config: cfg,
            requiresManualEstimation: false,
        };
    });
}

/* Documents + delivery as shown in the checkout sheet (same delivery rules as the server) */
function shownXeroxTotal(isPickup) {
    calculatePrices();
    const subtotal = uploadedFiles.reduce((s, f) => s + f.prices.final, 0);
    const shop  = shopById(selectedShopId);
    const rules = shop?.deliveryPrices?.xerox || [];
    const free  = rules.find(r => Number(r.fee) === 0);
    const rule  = rules.find(r => subtotal >= Number(r.min) && (r.max == null || subtotal <= Number(r.max)));
    const fee   = (isPickup || (free && subtotal >= Number(free.min))) ? 0 : Number(rule?.fee) || 0;
    return subtotal + fee;
}

/* Prices the order on the server (POST /api/orders/quote). Firestore rules only
   accept an order whose documents, subtotal and delivery fee equal the quote.
   If the shop's current price differs from what was shown (e.g. a cached price
   list), the customer confirms the new total first.
   Returns { documents, subtotal, deliveryFee }.                               */
async function quoteXeroxOrder(groupOrderId, isPickup) {
    const shown = shownXeroxTotal(isPickup);
    let q;
    try {
        q = await quoteOrder(currentUser, {
            groupOrderId, type: 'xerox', isPickup,
            groups: [{ shopId: selectedShopId, documents: buildOrderDocuments() }],
        });
    } catch (e) { e.isQuote = true; throw e; }
    const g = q.groups[0];
    if (priceChanged(shown, g.subtotal + g.deliveryFee)) {
        const now = g.subtotal + g.deliveryFee;
        const ok  = await new Promise(resolve => showConfirm({
            title: 'Price updated',
            msg:   `The shop's current price for this order is ₹${now.toFixed(2)} (you saw ₹${shown.toFixed(2)}). Place the order at this price?`,
            okLabel: 'Continue', okDanger: false,
            onOk: () => resolve(true), onCancel: () => resolve(false),
        }));
        if (!ok) {
            const err = new Error('Order not placed.');
            err.isQuote = true;
            throw err;
        }
    }
    return g;
}

/* ════ RENDER DOC CARDS ════ */
function renderDocCards() {
    calculatePrices();
    const container = document.getElementById('xoDocCards');
    if (!container) return;
    container.innerHTML = buildCombinedBookCard() + uploadedFiles.map((f, i) => buildDocCard(f, i)).join('');
    afterDocsRender(container);
    renderFinalSummary();
}

function buildDocCard(f, i) {
    const cfg = f.config;

    /* ── Resolve shop config if a shop is selected ── */
    const activeShopId = selectedShopId || selectedPickerShopId;
    const shopCfg      = activeShopId ? getShopXeroxConfig(activeShopId) : null;

    /* Paper list: shop-filtered if available, else global */
    const paperList = shopCfg ? shopCfg.paper : xeroxConfig.paper;

    /* Find the selected paper in the resolved list, fall back to global */
    const paper     = paperList.find(p => p.id === cfg.paperId)
                   || xeroxConfig.paper.find(p => p.id === cfg.paperId);

    /* Option sets for this paper — shop overrides first, then the global options (see paperOpt) */
    const formatOpt = paperOpt(paper, 'format');
    const ratioOpt  = paperOpt(paper, 'ratio');
    const bindOpt   = paperOpt(paper, 'binding');
    const lamOpt    = paperOpt(paper, 'lamination');

    /* Which option controls are shown. Colour is always shown: customers must be
       able to choose colour or black & white. */
    const formatEnabled = !formatOpt || formatOpt.enabled !== false;
    const ratioEnabled  = ratioOpt?.enabled === true;
    const bindEnabled   = !bindOpt   || bindOpt.enabled   !== false;
    const lamEnabled    = !lamOpt    || lamOpt.enabled     !== false;

    const modes = colorModesFor(paper, f.pages);

    /* Format / ratio choices for the active colour mode */
    const activeFmtSel = selectionFor(cfg.color,
        optSelection(formatOpt, 'bw',    ['frontOnly', 'both']),
        optSelection(formatOpt, 'color', ['frontOnly', 'both']));
    const activeRatSel = selectionFor(cfg.color,
        optSelection(ratioOpt, 'bw',    ['1:1', '1:2']),
        optSelection(ratioOpt, 'color', ['1:1', '1:2']));

    const inBook = cfg.bindingId === COMBINED_BINDING;

    /* ── Dropdown options ── */
    const paperOpts = paperList.map(p =>
        `<option value="${p.id}" ${cfg.paperId === p.id ? 'selected' : ''}>${p.name}</option>`
    ).join('');

    /* Binding list: shop-filtered if available */
    const bindingList = shopCfg ? shopCfg.binding : xeroxConfig.binding;
    /* If shop has a binding sub-selection for this paper, further filter */
    const bindSelIds  = bindOpt?.enabled !== false && bindOpt?.selection?.length ? bindOpt.selection : null;
    const filteredBinding = bindSelIds
        ? bindingList.filter(b => bindSelIds.includes(b.id))
        : bindingList;
    /* Files in the combined book are bound by the book panel ("Combine files") */
    const bookPos  = inBook ? combinedMembers().indexOf(f) + 1 : 0;
    const bindOpts = `<option value="none">No Binding</option>` +
        filteredBinding.map(b =>
            `<option value="${b.id}" ${cfg.bindingId === b.id ? 'selected' : ''}>${b.name}</option>`
        ).join('');

    /* Lamination list: shop-filtered if available */
    const laminationList = shopCfg ? shopCfg.lamination : xeroxConfig.lamination;
    const lamSelIds      = lamOpt?.enabled !== false && lamOpt?.selection?.length ? lamOpt.selection : null;
    const filteredLam    = lamSelIds
        ? laminationList.filter(l => lamSelIds.includes(l.id))
        : laminationList;
    const lamOpts = `<option value="none">No Lamination</option>` +
        filteredLam.map(l =>
            `<option value="${l.id}" ${cfg.laminationId === l.id ? 'selected' : ''}>${l.name}</option>`
        ).join('');

    /* Segmented button (colour / ratio) */
    const seg = (key, value, active, enabled, inner, why = '') => `
                    <button type="button" class="xo-seg-btn ${active ? 'active' : ''}" role="radio" aria-checked="${active}"
                            ${enabled ? '' : 'disabled'} ${why ? `title="${h(why)}"` : ''}
                            onclick="updateConfig(${i},'${key}','${value}')">${inner}</button>`;

    const colourWhy = !modes.color
        ? (modes.priced || !(selectedShopId || selectedPickerShopId)
            ? 'Colour is not offered on this paper'
            : 'This shop has no colour price for this paper')
        : '';

    /* Sheets used per copy — makes "pages per side" concrete */
    const perSide = cfg.ratio === '1:2' ? 2 : 1;
    const sheets  = Math.ceil(Math.ceil(f.pages / perSide) / (cfg.format === 'both' ? 2 : 1));

    // Build each option block as a keyed map, then render in admin-defined order
    const optionBlocks = {
        color: `
            <div class="xo-config-group full">
                <label class="xo-config-label">Print colour</label>
                <div class="xo-seg" role="radiogroup" aria-label="Print colour">
                    ${seg('color', 'bw', cfg.color === 'bw', modes.bw,
                        `<span class="xo-seg-swatch xo-seg-swatch--bw"></span><span class="xo-seg-text">Black &amp; White</span>`)}
                    ${seg('color', 'color', cfg.color === 'color', modes.color,
                        `<span class="xo-seg-swatch xo-seg-swatch--color"></span><span class="xo-seg-text">Colour</span>`, colourWhy)}
                    ${f.pages > 1 ? seg('color', 'mixed', cfg.color === 'mixed', modes.mixed,
                        `<span class="xo-seg-swatch xo-seg-swatch--mixed"></span><span class="xo-seg-text">Mixed<small>some pages colour</small></span>`,
                        modes.mixed ? '' : colourWhy) : ''}
                </div>
                ${!modes.color && colourWhy ? `<div class="xo-seg-hint"><i class="fa-solid fa-circle-info"></i> ${h(colourWhy)} — try another paper type${selectedPickerShopId && !selectedShopId ? ' or shop' : ''}.</div>` : ''}
            </div>
            ${cfg.color === 'mixed' ? buildColorPagesEditor(f, i) : ''}`,

        format: formatEnabled ? `
            <div class="xo-config-group">
                <label class="xo-config-label">Format</label>
                <select class="xo-select" onchange="updateConfig(${i},'format',this.value)">
                    ${activeFmtSel.includes('frontOnly') ? `<option value="frontOnly" ${cfg.format==='frontOnly'?'selected':''}>Front Only</option>` : ''}
                    ${activeFmtSel.includes('both')      ? `<option value="both" ${cfg.format==='both'?'selected':''} ${f.pages===1?'disabled':''}>Front &amp; Back</option>` : ''}
                </select>
            </div>` : '',

        /* Pages per side of the paper. Values stay '1:1' / '1:2' (what the server prices). */
        ratio: ratioEnabled ? `
            <div class="xo-config-group full">
                <label class="xo-config-label">Pages on each side of the paper</label>
                <div class="xo-seg xo-seg--ratio" role="radiogroup" aria-label="Pages on each side of the paper">
                    ${activeRatSel.includes('1:1') ? seg('ratio', '1:1', cfg.ratio !== '1:2', true,
                        `<span class="xo-ratio-icon" aria-hidden="true"><i></i></span><span class="xo-seg-text">1 page per side<small>Normal size</small></span>`) : ''}
                    ${activeRatSel.includes('1:2') ? seg('ratio', '1:2', cfg.ratio === '1:2', true,
                        `<span class="xo-ratio-icon xo-ratio-icon--2" aria-hidden="true"><i></i><i></i></span><span class="xo-seg-text">2 pages per side<small>Half size · saves paper</small></span>`) : ''}
                </div>
                <div class="xo-seg-hint">${f.pages} page${f.pages === 1 ? '' : 's'} → about ${sheets} sheet${sheets === 1 ? '' : 's'} per copy${cfg.format === 'both' ? ' (front &amp; back)' : ''}</div>
            </div>` : '',

        binding: inBook ? `
            <div class="xo-config-group">
                <label class="xo-config-label">Binding</label>
                <button type="button" class="xo-book-tag" onclick="scrollToBook()" title="Bound with the other files in the book">
                    <i class="fa-solid fa-book"></i> In book · #${bookPos}
                </button>
            </div>` : bindEnabled ? `
            <div class="xo-config-group">
                <label class="xo-config-label">Binding</label>
                <select class="xo-select" onchange="updateConfig(${i},'bindingId',this.value)">${bindOpts}</select>
            </div>` : '',

        lamination: lamEnabled ? `
            <div class="xo-config-group">
                <label class="xo-config-label">Lamination</label>
                <select class="xo-select" onchange="updateConfig(${i},'laminationId',this.value)">${lamOpts}</select>
            </div>` : '',
    };

    // Render in admin-defined order (falls back to default if not set)
    const order = [...(paper?.optionsOrder || ['color','format','ratio','binding','lamination'])];
    /* Colour (for Mixed) and Binding (for Combine) must show even if the admin's order omits them */
    ['color', 'binding'].forEach(k => { if (!order.includes(k)) order.push(k); });
    const orderedOptions = order.map(key => optionBlocks[key] || '').join('');

    return `
    <div class="xo-doc-card" id="docCard-${i}">
        <div class="xo-doc-card-head">
            <span class="xo-doc-card-label">Doc ${i+1}</span>
            <span class="xo-doc-card-name" title="${esc(f.name)}">${f.name}</span>
            <button class="xo-doc-remove" onclick="removeDoc(${i})" title="Remove"><i class="fa-solid fa-trash-can"></i></button>
        </div>
        <div class="xo-doc-body">
            <div class="xo-doc-meta">
                <div class="xo-doc-meta-item"><strong>${f.pages}</strong>Pages</div>
                <div class="xo-doc-meta-item"><strong>${f.type}</strong>Type</div>
            </div>
            <div class="xo-config-grid">
                <div class="xo-config-group">
                    <label class="xo-config-label">Paper Type</label>
                    <select class="xo-select" onchange="updateConfig(${i},'paperId',this.value)">${paperOpts}</select>
                </div>
                <div class="xo-config-group">
                    <label class="xo-config-label">Quantity</label>
                    ${inBook ? `
                    <div class="xo-qty-locked" title="Copies are set for the whole combined book">
                        <i class="fa-solid fa-book"></i> ×${cfg.quantity} <span>(book copies)</span>
                    </div>` : `
                    <div class="xo-qty-counter">
                        <button class="xo-qty-btn" type="button" onclick="updateQty(${i},-1)" title="Decrease quantity"><i class="fa-solid fa-minus"></i></button>
                        <input type="number" min="1" max="9999" class="xo-qty-val" value="${cfg.quantity}" oninput="setQty(${i}, this.value)" onblur="onQtyBlur(${i}, this)" onclick="this.select()">
                        <button class="xo-qty-btn" type="button" onclick="updateQty(${i},1)" title="Increase quantity"><i class="fa-solid fa-plus"></i></button>
                    </div>`}
                </div>
                ${orderedOptions}
                <div class="xo-config-group full" style="display:flex;align-items:center;justify-content:space-between;">
                    <label class="xo-config-label">Special Instructions</label>
                    <button class="xo-instructions-toggle" onclick="toggleInstructions(${i})">
                        <i class="fa-solid fa-pencil"></i> ${cfg.instructions ? 'Edit' : 'Add'}
                    </button>
                </div>
                ${cfg._showInstructions ? `
                <div class="xo-config-group full">
                    <textarea class="xo-textarea" rows="2" placeholder="e.g. Use 100 GSM paper, pack carefully…" oninput="uploadedFiles[${i}].config.instructions=this.value;renderFinalSummary();">${cfg.instructions}</textarea>
                </div>` : ''}
            </div>
        </div>
        <div class="xo-doc-price">
            ${cfg.color === 'mixed' ? `
            <div class="xo-doc-price-row">
                <span class="xo-doc-price-label">B&amp;W / Colour rate</span>
                <span class="xo-doc-price-val">₹${f.prices.perPage.toFixed(2)} / ₹${f.prices.colorRate.toFixed(2)}</span>
            </div>
            <div class="xo-doc-price-row">
                <span class="xo-doc-price-label">Pages</span>
                <span class="xo-doc-price-val">${f.prices.colorPages} colour · ${f.pages - f.prices.colorPages} B&amp;W</span>
            </div>` : `
            <div class="xo-doc-price-row">
                <span class="xo-doc-price-label">Price per page</span>
                <span class="xo-doc-price-val">₹${f.prices.perPage.toFixed(2)}</span>
            </div>`}
            ${f.prices.binding > 0 ? `<div class="xo-doc-price-row"><span class="xo-doc-price-label">${inBook ? 'Book binding' : 'Binding'}</span><span class="xo-doc-price-val">+ ₹${f.prices.binding.toFixed(2)}</span></div>` : ''}
            ${inBook && !f.prices.binding ? `<div class="xo-doc-price-row"><span class="xo-doc-price-label">Binding</span><span class="xo-doc-price-val">In combined book</span></div>` : ''}
            ${f.prices.lamination > 0 ? `<div class="xo-doc-price-row"><span class="xo-doc-price-label">Lamination</span><span class="xo-doc-price-val">+ ₹${f.prices.lamination.toFixed(2)}</span></div>` : ''}
            <div class="xo-doc-price-row total">
                <span class="xo-doc-price-label">Total</span>
                <span class="xo-doc-price-val">₹${f.prices.final.toFixed(2)}</span>
            </div>
        </div>
    </div>`;
}

/* Colour-page picker for a mixed-mode doc: quick picks + free-text list */
function buildColorPagesEditor(f, i) {
    const { pages, invalid } = parsePageList(f.config.colorPages, f.pages);
    const current = formatPageList(pages);
    const quick = [
        ['First page',   '1'],
        ['Last page',    `${f.pages}`],
        ['First & last', `1, ${f.pages}`],
    ];
    const hint = invalid.length
        ? `<span class="xo-cp-hint--err">Ignored: ${esc(invalid.join(', '))} — this file has ${f.pages} pages</span>`
        : pages.length
            ? `${pages.length} colour · ${f.pages - pages.length} B&amp;W page${f.pages - pages.length === 1 ? '' : 's'}`
            : `<span class="xo-cp-hint--err">Pick the pages to print in colour</span>`;
    return `
            <div class="xo-config-group full">
                <label class="xo-config-label">Colour pages (rest print B&amp;W)</label>
                <div class="xo-cp-chips">
                    ${quick.map(([label, val]) => `
                    <button type="button" class="xo-cp-chip ${current === formatPageList(parsePageList(val, f.pages).pages) ? 'active' : ''}"
                            onclick="setColorPages(${i}, '${val}')">${label}</button>`).join('')}
                </div>
                <input type="text" class="xo-text-input" inputmode="numeric" value="${esc(f.config.colorPages)}"
                       placeholder="e.g. 1, 3, 5-8" onchange="setColorPages(${i}, this.value)"
                       onkeydown="if(event.key==='Enter')this.blur()">
                <div class="xo-cp-hint">${hint}</div>
                ${pages.length && !(f.prices.colorRate > 0) ? `<div class="xo-cp-hint"><span class="xo-cp-hint--err">This shop hasn't set a colour price for this paper, so colour pages are charged ₹0 here. The shop may ask for the difference.</span></div>` : ''}
            </div>`;
}

/* "Combine files into one book" panel, shown above the document cards once
   there are 2+ files: a switch, a dropdown to pick which files go in the book,
   a page-order preview (first-page thumbnails, drag to reorder) and the book's
   binding type + copies. Files left out print on their own.                 */
function buildCombinedBookCard() {
    const on = combinedBook.enabled;
    if (uploadedFiles.length < 2 && !on) return '';

    const toggle = `
        <label class="xo-book-toggle">
            <span class="xo-book-toggle-icon"><i class="fa-solid fa-book"></i></span>
            <span class="xo-book-toggle-text">
                <span class="xo-book-title">Combine files into one book</span>
                <span class="xo-book-sub">Bind several files together as a single spiral / binding</span>
            </span>
            <input type="checkbox" class="xo-switch-input" ${on ? 'checked' : ''} onchange="toggleCombine(this.checked)">
            <span class="xo-switch" aria-hidden="true"></span>
        </label>`;
    if (!on) return `<div class="xo-book-card">${toggle}</div>`;

    const members    = combinedMembers();
    const standalone = uploadedFiles.filter(f => f.config.bindingId !== COMBINED_BINDING);
    const book       = combinedBinding();
    const totalPages = members.reduce((s, f) => s + f.pages, 0);

    const picker = `
        <details class="xo-book-picker" ${combinedBook.pickerOpen ? 'open' : ''} ontoggle="setBookPickerOpen(this.open)">
            <summary>
                <span class="xo-book-picker-label"><i class="fa-solid fa-list-check"></i> Files in the book</span>
                <span class="xo-book-picker-count">${members.length} of ${uploadedFiles.length}</span>
                <i class="fa-solid fa-chevron-down xo-book-picker-caret"></i>
            </summary>
            <div class="xo-book-picker-list">
                ${uploadedFiles.map(f => `
                <label class="xo-book-pick">
                    <input type="checkbox" ${f.config.bindingId === COMBINED_BINDING ? 'checked' : ''} onchange="toggleBookFile('${f.id}', this.checked)">
                    <span class="xo-book-pick-box"><i class="fa-solid fa-check"></i></span>
                    <span class="xo-book-pick-name" title="${esc(f.name)}">${esc(f.name)}</span>
                    <span class="xo-book-pick-pages">${f.pages} pg</span>
                </label>`).join('')}
            </div>
        </details>`;

    let next = 1;
    const rows = members.map((f, n) => {
        const from = next, to = next + f.pages - 1;
        next = to + 1;
        return `
            <li class="xo-book-file" data-id="${f.id}">
                <span class="xo-book-handle" title="Drag to reorder" aria-label="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
                <span class="xo-book-thumb" data-thumb="${f.id}">${f.thumb ? `<img src="${f.thumb}" alt="">` : '<i class="fa-regular fa-file-lines"></i>'}<span class="xo-book-file-num">${n + 1}</span></span>
                <span class="xo-book-file-info">
                    <span class="xo-book-file-name" title="${esc(f.name)}">${esc(f.name)}</span>
                    <span class="xo-book-file-range">${f.pages === 1 ? `Book page ${from}` : `Book pages ${from}–${to}`}</span>
                </span>
                <span class="xo-book-moves">
                    <button type="button" class="xo-book-move" onclick="moveInBook('${f.id}',-1)" ${n === 0 ? 'disabled' : ''} title="Move up"><i class="fa-solid fa-chevron-up"></i></button>
                    <button type="button" class="xo-book-move" onclick="moveInBook('${f.id}',1)" ${n === members.length - 1 ? 'disabled' : ''} title="Move down"><i class="fa-solid fa-chevron-down"></i></button>
                </span>
            </li>`;
    }).join('');

    const bindOpts = activeBindingList().map(b =>
        `<option value="${b.id}" ${book?.id === b.id ? 'selected' : ''}>${esc(b.name)}${b.price ? ` — ₹${Number(b.price).toFixed(2)}` : ''}</option>`).join('')
        || `<option value="">Shop's own binding</option>`;

    return `
    <div class="xo-book-card is-on" id="xoBookCard">
        ${toggle}
        <div class="xo-book-body">
            ${picker}
            ${members.length < 2 ? `
            <div class="xo-book-note"><i class="fa-solid fa-circle-info"></i> Tick at least 2 files to combine them into one book.</div>` : ''}
            ${members.length ? `
            <div class="xo-book-order-head">
                <span>Page order</span>
                <span class="xo-book-order-hint"><i class="fa-solid fa-grip-vertical"></i> Drag to rearrange</span>
            </div>
            <ol class="xo-book-list">${rows}</ol>` : ''}
            <div class="xo-config-grid">
                <div class="xo-config-group full">
                    <label class="xo-config-label">Binding type</label>
                    <select class="xo-select" onchange="setBookBinding(this.value)">${bindOpts}</select>
                </div>
                <div class="xo-config-group">
                    <label class="xo-config-label">Book copies</label>
                    <div class="xo-qty-counter">
                        <button class="xo-qty-btn" type="button" onclick="setBookCopies(${combinedBook.copies - 1})" title="Decrease copies"><i class="fa-solid fa-minus"></i></button>
                        <input type="number" min="1" max="9999" class="xo-qty-val" value="${combinedBook.copies}" onchange="setBookCopies(this.value)" onclick="this.select()">
                        <button class="xo-qty-btn" type="button" onclick="setBookCopies(${combinedBook.copies + 1})" title="Increase copies"><i class="fa-solid fa-plus"></i></button>
                    </div>
                </div>
            </div>
            <div class="xo-book-foot">
                <div><strong>${members.length} file${members.length === 1 ? '' : 's'} · ${totalPages} pages</strong> bound as one book${combinedBook.copies > 1 ? ` × ${combinedBook.copies} copies` : ''}</div>
                <div>${book
                    ? `${esc(book.name)} ₹${(book.price || 0).toFixed(2)}${combinedBook.copies > 1 ? ` × ${combinedBook.copies}` : ''} — charged once per book`
                    : 'No binding price set by this shop — bound at no extra charge'}</div>
                ${standalone.length ? `<div class="xo-book-foot-alone"><i class="fa-regular fa-file"></i> Printed separately: ${standalone.map(f => esc(f.name)).join(', ')}</div>` : ''}
            </div>
        </div>
    </div>`;
}

/* After the cards are (re)rendered: drag-to-reorder + first-page thumbnails */
function afterDocsRender(container) {
    const list = container?.querySelector('.xo-book-list');
    if (!list) return;
    if (typeof Sortable !== 'undefined') {
        Sortable.create(list, {
            handle: '.xo-book-handle', animation: 160,
            ghostClass: 'xo-book-ghost', chosenClass: 'xo-book-chosen',
            onEnd: () => setBookOrder([...list.children].map(li => li.dataset.id)),
        });
    }
    combinedMembers().forEach(makeBookThumb);
}

/* First page of a file as a small image for the book preview (cached on the file) */
async function makeBookThumb(f) {
    if (f.thumb || f._thumbBusy || !f.fileObj) return;
    f._thumbBusy = true;
    try {
        if (/^image\//.test(f.fileObj.type)) {
            f.thumb = URL.createObjectURL(f.fileObj);
        } else if (typeof pdfjsLib !== 'undefined') {
            const pdf  = await pdfjsLib.getDocument({ data: await f.fileObj.arrayBuffer() }).promise;
            const page = await pdf.getPage(1);
            const vp   = page.getViewport({ scale: 96 / page.getViewport({ scale: 1 }).width });
            const c    = document.createElement('canvas');
            c.width = vp.width; c.height = vp.height;
            await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
            f.thumb = c.toDataURL('image/jpeg', 0.75);
            pdf.destroy?.();
        }
    } catch (_) { /* no preview — the file icon stays */ }
    finally { f._thumbBusy = false; }
    if (f.thumb) {
        document.querySelectorAll(`[data-thumb="${f.id}"]`).forEach(el => {
            const num = el.querySelector('.xo-book-file-num')?.outerHTML || '';
            el.innerHTML = `<img src="${f.thumb}" alt="">${num}`;
        });
    }
}

function addToBook(f) {
    if (f.config.bindingId === COMBINED_BINDING) return;
    f._before = { bindingId: f.config.bindingId, quantity: f.config.quantity };
    f.config.bindingId = COMBINED_BINDING;
}

function removeFromBook(f) {
    if (f.config.bindingId !== COMBINED_BINDING) return;
    f.config.bindingId = f._before?.bindingId || 'none';
    if (f._before?.quantity) f.config.quantity = f._before.quantity;
}

/* ════ DOC CONFIG ACTIONS ════ */

window.setColorPages = function(i, text) {
    uploadedFiles[i].config.colorPages = String(text || '').trim();
    rerenderDocs();
};

window.moveInBook = function(id, delta) {
    combinedMembers();   /* syncs combinedBook.order with the current members */
    const order = combinedBook.order;
    const from  = order.indexOf(id), to = from + delta;
    if (from === -1 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    rerenderDocs();
};

window.toggleCombine = function(on) {
    combinedBook.enabled = !!on;
    if (on && !combinedMembers().length) {
        /* Start with every file in the book; the book takes the first file's
           binding (if it had one) and copies, so nothing changes unexpectedly */
        const withBinding = uploadedFiles.find(f => f.config.bindingId && f.config.bindingId !== 'none');
        if (withBinding) combinedBook.bindingId = withBinding.config.bindingId;
        combinedBook.copies = parseInt(uploadedFiles[0]?.config.quantity, 10) || 1;
        uploadedFiles.forEach(addToBook);
        combinedBook.pickerOpen = true;
    }
    if (!on) uploadedFiles.forEach(removeFromBook);
    rerenderDocs();
};

window.toggleBookFile = function(id, on) {
    const f = uploadedFiles.find(x => x.id === id);
    if (!f) return;
    if (on) addToBook(f); else removeFromBook(f);
    rerenderDocs();
};

window.setBookPickerOpen = function(open) { combinedBook.pickerOpen = !!open; };

/* New order from drag-and-drop (doc ids, top → bottom) */
function setBookOrder(ids) {
    combinedBook.order = ids.filter(Boolean);
    rerenderDocs();
}

window.scrollToBook = function() {
    const card = [...document.querySelectorAll('.xo-book-card')].find(el => el.offsetParent !== null);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.setBookBinding = function(id) {
    combinedBook.bindingId = id;
    rerenderDocs();
};

window.setBookCopies = function(val) {
    combinedBook.copies = Math.min(9999, Math.max(1, parseInt(val, 10) || 1));
    rerenderDocs();
};

/* Helper: are we currently inside the step-5 wizard panel? */
function _inStep5() {
    const s5 = document.getElementById('xoLocStep5');
    const ov = document.getElementById('xoLocationOverlay');
    /* The upload panel stays display:block after the wizard closes, so the overlay must be checked too */
    return !!s5 && s5.style.display !== 'none' && !(ov && ov.style.display === 'none');
}

window.updateConfig = function(i, key, value) {
    const f = uploadedFiles[i];
    if (!f) return;
    const paperNow = resolvePaper(key === 'paperId' ? value : f.config.paperId);
    /* A colour mode this paper doesn't allow (disabled button) is ignored */
    if (key === 'color' && !colorModesFor(paperNow, f.pages)[value]) return;
    f.config[key] = value;
    /* New paper or colour mode: snap colour / format / ratio to what is allowed
       (format and ratio choices can differ between the B&W and colour panels) */
    if (key === 'paperId' || key === 'color') snapDocOptions(f, paperNow);
    rerenderDocs();
};
window.updateQty = function(i, delta) {
    const current = parseInt(uploadedFiles[i].config.quantity, 10) || 1;
    uploadedFiles[i].config.quantity = Math.max(1, current + delta);
    if (_inStep5()) {
        const shopCfg = getShopXeroxConfig(selectedPickerShopId);
        renderStep5Docs(shopCfg);
        updateStep5Summary(shopCfg);
    } else {
        renderDocCards();
    }
};
window.setQty = function(i, val) {
    let num = parseInt(val, 10);
    if (isNaN(num) || num < 1) {
        num = 1;
    }
    uploadedFiles[i].config.quantity = num;

    if (_inStep5()) {
        const shopCfg = getShopXeroxConfig(selectedPickerShopId);
        const saved = { paper: xeroxConfig.paper, binding: xeroxConfig.binding, lamination: xeroxConfig.lamination };
        xeroxConfig.paper      = shopCfg.paper;
        xeroxConfig.binding    = shopCfg.binding;
        xeroxConfig.lamination = shopCfg.lamination;
        calculatePrices();
        xeroxConfig.paper      = saved.paper;
        xeroxConfig.binding    = saved.binding;
        xeroxConfig.lamination = saved.lamination;

        const card = document.getElementById(`docCard-${i}`);
        if (card) {
            const priceVal = card.querySelector('.xo-doc-price-row.total .xo-doc-price-val');
            if (priceVal) {
                const f = uploadedFiles[i];
                priceVal.innerHTML = f.config.colorMode === 'custom'
                    ? '<em style="color:var(--primary)">Seller Estimate</em>'
                    : `₹${f.prices.final.toFixed(2)}`;
            }
        }
        updateStep5Summary(shopCfg);
    } else {
        calculatePrices();
        const card = document.getElementById(`docCard-${i}`);
        if (card) {
            const priceVal = card.querySelector('.xo-doc-price-row.total .xo-doc-price-val');
            if (priceVal) {
                const f = uploadedFiles[i];
                priceVal.innerHTML = f.config.colorMode === 'custom'
                    ? '<em style="color:var(--primary)">Seller Estimate</em>'
                    : `₹${f.prices.final.toFixed(2)}`;
            }
        }
        renderFinalSummary();
    }
};
window.onQtyBlur = function(i, el) {
    let num = parseInt(el.value, 10);
    if (isNaN(num) || num < 1) {
        num = 1;
        el.value = 1;
    }
    setQty(i, num);
};
window.toggleInstructions = function(i) {
    uploadedFiles[i].config._showInstructions = !uploadedFiles[i].config._showInstructions;
    if (_inStep5()) {
        const shopCfg = getShopXeroxConfig(selectedPickerShopId);
        renderStep5Docs(shopCfg);
    } else {
        renderDocCards();
    }
};
/* ════ CONFIRM POPUP ════ */
function showConfirm({ title = 'Are you sure?', msg = '', okLabel = 'Confirm', okDanger = true, okColor = null, onOk, onCancel }) {
    const backdrop = document.getElementById('xoConfirmBackdrop');
    const popup    = document.getElementById('xoConfirmPopup');
    const titleEl  = document.getElementById('xoConfirmTitle');
    const msgEl    = document.getElementById('xoConfirmMsg');
    const okBtn    = document.getElementById('xoConfirmOk');
    const cancelBtn = document.getElementById('xoConfirmCancel');
    if (!popup) { if (onOk) onOk(); return; }

    titleEl.textContent = title;
    msgEl.textContent   = msg;
    okBtn.textContent   = okLabel;
    okBtn.style.background = okColor ? okColor : (okDanger ? '#ef4444' : 'var(--primary, #2D8CF0)');

    backdrop.style.display = 'block';
    popup.style.display    = 'block';

    const close = () => {
        backdrop.style.display = 'none';
        popup.style.display    = 'none';
        okBtn.onclick     = null;
        cancelBtn.onclick = null;
        // Reset icon to default (trash/remove)
        const iconEl = document.getElementById('xoConfirmIcon');
        if (iconEl) {
            iconEl.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
            iconEl.style.background = '';
            iconEl.style.color = '';
        }
    };
    okBtn.onclick     = () => { close(); if (onOk) onOk(); };
    cancelBtn.onclick = () => { close(); if (onCancel) onCancel(); };
    backdrop.onclick  = () => { close(); if (onCancel) onCancel(); };
}

/* ════ COLLEGE SHOP MINIMUM ORDER CHECK (₹50) ════ */
function isCollegeShopSelected() {
    if (selectedPlaceType === 'college' || window.selectedPlaceType === 'college') return true;
    const shopId = selectedShopId || selectedPickerShopId;
    if (shopId) {
        const shop = shopById(shopId) ||
                     (allShopsRaw && allShopsRaw.find(s => s.id === shopId));
        if (shop && extractShopPlaceType(shop) === 'college') return true;
    }
    return false;
}

function checkCollegeMinOrder() {
    if (!isCollegeShopSelected()) return true;

    calculatePrices();
    let subtotal = 0;
    uploadedFiles.forEach(f => {
        subtotal += (f.prices?.final || 0);
    });

    const MIN_AMOUNT = 50;
    if (subtotal < MIN_AMOUNT) {
        showCollegeMinOrderModal(subtotal, MIN_AMOUNT);
        return false;
    }
    return true;
}

function showCollegeMinOrderModal(currentVal, minVal = 50) {
    const backdrop = document.getElementById('xoMinOrderBackdrop');
    const popup    = document.getElementById('xoMinOrderPopup');
    const curEl    = document.getElementById('xoMinOrderCurrentVal');
    const shortEl  = document.getElementById('xoMinOrderShortVal');
    const barEl    = document.getElementById('xoMinOrderBarFill');

    if (!popup) return;

    const shortVal = Math.max(0, minVal - currentVal);
    const pct      = Math.min(100, Math.max(0, (currentVal / minVal) * 100));

    if (curEl)   curEl.textContent   = `₹${currentVal.toFixed(2)}`;
    if (shortEl) shortEl.textContent = `₹${shortVal.toFixed(2)}`;
    if (barEl)   barEl.style.width   = `${pct}%`;

    if (backdrop) backdrop.style.display = 'block';
    popup.style.display = 'block';
}

window.closeMinOrderModal = function() {
    const backdrop = document.getElementById('xoMinOrderBackdrop');
    const popup    = document.getElementById('xoMinOrderPopup');
    if (backdrop) backdrop.style.display = 'none';
    if (popup)    popup.style.display    = 'none';
    /* "Add more pages / files" from the shop step → back to the upload step */
    const s4 = document.getElementById('xoLocStep4');
    const overlay = document.getElementById('xoLocationOverlay');
    if (s4 && s4.style.display !== 'none' && overlay && overlay.style.display !== 'none') window.goBackToUpload();
};

window.removeDoc = async function(i) {
    const name = uploadedFiles[i]?.name || 'this document';
    showConfirm({
        title: 'Remove Document?',
        msg: `"${name}" will be removed from your order.`,
        okLabel: 'Remove',
        onOk: () => {
            if (uploadedFiles[i]?.xhr) { uploadedFiles[i].xhr.abort(); }
            uploadedFiles.splice(i, 1);
            if (_inStep5()) {
                const shopCfg = getShopXeroxConfig(selectedPickerShopId);
                renderStep5Docs(shopCfg);
                renderStep5UploadRows();
                updateStep5Summary(shopCfg);
            } else {
                updateUIState();
                renderDocCards();
            }
        }
    });
};

/* ════ FINAL SUMMARY CARD ════ */
function renderFinalSummary() {
    const container = document.getElementById('xoFinalSummary');
    if (!container) return;
    if (uploadedFiles.length === 0) { container.innerHTML = ''; return; }

    calculatePrices();
    let subtotal = 0;
    let hasEstimation = false;
    uploadedFiles.forEach(f => {
        if (f.config.colorMode === 'custom') hasEstimation = true;
        subtotal += f.prices.final;
    });

    // Delivery fee from selected shop — only applies for home delivery, never for pickup
    const isPickup = selectedOrderType === 'pickup';
    let deliveryFee = 25, threshold = 150, showNudge = !isPickup;
    if (selectedShopId) {
        const shop  = shopById(selectedShopId);
        const rules = shop?.deliveryPrices?.xerox || [];
        if (rules.length) {
            const rule = rules.find(r => subtotal >= r.min && (r.max == null || subtotal <= r.max));
            if (rule) deliveryFee = rule.fee;
            const free = rules.find(r => r.fee === 0);
            threshold = free ? free.min : 9999;
            if (!free) showNudge = false;
        }
    }
    const isFree        = subtotal >= threshold;
    const deliveryApply = isPickup
        ? 0  /* pickup — no delivery charge */
        : (isFree || hasEstimation) ? 0 : (selectedShopId ? deliveryFee : 0);
    const remaining = threshold - subtotal;

    const docSummaryHtml = uploadedFiles.map((f, i) => {
        const cfg  = f.config;
        const pName = xeroxConfig.paper.find(p => p.id === cfg.paperId)?.name || 'Standard';
        const bName = bindingText(cfg);
        const lName = cfg.laminationId !== 'none' ? (xeroxConfig.lamination.find(l => l.id === cfg.laminationId)?.name || '') : '';
        return `
        <div class="xo-summary-doc">
            <div class="xo-summary-doc-head">
                <div class="xo-summary-doc-name">Doc ${i+1}: ${f.name}</div>
                <div class="xo-summary-doc-price">${cfg.colorMode==='custom' ? '<em style="font-size:.78rem;color:var(--primary)">Est.</em>' : `₹${f.prices.final.toFixed(2)}`}</div>
            </div>
            <div class="xo-summary-kv">
                <div class="xo-summary-kv-key">Pages / Qty</div>
                <div class="xo-summary-kv-val">${f.pages} × ${cfg.quantity}</div>
                <div class="xo-summary-kv-key">Paper / Color</div>
                <div class="xo-summary-kv-val">${pName} / ${esc(colorText(cfg))}</div>
                <div class="xo-summary-kv-key">Format / Ratio</div>
                <div class="xo-summary-kv-val">${cfg.format === 'both' ? 'Front & Back' : 'One Side'} / ${ratioText(cfg.ratio)}</div>
                ${bName || lName ? `<div class="xo-summary-kv-key">Finishing</div><div class="xo-summary-kv-val">${[bName,lName].filter(Boolean).join(' + ')}</div>` : ''}
                ${cfg.instructions ? `<div class="xo-summary-kv-key">Notes</div><div class="xo-summary-kv-val">${cfg.instructions}</div>` : ''}
            </div>
        </div>`;
    }).join('');

    container.innerHTML = `
    <div class="xo-summary-card">
        <div class="xo-summary-header">
            <p class="xo-summary-title">Final Estimation</p>
            <p class="xo-summary-sub">Review each document before proceeding.</p>
        </div>
        <div class="xo-summary-body">${docSummaryHtml}</div>
        <div class="xo-summary-footer">
            <div class="xo-summary-row"><span class="xo-summary-label">Subtotal</span><span class="xo-summary-val">₹${subtotal.toFixed(2)}</span></div>
            <div class="xo-summary-row">
                <span class="xo-summary-label">Delivery</span>
                <span class="xo-summary-val ${(isPickup || isFree) ? 'xo-free-delivery' : ''}">
                    ${!selectedShopId
                        ? 'Select shop below'
                        : isPickup
                            ? 'FREE <span style="font-size:.7rem;font-weight:600;opacity:.75;">(Pickup)</span>'
                            : isFree
                                ? 'FREE 🎉'
                                : hasEstimation
                                    ? 'TBD'
                                    : `₹${deliveryApply.toFixed(2)}`}
                </span>
            </div>
            ${showNudge && selectedShopId && !isPickup && !isFree && !hasEstimation ? `
            <div class="xo-nudge"><i class="fa-solid fa-circle-info"></i> Add ₹${remaining.toFixed(2)} more for FREE delivery!</div>` : ''}
            <div class="xo-summary-row total">
                <span>Total</span>
                <span>${!selectedShopId ? '<em style="font-size:.82rem;color:var(--txt3)">Pending shop</em>' : `₹${(subtotal + deliveryApply).toFixed(2)}`}</span>
            </div>
            ${hasEstimation ? '<div style="font-size:.72rem;color:var(--primary);font-weight:700;text-align:right;margin-top:4px;">+ Manual estimation pending</div>' : ''}

            <!-- Upload section -->
            <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border,#e5e7eb);">
                <div style="font-size:.78rem;font-weight:800;color:var(--txt2);margin-bottom:10px;">
                    <i class="fa-solid fa-cloud-arrow-up" style="color:var(--primary);margin-right:5px;"></i>Upload Files to Continue
                </div>
                <div id="xoUploadRows" class="xo-upload-rows"></div>
            </div>
        </div>
    </div>`;

    // Actions now live in the sticky footer — just update verify block state
    const actionsEl = document.getElementById('xoActions');
    if (actionsEl) actionsEl.style.display = 'block';

    renderUploadRows();
    renderShopSelector();
}

/* ════ UPLOAD ROWS ════ */
function renderUploadRows() {
    const list = document.getElementById('xoUploadRows');
    if (!list) return;
    list.innerHTML = uploadedFiles.map((f, i) => buildUploadRow(f, i)).join('');
}

function buildUploadRow(f, i) {
    const mb   = (f.fileObj.size / (1024*1024)).toFixed(2);
    const over = f.fileObj.size > 50 * 1024 * 1024;

    let badge = '', actions = '', progress = '';

    if (f.uploadStatus === 'pending') {
        badge   = `<span class="xo-upload-badge xo-badge-pending">Pending</span>`;
        if (over) {
            actions = `
            <div class="xo-upload-actions">
                <div style="font-size:.72rem;color:#ef4444;font-weight:700;margin-bottom:8px;"><i class="fa-solid fa-circle-exclamation"></i> File too large (&gt;50 MB) — upload via WhatsApp instead.</div>
                <button class="xo-btn-wa" onclick="sendViaWhatsApp(${i})"><i class="fa-brands fa-whatsapp"></i> Send via WhatsApp</button>
            </div>`;
        } else {
            actions = `
            <div class="xo-upload-actions">
                <div class="xo-upload-actions-row">
                    <button class="xo-btn-upload" onclick="uploadFile(${i})"><i class="fa-solid fa-cloud-arrow-up"></i> Upload Now</button>
                    <button class="xo-btn-later"  onclick="markUpload(${i},'later')"><i class="fa-regular fa-clock"></i> Upload Later</button>
                </div>
                <button class="xo-btn-wa" onclick="sendViaWhatsApp(${i})"><i class="fa-brands fa-whatsapp"></i> Send via WhatsApp</button>
            </div>`;
        }
    } else if (f.uploadStatus === 'uploading') {
        badge   = `<span class="xo-upload-badge xo-badge-uploading">Uploading</span>`;
        progress = `
        <div class="xo-progress-wrap">
            <div class="xo-progress-bar-bg"><div class="xo-progress-bar-fill" style="width:${f.uploadProgress||0}%"></div></div>
            <div class="xo-progress-meta"><span>${f.uploadSpeed||'Calculating…'}</span><span>${f.uploadProgress||0}%</span><span>${f.uploadETA||'…'}</span></div>
            <div class="xo-progress-actions">
                <button class="xo-btn-sm" onclick="pauseUpload(${i})"><i class="fa-solid fa-pause"></i> Pause</button>
                <button class="xo-btn-sm danger" onclick="cancelUpload(${i})"><i class="fa-solid fa-xmark"></i> Cancel</button>
            </div>
        </div>`;
    } else if (f.uploadStatus === 'paused') {
        badge   = `<span class="xo-upload-badge xo-badge-paused">Paused</span>`;
        progress = `
        <div class="xo-progress-wrap">
            <div class="xo-progress-bar-bg"><div class="xo-progress-bar-fill" style="width:${f.uploadProgress||0}%;background:#f59e0b;"></div></div>
            <div class="xo-progress-meta"><span>Paused</span><span>${f.uploadProgress||0}%</span></div>
            <div class="xo-progress-actions">
                <button class="xo-btn-sm" onclick="uploadFile(${i})"><i class="fa-solid fa-play"></i> Resume</button>
                <button class="xo-btn-sm danger" onclick="cancelUpload(${i})"><i class="fa-solid fa-xmark"></i> Cancel</button>
            </div>
        </div>`;
    } else if (f.uploadStatus === 'uploaded') {
        badge   = `<span class="xo-upload-badge xo-badge-uploaded"><i class="fa-solid fa-check"></i> Uploaded</span>`;
        actions = `<div style="margin-top:6px;font-size:.75rem;color:#16a34a;font-weight:700;"><i class="fa-solid fa-circle-check"></i> Upload complete</div>`;
    } else if (f.uploadStatus === 'later') {
        badge   = `<span class="xo-upload-badge xo-badge-later">Upload Later</span>`;
        actions = `<div class="xo-upload-actions"><button class="xo-btn-undo" onclick="markUpload(${i},'pending')"><i class="fa-solid fa-rotate-left"></i> Undo</button></div>`;
    } else if (f.uploadStatus === 'whatsapp') {
        badge   = `<span class="xo-upload-badge xo-badge-whatsapp"><i class="fa-brands fa-whatsapp"></i> Via WhatsApp</span>`;
        actions = `<div class="xo-upload-actions"><button class="xo-btn-undo" onclick="markUpload(${i},'pending')"><i class="fa-solid fa-rotate-left"></i> Undo</button></div>`;
    }

    return `
    <div class="xo-upload-row" id="uploadRow-${i}">
        <div class="xo-upload-row-head">
            <div>
                <div class="xo-upload-row-name"><i class="fa-regular fa-file-pdf" style="color:#ef4444;margin-right:6px;"></i>${f.name}</div>
                <div class="xo-upload-row-meta">${f.pages} pages · ${mb} MB</div>
            </div>
            ${badge}
        </div>
        ${over && f.uploadStatus==='pending' ? '<div style="font-size:.72rem;color:#ef4444;font-weight:700;margin-bottom:4px;"><i class="fa-solid fa-circle-exclamation"></i> File too large (&gt;50MB) — please compress before uploading.</div>' : ''}
        ${actions}
        ${progress}
    </div>`;
}

/* ════ UPLOAD ACTIONS ════ */
window.markUpload = function(i, status) {
    uploadedFiles[i].uploadStatus    = status;
    uploadedFiles[i].uploadProgress  = 0;
    uploadedFiles[i].uploadSpeed     = '';
    uploadedFiles[i].uploadETA       = '';
    if (_inStep5()) {
        const shopCfg = getShopXeroxConfig(selectedPickerShopId);
        renderStep5UploadRows();
        updateStep5Summary(shopCfg);
    } else {
        renderUploadRows();
        renderFinalSummary();
    }
};

window.sendViaWhatsApp = function(i) {
    // Style the confirm icon green/whatsapp before opening popup
    const iconEl = document.getElementById('xoConfirmIcon');
    if (iconEl) {
        iconEl.innerHTML = '<i class="fa-brands fa-whatsapp"></i>';
        iconEl.style.background = 'rgba(37,211,102,0.12)';
        iconEl.style.color = '#25D366';
    }

    // Just mark this file as "via whatsapp" — the actual WhatsApp redirect
    // happens after the full order is placed (see placeOrder → sendWhatsAppOrderMessage).
    showConfirm({
        title:    'Send via WhatsApp?',
        msg:      'This file will be marked as "Via WhatsApp". After you place the order, you\'ll be redirected to WhatsApp with your complete order details to send the file.',
        okLabel:  'Mark & Continue',
        okDanger: false,
        okColor:  '#25D366',
        onOk: () => {
            markUpload(i, 'whatsapp');
            showToast('Marked as "Via WhatsApp". Complete checkout to send.', 'info');
        }
    });
};

window.uploadFile = async function(i) {
    const f = uploadedFiles[i];
    f.uploadStatus   = 'uploading';
    f.uploadProgress = 0;
    f.uploadIntent   = 'active';
    if (_inStep5()) renderStep5UploadRows(); else renderUploadRows();

    /* Signed, single-use upload link from the server (private bucket) */
    let target;
    try {
        target = await getUploadTarget('xerox', f.fileObj.name);
    } catch (e) {
        f.uploadStatus = 'pending';
        showToast(currentUser ? `Upload unavailable: ${e.message}` : 'Please sign in to upload files.', 'error');
        if (_inStep5()) renderStep5UploadRows(); else renderUploadRows();
        return;
    }

    const xhr = new XMLHttpRequest();
    f.xhr = xhr;

    let lastLoaded = 0, lastTime = Date.now();

    xhr.upload.addEventListener('progress', e => {
        if (!e.lengthComputable || f.uploadIntent !== 'active') return;
        const now   = Date.now();
        const diff  = (now - lastTime) / 1000;
        if (diff >= 0.5) {
            const bps = (e.loaded - lastLoaded) / diff;
            f.uploadSpeed    = bps < 1024*1024 ? `${(bps/1024).toFixed(1)} KB/s` : `${(bps/(1024*1024)).toFixed(2)} MB/s`;
            const remain = e.total - e.loaded;
            const eta    = bps > 0 ? remain / bps : 0;
            f.uploadETA  = eta < 60 ? `${Math.ceil(eta)}s left` : `${Math.ceil(eta/60)}m left`;
            lastLoaded = e.loaded; lastTime = now;
        }
        f.uploadProgress = Math.round((e.loaded / e.total) * 100);
        if (_inStep5()) renderStep5UploadRows(); else renderUploadRows();
    });

    xhr.addEventListener('load', () => {
        if (f.uploadIntent !== 'active') return;
        delete f.xhr;
        if (xhr.status >= 200 && xhr.status < 300) {
            f.uploadStatus  = 'uploaded';
            f.uploadedUrl   = target.fileUrl;
            f.config.selectedUrl = f.uploadedUrl;
        } else {
            f.uploadStatus = 'pending';
            showToast('Upload failed. Please try again.', 'error');
        }
        if (_inStep5()) {
            const shopCfg = getShopXeroxConfig(selectedPickerShopId);
            renderStep5UploadRows();
            updateStep5Summary(shopCfg);
        } else {
            renderUploadRows();
            renderFinalSummary();
        }
    });

    xhr.addEventListener('error', () => {
        if (f.uploadIntent !== 'active') return;
        delete f.xhr;
        f.uploadStatus = 'pending';
        showToast('Network error. Please try again.', 'error');
        if (_inStep5()) {
            renderStep5UploadRows();
        } else {
            renderUploadRows();
            renderFinalSummary();
        }
    });

    xhr.addEventListener('abort', () => {
        delete f.xhr;
        if (f.uploadIntent === 'paused') f.uploadStatus = 'paused';
        else f.uploadStatus = 'pending';
        if (_inStep5()) renderStep5UploadRows(); else renderUploadRows();
    });

    xhr.open('PUT', target.uploadUrl, true);
    if (f.fileObj.type) xhr.setRequestHeader('Content-Type', f.fileObj.type);
    xhr.send(f.fileObj);
};

window.pauseUpload = function(i) {
    const f = uploadedFiles[i];
    if (f.xhr) { f.uploadIntent = 'paused'; f.xhr.abort(); }
};

window.cancelUpload = function(i) {
    const f = uploadedFiles[i];
    if (f.xhr) { f.uploadIntent = 'cancelled'; f.xhr.abort(); }
    markUpload(i, 'pending');
};

/* ════ LANDING SHOP CARDS (shown before files selected) ════ */

/* Switch the landing shop-type filter tab and re-render */
window.switchShopTypeFilter = function(filter) {
    landingShopTypeFilter = filter;

    /* Update active tab styling */
    document.querySelectorAll('.xo-shop-filter-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });

    renderLandingShops();
};

function renderLandingShops() {
    const list = document.getElementById('xoLandingShopList');
    if (!list) return;

    /* ── Always filter allShops to xerox-only shops ── */
    const xeroxShops = allShops.filter(s => isXeroxShop(s));

    /* ── Compute counts for each tab ── */
    const allCount     = xeroxShops.length;
    const shopCount    = xeroxShops.filter(s => extractShopPlaceType(s) === 'shop').length;
    const collegeCount = xeroxShops.filter(s => extractShopPlaceType(s) === 'college').length;

    /* Update count pills on the filter tabs */
    const countAll     = document.getElementById('xoFilterCountAll');
    const countShop    = document.getElementById('xoFilterCountShop');
    const countCollege = document.getElementById('xoFilterCountCollege');
    if (countAll)     countAll.textContent     = allCount     || '';
    if (countShop)    countShop.textContent    = shopCount    || '';
    if (countCollege) countCollege.textContent = collegeCount || '';

    /* Hide filter bar if there is only one type present (nothing to filter) */
    const filterBar = document.getElementById('xoShopFilterBar');
    if (filterBar) {
        const hasMultipleTypes = shopCount > 0 && collegeCount > 0;
        filterBar.style.display = hasMultipleTypes ? 'flex' : 'none';
        /* If the previously active filter now has zero results, fall back to 'all' */
        if (landingShopTypeFilter !== 'all') {
            const activeCount = landingShopTypeFilter === 'college' ? collegeCount : shopCount;
            if (activeCount === 0) {
                landingShopTypeFilter = 'all';
                document.querySelectorAll('.xo-shop-filter-tab').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.filter === 'all');
                });
            }
        }
    }

    /* ── Apply active type filter ── */
    const visibleShops = landingShopTypeFilter === 'all'
        ? xeroxShops
        : xeroxShops.filter(s => extractShopPlaceType(s) === landingShopTypeFilter);

    /* Update sub-label */
    const subLabel = document.getElementById('xoLandingShopsSub');
    if (subLabel) {
        if (!visibleShops.length) {
            subLabel.textContent = 'No centers match the selected filter';
        } else {
            const typeLabel = landingShopTypeFilter === 'shop'    ? 'Xerox shops'
                            : landingShopTypeFilter === 'college' ? 'College centers'
                            : 'Xerox centers';
            subLabel.textContent = `${visibleShops.length} ${typeLabel} near you`;
        }
    }

    if (!visibleShops.length) {
        const emptyMsg = allCount === 0
            ? 'No active xerox centers found.'
            : `No ${landingShopTypeFilter === 'college' ? 'college' : 'xerox shop'} centers in this area.`;
        list.innerHTML = `<div class="xo-shops-empty"><i class="fa-solid fa-store-slash"></i><span>${emptyMsg}</span></div>`;
        return;
    }

    const cleanPhone = num => num.toString().replace(/[^\d+]/g, '');

    list.innerHTML = visibleShops.map(shop => {
        const mobileNums  = Array.isArray(shop.mobileNumbers) ? shop.mobileNumbers : (shop.phone ? [shop.phone] : []);
        const waNums      = Array.isArray(shop.whatsappNumbers) ? shop.whatsappNumbers : (shop.whatsapp ? [shop.whatsapp] : []);
        const isSelected  = shop.id === selectedShopId;
        const placeType   = extractShopPlaceType(shop);
        const isCollege   = placeType === 'college';

        /* Type badge */
        const typeBadge = isCollege
            ? `<span class="xo-sc-type-badge xo-sc-type-badge--college"><i class="fa-solid fa-building-columns"></i> College</span>`
            : `<span class="xo-sc-type-badge xo-sc-type-badge--shop"><i class="fa-solid fa-print"></i> Xerox Shop</span>`;

        /* Card icon changes for college */
        const cardIconClass  = isCollege ? 'fa-solid fa-building-columns' : 'fa-solid fa-store';
        const cardIconBg     = isCollege
            ? 'background:rgba(124,58,237,0.1);color:#7c3aed;'
            : '';

        const callBtns = mobileNums.map((num, idx) => `
            <button class="xo-sc-call-btn" onclick="event.stopPropagation();confirmCall('${cleanPhone(num)}','${shop.name.replace(/'/g,"\\'")}')">
                <i class="fa-solid fa-phone"></i>
                ${mobileNums.length > 1 ? `Call #${idx+1}` : 'Call'} <span class="xo-sc-num">${num}</span>
            </button>`).join('');

        const waBtns = waNums.map((num, idx) => {
            const clean = cleanPhone(num).replace('+', '').slice(-10);
            const uName = userProfile.fullName || 'Customer';
            const uMob  = userProfile.mobileNumber || '';
            const msg   = `Hi! I'm ${uName}${uMob ? ` (${uMob})` : ''}.\nI want to place a Xerox order via JASA Essential.\n\nShop: ${shop.name}`;
            const waUrl = `https://wa.me/91${clean}?text=${encodeURIComponent(msg)}`;
            return `
            <button class="xo-sc-wa-btn" onclick="event.stopPropagation();confirmWhatsApp('${waUrl.replace(/'/g,"\\'")}','${shop.name.replace(/'/g,"\\'")}','${num}')">
                <i class="fa-brands fa-whatsapp"></i>
                ${waNums.length > 1 ? `WhatsApp #${idx+1}` : 'WhatsApp'} <span class="xo-sc-num">${num}</span>
            </button>`;
        }).join('');

        const xeroxRules = shop.deliveryPrices?.xerox || [];
        const freeRule   = xeroxRules.find(r => r.fee === 0);

        const areasHtml  = (shop.areas || []).slice(0, 3).map(a =>
            `<span class="xo-sc-area">${a}</span>`).join('');
        const moreAreas  = (shop.areas || []).length > 3
            ? `<span class="xo-sc-area xo-sc-area-more">+${shop.areas.length - 3}</span>` : '';

        return `
        <div class="xo-shop-card ${isSelected ? 'selected' : ''}" onclick="preselectShop('${shop.id}')">
            <div class="xo-sc-head">
                <div class="xo-sc-icon" style="${cardIconBg}"><i class="${cardIconClass}"></i></div>
                <div class="xo-sc-info">
                    <div class="xo-sc-name" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${shop.name}</span>
                        ${typeBadge}${distBadge(shop, false)}
                    </div>
                    <div class="xo-sc-addr">
                        <i class="fa-solid fa-location-dot"></i> ${shop.address || 'Local Center'}
                        ${shop.locationLink ? `<br><a href="${esc(shop.locationLink)}" target="_blank" onclick="event.stopPropagation();" style="color:var(--primary); font-weight:600; text-decoration:none; display:inline-block; margin-top:4px;"><i class="fa-solid fa-map-location-dot"></i> View on Map</a>` : ''}
                    </div>
                </div>
                <div class="xo-sc-radio ${isSelected ? 'checked' : ''}">
                    ${isSelected ? '<i class="fa-solid fa-circle-check"></i>' : ''}
                </div>
            </div>
            ${areasHtml ? `
            <div class="xo-sc-areas">
                <i class="fa-solid fa-motorcycle xo-sc-areas-icon"></i>
                ${areasHtml}${moreAreas}
            </div>` : ''}
            ${freeRule ? `
            <div class="xo-sc-free-badge">
                <i class="fa-solid fa-gift"></i> FREE delivery above ₹${freeRule.min}
            </div>` : ''}
            ${shop.notes ? `
            <div class="xo-sc-notes"><i class="fa-solid fa-circle-info"></i> ${shop.notes}</div>` : ''}
            ${(waBtns || callBtns) ? `<div class="xo-sc-actions">${waBtns}${callBtns}</div>` : ''}
        </div>`;
    }).join('');
}

window.preselectShop = function(id) {
    selectedShopId = selectedShopId === id ? null : id;  // toggle
    renderLandingShops();
    showToast(selectedShopId ? 'Shop selected ✓' : 'Shop deselected', selectedShopId ? 'success' : '');
};

/* ════ CONTACT CONFIRM HANDLERS ════ */
window.confirmCall = function(tel, shopName) {
    const iconEl = document.getElementById('xoConfirmIcon');
    if (iconEl) {
        iconEl.innerHTML = '<i class="fa-solid fa-phone"></i>';
        iconEl.style.background = 'rgba(37,99,235,0.12)';
        iconEl.style.color = '#2563eb';
    }
    showConfirm({
        title: 'Call Shop?',
        msg:   `You're about to call ${shopName}. Proceed?`,
        okLabel:  'Call Now',
        okDanger: false,
        okColor:  '#2563eb',
        onOk: () => { window.location.href = `tel:${tel}`; }
    });
};

window.confirmWhatsApp = function(waUrl, shopName, num) {
    const iconEl = document.getElementById('xoConfirmIcon');
    if (iconEl) {
        iconEl.innerHTML = '<i class="fa-brands fa-whatsapp"></i>';
        iconEl.style.background = 'rgba(22,163,74,0.12)';
        iconEl.style.color = '#16a34a';
    }
    showConfirm({
        title: 'Open WhatsApp?',
        msg:   `Chat with ${shopName} on WhatsApp (${num})?`,
        okLabel:  'Open WhatsApp',
        okDanger: false,
        okColor:  '#16a34a',
        onOk: () => { window.open(waUrl, '_blank'); }
    });
};

/* ════ SHOP SELECTOR (inside order flow, shown after files added) ════ */
function renderShopSelector() {
    const wrap = document.getElementById('xoShopSelector');
    if (!wrap || !uploadedFiles.length) return;

    const shop = shopById(selectedShopId);
    const displayText = shop ? shop.name : 'Tap to select a shop';
    const hasShop = !!shop;

    wrap.innerHTML = `
    <div class="xo-shop-selector-card ${hasShop ? 'has-shop' : ''}">
        <div class="xo-shop-selector-label"><i class="fa-solid fa-bolt-lightning" style="margin-right:5px;"></i>Xerox Shop</div>
        <div class="xo-shop-select-btn" onclick="openShopModal()">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                ${hasShop ? `<i class="fa-solid fa-circle-check" style="color:#16a34a;flex-shrink:0;"></i>` : `<i class="fa-solid fa-store" style="color:var(--txt3);flex-shrink:0;font-size:.8rem;"></i>`}
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${displayText}</span>
            </div>
            <i class="fa-solid fa-chevron-down" style="font-size:.75rem;flex-shrink:0;"></i>
        </div>
    </div>`;
}

window.openShopModal = function() {
    const list    = document.getElementById('shopModalList');
    const backdrop = document.getElementById('shopModalBackdrop');
    const modal    = document.getElementById('shopModal');
    if (!list) return;

    /* Same choices as the wizard's shop step: nearest first, default shop when none is near */
    const choice = nearestShopChoices();
    const shops  = [...choice.list];
    const cur    = shopById(selectedShopId);
    if (cur && !shops.some(s => s.id === cur.id)) shops.unshift(cur);
    const note = shopListNote(choice);

    list.innerHTML = (note ? `<div class="xo-picker-note ${choice.isDefault ? 'xo-picker-note--warn' : ''}" style="display:flex;margin:0 0 10px;">${note}</div>` : '') + (shops.map((shop, idx) => {
        const selected = shop.id === selectedShopId;
        const xeroxRules = shop.deliveryPrices?.xerox || [];
        const freeRule   = xeroxRules.find(r => r.fee === 0);
        return `
        <div class="xo-modal-shop-item ${selected?'selected':''}" onclick="selectShop('${esc(shop.id)}')">
            <div class="xo-modal-shop-icon"><i class="fa-solid fa-store"></i></div>
            <div style="flex:1;overflow:hidden;">
                <div class="xo-modal-shop-name">${h(shop.name)}${distBadge(shop, idx === 0 && !choice.isDefault && shops.length > 1)}</div>
                <div class="xo-modal-shop-addr">
                    <i class="fa-solid fa-location-dot" style="margin-right:4px;"></i>${h(shop.address||'Local Center')}
                    ${shop.locationLink ? `<br><a href="${h(shop.locationLink)}" target="_blank" rel="noopener" onclick="event.stopPropagation();" style="color:var(--primary); font-weight:600; text-decoration:none; display:inline-block; margin-top:4px;"><i class="fa-solid fa-map-location-dot"></i> View on Map</a>` : ''}
                </div>
                ${freeRule ? `<div class="xo-modal-shop-free"><i class="fa-solid fa-gift" style="margin-right:3px;"></i>FREE delivery above ₹${h(freeRule.min)}</div>` : ''}
            </div>
            <div class="xo-modal-shop-radio"></div>
        </div>`;
    }).join('') || '<p style="text-align:center;padding:24px;font-size:.82rem;color:var(--txt3);">No active xerox shops found.</p>');

    backdrop.style.display = 'block';
    modal.style.display    = 'flex';
};

window.closeShopModal = function() {
    document.getElementById('shopModalBackdrop').style.display = 'none';
    document.getElementById('shopModal').style.display         = 'none';
};

window.selectShop = function(id) {
    selectedShopId = id;
    closeShopModal();
    /* The documents may use papers / finishes this shop doesn't offer */
    const changed = fitDocsToShop(id);
    if (changed.length) showToast(`Changed for this shop: ${h(changed.join('; '))}.`, 'info');
    renderDocCards();
    renderShopSelector();
    renderLandingShops();
};

/* ════ VALIDATE + OPEN CHECKOUT ════ */
window.validateAndProceed = function() {
    const shop = shopById(selectedShopId);
    if (!shop) {
        selectedShopId = null;
        flagField(document.querySelector('.xo-shop-selector-card'), 'Please choose a Xerox shop for your order.');
        return;
    }
    if ((selectedOrderType || window.selectedOrderType) === 'delivery' && shop.homeDelivery !== true) {
        flagField(document.querySelector('.xo-shop-selector-card'),
            `${h(shop.name || 'This shop')} offers pickup only. Choose another shop, or change location and pick "Pick Up Myself".`);
        return;
    }
    const verified = document.getElementById('xoVerifyCheck')?.checked;
    if (!verified) {
        flagField(document.getElementById('xoVerifyBlock'), 'Please tick "Settings verified" after checking your document settings.');
        return;
    }
    const pendingFiles = uploadedFiles.filter(isPendingUpload);
    if (pendingFiles.length > 0) {
        // Highlight each pending upload row
        pendingFiles.forEach(f => {
            const idx  = uploadedFiles.indexOf(f);
            const row  = document.getElementById(`uploadRow-${idx}`);
            if (row) {
                row.classList.add('error');
                setTimeout(() => row.classList.remove('error'), 1600);
            }
        });
        flagField(document.getElementById(`uploadRow-${uploadedFiles.indexOf(pendingFiles[0])}`) || document.getElementById('xoUploadRows'),
            'Please upload each file, or choose "Upload Later" / WhatsApp for it.');
        return;
    }
    if (!checkDocConfigs() || !checkCollegeMinOrder()) return;
    openCheckoutSheet();
};

/* ════ CHECKOUT SHEET ════ */
function openCheckoutSheet() {
    if (!checkDocConfigs() || !checkCollegeMinOrder()) return;
    // Load fresh user profile if needed
    if (currentUser && (!userProfile.addresses?.length || !userProfile.mobileNumber)) {
        getDoc(doc(db, 'users', currentUser.uid)).then(snap => {
            if (snap.exists()) Object.assign(userProfile, snap.data());
            renderCheckoutContact();
            renderCheckoutAddresses();
        }).catch(() => {});
    }

    // Fetch payment config fresh from KV — no localStorage — then render options
    const payBlock = document.getElementById('coPaymentBlock');
    if (payBlock) payBlock.innerHTML = '';
    fetchPaymentConfig().then(() => renderPaymentOptions());
    loadWalletState().then(() => refreshCheckoutTotals());

    renderCheckoutSummary();
    renderCheckoutContact();
    renderCheckoutAddresses();

    document.getElementById('checkoutBackdrop').style.display = 'block';
    document.getElementById('checkoutSheet').style.display    = 'flex';
}

function renderCheckoutSummary() {
    const sumEl = document.getElementById('coEstimationBlock');
    if (sumEl) {
        calculatePrices();
        let subtotal = 0;
        let hasEstimate = false;
        uploadedFiles.forEach(f => {
            if (f.config.colorMode === 'custom') hasEstimate = true;
            subtotal += f.prices.final;
        });

        const shop = shopById(selectedShopId);
        const xeroxRules = shop?.deliveryPrices?.xerox || [];
        const freeRule   = xeroxRules.find(r => r.fee === 0);
        const rule = xeroxRules.find(r => subtotal >= r.min && (r.max == null || subtotal <= r.max));
        const deliveryFee = rule ? rule.fee : 0;
        const isFree = freeRule && subtotal >= freeRule.min;
        const isPickup = (selectedOrderType || window.selectedOrderType) === 'pickup';
        const deliveryApply = isPickup
            ? 0  /* pickup — no delivery charge */
            : (isFree || hasEstimate || !shop) ? 0 : deliveryFee;

        const statusIcon = s =>
            s === 'uploaded'  ? '<i class="fa-solid fa-circle-check" style="color:#16a34a"></i>' :
            s === 'whatsapp'  ? '<i class="fa-brands fa-whatsapp"    style="color:#25D366"></i>'  :
            s === 'later'     ? '<i class="fa-regular fa-clock"      style="color:#f59e0b"></i>'  :
                                '<i class="fa-solid fa-cloud-arrow-up" style="color:var(--primary)"></i>';

        const fileRows = uploadedFiles.map((f, i) => {
            const cfg   = f.config;
            const paper = xeroxConfig.paper.find(p => p.id === cfg.paperId)?.name || 'Standard';
            const color = cfg.color === 'mixed' ? `Mixed (${f.prices.colorPages} colour)` : colorText(cfg);
            const format = cfg.format === 'both' ? 'F&B' : 'One Side';
            const priceStr = cfg.colorMode === 'custom'
                ? '<em style="color:var(--primary);font-style:normal">Est.</em>'
                : `₹${f.prices.final.toFixed(2)}`;
            const name = f.name.length > 28 ? f.name.substring(0, 26) + '…' : f.name;
            return `
            <div class="co-file-row">
                <div class="co-file-row-left">
                    <span class="co-file-num">${i + 1}</span>
                    <div class="co-file-info">
                        <div class="co-file-name" title="${esc(f.name)}">${name}</div>
                        <div class="co-file-meta">${f.pages}pg · ×${cfg.quantity} · ${paper} · ${color} · ${format}</div>
                    </div>
                </div>
                <div class="co-file-row-right">
                    <span class="co-file-price">${priceStr}</span>
                    <span class="co-file-status">${statusIcon(f.uploadStatus)}</span>
                </div>
            </div>`;
        }).join('');

        const couponDisc = hasEstimate ? 0 : calcDiscount(appliedCoupon, subtotal);
        const grossTotal = subtotal - couponDisc + deliveryApply;
        const walletDisc = !shop ? 0 : walletUseFor(grossTotal);
        renderWalletBlock(grossTotal, hasEstimate);

        sumEl.innerHTML = `
        <div class="co-summary-block">
            <div class="co-summary-title"><i class="fa-solid fa-receipt"></i> Order Summary</div>
            <div class="co-file-list">${fileRows}</div>
            <div class="co-summary-totals">
                <div class="co-total-row">
                    <span>Subtotal</span>
                    <span>₹${subtotal.toFixed(2)}</span>
                </div>
                ${couponDisc > 0 ? `
                <div class="co-total-row">
                    <span>Coupon (${esc(appliedCoupon.code)})</span>
                    <span class="co-free">-₹${couponDisc.toFixed(2)}</span>
                </div>` : ''}
                ${walletDisc > 0 ? `
                <div class="co-total-row">
                    <span>Wallet</span>
                    <span class="co-free">-₹${walletDisc.toFixed(2)}</span>
                </div>` : ''}
                <div class="co-total-row">
                    <span>Delivery</span>
                    <span class="${(isPickup || isFree) ? 'co-free' : ''}">${
                        !shop    ? '—'
                        : isPickup ? 'FREE (Pickup)'
                        : isFree   ? 'FREE 🎉'
                        : hasEstimate ? 'TBD'
                        : `₹${deliveryApply.toFixed(2)}`
                    }</span>
                </div>
                <div class="co-total-row co-grand-total">
                    <span>Total</span>
                    <span>${!shop ? '—' : hasEstimate ? `₹${subtotal.toFixed(2)}+` : `₹${(grossTotal - walletDisc).toFixed(2)}`}</span>
                </div>
            </div>
        </div>`;
    }
    renderCouponBox();
}

window.closeCheckoutSheet = function() {
    document.getElementById('checkoutBackdrop').style.display = 'none';
    document.getElementById('checkoutSheet').style.display    = 'none';
};

function renderCheckoutContact() {
    const mobile = document.getElementById('coMobile');
    const alt    = document.getElementById('coAltMobile');
    if (!mobile || !alt) return;

    const nums = [];
    if (userProfile.mobileNumber) nums.push(userProfile.mobileNumber);
    (userProfile.altMobiles || []).forEach(n => { if (!nums.includes(n)) nums.push(n); });

    const newForm = document.getElementById('coNewContactForm');
    if (!nums.length) {
        mobile.innerHTML = '<option value="">No number saved</option>';
        alt.innerHTML    = '<option value="">— None —</option>';
        if (newForm) newForm.style.display = 'block';
    } else {
        mobile.innerHTML = nums.map(n => `<option value="${n}">${n}</option>`).join('');
        alt.innerHTML    = '<option value="">— None —</option>' + nums.map(n => `<option value="${n}">${n}</option>`).join('');
        if (newForm) newForm.style.display = 'none';
    }
}

function renderCheckoutAddresses() {
    const listEl  = document.getElementById('coAddressList');
    const newForm = document.getElementById('coNewAddressForm');
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
        <div>
            <div class="co-addr-label"><i class="fa-solid fa-location-dot" style="color:var(--primary);margin-right:5px;"></i>${a.label||'Home'}</div>
            <div class="co-addr-text">${a.street}, ${a.city}${a.pincode?' — '+a.pincode:''}</div>
        </div>
    </div>`).join('');
}

window.selectAddr = function(i) { selAddrIdx = i; renderCheckoutAddresses(); };

window.toggleNewContact = function() {
    const f = document.getElementById('coNewContactForm');
    if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
};
window.toggleNewAddress = function() {
    const f = document.getElementById('coNewAddressForm');
    if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
};

window.saveNewMobile = async function() {
    const input = document.getElementById('coNewMobile');
    const num   = (input?.value || '').trim();
    if (!/^[6-9]\d{9}$/.test(num)) { showToast('Enter a valid 10-digit number.', 'error'); return; }
    if (!userProfile.mobileNumber) userProfile.mobileNumber = num;
    else {
        if (!userProfile.altMobiles) userProfile.altMobiles = [];
        if (!userProfile.altMobiles.includes(num)) userProfile.altMobiles.push(num);
    }
    if (currentUser) {
        try { await updateDoc(doc(db, 'users', currentUser.uid), { mobileNumber: userProfile.mobileNumber, altMobiles: userProfile.altMobiles }); } catch(_){}
    }
    if (input) input.value = '';
    renderCheckoutContact();
    toggleNewContact();
};

window.saveNewAddress = async function() {
    const street  = document.getElementById('coAddrStreet')?.value.trim();
    const city    = document.getElementById('coAddrCity')?.value.trim();
    if (!street || !city) { showToast('Street and City are required.', 'error'); return; }
    const addr = {
        label:   document.getElementById('coAddrLabel')?.value.trim()   || 'Home',
        street, city,
        pincode: document.getElementById('coAddrPincode')?.value.trim() || ''
    };
    if (!userProfile.addresses) userProfile.addresses = [];
    userProfile.addresses.push(addr);
    selAddrIdx = userProfile.addresses.length - 1;
    if (currentUser) {
        try { await updateDoc(doc(db, 'users', currentUser.uid), { addresses: userProfile.addresses }); } catch(_){}
    }
    ['coAddrLabel','coAddrStreet','coAddrCity','coAddrPincode'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    renderCheckoutAddresses();
    toggleNewAddress();
};

/* ════ PAYMENT OPTIONS RENDER ════ */
function renderPaymentOptions() {
    const block = document.getElementById('coPaymentBlock');
    if (!block) return;

    // Recalculate totals fresh each time
    calculatePrices();
    let subtotal = 0;
    uploadedFiles.forEach(f => { subtotal += f.prices.final; });

    const shop = shopById(selectedShopId) || {};
    const isPickup = (selectedOrderType || window.selectedOrderType) === 'pickup';
    const xeroxRules = shop?.deliveryPrices?.xerox || [];
    const rule = xeroxRules.find(r => subtotal >= r.min && (r.max == null || subtotal <= r.max));
    const freeRule = xeroxRules.find(r => r.fee === 0);
    const deliveryFee = (isPickup || (freeRule && subtotal >= freeRule.min)) ? 0 : (rule?.fee ?? 0);
    const grossAmount = subtotal - xeroxCouponDiscount() + deliveryFee;
    const totalAmount = grossAmount - walletUseFor(grossAmount);

    const mode = effectivePayMode();
    const pct  = _payConfig?.onlineDepositPercent ?? 30;
    const depositAmt = Math.ceil(totalAmount * pct / 100);
    const balanceAmt = totalAmount - depositAmt;

    const fmt = n => `₹${n.toFixed(2)}`;

    if (mode === 'cod_only') {
        // No payment block needed — COD is implicit, button label stays "Place Order"
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
                        <div class="co-pay-radio">
                            <div class="co-pay-radio-dot"></div>
                        </div>
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
                        <div class="co-pay-radio">
                            <div class="co-pay-radio-dot"></div>
                        </div>
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
        // COD is NOT an option in partial mode — admin explicitly requires a deposit
        // Reset any stale COD selection that may have carried over
        if (!selectedPayMethod || selectedPayMethod === 'COD' || selectedPayMethod === 'razorpay') {
            selectedPayMethod = 'partial';
        }
        block.innerHTML = `
        <div class="co-payment-block">
            <div class="co-payment-label"><i class="fa-solid fa-percent"></i> Deposit required to confirm order</div>
            <div class="co-pay-cards">

                <!-- Partial deposit card — only option in this mode -->
                <div class="co-pay-card co-pay-card--active"
                     onclick="selectPayMethod('partial', ${totalAmount})">
                    <div class="co-pay-card-row">
                        <div class="co-pay-card-icon co-pay-card-icon--partial">
                            <i class="fa-solid fa-percent"></i>
                        </div>
                        <div class="co-pay-card-body">
                            <div class="co-pay-card-title">Pay ${pct}% now to confirm</div>
                            <div class="co-pay-card-sub">
                                ${fmt(balanceAmt)} pending — collected on delivery
                            </div>
                        </div>
                        <div class="co-pay-card-amount">${fmt(depositAmt)} now</div>
                    </div>
                    <!-- Deposit breakdown always visible — this is the only choice -->
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
                        <div class="co-pay-full-link" onclick="event.stopPropagation();selectPayMethod('partial_full', ${totalAmount})">
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

/* Select a payment method and re-render the button label */
window.selectPayMethod = function(method, totalAmount) {
    selectedPayMethod = method;
    // Re-render the whole block so active states update
    renderPaymentOptions();
};

/* Update the Place Order button label based on selected method */
function updatePlaceOrderBtn(totalAmount) {
    const btn = document.getElementById('xoPlaceOrderBtn');
    if (!btn) return;
    const fmt = n => `₹${n.toFixed(2)}`;
    const mode = effectivePayMode();
    const pct  = _payConfig?.onlineDepositPercent ?? 30;
    const depositAmt = Math.ceil(totalAmount * pct / 100);

    // partial_online: COD is not allowed — always show deposit button
    if (mode === 'partial_online') {
        if (selectedPayMethod === 'partial_full') {
            btn.innerHTML = `<i class="fa-solid fa-lock"></i> Pay ${fmt(totalAmount)} &amp; Place Order`;
        } else {
            btn.innerHTML = `<i class="fa-solid fa-percent"></i> Pay ${fmt(depositAmt)} &amp; Confirm Order`;
        }
    } else if (mode === 'cod_only' || selectedPayMethod === 'COD') {
        btn.innerHTML = '<i class="fa-solid fa-box-open"></i> Place Order';
    } else if (selectedPayMethod === 'razorpay' || mode === 'online_only') {
        btn.innerHTML = `<i class="fa-solid fa-lock"></i> Pay ${fmt(totalAmount)} &amp; Place Order`;
    } else if (selectedPayMethod === 'partial') {
        btn.innerHTML = `<i class="fa-solid fa-percent"></i> Pay ${fmt(depositAmt)} &amp; Confirm Order`;
    } else if (selectedPayMethod === 'partial_full') {
        btn.innerHTML = `<i class="fa-solid fa-lock"></i> Pay ${fmt(totalAmount)} &amp; Place Order`;
    }
    btn.disabled = false;
}

/* ════ PROCESS CHECKOUT → PLACE ORDER ════ */
window.processCheckout = async function() {
    if (!checkDocConfigs() || !checkCollegeMinOrder()) return;
    const mobile = document.getElementById('coMobile')?.value;
    const alt    = document.getElementById('coAltMobile')?.value || '';
    if (!mobile) {
        const form = document.getElementById('coNewContactForm');
        flagField(form && form.style.display !== 'none' ? form : document.getElementById('coMobile'), 'Please add or select a primary mobile number.', 'error');
        return;
    }

    const isPickup = (selectedOrderType || window.selectedOrderType) === 'pickup';
    const address  = (userProfile.addresses || [])[selAddrIdx];
    if (!isPickup && !address) {
        const form = document.getElementById('coNewAddressForm');
        flagField(form && form.style.display !== 'none' ? form : document.getElementById('coAddressList'), 'Please select or add a delivery address.', 'error');
        return;
    }

    const mode = effectivePayMode();

    // COD path — write order directly to Firestore, no Razorpay
    // Guard: COD is never allowed in partial_online or online_only
    if (mode === 'cod_only' || (selectedPayMethod === 'COD' && mode !== 'partial_online' && mode !== 'online_only')) {
        await placeOrder({ mobile, altMobile: alt }, address);
        return;
    }

    // Online / partial path — Razorpay flow
    calculatePrices();
    let subtotal = 0, requiresManualEst = false;
    uploadedFiles.forEach(f => {
        if (f.config.colorMode === 'custom') requiresManualEst = true;
        else subtotal += f.prices.final;
    });

    const shop = shopById(selectedShopId) || {};
    const xeroxRules = shop?.deliveryPrices?.xerox || [];
    const rule       = xeroxRules.find(r => subtotal >= r.min && (r.max == null || subtotal <= r.max));
    const freeRule   = xeroxRules.find(r => r.fee === 0);
    let deliveryFee = (isPickup || (freeRule && subtotal >= freeRule.min)) ? 0 : (rule?.fee ?? 0);
    let couponDiscount = 0;
    let couponRedeemedFor = null;   // groupOrderId to release if payment never completes
    let walletRedeemedFor = null;
    let walletAmount      = 0;
    let paymentCaptured   = false;
    let placedOrders      = [];     // cancelled if the payment window is closed
    let rzpOpened         = false;
    let totalAmount = subtotal + deliveryFee;

    const pct        = _payConfig?.onlineDepositPercent ?? 30;
    let depositAmt = 0, balanceAmt = 0;

    let chargeAmount, payMethod, payStatus;
    if (selectedPayMethod === 'partial') {
        payMethod    = 'partial';
        payStatus    = 'partial_paid';
    } else {
        payMethod    = 'razorpay';
        payStatus    = 'pending';
    }

    const btn = document.getElementById('xoPlaceOrderBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing…'; }

    try {
        // 1. Write order to Firestore (paymentPending) to get a doc ID
        const orderRef     = doc(collection(db, 'orders'));
        const firestoreId  = orderRef.id;
        const groupOrderId = genId();

        // Server prices the documents + delivery; the order must use these exact values
        const quoted    = await quoteXeroxOrder(groupOrderId, isPickup);
        const documents = quoted.documents;
        subtotal    = quoted.subtotal;
        deliveryFee = quoted.deliveryFee;

        // Redeem coupon (server-side) before totals are final
        couponDiscount = await redeemForOrder(subtotal, groupOrderId, 'online');
        if (appliedCoupon) couponRedeemedFor = groupOrderId;
        walletAmount = await redeemWalletForOrder(subtotal - couponDiscount + deliveryFee, groupOrderId, 'online');
        if (walletAmount > 0) walletRedeemedFor = groupOrderId;
        totalAmount  = subtotal - couponDiscount - walletAmount + deliveryFee;
        depositAmt   = Math.ceil(totalAmount * pct / 100);
        balanceAmt   = totalAmount - depositAmt;
        chargeAmount = payMethod === 'partial' ? depositAmt : totalAmount;

        await Promise.all([
            setDoc(orderRef, {
                groupOrderId,
                userId:      currentUser.uid,
                userName:    userProfile.fullName || 'Customer',
                shopId:      selectedShopId,
                shopName:    shop.name || 'Unknown Shop',
                shopAddress: shop.address || '',
                shopLocationLink: shop.locationLink || '',
                shopContacts: {
                    mobile:   shop.mobileNumbers   || (shop.phone    ? [shop.phone]    : []),
                    whatsapp: shop.whatsappNumbers || (shop.whatsapp ? [shop.whatsapp] : []),
                },
                type: 'xerox', status: 'Pending',
                fulfillmentType: isPickup ? 'pickup' : 'delivery',
                fulfillmentLabel: isPickup ? 'Pick Myself' : 'Delivery',
                isPickup: isPickup,
                deliveryMode: isPickup ? 'pickup' : 'delivery',
                paymentMethod: payMethod, paymentStatus: 'pending',
                createdAt: serverTimestamp(),
                subtotal, deliveryFee, totalAmount,
                couponCode: appliedCoupon?.code || null,
                discountAmount: couponDiscount,
                walletAmount,
                amountPaid: 0,
                balanceDue: payMethod === 'partial' ? balanceAmt : totalAmount,
                requiresManualEstimation: requiresManualEst,
                deliveryAddress: isPickup ? null : address,
                contacts: { mobile, altMobile: alt },
                documents,
            }),
            setDoc(doc(db, 'order_status', firestoreId), {
                status: 'Pending', userId: currentUser.uid,
                shopId: selectedShopId, updatedAt: serverTimestamp(), lastUpdatedBy: 'user',
            }),
        ]);
        placedOrders = [{ id: firestoreId, shopId: null }];   // this path doesn't bump newOrdersCount

        // 2. Create Razorpay order on Node server
        const serverBase = window.__JASA_SERVER || PAYMENT_SERVER_URL;
        let idToken = '';
        try { idToken = await currentUser.getIdToken(); } catch (_) {}

        const createRes = await fetch(`${serverBase}/api/payment/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': idToken ? `Bearer ${idToken}` : '' },
            body: JSON.stringify({
                jasaOrderIds: [firestoreId],
                groupOrderId, amount: chargeAmount,
                userId: currentUser.uid, userEmail: currentUser?.email || '',
                userName: userProfile.fullName || 'Customer',
            }),
        });
        if (!createRes.ok) {
            const err = await createRes.json().catch(() => ({}));
            throw new Error(err.error || `Payment server error (${createRes.status})`);
        }
        const { razorpayOrderId, amount: rzpAmount, currency, keyId } = await createRes.json();

        // 3. Open Razorpay modal
        if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Opening Payment…';

        await new Promise((resolve, reject) => {
            const options = {
                key: keyId, amount: rzpAmount, currency,
                name: 'JASA Essential',
                description: payMethod === 'partial'
                    ? `Deposit ${pct}% — Order ${groupOrderId}`
                    : `Order ${groupOrderId}`,
                order_id: razorpayOrderId,
                prefill: {
                    name:    userProfile.fullName || 'Customer',
                    email:   currentUser?.email   || '',
                    contact: mobile,
                },
                theme: { color: '#2D8CF0' },

                handler: async function(response) {
                    paymentCaptured = true;
                    if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying…';
                    try {
                        const verifyRes = await fetch(`${serverBase}/api/payment/verify`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': idToken ? `Bearer ${idToken}` : '' },
                            body: JSON.stringify({
                                razorpay_order_id:   response.razorpay_order_id,
                                razorpay_payment_id: response.razorpay_payment_id,
                                razorpay_signature:  response.razorpay_signature,
                            }),
                        });
                        if (!verifyRes.ok) {
                            const err = await verifyRes.json().catch(() => ({}));
                            throw new Error(err.error || 'Payment verification failed');
                        }

                        // /api/payment/verify has already stamped paymentStatus, amountPaid and
                        // balanceDue on the order (customers may not write those fields)

                        closeCheckoutSheet();
                        showToast('Payment confirmed! Order placed.', 'success');
                        uploadedFiles.length = 0;

                        // WhatsApp redirect for files marked as whatsapp
                        const waFiles = documents.filter(d => d.uploadStatus === 'whatsapp');
                        if (waFiles.length > 0) {
                            const rawNums  = (shop.whatsappNumbers || []).concat(shop.whatsapp ? [shop.whatsapp] : []);
                            const fallback = (shop.mobileNumbers   || []).concat(shop.phone    ? [shop.phone]    : []);
                            const nums     = rawNums.length ? rawNums : fallback;
                            const firstNum = nums[0]?.toString().replace(/\D/g, '').slice(-10);
                            if (firstNum) {
                                const waMsg = buildWhatsAppOrderMessage({
                                    orderId: groupOrderId, shopData: shop,
                                    contacts: { mobile, altMobile: alt },
                                    deliveryAddress: isPickup ? null : address,
                                    documents, waFiles, subtotal, deliveryApply: deliveryFee,
                                    totalAmount, requiresManualEst,
                                });
                                const waUrl = `https://wa.me/91${firstNum}?text=${encodeURIComponent(waMsg)}`;
                                setTimeout(() => {
                                    const iconEl = document.getElementById('xoConfirmIcon');
                                    if (iconEl) { iconEl.innerHTML = '<i class="fa-brands fa-whatsapp"></i>'; iconEl.style.background = 'rgba(37,211,102,0.12)'; iconEl.style.color = '#25D366'; }
                                    showConfirm({
                                        title: 'Open WhatsApp to Send Files',
                                        msg: `Order placed! Open WhatsApp to send ${waFiles.length} file(s) to ${shop.name || 'the shop'}.`,
                                        okLabel: 'Open WhatsApp', okDanger: false, okColor: '#25D366',
                                        onOk: () => { window.open(waUrl, '_blank'); window.location.href = 'orders.html'; },
                                    });
                                    const cancelBtn = document.getElementById('xoConfirmCancel');
                                    if (cancelBtn) cancelBtn.onclick = () => { window.location.href = 'orders.html'; };
                                }, 800);
                                resolve(); return;
                            }
                        }

                        setTimeout(() => window.location.href = 'orders.html', 1600);
                        resolve();
                    } catch (verifyErr) {
                        console.error('[xerox] verify error:', verifyErr);
                        showToast('Payment done but verification failed. Contact support.', 'error');
                        reject(verifyErr);
                    }
                },

                modal: {
                    ondismiss: function() {
                        if (!paymentCaptured) cancelUnpaidOrders(placedOrders);
                        if (couponRedeemedFor && !paymentCaptured) {
                            releaseCoupon(currentUser, couponRedeemedFor);
                            couponRedeemedFor = null;
                        }
                        if (walletRedeemedFor && !paymentCaptured) {
                            releaseWallet(currentUser, walletRedeemedFor);
                            walletRedeemedFor = null;
                        }
                        showToast('Payment cancelled.', '');
                        if (btn) { btn.disabled = false; renderPaymentOptions(); }
                        resolve();
                    },
                },
            };
            const rzp = new window.Razorpay(options);
            rzpOpened = true;
            rzp.open();
        });

    } catch (err) {
        console.error('[xerox] processCheckout error:', err);
        if (!rzpOpened && placedOrders.length) await cancelUnpaidOrders(placedOrders);
        if (couponRedeemedFor && !paymentCaptured) await releaseCoupon(currentUser, couponRedeemedFor);
        if (walletRedeemedFor && !paymentCaptured) await releaseWallet(currentUser, walletRedeemedFor);
        showToast(`Failed: ${err.message}`, 'error');
        if (btn) { btn.disabled = false; renderPaymentOptions(); }
    }
};

/* ════ PLACE ORDER ════ */
async function placeOrder(contacts, deliveryAddress) {
    if (!checkDocConfigs() || !checkCollegeMinOrder()) return;
    if (!currentUser) {
        showToast('Please sign in to place an order.', 'error');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }
    if (!selectedShopId) { showToast('Please select a shop.', 'error'); return; }

    const btn = document.getElementById('xoPlaceOrderBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Placing Order…'; }

    let couponRedeemedFor = null;
    let walletRedeemedFor = null;

    try {
        const groupOrderId      = genId();
        const shopData          = shopById(selectedShopId) || {};
        const isPickupOrder     = (selectedOrderType || window.selectedOrderType) === 'pickup';
        const requiresManualEst = false;

        // Server prices the documents + delivery; the order must use these exact values
        const quoted        = await quoteXeroxOrder(groupOrderId, isPickupOrder);
        const documents     = quoted.documents;
        const subtotal      = quoted.subtotal;
        const deliveryApply = quoted.deliveryFee;

        const couponDiscount = await redeemForOrder(subtotal, groupOrderId, 'cod');
        if (appliedCoupon) couponRedeemedFor = groupOrderId;
        const walletAmount  = await redeemWalletForOrder(subtotal - couponDiscount + deliveryApply, groupOrderId, 'cod');
        if (walletAmount > 0) walletRedeemedFor = groupOrderId;
        const totalAmount   = subtotal - couponDiscount - walletAmount + deliveryApply;

        const orderPayload = {
            groupOrderId,
            userId:      currentUser.uid,
            userName:    userProfile.fullName || 'Customer',
            shopId:      selectedShopId,
            shopName:    shopData.name || 'Unknown Shop',
            shopAddress: shopData.address || '',
            shopLocationLink: shopData.locationLink || '',
            shopContacts: {
                mobile:    shopData.mobileNumbers  || (shopData.phone    ? [shopData.phone]    : []),
                whatsapp:  shopData.whatsappNumbers|| (shopData.whatsapp ? [shopData.whatsapp] : [])
            },
            type:        'xerox',
            status:      'Pending',
            fulfillmentType: isPickupOrder ? 'pickup' : 'delivery',
            fulfillmentLabel: isPickupOrder ? 'Pick Myself' : 'Delivery',
            isPickup:    isPickupOrder,
            deliveryMode: isPickupOrder ? 'pickup' : 'delivery',
            paymentMethod: 'COD',
            paymentStatus: 'cod',
            createdAt:   serverTimestamp(),
            subtotal,
            deliveryFee: deliveryApply,
            couponCode:  appliedCoupon?.code || null,
            discountAmount: couponDiscount,
            walletAmount,
            totalAmount,
            amountPaid:  0,
            balanceDue:  totalAmount,
            requiresManualEstimation: requiresManualEst,
            deliveryAddress: isPickupOrder ? null : deliveryAddress,
            contacts,
            documents
        };

        const orderRef = doc(collection(db, 'orders'));
        const orderId  = orderRef.id;

        await Promise.all([
            setDoc(orderRef, orderPayload),
            setDoc(doc(db, 'order_status', orderId), {
                status: 'Pending', userId: currentUser.uid,
                shopId: selectedShopId, updatedAt: serverTimestamp(), lastUpdatedBy: 'user'
            }),
            updateDoc(doc(db, 'shops', selectedShopId), { newOrdersCount: increment(1) }).catch(()=>{})
        ]);

        closeCheckoutSheet();

        showToast('Order placed successfully!', 'success');

        // WhatsApp redirect for files marked as whatsapp — fires after order is placed
        const waFiles = documents.filter(d => d.uploadStatus === 'whatsapp');
        if (waFiles.length > 0) {
            const rawNums  = (shopData.whatsappNumbers || []).concat(shopData.whatsapp ? [shopData.whatsapp] : []);
            const fallback = (shopData.mobileNumbers   || []).concat(shopData.phone    ? [shopData.phone]    : []);
            const nums     = rawNums.length ? rawNums : fallback;
            const firstNum = nums[0]?.toString().replace(/\D/g, '').slice(-10);

            if (firstNum) {
                const waMsg = buildWhatsAppOrderMessage({
                    orderId:     groupOrderId,
                    shopData,
                    contacts,
                    deliveryAddress,
                    documents,
                    waFiles,
                    subtotal,
                    deliveryApply,
                    totalAmount,
                    requiresManualEst
                });
                const waUrl = `https://wa.me/91${firstNum}?text=${encodeURIComponent(waMsg)}`;

                // Show confirmation popup before opening WhatsApp
                setTimeout(() => {
                    const iconEl = document.getElementById('xoConfirmIcon');
                    if (iconEl) {
                        iconEl.innerHTML = '<i class="fa-brands fa-whatsapp"></i>';
                        iconEl.style.background = 'rgba(37,211,102,0.12)';
                        iconEl.style.color = '#25D366';
                    }
                    showConfirm({
                        title:    'Open WhatsApp to Send Files',
                        msg:      `Your order #${groupOrderId} is placed! Now open WhatsApp to send ${waFiles.length} file${waFiles.length > 1 ? 's' : ''} to ${shopData.name || 'the shop'}.`,
                        okLabel:  'Open WhatsApp',
                        okDanger: false,
                        okColor:  '#25D366',
                        onOk: () => {
                            window.open(waUrl, '_blank');
                            uploadedFiles.length = 0;
                            window.location.href = 'orders.html';
                        }
                    });
                    // Override cancel to still navigate away
                    const cancelBtn = document.getElementById('xoConfirmCancel');
                    if (cancelBtn) {
                        const origClick = cancelBtn.onclick;
                        cancelBtn.onclick = () => {
                            if (origClick) origClick();
                            uploadedFiles.length = 0;
                            window.location.href = 'orders.html';
                        };
                    }
                }, 800);
                return; // don't auto-redirect; let the popup handle it
            }
        }

        uploadedFiles.length = 0;
        setTimeout(() => window.location.href = 'orders.html', 1600);

    } catch(e) {
        console.error('Order failed:', e);
        if (couponRedeemedFor) await releaseCoupon(currentUser, couponRedeemedFor);
        if (walletRedeemedFor) await releaseWallet(currentUser, walletRedeemedFor);
        showToast(e.isCoupon || e.isWallet || e.isQuote ? e.message : 'Order failed. Please try again.', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-box-open"></i> Place Order'; }
    }
}

/* ════ WHATSAPP ORDER MESSAGE BUILDER ════ */
function buildWhatsAppOrderMessage({ orderId, shopData, contacts, deliveryAddress, documents, waFiles, subtotal, deliveryApply, totalAmount, requiresManualEst }) {
    const userName   = userProfile.fullName || 'Customer';
    const userMobile = contacts.mobile || userProfile.mobileNumber || '';
    const altMobile  = contacts.altMobile || '';
    const addr       = deliveryAddress
        ? `${deliveryAddress.street}, ${deliveryAddress.city}${deliveryAddress.pincode ? ' - ' + deliveryAddress.pincode : ''}`
        : 'Not specified';

    // All files breakdown
    const allFileLines = documents.map((d, idx) => {
        const cfg      = d.config;
        const paper    = xeroxConfig.paper.find(p => p.id === cfg.paperId)?.name      || 'Standard';
        const binding  = bindingText(cfg);
        const laminate = cfg.laminationId !== 'none'
            ? (xeroxConfig.lamination.find(l => l.id === cfg.laminationId)?.name || '') : '';
        const color    = cfg.color === 'color' ? 'Color' : cfg.color === 'mixed' ? 'Mixed' : 'B&W';
        const format   = cfg.format === 'both' ? 'Front & Back' : 'Front Only';
        const priceStr = cfg.colorMode === 'custom'
            ? 'Seller Estimate' : `Rs.${d.price.toFixed(2)}`;
        const book     = cfg.bindingSet;
        const uploadTag = d.uploadStatus === 'uploaded'  ? '✅ Uploaded'
                        : d.uploadStatus === 'whatsapp'  ? '📲 Send via WhatsApp'
                        : d.uploadStatus === 'later'     ? '🕐 Will upload later'
                        : '';

        const lines = [
            `*${idx + 1}. ${d.name}*`,
            `   Pages: ${d.pages}  |  Copies: ${cfg.quantity}`,
            `   Paper: ${paper}  |  Color: ${color}`,
            `   Format: ${format}  |  Layout: ${ratioText(cfg.ratio)}`,
        ];
        if (binding)   lines.push(`   Binding: ${binding}`);
        if (book)      lines.push(`   Bind together: file ${book.position} of ${book.size} in one book`);
        if (laminate)  lines.push(`   Lamination: ${laminate}`);
        if (cfg.color === 'mixed')
            lines.push(`   Colour Pages: ${cfg.colorPages} (rest B&W)`);
        if (cfg.instructions)
            lines.push(`   Instructions: ${cfg.instructions}`);
        lines.push(`   Price: ${priceStr}`);
        lines.push(`   Status: ${uploadTag}`);
        return lines.join('\n');
    }).join('\n\n');

    // Files to physically send section
    const sendFileLines = waFiles.map((d, idx) =>
        `  ${idx + 1}. ${d.name}  (${d.pages} pages)  [ID: ${d.fileOrderId}]`
    ).join('\n');

    const deliveryLine = requiresManualEst
        ? `Rs.${subtotal.toFixed(2)} + seller estimate pending`
        : deliveryApply === 0
            ? `Rs.${subtotal.toFixed(2)} + FREE delivery 🎉`
            : `Rs.${subtotal.toFixed(2)} + Rs.${deliveryApply.toFixed(2)} delivery = *Rs.${totalAmount.toFixed(2)}*`;

    return [
        `🖨️ *XEROX ORDER — JASA Essential*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `📋 *Order ID:* ${orderId}`,
        `🏪 *Shop:* ${shopData.name || 'Unknown'}`,
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        `👤 *CUSTOMER DETAILS*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        `Name:    ${userName}`,
        `Mobile:  ${userMobile}`,
        altMobile ? `Alt No:  ${altMobile}` : null,
        `Address: ${addr}`,
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        `📁 *DOCUMENTS (${documents.length} total)*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        allFileLines,
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        `💰 *PRICING*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        deliveryLine,
        `Payment: Cash on Delivery`,
        ``,
        waFiles.length > 0 ? [
            `━━━━━━━━━━━━━━━━━━━━━━━━`,
            `📲 *PLEASE RECEIVE THESE FILES*`,
            `━━━━━━━━━━━━━━━━━━━━━━━━`,
            sendFileLines,
            ``,
            `⚠️ Reply to confirm receipt of files.`,
        ].join('\n') : null,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        `✅ Order placed via JASA Essential App.`,
        `Please confirm & process the order.`,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].filter(l => l !== null).join('\n');
}

/* ════ HELPERS ════ */
function genId(len = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    for (const b of arr) id += chars[b % chars.length];
    return id;
}

function esc(s) {
    return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
}

/* HTML-escape text placed inside markup */
function h(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function showToast(msg, type = 'success') {
    const container = document.getElementById('xoToastContainer');
    if (!container) return;

    const icons = {
        success: 'fa-circle-check',
        error:   'fa-circle-xmark',
        warning: 'fa-triangle-exclamation',
        info:    'fa-circle-info',
        '':      'fa-bell'
    };
    const colors = {
        success: '#16a34a',
        error:   '#ef4444',
        warning: '#f59e0b',
        info:    'var(--primary, #2D8CF0)',
        '':      'var(--txt2, #374151)'
    };

    const icon  = icons[type]  || icons[''];
    const color = colors[type] || colors[''];

    const toast = document.createElement('div');
    toast.className = 'xo-toast-card';
    toast.innerHTML = `
        <div class="xo-toast-icon" style="color:${color};">
            <i class="fa-solid ${icon}"></i>
        </div>
        <div class="xo-toast-msg">${msg}</div>
        <button class="xo-toast-close" onclick="this.closest('.xo-toast-card').remove()">
            <i class="fa-solid fa-xmark"></i>
        </button>`;

    container.appendChild(toast);
    // Trigger animation
    requestAnimationFrame(() => toast.classList.add('show'));

    // Auto remove after 3s
    const t = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 350);
    }, 3000);

    toast.querySelector('.xo-toast-close').addEventListener('click', () => clearTimeout(t));
}

// Expose for inline event handlers and renderFinalSummary re-call
window.uploadedFiles      = uploadedFiles;
window.renderFinalSummary = renderFinalSummary;
window.selectedOrderType  = null; // updated by selectOrderType()
