/* ═══════════════════════════════════════════════
   MANAGE ITEMS — Admin + manage_items (employee)
   ═══════════════════════════════════════════════ */
import { auth, db }               from './firebase-init.js';
import { SERVER_URL, R2_CONFIG, WORKER_URL, initAppConfig, getAdminToken } from './env-config.js';
import { onAuthStateChanged }     from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    collection, addDoc, getDocs, query, where,
    updateDoc, doc, deleteDoc, setDoc, getDoc,
    arrayUnion, arrayRemove, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

/* ════════════════════════════════
   CATEGORY CONFIG
   ════════════════════════════════ */
const CAT_CFG = {
    stationary: {
        label:       'STATIONARY PRODUCTS',
        attr1Label:  'Brand',    attr1Type: 'brand',
        attr2Label:  'Type',     attr2Type: 'type',
        brandField:  'brands',   typeField:  'types',
    },
    electronic: {
        label:       'KIT PRODUCTS',
        attr1Label:  'Brand',    attr1Type: 'brand',
        attr2Label:  'Type',     attr2Type: 'type',
        brandField:  'brands',   typeField:  'types',
    },
    books: {
        label:       'BOOKS',
        attr1Label:  'Author',   attr1Type: 'author',
        attr2Label:  'Category', attr2Type: 'category',
        brandField:  'authors',  typeField:  'categories',
    },
    /* Wall posters reuse the brand/type storage fields; only the labels differ */
    posters: {
        label:       'WALL POSTERS',
        attr1Label:  'Theme',    attr1Type: 'brand',
        attr2Label:  'Size',     attr2Type: 'type',
        brandField:  'brands',   typeField:  'types',
    },
};

/* example text shown in the quick-add inputs */
const ATTR_EXAMPLE = {
    stationary: ['Classmate', 'Pen'],
    electronic: ['Classmate', 'Pen'],
    books:      ['J.K. Rowling', 'Fiction'],
    posters:    ['Motivational', 'A3'],
};

/* ════════════════════════════════
   STATE
   ════════════════════════════════ */
window.activeTab  = 'stationary';
let editingItemId = null;
let selectedFiles = [];
let primaryIdx    = 0;

/* ════════════════════════════════
   TOAST
   ════════════════════════════════ */
