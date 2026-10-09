/* ═══════════════════════════════════════════════
   ADMIN ORDER DETAILS — admin-order-details.js
   URL param: ?orderId=xxx
   • Admin-only auth guard
   • Real-time listener on orders/{id}
   • Per-item status update via sheet
   • Delete order
   • Full customer info, shop, pricing, config
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import {
    doc, getDoc, getDocs, collection,
    updateDoc, deleteDoc, setDoc,
    onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { WORKER_URL } from './env-config.js';
import './secure-files.js';   // opens customer files via signed links
import { moveBookCharge } from './xerox-book.js';

/* ── URL param ── */
const orderId = new URLSearchParams(window.location.search).get('orderId');

/* ── State ── */
let currentOrder    = null;
let xeroxMeta       = { paper: [], binding: [], lamination: [] };
let _cachedProfile  = null;

/* ── STATUS MAP ── */
const STATUS_MAP = {
    pending:            { label: 'Pending',          color: '#f59e0b', bg: '#fef3c7', icon: 'fa-solid fa-hourglass-half'       },
    confirmed:          { label: 'Confirmed',         color: '#2D8CF0', bg: '#deeeff', icon: 'fa-solid fa-circle-check'         },
    accepted:           { label: 'Confirmed',         color: '#2D8CF0', bg: '#deeeff', icon: 'fa-solid fa-circle-check'         },
    processing:         { label: 'Processing',        color: '#06b6d4', bg: '#cffafe', icon: 'fa-solid fa-gears'                },
    'out for delivery': { label: 'Out for Delivery',  color: '#10b981', bg: '#d1fae5', icon: 'fa-solid fa-truck-fast'           },
    delivered:          { label: 'Delivered',         color: '#16a34a', bg: '#dcfce7', icon: 'fa-solid fa-circle-check'         },
    cancelled:          { label: 'Cancelled',         color: '#ef4444', bg: '#fee2e2', icon: 'fa-solid fa-circle-xmark'         },
    rejected:           { label: 'Rejected',          color: '#ef4444', bg: '#fee2e2', icon: 'fa-solid fa-triangle-exclamation' },
};
const STATUS_ORDER = ['pending','confirmed','processing','out for delivery','delivered','cancelled','rejected'];

function getStatus(raw) {
    return STATUS_MAP[(raw || 'pending').toLowerCase().trim()]
        || { label: raw || 'Pending', color: '#6b7280', bg: '#f3f4f6', icon: 'fa-solid fa-circle-dot' };
}

