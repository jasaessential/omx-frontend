/* ═══════════════════════════════════════════════
   JASA V2 — order-details.js
   Reads orders/{id} + order_status/{id} with
   real-time onSnapshot listeners.
   Supports xerox orders (documents[]) and
   product orders (items[]).
   Late upload of xerox files via signed-URL XHR (R2).
   ═══════════════════════════════════════════════ */
import './omx-push.js';   // order notifications
import { auth, db } from './firebase-init.js';
import { WORKER_URL, PAYMENT_SERVER_URL } from './env-config.js';
import { getUploadTarget } from './secure-files.js';   // signed upload / view links
import { wallSlotsHtml, secureImgHtml } from './wall-order-view.js';

/* Customer changes to a placed order go through the server, which recomputes
   the totals (POST /api/orders/cancel-item and /attach-file). */
async function ordersApi(path, body) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error('Please sign in again.');
    let res;
    try {
        res = await fetch(`${(window.__JASA_SERVER || PAYMENT_SERVER_URL).replace(/\/$/, '')}/api/orders/${path}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body:    JSON.stringify(body),
            signal:  AbortSignal.timeout(60000),
        });
    } catch (_) { throw new Error('Could not reach the server. Please try again.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.userFacing = !!data.error; throw e; }
    return data;
}
import {
    doc, getDoc, onSnapshot, collection, getDocs
} from "./cf-firestore.js";
import { onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const orderId = new URLSearchParams(window.location.search).get('id');
let currentOrder = null;
let currentUser  = null;
let xeroxMeta    = { paper: [], binding: [], lamination: [] };
const lateUploads = {}; // trackingKey → { file, xhr, status, progress, speed, eta, intent }

/* ════ STATUS MAP ════ */
const STATUS_MAP = {
    pending:           { label:'Pending',          color:'#f59e0b', bg:'#fef3c7', icon:'fa-solid fa-hourglass-half', step:1 },
    confirmed:         { label:'Confirmed',         color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check',   step:2 },
    accepted:          { label:'Confirmed',         color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check',   step:2 },
    processing:        { label:'Processing',        color:'#06b6d4', bg:'#cffafe', icon:'fa-solid fa-gears',           step:2 },
    'out for delivery':{ label:'Out for Delivery',  color:'#10b981', bg:'#d1fae5', icon:'fa-solid fa-truck-fast',      step:3 },
    delivered:         { label:'Delivered',         color:'#16a34a', bg:'#dcfce7', icon:'fa-solid fa-circle-check',   step:4 },
    cancelled:         { label:'Cancelled',         color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-circle-xmark',   step:0 },
    rejected:          { label:'Rejected',          color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-triangle-exclamation', step:0 },
};
function getStatus(raw) {
    return STATUS_MAP[(raw||'pending').toLowerCase().trim()]
        || { label:raw||'Pending', color:'#6b7280', bg:'#f3f4f6', icon:'fa-solid fa-circle-dot', step:1 };
}

/* ── Derive true overall status from item-level statuses ──
   Priority: pending > confirmed > out for delivery > delivered > cancelled
   Falls back to order.status for cases like 'processing' set by admin.
   ─────────────────────────────────────────────────────── */
function deriveOrderStatus(order) {
    const isXerox = order.type === 'xerox';
    const items   = isXerox ? (order.documents || []) : (order.items || []);
    if (!items.length) return (order.status || 'pending').toLowerCase();

    const statuses = items.map(i => (i.status || 'pending').toLowerCase());

    if (statuses.every(s => s === 'cancelled' || s === 'rejected')) return 'cancelled';

    const active = statuses.filter(s => s !== 'cancelled' && s !== 'rejected');
    if (!active.length) return 'cancelled';

    if (active.some(s => s === 'pending'))           return 'pending';
    if (active.some(s => s === 'confirmed'))          return 'confirmed';
    if (active.some(s => s === 'out for delivery'))   return 'out for delivery';
    if (active.every(s => s === 'delivered'))         return 'delivered';

    return (order.status || 'pending').toLowerCase();
}

/* ── Item status badge ── */
function itemStatusBadge(raw) {
    const s = (raw || 'pending').toLowerCase().trim();
    const map = {
        pending:            { cls: 'od-status--pending',   icon: 'fa-solid fa-hourglass-half',       label: 'Pending'          },
        confirmed:          { cls: 'od-status--confirmed',  icon: 'fa-solid fa-circle-check',         label: 'Confirmed'        },
        accepted:           { cls: 'od-status--confirmed',  icon: 'fa-solid fa-circle-check',         label: 'Confirmed'        },
        processing:         { cls: 'od-status--processing', icon: 'fa-solid fa-gears',                label: 'Processing'       },
        'out for delivery': { cls: 'od-status--delivery',   icon: 'fa-solid fa-truck-fast',           label: 'Out for Delivery' },
        delivered:          { cls: 'od-status--delivered',  icon: 'fa-solid fa-circle-check',         label: 'Delivered'        },
        cancelled:          { cls: 'od-status--cancelled',  icon: 'fa-solid fa-circle-xmark',         label: 'Cancelled'        },
        rejected:           { cls: 'od-status--rejected',   icon: 'fa-solid fa-triangle-exclamation', label: 'Rejected'         },
    };
    const m = map[s] || { cls: 'od-status--pending', icon: 'fa-solid fa-circle-dot', label: raw || 'Pending' };
    return `<span class="od-item-status-badge ${m.cls}"><i class="${m.icon}"></i>${m.label}</span>`;
}

/* ── 3-step item progress tracker (user side) ── */
function buildOdItemTracker(rawStatus, rejectionMessage) {
    const s = (rawStatus || 'pending').toLowerCase().trim();

    if (s === 'rejected' || s === 'cancelled') {
        const title  = s === 'rejected' ? 'Item Rejected by Seller' : 'Item Cancelled';
        const detail = rejectionMessage
            ? rejectionMessage
            : s === 'rejected'
                ? 'This item cannot be fulfilled. Contact the shop for details.'
                : 'You have cancelled this item.';
        return `
<div class="od-item-rejected-banner">
    <div class="od-rej-title">
        <i class="fa-solid fa-triangle-exclamation"></i>${title}
    </div>
    <div class="od-rej-reason">${detail}</div>
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
        const cls   = done ? 'od-tracker-step--done' : active ? `od-tracker-step--${sd.key}` : '';
        return `
<div class="od-tracker-step ${cls}">
    <div class="od-tracker-dot"><i class="${sd.icon}"></i></div>
    <span class="od-tracker-label">${sd.label}</span>
</div>`;
    }).join('');

    return `
<div class="od-item-tracker">
    <div class="od-tracker-progress" style="width:${progressW};background:${progressBg};"></div>
    ${stepsHtml}
</div>`;
}

/* ════ AUTH + LOAD ════ */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html'); return; }
    currentUser = user;
    if (!orderId) { showError(); return; }
    await loadXeroxMeta();
    await loadOrder();
});

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
            getDocs(collection(db, 'xerox_config_lamination'))
        ]);
        xeroxMeta.paper      = p.docs.map(d => ({ id: d.id, ...d.data() }));
        xeroxMeta.binding    = b.docs.map(d => ({ id: d.id, ...d.data() }));
        xeroxMeta.lamination = l.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch(e) { console.warn('xerox meta load failed:', e); }
}

let shopDataMap = {};

/* Catalog docs of ordered products: picture fallback for lines saved without
   one (older carts stored `imageUrl`, some lines none at all). items/ is public. */
