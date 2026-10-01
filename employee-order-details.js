/* ═══════════════════════════════════════════════
   EMPLOYEE ORDER DETAILS — employee-order-details.js
   URL param: ?orderId=xxx
   Auth: employee | admin (must be in shops.employees[] or shops.owners[])
   Logic: mirrors seller-order-details.js but
   – Only allows "Mark Delivered" (no Confirm / Reject)
   – Shows full order + customer + delivery info
   – WA quick-send in header
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import {
    doc, getDoc, getDocs, collection,
    updateDoc, setDoc, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { WORKER_URL } from './env-config.js';

/* ── URL param ── */
const orderId = new URLSearchParams(window.location.search).get('orderId');

/* ── State ── */
let currentOrder    = null;
let currentShopData = null;
let xeroxMeta       = { paper:[], binding:[], lamination:[] };
let _cachedProfile  = null;

/* ── STATUS MAP ── */
const STATUS_MAP = {
    pending:            { label:'Pending',         color:'#f59e0b', bg:'#fef3c7', icon:'fa-solid fa-hourglass-half' },
    confirmed:          { label:'Confirmed',        color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check'  },
    accepted:           { label:'Confirmed',        color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check'  },
    'out for delivery': { label:'Out for Delivery', color:'#10b981', bg:'#d1fae5', icon:'fa-solid fa-truck-fast'    },
    delivered:          { label:'Delivered',        color:'#16a34a', bg:'#dcfce7', icon:'fa-solid fa-circle-check'  },
    cancelled:          { label:'Cancelled',        color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-circle-xmark'  },
    rejected:           { label:'Rejected',         color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-triangle-exclamation' },
};
function getStatus(raw) {
    return STATUS_MAP[(raw||'pending').toLowerCase().trim()]
        || { label:raw||'Pending', color:'#6b7280', bg:'#f3f4f6', icon:'fa-solid fa-circle-dot' };
}

/* ── Helpers ── */
function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDateTime(raw) {
    if (!raw) return '—';
    try {
        const d = raw.toDate ? raw.toDate() : new Date((raw.seconds||0)*1000);
        return d.toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});
    } catch(_){ return '—'; }
}
const COLOR_LABELS  = { bw:'Black & White', color:'Color', mixed:'Mixed (B&W + Colour)' };
const FORMAT_LABELS = { frontOnly:'Front Only', both:'Front & Back' };
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
function resolveId(list,id){ if(!id||id==='none')return null; return list.find(x=>x.id===id)?.name||null; }

/* ── Toast ── */
function toast(msg, type='') {
    const el = document.getElementById('soToast');
    el.textContent = msg; el.className = 'so-toast ' + type;
    void el.offsetWidth; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3200);
}

/* ════════════════════════════════
   AUTH + ACCESS GUARD
   Employee must be in shops.employees[] or shops.owners[]
   ════════════════════════════════ */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search)); return; }
    if (!orderId) { showError(); return; }

    try {
        const snap = await getDoc(doc(db,'users',user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const userData = snap.data();
        const roles    = userData.roles || [userData.role || 'user'];

        if (!roles.includes('employee') && !roles.includes('admin')) {
            toast('Employee access required.','error');
            setTimeout(() => window.location.replace('index.html'), 1400);
            return;
        }

        await loadXeroxMeta();
        listenToOrder(user.uid, roles);
    } catch(err) {
        console.error('[EmpOrderDetails] auth:', err);
        showError();
    }
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
        const [p,b,l] = await Promise.all([
            getDocs(collection(db,'xerox_config_paper')),
            getDocs(collection(db,'xerox_config_binding')),
            getDocs(collection(db,'xerox_config_lamination')),
        ]);
        xeroxMeta.paper      = p.docs.map(d=>({id:d.id,...d.data()}));
        xeroxMeta.binding    = b.docs.map(d=>({id:d.id,...d.data()}));
        xeroxMeta.lamination = l.docs.map(d=>({id:d.id,...d.data()}));
    } catch(e){ console.warn('xerox meta:',e); }
}

/* ════════════════════════════════
   REAL-TIME ORDER LISTENER
   ════════════════════════════════ */
