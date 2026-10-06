/* ═══════════════════════════════════════════════
   JASA V2 — item-details.js
   Loads a single item by ?id= from Firestore:
     1. sessionStorage cache (1 hr TTL)
     2. items/{id} direct doc fetch
   Shows image gallery, info, description,
   product detail tags, related item sliders.
   Cart stored in localStorage key "jasa_cart"
   ═══════════════════════════════════════════════ */

import { db, auth } from './firebase-init.js';
import {
    doc, getDoc,
    collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { WORKER_URL } from './env-config.js';

/* ── Track auth state ── */
let currentUser = null;
onAuthStateChanged(auth, user => { currentUser = user; });

/* ════════════════════════════════
   STATE
   ════════════════════════════════ */
let item         = null;
let galleryIndex = 0;
let galleryTotal = 0;
let descExpanded = false;

/* ════════════════════════════════
   INIT
   ════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) { showError('No item ID provided.'); return; }

    updateCartBadge();

    try {
        item = await loadItem(id);
        if (!item) { showError('Item not found or unavailable.'); return; }
        render();
        loadRelated();
    } catch (e) {
        console.error('Item load error:', e);
        showError('Could not load item. Please try again.');
    }
});

/* ════════════════════════════════
   DATA
   ════════════════════════════════ */
async function loadItem(id) {
    /* 1. Try sessionStorage cache (item-level, 1hr TTL) */
    const CACHE_KEY = `jasa_v2_item_${id}`;
    try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        if (raw) {
            const { data, ts } = JSON.parse(raw);
            if (Date.now() - ts < 3600000 && data) return data;
        }
    } catch (_) {}

    /* 2. Try finding the item inside any already-cached category
          (sessionStorage keys: jasa_v2_cat_{cat}) — zero DB reads */
    const CATEGORIES = ['stationary', 'books', 'electronic', 'posters'];
    for (const cat of CATEGORIES) {
        try {
            const raw = sessionStorage.getItem(`jasa_v2_cat_${cat}`);
            if (!raw) continue;
            const { data, ts } = JSON.parse(raw);
            if (Date.now() - ts > 3600000) continue; // stale
            const found = Array.isArray(data) ? data.find(it => it.id === id) : null;
            if (found) {
                try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data: found, ts: Date.now() })); } catch (_) {}
                return found;
            }
        } catch (_) {}
    }

    /* 3. Try Cloudflare Worker category cache — fetches all items for the
          item's category, which also populates the category sessionStorage
          cache for future use */
    for (const cat of CATEGORIES) {
        try {
            const res = await fetch(`${WORKER_URL}/api/items?category=${cat}`, {
                cache: 'no-cache', signal: AbortSignal.timeout(3000)
            });
            if (!res.ok) continue;
            const json = await res.json();
            const items = json.items || json.data || [];
            if (!items.length) continue;
            /* Cache the full category */
            try { sessionStorage.setItem(`jasa_v2_cat_${cat}`, JSON.stringify({ data: items, ts: Date.now() })); } catch (_) {}
            const found = items.find(it => it.id === id);
            if (found) {
                try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data: found, ts: Date.now() })); } catch (_) {}
                return found;
            }
        } catch (_) {}
    }

    /* 4. Direct Firestore doc fetch (last resort) */
    const snap = await getDoc(doc(db, 'items', id));
    if (!snap.exists()) return null;
    const data = { id: snap.id, ...snap.data() };

    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch (_) {}
    return data;
}

