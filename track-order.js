/* ═══════════════════════════════════════════════
   JASA V2 — track-order.js
   • Logged-in users: auto-loads their recent
     orders and shows them immediately (like the
     website folder's Active Orders section)
   • Guests: search-only mode
   Collections:
     • orders       — static order data
     • order_status — live status (same doc ID)
   ═══════════════════════════════════════════════ */

import { auth, db } from './firebase-init.js';
import { WORKER_URL } from './env-config.js';
import { onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    collection, query, where, orderBy,
    getDocs, getDoc, doc, limit
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

/* ════ STATE ════ */
let currentUid = null;

/* ════ STATUS CONFIG ════ */
const STATUS_MAP = {
    'pending':          { label: 'Pending',          color: '#f59e0b', bg: '#fef3c7', icon: 'fa-solid fa-hourglass-half',       step: 1 },
    'confirmed':        { label: 'Confirmed',         color: '#2D8CF0', bg: '#deeeff', icon: 'fa-solid fa-circle-check',         step: 2 },
    'accepted':         { label: 'Confirmed',         color: '#2D8CF0', bg: '#deeeff', icon: 'fa-solid fa-circle-check',         step: 2 },
    'processing':       { label: 'Processing',        color: '#06b6d4', bg: '#cffafe', icon: 'fa-solid fa-gears',                step: 2 },
    'out for delivery': { label: 'Out for Delivery',  color: '#10b981', bg: '#d1fae5', icon: 'fa-solid fa-truck-fast',           step: 3 },
    'delivered':        { label: 'Delivered',         color: '#16a34a', bg: '#dcfce7', icon: 'fa-solid fa-circle-check',         step: 4 },
    'cancelled':        { label: 'Cancelled',         color: '#ef4444', bg: '#fee2e2', icon: 'fa-solid fa-circle-xmark',         step: 0 },
    'rejected':         { label: 'Rejected',          color: '#ef4444', bg: '#fee2e2', icon: 'fa-solid fa-triangle-exclamation', step: 0 },
};

function getStatus(raw) {
    const key = (raw || 'pending').toLowerCase().trim();
    return STATUS_MAP[key] || { label: raw || 'Pending', color: '#6b7280', bg: '#f3f4f6', icon: 'fa-solid fa-circle-dot', step: 1 };
}

/* ── Derive true overall status from item-level statuses ──
   Priority: pending > confirmed > out for delivery > delivered > cancelled
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

/* ════ INIT ════ */
document.addEventListener('DOMContentLoaded', () => {
    /* Enter key for manual search — only if input exists on the page */
    document.getElementById('trackOrderInput')
        ?.addEventListener('keydown', (e) => { if (e.key === 'Enter') trackOrder(); });

    /* Auth: auto-load orders when logged in */
    onAuthStateChanged(auth, async (user) => {
        currentUid = user?.uid || null;
        if (user) {
            await loadUserOrders(user.uid);
        } else {
            showGuestMode();
        }
    });
});

/* ════════════════════════════════════════
   AUTO-LOAD: User's recent orders
   ════════════════════════════════════════ */
async function loadUserOrders(uid) {
    const resultEl = document.getElementById('trackResult');
    if (!resultEl) return;

    /* ── Instant render from orders cache (no flash) ── */
    const ORDERS_CACHE = 'jasa_orders_cache';
    try {
        const raw = localStorage.getItem(ORDERS_CACHE);
        if (raw) {
            const cached = JSON.parse(raw);
            if (cached?.length) {
                const activeKeywords = ['pending','processing','out for delivery','confirmed','accepted'];
                const active = cached.filter(o => activeKeywords.includes(deriveOrderStatus(o)));
                if (active.length) {
                    resultEl.style.display = 'block';
                    let html = `<div class="tr-section-label"><i class="fa-solid fa-bolt-lightning"></i> Active Orders</div>`;
                    html += active.slice(0,3).map(o => buildResultCard(o, true)).join('');
                    html += `<a href="orders.html" class="tr-view-all-btn"><i class="fa-solid fa-list"></i> View All Orders</a>`;
                    resultEl.innerHTML = html;
                }
            }
        }
    } catch (_) {}

    /* ── Show spinner if nothing cached ── */
    if (!resultEl.innerHTML.trim()) {
        resultEl.style.display = 'block';
        resultEl.innerHTML = `<div class="tr-loading"><span class="track-spin"></span> Loading your orders…</div>`;
    }

    try {
        const q = query(
            collection(db, 'orders'),
            where('userId', '==', uid),
            orderBy('createdAt', 'desc'),
            limit(5)
        );
        const snap = await getDocs(q);

        if (snap.empty) {
            resultEl.innerHTML = `
                <div class="tr-empty-note">
                    <i class="fa-solid fa-box-open"></i>
                    No orders yet. Place your first order!
                </div>`;
            return;
        }

        /* Fetch live statuses in parallel */
        const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const statusSnaps = await Promise.all(
            orders.map(o => getDoc(doc(db, 'order_status', o.id)).catch(() => null))
        );
        orders.forEach((o, i) => {
            const ss = statusSnaps[i];
            if (ss?.exists()) o.status = ss.data().status || o.status;
        });

        /* ── Update orders cache with fresh data ── */
        try {
            const existing = JSON.parse(localStorage.getItem(ORDERS_CACHE) || '[]');
            orders.forEach(fresh => {
                const idx = existing.findIndex(e => e.id === fresh.id);
                if (idx !== -1) existing[idx] = { ...existing[idx], ...fresh };
                else existing.unshift(fresh);
            });
            localStorage.setItem(ORDERS_CACHE, JSON.stringify(existing));
        } catch (_) {}

        /* Separate active vs recent */
        const activeKeywords = ['pending', 'processing', 'out for delivery', 'confirmed', 'accepted'];
        const active  = orders.filter(o => activeKeywords.includes(deriveOrderStatus(o)));
        const rest    = orders.filter(o => !activeKeywords.includes(deriveOrderStatus(o)));

        let html = '';
        if (active.length) {
            html += `<div class="tr-section-label"><i class="fa-solid fa-bolt-lightning"></i> Active Orders</div>`;
            html += active.map(o => buildResultCard(o, true)).join('');
        }
        if (!active.length) {
            html += `<div class="tr-section-label"><i class="fa-solid fa-clock-rotate-left"></i> Recent Orders</div>`;
            html += orders.slice(0, 3).map(o => buildResultCard(o, true)).join('');
        } else if (rest.length) {
            html += `<div class="tr-section-label" style="margin-top:12px;"><i class="fa-solid fa-clock-rotate-left"></i> Recent Orders</div>`;
            html += rest.slice(0, 2).map(o => buildResultCard(o, true)).join('');
        }
        html += `<a href="orders.html" class="tr-view-all-btn"><i class="fa-solid fa-list"></i> View All Orders</a>`;
        resultEl.innerHTML = html;

        const input = document.getElementById('trackOrderInput');
        if (input) input.placeholder = 'Search another order ID…';

    } catch (err) {
        console.error('loadUserOrders error:', err);
        /* Don't overwrite cached content if we already showed something */
        if (!resultEl.innerHTML.includes('tr-card') && !resultEl.innerHTML.includes('tr-section-label')) {
            resultEl.innerHTML = `<div class="tr-error"><i class="fa-solid fa-circle-exclamation"></i> Could not load orders. Try searching by Order ID.</div>`;
        }
    }
}

/* ════════════════════════════════════════
   GUEST MODE: just show the search input
   ════════════════════════════════════════ */
function showGuestMode() {
    const resultEl = document.getElementById('trackResult');
    if (resultEl) {
        resultEl.style.display = 'none';
        resultEl.innerHTML = '';
    }
}

/* ════════════════════════════════════════
   MANUAL SEARCH (works for both auth states)
   ════════════════════════════════════════ */
window.trackOrder = async function () {
    const input  = document.getElementById('trackOrderInput');
    const btn    = document.getElementById('trackOrderBtn');
    const raw    = (input?.value || '').trim().toUpperCase();

    if (!raw) {
        if (currentUid) { await loadUserOrders(currentUid); return; }
        showResult(errorPanel('Please enter an Order ID.'));
        return;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="track-spin"></span>'; }
    showResult('<div class="tr-loading"><span class="track-spin"></span> Searching…</div>');

    try {
        /* Strategy 1: exact groupOrderId match */
        let snap = await getDocs(query(
            collection(db, 'orders'),
            where('groupOrderId', '==', raw)
        ));

        /* Strategy 2: strip ORD- prefix */
        if (snap.empty) {
            const stripped = raw.replace(/^ORD[-]?/, '');
            snap = await getDocs(query(
                collection(db, 'orders'),
                where('groupOrderId', '==', stripped)
            ));
        }

        /* Strategy 3: direct Firestore doc ID */
        if (snap.empty && raw.length >= 6) {
            const directSnap = await getDoc(doc(db, 'orders', raw));
            if (directSnap.exists()) snap = { empty: false, docs: [directSnap] };
        }

        if (snap.empty) {
            showResult(errorPanel(`No order found for "<strong>${raw}</strong>". Check the ID and try again.`));
            return;
        }

        const orderDoc  = snap.docs[0];
        const orderData = { id: orderDoc.id, ...orderDoc.data() };

        /* Fetch live status */
        try {
            const ss = await getDoc(doc(db, 'order_status', orderDoc.id));
            if (ss.exists()) orderData.status = ss.data().status || orderData.status;
        } catch (_) {}

        const isOwner = currentUid && orderData.userId === currentUid;

        /* If logged-in user found their own order, show a back-to-orders link too */
        let html = buildResultCard(orderData, isOwner);
        if (isOwner) {
            html += `<button class="tr-back-btn" onclick="loadUserOrders('${currentUid}')">
                        <i class="fa-solid fa-arrow-left"></i> Back to My Orders
                     </button>`;
        }
        showResult(html);

    } catch (err) {
        console.error('Track order error:', err);
        showResult(errorPanel('Something went wrong. Please try again.'));
    } finally {
        const btn = document.getElementById('trackOrderBtn');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>'; }
    }
};

/* ════════════════════════════════════════
   BUILD RESULT CARD
   ════════════════════════════════════════ */
function buildResultCard(order, isOwner) {
    const st      = getStatus(deriveOrderStatus(order));
    const orderId = order.groupOrderId || order.id.slice(0, 8).toUpperCase();

    let dateStr = '—';
    try {
        const d = order.createdAt?.toDate
            ? order.createdAt.toDate()
            : new Date(order.createdAt?.seconds * 1000);
        dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (_) {}

    const isXerox   = order.type === 'xerox';
    const items     = isXerox ? (order.documents || []) : (order.items || []);
    const itemCount = items.length;

    const shopHtml = order.shopName
        ? `<div class="tr-row">
               <span class="tr-label"><i class="fa-solid fa-store"></i> Shop</span>
               <span class="tr-val">${order.shopName}</span>
           </div>`
        : '';

    const addrHtml = isOwner && order.deliveryAddress
        ? `<div class="tr-row">
               <span class="tr-label"><i class="fa-solid fa-location-dot"></i> Deliver To</span>
               <span class="tr-val">${order.deliveryAddress.street}, ${order.deliveryAddress.city}</span>
           </div>`
        : '';

    const trackerHtml = st.step > 0
        ? buildTracker(st.step)
        : `<div class="tr-cancelled">
               <i class="fa-solid fa-triangle-exclamation"></i> Order ${st.label}
           </div>`;

    const detailsLink = isOwner
        ? `<a href="order-details.html?id=${order.id}" class="tr-details-btn">
               View Full Details <i class="fa-solid fa-arrow-right"></i>
           </a>`
        : `<p class="tr-guest-note">
               <i class="fa-solid fa-lock"></i> Sign in to view full order details.
           </p>`;

    return `
    <div class="tr-card">
        <div class="tr-header">
            <div>
                <div class="tr-order-id">ORDER #${orderId}</div>
                <div class="tr-date">${dateStr} · ${itemCount} item${itemCount !== 1 ? 's' : ''}</div>
            </div>
            <span class="tr-badge" style="background:${st.bg}; color:${st.color};">
                <i class="${st.icon}"></i> ${st.label}
            </span>
        </div>
        <div class="tr-rows">${shopHtml}${addrHtml}</div>
        ${trackerHtml}
        <div class="tr-footer">${detailsLink}</div>
    </div>`;
}

/* ════ 4-STEP TRACKER ════ */
function buildTracker(activeStep) {
    const steps = [
        { icon: 'fa-solid fa-hourglass-half', label: 'Placed'     },
        { icon: 'fa-solid fa-gears',           label: 'Processing' },
        { icon: 'fa-solid fa-truck-fast',      label: 'On the Way' },
        { icon: 'fa-solid fa-circle-check',    label: 'Delivered'  },
    ];
    const fill = Math.round(((activeStep - 1) / 3) * 100);
    const stepsHtml = steps.map((s, i) => {
        const idx  = i + 1;
        const cls  = idx < activeStep ? 'tr-step done' : idx === activeStep ? 'tr-step active' : 'tr-step';
        return `<div class="${cls}">
            <div class="tr-step-dot"><i class="${s.icon}"></i></div>
            <span class="tr-step-label">${s.label}</span>
        </div>`;
    }).join('');
    return `
    <div class="tr-tracker">
        <div class="tr-track-line"><div class="tr-track-fill" style="width:${fill}%"></div></div>
        <div class="tr-steps">${stepsHtml}</div>
    </div>`;
}

/* ════ HELPERS ════ */
function errorPanel(msg) {
    return `<div class="tr-error"><i class="fa-solid fa-circle-exclamation"></i> ${msg}</div>`;
}

function showResult(html) {
    const el = document.getElementById('trackResult');
    if (!el) return;
    el.innerHTML = html;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* Expose loadUserOrders globally so the back button can call it */
window.loadUserOrders = loadUserOrders;