function toast(msg, type = '') {
    const el = document.getElementById('miToast');
    el.textContent = msg;
    el.className   = 'mi-toast ' + type;
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

/* ════════════════════════════════
   ESCAPE HTML
   ════════════════════════════════ */
function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ════════════════════════════════
   TAB SWITCHING
   ════════════════════════════════ */
window.switchTab = function(cat, btn) {
    window.activeTab = cat;
    document.querySelectorAll('.mi-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const cfg = CAT_CFG[cat];
    document.getElementById('listTitle').textContent        = cfg.label;
    document.getElementById('attrLabel1').textContent       = cfg.attr1Label;
    document.getElementById('attrInput1').placeholder       = `e.g. ${(ATTR_EXAMPLE[cat] || ATTR_EXAMPLE.stationary)[0]}`;
    document.getElementById('attrLabel2').textContent       = cfg.attr2Label;
    document.getElementById('attrInput2').placeholder       = `e.g. ${(ATTR_EXAMPLE[cat] || ATTR_EXAMPLE.stationary)[1]}`;
    document.getElementById('posterTools').style.display    = cat === 'posters' ? '' : 'none';
    if (cat === 'posters') loadStdPrices().then(updateStdSummary);
    fetchItems(cat);
};

/* ════════════════════════════════
   FETCH & RENDER ITEMS
   Admin always reads directly from Firestore — never the Worker/categoryData
   cache — so counts and images are always current.
   ════════════════════════════════ */
async function fetchItems(cat) {
    const grid  = document.getElementById('itemsGrid');
    const badge = document.getElementById('itemCount');
    grid.innerHTML = '<div class="mi-skeleton"></div>'.repeat(4);

    try {
        const q     = query(collection(db, 'items'), where('category', '==', cat));
        const qs    = await getDocs(q);
        const items = qs.docs.map(d => ({ id: d.id, ...d.data() }));
        badge.textContent = items.length;
        renderGrid(items);
    } catch (err) {
        grid.innerHTML = `<div class="mi-empty"><i class="fa-solid fa-circle-exclamation"></i>Failed to load items.</div>`;
        console.error('[ManageItems] fetchItems:', err);
    }
}

function renderGrid(items) {
    const grid = document.getElementById('itemsGrid');
    if (!items.length) {
        grid.innerHTML = `<div class="mi-empty"><i class="fa-solid fa-box-open"></i>No products yet. Add one!</div>`;
        return;
    }
    grid.innerHTML = items.map(item => {
        const o = item.priceOriginal || 0;
        const d = item.priceDiscount || 0;
        const hasDisc = d > 0 && d < o;
        const price   = hasDisc ? d : o;
        const disc    = hasDisc ? Math.round(((o - d) / o) * 100) : 0;
        const img     = item.images?.find(i => i.isPrimary)?.url || item.images?.[0]?.url || '';
        return `
        <div class="mi-card">
            <div class="mi-card-img">
                ${img
                    ? `<img src="${esc(img)}" alt="${esc(item.name)}" loading="lazy">`
                    : `<div class="mi-no-img"><i class="fa-solid fa-image"></i></div>`}
            </div>
            <div class="mi-card-body">
                <div class="mi-card-name" title="${esc(item.name)}">${esc(item.name)}</div>
                <div class="mi-card-price-row">
                    <span class="mi-card-price">₹${price.toLocaleString('en-IN')}</span>
                    ${hasDisc ? `<span class="mi-card-orig">₹${o.toLocaleString('en-IN')}</span>` : ''}
                    ${disc  ? `<span class="mi-card-disc">${disc}% OFF</span>` : ''}
                </div>
            </div>
            <div class="mi-card-actions">
                <button class="mi-card-action-btn mi-card-action-btn--edit" onclick="editItem('${esc(item.id)}')" title="Edit">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="mi-card-action-btn mi-card-action-btn--del" onclick="confirmDelete('${esc(item.id)}','${esc(item.name)}')" title="Delete">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>`;
    }).join('');
}

/* ════════════════════════════════
   CATEGORY SNAPSHOT SYNC
   Updates the Firestore categoryData snapshot AND busts the Worker KV cache
   so users see fresh items/images immediately after any create/update/delete.
   ════════════════════════════════ */
async function syncSnapshot(cat, itemsOverride) {
    try {
        let items = itemsOverride;
        if (!items) {
            const q  = query(collection(db, 'items'), where('category', '==', cat));
            const qs = await getDocs(q);
            items    = qs.docs.map(d => ({ id: d.id, ...d.data() }));
        }
        await setDoc(doc(db, 'categoryData', cat), {
            items, count: items.length, lastSync: new Date().toISOString()
        }, { merge: true });
    } catch (e) { console.warn('[ManageItems] syncSnapshot (Firestore):', e); }

    /* Bust the Worker KV cache for this category.
       We use ?bust=1 so the Worker re-fetches from Firestore immediately
       and stores the fresh data (with correct R2 image URLs) back into KV.
       Auth uses the same admin token used for image uploads.                */
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (idToken) {
            const adminSecret = await getAdminToken(idToken);
            const res = await fetch(
                `${WORKER_URL}/api/items?category=${encodeURIComponent(cat)}&bust=1`,
                {
                    headers: { 'Authorization': `Bearer ${adminSecret}` },
                    signal: AbortSignal.timeout(8000),
                }
            );
            if (!res.ok) console.warn(`[ManageItems] Worker bust returned HTTP ${res.status}`);
            else console.log(`[ManageItems] Worker KV busted for category: ${cat}`);
        }
    } catch (e) {
        // Non-fatal — the KV will eventually be overwritten on the next user request
        console.warn('[ManageItems] syncSnapshot (Worker bust):', e.message);
    }

    /* Tell every open storefront page (home / categories) to reload this category now.
       Done last, so they read the freshly-busted Worker data. */
    try {
        await setDoc(doc(db, 'metadata', 'catalog_version'), {
            [cat]: Date.now(), updatedAt: new Date().toISOString(),
        }, { merge: true });
    } catch (e) { console.warn('[ManageItems] catalog_version signal:', e.message); }
}

/* ════════════════════════════════
   ATTRIBUTE MANAGEMENT
   ════════════════════════════════ */
const attrMeta = { stationary:{}, electronic:{}, books:{}, posters:{} }; // runtime cache of attr lists

window.saveAttr = async function(slot) {
    const cat  = window.activeTab;
    const cfg  = CAT_CFG[cat];
    const type = slot === 1 ? cfg.attr1Type : cfg.attr2Type;
    const inputEl = document.getElementById(`attrInput${slot}`);
    const val  = inputEl.value.trim();
    if (!val) return;

    const btnEl = inputEl.nextElementSibling;
    const orig  = btnEl.textContent;
    btnEl.textContent = '…';

    try {
        await addDoc(collection(db, 'itemAttributes'), {
            category: cat, type, name: val, createdAt: new Date().toISOString()
        });
        // sync metadata cache
        const fieldName = type === 'author' ? 'authors' : type === 'category' ? 'bookCategories' : type === 'brand' ? 'brands' : 'types';
        await updateDoc(doc(db, 'metadata', 'item_filters'), {
            [`${cat}.${fieldName}`]: arrayUnion(val),
            lastUpdated: new Date().toISOString()
        }).catch(() => setDoc(doc(db, 'metadata', 'item_filters'), {
            [cat]: { [fieldName]: [val] }, lastUpdated: new Date().toISOString()
        }, { merge: true }));

        inputEl.value = '';
        toast(`${val} saved!`, 'success');
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
    btnEl.textContent = orig;
};

window.viewAttr = async function(slot) {
    const cat  = window.activeTab;
    const cfg  = CAT_CFG[cat];
    const type = slot === 1 ? cfg.attr1Type : cfg.attr2Type;
    const label = slot === 1 ? cfg.attr1Label : cfg.attr2Label;

    document.getElementById('attrSheetTitle').textContent = `Manage ${label}s`;
    document.getElementById('attrSheetBody').innerHTML = '<div class="mi-spinner"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    openAttrSheet();

    try {
        const q    = query(collection(db, 'itemAttributes'), where('category','==',cat), where('type','==',type));
        const snap = await getDocs(q);
        if (snap.empty) {
            document.getElementById('attrSheetBody').innerHTML = '<p style="text-align:center;color:var(--txt3);padding:24px;font-size:.82rem;">No entries yet.</p>';
            return;
        }
        document.getElementById('attrSheetBody').innerHTML = snap.docs.map(d => `
            <div class="mi-attr-item" id="ai-${d.id}">
                <input type="text" class="mi-input" id="aiv-${d.id}" value="${esc(d.data().name)}">
                <div class="mi-attr-item-btns">
                    <button class="mi-btn-dark" style="height:36px;font-size:.72rem;" onclick="updateAttr('${d.id}','${esc(cat)}','${esc(type)}')">Update</button>
                    <button class="mi-btn-danger" style="height:36px;padding:0 10px;font-size:.72rem;" onclick="deleteAttr('${d.id}','${esc(cat)}','${esc(type)}','${esc(d.data().name)}')">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>`).join('');
    } catch (err) {
        document.getElementById('attrSheetBody').innerHTML = '<p style="text-align:center;color:#dc2626;padding:24px;font-size:.82rem;">Failed to load.</p>';
    }
};

window.updateAttr = async function(docId, cat, type) {
    const input = document.getElementById(`aiv-${docId}`);
    const val   = input.value.trim();
    if (!val) return;
    const btn = input.nextElementSibling?.querySelector('button');
    if (btn) { const o = btn.textContent; btn.textContent = '…';
        try {
            const attrDoc = await getDoc(doc(db, 'itemAttributes', docId));
            if (attrDoc.exists()) {
                const old  = attrDoc.data().name;
                const field = type === 'author' ? 'authors' : type === 'category' ? 'bookCategories' : type === 'brand' ? 'brands' : 'types';
                if (old !== val) {
                    await updateDoc(doc(db, 'metadata', 'item_filters'), { [`${cat}.${field}`]: arrayRemove(old) });
                    await updateDoc(doc(db, 'metadata', 'item_filters'), { [`${cat}.${field}`]: arrayUnion(val) });
                }
            }
            await updateDoc(doc(db, 'itemAttributes', docId), { name: val });
            toast('Updated!', 'success');
        } catch (e) { toast('Update failed.', 'error'); }
        btn.textContent = o;
    }
};

window.deleteAttr = async function(docId, cat, type, name) {
    if (!window.confirm(`Delete "${name}"?`)) return;
    try {
        const field = type === 'author' ? 'authors' : type === 'category' ? 'bookCategories' : type === 'brand' ? 'brands' : 'types';
        await updateDoc(doc(db, 'metadata', 'item_filters'), { [`${cat}.${field}`]: arrayRemove(name) }).catch(() => {});
        await deleteDoc(doc(db, 'itemAttributes', docId));
        const el = document.getElementById(`ai-${docId}`);
        if (el) el.remove();
        toast('Deleted!', 'success');
    } catch (e) { toast('Delete failed.', 'error'); }
};

function openAttrSheet() {
    document.getElementById('attrSheetOverlay').classList.add('open');
    document.getElementById('attrSheet').classList.add('open');
    document.body.style.overflow = 'hidden';
}
window.closeAttrSheet = function() {
    document.getElementById('attrSheetOverlay').classList.remove('open');
    document.getElementById('attrSheet').classList.remove('open');
    document.body.style.overflow = '';
};

/* ════════════════════════════════
   CREATE / EDIT MODAL
   ════════════════════════════════ */
window.openCreateModal = async function(cat) {
    editingItemId = null;
    selectedFiles = [];
    primaryIdx    = 0;

    const cfg = CAT_CFG[cat];
    document.getElementById('fCategory').value       = cat;
    document.getElementById('modalTitle').textContent = `Add ${cfg.label.replace(' PRODUCTS','')} Item`;
    document.getElementById('modalSub').textContent   = 'Fill in the details below';
    document.getElementById('submitBtnText').textContent = 'Create Item';
    document.getElementById('itemForm').reset();
    document.getElementById('fId').disabled  = false;
    document.getElementById('previewRow').innerHTML = '';
    document.getElementById('fBrandLabel').textContent = cfg.attr1Label + 's';
    document.getElementById('fTypeLabel').textContent  = cfg.attr2Label + 's';

    document.getElementById('fBrandsBox').innerHTML = '<span class="mi-chips-empty">Loading…</span>';
    document.getElementById('fTypesBox').innerHTML  = '<span class="mi-chips-empty">Loading…</span>';

    openModal();
    sizePriceDraft = {};
    if (cat === 'posters') await loadStdPrices();
    await loadAttrChips(cat);
    // New poster: start with the Default sizes and their standard prices
    if (cat === 'posters') (stdPrices.defaultSizes || []).forEach(sz => {
        const cb = document.querySelector(`input[name="item-type"][value="${CSS.escape(sz)}"]`);
        if (cb) cb.checked = true;
    });
    renderSizePrices();
};

async function loadAttrChips(cat) {
    const cfg = CAT_CFG[cat];
    try {
        const snap = await getDoc(doc(db, 'metadata', 'item_filters'));
        const meta = snap.exists() ? (snap.data()[cat] || {}) : {};

        const bList = cat === 'books' ? (meta.authors       || []) : (meta.brands  || []);
        const tList = cat === 'books' ? (meta.bookCategories || []) : (meta.types   || []);

        renderChips('fBrandsBox', bList, 'item-brand');
        renderChips('fTypesBox',  tList, 'item-type');
    } catch {
        document.getElementById('fBrandsBox').innerHTML = '<span class="mi-chips-empty" style="color:#dc2626;">Error loading options.</span>';
        document.getElementById('fTypesBox').innerHTML  = '<span class="mi-chips-empty" style="color:#dc2626;">Error loading options.</span>';
    }
}

function renderChips(boxId, list, name) {
    const box = document.getElementById(boxId);
    if (!list.length) {
        box.innerHTML = '<span class="mi-chips-empty">None yet — add some above first.</span>';
        return;
    }
    box.innerHTML = list.map((v, i) => `
        <label class="mi-chip-check">
            <input type="checkbox" name="${name}" value="${esc(v)}" id="chip-${name}-${i}">
            <span>${esc(v)}</span>
        </label>`).join('');
}

window.editItem = async function(id) {
    try {
        const snap = await getDoc(doc(db, 'items', id));
        if (!snap.exists()) { toast('Item not found.', 'error'); return; }
        const item = { id: snap.id, ...snap.data() };
        const cat  = item.category;
        const cfg  = CAT_CFG[cat] || CAT_CFG.stationary;

        editingItemId = id;
        selectedFiles = [];
        primaryIdx    = 0;

        document.getElementById('fCategory').value       = cat;
        document.getElementById('modalTitle').textContent = `Edit: ${item.name}`;
        document.getElementById('modalSub').textContent   = cat;
        document.getElementById('submitBtnText').textContent = 'Update Item';
        document.getElementById('itemForm').reset();
        document.getElementById('fBrandLabel').textContent = cfg.attr1Label + 's';
        document.getElementById('fTypeLabel').textContent  = cfg.attr2Label + 's';

        document.getElementById('fName').value     = item.name || '';
        document.getElementById('fId').value       = id;
        document.getElementById('fId').disabled    = true;
        document.getElementById('fPriceOrg').value = item.priceOriginal || '';
        document.getElementById('fPriceDisc').value= item.priceDiscount || '';
        document.getElementById('fDesc').value     = item.description   || '';

        // Existing image previews
        document.getElementById('previewRow').innerHTML = '';
        (item.images || []).forEach((img, i) => appendExistingPreview(img, i));

        document.getElementById('fBrandsBox').innerHTML = '<span class="mi-chips-empty">Loading…</span>';
        document.getElementById('fTypesBox').innerHTML  = '<span class="mi-chips-empty">Loading…</span>';

        openModal();
        if (cat === 'posters') await loadStdPrices();
        await loadAttrChips(cat);

        // Pre-check existing values after chips render
        setTimeout(() => {
            const brands = cat === 'books' ? (item.authors     || []) : (item.brands || []);
            const types  = cat === 'books' ? (item.categories  || []) : (item.types  || []);
            brands.forEach(v => {
                const cb = document.querySelector(`input[name="item-brand"][value="${CSS.escape(v)}"]`);
                if (cb) cb.checked = true;
            });
            types.forEach(v => {
                const cb = document.querySelector(`input[name="item-type"][value="${CSS.escape(v)}"]`);
                if (cb) cb.checked = true;
                else if (cat === 'posters') appendSizeChip(v);   // Mixed / custom size of this poster
            });
            sizePriceDraft = { ...(item.sizePrices || {}) };
            document.getElementById('fCustomUpload').checked = item.customUpload === true;
            renderSizePrices();
        }, 500);
    } catch (err) { toast('Error loading item: ' + err.message, 'error'); }
};

/* ── Per-size prices (wall posters): one price row per ticked Size ── */
let sizePriceDraft = {};
function readSizePriceInputs() {
    document.querySelectorAll('#fSizePrices [data-size]').forEach(row => {
        sizePriceDraft[row.dataset.size] = {
            priceOriginal: row.querySelector('.sp-org').value,
            priceDiscount: row.querySelector('.sp-disc').value,
        };
    });
}
function renderSizePrices() {
    const cat  = document.getElementById('fCategory').value;
    const wrap = document.getElementById('fSizePricesWrap');
    const on   = cat === 'posters';
    wrap.style.display = on ? '' : 'none';
    document.getElementById('fPriceOrg').required = !on;
    document.getElementById('fBasePriceRow').style.display = on ? 'none' : '';
    document.getElementById('fCustomUploadWrap').style.display = on ? '' : 'none';
    document.getElementById('fOwnSizes').style.display = on ? '' : 'none';
    document.getElementById('fOwnSizesHint').style.display = on ? '' : 'none';
    if (!on) return;
    readSizePriceInputs();
    const sizes = Array.from(document.querySelectorAll('input[name="item-type"]:checked')).map(c => c.value);
    document.getElementById('fUseStdBtn').style.display = Object.keys(stdPrices.sizePrices || {}).length ? '' : 'none';
    document.getElementById('fSizePrices').innerHTML = sizes.length ? sizes.map(sz => {
        // A size with nothing typed yet starts at its standard price
        const typed = sizePriceDraft[sz];
        const v = typed && (typed.priceOriginal !== '' && typed.priceOriginal != null) ? typed : (stdPrices.sizePrices?.[sz] || typed || {});
        return `<div class="mi-field-row" data-size="${sz.replace(/"/g,'&quot;')}" style="align-items:center;margin-bottom:6px;">
            <div style="font-weight:800;min-width:60px;">${sz.replace(/</g,'&lt;')}</div>
            <input type="number" step="0.01" min="0" class="mi-input sp-org"  placeholder="Original ₹" value="${v.priceOriginal ?? ''}">
            <input type="number" step="0.01" min="0" class="mi-input sp-disc" placeholder="Discount ₹" value="${v.priceDiscount ?? ''}">
        </div>`;
    }).join('') : '<span class="mi-chips-empty">Tick one or more sizes above to set their prices.</span>';
}
document.addEventListener('change', e => { if (e.target.name === 'item-type') renderSizePrices(); });

/* ── Wall posters: a size for this poster only ("Mixed", "24x36", …) ──
   Added as a ticked Size chip, so it gets a price row and is saved in the
   poster's types / sizePrices like any other size; customers see it as a size option. */
const OWN_SIZE = /^[A-Za-z0-9][A-Za-z0-9 .x×*-]{0,19}$/;
function appendSizeChip(v) {
    const box = document.getElementById('fTypesBox');
    box.querySelector('.mi-chips-empty')?.remove();
    const label = document.createElement('label');
    label.className = 'mi-chip-check mi-chip-own';
    label.innerHTML = `<input type="checkbox" name="item-type" value="${esc(v)}" checked><span>${esc(v)}</span>`;
    box.appendChild(label);
}
window.addPosterSize = function(raw) {
    const v = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!v) { toast('Type a size, e.g. 24x36.', 'error'); return; }
    if (!OWN_SIZE.test(v)) { toast('Use letters, numbers, space, . x - (max 20), e.g. 24x36.', 'error'); return; }
    const have = [...document.querySelectorAll('input[name="item-type"]')].find(c => c.value.toLowerCase() === v.toLowerCase());
    if (have) have.checked = true; else appendSizeChip(v);
    document.getElementById('fCustomSize').value = '';
    renderSizePrices();
};
document.getElementById('fCustomSize').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addPosterSize(e.target.value); }
});

