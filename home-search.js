/* ═══════════════════════════════════════════════
   JASA V2 — home-search.js
   Home page search bar — reads ONLY from
   sessionStorage / localStorage caches.
   Zero Firestore reads. Zero Worker calls.

   Cache sources (in priority order):
     1. sessionStorage jasa_v2_cat_{cat}  — set by
        home-categories.js when sections load
     2. sessionStorage jasa_v2_hcat_{cat} — set by
        home-categories.js previews
   If caches are empty the bar simply shows
   "Browse our categories" — no DB hit.

   Search logic:
     - Debounced 180 ms
     - Case-insensitive substring match on:
         name, brands[], authors[], types[],
         categories[], type
     - Max 8 results shown in dropdown
     - "See all results" → categories.html?search=…
   ═══════════════════════════════════════════════ */

/* ────────────────────────────────
   CONSTANTS
   ──────────────────────────────── */
const CAT_KEYS = [
    { cat: 'stationary', label: 'Stationary', icon: 'fa-solid fa-pen-ruler',  color: '#22c55e' },
    { cat: 'books',      label: 'Books',       icon: 'fa-solid fa-book-open',  color: '#f59e0b' },
    { cat: 'electronic', label: 'Kits',        icon: 'fa-solid fa-microchip',  color: '#a855f7' },
    { cat: 'posters',    label: 'Wall Posters', icon: 'fa-solid fa-image',     color: '#ec4899' },
];

const SESSION_KEYS = ['jasa_v2_cat_', 'jasa_v2_hcat_'];  // prefixes tried in order
const MAX_RESULTS  = 8;
const DEBOUNCE_MS  = 180;

/* ────────────────────────────────
   READ ALL ITEMS FROM CACHE
   ──────────────────────────────── */
function readCachedItems() {
    const seen  = new Set();
    const items = [];

    for (const { cat } of CAT_KEYS) {
        for (const prefix of SESSION_KEYS) {
            try {
                const raw = sessionStorage.getItem(`${prefix}${cat}`);
                if (!raw) continue;
                const { data, ts } = JSON.parse(raw);
                /* Accept cache up to 2 hours old */
                if (!data || !Array.isArray(data)) continue;
                if (Date.now() - ts > 2 * 60 * 60 * 1000) continue;

                for (const item of data) {
                    const id = item.id || item.itemId;
                    if (!id || seen.has(id)) continue;
                    seen.add(id);
                    items.push({ ...item, _cat: cat });
                }
                break; // got data from this prefix, skip next prefix for same cat
            } catch (_) {}
        }
    }
    return items;
}

/* ────────────────────────────────
   SEARCH LOGIC
   ──────────────────────────────── */
function searchItems(items, raw) {
    const q = raw.trim().toLowerCase();
    if (!q) return [];

    return items
        .filter(item => {
            const fields = [
                item.name || '',
                ...(item.brands    || []),
                ...(item.authors   || []),
                ...(item.types     || []),
                ...(item.categories|| []),
                item.type   || '',
                item.brand  || '',
                item.author || '',
            ];
            return fields.some(f => f.toLowerCase().includes(q));
        })
        .slice(0, MAX_RESULTS);
}

/* ────────────────────────────────
   HIGHLIGHT matching substring
   ──────────────────────────────── */
function highlight(text, q) {
    if (!q || !text) return esc(text || '');
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return esc(text);
    return (
        esc(text.slice(0, idx)) +
        '<mark>' + esc(text.slice(idx, idx + q.length)) + '</mark>' +
        esc(text.slice(idx + q.length))
    );
}

function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ────────────────────────────────
   PRICE RESOLVER
   ──────────────────────────────── */
function getPrice(item) {
    const d = parseFloat(item.priceDiscount || 0);
    const o = parseFloat(item.priceOriginal || item.price || 0);
    return (d > 0 && d < o) ? d : o || d;
}

/* ────────────────────────────────
   IMAGE RESOLVER
   ──────────────────────────────── */
function getImg(item) {
    if (Array.isArray(item.images) && item.images.length) {
        const p = item.images.find(i => i.isPrimary);
        return (p?.url) || item.images[0]?.url || null;
    }
    return item.image || item.imageUrl || item.thumbnail || null;
}

/* ────────────────────────────────
   RENDER RESULTS
   ──────────────────────────────── */
