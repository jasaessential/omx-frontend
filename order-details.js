/* ═══════════════════════════════════════════════
   JASA V2 — order-details.js
   Reads orders/{id} + order_status/{id} with
   real-time onSnapshot listeners.
   Supports xerox orders (documents[]) and
   product orders (items[]).
   Late upload of xerox files via Supabase XHR.
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import { SUPABASE_CONFIG, WORKER_URL, PAYMENT_SERVER_URL, getSupabaseConfig } from './env-config.js';

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
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
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
            const { status } = snap.data();
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

/* ════ RENDER ════ */
function render() {
    document.getElementById('odSkeleton').style.display = 'none';
    document.getElementById('odContent').style.display  = 'block';

    const o      = currentOrder;
    const st     = getStatus(deriveOrderStatus(o));
    const ordRef = o.groupOrderId || o.id.slice(0,8).toUpperCase();

    document.getElementById('odHeaderSub').textContent = `Order #${ordRef}`;

    let dateStr = '—';
    try {
        const d = o.createdAt?.toDate ? o.createdAt.toDate()
            : new Date((o.createdAt?.seconds||0)*1000);
        dateStr = d.toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
    } catch(_){}

    const shopObj   = shopDataMap[o.shopId] || {};
    const shopName  = shopObj.name || o.shopName || 'Shop';
    const shopAddr  = shopObj.address || o.shopAddress || 'Local Center';
    const rawLink   = shopObj.locationLink || o.shopLocationLink || '';
    const mapUrl    = rawLink || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shopName + ' ' + shopAddr)}`;

    const isPickup  = o.fulfillmentType === 'pickup' || o.deliveryMode === 'pickup' || o.isPickup === true || o.orderType === 'pickup' || (o.deliveryFee === 0 && !o.deliveryAddress);

    const addr      = o.deliveryAddress;
    const addrText  = addr ? `${addr.label?addr.label+' — ':''}${addr.street||''}, ${addr.city||''}${addr.pincode?' — '+addr.pincode:''}` : (isPickup ? 'Self Pickup at Shop' : '—');

    // Payment info
    const pMethod   = (o.paymentMethod || '').toLowerCase();
    const pStatus   = (o.paymentStatus || '').toLowerCase();
    const isPartial = pMethod === 'partial' || pStatus === 'partial_paid' || (o.balanceDue > 0 && o.amountPaid > 0);
    const isPaid    = pStatus === 'paid' || pMethod === 'paid' || (pMethod === 'razorpay' && pStatus !== 'pending' && !isPartial);

    let payPillHtml = '';
    if (isPartial) {
        const paidAmt = o.amountPaid || 0;
        const balAmt  = o.balanceDue || Math.max(0, (o.totalAmount || 0) - paidAmt);
        payPillHtml = `<span class="od-status-pill" style="background:#e0f2fe;color:#0284c7;">
            <i class="fa-solid fa-percent"></i> Partial Paid (₹${paidAmt.toLocaleString('en-IN')} Paid, ₹${balAmt.toLocaleString('en-IN')} Balance)
        </span>`;
    } else if (isPaid) {
        payPillHtml = `<span class="od-status-pill" style="background:#dcfce7;color:#16a34a;">
            <i class="fa-solid fa-circle-check"></i> Paid Online
        </span>`;
    } else {
        payPillHtml = `<span class="od-status-pill" style="background:#fef3c7;color:#d97706;">
            <i class="fa-solid fa-money-bill-wave"></i> Cash on Delivery (COD)
        </span>`;
    }

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
        <div class="od-psc-name">${esc(shopName)}</div>
        <div class="od-psc-addr"><i class="fa-solid fa-location-dot" style="color:var(--primary);margin-right:4px;"></i> ${esc(shopAddr)}</div>
        ${shopLinkBtn}
    </div>` : '';

    document.getElementById('odSummaryCard').innerHTML = `
    <div class="od-section-title"><i class="fa-solid fa-receipt"></i> Order Summary</div>
    <table class="od-kv-table">
        ${kvS('Order Info')}
        ${kv('Order ID',     `<strong>#${ordRef}</strong>`, 'fa-solid fa-receipt')}
        ${kv('Fulfillment',  fulPillHtml,                   'fa-solid fa-truck-ramp-box')}
        ${kv('Shop',         isPickup
            ? `<a href="javascript:void(0)" onclick="confirmOpenMap('${esc(shopName)}', '${esc(mapUrl)}')" style="color:var(--primary);font-weight:700;text-decoration:none;"><i class="fa-solid fa-map-location-dot"></i> ${esc(shopName)} (View Map)</a>`
            : `<span style="font-weight:700;">${esc(shopName)}</span>`, 'fa-solid fa-store')}
        ${kv('Date',         dateStr,                        'fa-regular fa-calendar')}
        ${kv('Payment',      payPillHtml,                    'fa-solid fa-wallet')}
        ${kv('Status',       statusPill,                     'fa-solid fa-circle-dot')}
        ${kvS('Pricing')}
        ${kv('Subtotal',     `₹${(o.subtotal||0).toLocaleString('en-IN')}`,                          'fa-solid fa-file-invoice')}
        ${Number(o.discountAmount) > 0 ? kv(`Coupon${o.couponCode ? ` (${esc(o.couponCode)})` : ''}`, `<span style="color:#16a34a;font-weight:800;">-₹${Number(o.discountAmount).toLocaleString('en-IN')}</span>`, 'fa-solid fa-ticket') : ''}
        ${Number(o.walletAmount) > 0 ? kv('Wallet', `<span style="color:#16a34a;font-weight:800;">-₹${Number(o.walletAmount).toLocaleString('en-IN')}</span>`, 'fa-solid fa-wallet') : ''}
        ${kv('Delivery',    o.deliveryFee != null ? (o.deliveryFee === 0 ? '<span style="color:#16a34a;font-weight:800;">FREE ' + (isPickup?'(Pickup)':'') + '</span>' : `₹${Number(o.deliveryFee).toLocaleString('en-IN')}`) : '—', 'fa-solid fa-truck-fast')}
        ${isPartial ? kv('Amount Paid', `<strong style="color:#16a34a;">₹${(o.amountPaid||0).toLocaleString('en-IN')}</strong>`, 'fa-solid fa-circle-check') : ''}
        ${isPartial ? kv('Balance Due', `<strong style="color:#e11d48;">₹${(o.balanceDue||0).toLocaleString('en-IN')}</strong>`, 'fa-solid fa-triangle-exclamation') : ''}
        ${kv('Total',        `<strong style="color:var(--primary);font-size:1.05rem;">₹${(o.totalAmount || (o.subtotal||0) + (o.deliveryFee||0)).toLocaleString('en-IN')}</strong>`, 'fa-solid fa-receipt')}
        ${kvS(isPickup ? 'Pickup Details' : 'Delivery Address')}
        ${isPickup ? kv('Pickup Spot', `<span style="font-weight:700;">${esc(shopName)}</span> — <span style="font-size:.78rem;color:var(--txt2);">${esc(shopAddr)}</span>`, 'fa-solid fa-location-dot') : kv('Address', addrText, 'fa-solid fa-location-dot')}
        ${o.contacts?.mobile    ? kv('Primary Phone', o.contacts.mobile,    'fa-solid fa-phone')        : ''}
        ${o.contacts?.altMobile ? kv('Alternate Phone', o.contacts.altMobile, 'fa-solid fa-phone-volume') : ''}
    </table>
    ${pickupShopBlock}`;

    // Items
    const isXerox = o.type === 'xerox';
    const items   = isXerox ? (o.documents||[]) : (o.items||[]);
    document.getElementById('odItemsList').innerHTML = items.map((item,i) => buildItemCard(item, i, o)).join('');
}

function buildItemCard(item, idx, order) {
    const isCancelled = ['cancelled','rejected'].includes((item.status||'').toLowerCase());
    const isXerox = order.type === 'xerox';
    const qty   = item.qty || item.config?.quantity || 1;
    const price = isXerox ? (item.price||0) : ((item.price||0) * qty);
    const img   = item.img || item.images?.[0]?.url || '';

    const orderPending = deriveOrderStatus(order) === 'pending';
    const itemPending  = !item.status || item.status.toLowerCase() === 'pending';
    const itemType     = isXerox ? 'doc' : 'item';
    const cancelBtn    = (!isCancelled && orderPending && itemPending) ? `
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border, #eee);text-align:center;">
            <button onclick="cancelOrderItem('${order.id}', ${idx}, '${itemType}')"
                style="background:none;border:1.5px solid #ef4444;color:#ef4444;border-radius:50px;padding:7px 22px;font-size:0.78rem;font-weight:700;cursor:pointer;letter-spacing:0.3px;">
                <i class="fa-solid fa-trash-can" style="margin-right:5px;"></i>Cancel Item
            </button>
        </div>` : '';

    if (isXerox) {
        return buildXeroxDocCard(item, idx, order, cancelBtn);
    }

    return `
    <div class="od-item-card" id="od-item-${order.id}-${idx}" style="margin-top:10px;">
        <div class="od-item-head">
            <div class="od-item-img">
                ${img ? `<img src="${img}" alt="${item.name||'Item'}" loading="lazy">` : '<i class="fa-solid fa-box od-no-img"></i>'}
            </div>
            <div class="od-item-meta-wrap">
                <div class="od-item-name">${item.name||'Item'}</div>
                <div class="od-item-price">₹${item.price.toLocaleString('en-IN')} × ${qty} = ₹${price.toLocaleString('en-IN')}</div>
                ${itemStatusBadge(item.status || 'pending')}
            </div>
        </div>
        ${buildOdItemTracker(item.status, item.rejectionMessage)}
        ${cancelBtn}
    </div>`;
}

/* ── Resolve xerox meta IDs to names ── */
function resolveXeroxId(list, id, fallback) {
    if (!id || id === 'none') return null;
    return list.find(x => x.id === id)?.name || fallback || id;
}

/* ── Full xerox document detail card ── */
function buildXeroxDocCard(d, idx, order, cancelBtn) {
    const cfg         = d.config || {};
    const uploadSt    = d.uploadStatus || 'pending';
    const isCancelled = ['cancelled','rejected'].includes((d.status||'').toLowerCase());

    const isUploaded = uploadSt === 'uploaded';
    const isWA       = uploadSt === 'whatsapp';
    const isPending  = !isUploaded && (uploadSt === 'pending' || uploadSt === 'later' || uploadSt === 'pending_later' || uploadSt === 'whatsapp');

    const COLOR_LABELS  = { bw: 'Black & White', color: 'Color', mixed: 'Mixed (B&W + Colour)' };
    const book = cfg.bindingSet;
    const FORMAT_LABELS = { frontOnly: 'Front Only', both: 'Front & Back' };

    const paperName = resolveXeroxId(xeroxMeta.paper, cfg.paperId, 'Standard Paper');
    const bindName  = resolveXeroxId(xeroxMeta.binding, cfg.bindingId);
    const lamName   = resolveXeroxId(xeroxMeta.lamination, cfg.laminationId);

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

    const viewFileBtn = (isUploaded && d.uploadedUrl && !['pending_whatsapp','pending_later'].includes(d.uploadedUrl)) ? `
    <div style="margin-top:8px;">
        <a href="${d.uploadedUrl}" target="_blank" class="od-view-file-btn">
            <i class="fa-solid fa-eye"></i> View Uploaded File
        </a>
    </div>` : '';

    return `
    <div class="od-item-card od-xerox-doc-card" id="od-item-${order.id}-${idx}">

        <div class="od-doc-head-row">
            <span class="od-doc-label">Document ${idx+1}</span>
            ${d.requiresManualEstimation ? `<span class="od-doc-est-badge">Manual Est.</span>` : ''}
        </div>

        <div class="od-doc-filename">${d.name}</div>

        <div class="od-doc-meta-row">
            <span class="od-doc-meta-item"><i class="fa-regular fa-file-lines"></i>${d.pages||0} Pages</span>
            <span class="od-doc-price-chip">₹${(d.price||0).toFixed(2)}</span>
            ${!isCancelled ? uploadBadge : ''}
            ${itemStatusBadge(d.status || 'pending')}
        </div>

        ${uploadBtn}
        ${lateArea}
        ${viewFileBtn}
        ${buildOdItemTracker(d.status, d.rejectionMessage)}

        <div class="od-paper-config-block">
            <div class="od-paper-config-title">
                <i class="fa-solid fa-file-invoice"></i> Paper Configuration
            </div>
            <table class="od-paper-config-table">
                <tr><td>Paper Type</td><td>${paperName||'Standard'}</td></tr>
                <tr><td>Color Mode</td><td>${COLOR_LABELS[cfg.color]||cfg.color||'B&W'}</td></tr>
                ${cfg.color === 'mixed' ? `<tr><td>Colour Pages</td><td>${cfg.colorPages} (rest B&amp;W)</td></tr>` : ''}
                <tr><td>Print Format</td><td>${FORMAT_LABELS[cfg.format]||cfg.format||'Front Only'}</td></tr>
                ${cfg.ratio && cfg.ratio !== '1:1' ? `<tr><td>Ratio</td><td>${cfg.ratio}</td></tr>` : ''}
                <tr><td>Total Pages</td><td>${d.pages||0} pages</td></tr>
                <tr><td>Quantity</td><td>×${cfg.quantity||1} ${(cfg.quantity||1)>1?'copies':'copy'}</td></tr>
                ${bindName ? `<tr><td>Binding</td><td>${bindName}</td></tr>` : ''}
                ${book ? `<tr><td>Combined Book</td><td>File ${book.position} of ${book.size}</td></tr>` : ''}
                ${lamName  ? `<tr><td>Lamination</td><td>${lamName}</td></tr>` : ''}
            </table>
        </div>

        ${cfg.instructions ? `
        <div class="od-instructions-block">
            <i class="fa-solid fa-note-sticky"></i>
            <span><strong>Instructions:</strong> ${cfg.instructions}</span>
        </div>` : ''}

        ${cancelBtn}
    </div>`;
}

function buildTracker(step) {
    const steps = [
        { icon:'fa-solid fa-hourglass-half', label:'Pending'    },
        { icon:'fa-solid fa-gears',           label:'Processing' },
        { icon:'fa-solid fa-truck-fast',      label:'On the Way' },
        { icon:'fa-solid fa-circle-check',    label:'Delivered'  },
    ];
    const fill = Math.round(((Math.max(0, step-1)) / 3) * 100);
    const stepsHtml = steps.map((s, i) => {
        const n   = i + 1;
        const cls = n < step ? 'od-step done' : n === step ? 'od-step active' : 'od-step';
        return `<div class="${cls}">
            <div class="od-step-dot"><i class="${s.icon}"></i></div>
            <span class="od-step-label">${s.label}</span>
        </div>`;
    }).join('');
    return `<div class="od-tracker" style="--fill:${fill};">${stepsHtml}</div>`;
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

    /* Ensure env config is loaded before reading Supabase creds */
    let sbUrl, sbKey;
    try {
        const sb = await getSupabaseConfig();
        sbUrl = sb?.url;
        sbKey = sb?.anonKey;
    } catch (_) {}
    if (!sbUrl || !sbKey) {
        t.status = 'error'; renderLateProgress(oId, dIdx);
        odToast('Upload service unavailable. Please try again.', 'error');
        return;
    }

    const cleanName = t.file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const path      = `xerox-orders/${oId}/${Date.now()}_${cleanName}`;
    const url       = `${sbUrl}/storage/v1/object/files/${path}`;
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
            const finalUrl = `${sbUrl}/storage/v1/object/public/files/${path}`;
            await syncLateUpload(oId, dIdx, finalUrl, 'uploaded');
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

    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${sbKey}`);
    xhr.setRequestHeader('apikey', sbKey);
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