/* ════════════════════════════════
   STANDARD POSTER PRICES — poster_config/catalog
   { sizePrices: { <size>: { priceOriginal, priceDiscount } }, defaultSizes: [] }
   Admin-only helper: fills new posters and bulk-updates existing ones.
   Orders are still priced from each poster's own sizePrices.
   ════════════════════════════════ */
let stdPrices = { sizePrices: {}, defaultSizes: [] };
async function loadStdPrices() {
    try {
        const snap = await getDoc(doc(db, 'poster_config', 'catalog'));
        const d = snap.exists() ? snap.data() : {};
        stdPrices = { sizePrices: d.sizePrices || {}, defaultSizes: Array.isArray(d.defaultSizes) ? d.defaultSizes : [] };
    } catch (e) { console.warn('[ManageItems] standard prices:', e.message); }
    return stdPrices;
}
function updateStdSummary() {
    const el = document.getElementById('stdPriceSummary');
    const list = Object.entries(stdPrices.sizePrices || {});
    el.textContent = list.length
        ? list.map(([sz, p]) => `${sz} ₹${p.priceDiscount > 0 ? p.priceDiscount : p.priceOriginal}`).join(' · ')
        : 'Set once per size — new posters fill in automatically';
}

/** "Use standard prices" in the poster form: every ticked size gets its standard price. */
window.useStdPrices = function() {
    readSizePriceInputs();
    Object.entries(stdPrices.sizePrices || {}).forEach(([sz, p]) => { sizePriceDraft[sz] = { ...p }; });
    renderSizePrices();
    toast('Standard prices filled in.', 'success');
};

