/* ═══════════════════════════════════════════════
   EMPLOYEE ORDERS — employee-orders.js
   Delivery person view: shows confirmed/OFD orders
   across all shops the employee is assigned to.
   Auth: employee role (checks shops.employees[])
   Mirrors: WEBSITE delivery-orders.js logic
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import {
    collection, query, where, getDocs, getDoc,
    doc, onSnapshot, updateDoc, setDoc,
    runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { WORKER_URL } from './env-config.js';

/* ── State ── */
let allOrders       = [];
let userProfileMap  = new Map();
let activeShopIds   = [];
let activeShopsCache = [];
let xeroxMeta       = { paper: [] };
let currentFilter   = 'active'; // 'active' | 'past'

/* ── DOM ── */
const listEl    = document.getElementById('eoList');
const emptyEl   = document.getElementById('eoEmpty');
const noShopEl  = document.getElementById('eoNoShop');
const skelEl    = document.getElementById('eoSkeleton');

/* ── Status map ── */
const STATUS_MAP = {
    pending:            { label:'Pending',         color:'#f59e0b', bg:'#fef3c7', icon:'fa-solid fa-hourglass-half' },
    confirmed:          { label:'Confirmed',        color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check'  },
    'out for delivery': { label:'Out for Delivery', color:'#10b981', bg:'#d1fae5', icon:'fa-solid fa-truck-fast'    },
    delivered:          { label:'Delivered',        color:'#16a34a', bg:'#dcfce7', icon:'fa-solid fa-circle-check'  },
    rejected:           { label:'Rejected',         color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-triangle-exclamation' },
    cancelled:          { label:'Cancelled',        color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-circle-xmark'  },
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
function fmtDate(raw) {
    if (!raw) return '—';
    try {
        const d = raw.toDate ? raw.toDate() : new Date((raw.seconds||0)*1000);
        return d.toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});
    } catch(_){ return '—'; }
}

/* ── Toast ── */
function toast(msg, type='') {
    const el = document.getElementById('soToast');
    el.textContent = msg; el.className = 'so-toast ' + type;
    void el.offsetWidth; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3200);
}

/* ════════════════════════════════
   AUTH + SHOP ASSIGNMENT CHECK
   ════════════════════════════════ */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search)); return; }

    try {
        const snap = await getDoc(doc(db,'users',user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];

        // Must be employee OR admin
        if (!roles.includes('employee') && !roles.includes('admin')) {
            toast('Employee access required.','error');
            setTimeout(() => window.location.replace('index.html'), 1400);
            return;
        }

        // Discover assigned shops from shops.employees[] (and owners[] for admin)
        const shopsRef = collection(db,'shops');
        const [snapEmp, snapOwner] = await Promise.all([
            getDocs(query(shopsRef, where('employees','array-contains',user.uid))),
            getDocs(query(shopsRef, where('owners','array-contains',user.uid))),
        ]);

        const shopMap = new Map();
        snapOwner.forEach(d => shopMap.set(d.id, { shopId:d.id, name:d.data().name, numbers:d.data().mobileNumbers||[] }));
        snapEmp.forEach(d   => shopMap.set(d.id, { shopId:d.id, name:d.data().name, numbers:d.data().mobileNumbers||[] }));

        // Admin also gets all shops
        if (roles.includes('admin') && shopMap.size === 0) {
            const allShops = await getDocs(collection(db,'shops'));
            allShops.forEach(d => shopMap.set(d.id, { shopId:d.id, name:d.data().name, numbers:d.data().mobileNumbers||[] }));
        }

        const userShops = Array.from(shopMap.values());
        if (userShops.length === 0) {
            skelEl.style.display = 'none';
            noShopEl.style.display = 'block';
            return;
        }

        activeShopsCache = userShops;
        activeShopIds    = userShops.map(s => s.shopId).slice(0, 30);

        await loadXeroxMeta();
        await listenToOrders();
    } catch(err) {
        console.error('[EmployeeOrders] auth:', err);
        toast('Failed to load. Please refresh.','error');
    }
});

