/* ═══════════════════════════════════════════════
   COUPON MANAGER — admin-coupons.js
   Firestore: coupons/{CODE}, coupon_usages (read-only here)
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import {
    collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
    query, where, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

let allCoupons = [];
let allShops   = [];
let filter     = 'all';
let editingId  = null;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, type = '') {
    const el = $('abToast');
    el.textContent = msg;
    el.className = 'ab-toast' + (type ? ' ' + type : '');
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

let _dialogResolve = null;
function confirmDialog(title, msg) {
    return new Promise(resolve => {
        _dialogResolve = resolve;
        $('abDialogTitle').textContent = title;
        $('abDialogMsg').textContent = msg;
        $('abDialogOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
    });
}
window.closeDialog = function (result = false) {
    $('abDialogOverlay').classList.remove('open');
    document.body.style.overflow = '';
    if (_dialogResolve) { _dialogResolve(result); _dialogResolve = null; }
};
$('abDialogConfirm').addEventListener('click', () => window.closeDialog(true));

/* ── Auth guard ── */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html'); return; }
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const roles = snap.data().roles || [snap.data().role || 'user'];
        if (!roles.includes('admin') && !roles.includes('manage_coupons')) {
            toast('Access denied. Admin permission required.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1200);
            return;
        }
        await Promise.all([loadCoupons(), loadShops()]);
    } catch (err) {
        console.error('[AdminCoupons] auth:', err);
        window.location.replace('index.html');
    }
});

/* ── Helpers ── */
function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    const d = new Date(v);
    return isNaN(d) ? null : d;
}
function toLocalInput(v) {
    const d = toDate(v);
    if (!d) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fmtDate = v => { const d = toDate(v); return d ? d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; };

function statusOf(c) {
    const now = new Date();
    const from = toDate(c.validFrom), till = toDate(c.validTill);
    if (!c.active) return 'inactive';
    if (till && now > till) return 'expired';
    if (from && now < from) return 'upcoming';
    if (c.totalUsageLimit > 0 && (c.usedCount || 0) >= c.totalUsageLimit) return 'used-up';
    return 'live';
}
const STATUS_LABEL = { live: 'Live', inactive: 'Inactive', expired: 'Expired', upcoming: 'Upcoming', 'used-up': 'Used up' };

/* ── Load & render ── */
export async function loadCoupons() {
    $('cpList').innerHTML = `<div class="ab-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading coupons…</div>`;
    try {
        const snap = await getDocs(query(collection(db, 'coupons'), orderBy('createdAt', 'desc')));
        allCoupons = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderCoupons();
    } catch (err) {
        console.error('[AdminCoupons] load:', err);
        $('cpList').innerHTML = `<div class="ab-empty"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load coupons: ${esc(err.message)}</div>`;
    }
}
window.loadCoupons = loadCoupons;

async function loadShops() {
    try {
        const snap = await getDocs(collection(db, 'shops'));
        allShops = snap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }));
    } catch (err) { console.warn('[AdminCoupons] shops:', err); }
}