async function posterSizes() {
    const snap = await getDoc(doc(db, 'metadata', 'item_filters'));
    return (snap.exists() ? snap.data().posters?.types : null) || [];
}

window.openPriceSheet = async function() {
    document.getElementById('priceSheetOverlay').classList.add('open');
    document.getElementById('priceSheet').classList.add('open');
    document.body.style.overflow = 'hidden';
    const box = document.getElementById('stdPriceRows');
    box.innerHTML = '<div class="mi-spinner"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    try {
        const [sizes] = await Promise.all([posterSizes(), loadStdPrices()]);
        const suggested = Object.keys(stdPrices.sizePrices).length ? null : await pricesInUse();
        const prices = suggested ? suggested.sizePrices : stdPrices.sizePrices;
        const defaults = suggested ? suggested.defaultSizes : stdPrices.defaultSizes;
        const all = [...new Set([...sizes, ...Object.keys(prices)])];
        box.innerHTML = (suggested && Object.keys(prices).length
            ? '<p class="mi-hint" style="margin:0 0 10px;color:#16a34a;"><i class="fa-solid fa-wand-magic-sparkles"></i> Filled in from the prices your posters use now — check them and save.</p>' : '')
            + (all.length ? all.map(sz => {
            const p = prices[sz] || {};
            return `<div class="mi-std-row" data-size="${esc(sz)}">
                <b>${esc(sz)}</b>
                <input type="number" step="0.01" min="0" class="mi-input std-org"  placeholder="MRP ₹"   value="${p.priceOriginal ?? ''}">
                <input type="number" step="0.01" min="0" class="mi-input std-disc" placeholder="Offer ₹" value="${p.priceDiscount || ''}">
                <label><input type="checkbox" class="std-def" ${defaults.includes(sz) ? 'checked' : ''}> Default</label>
            </div>`;
        }).join('') : '<span class="mi-chips-empty">Add sizes first (Size → Save above), e.g. A4, A3.</span>');
    } catch (e) {
        box.innerHTML = '<span class="mi-chips-empty" style="color:#dc2626;">Could not load sizes.</span>';
    }
};
/** Most common price of each size across the current posters (a starting point
    before any standard prices are saved). Default = sizes most posters have. */
