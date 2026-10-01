/* ═══════════════════════════════════════════════
   JASA V2 — product-request.js
   User-facing: submit & view own product requests.
   Firestore collection: product_requests
   Fields:
     productName, category, quantity, description,
     urgency, status, userId, userName, userEmail,
     createdAt, updatedAt, reviewed, reply, repliedAt
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import { onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    collection, doc, getDoc, getDocs,
    addDoc, query, where, orderBy,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

/* ── State ── */
let currentUser   = null;
let selectedUrgency = 'low';

/* ── Toast ── */
function toast(msg, type = '') {
    const el = document.getElementById('prToast');
    if (!el) return;
    clearTimeout(el._t);
    el.textContent = msg;
    el.className   = 'pr-toast ' + type;
    el.classList.add('show');
    el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── Urgency selector ── */
window.setUrgency = function(val) {
    selectedUrgency = val;
    ['low','medium','high'].forEach(u => {
        const btn = document.getElementById(`urg${u.charAt(0).toUpperCase() + u.slice(1)}`);
        if (!btn) return;
        btn.className = 'pr-urgency-btn' + (u === val ? ` active-${u}` : '');
    });
};

/* ── Format date ── */
function fmtDate(raw) {
    if (!raw) return '—';
    try {
        const d = raw.toDate ? raw.toDate() : new Date((raw.seconds || 0) * 1000);
        return d.toLocaleDateString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch(_) { return '—'; }
}

function esc(s) {
    return String(s || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Auth guard ── */
onAuthStateChanged(auth, async user => {
    currentUser = user;
    if (!user) {
        /* Not logged in — show login prompt but keep page visible */
        document.getElementById('prHistoryList').innerHTML = `
            <div class="pr-empty">
                <i class="fa-solid fa-user-lock"></i>
                <div>Sign in to view your past requests</div>
                <a href="login.html" style="
                    display:inline-flex;align-items:center;gap:6px;margin-top:10px;
                    padding:8px 18px;background:var(--primary);color:#fff;
                    border-radius:50px;font-size:.78rem;font-weight:800;text-decoration:none;">
                    <i class="fa-solid fa-right-to-bracket"></i> Sign In
                </a>
            </div>`;
        return;
    }
    loadHistory();
});

/* ── Submit request ── */
window.submitRequest = async function() {
    if (!currentUser) {
        toast('Please sign in to submit a request.', 'error');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }

    const name = document.getElementById('prProductName')?.value.trim();
    const cat  = document.getElementById('prCategory')?.value;
    const qty  = parseInt(document.getElementById('prQty')?.value || '1', 10);
    const desc = document.getElementById('prDesc')?.value.trim();

    if (!name) { toast('Please enter the product name.', 'error'); return; }
    if (!cat)  { toast('Please select a category.', 'error'); return; }
    if (qty < 1 || isNaN(qty)) { toast('Enter a valid quantity.', 'error'); return; }

    const btn = document.getElementById('prSubmitBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…';

    try {
        /* Get user profile for name & email */
        let userName  = currentUser.displayName || currentUser.email?.split('@')[0] || 'User';
        let userEmail = currentUser.email || '';
        try {
            const raw = localStorage.getItem('jasa_user_cache');
            if (raw) {
                const cached = JSON.parse(raw);
                if (cached.fullName) userName  = cached.fullName;
                if (cached.email)    userEmail = cached.email;
            }
        } catch(_) {}

        await addDoc(collection(db, 'product_requests'), {
            productName:  name,
            category:     cat,
            quantity:     qty,
            description:  desc || '',
            urgency:      selectedUrgency,
            status:       'pending',
            reviewed:     false,
            userId:       currentUser.uid,
            userName,
            userEmail,
            createdAt:    serverTimestamp(),
            updatedAt:    serverTimestamp(),
        });

        toast('Request submitted!', 'success');

        /* Reset form */
        document.getElementById('prProductName').value = '';
        document.getElementById('prCategory').value    = '';
        document.getElementById('prQty').value         = '1';
        document.getElementById('prDesc').value        = '';
        setUrgency('low');

        /* Reload history */
        loadHistory();
    } catch (e) {
        console.error('[ProductRequest] submit error:', e);
        toast('Failed to submit. Try again.', 'error');
    } finally {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Request';
    }
};

/* ── Load user's own history ── */
async function loadHistory() {
    if (!currentUser) return;
    const listEl = document.getElementById('prHistoryList');

    /* Instant render from sessionStorage */
    const CACHE_KEY = `jasa_pr_history_${currentUser.uid}`;
    try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        if (raw) {
            const { data, ts } = JSON.parse(raw);
            if (Date.now() - ts < 5 * 60 * 1000 && Array.isArray(data)) {
                renderHistory(data);
                return;
            }
        }
    } catch(_) {}

    listEl.innerHTML = '<div class="pr-empty"><i class="fa-solid fa-spinner fa-spin"></i>Loading…</div>';

    try {
        const q    = query(
            collection(db, 'product_requests'),
            where('userId', '==', currentUser.uid),
            orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        /* Cache for 5 min */
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
        } catch(_) {}

        renderHistory(data);
    } catch (e) {
        console.error('[ProductRequest] history error:', e);
        listEl.innerHTML = `
            <div class="pr-empty">
                <i class="fa-solid fa-circle-exclamation" style="color:#ef4444;"></i>
                Failed to load history.
            </div>`;
    }
}

/* ── Render history list ── */
function renderHistory(items) {
    const listEl = document.getElementById('prHistoryList');
    if (!items.length) {
        listEl.innerHTML = `
            <div class="pr-empty">
                <i class="fa-solid fa-inbox"></i>
                No requests yet. Submit your first one above!
            </div>`;
        return;
    }

    const urgencyIcon = { high:'🔴', medium:'🟡', low:'🟢' };
    const catLabel    = {
        books:'Books', stationary:'Stationary',
        electronic:'Electronic / Kits', posters:'Wall Posters', xerox:'Xerox / Printing', other:'Other'
    };

    listEl.innerHTML = items.map(r => {
        const statusClass = r.reviewed ? 'pr-status-reviewed' : 'pr-status-pending';
        const statusLabel = r.reviewed ? 'Reviewed' : 'Pending';

        return `
        <div class="pr-req-item">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;">
                <div class="pr-req-name">
                    ${urgencyIcon[r.urgency] || '⚪'} ${esc(r.productName)}
                </div>
                <span class="pr-status-badge ${statusClass}">${statusLabel}</span>
            </div>
            <div class="pr-req-meta">
                <span><i class="fa-solid fa-tag"></i>${esc(catLabel[r.category] || r.category)}</span>
                <span><i class="fa-solid fa-cubes"></i>Qty: ${r.quantity || 1}</span>
                <span><i class="fa-regular fa-calendar"></i>${fmtDate(r.createdAt)}</span>
            </div>
            ${r.description ? `
            <div style="font-size:.75rem;color:var(--txt3);font-weight:500;line-height:1.45;margin-bottom:6px;">
                ${esc(r.description)}
            </div>` : ''}
            ${r.reply ? `
            <div class="pr-req-reply">
                <strong><i class="fa-solid fa-reply" style="margin-right:5px;"></i>Admin Reply:</strong> ${esc(r.reply)}
            </div>` : ''}
        </div>`;
    }).join('');
}
