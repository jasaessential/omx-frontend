/* ═══════════════════════════════════════════════
   MANAGE USERS — Admin only
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import {
    collection, getDocs, query, orderBy,
    where, updateDoc, doc, getDoc
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

/* ─────────── State ─────────── */
let allUsers     = [];
let currentFilter = 'all';
let currentEditId = null;   // Firestore doc id of user being edited

/* ─────────── DOM refs ─────────── */
const searchForm      = document.getElementById('searchForm');
const searchEmailEl   = document.getElementById('searchEmail');
const resultPanel     = document.getElementById('resultPanel');
const userListEl      = document.getElementById('userList');
const userCountEl     = document.getElementById('userCount');
const updateBtn       = document.getElementById('updateBtn');
const rEmp            = document.getElementById('r-emp');
const rItems          = document.getElementById('r-items');
const empPermsSection = document.getElementById('empPermsSection');

/* ─────────── Helpers ─────────── */
function showToast(msg, type = '') {
    const t = document.getElementById('muToast');
    t.textContent = msg;
    t.className   = 'mu-toast ' + type;
    void t.offsetWidth;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2800);
}

window.copyText = function(text) {
    if (!text || text === '—') return;
    navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));
};

function fmtDate(raw) {
    if (!raw) return 'N/A';
    try {
        const d = raw.toDate ? raw.toDate() : (raw.seconds ? new Date(raw.seconds * 1000) : new Date(raw));
        if (isNaN(d)) return 'N/A';
        return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return 'N/A'; }
}

function highestRole(roles) {
    const p = { admin: 4, seller: 3, employee: 2, user: 1 };
    return (roles || ['user']).reduce((h, r) => (p[r] || 0) > (p[h] || 0) ? r : h, roles?.[0] || 'user');
}

function roleBadgeClass(role) {
    return ({ admin: 'mu-role-badge--admin', seller: 'mu-role-badge--seller', employee: 'mu-role-badge--employee' })[role] || 'mu-role-badge--user';
}

/* ─────────── Employee permission toggle ─────────── */
function syncEmpPerms() {
    empPermsSection.style.display = rEmp.checked ? 'flex' : 'none';
    if (!rEmp.checked) {
        document.querySelectorAll('#empPermsSection input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    }
}

rEmp.addEventListener('change', syncEmpPerms);

// manage_items also requires employee
rItems.addEventListener('change', () => {
    if (rItems.checked) { rEmp.checked = true; syncEmpPerms(); }
});

// any manage_* perm → auto-check employee
document.querySelectorAll('#empPermsSection input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
        if (cb.checked) { rEmp.checked = true; syncEmpPerms(); }
    });
});

/* ─────────── Search ─────────── */
searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = searchEmailEl.value.trim().toLowerCase();
    if (!email) return;

    const btn = document.getElementById('searchBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching…';

    try {
        const q = query(collection(db, 'users'), where('email', '==', email));
        const snap = await getDocs(q);

        if (snap.empty) {
            showToast('No user found with that email.', 'error');
            resultPanel.style.display = 'none';
            return;
        }

        const docSnap  = snap.docs[0];
        const userData = docSnap.data();
        currentEditId  = docSnap.id;

        document.getElementById('resName').textContent   = userData.fullName || 'Unknown';
        document.getElementById('resEmail').textContent  = userData.email    || email;
        document.getElementById('resAvatar').textContent = (userData.fullName || 'U').charAt(0).toUpperCase();

        // Pre-check existing roles
        const roles = userData.roles || (userData.role ? [userData.role] : ['user']);
        document.querySelectorAll('input[name="role"]').forEach(cb => {
            cb.checked = roles.includes(cb.value);
        });
        syncEmpPerms();

        resultPanel.style.display = 'flex';
    } catch (err) {
        showToast('Search failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-search"></i> Search';
    }
});

/* ─────────── Update roles ─────────── */
updateBtn.addEventListener('click', async () => {
    if (!currentEditId) return;

    const selected = Array.from(document.querySelectorAll('input[name="role"]:checked')).map(cb => cb.value);
    if (!selected.includes('user')) selected.push('user');   // always keep base role

    updateBtn.disabled = true;
    updateBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        await updateDoc(doc(db, 'users', currentEditId), {
            roles: selected,
            role:  selected.find(r => r !== 'user') || 'user'  // keep legacy role field
        });
        showToast('Roles updated successfully!', 'success');
        resultPanel.style.display = 'none';
        searchEmailEl.value = '';
        currentEditId = null;
        fetchUsers();   // refresh list
    } catch (err) {
        showToast('Update failed: ' + err.message, 'error');
    } finally {
        updateBtn.disabled = false;
        updateBtn.innerHTML = '<i class="fa-solid fa-check"></i> Update';
    }
});

/* ─────────── Filter bar ─────────── */
document.querySelectorAll('.mu-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelector('.mu-filter-btn.active').classList.remove('active');
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderUsers();
    });
});