async function pricesInUse() {
    const qs = await getDocs(query(collection(db, 'items'), where('category', '==', 'posters')));
    const seen = {};   // size → { "o|d": count }
    let n = 0;
    qs.docs.forEach(d => {
        const sp = d.data().customUpload ? null : d.data().sizePrices;
        if (!sp) return;
        n++;
        Object.entries(sp).forEach(([sz, p]) => {
            const k = `${Number(p.priceOriginal) || 0}|${Number(p.priceDiscount) || 0}`;
            (seen[sz] = seen[sz] || {})[k] = (seen[sz][k] || 0) + 1;
        });
    });
    const sizePrices = {}, defaultSizes = [];
    Object.entries(seen).forEach(([sz, counts]) => {
        const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        const [o, dsc] = best.split('|').map(Number);
        if (!(o > 0)) return;
        sizePrices[sz] = { priceOriginal: o, priceDiscount: dsc };
        if (Object.values(counts).reduce((s, c) => s + c, 0) * 2 >= n) defaultSizes.push(sz);
    });
    return { sizePrices, defaultSizes };
}

window.closePriceSheet = function() {
    document.getElementById('priceSheetOverlay').classList.remove('open');
    document.getElementById('priceSheet').classList.remove('open');
    document.body.style.overflow = '';
};

/** Lowest selling price of a sizePrices map → the item's base (card) prices. */
function basePriceOf(sizePrices) {
    let best = null;
    Object.values(sizePrices).forEach(p => {
        const o = Number(p.priceOriginal) || 0, d = Number(p.priceDiscount) || 0;
        const eff = d > 0 && d < o ? d : o;
        if (o > 0 && (!best || eff < best.eff)) best = { eff, o, d };
    });
    return best;
}

