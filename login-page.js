/* ═══════════════════════════════════════════════
   JASA V2 — Login / Register Page Logic
   Integrates: Firebase Auth + Firestore + Google
   ═══════════════════════════════════════════════ */

'use strict';

import { auth, db, googleProvider } from './firebase-init.js';
import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    signInWithPopup,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    doc,
    setDoc,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

/* ════════════════════════════════
   REDIRECT IF ALREADY LOGGED IN
   ════════════════════════════════ */
onAuthStateChanged(auth, (user) => {
    if (user) {
        // already signed-in — send straight to home
        window.location.replace('index.html');
    }
});

/* ════════════════════════════════
   TAB / FORM SWITCHER
   ════════════════════════════════ */
let activeForm = 'login';

function positionPill() {
    const active = document.querySelector('.auth-tab.active');
    const pill   = document.getElementById('authTabPill');
    if (!pill || !active) return;

    const pRect = active.closest('.auth-tabs').getBoundingClientRect();
    const aRect = active.getBoundingClientRect();

    pill.style.width     = aRect.width  + 'px';
    pill.style.height    = aRect.height + 'px';
    pill.style.transform = `translateX(${aRect.left - pRect.left - 4}px)`;
}

function showForm(name) {
    activeForm = name;

    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    const targetTab = name === 'login'
        ? document.getElementById('tabLogin')
        : document.getElementById('tabRegister');
    if (targetTab) targetTab.classList.add('active');

    positionPill();

    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    const form = document.getElementById(name === 'login' ? 'loginForm' : 'registerForm');
    if (form) form.classList.add('active');

    const h = document.getElementById('authHeading');
    const s = document.getElementById('authSubhead');
    if (name === 'login') {
        if (h) h.textContent = 'Welcome Back!';
        if (s) s.textContent = 'Sign in to your account';
    } else {
        if (h) h.textContent = 'Create Account';
        if (s) s.textContent = 'Join JASA Essential today';
    }
}

/* ════════════════════════════════
   PASSWORD HELPERS
   ════════════════════════════════ */
function togglePwd(inputId, btn) {
    const input = document.getElementById(inputId);
    const icon  = btn.querySelector('i');
    if (!input) return;
    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'fa-regular fa-eye-slash';
    } else {
        input.type = 'password';
        icon.className = 'fa-regular fa-eye';
    }
}

