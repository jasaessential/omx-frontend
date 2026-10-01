/* ═══════════════════════════════════════════════
   JASA V2 — orders.js
   Reads "orders" + "order_status" collections
   filtered by userId with real-time listeners.
   Listeners are stored and unsubscribed on
   page unload to prevent accumulation.
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import { WORKER_URL } from './env-config.js';
import {
    collection, query, where, orderBy,
    getDocs, getDoc, doc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

/* ════ STATE ════ */
let allOrders    = [];
let activeFilter = 'active';
let shopsCache   = [];

/* Store unsubscribe functions to avoid listener leaks */
let _unsubOrders = null;
let _unsubStatus = null;

const STATUS_MAP = {
    pending:          { label:'Pending',         color:'#f59e0b', bg:'#fef3c7', icon:'fa-solid fa-hourglass-half' },
    confirmed:        { label:'Confirmed',        color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check'   },
    accepted:         { label:'Confirmed',        color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check'   },
    processing:       { label:'Processing',       color:'#06b6d4', bg:'#cffafe', icon:'fa-solid fa-gears'           },
    'out for delivery':{ label:'Out for Delivery',color:'#10b981', bg:'#d1fae5', icon:'fa-solid fa-truck-fast'      },
    delivered:        { label:'Delivered',        color:'#16a34a', bg:'#dcfce7', icon:'fa-solid fa-circle-check'    },
    cancelled:        { label:'Cancelled',        color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-circle-xmark'    },
    rejected:         { label:'Rejected',         color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-triangle-exclamation' },
};
function getStatus(raw) {
    return STATUS_MAP[(raw||'pending').toLowerCase().trim()]
        || { label: raw||'Pending', color:'#6b7280', bg:'#f3f4f6', icon:'fa-solid fa-circle-dot' };
}

/* ── Derive the true overall status from item-level statuses ──
   Overrides the stale top-level "Processing" value.
   Priority: pending > confirmed > out for delivery > delivered > cancelled
   ─────────────────────────────────────────────────────────── */
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

    // Fallback to stored value (covers 'processing' and other admin-set values)
    return (order.status || 'pending').toLowerCase();
}

/* ════ AUTH + LOAD ════ */
onAuthStateChanged(auth, user => {
    if (!user) { window.location.replace('login.html'); return; }
    loadOrders(user.uid);
});

async function loadOrders(uid) {
    /* ── Load shops for delivery fee calculation (3-layer cache) ── */
    const SHOPS_KEY = 'global_shops_data_v1';
    try {
        const cached = localStorage.getItem(SHOPS_KEY);
        if (cached) {
            const { data, timestamp, ttl } = JSON.parse(cached);
            if (Date.now() - timestamp < (ttl || 86400000) && data?.length) {
                shopsCache = data;
            }
        }
    } catch (_) {}

    if (!shopsCache.length) {
        try {
            const res = await fetch(`${WORKER_URL}/api/shops/all`, { signal: AbortSignal.timeout(4000) });
            if (res.ok) {
                const json  = await res.json();
                const shops = json.shops || json.data || [];
                if (shops.length) {
                    localStorage.setItem(SHOPS_KEY, JSON.stringify({ data: shops, timestamp: Date.now(), ttl: 86400000 }));
                    shopsCache = shops;
                }
            }
        } catch (_) {}
    }

    if (!shopsCache.length) {
        try {
            const snap = await getDocs(collection(db, 'shops'));
            shopsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            localStorage.setItem(SHOPS_KEY, JSON.stringify({ data: shopsCache, timestamp: Date.now(), ttl: 86400000 }));
        } catch (_) {}
    }

    /* ── Instant render from localStorage orders cache ── */
    const cached = localStorage.getItem('jasa_orders_cache');
    if (cached) {
        try { allOrders = JSON.parse(cached); renderOrders(); } catch(_){}
    } else { showSkeleton(); }

    /* ── Fetch static order data ── */
    try {
        const q    = query(collection(db,'orders'), where('userId','==',uid), orderBy('createdAt','desc'));
        const snap = await getDocs(q);
        allOrders  = snap.docs.map(d => ({ id:d.id, ...d.data() }));
        localStorage.setItem('jasa_orders_cache', JSON.stringify(allOrders));
        renderOrders();
    } catch(e) { console.error('Orders fetch:',e); }

    /* ── Real-time order changes ── */
    if (_unsubOrders) _unsubOrders();   // detach any previous listener
    const qOrders = query(collection(db,'orders'), where('userId','==',uid));
    _unsubOrders = onSnapshot(qOrders, snap => {
        let changed = false;
        snap.docChanges().forEach(ch => {
            const data = { id:ch.doc.id, ...ch.doc.data() };
            const idx  = allOrders.findIndex(o => o.id === ch.doc.id);
            if (ch.type==='modified' && idx!==-1) { allOrders[idx] = { ...allOrders[idx], ...data }; changed=true; }
            else if (ch.type==='added' && idx===-1){ allOrders.push(data); changed=true; }
        });
        if (changed) { sortOrders(); localStorage.setItem('jasa_orders_cache',JSON.stringify(allOrders)); renderOrders(); }
    }, err => console.warn('orders snap err:',err));

    /* ── Real-time status changes ── */
    if (_unsubStatus) _unsubStatus();   // detach any previous listener
    const qStatus = query(collection(db,'order_status'), where('userId','==',uid));
    _unsubStatus = onSnapshot(qStatus, snap => {
        let changed = false;
        snap.docChanges().forEach(ch => {
            const { status } = ch.doc.data();
            const idx = allOrders.findIndex(o => o.id === ch.doc.id);
            if (idx !== -1 && allOrders[idx].status !== status) {
                allOrders[idx].status = status; changed = true;
            }
        });
        if (changed) { localStorage.setItem('jasa_orders_cache',JSON.stringify(allOrders)); renderOrders(); }
    }, err => console.warn('status snap err:',err));
}

/* ── Clean up listeners when the page is closed / navigated away ── */
window.addEventListener('pagehide', () => {
    if (_unsubOrders) { _unsubOrders(); _unsubOrders = null; }
    if (_unsubStatus) { _unsubStatus(); _unsubStatus = null; }
});

function sortOrders() {
    allOrders.sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0));
}

/* ════ FILTER ════ */
window.setFilter = function(filter, btn) {
    activeFilter = filter;
    document.querySelectorAll('.ord-filter-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderOrders();
};

// Set active tab on load
document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('[data-filter="active"]')?.classList.add('active');
});

