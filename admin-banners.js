/* ═══════════════════════════════════════════════
   BANNER MANAGER — admin-banners.js
   Manages two Firestore paths:
     • site_banners         — hero slider image banners
     • site_config/category_images — service button images
   ═══════════════════════════════════════════════ */
import { auth, db }            from './firebase-init.js';
import { CLOUDINARY_CONFIG, WORKER_URL, initAppConfig } from './env-config.js';
import {
    collection, doc, getDoc, getDocs,
    setDoc, updateDoc, deleteDoc,
    query, orderBy, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

/* ── State ── */
let allBanners    = [];
let currentFilter = 'all';
let editingId     = null;
let dragSrcIndex  = null;

let categoryImages  = {};        // { xerox, stationary, books, electronic, posters }
let pendingCatKey   = null;      // key being edited in cat modal
let pendingCatUrl   = '';        // newly uploaded Cloudinary URL
let pendingCatPid   = '';        // newly uploaded public_id

const CATEGORIES = [
    { key: 'xerox',      label: 'Xerox',      icon: 'fa-copy',       color: '#2D8CF0', bg: '#e8f2fe' },
    { key: 'stationary', label: 'Stationary', icon: 'fa-pen-ruler',  color: '#22c55e', bg: '#dcfce7' },
    { key: 'books',      label: 'Books',      icon: 'fa-book-open',  color: '#f59e0b', bg: '#fef3c7' },
    { key: 'electronic', label: 'Kits',       icon: 'fa-microchip',  color: '#a855f7', bg: '#f3e8ff' },
    { key: 'posters',    label: 'Posters',    icon: 'fa-image',      color: '#ec4899', bg: '#fce7f3' },
];

/* ══════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════ */
function toast(msg, type = '') {
    const el = document.getElementById('abToast');
    if (!el) return;
    el.textContent = msg;
    el.className   = 'ab-toast' + (type ? ' ' + type : '');
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

/* ══════════════════════════════════════════════
   CONFIRM DIALOG
   ══════════════════════════════════════════════ */
let _dialogResolve = null;
function confirmDialog(title, msg) {
    return new Promise(resolve => {
        _dialogResolve = resolve;
        document.getElementById('abDialogTitle').textContent = title;
        document.getElementById('abDialogMsg').textContent   = msg;
        document.getElementById('abDialogOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
    });
}
window.closeDialog = function (result = false) {
    document.getElementById('abDialogOverlay').classList.remove('open');
    document.body.style.overflow = '';
    if (_dialogResolve) { _dialogResolve(result); _dialogResolve = null; }
};
document.getElementById('abDialogConfirm').addEventListener('click', () => window.closeDialog(true));

/* ══════════════════════════════════════════════
   TAB SWITCHING
   ══════════════════════════════════════════════ */
window.switchTab = function (tab) {
    document.querySelectorAll('.ab-tab-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.ab-tab').forEach(b => b.classList.remove('active'));
    document.getElementById('section-' + tab).classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');

    // Lazy-load category images first time the tab is opened
    if (tab === 'categories' && Object.keys(categoryImages).length === 0) {
        loadCategoryImages();
    }
};

/* ══════════════════════════════════════════════
   AUTH GUARD
   ══════════════════════════════════════════════ */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html'); return; }
    try {
        const snap  = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin') && !roles.includes('manage_banners')) {
            toast('Access denied. Admin permission required.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1200);
            return;
        }
        // Load both in parallel on first auth
        await Promise.all([loadBanners(), loadCategoryImages()]);
    } catch (err) {
        console.error('[AdminBanners] auth:', err);
        window.location.replace('index.html');
    }
});

/* ══════════════════════════════════════════════
   BANNER — LOAD & RENDER
   ══════════════════════════════════════════════ */
export async function loadBanners() {
    document.getElementById('abList').innerHTML =
        `<div class="ab-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading banners…</div>`;
    try {
        const snap = await getDocs(query(collection(db, 'site_banners'), orderBy('order', 'asc')));
        allBanners = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderBanners();
    } catch (err) {
        console.error('[AdminBanners] load:', err);
        document.getElementById('abList').innerHTML =
            `<div class="ab-empty"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load banners.</div>`;
    }
}
window.loadBanners = loadBanners;

window.setFilter = function (filter, btn) {
    currentFilter = filter;
    document.querySelectorAll('#abFilterPills .ab-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderBanners();
};

function renderBanners() {
    let list = allBanners;
    if (currentFilter === 'active')   list = allBanners.filter(b => b.active !== false);
    if (currentFilter === 'inactive') list = allBanners.filter(b => b.active === false);

    document.getElementById('abCountBadge').textContent =
        `${list.length} of ${allBanners.length} banners`;

    if (!list.length) {
        document.getElementById('abList').innerHTML =
            `<div class="ab-empty"><i class="fa-solid fa-images"></i>
             No banners yet — click "+ Add" to create one.</div>`;
        return;
    }

    document.getElementById('abList').innerHTML = list.map((b, idx) => {
        const isActive = b.active !== false;
        return `
        <div class="ab-banner-card ${!isActive ? 'inactive' : ''}"
             data-id="${b.id}" data-index="${idx}"
             draggable="true"
             ondragstart="onDragStart(event,${idx})"
             ondragover="onDragOver(event)"
             ondrop="onDrop(event,${idx})">
            <div class="ab-banner-preview-wrap">
                ${b.imageUrl
                    ? `<img src="${esc(b.imageUrl)}" alt="${esc(b.alt||b.text||'Banner')}" class="ab-banner-img">`
                    : `<div class="ab-banner-img-placeholder"><i class="fa-solid fa-image"></i></div>`}
                ${b.text ? `<div class="ab-banner-caption">${esc(b.text)}</div>` : ''}
            </div>
            <div class="ab-banner-meta">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                    <span style="font-size:.7rem;font-weight:700;color:var(--txt3);">#${idx+1}</span>
                    <span class="ab-badge ${isActive ? 'ab-badge--active' : 'ab-badge--inactive'}">
                        ${isActive ? 'Active' : 'Inactive'}
                    </span>
                    <span style="font-size:.62rem;color:var(--txt3);margin-left:auto;cursor:grab;"
                          title="Drag to reorder">
                        <i class="fa-solid fa-grip-dots-vertical"></i>
                    </span>
                </div>
                <div class="ab-banner-link-row">
                    <i class="fa-solid fa-link" style="margin-right:4px;"></i>${esc(b.link||'—')}
                </div>
            </div>
            <div class="ab-banner-btns">
                <button class="ab-action-btn" onclick="openEditModal('${b.id}')">
                    <i class="fa-solid fa-pen"></i> Edit
                </button>
                <button class="ab-action-btn" onclick="toggleActive('${b.id}',${!isActive})">
                    <i class="fa-solid fa-${isActive ? 'eye-slash' : 'eye'}"></i>
                    ${isActive ? 'Disable' : 'Enable'}
                </button>
                <button class="ab-action-btn del" onclick="deleteBanner('${b.id}')">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>`;
    }).join('');
}

/* ══════════════════════════════════════════════
   BANNER MODAL OPEN / CLOSE
   ══════════════════════════════════════════════ */
window.openAddModal = function () {
    editingId = null;
    document.getElementById('abModalTitle').textContent = 'Add Banner';
    document.getElementById('abBannerForm').reset();
    document.getElementById('abImageUrl').value = '';
    document.getElementById('abPublicId').value = '';
    document.getElementById('abUploadPreview').style.display    = 'none';
    document.getElementById('abUploadPlaceholder').style.display = 'block';
    document.getElementById('abCurrentImgWrap').style.display   = 'none';
    document.getElementById('abSaveBtn').textContent = 'Add Banner';
    document.getElementById('abModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.openEditModal = function (id) {
    const b = allBanners.find(x => x.id === id);
    if (!b) return;
    editingId = id;
    document.getElementById('abModalTitle').textContent = 'Edit Banner';
    document.getElementById('abText').value  = b.text || '';
    document.getElementById('abAlt').value   = b.alt  || '';
    document.getElementById('abActive').checked = b.active !== false;
    updateCount();

    const knownLinks = [
        'xerox-order.html','categories.html?cat=stationary',
        'categories.html?cat=books','categories.html?cat=electronic','categories.html?cat=posters',
        'cart.html','index.html'
    ];
    const sel = document.getElementById('abLinkSelect');
    const cust = document.getElementById('abLinkCustom');
    if (knownLinks.includes(b.link)) { sel.value = b.link; cust.style.display = 'none'; }
    else { sel.value = 'custom'; cust.value = b.link || ''; cust.style.display = 'block'; }

    document.getElementById('abImageUrl').value = '';
    document.getElementById('abPublicId').value = '';
    document.getElementById('abUploadPreview').style.display    = 'none';
    document.getElementById('abUploadPlaceholder').style.display = 'block';

    if (b.imageUrl) {
        document.getElementById('abCurrentImg').src = b.imageUrl;
        const w = document.getElementById('abCurrentImgWrap');
        w.style.display = 'flex'; w.style.alignItems = 'center';
    } else {
        document.getElementById('abCurrentImgWrap').style.display = 'none';
    }

    document.getElementById('abSaveBtn').textContent = 'Save Changes';
    document.getElementById('abModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.closeModal = function () {
    document.getElementById('abModalOverlay').classList.remove('open');
    document.body.style.overflow = '';
};

window.updateCount = function () {
    const input   = document.getElementById('abText');
    const counter = document.getElementById('abTextCount');
    if (!input || !counter) return;
    const len = input.value.length;
    counter.textContent = `${len} / 60`;
    counter.style.color = len > 54 ? (len >= 60 ? '#ef4444' : '#f59e0b') : 'var(--txt3)';
};

window.onLinkSelectChange = function () {
    const sel  = document.getElementById('abLinkSelect');
    const cust = document.getElementById('abLinkCustom');
    cust.style.display = sel.value === 'custom' ? 'block' : 'none';
};

/* ══════════════════════════════════════════════
   BANNER FILE UPLOAD → CLOUDINARY
   ══════════════════════════════════════════════ */
window.handleFileSelect = function (input) {
    const file = input.files[0];
    if (file) processBannerFile(file);
};

function processBannerFile(file) {
    if (file.size > 5 * 1024 * 1024) { toast('File too large — max 5 MB.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
        document.getElementById('abPreviewImg').src = e.target.result;
        document.getElementById('abPreviewName').textContent = file.name;
        document.getElementById('abUploadPreview').style.display    = 'block';
        document.getElementById('abUploadPlaceholder').style.display = 'none';
    };
    reader.readAsDataURL(file);
    uploadToCloudinary(file, 'banner');
}

document.addEventListener('DOMContentLoaded', () => {
    setupDragZone(
        document.getElementById('abUploadZone'),
        file => processBannerFile(file)
    );
    setupDragZone(
        document.getElementById('abCatUploadZone'),
        file => processCatFile(file)
    );
});

function setupDragZone(zone, handler) {
    if (!zone) return;
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handler(file);
    });
}

/* ══════════════════════════════════════════════
   CLOUDINARY UPLOAD (shared)
   target: 'banner' | 'category'
   ══════════════════════════════════════════════ */
async function uploadToCloudinary(file, target) {
    const barId  = target === 'banner' ? 'abUploadBar'  : 'abCatUploadBar';
    const fillId = target === 'banner' ? 'abUploadFill' : 'abCatUploadFill';
    const bar    = document.getElementById(barId);
    const fill   = document.getElementById(fillId);

    bar.style.display = 'block';
    fill.style.width  = '10%';

    try {
        // Ensure config is loaded before reading CLOUDINARY_CONFIG
        await initAppConfig();

        const fd = new FormData();
        fd.append('file',           file);
        fd.append('upload_preset',  CLOUDINARY_CONFIG.uploadPreset);
        fd.append('folder',         target === 'banner' ? 'jasa_banners' : 'jasa_categories');

        fill.style.width = '40%';
        const res  = await fetch(
            `https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/image/upload`,
            { method: 'POST', body: fd }
        );
        const data = await res.json();
        fill.style.width = '100%';
        setTimeout(() => { bar.style.display = 'none'; }, 600);

        if (!data.secure_url) throw new Error(data.error?.message || 'Upload failed');

        if (target === 'banner') {
            document.getElementById('abImageUrl').value = data.secure_url;
            document.getElementById('abPublicId').value = data.public_id;
            toast('Image uploaded ✓', 'success');
        } else {
            pendingCatUrl = data.secure_url;
            pendingCatPid = data.public_id;
            document.getElementById('abCatSaveBtn').disabled = false;
            toast('Image uploaded — click Save to apply.', 'success');
        }
        return data;
    } catch (err) {
        bar.style.display = 'none';
        toast('Upload failed: ' + err.message, 'error');
        return null;
    }
}

/* ══════════════════════════════════════════════
   SAVE BANNER
   ══════════════════════════════════════════════ */
window.saveBanner = async function (e) {
    e.preventDefault();
    const imageUrl = document.getElementById('abImageUrl').value.trim();
    const publicId = document.getElementById('abPublicId').value.trim();
    const text     = document.getElementById('abText').value.trim();
    const alt      = document.getElementById('abAlt').value.trim();
    const active   = document.getElementById('abActive').checked;
    const sel      = document.getElementById('abLinkSelect');
    const link     = sel.value === 'custom'
        ? document.getElementById('abLinkCustom').value.trim()
        : sel.value;

    const existing     = editingId ? allBanners.find(b => b.id === editingId) : null;
    const finalImageUrl = imageUrl || (existing?.imageUrl || '');

    if (!finalImageUrl) { toast('Please upload an image first.', 'error'); return; }
    if (!link)          { toast('Please select a link URL.', 'error');    return; }

    const btn = document.getElementById('abSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    try {
        if (editingId) {
            const upd = { text, alt, active, link, updatedAt: serverTimestamp() };
            if (imageUrl) { upd.imageUrl = imageUrl; upd.publicId = publicId; }
            await updateDoc(doc(db, 'site_banners', editingId), upd);
            toast('Banner updated', 'success');
        } else {
            const newId = `banner_${Date.now()}`;
            await setDoc(doc(db, 'site_banners', newId), {
                imageUrl: finalImageUrl, publicId, text, alt, link, active,
                order: allBanners.length,
                createdAt: serverTimestamp(), updatedAt: serverTimestamp()
            });
            toast('Banner added', 'success');
        }
        closeModal();
        invalidateBannerCache();
        await loadBanners();
    } catch (err) {
        console.error('[AdminBanners] save:', err);
        toast('Save failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = editingId ? 'Save Changes' : 'Add Banner';
    }
};

window.toggleActive = async function (id, newActive) {
    try {
        await updateDoc(doc(db, 'site_banners', id), { active: newActive, updatedAt: serverTimestamp() });
        toast(`Banner ${newActive ? 'enabled' : 'disabled'}`, 'success');
        invalidateBannerCache(); await loadBanners();
    } catch (err) { toast('Update failed: ' + err.message, 'error'); }
};

window.deleteBanner = async function (id) {
    const ok = await confirmDialog('Delete Banner?',
        'This removes the banner from the home page. The Cloudinary image is kept.');
    if (!ok) return;
    try {
        await deleteDoc(doc(db, 'site_banners', id));
        toast('Banner deleted', 'success');
        invalidateBannerCache(); await loadBanners();
    } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
};

/* ══════════════════════════════════════════════
   BANNER DRAG-TO-REORDER
   ══════════════════════════════════════════════ */
window.onDragStart = function (e, idx) {
    dragSrcIndex = idx;
    e.dataTransfer.effectAllowed = 'move';
};
window.onDragOver = function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
};
window.onDrop = async function (e, targetIdx) {
    e.preventDefault();
    if (dragSrcIndex === null || dragSrcIndex === targetIdx) return;
    const moved = allBanners.splice(dragSrcIndex, 1)[0];
    allBanners.splice(targetIdx, 0, moved);
    dragSrcIndex = null;
    try {
        const batch = writeBatch(db);
        allBanners.forEach((b, i) => batch.update(doc(db, 'site_banners', b.id), { order: i }));
        await batch.commit();
        renderBanners();
        invalidateBannerCache();
        toast('Order saved', 'success');
    } catch (err) {
        toast('Reorder failed: ' + err.message, 'error');
        await loadBanners();
    }
};

/* ══════════════════════════════════════════════
   CATEGORY IMAGES — LOAD & RENDER
   ══════════════════════════════════════════════ */
export async function loadCategoryImages() {
    const grid = document.getElementById('abCatGrid');
    grid.innerHTML = `<div class="ab-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>`;
    try {
        const snap = await getDoc(doc(db, 'site_config', 'category_images'));
        categoryImages = snap.exists() ? snap.data() : {};
        renderCategoryCards();
    } catch (err) {
        console.error('[AdminBanners] cat load:', err);
        grid.innerHTML = `<div class="ab-empty"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load category images.</div>`;
    }
}
window.loadCategoryImages = loadCategoryImages;

function renderCategoryCards() {
    const grid = document.getElementById('abCatGrid');
    grid.innerHTML = CATEGORIES.map(cat => {
        const imgUrl   = categoryImages[cat.key] || '';
        const hasImage = !!imgUrl;
        return `
        <div class="ab-cat-card" onclick="openCatModal('${cat.key}')">
            <div class="ab-cat-preview"
                 style="background:${cat.bg};color:${cat.color};">
                ${hasImage
                    ? `<img src="${esc(imgUrl)}" alt="${cat.label}"
                            onerror="this.style.display='none'">
                       <div class="ab-cat-custom-badge">
                           <i class="fa-solid fa-check"></i>
                       </div>`
                    : `<i class="fa-solid ${cat.icon} ab-cat-preview-icon"></i>`
                }
            </div>
            <div class="ab-cat-label">${cat.label}</div>
            <div class="ab-cat-status ${hasImage ? 'custom' : ''}">
                ${hasImage ? 'Custom image' : 'Default icon'}
            </div>
            <button class="ab-cat-edit-btn" onclick="event.stopPropagation(); openCatModal('${cat.key}')">
                <i class="fa-solid fa-pen"></i>
                ${hasImage ? 'Change' : 'Upload Image'}
            </button>
        </div>`;
    }).join('');
}

/* ══════════════════════════════════════════════
   CATEGORY MODAL
   ══════════════════════════════════════════════ */
window.openCatModal = function (key) {
    pendingCatKey = key;
    pendingCatUrl = '';
    pendingCatPid = '';

    const cat = CATEGORIES.find(c => c.key === key);
    document.getElementById('abCatModalTitle').textContent =
        `${cat ? cat.label : key} — Category Image`;

    // Reset upload zone
    document.getElementById('abCatUploadPreview').style.display    = 'none';
    document.getElementById('abCatUploadPlaceholder').style.display = 'block';
    document.getElementById('abCatUploadBar').style.display         = 'none';
    document.getElementById('abCatUploadFill').style.width          = '0%';
    document.getElementById('abCatFileInput').value                 = '';
    document.getElementById('abCatSaveBtn').disabled                = true;

    // Show current image if set
    const currentUrl = categoryImages[key] || '';
    const curWrap    = document.getElementById('abCatCurrentWrap');
    if (currentUrl) {
        document.getElementById('abCatCurrentImg').src = currentUrl;
        curWrap.style.display = 'block';
    } else {
        curWrap.style.display = 'none';
    }

    document.getElementById('abCatModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.closeCatModal = function () {
    document.getElementById('abCatModalOverlay').classList.remove('open');
    document.body.style.overflow = '';
    pendingCatKey = null; pendingCatUrl = ''; pendingCatPid = '';
};

window.handleCatFileSelect = function (input) {
    const file = input.files[0];
    if (file) processCatFile(file);
};

function processCatFile(file) {
    if (file.size > 3 * 1024 * 1024) { toast('File too large — max 3 MB.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
        document.getElementById('abCatPreviewImg').src = e.target.result;
        document.getElementById('abCatPreviewName').textContent = file.name;
        document.getElementById('abCatUploadPreview').style.display    = 'block';
        document.getElementById('abCatUploadPlaceholder').style.display = 'none';
    };
    reader.readAsDataURL(file);
    uploadToCloudinary(file, 'category');
}

window.saveCategoryImage = async function () {
    if (!pendingCatUrl || !pendingCatKey) {
        toast('Please upload an image first.', 'error');
        return;
    }
    const btn = document.getElementById('abCatSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    try {
        categoryImages[pendingCatKey] = pendingCatUrl;
        await setDoc(
            doc(db, 'site_config', 'category_images'),
            categoryImages,
            { merge: true }
        );
        toast(`${pendingCatKey} image updated`, 'success');
        invalidateSiteConfigCache();
        closeCatModal();
        renderCategoryCards();
    } catch (err) {
        toast('Save failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Save Image';
    }
};

window.resetCategoryImage = async function () {
    if (!pendingCatKey) return;
    const cat = CATEGORIES.find(c => c.key === pendingCatKey);
    const ok  = await confirmDialog(
        `Reset ${cat?.label || pendingCatKey}?`,
        'This removes the custom image and restores the default icon.'
    );
    if (!ok) return;
    try {
        delete categoryImages[pendingCatKey];
        await setDoc(doc(db, 'site_config', 'category_images'), categoryImages);
        toast('Reset to default icon', 'success');
        invalidateSiteConfigCache();
        closeCatModal();
        renderCategoryCards();
    } catch (err) {
        toast('Reset failed: ' + err.message, 'error');
    }
};

/* ══════════════════════════════════════════════
   WORKER CACHE INVALIDATION
   ══════════════════════════════════════════════ */
/* Worker cache calls carry the admin's Firebase ID token (checked for admin / manage_banners) */
async function workerHeaders() {
    const idToken = await auth.currentUser?.getIdToken();
    return { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) };
}

async function invalidateBannerCache() {
    try {
        await fetch(`${WORKER_URL}/api/cache/refresh-banners`, {
            method: 'POST',
            headers: await workerHeaders()
        });
    } catch (err) { console.warn('[AdminBanners] banner cache invalidate:', err.message); }
}

async function invalidateSiteConfigCache() {
    try {
        await fetch(`${WORKER_URL}/api/site-config`, {
            method: 'POST',
            headers: await workerHeaders()
        });
    } catch (err) { console.warn('[AdminBanners] site-config cache invalidate:', err.message); }
}

/* ══════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════ */
function esc(s) {
    return String(s || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