const CUSTOM_BASE_IDS = new Set(['custom-poster', 'wall-poster', 'poster-pack']);
const productDocs = new Map();   // baseId → item data | null
const baseIdOf = item => item.baseId || String(item.id || '').split('__')[0];
async function loadProductDocs() {
    if (!currentOrder || currentOrder.type === 'xerox') return;
    const ids = [...new Set((currentOrder.items || []).filter(i => !lineImg(i)).map(baseIdOf))]
        .filter(id => id && !CUSTOM_BASE_IDS.has(id) && !productDocs.has(id));
    if (!ids.length) return;
    await Promise.all(ids.map(async id => {
        try {
            const snap = await getDoc(doc(db, 'items', id));
            productDocs.set(id, snap.exists() ? snap.data() : null);
        } catch (_) { productDocs.set(id, null); }
    }));
    render();
}

async function loadOrder() {
    try {
        const snap = await getDoc(doc(db,'orders', orderId));
        if (!snap.exists() || snap.data().userId !== currentUser.uid) { showError(); return; }
        currentOrder = { id: snap.id, ...snap.data() };
        if (currentOrder.shopId) {
            try {
                const sSnap = await getDoc(doc(db, 'shops', currentOrder.shopId));
                if (sSnap.exists()) { shopDataMap[currentOrder.shopId] = sSnap.data(); }
            } catch (_) {}
        }
        render();
        loadProductDocs();
    } catch(e) { console.error('Order load error:',e); showError(); return; }

    // Real-time: order data changes
    onSnapshot(doc(db,'orders', orderId), snap => {
        if (snap.exists() && currentOrder) {
            currentOrder = { ...currentOrder, ...snap.data(), id: snap.id };
            render();
        }
    }, err => console.warn('order snap:',err));

    // Real-time: status changes
    onSnapshot(doc(db,'order_status', orderId), snap => {
        if (snap.exists() && currentOrder) {
            const { status, updatedAt } = snap.data();
            if (updatedAt) currentOrder._statusUpdatedAt = updatedAt;
            if (currentOrder.status !== status) {
                const prev = currentOrder.status;
                currentOrder.status = status;
                render();
                notifyStatusChange(prev, status);
            }
        }
    }, err => console.warn('status snap:',err));
}