async function loadCategoryItems(cat) {
    const CACHE_KEY = `jasa_v2_cat_${cat}`;
    try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        if (raw) {
            const { data, ts } = JSON.parse(raw);
            if (Date.now() - ts < 3600000 && Array.isArray(data) && data.length) return data;
        }
    } catch (_) {}

    /* 1. Cloudflare Worker edge cache */
    try {
        const res = await fetch(`${WORKER_URL}/api/items?category=${cat}`, {
            cache: 'no-cache', signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
            const json = await res.json();
            const data = json.items || json.data || [];
            if (data.length) {
                try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch (_) {}
                return data;
            }
        }
    } catch (_) {}

    /* 2. Firestore categoryData batch doc */
    try {
        const snap = await getDoc(doc(db, 'categoryData', cat));
        if (snap.exists()) {
            const data = snap.data().items || [];
            if (data.length) {
                try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch (_) {}
                return data;
            }
        }
    } catch (_) {}

    /* 3. Fallback: items collection query */
    const q    = query(collection(db, 'items'), where('category', '==', cat));
    const snap = await getDocs(q);
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch (_) {}
    return data;
}

/* ════════════════════════════════
   RENDER
   ════════════════════════════════ */
function render() {
    document.getElementById('skeleton').style.display = 'none';
    document.getElementById('mainContent').style.display = 'block';

    /* Header title */
    document.getElementById('headerTitle').textContent = item.name;
    document.title = `${item.name} — JASA Essential`;

    /* Subtitle */
    const sub = item.brands?.[0] || item.authors?.[0]
        || item.categories?.[0] || item.types?.[0]
        || item.type || '';
    document.getElementById('productName').textContent = item.name;
    document.getElementById('productSub').textContent  = sub;
    document.getElementById('productSub').style.display = sub ? '' : 'none';

    /* Per-size pricing (wall posters): default to the first priced size */
    const sizes = Object.keys(item.sizePrices || {});
    selectedSize = sizes.length ? ((item.types || []).find(t => item.sizePrices[t]) || sizes[0]) : '';
    updatePrice();

    /* Gallery */
    buildGallery(item.images || []);

    /* Description */
    const desc = item.description || 'No description provided.';
    const descEl   = document.getElementById('productDesc');
    const toggleEl = document.getElementById('descToggle');
    descEl.textContent = desc;
    descEl.classList.add('clamped');
    /* Check if clamping kicks in */
    requestAnimationFrame(() => {
        if (descEl.scrollHeight > descEl.clientHeight + 4) {
            toggleEl.style.display = 'flex';
        }
    });

    /* Tags / product details */
    buildTags();

    /* Cart buttons */
    document.getElementById('btnAddCart').onclick  = () => addToCart(currentCartData());
    document.getElementById('btnBuyNow').onclick   = () => addAndGo(currentCartData());
}

/* ── Price for the selected size (or the item's own price) ── */
let selectedSize = '';
function currentPricing() {
    const sp = selectedSize && item.sizePrices?.[selectedSize];
    const o  = (sp ? sp.priceOriginal : item.priceOriginal) || 0;
    const d  = (sp ? sp.priceDiscount : item.priceDiscount) || 0;
    const hasDisc = d > 0 && d < o;
    return { o, price: hasDisc ? d : o, hasDisc,
             disc: hasDisc ? Math.round(((o - d) / o) * 100) : 0 };
}

function updatePrice() {
    const { o, price, hasDisc, disc } = currentPricing();
    document.getElementById('productPrice').textContent = `₹${price.toLocaleString('en-IN')}`;
    const origEl = document.getElementById('productPriceOrig');
    const discEl = document.getElementById('productPriceDisc');
    origEl.textContent  = `₹${o.toLocaleString('en-IN')}`;
    discEl.textContent  = `${disc}% OFF`;
    origEl.style.display = discEl.style.display = hasDisc ? '' : 'none';
}

function currentCartData() {
    const { o, price, disc } = currentPricing();
    return { id: selectedSize ? `${item.id}__${selectedSize}` : item.id,
             baseId: item.id, size: selectedSize || undefined,
             name: selectedSize ? `${item.name} (${selectedSize})` : item.name,
             price, originalPrice: o, discountPercent: disc,
             img: getPrimaryImg(), category: item.category };
}

window.selectSize = function (size) {
    selectedSize = size;
    updatePrice();
    buildTags();
};

