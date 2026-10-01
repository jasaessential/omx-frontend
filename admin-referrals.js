/* ═══════════════════════════════════════════════
   REFERRALS — admin-referrals.js  (admin only)
   Firestore: config/referral (settings), referrals (read-only here)
   Server:    POST /api/referral/admin/backfill, /admin/void
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import {
    collection, doc, getDoc, getDocs, setDoc, query, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { PAYMENT_SERVER_URL } from './env-config.js';
import { inr } from './wallet-client.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = () => (window.__JASA_SERVER || PAYMENT_SERVER_URL).replace(/\/$/, '');
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const radio = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, val) => { const el = document.querySelector(`input[name="${name}"][value="${val}"]`); if (el) el.checked = true; };

function toast(msg, type = '') {
    const el = $('abToast');
    el.textContent = msg;
    el.className = 'ab-toast' + (type ? ' ' + type : '');
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3200);
}

onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html'); return; }
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        const d = snap.exists() ? snap.data() : {};
        const roles = d.roles || [d.role || 'user'];
        if (!roles.includes('admin')) {
            toast('Access denied. Admin permission required.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1200);
            return;
        }
        await Promise.all([loadConfig(), loadReferrals()]);
    } catch (err) {
        console.error('[AdminReferrals] auth:', err);
        window.location.replace('index.html');
    }
});

/* ═══════ Settings ═══════ */
function paintMaster() {
    const on = $('rEnabled').checked;
    $('rMaster').classList.toggle('on', on);
    $('rMasterState').textContent = on ? 'on' : 'off';
}

/* Percent rewards need an order to take a percent of, so they only make sense for the first-order trigger */
window.onTriggerChange = function () {
    const signup = radio('rTrigger') === 'signup';
    ['rrType', 'reType'].forEach(name => {
        document.querySelectorAll(`input[name="${name}"]`).forEach(el => { if (el.value === 'percent') el.disabled = signup; });
        if (signup) setRadio(name, 'fixed');
    });
    $('rMinOrderWrap').style.display = signup ? 'none' : '';
    $('rTriggerHint').textContent = signup
        ? 'Both the referrer and the friend are paid the moment the code is applied. Only fixed amounts are possible here.'
        : "Both are paid once the friend's first qualifying order is marked Delivered — this protects you from fake sign-ups.";
    window.onTypeChange();
};

window.onTypeChange = function () {
    for (const [p, label] of [['rr', 'referrer'], ['re', 'friend']]) {
        const pct = radio(`${p}Type`) === 'percent';
        $(`${p}Unit`).textContent = pct ? '%' : '₹';
        $(`${p}ValueLabel`).textContent = pct ? "Percent of friend's first order" : 'Amount';
        $(`${p}Value`).max = pct ? '100' : '';
        $(`${p}MaxField`).style.display = pct ? '' : 'none';
        $(`${p}ValueWrap`).classList.toggle('pre', !pct);
    }
};

function fillForm(c) {
    $('rEnabled').checked = !!c.enabled;
    setRadio('rTrigger', c.trigger === 'signup' ? 'signup' : 'first_order');
    setRadio('rrType', c.referrerRewardType === 'percent' ? 'percent' : 'fixed');
    setRadio('reType', c.refereeRewardType === 'percent' ? 'percent' : 'fixed');
    $('rrValue').value = c.referrerRewardValue || '';
    $('rrMax').value   = c.referrerMaxReward || '';
    $('reValue').value = c.refereeRewardValue || '';
    $('reMax').value   = c.refereeMaxReward || '';
    $('rMinFirst').value = c.minFirstOrderValue || '';
    $('rMaxPer').value   = c.maxReferralsPerUser || '';
    $('rNewOnly').checked = c.newUsersOnly !== false;
    paintMaster();
    window.onTriggerChange();
}

async function loadConfig() {
    try {
        const snap = await getDoc(doc(db, 'config', 'referral'));
        const c = snap.exists() ? snap.data() : {};
        fillForm(c);
        if (c.updatedAt?.toDate) {
            $('rSaved').textContent = 'Last saved ' + c.updatedAt.toDate().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        }
    } catch (e) { toast('Could not load settings: ' + e.message, 'error'); }
}

window.onMasterChange = async function () {
    paintMaster();
    const on = $('rEnabled').checked;
    try {
        await setDoc(doc(db, 'config', 'referral'), { enabled: on, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid }, { merge: true });
        toast(on ? 'Referral program turned on' : 'Referral program turned off', 'success');
    } catch (e) {
        $('rEnabled').checked = !on; paintMaster();
        toast('Could not change: ' + e.message, 'error');
    }
};