async function loadXeroxMeta() {
    /* 1. Worker edge cache */
    try {
        const res = await fetch(`${WORKER_URL}/api/config/xerox`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            const json = await res.json();
            const cfg  = json.config || json;
            if (cfg.paper?.length) { xeroxMeta.paper = cfg.paper; return; }
        }
    } catch (_) {}
    /* 2. Firestore fallback */
    try {
        const p = await getDocs(collection(db,'xerox_config_paper'));
        xeroxMeta.paper = p.docs.map(d=>({id:d.id,...d.data()}));
    } catch(e){ console.warn('meta:',e); }
}
function resolveId(list,id){
    if(!id||id==='none') return null;
    return list.find(x=>x.id===id)?.name||null;
}

/* ════════════════════════════════
   REAL-TIME LISTENERS
   ════════════════════════════════ */
async function listenToOrders() {
    showSkeleton();

    // Initial fetch
    try {
        // One query per shop: rules only let employees read their own shops' orders,
        // which Firestore can check for an equality filter
        const snaps = await Promise.all(activeShopIds.map(id =>
            getDocs(query(collection(db,'orders'), where('shopId','==',id)))));
        allOrders  = snaps.flatMap(snap => snap.docs.map(d=>({id:d.id,...d.data()})));
        await fetchUsersForOrders(allOrders);
        renderOrders();
    } catch(e){ console.error('[EmployeeOrders] initial fetch:',e); }

    // Live order data (item status changes)
    const onOrders = snap => {
        let changed = false;
        snap.docChanges().forEach(ch => {
            const data = { id:ch.doc.id, ...ch.doc.data() };
            const idx  = allOrders.findIndex(o=>o.id===ch.doc.id);
            if (ch.type==='modified' && idx!==-1) {
                allOrders[idx] = { ...allOrders[idx], ...data }; changed=true;
            } else if (ch.type==='added' && idx===-1) {
                allOrders.push(data); fetchUsersForOrders([data]); changed=true;
            } else if (ch.type==='removed' && idx!==-1) {
                allOrders.splice(idx,1); changed=true;
            }
        });
        if (changed) { sortOrders(); renderOrders(); }
    };
    activeShopIds.forEach(id => onSnapshot(query(collection(db,'orders'), where('shopId','==',id)),
        onOrders, err => console.warn('[EmployeeOrders] orders snap:',err)));

    // Live status changes
    const onStatus = snap => {
        let changed = false;
        snap.docChanges().forEach(ch => {
            const { status } = ch.doc.data();
            const idx = allOrders.findIndex(o=>o.id===ch.doc.id);
            if (idx!==-1 && allOrders[idx].status !== status) {
                allOrders[idx].status = status; changed=true;
            }
        });
        if (changed) renderOrders();
    };
    activeShopIds.forEach(id => onSnapshot(query(collection(db,'order_status'), where('shopId','==',id)),
        onStatus, err => console.warn('[EmployeeOrders] status snap:',err)));
}

function sortOrders() {
    allOrders.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
}

async function fetchUsersForOrders(orders) {
    const uids    = [...new Set(orders.map(o=>o.userId).filter(Boolean))];
    const missing = uids.filter(uid=>!userProfileMap.has(uid));
    await Promise.all(missing.map(async uid => {
        try {
            const s = await getDoc(doc(db,'users',uid));
            if (s.exists()) {
                const d = s.data();
                userProfileMap.set(uid,{ name:d.fullName||d.name||'Customer', phone:d.mobileNumber||d.phone||'' });
            } else { userProfileMap.set(uid,{name:'Customer',phone:''}); }
        } catch(e){ console.warn('user fetch',uid,e); }
    }));
}

/* ════════════════════════════════
   FILTER LOGIC
   active = confirmed / out for delivery
   past   = delivered
   ════════════════════════════════ */
function itemMatchesFilter(itemStatus, orderStatus, filter) {
    const s = (itemStatus || orderStatus || 'pending').toLowerCase();
    if (filter === 'active') return s === 'confirmed' || s === 'out for delivery';
    if (filter === 'past')   return s === 'delivered';
    return false;
}

function orderMatchesFilter(order, filter) {
    const isXerox = order.type === 'xerox';
    const items   = isXerox ? (order.documents||[]) : (order.items||[]);
    if (!items.length) return itemMatchesFilter(null, order.status, filter);
    return items.some(i => itemMatchesFilter(i.status, order.status, filter));
}

