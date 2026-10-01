/* ═══════════════════════════════════════════════
   CLOUD SERVICES — admin-cloud.js
   Three tabs: Firebase · Cloudinary · Storage
   Auth: admin role required
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import { SERVER_URL, SUPABASE_CONFIG, CLOUDINARY_CONFIG, WORKER_URL, initAppConfig, getAdminToken } from './env-config.js';
import {
    collection, getDocs, doc, getDoc, deleteDoc,
    getCountFromServer, writeBatch, setDoc
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

/* ════ STATE ════ */
let currentTab = 'firebase';

// Cloudinary
let clImages    = [];
let clSelected  = new Set();
let clFilter    = 'all';
const CL_FREE_BYTES = 25 * 1024 * 1024 * 1024; // 25 GB

// Storage (Supabase)
let stFiles    = [];
let stSelected = new Set();
const ST_BUCKET    = 'files';
const MAX_ST_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

/* ════ HELPERS ════ */
function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtBytes(b) {
    if (!b) return '0 B';
    const u = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(2) + ' ' + u[i];
}

function fmtDate(s) {
    if (!s) return '—';
    try {
        return new Date(s).toLocaleDateString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric'
        });
    } catch { return '—'; }
}

/* ════ TOAST ════ */
function toast(msg, type = '') {
    const el = document.getElementById('aclToast');
    el.textContent = msg;
    el.className = 'acl-toast ' + type;
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3200);
}

/* ════ CONFIRM DIALOG ════ */
let _dialogResolve = null;

function confirm(title, msg) {
    return new Promise(resolve => {
        _dialogResolve = resolve;
        document.getElementById('aclDialogTitle').textContent = title;
        document.getElementById('aclDialogMsg').textContent   = msg;
        document.getElementById('aclDialogOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
    });
}

window.closeDialog = function(result = false) {
    document.getElementById('aclDialogOverlay').classList.remove('open');
    document.body.style.overflow = '';
    if (_dialogResolve) { _dialogResolve(result); _dialogResolve = null; }
};
document.getElementById('aclDialogConfirm').addEventListener('click', () => window.closeDialog(true));
document.getElementById('aclDialogOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('aclDialogOverlay')) window.closeDialog(false);
});

/* ════ AUTH GUARD ════ */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html'); return; }

    // Fast cache check
    try {
        const cached = localStorage.getItem('jasa_user_cache');
        if (cached) {
            const cd = JSON.parse(cached);
            const cr = cd.roles || [cd.role || 'user'];
            if (!cr.includes('admin')) { window.location.replace('index.html'); return; }
        }
    } catch (_) {}

    // Live Firestore check
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin')) {
            toast('Admin access required.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1200);
            return;
        }
        // Authorised — load all tabs in parallel (Firebase first, others background)
        loadFirebase();
        loadCloudinary();
        loadStorage();
        loadR2();
    } catch (err) {
        console.error('[Cloud] auth:', err);
        window.location.replace('index.html');
    }
});