window.saveStdPrices = async function(apply) {
    const sizePrices = {}, defaultSizes = [];
    for (const row of document.querySelectorAll('#stdPriceRows [data-size]')) {
        const sz = row.dataset.size;
        const o = parseFloat(row.querySelector('.std-org').value || 0);
        const d = parseFloat(row.querySelector('.std-disc').value || 0);
        const def = row.querySelector('.std-def').checked;
        if (!(o > 0)) {
            if (d || def) return toast(`Enter the MRP for ${sz} (or clear it).`, 'error');
            continue;
        }
        if (d && d >= o) return toast(`The offer price of ${sz} must be below its MRP.`, 'error');
        sizePrices[sz] = { priceOriginal: o, priceDiscount: d || 0 };
        if (def) defaultSizes.push(sz);
    }
    const addDefaults    = document.getElementById('stdAddDefaults').checked;
    const includeCustom  = document.getElementById('stdIncludeCustom').checked;
    if (apply && !Object.keys(sizePrices).length) return toast('Enter at least one price.', 'error');

    try {
        await setDoc(doc(db, 'poster_config', 'catalog'), { sizePrices, defaultSizes, updatedAt: new Date().toISOString() });
        stdPrices = { sizePrices, defaultSizes };
        updateStdSummary();
    } catch (e) { return toast('Could not save: ' + e.message, 'error'); }
    if (!apply) { toast('Standard prices saved.', 'success'); closePriceSheet(); return; }

    /* Bulk update: every poster's sizes take the standard price */
    const qs = await getDocs(query(collection(db, 'items'), where('category', '==', 'posters')));
    const now = new Date().toISOString();
    const changes = [];
    qs.docs.forEach(d => {
        const it = d.data();
        if (it.customUpload && !includeCustom) return;
        const sp = { ...(it.sizePrices || {}) };
        const types = [...(it.types || [])];
        Object.keys(sp).forEach(sz => { if (sizePrices[sz]) sp[sz] = { ...sizePrices[sz] }; });
        if (addDefaults) defaultSizes.forEach(sz => {
            if (!sp[sz]) sp[sz] = { ...sizePrices[sz] };
            if (!types.includes(sz)) types.push(sz);
        });
        const base = basePriceOf(sp);
        if (!base || JSON.stringify(sp) === JSON.stringify(it.sizePrices || {})) return;
        changes.push([d.ref, {
            sizePrices: sp, types, type: types[0] || it.type || 'general',
            priceOriginal: base.o, priceDiscount: base.d || 0,
            searchTags: [...new Set([...(it.searchTags || []), ...types])],
            updatedAt: now,
        }]);
    });
    if (!changes.length) { toast('Saved. Every poster already has these prices.', 'success'); closePriceSheet(); return; }
    if (!confirm(`Update the prices of ${changes.length} poster${changes.length === 1 ? '' : 's'} to the standard prices?`)) return;
    try {
        for (let i = 0; i < changes.length; i += 400) {
            const batch = writeBatch(db);
            changes.slice(i, i + 400).forEach(([ref, data]) => batch.update(ref, data));
            await batch.commit();
        }
        await syncSnapshot('posters');
        toast(`${changes.length} poster${changes.length === 1 ? '' : 's'} updated.`, 'success');
        closePriceSheet();
        if (window.activeTab === 'posters') fetchItems('posters');
    } catch (e) {
        console.error('[ManageItems] apply standard prices:', e);
        toast('Update failed: ' + e.message, 'error');
    }
};

/* ════════════════════════════════
   SUGGESTED POSTER THEMES (sub-categories)
   Shoppers browse Wall Posters by Theme; this adds the usual set in one tap.
   ════════════════════════════════ */
const SUGGESTED_THEMES = ['Movies & TV', 'Anime', 'Cars & Bikes', 'Sports', 'Music', 'Quotes & Motivation',
                          'Aesthetic & Minimal', 'Nature & Travel', 'Gaming', 'Spiritual'];
window.addSuggestedThemes = async function() {
    try {
        const snap = await getDoc(doc(db, 'metadata', 'item_filters'));
        const have = new Set((snap.exists() ? snap.data().posters?.brands : null) || []);
        const add = SUGGESTED_THEMES.filter(t => !have.has(t));
        if (!add.length) return toast('All suggested themes are already added.', 'success');
        if (!confirm(`Add ${add.length} theme${add.length === 1 ? '' : 's'}?\n\n${add.join(', ')}`)) return;
        const now = new Date().toISOString();
        await Promise.all(add.map(name => addDoc(collection(db, 'itemAttributes'), { category: 'posters', type: 'brand', name, createdAt: now })));
        await updateDoc(doc(db, 'metadata', 'item_filters'), { 'posters.brands': arrayUnion(...add), lastUpdated: now })
            .catch(() => setDoc(doc(db, 'metadata', 'item_filters'), { posters: { brands: add }, lastUpdated: now }, { merge: true }));
        toast(`${add.length} theme${add.length === 1 ? '' : 's'} added. Tick them on each poster.`, 'success');
    } catch (e) { toast('Could not add themes: ' + e.message, 'error'); }
};

function openModal() {
    document.getElementById('createModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
}
window.closeCreateModal = function() {
    document.getElementById('createModalOverlay').classList.remove('open');
    document.body.style.overflow = '';
    editingItemId = null; selectedFiles = []; primaryIdx = 0;
};

/* ── Auto-slug ID from name ── */
document.getElementById('fName').addEventListener('input', e => {
    if (editingItemId) return;
    document.getElementById('fId').value = e.target.value.toLowerCase()
        .replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-+|-+$/g,'');
});

/* ── Image handling ── */
document.getElementById('fImages').addEventListener('change', function() {
    const files = Array.from(this.files);
    const existing = document.querySelectorAll('[data-existing-img]').length;
    if (existing + selectedFiles.length + files.length > 5) {
        toast('Max 5 images allowed.', 'error'); return;
    }
    const big = files.filter(f => f.size > 1024 * 1024);
    if (big.length) { toast('Each image must be under 1 MB.', 'error'); return; }

    files.forEach(file => {
        const reader = new FileReader();
        reader.onload = re => {
            selectedFiles.push({ file, src: re.target.result });
            renderPreviews();
        };
        reader.readAsDataURL(file);
    });
});

function appendExistingPreview(img, idx) {
    const row = document.getElementById('previewRow');
    const div = document.createElement('div');
    div.className = 'mi-preview-item';
    div.dataset.existingImg = JSON.stringify(img);
    div.innerHTML = `
        <img src="${esc(img.url)}" class="mi-preview-img">
        <button type="button" class="mi-preview-rm" onclick="this.closest('.mi-preview-item').remove()">
            <i class="fa-solid fa-xmark"></i>
        </button>
        <input type="radio" name="primary-img" value="existing-${idx}" class="mi-primary-radio" ${img.isPrimary?'checked':''}>`;
    row.appendChild(div);
}