window.setFilter = function(f, btn) {
    currentFilter = f;
    document.querySelectorAll('.so-filter-tab').forEach(b=>b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderOrders();
};

/* ── Count pills ── */
function updateCounts() {
    let active=0, past=0;
    allOrders.forEach(o => {
        if (orderMatchesFilter(o,'active')) active++;
        if (orderMatchesFilter(o,'past'))   past++;
    });
    document.getElementById('cntActive').textContent = active;
    document.getElementById('cntPast').textContent   = past;
}

/* ════════════════════════════════
   RENDER
   ════════════════════════════════ */
function renderOrders() {
    hideSkeleton();
    updateCounts();

    const filtered = allOrders
        .filter(o => orderMatchesFilter(o, currentFilter))
        .sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0));

    if (!filtered.length) {
        listEl.innerHTML = '';
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = filtered.map(buildOrderCard).join('');
}

/* ── Subtotal helper (only non-cancelled / non-rejected items) ── */
function calcSubtotal(order) {
    const isXerox = order.type === 'xerox';
    const items   = isXerox ? (order.documents||[]) : (order.items||[]);
    let sub = 0;
    items.forEach(item => {
        const s = (item.status||'pending').toLowerCase();
        if (s!=='cancelled' && s!=='rejected') {
            sub += isXerox ? (item.price||0) : ((item.price||0)*(item.qty||1));
        }
    });
    return sub;
}

/* ── Delivery fee lookup from shop config ── */
function calcDeliveryFee(order, subtotal) {
    const shop = activeShopsCache.find(s => s.shopId === order.shopId);
    if (!shop) return 0;
    const rules = order.type==='xerox'
        ? (shop.deliveryPrices?.xerox  || [])
        : (shop.deliveryPrices?.others || []);
    const rule = rules.find(r => subtotal >= r.min && (r.max==null || subtotal<=r.max));
    return rule?.fee || 0;
}

/* ════════════════════════════════
   BUILD ORDER CARD
   ════════════════════════════════ */
