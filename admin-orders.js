/* ═══════════════════════════════════════════════
   ADMIN ORDERS — admin-orders.js
   Features (matching WEBSITE folder):
   • Real-time orders + status listeners
   • Status / type / shop / payment / date filters
   • Search by ID, name, phone, shop
   • Revenue stat (delivered items only)
   • Cleanup mode — single & bulk delete
   • CSV download
   • Bottom-sheet detail with status update
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import {
    collection, doc, getDoc, getDocs,
    deleteDoc,
    onSnapshot, query, orderBy, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { WORKER_URL } from './env-config.js';

/* ════ STATE ════ */
let allOrders      = [];
let shopsCache     = [];
let usersCache     = new Map();
let selectedIds    = new Set();
let isCleanupMode  = false;

let activeFilter   = 'all';
let activeType     = 'all';
let activeShop     = 'all';
let activePayment  = 'all';
let dateFrom       = null;
let dateTo         = null;
let searchQuery    = '';

/* ════ STATUS MAP ════ */
const STATUS_MAP = {
    pending:            { label:'Pending',         color:'#f59e0b', bg:'#fef3c7', icon:'fa-solid fa-hourglass-half'       },
    confirmed:          { label:'Confirmed',        color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check'         },
    accepted:           { label:'Confirmed',        color:'#2D8CF0', bg:'#deeeff', icon:'fa-solid fa-circle-check'         },
    processing:         { label:'Processing',       color:'#06b6d4', bg:'#cffafe', icon:'fa-solid fa-gears'                },
    'out for delivery': { label:'Out for Delivery', color:'#10b981', bg:'#d1fae5', icon:'fa-solid fa-truck-fast'           },
    delivered:          { label:'Delivered',        color:'#16a34a', bg:'#dcfce7', icon:'fa-solid fa-circle-check'         },
    cancelled:          { label:'Cancelled',        color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-circle-xmark'         },
    rejected:           { label:'Rejected',         color:'#ef4444', bg:'#fee2e2', icon:'fa-solid fa-triangle-exclamation' },
};
function getStatus(raw) {
    const key = (raw || 'pending').toLowerCase().trim();
    return STATUS_MAP[key] || { label: raw || 'Pending', color:'#6b7280', bg:'#f3f4f6', icon:'fa-solid fa-circle-dot' };
}

/* ════ EFFECTIVE STATUS ════ */
function getEffectiveOrderStatus(order) {
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

function calcDeliveredRevenue(order) {
    const isXerox = order.type === 'xerox';
    const items   = isXerox ? (order.documents || []) : (order.items || []);
    return items.reduce((sum, item) => {
        if ((item.status || '').toLowerCase() === 'delivered') {
            return sum + (isXerox ? (item.price || 0) : (item.price || 0) * (item.qty || 1));
        }
        return sum;
    }, 0);
}

function buildItemStatusSummary(items) {
    const counts = {};
    items.forEach(i => { const s = (i.status || 'pending').toLowerCase(); counts[s] = (counts[s] || 0) + 1; });
    const order = ['delivered','confirmed','out for delivery','pending','rejected','cancelled'];
    const parts = [];
    order.forEach(s => { if (counts[s]) parts.push(`${counts[s]} ${s}`); });
    Object.keys(counts).forEach(s => { if (!order.includes(s)) parts.push(`${counts[s]} ${s}`); });
    return parts.join(' · ');
}

/* ════ HELPERS ════ */
function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(raw) {
    if (!raw) return '—';
    try {
        const d = raw.toDate ? raw.toDate() : raw.seconds ? new Date(raw.seconds*1000) : new Date(raw);
        if (isNaN(d)) return '—';
        return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    } catch { return '—'; }
}
function fmtDateTime(raw) {
    if (!raw) return '—';
    try {
        const d = raw.toDate ? raw.toDate() : raw.seconds ? new Date(raw.seconds*1000) : new Date(raw);
        if (isNaN(d)) return '—';
        return d.toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
    } catch { return '—'; }
}

/* ════ TOAST ════ */
function toast(msg, type = '') {
    const el = document.getElementById('aoToast');
    el.textContent = msg; el.className = 'ao-toast ' + type;
    void el.offsetWidth; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

/* ════ AUTH GUARD ════ */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search)); return; }
    try {
        const cached = localStorage.getItem('jasa_user_cache');
        if (cached) {
            const cd = JSON.parse(cached);
            const cr = cd.roles || [cd.role || 'user'];
            if (!cr.includes('admin')) { window.location.replace('index.html'); return; }
        }
    } catch (_) {}
    try {
        const snap  = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin')) {
            toast('Admin access required.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1200);
            return;
        }
        await init();
    } catch (err) { console.error('[AdminOrders] auth:', err); window.location.replace('index.html'); }
});