/* ── Helpers ── */
function esc(s) {
    return String(s || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDateTime(raw) {
    if (!raw) return '—';
    try {
        const d = raw.toDate ? raw.toDate() : new Date((raw.seconds || 0) * 1000);
        return d.toLocaleDateString('en-IN', {
            weekday: 'short', day: '2-digit', month: 'long',
            year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
        });
    } catch { return '—'; }
}
const COLOR_LABELS  = { bw: 'Black & White', color: 'Color', mixed: 'Mixed (B&W + Colour)' };
const FORMAT_LABELS = { frontOnly: 'Front Only', both: 'Front & Back' };
/* Pages to print in colour — `mixed` orders; `customColorPages` is the older field */
function colorPagesRow(cfg) {
    if (cfg.color === 'mixed') return ['Colour Pages', `${cfg.colorPages} (${cfg.colorPageCount} pg, rest B&W)`];
    if (cfg.colorMode === 'custom' && cfg.customColorPages) return ['Colour Pages', cfg.customColorPages];
    return null;
}
/* Files the customer wants bound together as one book */
function bindingSetRow(cfg) {
    const s = cfg.bindingSet;
    if (!s) return null;
    return ['Bind Together', `File ${s.position} of ${s.size} in one book (${s.files.join(' → ')})${s.chargedHere ? ' · binding charged on this file' : ''}`];
}
function resolveId(list, id) {
    if (!id || id === 'none') return null;
    return list.find(x => x.id === id)?.name || null;
}

/* ── Toast ── */
function toast(msg, type = '') {
    const el = document.getElementById('soToast');
    el.textContent = msg;
    el.className   = 'so-toast ' + type;
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── Status badge helper ── */
function statusBadge(raw) {
    const s = (raw || 'pending').toLowerCase().trim();
    const map = {
        pending:            { cls: 'sod-status--pending',   icon: 'fa-solid fa-hourglass-half',       label: 'Pending'          },
        confirmed:          { cls: 'sod-status--confirmed',  icon: 'fa-solid fa-circle-check',         label: 'Confirmed'        },
        accepted:           { cls: 'sod-status--confirmed',  icon: 'fa-solid fa-circle-check',         label: 'Confirmed'        },
        processing:         { cls: 'sod-status--processing', icon: 'fa-solid fa-gears',                label: 'Processing'       },
        'out for delivery': { cls: 'sod-status--delivery',   icon: 'fa-solid fa-truck-fast',           label: 'Out for Delivery' },
        delivered:          { cls: 'sod-status--delivered',  icon: 'fa-solid fa-circle-check',         label: 'Delivered'        },
        cancelled:          { cls: 'sod-status--cancelled',  icon: 'fa-solid fa-circle-xmark',         label: 'Cancelled'        },
        rejected:           { cls: 'sod-status--rejected',   icon: 'fa-solid fa-triangle-exclamation', label: 'Rejected'         },
    };
    const m = map[s] || { cls: 'sod-status--pending', icon: 'fa-solid fa-circle-dot', label: raw || 'Pending' };
    return `<span class="sod-item-status-badge ${m.cls}"><i class="${m.icon}"></i>${m.label}</span>`;
}

/* ── 3-step item progress tracker ── */
function buildItemTracker(rawStatus, rejectionMessage) {
    const s = (rawStatus || 'pending').toLowerCase().trim();

    if (s === 'rejected' || s === 'cancelled') {
        const title  = s === 'rejected' ? 'Item Rejected' : 'Item Cancelled';
        const detail = rejectionMessage
            ? `<div class="sod-rej-reason"><i class="fa-solid fa-quote-left" style="opacity:.5;margin-right:4px;font-size:.6rem;"></i>${esc(rejectionMessage)}</div>`
            : `<div class="sod-rej-reason">${s === 'rejected' ? 'This item could not be fulfilled.' : 'This item was cancelled.'}</div>`;
        return `
<div class="sod-item-rejected-banner">
    <div class="sod-rej-title"><i class="fa-solid fa-triangle-exclamation"></i>${title}</div>
    ${detail}
</div>`;
    }

    const step       = s === 'delivered' ? 3 : (s === 'confirmed' || s === 'accepted') ? 2 : 1;
    const progressW  = step === 3 ? '66.66%' : step === 2 ? '33.33%' : '0%';
    const progressBg = step === 3 ? '#16a34a' : step === 2 ? '#2D8CF0' : '#f59e0b';

    const stepDefs = [
        { key: 'pending',   icon: 'fa-solid fa-hourglass-half', label: 'Pending'   },
        { key: 'confirmed', icon: 'fa-solid fa-check',           label: 'Confirmed' },
        { key: 'delivered', icon: 'fa-solid fa-truck-fast',      label: 'Delivered' },
    ];

    const stepsHtml = stepDefs.map((sd, i) => {
        const n     = i + 1;
        const done  = n < step;
        const active = n === step;
        const cls   = done ? 'sod-tracker-step--done' : active ? `sod-tracker-step--${sd.key}` : '';
        return `
<div class="sod-tracker-step ${cls}">
    <div class="sod-tracker-dot"><i class="${sd.icon}"></i></div>
    <span class="sod-tracker-label">${sd.label}</span>
</div>`;
    }).join('');

    return `
<div class="sod-item-tracker">
    <div class="sod-tracker-progress" style="width:${progressW};background:${progressBg};"></div>
    ${stepsHtml}
</div>`;
}

/* ── Auth guard (admin only) ── */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search)); return; }
    if (!orderId) { showError(); return; }

    try {
        const snap  = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin')) {
            toast('Admin access required.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1400);
            return;
        }
        await loadXeroxMeta();
        listenToOrder();
    } catch (err) {
        console.error('[AdminOrderDetails] auth:', err);
        showError();
    }
});