function renderPreviews() {
    // Remove old new-file previews (keep existing)
    document.querySelectorAll('.mi-preview-item:not([data-existing-img])').forEach(el => el.remove());
    const row = document.getElementById('previewRow');
    selectedFiles.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'mi-preview-item';
        div.innerHTML = `
            <img src="${item.src}" class="mi-preview-img">
            <button type="button" class="mi-preview-rm" onclick="removeFile(${i})">
                <i class="fa-solid fa-xmark"></i>
            </button>
            <input type="radio" name="primary-img" value="new-${i}" class="mi-primary-radio" ${i===primaryIdx&&!document.querySelector('input[name="primary-img"][value^="existing"]:checked')?'checked':''}>`;
        row.appendChild(div);
    });
}

window.removeFile = function(idx) {
    selectedFiles.splice(idx, 1);
    if (primaryIdx >= selectedFiles.length) primaryIdx = 0;
    renderPreviews();
};

/* ════════════════════════════════
   SUBMIT (CREATE / UPDATE)
   ════════════════════════════════ */
/* ════════════════════════════════
   IMAGE UPLOAD HELPERS
   Phone photos are shrunk before upload and each upload is retried,
   so a slow or flaky mobile connection doesn't fail the whole save.
   ════════════════════════════════ */
async function shrinkImage(file, maxSide = 1400, quality = 0.82) {
    try {
        if (file.size <= 250 * 1024) return file;
        const bmp   = await createImageBitmap(file);
        const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
        bmp.close?.();
        const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', quality));
        if (!blob || blob.type !== 'image/webp' || blob.size >= file.size) return file;
        return new File([blob], file.name.replace(/\.\w+$/, '') + '.webp', { type: 'image/webp' });
    } catch (_) { return file; }
}

async function uploadImage(url, secret, file, cat, itemId, n) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const fd = new FormData();
            fd.append('image',    file);
            fd.append('category', cat);
            fd.append('itemId',   itemId);
            const res = await fetch(url, {
                method:  'POST',
                headers: { 'x-server-secret': secret },
                body:    fd,
                signal:  AbortSignal.timeout(90000),
            });
            let data = {};
            try { data = await res.json(); } catch (_) {}
            if (res.ok) return data;
            const err = new Error(data.error || `Image ${n} upload failed (${res.status})`);
            if (res.status < 500) { err.fatal = true; throw err; }   // rejected: retrying won't help
            lastErr = err;
        } catch (e) {
            if (e.fatal) throw e;
            lastErr = e;
        }
        if (attempt < 3) await new Promise(r => setTimeout(r, 1200 * attempt));
    }
    throw lastErr;
}