/* ════ INIT ════ */
async function init() {
    await Promise.all([loadShops(), loadOrders()]);
    setupListeners();
}

/* ════ SHOPS CACHE ════ */
async function loadShops() {
    /* 1. localStorage cache (24h TTL) — shared key with other pages */
    const CACHE_KEY = 'global_shops_data_v1';
    try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
            const { data, timestamp, ttl } = JSON.parse(cached);
            if (Date.now() - timestamp < (ttl || 86400000) && data?.length) {
                shopsCache = data;
                buildShopPills();
                return;
            }
        }
    } catch (_) {}

    /* 2. Cloudflare Worker edge cache */
    try {
        const res = await fetch(`${WORKER_URL}/api/shops/all`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            const json = await res.json();
            const shops = json.shops || json.data || [];
            if (shops.length) {
                localStorage.setItem(CACHE_KEY, JSON.stringify({ data: shops, timestamp: Date.now(), ttl: 86400000 }));
                shopsCache = shops;
                buildShopPills();
                return;
            }
        }
    } catch (_) {}

    /* 3. Firestore fallback */
    try {
        const snap   = await getDocs(collection(db, 'shops'));
        shopsCache   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        localStorage.setItem(CACHE_KEY, JSON.stringify({ data: shopsCache, timestamp: Date.now(), ttl: 86400000 }));
        buildShopPills();
    } catch (err) { console.warn('[AdminOrders] shops:', err); }
}

function buildShopPills() {
    const container = document.getElementById('aoShopPills');
    if (!container) return;
    shopsCache.forEach(shop => {
        const btn = document.createElement('button');
        btn.className   = 'ao-pill';
        btn.dataset.value = shop.id;
        btn.textContent = shop.name || 'Shop';
        btn.onclick = () => setShopFilter(shop.id, btn);
        container.appendChild(btn);
    });
}

/* ════ LOAD ORDERS ════ */
async function loadOrders() {
    document.getElementById('aoSkeletons').style.display = 'flex';
    document.getElementById('aoList').innerHTML          = '';
    document.getElementById('aoEmpty').style.display     = 'none';

    try {
        const q    = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        allOrders  = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Merge order_status collection
        const statusSnap = await getDocs(collection(db, 'order_status'));
        const statusMap  = new Map(statusSnap.docs.map(d => [d.id, d.data().status]));
        allOrders.forEach(o => { if (statusMap.has(o.id)) o.status = statusMap.get(o.id); });

        // Fetch user profiles
        const uids = [...new Set(allOrders.map(o => o.userId).filter(Boolean))];
        await fetchUsers(uids);

        document.getElementById('aoSkeletons').style.display = 'none';
        updateStats(); renderOrders();
    } catch (err) {
        console.error('[AdminOrders] load:', err);
        document.getElementById('aoSkeletons').style.display = 'none';
        toast('Failed to load orders.', 'error');
    }
}

async function fetchUsers(uids) {
    const missing = uids.filter(id => !usersCache.has(id));
    for (let i = 0; i < missing.length; i += 10) {
        await Promise.all(missing.slice(i, i+10).map(async uid => {
            try {
                const snap = await getDoc(doc(db, 'users', uid));
                const d    = snap.exists() ? snap.data() : {};
                usersCache.set(uid, {
                    name:      d.fullName || d.name || 'Customer',
                    displayId: d.userId   || '',
                    phone:     d.phone    || ''
                });
            } catch { usersCache.set(uid, { name:'Customer', displayId:'', phone:'' }); }
        }));
    }
}