/* ── Xerox config metadata ── */
async function loadXeroxMeta() {
    /* 1. Worker edge cache */
    try {
        const res = await fetch(`${WORKER_URL}/api/config/xerox`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            const json = await res.json();
            const cfg  = json.config || json;
            if (cfg.paper?.length || cfg.binding?.length) {
                xeroxMeta.paper      = cfg.paper      || [];
                xeroxMeta.binding    = cfg.binding    || [];
                xeroxMeta.lamination = cfg.lamination || [];
                return;
            }
        }
    } catch (_) {}
    /* 2. Firestore fallback */
    try {
        const [p, b, l] = await Promise.all([
            getDocs(collection(db, 'xerox_config_paper')),
            getDocs(collection(db, 'xerox_config_binding')),
            getDocs(collection(db, 'xerox_config_lamination')),
        ]);
        xeroxMeta.paper      = p.docs.map(d => ({ id: d.id, ...d.data() }));
        xeroxMeta.binding    = b.docs.map(d => ({ id: d.id, ...d.data() }));
        xeroxMeta.lamination = l.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { console.warn('[AdminOrderDetails] xerox meta:', e); }
}

/* ── Real-time order listener ── */
function listenToOrder() {
    onSnapshot(doc(db, 'orders', orderId), async snap => {
        if (!snap.exists()) { showError(); return; }
        currentOrder = { id: snap.id, ...snap.data() };

        // Fetch + cache user profile
        if (currentOrder.userId) {
            if (!_cachedProfile || _cachedProfile.userId !== currentOrder.userId) {
                try {
                    const uSnap = await getDoc(doc(db, 'users', currentOrder.userId));
                    if (uSnap.exists()) {
                        const ud = uSnap.data();
                        _cachedProfile = {
                            userId:        currentOrder.userId,
                            userName:      ud.fullName || ud.name || 'Customer',
                            userEmail:     ud.email  || '',
                            userDisplayId: ud.userId || currentOrder.userId.slice(0, 8).toUpperCase(),
                        };
                    } else {
                        _cachedProfile = {
                            userId: currentOrder.userId,
                            userName: 'Customer', userEmail: '',
                            userDisplayId: currentOrder.userId.slice(0, 8).toUpperCase(),
                        };
                    }
                } catch {
                    _cachedProfile = {
                        userId: currentOrder.userId,
                        userName: 'Customer', userEmail: '',
                        userDisplayId: currentOrder.userId.slice(0, 8).toUpperCase(),
                    };
                }
            }
            currentOrder.userName      = _cachedProfile.userName;
            currentOrder.userEmail     = _cachedProfile.userEmail;
            currentOrder.userDisplayId = _cachedProfile.userDisplayId;
        }

        // Fetch + cache shop data for delivery calc
        if (!currentOrder._shopData && currentOrder.shopId) {
            try {
                const shopSnap = await getDoc(doc(db, 'shops', currentOrder.shopId));
                if (shopSnap.exists()) {
                    currentOrder._shopData = { id: shopSnap.id, ...shopSnap.data() };
                    listenToOrder._shopCache = currentOrder._shopData;
                }
            } catch (e) { console.warn('shop data:', e); }
        } else if (!currentOrder._shopData && listenToOrder._shopCache) {
            currentOrder._shopData = listenToOrder._shopCache;
        }

        render();
    }, err => { console.error('[AdminOrderDetails] snap:', err); showError(); });
}

/* ── Derive effective status from item statuses ── */
function deriveStatus(order) {
    const isXerox = order.type === 'xerox';
    const items   = isXerox ? (order.documents || []) : (order.items || []);
    if (!items.length) return (order.status || 'pending').toLowerCase();

    const statuses = items.map(i => (i.status || 'pending').toLowerCase());
    if (statuses.every(s => s === 'cancelled' || s === 'rejected')) return 'cancelled';

    const active = statuses.filter(s => s !== 'cancelled' && s !== 'rejected');
    if (!active.length) return 'cancelled';
    if (active.some(s => s === 'pending'))          return 'pending';
    if (active.some(s => s === 'confirmed'))         return 'confirmed';
    if (active.some(s => s === 'out for delivery'))  return 'out for delivery';
    if (active.every(s => s === 'delivered'))        return 'delivered';
    return (order.status || 'pending').toLowerCase();
}

window.confirmOpenMap = function(shopName, mapUrl) {
    const msg = `Are you sure you want to open Google Maps to navigate to ${shopName}?`;
    if (window.confirm(msg)) {
        if (mapUrl) window.open(mapUrl, '_blank');
    }
};

/* ── Main render ── */
function render() {
    const o       = currentOrder;
    const isXerox = o.type === 'xerox';
    const items   = isXerox ? (o.documents || []) : (o.items || []);
    const ordRef  = o.groupOrderId || o.id.slice(0, 8).toUpperCase();
    const effSt   = deriveStatus(o);
    const st      = getStatus(effSt);
    const addr    = o.deliveryAddress || {};
    const contacts = o.contacts || {};

    const isPickup = o.fulfillmentType === 'pickup' || o.deliveryMode === 'pickup' || o.isPickup === true || o.orderType === 'pickup' || (o.deliveryFee === 0 && !o.deliveryAddress);
    
    const pMethod   = (o.paymentMethod || '').toLowerCase();
    const pStatus   = (o.paymentStatus || '').toLowerCase();
    const isPartial = pMethod === 'partial' || pStatus === 'partial_paid' || (o.balanceDue > 0 && o.amountPaid > 0);
    const isPaid    = pStatus === 'paid' || pMethod === 'paid' || (pMethod === 'razorpay' && pStatus !== 'pending' && !isPartial);

    let payPillHtml = '';
    if (isPartial) {
        const paidAmt = o.amountPaid || 0;
        const balAmt  = o.balanceDue || Math.max(0, (o.totalAmount || 0) - paidAmt);
        payPillHtml = `<span class="od-status-pill" style="background:#e0f2fe;color:#0284c7;padding:2px 8px;border-radius:50px;font-size:0.75rem;font-weight:700;">
            <i class="fa-solid fa-percent"></i> Partial Paid (₹${paidAmt.toLocaleString('en-IN')} Paid, ₹${balAmt.toLocaleString('en-IN')} Balance)
        </span>`;
    } else if (isPaid) {
        payPillHtml = `<span class="od-status-pill" style="background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:50px;font-size:0.75rem;font-weight:700;">
            <i class="fa-solid fa-circle-check"></i> Paid Online
        </span>`;
    } else {
        payPillHtml = `<span class="od-status-pill" style="background:#fef3c7;color:#d97706;padding:2px 8px;border-radius:50px;font-size:0.75rem;font-weight:700;">
            <i class="fa-solid fa-money-bill-wave"></i> Cash on Delivery (COD)
        </span>`;
    }

    const fulPillHtml = isPickup
        ? `<span class="od-status-pill" style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:50px;font-size:0.75rem;font-weight:700;"><i class="fa-solid fa-store"></i> Pick Myself (Self Pickup)</span>`
        : `<span class="od-status-pill" style="background:#deeeff;color:#2D8CF0;padding:2px 8px;border-radius:50px;font-size:0.75rem;font-weight:700;"><i class="fa-solid fa-truck-fast"></i> Home Delivery</span>`;

    const shopObj   = o._shopData || {};
    const shopName  = shopObj.name || o.shopName || 'Shop';
    const shopAddr  = shopObj.address || o.shopAddress || 'Local Center';
    const rawLink   = shopObj.locationLink || o.shopLocationLink || '';
    const mapUrl    = rawLink || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shopName + ' ' + shopAddr)}`;

    const shopLinkBtn = `
    <button onclick="confirmOpenMap('${esc(shopName)}', '${esc(mapUrl)}')" class="od-map-link-btn" style="margin-top:10px;">
        <i class="fa-solid fa-map-location-dot"></i> View Shop Location &amp; Directions
    </button>`;

    const pickupShopBlock = isPickup ? `
    <div class="od-pickup-shop-card" style="margin-top:16px;">
        <div class="od-psc-head">
            <span class="od-psc-title"><i class="fa-solid fa-store"></i> Self Pickup Center</span>
            <span class="od-psc-badge">Pick Myself</span>
        </div>
        <div class="od-psc-name">${esc(shopName)}</div>
        <div class="od-psc-addr"><i class="fa-solid fa-location-dot" style="color:var(--primary);margin-right:4px;"></i> ${esc(shopAddr)}</div>
        ${shopLinkBtn}
    </div>` : '';

    hideSkeleton();

    document.getElementById('aodTitle').textContent        = `Order #${ordRef}`;
    document.getElementById('aodSub').textContent          = fmtDateTime(o.createdAt);
    document.getElementById('aodOrderIdBadge').textContent = `ORDER #${ordRef}`;

    const billUrl = `generate-bill.html?orderId=${encodeURIComponent(o.id)}${o.shopId ? '&shopId=' + encodeURIComponent(o.shopId) : ''}`;
    const headBtn = document.getElementById('aodHeaderBillBtn');
    if (headBtn) headBtn.href = billUrl;
    const mainBtn = document.getElementById('aodMainBillBtn');
    if (mainBtn) mainBtn.href = billUrl;

    /* ── Pricing calc ── */
    let subtotal = 0, deliveryFee = 0;
    items.forEach(item => {
        const s = (item.status || 'pending').toLowerCase();
        if (!['cancelled','rejected'].includes(s)) {
            subtotal += isXerox
                ? (item.price || 0)
                : ((item.price || 0) * (item.qty || 1));
        }
    });
    if (isPickup) {
        deliveryFee = 0;
    } else if (o._shopData) {
        const rules = isXerox
            ? (o._shopData.deliveryPrices?.xerox   || [])
            : (o._shopData.deliveryPrices?.others  || []);
        const rule = rules.find(r => subtotal >= r.min && (r.max == null || subtotal <= r.max));
        if (rule) deliveryFee = rule.fee || 0;
    } else if (o.deliveryFee != null) {
        deliveryFee = Number(o.deliveryFee);
    }
    const couponDiscount = Math.min(Number(o.discountAmount) || 0, subtotal);
    const walletUsed = Math.min(Number(o.walletAmount) || 0, Math.max(0, subtotal - couponDiscount + deliveryFee));
    const total = subtotal - couponDiscount - walletUsed + deliveryFee;

    /* ── Per-item price rows ── */
    const itemRows = items.map(item => {
        const qty  = item.qty || item.config?.quantity || 1;
        const line = isXerox ? (item.price || 0) : ((item.price || 0) * qty);
        return `<tr class="sod-kv"><td class="kv-key" style="padding-left:20px;color:var(--txt2);">
            ${esc(item.name || 'Item')} ×${qty}</td>
            <td class="kv-val">₹${line.toFixed(2)}</td></tr>`;
    }).join('');

    /* ── KV helpers ── */
    const kv  = (k, v) => `<tr class="sod-kv"><td class="kv-key">${k}</td><td class="kv-val">${v}</td></tr>`;
    const kvS = label  => `<tr class="kv-section"><td colspan="2">${label}</td></tr>`;

    /* ── Summary card ── */
    document.getElementById('aodSummaryCard').innerHTML = `
<div class="sod-section-title"><i class="fa-solid fa-receipt"></i> Order Summary</div>
<table class="sod-kv" style="width:100%;">
    ${kvS('<i class="fa-solid fa-user" style="margin-right:5px;"></i>Customer')}
    ${kv('Name',      esc(o.userName      || 'Guest'))}
    ${kv('User ID',   esc(o.userDisplayId || 'N/A'))}
    ${o.userEmail ? kv('Email', `<a href="mailto:${esc(o.userEmail)}" style="color:var(--primary);">${esc(o.userEmail)}</a>`) : ''}
    ${kv('Mobile',    contacts.mobile
        ? `<a href="tel:${esc(contacts.mobile)}" class="so-call-link"><i class="fa-solid fa-phone"></i> ${esc(contacts.mobile)}</a>`
        : '—')}
    ${contacts.altMobile
        ? kv('Alt Mobile', `<a href="tel:${esc(contacts.altMobile)}" class="so-call-link"><i class="fa-solid fa-phone-volume"></i> ${esc(contacts.altMobile)}</a>`)
        : ''}

    ${kvS('<i class="fa-solid fa-store" style="margin-right:5px;"></i>Order Info')}
    ${kv('Fulfillment', fulPillHtml)}
    ${kv('Shop',      isPickup
        ? `<a href="javascript:void(0)" onclick="confirmOpenMap('${esc(shopName)}', '${esc(mapUrl)}')" style="color:var(--primary);font-weight:700;text-decoration:none;"><i class="fa-solid fa-map-location-dot"></i> ${esc(shopName)} (View Map)</a>`
        : `<span style="font-weight:700;">${esc(shopName)}</span>`)}
    ${kv('Date',      fmtDateTime(o.createdAt))}
    ${kv('Type',      isXerox ? '<span style="color:var(--primary);font-weight:800;">Xerox</span>' : '<span style="color:#16a34a;font-weight:800;">Product</span>')}
    ${kv('Payment',   payPillHtml)}
    ${kv('Status',    `<span class="so-badge" style="background:${st.bg};color:${st.color};"><i class="${st.icon}"></i> ${st.label}</span>`)}

    ${kvS('<i class="fa-solid fa-indian-rupee-sign" style="margin-right:5px;"></i>Pricing')}
    ${itemRows}
    ${kv('Subtotal',  `₹${subtotal.toFixed(2)}`)}
    ${couponDiscount > 0 ? kv(`Coupon${o.couponCode ? ` (${esc(o.couponCode)})` : ''}`, `<span class="kv-free">-₹${couponDiscount.toFixed(2)}</span>`) : ''}
    ${walletUsed > 0 ? kv('Wallet', `<span class="kv-free">-₹${walletUsed.toFixed(2)}</span>`) : ''}
    ${kv('Delivery',  isPickup ? '<span class="kv-free">FREE (Pickup)</span>' : (deliveryFee === 0 ? '<span class="kv-free">FREE</span>' : `₹${deliveryFee.toFixed(2)}`))}
    ${isPartial ? kv('Amount Paid', `<strong style="color:#16a34a;">₹${(o.amountPaid||0).toLocaleString('en-IN')}</strong>`) : ''}
    ${isPartial ? kv('Balance Due', `<strong style="color:#e11d48;">₹${(o.balanceDue||0).toLocaleString('en-IN')}</strong>`) : ''}
    <tr class="sod-kv kv-total">
        <td class="kv-key" style="font-weight:800;color:var(--primary);">Total</td>
        <td class="kv-val" style="font-size:.95rem;font-weight:800;color:var(--primary);">₹${total.toFixed(2)}</td>
    </tr>

    ${isPickup ? kvS('<i class="fa-solid fa-location-dot" style="margin-right:5px;"></i>Pickup Details') : (addr.street || addr.city ? kvS('<i class="fa-solid fa-location-dot" style="margin-right:5px;"></i>Delivery Address') : '')}
    ${isPickup
        ? kv('Pickup Spot', `<span style="font-weight:700;">${esc(shopName)}</span> — <span style="font-size:.78rem;color:var(--txt2);">${esc(shopAddr)}</span>`)
        : (addr.street || addr.city ? `
            ${addr.label   ? kv('Label',   esc(addr.label))   : ''}
            ${addr.street  ? kv('Street',  esc(addr.street))  : ''}
            ${addr.city    ? kv('City',    esc(addr.city))     : ''}
            ${addr.pincode ? kv('Pincode', esc(addr.pincode))  : ''}` : '')
    }
</table>
${pickupShopBlock}
<div style="padding:0 14px 14px;">
    <a href="generate-bill.html?orderId=${encodeURIComponent(o.id)}&shopId=${encodeURIComponent(o.shopId || '')}" class="sod-btn-bill">
        <i class="fa-solid fa-file-invoice-dollar"></i> Generate &amp; Print Bill
    </a>
</div>`;

    /* ── Items list ── */
    document.getElementById('aodItemsList').innerHTML = items.length
        ? items.map((item, i) => isXerox ? buildDocCard(item, i) : buildProductCard(item, i)).join('')
        : `<div class="sod-section" style="padding:16px;font-size:.82rem;color:var(--txt3);text-align:center;">No items in this order.</div>`;
}

