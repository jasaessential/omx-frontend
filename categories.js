/* ═══════════════════════════════════════════════
   JASA V2 — categories.js
   Unified shop page: Stationary / Books / Kits
   Firestore: categoryData/{cat} → items[]
   Fallback:  items collection where category==
   Cart:      localStorage key "jasa_cart"
   ═══════════════════════════════════════════════ */

import { db, auth } from './firebase-init.js';
import { watchCatalog } from './catalog-sync.js';
import {
    collection, query, where, getDocs, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const WORKER_URL = 'https://jasa-backend-worker.jasaessential3.workers.dev';

/* ── Track auth state ── */
let currentUser = null;
onAuthStateChanged(auth, user => { currentUser = user; });

/* ════════════════════════════════
   CATEGORY CONFIG
   ════════════════════════════════ */
const CATEGORIES = {
    stationary: {
        label:    'Stationary',
        icon:     'fa-solid fa-pen-ruler',
        color:    '#22c55e',
        filters:  [
            { id: 'brand', label: 'Brand',  field: 'brands' },
            { id: 'type',  label: 'Type',   field: 'types'  },
            { id: 'price', label: 'Price',  field: '_price' },
        ],
        priceRanges: [
            { id: 'under50',  label: 'Under ₹50',      min: 0,   max: 50   },
            { id: '50to200',  label: '₹50 – ₹200',     min: 50,  max: 200  },
            { id: '200to500', label: '₹200 – ₹500',    min: 200, max: 500  },
            { id: 'above500', label: 'Above ₹500',      min: 500, max: Infinity },
        ],
    },
    books: {
        label:    'Books',
        icon:     'fa-solid fa-book-open',
        color:    '#f59e0b',
        filters:  [
            { id: 'author',  label: 'Author',   field: 'authors'    },
            { id: 'bookcat', label: 'Category', field: 'categories' },
            { id: 'price',   label: 'Price',    field: '_price'     },
        ],
        priceRanges: [
            { id: 'under100',  label: 'Under ₹100',     min: 0,   max: 100  },
            { id: '100to300',  label: '₹100 – ₹300',    min: 100, max: 300  },
            { id: '300to600',  label: '₹300 – ₹600',    min: 300, max: 600  },
            { id: 'above600',  label: 'Above ₹600',      min: 600, max: Infinity },
        ],
    },
    electronic: {
        label:    'Kits',
        icon:     'fa-solid fa-microchip',
        color:    '#a855f7',
        filters:  [
            { id: 'brand', label: 'Brand', field: 'brands' },
            { id: 'type',  label: 'Type',  field: 'types'  },
            { id: 'price', label: 'Price', field: '_price' },
        ],
        priceRanges: [
            { id: 'under200',   label: 'Under ₹200',      min: 0,    max: 200    },
            { id: '200to500',   label: '₹200 – ₹500',     min: 200,  max: 500    },
            { id: '500to1500',  label: '₹500 – ₹1,500',   min: 500,  max: 1500   },
            { id: 'above1500',  label: 'Above ₹1,500',     min: 1500, max: Infinity },
        ],
    },
    posters: {
        label:    'Wall Posters',
        icon:     'fa-solid fa-image',
        color:    '#ec4899',
        filters:  [
            { id: 'theme', label: 'Theme', field: 'brands' },
            { id: 'size',  label: 'Size',  field: 'types'  },
            { id: 'price', label: 'Price', field: '_price' },
        ],
        priceRanges: [
            { id: 'under100',  label: 'Under ₹100',      min: 0,   max: 100  },
            { id: '100to250',  label: '₹100 – ₹250',     min: 100, max: 250  },
            { id: '250to500',  label: '₹250 – ₹500',     min: 250, max: 500  },
            { id: 'above500',  label: 'Above ₹500',       min: 500, max: Infinity },
        ],
    },
};

const SORT_OPTIONS = [
    { id: 'relevance',  label: 'Relevance'              },
    { id: 'price_asc',  label: 'Price: Low to High'     },
    { id: 'price_desc', label: 'Price: High to Low'     },
    { id: 'name_asc',   label: 'Name: A → Z'            },
    { id: 'name_desc',  label: 'Name: Z → A'            },
    { id: 'disc_desc',  label: 'Discount: High to Low'  },
];

/* ════════════════════════════════
   STATE
   ════════════════════════════════ */
let activeCategory  = 'stationary';
let allItems        = [];
let activeFilters   = {};   // { filterId: Set<string> }
let activeSort      = 'relevance';
let activeFilterTab = '';   // which filter sub-tab is open
let searchTimer     = null;

/* ════════════════════════════════
   INIT
   ════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    /* Read ?cat= and ?search= from URL */
    const params = new URLSearchParams(window.location.search);
    const param  = params.get('cat');
    const search = params.get('search') || '';
    if (param && CATEGORIES[param]) activeCategory = param;

    /* Wire search input */
    const input    = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    input?.addEventListener('input', () => {
        clearBtn.style.display = input.value.trim() ? 'flex' : 'none';
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applyAndRender, 220);
    });

    /* Pre-fill search term passed from home search bar */
    if (search && input) {
        input.value = search;
        if (clearBtn) clearBtn.style.display = 'flex';
    }

    activateCategoryTab(activeCategory);
    loadItems(activeCategory);

    /* Reload instantly when an admin adds / edits / removes a product */
    watchCatalog(cat => { if (cat === activeCategory) loadItems(cat); });
});