window.setCouponFilter = function (f, btn) {
    filter = f;
    document.querySelectorAll('#cpFilterPills .ab-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderCoupons();
};

function renderCoupons() {
    const list = allCoupons.filter(c => {
        const s = statusOf(c);
        if (filter === 'all') return true;
        if (filter === 'live') return s === 'live';
        return s === filter;
    });
    $('cpCount').textContent = `${list.length} coupon${list.length === 1 ? '' : 's'}`;

    if (!list.length) {
        $('cpList').innerHTML = `<div class="ab-empty"><i class="fa-solid fa-ticket"></i> No coupons here yet.</div>`;
        return;
    }

    $('cpList').innerHTML = list.map(c => {
        const s = statusOf(c);
        const used = c.usedCount || 0;
        const limit = c.totalUsageLimit || 0;
        const pct = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0;
        const valueTxt = c.type === 'percentage'
            ? `${c.value}% off${c.maxDiscount > 0 ? ` (max ₹${c.maxDiscount})` : ''}`
            : `₹${c.value} off`;
        const shopTxt = (c.shopIds || []).length ? `${c.shopIds.length} shop(s)` : 'All shops';
        return `
        <div class="cp-card">
            <div class="cp-top">
                <div>
                    <span class="cp-code">${esc(c.id)}</span>
                    <div class="cp-name">${esc(c.name)}</div>
                    ${c.description ? `<div class="cp-desc">${esc(c.description)}</div>` : ''}
                </div>
                <span class="cp-status ${s}">${STATUS_LABEL[s]}</span>
            </div>
            <div class="cp-meta">
                <span class="cp-chip"><i class="fa-solid fa-tag"></i>${esc(valueTxt)}</span>
                ${c.minOrderAmount > 0 ? `<span class="cp-chip"><i class="fa-solid fa-cart-shopping"></i>Min ₹${c.minOrderAmount}</span>` : ''}
                <span class="cp-chip"><i class="fa-solid fa-user"></i>${c.perUserLimit > 0 ? c.perUserLimit + '× per user' : 'Unlimited per user'}</span>
                <span class="cp-chip"><i class="fa-solid fa-layer-group"></i>${esc(c.applicableTo || 'all')}</span>
                <span class="cp-chip"><i class="fa-solid fa-store"></i>${shopTxt}</span>
                ${c.firstOrderOnly ? `<span class="cp-chip"><i class="fa-solid fa-1"></i>First order</span>` : ''}
                <span class="cp-chip"><i class="fa-regular fa-clock"></i>Till ${esc(fmtDate(c.validTill))}</span>
            </div>
            <div>
                <div style="font-size:.7rem;font-weight:700;color:var(--txt2);margin-bottom:4px;">
                    Used ${used}${limit > 0 ? ' / ' + limit : ''}
                </div>
                ${limit > 0 ? `<div class="cp-bar"><span style="width:${pct}%"></span></div>` : ''}
            </div>
            <div class="cp-actions">
                <button class="ab-action-btn" onclick="openCouponModal('${esc(c.id)}')"><i class="fa-solid fa-pen"></i> Edit</button>
                <button class="ab-action-btn" onclick="toggleCoupon('${esc(c.id)}')">
                    <i class="fa-solid ${c.active ? 'fa-pause' : 'fa-play'}"></i> ${c.active ? 'Disable' : 'Enable'}
                </button>
                <button class="ab-action-btn" onclick="viewUsage('${esc(c.id)}')"><i class="fa-solid fa-clock-rotate-left"></i> Usage</button>
                <button class="ab-action-btn del" onclick="deleteCoupon('${esc(c.id)}')"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`;
    }).join('');
}

/* ── Modal ── */
window.onTypeChange = function () {
    const pct = $('cpType').value === 'percentage';
    $('cpValueLabel').innerHTML = (pct ? 'Percent Off' : 'Amount Off (₹)') + ' <span class="cp-req">*</span>';
    $('cpValue').max = pct ? '100' : '';
    $('cpMaxWrap').style.display = pct ? '' : 'none';
};

function renderShopChecks(selected = []) {
    if (!allShops.length) { $('cpShops').innerHTML = '<span class="cp-hint">No shops found — coupon applies to all shops.</span>'; return; }
    $('cpShops').innerHTML = allShops.map(s => `
        <label><input type="checkbox" name="cp-shop" value="${esc(s.id)}" ${selected.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('');
}

window.openCouponModal = function (id) {
    editingId = id || null;
    const c = id ? allCoupons.find(x => x.id === id) : null;

    $('cpModalTitle').textContent = c ? 'Edit Coupon' : 'New Coupon';
    $('cpSaveBtn').textContent = c ? 'Save Changes' : 'Create Coupon';
    $('cpForm').reset();

    $('cpSlug').value = c ? c.id : '';
    $('cpSlug').readOnly = !!c;
    $('cpName').value = c?.name || '';
    $('cpDesc').value = c?.description || '';
    $('cpType').value = c?.type || 'percentage';
    $('cpValue').value = c?.value ?? '';
    $('cpMaxDiscount').value = c?.maxDiscount || '';
    $('cpMinOrder').value = c?.minOrderAmount || '';
    $('cpFrom').value = toLocalInput(c?.validFrom);
    $('cpTill').value = toLocalInput(c?.validTill);
    $('cpPerUser').value = c ? (c.perUserLimit ?? 0) : 1;
    $('cpTotalLimit').value = c ? (c.totalUsageLimit ?? 0) : 0;
    $('cpApplies').value = c?.applicableTo || 'all';
    $('cpFirstOrder').checked = !!c?.firstOrderOnly;
    $('cpActive').checked = c ? !!c.active : true;
    renderShopChecks(c?.shopIds || []);
    window.onTypeChange();

    $('cpModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
};
window.closeCouponModal = function () {
    $('cpModalOverlay').classList.remove('open');
    document.body.style.overflow = '';
};

window.saveCoupon = async function (e) {
    e.preventDefault();
    const slug = $('cpSlug').value.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,20}$/.test(slug)) { toast('Code must be 3-20 letters, numbers, - or _.', 'error'); return; }

    const type = $('cpType').value;
    const value = parseFloat($('cpValue').value);
    if (!(value > 0)) { toast('Enter a discount value greater than 0.', 'error'); return; }
    if (type === 'percentage' && value > 100) { toast('Percentage cannot exceed 100.', 'error'); return; }

    const till = $('cpTill').value ? new Date($('cpTill').value) : null;
    const from = $('cpFrom').value ? new Date($('cpFrom').value) : null;
    if (!till) { toast('Select a "Valid Till" date.', 'error'); return; }
    if (from && from >= till) { toast('"Valid From" must be before "Valid Till".', 'error'); return; }

    const data = {
        name: $('cpName').value.trim(),
        slug,
        description: $('cpDesc').value.trim(),
        type, value,
        maxDiscount: type === 'percentage' ? (parseFloat($('cpMaxDiscount').value) || 0) : 0,
        minOrderAmount: parseFloat($('cpMinOrder').value) || 0,
        validFrom: from ? from.toISOString() : null,
        validTill: till.toISOString(),
        perUserLimit: parseInt($('cpPerUser').value) || 0,
        totalUsageLimit: parseInt($('cpTotalLimit').value) || 0,
        applicableTo: $('cpApplies').value,
        shopIds: Array.from(document.querySelectorAll('input[name="cp-shop"]:checked')).map(c => c.value),
        firstOrderOnly: $('cpFirstOrder').checked,
        active: $('cpActive').checked,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser.uid,
    };

    const btn = $('cpSaveBtn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        if (editingId) {
            await updateDoc(doc(db, 'coupons', editingId), data);
            toast('Coupon updated.', 'success');
        } else {
            const ref = doc(db, 'coupons', slug);
            if ((await getDoc(ref)).exists()) { toast(`Code ${slug} already exists.`, 'error'); return; }
            await setDoc(ref, { ...data, usedCount: 0, createdAt: serverTimestamp(), createdBy: auth.currentUser.uid });
            toast('Coupon created.', 'success');
        }
        window.closeCouponModal();
        await loadCoupons();
    } catch (err) {
        console.error('[AdminCoupons] save:', err);
        toast('Save failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false; btn.textContent = orig;
    }
};

/* ── Toggle / delete ── */
window.toggleCoupon = async function (id) {
    const c = allCoupons.find(x => x.id === id);
    if (!c) return;
    try {
        await updateDoc(doc(db, 'coupons', id), { active: !c.active, updatedAt: serverTimestamp() });
        toast(c.active ? 'Coupon disabled.' : 'Coupon enabled.', 'success');
        await loadCoupons();
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
};

window.deleteCoupon = async function (id) {
    const ok = await confirmDialog('Delete coupon?', `${id} will be removed. Past usage records are kept.`);
    if (!ok) return;
    try {
        await deleteDoc(doc(db, 'coupons', id));
        toast('Coupon deleted.', 'success');
        await loadCoupons();
    } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
};

/* ── Usage history ── */
window.viewUsage = async function (id) {
    $('cpUsageTitle').textContent = `Usage — ${id}`;
    $('cpUsageBody').innerHTML = `<div class="ab-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>`;
    $('cpUsageOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    try {
        const snap = await getDocs(query(collection(db, 'coupon_usages'), where('couponCode', '==', id), limit(500)));
        if (snap.empty) { $('cpUsageBody').innerHTML = `<div class="ab-empty">Not used yet.</div>`; return; }
        const rows = snap.docs.map(d => d.data())
            .sort((a, b) => (toDate(b.usedAt)?.getTime() || 0) - (toDate(a.usedAt)?.getTime() || 0));
        const total = rows.filter(r => r.status === 'redeemed').reduce((s, r) => s + (r.discountAmount || 0), 0);
        $('cpUsageBody').innerHTML =
            `<div class="cp-hint" style="margin-bottom:8px;">Total discount given: <b>₹${total.toFixed(2)}</b> (latest 500 uses)</div>` +
            rows.map(r => `
            <div class="cp-usage-row">
                <div>
                    <b>${esc(r.groupOrderId)}</b>
                    <small>User ${esc((r.userId || '').slice(0, 8))} · ${esc(fmtDate(r.usedAt))}</small>
                </div>
                <div style="text-align:right;">
                    ₹${(r.discountAmount || 0).toFixed(2)}
                    <small class="${r.status === 'released' ? 'rel' : ''}">${esc(r.status)} · order ₹${r.orderAmount}</small>
                </div>
            </div>`).join('');
    } catch (err) {
        console.error('[AdminCoupons] usage:', err);
        $('cpUsageBody').innerHTML = `<div class="ab-empty">Failed to load: ${esc(err.message)}</div>`;
    }
};
window.closeUsageModal = function () {
    $('cpUsageOverlay').classList.remove('open');
    document.body.style.overflow = '';
};
