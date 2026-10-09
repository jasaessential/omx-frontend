/* ═══════════════════════════════════════════════
   JASA ESSENTIAL — Core App JS
   ═══════════════════════════════════════════════ */

/* ── Theme ── */
const THEME_KEY = 'jasa_theme';

function getStoredTheme() {
    return localStorage.getItem(THEME_KEY) || 'light';
}

function getEffectiveTheme(mode) {
    if (mode === 'device') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return mode;
}

function applyTheme(mode) {
    const effective = getEffectiveTheme(mode);
    document.documentElement.setAttribute('data-theme', effective);
    localStorage.setItem(THEME_KEY, mode);
}

function toggleTheme() {
    const current = getStoredTheme();
    const next = current === 'dark' ? 'light' : current === 'light' ? 'device' : 'dark';
    applyTheme(next);
}

/* ── Theme Picker Popup ── */
function openThemePicker(triggerEl) {
    const existing = document.getElementById('themePickerOverlay');
    if (existing) { existing.remove(); return; }

    const current = getStoredTheme();
    const overlay = document.createElement('div');
    overlay.id = 'themePickerOverlay';
    overlay.className = 'theme-picker-overlay';
    overlay.innerHTML = `
        <div class="theme-picker-card" id="themePickerCard">
            <div class="theme-picker-title">Appearance</div>
            <div class="theme-picker-options">
                <button class="theme-option ${current==='light'?'active':''}" onclick="setThemeMode('light')">
                    <div class="theme-option-icon"><i class="fa-solid fa-sun"></i></div>
                    <span>Light</span>
                </button>
                <button class="theme-option ${current==='dark'?'active':''}" onclick="setThemeMode('dark')">
                    <div class="theme-option-icon"><i class="fa-solid fa-moon"></i></div>
                    <span>Dark</span>
                </button>
                <button class="theme-option ${current==='device'?'active':''}" onclick="setThemeMode('device')">
                    <div class="theme-option-icon"><i class="fa-solid fa-display"></i></div>
                    <span>Device</span>
                </button>
            </div>
        </div>`;

    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);

    // Position card near the trigger button
    const card = document.getElementById('themePickerCard');
    const btn  = triggerEl instanceof Element ? triggerEl
                 : (typeof triggerEl === 'object' && triggerEl?.target) ? triggerEl.target.closest('button') ?? triggerEl.target
                 : null;

    if (btn && card) {
        const r        = btn.getBoundingClientRect();
        const cardW    = 220;
        const cardH    = 150; // approx
        const margin   = 8;

        let top  = r.top - cardH - margin;
        let left = r.left;

        // Flip below if not enough space above
        if (top < margin) top = r.bottom + margin;
        // Keep within viewport horizontally
        if (left + cardW > window.innerWidth - margin) left = window.innerWidth - cardW - margin;
        if (left < margin) left = margin;

        card.style.top  = top  + 'px';
        card.style.left = left + 'px';
    } else {
        // Fallback: centre of screen
        card.style.top  = '50%';
        card.style.left = '50%';
        card.style.transform = 'translate(-50%,-50%)';
    }

    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function setThemeMode(mode) {
    applyTheme(mode);
    // Update active state in picker
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick') === `setThemeMode('${mode}')`);
    });
    // Close after short delay
    setTimeout(() => {
        const ov = document.getElementById('themePickerOverlay');
        if (ov) ov.remove();
    }, 400);
}

/* ── Logout Confirmation Popup Card ── */
function logoutUser() {
    openLogoutConfirm();
}