/* ════ TAB NAVIGATION ════ */
window.setTab = window.__setTab = function(tabId, el) {
    currentTab = tabId;
    document.querySelectorAll('.acl-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('.acl-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

/* ══════════════════════════════════════════════
   FIREBASE MODULE
   ══════════════════════════════════════════════ */
async function loadFirebase() {
    const cols = [
        { key: 'orders',       id: 'fbCountOrders'     },
        { key: 'items',        id: 'fbCountItems'      },
        { key: 'shops',        id: 'fbCountShops'      },
        { key: 'categories',   id: 'fbCountCategories' },
        { key: 'site_banners', id: 'fbCountBanners'    },
    ];

    try {
        const counts = {};

        // 1. Fetch Users count - filter for standard user accounts (matching Manage Users page)
        try {
            const userSnap = await getDocs(collection(db, 'users'));
            const userDocs = userSnap.docs.map(d => d.data());
            const standardUsers = userDocs.filter(u => {
                const r = u.roles || [u.role || 'user'];
                return r.every(x => x === 'user');
            }).length;
            counts['users'] = standardUsers > 0 ? standardUsers : userSnap.size;
        } catch (e) {
            try {
                const snap = await getCountFromServer(collection(db, 'users'));
                counts['users'] = snap.data().count;
            } catch (_) {
                counts['users'] = 0;
            }
        }
        const uEl = document.getElementById('fbCountUsers');
        if (uEl) uEl.textContent = (counts['users'] || 0).toLocaleString();

        // 2. Fetch other collection counts
        await Promise.all(cols.map(async c => {
            try {
                const snap = await getCountFromServer(collection(db, c.key));
                counts[c.key] = snap.data().count;
                const el = document.getElementById(c.id);
                if (el) el.textContent = counts[c.key].toLocaleString();
            } catch (e) {
                try {
                    const snap = await getDocs(collection(db, c.key));
                    counts[c.key] = snap.size;
                    const el = document.getElementById(c.id);
                    if (el) el.textContent = counts[c.key].toLocaleString();
                } catch (_) {
                    counts[c.key] = 0;
                    const el = document.getElementById(c.id);
                    if (el) el.textContent = '—';
                }
            }
        }));

        // Also count categoryData as part of Items
        try {
            const catDataSnap = await getCountFromServer(collection(db, 'categoryData'));
            const totalItems = (counts['items'] || 0) + catDataSnap.data().count;
            const el = document.getElementById('fbCountItems');
            if (el) el.textContent = totalItems.toLocaleString();
        } catch (_) {}

        // Estimate daily operations strictly from actual user and order count
        const userCount  = counts['users']  || 0;
        const orderCount = counts['orders'] || 0;
        const base = userCount + (orderCount * 2);
        const reads   = Math.floor(base * 10);
        const writes  = Math.floor(base * 1.5);
        const deletes = Math.floor(base * 0.1);

        const rEl = document.getElementById('fbReads');
        const wEl = document.getElementById('fbWrites');
        const dEl = document.getElementById('fbDeletes');
        if (rEl) rEl.textContent = reads.toLocaleString();
        if (wEl) wEl.textContent = writes.toLocaleString();
        if (dEl) dEl.textContent = deletes.toLocaleString();

    } catch (e) {
        console.error('[Cloud/Firebase]', e);
    }
}

/* ══════════════════════════════════════════════
   CLOUDINARY MODULE
   ══════════════════════════════════════════════ */
async function loadCloudinary() {
    clSelected.clear();
    setClGrid(`<div class="acl-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading images…</div>`);

    try {
        // Ensure config is loaded before accessing CLOUDINARY_CONFIG
        await initAppConfig();
        const [rawImages, usageMap] = await Promise.all([
            fetchClImages(),
            buildUsageMap()
        ]);

        clImages = rawImages.map(img => {
            const usage = usageMap.get(img.public_id) || usageMap.get(img.url);
            return { ...img, used: !!usage, usageContext: usage || null };
        });

        renderClStats();
        renderClGrid();
        syncClRegistry(clImages); // best-effort background sync
    } catch (e) {
        console.error('[Cloud/Cloudinary]', e);
        setClGrid(`<div class="acl-empty">Failed to load images. Check Worker connection.</div>`);
    }
}

async function fetchClImages() {
    const res = await fetch(`${WORKER_URL}/api/cloudinary/all`);
    if (!res.ok) throw new Error(`Worker responded ${res.status}`);
    return res.json();
}

async function buildUsageMap() {
    const usage = new Map();

    const extractPublicId = url => {
        if (!url || typeof url !== 'string') return null;
        const m = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
        return m ? m[1] : null;
    };

    const register = (url, label, name) => {
        if (!url) return;
        const pid = extractPublicId(url);
        if (pid) usage.set(pid, { col: label, name });
        usage.set(url, { col: label, name });
    };

    const sources = [
        { col: 'items',                   label: 'Item'             },
        { col: 'shops',                   label: 'Shop'             },
        { col: 'site_banners',            label: 'Banner'           },
        { col: 'categories',              label: 'Category'         },
        { col: 'categoryData',            label: 'Category Data'    },
        { col: 'xerox_config_lamination', label: 'Xerox Lamination' },
        { col: 'xerox_config_binding',    label: 'Xerox Binding'    },
        { col: 'xerox_config_paper',      label: 'Xerox Paper'      },
        { col: 'site_config',             label: 'Site Config'      },
    ];

    const snaps = await Promise.all(sources.map(s => getDocs(collection(db, s.col)).catch(() => null)));

    snaps.forEach((snap, idx) => {
        if (!snap) return;
        const { col, label } = sources[idx];
        snap.forEach(d => {
            const data = d.data();
            const name = data.name || data.title || d.id;
            if (col === 'items' || col.startsWith('xerox_config_')) {
                (data.images || []).forEach(img => {
                    if (typeof img === 'object' && img !== null) {
                        if (img.id) usage.set(img.id, { col: label, name });
                        if (img.public_id) usage.set(img.public_id, { col: label, name });
                        register(img.url || img.imageUrl, label, name);
                    } else if (typeof img === 'string') {
                        register(img, label, name);
                    }
                });
                register(data.image || data.imageUrl, label, name);
            } else if (col === 'shops') {
                ['logoUrl','bannerUrl','imageUrl'].forEach(f => register(data[f], label, name));
            } else if (col === 'site_config') {
                Object.values(data).forEach(val => {
                    if (typeof val === 'string') register(val, label, name);
                    else if (Array.isArray(val)) {
                        val.forEach(v => {
                            if (typeof v === 'string') register(v, label, name);
                            else if (v && typeof v === 'object') register(v.url || v.imageUrl, label, name);
                        });
                    } else if (val && typeof val === 'object') {
                        Object.values(val).forEach(v => {
                            if (typeof v === 'string') register(v, label, name);
                            else if (v && typeof v === 'object') register(v.url || v.imageUrl, label, name);
                        });
                    }
                });
            } else {
                register(data.imageUrl || data.image || data.url, label, name);
            }
        });
    });

    return usage;
}

async function syncClRegistry(images) {
    try {
        const BATCH = 500;
        const ts = new Date().toISOString();
        for (let i = 0; i < images.length; i += BATCH) {
            const batch = writeBatch(db);
            images.slice(i, i + BATCH).forEach(img => {
                const fid = img.public_id.replace(/\//g, '__');
                batch.set(doc(db, 'cloudinary_images', fid), { ...img, lastSeen: ts }, { merge: true });
            });
            await batch.commit();
        }
    } catch (e) { console.warn('[Cloud] registry sync:', e); }
}

function renderClStats() {
    const totalBytes = clImages.reduce((s, i) => s + (i.bytes || 0), 0);
    const usedCount  = clImages.filter(i => i.used).length;
    const pct        = Math.min(100, (totalBytes / CL_FREE_BYTES) * 100);

    setText('clStorage', fmtBytes(totalBytes));
    setText('clTotal',   clImages.length);
    setText('clUsed',    usedCount);
    setText('clUnused',  clImages.length - usedCount);
    setText('clPct',     pct.toFixed(2) + '%');
    setStyle('clBar', 'width', pct + '%');
}

function getVisibleCl() {
    if (clFilter === 'used')   return clImages.filter(i => i.used);
    if (clFilter === 'unused') return clImages.filter(i => !i.used);
    return clImages;
}

function renderClGrid() {
    const visible = getVisibleCl();
    if (!visible.length) {
        setClGrid(`<div class="acl-empty">No images found for this filter.</div>`);
        updateClControls();
        return;
    }

    document.getElementById('clGrid').innerHTML = visible.map(img => {
        const isSel  = clSelected.has(img.public_id);
        const name   = img.public_id.split('/').pop();
        const pid    = esc(img.public_id);
        const pidJs  = img.public_id.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        const badge  = img.used
            ? `<span class="acl-img-badge acl-img-badge--used">Used</span>`
            : `<span class="acl-img-badge acl-img-badge--unused">Unused</span>`;
        const ctx    = img.used ? `${img.usageContext.col}: ${esc(img.usageContext.name)}` : '—';
        const kb     = img.bytes ? ((img.bytes / 1024).toFixed(0) + ' KB') : '—';
        const date   = img.uploadedAt ? fmtDate(img.uploadedAt) : '';

        return `
<div class="acl-img-card ${isSel ? 'selected' : ''}" id="clCard-${pid}" onclick="toggleClCard('${pidJs}')">
    <input type="checkbox" class="acl-img-check" ${isSel ? 'checked' : ''}
           onclick="event.stopPropagation(); handleClCheck('${pidJs}', this)">
    ${badge}
    <img class="acl-img-thumb" src="${esc(img.url)}" loading="lazy" alt="${esc(name)}">
    <div class="acl-img-info">
        <div class="acl-img-name" title="${esc(img.public_id)}">${esc(name)}</div>
        <div class="acl-img-context">${ctx}</div>
        <div class="acl-img-meta"><span>${kb}</span><span>${date}</span></div>
    </div>
</div>`;
    }).join('');

    updateClControls();
}

function setClGrid(html) {
    const el = document.getElementById('clGrid');
    if (el) el.innerHTML = html;
}

window.toggleClCard = function(pid) {
    if (clSelected.has(pid)) clSelected.delete(pid);
    else clSelected.add(pid);
    const card = document.getElementById(`clCard-${pid.replace(/\//g,'\\/')}`);
    // Re-render is cheapest for grid items
    renderClGrid();
};

window.handleClCheck = function(pid, cb) {
    if (cb.checked) clSelected.add(pid);
    else clSelected.delete(pid);
    renderClGrid();
};

window.setClFilter = function(f, el) {
    clFilter = f;
    document.querySelectorAll('#clFilterPills .acl-pill').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    clSelected.clear();
    document.getElementById('clSelectAll').checked = false;
    renderClGrid();
};

function updateClControls() {
    const btn = document.getElementById('clBulkDel');
    if (btn) {
        btn.disabled = clSelected.size === 0;
        const spanEl = btn.querySelector('span');
        if (spanEl) spanEl.textContent = clSelected.size > 0 ? `Delete (${clSelected.size})` : 'Delete';
    }
    const visible = getVisibleCl();
    const allChk  = visible.length > 0 && visible.every(i => clSelected.has(i.public_id));
    const cb = document.getElementById('clSelectAll');
    if (cb) cb.checked = allChk;
}

window.refreshCl = async function() { await loadCloudinary(); };

window.deleteSelectedCl = async function() {
    const count = clSelected.size;
    if (!count) return;

    const ok = await confirm(
        `Delete ${count} image${count !== 1 ? 's' : ''}?`,
        'Permanently removes from Cloudinary and the Firestore registry. This cannot be undone.'
    );
    if (!ok) return;

    const btn = document.getElementById('clBulkDel');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    const pids = Array.from(clSelected);

    try {
        let deletedPids = [];
        let failedPids  = [];

        // All deletes go through the Worker — apiSecret stays server-side in CF Worker env
        try {
            const res = await fetch(`${WORKER_URL}/api/cloudinary/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ public_ids: pids })
            });

            if (res.ok) {
                const data = await res.json();
                if (typeof data.deleted === 'number' && (data.deleted > 0 || data.failed === 0)) {
                    if (data.results?.deleted) {
                        deletedPids = Object.keys(data.results.deleted);
                    } else if (data.deleted === pids.length) {
                        deletedPids = pids;
                    }
                    if (data.results?.failed) {
                        failedPids = Object.keys(data.results.failed);
                    }
                } else {
                    throw new Error(`Worker returned 0 deleted. Check Cloudflare Worker logs.`);
                }
            } else {
                const errBody = await res.json().catch(() => ({}));
                throw new Error(`Worker error ${res.status}: ${errBody.error || res.statusText}`);
            }
        } catch (workerErr) {
            throw new Error('Delete failed: ' + workerErr.message);
        }

        // ── Clean up Firestore registry for confirmed deletes ──
        const deletedSet = new Set(deletedPids);
        deletedPids.forEach(pid => {
            const fid = pid.replace(/\//g, '__');
            deleteDoc(doc(db, 'cloudinary_images', fid)).catch(() => {});
        });

        // ── Update local state ──
        clImages = clImages.filter(i => !deletedSet.has(i.public_id));
        clSelected.clear();
        renderClStats();
        renderClGrid();

        const dc = deletedPids.length;
        const fc = failedPids.length;

        if (fc === 0 && dc > 0) {
            toast(`${dc} image${dc !== 1 ? 's' : ''} deleted`, 'success');
        } else if (dc === 0) {
            toast(`Delete failed — no images were removed. Check console for details.`, 'error');
        } else {
            toast(`Deleted ${dc}, failed ${fc}`, 'error');
        }

    } catch (e) {
        console.error('[Cloud] deleteSelectedCl:', e);
        toast('Delete failed: ' + e.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = clSelected.size === 0;
            btn.innerHTML = '<i class="fa-solid fa-trash-can"></i> <span>Delete</span>';
        }
    }
};

async function sha1(msg) {
    const buf  = new TextEncoder().encode(msg);
    const hash = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ══════════════════════════════════════════════
   CLOUDINARY SELECT-ALL LISTENER
   ══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('clSelectAll')?.addEventListener('change', e => {
        const visible = getVisibleCl();
        if (e.target.checked) visible.forEach(i => clSelected.add(i.public_id));
        else visible.forEach(i => clSelected.delete(i.public_id));
        renderClGrid();
        updateClControls();
    });

    document.getElementById('stSelectAll')?.addEventListener('change', e => {
        if (e.target.checked) stFiles.forEach(f => stSelected.add(f.fullPath));
        else stSelected.clear();
        renderStList();
        updateStControls();
    });
});

/* ══════════════════════════════════════════════
   STORAGE MODULE (Supabase)
   ══════════════════════════════════════════════ */
async function loadStorage() {
    stSelected.clear();
    setStList(`<div class="acl-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading files…</div>`);

    try {
        // Ensure config is loaded before accessing SUPABASE_CONFIG
        await initAppConfig();
        stFiles = await listFilesRecursive('');
        stFiles.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        renderStStats();
        renderStList();
    } catch (e) {
        console.error('[Cloud/Storage]', e);
        setStList(`<div class="acl-empty">Failed to load storage files.</div>`);
    }
}

async function listFilesRecursive(prefix) {
    const res = await fetch(`${SUPABASE_CONFIG.url}/storage/v1/object/list/${ST_BUCKET}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`,
            'apikey':        SUPABASE_CONFIG.anonKey,
            'Content-Type':  'application/json'
        },
        body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } })
    });
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Unexpected storage response');

    let files = [];
    for (const item of data) {
        if (item.name === '.emptyFolderPlaceholder') continue;
        if (!item.id && item.name) {
            // Folder — recurse
            const sub = await listFilesRecursive(prefix + item.name + '/');
            files = files.concat(sub);
        } else if (item.id) {
            files.push({ ...item, fullPath: prefix + item.name });
        }
    }
    return files;
}

function renderStStats() {
    const totalBytes = stFiles.reduce((s, f) => s + (f.metadata?.size || 0), 0);
    const pct  = Math.min(100, (totalBytes / MAX_ST_BYTES) * 100);
    const mb   = (totalBytes / (1024 * 1024)).toFixed(2);

    setText('stUsageText', `${mb} MB / 5.00 GB`);
    setText('stFileCount', `${stFiles.length} file${stFiles.length !== 1 ? 's' : ''}`);
    setText('stPct', pct.toFixed(2) + '%');
    setStyle('stBar', 'width', pct + '%');
}

function renderStList() {
    if (!stFiles.length) {
        setStList(`<div class="acl-empty">Storage bucket is empty.</div>`);
        updateStControls();
        return;
    }

    document.getElementById('stList').innerHTML = stFiles.map(file => {
        const isSel  = stSelected.has(file.fullPath);
        const size   = file.metadata?.size ? fmtBytes(file.metadata.size) : '—';
        const date   = fmtDate(file.created_at);
        const ext    = file.name.split('.').pop().toLowerCase();
        const isPdf  = ext === 'pdf';
        const isDoc  = ['doc','docx'].includes(ext);
        const isImg  = ['jpg','jpeg','png','gif','webp','svg'].includes(ext);
        const iconCls = isPdf ? 'acl-st-file-icon--pdf fa-file-pdf'
                      : isDoc ? 'acl-st-file-icon--doc fa-file-word'
                      : isImg ? 'acl-st-file-icon--img fa-file-image'
                      : 'acl-st-file-icon--def fa-file';
        const pathJs = file.fullPath.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        const pubUrl = `${SUPABASE_CONFIG.url}/storage/v1/object/public/${ST_BUCKET}/${encodeURIComponent(file.fullPath)}`;

        return `
<div class="acl-st-file ${isSel ? 'selected' : ''}">
    <input type="checkbox" ${isSel ? 'checked' : ''}
           onchange="toggleStFile('${esc(pathJs)}', this.checked)">
    <div class="acl-st-file-icon">
        <i class="fa-solid ${iconCls}"></i>
    </div>
    <div class="acl-st-file-info">
        <div class="acl-st-file-name" title="${esc(file.fullPath)}">${esc(file.name)}</div>
        <div class="acl-st-file-meta">${size} · ${date}</div>
    </div>
    <a href="${esc(pubUrl)}" target="_blank" class="acl-st-open-btn" title="Open file">
        <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:.7rem;"></i>
    </a>
</div>`;
    }).join('');

    updateStControls();
}

function setStList(html) {
    const el = document.getElementById('stList');
    if (el) el.innerHTML = html;
}

window.toggleStFile = function(path, checked) {
    if (checked) stSelected.add(path);
    else stSelected.delete(path);
    updateStControls();
    // Update row style only — no full re-render needed
    const rows = document.querySelectorAll('#stList .acl-st-file');
    rows.forEach(row => {
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb && cb.getAttribute('onchange')?.includes(path.replace(/'/g,"\\'"))) {
            row.classList.toggle('selected', checked);
        }
    });
};

function updateStControls() {
    const btn = document.getElementById('stBulkDel');
    if (btn) {
        btn.disabled = stSelected.size === 0;
        const spanEl = btn.querySelector('span');
        if (spanEl) spanEl.textContent = stSelected.size > 0
            ? `Delete (${stSelected.size})`
            : 'Delete';
    }
    const allChk = stFiles.length > 0 && stFiles.every(f => stSelected.has(f.fullPath));
    const cb = document.getElementById('stSelectAll');
    if (cb) cb.checked = allChk;
}

window.refreshSt = async function() { await loadStorage(); };

window.deleteSelectedSt = async function() {
    const count = stSelected.size;
    const ok = await confirm(`Delete ${count} file${count !== 1 ? 's' : ''}?`, 'Permanently removes from Supabase Storage. This cannot be undone.');
    if (!ok) return;

    const btn = document.getElementById('stBulkDel');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    try {
        const res = await fetch(
            `${SUPABASE_CONFIG.url}/storage/v1/object/${ST_BUCKET}`,
            {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`,
                    'apikey':        SUPABASE_CONFIG.anonKey,
                    'Content-Type':  'application/json'
                },
                body: JSON.stringify({ prefixes: Array.from(stSelected) })
            }
        );
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `HTTP ${res.status}`);
        }
        stFiles    = stFiles.filter(f => !stSelected.has(f.fullPath));
        stSelected.clear();
        renderStStats();
        renderStList();
        toast(`${count} file${count !== 1 ? 's' : ''} deleted`, 'success');
    } catch (e) {
        toast('Delete failed: ' + e.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = stSelected.size === 0;
            btn.innerHTML = '<i class="fa-solid fa-trash-can"></i> <span>Delete</span>';
        }
    }
};

/* ════ TINY DOM HELPERS ════ */
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}
function setStyle(id, prop, val) {
    const el = document.getElementById(id);
    if (el) el.style[prop] = val;
}

/* ══════════════════════════════════════════════
   R2 PRODUCT IMAGES MODULE
   ══════════════════════════════════════════════ */
let r2Images   = [];      // { key, url, size, lastModified, category }
let r2Selected = new Set();
let r2Filter   = 'all';   // 'all' | 'stationary' | 'electronic' | 'books'

/* ── Load ─────────────────────────────────────── */
async function loadR2() {
    r2Selected.clear();
    setR2Grid(`<div class="acl-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading images…</div>`);

    try {
        await initAppConfig();
        const idToken     = await auth.currentUser.getIdToken();
        const adminSecret = await getAdminToken(idToken);
        const base        = (window.__JASA_SERVER || SERVER_URL).replace(/\/$/, '');

        const res  = await fetch(`${base}/api/upload/product-images?prefix=products/`, {
            headers: { 'x-server-secret': adminSecret },
        });
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        const data = await res.json();

        // Parse category from key: products/<category>/<itemId>/<file>
        r2Images = (data.objects || []).map(obj => {
            const parts = obj.key.split('/');   // ['products','stationary','pen-xyz','uuid.jpg']
            return { ...obj, category: parts[1] || 'unknown' };
        });

        renderR2Stats();
        renderR2Grid();
    } catch (err) {
        console.error('[Cloud/R2]', err);
        setR2Grid(`<div class="acl-empty">Failed to load R2 images. Check server connection.</div>`);
    }
}

/* ── Stats ────────────────────────────────────── */
function renderR2Stats() {
    const visible    = getVisibleR2();
    const totalBytes = r2Images.reduce((s, i) => s + (i.size || 0), 0);
    setText('r2Total',       r2Images.length);
    setText('r2Storage',     fmtBytes(totalBytes));
    setText('r2FilterLabel', r2Filter === 'all' ? 'All' :
                             r2Filter === 'stationary' ? 'Stationary' :
                             r2Filter === 'electronic' ? 'Kit' :
                             r2Filter === 'posters'    ? 'Posters' : 'Books');
}

/* ── Filter helpers ───────────────────────────── */
function getVisibleR2() {
    if (r2Filter === 'all') return r2Images;
    return r2Images.filter(i => i.category === r2Filter);
}

window.setR2Filter = function(f, el) {
    r2Filter = f;
    document.querySelectorAll('#r2FilterPills .acl-pill').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    r2Selected.clear();
    const cb = document.getElementById('r2SelectAll');
    if (cb) cb.checked = false;
    renderR2Stats();
    renderR2Grid();
};

/* ── Grid ─────────────────────────────────────── */
function renderR2Grid() {
    const visible = getVisibleR2();
    if (!visible.length) {
        setR2Grid(`<div class="acl-empty">No images found for this filter.</div>`);
        updateR2Controls();
        return;
    }

    document.getElementById('r2Grid').innerHTML = visible.map(img => {
        const isSel   = r2Selected.has(img.key);
        const fname   = img.key.split('/').pop();
        const keyJs   = img.key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const kb      = img.size ? ((img.size / 1024).toFixed(0) + ' KB') : '—';
        const date    = img.lastModified ? fmtDate(img.lastModified) : '';
        const cat     = img.category || 'unknown';
        const catBadge = `<span class="acl-img-badge acl-img-badge--used">${esc(cat)}</span>`;

        return `
<div class="acl-img-card ${isSel ? 'selected' : ''}" id="r2Card-${esc(img.key)}" onclick="toggleR2Card('${keyJs}')">
    <input type="checkbox" class="acl-img-check" ${isSel ? 'checked' : ''}
           onclick="event.stopPropagation(); handleR2Check('${keyJs}', this)">
    ${catBadge}
    <img class="acl-img-thumb" src="${esc(img.url)}" loading="lazy" alt="${esc(fname)}">
    <div class="acl-img-info">
        <div class="acl-img-name" title="${esc(img.key)}">${esc(fname)}</div>
        <div class="acl-img-context">${esc(img.key.split('/').slice(1, 3).join(' / '))}</div>
        <div class="acl-img-meta"><span>${kb}</span><span>${date}</span></div>
    </div>
</div>`;
    }).join('');

    updateR2Controls();
}

function setR2Grid(html) {
    const el = document.getElementById('r2Grid');
    if (el) el.innerHTML = html;
}

window.toggleR2Card = function(key) {
    if (r2Selected.has(key)) r2Selected.delete(key);
    else r2Selected.add(key);
    renderR2Grid();
};

window.handleR2Check = function(key, cb) {
    if (cb.checked) r2Selected.add(key);
    else r2Selected.delete(key);
    renderR2Grid();
};

function updateR2Controls() {
    const btn = document.getElementById('r2BulkDel');
    if (btn) {
        btn.disabled = r2Selected.size === 0;
        const span = btn.querySelector('span');
        if (span) span.textContent = r2Selected.size > 0 ? `Delete (${r2Selected.size})` : 'Delete';
    }
    const visible = getVisibleR2();
    const allChk  = visible.length > 0 && visible.every(i => r2Selected.has(i.key));
    const cb = document.getElementById('r2SelectAll');
    if (cb) cb.checked = allChk;
}

/* ── Refresh ──────────────────────────────────── */
window.refreshR2 = async function() { await loadR2(); };

/* ── Bulk Delete ──────────────────────────────── */
window.deleteSelectedR2 = async function() {
    const count = r2Selected.size;
    if (!count) return;

    const ok = await confirm(
        `Delete ${count} image${count !== 1 ? 's' : ''}?`,
        'Permanently removes from Cloudflare R2. This cannot be undone.'
    );
    if (!ok) return;

    const btn = document.getElementById('r2BulkDel');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    try {
        await initAppConfig();
        const idToken     = await auth.currentUser.getIdToken();
        const adminSecret = await getAdminToken(idToken);
        const base        = (window.__JASA_SERVER || SERVER_URL).replace(/\/$/, '');

        const keys     = Array.from(r2Selected);
        const results  = await Promise.allSettled(
            keys.map(key =>
                fetch(`${base}/api/upload/product-image`, {
                    method:  'DELETE',
                    headers: {
                        'Content-Type':    'application/json',
                        'x-server-secret': adminSecret,
                    },
                    body: JSON.stringify({ key }),
                }).then(r => r.ok ? { key, ok: true } : r.json().then(e => { throw new Error(e.error); }))
            )
        );

        let deleted = 0;
        let failed  = 0;
        const deletedKeys = new Set();

        results.forEach((r, i) => {
            if (r.status === 'fulfilled') { deleted++; deletedKeys.add(keys[i]); }
            else { failed++; console.warn('[R2 Delete]', keys[i], r.reason?.message); }
        });

        // Clean up Firestore r2_images registry
        deletedKeys.forEach(key => {
            const fid = key.replace(/\//g, '__');
            import('./firebase-init.js').then(({ db: _db }) => {
                import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js')
                    .then(({ doc: _doc, deleteDoc: _del }) => _del(_doc(_db, 'r2_images', fid)).catch(() => {}));
            });
        });

        // Update local list
        r2Images  = r2Images.filter(i => !deletedKeys.has(i.key));
        r2Selected.clear();
        renderR2Stats();
        renderR2Grid();

        if (failed === 0) {
            toast(`${deleted} image${deleted !== 1 ? 's' : ''} deleted`, 'success');
        } else {
            toast(`Deleted ${deleted}, failed ${failed}`, 'error');
        }
    } catch (err) {
        console.error('[Cloud/R2] deleteSelectedR2:', err);
        toast('Delete failed: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = r2Selected.size === 0;
            btn.innerHTML = '<i class="fa-solid fa-trash-can"></i> <span>Delete</span>';
        }
    }
};

/* ── Select-all listener (wired in DOMContentLoaded) ── */
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('r2SelectAll')?.addEventListener('change', e => {
        const visible = getVisibleR2();
        if (e.target.checked) visible.forEach(i => r2Selected.add(i.key));
        else visible.forEach(i => r2Selected.delete(i.key));
        renderR2Grid();
        updateR2Controls();
    });
});
