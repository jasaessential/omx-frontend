/* ═══════════════════════════════════════════════
   SELLER ORDERS — seller-orders.js
   Shows all orders for the seller's shop.
   URL param: ?shopId=xxx
   Auth: seller | admin  (checks userShops or shop.owners[])
   Real-time: orders + order_status listeners
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import {
    collection, query, where, orderBy,
    getDocs, getDoc, doc, onSnapshot, updateDoc, setDoc,
    increment, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { WORKER_URL } from './env-config.js';

/* ── URL params ── */
const currentShopId = new URLSearchParams(window.location.search).get('shopId');

/* ── State ── */
let allOrders      = [];
let currentFilter  = 'pending';
let currentShopData = null;
let userProfileMap = new Map(); // uid → { name, displayId }
let xeroxMeta      = { paper: [], binding: [], lamination: [] };

/* ── STATUS MAP ── */
const STATUS_MAP = {
    pending:            { label:'Pending',         color:'#f59e0b', bg:'#fef3c7', icon:'fa-solid fa-hourglass-half' },
    confirmed:          { label:'Confirmed',        color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check'  },
    accepted:           { label:'Confirmed',        color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check'  },
    processing:         { label:'Processing',       color:'#06b6d4', bg:'#cffafe', icon:'fa-solid fa-gears'          },
    'out for delivery': { label:'Out for Delivery', color:'#10b981', bg:'#d1fae5', icon:'fa-solid fa-truck-fast'     },
    delivered:          { label:'Delivered',        color:'#16a34a', bg:'#dcfce7', icon:'fa-solid fa-circle-check'   },
    cancelled:          { label:'Cancelled',        color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-circle-xmark'   },
    rejected:           { label:'Rejected',         color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-triangle-exclamation' },
};
function getStatus(raw) {
    return STATUS_MAP[(raw||'pending').toLowerCase().trim()]
        || { label:raw||'Pending', color:'#6b7280', bg:'#f3f4f6', icon:'fa-solid fa-circle-dot' };
}

/* ── Helpers ── */
function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(raw) {
    if (!raw) return '—';
    try {
        const d = raw.toDate ? raw.toDate() : new Date((raw.seconds||0)*1000);
        return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});
    } catch(_){ return '—'; }
}

/* ── Toast ── */
function toast(msg, type='') {
    const el = document.getElementById('soToast');
    el.textContent = msg; el.className = 'so-toast ' + type;
    void el.offsetWidth; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── Auth + Access Guard ── */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search)); return; }
    if (!currentShopId) { toast('No Shop ID provided.','error'); return; }

    try {
        const snap = await getDoc(doc(db,'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const userData = snap.data();
        const roles    = userData.roles || [userData.role || 'user'];
        const userShops = userData.userShops || [];
        const isAdmin   = roles.includes('admin');
        const isSeller  = roles.includes('seller');

        // 1. Admin always has access
        // 2. userShops array contains this shopId
        let hasAccess = isAdmin || userShops.some(s => s.shopId === currentShopId);

        // 3. Fallback: check shop.owners[] / shop.employees[]
        if (!hasAccess && (isSeller || roles.includes('employee'))) {
            try {
                const shopSnap = await getDoc(doc(db,'shops', currentShopId));
                if (shopSnap.exists()) {
                    const sd = shopSnap.data();
                    if ((sd.owners||[]).includes(user.uid) || (sd.employees||[]).includes(user.uid)) {
                        hasAccess = true;
                    }
                }
            } catch(e) { console.warn('Shop fallback check failed:',e); }
        }

        if (!hasAccess) {
            toast('You do not have access to this shop.','error');
            setTimeout(() => window.location.replace('index.html'), 1400);
            return;
        }

        await initShopInfo(userData.userShops || []);
        await loadXeroxMeta();
        restoreFilter();
        listenToOrders();
    } catch(err) {
        console.error('[SellerOrders] auth error:',err);
        window.location.replace('index.html');
    }
});