/* ════ REAL-TIME LISTENERS ════ */
function setupListeners() {
    // order_status changes
    onSnapshot(collection(db, 'order_status'), snap => {
        let changed = false;
        snap.docChanges().forEach(ch => {
            const idx = allOrders.findIndex(o => o.id === ch.doc.id);
            if (idx !== -1 && allOrders[idx].status !== ch.doc.data().status) {
                allOrders[idx].status = ch.doc.data().status; changed = true;
            }
        });
        if (changed) { updateStats(); renderOrders(); }
    }, err => console.warn('[AdminOrders] status snap:', err));

    // orders collection
    const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
    onSnapshot(q, snap => {
        let changed = false;
        snap.docChanges().forEach(ch => {
            const data = { id: ch.doc.id, ...ch.doc.data() };
            const idx  = allOrders.findIndex(o => o.id === ch.doc.id);
            if (ch.type === 'modified' && idx !== -1) {
                const prevStatus = allOrders[idx].status;
                allOrders[idx]   = { ...allOrders[idx], ...data };
                if (prevStatus) allOrders[idx].status = prevStatus;
                changed = true;
            } else if (ch.type === 'added' && idx === -1) {
                allOrders.unshift(data);
                fetchUsers([data.userId]); changed = true;
            } else if (ch.type === 'removed' && idx !== -1) {
                allOrders.splice(idx, 1); changed = true;
            }
        });
        if (changed) { updateStats(); renderOrders(); }
    }, err => console.warn('[AdminOrders] orders snap:', err));
}

/* ════ STATS ════ */
function updateStats() {
    const visible = filtered();
    let pending = 0, active = 0, delivered = 0, revenue = 0;
    visible.forEach(o => {
        const s = getEffectiveOrderStatus(o);
        if (s === 'pending')   pending++;
        if (['confirmed','accepted','processing','out for delivery'].includes(s)) active++;
        if (s === 'delivered') { delivered++; revenue += calcDeliveredRevenue(o); }
    });
    setText('aoStatTotal',    visible.length);
    setText('aoStatPending',  pending);
    setText('aoStatActive',   active);
    setText('aoStatDelivered', delivered);
    setText('aoStatRevenue',  '₹' + revenue.toLocaleString('en-IN', {maximumFractionDigits:0}));
}

/* ════ FILTER ════ */
function filtered() {
    return allOrders.filter(o => {
        const s = getEffectiveOrderStatus(o);

        if (activeFilter !== 'all' && s !== activeFilter) return false;
        if (activeType   !== 'all' && (o.type || 'product') !== activeType) return false;
        if (activeShop   !== 'all' && o.shopId !== activeShop) return false;

        if (activePayment !== 'all') {
            const pm = (o.paymentMethod || 'cod').toLowerCase();
            if (pm !== activePayment) return false;
        }

        if (dateFrom || dateTo) {
            const d = o.createdAt?.toDate ? o.createdAt.toDate() : new Date(o.createdAt || 0);
            if (dateFrom) { const f = new Date(dateFrom); f.setHours(0,0,0,0); if (d < f) return false; }
            if (dateTo)   { const t = new Date(dateTo);   t.setHours(23,59,59,999); if (d > t) return false; }
        }

        if (searchQuery) {
            const q    = searchQuery;
            const gid  = (o.groupOrderId || '').toLowerCase();
            const id   = (o.id || '').toLowerCase();
            const shop = (shopsCache.find(s => s.id === o.shopId)?.name || o.shopName || '').toLowerCase();
            const mob  = (o.contacts?.mobile || '').toLowerCase();
            const user = (usersCache.get(o.userId)?.name || '').toLowerCase();
            if (!gid.includes(q) && !id.includes(q) && !shop.includes(q) && !mob.includes(q) && !user.includes(q)) return false;
        }
        return true;
    });
}