function esc(s) { return String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

window.confirmOpenMap = function(shopName, mapUrl) {
    odConfirm({
        title: 'Open Google Maps?',
        msg: `Are you sure you want to open Google Maps to navigate to ${shopName}?`,
        icon: 'fa-solid fa-map-location-dot',
        iconColor: '#2563eb',
        okText: 'Open Google Maps',
        cancelText: 'Cancel',
        okColor: '#2563eb'
    }).then(confirmed => {
        if (confirmed && mapUrl) {
            window.open(mapUrl, '_blank');
        }
    });
};

/* ════ RENDER HELPERS ════ */
/* HTML-escape (esc() above is for strings inside onclick='…' handlers) */
function h(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
const num    = v => Number(v) || 0;
const rupees = n => `₹${num(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const safeOrderId = () => String(orderId || '').replace(/[^A-Za-z0-9_-]/g, '');

function fmtDate(raw, withTime = true) {
    if (!raw) return '';
    try {
        const d = raw.toDate ? raw.toDate() : raw.seconds != null ? new Date(raw.seconds * 1000) : new Date(raw);
        if (isNaN(d)) return '';
        return d.toLocaleString('en-IN', withTime
            ? { weekday:'short', day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true }
            : { day:'2-digit', month:'short', year:'numeric' });
    } catch (_) { return ''; }
}

/** Primary picture of a catalog item / order line (all the field names in use). */
function primaryOf(obj) {
    if (!obj) return '';
    const imgs = Array.isArray(obj.images) ? obj.images : [];
    const fromList = (imgs.find(i => i && i.isPrimary) || imgs[0] || {});
    return obj.img || obj.imageUrl || obj.image || obj.thumbnail
        || (typeof fromList === 'string' ? fromList : fromList.url) || '';
}
/** Picture saved on the order line itself (public catalog / design image). */
function lineImg(item) {
    return primaryOf(item)
        || (Array.isArray(item.wallSlots) ? (item.wallSlots.find(s => s && s.img) || {}).img : '')
        || '';
}

const CAT_LABELS  = { stationary: 'Stationery', stationery: 'Stationery', books: 'Books', electronic: 'Kits & Electronics', posters: 'Wall Posters' };
const SIZE_LABELS = { A5: 'A5', A4: 'A4', A3: 'A3', P13: '13×19"' };
const ARRANGEMENTS = { grid: 'Grid', zigzag: 'Zigzag', cascade: 'Cascade', gallery: 'Gallery' };
const sizeText = k => SIZE_LABELS[k] || String(k || '');

/* Payment: method + state as the customer should read them */
function paymentInfo(o, isPickup = false) {
    const onDelivery = isPickup ? 'Pay at Pickup' : 'Pay on Delivery';
    const m = String(o.paymentMethod || '').toLowerCase();
    const s = String(o.paymentStatus || '').toLowerCase();
    const paid = num(o.amountPaid), bal = num(o.balanceDue), total = num(o.totalAmount);
    const pill = (bg, color, icon, text) => `<span class="od-status-pill" style="background:${bg};color:${color};"><i class="${icon}"></i> ${text}</span>`;
    if (m === 'cod' || s === 'cod') {
        return { mode: 'Cash on Delivery', pill: pill('#fef3c7', '#d97706', 'fa-solid fa-money-bill-wave',
            String(o.status || '').toLowerCase() === 'delivered' ? 'Cash on Delivery' : onDelivery) };
    }
    if (m === 'partial' || s === 'partial_paid') {
        if (s === 'partial_paid' || paid > 0) {
            return { mode: 'Part payment (deposit online, rest on delivery)', partial: true,
                pill: pill('#e0f2fe', '#0284c7', 'fa-solid fa-percent', `Deposit Paid · ${rupees(paid)} paid, ${rupees(bal || Math.max(0, total - paid))} due`) };
        }
    }
    const online = m === 'partial' ? 'Part payment (deposit online)' : 'Online (Razorpay)';
    if (s === 'paid')      return { mode: online, pill: pill('#dcfce7', '#16a34a', 'fa-solid fa-circle-check', 'Paid Online') };
    if (s === 'failed')    return { mode: online, pill: pill('#fee2e2', '#dc2626', 'fa-solid fa-circle-xmark', 'Payment Failed') };
    if (s === 'abandoned') return { mode: online, pill: pill('#f3f4f6', '#6b7280', 'fa-solid fa-ban', 'Payment Not Completed') };
    if (s === 'refunded')  return { mode: online, pill: pill('#ede9fe', '#7c3aed', 'fa-solid fa-rotate-left', 'Refunded') };
    if (m === 'razorpay' || m === 'partial') return { mode: online, pill: pill('#fef3c7', '#d97706', 'fa-solid fa-hourglass-half', 'Payment Pending') };
    if (m === 'paid') return { mode: 'Online', pill: pill('#dcfce7', '#16a34a', 'fa-solid fa-circle-check', 'Paid') };
    return { mode: o.paymentMethod ? String(o.paymentMethod) : 'Cash on Delivery',
             pill: pill('#fef3c7', '#d97706', 'fa-solid fa-money-bill-wave', onDelivery) };
}

/* Order-level status timeline: Placed → Confirmed → Out for delivery → Delivered */
function buildOrderTimeline(o, statusKey) {
    const placed = fmtDate(o.createdAt);
    const updated = fmtDate(o._statusUpdatedAt);
    if (statusKey === 'cancelled' || statusKey === 'rejected') {
        const when = fmtDate(o.cancelledAt) || updated;
        const abandoned = String(o.paymentStatus || '').toLowerCase() === 'abandoned';
        return `
        <div class="od-timeline-cancel">
            <i class="fa-solid fa-circle-xmark"></i>
            <div>
                <div class="od-tl-cancel-title">Order ${statusKey === 'rejected' ? 'rejected' : 'cancelled'}</div>
                <div class="od-tl-cancel-sub">${abandoned ? 'Payment was not completed, so the order was cancelled. ' : ''}${placed ? `Placed ${h(placed)}` : ''}${when ? ` · Cancelled ${h(when)}` : ''}</div>
            </div>
        </div>`;
    }
    const step = { pending: 1, confirmed: 2, accepted: 2, processing: 2, 'out for delivery': 3, delivered: 4 }[statusKey] || 1;
    const isPickup = o._isPickup;
    const steps = [
        { icon: 'fa-solid fa-receipt',      label: 'Placed',    sub: placed },
        { icon: 'fa-solid fa-circle-check', label: 'Confirmed', sub: '' },
        { icon: isPickup ? 'fa-solid fa-store' : 'fa-solid fa-truck-fast', label: isPickup ? 'Ready' : 'On the way', sub: '' },
        { icon: 'fa-solid fa-house-circle-check', label: isPickup ? 'Picked up' : 'Delivered', sub: '' },
    ];
    if (updated && step > 1) steps[step - 1].sub = updated;
    return `
    <ol class="od-timeline">
        ${steps.map((s, i) => {
            const n = i + 1;
            const cls = n < step ? 'is-done' : n === step ? 'is-current' : '';
            return `<li class="od-tl-step ${cls}">
                <span class="od-tl-dot"><i class="${s.icon}"></i></span>
                <span class="od-tl-label">${s.label}</span>
                ${s.sub ? `<span class="od-tl-sub">${h(s.sub)}</span>` : ''}
            </li>`;
        }).join('')}
    </ol>`;
}

/* ════ RENDER ════ */
function render() {
    document.getElementById('odSkeleton').style.display = 'none';
    document.getElementById('odContent').style.display  = 'block';

    const o        = currentOrder;
    const statusKey = deriveOrderStatus(o);
    const st       = getStatus(statusKey);
    const ordRef   = o.groupOrderId || o.id.slice(0,8).toUpperCase();
    const isXerox  = o.type === 'xerox';
    const items    = isXerox ? (o.documents||[]) : (o.items||[]);
    const active   = items.filter(i => !['cancelled','rejected'].includes(String(i.status||'').toLowerCase()));

    document.getElementById('odHeaderSub').textContent = `Order #${ordRef}`;

    const dateStr = fmtDate(o.createdAt) || '—';

    const shopObj   = shopDataMap[o.shopId] || {};
    const shopName  = shopObj.name || o.shopName || 'Shop';
    const shopAddr  = shopObj.address || o.shopAddress || 'Local Center';
    const rawLink   = shopObj.locationLink || o.shopLocationLink || '';
    const mapUrl    = rawLink || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shopName + ' ' + shopAddr)}`;
    const toList    = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim()).filter(Boolean);
    const shopPhone = toList(o.shopContacts?.mobile)[0] || toList(shopObj.mobileNumbers)[0] || toList(shopObj.phone)[0] || '';

    const isPickup  = o.fulfillmentType === 'pickup' || o.deliveryMode === 'pickup' || o.isPickup === true || o.orderType === 'pickup' || (o.deliveryFee === 0 && !o.deliveryAddress);
    o._isPickup = isPickup;

    const addr      = o.deliveryAddress || null;
    const addrText  = addr
        ? [addr.label ? `<strong>${h(addr.label)}</strong>` : '', h(addr.street || ''),
           h([addr.city, addr.state].filter(Boolean).join(', ') + (addr.pincode ? ` — ${addr.pincode}` : ''))]
            .filter(Boolean).join('<br>')
        : (isPickup ? 'Self Pickup at Shop' : '—');

    const pay = paymentInfo(o, isPickup);

    const fulPillHtml = isPickup
        ? `<span class="od-status-pill" style="background:#dcfce7;color:#15803d;"><i class="fa-solid fa-store"></i> Pick Myself (Self Pickup)</span>`
        : `<span class="od-status-pill" style="background:#deeeff;color:#2D8CF0;"><i class="fa-solid fa-truck-fast"></i> Home Delivery</span>`;

    // KV summary
    const kv  = (key, val, icon='') => `<tr class="od-kv-row"><td class="od-kv-key">${icon?`<i class="${icon}" style="margin-right:5px;opacity:.5;"></i>`:''}${key}</td><td class="od-kv-val">${val}</td></tr>`;
    const kvS = label => `<tr class="od-kv-row od-kv-section"><td colspan="2">${label}</td></tr>`;

    const statusPill = `<span class="od-status-pill" style="background:${st.bg};color:${st.color};">
        <i class="${st.icon}"></i> ${st.label}</span>`;

    const shopLinkBtn = `
    <button onclick="confirmOpenMap('${esc(shopName)}', '${esc(mapUrl)}')" class="od-map-link-btn">
        <i class="fa-solid fa-map-location-dot"></i> View Shop Location &amp; Directions
    </button>`;

    const pickupShopBlock = isPickup ? `
    <div class="od-pickup-shop-card">
        <div class="od-psc-head">
            <span class="od-psc-title"><i class="fa-solid fa-store"></i> Self Pickup Center</span>
            <span class="od-psc-badge">Pick Myself</span>
        </div>
        <div class="od-psc-name">${h(shopName)}</div>
        <div class="od-psc-addr"><i class="fa-solid fa-location-dot" style="color:var(--primary);margin-right:4px;"></i> ${h(shopAddr)}</div>
        ${shopLinkBtn}
    </div>` : '';

    /* Pricing */
    const subtotal  = o.subtotal != null ? num(o.subtotal)
        : active.reduce((s, it) => s + (isXerox ? num(it.price) : num(it.price) * (num(it.qty) || 1)), 0);
    const mrpSaving = isXerox ? 0 : active.reduce((s, it) => {
        const p = num(it.price), m = num(it.originalPrice);
        return s + (m > p ? (m - p) * (num(it.qty) || 1) : 0);
    }, 0);
    const discount  = num(o.discountAmount);
    const wallet    = num(o.walletAmount);
    const fee       = o.deliveryFee != null ? num(o.deliveryFee) : null;
    const total     = o.totalAmount != null ? num(o.totalAmount) : Math.max(0, subtotal - discount - wallet + (fee || 0));
    const unitCount = isXerox
        ? active.reduce((s, d) => s + (num(d.config?.quantity) || 1), 0)
        : active.reduce((s, it) => s + (num(it.qty) || 1), 0);
    const lineCount = `${active.length} ${isXerox ? 'document' : 'item'}${active.length === 1 ? '' : 's'}`
        + (unitCount > active.length ? ` · ${unitCount} ${isXerox ? 'sets' : 'pcs'}` : '');
    const cancelledCount = items.length - active.length;

    const orderNote = o.notes || o.orderNote || o.note || o.instructions || o.deliveryInstructions || '';

    document.getElementById('odSummaryCard').innerHTML = `
    <div class="od-section-title"><i class="fa-solid fa-receipt"></i> Order Summary</div>
    ${buildOrderTimeline(o, statusKey)}
    <table class="od-kv-table">
        ${kvS('Order Info')}
        ${kv('Order ID',     `<strong>#${h(ordRef)}</strong>`, 'fa-solid fa-receipt')}
        ${kv('Order Type',   isXerox ? '<span style="font-weight:700;"><i class="fa-solid fa-print" style="color:var(--primary);"></i> Xerox / Print</span>' : '<span style="font-weight:700;"><i class="fa-solid fa-bag-shopping" style="color:#16a34a;"></i> Products</span>', 'fa-solid fa-tag')}
        ${kv('Placed On',    h(dateStr),                     'fa-regular fa-calendar')}
        ${kv('Status',       statusPill,                     'fa-solid fa-circle-dot')}
        ${o._statusUpdatedAt ? kv('Last Update', h(fmtDate(o._statusUpdatedAt)), 'fa-regular fa-clock') : ''}
        ${kv('Fulfillment',  fulPillHtml,                   'fa-solid fa-truck-ramp-box')}
        ${kv('Shop',         isPickup
            ? `<a href="javascript:void(0)" onclick="confirmOpenMap('${esc(shopName)}', '${esc(mapUrl)}')" style="color:var(--primary);font-weight:700;text-decoration:none;"><i class="fa-solid fa-map-location-dot"></i> ${h(shopName)} (View Map)</a>`
            : `<span style="font-weight:700;">${h(shopName)}</span>`, 'fa-solid fa-store')}
        ${shopPhone ? kv('Shop Phone', `<a href="tel:${h(shopPhone.replace(/[^\d+]/g, ''))}" style="color:var(--primary);font-weight:700;text-decoration:none;">${h(shopPhone)}</a>`, 'fa-solid fa-phone') : ''}
        ${kv('Items',        h(lineCount) + (cancelledCount ? ` <span style="color:#ef4444;font-size:.72rem;">(${cancelledCount} cancelled)</span>` : ''), 'fa-solid fa-boxes-stacked')}
        ${orderNote ? kv('Note', h(orderNote), 'fa-regular fa-note-sticky') : ''}

        ${kvS('Payment')}
        ${kv('Mode',         h(pay.mode),                   'fa-solid fa-wallet')}
        ${kv('Status',       pay.pill,                      'fa-solid fa-circle-info')}
        ${o.paidAt ? kv('Paid On', h(fmtDate(o.paidAt)), 'fa-regular fa-calendar-check') : ''}
        ${o.razorpayPaymentId ? kv('Payment Ref', `<span style="font-family:monospace;font-size:.72rem;">${h(o.razorpayPaymentId)}</span>`, 'fa-solid fa-hashtag') : ''}

        ${kvS('Price Details')}
        ${kv(`Items Total (${active.length})`, rupees(subtotal), 'fa-solid fa-file-invoice')}
        ${mrpSaving > 0 ? kv('Product Discount', `<span style="color:#16a34a;font-weight:700;">You saved ${rupees(mrpSaving)} on MRP</span>`, 'fa-solid fa-tags') : ''}
        ${discount > 0 ? kv(`Coupon${o.couponCode ? ` (${h(o.couponCode)})` : ''}`, `<span style="color:#16a34a;font-weight:800;">-${rupees(discount)}</span>`, 'fa-solid fa-ticket') : (o.couponCode ? kv('Coupon', h(o.couponCode), 'fa-solid fa-ticket') : '')}
        ${wallet > 0 ? kv('Wallet Used', `<span style="color:#16a34a;font-weight:800;">-${rupees(wallet)}</span>`, 'fa-solid fa-wallet') : ''}
        ${kv(isPickup ? 'Delivery' : 'Delivery Charges', fee == null ? '—' : fee === 0 ? `<span style="color:#16a34a;font-weight:800;">FREE${isPickup ? ' (Pickup)' : ''}</span>` : rupees(fee), 'fa-solid fa-truck-fast')}
        ${kv('Order Total',  `<strong style="color:var(--primary);font-size:1.05rem;">${rupees(total)}</strong>`, 'fa-solid fa-receipt')}
        ${num(o.amountPaid) > 0 ? kv('Amount Paid', `<strong style="color:#16a34a;">${rupees(o.amountPaid)}</strong>`, 'fa-solid fa-circle-check') : ''}
        ${!['cancelled','rejected'].includes(statusKey) && num(o.balanceDue) > 0 && (pay.partial || num(o.amountPaid) > 0) ? kv('Balance Due', `<strong style="color:#e11d48;">${rupees(o.balanceDue)}</strong> <span style="font-size:.7rem;color:var(--txt3);">${isPickup ? 'at pickup' : 'on delivery'}</span>`, 'fa-solid fa-triangle-exclamation') : ''}

        ${kvS(isPickup ? 'Pickup Details' : 'Delivery Address')}
        ${isPickup ? kv('Pickup Spot', `<span style="font-weight:700;">${h(shopName)}</span> — <span style="font-size:.78rem;color:var(--txt2);">${h(shopAddr)}</span>`, 'fa-solid fa-location-dot') : kv('Address', addrText, 'fa-solid fa-location-dot')}
        ${o.userName ? kv('Name', h(o.userName), 'fa-regular fa-user') : ''}
        ${o.contacts?.mobile    ? kv('Primary Phone', h(o.contacts.mobile),    'fa-solid fa-phone')        : ''}
        ${o.contacts?.altMobile ? kv('Alternate Phone', h(o.contacts.altMobile), 'fa-solid fa-phone-volume') : ''}
    </table>
    ${pickupShopBlock}`;

    // Items
    const list = document.getElementById('odItemsList');
    list.innerHTML = `
        <div class="od-items-heading"><i class="fa-solid ${isXerox ? 'fa-file-lines' : 'fa-box-open'}"></i> ${isXerox ? 'Documents' : 'Items'} in this order <span>${items.length}</span></div>
        ${items.length
            ? items.map((item,i) => buildItemCard(item, i, o)).join('')
            : '<div class="od-item-card" style="padding:18px;text-align:center;font-size:.8rem;color:var(--txt3);">No items found in this order.</div>'}`;
}

/* ── Picture for an order line ── */
function itemPictureHtml(item, order) {
    const oid = order.id;
    const icon = item.wallPoster ? 'fa-solid fa-table-cells-large'
        : (item.customPoster || item.category === 'posters') ? 'fa-regular fa-image' : 'fa-solid fa-box';
    const placeholder = `<i class="${icon} od-no-img"></i>`;
    // Custom poster: the customer's own picture (private, signed on screen)
    if (item.customPoster && (item.customPreview || item.customPhoto)) {
        return placeholder + secureImgHtml(item.customPreview || item.customPhoto, oid, { alt: item.name || 'Your poster', cls: 'od-sec-img' });
    }
    const img = lineImg(item) || primaryOf(productDocs.get(baseIdOf(item)));
    if (img) {
        return `<img src="${h(img)}" alt="${h(item.name || 'Item')}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'${icon} od-no-img'}))">`;
    }
    const firstPhoto = Array.isArray(item.wallSlots) ? (item.wallSlots.find(s => s && s.photo) || {}).photo : '';
    if (firstPhoto || item.customPhoto) {
        return placeholder + secureImgHtml(firstPhoto || item.customPhoto, oid, { alt: item.name || '', cls: 'od-sec-img' });
    }
    return placeholder;
}

/* ── Details of a product line, as the customer chose it ── */
function productDetailsHtml(item) {
    const baseId = baseIdOf(item);
    const custom = CUSTOM_BASE_IDS.has(baseId);
    const d      = productDocs.get(baseId) || {};
    const cat    = item.category || d.category || '';
    const qty    = num(item.qty) || 1;
    const price  = num(item.price);
    const mrp    = num(item.originalPrice) || price;
    const size   = item.size || (!item.wallPoster && !item.customPoster ? String(item.id || '').split('__')[1] : '') || '';
    const color  = item.color || item.selectedColor || item.variant || '';
    const fit    = item.customLayout;
    const rows = [
        cat ? ['Category', h(CAT_LABELS[cat] || cat)] : null,
        item.wallPoster === 'wall' ? ['Product', 'Build Your Wall'] : null,
        item.wallPoster === 'pack' ? ['Product', 'Mix &amp; Match Poster Pack'] : null,
        item.customPoster ? ['Product', 'Custom poster (your picture)'] : null,
        size ? ['Size', `<b>${h(sizeText(size))}</b>`] : null,
        color ? ['Colour / Variant', h(color)] : null,
        item.gsm ? ['Paper', `${h(item.gsm)} GSM`] : null,
        item.wallPoster === 'pack' ? ['Pack', `${h(item.packCount || item.wallSlots?.length || '')} posters · ${h(sizeText(item.packSize))}`] : null,
        item.arrangement ? ['Arrangement', h(ARRANGEMENTS[item.arrangement] || item.arrangement)] : null,
        fit && (fit.landscape || num(fit.rotate)) ? ['Orientation', `${fit.landscape ? 'Landscape' : 'Portrait'}${num(fit.rotate) ? `, rotated ${num(fit.rotate)}°` : ''}`] : null,
        mrp > price ? ['MRP', `<s style="color:var(--txt3);">${rupees(mrp)}</s>`] : null,
        ['Price', `${rupees(price)}${num(item.discountPercent) ? ` <span style="color:#16a34a;font-weight:700;">(${num(item.discountPercent)}% off)</span>` : ''}`],
        ['Quantity', `×${qty}`],
        ['Line Total', `<b>${rupees(price * qty)}</b>`],
        mrp > price ? ['You Save', `<span style="color:#16a34a;font-weight:700;">${rupees((mrp - price) * qty)}</span>`] : null,
    ].filter(Boolean).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    const link = !custom && baseId
        ? `<a href="item-details.html?id=${encodeURIComponent(baseId)}" class="od-product-link"><i class="fa-solid fa-arrow-up-right-from-square"></i> View product</a>` : '';
    return `
    <div class="od-paper-config-block">
        <div class="od-paper-config-title"><i class="fa-solid fa-circle-info"></i> Item Details</div>
        <table class="od-paper-config-table">${rows}</table>
        ${link}
    </div>`;
}

/* ── The customer's own pictures on a poster line (private, signed) ── */
function customPhotosHtml(item, order) {
    if (!item.customPhoto && !item.customPreview) return '';
    const oid = safeOrderId();
    const tile = (url, label) => `
        <a href="${h(url)}" data-secure-file data-order-id="${oid}" target="_blank" rel="noopener" class="od-photo-tile">
            <span class="od-photo-thumb"><i class="fa-regular fa-image"></i>${secureImgHtml(url, order.id, { alt: label, cls: 'od-sec-img' })}</span>
            <span class="od-photo-label"><i class="fa-solid fa-eye"></i> ${label}</span>
        </a>`;
    return `
    <div class="od-photo-block">
        <div class="od-photo-title"><i class="fa-solid fa-image"></i> Your picture</div>
        <div class="od-photo-row">
            ${item.customPreview ? tile(item.customPreview, 'As printed') : ''}
            ${item.customPhoto ? tile(item.customPhoto, item.customPreview ? 'Original' : 'Your photo') : ''}
        </div>
        ${item.customNote ? `<div class="od-photo-note"><i class="fa-regular fa-note-sticky"></i> ${h(item.customNote)}</div>` : ''}
    </div>`;
}

function buildItemCard(item, idx, order) {
    const isCancelled = ['cancelled','rejected'].includes((item.status||'').toLowerCase());
    const isXerox = order.type === 'xerox';

    const orderPending = deriveOrderStatus(order) === 'pending';
    const itemPending  = !item.status || item.status.toLowerCase() === 'pending';
    const itemType     = isXerox ? 'doc' : 'item';
    const cancelBtn    = (!isCancelled && orderPending && itemPending) ? `
        <div style="margin-top:12px;padding:12px 0;border-top:1px solid var(--border, #eee);text-align:center;">
            <button onclick="cancelOrderItem('${order.id}', ${idx}, '${itemType}')"
                style="background:none;border:1.5px solid #ef4444;color:#ef4444;border-radius:50px;padding:7px 22px;font-size:0.78rem;font-weight:700;cursor:pointer;letter-spacing:0.3px;">
                <i class="fa-solid fa-trash-can" style="margin-right:5px;"></i>Cancel Item
            </button>
        </div>` : '';

    if (isXerox) {
        return buildXeroxDocCard(item, idx, order, cancelBtn);
    }

    const qty   = num(item.qty) || 1;
    const price = num(item.price);
    const mrp   = num(item.originalPrice);

    return `
    <div class="od-item-card${isCancelled ? ' od-item-card--off' : ''}" id="od-item-${order.id}-${idx}" style="margin-top:10px;">
        <div class="od-item-head">
            <div class="od-item-img od-item-img--lg">
                ${itemPictureHtml(item, order)}
            </div>
            <div class="od-item-meta-wrap">
                <div class="od-item-name">${h(item.name||'Item')}</div>
                <div class="od-item-price">
                    ${mrp > price ? `<s style="opacity:.7;margin-right:4px;">${rupees(mrp)}</s>` : ''}${rupees(price)} × ${qty} = <strong style="color:var(--txt1);">${rupees(price * qty)}</strong>
                </div>
                ${itemStatusBadge(item.status || 'pending')}
            </div>
        </div>
        ${customPhotosHtml(item, order)}
        ${wallSlotsHtml(item, order.id)}
        ${productDetailsHtml(item)}
        ${buildOdItemTracker(item.status, item.rejectionMessage)}
        ${cancelBtn}
    </div>`;
}

/* ── Resolve xerox meta IDs to names ── */
function resolveXeroxId(list, id, fallback) {
    if (!id || id === 'none') return null;
    return list.find(x => x.id === id)?.name || fallback || id;
}

const IMAGE_FILE = /\.(jpe?g|png|webp|gif|heic|heif|bmp)(?:$|[?#])/i;

/* ── Full xerox document detail card ── */
function buildXeroxDocCard(d, idx, order, cancelBtn) {
    const cfg         = d.config || {};
    const uploadSt    = d.uploadStatus || 'pending';
    const isCancelled = ['cancelled','rejected'].includes((d.status||'').toLowerCase());

    const isUploaded = uploadSt === 'uploaded';
    const isWA       = uploadSt === 'whatsapp';
    const isPending  = !isUploaded && (uploadSt === 'pending' || uploadSt === 'later' || uploadSt === 'pending_later' || uploadSt === 'whatsapp');

    const COLOR_LABELS  = { bw: 'Black & White', color: 'Colour', mixed: 'Mixed (B&W + Colour)' };
    const book = cfg.bindingSet;
    const FORMAT_LABELS = { frontOnly: 'Single-sided (front only)', both: 'Double-sided (front & back)' };

    const paperName = resolveXeroxId(xeroxMeta.paper, cfg.paperId, 'Standard Paper');
    const bindName  = resolveXeroxId(xeroxMeta.binding, cfg.bindingId);
    const lamName   = resolveXeroxId(xeroxMeta.lamination, cfg.laminationId);
    const copies    = num(cfg.quantity) || 1;
    const pages     = num(d.pages);
    const perSide   = cfg.ratio === '1:2' ? 2 : 1;
    const sides     = Math.ceil(pages / perSide);
    const sheets    = cfg.format === 'both' ? Math.ceil(sides / 2) : sides;

    const hasFile = isUploaded && d.uploadedUrl && /^https?:/i.test(String(d.uploadedUrl));
    const isImageFile = hasFile && (IMAGE_FILE.test(String(d.uploadedUrl)) || IMAGE_FILE.test(String(d.name || '')));

    let uploadBadge = '';
    if (isUploaded) uploadBadge = `<span class="od-upload-badge od-upload-badge--ok"><i class="fa-solid fa-check-circle"></i> Uploaded</span>`;
    else if (isWA)  uploadBadge = `<span class="od-upload-badge od-upload-badge--wa"><i class="fa-brands fa-whatsapp"></i> Via WhatsApp</span>`;
    else            uploadBadge = `<span class="od-upload-badge od-upload-badge--pending"><i class="fa-solid fa-triangle-exclamation"></i> Yet to Upload</span>`;

    const lateArea = `<div id="od-late-progress-${order.id}-${idx}"></div>`;
    const uploadBtn = (isPending && !isCancelled) ? `
    <div class="od-upload-prompt">
        <div class="od-upload-prompt-msg">
            <i class="fa-solid fa-circle-exclamation"></i>${isWA ? ' You can also upload directly' : ' Shop requires your file to print'}
        </div>
        <input type="file" id="od-late-input-${order.id}-${idx}" accept=".pdf,.jpg,.jpeg,.png,image/*" style="display:none;"
               onchange="handleLateUpload('${order.id}',${idx},this)">
        <button class="od-btn-upload" onclick="document.getElementById('od-late-input-${order.id}-${idx}').click()">
            <i class="fa-solid fa-cloud-arrow-up"></i> Upload Now
        </button>
        ${!isWA ? `<button class="od-btn-wa" onclick="markLateWA('${order.id}',${idx})">
            <i class="fa-brands fa-whatsapp"></i> Send via WhatsApp
        </button>` : ''}
    </div>` : '';

    const viewFileBtn = hasFile ? `
    <div style="margin-top:8px;">
        <a href="${h(d.uploadedUrl)}" data-secure-file data-order-id="${safeOrderId()}" target="_blank" class="od-view-file-btn">
            <i class="fa-solid fa-eye"></i> View Uploaded File
        </a>
    </div>` : '';

    const thumb = isImageFile
        ? `<i class="fa-regular fa-file-image od-no-img"></i>${secureImgHtml(d.uploadedUrl, order.id, { alt: d.name || 'Document', cls: 'od-sec-img' })}`
        : `<i class="fa-regular ${/\.pdf$/i.test(String(d.name || '')) || !d.name ? 'fa-file-pdf' : 'fa-file-lines'} od-no-img" style="color:#ef4444;opacity:.75;"></i>`;

    const colourRow = cfg.color === 'mixed'
        ? `<tr><td>Colour Pages</td><td>${h(cfg.colorPages || '—')}${cfg.colorPageCount ? ` (${num(cfg.colorPageCount)} pg)` : ''}, rest B&amp;W</td></tr>`
        : (cfg.colorMode === 'custom' && cfg.customColorPages ? `<tr><td>Colour Pages</td><td>${h(cfg.customColorPages)}</td></tr>` : '');

    return `
    <div class="od-item-card od-xerox-doc-card${isCancelled ? ' od-item-card--off' : ''}" id="od-item-${order.id}-${idx}">

        <div class="od-doc-head-row">
            <span class="od-doc-label">Document ${idx+1}</span>
            ${d.requiresManualEstimation ? `<span class="od-doc-est-badge">Manual Est.</span>` : ''}
        </div>

        <div class="od-doc-main">
            <div class="od-item-img">${thumb}</div>
            <div class="od-item-meta-wrap">
                <div class="od-doc-filename">${h(d.name || 'Document')}</div>
                <div class="od-doc-meta-row">
                    <span class="od-doc-meta-item"><i class="fa-regular fa-file-lines"></i>${pages} Page${pages === 1 ? '' : 's'} × ${copies}</span>
                    <span class="od-doc-price-chip">${rupees(d.price)}</span>
                    ${!isCancelled ? uploadBadge : ''}
                    ${itemStatusBadge(d.status || 'pending')}
                </div>
            </div>
        </div>

        ${uploadBtn}
        ${lateArea}
        ${viewFileBtn}
        ${buildOdItemTracker(d.status, d.rejectionMessage)}

        <div class="od-paper-config-block">
            <div class="od-paper-config-title">
                <i class="fa-solid fa-file-invoice"></i> Print Settings
            </div>
            <table class="od-paper-config-table">
                <tr><td>Paper</td><td>${h(paperName||'Standard')}</td></tr>
                <tr><td>Colour</td><td>${h(COLOR_LABELS[cfg.color]||cfg.color||'Black & White')}</td></tr>
                ${colourRow}
                <tr><td>Sides</td><td>${h(FORMAT_LABELS[cfg.format]||cfg.format||'Single-sided (front only)')}</td></tr>
                <tr><td>Pages per Side</td><td>${perSide === 2 ? '2 pages per side (1:2)' : '1 page per side'}</td></tr>
                <tr><td>Total Pages</td><td>${pages} page${pages === 1 ? '' : 's'}${pages ? ` · about ${sheets} sheet${sheets === 1 ? '' : 's'} per copy` : ''}</td></tr>
                <tr><td>Copies</td><td>×${copies} ${copies>1?'copies':'copy'}</td></tr>
                <tr><td>Binding</td><td>${bindName ? h(bindName) : 'None'}</td></tr>
                ${book ? `<tr><td>Bound Together</td><td>File ${num(book.position)} of ${num(book.size)} in one book${Array.isArray(book.files) && book.files.length ? ` (${h(book.files.join(' → '))})` : ''}${book.chargedHere ? ' · binding charged on this file' : ''}</td></tr>` : ''}
                <tr><td>Lamination</td><td>${lamName ? h(lamName) : 'None'}</td></tr>
                <tr><td>Price</td><td><b>${rupees(d.price)}</b>${copies > 1 ? ` <span style="color:var(--txt3);font-size:.72rem;">(${rupees(num(d.price) / copies)} per copy)</span>` : ''}</td></tr>
            </table>
        </div>

        ${cfg.instructions ? `
        <div class="od-instructions-block">
            <i class="fa-solid fa-note-sticky"></i>
            <span><strong>Instructions:</strong> ${h(cfg.instructions)}</span>
        </div>` : ''}

        ${cancelBtn}
    </div>`;
}

function showError() {
    document.getElementById('odSkeleton').style.display = 'none';
    document.getElementById('odContent').style.display  = 'block';
    document.getElementById('odSummaryCard').style.display = 'none';
    document.getElementById('odItemsList').style.display   = 'none';
    document.getElementById('odError').style.display       = 'block';
}

/* ════ TOAST ════
   types: 'success' | 'error' | 'warning' | 'info'
   ════════════════ */
const TOAST_STYLES = {
    success: { bg:'#16a34a', icon:'fa-solid fa-circle-check' },
    error:   { bg:'#ef4444', icon:'fa-solid fa-circle-xmark' },
    warning: { bg:'#f59e0b', icon:'fa-solid fa-triangle-exclamation' },
    info:    { bg:'#2D8CF0', icon:'fa-solid fa-circle-info' },
};

function odToast(msg, type = 'success', duration = 3000) {
    const container = document.getElementById('odToastContainer');
    if (!container) return;

    const st  = TOAST_STYLES[type] || TOAST_STYLES.success;
    const el  = document.createElement('div');
    el.style.cssText = `
        display:flex; align-items:center; gap:10px;
        background:${st.bg}; color:#fff;
        padding:11px 18px; border-radius:50px;
        font-size:0.82rem; font-weight:700; line-height:1.3;
        box-shadow:0 4px 20px rgba(0,0,0,0.22);
        pointer-events:auto; max-width:360px; width:max-content;
        opacity:0; transform:translateY(12px) scale(0.96);
        transition:opacity 0.28s ease, transform 0.28s cubic-bezier(.4,0,.2,1);
    `;
    el.innerHTML = `<i class="${st.icon}" style="font-size:1rem;flex-shrink:0;"></i><span>${msg}</span>`;
    container.appendChild(el);

    // Animate in
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            el.style.opacity   = '1';
            el.style.transform = 'translateY(0) scale(1)';
        });
    });

    // Animate out
    setTimeout(() => {
        el.style.opacity   = '0';
        el.style.transform = 'translateY(8px) scale(0.96)';
        setTimeout(() => el.remove(), 300);
    }, duration);
}

/* ════ CONFIRM SHEET ════ */
function odConfirm({ title = 'Are you sure?', msg = '', icon = 'fa-solid fa-trash-can', iconColor = '#ef4444', okText = 'Confirm', cancelText = 'Cancel', okColor = '#ef4444' } = {}) {
    return new Promise(resolve => {
        const backdrop = document.getElementById('odConfirmBackdrop');
        const sheet    = document.getElementById('odConfirmSheet');
        const okBtn    = document.getElementById('odConfirmOk');
        const cancelBtn= document.getElementById('odConfirmCancel');

        const iconEl = document.getElementById('odConfirmIcon');
        iconEl.innerHTML = `<i class="${icon}" style="color:${iconColor};font-size:2rem;"></i>`;
        document.getElementById('odConfirmTitle').textContent = title;
        document.getElementById('odConfirmMsg').textContent   = msg;
        okBtn.textContent      = okText;
        okBtn.style.background = okColor;
        cancelBtn.textContent  = cancelText;

        backdrop.style.display = 'flex';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                sheet.style.transform = 'translateY(0)';
            });
        });

        function close(result) {
            sheet.style.transform = 'translateY(100%)';
            setTimeout(() => { backdrop.style.display = 'none'; }, 300);
            okBtn.onclick     = null;
            cancelBtn.onclick = null;
            backdrop.onclick  = null;
            resolve(result);
        }

        okBtn.onclick     = () => close(true);
        cancelBtn.onclick = () => close(false);
        backdrop.onclick  = e => { if (e.target === backdrop) close(false); };
    });
}

/* ════ STATUS CHANGE TOAST ════ */
function notifyStatusChange(prev, next) {
    const n = (next || '').toLowerCase();
    if (n === 'confirmed' || n === 'accepted') {
        odToast('Your order has been confirmed!', 'success');
    } else if (n === 'processing') {
        odToast('Order is now being processed.', 'info');
    } else if (n === 'out for delivery') {
        odToast('Your order is on the way!', 'info');
    } else if (n === 'delivered') {
        odToast('Order delivered successfully!', 'success');
    } else if (n === 'cancelled') {
        odToast('This order has been cancelled.', 'warning');
    } else if (n === 'rejected') {
        odToast('Order was rejected by the seller.', 'error');
    } else {
        odToast(`Order status updated to ${next}.`, 'info');
    }
}

/* ════ LATE UPLOAD HANDLERS ════ */
window.handleLateUpload = async function(oId, dIdx, inputEl) {
    const file = inputEl.files[0];
    if (!file) return;
    const order = currentOrder;
    if (!order || order.id !== oId) return;
    const docItem = order.documents[dIdx];

    const isPdf   = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isImage = file.type.startsWith('image/');
    if (!isPdf && !isImage) {
        odToast('Only PDF or image files are supported.', 'warning');
        inputEl.value = '';
        return;
    }

    // Name match check
    const stripExt = n => n.replace(/\.[^.]+$/, '').toLowerCase().trim();
    if (stripExt(file.name) !== stripExt(docItem.name)) {
        odToast(`File name mismatch. Expected: "${docItem.name}"`, 'warning');
        inputEl.value = '';
        return;
    }

    // Page count check for PDFs
    if (isPdf && typeof pdfjsLib !== 'undefined') {
        try {
            const buf = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
            if (pdf.numPages !== docItem.pages) {
                odToast(`Page count mismatch. Expected ${docItem.pages}, got ${pdf.numPages}.`, 'warning');
                inputEl.value = '';
                return;
            }
        } catch(e) { /* skip page check if pdf.js fails */ }
    }

    const key = `${oId}-${dIdx}`;
    lateUploads[key] = { file, status: 'uploading', progress: 0, speed: 'Calculating…', eta: '…', intent: 'active', xhr: null };
    renderLateProgress(oId, dIdx);
    startLateXHR(oId, dIdx);
};

async function startLateXHR(oId, dIdx) {
    const key = `${oId}-${dIdx}`;
    const t   = lateUploads[key];
    if (!t || t.intent === 'cancelled') return;
    t.status = 'uploading'; t.intent = 'active';

    /* Signed, single-use upload link from the server (private bucket) */
    let target;
    try {
        target = await getUploadTarget('order', t.file.name, oId);
    } catch (e) {
        t.status = 'error'; renderLateProgress(oId, dIdx);
        odToast(`Upload unavailable: ${e.message}`, 'error');
        return;
    }

    const xhr       = new XMLHttpRequest();
    t.xhr = xhr;

    let lastLoaded = 0, lastTime = Date.now();
    xhr.upload.addEventListener('progress', e => {
        if (!e.lengthComputable || t.intent !== 'active') return;
        const now  = Date.now();
        const diff = (now - lastTime) / 1000;
        if (diff >= 0.5) {
            const bps = (e.loaded - lastLoaded) / diff;
            t.speed = bps < 1024*1024 ? `${(bps/1024).toFixed(1)} KB/s` : `${(bps/(1024*1024)).toFixed(2)} MB/s`;
            const remain = e.total - e.loaded;
            t.eta = bps > 0 ? (remain/bps < 60 ? `${Math.ceil(remain/bps)}s left` : `${Math.ceil(remain/bps/60)}m left`) : '…';
            lastLoaded = e.loaded; lastTime = now;
        }
        t.progress = Math.round((e.loaded / e.total) * 100);
        renderLateProgress(oId, dIdx);
    });

    xhr.addEventListener('load', async () => {
        if (t.intent !== 'active') return;
        if (xhr.status >= 200 && xhr.status < 300) {
            await syncLateUpload(oId, dIdx, target.fileUrl, 'uploaded');
        } else {
            t.status = 'error'; renderLateProgress(oId, dIdx);
            odToast('Upload failed. Try WhatsApp instead.', 'error');
        }
    });
    xhr.addEventListener('error', () => {
        if (t.intent !== 'active') return;
        t.status = 'error'; renderLateProgress(oId, dIdx);
        odToast('Network error during upload.', 'error');
    });
    xhr.addEventListener('abort', () => { renderLateProgress(oId, dIdx); });

    xhr.open('PUT', target.uploadUrl, true);
    if (t.file.type) xhr.setRequestHeader('Content-Type', t.file.type);
    xhr.send(t.file);
}

async function syncLateUpload(oId, dIdx, finalUrl, finalStatus) {
    const order = currentOrder;
    const key   = `${oId}-${dIdx}`;
    const t     = lateUploads[key];
    const updatedDocs = [...order.documents];
    updatedDocs[dIdx] = { ...order.documents[dIdx], uploadedUrl: finalUrl, uploadStatus: finalStatus };
    currentOrder.documents = updatedDocs;
    if (t) { t.status = 'success'; renderLateProgress(oId, dIdx); }
    try {
        await ordersApi('attach-file', { orderId: oId, index: dIdx, uploadStatus: finalStatus, uploadedUrl: finalUrl });
        odToast('File uploaded successfully!', 'success');
        setTimeout(() => { delete lateUploads[key]; render(); }, 1500);
    } catch(e) {
        console.error('Firestore sync failed:', e);
        odToast('Could not sync upload. Please try again.', 'error');
        if (t) { t.status = 'error'; renderLateProgress(oId, dIdx); }
    }
}

function renderLateProgress(oId, dIdx) {
    const area = document.getElementById(`od-late-progress-${oId}-${dIdx}`);
    if (!area) return;
    const key = `${oId}-${dIdx}`;
    const t   = lateUploads[key];
    if (!t || t.intent === 'cancelled') { area.innerHTML = ''; return; }

    if (t.status === 'uploading') {
        area.innerHTML = `
        <div style="margin-top:10px;padding:10px;background:var(--primary-faint,#eef6ff);border:1px solid var(--primary-light,#deeeff);border-radius:10px;">
            <div style="display:flex;justify-content:space-between;font-size:.72rem;font-weight:700;margin-bottom:5px;">
                <span style="color:var(--primary,#2D8CF0);"><i class="fa-solid fa-cloud-arrow-up"></i> Uploading…</span>
                <span style="color:var(--txt2)">${t.progress}%</span>
            </div>
            <div style="background:var(--bg,#f2f4f8);border-radius:50px;height:7px;margin-bottom:5px;">
                <div style="background:var(--primary,#2D8CF0);border-radius:50px;height:7px;width:${t.progress}%;transition:width .3s;"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--txt3,#6b7280);">
                <span>${t.speed}</span><span>${t.eta}</span>
            </div>
            <div style="display:flex;gap:8px;margin-top:8px;">
                <button onclick="pauseLateUpload('${oId}',${dIdx})" style="flex:1;padding:6px;border-radius:8px;border:1.5px solid var(--border);background:var(--bg-white);color:var(--txt2);font-size:.72rem;font-weight:700;cursor:pointer;font-family:inherit;">
                    <i class="fa-solid fa-pause"></i> Pause
                </button>
                <button onclick="cancelLateUpload('${oId}',${dIdx})" style="flex:1;padding:6px;border-radius:8px;border:1.5px solid #ef4444;background:rgba(239,68,68,.08);color:#ef4444;font-size:.72rem;font-weight:700;cursor:pointer;font-family:inherit;">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>
            </div>
        </div>`;
    } else if (t.status === 'paused') {
        area.innerHTML = `
        <div style="margin-top:10px;padding:10px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:10px;">
            <div style="display:flex;justify-content:space-between;font-size:.72rem;font-weight:700;margin-bottom:5px;">
                <span style="color:#f59e0b;"><i class="fa-solid fa-pause"></i> Paused</span><span style="color:var(--txt2)">${t.progress}%</span>
            </div>
            <div style="background:var(--bg,#f2f4f8);border-radius:50px;height:7px;margin-bottom:8px;">
                <div style="background:#f59e0b;border-radius:50px;height:7px;width:${t.progress}%;"></div>
            </div>
            <div style="display:flex;gap:8px;">
                <button onclick="resumeLateUpload('${oId}',${dIdx})" style="flex:1;padding:7px;border-radius:8px;border:none;background:var(--primary,#2D8CF0);color:#fff;font-size:.72rem;font-weight:700;cursor:pointer;font-family:inherit;">
                    <i class="fa-solid fa-play"></i> Resume
                </button>
                <button onclick="cancelLateUpload('${oId}',${dIdx})" style="flex:1;padding:7px;border-radius:8px;border:1.5px solid #ef4444;background:rgba(239,68,68,.08);color:#ef4444;font-size:.72rem;font-weight:700;cursor:pointer;font-family:inherit;">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>
            </div>
        </div>`;
    } else if (t.status === 'error') {
        area.innerHTML = `
        <div style="margin-top:10px;padding:10px;background:#fff5f5;border:1px solid #fca5a5;border-radius:10px;text-align:center;">
            <div style="color:#ef4444;font-size:.75rem;font-weight:700;margin-bottom:6px;"><i class="fa-solid fa-circle-xmark"></i> Upload failed</div>
            <button onclick="cancelLateUpload('${oId}',${dIdx})" style="padding:5px 14px;border-radius:8px;border:1.5px solid #ef4444;background:#fff;color:#ef4444;font-size:.72rem;font-weight:700;cursor:pointer;">Clear</button>
        </div>`;
    } else if (t.status === 'success') {
        area.innerHTML = `
        <div style="margin-top:10px;padding:10px;background:#f0fdf4;border:1px solid #86efac;border-radius:10px;text-align:center;">
            <div style="color:#16a34a;font-size:.75rem;font-weight:700;"><i class="fa-solid fa-circle-check"></i> Upload complete!</div>
        </div>`;
    }
}

window.pauseLateUpload = function(oId, dIdx) {
    const t = lateUploads[`${oId}-${dIdx}`];
    if (t?.xhr) { t.intent = 'paused'; t.status = 'paused'; t.xhr.abort(); }
};
window.resumeLateUpload = function(oId, dIdx) { startLateXHR(oId, dIdx); };
window.cancelLateUpload = function(oId, dIdx) {
    const key = `${oId}-${dIdx}`;
    const t   = lateUploads[key];
    if (t?.xhr) { t.intent = 'cancelled'; t.xhr.abort(); }
    delete lateUploads[key];
    const inp = document.getElementById(`od-late-input-${oId}-${dIdx}`);
    if (inp) inp.value = '';
    renderLateProgress(oId, dIdx);
};

window.markLateWA = async function(oId, dIdx) {
    const order = currentOrder;
    if (!order || order.id !== oId) return;
    const d         = order.documents[dIdx];
    const shop      = {};
    const orderRef  = d.config?.groupOrderId || oId.slice(0,8).toUpperCase();
    const waNums    = Array.isArray(order.shopContacts?.whatsapp) ? order.shopContacts.whatsapp : (order.shopContacts?.whatsapp ? [order.shopContacts.whatsapp] : []);
    if (!waNums.length) { odToast("No WhatsApp number found for this shop.", 'warning'); return; }
    const cleanNum  = waNums[0].toString().replace(/\D/g,'').slice(-10);
    const waText    = `*SUBMIT DOCUMENT*\nOrder ID: #${orderRef}\nFile: ${d.name} (${d.pages} pages)\n\nHi, I am sending this file for my xerox order.`;
    window.open(`https://wa.me/91${cleanNum}?text=${encodeURIComponent(waText)}`, '_blank');
    await syncLateUpload(oId, dIdx, 'pending_whatsapp', 'whatsapp');
};

