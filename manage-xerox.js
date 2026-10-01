/* ═══════════════════════════════════════════════
   MANAGE XEROX SETUP — admin + manage_xerox
   Firestore:
     xerox_config_lamination  { name, price, sortOrder, images[] }
     xerox_config_binding     { name, price, sortOrder, images[] }
     xerox_config_paper       { name, sortOrder, optionsOrder[],
       bwPrices, colorPrices, options{…}, images[] }
   ═══════════════════════════════════════════════ */

import { auth, db }           from './firebase-init.js';
import { CLOUDINARY_CONFIG, WORKER_URL, initAppConfig, getAdminToken }
                               from './env-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    collection, getDocs, doc, getDoc,
    addDoc, updateDoc, deleteDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

/* ─── State ─────────────────────────────────── */
window.activeTab = 'lamination';
const configCache = { binding: [], lamination: [] };
let sFiles = [];   // simple modal images
let pFiles = [];   // paper modal images
let _reorderItems = [];
let _reorderType  = '';

/* ─── Toast ─────────────────────────────────── */
function toast(msg, type = '') {
    const el = document.getElementById('mxToast');
    el.textContent = msg;
    el.className   = 'mx-toast ' + type;
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

/* ─── Escape HTML ────────────────────────────── */
function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ═══════════════════════════════════════════════
   TAB SWITCHING
   ═══════════════════════════════════════════════ */
const TAB_LABELS = {
    lamination: 'LAMINATION TYPES',
    binding:    'BINDING TYPES',
    paper:      'PAPER TYPES',
};

window.switchTab = function(tab, btn) {
    window.activeTab = tab;
    document.querySelectorAll('.mx-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.getElementById('listTitle').textContent = TAB_LABELS[tab];
    // In per-shop modes, delegate to the shop renderer; otherwise universal
    if (window._shopMode && window._shopMode !== 'universal') {
        renderShopView();
    } else {
        loadTab(tab);
    }
};

window.openAddModal = function() {
    // Add is only available in universal mode
    if (window._shopMode && window._shopMode !== 'universal') {
        toast('Switch to Universal mode to add new types.', 'error');
        return;
    }
    if (window.activeTab === 'paper') openPaperModal();
    else openSimpleModal(window.activeTab);
};

/* ═══════════════════════════════════════════════
   LOAD & RENDER TAB
   ═══════════════════════════════════════════════ */
function loadTab(tab) {
    const grid  = document.getElementById('cardGrid');
    const badge = document.getElementById('listCount');
    grid.innerHTML = '<div class="mx-skeleton"></div>'.repeat(3);

    onSnapshot(collection(db, `xerox_config_${tab}`), snap => {
        const items = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

        if (tab === 'binding')    configCache.binding    = items;
        if (tab === 'lamination') configCache.lamination = items;

        badge.textContent = items.length;

        if (!items.length) {
            grid.innerHTML = `<div class="mx-empty"><i class="fa-solid fa-inbox"></i>No ${tab} types yet. Tap Add to create one.</div>`;
            return;
        }
        grid.innerHTML = items.map(item => buildCard(item, tab)).join('');
    });
}

/* ═══════════════════════════════════════════════
   BUILD CARD HTML
   ═══════════════════════════════════════════════ */
function buildCard(item, tab) {
    const img     = item.images?.find(i => i.isPrimary)?.url || item.images?.[0]?.url || '';
    const imgHtml = img
        ? `<img src="${esc(img)}" alt="${esc(item.name)}" loading="lazy">`
        : `<div class="mx-no-img"><i class="fa-solid fa-image"></i></div>`;

    if (tab === 'paper') {
        return `
        <div class="mx-card mx-card--paper">
            <div class="mx-card-img" style="padding-top:60%;">${imgHtml}</div>
            <div class="mx-card-body">
                <div class="mx-card-name" title="${esc(item.name)}">${esc(item.name)}</div>
                <div class="mx-card-grid">
                    <div class="mx-card-kv">
                        <div class="mx-card-kv-label">B&amp;W Front</div>
                        <div class="mx-card-kv-val">₹${item.bwPrices?.frontOnly ?? 0}</div>
                    </div>
                    <div class="mx-card-kv">
                        <div class="mx-card-kv-label" style="color:var(--primary)">Color Front</div>
                        <div class="mx-card-kv-val mx-card-kv-val--blue">₹${item.colorPrices?.frontOnly ?? 0}</div>
                    </div>
                </div>
                <span class="mx-sort-badge"><i class="fa-solid fa-arrow-up-1-9"></i> #${(item.sortOrder ?? 0) + 1}</span>
            </div>
            <div class="mx-card-actions">
                <button class="mx-card-btn mx-card-btn--edit" onclick="editPaper('${esc(item.id)}')">
                    <i class="fa-solid fa-pen"></i> Edit
                </button>
                <button class="mx-card-btn mx-card-btn--del" onclick="confirmDelete('paper','${esc(item.id)}','${esc(item.name)}')">
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </div>
        </div>`;
    }

    return `
    <div class="mx-card">
        <div class="mx-card-img">${imgHtml}</div>
        <div class="mx-card-body">
            <div class="mx-card-name" title="${esc(item.name)}">${esc(item.name)}</div>
            <span class="mx-card-price-tag"><i class="fa-solid fa-tag" style="font-size:.6rem;"></i>₹${item.price ?? 0}</span>
            <span class="mx-sort-badge"><i class="fa-solid fa-arrow-up-1-9"></i> #${(item.sortOrder ?? 0) + 1}</span>
        </div>
        <div class="mx-card-actions">
            <button class="mx-card-btn mx-card-btn--edit" onclick="editSimple('${esc(tab)}','${esc(item.id)}')">
                <i class="fa-solid fa-pen"></i> Edit
            </button>
            <button class="mx-card-btn mx-card-btn--del" onclick="confirmDelete('${esc(tab)}','${esc(item.id)}','${esc(item.name)}')">
                <i class="fa-solid fa-trash"></i> Delete
            </button>
        </div>
    </div>`;
}

/* ═══════════════════════════════════════════════
   IMAGE HELPERS
   ═══════════════════════════════════════════════ */
function setupImageInput(inputId, previewId, fileArr, maxCount) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener('change', () => {
        const existingCount = document.querySelectorAll(`#${previewId} [data-existing]`).length;
        const newFiles = Array.from(input.files);
        if (existingCount + fileArr.length + newFiles.length > maxCount) {
            toast(`Max ${maxCount} images allowed.`, 'error'); return;
        }
        newFiles.forEach(file => {
            const reader = new FileReader();
            reader.onload = re => { fileArr.push({ file, src: re.target.result }); renderPreviews(previewId, fileArr); };
            reader.readAsDataURL(file);
        });
        input.value = '';
    });
}

function renderPreviews(previewId, fileArr, existingImages = null) {
    const row = document.getElementById(previewId);
    if (!row) return;
    const existingDivs = existingImages !== null ? [] : Array.from(row.querySelectorAll('[data-existing]'));
    row.innerHTML = '';
    (existingImages || []).forEach((img, i) => {
        const div = document.createElement('div');
        div.className = 'mx-preview-item';
        div.dataset.existing = JSON.stringify(img);
        div.innerHTML = `
            <img src="${esc(img.url)}" class="mx-preview-img">
            <button type="button" class="mx-preview-rm" onclick="this.closest('.mx-preview-item').remove()"><i class="fa-solid fa-xmark"></i></button>
            <input type="radio" name="${previewId}-primary" value="ex-${i}" class="mx-primary-radio" ${img.isPrimary?'checked':''}>`;
        row.appendChild(div);
    });
    if (existingImages === null) existingDivs.forEach(div => row.appendChild(div));
    fileArr.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'mx-preview-item';
        div.innerHTML = `
            <img src="${item.src}" class="mx-preview-img">
            <button type="button" class="mx-preview-rm" onclick="removeFile('${previewId}',${i})"><i class="fa-solid fa-xmark"></i></button>
            <input type="radio" name="${previewId}-primary" value="new-${i}" class="mx-primary-radio">`;
        row.appendChild(div);
    });
}