function listenToOrder(uid, roles) {
    onSnapshot(doc(db,'orders',orderId), async snap => {
        if (!snap.exists()) { showError(); return; }

        const data = snap.data();

        // Access check: employee must be in the shop's employees[] or owners[]
        if (!roles.includes('admin') && data.shopId) {
            try {
                const shopSnap = await getDoc(doc(db,'shops',data.shopId));
                if (shopSnap.exists()) {
                    const sd = shopSnap.data();
                    const hasAccess = (sd.employees||[]).includes(uid) || (sd.owners||[]).includes(uid);
                    if (!hasAccess) { showError(); return; }
                    currentShopData = { id:shopSnap.id, ...sd };
                }
            } catch(e){ console.warn('shop access check:',e); }
        } else if (roles.includes('admin') && data.shopId && !currentShopData) {
            try {
                const shopSnap = await getDoc(doc(db,'shops',data.shopId));
                if (shopSnap.exists()) currentShopData = { id:shopSnap.id, ...shopSnap.data() };
            } catch(e){}
        }

        currentOrder = { id:snap.id, ...data };

        // Fetch + cache user profile
        if (currentOrder.userId) {
            if (!_cachedProfile || _cachedProfile.userId !== currentOrder.userId) {
                try {
                    const uSnap = await getDoc(doc(db,'users',currentOrder.userId));
                    if (uSnap.exists()) {
                        const ud = uSnap.data();
                        _cachedProfile = {
                            userId:        currentOrder.userId,
                            userName:      ud.fullName || ud.name || 'Customer',
                            userEmail:     ud.email || '',
                            userDisplayId: ud.userId || currentOrder.userId.slice(0,8).toUpperCase(),
                        };
                    } else {
                        _cachedProfile = { userId:currentOrder.userId, userName:'Customer', userEmail:'', userDisplayId:currentOrder.userId.slice(0,8).toUpperCase() };
                    }
                } catch(e){
                    _cachedProfile = { userId:currentOrder.userId, userName:'Customer', userEmail:'', userDisplayId:currentOrder.userId.slice(0,8).toUpperCase() };
                }
            }
            currentOrder.userName      = _cachedProfile.userName;
            currentOrder.userEmail     = _cachedProfile.userEmail;
            currentOrder.userDisplayId = _cachedProfile.userDisplayId;
        }

        render();
    }, err => { console.error('[EmpOrderDetails] snap:',err); showError(); });
}

window.confirmOpenMap = function(shopName, mapUrl) {
    const msg = `Are you sure you want to open Google Maps to navigate to ${shopName}?`;
    if (window.confirm(msg)) {
        if (mapUrl) window.open(mapUrl, '_blank');
    }
};

/* ════════════════════════════════
   MAIN RENDER
   ════════════════════════════════ */