function buildOrderCard(order) {
    const isXerox   = order.type === 'xerox';
    const items     = isXerox ? (order.documents||[]) : (order.items||[]);
    const isPast    = currentFilter === 'past';
    const dateStr   = fmtDate(order.createdAt);
    const ordId     = order.groupOrderId || order.id.slice(0,8).toUpperCase();
    const profile   = userProfileMap.get(order.userId) || { name: order.userName||'Customer', phone:'' };
    const mobile    = order.contacts?.mobile || profile.phone || '';
    const altMobile = order.contacts?.altMobile || '';
    const shop      = activeShopsCache.find(s => s.shopId === order.shopId);
    const shopName  = shop?.name || order.shopName || '—';

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

    const subtotal    = calcSubtotal(order);
    const deliveryFee = isPickup ? 0 : calcDeliveryFee(order, subtotal);
    const couponDiscount = Math.min(Number(order.discountAmount) || 0, subtotal);
    const total       = subtotal - couponDiscount + deliveryFee;

    // Only show items relevant to the current filter
    const relevantItems = items.filter(i => itemMatchesFilter(i.status, order.status, currentFilter));
    if (!relevantItems.length && items.length > 0) return ''; // nothing to show

    // WA message
    let waMsg  = `*${isPast ? 'ORDER DELIVERED' : 'OUT FOR DELIVERY'}*\n`;
    waMsg += `Hello ${profile.name}!\nOrder ID: #${ordId}\n\n`;
    waMsg += (isPast ? 'Delivered Items:\n' : 'Items being delivered:\n');
    relevantItems.forEach((item,i) => {
        const qty = item.qty || item.config?.quantity || 1;
        const amt = isXerox ? (item.price||0) : ((item.price||0)*qty);
        waMsg += `${i+1}. ${item.name||'Item'} x${qty} - ₹${amt.toFixed(2)}\n`;
    });
    waMsg += `\nTotal: ₹${total.toFixed(2)}`;
    if (!isPaid && !isPartial) waMsg += '\n*Please keep cash ready (COD)*';
    const waUrl = mobile
        ? `https://wa.me/91${mobile.replace(/\D/g,'').slice(-10)}?text=${encodeURIComponent(waMsg)}`
        : '';

    // Build item rows
    const buildItemRow = (item, globalIdx) => {
        const qty      = item.qty || item.config?.quantity || 1;
        const lineAmt  = isXerox ? (item.price||0) : ((item.price||0)*qty);
        const iSt      = getStatus(item.status || order.status);
        const configChips = isXerox && item.config
            ? `<div style="margin-top:3px;display:flex;gap:4px;flex-wrap:wrap;">
                   <span style="font-size:.58rem;font-weight:700;background:var(--bg);border:1px solid var(--border);padding:2px 6px;border-radius:4px;">${item.pages||'?'} pgs</span>
                   <span style="font-size:.58rem;font-weight:700;background:var(--bg);border:1px solid var(--border);padding:2px 6px;border-radius:4px;">${item.config.color==='bw'?'B&W':'Color'}</span>
                   ${resolveId(xeroxMeta.paper, item.config.paperId)
                       ? `<span style="font-size:.58rem;font-weight:700;background:var(--bg);border:1px solid var(--border);padding:2px 6px;border-radius:4px;">${esc(resolveId(xeroxMeta.paper, item.config.paperId))}</span>`
                       : ''}
               </div>` : '';
        return `<div class="so-item-row">
            <div class="so-item-name-line">
                <span class="so-item-name" title="${esc(item.name||'Item')}">${esc(item.name||'Item')}</span>
                <span class="so-item-price">₹${lineAmt.toFixed(2)}</span>
            </div>
            <div class="so-item-meta">
                <span style="font-size:.63rem;font-weight:600;color:var(--txt3);">×${qty}</span>
                <span class="so-badge" style="background:${iSt.bg};color:${iSt.color};font-size:.58rem;">
                    <i class="${iSt.icon}"></i> ${iSt.label}
                </span>
                ${!isPast ? `<input type="checkbox"
                    class="eo-item-check eo-item-check-${esc(order.id)}"
                    value="${globalIdx}"
                    data-name="${esc(item.name||'Item')}"
                    onchange="eoUpdateSelection('${esc(order.id)}')"
                    style="width:18px;height:18px;cursor:pointer;accent-color:var(--primary);margin-left:auto;">` : ''}
            </div>
            ${configChips}
        </div>`;
    };

    const preview    = relevantItems.slice(0,3);
    const extra      = relevantItems.slice(3);
    const uid        = order.id;
    const previewHtml = preview.map(item => buildItemRow(item, items.indexOf(item))).join('');
    const extraHtml   = extra.map(item   => buildItemRow(item, items.indexOf(item))).join('');
    const moreHtml    = extra.length
        ? `<div id="eoExtra-${uid}" style="display:none;">${extraHtml}</div>
           <button class="so-show-more" onclick="eoToggleExtra('${uid}',this)">
               <i class="fa-solid fa-chevron-down" id="eochev-${uid}"></i>
               +${extra.length} more item${extra.length>1?'s':''}
           </button>` : '';

    const addr = order.deliveryAddress;

    return `
<div class="so-card">
    <!-- Card head: order ID + date -->
    <div class="so-card-head">
        <div style="display:flex;align-items:flex-start;gap:8px;min-width:0;">
            ${!isPast && waUrl
                ? `<a href="${esc(waUrl)}" target="_blank" class="so-wa-btn" title="Send WhatsApp update"><i class="fa-brands fa-whatsapp"></i></a>`
                : ''}
            <div>
                <div class="so-card-id">ORDER <span>#${esc(ordId)}</span></div>
                <div class="so-card-date"><i class="fa-regular fa-calendar"></i> ${dateStr}</div>
                <div style="display:flex;gap:4px;align-items:center;margin-top:4px;flex-wrap:wrap;">
                    ${fulChip}
                    ${payChip}
                </div>
            </div>
        </div>
        <span class="so-badge" style="background:#d1fae5;color:#065f46;flex-shrink:0;">
            <i class="fa-solid fa-motorcycle"></i> ${isPast ? 'Delivered' : 'Delivery'}
        </span>
    </div>

    <!-- Customer info -->
    <div class="so-card-user">
        <div>
            <div class="so-card-user-name">${esc(profile.name)}</div>
            <div style="font-size:.62rem;color:var(--txt3);font-weight:600;margin-top:2px;">
                <i class="fa-solid fa-store" style="margin-right:4px;color:var(--primary);opacity:.7;"></i>${esc(shopName)}
            </div>
        </div>
        ${mobile
            ? `<a href="tel:${esc(mobile)}" class="so-card-phone"><i class="fa-solid fa-phone"></i>${esc(mobile)}</a>`
            : ''}
        ${altMobile
            ? `<a href="tel:${esc(altMobile)}" class="so-card-phone" style="margin-left:6px;"><i class="fa-solid fa-phone-volume"></i>${esc(altMobile)}</a>`
            : ''}
    </div>

    <!-- Items -->
    <div class="so-card-items">
        <div class="so-items-label">${isPast ? 'Delivered Items' : 'Items to Deliver'} (${relevantItems.length})</div>
        ${previewHtml}${moreHtml}
    </div>

    <!-- Footer: pricing + address + action -->
    <div class="so-card-foot">
        <div class="so-pricing-row">
            <span>Subtotal</span><span>₹${subtotal.toFixed(2)}</span>
        </div>
        ${couponDiscount > 0 ? `<div class="so-pricing-row">
            <span>Coupon${order.couponCode ? ` (${esc(order.couponCode)})` : ''}</span>
            <span style="color:#16a34a;font-weight:800;">-₹${couponDiscount.toFixed(2)}</span>
        </div>` : ''}
        <div class="so-pricing-row">
            <span>Delivery</span>
            <span ${deliveryFee===0?'style="color:#16a34a;font-weight:800;"':''}>
                ${isPickup ? 'FREE (Pickup)' : (deliveryFee===0?'FREE':'₹'+deliveryFee.toFixed(2))}
            </span>
        </div>
        <div class="so-pricing-row total">
            <span>${isPaid ? 'Total' : isPartial ? 'Balance Due' : 'Collect (COD)'}</span>
            <span>₹${(isPartial ? (order.balanceDue || Math.max(0, total - (order.amountPaid||0))) : total).toFixed(2)}</span>
        </div>
        ${isPartial
            ? `<div style="font-size:.6rem;font-weight:800;color:#0284c7;text-align:right;margin-top:2px;">PARTIAL PAID (₹${(order.amountPaid||0).toLocaleString('en-IN')} Paid)</div>`
            : isPaid
                ? `<div style="font-size:.6rem;font-weight:800;color:#16a34a;text-align:right;margin-top:2px;"><i class="fa-solid fa-check"></i> PREPAID ONLINE</div>`
                : `<div style="font-size:.6rem;font-weight:800;color:#ef4444;text-align:right;margin-top:2px;">CASH ON DELIVERY</div>`
        }
        ${isPickup
            ? `<div class="so-addr-line" style="color:#15803d;"><i class="fa-solid fa-store"></i> Self Pickup Order</div>`
            : (addr
                ? `<div class="so-addr-line">
                       <i class="fa-solid fa-location-dot" style="color:#ef4444;"></i>
                       ${esc((addr.label?addr.label+' — ':'')+addr.street+', '+addr.city+(addr.pincode?' - '+addr.pincode:''))}
                   </div>`
                : '')}

        <!-- Selection summary (shown after checkbox picks) -->
        ${!isPast ? `
        <div id="eoSel-${uid}" style="display:none;margin-top:8px;padding:8px 10px;background:var(--primary-faint);border:1px solid var(--primary-light);border-radius:var(--r-xs);">
            <div style="font-size:.62rem;font-weight:800;color:var(--primary);margin-bottom:4px;text-transform:uppercase;">
                <i class="fa-solid fa-check-double"></i> Selected for delivery:
            </div>
            <div id="eoSelList-${uid}" style="font-size:.68rem;font-weight:600;color:var(--txt2);"></div>
        </div>
        <button class="so-details-btn" onclick="eoMarkDelivered('${esc(order.id)}','${isXerox}')">
            <i class="fa-solid fa-box-open"></i> Mark Selected as Delivered
        </button>` : `
        <a href="employee-order-details.html?orderId=${esc(order.id)}"
           class="so-details-btn" style="background:var(--bg);color:var(--primary);border:1.5px solid var(--primary);">
            <i class="fa-solid fa-eye"></i> View Details
        </a>`}
    </div>
</div>`;
}