/* ── Build xerox document card ── */
function buildDocCard(d, idx) {
    const cfg    = d.config || {};
    const status = d.status || 'pending';
    const us     = (d.uploadStatus || 'pending').toLowerCase();

    let uClass = 'so-badge-upload-pending', uLabel = 'Pending';
    if (us === 'uploaded')                             { uClass = 'so-badge-upload-uploaded'; uLabel = '✓ Uploaded'; }
    else if (us === 'whatsapp')                        { uClass = 'so-badge-upload-whatsapp'; uLabel = '⚡ WhatsApp'; }
    else if (us === 'later' || us === 'pending_later') { uClass = 'so-badge-upload-later';    uLabel = '⚠ Upload Pending'; }

    const paperName = resolveId(xeroxMeta.paper,      cfg.paperId);
    const bindName  = resolveId(xeroxMeta.binding,    cfg.bindingId);
    const lamName   = resolveId(xeroxMeta.lamination, cfg.laminationId);

    const configRows = [
        ['Paper',       paperName || 'Standard'],
        ['Color',       COLOR_LABELS[cfg.color]  || cfg.color  || 'B&W'],
        colorPagesRow(cfg),
        ['Format',      FORMAT_LABELS[cfg.format] || cfg.format || 'Front Only'],
        cfg.ratio && cfg.ratio !== '1:1' ? ['Ratio', cfg.ratio] : null,
        ['Pages',       String(d.pages || 0)],
        ['Copies',      `×${cfg.quantity || 1}`],
        bindName  ? ['Binding',    bindName]  : null,
        bindingSetRow(cfg),
        lamName   ? ['Lamination', lamName]   : null,
    ].filter(Boolean)
     .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
     .join('');

    const fileBtn = (d.uploadedUrl && d.uploadedUrl.startsWith('http'))
        ? `<a href="${esc(d.uploadedUrl)}" data-secure-file data-order-id="${esc(orderId)}" target="_blank" class="sod-file-btn" style="margin:8px 14px 0;">
               <i class="fa-solid fa-eye"></i> View / Download File
           </a>` : '';

    return `
<div class="sod-item-card" id="aodItem-${idx}">
    <div class="sod-item-head">
        <div style="display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;">
            <i class="fa-regular fa-file-pdf sod-item-doc-icon"></i>
            <div class="sod-item-meta-wrap">
                <div class="sod-item-name">${esc(d.name || 'Document')}</div>
                <div class="sod-item-price-sub">
                    ${d.pages || 0} pages &nbsp;·&nbsp; <strong>₹${(d.price || 0).toFixed(2)}</strong>
                    <span class="so-badge ${uClass}">${uLabel}</span>
                </div>
            </div>
        </div>
        ${statusBadge(status)}
    </div>
    ${fileBtn}
    ${buildItemTracker(status, d.rejectionMessage)}
    <div class="sod-config-block">
        <div class="sod-config-title"><i class="fa-solid fa-file-invoice"></i> Print Configuration</div>
        <table class="sod-config-table">${configRows}</table>
    </div>
    ${cfg.instructions
        ? `<div class="sod-instructions">
               <i class="fa-solid fa-note-sticky"></i>
               <span><strong>Instructions:</strong> ${esc(cfg.instructions)}</span>
           </div>` : ''}
    ${buildItemActions(status, idx)}
</div>`;
}