function matchesFilter(order) {
    const s = deriveOrderStatus(order);
    if (activeFilter === 'all')       return true;
    if (activeFilter === 'active')    return ['pending','confirmed','accepted','processing','out for delivery'].includes(s);
    if (activeFilter === 'delivered') return s === 'delivered';
    if (activeFilter === 'rejected')  return ['rejected','cancelled'].includes(s);
    return false;
}

/* ════ RENDER ════ */
function renderOrders() {
    document.getElementById('ordSkeleton').style.display = 'none';
    const filtered = allOrders.filter(matchesFilter);
    const listEl   = document.getElementById('ordList');
    const emptyEl  = document.getElementById('ordEmpty');
    if (!filtered.length) {
        listEl.innerHTML = ''; emptyEl.style.display = 'block'; return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = filtered.map(buildOrderCard).join('');
}

function buildOrderCard(order) {
    const st     = getStatus(deriveOrderStatus(order));
    const ordId  = order.groupOrderId || order.id.slice(0,8).toUpperCase();
    const items  = order.type==='xerox' ? (order.documents||[]) : (order.items||[]);
    const count  = items.length;
    const sub    = order.subtotal || 0;

    let dateStr = '—';
    try {
        const d = order.createdAt?.toDate ? order.createdAt.toDate()
            : new Date((order.createdAt?.seconds||0)*1000);
        dateStr = d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    } catch(_){}

    const preview = items.slice(0,3);
    const extra   = items.slice(3);

    const isXerox = order.type === 'xerox';
    const buildRow = item => {
        const iStatus = getStatus(item.status || deriveOrderStatus(order));
        if (isXerox) {
            const us = item.uploadStatus || 'pending';
            let uStyle = 'background:#f3f4f6;color:#6b7280;', uLabel = 'Pending';
            if (us === 'uploaded')                             { uStyle = 'background:#dcfce7;color:#16a34a;'; uLabel = '✓ Uploaded'; }
            else if (us === 'whatsapp')                        { uStyle = 'background:#dcfce7;color:#15803d;'; uLabel = '⚡ WhatsApp'; }
            else if (us === 'later' || us === 'pending_later') { uStyle = 'background:#ffedd5;color:#c2410c;'; uLabel = '⚠ Upload Pending'; }
            const qty = item.config?.quantity || 1;
            const total = item.price || 0;
            return `<div class="ord-item-row">
            <div>
                <div class="ord-item-name">${item.name||'Item'}</div>
                <div class="ord-item-meta">
                    ₹${(total/qty).toFixed(2)} × ${qty}
                    <span class="ord-status-badge" style="${uStyle}font-size:.6rem;">${uLabel}</span>
                    <span class="ord-status-badge" style="background:${iStatus.bg};color:${iStatus.color};">
                        <i class="${iStatus.icon}"></i> ${iStatus.label}
                    </span>
                </div>
            </div>
            <span class="ord-item-price">₹${total.toFixed(2)}</span>
        </div>`;
        }
        return `<div class="ord-item-row">
            <div>
                <div class="ord-item-name">${item.name||'Item'}</div>
                <div class="ord-item-meta">
                    ${item.qty ? `₹${item.price} × ${item.qty}` : `₹${item.price||0}`}
                    <span class="ord-status-badge" style="background:${iStatus.bg};color:${iStatus.color};">
                        <i class="${iStatus.icon}"></i> ${iStatus.label}
                    </span>
                </div>
            </div>
            <span class="ord-item-price">₹${item.qty ? (item.price*item.qty).toLocaleString('en-IN') : (item.price||0).toLocaleString('en-IN')}</span>
        </div>`;
    };

    const uid = order.id;
    const moreHtml = extra.length ? `
        <div id="extra-${uid}" style="display:none;">
            ${extra.map(buildRow).join('')}
        </div>
        <button class="ord-show-more" onclick="toggleExtra('${uid}',this)">
            <i class="fa-solid fa-chevron-down" id="chev-${uid}"></i> +${extra.length} more item${extra.length>1?'s':''}
        </button>` : '';

    return `
    <div class="ord-card">
        <div class="ord-card-head">
            <div>
                <div class="ord-card-id" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    ORDER <span>#${ordId}</span>
                    ${(order.fulfillmentType === 'pickup' || order.deliveryMode === 'pickup' || order.isPickup === true || order.orderType === 'pickup' || (order.deliveryFee === 0 && !order.deliveryAddress))
                        ? `<span class="ord-ful-chip ord-ful-chip--pickup"><i class="fa-solid fa-store"></i> Pick Myself</span>`
                        : `<span class="ord-ful-chip ord-ful-chip--delivery"><i class="fa-solid fa-truck-fast"></i> Delivery</span>`}
                    ${((order.paymentMethod||'').toLowerCase() === 'partial' || (order.paymentStatus||'').toLowerCase() === 'partial_paid' || (order.balanceDue > 0 && order.amountPaid > 0))
                        ? `<span class="ord-pay-chip ord-pay-chip--partial"><i class="fa-solid fa-percent"></i> Partial Paid</span>`
                        : ((order.paymentStatus||'').toLowerCase() === 'paid' || (order.paymentMethod||'').toLowerCase() === 'paid')
                        ? `<span class="ord-pay-chip ord-pay-chip--paid"><i class="fa-solid fa-circle-check"></i> Paid</span>`
                        : `<span class="ord-pay-chip ord-pay-chip--cod"><i class="fa-solid fa-money-bill-wave"></i> COD</span>`}
                </div>
                <div class="ord-card-date"><i class="fa-regular fa-calendar"></i> ${dateStr} · ${count} item${count!==1?'s':''}</div>
                ${!(order.fulfillmentType === 'pickup' || order.deliveryMode === 'pickup' || order.isPickup === true || order.orderType === 'pickup' || (order.deliveryFee === 0 && !order.deliveryAddress)) && order.deliveryAddress ? `<div class="ord-card-date" style="margin-top:2px;"><i class="fa-solid fa-location-dot"></i> ${order.deliveryAddress.street||''}, ${order.deliveryAddress.city||''}</div>` : ''}
                ${(order.fulfillmentType === 'pickup' || order.deliveryMode === 'pickup' || order.isPickup === true || order.orderType === 'pickup' || (order.deliveryFee === 0 && !order.deliveryAddress)) ? `<div class="ord-card-date" style="margin-top:2px;color:#15803d;font-weight:700;"><i class="fa-solid fa-store"></i> ${order.shopName||'Self Pickup'}</div>` : ''}
            </div>
            <span class="ord-status-badge" style="background:${st.bg};color:${st.color};">
                <i class="${st.icon}"></i> ${st.label}
            </span>
        </div>
        <div class="ord-card-items">
            ${preview.map(buildRow).join('')}
            ${moreHtml}
        </div>
        <div class="ord-card-foot">
            <div class="ord-total-block">
                <div class="ord-total">Subtotal <span>₹${sub.toLocaleString('en-IN')}</span></div>
                ${Number(order.discountAmount) > 0 ? `
                <div class="ord-total">Coupon${order.couponCode ? ` (${order.couponCode})` : ''}
                    <span style="color:#16a34a;">-₹${Number(order.discountAmount).toLocaleString('en-IN')}</span>
                </div>` : ''}
                ${Number(order.walletAmount) > 0 ? `
                <div class="ord-total">Wallet
                    <span style="color:#16a34a;">-₹${Number(order.walletAmount).toLocaleString('en-IN')}</span>
                </div>` : ''}
                ${order.deliveryFee != null ? `
                <div class="ord-total">Delivery
                    <span ${order.deliveryFee === 0 ? 'style="color:#16a34a;"' : ''}>
                        ${order.deliveryFee === 0 ? 'FREE' : `₹${Number(order.deliveryFee).toLocaleString('en-IN')}`}
                    </span>
                </div>
                <div class="ord-total ord-grand-total">Total
                    <span>₹${(sub - (Number(order.discountAmount) || 0) - (Number(order.walletAmount) || 0) + Number(order.deliveryFee)).toLocaleString('en-IN')}</span>
                </div>` : ''}
            </div>
            <a href="order-details.html?id=${order.id}" class="ord-details-btn">
                Details <i class="fa-solid fa-arrow-right"></i>
            </a>
        </div>
    </div>`;
}

window.toggleExtra = function(id, btn) {
    const box  = document.getElementById(`extra-${id}`);
    const chev = document.getElementById(`chev-${id}`);
    if (!box) return;
    const open = box.style.display !== 'none';
    box.style.display    = open ? 'none' : 'block';
    if (chev) chev.className = open ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
    if (btn)  btn.innerHTML  = `<i class="${chev?.className||'fa-solid fa-chevron-down'}"></i> ${open ? `+${box.querySelectorAll('.ord-item-row').length} more items` : 'Show less'}`;
};

function showSkeleton() {
    document.getElementById('ordSkeleton').style.display = 'block';
}