window.removeFile = function(previewId, idx) {
    const arr = previewId.startsWith('s') ? sFiles : pFiles;
    arr.splice(idx, 1);
    renderPreviews(previewId, arr);
};

async function uploadImages(fileArr, previewId) {
    // Ensure config is loaded before reading CLOUDINARY_CONFIG
    await initAppConfig();

    const CLOUD_URL  = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/image/upload`;
    const primaryVal = document.querySelector(`input[name="${previewId}-primary"]:checked`)?.value;
    const result     = [];
    document.querySelectorAll(`#${previewId} [data-existing]`).forEach((node, i) => {
        const img = JSON.parse(node.dataset.existing);
        img.isPrimary = primaryVal === `ex-${i}`;
        result.push(img);
    });
    for (let i = 0; i < fileArr.length; i++) {
        const fd = new FormData();
        fd.append('file', fileArr[i].file);
        fd.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);
        fd.append('api_key',       CLOUDINARY_CONFIG.apiKey);
        const res  = await fetch(CLOUD_URL, { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Image upload failed');
        result.push({ url: data.secure_url, publicId: data.public_id, isPrimary: primaryVal === `new-${i}` });
    }
    if (result.length && !result.some(i => i.isPrimary)) result[0].isPrimary = true;
    return result;
}

/* ═══════════════════════════════════════════════
   CLOUDFLARE CACHE BUST
   ═══════════════════════════════════════════════ */
async function bustXeroxCache() {
    try {
        // Also clear the user-side localStorage so the 6hr local cache doesn't serve stale config
        try { localStorage.removeItem('jasa_xerox_config_v1'); } catch (_) {}
        const idToken = await auth.currentUser?.getIdToken();
        const adminKey = idToken ? await getAdminToken(idToken) : null;
        const headers = {
            'Content-Type': 'application/json',
            ...(adminKey ? { 'Authorization': `Bearer ${adminKey}` } : {})
        };
        await fetch(`${WORKER_URL}/api/cache/clear?type=config`, {
            method: 'DELETE',
            headers
        });
        console.log('[ManageXerox] Worker cache cleared ✓');
    } catch (e) {
        console.warn('[ManageXerox] Cache bust non-fatal:', e.message);
    }
}

/* Bust the shops KV cache — called when xeroxConfig fields on a shop doc change */
async function bustShopsCache() {
    try {
        // Also clear user-side localStorage so the 6hr local cache doesn't serve stale data
        try {
            Object.keys(localStorage)
                .filter(k =>
                    k.includes('global_shops_data') ||
                    k.includes('xerox_shops_data')  ||
                    k === 'jasa_xerox_shops_v1'     ||
                    k === 'jasa_xerox_shops_v2'
                )
                .forEach(k => localStorage.removeItem(k));
        } catch (_) {}
        const idToken = await auth.currentUser?.getIdToken();
        const adminKey = idToken ? await getAdminToken(idToken) : null;
        const headers = {
            'Content-Type': 'application/json',
            ...(adminKey ? { 'Authorization': `Bearer ${adminKey}` } : {})
        };
        await fetch(`${WORKER_URL}/api/cache/clear?type=shops`, {
            method: 'DELETE',
            headers
        });
        console.log('[ManageXerox] Worker shops cache cleared ✓');
    } catch (e) {
        console.warn('[ManageXerox] Shops cache bust non-fatal:', e.message);
    }
}

/* ═══════════════════════════════════════════════
   REORDER SHEET  — drag all at once, save in batch
   ═══════════════════════════════════════════════ */
window.openReorderSheet = async function() {
    _reorderType = window.activeTab;
    const tab    = _reorderType;

    document.getElementById('reorderSheetTitle').textContent =
        ({ lamination:'Reorder Lamination', binding:'Reorder Binding', paper:'Reorder Paper Types' })[tab] || 'Reorder';

    const list = document.getElementById('reorderList');
    list.innerHTML = '<li style="text-align:center;padding:24px;color:var(--txt3);font-size:.82rem;"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</li>';

    document.getElementById('reorderSheetOverlay').classList.add('open');
    document.getElementById('reorderSheet').classList.add('open');
    document.body.style.overflow = 'hidden';

    const snap = await getDocs(collection(db, `xerox_config_${tab}`));
    _reorderItems = snap.docs.map(d => {
        const data = d.data();
        const meta = tab === 'paper' ? `B&W ₹${data.bwPrices?.frontOnly ?? 0}` : `₹${data.price ?? 0}`;
        return { id: d.id, name: data.name || d.id, sortOrder: data.sortOrder ?? 0, meta };
    }).sort((a, b) => a.sortOrder - b.sortOrder);

    renderReorderList();
};

function renderReorderList() {
    const list = document.getElementById('reorderList');
    if (!_reorderItems.length) {
        list.innerHTML = '<li style="text-align:center;padding:24px;color:var(--txt3);font-size:.82rem;">No items yet.</li>';
        return;
    }
    const total = _reorderItems.length;
    list.innerHTML = _reorderItems.map((item, idx) => `
        <li class="mx-reorder-item" data-id="${esc(item.id)}" draggable="false">
            <span class="mx-reorder-handle"><i class="fa-solid fa-grip-lines"></i></span>
            <span class="mx-reorder-pos">${idx + 1}</span>
            <span class="mx-reorder-name">${esc(item.name)}</span>
            <span class="mx-reorder-meta">${esc(item.meta)}</span>
            <div class="mx-reorder-arrows">
                <button class="mx-arrow-btn" onclick="moveReorderItem(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} title="Move up">
                    <i class="fa-solid fa-chevron-up"></i>
                </button>
                <button class="mx-arrow-btn" onclick="moveReorderItem(${idx}, 1)" ${idx === total - 1 ? 'disabled' : ''} title="Move down">
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
            </div>
        </li>`).join('');
    initReorderDrag();
}

window.moveReorderItem = function(idx, direction) {
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= _reorderItems.length) return;
    // Swap
    [_reorderItems[idx], _reorderItems[newIdx]] = [_reorderItems[newIdx], _reorderItems[idx]];
    renderReorderList();
};