/* ════════════════════════════════
   CATEGORY SWITCH
   ════════════════════════════════ */
window.switchCategory = function (cat) {
    if (cat === activeCategory) return;
    activeCategory  = cat;
    activeFilters   = {};
    activeSort      = 'relevance';

    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (input)    { input.value = ''; }
    if (clearBtn) { clearBtn.style.display = 'none'; }

    activateCategoryTab(cat);
    showSkeletons();
    loadItems(cat);

    /* Update URL without reload */
    const url = new URL(window.location);
    url.searchParams.set('cat', cat);
    window.history.replaceState({}, '', url);
};

function activateCategoryTab(cat) {
    document.querySelectorAll('.cat-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.cat === cat);
    });
}

/* ════════════════════════════════
   DATA LOADING
   1. Cloudflare Worker KV (primary, always fetched)
   2. copy saved on this device (only when the Worker can't be reached)
   3. Firestore categoryData/{cat} snapshot
   4. Firestore items collection query (final fallback)
   ════════════════════════════════ */
async function loadItems(cat) {
    const CACHE_KEY = `jasa_v2_cat_${cat}`;
    showSkeletons();

    /* 1. Cloudflare Worker — KV cache (primary source) */
    let workerOk = false;
    let workerReached = false;
    try {
        const res = await fetch(`${WORKER_URL}/api/items?category=${cat}`, { cache: 'no-cache' });
        if (res.ok) {
            workerReached = true;
            const json = await res.json();
            const data = json.items || [];
            if (data.length) {
                allItems = data;
                cacheItems(CACHE_KEY, data);
                buildFilterUI();
                applyAndRender();
                workerOk = true;
                return;
            }
            console.warn(`[categories] Worker returned 0 items for ${cat}`);
        } else {
            console.error(`[categories] Worker returned HTTP ${res.status} for ${cat}`);
        }
    } catch (err) {
        console.error(`[categories] Worker fetch failed:`, err.message);
    }

    /* 2. Worker unreachable — the copy saved on this device */
    if (!workerReached) {
        try {
            const { data } = JSON.parse(sessionStorage.getItem(CACHE_KEY) || '{}');
            if (Array.isArray(data) && data.length) {
                allItems = data;
                buildFilterUI();
                applyAndRender();
                return;
            }
        } catch (_) {}
    }

    /* 3. Firestore categoryData/{cat} snapshot — faster single-doc read */
    if (!workerOk) {
        try {
            const snap = await getDoc(doc(db, 'categoryData', cat));
            if (snap.exists()) {
                const data = snap.data().items || [];
                if (data.length) {
                    allItems = data;
                    cacheItems(CACHE_KEY, data);
                    buildFilterUI();
                    applyAndRender();
                    return;
                }
            }
        } catch (e) {
            console.warn(`[categories] categoryData fallback failed:`, e.message);
        }
    }

    /* 4. Firestore items collection — final fallback */
    console.warn(`[categories] Falling back to Firestore items collection for ${cat}`);
    try {
        const q    = query(collection(db, 'items'), where('category', '==', cat));
        const snap = await getDocs(q);
        const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        allItems = data;
        if (data.length) cacheItems(CACHE_KEY, data);
        buildFilterUI();
        applyAndRender();
    } catch (err) {
        console.error('[categories] Firestore fallback failed:', err.message);
        showError('Could not load products. Check your connection and refresh.');
    }
}