/* ── Restore saved filter ── */
function restoreFilter() {
    const saved = sessionStorage.getItem(`so_filter_${currentShopId}`);
    if (saved) {
        currentFilter = saved;
        document.querySelectorAll('.so-filter-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.filter === currentFilter);
        });
    }
}

/* ── Init shop name in header ── */
async function initShopInfo(userShops) {
    const cached = userShops.find(s => s.shopId === currentShopId);
    if (cached?.name) {
        document.getElementById('soShopName').textContent = cached.name;
        return;
    }
    try {
        const shopSnap = await getDoc(doc(db,'shops', currentShopId));
        if (shopSnap.exists()) {
            currentShopData = { id: shopSnap.id, ...shopSnap.data() };
            document.getElementById('soShopName').textContent = currentShopData.name || 'Shop Orders';
        }
    } catch(e) { console.warn('Shop info fetch failed:',e); }
}

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
    } catch(e){ console.warn('xerox meta failed:',e); }
}
function resolveId(list,id){ if(!id||id==='none')return null; return list.find(x=>x.id===id)?.name||null; }

/* ── Real-time listeners ── */
async function listenToOrders() {
    showSkeleton();

    // Initial fetch
    try {
        const qInit = query(collection(db,'orders'), where('shopId','==',currentShopId), orderBy('createdAt','desc'));
        const snap  = await getDocs(qInit);
        allOrders   = snap.docs.map(d=>({id:d.id,...d.data()}));
        await fetchUserProfiles(allOrders);
        renderOrders();
    } catch(e){ console.error('[SellerOrders] initial fetch:',e); }

    // Live orders (new + edits)
    const qOrders = query(collection(db,'orders'), where('shopId','==',currentShopId));
    onSnapshot(qOrders, snap => {
        let changed = false;
        snap.docChanges().forEach(ch => {
            const data = { id:ch.doc.id, ...ch.doc.data() };
            const idx  = allOrders.findIndex(o=>o.id===ch.doc.id);
            if (ch.type==='modified' && idx!==-1) { allOrders[idx]={...allOrders[idx],...data}; changed=true; }
            else if (ch.type==='added' && idx===-1) { allOrders.push(data); fetchUserProfiles([data]); changed=true; }
            else if (ch.type==='removed' && idx!==-1) { allOrders.splice(idx,1); changed=true; }
        });
        if (changed) { sortOrders(); renderOrders(); }
    }, err => console.warn('[SellerOrders] orders snap:',err));

    // Live status updates
    const qStatus = query(collection(db,'order_status'), where('shopId','==',currentShopId));
    onSnapshot(qStatus, snap => {
        let changed = false;
        snap.docChanges().forEach(ch => {
            const { status } = ch.doc.data();
            const idx = allOrders.findIndex(o=>o.id===ch.doc.id);
            if (idx!==-1 && allOrders[idx].status !== status) { allOrders[idx].status=status; changed=true; }
        });
        if (changed) renderOrders();
    }, err => console.warn('[SellerOrders] status snap:',err));
}

function sortOrders() {
    allOrders.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
}

async function fetchUserProfiles(orders) {
    const uids = [...new Set(orders.map(o=>o.userId).filter(id=>id))];
    const missing = uids.filter(uid=>!userProfileMap.has(uid));
    await Promise.all(missing.map(async uid => {
        try {
            const snap = await getDoc(doc(db,'users',uid));
            if (snap.exists()) {
                const d = snap.data();
                userProfileMap.set(uid,{ name: d.fullName||d.name||'Customer', displayId: d.userId||'N/A' });
            } else { userProfileMap.set(uid,{name:'Customer',displayId:'N/A'}); }
        } catch(e){ console.warn('profile fetch failed',uid,e); }
    }));
}

