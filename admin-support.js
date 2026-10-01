/* ═══════════════════════════════════════════════
   ADMIN SUPPORT QUERIES — admin-support.js
   Auth:  admin | manage_support
   Reads: support_queries (orderBy createdAt desc)
   Cache: allQueries in-memory, user contacts in
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
let allQueries       = [];
let contactCache     = {};   // uid → { mobile, altMobiles, email }
let _replyId         = null;
let _replyEmail      = '';
let _replySubject    = '';
let _delResolve      = null;

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
        if (!roles.includes('admin') && !roles.includes('manage_support')) {
            window.location.replace('index.html'); return;
        }
    } catch(_) {}

    /* Live Firestore check */
    try {
        const snap  = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin') && !roles.includes('manage_support')) {
            toast('Access denied.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1400);
            return;
        }
        loadQueries();
    } catch(e) {
        console.error('[AdminSupport] auth:', e);
        window.location.replace('index.html');
    }
});

/* ════════════════════════════════
   LOAD
   ════════════════════════════════ */
window.loadQueries = async function() {
    setRefreshing(true);
    try {
        const q    = query(collection(db, 'support_queries'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        allQueries = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        /* Pre-fetch contacts for all unique userIds that have one */
        const uids = [...new Set(allQueries.map(q => q.userId).filter(Boolean))];
        await Promise.all(uids.map(getContact));

        updateStats();
        renderQueries();
    } catch(e) {
        console.error('[AdminSupport] load:', e);
        document.getElementById('queriesList').innerHTML =
            '<div class="ac-table-card"><div class="ac-table-empty" style="color:#ef4444;">Failed to load queries.</div></div>';
        toast('Load failed: ' + e.message, 'error');
    } finally {
        setRefreshing(false);
    }
};

/* ════════════════════════════════
   STATS
   ════════════════════════════════ */
function updateStats() {
    document.getElementById('statTotal').textContent  = allQueries.length;
    document.getElementById('statOpen').textContent   = allQueries.filter(q => q.status === 'open').length;
    document.getElementById('statClosed').textContent = allQueries.filter(q => q.status === 'closed').length;
}

/* ════════════════════════════════
   RENDER
   ════════════════════════════════ */
function renderQueries() {
    const statusF = document.getElementById('filterStatus').value;
    const typeF   = document.getElementById('filterType').value;

    const filtered = allQueries.filter(q => {
        const matchSt = statusF === 'all' || q.status === statusF;
        const matchTy = typeF   === 'all' || q.type   === typeF;
        return matchSt && matchTy;
    });

    const listEl = document.getElementById('queriesList');

    if (!filtered.length) {
        listEl.innerHTML = `
        <div class="ac-table-card">
            <div class="ac-table-empty">
                <i class="fa-solid fa-inbox" style="font-size:2rem;display:block;margin-bottom:10px;"></i>
                No queries match the selected filters.
            </div>
        </div>`;
        return;
    }

    const typeIcon = {
        order:'📦', product:'🛍️', delivery:'🚚',
        payment:'💳', technical:'🔧', feedback:'💬',
        general:'❓', other:'📝'
    };

    listEl.innerHTML = filtered.map(q => {
        const contact = contactCache[q.userId] || null;
        const mobile  = contact?.mobile || q.phone || null;
        const email   = q.email || contact?.email || null;

        /* Contact row */
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
                ${email ? `<button class="ar-icon-btn ar-icon-btn--mail"
                    onclick="window.location.href='mailto:${esc(email)}?subject=Re: ${esc(q.subject)}'"
                    title="Reply by email"><i class="fa-solid fa-envelope"></i></button>` : ''}
            </div>`;
        } else if (email) {
            contactHtml = `
            <div class="ar-contact">
                <span class="ar-contact-num">
                    <i class="fa-solid fa-envelope" style="color:var(--primary);"></i>${esc(email)}
                </span>
                <button class="ar-icon-btn ar-icon-btn--mail"
                    onclick="window.location.href='mailto:${esc(email)}?subject=Re: ${esc(q.subject)}'"
                    title="Reply by email"><i class="fa-solid fa-envelope"></i></button>
            </div>`;
        } else {
            contactHtml = `
            <div class="ar-contact">
                <span class="ar-contact-no-mobile">
                    <i class="fa-solid fa-triangle-exclamation"></i> No contact info saved
                </span>
            </div>`;
        }

        return `
        <div class="ar-card" id="qcard-${q.id}">
            <div class="ar-card-head">
                <div class="ar-card-title">
                    ${typeIcon[q.type] || '❓'} ${esc(q.subject)}
                    <small>
                        <i class="fa-solid fa-user"></i> ${esc(q.name || '—')}
                        &nbsp;·&nbsp;
                        <i class="fa-solid fa-tag"></i> ${esc(q.type || 'general')}
                        &nbsp;·&nbsp;
                        <i class="fa-regular fa-calendar"></i> ${fmtDate(q.createdAt)}
                    </small>
                </div>
                <span class="ar-badge ar-badge-${q.status || 'open'}">
                    ${{ open:'Open', replied:'Replied', closed:'Closed' }[q.status] || q.status || 'Open'}
                </span>
            </div>

            ${contactHtml}

            <div class="ar-body">${esc(q.message)}</div>

            ${q.adminReply ? `
            <div class="ar-reply-block">
                <i class="fa-solid fa-reply"></i>
                <strong>Reply:</strong> ${esc(q.adminReply)}
            </div>` : ''}

            <div class="ar-actions">
                <select class="ar-status-select"
                    onchange="updateStatus('${q.id}', this.value)"
                    title="Change status">
                    <option value="open"    ${q.status==='open'    ?'selected':''}>Open</option>
                    <option value="replied" ${q.status==='replied' ?'selected':''}>Replied</option>
                    <option value="closed"  ${q.status==='closed'  ?'selected':''}>Closed</option>
                </select>
                <button class="ac-btn ac-btn--refresh"
                    onclick="openReplySheet('${q.id}','${esc(q.subject)}','${esc(email||'')}')">
                    <i class="fa-solid fa-reply"></i> ${q.adminReply ? 'Edit Reply' : 'Reply'}
                </button>
                <button class="ar-icon-btn ar-icon-btn--del"
                    onclick="confirmDelete('${q.id}','${esc(q.subject)}')"
                    title="Delete"><i class="fa-solid fa-trash-can"></i></button>
            </div>
        </div>`;
    }).join('');
}

window.renderQueries = renderQueries;

/* ════════════════════════════════
   UPDATE STATUS
   ════════════════════════════════ */
window.updateStatus = async function(id, newStatus) {
    try {
        await updateDoc(doc(db, 'support_queries', id), {
            status:    newStatus,
            updatedAt: serverTimestamp()
        });
        const idx = allQueries.findIndex(q => q.id === id);
        if (idx !== -1) allQueries[idx].status = newStatus;
        updateStats();
        const card = document.getElementById(`qcard-${id}`);
        if (card) {
            const badge = card.querySelector('.ar-badge');
            const lbl   = { open:'Open', replied:'Replied', closed:'Closed' };
            if (badge) {
                badge.className = `ar-badge ar-badge-${newStatus}`;
                badge.textContent = lbl[newStatus] || newStatus;
            }
        }
        toast('Status updated', 'success');
    } catch(e) { toast('Update failed: ' + e.message, 'error'); }
};

/* ════════════════════════════════
   REPLY SHEET
   ════════════════════════════════ */
window.openReplySheet = function(id, subject, email) {
    _replyId      = id;
    _replyEmail   = email   || '';
    _replySubject = subject || 'Query';
    document.getElementById('replySheetSub').textContent = subject || 'Query';
    const existing = allQueries.find(q => q.id === id)?.adminReply || '';
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
        await updateDoc(doc(db, 'support_queries', _replyId), {
            adminReply: text,
            status:     'replied',
            repliedAt:  serverTimestamp(),
            updatedAt:  serverTimestamp()
        });
        const idx = allQueries.findIndex(q => q.id === _replyId);
        if (idx !== -1) {
            allQueries[idx].adminReply = text;
            allQueries[idx].status     = 'replied';
        }
        closeReplySheet();
        updateStats();
        renderQueries();
        toast('Reply saved', 'success');
    } catch(e) { toast('Save failed: ' + e.message, 'error'); }
};

/* ════════════════════════════════
   DELETE
   ════════════════════════════════ */
window.confirmDelete = function(id, subject) {
    document.getElementById('dialogTitle').textContent = 'Delete Query?';
    document.getElementById('dialogMsg').textContent   = `"${subject}" will be permanently deleted.`;
    document.getElementById('delDialog').classList.add('open');

    document.getElementById('dialogConfirmBtn').onclick = async () => {
        closeDelDialog();
        try {
            await deleteDoc(doc(db, 'support_queries', id));
            allQueries = allQueries.filter(q => q.id !== id);
            updateStats();
            renderQueries();
            toast('Query deleted', 'success');
        } catch(e) { toast('Delete failed: ' + e.message, 'error'); }
    };
};

window.closeDelDialog = function() {
    document.getElementById('delDialog').classList.remove('open');
};

/* Close dialog on overlay click */
document.getElementById('delDialog')?.addEventListener('click', e => {
    if (e.target === document.getElementById('delDialog')) closeDelDialog();
});