function render() {
    const o       = currentOrder;
    const isXerox = o.type === 'xerox';
    const items   = isXerox ? (o.documents||[]) : (o.items||[]);
    const ordRef  = o.groupOrderId || o.id.slice(0,8).toUpperCase();
    const st      = getStatus(o.status);
    const addr    = o.deliveryAddress || {};
    const contacts = o.contacts || {};
    const mobile  = contacts.mobile || '';

    const isPickup  = o.fulfillmentType === 'pickup' || o.deliveryMode === 'pickup' || o.isPickup === true || o.orderType === 'pickup' || (o.deliveryFee === 0 && !o.deliveryAddress);

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

    const shopObj   = currentShopData || {};
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

    // Header
    document.getElementById('eodTitle').textContent = `Order #${ordRef}`;
    document.getElementById('eodSub').textContent   = fmtDateTime(o.createdAt);
    document.getElementById('eodOrderIdBadge').textContent = `ORDER #${ordRef}`;

    // Pricing
    let subtotal = 0, deliveryFee = 0;
    items.forEach(item => {
        const s = (item.status||'pending').toLowerCase();
        if (!['cancelled','rejected'].includes(s)) {
            subtotal += isXerox ? (item.price||0) : ((item.price||0)*(item.qty||1));
        }
    });
    if (isPickup) {
        deliveryFee = 0;
    } else if (currentShopData) {
        const rules = isXerox
            ? (currentShopData.deliveryPrices?.xerox  || [])
            : (currentShopData.deliveryPrices?.others || []);
        const rule = rules.find(r => subtotal>=r.min && (r.max==null||subtotal<=r.max));
        if (rule) deliveryFee = rule.fee || 0;
    }
    const couponDiscount = Math.min(Number(o.discountAmount) || 0, subtotal);
    const walletUsed = Math.min(Number(o.walletAmount) || 0, Math.max(0, subtotal - couponDiscount + deliveryFee));
    const total = subtotal - couponDiscount - walletUsed + deliveryFee;

    // WA quick-send in header
    if (mobile) {
        let waMsg = `*OUT FOR DELIVERY*\nHello ${o.userName||'Customer'}!\nOrder ID: #${ordRef}\n\nItems:\n`;
        items.forEach((item,i)=>{
            const qty = item.qty||item.config?.quantity||1;
            const amt = isXerox?(item.price||0):((item.price||0)*qty);
            waMsg += `${i+1}. ${item.name||'Item'} x${qty} - ₹${amt.toFixed(2)}\n`;
        });
        waMsg += `\nAmount: ${isPaid ? 'PAID (Prepaid)' : isPartial ? `₹${(o.balanceDue || Math.max(0, total - (o.amountPaid||0))).toFixed(2)} (Partial Balance)` : `₹${total.toFixed(2)} (Cash on Delivery)`}`;
        const waUrl = `https://wa.me/91${mobile.replace(/\D/g,'').slice(-10)}?text=${encodeURIComponent(waMsg)}`;
        document.getElementById('eodWaBtn').innerHTML =
            `<a href="${esc(waUrl)}" target="_blank" class="so-wa-btn" title="Send WhatsApp update" style="width:36px;height:36px;">
                 <i class="fa-brands fa-whatsapp"></i>
             </a>`;
    }

    // Per-item price rows
    const itemRows = items.map(item => {
        const qty  = item.qty||item.config?.quantity||1;
        const line = isXerox?(item.price||0):((item.price||0)*qty);
        return `<tr class="sod-kv">
            <td class="kv-key" style="padding-left:20px;color:var(--txt2);">${esc(item.name||'Item')} ×${qty}</td>
            <td class="kv-val">₹${line.toFixed(2)}</td>
        </tr>`;
    }).join('');

    const kv  = (k,v) => `<tr class="sod-kv"><td class="kv-key">${k}</td><td class="kv-val">${v}</td></tr>`;
    const kvS = label  => `<tr class="sod-kv kv-section"><td colspan="2">${label}</td></tr>`;

    // Summary card
    document.getElementById('eodSummaryCard').innerHTML = `
<div class="sod-section-title"><i class="fa-solid fa-receipt"></i> Order Summary</div>
<table class="sod-kv" style="width:100%;">
    ${kvS('<i class="fa-solid fa-user" style="margin-right:5px;"></i>Customer Info')}
    ${kv('Name',    esc(o.userName||'Guest'))}
    ${kv('User ID', esc(o.userDisplayId||'N/A'))}
    ${mobile ? kv('Phone', `<a href="tel:${esc(mobile)}" class="so-call-link"><i class="fa-solid fa-phone"></i> ${esc(mobile)}</a>`) : ''}
    ${contacts.altMobile ? kv('Alt Phone', `<a href="tel:${esc(contacts.altMobile)}" class="so-call-link"><i class="fa-solid fa-phone-volume"></i> ${esc(contacts.altMobile)}</a>`) : ''}

    ${kvS('<i class="fa-solid fa-truck-ramp-box" style="margin-right:5px;"></i>Order Info')}
    ${kv('Fulfillment', fulPillHtml)}
    ${kv('Shop',     isPickup
        ? `<a href="javascript:void(0)" onclick="confirmOpenMap('${esc(shopName)}', '${esc(mapUrl)}')" style="color:var(--primary);font-weight:700;text-decoration:none;"><i class="fa-solid fa-map-location-dot"></i> ${esc(shopName)} (View Map)</a>`
        : `<span style="font-weight:700;">${esc(shopName)}</span>`)}
    ${kv('Date',    fmtDateTime(o.createdAt))}
    ${kv('Type',    isXerox ? '<span style="color:var(--primary);font-weight:800;">Xerox</span>' : '<span style="color:#16a34a;font-weight:800;">Product</span>')}
    ${kv('Payment', payPillHtml)}
    ${kv('Status',  `<span class="so-badge" style="background:${st.bg};color:${st.color};"><i class="${st.icon}"></i> ${st.label}</span>`)}

    ${kvS('<i class="fa-solid fa-indian-rupee-sign" style="margin-right:5px;"></i>Pricing')}
    ${itemRows}
    ${kv('Subtotal', `₹${subtotal.toFixed(2)}`)}
    ${couponDiscount > 0 ? kv(`Coupon${o.couponCode ? ` (${esc(o.couponCode)})` : ''}`, `<span class="kv-free">-₹${couponDiscount.toFixed(2)}</span>`) : ''}
    ${walletUsed > 0 ? kv('Wallet', `<span class="kv-free">-₹${walletUsed.toFixed(2)}</span>`) : ''}
    ${kv('Delivery', isPickup ? '<span class="kv-free">FREE (Pickup)</span>' : (deliveryFee===0 ? '<span class="kv-free">FREE</span>' : `₹${deliveryFee.toFixed(2)}`))}
    ${isPartial ? kv('Amount Paid', `<strong style="color:#16a34a;">₹${(o.amountPaid||0).toLocaleString('en-IN')}</strong>`) : ''}
    ${isPartial ? kv('Balance Due', `<strong style="color:#e11d48;">₹${(o.balanceDue||0).toLocaleString('en-IN')}</strong>`) : ''}
    <tr class="sod-kv kv-total">
        <td class="kv-key" style="font-weight:800;color:var(--primary);">
            ${isPaid ? 'Total' : isPartial ? 'Balance Due' : 'Collect (COD)'}
        </td>
        <td class="kv-val" style="font-size:.95rem;font-weight:800;color:var(--primary);">₹${(isPartial ? (o.balanceDue || Math.max(0, total - (o.amountPaid||0))) : total).toFixed(2)}</td>
    </tr>
    ${isPartial
        ? `<tr class="sod-kv"><td colspan="2" style="text-align:right;font-size:.62rem;font-weight:800;color:#0284c7;padding:4px 14px;">PARTIAL PAID (₹${(o.amountPaid||0).toLocaleString('en-IN')} Paid)</td></tr>`
        : isPaid
            ? `<tr class="sod-kv"><td colspan="2" style="text-align:right;font-size:.62rem;font-weight:800;color:#16a34a;padding:4px 14px;"><i class="fa-solid fa-check"></i> PREPAID ONLINE</td></tr>`
            : `<tr class="sod-kv"><td colspan="2" style="text-align:right;font-size:.62rem;font-weight:800;color:#ef4444;padding:4px 14px;">CASH ON DELIVERY</td></tr>`}

    ${isPickup ? kvS('<i class="fa-solid fa-location-dot" style="margin-right:5px;"></i>Pickup Details') : (addr.street||addr.city ? kvS('<i class="fa-solid fa-location-dot" style="margin-right:5px;"></i>Delivery Address') : '')}
    ${isPickup
        ? kv('Pickup Spot', `<span style="font-weight:700;">${esc(shopName)}</span> — <span style="font-size:.78rem;color:var(--txt2);">${esc(shopAddr)}</span>`)
        : (addr.street||addr.city ? `
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

    // Items list
    document.getElementById('eodItemsList').innerHTML =
        items.map((item,i) => isXerox ? buildDocCard(item,i) : buildProductCard(item,i)).join('');

    // Show bulk deliver card if any confirmed/OFD items exist
    const hasDeliverable = items.some(i => {
        const s = (i.status||'pending').toLowerCase();
        return s==='confirmed' || s==='out for delivery';
    });
    document.getElementById('eodBulkDeliverCard').style.display = hasDeliverable ? 'block' : 'none';
}

