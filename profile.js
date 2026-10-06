/* ═══════════════════════════════════════════════
   JASA V2 — Profile Page Logic (profile.js)
   Firebase: Auth + Firestore read/write
   ═══════════════════════════════════════════════ */

import { auth, db } from './firebase-init.js';
import {
    onAuthStateChanged,
    signOut,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    doc,
    getDoc,
    updateDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

/* ════════════════════════════════
   COLOR — same palette as auth-header.js
   so hero avatar matches header icon exactly
   ════════════════════════════════ */
const COLORS = [
    { color: '#2D8CF0', bg: '#e8f2fe' }, // blue
    { color: '#10b981', bg: '#d1fae5' }, // green
    { color: '#f59e0b', bg: '#fef3c7' }, // amber
    { color: '#ef4444', bg: '#fee2e2' }, // red
    { color: '#8b5cf6', bg: '#ede9fe' }, // violet
    { color: '#ec4899', bg: '#fce7f3' }, // pink
    { color: '#06b6d4', bg: '#cffafe' }, // cyan
    { color: '#f97316', bg: '#ffedd5' }, // orange
];

function pickColor(uid = '') {
    const sum = [...uid].reduce((a, c) => a + c.charCodeAt(0), 0);
    return COLORS[sum % COLORS.length];
}
let currentUser    = null;
let userData       = {};
let altMobiles     = [];   // working copy for edit form
let addresses      = [];   // working copy for address list

/* ════════════════════════════════
   AUTH GUARD + LOAD
   ════════════════════════════════ */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.replace('login.html');
        return;
    }
    currentUser = user;

    /* Instant render from localStorage cache */
    const raw = localStorage.getItem('jasa_user_cache');
    if (raw) {
        try { renderProfile(JSON.parse(raw)); } catch (_) {}
    }

    /* Live fetch from Firestore */
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (snap.exists()) {
            const fresh = { ...snap.data(), email: user.email, uid: user.uid };
            localStorage.setItem('jasa_user_cache', JSON.stringify(fresh));
            renderProfile(fresh);
        }
    } catch (err) {
        console.error('Profile fetch error:', err);
        showToast('Could not load profile data.', 'error');
    }
});

/* ════════════════════════════════
   RENDER PROFILE
   ════════════════════════════════ */
function renderProfile(data) {
    userData   = data;
    altMobiles = Array.isArray(data.altMobiles) ? [...data.altMobiles] : [];
    addresses  = Array.isArray(data.addresses)  ? [...data.addresses]  : [];

    /* Apply accent color to hero avatar — same as header icon */
    const { color, bg } = pickColor(currentUser?.uid || '');
    const avatar = document.getElementById('heroAvatar');
    if (avatar) {
        avatar.style.setProperty('--av-color', color);
        avatar.style.setProperty('--av-bg',    bg);
    }

    const name   = data.fullName     || 'User';
    const email  = data.email        || currentUser?.email || '—';
    const mobile = data.mobileNumber || '—';
    const role   = data.role         || 'user';
    const userId = data.userId       || '——';

    const $ = (id) => document.getElementById(id);

    /* Hero */
    $('heroName').textContent      = name;
    $('heroEmail').textContent     = email;
    $('heroBadge').textContent     = role.charAt(0).toUpperCase() + role.slice(1);
    $('heroUserId').textContent    = userId;

    if (data.createdAt) {
        const dateStr = new Date(data.createdAt).toLocaleDateString('en-IN', {
            year: 'numeric', month: 'short', day: 'numeric'
        });
        $('heroMemberSince').textContent = dateStr;
        $('valDate').textContent         = dateStr;
    }

    /* Info section — view mode */
    $('valName').textContent   = name;
    $('valEmail').textContent  = email;
    $('valMobile').textContent = mobile !== '—' ? mobile : 'Not set';

    if (altMobiles.length > 0) {
        $('valAltMobiles').textContent = altMobiles.join(', ');
        $('valAltMobiles').classList.remove('pf-muted');
    } else {
        $('valAltMobiles').textContent = 'None added';
        $('valAltMobiles').classList.add('pf-muted');
    }

    /* Security section */
    $('valRole').textContent = role;

    /* Pre-fill edit inputs */
    $('editName').value   = name !== 'User' ? name : '';
    $('editMobile').value = mobile !== '—'  ? mobile : '';

    renderAltMobileTags();
    renderAddresses();
}

/* ════════════════════════════════
   PERSONAL INFO — EDIT TOGGLE
   ════════════════════════════════ */
