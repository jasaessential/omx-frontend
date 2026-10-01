/* ═══════════════════════════════════════════════
   ADMIN SUPPORT REQUESTS — admin-support-requests.js
   Auth: admin OR manage_support
   Reads: support_queries collection
   Actions: update status, reply, delete
   User contact: cached from users/{userId}
   ═══════════════════════════════════════════════ */
import { auth, db }           from './firebase-init.js';
import { onAuthStateChanged }  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    collection, doc, getDoc, getDocs, deleteDoc,
    updateDoc, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

let allQueries        = [];
let currentFilter     = 'all';
let _replyId          = null;
let _searchQuery      = '';
let _searchTimer      = null;
let userContactCache  = {};

/* ── Toast ── */
function toast(msg, type = '') {
    const el = document.getElementById('acToast');
    el.textContent = msg; el.className = 'ac-toast ' + type;
    void el.offsetWidth; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── Escape HTML ── */
function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Format date ── */
function fmtDate(raw) {
    if (!raw) return '—';
    try {
        const d = raw.toDate ? raw.toDate() : new Date((raw.seconds || 0) * 1000);
        return d.toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    } catch (_) { return '—'; }
}

/* ── Confirm dialog (Promise) ── */
function showConfirm(title, msg) {
    return new Promise(resolve => {
        const overlay  = document.getElementById('acDialogOverlay');
        const titleEl  = document.getElementById('acDialogTitle');
        const msgEl    = document.getElementById('acDialogMsg');
        const confirmB = document.getElementById('acDialogConfirm');
        const cancelB  = document.getElementById('acDialogCancel');

        titleEl.textContent = title;
        msgEl.textContent   = msg;
        overlay.classList.add('open');

        function cleanup(result) {
            overlay.classList.remove('open');
            confirmB.removeEventListener('click', onConfirm);
            cancelB.removeEventListener('click',  onCancel);
            resolve(result);
        }
        function onConfirm() { cleanup(true); }
        function onCancel()  { cleanup(false); }

        confirmB.addEventListener('click', onConfirm);
        cancelB.addEventListener('click',  onCancel);
    });
}

/* ── Get type icon ── */
function typeIcon(type) {
    const map = {
        order:     '📦',
        product:   '🛍️',
        delivery:  '🚚',
        payment:   '💳',
        technical: '🔧',
        feedback:  '💬',
        general:   '❓',
        other:     '❓'
    };
    return map[(type || '').toLowerCase()] || '❓';
}

/* ── Status badge ── */
function statusBadge(status) {
    const map = {
        open:    { bg:'#fef3c7', color:'#b45309', label:'Open' },
        replied: { bg:'#dbeafe', color:'#1d4ed8', label:'Replied' },
        closed:  { bg:'#dcfce7', color:'#16a34a', label:'Closed' }
    };
    const s = map[(status || 'open').toLowerCase()] || map['open'];
    return `<span style="background:${s.bg};color:${s.color};padding:3px 10px;border-radius:50px;font-size:.62rem;font-weight:800;flex-shrink:0;">${s.label}</span>`;
}

/* ── Get/cache user contact ── */
async function getUserContact(uid) {
    if (!uid) return null;
    // 1. memory cache
    if (userContactCache[uid]) return userContactCache[uid];
    // 2. sessionStorage cache
    const ssKey = `jasa_contact_${uid}`;
    try {
        const cached = sessionStorage.getItem(ssKey);
        if (cached) {
            const parsed = JSON.parse(cached);
            userContactCache[uid] = parsed;
            return parsed;
        }
    } catch (_) {}
    // 3. Firestore fetch
    try {
        const snap = await getDoc(doc(db, 'users', uid));
        const data = snap.exists() ? snap.data() : {};
        const contact = {
            mobile:     data.mobile     || data.phone     || '',
            altMobiles: data.altMobiles || data.altPhones || [],
            email:      data.email      || ''
        };
        userContactCache[uid] = contact;
        try { sessionStorage.setItem(ssKey, JSON.stringify(contact)); } catch (_) {}
        return contact;
    } catch (_) { return null; }
}

/* ── Auth guard ── */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search)); return; }
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
    } catch (e) { console.error(e); window.location.replace('index.html'); }
});