function initReorderDrag() {
    const list  = document.getElementById('reorderList');
    let dragged = null;

    list.querySelectorAll('.mx-reorder-item').forEach(row => {
        const handle = row.querySelector('.mx-reorder-handle');
        handle.addEventListener('mousedown',  () => { row.draggable = true; });
        handle.addEventListener('touchstart', () => { row.draggable = true; }, { passive: true });

        row.addEventListener('dragstart', e => {
            dragged = row;
            row.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            row.draggable = false;
            dragged = null;
            list.querySelectorAll('.mx-reorder-item').forEach(r => r.classList.remove('drag-over'));
            _reorderItems = [...list.querySelectorAll('.mx-reorder-item')]
                .map(r => _reorderItems.find(i => i.id === r.dataset.id)).filter(Boolean);
            list.querySelectorAll('.mx-reorder-pos').forEach((el, i) => { el.textContent = i + 1; });
        });
        row.addEventListener('dragover', e => {
            e.preventDefault();
            if (dragged && dragged !== row) {
                list.querySelectorAll('.mx-reorder-item').forEach(r => r.classList.remove('drag-over'));
                row.classList.add('drag-over');
            }
        });
        row.addEventListener('drop', e => {
            e.preventDefault();
            row.classList.remove('drag-over');
            if (dragged && dragged !== row) {
                const rows = [...list.querySelectorAll('.mx-reorder-item')];
                if (rows.indexOf(dragged) < rows.indexOf(row)) list.insertBefore(dragged, row.nextSibling);
                else                                            list.insertBefore(dragged, row);
            }
        });
    });
}

window.closeReorderSheet = function() {
    document.getElementById('reorderSheetOverlay').classList.remove('open');
    document.getElementById('reorderSheet').classList.remove('open');
    document.body.style.overflow = '';
};

