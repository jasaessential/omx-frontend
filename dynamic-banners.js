/* ═══════════════════════════════════════════════
   DYNAMIC BANNERS & CATEGORY IMAGES
   Loads data from Firestore / Worker and populates:
     • #bannerTrack   — home page hero slider
     • #cat-img-*     — service section icon boxes
   Falls back gracefully if network / Firestore fails.
   ═══════════════════════════════════════════════ */
import { db }         from './firebase-init.js';
import { WORKER_URL } from './env-config.js';
import {
    collection, getDocs, doc, getDoc, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

/* ══════════════════════════════════════════════
   BANNERS
   ══════════════════════════════════════════════ */
async function loadHomeBanners() {
    const track = document.getElementById('bannerTrack');
    const dots  = document.getElementById('bannerDots');
    if (!track) return;

    let banners = [];

    // 1. Try fast worker edge-cache first
    try {
        const res = await fetch(`${WORKER_URL}/api/banners`);
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.banners) && data.banners.length > 0) {
                banners = data.banners;
                console.log(`[Banners] Loaded from worker (${data.source}):`, banners.length);
            }
        }
    } catch (_) {}

    // 2. Firestore fallback
    if (!banners.length) {
        try {
            const snap = await getDocs(
                query(collection(db, 'site_banners'), orderBy('order', 'asc'))
            );
            banners = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(b => b.active !== false);
            console.log('[Banners] Loaded from Firestore:', banners.length);
        } catch (_) {}
    }

    // No dynamic banners — keep static gradient slides as-is
    if (!banners.length) return;

    // Render image-based slides into bannerTrack
    track.innerHTML = banners.map(b => {
        const link   = b.link ? esc(b.link) : 'index.html';
        const imgUrl = b.imageUrl ? esc(b.imageUrl) : '';
        const text   = b.text ? esc(b.text) : '';
        const alt    = b.alt  ? esc(b.alt)  : (text || 'Banner');

        return `
        <div class="banner-slide banner-slide--img"
             data-gradient="linear-gradient(135deg,#0f2d80 0%,#1a55d4 55%,#3a9eff 100%)">
            <a href="${link}" class="banner-img-link" aria-label="${alt}">
                ${imgUrl
                    ? `<img src="${imgUrl}" alt="${alt}" class="banner-img-cover"
                            onerror="this.style.display='none'">`
                    : ''
                }
                ${text
                    ? `<div class="banner-img-caption"><span>${text}</span></div>`
                    : ''
                }
            </a>
        </div>`;
    }).join('');

    // Rebuild dots to match new slide count
    if (dots) {
        dots.innerHTML = banners.map((_, i) =>
            `<span class="dot${i === 0 ? ' active' : ''}" onclick="goToSlide(${i})"></span>`
        ).join('');
    }

    // Re-init slider so auto-play and swipe work with the new slides
    if (typeof window.initSlider === 'function') {
        window.initSlider();
    }
}

/* ══════════════════════════════════════════════
   CATEGORY IMAGES
   Reads site_config/category_images document.
   When an image URL exists for a key, it replaces
   the icon inside the matching service-icon-wrap
   element (#cat-img-xerox etc.) with an <img>.
   ══════════════════════════════════════════════ */

// Maps Firestore key → DOM element id
const CAT_MAP = {
    xerox:      'cat-img-xerox',
    stationary: 'cat-img-stationary',
    books:      'cat-img-books',
    electronic: 'cat-img-electronic',
    posters:    'cat-img-posters',
};

async function loadCategoryImages() {
    let config = null;

    // 1. Try worker
    try {
        const res = await fetch(`${WORKER_URL}/api/site-config`);
        if (res.ok) {
            const data = await res.json();
            if (data.config && Object.keys(data.config).length) {
                config = data.config;
                console.log(`[Categories] Loaded from worker (${data.source})`);
            }
        }
    } catch (_) {}

    // 2. Firestore fallback
    if (!config) {
        try {
            const snap = await getDoc(doc(db, 'site_config', 'category_images'));
            if (snap.exists()) {
                config = snap.data();
                console.log('[Categories] Loaded from Firestore');
            }
        } catch (_) {}
    }

    if (!config) return; // no custom images — keep icons

    Object.entries(CAT_MAP).forEach(([key, elId]) => {
        const url = config[key];
        const el  = document.getElementById(elId);
        if (!url || !el) return;

        // Replace fallback icon with image inside the new service-img-area
        const fallbackIcon = key === 'xerox' ? 'copy'
            : key === 'stationary' ? 'pen-ruler'
            : key === 'books'      ? 'book-open'
            : 'microchip';

        el.innerHTML = `
            <img src="${esc(url)}"
                 alt="${key}"
                 onerror="this.parentElement.innerHTML='<i class=\\'fa-solid fa-${fallbackIcon}\\'></i>'">`;
    });
}

/* ══════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════ */
function esc(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ══════════════════════════════════════════════
   INIT — run both in parallel, non-blocking
   ══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    Promise.all([loadHomeBanners(), loadCategoryImages()]).catch(() => {});
});