/* ════════════════════════════════
   SELECTION + MARK DELIVERED
   ════════════════════════════════ */
window.eoUpdateSelection = function(orderId) {
    const selBox  = document.getElementById(`eoSel-${orderId}`);
    const selList = document.getElementById(`eoSelList-${orderId}`);
    const checks  = document.querySelectorAll(`.eo-item-check-${orderId}:checked`);
    if (!selBox || !selList) return;
    if (!checks.length) { selBox.style.display='none'; return; }
    selBox.style.display = 'block';
    selList.innerHTML = Array.from(checks).map((c,i) =>
        `<div style="display:flex;justify-content:space-between;margin-bottom:2px;">
             <span>${i+1}. ${esc(c.dataset.name)}</span>
             <span style="color:#16a34a;font-weight:800;">✓</span>
         </div>`
    ).join('');
};

window.eoToggleExtra = function(uid, btn) {
    const box  = document.getElementById(`eoExtra-${uid}`);
    const chev = document.getElementById(`eochev-${uid}`);
    if (!box) return;
    const open = box.style.display !== 'none';
    box.style.display = open ? 'none' : 'block';
    if (chev) chev.className = `fa-solid ${open?'fa-chevron-down':'fa-chevron-up'}`;
    if (btn)  btn.innerHTML  = `<i class="fa-solid ${open?'fa-chevron-down':'fa-chevron-up'}"></i> ${open?`+${box.querySelectorAll('.so-item-row').length} more items`:'Show less'}`;
};