window.saveReorder = async function() {
    const btn  = document.getElementById('saveOrderBtn');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    btn.disabled  = true;
    try {
        const rows = [...document.querySelectorAll('#reorderList .mx-reorder-item')];
        await Promise.all(rows.map((row, idx) =>
            updateDoc(doc(db, `xerox_config_${_reorderType}`, row.dataset.id), {
                sortOrder: idx, updatedAt: new Date().toISOString()
            })
        ));
        await bustXeroxCache();
        toast('Order saved!', 'success');
        window.closeReorderSheet();
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
    btn.innerHTML = orig;
    btn.disabled  = false;
};

/* ═══════════════════════════════════════════════
   SIMPLE MODAL  (Lamination / Binding)
   ═══════════════════════════════════════════════ */
const typeLabels = { lamination: 'Lamination', binding: 'Binding' };

window.openSimpleModal = function(type) {
    sFiles = [];
    document.getElementById('sEditId').value  = '';
    document.getElementById('sType').value    = type;
    document.getElementById('simpleModalTitle').textContent = `Add ${typeLabels[type]}`;
    document.getElementById('simpleModalSub').textContent   = 'Name &amp; price';
    document.getElementById('sSubmitText').textContent      = 'Save';
    document.getElementById('sName').value    = '';
    document.getElementById('sPrice').value   = '';
    document.getElementById('sPreviewRow').innerHTML = '';
    document.getElementById('simpleModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.editSimple = async function(type, id) {
    const snap = await getDoc(doc(db, `xerox_config_${type}`, id));
    if (!snap.exists()) { toast('Not found.', 'error'); return; }
    const item = snap.data();
    sFiles = [];
    document.getElementById('sEditId').value  = id;
    document.getElementById('sType').value    = type;
    document.getElementById('simpleModalTitle').textContent = `Edit ${typeLabels[type]}`;
    document.getElementById('simpleModalSub').textContent   = item.name;
    document.getElementById('sSubmitText').textContent      = 'Update';
    document.getElementById('sName').value    = item.name  || '';
    document.getElementById('sPrice').value   = item.price ?? '';
    renderPreviews('sPreviewRow', [], item.images || []);
    document.getElementById('simpleModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.closeSimpleModal = function() {
    document.getElementById('simpleModalOverlay').classList.remove('open');
    document.body.style.overflow = '';
};

window.submitSimple = async function() {
    const type  = document.getElementById('sType').value;
    const id    = document.getElementById('sEditId').value;
    const name  = document.getElementById('sName').value.trim();
    const price = parseFloat(document.getElementById('sPrice').value || 0);
    if (!name) { toast('Name is required.', 'error'); return; }

    const btn  = document.getElementById('sSubmitBtn');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled  = true;
    try {
        const images = await uploadImages(sFiles, 'sPreviewRow');
        // sortOrder is managed exclusively via the Reorder sheet; preserve existing or default to end
        let sortOrder;
        if (id) {
            const existing = await getDoc(doc(db, `xerox_config_${type}`, id));
            sortOrder = existing.exists() ? (existing.data().sortOrder ?? 0) : await getNextSortOrder(type);
        } else {
            sortOrder = await getNextSortOrder(type);
        }
        const data = { name, price, images, sortOrder, updatedAt: new Date().toISOString() };
        if (id) {
            await updateDoc(doc(db, `xerox_config_${type}`, id), data);
            toast(`${typeLabels[type]} updated!`, 'success');
        } else {
            data.createdAt = data.updatedAt;
            await addDoc(collection(db, `xerox_config_${type}`), data);
            toast(`${typeLabels[type]} added! Use Reorder to position it.`, 'success');
        }
        await bustXeroxCache();
        window.closeSimpleModal();
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
    btn.innerHTML = orig;
    btn.disabled  = false;
};

/** Auto-assign sortOrder = max+1 for new items */
async function getNextSortOrder(type) {
    const snap = await getDocs(collection(db, `xerox_config_${type}`));
    if (snap.empty) return 0;
    return Math.max(...snap.docs.map(d => d.data().sortOrder ?? 0)) + 1;
}

/* ═══════════════════════════════════════════════
   PAPER MODAL — option drag-to-reorder
   ═══════════════════════════════════════════════ */
function syncBindLamCheckboxes() {
    document.getElementById('subBinding').innerHTML = configCache.binding.length
        ? configCache.binding.map(b => `
            <label class="mx-check-label">
                <input type="checkbox" class="sub-opt-binding" value="${esc(b.id)}" id="sbind-${esc(b.id)}" checked>
                ${esc(b.name)}
            </label>`).join('')
        : '<span class="mx-option-empty">No binding types yet.</span>';

    document.getElementById('subLamination').innerHTML = configCache.lamination.length
        ? configCache.lamination.map(l => `
            <label class="mx-check-label">
                <input type="checkbox" class="sub-opt-lamination" value="${esc(l.id)}" id="slam-${esc(l.id)}" checked>
                ${esc(l.name)}
            </label>`).join('')
        : '<span class="mx-option-empty">No lamination types yet.</span>';
}

window.syncOptionVis = function(key) {
    const K   = key.charAt(0).toUpperCase() + key.slice(1);
    const sw  = document.getElementById(`opt${K}`);
    const sub = document.getElementById(`sub${K}`);
    if (sw && sub) sub.style.display = sw.checked ? '' : 'none';
};

function initDragSort() {
    const list = document.getElementById('optionsList');
    if (!list) return;
    let dragged = null;
    list.querySelectorAll('.mx-option-row').forEach(row => {
        const handle = row.querySelector('.mx-drag-handle');
        if (!handle) return;
        handle.addEventListener('mousedown',  () => { row.draggable = true; });
        handle.addEventListener('touchstart', () => { row.draggable = true; }, { passive: true });
        row.addEventListener('dragstart', e => { dragged = row; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
        row.addEventListener('dragend',   () => {
            row.classList.remove('dragging'); row.draggable = false; dragged = null;
            list.querySelectorAll('.mx-option-row').forEach(r => r.classList.remove('drag-over'));
        });
        row.addEventListener('dragover', e => {
            e.preventDefault();
            if (dragged && dragged !== row) {
                list.querySelectorAll('.mx-option-row').forEach(r => r.classList.remove('drag-over'));
                row.classList.add('drag-over');
            }
        });
        row.addEventListener('drop', e => {
            e.preventDefault(); row.classList.remove('drag-over');
            if (dragged && dragged !== row) {
                const rows = [...list.querySelectorAll('.mx-option-row')];
                if (rows.indexOf(dragged) < rows.indexOf(row)) list.insertBefore(dragged, row.nextSibling);
                else                                            list.insertBefore(dragged, row);
            }
        });
    });
}

function getOptionsOrder() {
    return [...document.querySelectorAll('#optionsList .mx-option-row[data-option]')].map(r => r.dataset.option);
}

function applyOptionsOrder(order) {
    if (!Array.isArray(order) || !order.length) return;
    const list   = document.getElementById('optionsList');
    if (!list) return;
    const imgRow = list.querySelector('.mx-option-row:not([data-option])');
    order.forEach(key => {
        const row = list.querySelector(`.mx-option-row[data-option="${key}"]`);
        if (row) list.insertBefore(row, imgRow || null);
    });
}

window.openPaperModal = async function() {
    pFiles = [];
    document.getElementById('pEditId').value = '';
    document.getElementById('paperModalTitle').textContent = 'Add Paper Type';
    document.getElementById('pSubmitText').textContent     = 'Save Paper Type';
    document.getElementById('pName').value       = '';
    document.getElementById('pBwFront').value    = '0';
    document.getElementById('pBwBoth').value     = '0';
    document.getElementById('pColorFront').value = '0';
    document.getElementById('pColorBoth').value  = '0';
    document.getElementById('pPreviewRow').innerHTML = '';

    ['optColor','optFormat','optBinding','optLamination'].forEach(id => {
        const el = document.getElementById(id); if (el) el.checked = true;
    });
    document.getElementById('optRatio').checked = false;
    // Color sub-options
    ['subBw','subColor'].forEach(id => {
        const el = document.getElementById(id); if (el) el.checked = true;
    });
    // Format Types — per color mode
    ['subFormatBw_frontOnly','subFormatBw_both','subFormatColor_frontOnly','subFormatColor_both'].forEach(id => {
        const el = document.getElementById(id); if (el) el.checked = true;
    });
    // Print Ratios — per color mode
    ['subRatioBw_11','subRatioBw_12','subRatioColor_11','subRatioColor_12'].forEach(id => {
        const el = document.getElementById(id); if (el) el.checked = true;
    });
    ['color','format','ratio','binding','lamination'].forEach(k => syncOptionVis(k));
    applyOptionsOrder(['color','format','ratio','binding','lamination']);
    syncBindLamCheckboxes();
    initDragSort();

    document.getElementById('paperModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.closePaperModal = function() {
    document.getElementById('paperModalOverlay').classList.remove('open');
    document.body.style.overflow = '';
};

window.editPaper = async function(id) {
    const snap = await getDoc(doc(db, 'xerox_config_paper', id));
    if (!snap.exists()) { toast('Not found.', 'error'); return; }
    const item = snap.data();
    pFiles = [];

    document.getElementById('pEditId').value = id;
    document.getElementById('paperModalTitle').textContent = 'Edit Paper Type';
    document.getElementById('pSubmitText').textContent     = 'Update Paper Type';
    document.getElementById('pName').value       = item.name || '';
    document.getElementById('pBwFront').value    = item.bwPrices?.frontOnly   ?? 0;
    document.getElementById('pBwBoth').value     = item.bwPrices?.frontBack   ?? 0;
    document.getElementById('pColorFront').value = item.colorPrices?.frontOnly ?? 0;
    document.getElementById('pColorBoth').value  = item.colorPrices?.frontBack ?? 0;
    renderPreviews('pPreviewRow', [], item.images || []);
    syncBindLamCheckboxes();

    const opts = item.options || {};

    const colorOpts = opts.color || { enabled: true, selection: ['bw','color'] };
    document.getElementById('optColor').checked = colorOpts.enabled !== false;
    document.getElementById('subBw').checked    = colorOpts.selection?.includes('bw')    ?? true;
    document.getElementById('subColor').checked = colorOpts.selection?.includes('color') ?? true;
    syncOptionVis('color');

    const fmtOpts = opts.format || { enabled: true, bw: { selection: ['frontOnly','both'] }, color: { selection: ['frontOnly','both'] } };
    document.getElementById('optFormat').checked = fmtOpts.enabled !== false;
    // Support old flat format: { selection: [...] } by spreading into both panels
    const fmtBwSel    = fmtOpts.bw?.selection    ?? fmtOpts.selection ?? ['frontOnly','both'];
    const fmtColorSel = fmtOpts.color?.selection  ?? fmtOpts.selection ?? ['frontOnly','both'];
    document.getElementById('subFormatBw_frontOnly').checked    = fmtBwSel.includes('frontOnly');
    document.getElementById('subFormatBw_both').checked         = fmtBwSel.includes('both');
    document.getElementById('subFormatColor_frontOnly').checked = fmtColorSel.includes('frontOnly');
    document.getElementById('subFormatColor_both').checked      = fmtColorSel.includes('both');
    syncOptionVis('format');

    const ratOpts = opts.ratio || { enabled: false, bw: { selection: ['1:1','1:2'] }, color: { selection: ['1:1','1:2'] } };
    document.getElementById('optRatio').checked = ratOpts.enabled === true;
    // Support old flat ratio: { selection: [...] } by spreading into both panels
    const ratBwSel    = ratOpts.bw?.selection    ?? ratOpts.selection ?? ['1:1','1:2'];
    const ratColorSel = ratOpts.color?.selection  ?? ratOpts.selection ?? ['1:1','1:2'];
    document.getElementById('subRatioBw_11').checked    = ratBwSel.includes('1:1');
    document.getElementById('subRatioBw_12').checked    = ratBwSel.includes('1:2');
    document.getElementById('subRatioColor_11').checked = ratColorSel.includes('1:1');
    document.getElementById('subRatioColor_12').checked = ratColorSel.includes('1:2');
    syncOptionVis('ratio');

    const bndOpts = opts.binding || { enabled: true, selection: [] };
    document.getElementById('optBinding').checked = bndOpts.enabled !== false;
    configCache.binding.forEach(b => {
        const el = document.getElementById(`sbind-${b.id}`);
        if (el) el.checked = bndOpts.selection?.includes(b.id) ?? true;
    });
    syncOptionVis('binding');

    const lamOpts = opts.lamination || { enabled: true, selection: [] };
    document.getElementById('optLamination').checked = lamOpts.enabled !== false;
    configCache.lamination.forEach(l => {
        const el = document.getElementById(`slam-${l.id}`);
        if (el) el.checked = lamOpts.selection?.includes(l.id) ?? true;
    });
    syncOptionVis('lamination');

    applyOptionsOrder(item.optionsOrder || ['color','format','ratio','binding','lamination']);
    initDragSort();

    document.getElementById('paperModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.submitPaper = async function() {
    const id   = document.getElementById('pEditId').value;
    const name = document.getElementById('pName').value.trim();
    if (!name) { toast('Paper name is required.', 'error'); return; }

    const optionsOrder = getOptionsOrder();
    const colorSel = [];
    if (document.getElementById('subBw')?.checked)    colorSel.push('bw');
    if (document.getElementById('subColor')?.checked) colorSel.push('color');
    // Format Types — per color mode
    const fmtBwSel    = [];
    if (document.getElementById('subFormatBw_frontOnly')?.checked)    fmtBwSel.push('frontOnly');
    if (document.getElementById('subFormatBw_both')?.checked)         fmtBwSel.push('both');
    const fmtColorSel = [];
    if (document.getElementById('subFormatColor_frontOnly')?.checked) fmtColorSel.push('frontOnly');
    if (document.getElementById('subFormatColor_both')?.checked)      fmtColorSel.push('both');
    // Print Ratios — per color mode
    const ratBwSel    = [];
    if (document.getElementById('subRatioBw_11')?.checked)    ratBwSel.push('1:1');
    if (document.getElementById('subRatioBw_12')?.checked)    ratBwSel.push('1:2');
    const ratColorSel = [];
    if (document.getElementById('subRatioColor_11')?.checked) ratColorSel.push('1:1');
    if (document.getElementById('subRatioColor_12')?.checked) ratColorSel.push('1:2');
    const bndSel = Array.from(document.querySelectorAll('.sub-opt-binding:checked')).map(e => e.value);
    const lamSel = Array.from(document.querySelectorAll('.sub-opt-lamination:checked')).map(e => e.value);

    const btn  = document.getElementById('pSubmitBtn');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled  = true;

    try {
        // Preserve existing sortOrder (position managed via Reorder sheet); assign end for new
        let sortOrder;
        if (id) {
            const existing = await getDoc(doc(db, 'xerox_config_paper', id));
            sortOrder = existing.exists() ? (existing.data().sortOrder ?? 0) : await getNextSortOrder('paper');
        } else {
            sortOrder = await getNextSortOrder('paper');
        }

        const data = {
            name, sortOrder, optionsOrder,
            bwPrices:    { frontOnly: parseFloat(document.getElementById('pBwFront').value    || 0), frontBack: parseFloat(document.getElementById('pBwBoth').value     || 0) },
            colorPrices: { frontOnly: parseFloat(document.getElementById('pColorFront').value || 0), frontBack: parseFloat(document.getElementById('pColorBoth').value  || 0) },
            options: {
                color:      { enabled: document.getElementById('optColor').checked,      selection: colorSel },
                format:     { enabled: document.getElementById('optFormat').checked,     bw: { selection: fmtBwSel }, color: { selection: fmtColorSel } },
                ratio:      { enabled: document.getElementById('optRatio').checked,      bw: { selection: ratBwSel }, color: { selection: ratColorSel } },
                binding:    { enabled: document.getElementById('optBinding').checked,    selection: bndSel   },
                lamination: { enabled: document.getElementById('optLamination').checked, selection: lamSel   },
            },
            updatedAt: new Date().toISOString(),
        };
        data.images = await uploadImages(pFiles, 'pPreviewRow');
        if (id) {
            await updateDoc(doc(db, 'xerox_config_paper', id), data);
            toast('Paper type updated!', 'success');
        } else {
            data.createdAt = data.updatedAt;
            await addDoc(collection(db, 'xerox_config_paper'), data);
            toast('Paper type saved! Use Reorder to position it.', 'success');
        }
        await bustXeroxCache();
        window.closePaperModal();
    } catch (err) { console.error('[submitPaper]', err); toast('Save failed: ' + err.message, 'error'); }

    btn.innerHTML = orig;
    btn.disabled  = false;
};

/* ═══════════════════════════════════════════════
   DELETE
   ═══════════════════════════════════════════════ */
window.confirmDelete = function(type, id, name) {
    document.getElementById('deleteDialogMsg').innerHTML = `Delete <b>${esc(name)}</b>? This cannot be undone.`;
    document.getElementById('deleteConfirmBtn').onclick  = () => doDelete(type, id);
    document.getElementById('deleteDialogOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};
window.closeDeleteDialog = function() {
    document.getElementById('deleteDialogOverlay').classList.remove('open');
    document.body.style.overflow = '';
};
async function doDelete(type, id) {
    window.closeDeleteDialog();
    try {
        await deleteDoc(doc(db, `xerox_config_${type}`, id));
        await bustXeroxCache();
        toast('Deleted.', 'success');
    } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
}

/* ═══════════════════════════════════════════════
   AUTH GUARD — admin OR manage_xerox
   ═══════════════════════════════════════════════ */
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search)); return; }
    try {
        const cached = localStorage.getItem('jasa_user_cache');
        if (cached) {
            const cd = JSON.parse(cached);
            const cr = cd.roles || [cd.role || 'user'];
            if (!cr.includes('admin') && !cr.includes('manage_xerox')) {
                window.location.replace('index.html'); return;
            }
        }
    } catch (_) {}
    try {
        const snap  = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin') && !roles.includes('manage_xerox')) {
            toast('Access denied.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1200);
            return;
        }
        getDocs(collection(db, 'xerox_config_binding'))
            .then(s => { configCache.binding    = s.docs.map(d => ({ id: d.id, ...d.data() })); });
        getDocs(collection(db, 'xerox_config_lamination'))
            .then(s => { configCache.lamination = s.docs.map(d => ({ id: d.id, ...d.data() })); });
        loadTab(window.activeTab);
        setupImageInput('sImages', 'sPreviewRow', sFiles, 3);
        setupImageInput('pImages', 'pPreviewRow', pFiles, 5);
        // Init per-shop feature
        if (typeof window._initShopFeature === 'function') window._initShopFeature();
    } catch (err) {
        console.error('[ManageXerox] auth error:', err);
        window.location.replace('index.html');
    }
});

/* ═══════════════════════════════════════════════
   PER-SHOP XEROX CONFIGURATION
   ═══════════════════════════════════════════════ */

/* ─── Per-shop state ─────────────────────────── */
window._shopMode    = null;   // 'universal' | 'manage' | 'pricing'
let _currentShopId  = null;
let _shopConfig     = null;   // xeroxConfig sub-object from shop doc
let _allShops       = [];
let _unsubShopCfg   = null;
let _shopSimpleCtx  = null;   // { type, id } for save
let _shopPaperCtx   = null;   // { id } for save

/* ─── Load shops (Xerox service only) ─────────── */
async function loadShopsForSelector() {
    try {
        const snap = await getDocs(collection(db, 'shops'));
        _allShops = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => (s.services || []).some(sv => sv.toLowerCase() === 'xerox'))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        const sel = document.getElementById('shopSelector');
        sel.innerHTML = '<option value="">— Select a Xerox Shop to configure —</option>' +
            _allShops.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    } catch (err) {
        console.error('[ManageXerox] loadShops:', err);
        toast('Failed to load shops.', 'error');
    }
}

/* ─── Shop change handler ────────────────────── */
window.handleShopChange = function(shopId) {
    // Unsubscribe previous listener
    if (_unsubShopCfg) { _unsubShopCfg(); _unsubShopCfg = null; }

    if (!shopId) {
        _currentShopId = null;
        _shopConfig    = null;
        window._shopMode = null;
        document.getElementById('modeBar').style.display = 'none';
        // Reset reorder btn visibility and header add btn
        document.getElementById('reorderBtn').style.display = '';
        document.getElementById('headerAddBtn').style.display = '';
        loadTab(window.activeTab);
        return;
    }

    _currentShopId   = shopId;
    window._shopMode = 'universal'; // default
    document.getElementById('modeBar').style.display = 'grid';

    // Activate Universal tab in mode bar
    document.querySelectorAll('.mx-mode-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === 'universal');
    });

    // Subscribe to shop doc for live xeroxConfig updates
    _unsubShopCfg = onSnapshot(doc(db, 'shops', _currentShopId), snap => {
        _shopConfig = snap.data()?.xeroxConfig || { lamination: {}, binding: {}, paper: {} };
        if (window._shopMode && window._shopMode !== 'universal') renderShopView();
    }, err => console.error('[ManageXerox] shopCfg listener:', err));

    // Start in universal mode — show existing grid
    switchMode('universal', document.querySelector('.mx-mode-tab[data-mode="universal"]'));
};

/* ─── Mode switching ─────────────────────────── */
window.switchMode = function(mode, btn) {
    window._shopMode = mode;

    document.querySelectorAll('.mx-mode-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    const reorderBtn = document.getElementById('reorderBtn');
    const addBtn     = document.getElementById('headerAddBtn');

    if (mode === 'universal') {
        reorderBtn.style.display = '';
        addBtn.style.display     = '';
        loadTab(window.activeTab);
    } else {
        reorderBtn.style.display = 'none';
        addBtn.style.display     = 'none';
        renderShopView();
    }
};

/* ─── Route shop view by tab ─────────────────── */
function renderShopView() {
    if (!_currentShopId) return;
    const tab  = window.activeTab;
    const mode = window._shopMode;

    // Update list title
    const labels = { lamination: 'LAMINATION', binding: 'BINDING', paper: 'PAPER' };
    const modeLabel = mode === 'manage' ? 'AVAILABILITY' : 'PRICING';
    document.getElementById('listTitle').textContent = `${labels[tab]} — ${modeLabel}`;

    if (mode === 'manage')  renderManageView(tab);
    if (mode === 'pricing') renderPricingView(tab);
}

/* ═══════════════════════════════════════════════
   MANAGE AVAILABILITY VIEW
   ═══════════════════════════════════════════════ */
function renderManageView(tab) {
    const grid  = document.getElementById('cardGrid');
    const badge = document.getElementById('listCount');

    // Get the right universal list from configCache or build from the live snapshot data
    const items = _getUniversalList(tab);

    if (!items.length) {
        badge.textContent = '0';
        grid.innerHTML = `<div class="mx-empty"><i class="fa-solid fa-inbox"></i>No universal ${tab} types yet. Use Universal mode to add them.</div>`;
        return;
    }

    const cfg = _shopConfig?.[tab] || {};
    const enabledCount = items.filter(i => cfg[i.id]?.enabled).length;
    badge.textContent = `${enabledCount}/${items.length}`;

    grid.innerHTML = items.map(item => {
        const isEnabled = cfg[item.id]?.enabled === true;
        const img = item.images?.find(i => i.isPrimary)?.url || item.images?.[0]?.url || '';
        const imgHtml = img
            ? `<img src="${esc(img)}" alt="${esc(item.name)}" loading="lazy">`
            : `<div class="mx-no-img"><i class="fa-solid fa-image"></i></div>`;

        return `
        <div class="mx-card ${isEnabled ? 'mx-card--enabled' : 'mx-card--disabled'}">
            <div class="mx-card-img" style="padding-top:56%;">${imgHtml}</div>
            <div class="mx-card-body">
                <div class="mx-card-name">${esc(item.name)}</div>
                <div class="mx-status-badge ${isEnabled ? 'enabled' : 'disabled'}">
                    <i class="fa-solid fa-${isEnabled ? 'circle-check' : 'circle-xmark'}"></i>
                    ${isEnabled ? 'Available' : 'Disabled'}
                </div>
            </div>
            <div class="mx-card-actions">
                <button class="mx-card-btn ${isEnabled ? 'mx-card-btn--disable' : 'mx-card-btn--enable'}"
                        onclick="toggleAvailability('${esc(tab)}','${esc(item.id)}',${!isEnabled})">
                    <i class="fa-solid fa-${isEnabled ? 'eye-slash' : 'eye'}"></i>
                    ${isEnabled ? 'Disable' : 'Enable'}
                </button>
            </div>
        </div>`;
    }).join('');
}

/* ═══════════════════════════════════════════════
   PRICING VIEW
   ═══════════════════════════════════════════════ */
function renderPricingView(tab) {
    const grid  = document.getElementById('cardGrid');
    const badge = document.getElementById('listCount');

    const items  = _getUniversalList(tab);
    const cfg    = _shopConfig?.[tab] || {};
    const enabled = items.filter(i => cfg[i.id]?.enabled === true);

    badge.textContent = enabled.length;

    if (!enabled.length) {
        grid.innerHTML = `<div class="mx-empty"><i class="fa-solid fa-inbox"></i>No ${tab} types enabled for this shop. Use Availability mode to enable some.</div>`;
        return;
    }

    grid.innerHTML = enabled.map(item => {
        const shopItem = cfg[item.id] || {};
        const img      = item.images?.find(i => i.isPrimary)?.url || item.images?.[0]?.url || '';
        const imgHtml  = img
            ? `<img src="${esc(img)}" alt="${esc(item.name)}" loading="lazy">`
            : `<div class="mx-no-img"><i class="fa-solid fa-image"></i></div>`;

        if (tab === 'paper') {
            const bw    = shopItem.bwPrices    || { frontOnly: 0, frontBack: 0 };
            const col   = shopItem.colorPrices || { frontOnly: 0, frontBack: 0 };

            // Option badges
            const opts = [
                { key: 'colorOptions',     icon: 'fa-palette',      label: 'Color'  },
                { key: 'formatOptions',    icon: 'fa-file',         label: 'Format' },
                { key: 'ratioOptions',     icon: 'fa-expand',       label: 'Ratio'  },
                { key: 'bindingOptions',   icon: 'fa-book',         label: 'Binding'},
                { key: 'laminationOptions',icon: 'fa-layer-group',  label: 'Lam.'   },
            ];
            const badgesHtml = opts.map(o => {
                const on = shopItem[o.key]?.enabled === true;
                return `<span class="mx-opt-badge ${on ? 'on' : 'off'}">
                    <i class="fa-solid ${esc(o.icon)}"></i>${esc(o.label)}
                </span>`;
            }).join('');

            return `
            <div class="mx-card mx-card--paper">
                <div class="mx-card-img" style="padding-top:56%;">${imgHtml}</div>
                <div class="mx-card-body">
                    <div class="mx-card-name">${esc(item.name)}</div>
                    <div class="mx-price-boxes">
                        <div class="mx-price-box"><div class="mx-price-box-label">B&W Front</div><div class="mx-price-box-val">₹${bw.frontOnly}</div></div>
                        <div class="mx-price-box"><div class="mx-price-box-label">B&W Both</div><div class="mx-price-box-val">₹${bw.frontBack}</div></div>
                        <div class="mx-price-box color"><div class="mx-price-box-label">Color Front</div><div class="mx-price-box-val">₹${col.frontOnly}</div></div>
                        <div class="mx-price-box color"><div class="mx-price-box-label">Color Both</div><div class="mx-price-box-val">₹${col.frontBack}</div></div>
                    </div>
                    <div class="mx-opt-badges">${badgesHtml}</div>
                </div>
                <div class="mx-card-actions">
                    <button class="mx-card-btn mx-card-btn--edit" onclick="openShopPaperModal('${esc(item.id)}')">
                        <i class="fa-solid fa-pen"></i> Edit Config
                    </button>
                </div>
            </div>`;
        }

        // Lamination / Binding
        const price = shopItem.price ?? 0;
        return `
        <div class="mx-card">
            <div class="mx-card-img">${imgHtml}</div>
            <div class="mx-card-body">
                <div class="mx-card-name">${esc(item.name)}</div>
                <span class="mx-card-price-tag"><i class="fa-solid fa-tag" style="font-size:.6rem;"></i>₹${price}</span>
            </div>
            <div class="mx-card-actions">
                <button class="mx-card-btn mx-card-btn--edit" onclick="openShopSimpleModal('${esc(tab)}','${esc(item.id)}')">
                    <i class="fa-solid fa-pen"></i> Edit Price
                </button>
            </div>
        </div>`;
    }).join('');
}

/* ─── Universal list helper ──────────────────── */
function _getUniversalList(tab) {
    // configCache is populated by the existing onSnapshot listeners in loadTab()
    // For paper we need to reach into the live snapshot; keep a separate store.
    if (tab === 'lamination') return configCache.lamination || [];
    if (tab === 'binding')    return configCache.binding    || [];
    if (tab === 'paper')      return window._paperCache     || [];
    return [];
}

/* ═══════════════════════════════════════════════
   TOGGLE AVAILABILITY
   ═══════════════════════════════════════════════ */
window.toggleAvailability = async function(type, typeId, enable) {
    if (!_currentShopId) return;
    const btn = event?.currentTarget;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
    try {
        const updates = {
            [`xeroxConfig.${type}.${typeId}.enabled`]: enable,
            updatedAt: new Date()
        };
        // Set default prices when enabling
        if (enable) {
            if (type === 'paper') {
                updates[`xeroxConfig.${type}.${typeId}.bwPrices`]    = { frontOnly: 0, frontBack: 0 };
                updates[`xeroxConfig.${type}.${typeId}.colorPrices`]  = { frontOnly: 0, frontBack: 0 };
            } else {
                updates[`xeroxConfig.${type}.${typeId}.price`] = 0;
            }
        }
        await updateDoc(doc(db, 'shops', _currentShopId), updates);
        await bustXeroxCache();
        await bustShopsCache();
        toast(`${enable ? 'Enabled' : 'Disabled'} successfully.`, 'success');
    } catch (err) {
        console.error('[toggleAvailability]', err);
        toast('Failed to update. ' + err.message, 'error');
    }
    // View will re-render via onSnapshot
};

/* ═══════════════════════════════════════════════
   SHOP SIMPLE PRICING MODAL (Lamination / Binding)
   ═══════════════════════════════════════════════ */
window.openShopSimpleModal = function(type, id) {
    const item  = _getUniversalList(type).find(i => i.id === id);
    if (!item) return;
    const price = _shopConfig?.[type]?.[id]?.price ?? 0;

    _shopSimpleCtx = { type, id };
    document.getElementById('shopSimpleTitle').textContent =
        `Edit ${type === 'lamination' ? 'Lamination' : 'Binding'} Price`;
    document.getElementById('shopSimpleSub').textContent   = item.name;
    document.getElementById('shopSimpleName').value        = item.name;
    document.getElementById('shopSimplePrice').value       = price;

    document.getElementById('shopSimpleModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.closeShopSimpleModal = function() {
    document.getElementById('shopSimpleModalOverlay').classList.remove('open');
    document.body.style.overflow = '';
};

window.saveShopSimplePrice = async function() {
    const { type, id } = _shopSimpleCtx || {};
    if (!type || !id || !_currentShopId) return;

    const price = parseFloat(document.getElementById('shopSimplePrice').value);
    if (isNaN(price) || price < 0) { toast('Enter a valid price.', 'error'); return; }

    const btn  = document.getElementById('shopSimpleSaveBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
        await updateDoc(doc(db, 'shops', _currentShopId), {
            [`xeroxConfig.${type}.${id}.price`]: price,
            updatedAt: new Date()
        });
        await bustXeroxCache();
        await bustShopsCache();
        toast('Price saved!', 'success');
        window.closeShopSimpleModal();
    } catch (err) {
        console.error('[saveShopSimplePrice]', err);
        toast('Save failed: ' + err.message, 'error');
    }
    btn.disabled = false; btn.innerHTML = orig;
};

/* ═══════════════════════════════════════════════
   SHOP PAPER PRICING MODAL
   ═══════════════════════════════════════════════ */
window.openShopPaperModal = function(id) {
    const item = (window._paperCache || []).find(i => i.id === id);
    if (!item) return;

    const cfg       = _shopConfig?.paper?.[id]         || {};
    const bw        = cfg.bwPrices                      || { frontOnly: 0, frontBack: 0 };
    const col       = cfg.colorPrices                   || { frontOnly: 0, frontBack: 0 };
    const universalOpts = item.options                  || {};

    _shopPaperCtx = { id };

    document.getElementById('shopPaperTitle').textContent = `Configure: ${item.name}`;
    document.getElementById('shopPaperName').value        = item.name;
    document.getElementById('shopBwFront').value          = bw.frontOnly;
    document.getElementById('shopBwBoth').value           = bw.frontBack;
    document.getElementById('shopColorFront').value       = col.frontOnly;
    document.getElementById('shopColorBoth').value        = col.frontBack;

    // ── Color Options ──
    _setupShopOpt(
        'shopOptColor', 'shopEnableColor', 'shopColorChoices',
        universalOpts.color?.enabled !== false,
        cfg.colorOptions?.enabled === true,
        null // no sub-checkboxes to set here — handled below
    );
    const colSel = cfg.colorOptions?.selection || [];
    _chk('shopCol_bw',    colSel.includes('bw'));
    _chk('shopCol_color', colSel.includes('color'));

    // ── Format Types (per color mode) ──
    _setupShopOpt(
        'shopOptFormat', 'shopEnableFormat', 'shopFormatChoices',
        universalOpts.format?.enabled !== false,
        cfg.formatOptions?.enabled === true,
        null
    );
    const fmtBw  = cfg.formatOptions?.bw?.selection    ?? cfg.formatOptions?.selection ?? [];
    const fmtCol = cfg.formatOptions?.color?.selection  ?? cfg.formatOptions?.selection ?? [];
    _chk('shopFmtBw_fo',  fmtBw.includes('frontOnly'));
    _chk('shopFmtBw_bo',  fmtBw.includes('both'));
    _chk('shopFmtCol_fo', fmtCol.includes('frontOnly'));
    _chk('shopFmtCol_bo', fmtCol.includes('both'));

    // ── Print Ratios (per color mode) ──
    _setupShopOpt(
        'shopOptRatio', 'shopEnableRatio', 'shopRatioChoices',
        universalOpts.ratio?.enabled === true,  // off by default unless universal enables it
        cfg.ratioOptions?.enabled === true,
        null
    );
    const ratBw  = cfg.ratioOptions?.bw?.selection    ?? cfg.ratioOptions?.selection ?? [];
    const ratCol = cfg.ratioOptions?.color?.selection  ?? cfg.ratioOptions?.selection ?? [];
    _chk('shopRatBw_11',  ratBw.includes('1:1'));
    _chk('shopRatBw_12',  ratBw.includes('1:2'));
    _chk('shopRatCol_11', ratCol.includes('1:1'));
    _chk('shopRatCol_12', ratCol.includes('1:2'));

    // ── Binding ──
    _setupShopOpt(
        'shopOptBinding', 'shopEnableBinding', 'shopBindingChoices',
        universalOpts.binding?.enabled !== false,
        cfg.bindingOptions?.enabled === true,
        null
    );
    const bndSel  = cfg.bindingOptions?.selection || [];
    const bndEnabled = Object.keys(_shopConfig?.binding || {}).filter(bid => _shopConfig.binding[bid]?.enabled);
    const bndList = configCache.binding.filter(b => bndEnabled.includes(b.id));
    document.getElementById('shopBindingChoices').innerHTML = bndList.length
        ? bndList.map(b => `<label class="mx-check-label">
            <input type="checkbox" class="shopBndChk" value="${esc(b.id)}" ${bndSel.includes(b.id) ? 'checked' : ''}>
            ${esc(b.name)}</label>`).join('')
        : '<span style="font-size:.75rem;color:var(--txt3);">No binding types enabled for this shop.</span>';

    // ── Lamination ──
    _setupShopOpt(
        'shopOptLamination', 'shopEnableLamination', 'shopLaminationChoices',
        universalOpts.lamination?.enabled !== false,
        cfg.laminationOptions?.enabled === true,
        null
    );
    const lamSel  = cfg.laminationOptions?.selection || [];
    const lamEnabled = Object.keys(_shopConfig?.lamination || {}).filter(lid => _shopConfig.lamination[lid]?.enabled);
    const lamList = configCache.lamination.filter(l => lamEnabled.includes(l.id));
    document.getElementById('shopLaminationChoices').innerHTML = lamList.length
        ? lamList.map(l => `<label class="mx-check-label">
            <input type="checkbox" class="shopLamChk" value="${esc(l.id)}" ${lamSel.includes(l.id) ? 'checked' : ''}>
            ${esc(l.name)}</label>`).join('')
        : '<span style="font-size:.75rem;color:var(--txt3);">No lamination types enabled for this shop.</span>';

    document.getElementById('shopPaperModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};

/* helper: set up one option item — enable/disable whole row + show/hide choices */
function _setupShopOpt(rowId, toggleId, choicesId, universalAllows, shopEnabled, _unused) {
    const row     = document.getElementById(rowId);
    const toggle  = document.getElementById(toggleId);
    const choices = document.getElementById(choicesId);
    if (!row || !toggle || !choices) return;

    if (!universalAllows) {
        row.style.opacity = '0.4';
        toggle.disabled = true;
        toggle.checked  = false;
        choices.style.display = 'none';
        return;
    }
    row.style.opacity = '1';
    toggle.disabled = false;
    toggle.checked  = shopEnabled;
    choices.style.display = shopEnabled ? '' : 'none';
}

/* helper: set checkbox */
function _chk(id, val) {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
}

/* toggle sub-choices visibility — called from HTML onchange */
window.toggleShopOpt = function(choicesId, toggleEl) {
    const choices = document.getElementById(choicesId);
    if (choices) choices.style.display = toggleEl.checked ? '' : 'none';
};

window.closeShopPaperModal = function() {
    document.getElementById('shopPaperModalOverlay').classList.remove('open');
    document.body.style.overflow = '';
};

window.saveShopPaperConfig = async function() {
    const { id } = _shopPaperCtx || {};
    if (!id || !_currentShopId) return;

    const btn  = document.getElementById('shopPaperSaveBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const updates = {
            [`xeroxConfig.paper.${id}.bwPrices`]: {
                frontOnly: parseFloat(document.getElementById('shopBwFront').value)  || 0,
                frontBack: parseFloat(document.getElementById('shopBwBoth').value)   || 0
            },
            [`xeroxConfig.paper.${id}.colorPrices`]: {
                frontOnly: parseFloat(document.getElementById('shopColorFront').value) || 0,
                frontBack: parseFloat(document.getElementById('shopColorBoth').value)  || 0
            },
            [`xeroxConfig.paper.${id}.colorOptions`]: {
                enabled:   document.getElementById('shopEnableColor').checked,
                selection: [
                    document.getElementById('shopCol_bw').checked    ? 'bw'    : null,
                    document.getElementById('shopCol_color').checked ? 'color' : null,
                ].filter(Boolean)
            },
            [`xeroxConfig.paper.${id}.formatOptions`]: {
                enabled: document.getElementById('shopEnableFormat').checked,
                bw: { selection: [
                    document.getElementById('shopFmtBw_fo').checked ? 'frontOnly' : null,
                    document.getElementById('shopFmtBw_bo').checked ? 'both'      : null,
                ].filter(Boolean) },
                color: { selection: [
                    document.getElementById('shopFmtCol_fo').checked ? 'frontOnly' : null,
                    document.getElementById('shopFmtCol_bo').checked ? 'both'      : null,
                ].filter(Boolean) }
            },
            [`xeroxConfig.paper.${id}.ratioOptions`]: {
                enabled: document.getElementById('shopEnableRatio').checked,
                bw: { selection: [
                    document.getElementById('shopRatBw_11').checked ? '1:1' : null,
                    document.getElementById('shopRatBw_12').checked ? '1:2' : null,
                ].filter(Boolean) },
                color: { selection: [
                    document.getElementById('shopRatCol_11').checked ? '1:1' : null,
                    document.getElementById('shopRatCol_12').checked ? '1:2' : null,
                ].filter(Boolean) }
            },
            [`xeroxConfig.paper.${id}.bindingOptions`]: {
                enabled:   document.getElementById('shopEnableBinding').checked,
                selection: Array.from(document.querySelectorAll('.shopBndChk:checked')).map(e => e.value)
            },
            [`xeroxConfig.paper.${id}.laminationOptions`]: {
                enabled:   document.getElementById('shopEnableLamination').checked,
                selection: Array.from(document.querySelectorAll('.shopLamChk:checked')).map(e => e.value)
            },
            updatedAt: new Date()
        };

        await updateDoc(doc(db, 'shops', _currentShopId), updates);
        await bustXeroxCache();
        await bustShopsCache();
        toast('Paper configuration saved!', 'success');
        window.closeShopPaperModal();
    } catch (err) {
        console.error('[saveShopPaperConfig]', err);
        toast('Save failed: ' + err.message, 'error');
    }
    btn.disabled = false; btn.innerHTML = orig;
};

/* ═══════════════════════════════════════════════
   PAPER CACHE — keep a live copy for shop views
   The existing loadTab onSnapshot for 'paper' doesn't
   store to configCache; we wire it here.
   ═══════════════════════════════════════════════ */
(function patchLoadTab() {
    const _orig = loadTab;
    window._loadTabOrig = _orig;   // keep reference
})();

// After auth, also kick off shops load and paper cache listener
const _origAuthCallback = onAuthStateChanged;
// We hook into the auth success point via a post-auth init extension:
window._initShopFeature = function() {
    loadShopsForSelector();

    // Live paper cache so shop views can read paper items
    onSnapshot(
        collection(db, 'xerox_config_paper'),
        snap => {
            window._paperCache = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
            // If currently in a shop pricing/manage view on paper tab, re-render
            if (window._shopMode && window._shopMode !== 'universal' && window.activeTab === 'paper') {
                renderShopView();
            }
        },
        err => console.error('[ManageXerox] paperCache:', err)
    );
};
