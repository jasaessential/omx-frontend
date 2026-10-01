/* ═══════════════════════════════════════════════
   ADMIN MARKETING — admin-marketing.js
   Auth: admin OR manage_marketing
   Features:
   • Send FCM push to all opted-in users
   • Campaign history via Worker KV
   • Stats: campaigns, eligible users, 7-day count
   ═══════════════════════════════════════════════ */
import { auth, db }         from './firebase-init.js';
import { WORKER_URL } from './env-config.js';
import { onAuthStateChanged }           from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { doc, getDoc, collection, getDocs }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

/* ── Auth headers — the Worker checks this Firebase ID token + the admin / manage_marketing role ── */
async function authHeaders() {
    const idToken = await auth.currentUser?.getIdToken();
    return { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) };
}

/* ── Toast ── */
function toast(msg, type = '') {
    const el = document.getElementById('acToast');
    el.textContent = msg; el.className = 'ac-toast ' + type;
    void el.offsetWidth; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3200);
}

/* ── Status message ── */
function setStatus(msg, type = 'info') {
    const el = document.getElementById('statusMsg');
    const colors = {
        info:    { bg:'var(--primary-faint)', color:'var(--primary)', border:'var(--primary-light)' },
        success: { bg:'#dcfce7', color:'#16a34a', border:'#86efac' },
        error:   { bg:'#fee2e2', color:'#dc2626', border:'#fca5a5' },
        warn:    { bg:'#fef3c7', color:'#b45309', border:'#fde68a' },
    };
    const c = colors[type] || colors.info;
    el.style.cssText = `display:block;background:${c.bg};color:${c.color};border:1px solid ${c.border};`;
    el.innerHTML = msg;
}

/* ── Live preview ── */
window.updatePreview = function() {
    const title = document.getElementById('notifTitle').value;
    const body  = document.getElementById('notifBody').value;
    const image = document.getElementById('notifImage').value;

    document.getElementById('prevTitle').textContent = title || 'Your Title Here';
    document.getElementById('prevBody').textContent  = body  || 'Notification preview…';
    document.getElementById('titleCounter').textContent = `${title.length}/50`;
    document.getElementById('bodyCounter').textContent  = `${body.length}/150`;

    const img = document.getElementById('prevImg');
    if (image) { img.src = image; img.style.display = 'block'; }
    else { img.style.display = 'none'; }
};

/* ── Auth guard ── */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html'); return; }
    try {
        const snap  = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin') && !roles.includes('manage_marketing')) {
            toast('Access denied.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1400);
            return;
        }
        loadPage();
    } catch (e) { console.error(e); window.location.replace('index.html'); }
});

/* ── Load page data ── */
window.loadPage = async function() {
    setRefreshing(true);
    await Promise.all([fetchHistory(), fetchEligibleCount()]);
    setRefreshing(false);
};

function setRefreshing(on) {
    document.getElementById('refreshBtn').classList.toggle('spinning', on);
}