function openLogoutConfirm() {
    const existing = document.getElementById('logoutConfirmOverlay');
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement('div');
    overlay.id = 'logoutConfirmOverlay';
    overlay.className = 'logout-confirm-overlay';
    overlay.innerHTML = `
        <div class="logout-confirm-card" id="logoutConfirmCard">
            <div class="logout-confirm-icon">
                <i class="fa-solid fa-right-from-bracket"></i>
            </div>
            <div class="logout-confirm-title">Sign Out?</div>
            <div class="logout-confirm-desc">Are you sure you want to log out of your account?</div>
            <div class="logout-confirm-actions">
                <button class="logout-btn-cancel" onclick="closeLogoutConfirm()">Cancel</button>
                <button class="logout-btn-confirm" onclick="confirmLogout()">Logout</button>
            </div>
        </div>`;

    overlay.addEventListener('click', e => {
        if (e.target === overlay) closeLogoutConfirm();
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function closeLogoutConfirm() {
    const ov = document.getElementById('logoutConfirmOverlay');
    if (ov) {
        ov.classList.remove('visible');
        setTimeout(() => ov.remove(), 250);
    }
}

async function confirmLogout() {
    closeLogoutConfirm();
    if (typeof closeSidebar === 'function') closeSidebar();

    try {
        const { signOut } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
        const { auth }    = await import('./firebase-init.js');
        await signOut(auth);
    } catch(e) {
        console.warn('Firebase signOut error:', e);
    }
    localStorage.removeItem('jasa_user_cache');
    window.location.href = 'login.html';
}

/* ── Sidebar ── */
function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('active');
    document.body.style.overflow = '';
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });

/* ── Sidebar auth rendering ── */
function renderSidebarAuth() {
    const identityEl = document.getElementById('sbIdentity');
    const navEl      = document.getElementById('sbNav');
    if (!identityEl || !navEl) return;

    const raw = localStorage.getItem('jasa_user_cache');
    const user = raw ? (() => { try { return JSON.parse(raw); } catch(_){ return null; } })() : null;

    const page = p => `${p}`;

    // ── Access box builder ──
    const box = (title, items) => `
        <div class="access-section">
            <div class="access-section-header">${title}</div>
            ${items.map(it => `
                <a href="${it.link}" class="access-link ${it.active ? 'active' : ''}">
                    <i class="${it.icon}"></i><span>${it.text}</span>
                </a>`).join('')}
        </div>`;

    const cur = window.location.pathname.split('/').pop();

    const shopLinks = [
        { text:'Home',          icon:'fa-solid fa-house',           link:'index.html'              },
        { text:'Order My Xerox',icon:'fa-solid fa-print',           link:'xerox-order.html'        },
        { text:'Stationary',    icon:'fa-solid fa-pen-ruler',       link:'categories.html?cat=stationary' },
        { text:'Books',         icon:'fa-solid fa-book-open',       link:'categories.html?cat=books'      },
        { text:'Kits',          icon:'fa-solid fa-microchip',       link:'categories.html?cat=electronic' },
        { text:'Wall Posters',  icon:'fa-solid fa-image',           link:'categories.html?cat=posters'    },
    ].map(it => ({ ...it, active: cur === it.link.split('?')[0] }));

    const accountLinks = [
        { text:'My Orders',        icon:'fa-solid fa-box',             link:'orders.html'          },
        { text:'My Wallet',        icon:'fa-solid fa-wallet',          link:'wallet.html'          },
        { text:'Refer a Friend',   icon:'fa-solid fa-user-plus',       link:'refer.html'           },
        { text:'Cart',             icon:'fa-solid fa-cart-shopping',   link:'cart.html'            },
        { text:'Request Product',  icon:'fa-solid fa-box-open',        link:'product-request.html' },
        { text:'Profile',          icon:'fa-solid fa-user-gear',       link:'profile.html'         },
        { text:'Settings',         icon:'fa-solid fa-gear',            link:'settings.html'        },
        { text:'Support',          icon:'fa-solid fa-headset',         link:'support.html'         },
        { text:'Privacy Policy',   icon:'fa-solid fa-shield-halved',   link:'privacy.html'         },
        { text:'Terms & Conditions', icon:'fa-solid fa-file-contract', link:'terms.html'           },
    ].map(it => ({ ...it, active: cur === it.link }));

    if (user && user.uid) {
        // Identity hero card — injected into the nav scroll area
        const name      = user.fullName  || 'User';
        const email     = user.email     || '';
        const displayId = user.userId    || (user.uid ? user.uid.substring(0, 8).toUpperCase() : '');
        const roles     = user.roles     || [user.role || 'user'];
        identityEl.innerHTML = ''; // clear — card goes into nav

        // ── Role-based extra sections ──
        // Each role gets its own card, appended after the main Shop/Account card.
        const roleCards = [];

        // Admin section
        if (roles.includes('admin')) {
            const adminLinks = [
                { text: 'Admin Orders',      icon: 'fa-solid fa-clipboard-list',  link: 'admin-orders.html'           },
                { text: 'Manage Items',      icon: 'fa-solid fa-boxes-stacked',   link: 'manage-items.html'           },
                { text: 'Poster Setup',      icon: 'fa-solid fa-image',           link: 'manage-posters.html'         },
                { text: 'Manage Users',      icon: 'fa-solid fa-users-gear',      link: 'manage-users.html'           },
                { text: 'Manage Shops',      icon: 'fa-solid fa-store',           link: 'manage-shops.html'           },
                { text: 'Product Requests',  icon: 'fa-solid fa-box-open',        link: 'admin-product-requests.html' },
                { text: 'Support Queries',   icon: 'fa-solid fa-headset',         link: 'admin-support.html'          },
                { text: 'Marketing',         icon: 'fa-solid fa-bullhorn',        link: 'admin-marketing.html'        },
                { text: 'Banner Manager',    icon: 'fa-solid fa-images',          link: 'admin-banners.html'          },
                { text: 'Coupons',           icon: 'fa-solid fa-ticket',          link: 'admin-coupons.html'          },
                { text: 'Wallet Settings',   icon: 'fa-solid fa-wallet',          link: 'admin-wallet.html'           },
                { text: 'Referrals',         icon: 'fa-solid fa-user-plus',       link: 'admin-referrals.html'        },
                { text: 'Xerox Setup',       icon: 'fa-solid fa-gears',           link: 'manage-xerox.html'           },
                { text: 'Payment Config',   icon: 'fa-solid fa-credit-card',     link: 'payment-config.html'         },
                { text: 'Cache Control',     icon: 'fa-solid fa-database',        link: 'admin-cache.html'            },
                { text: 'Cloud Services',    icon: 'fa-solid fa-cloud',           link: 'admin-cloud.html'            },
            ].map(it => ({ ...it, active: cur === it.link }));
            roleCards.push(`
                <div class="access-box">
                    ${box('Admin Access', adminLinks)}
                </div>`);
        }

        // Seller section — builds one link per shop using userShops[]
        if (roles.includes('seller')) {
            const ownerShops = (user.userShops || []).filter(s => s.role === 'owner' || !s.role);
            const sellerShopLinks = ownerShops.length > 0
                ? ownerShops.map(shop => ({
                    text: shop.name || 'My Shop',
                    icon: 'fa-solid fa-store',
                    link: `seller-orders.html?shopId=${encodeURIComponent(shop.shopId)}`,
                    active: cur === 'seller-orders.html',
                  }))
                : [{ text: 'My Shop Orders', icon: 'fa-solid fa-store', link: 'seller-orders.html', active: cur === 'seller-orders.html' }];
            const sellerLinks = [
                ...sellerShopLinks,
            ];
            roleCards.push(`
                <div class="access-box">
                    ${box('Seller Access', sellerLinks)}
                </div>`);
        }

        // Employee section — shows only permitted links
        if (roles.includes('employee')) {
            const empLinks = [
                { text: 'Delivery Orders', icon: 'fa-solid fa-motorcycle', link: 'employee-orders.html' },
            ];
            if (roles.includes('manage_items'))     empLinks.push({ text: 'Manage Items',     icon: 'fa-solid fa-boxes-stacked', link: 'manage-items.html'           });
            if (roles.includes('manage_items'))     empLinks.push({ text: 'Poster Setup',     icon: 'fa-solid fa-image',         link: 'manage-posters.html'         });
            if (roles.includes('manage_marketing')) empLinks.push({ text: 'Marketing',        icon: 'fa-solid fa-bullhorn',      link: 'admin-marketing.html'        });
            if (roles.includes('manage_support'))   empLinks.push({ text: 'Support Queries',  icon: 'fa-solid fa-headset',       link: 'admin-support.html'          });
            if (roles.includes('manage_requests'))  empLinks.push({ text: 'Product Requests', icon: 'fa-solid fa-box-open',      link: 'admin-product-requests.html' });
            if (roles.includes('manage_banners'))   empLinks.push({ text: 'Banner Manager',   icon: 'fa-solid fa-images',        link: 'admin-banners.html'          });
            if (roles.includes('manage_coupons'))   empLinks.push({ text: 'Coupons',          icon: 'fa-solid fa-ticket',        link: 'admin-coupons.html'          });
            if (roles.includes('manage_xerox'))     empLinks.push({ text: 'Xerox Setup',      icon: 'fa-solid fa-gears',         link: 'manage-xerox.html'           });
            if (roles.includes('manage_cache'))     empLinks.push({ text: 'Cache Control',    icon: 'fa-solid fa-database',      link: 'admin-cache.html'            });
            const mappedEmpLinks = empLinks.map(it => ({ ...it, active: cur === it.link }));
            roleCards.push(`
                <div class="access-box">
                    ${box('Employee Access', mappedEmpLinks)}
                </div>`);
        }

        navEl.innerHTML = `
            <div class="sb-identity">
                <div class="sb-identity-avatar"><i class="fa-solid fa-user"></i></div>
                <div class="sb-identity-info">
                    <div class="sb-identity-name">${name}</div>
                    <div class="sb-identity-email">${email}</div>
                    ${displayId ? `
                        <div class="sb-identity-id" onclick="copyUserId('${displayId}', this)" title="Click to copy ID">
                            <span>ID: ${displayId}</span>
                            <i class="fa-regular fa-clipboard"></i>
                        </div>` : ''}
                </div>
            </div>
            <div class="sb-action-row">
                <button class="sb-action-btn sb-action-btn--mode" onclick="openThemePicker(this)">
                    <i class="fa-solid fa-circle-half-stroke"></i> Mode
                </button>
                <button class="sb-action-btn sb-action-btn--logout" onclick="logoutUser()">
                    <i class="fa-solid fa-right-from-bracket"></i> Logout
                </button>
            </div>
            <div class="access-box">
                ${box('Shop', shopLinks)}
                <div class="access-box-divider"></div>
                ${box('Account', accountLinks)}
            </div>
            ${roleCards.join('')}`;
    } else {
        // Guest card — also inside nav scroll area
        identityEl.innerHTML = '';
        navEl.innerHTML = `
            <div class="sb-guest">
                <div class="sb-guest-text">Sign in to access your orders, cart and more.</div>
                <a href="login.html" class="sb-login-btn"><i class="fa-regular fa-user" style="margin-right:6px;"></i>Login / Register</a>
            </div>
            <div class="sb-action-row">
                <button class="sb-action-btn sb-action-btn--mode" onclick="openThemePicker(this)">
                    <i class="fa-solid fa-circle-half-stroke"></i> Mode
                </button>
            </div>
            <div class="access-box">
                ${box('Shop', shopLinks)}
                <div class="access-box-divider"></div>
                ${box('Account', accountLinks)}
            </div>`;
    }
}

// Re-render sidebar when auth state changes (called from auth-header.js)
window.refreshSidebarAuth = renderSidebarAuth;

/* ════════════════════════════════
   BANNER SLIDER
   ════════════════════════════════ */
let currentSlide  = 0;
let totalSlides   = 0;
let sliderTimer   = null;
let isAnimating   = false;
const SLIDE_MS    = 4000;

function initSlider() {
    const track  = document.getElementById('bannerTrack');
    const section = document.querySelector('.banner-section');
    if (!track || !section) return;

    const slides = track.querySelectorAll('.banner-slide');
    totalSlides  = slides.length;
    if (totalSlides === 0) return;

    currentSlide = 0;
    track.style.transform = `translateX(0%)`;

    /* set initial background from first slide's data-gradient */
    setBackground(section, slides[0]);

    /* trigger enter animation on first slide */
    triggerEnterAnim(slides[0]);

    startSlider();
    initSwipe(section);
}
window.initSlider = initSlider;

function goToSlide(index) {
    if (isAnimating) return;

    const track   = document.getElementById('bannerTrack');
    const section = document.querySelector('.banner-section');
    const dots    = document.querySelectorAll('.dot');
    if (!track) return;

    const slides = track.querySelectorAll('.banner-slide');
    const n      = slides.length;
    const next   = ((index % n) + n) % n;   // wrap around

    if (next === currentSlide) return;

    isAnimating = true;

    /* update dot */
    dots[currentSlide]?.classList.remove('active');
    dots[next]?.classList.add('active');

    /* slide the track */
    track.style.transform = `translateX(-${next * 100}%)`;

    /* update background colour */
    setBackground(section, slides[next]);

    currentSlide = next;

    /* content enter animation */
    setTimeout(() => {
        triggerEnterAnim(slides[next]);
        isAnimating = false;
    }, 350);

    /* restart auto-play timer */
    restartTimer();
}

function setBackground(section, slide) {
    const grad = slide?.dataset?.gradient || 'linear-gradient(135deg,#0f2d80,#2D8CF0)';
    section.style.background = grad;
}

function triggerEnterAnim(slide) {
    if (!slide) return;
    /* remove then re-add class to replay animation */
    slide.classList.remove('is-entering');
    void slide.offsetWidth; /* reflow */
    slide.classList.add('is-entering');
}

function nextSlide()  { goToSlide(currentSlide + 1); }
function prevSlide()  { goToSlide(currentSlide - 1); }

function startSlider()   { stopSlider(); sliderTimer = setInterval(nextSlide, SLIDE_MS); }
function stopSlider()    { if (sliderTimer) { clearInterval(sliderTimer); sliderTimer = null; } }
function restartTimer()  { startSlider(); }

/* touch/swipe */
function initSwipe(el) {
    let sx = 0, sy = 0;
    el.addEventListener('touchstart', e => {
        sx = e.changedTouches[0].clientX;
        sy = e.changedTouches[0].clientY;
        stopSlider();
    }, { passive: true });

    el.addEventListener('touchend', e => {
        const dx = sx - e.changedTouches[0].clientX;
        const dy = Math.abs(sy - e.changedTouches[0].clientY);
        if (dy < 40 && Math.abs(dx) > 40) {
            dx > 0 ? nextSlide() : prevSlide();
        }
        startSlider();
    }, { passive: true });

    el.addEventListener('mouseenter', stopSlider);
    el.addEventListener('mouseleave', startSlider);
}

/* ── Bottom Nav active ── */
function initBottomNav() {
    document.querySelectorAll('.bottom-nav-item').forEach(item => {
        item.addEventListener('click', function () {
            document.querySelectorAll('.bottom-nav-item').forEach(i => i.classList.remove('active'));
            this.classList.add('active');
        });
    });
}

/* ── Cart badge in header ── */
function updateHeaderCartBadge() {
    const badge = document.getElementById('headerCartBadge');
    if (!badge) return;
    try {
        const cart  = JSON.parse(localStorage.getItem('jasa_cart') || '[]');
        const count = cart.reduce((sum, item) => sum + (item.qty || 1), 0);
        if (count > 0) {
            badge.textContent    = count > 99 ? '99+' : count;
            badge.style.display  = 'flex';
        } else {
            badge.style.display  = 'none';
        }
    } catch(_) {
        badge.style.display = 'none';
    }
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
    applyTheme(getStoredTheme());
    initSlider();
    initBottomNav();
    renderSidebarAuth();
    updateHeaderCartBadge();
});