function cacheItems(key, data) {
    try {
        sessionStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
    } catch (_) {}
}

/* ════════════════════════════════
   HELPERS
   ════════════════════════════════ */
function getPrice(item) {
    const d = item.priceDiscount || 0, o = item.priceOriginal || 0;
    return (d > 0 && d < o) ? d : o;
}
function getDiscount(item) {
    const d = item.priceDiscount || 0, o = item.priceOriginal || 0;
    return (d > 0 && d < o) ? Math.round(((o - d) / o) * 100) : 0;
}
function esc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

/* ════════════════════════════════
   FILTER UI
   ════════════════════════════════ */
function buildFilterUI() {
    const catCfg   = CATEGORIES[activeCategory];
    const filters  = catCfg.filters;
    const priceRng = catCfg.priceRanges;

    /* Collect unique values per filter */
    const values = {};
    filters.forEach(f => {
        if (f.field === '_price') { values[f.id] = null; return; }
        const set = new Set();
        allItems.forEach(item => {
            const val = item[f.field];
            if (Array.isArray(val)) val.forEach(v => v && set.add(v));
            else if (typeof val === 'string' && val) set.add(val);
        });
        values[f.id] = [...set].sort();
    });

    /* Tab row */
    const tabRow = document.getElementById('filterCats');
    activeFilterTab = filters[0].id;
    tabRow.innerHTML = filters.map((f, i) =>
        `<button class="filter-tab-btn ${i === 0 ? 'active' : ''}"
                 id="ftab-${f.id}"
                 onclick="switchFilterTab('${f.id}',this)">
             ${f.label}
         </button>`
    ).join('');

    /* Option panes */
    const panes = document.getElementById('filterOpts');
    panes.innerHTML = filters.map((f, i) => {
        if (f.field === '_price') {
            return `<div class="filter-pane ${i === 0 ? 'active' : ''}" id="fpane-${f.id}">
                ${priceRng.map(r =>
                    `<label class="filter-check">
                         <input type="checkbox" data-filter="${f.id}" value="${r.id}">
                         ${r.label}
                     </label>`
                ).join('')}
            </div>`;
        }
        const opts = values[f.id] || [];
        if (!opts.length) {
            return `<div class="filter-pane ${i === 0 ? 'active' : ''}" id="fpane-${f.id}">
                <p style="text-align:center;color:var(--txt3);font-size:.78rem;padding:20px 0;">No options available</p>
            </div>`;
        }
        return `<div class="filter-pane ${i === 0 ? 'active' : ''}" id="fpane-${f.id}">
            ${opts.map(v =>
                `<label class="filter-check">
                     <input type="checkbox" data-filter="${f.id}" value="${esc(v)}">
                     ${v}
                 </label>`
            ).join('')}
        </div>`;
    }).join('');

    /* Sort list */
    const sortList = document.getElementById('sortOptionsList');
    sortList.innerHTML = SORT_OPTIONS.map(s =>
        `<label class="sort-option ${s.id === activeSort ? 'selected' : ''}">
             <input type="radio" name="sortOpt" value="${s.id}"
                    ${s.id === activeSort ? 'checked' : ''}
                    onchange="selectSort('${s.id}')">
             ${s.label}
         </label>`
    ).join('');
}

window.switchFilterTab = function (tabId, btn) {
    activeFilterTab = tabId;
    document.querySelectorAll('.filter-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.filter-pane').forEach(p => p.classList.remove('active'));
    document.getElementById(`fpane-${tabId}`)?.classList.add('active');
};

/* ════════════════════════════════
   FILTER SHEET
   ════════════════════════════════ */
window.openFilterSheet = function () {
    /* Restore checked state */
    document.querySelectorAll('[data-filter]').forEach(cb => {
        cb.checked = activeFilters[cb.dataset.filter]?.has(cb.value) || false;
    });
    updateApplyCount();
    document.getElementById('filterBackdrop').classList.add('show');
    requestAnimationFrame(() =>
        document.getElementById('filterSheet').classList.add('open')
    );
};
window.closeFilterSheet = function () {
    document.getElementById('filterSheet').classList.remove('open');
    document.getElementById('filterBackdrop').classList.remove('show');
};