window.toggleEditInfo = function () {
    const view = document.getElementById('infoViewMode');
    const edit = document.getElementById('infoEditMode');
    const btn  = document.getElementById('editInfoBtn');
    const isOpen = edit.style.display === 'block';

    if (isOpen) {
        /* Cancel — restore working copy from saved state */
        altMobiles = Array.isArray(userData.altMobiles) ? [...userData.altMobiles] : [];
        renderAltMobileTags();
        edit.style.display = 'none';
        view.style.display = 'block';
        btn.innerHTML = '<i class="fa-solid fa-pen"></i> Edit';
    } else {
        /* Open edit */
        document.getElementById('editName').value   = userData.fullName     || '';
        document.getElementById('editMobile').value = userData.mobileNumber || '';
        altMobiles = Array.isArray(userData.altMobiles) ? [...userData.altMobiles] : [];
        renderAltMobileTags();
        view.style.display = 'none';
        edit.style.display = 'block';
        btn.innerHTML = '<i class="fa-solid fa-xmark"></i> Cancel';
    }
};

/* ════════════════════════════════
   SAVE PERSONAL INFO
   ════════════════════════════════ */
window.savePersonalInfo = async function () {
    const name   = document.getElementById('editName').value.trim();
    const mobile = document.getElementById('editMobile').value.trim();
    const btn    = document.getElementById('editInfoBtn'); // not the save btn
    const saveBtn = document.querySelector('#infoEditMode .pf-btn-save');

    if (!name) {
        showToast('Full name is required.', 'error');
        return;
    }

    setBtnLoading(saveBtn, true);
    try {
        await updateDoc(doc(db, 'users', currentUser.uid), {
            fullName:     name,
            mobileNumber: mobile,
            altMobiles:   altMobiles
        });

        /* Update local state */
        userData.fullName     = name;
        userData.mobileNumber = mobile;
        userData.altMobiles   = [...altMobiles];
        localStorage.setItem('jasa_user_cache', JSON.stringify(userData));

        renderProfile(userData);

        /* Close edit mode */
        document.getElementById('infoEditMode').style.display = 'none';
        document.getElementById('infoViewMode').style.display = 'block';
        btn.innerHTML = '<i class="fa-solid fa-pen"></i> Edit';

        showToast('Profile updated!', 'success');
    } catch (err) {
        console.error('Save personal info error:', err);
        showToast('Could not save changes. Try again.', 'error');
    } finally {
        setBtnLoading(saveBtn, false, '<i class="fa-solid fa-floppy-disk"></i> Save');
    }
};

/* ════════════════════════════════
   ALT MOBILES
   ════════════════════════════════ */
function renderAltMobileTags() {
    const wrap = document.getElementById('altTagsWrap');
    if (!wrap) return;
    wrap.innerHTML = altMobiles.map((num, i) => `
        <span class="pf-tag">
            <i class="fa-solid fa-phone" style="font-size:.6rem;"></i>
            ${num}
            <button class="pf-tag-remove" onclick="removeAltMobile(${i})" title="Remove">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </span>
    `).join('');
}

window.addAltMobile = function () {
    const input = document.getElementById('altMobileInput');
    const num   = input.value.trim();
    if (!num) return;
    if (altMobiles.includes(num)) {
        showToast('Number already added.', 'info');
        return;
    }
    altMobiles.push(num);
    input.value = '';
    renderAltMobileTags();
};

window.removeAltMobile = function (index) {
    altMobiles.splice(index, 1);
    renderAltMobileTags();
};

/* Enter key to add alt mobile */
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('altMobileInput');
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); window.addAltMobile(); }
    });
});

/* ════════════════════════════════
   ADDRESSES — RENDER
   ════════════════════════════════ */
function renderAddresses() {
    const list   = document.getElementById('addressList');
    const noMsg  = document.getElementById('noAddrMsg');
    if (!list) return;

    /* Remove existing address cards (keep the empty msg) */
    list.querySelectorAll('.pf-addr-card').forEach(c => c.remove());

    if (addresses.length === 0) {
        noMsg.style.display = 'block';
        return;
    }
    noMsg.style.display = 'none';

    addresses.forEach((addr, i) => {
        const card = document.createElement('div');
        card.className = 'pf-addr-card';
        const cityState = [addr.city, addr.state].filter(Boolean).join(', ');
        const pin       = addr.pincode ? ` — ${addr.pincode}` : '';

        card.innerHTML = `
            <div class="pf-addr-pill">
                <i class="fa-solid fa-location-dot"></i>
                ${addr.label || 'Address'} ${i + 1}
            </div>
            <div class="pf-addr-street">${addr.street || '—'}</div>
            <div class="pf-addr-detail">${cityState}${pin}</div>
            <div class="pf-addr-actions">
                <button class="pf-addr-btn edit" onclick="showAddressForm(${i})">
                    <i class="fa-solid fa-pen"></i> Edit
                </button>
                <button class="pf-addr-btn del" onclick="deleteAddress(${i})">
                    <i class="fa-solid fa-trash-can"></i> Remove
                </button>
            </div>
        `;
        list.insertBefore(card, noMsg);
    });
}