/* ── Build product card ── */
function buildProductCard(item, idx) {
    const qty       = item.qty || 1;
    const lineTotal = (item.price || 0) * qty;
    const img       = item.img || item.images?.[0]?.url || '';

    return `
<div class="sod-item-card" id="aodItem-${idx}">
    <div class="sod-item-head">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
            <div class="sod-item-product-img">
                ${img
                    ? `<img src="${esc(img)}" alt="${esc(item.name || '')}" loading="lazy">`
                    : '<i class="fa-solid fa-box"></i>'}
            </div>
            <div class="sod-item-meta-wrap">
                <div class="sod-item-name">${esc(item.name || 'Product')}</div>
                <div class="sod-item-price-sub">
                    ₹${(item.price || 0).toFixed(2)} × ${qty}
                    = <strong>₹${lineTotal.toFixed(2)}</strong>
                </div>
            </div>
        </div>
        ${statusBadge(item.status || 'pending')}
    </div>
    ${item.customPhoto ? `
    <div style="margin:8px 0 2px;padding:8px 10px;border:1.5px dashed #ec4899;border-radius:10px;font-size:.78rem;font-weight:700;">
        <a href="${esc(item.customPhoto)}" data-secure-file data-order-id="${esc(orderId)}" target="_blank" rel="noopener" style="color:#ec4899;text-decoration:none;">
            <i class="fa-solid fa-download"></i> ${item.customPreview ? "Customer's original picture" : "Customer's photo to print"}: open / download
        </a>
        ${item.customPreview ? `<br><a href="${esc(item.customPreview)}" data-secure-file data-order-id="${esc(orderId)}" target="_blank" rel="noopener" style="color:#ec4899;text-decoration:none;">
            <i class="fa-solid fa-crop-simple"></i> Fitted to the poster size (print this): open / download
        </a>` : ''}
        ${item.customNote ? `<div style="margin-top:6px;font-weight:600;color:var(--txt2,#555);"><i class="fa-regular fa-note-sticky"></i> ${esc(item.customNote)}</div>` : ''}
    </div>` : ''}
    ${buildItemTracker(item.status || 'pending', item.rejectionMessage)}
    ${buildItemActions(item.status || 'pending', idx)}
</div>`;
}

