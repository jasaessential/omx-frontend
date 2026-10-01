/* ═══════════════════════════════════════════════
   JASA V2 — settings.js
   Features:
     • Theme mode (Light / Dark / Auto)
     • Reset password via email
   ═══════════════════════════════════════════════ */

import { auth } from './firebase-init.js';
import {
    onAuthStateChanged,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

/* ─── State ─── */
let currentUser = null;

/* ─────────────────────────────────────────────
   AUTH STATE — show/hide account-only sections
   ───────────────────────────────────────────── */
onAuthStateChanged(auth, user => {
    currentUser = user;

    /* Account & Security + Danger Zone are only useful when logged in */
    const accountCard = document.getElementById('stAccountCard');
    const dangerCard  = document.getElementById('stDangerCard');
    const guestNotice = document.getElementById('stGuestNotice');

    if (user) {
        if (accountCard) accountCard.style.display = '';
        if (dangerCard)  dangerCard.style.display  = '';
        if (guestNotice) guestNotice.style.display = 'none';
    } else {
        if (accountCard) accountCard.style.display = 'none';
        if (dangerCard)  dangerCard.style.display  = 'none';
        if (guestNotice) guestNotice.style.display = '';
    }
});

/* ─────────────────────────────────────────────
   THEME MODE
   ─── syncs with app.js's applyTheme / getStoredTheme
   ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    syncThemePills();
});

function syncThemePills() {
    const stored = (typeof getStoredTheme === 'function')
        ? getStoredTheme()
        : (localStorage.getItem('jasa_theme') || 'device');

    document.querySelectorAll('.st-theme-pill').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === stored);
    });
}

window.stSetTheme = function(mode) {
    /* Delegate to app.js applyTheme so it works globally */
    if (typeof applyTheme === 'function') {
        applyTheme(mode);
    } else {
        /* Fallback */
        const effective = mode === 'device'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : mode;
        document.documentElement.setAttribute('data-theme', effective);
        localStorage.setItem('jasa_theme', mode);
    }
    syncThemePills();
    showToast(
        mode === 'light' ? 'Light mode on' :
        mode === 'dark'  ? 'Dark mode on'  : 'Following device theme',
        'success'
    );
};

/* ─────────────────────────────────────────────
   RESET PASSWORD
   ───────────────────────────────────────────── */
window.stResetPassword = async function() {
    const email = currentUser?.email;
    if (!email) { showToast('No email on file.', 'error'); return; }

    const ok = await showConfirm(
        'Reset Password?',
        `A reset link will be sent to:\n${email}`
    );
    if (!ok) return;

    try {
        await sendPasswordResetEmail(auth, email);
        showToast('Reset link sent! Check your inbox.', 'success');
    } catch (err) {
        console.error('Password reset error:', err);
        showToast(err.message || 'Failed to send reset email.', 'error');
    }
};

/* ─────────────────────────────────────────────
   TOAST  — reuses profile.css .pf-toast styles
   ───────────────────────────────────────────── */
let _toastTimer;
function showToast(msg, type = 'info') {
    const el = document.getElementById('pfToast');
    if (!el) return;
    clearTimeout(_toastTimer);
    el.textContent = msg;
    const cls = type === 'warning' ? 'info' : type;
    el.className   = `pf-toast ${cls} show`;
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ─────────────────────────────────────────────
   CONFIRM DIALOG  — reuses profile.css .pf-overlay
   ───────────────────────────────────────────── */
function showConfirm(title, msg, variant = 'default') {
    return new Promise(resolve => {
        const overlay = document.getElementById('pfConfirmOverlay');
        const iconEl  = document.getElementById('pfConfirmIcon');
        const tEl     = document.getElementById('pfConfirmTitle');
        const mEl     = document.getElementById('pfConfirmMsg');
        const yesBtn  = document.getElementById('pfConfirmYes');
        const noBtn   = document.getElementById('pfConfirmNo');

        if (!overlay) { resolve(false); return; }

        tEl.textContent = title;
        mEl.textContent = msg;

        if (variant === 'danger') {
            yesBtn.style.background = '#ef4444';
            iconEl.innerHTML        = '<i class="fa-solid fa-triangle-exclamation"></i>';
            iconEl.style.background = '#fee2e2';
            iconEl.style.color      = '#dc2626';
        } else {
            yesBtn.style.background = '';
            iconEl.innerHTML        = '<i class="fa-solid fa-circle-question"></i>';
            iconEl.style.background = '';
            iconEl.style.color      = '';
        }

        overlay.classList.add('active');

        const cleanup = () => overlay.classList.remove('active');

        yesBtn.onclick = () => { cleanup(); resolve(true);  };
        noBtn.onclick  = () => { cleanup(); resolve(false); };
    });
}