function updateApplyCount() {
    const n  = document.querySelectorAll('[data-filter]:checked').length;
    const el = document.getElementById('filterApplyCount');
    if (el) el.textContent = n > 0 ? `(${n})` : '';
}

window.applyFilters = function () {
    activeFilters = {};
    document.querySelectorAll('[data-filter]:checked').forEach(cb => {
        const g = cb.dataset.filter;
        if (!activeFilters[g]) activeFilters[g] = new Set();
        activeFilters[g].add(cb.value);
    });
    renderChips();
    updateFilterBadge();
    applyAndRender();
    closeFilterSheet();
};

window.clearAllFilters = function () {
    document.querySelectorAll('[data-filter]').forEach(cb => cb.checked = false);
    activeFilters = {};
    renderChips();
    updateFilterBadge();
    applyAndRender();
    closeFilterSheet();
};

function updateFilterBadge() {
    const total = Object.values(activeFilters).reduce((s, set) => s + set.size, 0);
    const badge = document.getElementById('filterBadge');
    const btn   = document.getElementById('filterBtn');
    if (total > 0) {
        badge.textContent = total;
        badge.style.display = 'flex';
        btn.classList.add('active');
    } else {
        badge.style.display = 'none';
        btn.classList.remove('active');
    }
}

function renderChips() {
    const el    = document.getElementById('activeChips');
    const catCfg = CATEGORIES[activeCategory];
    const chips = [];

    Object.entries(activeFilters).forEach(([grp, vals]) => {
        vals.forEach(v => {
            const display = grp === 'price'
                ? catCfg.priceRanges.find(r => r.id === v)?.label || v
                : v;
            chips.push({ grp, v, display });
        });
    });

    if (!chips.length) {
        el.style.display = 'none';
        return;
    }
    el.style.display = 'flex';
    el.innerHTML = chips.map(c =>
        `<span class="cat-chip">
             ${c.display}
             <button class="cat-chip-rm" onclick="removeChip('${c.grp}','${esc(c.v)}')">
                 <i class="fa-solid fa-xmark"></i>
             </button>
         </span>`
    ).join('');
}

window.removeChip = function (grp, val) {
    activeFilters[grp]?.delete(val);
    if (!activeFilters[grp]?.size) delete activeFilters[grp];
    renderChips();
    updateFilterBadge();
    applyAndRender();
};

/* ════════════════════════════════
   SORT SHEET
   ════════════════════════════════ */
window.openSortSheet = function () {
    document.getElementById('sortBackdrop').classList.add('show');
    requestAnimationFrame(() =>
        document.getElementById('sortSheet').classList.add('open')
    );
};
window.closeSortSheet = function () {
    document.getElementById('sortSheet').classList.remove('open');
    document.getElementById('sortBackdrop').classList.remove('show');
};
window.selectSort = function (id) {
    activeSort = id;
    /* Update sort btn active state */
    document.getElementById('sortBtn')
        .classList.toggle('active', id !== 'relevance');
    /* Re-highlight selected option */
    document.querySelectorAll('.sort-option').forEach(l => {
        l.classList.toggle('selected',
            l.querySelector('input')?.value === id);
    });
    applyAndRender();
    setTimeout(closeSortSheet, 180);
};

/* ════════════════════════════════
   SEARCH
   ════════════════════════════════ */
window.clearSearch = function () {
    const input = document.getElementById('searchInput');
    const btn   = document.getElementById('searchClearBtn');
    if (input) input.value = '';
    if (btn)   btn.style.display = 'none';
    applyAndRender();
    input?.focus();
};

/* ════════════════════════════════
   FILTER + SORT + RENDER
   ════════════════════════════════ */
