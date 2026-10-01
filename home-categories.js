/* ═══════════════════════════════════════════════
   JASA V2 — home-categories.js
   Loads product previews for Stationary, Books,
   and Kits on the home page as horizontal scroll
   card rows — matching the website reference.

   Data model (Firestore items collection):
     name, category, priceOriginal, priceDiscount,
     images: [{ url, isPrimary }]

   Caching: sessionStorage per category, 5-min TTL
   ═══════════════════════════════════════════════ */

import { db } from './firebase-init.js';
import { watchCatalog } from './catalog-sync.js';
import {
    collection, query, where, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const WORKER_URL = 'https://jasa-backend-worker.jasaessential3.workers.dev';

/* ─── Section config ─── */
const SECTIONS = [
    { cat: 'stationary', trackId: 'hcatStatTrack',  color: '#22c55e', accent: '#dcfce7' },
    { cat: 'books',      trackId: 'hcatBooksTrack', color: '#f59e0b', accent: '#fef3c7' },
    { cat: 'electronic', trackId: 'hcatKitsTrack',  color: '#a855f7', accent: '#f3e8ff' },
    { cat: 'posters',    trackId: 'hcatPostersTrack', color: '#ec4899', accent: '#fce7f3' },
];

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_ITEMS = 12;

/* ─────────────────────────────────────────────
   IMAGE RESOLVER  (mirrors website mapItemForSlider)
   Priority: isPrimary image → first image → item.image → null
   ───────────────────────────────────────────── */
function resolveImage(item) {
    if (Array.isArray(item.images) && item.images.length > 0) {
        const primary = item.images.find(img => img.isPrimary);
        return (primary?.url) || (item.images[0]?.url) || null;
    }
    return item.image || item.imageUrl || item.thumbnail || null;
}

/* ─────────────────────────────────────────────
   PRICE RESOLVER  (matches website data model)
   Fields: priceOriginal / priceDiscount
   Fallbacks: price, mrp, sellingPrice
   ───────────────────────────────────────────── */
function resolvePrices(item) {
    const orig     = parseFloat(item.priceOriginal || item.mrp          || item.originalPrice || 0);
    const discount = parseFloat(item.priceDiscount || item.sellingPrice || item.price         || 0);

    const hasDiscount = discount > 0 && discount < orig;
    const displayPrice = hasDiscount ? discount : (orig || discount);
    const pct = (hasDiscount && orig > 0) ? Math.round(((orig - discount) / orig) * 100) : 0;

    return { orig, displayPrice, hasDiscount, pct };
}

/* ─────────────────────────────────────────────
   CACHE HELPERS  (sessionStorage, 5-min TTL)
   ───────────────────────────────────────────── */
function cacheGet(cat) {
    try {
        const raw = sessionStorage.getItem(`jasa_v2_hcat_${cat}`);
        if (!raw) return null;
        const { ts, items } = JSON.parse(raw);
        if (Date.now() - ts > CACHE_TTL) { sessionStorage.removeItem(`jasa_v2_hcat_${cat}`); return null; }
        return items;
    } catch { return null; }
}

function cacheSet(cat, items) {
    try {
        sessionStorage.setItem(`jasa_v2_hcat_${cat}`, JSON.stringify({ ts: Date.now(), items }));
    } catch { /* quota full — skip */ }
}

/* ─────────────────────────────────────────────
   FETCH FROM CLOUDFLARE WORKER (KV cache)
   Primary source — fast, no Firestore quota.
   Firestore is only used if Worker fails.
   ───────────────────────────────────────────── */
async function fetchItems(cat) {
    /* 1. sessionStorage cache (5-min TTL) */
    const cached = cacheGet(cat);
    if (cached) return cached;

    /* 2. Cloudflare Worker — KV cache */
    let res;
    try {
        res = await fetch(`${WORKER_URL}/api/items?category=${cat}`, { cache: 'no-cache' });
    } catch (err) {
        console.error(`[home-categories] Worker fetch failed for ${cat}:`, err.message);
        res = null;
    }

    if (res && res.ok) {
        const json  = await res.json();
        const items = (json.items || []).slice(0, MAX_ITEMS);
        if (items.length) {
            cacheSet(cat, items);
            return items;
        }
        console.warn(`[home-categories] Worker returned 0 items for ${cat}`);
    } else if (res) {
        console.error(`[home-categories] Worker returned ${res.status} for ${cat}`);
    }

    /* 3. Firestore fallback */
    console.warn(`[home-categories] Falling back to Firestore for ${cat}`);
    try {
        const q    = query(collection(db, 'items'), where('category', '==', cat), limit(MAX_ITEMS));
        const snap = await getDocs(q);
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (items.length) cacheSet(cat, items);
        return items;
    } catch (err) {
        console.error(`[home-categories] Firestore fallback failed for ${cat}:`, err.message);
        return [];
    }
}

/* ─────────────────────────────────────────────
   CART HELPERS
   ───────────────────────────────────────────── */
function getCart() {
    try { return JSON.parse(localStorage.getItem('jasa_cart') || '[]'); } catch { return []; }
}
function saveCart(cart) {
    localStorage.setItem('jasa_cart', JSON.stringify(cart));
    window.dispatchEvent(new CustomEvent('cartUpdated', { detail: cart }));
}
function isInCart(id) { return getCart().some(i => i.id === id); }

window._hcatAddToCart = function(btn, id, name, price, imageUrl, category) {
    /* Auth check */
    if (!localStorage.getItem('jasa_user_cache')) {
        showToastV2('Please login to add items to cart.', 'warning');
        setTimeout(() => { window.location.href = 'login.html'; }, 1200);
        return;
    }

    const cart = getCart();
    const existing = cart.find(i => i.id === id);
    if (existing) {
        existing.qty = (existing.qty || 1) + 1;
    } else {
        cart.push({ id, name, price: parseFloat(price) || 0, imageUrl, category, qty: 1 });
    }
    saveCart(cart);

    /* Update all matching buttons across sections */
    document.querySelectorAll(`[data-hcat-id="${id}"]`).forEach(b => {
        b.innerHTML = '<i class="fa-solid fa-check"></i> Added';
        b.classList.add('hcat-btn-added');
        b.disabled = true;
    });

    showToastV2(`${name} added to cart!`, 'success');
};

/* ─────────────────────────────────────────────
   TOAST  (reuses existing xoToast if present,
   otherwise creates a temporary one)
   ───────────────────────────────────────────── */
let _toastTimer;
function showToastV2(msg, type = 'success') {
    let el = document.getElementById('xoToast') || document.getElementById('hcatToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'hcatToast';
        el.className = 'xo-toast';
        document.body.appendChild(el);
    }
    clearTimeout(_toastTimer);
    el.textContent = msg;
    el.className = `xo-toast ${type} show`;
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ─────────────────────────────────────────────
   CARD BUILDER
   ───────────────────────────────────────────── */
function buildCard(item, color, accent, cat) {
    const id    = item.id || item.itemId || '';
    const name  = (item.name || item.itemName || 'Product').trim();
    const imgSrc = resolveImage(item);
    const { orig, displayPrice, hasDiscount, pct } = resolvePrices(item);
    const inCart = isInCart(id);

    const safeId  = escAttr(id);
    const safeName = escAttr(name);
    const safeImg  = escAttr(imgSrc || '');

    /* Image area */
    let imgHtml;
    if (imgSrc) {
        imgHtml = `
            <img
                src="${escAttr(imgSrc)}"
                alt="${escHtml(name)}"
                class="hcat-card-img"
                loading="lazy"
                decoding="async"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
            <div class="hcat-card-img-fallback" style="display:none;background:${accent};color:${color};">
                <i class="fa-solid fa-box"></i>
            </div>`;
    } else {
        imgHtml = `
            <div class="hcat-card-img-fallback" style="background:${accent};color:${color};">
                <i class="fa-solid fa-box"></i>
            </div>`;
    }

    /* Subtitle — brand / author / type */
    const sub = (item.brands?.[0] || item.authors?.[0] || item.brand || item.type || '').trim();

    return `
    <a href="item-details.html?id=${encodeURIComponent(id)}"
       class="hcat-card"
       style="--hcat-accent:${accent};--hcat-color:${color};">
        <div class="hcat-card-img-wrap">
            ${imgHtml}
            ${pct > 0 ? `<span class="hcat-badge">${pct}% off</span>` : ''}
        </div>
        <div class="hcat-card-body">
            <div class="hcat-card-name">${escHtml(name)}</div>
            ${sub ? `<div class="hcat-card-sub">${escHtml(sub)}</div>` : ''}
            <div class="hcat-card-prices">
                <span class="hcat-card-price">₹${displayPrice.toFixed(0)}</span>
                ${hasDiscount ? `<span class="hcat-card-mrp">₹${orig.toFixed(0)}</span>` : ''}
            </div>
            <button
                class="hcat-add-btn${inCart ? ' hcat-btn-added' : ''}"
                data-hcat-id="${safeId}"
                ${inCart ? 'disabled' : ''}
                onclick="event.preventDefault();event.stopPropagation();
                    window._hcatAddToCart(this,'${safeId}','${safeName}',
                        '${displayPrice}','${safeImg}','${escAttr(cat)}')">
                ${inCart
                    ? '<i class="fa-solid fa-check"></i> Added'
                    : '<i class="fa-solid fa-cart-plus"></i> Add'}
            </button>
        </div>
    </a>`;
}

/* "View All" end card */
function buildViewAllCard(href, color) {
    return `
    <a href="${href}" class="hcat-card hcat-viewall-card" style="--hcat-color:${color};">
        <div class="hcat-viewall-inner">
            <div class="hcat-viewall-circle">
                <i class="fa-solid fa-arrow-right"></i>
            </div>
            <span class="hcat-viewall-label">View All</span>
        </div>
    </a>`;
}

/* ─────────────────────────────────────────────
   RENDER ONE SECTION
   ───────────────────────────────────────────── */
const CAT_LINKS = {
    stationary: 'categories.html?cat=stationary',
    books:      'categories.html?cat=books',
    electronic: 'categories.html?cat=electronic',
    posters:    'categories.html?cat=posters',
};

async function renderSection({ cat, trackId, color, accent }) {
    const track = document.getElementById(trackId);
    if (!track) return;

    /* Show skeleton while loading */
    track.innerHTML = Array(4).fill(
        `<div class="hcat-skeleton"></div>`
    ).join('');

    let items;
    try {
        items = await fetchItems(cat);
    } catch (e) {
        console.warn(`[hcat] fetch failed for ${cat}:`, e);
        items = [];
    }

    if (!items.length) {
        track.innerHTML = `
            <div class="hcat-empty">
                <i class="fa-solid fa-box-open"></i>
                <span>Coming soon</span>
            </div>`;
        return;
    }

    /* Shuffle and limit to 10 for variety */
    const display = [...items]
        .sort(() => Math.random() - 0.5)
        .slice(0, 10);

    track.innerHTML =
        display.map(item => buildCard(item, color, accent, cat)).join('') +
        buildViewAllCard(CAT_LINKS[cat] || 'categories.html', color);
}

/* ─────────────────────────────────────────────
   DRAG-SCROLL  (mouse + touch)
   ───────────────────────────────────────────── */
function initDragScroll(wrap) {
    let isDown = false, startX = 0, scrollLeft = 0;

    wrap.addEventListener('mousedown', e => {
        isDown     = true;
        startX     = e.pageX - wrap.offsetLeft;
        scrollLeft = wrap.scrollLeft;
        wrap.style.cursor = 'grabbing';
    });
    wrap.addEventListener('mouseleave', () => { isDown = false; wrap.style.cursor = ''; });
    wrap.addEventListener('mouseup',    () => { isDown = false; wrap.style.cursor = ''; });
    wrap.addEventListener('mousemove',  e => {
        if (!isDown) return;
        e.preventDefault();
        wrap.scrollLeft = scrollLeft - (e.pageX - wrap.offsetLeft - startX);
    });
}

/* ─────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────── */
function escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function escAttr(s) {
    return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

/* ─────────────────────────────────────────────
   INIT
   ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    /* Render all three sections in parallel, then signal search cache is ready */
    Promise.all(SECTIONS.map(s => renderSection(s))).then(() => {
        window.dispatchEvent(new CustomEvent('hcatLoaded'));
    });

    /* Refresh a row the moment an admin changes that category */
    watchCatalog(cat => {
        const section = SECTIONS.find(s => s.cat === cat);
        if (section) renderSection(section).then(() => window.dispatchEvent(new CustomEvent('hcatLoaded')));
    });

    /* Enable drag-scroll on each row */
    document.querySelectorAll('.hcat-scroll-wrap').forEach(initDragScroll);

    /* Re-check cart state when cart changes (e.g. after removing from cart page) */
    window.addEventListener('cartUpdated', () => {
        document.querySelectorAll('.hcat-add-btn').forEach(btn => {
            const id = btn.dataset.hcatId;
            if (!id) return;
            if (isInCart(id)) {
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Added';
                btn.classList.add('hcat-btn-added');
                btn.disabled = true;
            } else {
                btn.innerHTML = '<i class="fa-solid fa-cart-plus"></i> Add';
                btn.classList.remove('hcat-btn-added');
                btn.disabled = false;
            }
        });
    });
});