/* ── Load queries ── */
window.loadQueries = async function() {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    try {
        const q    = query(collection(db, 'support_queries'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        allQueries = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Fetch contacts for all unique userIds
        const uids = [...new Set(allQueries.map(q => q.userId).filter(Boolean))];
        await Promise.all(uids.map(uid => getUserContact(uid)));

        updateStats();
        renderList();
    } catch (e) {
        document.getElementById('queriesList').innerHTML =
            '<div class="ac-table-card"><div class="ac-table-empty" style="color:#ef4444;">Failed to load support queries.</div></div>';
    } finally {
        btn.classList.remove('spinning');
    }
};

/* ── Update stats ── */
function updateStats() {
    document.getElementById('statTotal').textContent  = allQueries.length;
    document.getElementById('statOpen').textContent   = allQueries.filter(q => (q.status || 'open') === 'open').length;
    document.getElementById('statClosed').textContent = allQueries.filter(q => q.status === 'closed').length;
}

/* ── Filter tab ── */
window.setTab = function(f, btn) {
    currentFilter = f;
    document.querySelectorAll('.ac-cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderList();
};

/* ── Debounced search ── */
window.onSearch = function(val) {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
        _searchQuery = val.trim().toLowerCase();
        renderList();
    }, 220);
};

/* ── Render list ── */
function renderList() {
    let filtered = allQueries.filter(q => {
        if (currentFilter !== 'all') {
            const s = (q.status || 'open').toLowerCase();
            if (s !== currentFilter) return false;
        }
        if (_searchQuery) {
            const haystack = [q.subject, q.name, q.userName, q.message].join(' ').toLowerCase();
            if (!haystack.includes(_searchQuery)) return false;
        }
        return true;
    });

    const list = document.getElementById('queriesList');

    if (!filtered.length) {
        list.innerHTML = `
        <div class="ac-table-card">
            <div class="ac-table-empty">
                <i class="fa-solid fa-headset" style="font-size:2rem;display:block;margin-bottom:10px;"></i>
                No ${currentFilter === 'all' ? '' : currentFilter + ' '}queries found.
            </div>
        </div>`;
        return;
    }

    list.innerHTML = filtered.map(q => {
        const contact   = userContactCache[q.userId] || null;
        const hasMobile = contact && contact.mobile;
        const mobile    = hasMobile ? contact.mobile : '';

        const contactRow = q.userId
            ? (hasMobile
                ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;padding:8px 10px;background:var(--bg);border-radius:var(--r-xs);">
                    <i class="fa-solid fa-phone" style="color:var(--primary);font-size:.8rem;"></i>
                    <span style="font-size:.78rem;font-weight:700;color:var(--txt1);">${esc(mobile)}</span>
                    <a href="tel:${esc(mobile)}" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:50px;background:var(--primary-light);color:var(--primary);font-size:.7rem;font-weight:800;text-decoration:none;">
                        <i class="fa-solid fa-phone"></i> Call
                    </a>
                    <a href="https://wa.me/${esc(mobile.replace(/\D/g,''))}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:50px;background:#dcfce7;color:#16a34a;font-size:.7rem;font-weight:800;text-decoration:none;">
                        <i class="fa-brands fa-whatsapp"></i> WhatsApp
                    </a>
                  </div>`
                : `<div style="display:flex;align-items:center;gap:6px;margin-top:8px;padding:7px 10px;background:#fff3cd;border-radius:var(--r-xs);">
                    <i class="fa-solid fa-triangle-exclamation" style="color:#b45309;font-size:.8rem;"></i>
                    <span style="font-size:.74rem;font-weight:600;color:#b45309;">No number saved</span>
                   </div>`)
            : '';

        return `
        <div class="ac-table-card" style="margin-bottom:10px;padding:14px;">
            <!-- Header row -->
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;">
                <div style="display:flex;align-items:flex-start;gap:10px;min-width:0;flex:1;">
                    <span style="font-size:1.4rem;flex-shrink:0;line-height:1.2;">${typeIcon(q.type)}</span>
                    <div style="min-width:0;">
                        <div style="font-size:.88rem;font-weight:800;color:var(--txt1);">${esc(q.subject || 'No Subject')}</div>
                        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px;">
                            <span style="font-size:.62rem;font-weight:700;padding:2px 8px;border-radius:50px;background:var(--bg);border:1px solid var(--border2);color:var(--txt3);">${esc((q.type||'general').charAt(0).toUpperCase()+(q.type||'general').slice(1))}</span>
                            ${statusBadge(q.status || 'open')}
                        </div>
                    </div>
                </div>
                <div style="font-size:.65rem;color:var(--txt3);white-space:nowrap;flex-shrink:0;">${fmtDate(q.createdAt)}</div>
            </div>

            <!-- Message -->
            ${q.message ? `<div style="font-size:.78rem;color:var(--txt2);line-height:1.55;margin-bottom:8px;padding:8px 10px;background:var(--bg);border-radius:var(--r-xs);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">${esc(q.message)}</div>` : ''}

            <!-- User info -->
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;">
                <i class="fa-solid fa-user" style="font-size:.72rem;color:var(--txt3);"></i>
                <span style="font-size:.74rem;font-weight:700;color:var(--txt1);">${esc(q.userName || q.name || 'Anonymous')}</span>
                ${q.userEmail || q.email ? `<span style="font-size:.7rem;color:var(--txt3);">· ${esc(q.userEmail || q.email)}</span>` : ''}
            </div>

            <!-- Contact row -->
            ${contactRow}

            <!-- Admin reply -->
            ${q.reply ? `
            <div style="font-size:.76rem;color:var(--primary);background:var(--primary-faint);border:1px solid var(--primary-light);border-radius:var(--r-xs);padding:8px 10px;margin-top:8px;">
                <i class="fa-solid fa-reply" style="margin-right:5px;"></i><strong>Reply:</strong> ${esc(q.reply)}
                ${q.repliedAt ? `<span style="font-size:.62rem;color:var(--txt3);margin-left:8px;">${fmtDate(q.repliedAt)}</span>` : ''}
            </div>` : ''}

            <!-- Actions -->
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center;">
                <select onchange="updateStatus('${esc(q.id)}', this.value)"
                    style="height:34px;padding:0 10px;border-radius:var(--r-sm);border:1.5px solid var(--border2);background:var(--bg-white);color:var(--txt2);font-family:inherit;font-size:.76rem;font-weight:700;cursor:pointer;outline:none;">
                    <option value="open"    ${(q.status||'open')==='open'    ? 'selected' : ''}>Open</option>
                    <option value="replied" ${(q.status||'')==='replied'     ? 'selected' : ''}>Replied</option>
                    <option value="closed"  ${(q.status||'')==='closed'      ? 'selected' : ''}>Closed</option>
                </select>
                <button class="ac-btn" onclick="openReplySheet('${esc(q.id)}','${esc(q.subject||'')}')"
                    style="background:var(--bg);color:var(--txt2);border:1.5px solid var(--border2);">
                    <i class="fa-solid fa-reply"></i> ${q.reply ? 'Edit Reply' : 'Reply'}
                </button>
                <button class="ac-btn" onclick="deleteQuery('${esc(q.id)}','${esc(q.subject||'No Subject')}')"
                    style="background:#fee2e2;color:#dc2626;border:none;">
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </div>
        </div>`;
    }).join('');
}

/* ── Update status ── */
window.updateStatus = async function(id, newStatus) {
    try {
        await updateDoc(doc(db, 'support_queries', id), { status: newStatus, updatedAt: serverTimestamp() });
        const idx = allQueries.findIndex(q => q.id === id);
        if (idx !== -1) allQueries[idx].status = newStatus;
        updateStats();
        renderList();
        toast('Status updated', 'success');
    } catch (e) { toast('Update failed: ' + e.message, 'error'); }
};

/* ── Delete query ── */
window.deleteQuery = async function(id, subject) {
    const confirmed = await showConfirm('Delete Query?', `"${subject}" will be permanently deleted.`);
    if (!confirmed) return;
    try {
        await deleteDoc(doc(db, 'support_queries', id));
        allQueries = allQueries.filter(q => q.id !== id);
        updateStats();
        renderList();
        toast('Query deleted', 'success');
    } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
};

/* ── Reply sheet ── */
window.openReplySheet = function(id, subject) {
    _replyId = id;
    document.getElementById('replySheetSub').textContent = subject || 'Query';
    const existing = allQueries.find(q => q.id === id)?.reply || '';
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
    if (!text) { toast('Please enter a reply.', ''); return; }
    try {
        await updateDoc(doc(db, 'support_queries', _replyId), {
            reply:     text,
            repliedAt: serverTimestamp(),
            status:    'replied'
        });
        const idx = allQueries.findIndex(q => q.id === _replyId);
        if (idx !== -1) {
            allQueries[idx].reply  = text;
            allQueries[idx].status = 'replied';
        }
        closeReplySheet();
        updateStats();
        renderList();
        toast('Reply saved', 'success');
    } catch (e) { toast('Save failed: ' + e.message, 'error'); }
};