window.eoMarkDelivered = async function(orderId, isXeroxStr) {
    const checks = document.querySelectorAll(`.eo-item-check-${orderId}:checked`);
    if (!checks.length) {
        toast('Select at least one item to mark as delivered.','');
        return;
    }
    if (!confirm(`Mark ${checks.length} item(s) as Delivered? This will notify the seller and customer.`)) return;

    const selectedIndices = Array.from(checks).map(c => parseInt(c.value));
    const isXerox = isXeroxStr === 'true';

    try {
        const orderRef = doc(db, 'orders', orderId);
        await runTransaction(db, async tx => {
            const orderDoc = await tx.get(orderRef);
            if (!orderDoc.exists()) throw new Error('Order not found.');

            const data     = orderDoc.data();
            const field    = isXerox ? 'documents' : 'items';
            const items    = [...(data[field]||[])];

            let updated = 0;
            items.forEach((item, idx) => {
                if (selectedIndices.includes(idx)) {
                    const s = (item.status||'pending').toLowerCase();
                    if (s === 'confirmed' || s === 'out for delivery') {
                        items[idx] = { ...item, status:'delivered' };
                        updated++;
                    }
                }
            });
            if (!updated) throw new Error('Selected items are not available for delivery.');

            const payload = { [field]: items };
            const allDone = items.every(i => ['delivered','rejected','cancelled'].includes((i.status||'pending').toLowerCase()));
            if (allDone) payload.status = 'Delivered';

            tx.update(orderRef, payload);
            if (allDone) {
                tx.set(doc(db,'order_status',orderId), { status:'Delivered', updatedAt:serverTimestamp() }, { merge:true });
            }
        });

        // Update local state
        const idx = allOrders.findIndex(o=>o.id===orderId);
        if (idx!==-1) {
            const field = isXerox ? 'documents' : 'items';
            allOrders[idx][field] = allOrders[idx][field].map((item,i) => {
                if (selectedIndices.includes(i)) return {...item, status:'delivered'};
                return item;
            });
            const allDone = allOrders[idx][field].every(i => ['delivered','rejected','cancelled'].includes((i.status||'pending').toLowerCase()));
            if (allDone) allOrders[idx].status = 'Delivered';
        }

        renderOrders();
        toast(`${checks.length} item(s) marked as delivered!`, 'success');
    } catch(err) {
        console.error('[eoMarkDelivered]', err);
        toast('Update failed: ' + err.message, 'error');
    }
};

/* ════════════════════════════════
   SKELETON
   ════════════════════════════════ */
function showSkeleton() { skelEl.style.display='block'; }
function hideSkeleton()  { skelEl.style.display='none'; }