/* ── Gallery ── */
function buildGallery(images) {
    const gallery = document.getElementById('gallery');
    const dotsEl  = document.getElementById('galleryDots');

    if (!images.length) {
        gallery.innerHTML = `
        <div class="id-gallery-track" id="galleryTrack">
            <div class="id-gallery-slide">
                <i class="fa-solid fa-image id-no-img"></i>
            </div>
        </div>`;
        dotsEl.style.display = 'none';
        return;
    }

    galleryTotal = images.length;
    galleryIndex = 0;

    /* Sort: primary image first */
    const sorted = [...images].sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));

    const track = document.createElement('div');
    track.className = 'id-gallery-track';
    track.id = 'galleryTrack';

    sorted.forEach(img => {
        const slide = document.createElement('div');
        slide.className = 'id-gallery-slide';
        const el = document.createElement('img');
        el.src = img.url;
        el.alt = item.name;
        el.loading = 'lazy';
        slide.appendChild(el);
        track.appendChild(slide);
    });

    gallery.innerHTML = '';
    gallery.appendChild(track);

    /* Arrows (only if multiple images) */
    if (galleryTotal > 1) {
        const prev = document.createElement('button');
        prev.className = 'id-gallery-arrow prev';
        prev.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
        prev.onclick = () => slideGallery(-1);

        const next = document.createElement('button');
        next.className = 'id-gallery-arrow next';
        next.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
        next.onclick = () => slideGallery(1);

        gallery.appendChild(prev);
        gallery.appendChild(next);

        /* Dots */
        dotsEl.innerHTML = sorted.map((_, i) =>
            `<span class="id-dot ${i === 0 ? 'active' : ''}" onclick="goToSlide(${i})"></span>`
        ).join('');

        /* Touch / swipe */
        let tx = 0;
        gallery.addEventListener('touchstart', e => { tx = e.changedTouches[0].clientX; }, { passive: true });
        gallery.addEventListener('touchend', e => {
            const dx = tx - e.changedTouches[0].clientX;
            if (Math.abs(dx) > 40) slideGallery(dx > 0 ? 1 : -1);
        }, { passive: true });
    } else {
        dotsEl.style.display = 'none';
    }
}

window.slideGallery = function (dir) {
    galleryIndex = ((galleryIndex + dir) + galleryTotal) % galleryTotal;
    updateGallery();
};
window.goToSlide = function (idx) {
    galleryIndex = idx;
    updateGallery();
};
function updateGallery() {
    const track = document.getElementById('galleryTrack');
    if (track) track.style.transform = `translateX(-${galleryIndex * 100}%)`;
    document.querySelectorAll('.id-dot').forEach((d, i) =>
        d.classList.toggle('active', i === galleryIndex)
    );
}

function getPrimaryImg() {
    const imgs = item.images || [];
    return imgs.find(i => i.isPrimary)?.url || imgs[0]?.url || '';
}

/* ── Tags ── */
function buildTags() {
    const tags  = [];
    const cat   = item.category;

    if (cat) tags.push({ icon: 'fa-solid fa-tag', text: cat });

    (item.brands    || []).forEach(v => tags.push({ icon: 'fa-solid fa-award',        text: v }));
    (item.authors   || []).forEach(v => tags.push({ icon: 'fa-solid fa-pen-nib',      text: v }));
    (item.categories|| []).forEach(v => tags.push({ icon: 'fa-solid fa-bookmark',     text: v }));
    (item.types     || []).forEach(v => tags.push({ icon: 'fa-solid fa-layer-group',  text: v,
        size: item.sizePrices?.[v] ? v : '' }));
    if (item.type)         tags.push({ icon: 'fa-solid fa-layer-group', text: item.type });

    if (!tags.length) return;

    const section = document.getElementById('detailsSection');
    const wrap    = document.getElementById('productTags');
    section.style.display = '';
    wrap.innerHTML = tags.map(t => t.size
        ? `<button type="button" class="id-tag id-tag-size${t.size === selectedSize ? ' active' : ''}" onclick="selectSize('${esc(t.size)}')"><i class="${t.icon}"></i>${t.text}</button>`
        : `<span class="id-tag"><i class="${t.icon}"></i>${t.text}</span>`
    ).join('');
}

