/* ═══════════════════════════════════════════════
   ADMIN PRODUCT REQUESTS — admin-product-requests.js
   Auth:  admin | manage_requests
   Reads: product_requests (orderBy createdAt desc)
   Cache: allRequests in-memory, user contacts in
          sessionStorage (user_contact_{uid})
   Actions: update status, reply, delete
   ═══════════════════════════════════════════════ */
import { auth, db }          from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    collection, doc, getDoc, getDocs,
    updateDoc, deleteDoc,
    query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

/* ── State ── */
let allRequests   = [];
let contactCache  = {};   // uid → { mobile, altMobiles, email }
let currentFilter = 'all';
let _replyId      = null;

/* ════════════════════════════════
   HELPERS
   ════════════════════════════════ */
function toast(msg, type = '') {
    const el = document.getElementById('acToast');
    el.textContent = msg;
    el.className   = 'ac-toast ' + type;
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

function esc(s) {
    return String(s || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(raw) {
    if (!raw) return '—';
    try {
        const d = raw.toDate ? raw.toDate() : new Date((raw.seconds||0)*1000);
        return d.toLocaleString('en-IN', {
            day:'2-digit', month:'short', year:'numeric',
            hour:'2-digit', minute:'2-digit'
        });
    } catch(_) { return '—'; }
}

function setRefreshing(on) {
    document.getElementById('refreshBtn').classList.toggle('spinning', on);
}

/* ── Contact lookup with sessionStorage cache ── */
async function getContact(uid) {
    if (!uid) return null;
    if (contactCache[uid]) return contactCache[uid];

    const KEY = `user_contact_${uid}`;
    try {
        const raw = sessionStorage.getItem(KEY);
        if (raw) { const d = JSON.parse(raw); contactCache[uid] = d; return d; }
    } catch(_) {}

    try {
        const snap = await getDoc(doc(db, 'users', uid));
        if (snap.exists()) {
            const u = snap.data();
            const d = {
                mobile:     u.mobileNumber || null,
                altMobiles: u.altMobiles   || [],
                email:      u.email        || null
            };
            contactCache[uid] = d;
            sessionStorage.setItem(KEY, JSON.stringify(d));
            return d;
        }
    } catch(_) {}
    return null;
}

/* ════════════════════════════════
   AUTH GUARD
   ════════════════════════════════ */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search)); return; }

    /* Fast cache check */
    try {
        const raw   = localStorage.getItem('jasa_user_cache');
        const cd    = raw ? JSON.parse(raw) : null;
        const roles = cd?.roles || [cd?.role || 'user'];
        if (!roles.includes('admin') && !roles.includes('manage_requests')) {
            window.location.replace('index.html'); return;
        }
    } catch(_) {}

    /* Live Firestore check */
    try {
        const snap  = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin') && !roles.includes('manage_requests')) {
            toast('Access denied.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1400);
            return;
        }
        loadRequests();
    } catch(e) {
        console.error('[AdminRequests] auth:', e);
        window.location.replace('index.html');
    }
});

/* ════════════════════════════════
   LOAD
   ════════════════════════════════ */