function applyAndRender() {
    const catCfg  = CATEGORIES[activeCategory];
    let   items   = [...allItems];

    /* Search */
    const q = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
    if (q) {
        items = items.filter(item => {
            const name = (item.name || '').toLowerCase();
            /* search across all filterable array fields */
            const extra = catCfg.filters
                .filter(f => f.field !== '_price')
                .flatMap(f => {
                    const v = item[f.field];
                    return Array.isArray(v) ? v : (v ? [v] : []);
                })
                .map(s => String(s).toLowerCase());
            return name.includes(q) || extra.some(s => s.includes(q));
        });
    }

    /* Filters */
    Object.entries(activeFilters).forEach(([grp, vals]) => {
        if (!vals.size) return;
        if (grp === 'price') {
            items = items.filter(item => {
                const p = getPrice(item);
                return [...vals].some(rid => {
                    const r = catCfg.priceRanges.find(x => x.id === rid);
                    return r && p >= r.min && p < r.max;
                });
            });
        } else {
            const filterDef = catCfg.filters.find(f => f.id === grp);
            if (!filterDef) return;
            items = items.filter(item => {
                const arr = item[filterDef.field] || [];
                return [...vals].some(v =>
                    Array.isArray(arr) ? arr.includes(v) : arr === v
                );
            });
        }
    });

    /* Sort */
    switch (activeSort) {
        case 'price_asc':  items.sort((a, b) => getPrice(a) - getPrice(b)); break;
        case 'price_desc': items.sort((a, b) => getPrice(b) - getPrice(a)); break;
        case 'name_asc':   items.sort((a, b) => (a.name||'').localeCompare(b.name||'')); break;
        case 'name_desc':  items.sort((a, b) => (b.name||'').localeCompare(a.name||'')); break;
        case 'disc_desc':  items.sort((a, b) => getDiscount(b) - getDiscount(a)); break;
    }

    /* Results count */
    const rc = document.getElementById('resultsCount');
    if (rc) rc.textContent = items.length
        ? `${items.length} result${items.length !== 1 ? 's' : ''}`
        : '';

    renderGrid(items);
}

/* ════════════════════════════════
   RENDER GRID
   ════════════════════════════════ */
function renderGrid(items) {
    const grid   = document.getElementById('productsGrid');
    const catCfg = CATEGORIES[activeCategory];
    if (!grid) return;

    if (!items.length) {
        grid.innerHTML = `
        <div class="cat-empty">
            <div class="cat-empty-icon"><i class="${catCfg.icon}"></i></div>
            <h5>No Products Found</h5>
            <p>Try adjusting your filters or search term.</p>
            <button class="cat-empty-btn" onclick="clearAllFilters();clearSearch();">
                <i class="fa-solid fa-rotate-left"></i> Clear Filters
            </button>
        </div>`;
        return;
    }

    grid.innerHTML = items.map(item => buildCard(item, catCfg)).join('');
}

function buildCard(item, catCfg) {
    const o       = item.priceOriginal || 0;
    const d       = item.priceDiscount || 0;
    const hasDisc = d > 0 && d < o;
    const price   = hasDisc ? d : o;
    const disc    = hasDisc ? Math.round(((o - d) / o) * 100) : 0;

    /* Primary image — handle multiple storage shapes:
       1. images[] array with {url, isPrimary} objects  (standard)
       2. images[] array with plain URL strings          (legacy)
       3. top-level imageUrl / image / thumbnail fields  (old schema) */
    let primaryImg = null;
    if (Array.isArray(item.images) && item.images.length) {
        // Find the marked primary, fallback to first element
        const primary = item.images.find(img => img && img.isPrimary);
        const first   = item.images[0];
        // Handle both object shape {url:...} and plain string shape
        const resolve = (img) => (typeof img === 'string' ? img : img?.url) || null;
        primaryImg = resolve(primary) || resolve(first);
    }
    // Legacy field fallbacks
    if (!primaryImg) {
        primaryImg = item.imageUrl || item.image || item.thumbnail || null;
    }

    const imgHtml = primaryImg
        ? `<img src="${primaryImg}" alt="${esc(item.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
           <i class="${catCfg.icon} prod-no-img" style="display:none;"></i>`
        : `<i class="${catCfg.icon} prod-no-img"></i>`;

    /* Subtitle: brand / author / type */
    const sub = (item.brands?.[0]) || (item.authors?.[0])
        || (item.categories?.[0]) || (item.types?.[0])
        || (item.type || catCfg.label);

    /* Escaped strings for onclick attrs */
    const safeName = esc(item.name);
    const safeImg  = primaryImg ? esc(primaryImg) : '';
    const cat      = activeCategory;
    /* Sized or custom-photo posters need a choice first: open the product page */
    const pick     = item.customUpload || Object.keys(item.sizePrices || {}).length
        ? `location.href='item-details.html?id=${item.id}'` : '';
    const line     = `{id:'${item.id}',name:'${safeName}',price:${price},originalPrice:${o},discountPercent:${disc},img:'${safeImg}',category:'${cat}'}`;

    return `
    <div class="prod-card">
        <a href="item-details.html?id=${item.id}" class="prod-card-link" style="text-decoration:none;color:inherit;display:contents;">
            <div class="prod-card-img">${imgHtml}</div>
            <div class="prod-card-body">
                <div class="prod-card-name">${item.name}</div>
                <div class="prod-card-sub">${sub}</div>
                <div class="prod-card-price-row">
                    <span class="prod-price">₹${price.toLocaleString('en-IN')}</span>
                    ${hasDisc ? `<span class="prod-original">₹${o.toLocaleString('en-IN')}</span>` : ''}
                    ${disc > 0 ? `<span class="prod-disc">${disc}% OFF</span>` : ''}
                </div>
                <div class="prod-card-actions">
                    <button class="prod-buy-btn"
                        onclick="event.preventDefault();event.stopPropagation();${pick || `addToCartAndGo(${line})`}">
                        <i class="fa-solid fa-bag-shopping"></i> Buy Now
                    </button>
                    <button class="prod-cart-btn" id="cart-btn-${item.id}"
                        onclick="event.preventDefault();event.stopPropagation();${pick || `addToCart(${line})`}">
                        <i class="fa-solid fa-cart-shopping"></i>
                    </button>
                </div>
            </div>
        </a>
    </div>`;
}