/* ════ FILTER SETTERS (window-exposed) ════ */
window.setFilter = function(f, btn) {
    activeFilter = f;
    document.querySelectorAll('.ao-filter-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    updateStats(); renderOrders();
};
window.setTypeFilter = function(t, btn) {
    activeType = t;
    document.querySelectorAll('.ao-type-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    updateStats(); renderOrders();
};
window.setShopFilter = function(v, btn) {
    activeShop = v;
    document.querySelectorAll('#aoShopPills .ao-pill').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    updateStats(); renderOrders();
};
window.setPaymentFilter = function(v, btn) {
    activePayment = v;
    document.querySelectorAll('.ao-pill[data-value="cod"],.ao-pill[data-value="prepaid"],.ao-pill[data-value="all"]').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    updateStats(); renderOrders();
};
window.onSearchInput = function(val) { searchQuery = val.trim().toLowerCase(); updateStats(); renderOrders(); };
window.onDateChange  = function() {
    dateFrom = document.getElementById('aoDateFrom').value || null;
    dateTo   = document.getElementById('aoDateTo').value   || null;
    updateStats(); renderOrders();
};

/* ════ RENDER ════ */
function renderOrders() {
    const list    = document.getElementById('aoList');
    const empty   = document.getElementById('aoEmpty');
    const visible = filtered();

    if (!visible.length) {
        list.innerHTML          = '';
        empty.style.display     = 'flex';
        return;
    }
    empty.style.display = 'none';
    list.innerHTML      = visible.map(buildCard).join('');
}

function buildCard(o) {
    const s       = getEffectiveOrderStatus(o);
    const st      = getStatus(s);
    const isXerox = o.type === 'xerox';
    const items   = isXerox ? (o.documents || []) : (o.items || []);
    const ordId   = o.groupOrderId ? '#' + esc(o.groupOrderId) : '#' + esc(o.id.slice(0,8).toUpperCase());
    const shop    = shopsCache.find(sh => sh.id === o.shopId);
    const shopName = esc(shop?.name || o.shopName || '—');
    const user    = usersCache.get(o.userId) || { name:'—' };
    const sub     = o.subtotal || 0;
    const isSelected = selectedIds.has(o.id);

    const summary = items.length > 0 ? buildItemStatusSummary(items) : '';

    const isPickup = o.fulfillmentType === 'pickup' || o.deliveryMode === 'pickup' || o.isPickup === true || o.orderType === 'pickup' || (o.deliveryFee === 0 && !o.deliveryAddress);
    const pMethod  = (o.paymentMethod || 'cod').toLowerCase();
    const pStatus  = (o.paymentStatus || 'pending').toLowerCase();
    const isPartial = pMethod === 'partial' || pStatus === 'partial_paid' || (o.balanceDue > 0 && o.amountPaid > 0);
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

    return `
<div class="ao-card${isSelected ? ' ao-card--selected' : ''}"
     data-id="${o.id}"
     onclick="${isCleanupMode ? `toggleSelect('${o.id}')` : `window.location.href='admin-order-details.html?orderId=${o.id}'`}">
    <div class="ao-card-head">
        <div>
            <div class="ao-card-id">ORDER <span>${ordId}</span></div>
            <div class="ao-card-date"><i class="fa-regular fa-calendar"></i> ${fmtDate(o.createdAt)}</div>
            <div style="display:flex;gap:4px;align-items:center;margin-top:4px;flex-wrap:wrap;">
                <span class="ao-type-badge ao-type-badge--${isXerox ? 'xerox' : 'product'}">
                    <i class="fa-solid fa-${isXerox ? 'print' : 'box'}"></i> ${isXerox ? 'XEROX' : 'PRODUCT'}
                </span>
                ${fulChip}
                ${payChip}
            </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
            <span class="ao-status-badge" style="background:${st.bg};color:${st.color};">
                <i class="${st.icon}"></i> ${st.label}
            </span>
            ${isCleanupMode
                ? `<button class="ao-card-del-btn" onclick="event.stopPropagation();deleteSingle('${o.id}')">
                       <i class="fa-solid fa-trash-can"></i> Delete
                   </button>`
                : ''
            }
        </div>
    </div>
    <div class="ao-card-mid">
        <span class="ao-card-shop"><i class="fa-solid fa-store"></i> ${shopName}</span>
        <span class="ao-card-customer"><i class="fa-solid fa-user"></i> ${esc(user.name)}</span>
        <span class="ao-card-mobile"><i class="fa-solid fa-phone"></i> ${esc(o.contacts?.mobile || '—')}</span>
    </div>
    ${summary ? `<div class="ao-card-summary"><i class="fa-solid fa-layer-group" style="margin-right:5px;opacity:.5;"></i>${esc(summary)}</div>` : ''}
    <div class="ao-card-foot">
        <span class="ao-card-count"><i class="fa-solid fa-layer-group"></i> ${items.length} item${items.length !== 1 ? 's' : ''}</span>
        <span class="ao-card-subtotal">₹${Number(sub).toLocaleString('en-IN')}</span>
        <i class="fa-solid fa-chevron-right ao-card-arrow"></i>
    </div>
</div>`;
}

/* ════ CLEANUP MODE ════ */
window.toggleCleanupMode = function() {
    isCleanupMode = !isCleanupMode;
    selectedIds.clear();

    const toggle  = document.getElementById('aoCleanupToggle');
    const banner  = document.getElementById('aoCleanupBanner');
    const bulkBar = document.getElementById('aoBulkBar');

    toggle.classList.toggle('active', isCleanupMode);
    banner.style.display  = isCleanupMode ? 'flex' : 'none';
    bulkBar.style.display = 'none';

    renderOrders();
};

window.toggleSelectAll = function() {
    const vis = filtered();
    const btn = document.getElementById('aoSelectAllBtn');
    if (selectedIds.size === vis.length) {
        selectedIds.clear();
        btn.innerHTML = '<i class="fa-solid fa-check-double"></i> Select All';
    } else {
        vis.forEach(o => selectedIds.add(o.id));
        btn.innerHTML = '<i class="fa-solid fa-xmark"></i> Deselect All';
    }
    updateBulkBar(); renderOrders();
};

window.toggleSelect = function(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    updateBulkBar(); renderOrders();
};

function updateBulkBar() {
    const bar   = document.getElementById('aoBulkBar');
    const count = document.getElementById('aoBulkCount');
    const n     = selectedIds.size;
    bar.style.display = (isCleanupMode && n > 0) ? 'block' : 'none';
    if (count) count.textContent = n;
}

window.deleteSingle = async function(id) {
    if (!confirm('Delete this order permanently? This cannot be undone.')) return;
    try {
        await deleteDoc(doc(db, 'orders', id));
        await deleteDoc(doc(db, 'order_status', id)).catch(() => {});
        allOrders  = allOrders.filter(o => o.id !== id);
        selectedIds.delete(id);
        updateStats(); renderOrders(); updateBulkBar();
        toast('Order deleted', 'success');
    } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
};

window.bulkDeleteOrders = async function() {
    const n = selectedIds.size;
    if (!n) return;
    if (!confirm(`Permanently delete ${n} order${n !== 1 ? 's' : ''}? This cannot be undone.`)) return;

    document.getElementById('aoBulkBar').style.display = 'none';
    const ids = Array.from(selectedIds);

    try {
        const CHUNK = 240;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const batch = writeBatch(db);
            ids.slice(i, i + CHUNK).forEach(id => {
                batch.delete(doc(db, 'orders', id));
                batch.delete(doc(db, 'order_status', id));
            });
            await batch.commit();
        }
        allOrders = allOrders.filter(o => !selectedIds.has(o.id));
        selectedIds.clear();
        updateStats(); renderOrders(); updateBulkBar();
        toast(`${n} order${n !== 1 ? 's' : ''} deleted`, 'success');
    } catch (err) { toast('Bulk delete failed: ' + err.message, 'error'); }
};

/* ════ CSV DOWNLOAD ════ */
window.downloadCSV = function() {
    const rows = filtered();
    if (!rows.length) { toast('No orders to download.', ''); return; }

    const btn = document.getElementById('aoDownloadBtn');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled  = true;

    try {
        const headers = [
            'Order ID','Date','Shop','Customer','Phone',
            'Status','Type','Payment','Items','Subtotal','Coupon','Discount','Wallet','Delivery Fee','Total','Address','City'
        ];

        const dataRows = rows.map(o => {
            const isXerox  = o.type === 'xerox';
            const items    = isXerox ? (o.documents || []) : (o.items || []);
            const shop     = shopsCache.find(s => s.id === o.shopId);
            const user     = usersCache.get(o.userId) || { name: '—' };
            const sub      = o.subtotal   || 0;
            const delFee   = o.deliveryFee != null ? Number(o.deliveryFee) : 0;
            const total    = o.totalAmount || (sub + delFee);
            const addr     = o.deliveryAddress || {};

            const dateStr  = o.createdAt?.toDate
                ? o.createdAt.toDate().toLocaleString('en-IN') : '—';

            return [
                o.groupOrderId || o.id.slice(0,8).toUpperCase(),
                dateStr,
                shop?.name || o.shopName || '—',
                user.name,
                o.contacts?.mobile || '—',
                getEffectiveOrderStatus(o),
                isXerox ? 'Xerox' : 'Product',
                o.paymentMethod === 'prepaid' ? 'Prepaid' : 'COD',
                items.length,
                sub.toFixed(2),
                o.couponCode || '',
                (Number(o.discountAmount) || 0).toFixed(2),
                (Number(o.walletAmount) || 0).toFixed(2),
                delFee.toFixed(2),
                total.toFixed(2),
                addr.street || '—',
                addr.city   || '—'
            ];
        });

        const csvEsc = v => {
            const s = String(v ?? '');
            return (s.includes(',') || s.includes('"') || s.includes('\n'))
                ? `"${s.replace(/"/g,'""')}"` : s;
        };

        const csv  = [headers, ...dataRows].map(r => r.map(csvEsc).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `orders_${new Date().toISOString().slice(0,10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('Report downloaded', 'success');
    } catch (err) {
        toast('Download failed: ' + err.message, 'error');
    } finally {
        btn.innerHTML = orig;
        btn.disabled  = false;
    }
};

/* ════ TINY HELPERS ════ */
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}