/* ════════════════════════════════
   ITEM CARDS
   Employee can only Mark Delivered
   (no confirm/reject — that's seller's job)
   ════════════════════════════════ */
function buildItemActions(itemStatus, idx) {
    const s = (itemStatus||'pending').toLowerCase();
    // Only deliverable statuses get the action button
    if (s==='confirmed' || s==='out for delivery') {
        return `
<div class="sod-item-actions">
    <button class="sod-action-btn sod-action-deliver" onclick="eodDeliverItem(${idx})">
        <i class="fa-solid fa-circle-check"></i> Mark Delivered
    </button>
</div>`;
    }
    return ''; // pending/delivered/rejected/cancelled — no action for employee
}

function buildDocCard(d, idx) {
    const cfg    = d.config || {};
    const status = d.status || 'pending';
    const iSt    = getStatus(status);
    const us     = (d.uploadStatus||'pending').toLowerCase();

    let uClass='so-badge-upload-pending', uLabel='Pending';
    if (us==='uploaded')                         { uClass='so-badge-upload-uploaded'; uLabel='✓ Uploaded'; }
    else if (us==='whatsapp')                    { uClass='so-badge-upload-whatsapp'; uLabel='⚡ WhatsApp'; }
    else if (us==='later'||us==='pending_later') { uClass='so-badge-upload-later';    uLabel='⚠ Upload Pending'; }

    const paperName = resolveId(xeroxMeta.paper,      cfg.paperId);
    const bindName  = resolveId(xeroxMeta.binding,    cfg.bindingId);
    const lamName   = resolveId(xeroxMeta.lamination, cfg.laminationId);

    const configRows = [
        ['Paper',     paperName || 'Standard'],
        ['Color',     COLOR_LABELS[cfg.color]  || cfg.color  || 'B&W'],
        colorPagesRow(cfg),
        ['Format',    FORMAT_LABELS[cfg.format] || cfg.format || 'Front Only'],
        cfg.ratio && cfg.ratio!=='1:1' ? ['Ratio', cfg.ratio] : null,
        ['Pages',     String(d.pages||0)],
        ['Copies',    `×${cfg.quantity||1}`],
        bindName ? ['Binding',    bindName] : null,
        bindingSetRow(cfg),
        lamName  ? ['Lamination', lamName]  : null,
    ].filter(Boolean).map(([k,v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');

    const rejectNote = d.rejectionMessage
        ? `<div class="sod-rejection-note"><i class="fa-solid fa-ban"></i> ${esc(d.rejectionMessage)}</div>` : '';

    return `
<div class="sod-item-card" id="eodItem-${idx}">
    <div class="sod-item-head">
        <div style="display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;">
            <i class="fa-regular fa-file-pdf sod-item-doc-icon"></i>
            <div class="sod-item-meta-wrap">
                <div class="sod-item-name">${esc(d.name||'Document')}</div>
                <div class="sod-item-price-sub">
                    ${d.pages||0} pages · <strong>₹${(d.price||0).toFixed(2)}</strong>
                    <span class="so-badge ${uClass}" style="margin-left:5px;">${uLabel}</span>
                </div>
            </div>
        </div>
        <span class="sod-item-status-badge" style="background:${iSt.bg};color:${iSt.color};flex-shrink:0;">
            <i class="${iSt.icon}"></i> ${iSt.label}
        </span>
    </div>
    ${rejectNote}
    <div class="sod-config-block">
        <div class="sod-config-title"><i class="fa-solid fa-file-invoice"></i> Print Configuration</div>
        <table class="sod-config-table">${configRows}</table>
    </div>
    ${cfg.instructions ? `<div class="sod-instructions"><i class="fa-solid fa-note-sticky"></i><span><strong>Instructions:</strong> ${esc(cfg.instructions)}</span></div>` : ''}
    ${buildItemActions(status, idx)}
</div>`;
}

function buildProductCard(item, idx) {
    const iSt       = getStatus(item.status||'pending');
    const qty       = item.qty || 1;
    const lineTotal = (item.price||0) * qty;
    const img       = item.img || item.images?.[0]?.url || '';

    const rejectNote = item.rejectionMessage
        ? `<div class="sod-rejection-note"><i class="fa-solid fa-ban"></i> ${esc(item.rejectionMessage)}</div>` : '';

    return `
<div class="sod-item-card" id="eodItem-${idx}">
    <div class="sod-item-head">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
            <div class="sod-item-product-img">
                ${img ? `<img src="${esc(img)}" alt="${esc(item.name||'')}" loading="lazy">` : '<i class="fa-solid fa-box"></i>'}
            </div>
            <div class="sod-item-meta-wrap">
                <div class="sod-item-name">${esc(item.name||'Product')}</div>
                <div class="sod-item-price-sub">
                    ₹${(item.price||0).toFixed(2)} × ${qty} = <strong>₹${lineTotal.toFixed(2)}</strong>
                </div>
            </div>
        </div>
        <span class="sod-item-status-badge" style="background:${iSt.bg};color:${iSt.color};flex-shrink:0;">
            <i class="${iSt.icon}"></i> ${iSt.label}
        </span>
    </div>
    ${rejectNote}
    ${buildItemActions(item.status||'pending', idx)}
</div>`;
}

/* ════════════════════════════════
   DELIVERY ACTIONS
   ════════════════════════════════ */
window.eodDeliverItem = async function(idx) {
    await updateItemStatus(idx, 'delivered');
};

/* Mark ALL confirmed/OFD items as delivered at once */
window.eodMarkAllDelivered = async function() {
    if (!currentOrder) return;
    if (!confirm('Mark all confirmed items as delivered?')) return;

    const isXerox = currentOrder.type === 'xerox';
    const field   = isXerox ? 'documents' : 'items';
    const items   = [...(currentOrder[field]||[])];

    let count = 0;
    items.forEach((item,i) => {
        const s = (item.status||'pending').toLowerCase();
        if (s==='confirmed' || s==='out for delivery') {
            items[i] = { ...item, status:'delivered' };
            count++;
        }
    });

    if (!count) { toast('No confirmed items to deliver.',''); return; }

    // Disable all delivery buttons
    document.querySelectorAll('.sod-action-btn').forEach(b=>{ b.disabled=true; });

    try {
        const payload = { [field]: items };
        const allDone = items.every(i => ['delivered','rejected','cancelled'].includes((i.status||'pending').toLowerCase()));
        if (allDone) payload.status = 'Delivered';

        await updateDoc(doc(db,'orders',currentOrder.id), payload);
        currentOrder[field] = items;

        if (allDone) {
            await setDoc(doc(db,'order_status',currentOrder.id), {
                status: 'Delivered', updatedAt: serverTimestamp(), lastUpdatedBy: 'employee'
            }, { merge:true });
            currentOrder.status = 'Delivered';
        }

        toast(`${count} item(s) marked as delivered!`, 'success');
        render();
    } catch(err) {
        console.error('[EmpOrderDetails] markAll:',err);
        toast('Update failed: ' + err.message, 'error');
        document.querySelectorAll('.sod-action-btn').forEach(b=>{ b.disabled=false; });
    }
};

/* ── Core single-item update ── */
async function updateItemStatus(idx, newStatus) {
    if (!currentOrder) return;
    const isXerox = currentOrder.type === 'xerox';
    const field   = isXerox ? 'documents' : 'items';
    const items   = [...(currentOrder[field]||[])];

    items[idx] = { ...items[idx], status: newStatus };

    document.querySelectorAll('.sod-action-btn').forEach(b=>{ b.disabled=true; });

    try {
        const payload = { [field]: items };

        // Check if all items are now terminal
        const allDone = items.every(i =>
            ['delivered','rejected','cancelled'].includes((i.status||'pending').toLowerCase())
        );
        if (allDone) payload.status = 'Delivered';

        await updateDoc(doc(db,'orders',currentOrder.id), payload);
        currentOrder[field] = items;

        if (allDone) {
            await setDoc(doc(db,'order_status',currentOrder.id), {
                status: 'Delivered', updatedAt: serverTimestamp(), lastUpdatedBy: 'employee'
            }, { merge:true });
            currentOrder.status = 'Delivered';
        }

        toast('Item marked as delivered!', 'success');
        render();
    } catch(err) {
        console.error('[EmpOrderDetails] update:',err);
        toast('Update failed: ' + err.message, 'error');
        document.querySelectorAll('.sod-action-btn').forEach(b=>{ b.disabled=false; });
    }
}

/* ════════════════════════════════
   SKELETON / ERROR
   ════════════════════════════════ */
function hideSkeleton() {
    document.getElementById('eodSkeleton').style.display = 'none';
    document.getElementById('eodContent').style.display  = 'block';
}
function showError() {
    document.getElementById('eodSkeleton').style.display = 'none';
    document.getElementById('eodError').style.display    = 'block';
}