/* ── Fetch campaign history ── */
async function fetchHistory() {
    const tbody = document.getElementById('historyBody');
    try {
        const res  = await fetch(`${WORKER_URL}/api/notification-history`, { headers: await authHeaders() });
        const data = res.ok ? await res.json() : [];
        const items = Array.isArray(data) ? data : (data.history || []);

        updateStats(items);

        if (!items.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="ac-table-empty"><i class="fa-solid fa-inbox"></i> No campaigns yet.</td></tr>';
            return;
        }
        tbody.innerHTML = items.map(item => {
            const date = item.sent_at ? new Date(item.sent_at).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';
            return `<tr>
                <td><span style="font-weight:700;color:var(--txt1);">${escHtml(item.title || '—')}</span>
                    ${item.image ? '<i class="fa-solid fa-image" style="margin-left:5px;color:var(--primary);font-size:.7rem;"></i>' : ''}
                </td>
                <td><span style="font-size:.72rem;font-weight:700;background:var(--primary-light);color:var(--primary);padding:2px 8px;border-radius:50px;">${item.recipientCount || item.successCount || '—'}</span></td>
                <td style="font-size:.72rem;color:var(--txt3);">${date}</td>
                <td>
                    <button class="ac-del-btn" onclick="deleteHistory('${escHtml(item.id || '')}')">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="ac-table-empty" style="color:#ef4444;">Failed to load history.</td></tr>`;
    }
}

function updateStats(items) {
    document.getElementById('statCampaigns').textContent = items.length;
    const seven = new Date(); seven.setDate(seven.getDate() - 7);
    const recent = items.filter(i => i.sent_at && new Date(i.sent_at) >= seven).length;
    document.getElementById('statRecent').textContent = recent;
    const imgs = new Set(items.filter(i => i.image).map(i => i.image)).size;
    document.getElementById('statImages').textContent = imgs;
}

async function fetchEligibleCount() {
    try {
        const snap = await getDocs(collection(db, 'users'));
        const n = snap.docs.filter(d => {
            const u = d.data();
            return u.notificationsEnabled && (u.fcmToken || u.fcmTokens?.length);
        }).length;
        document.getElementById('statEligible').textContent = n;
    } catch (_) { document.getElementById('statEligible').textContent = '?'; }
}

/* ── Send notification ── */
window.sendNotification = async function() {
    const title = document.getElementById('notifTitle').value.trim();
    const body  = document.getElementById('notifBody').value.trim();
    const image = document.getElementById('notifImage').value.trim();
    const link  = document.getElementById('notifLink').value;

    if (!title || !body) {
        setStatus('<i class="fa-solid fa-exclamation-triangle"></i> Title and body are required.', 'warn');
        return;
    }

    const btn = document.getElementById('sendBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';
    setStatus('<i class="fa-solid fa-spinner fa-spin"></i> Fetching users…', 'info');

    try {
        /* Collect FCM tokens from users with notifications enabled */
        const snap   = await getDocs(collection(db, 'users'));
        const tokens = [];
        snap.docs.forEach(d => {
            const u = d.data();
            if (!u.notificationsEnabled) return;
            if (u.fcmTokens?.length) tokens.push(...u.fcmTokens);
            else if (u.fcmToken) tokens.push(u.fcmToken);
        });

        if (!tokens.length) {
            setStatus('<i class="fa-solid fa-exclamation-triangle"></i> No users have notifications enabled.', 'warn');
            return;
        }

        setStatus(`<i class="fa-solid fa-paper-plane"></i> Sending to ${tokens.length} devices…`, 'info');

        const res = await fetch(`${WORKER_URL}/api/send-push-all`, {
            method: 'POST',
            headers: await authHeaders(),
            body: JSON.stringify({ title, body, image: image || undefined, link, tokens })
        });
        const result = await res.json();

        if (res.ok) {
            setStatus(`<i class="fa-solid fa-check-circle"></i> Sent to ${result.successCount || tokens.length} users!${result.failureCount ? ` (${result.failureCount} failed)` : ''}`, 'success');
            toast(`Campaign launched — ${result.successCount || tokens.length} users notified`, 'success');
            /* Reset form */
            ['notifTitle','notifBody','notifImage'].forEach(id => document.getElementById(id).value = '');
            document.getElementById('notifLink').selectedIndex = 0;
            window.updatePreview();
            await fetchHistory();
        } else {
            setStatus(`<i class="fa-solid fa-times-circle"></i> Error: ${result.error || 'Send failed'}`, 'error');
        }
    } catch (err) {
        setStatus(`<i class="fa-solid fa-times-circle"></i> Network error: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Launch Campaign';
    }
};

/* ── Delete history item ── */
window.deleteHistory = async function(id) {
    if (!id) return;
    try {
        await fetch(`${WORKER_URL}/api/notification-history?id=${encodeURIComponent(id)}`, {
            method: 'DELETE', headers: await authHeaders()
        });
        toast('Entry deleted', 'success');
        await fetchHistory();
    } catch (e) { toast('Delete failed', 'error'); }
};

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