// Keep badge in sync when cart changes (same tab or other tabs)
window.addEventListener('cartUpdated', updateHeaderCartBadge);
window.addEventListener('storage', e => {
    if (e.key === 'jasa_cart') updateHeaderCartBadge();
});

/* globals for inline handlers */
/* ── Copy User ID ── */
function copyUserId(id, el) {
    if (!id || !el) return;
    const textToCopy = id;
    navigator.clipboard.writeText(textToCopy).then(() => {
        const icon = el.querySelector('i');
        const span = el.querySelector('span');
        const origIcon = icon ? icon.className : '';
        const origText = span ? span.textContent : '';

        if (icon) icon.className = 'fa-solid fa-check';
        if (span) span.textContent = 'Copied!';

        setTimeout(() => {
            if (icon) icon.className = origIcon || 'fa-regular fa-clipboard';
            if (span) span.textContent = origText || `ID: ${id}`;
        }, 1500);
    }).catch(err => {
        console.warn('Failed to copy ID:', err);
    });
}

window.openSidebar       = openSidebar;
window.closeSidebar      = closeSidebar;
window.toggleTheme       = toggleTheme;
window.openThemePicker   = openThemePicker;
window.setThemeMode      = setThemeMode;
window.logoutUser        = logoutUser;
window.openLogoutConfirm = openLogoutConfirm;
window.closeLogoutConfirm= closeLogoutConfirm;
window.confirmLogout     = confirmLogout;
window.copyUserId        = copyUserId;
window.goToSlide         = goToSlide;
window.updateHeaderCartBadge = updateHeaderCartBadge;
Object.defineProperty(window, 'currentSlide', {
    get: () => currentSlide,
    set: v  => { currentSlide = v; }
});