/* ── Description toggle ── */
window.toggleDesc = function () {
    const el  = document.getElementById('productDesc');
    const btn = document.getElementById('descToggle');
    descExpanded = !descExpanded;
    if (descExpanded) {
        el.classList.remove('clamped');
        btn.innerHTML = 'Show Less <i class="fa-solid fa-chevron-up"></i>';
    } else {
        el.classList.add('clamped');
        btn.innerHTML = 'View More <i class="fa-solid fa-chevron-down"></i>';
    }
};

/* ════════════════════════════════
   RELATED ITEMS
   ════════════════════════════════ */
async function loadRelated() {
    const container = document.getElementById('relatedContainer');
    if (!item) return;

    const cat   = item.category;
    let catItems;
    try { catItems = await loadCategoryItems(cat); } catch (e) {
        console.warn('Related load failed:', e); return;
    }

    /* Build sections: by brand/author, then by type, then whole category */
    const sections = [];

    const brand = item.brands?.[0] || item.authors?.[0];
    const brandField = cat === 'books' ? 'authors' : 'brands';
    if (brand) {
        const filtered = catItems.filter(i =>
            i.id !== item.id &&
            [].concat(i[brandField] || []).some(v => v === brand)
        ).slice(0, 12);
        if (filtered.length) sections.push({ title: `More from ${brand}`, items: filtered });
    }

    const type = item.types?.[0] || item.type || item.categories?.[0];
    if (type) {
        const filtered = catItems.filter(i => {
            if (i.id === item.id) return false;
            const vals = [].concat(i.types || [], i.categories || [], i.type ? [i.type] : []);
            return vals.some(v => v === type);
        }).slice(0, 12);
        if (filtered.length) sections.push({ title: `More in ${type}`, items: filtered });
    }

    /* Always add category catch-all (exclude already shown) */
    const shownIds = new Set(sections.flatMap(s => s.items.map(i => i.id)));
    shownIds.add(item.id);
    const rest = catItems.filter(i => !shownIds.has(i.id)).slice(0, 12);
    if (rest.length) {
        const label = { stationary: 'Stationary', books: 'Books', electronic: 'Kits', posters: 'Wall Posters' }[cat] || cat;
        sections.push({ title: `More ${label}`, items: rest });
    }

    container.innerHTML = sections.map((sec, idx) =>
        `<div class="id-related-section" id="relSec${idx}">
            <div class="id-related-title">${sec.title}</div>
            <div class="id-related-scroll" id="relScroll${idx}">
                ${sec.items.map(p => buildRelCard(p)).join('')}
            </div>
        </div>`
    ).join('');

    /* Attach drag-scroll to each row */
    sections.forEach((_, idx) => initDragScroll(`relScroll${idx}`));
}

function buildRelCard(p) {
    const o       = p.priceOriginal || 0;
    const d       = p.priceDiscount || 0;
    const hasDisc = d > 0 && d < o;
    const price   = hasDisc ? d : o;
    const disc    = hasDisc ? Math.round(((o - d) / o) * 100) : 0;
    const img     = p.images?.find(i => i.isPrimary)?.url || p.images?.[0]?.url || '';
    const imgHtml = img
        ? `<img src="${img}" alt="${esc(p.name)}" loading="lazy">`
        : `<i class="fa-solid fa-box id-rel-no-img"></i>`;
    const cat = p.category || item.category;

    return `
    <a href="item-details.html?id=${p.id}" class="id-rel-card">
        <div class="id-rel-img">${imgHtml}</div>
        <div class="id-rel-body">
            <div class="id-rel-name">${p.name}</div>
            <div style="display:flex;align-items:baseline;gap:4px;margin-top:4px;flex-wrap:wrap;">
                <span class="id-rel-price">₹${price.toLocaleString('en-IN')}</span>
                ${hasDisc ? `<span class="id-rel-price-orig">₹${o.toLocaleString('en-IN')}</span>` : ''}
                ${disc > 0 ? `<span class="id-rel-disc">${disc}%</span>` : ''}
            </div>
        </div>
        <div class="id-rel-actions">
            <button class="id-rel-buy"
                onclick="event.preventDefault();event.stopPropagation();addAndGo({id:'${p.id}',name:'${esc(p.name)}',price:${price},originalPrice:${o},discountPercent:${disc},img:'${esc(img)}',category:'${cat}'})">
                <i class="fa-solid fa-bag-shopping"></i> Buy
            </button>
            <button class="id-rel-cart"
                onclick="event.preventDefault();event.stopPropagation();addToCart({id:'${p.id}',name:'${esc(p.name)}',price:${price},originalPrice:${o},discountPercent:${disc},img:'${esc(img)}',category:'${cat}'})">
                <i class="fa-solid fa-cart-shopping"></i>
            </button>
        </div>
    </a>`;
}