window.submitItem = async function() {
    const form = document.getElementById('itemForm');
    if (!form.checkValidity()) { form.reportValidity(); return; }

    const cat      = document.getElementById('fCategory').value;
    const name     = document.getElementById('fName').value.trim();
    const itemId   = document.getElementById('fId').value.trim();
    const priceOrg = parseFloat(document.getElementById('fPriceOrg').value || 0);
    const priceDisc= parseFloat(document.getElementById('fPriceDisc').value || 0);
    const desc     = document.getElementById('fDesc').value.trim();
    const cfg      = CAT_CFG[cat] || CAT_CFG.stationary;

    if (!itemId) { toast('Product ID required.', 'error'); return; }

    const brands = Array.from(document.querySelectorAll('input[name="item-brand"]:checked')).map(c => c.value);
    const types  = Array.from(document.querySelectorAll('input[name="item-type"]:checked')).map(c => c.value);

    // Wall posters: one price per ticked size; the base price is the cheapest size
    let sizePrices = null, basePrices = { o: priceOrg, d: priceDisc };
    if (cat === 'posters') {
        sizePrices = {};
        let lowest = null;
        for (const row of document.querySelectorAll('#fSizePrices [data-size]')) {
            const o = parseFloat(row.querySelector('.sp-org').value || 0);
            const d = parseFloat(row.querySelector('.sp-disc').value || 0);
            if (!(o > 0)) { toast(`Enter a price for size ${row.dataset.size}.`, 'error'); return; }
            if (d && d >= o) { toast(`Discount for ${row.dataset.size} must be below its original price.`, 'error'); return; }
            sizePrices[row.dataset.size] = { priceOriginal: o, priceDiscount: d || 0 };
            const eff = d > 0 ? d : o;
            if (!lowest || eff < lowest.eff) lowest = { eff, o, d: d || 0 };
        }
        if (!lowest) { toast('Select at least one size and set its price.', 'error'); return; }
        basePrices = { o: lowest.o, d: lowest.d };
    }

    // Collect existing retained images
    const existingImages = Array.from(document.querySelectorAll('[data-existing-img]')).map(div => {
        const img   = JSON.parse(div.dataset.existingImg);
        const radio = div.querySelector('input[name="primary-img"]');
        return { ...img, isPrimary: radio ? radio.checked : false };
    });

    if (!selectedFiles.length && !existingImages.length) {
        toast('Add at least one image.', 'error'); return;
    }

    const btn  = document.getElementById('submitBtn');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing…';
    btn.disabled  = true;

    try {
        // Ensure config is loaded before reading SERVER_URL / R2_CONFIG
        await initAppConfig();

        // Get admin token for authenticated upload calls
        const idToken    = await auth.currentUser.getIdToken();
        const adminSecret = await getAdminToken(idToken);
        const uploadBase  = (window.__JASA_SERVER || SERVER_URL).replace(/\/$/, '');

        const primaryRadio = document.querySelector('input[name="primary-img"]:checked');
        const newImages    = [];

        for (let i = 0; i < selectedFiles.length; i++) {
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading image ${i + 1}/${selectedFiles.length}…`;
            const file = await shrinkImage(selectedFiles[i].file);
            const data = await uploadImage(`${uploadBase}/api/upload/product-image`, adminSecret, file, cat, itemId, i + 1);

            const isPrimary = primaryRadio?.value === `new-${i}`;
            // key is the R2 object key (e.g. products/stationary/pen/uuid.jpg)
            newImages.push({ url: data.url, id: data.key, isPrimary });

            // Track in r2_images collection
            try {
                await setDoc(doc(db, 'r2_images', data.key.replace(/\//g, '__')), {
                    key:        data.key,
                    url:        data.url,
                    category:   cat,
                    itemId:     itemId,
                    uploadedAt: new Date().toISOString(),
                }, { merge: true });
            } catch (_) {}
        }

        const finalImages = [...existingImages, ...newImages];
        if (finalImages.length && !finalImages.some(i => i.isPrimary)) finalImages[0].isPrimary = true;

        // Build item doc
        const firstType = types[0] || 'general';
        const sortKey   = `${cat}_${firstType}_${name}`.toLowerCase().replace(/\s+/g,'-');
        const searchTags = [...new Set([
            cat, ...types, ...brands,
            ...name.toLowerCase().split(' ').filter(w => w.length > 1)
        ])];

        const itemData = {
            name, category: cat,
            [cfg.brandField]: brands,
            [cfg.typeField]:  types,
            type: firstType,
            priceOriginal: basePrices.o,
            priceDiscount: basePrices.d,
            ...(sizePrices ? { sizePrices } : {}),
            customUpload:  cat === 'posters' && document.getElementById('fCustomUpload').checked,
            description:   desc,
            images:        finalImages,
            sortKey, searchTags,
            updatedAt: new Date().toISOString(),
            status:   'active'
        };

        if (editingItemId) {
            await setDoc(doc(db, 'items', editingItemId), itemData);
            toast('Product updated!', 'success');
        } else {
            itemData.createdAt = itemData.updatedAt;
            await setDoc(doc(db, 'items', itemId), itemData);
            toast('Product created!', 'success');
        }

        await syncSnapshot(cat);
        window.closeCreateModal();
        fetchItems(cat);
    } catch (err) {
        console.error('[ManageItems] submitItem:', err);
        const netErr = (err instanceof TypeError && /fetch/i.test(err.message))
            || err.name === 'TimeoutError' || err.name === 'AbortError';
        const msg = netErr
            ? 'Upload failed — your connection looks slow or unstable. Nothing was saved; please try again.'
            : err.message;
        toast('Error: ' + msg, 'error');
    }

    btn.innerHTML = orig;
    btn.disabled  = false;
};

/* ════════════════════════════════
   DELETE
   ════════════════════════════════ */
window.confirmDelete = function(id, name) {
    document.getElementById('deleteDialogMsg').innerHTML = `Delete <b>${esc(name)}</b>? This cannot be undone.`;
    document.getElementById('deleteConfirmBtn').onclick  = () => doDelete(id);
    document.getElementById('deleteDialogOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.closeDeleteDialog = function() {
    document.getElementById('deleteDialogOverlay').classList.remove('open');
    document.body.style.overflow = '';
};

async function doDelete(id) {
    window.closeDeleteDialog();
    try {
        const snap = await getDoc(doc(db, 'items', id));
        const cat  = snap.exists() ? snap.data().category : window.activeTab;

        // Delete R2 images for this item
        if (snap.exists()) {
            const images = snap.data().images || [];
            try {
                const idToken     = await auth.currentUser.getIdToken();
                const adminSecret = await getAdminToken(idToken);
                const uploadBase  = (window.__JASA_SERVER || SERVER_URL).replace(/\/$/, '');
                await Promise.allSettled(images.map(img => {
                    if (!img.id || !img.id.startsWith('products/')) return Promise.resolve();
                    return fetch(`${uploadBase}/api/upload/product-image`, {
                        method:  'DELETE',
                        headers: {
                            'Content-Type':    'application/json',
                            'x-server-secret': adminSecret,
                        },
                        body: JSON.stringify({ key: img.id }),
                    });
                }));
                // Clean up r2_images registry
                images.forEach(img => {
                    if (img.id) deleteDoc(doc(db, 'r2_images', img.id.replace(/\//g,'__'))).catch(() => {});
                });
            } catch (_) { /* non-fatal — item deletion proceeds regardless */ }
        }

        await deleteDoc(doc(db, 'items', id));
        await syncSnapshot(cat);
        toast('Item deleted.', 'success');
        fetchItems(cat);
    } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
}

/* ════════════════════════════════
   METADATA INIT
   ════════════════════════════════ */
async function ensureMetadata() {
    const ref  = doc(db, 'metadata', 'item_filters');
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data().stationary) return;  // already good
    // Bootstrap from itemAttributes collection
    const all  = await getDocs(collection(db, 'itemAttributes'));
    const meta = {
        stationary: { brands:[], types:[] },
        electronic: { brands:[], types:[] },
        books:      { authors:[], bookCategories:[] },
        posters:    { brands:[], types:[] },
        lastUpdated: new Date().toISOString()
    };
    all.forEach(d => {
        const { category: c, type: t, name: n } = d.data();
        if (!meta[c]) return;
        const f = t === 'author' ? 'authors' : t === 'category' ? 'bookCategories' : t === 'brand' ? 'brands' : 'types';
        if (meta[c][f] && !meta[c][f].includes(n)) meta[c][f].push(n);
    });
    await setDoc(ref, meta, { merge: true });
}

/* ════════════════════════════════
   AUTH GUARD — admin OR manage_items
   ════════════════════════════════ */
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search)); return; }

    // Fast cache check
    try {
        const cached = localStorage.getItem('jasa_user_cache');
        if (cached) {
            const cd = JSON.parse(cached);
            const cr = cd.roles || [cd.role || 'user'];
            if (!cr.includes('admin') && !cr.includes('manage_items')) {
                window.location.replace('index.html'); return;
            }
        }
    } catch (_) {}

    // Live Firestore check
    try {
        const snap  = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin') && !roles.includes('manage_items')) {
            toast('Access denied.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1200);
            return;
        }
        // Authorised
        ensureMetadata();
        fetchItems(window.activeTab);
    } catch (err) {
        console.error('[ManageItems] auth error:', err);
        window.location.replace('index.html');
    }
});