window.loadRequests = async function() {
    setRefreshing(true);
    try {
        const q    = query(collection(db, 'product_requests'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        allRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        /* Pre-fetch contacts for all unique userIds */
        const uids = [...new Set(allRequests.map(r => r.userId).filter(Boolean))];
        await Promise.all(uids.map(getContact));

        updateStats();
        renderList();
    } catch(e) {
        console.error('[AdminRequests] load:', e);
        document.getElementById('requestsList').innerHTML =
            '<div class="ac-table-card"><div class="ac-table-empty" style="color:#ef4444;">Failed to load requests.</div></div>';
        toast('Load failed: ' + e.message, 'error');
    } finally {
        setRefreshing(false);
    }
};

/* ════════════════════════════════
   STATS
   ════════════════════════════════ */
function updateStats() {
    const pending   = allRequests.filter(r => r.status === 'pending'  || (!r.status && !r.reviewed)).length;
    const reviewed  = allRequests.filter(r => r.status === 'reviewed' ||  r.reviewed).length;
    const completed = allRequests.filter(r => r.status === 'completed').length;
    document.getElementById('statTotal').textContent     = allRequests.length;
    document.getElementById('statPending').textContent   = pending;
    document.getElementById('statReviewed').textContent  = reviewed;
    document.getElementById('statCompleted').textContent = completed;
}

/* ════════════════════════════════
   FILTER TAB
   ════════════════════════════════ */
window.setTab = function(f, btn) {
    currentFilter = f;
    document.querySelectorAll('.ac-cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderList();
};

/* ════════════════════════════════
   RENDER
   ════════════════════════════════ */
function renderList() {
    const filtered = allRequests.filter(r => {
        const status = r.status || (r.reviewed ? 'reviewed' : 'pending');
        if (currentFilter === 'pending')   return status === 'pending';
        if (currentFilter === 'reviewed')  return status === 'reviewed';
        if (currentFilter === 'completed') return status === 'completed';
        return true;
    });

    const listEl = document.getElementById('requestsList');

    if (!filtered.length) {
        listEl.innerHTML = `
        <div class="ac-table-card">
            <div class="ac-table-empty">
                <i class="fa-solid fa-inbox" style="font-size:2rem;display:block;margin-bottom:10px;"></i>
                No ${currentFilter !== 'all' ? currentFilter + ' ' : ''}requests found.
            </div>
        </div>`;
        return;
    }

    const catLabel = {
        books:'Books', stationary:'Stationary',
        electronic:'Electronic / Kits', posters:'Wall Posters', xerox:'Xerox / Printing', other:'Other'
    };

    listEl.innerHTML = filtered.map(r => {
        const contact = contactCache[r.userId] || null;
        const mobile  = contact?.mobile || null;
        const email   = r.userEmail || contact?.email || null;
        const altMobs = contact?.altMobiles?.length ? contact.altMobiles : [];

        const status  = r.status || (r.reviewed ? 'reviewed' : 'pending');

        /* Contact section */
        let contactHtml = '';
        if (mobile) {
            const clean = mobile.toString().replace(/\D/g,'').slice(-10);
            contactHtml = `
            <div class="ar-contact">
                <span class="ar-contact-num">
                    <i class="fa-solid fa-phone"></i>${mobile}
                </span>
                <button class="ar-icon-btn ar-icon-btn--call"
                    onclick="window.location.href='tel:${clean}'"
                    title="Call"><i class="fa-solid fa-phone"></i></button>
                <button class="ar-icon-btn ar-icon-btn--wa"
                    onclick="window.open('https://wa.me/91${clean}','_blank')"
                    title="WhatsApp"><i class="fa-brands fa-whatsapp"></i></button>
                ${altMobs.length ? `<span class="ar-alt-mobiles">Alt: ${altMobs.join(', ')}</span>` : ''}
            </div>`;
        } else {
            contactHtml = `
            <div class="ar-contact">
                <span class="ar-contact-no-mobile">
                    <i class="fa-solid fa-triangle-exclamation"></i> No mobile number saved
                </span>
            </div>`;
        }

        /* Urgency */
        const urgClass = { high:'ar-urgency-high', medium:'ar-urgency-medium', low:'ar-urgency-low' };
        const urgIcon  = { high:'🔴', medium:'🟡', low:'🟢' };
        const urgLabel = { high:'High', medium:'Medium', low:'Low' };

        return `
        <div class="ar-card" id="rcard-${r.id}">

            <div class="ar-card-head">
                <div class="ar-card-title">
                    ${esc(r.productName || 'Unnamed Product')}
                    <small>
                        <i class="fa-solid fa-user"></i> ${esc(r.userName || 'Anonymous')}
                        ${email ? `&nbsp;·&nbsp;<i class="fa-solid fa-envelope"></i> ${esc(email)}` : ''}
                        &nbsp;·&nbsp;<i class="fa-regular fa-calendar"></i> ${fmtDate(r.createdAt)}
                    </small>
                </div>
                <span class="ar-badge ar-badge-${status}">
                    ${status.charAt(0).toUpperCase() + status.slice(1)}
                </span>
            </div>

            <div class="ar-meta">
                <span><i class="fa-solid fa-tag"></i>${esc(catLabel[r.category] || r.category || '—')}</span>
                <span><i class="fa-solid fa-cubes"></i>Qty: ${r.quantity || 1}</span>
                ${r.urgency ? `<span class="ar-urgency ${urgClass[r.urgency] || ''}">
                    ${urgIcon[r.urgency] || ''} ${urgLabel[r.urgency] || r.urgency}
                </span>` : ''}
            </div>

            ${contactHtml}

            ${r.description ? `<div class="ar-body">${esc(r.description)}</div>` : ''}

            ${r.reply ? `
            <div class="ar-reply-block">
                <i class="fa-solid fa-reply"></i>
                <strong>Reply:</strong> ${esc(r.reply)}
            </div>` : ''}

            <div class="ar-actions">
                <select class="ar-status-select"
                    onchange="updateStatus('${r.id}',this.value)"
                    title="Update status">
                    <option value="pending"   ${status==='pending'  ?'selected':''}>Pending</option>
                    <option value="reviewed"  ${status==='reviewed' ?'selected':''}>Reviewed</option>
                    <option value="completed" ${status==='completed'?'selected':''}>Completed</option>
                </select>
                <button class="ac-btn ac-btn--refresh"
                    onclick="openReplySheet('${r.id}','${esc(r.productName||'')}')">
                    <i class="fa-solid fa-reply"></i> ${r.reply ? 'Edit Reply' : 'Reply'}
                </button>
                <button class="ar-icon-btn ar-icon-btn--del"
                    onclick="confirmDelete('${r.id}','${esc(r.productName||'this request')}')"
                    title="Delete"><i class="fa-solid fa-trash-can"></i></button>
            </div>
        </div>`;
    }).join('');
}

/* ════════════════════════════════
   UPDATE STATUS
   ════════════════════════════════ */
window.updateStatus = async function(id, newStatus) {
    try {
        await updateDoc(doc(db, 'product_requests', id), {
            status:     newStatus,
            reviewed:   newStatus !== 'pending',
            updatedAt:  serverTimestamp()
        });
        const idx = allRequests.findIndex(r => r.id === id);
        if (idx !== -1) {
            allRequests[idx].status   = newStatus;
            allRequests[idx].reviewed = newStatus !== 'pending';
        }
        updateStats();
        toast('Status updated', 'success');
    } catch(e) { toast('Update failed: ' + e.message, 'error'); }
};

/* ════════════════════════════════
   REPLY SHEET
   ════════════════════════════════ */
window.openReplySheet = function(id, name) {
    _replyId = id;
    document.getElementById('replySheetSub').textContent = name || 'Request';
    const existing = allRequests.find(r => r.id === id)?.reply || '';
    document.getElementById('replyText').value = existing;
    document.getElementById('replyOverlay').classList.add('open');
    document.getElementById('replySheet').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.closeReplySheet = function() {
    document.getElementById('replyOverlay').classList.remove('open');
    document.getElementById('replySheet').classList.remove('open');
    document.body.style.overflow = '';
    _replyId = null;
};

window.submitReply = async function() {
    if (!_replyId) return;
    const text = document.getElementById('replyText').value.trim();
    if (!text) { toast('Enter a reply first.', ''); return; }
    try {
        await updateDoc(doc(db, 'product_requests', _replyId), {
            reply:     text,
            repliedAt: serverTimestamp(),
            reviewed:  true,
            status:    'reviewed',
            updatedAt: serverTimestamp()
        });
        const idx = allRequests.findIndex(r => r.id === _replyId);
        if (idx !== -1) {
            allRequests[idx].reply    = text;
            allRequests[idx].reviewed = true;
            allRequests[idx].status   = 'reviewed';
        }
        closeReplySheet();
        updateStats();
        renderList();
        toast('Reply saved', 'success');
    } catch(e) { toast('Save failed: ' + e.message, 'error'); }
};

/* ════════════════════════════════
   DELETE
   ════════════════════════════════ */
window.confirmDelete = function(id, name) {
    document.getElementById('dialogTitle').textContent = 'Delete Request?';
    document.getElementById('dialogMsg').textContent   = `"${name}" will be permanently deleted.`;
    document.getElementById('delDialog').classList.add('open');

    document.getElementById('dialogConfirmBtn').onclick = async () => {
        closeDelDialog();
        try {
            await deleteDoc(doc(db, 'product_requests', id));
            allRequests = allRequests.filter(r => r.id !== id);
            updateStats();
            renderList();
            toast('Request deleted', 'success');
        } catch(e) { toast('Delete failed: ' + e.message, 'error'); }
    };
};

window.closeDelDialog = function() {
    document.getElementById('delDialog').classList.remove('open');
};

document.getElementById('delDialog')?.addEventListener('click', e => {
    if (e.target === document.getElementById('delDialog')) closeDelDialog();
});