function initDragScroll(id) {
    const el = document.getElementById(id);
    if (!el) return;
    let isDown = false, startX, scrollLeft;
    el.addEventListener('mousedown', e => {
        isDown = true; startX = e.pageX - el.offsetLeft; scrollLeft = el.scrollLeft;
    });
    el.addEventListener('mouseleave', () => { isDown = false; });
    el.addEventListener('mouseup',    () => { isDown = false; });
    el.addEventListener('mousemove',  e => {
        if (!isDown) return;
        e.preventDefault();
        el.scrollLeft = scrollLeft - (e.pageX - el.offsetLeft - startX);
    });
}

/* ════════════════════════════════
   CART
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
    const badge = document.getElementById('cartBadge');
    if (badge) {
        badge.textContent  = total;
        badge.style.display = total > 0 ? 'flex' : 'none';
    }
}

window.addToCart = function (cartItem) {
    if (!currentUser) {
        showToast('Please sign in to add items to cart.', 'error');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }
    const cart     = getCart();
    const existing = cart.find(i => i.id === cartItem.id);
    if (existing) { existing.qty += 1; }
    else          { cart.push({ ...cartItem, qty: 1 }); }
    saveCart(cart);
    showToast(`${cartItem.name} added to cart!`, 'success');
};

window.addAndGo = function (cartItem) {
    if (!currentUser) {
        showToast('Please sign in to continue.', 'error');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }
    const cart     = getCart();
    const existing = cart.find(i => i.id === cartItem.id);
    if (existing) { existing.qty += 1; }
    else          { cart.push({ ...cartItem, qty: 1 }); }
    saveCart(cart);
    window.location.href = 'cart.html';
};

/* ════════════════════════════════
   HELPERS
   ════════════════════════════════ */
function esc(s) {
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;');
}

let toastTimer = null;
function showToast(msg, type = 'success') {
    const el = document.getElementById('idToast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.className   = `id-toast ${type}`;
    el.classList.add('show');
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function showError(msg) {
    document.getElementById('skeleton').style.display = 'none';
    document.getElementById('mainContent').style.display = 'none';
    document.body.insertAdjacentHTML('beforeend', `
    <div style="padding: calc(var(--hh) + 40px) 20px 20px; text-align:center;">
        <i class="fa-solid fa-circle-exclamation" style="font-size:3rem;color:#ef4444;margin-bottom:14px;"></i>
        <h2 style="font-size:1rem;font-weight:800;color:var(--txt1);margin-bottom:8px;">Oops!</h2>
        <p style="font-size:.84rem;font-weight:600;color:var(--txt3);margin-bottom:20px;">${msg}</p>
        <a href="categories.html"
           style="display:inline-flex;align-items:center;gap:6px;padding:10px 22px;background:var(--primary);color:#fff;border-radius:50px;font-size:.82rem;font-weight:800;text-decoration:none;">
            <i class="fa-solid fa-arrow-left"></i> Back to Shop
        </a>
    </div>`);
}

/* Sync badge from other tabs */
window.addEventListener('storage', e => {
    if (e.key === CART_KEY) updateCartBadge();
});