function renderResults(results, query) {
    const panel = document.getElementById('hsResults');
    if (!panel) return;

    if (!results.length) {
        panel.innerHTML = `
            <div class="hs-msg">
                <i class="fa-solid fa-magnifying-glass"></i>
                No results for "<strong>${esc(query)}</strong>"
            </div>`;
        panel.classList.add('open');
        return;
    }

    const rows = results.map(item => {
        const id    = item.id || item.itemId || '';
        const name  = item.name || item.itemName || 'Product';
        const price = getPrice(item);
        const img   = getImg(item);
        const catMeta = CAT_KEYS.find(c => c.cat === item._cat);

        const sub = [
            ...(item.brands    || item.authors    || []),
            ...(item.types     || item.categories || []),
            item.type || '',
        ].filter(Boolean)[0] || catMeta?.label || '';

        const imgHtml = img
            ? `<div class="hs-item-img"><img src="${esc(img)}" alt="${esc(name)}" loading="lazy"></div>`
            : `<div class="hs-item-img" style="background:${catMeta?.color || 'var(--bg)'}1a;">
                   <i class="${catMeta?.icon || 'fa-solid fa-box'}" style="color:${catMeta?.color || 'var(--txt3)'}"></i>
               </div>`;

        const priceHtml = price > 0
            ? `<div class="hs-item-price">₹${price.toLocaleString('en-IN')}</div>`
            : '';

        return `
        <a class="hs-item" href="item-details.html?id=${encodeURIComponent(id)}"
           role="option" tabindex="0">
            ${imgHtml}
            <div class="hs-item-info">
                <div class="hs-item-name">${highlight(name, query)}</div>
                ${sub ? `<div class="hs-item-sub">${esc(sub)}</div>` : ''}
            </div>
            ${priceHtml}
        </a>`;
    }).join('');

    /* Footer — "See all results in categories" */
    const footer = `
        <div class="hs-footer"
             role="option" tabindex="0"
             onclick="goToCategories('${esc(query)}')"
             onkeydown="if(event.key==='Enter')goToCategories('${esc(query)}')">
            <i class="fa-solid fa-arrow-right" style="margin-right:5px;"></i>
            See all results for "${esc(query)}"
        </div>`;

    panel.innerHTML = rows + footer;
    panel.classList.add('open');
}

window.goToCategories = function(q) {
    window.location.href = `categories.html?search=${encodeURIComponent(q)}`;
};

/* ────────────────────────────────
   INIT
   ──────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    const input   = document.getElementById('hsInput');
    const clearBtn= document.getElementById('hsClear');
    const panel   = document.getElementById('hsResults');
    const bar     = document.getElementById('hsBar');
    if (!input || !panel) return;

    let debounce = null;
    let cachedItems = [];

    /* Lazy-load cache on first focus so home-categories.js
       has time to populate sessionStorage               */
    function ensureCache() {
        if (!cachedItems.length) cachedItems = readCachedItems();
    }

    /* Open / close */
    function openPanel()  { panel.classList.add('open'); }
    function closePanel() { panel.classList.remove('open'); }

    /* Show empty/cached state when focused but no query */
    function showDefaultState() {
        ensureCache();
        if (!cachedItems.length) {
            panel.innerHTML = `
                <div class="hs-msg">
                    <i class="fa-solid fa-compass"></i>
                    Browse our categories below
                </div>`;
        } else {
            panel.innerHTML = `
                <div class="hs-msg">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    Start typing to search ${cachedItems.length} products
                </div>`;
        }
        openPanel();
    }

    /* Main search handler */
    function doSearch() {
        const q = input.value.trim();

        /* Clear button visibility */
        clearBtn.classList.toggle('visible', q.length > 0);

        if (!q) {
            showDefaultState();
            return;
        }

        ensureCache();

        if (!cachedItems.length) {
            panel.innerHTML = `
                <div class="hs-msg">
                    <i class="fa-solid fa-hourglass-half"></i>
                    Products loading — try again in a moment
                </div>`;
            openPanel();
            return;
        }

        const results = searchItems(cachedItems, q);
        renderResults(results, q);
    }

    /* Input event — debounced */
    input.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(doSearch, DEBOUNCE_MS);
    });

    /* Focus — show state */
    input.addEventListener('focus', () => {
        if (!input.value.trim()) showDefaultState();
        else openPanel();
    });

    /* Clear button */
    clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.classList.remove('visible');
        closePanel();
        input.focus();
        /* Reset cache so fresh items picked up */
        cachedItems = [];
    });

    /* Close on outside click */
    document.addEventListener('pointerdown', e => {
        const wrap = document.getElementById('hsBar')?.closest('.hs-wrap');
        if (wrap && !wrap.contains(e.target)) closePanel();
    });

    /* Keyboard navigation: Escape closes, ArrowDown moves into results */
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closePanel();
            input.blur();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const first = panel.querySelector('.hs-item, .hs-footer');
            first?.focus();
        }
        if (e.key === 'Enter' && input.value.trim()) {
            window.goToCategories(input.value.trim());
        }
    });

    panel.addEventListener('keydown', e => {
        const items  = [...panel.querySelectorAll('.hs-item, .hs-footer')];
        const idx    = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            items[idx + 1]?.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (idx === 0) input.focus();
            else items[idx - 1]?.focus();
        } else if (e.key === 'Escape') {
            closePanel();
            input.focus();
        }
    });

    /* Re-load cache after home-categories sections finish rendering
       (they populate sessionStorage — listen for the custom event) */
    window.addEventListener('hcatLoaded', () => { cachedItems = []; });
});