/* ── Filter logic ── */
function checkFilter(order, filter) {
    const isXerox = order.type === 'xerox';
    const items   = isXerox ? (order.documents || []) : (order.items || []);

    const checkOne = s => {
        const v = (s || 'pending').toLowerCase();
        if (filter === 'pending')    return v === 'pending';
        if (filter === 'processing') return ['confirmed', 'accepted', 'processing'].includes(v);
        if (filter === 'completed')  return ['delivered', 'rejected', 'cancelled', 'out for delivery'].includes(v);
        return true;
    };

    // Always use item-level status only — never fall back to order.status for filtering.
    // An item with no status field is always 'pending'.
    if (!items.length) return checkOne(order.status || 'pending');
    return items.some(item => checkOne(item.status || 'pending'));
}

window.setFilter = function(f, btn) {
    currentFilter = f;
    document.querySelectorAll('.so-filter-tab').forEach(b=>b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    sessionStorage.setItem(`so_filter_${currentShopId}`, f);
    renderOrders();
};

/* ── Update counts ── */
function updateCounts() {
    document.getElementById('cntPending').textContent    = allOrders.filter(o=>checkFilter(o,'pending')).length;
    document.getElementById('cntProcessing').textContent = allOrders.filter(o=>checkFilter(o,'processing')).length;
    document.getElementById('cntCompleted').textContent  = allOrders.filter(o=>checkFilter(o,'completed')).length;
}

/* ── Render ── */
function renderOrders() {
    updateCounts();
    hideSkeleton();
    const filtered = allOrders.filter(o=>checkFilter(o,currentFilter));
    const listEl   = document.getElementById('soList');
    const emptyEl  = document.getElementById('soEmpty');
    if (!filtered.length) { listEl.innerHTML=''; emptyEl.style.display='block'; return; }
    emptyEl.style.display='none';
    listEl.innerHTML = filtered.map(buildOrderCard).join('');
}

/* ── Build order card ── */
function buildOrderCard(order) {
    const isXerox = order.type==='xerox';
    const items   = isXerox ? (order.documents||[]) : (order.items||[]);
    const profile = userProfileMap.get(order.userId) || { name: order.userName||'Customer', displayId:'N/A' };
    const mobile  = order.contacts?.mobile || '';
    const altMob  = order.contacts?.altMobile || '';
    const ordId   = order.groupOrderId || order.id.slice(0,8).toUpperCase();
    const st      = getStatus(order.status);
    const dateStr = fmtDate(order.createdAt);

    // Subtotal calculation (from active items only)
    let subtotal = 0;
    items.forEach(item => {
        const s = (item.status||'pending').toLowerCase();
        if (!['cancelled','rejected'].includes(s)) {
            subtotal += isXerox ? (item.price||0) : ((item.price||0)*(item.qty||1));
        }
    });

    const isPickup = order.fulfillmentType === 'pickup' || order.deliveryMode === 'pickup' || order.isPickup === true || order.orderType === 'pickup' || (order.deliveryFee === 0 && !order.deliveryAddress);
    const pMethod  = (order.paymentMethod || 'cod').toLowerCase();
    const pStatus  = (order.paymentStatus || 'pending').toLowerCase();
    const isPartial = pMethod === 'partial' || pStatus === 'partial_paid' || (order.balanceDue > 0 && order.amountPaid > 0);
    const isPaid    = pStatus === 'paid' || pMethod === 'paid' || (pMethod === 'razorpay' && pStatus !== 'pending' && !isPartial);

    const fulChip = isPickup
        ? `<span class="ord-ful-chip ord-ful-chip--pickup"><i class="fa-solid fa-store"></i> Pick Myself</span>`
        : `<span class="ord-ful-chip ord-ful-chip--delivery"><i class="fa-solid fa-truck-fast"></i> Delivery</span>`;

    let payChip = `<span class="ord-pay-chip ord-pay-chip--cod"><i class="fa-solid fa-money-bill-wave"></i> COD</span>`;
    if (isPartial) {
        payChip = `<span class="ord-pay-chip ord-pay-chip--partial"><i class="fa-solid fa-percent"></i> Partial Paid</span>`;
    } else if (isPaid) {
        payChip = `<span class="ord-pay-chip ord-pay-chip--paid"><i class="fa-solid fa-circle-check"></i> Paid</span>`;
    }

    // Delivery fee from shop data if available
    let deliveryFee = 0;
    if (isPickup) {
        deliveryFee = 0;
    } else if (currentShopData) {
        const rules = isXerox
            ? (currentShopData.deliveryPrices?.xerox||[])
            : (currentShopData.deliveryPrices?.others||[]);
        const rule = rules.find(r=>subtotal>=r.min&&(r.max==null||subtotal<=r.max));
        if (rule) deliveryFee = rule.fee||0;
    }
    const couponDiscount = Math.min(Number(order.discountAmount) || 0, subtotal);
    const walletUsed = Math.min(Number(order.walletAmount) || 0, Math.max(0, subtotal - couponDiscount + deliveryFee));
    const total = subtotal - couponDiscount - walletUsed + deliveryFee;

    // WhatsApp message
    let waMsg = `*ORDER UPDATE*\nHello ${profile.name}!\nOrder ID: #${ordId}\n\nItems:\n`;
    items.forEach((it,i)=>{ const qty=it.qty||it.config?.quantity||1; waMsg+=`${i+1}. ${it.name||'Item'} x${qty} - ₹${(isXerox?it.price:(it.price||0)*qty).toFixed(2)}\n`; });
    waMsg += `\nTotal: ₹${total.toFixed(2)}\nPayment: ${order.paymentMethod||'COD'}`;
    const waUrl = mobile ? `https://wa.me/91${mobile.replace(/\D/g,'').slice(-10)}?text=${encodeURIComponent(waMsg)}` : '';

    // Items HTML (preview 3, rest collapsed)
    const buildItemRow = item => {
        const us = item.uploadStatus||'pending';
        const uClass = us==='uploaded'?'so-badge-upload-uploaded':us==='whatsapp'?'so-badge-upload-whatsapp':'so-badge-upload-pending';
        const uLabel = us==='uploaded'?'✓ Uploaded':us==='whatsapp'?'⚡ WhatsApp':us==='later'?'⚠ Upload Later':'Pending';
        const iSt = getStatus(item.status || 'pending');
        const qty = item.qty||item.config?.quantity||1;
        const lineTotal = isXerox ? (item.price||0) : ((item.price||0)*qty);
        return `<div class="so-item-row">
            <div class="so-item-name-line">
                <span class="so-item-name" title="${esc(item.name||'Item')}">${esc(item.name||'Item')}</span>
                <span class="so-item-price">₹${lineTotal.toFixed(2)}</span>
            </div>
            <div class="so-item-meta">
                <span>₹${(isXerox?(item.price||0)/qty:(item.price||0)).toFixed(2)} × ${qty}</span>
                ${isXerox?`<span class="so-badge ${uClass}">${uLabel}</span>`:''}
                <span class="so-badge" style="background:${iSt.bg};color:${iSt.color};">${iSt.label}</span>
            </div>
        </div>`;
    };

    const preview = items.slice(0,3).map(buildItemRow).join('');
    const extra   = items.slice(3);
    const uid     = order.id;
    const moreHtml = extra.length ? `
        <div id="soExtra-${uid}" style="display:none;">${extra.map(buildItemRow).join('')}</div>
        <button class="so-show-more" onclick="soToggleExtra('${uid}',this)">
            <i class="fa-solid fa-chevron-down" id="sochev-${uid}"></i> +${extra.length} more item${extra.length>1?'s':''}
        </button>` : '';

    const addr = order.deliveryAddress;

    return `
<div class="so-card">
    <div class="so-card-head">
        <div style="display:flex;align-items:flex-start;gap:8px;min-width:0;">
            ${waUrl?`<a href="${esc(waUrl)}" target="_blank" class="so-wa-btn" title="Send WhatsApp update"><i class="fa-brands fa-whatsapp"></i></a>`:''}
            <div>
                <div class="so-card-id">ORDER <span>#${esc(ordId)}</span></div>
                <div class="so-card-date"><i class="fa-regular fa-calendar"></i> ${dateStr}</div>
                <div style="display:flex;gap:4px;align-items:center;margin-top:4px;flex-wrap:wrap;">
                    ${fulChip}
                    ${payChip}
                </div>
            </div>
        </div>
        <span class="so-badge" style="background:${st.bg};color:${st.color};flex-shrink:0;">
            <i class="${st.icon}"></i> ${st.label}
        </span>
    </div>
    <div class="so-card-user">
        <div>
            <div class="so-card-user-name">${esc(profile.name)}</div>
            <div style="font-size:.62rem;font-weight:600;color:var(--txt3);">ID: ${esc(profile.displayId)}</div>
        </div>
        ${mobile?`<a href="tel:${esc(mobile)}" class="so-card-phone"><i class="fa-solid fa-phone"></i>${esc(mobile)}</a>`:''}
        ${altMob?`<a href="tel:${esc(altMob)}" class="so-card-phone" style="margin-left:6px;"><i class="fa-solid fa-phone-volume"></i>${esc(altMob)}</a>`:''}
    </div>
    <div class="so-card-items">
        <div class="so-items-label">Items in Order (${items.length})</div>
        ${preview}${moreHtml}
    </div>
    <div class="so-card-foot">
        <div class="so-pricing-row"><span>Subtotal</span><span>₹${subtotal.toFixed(2)}</span></div>
        ${couponDiscount > 0 ? `<div class="so-pricing-row">
            <span>Coupon${order.couponCode ? ` (${esc(order.couponCode)})` : ''}</span>
            <span style="color:#16a34a;font-weight:800;">-₹${couponDiscount.toFixed(2)}</span>
        </div>` : ''}
        ${walletUsed > 0 ? `<div class="so-pricing-row">
            <span>Wallet</span>
            <span style="color:#16a34a;font-weight:800;">-₹${walletUsed.toFixed(2)}</span>
        </div>` : ''}
        <div class="so-pricing-row">
            <span>Delivery</span>
            <span ${deliveryFee===0?'style="color:#16a34a;font-weight:800;"':''}>${isPickup?'FREE (Pickup)':(deliveryFee===0?'FREE':'₹'+deliveryFee.toFixed(2))}</span>
        </div>
        <div class="so-pricing-row total"><span>Total</span><span>₹${total.toFixed(2)}</span></div>
        ${isPickup
            ? `<div class="so-addr-line" style="color:#15803d;"><i class="fa-solid fa-store"></i> Self Pickup Order</div>`
            : (addr?`<div class="so-addr-line"><i class="fa-solid fa-location-dot" style="color:#ef4444;"></i>${esc((addr.label?addr.label+' — ':'')+addr.street+', '+addr.city)}</div>`:'')
        }
        <a href="seller-order-details.html?orderId=${esc(order.id)}&shopId=${esc(currentShopId)}" class="so-details-btn">
            View Details &amp; Process <i class="fa-solid fa-arrow-right"></i>
        </a>
    </div>
</div>`;
}

window.soToggleExtra = function(uid, btn) {
    const box  = document.getElementById(`soExtra-${uid}`);
    const chev = document.getElementById(`sochev-${uid}`);
    if (!box) return;
    const open = box.style.display !== 'none';
    box.style.display = open ? 'none' : 'block';
    if (chev) chev.className = `fa-solid ${open?'fa-chevron-down':'fa-chevron-up'}`;
    if (btn)  btn.innerHTML  = `<i class="fa-solid ${open?'fa-chevron-down':'fa-chevron-up'}"></i> ${open?`+${box.querySelectorAll('.so-item-row').length} more items`:'Show less'}`;
};

function showSkeleton() { document.getElementById('soSkeleton').style.display='block'; }
function hideSkeleton()  { document.getElementById('soSkeleton').style.display='none'; }