/* ════ CANCEL ITEM ════ */
window.cancelOrderItem = async function(oId, idx, type) {
    if (!currentOrder) return;

    const confirmed = await odConfirm({
        title:      'Cancel this item?',
        msg:        'This cannot be undone. The item will be permanently removed from your order.',
        icon:       'fa-solid fa-trash-can',
        iconColor:  '#ef4444',
        okText:     'Yes, Cancel',
        cancelText: 'Keep Item',
        okColor:    '#ef4444',
    });
    if (!confirmed) return;

    try {
        const orderRef  = doc(db, 'orders', oId);
        const orderSnap = await getDoc(orderRef);
        if (!orderSnap.exists()) return;

        const data = orderSnap.data();
        const list = type === 'doc' ? (data.documents || []) : (data.items || []);

        // Quick checks for a friendly message; the server enforces all of them
        if (Number(data.discountAmount) > 0) {
            odToast('This order used a coupon, so items cannot be removed individually. Please contact support.', 'warning');
            return;
        }
        if (Number(data.walletAmount) > 0) {
            odToast('This order was partly paid from your wallet, so items cannot be removed individually. Please contact support.', 'warning');
            return;
        }
        const orderStillPending = !data.status || data.status.toLowerCase() === 'pending';
        const itemStillPending  = !list[idx]?.status || list[idx].status.toLowerCase() === 'pending';
        if (!orderStillPending || !itemStillPending) {
            odToast('Cannot cancel — seller has already started processing.', 'warning');
            render();
            return;
        }

        const r = await ordersApi('cancel-item', { orderId: oId, index: idx });

        // Fade out the card
        const cardEl = document.getElementById(`od-item-${oId}-${idx}`);
        if (cardEl) {
            cardEl.style.transition = 'opacity 0.3s, transform 0.3s';
            cardEl.style.opacity    = '0';
            cardEl.style.transform  = 'scale(0.95)';
            setTimeout(() => cardEl.remove(), 300);
        }

        if (r.orderCancelled) {
            odToast('Order cancelled — no items remaining.', 'info');
            setTimeout(() => window.location.href = 'orders.html', 1800);
            return;
        }

        const updatedList = [...list];
        updatedList.splice(idx, 1);
        if (type === 'doc') currentOrder.documents = updatedList;
        else                currentOrder.items     = updatedList;
        currentOrder.subtotal    = r.subtotal;
        currentOrder.totalAmount = r.totalAmount;
        odToast('Item cancelled successfully.', 'success');
        render();

    } catch (e) {
        console.error('Cancel item error:', e);
        odToast(e.userFacing ? e.message : 'Could not cancel item. Please try again.', 'error');
    }
};