function checkStrength(pass) {
    const segs = ['ss1','ss2','ss3','ss4'].map(id => document.getElementById(id));
    const txt  = document.getElementById('strengthTxt');

    segs.forEach(s => { if (s) s.className = 'strength-seg'; });
    if (!pass) { if (txt) { txt.textContent = ''; txt.style.color = ''; } checkMatch(); return; }

    let score = 0;
    if (pass.length >= 8)                            score++;
    if (/[a-z]/.test(pass) && /[A-Z]/.test(pass))   score++;
    if (/[0-9]/.test(pass))                          score++;
    if (/[$@#&!*^%]/.test(pass))                     score++;

    const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
    const colors = ['', '#ef4444','#f97316','#3b82f6','#22c55e'];
    const cls    = ['', 's1','s2','s3','s4'];

    for (let i = 0; i < score; i++) {
        if (segs[i]) segs[i].classList.add(cls[score]);
    }
    if (txt) {
        txt.textContent = labels[score];
        txt.style.color = colors[score];
    }
    checkMatch();
}

function checkMatch() {
    const pass    = document.getElementById('regPass')?.value    || '';
    const confirm = document.getElementById('regConfirm')?.value || '';
    const icon    = document.getElementById('matchIcon');
    const btn     = document.getElementById('regBtn');

    if (!confirm) {
        if (icon) icon.style.color = 'var(--border2)';
        if (btn)  btn.disabled = true;
        return;
    }

    const ok = pass === confirm && pass.length >= 6;
    if (icon) icon.style.color = ok ? '#22c55e' : '#ef4444';
    if (btn)  btn.disabled = !ok;
}

/* ════════════════════════════════
   HELPERS
   ════════════════════════════════ */
function generateUserId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

function setLoading(btn, text) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span> ${text}`;
}

function resetBtn(btn, html) {
    btn.disabled = false;
    btn.innerHTML = html;
}

/* ════════════════════════════════
   LOGIN
   ════════════════════════════════ */
async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail')?.value.trim();
    const pass  = document.getElementById('loginPass')?.value;
    const btn   = document.getElementById('loginBtn');
    if (!email || !pass) return;

    setLoading(btn, 'Signing In...');
    try {
        const cred = await signInWithEmailAndPassword(auth, email, pass);

        // Cache user data in localStorage for instant reads
        const snap = await getDoc(doc(db, 'users', cred.user.uid));
        if (snap.exists()) {
            localStorage.setItem('jasa_user_cache',
                JSON.stringify({ ...snap.data(), email: cred.user.email, uid: cred.user.uid }));
        }

        showNotif('success', 'Welcome back!', 'Redirecting to home…');
        setTimeout(() => window.location.replace('index.html'), 1200);

    } catch (err) {
        console.error('Login error:', err.code);
        let msg = 'Incorrect email or password. Please try again.';
        if (err.code === 'auth/too-many-requests')
            msg = 'Too many attempts. Account temporarily locked — reset your password or try later.';
        else if (err.code === 'auth/user-disabled')
            msg = 'This account has been disabled. Contact support.';
        else if (err.code === 'auth/invalid-credential')
            msg = 'Invalid credentials. Please check your email and password.';
        showNotif('error', 'Sign-In Failed', msg);
        resetBtn(btn, 'Sign In');
    }
}

/* ════════════════════════════════
   REGISTER
   ════════════════════════════════ */
async function handleRegister(e) {
    e.preventDefault();
    const name   = document.getElementById('regName')?.value.trim();
    const mobile = document.getElementById('regMobile')?.value.trim();
    const email  = document.getElementById('regEmail')?.value.trim();
    const pass   = document.getElementById('regPass')?.value;
    const btn    = document.getElementById('regBtn');

    if (!name || !mobile || !email || !pass) return;

    const refCode = document.getElementById('regRef')?.value.trim().toUpperCase();
    if (refCode) localStorage.setItem('jasa_pending_ref', refCode);

    setLoading(btn, 'Creating Account...');
    try {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);

        const userId   = generateUserId();
        const userData = {
            fullName:     name,
            mobileNumber: mobile,
            email:        email,
            userId:       userId,
            role:         'user',
            createdAt:    new Date().toISOString()
        };

        await setDoc(doc(db, 'users', cred.user.uid), userData);

        // Cache for instant profile reads
        localStorage.setItem('jasa_user_cache',
            JSON.stringify({ ...userData, uid: cred.user.uid }));

        showNotif('success', 'Account Created!', 'Welcome to JASA Essential! Redirecting…');
        setTimeout(() => window.location.replace('index.html'), 1800);

    } catch (err) {
        console.error('Register error:', err.code);
        let msg = 'Account creation failed. Please check your details.';
        if (err.code === 'auth/email-already-in-use')
            msg = 'This email is already registered. Please sign in instead.';
        else if (err.code === 'auth/invalid-email')
            msg = 'Please enter a valid email address.';
        else if (err.code === 'auth/weak-password')
            msg = 'Password is too weak. Use at least 6 characters.';
        showNotif('error', 'Registration Failed', msg);
        resetBtn(btn, 'Create Account <i class="fa-solid fa-user-plus"></i>');
    }
}

/* ════════════════════════════════
   GOOGLE SIGN-IN
   ════════════════════════════════ */
document.getElementById('googleBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('googleBtn');
    const origHtml = btn.innerHTML;
    setLoading(btn, 'Signing in with Google…');

    try {
        const cred = await signInWithPopup(auth, googleProvider);
        const user = cred.user;

        // Check if user profile exists in Firestore
        const snap = await getDoc(doc(db, 'users', user.uid));

        if (snap.exists()) {
            // Existing user — cache and redirect
            localStorage.setItem('jasa_user_cache',
                JSON.stringify({ ...snap.data(), email: user.email, uid: user.uid }));
            showNotif('success', 'Signed in!', 'Welcome back! Redirecting…');
            setTimeout(() => window.location.replace('index.html'), 1200);

        } else {
            // New Google user — create Firestore record automatically
            const userId   = generateUserId();
            const userData = {
                fullName:     user.displayName || 'Google User',
                mobileNumber: '',
                email:        user.email,
                userId:       userId,
                role:         'user',
                photoURL:     user.photoURL || '',
                createdAt:    new Date().toISOString()
            };
            await setDoc(doc(db, 'users', user.uid), userData);
            localStorage.setItem('jasa_user_cache',
                JSON.stringify({ ...userData, uid: user.uid }));
            showNotif('success', 'Account Created!', 'Welcome to JASA Essential! Redirecting…');
            setTimeout(() => window.location.replace('index.html'), 1800);
        }

    } catch (err) {
        console.error('Google auth error:', err.code);
        if (err.code !== 'auth/popup-closed-by-user' &&
            err.code !== 'auth/cancelled-popup-request') {
            showNotif('error', 'Google Sign-In Failed', err.message || 'Please try again.');
        }
        btn.disabled = false;
        btn.innerHTML = origHtml;
    }
});

/* ════════════════════════════════
   FORGOT PASSWORD
   ════════════════════════════════ */
function showForgot() {
    document.getElementById('forgotOverlay').classList.add('active');
    document.getElementById('forgotEmail').value = '';
}
function hideForgot() {
    document.getElementById('forgotOverlay').classList.remove('active');
}

async function sendReset(e) {
    e.preventDefault();
    const email = document.getElementById('forgotEmail')?.value.trim();
    const btn   = document.getElementById('forgotBtn');
    if (!email) return;

    setLoading(btn, 'Sending…');
    try {
        await sendPasswordResetEmail(auth, email);
        hideForgot();
        showNotif('success', 'Email Sent!',
            `A password reset link has been sent to ${email}. Check your inbox.`);
    } catch (err) {
        console.error('Reset error:', err.code);
        let msg = 'Failed to send reset email. Please try again.';
        if (err.code === 'auth/user-not-found')
            msg = 'No account found with that email address.';
        else if (err.code === 'auth/invalid-email')
            msg = 'Please enter a valid email address.';
        showNotif('error', 'Reset Failed', msg);
    } finally {
        resetBtn(btn, 'Send Reset Link');
    }
}

/* ════════════════════════════════
   NOTIFICATION OVERLAY
   ════════════════════════════════ */
function showNotif(type, title, msg) {
    const overlay = document.getElementById('notifOverlay');
    const icon    = document.getElementById('notifIcon');
    const t       = document.getElementById('notifTitle');
    const m       = document.getElementById('notifMsg');

    const iconMap = {
        success: 'fa-solid fa-circle-check',
        error:   'fa-solid fa-circle-xmark',
        info:    'fa-solid fa-circle-info',
    };

    if (icon) {
        icon.className = `overlay-icon ${type}`;
        icon.innerHTML = `<i class="${iconMap[type] || iconMap.info}"></i>`;
    }
    if (t) t.textContent = title;
    if (m) m.textContent = msg;
    overlay.classList.add('active');

    if (type === 'success') {
        setTimeout(() => overlay.classList.remove('active'), 4000);
    }
}
function hideNotif() {
    document.getElementById('notifOverlay')?.classList.remove('active');
}

/* ════════════════════════════════
   TERMS OVERLAY
   ════════════════════════════════ */
function showTerms() {
    document.getElementById('termsOverlay').classList.add('active');
}
function hideTerms() {
    document.getElementById('termsOverlay').classList.remove('active');
}

/* ════════════════════════════════
   PRIVACY POLICY OVERLAY
   ════════════════════════════════ */
function showPrivacy() {
    document.getElementById('privacyOverlay').classList.add('active');
}
function hidePrivacy() {
    document.getElementById('privacyOverlay').classList.remove('active');
}

/* ════════════════════════════════
   OVERLAY BACKDROP CLOSE
   ════════════════════════════════ */
document.querySelectorAll('.auth-overlay').forEach(ov => {
    ov.addEventListener('click', e => {
        if (e.target === ov) ov.classList.remove('active');
    });
});

/* ════════════════════════════════
   INIT
   ════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    positionPill();
    window.addEventListener('resize', positionPill);

    const params = new URLSearchParams(window.location.search);

    // Show register form if URL has ?mode=register
    if (params.get('mode') === 'register') {
        showForm('register');
    }

    // Shared referral link: login.html?ref=CODE → open Create Account with the code filled in
    const ref = (params.get('ref') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (ref) {
        localStorage.setItem('jasa_pending_ref', ref);   // also covers "Continue with Google"
        const input = document.getElementById('regRef');
        if (input) input.value = ref;
        showForm('register');
    }
});

/* ── Expose to inline HTML handlers ── */
window.showForm      = showForm;
window.togglePwd     = togglePwd;
window.checkStrength = checkStrength;
window.checkMatch    = checkMatch;
window.handleLogin   = handleLogin;
window.handleRegister= handleRegister;
window.showForgot    = showForgot;
window.hideForgot    = hideForgot;
window.sendReset     = sendReset;
window.hideNotif     = hideNotif;
window.showTerms     = showTerms;
window.hideTerms     = hideTerms;
window.showPrivacy   = showPrivacy;
window.hidePrivacy   = hidePrivacy;