/* ════════════════════════════════
   INLINE ITEM ACTIONS
   Same pattern as seller-order-details.js:
   pending   → Confirm + Reject
   confirmed → Mark Delivered + Reject
   others    → no buttons
   ════════════════════════════════ */
function buildItemActions(itemStatus, idx) {
    const s = (itemStatus || 'pending').toLowerCase();

    if (s === 'pending') {
        return `
<div class="sod-item-actions">
    <button class="sod-action-btn sod-action-confirm" onclick="confirmItem(${idx})">
        <i class="fa-solid fa-check"></i> Confirm
    </button>
    <button class="sod-action-btn sod-action-reject" onclick="openRejectSheet(${idx})">
        <i class="fa-solid fa-ban"></i> Reject
    </button>
</div>`;
    }

    if (s === 'confirmed' || s === 'accepted') {
        return `
<div class="sod-item-actions">
    <button class="sod-action-btn sod-action-deliver" onclick="deliverItem(${idx})">
        <i class="fa-solid fa-circle-check"></i> Mark Delivered
    </button>
    <button class="sod-action-btn sod-action-reject" onclick="openRejectSheet(${idx})">
        <i class="fa-solid fa-ban"></i> Reject
    </button>
</div>`;
    }

    return ''; // delivered / rejected / cancelled — no actions
}