window.saveReferralConfig = async function (e) {
    e.preventDefault();
    const signup = radio('rTrigger') === 'signup';
    const rrType = signup ? 'fixed' : radio('rrType');
    const reType = signup ? 'fixed' : radio('reType');
    const data = {
        enabled: $('rEnabled').checked,
        trigger: signup ? 'signup' : 'first_order',
        referrerRewardType: rrType, referrerRewardValue: Math.max(0, num($('rrValue').value)),
        referrerMaxReward: rrType === 'percent' ? Math.max(0, num($('rrMax').value)) : 0,
        refereeRewardType: reType, refereeRewardValue: Math.max(0, num($('reValue').value)),
        refereeMaxReward: reType === 'percent' ? Math.max(0, num($('reMax').value)) : 0,
        minFirstOrderValue: signup ? 0 : Math.max(0, num($('rMinFirst').value)),
        maxReferralsPerUser: Math.max(0, Math.floor(num($('rMaxPer').value))),
        newUsersOnly: $('rNewOnly').checked,
    };
    if (rrType === 'percent' && data.referrerRewardValue > 100) { toast('Referrer percent cannot exceed 100.', 'error'); return; }
    if (reType === 'percent' && data.refereeRewardValue > 100) { toast('Friend bonus percent cannot exceed 100.', 'error'); return; }
    if (data.enabled && !(data.referrerRewardValue > 0) && !(data.refereeRewardValue > 0)) {
        toast('Set a reward for the referrer or the friend (or both).', 'error'); return;
    }

    const btn = $('rSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        await setDoc(doc(db, 'config', 'referral'), { ...data, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid }, { merge: true });
        $('rSaved').textContent = 'Saved just now';
        toast('Referral settings saved', 'success');
    } catch (err) {
        toast('Save failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Save settings';
    }
};

/* ═══════ Server calls ═══════ */
async function api(path, body) {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${base()}/api/referral/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

/* generate codes for every existing user, 200 at a time */
window.runBackfill = async function () {
    const btn = $('bfBtn');
    btn.disabled = true;
    $('bfBar').style.display = 'block';
    $('bfFill').style.width = '8%';
    let after = null, processed = 0, generated = 0, rounds = 0;
    try {
        for (;;) {
            const r = await api('admin/backfill', { after });
            processed += r.processed; generated += r.generated; after = r.after; rounds++;
            $('bfStatus').textContent = `Checked ${processed} users · generated ${generated} codes…`;
            $('bfFill').style.width = Math.min(95, 8 + rounds * 12) + '%';
            if (r.done || !after) break;
        }
        $('bfFill').style.width = '100%';
        $('bfStatus').textContent = `Done — checked ${processed} users, generated ${generated} new codes.`;
        toast(`Generated ${generated} referral codes`, 'success');
    } catch (e) {
        $('bfStatus').textContent = `Stopped after ${processed} users: ${e.message}`;
        toast(e.message, 'error');
    } finally {
        btn.disabled = false;
    }
};

/* ═══════ Referral list ═══════ */
let all = [];
let filter = 'all';

export async function loadReferrals() {
    $('rList').innerHTML = `<div class="ab-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>`;
    try {
        const snap = await getDocs(query(collection(db, 'referrals'), orderBy('appliedAt', 'desc'), limit(200)));
        all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const rewarded = all.filter(r => r.status === 'rewarded');
        $('sTotal').textContent    = all.length;
        $('sRewarded').textContent = rewarded.length;
        $('sPending').textContent  = all.filter(r => r.status === 'pending').length;
        $('sPaid').textContent     = inr(all.reduce((s, r) => s + num(r.referrerReward) + num(r.refereeReward), 0));
        renderList();
    } catch (e) {
        $('rList').innerHTML = `<div class="ab-empty">Could not load: ${esc(e.message)}</div>`;
    }
}
window.loadReferrals = loadReferrals;

window.setRefFilter = function (f, btn) {
    filter = f;
    document.querySelectorAll('#rFilters .ab-pill').forEach(b => b.classList.toggle('active', b === btn));
    renderList();
};

function renderList() {
    const list = all.filter(r => filter === 'all' || r.status === filter);
    if (!list.length) { $('rList').innerHTML = `<div class="ab-empty">No referrals here yet.</div>`; return; }
    $('rList').innerHTML = list.map(r => {
        const when = r.appliedAt?.toDate ? r.appliedAt.toDate().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '';
        const paid = num(r.referrerReward) + num(r.refereeReward);
        return `
        <div class="ag-row">
            <div class="ag-row-main">
                <div class="ag-row-title">${esc(r.referrerName || 'User')} → ${esc(r.refereeName || 'User')}</div>
                <div class="ag-row-sub">Code ${esc(r.code)} · ${esc(when)}${paid > 0 ? ` · referrer ${inr(r.referrerReward)} / friend ${inr(r.refereeReward)}` : ''}</div>
            </div>
            <span class="ag-pill ${esc(r.status)}">${esc(r.status)}</span>
            ${r.status === 'pending' ? `<button class="ab-action-btn del" title="Reject this referral" onclick="voidReferral('${esc(r.id)}')"><i class="fa-solid fa-ban"></i></button>` : ''}
        </div>`;
    }).join('');
}

window.voidReferral = async function (refereeUid) {
    if (!confirm('Reject this referral? It will never pay out, and this account cannot use another referral code.')) return;
    try {
        await api('admin/void', { refereeUid });
        toast('Referral rejected', 'success');
        await loadReferrals();
    } catch (e) { toast(e.message, 'error'); }
};
