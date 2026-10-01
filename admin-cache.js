/* ═══════════════════════════════════════════════
   CACHE CONTROL — Admin + manage_cache only
   ═══════════════════════════════════════════════ */
import { auth, db }                 from './firebase-init.js';
import { getWorkerUrl, getAdminToken } from './env-config.js';
import { onAuthStateChanged }        from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { doc, getDoc }               from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

/* ─────────── Auth headers ─────────── */
async function authHeaders() {
    const { getIdToken } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
    const idToken    = await getIdToken(auth.currentUser);
    const adminToken = await getAdminToken(idToken);
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
    };
}

/* ─────────── Toast ─────────── */
function toast(msg, type = '') {
    const el = document.getElementById('acToast');
    el.textContent = msg;
    el.className   = 'ac-toast ' + type;
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

/* ─────────── Confirm dialog ─────────── */
let _dialogResolve = null;

function confirm(title, msg, danger = false) {
    return new Promise(resolve => {
        _dialogResolve = resolve;
        document.getElementById('dialogTitle').textContent = title;
        document.getElementById('dialogMsg').textContent   = msg;
        const icon = document.getElementById('dialogIcon');
        icon.className = 'ac-dialog-icon' + (danger ? ' danger' : '');
        icon.innerHTML = danger
            ? '<i class="fa-solid fa-triangle-exclamation"></i>'
            : '<i class="fa-solid fa-circle-question"></i>';
        const confirmBtn = document.getElementById('dialogConfirmBtn');
        confirmBtn.textContent = danger ? 'Yes, Clear' : 'Confirm';
        document.getElementById('dialogOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
    });
}

window.closeDialog = function(result = false) {
    document.getElementById('dialogOverlay').classList.remove('open');
    document.body.style.overflow = '';
    if (_dialogResolve) { _dialogResolve(result); _dialogResolve = null; }
};

document.getElementById('dialogConfirmBtn').addEventListener('click', () => window.closeDialog(true));
document.getElementById('dialogOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('dialogOverlay')) window.closeDialog(false);
});

/* ─────────── Refresh btn spinner ─────────── */
function setRefreshing(on) {
    document.getElementById('refreshBtn').classList.toggle('spinning', on);
}

/* ─────────── Formatters ─────────── */
function fmtBytes(b) {
    if (!b || b === 0) return '—';
    const u = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

function fmtDate(s) {
    if (!s || s === 'Unknown') return '—';
    try {
        return new Date(s).toLocaleString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch { return s; }
}

/* ─────────── Load cache status ─────────── */
window.loadCacheStatus = async function() {
    setRefreshing(true);
    try {
        const workerUrl = await getWorkerUrl();
        const res = await fetch(`${workerUrl}/api/cache/status`, {
            method: 'GET', headers: await authHeaders()
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        updateStats(data);
        updateTable(data.caches || []);
        updateCategoryHealth(data.categoryHealth || {});
    } catch (err) {
        console.error('[Cache] status error:', err);
        toast('Failed to load cache status: ' + err.message, 'error');
        updateTable([]);
        updateCategoryHealth({});
    } finally {
        setRefreshing(false);
    }
};

/* ─────────── Stats update ─────────── */
function updateStats(data) {
    const caches    = data.caches || [];
    const items     = caches.filter(c => c.key && c.key.includes('_items_')).length;
    const configs   = caches.filter(c => c.key && c.key.includes('_config_')).length;
    const shops     = caches.filter(c => c.key && c.key.includes('_shops_')).length;
    const locations = caches.filter(c => c.key && c.key.includes('_locations_')).length;
    const banners   = caches.filter(c => c.key && (c.key.includes('site_banners') || c.key.includes('site_config'))).length;

    document.getElementById('statTotal').textContent     = data.total   ?? caches.length;
    document.getElementById('statItems').textContent     = items;
    document.getElementById('statConfig').textContent    = configs;
    document.getElementById('statShops').textContent     = shops;
    document.getElementById('statLocations').textContent = locations;
    document.getElementById('statBanners').textContent   = banners;
}

/* ─────────── Category health panel ─────────── */
//  Renders a card per category showing:
//  • whether it has a KV cache entry
//  • how many items are cached
//  • how many of those items have a valid R2 image URL
//  • a Refresh button that calls refreshCache for that category only
const CAT_META = {
    stationary: { label: 'Stationary', icon: 'fa-pen-ruler',   color: '#22c55e' },
    books:      { label: 'Books',      icon: 'fa-book-open',   color: '#f59e0b' },
    electronic: { label: 'Kits',       icon: 'fa-microchip',   color: '#a855f7' },
    posters:    { label: 'Wall Posters', icon: 'fa-image',     color: '#ec4899' },
};

function updateCategoryHealth(health) {
    const panel = document.getElementById('categoryHealthPanel');
    if (!panel) return;

    panel.innerHTML = Object.entries(CAT_META).map(([cat, meta]) => {
        const h           = health[cat] || { cached: false, itemCount: 0, withImages: 0, cachedAt: null };
        const pct         = h.itemCount > 0 ? Math.round((h.withImages / h.itemCount) * 100) : 0;
        const allOk       = h.cached && h.itemCount > 0 && h.withImages === h.itemCount;
        const partial     = h.cached && h.itemCount > 0 && h.withImages < h.itemCount;
        const missing     = !h.cached || h.itemCount === 0;

        const statusIcon  = allOk   ? 'fa-circle-check'       :
                            partial ? 'fa-circle-exclamation'  :
                                      'fa-circle-xmark';
        const statusColor = allOk   ? '#16a34a'  :
                            partial ? '#d97706'  :
                                      '#dc2626';
        const statusText  = allOk   ? 'All images OK'              :
                            partial ? `${h.withImages}/${h.itemCount} have images` :
                            h.cached && h.itemCount === 0 ? 'Cached — 0 items' :
                                        'Not cached';

        // Progress bar width
        const barWidth = h.itemCount > 0 ? `${pct}%` : '0%';
        const barColor = allOk ? '#16a34a' : partial ? '#f59e0b' : '#e5e7eb';

        return `
        <div class="ac-health-card ${allOk ? 'ac-health-card--ok' : partial ? 'ac-health-card--warn' : 'ac-health-card--error'}">
            <div class="ac-health-icon" style="color:${meta.color};">
                <i class="fa-solid ${meta.icon}"></i>
            </div>
            <div class="ac-health-body">
                <div class="ac-health-top">
                    <span class="ac-health-name">${meta.label}</span>
                    <span class="ac-health-status" style="color:${statusColor};">
                        <i class="fa-solid ${statusIcon}"></i> ${statusText}
                    </span>
                </div>
                <div class="ac-health-bar-wrap">
                    <div class="ac-health-bar" style="width:${barWidth}; background:${barColor};"></div>
                </div>
                <div class="ac-health-meta">
                    <span>${h.itemCount} item${h.itemCount !== 1 ? 's' : ''} cached</span>
                    <span>${h.withImages} with R2 image</span>
                    ${h.cachedAt ? `<span title="${h.cachedAt}">Updated ${fmtDate(h.cachedAt)}</span>` : ''}
                </div>
            </div>
            <button class="ac-health-refresh" onclick="refreshCache('items','${cat}')" title="Refresh ${meta.label}">
                <i class="fa-solid fa-arrows-rotate"></i>
            </button>
        </div>`;
    }).join('');
}

/* ─────────── Table update ─────────── */
function typeIcon(key = '') {
    if (key.includes('_items_'))                                   return ['fa-boxes-stacked',    '#2D8CF0'];
    if (key.includes('_config_'))                                  return ['fa-gear',              '#b45309'];
    if (key.includes('_shops_'))                                   return ['fa-store',             '#0891b2'];
    if (key.includes('_locations_'))                               return ['fa-map-location-dot',  '#ea580c'];
    if (key.includes('site_banners') || key.includes('site_config')) return ['fa-images',          '#7c3aed'];
    return ['fa-database', '#6b7280'];
}

function updateTable(caches) {
    const tbody = document.getElementById('cacheTableBody');
    if (caches.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="ac-table-empty"><i class="fa-solid fa-inbox"></i> No cached entries found.</td></tr>`;
        return;
    }
    tbody.innerHTML = caches.map(c => {
        const [icon, color] = typeIcon(c.key || '');
        return `
        <tr>
            <td>
                <i class="fa-solid ${icon}" style="color:${color}; margin-right:6px;"></i>
                <span class="ac-cache-key">${escHtml(c.key || '—')}</span>
            </td>
            <td style="white-space:nowrap; font-size:.72rem;">${fmtDate(c.cachedAt)}</td>
            <td><span class="ac-size-badge">${fmtBytes(c.size)}</span></td>
            <td>
                <button class="ac-del-btn" onclick="clearSpecificCache('${escHtml(c.key || '')}')" title="Delete">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </td>
        </tr>`;
    }).join('');
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─────────── Cache operations ─────────── */
window.clearCache = async function(type, category = null) {
    const labels = { items:'Product Items', config:'Xerox Config', shops:'Shops', data:'Data' };
    const name   = category ? `${labels[type]||type} (${category})` : (labels[type]||type);
    const ok = await confirm(`Clear ${name}?`, 'This removes the cached data. Users will see fresh data on next load.', true);
    if (!ok) return;

    setRefreshing(true);
    try {
        const workerUrl = await getWorkerUrl();
        let url = `${workerUrl}/api/cache/clear?type=${type}`;
        if (category) url += `&category=${category}`;
        const res = await fetch(url, { method:'DELETE', headers: await authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        toast(`Cleared ${data.deleted ?? '?'} cache(s)`, 'success');
        await window.loadCacheStatus();
    } catch (err) {
        toast('Clear failed: ' + err.message, 'error');
        setRefreshing(false);
    }
};

window.clearAllCaches = async function() {
    const ok = await confirm('Clear ALL caches?', 'This removes every server-side cache. Products will reload from Firestore on next request.', true);
    if (!ok) return;

    setRefreshing(true);
    try {
        const workerUrl = await getWorkerUrl();
        const res = await fetch(`${workerUrl}/api/cache/clear?type=all`, { method:'DELETE', headers: await authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        toast(`Cleared ${data.deleted ?? '?'} cache(s)`, 'success');
        await window.loadCacheStatus();
    } catch (err) {
        toast('Clear all failed: ' + err.message, 'error');
        setRefreshing(false);
    }
};

window.clearSpecificCache = async function(key) {
    const ok = await confirm('Delete cache entry?', `Key: ${key}`, true);
    if (!ok) return;

    // Key format is:  v2.2_<namespace>_<category>_<suffix>
    // Examples:  v2.2_items_stationary_all  →  type=items  cat=stationary
    //            v2.2_items_all_all         →  type=items  cat=null (clear all item keys)
    //            v2.2_config_xerox          →  type=config cat=null
    //            v2.2_shops_all             →  type=shops  cat=null
    const withoutVersion = key.replace(/^v[\d.]+_/, '');   // strip leading "v2.2_"
    const parts = withoutVersion.split('_');                // e.g. ['items','stationary','all']
    const namespace = parts[0] || 'data';                  // 'items' | 'config' | 'shops' | ...

    let type, cat;
    if (namespace === 'items') {
        type = 'items';
        // parts[1] is the category name; ignore if it is 'all'
        cat = (parts[1] && parts[1] !== 'all') ? parts[1] : null;
    } else if (namespace === 'config') {
        type = 'config'; cat = null;
    } else if (namespace === 'shops') {
        type = 'shops'; cat = null;
    } else if (namespace === 'locations') {
        type = 'locations'; cat = null;
    } else {
        type = 'data'; cat = null;
    }

    await window.clearCache(type, cat);
};

window.refreshCache = async function(type, category = null) {
    // Normalise: 'all' is the same as null — both mean "refresh every category"
    const normCat = (category && category !== 'all') ? category : null;

    const labels = { items: 'Product Items', config: 'Xerox Config', shops: 'Shops', locations: 'Locations' };
    const name   = normCat ? `${labels[type] || type} (${normCat})` : (labels[type] || type);

    setRefreshing(true);
    try {
        const workerUrl = await getWorkerUrl();
        const res = await fetch(`${workerUrl}/api/cache/refresh`, {
            method:  'POST',
            headers: await authHeaders(),
            body:    JSON.stringify({ type, category: normCat })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Build a useful toast: show per-category counts when refreshing all
        let extra = '';
        if (data.itemCount) {
            extra = ` — ${data.itemCount} items`;
        }
        if (data.writtenKeys && data.writtenKeys.length > 1) {
            // Full refresh: list each key that was written
            extra = ` — ${data.writtenKeys.length} categories cached`;
        }
        toast(`${name} refreshed${extra}`, 'success');
        await window.loadCacheStatus();
    } catch (err) {
        toast('Refresh failed: ' + err.message, 'error');
        setRefreshing(false);
    }
};

window.refreshBannersCache = async function() {
    setRefreshing(true);
    try {
        const workerUrl = await getWorkerUrl();
        const res = await fetch(`${workerUrl}/api/cache/refresh-banners`, {
            method: 'POST', headers: await authHeaders()
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        toast(`Banners: ${data.banners ?? '?'} | Site config: ${data.siteConfig ?? '?'}`, 'success');
        await window.loadCacheStatus();
    } catch (err) {
        toast('Banner refresh failed: ' + err.message, 'error');
        setRefreshing(false);
    }
};

window.clearClientShopCache = function() {
    const keys = Object.keys(localStorage).filter(k =>
        k.includes('global_shops_data') ||
        k.includes('jasa_shops')        ||
        k === 'jasa_xerox_shops_v1'     ||
        k === 'jasa_xerox_shops_v2'
    );
    keys.forEach(k => localStorage.removeItem(k));
    toast(keys.length > 0
        ? `Cleared ${keys.length} local shop cache(s)`
        : 'No local shop caches found',
        keys.length > 0 ? 'success' : 'info'
    );
};

window.clearClientXeroxCache = function() {
    const keys = Object.keys(localStorage).filter(k => k === 'jasa_xerox_config_v1');
    keys.forEach(k => localStorage.removeItem(k));
    toast(keys.length > 0
        ? `Cleared local xerox config cache`
        : 'No local xerox config cache found',
        keys.length > 0 ? 'success' : 'info'
    );
};

/* ─────────── Auth guard: admin OR manage_cache ─────────── */
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.replace('login.html'); return; }

    // Fast cache check
    try {
        const cached = localStorage.getItem('jasa_user_cache');
        if (cached) {
            const cd = JSON.parse(cached);
            const cr = cd.roles || [cd.role || 'user'];
            if (!cr.includes('admin') && !cr.includes('manage_cache')) {
                window.location.replace('index.html'); return;
            }
        }
    } catch (_) {}

    // Live Firestore check
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin') && !roles.includes('manage_cache')) {
            toast('Access denied.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1200);
            return;
        }
        // Authorised — load data
        window.loadCacheStatus();
    } catch (err) {
        console.error('[Cache] auth error:', err);
        window.location.replace('index.html');
    }
});