/* ════════════════════════════════
   CART  (localStorage, mirrors script.js CartManager)
   ════════════════════════════════ */
const CART_KEY = 'jasa_cart';

function getCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { return []; }
}
function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateCartBadge(cart);
    window.dispatchEvent(new CustomEvent('cartUpdated', { detail: cart }));
}
function updateCartBadge(cart) {
    const total = (cart || getCart()).reduce((s, i) => s + i.qty, 0);
    document.querySelectorAll('#header-cart-count, .cart-badge-global, .cart-badge')
        .forEach(el => {
            el.textContent  = total;
            el.style.display = total > 0 ? 'flex' : 'none';
        });
}

window.addToCart = function (item) {
    /* Auth check */
    if (!currentUser) {
        showToast('Please sign in to add items to cart.', 'error');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }
    const cart     = getCart();
    const existing = cart.find(i => i.id === item.id);
    if (existing) {
        existing.qty += 1;
    } else {
        cart.push({ ...item, qty: 1 });
    }
    saveCart(cart);

    /* Animate cart button */
    const btn = document.getElementById(`cart-btn-${item.id}`);
    if (btn) {
        btn.classList.add('added');
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        setTimeout(() => {
            btn.classList.remove('added');
            btn.innerHTML = '<i class="fa-solid fa-cart-shopping"></i>';
        }, 1400);
    }
    showToast(`${item.name} added to cart!`, 'success');
};

window.addToCartAndGo = function (item) {
    if (!currentUser) {
        showToast('Please sign in to continue.', 'error');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }
    const cart     = getCart();
    const existing = cart.find(i => i.id === item.id);
    if (existing) { existing.qty += 1; } else { cart.push({ ...item, qty: 1 }); }
    saveCart(cart);
    window.location.href = 'cart.html';
};

/* ════════════════════════════════
   TOAST
   ════════════════════════════════ */
let toastTimer = null;
function showToast(msg, type = 'success') {
    const el = document.getElementById('catToast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.className   = `cat-toast ${type}`;
    el.classList.add('show');
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ════════════════════════════════
   SKELETON / ERROR
   ════════════════════════════════ */
function showSkeletons() {
    const grid = document.getElementById('productsGrid');
    if (grid) {
        grid.innerHTML = Array(6).fill('<div class="cat-skeleton"></div>').join('');
    }
    const rc = document.getElementById('resultsCount');
    if (rc) rc.textContent = '';
}

function showError(msg) {
    const grid = document.getElementById('productsGrid');
    if (grid) {
        grid.innerHTML = `
        <div class="cat-empty">
            <div class="cat-empty-icon"><i class="fa-solid fa-circle-exclamation" style="color:#ef4444;"></i></div>
            <h5>Something went wrong</h5>
            <p>${msg}</p>
            <button class="cat-empty-btn" onclick="location.reload()">
                <i class="fa-solid fa-rotate-right"></i> Retry
            </button>
        </div>`;
    }
}

/* Sync cart badge on load */
document.addEventListener('DOMContentLoaded', () => updateCartBadge());
window.addEventListener('storage', e => {
    if (e.key === CART_KEY) updateCartBadge();
});