/* ════════════════════════════════
   ADDRESSES — FORM
   ════════════════════════════════ */
window.showAddressForm = function (index) {
    const form  = document.getElementById('addressForm');
    const title = document.getElementById('addrFormTitle');
    document.getElementById('editAddrIdx').value = index;

    if (index === -1) {
        /* Add new */
        title.textContent = 'Add New Address';
        ['addrLabel','addrStreet','addrCity','addrState','addrPincode']
            .forEach(id => document.getElementById(id).value = '');
    } else {
        /* Edit existing */
        const a = addresses[index];
        title.textContent = 'Edit Address';
        document.getElementById('addrLabel').value   = a.label   || '';
        document.getElementById('addrStreet').value  = a.street  || '';
        document.getElementById('addrCity').value    = a.city    || '';
        document.getElementById('addrState').value   = a.state   || '';
        document.getElementById('addrPincode').value = a.pincode || '';
    }

    form.style.display = 'block';
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window.hideAddressForm = function () {
    document.getElementById('addressForm').style.display = 'none';
};

/* ════════════════════════════════
   ADDRESSES — SAVE
   ════════════════════════════════ */
window.saveAddress = async function () {
    const index   = parseInt(document.getElementById('editAddrIdx').value, 10);
    const label   = document.getElementById('addrLabel').value.trim()   || 'Other';
    const street  = document.getElementById('addrStreet').value.trim();
    const city    = document.getElementById('addrCity').value.trim();
    const state   = document.getElementById('addrState').value.trim();
    const pincode = document.getElementById('addrPincode').value.trim();
    const saveBtn = document.querySelector('#addressForm .pf-btn-save');

    if (!street || !city) {
        showToast('Street and City are required.', 'error');
        return;
    }

    const entry = { label, street, city, state, pincode };
    const updated = [...addresses];

    if (index === -1) {
        updated.push(entry);
    } else {
        updated[index] = entry;
    }

    setBtnLoading(saveBtn, true);
    try {
        await updateDoc(doc(db, 'users', currentUser.uid), { addresses: updated });

        addresses = updated;
        userData.addresses = updated;
        localStorage.setItem('jasa_user_cache', JSON.stringify(userData));

        hideAddressForm();
        renderAddresses();
        showToast(index === -1 ? 'Address added!' : 'Address updated!', 'success');
    } catch (err) {
        console.error('Save address error:', err);
        showToast('Could not save address. Try again.', 'error');
    } finally {
        setBtnLoading(saveBtn, false, '<i class="fa-solid fa-floppy-disk"></i> Save');
    }
};

/* ════════════════════════════════
   ADDRESSES — DELETE
   ════════════════════════════════ */
window.deleteAddress = async function (index) {
    const addr  = addresses[index];
    const label = addr.label || `Address ${index + 1}`;

    const confirmed = await showConfirm(
        'Remove Address?',
        `"${label}" will be permanently removed.`,
        'danger'
    );
    if (!confirmed) return;

    const updated = addresses.filter((_, i) => i !== index);

    try {
        await updateDoc(doc(db, 'users', currentUser.uid), { addresses: updated });
        addresses = updated;
        userData.addresses = updated;
        localStorage.setItem('jasa_user_cache', JSON.stringify(userData));
        renderAddresses();
        showToast('Address removed.', 'success');
    } catch (err) {
        console.error('Delete address error:', err);
        showToast('Could not remove address. Try again.', 'error');
    }
};

/* ════════════════════════════════
   PASSWORD RESET
   ════════════════════════════════ */
window.sendPasswordReset = async function () {
    const email = currentUser?.email;
    if (!email) return;

    const confirmed = await showConfirm(
        'Reset Password?',
        `A reset link will be sent to ${email}.`
    );
    if (!confirmed) return;

    try {
        await sendPasswordResetEmail(auth, email);
        showToast('Reset email sent! Check your inbox.', 'success');
    } catch (err) {
        console.error('Password reset error:', err);
        showToast(err.message || 'Failed to send reset email.', 'error');
    }
};

/* ════════════════════════════════
   REFRESH ALL CACHE
   Clears all app-level localStorage caches
   (shops, xerox config, orders, categories, items).
   Preserves: jasa_user_cache, jasa_cart, jasa_theme,
              jasa_xerox_location_v3 (location pref).
   ════════════════════════════════ */
window.refreshAllCache = function () {
    const PRESERVE = new Set([
        'jasa_user_cache',
        'jasa_cart',
        'jasa_theme',
        'jasa_xerox_location_v3',
    ]);

    /* Static known keys */
    const STATIC_KEYS = [
        'jasa_xerox_config_v1',
        'jasa_xerox_shops_v1',
        'jasa_xerox_shops_v2',
        'global_shops_data_v1',
        'jasa_orders_cache',
        'jasa_cache_version',
    ];

    /* Dynamic key prefixes (categories, items, product-request history, search history) */
    const DYNAMIC_PREFIXES = [
        'jasa_v2_cat_',
        'jasa_v2_item_',
        'jasa_pr_history_',
        'jasa_sq_history_',
    ];

    let cleared = 0;

    /* Remove static keys */
    STATIC_KEYS.forEach(k => {
        if (localStorage.getItem(k) !== null) {
            localStorage.removeItem(k);
            cleared++;
        }
    });

    /* Scan all keys for dynamic prefix matches */
    const allKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
        allKeys.push(localStorage.key(i));
    }
    allKeys.forEach(k => {
        if (PRESERVE.has(k)) return;
        if (DYNAMIC_PREFIXES.some(prefix => k.startsWith(prefix))) {
            localStorage.removeItem(k);
            cleared++;
        }
    });

    /* Visual feedback on the button */
    const btn = document.getElementById('refreshCacheBtn');
    if (btn) {
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Cleared';
        setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = original;
        }, 2000);
    }

    showToast(
        cleared > 0
            ? `Cache cleared (${cleared} item${cleared > 1 ? 's' : ''} removed). Fresh data loads on next visit.`
            : 'Cache is already empty.',
        'success'
    );
};