window.confirmItem = async function(idx) {
    await updateSingleItem(idx, { status: 'confirmed' });
};

window.deliverItem = async function(idx) {
    await updateSingleItem(idx, { status: 'delivered' });
};

/* ── Reject sheet ── */
let _rejectItemIdx = null;

window.openRejectSheet = function(idx) {
    _rejectItemIdx = idx;
    const isXerox = currentOrder?.type === 'xerox';
    const items   = isXerox ? (currentOrder?.documents || []) : (currentOrder?.items || []);
    const name    = items[idx]?.name || 'Item';
    document.getElementById('aodRejectItemName').textContent = name;
    document.getElementById('aodRejectReason').value = '';
    document.getElementById('aodRejectOverlay').classList.add('open');
    document.getElementById('aodRejectSheet').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.closeRejectSheet = function() {
    document.getElementById('aodRejectOverlay').classList.remove('open');
    document.getElementById('aodRejectSheet').classList.remove('open');
    document.body.style.overflow = '';
    _rejectItemIdx = null;
};

window.confirmReject = async function() {
    if (_rejectItemIdx === null) return;
    const idx    = _rejectItemIdx;   // capture before closeRejectSheet nulls it
    const reason = document.getElementById('aodRejectReason').value.trim() || 'Rejected by admin';
    closeRejectSheet();
    await updateSingleItem(idx, { status: 'rejected', rejectionMessage: reason });
};

/* ── Core per-item update (mirrors seller pattern) ── */
async function updateSingleItem(idx, patch) {
    if (!currentOrder) return;
    const isXerox = currentOrder.type === 'xerox';
    const field   = isXerox ? 'documents' : 'items';
    let items     = [...(currentOrder[field] || [])];

    items[idx] = { ...items[idx], ...patch };
    // A rejected book file hands its binding charge to the book's next file
    if (isXerox) items = moveBookCharge(items);

    document.querySelectorAll('.sod-action-btn').forEach(b => { b.disabled = true; });

    try {
        const derived = deriveStatus({ ...currentOrder, [field]: items });

        await Promise.all([
            updateDoc(doc(db, 'orders', currentOrder.id), {
                [field]: items,
                status:  derived
            }),
            setDoc(doc(db, 'order_status', currentOrder.id), {
                status:        derived,
                updatedAt:     serverTimestamp(),
                lastUpdatedBy: 'admin'
            }, { merge: true })
        ]);

        currentOrder[field] = items;
        currentOrder.status = derived;
        toast('Item updated', 'success');
        render();
    } catch (err) {
        console.error('[AdminOrderDetails] updateSingleItem:', err);
        toast('Update failed: ' + err.message, 'error');
        document.querySelectorAll('.sod-action-btn').forEach(b => { b.disabled = false; });
    }
}

/* ════════════════════════════════
   DELETE ORDER
   ════════════════════════════════ */
window.deleteOrder = async function() {
    if (!currentOrder) return;
    if (!confirm('Delete this order permanently? This cannot be undone.')) return;

    const btn  = document.getElementById('aodDeleteBtn');
    btn.disabled = true;

    try {
        await deleteDoc(doc(db, 'orders', currentOrder.id));
        await deleteDoc(doc(db, 'order_status', currentOrder.id)).catch(() => {});
        toast('Order deleted', 'success');
        setTimeout(() => window.location.replace('admin-orders.html'), 900);
    } catch (err) {
        toast('Delete failed: ' + err.message, 'error');
        btn.disabled = false;
    }
};

/* ════════════════════════════════
   SKELETON / ERROR
   ════════════════════════════════ */
function hideSkeleton() {
    document.getElementById('aodSkeleton').style.display = 'none';
    document.getElementById('aodContent').style.display  = 'block';
}
function showError() {
    document.getElementById('aodSkeleton').style.display = 'none';
    document.getElementById('aodError').style.display    = 'block';
}