/* ─────────── Fetch all users ─────────── */
async function fetchUsers() {
    userListEl.innerHTML = `
        <div class="mu-skeleton">
            <div class="mu-skeleton-row"></div>
            <div class="mu-skeleton-row"></div>
            <div class="mu-skeleton-row"></div>
        </div>`;
    userCountEl.textContent = 'Loading…';

    try {
        const q    = query(collection(db, 'users'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        allUsers   = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
        updateStats();
        renderUsers();
    } catch (err) {
        userListEl.innerHTML = `<div class="mu-empty"><i class="fa-solid fa-triangle-exclamation"></i>Failed to load users.</div>`;
        userCountEl.textContent = '';
        console.error('[ManageUsers] fetchUsers error:', err);
    }
}

/* ─────────── Stats ─────────── */
function updateStats() {
    const total     = allUsers.length;
    const userOnly  = allUsers.filter(u => {
        const r = u.roles || [u.role || 'user'];
        // "user role only" = has no role beyond 'user'
        return r.every(x => x === 'user');
    }).length;
    const employees = allUsers.filter(u => (u.roles || [u.role || 'user']).includes('employee')).length;
    const sellers   = allUsers.filter(u => (u.roles || [u.role || 'user']).includes('seller')).length;
    const admins    = allUsers.filter(u => (u.roles || [u.role || 'user']).includes('admin')).length;

    document.getElementById('statTotal').textContent     = total;
    document.getElementById('statUsers').textContent     = userOnly;
    document.getElementById('statEmployees').textContent = employees;
    document.getElementById('statSellers').textContent   = sellers;
    document.getElementById('statAdmins').textContent    = admins;
}

/* ─────────── Render list ─────────── */
function renderUsers() {
    const filtered = currentFilter === 'all'
        ? allUsers
        : allUsers.filter(u => {
            const r = u.roles || [u.role || 'user'];
            return r.includes(currentFilter);
        });

    if (filtered.length === 0) {
        userListEl.innerHTML = `<div class="mu-empty"><i class="fa-solid fa-users-slash"></i>No users found.</div>`;
        userCountEl.textContent = `0 of ${allUsers.length} users`;
        return;
    }

    userListEl.innerHTML = filtered.map(u => {
        const roles = u.roles || [u.role || 'user'];
        const top   = highestRole(roles);
        const init  = (u.fullName || 'U').charAt(0).toUpperCase();
        return `
        <div class="mu-user-row" onclick="showDetail('${u.uid}')">
            <div class="mu-row-avatar">${init}</div>
            <div class="mu-row-info">
                <div class="mu-row-name">${escHtml(u.fullName || 'Unknown')}</div>
                <div class="mu-row-email">${escHtml(u.email || '—')}</div>
            </div>
            <div class="mu-row-right">
                <span class="mu-role-badge ${roleBadgeClass(top)}">${top}</span>
                <div class="mu-copy-icon" onclick="event.stopPropagation(); copyText('${escHtml(u.email || '')}')" title="Copy email">
                    <i class="fa-regular fa-copy"></i>
                </div>
            </div>
        </div>`;
    }).join('');

    userCountEl.textContent = `Showing ${filtered.length} of ${allUsers.length} users`;
}

function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─────────── Detail modal ─────────── */
window.showDetail = function(uid) {
    const u = allUsers.find(x => x.uid === uid);
    if (!u) return;

    document.getElementById('mdAvatar').textContent = (u.fullName || 'U').charAt(0).toUpperCase();
    document.getElementById('mdName').textContent   = u.fullName || 'Unknown';
    document.getElementById('mdUid').textContent    = 'ID: ' + (u.userId || uid.substring(0, 8).toUpperCase());
    document.getElementById('mdEmail').textContent  = u.email || '—';
    document.getElementById('mdPhone').textContent  = u.mobileNumber || 'Not set';
    document.getElementById('mdJoined').textContent = fmtDate(u.createdAt);

    // Roles badges
    const roles = u.roles || [u.role || 'user'];
    if (!roles.includes('user')) roles.push('user');
    const roleColors = {
        admin:    '#1d4ed8', seller: '#b45309', employee: '#15803d',
        manage_items: '#7c3aed', manage_marketing: '#d97706',
        manage_support: '#0891b2', manage_requests: '#0369a1',
        manage_banners: '#0369a1', manage_xerox: '#374151', manage_cache: '#374151',
        user: '#6b7280'
    };
    document.getElementById('mdRoles').innerHTML = roles.map(r => `
        <span class="mu-role-badge" style="background:${roleColors[r]||'#6b7280'}18; color:${roleColors[r]||'#6b7280'}; border-color:${roleColors[r]||'#6b7280'}33; font-size:.6rem;">
            ${r.replace(/_/g,' ')}
        </span>`).join('');

    // Addresses
    const addrs = Array.isArray(u.addresses) ? u.addresses : [];
    document.getElementById('mdAddrCount').textContent = addrs.length || 'None';
    const addrListEl = document.getElementById('mdAddresses');
    if (addrs.length > 0) {
        addrListEl.innerHTML = addrs.map((a, i) => `
            <div class="mu-addr-item">
                <div class="mu-addr-label">${escHtml(a.label || 'Address ' + (i+1))}</div>
                <div class="mu-addr-street">${escHtml(a.street || '—')}</div>
                <div class="mu-addr-meta">${[a.city, a.state].filter(Boolean).map(escHtml).join(', ')}${a.pincode ? ' – ' + escHtml(a.pincode) : ''}</div>
            </div>`).join('');
    } else {
        addrListEl.innerHTML = '';
    }

    const overlay = document.getElementById('detailOverlay');
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.closeDetailModal = function() {
    document.getElementById('detailOverlay').classList.remove('open');
    document.body.style.overflow = '';
};

// Close when clicking the backdrop
document.getElementById('detailOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('detailOverlay')) {
        window.closeDetailModal();
    }
});

/* ─────────── Auth guard (admin only) ─────────── */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search));
        return;
    }

    // Fast cache check first
    try {
        const cached = localStorage.getItem('jasa_user_cache');
        if (cached) {
            const cData = JSON.parse(cached);
            const cRoles = cData.roles || [cData.role || 'user'];
            if (!cRoles.includes('admin')) {
                window.location.replace('index.html');
                return;
            }
        }
    } catch (_) {}

    // Live Firestore check
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin')) {
            showToast('Admin access required.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1200);
            return;
        }
        fetchUsers();
    } catch (err) {
        console.error('[ManageUsers] Auth check failed:', err);
        window.location.replace('index.html');
    }
});