/* ════════════════════════════════
   LOGOUT
   ════════════════════════════════ */
window.confirmLogout = async function () {
    const confirmed = await showConfirm(
        'Logout?',
        'You will be signed out of your account.',
        'danger'
    );
    if (!confirmed) return;

    try {
        localStorage.removeItem('jasa_user_cache');
        await signOut(auth);
        window.location.replace('login.html');
    } catch (err) {
        console.error('Logout error:', err);
        showToast('Logout failed. Try again.', 'error');
    }
};

/* ════════════════════════════════
   UI HELPERS
   ════════════════════════════════ */

/* Toast notification */
let toastTimer = null;
function showToast(msg, type = 'info') {
    const el = document.getElementById('pfToast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.className   = `pf-toast ${type}`;
    el.classList.add('show');
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* Confirm dialog — returns a Promise<boolean> */
function showConfirm(title, msg, variant = 'default') {
    return new Promise((resolve) => {
        const overlay = document.getElementById('pfConfirmOverlay');
        const icon    = document.getElementById('pfConfirmIcon');
        const tEl     = document.getElementById('pfConfirmTitle');
        const mEl     = document.getElementById('pfConfirmMsg');
        const yesBtn  = document.getElementById('pfConfirmYes');
        const noBtn   = document.getElementById('pfConfirmNo');

        tEl.textContent = title;
        mEl.textContent = msg;

        icon.className = variant === 'danger' ? 'pf-dialog-icon danger' : 'pf-dialog-icon';
        icon.innerHTML = variant === 'danger'
            ? '<i class="fa-solid fa-triangle-exclamation"></i>'
            : '<i class="fa-solid fa-circle-question"></i>';

        if (variant === 'danger') {
            yesBtn.style.background = '#dc2626';
            yesBtn.style.boxShadow  = '0 4px 14px rgba(220,38,38,.3)';
        } else {
            yesBtn.style.background = '';
            yesBtn.style.boxShadow  = '';
        }

        overlay.classList.add('active');

        const cleanup = (result) => {
            overlay.classList.remove('active');
            yesBtn.removeEventListener('click', onYes);
            noBtn .removeEventListener('click', onNo);
            resolve(result);
        };

        const onYes = () => cleanup(true);
        const onNo  = () => cleanup(false);

        yesBtn.addEventListener('click', onYes,  { once: true });
        noBtn .addEventListener('click', onNo,   { once: true });

        /* Backdrop click = cancel */
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup(false);
        }, { once: true });
    });
}

/* Button loading state */
function setBtnLoading(btn, loading, resetHtml = '') {
    if (!btn) return;
    if (loading) {
        btn.disabled = true;
        btn.innerHTML = '<span class="pf-spin"></span>';
    } else {
        btn.disabled = false;
        btn.innerHTML = resetHtml;
    }
}
