/* ═══════════════════════════════════════════════
   WALLET SETTINGS — admin-wallet.js  (admin only)
   Firestore: config/wallet (settings), wallet_stats/summary (totals),
              wallets/{uid} + wallets/{uid}/transactions (read-only here)
   Manual credits/debits go through POST /api/wallet/admin/adjust so the
   ledger stays consistent (clients can never write balances).
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import {
    collection, doc, getDoc, getDocs, setDoc, query, where, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { PAYMENT_SERVER_URL } from './env-config.js';
import { normaliseWalletConfig, computeWalletUse, inr, round2, SOURCE_LABEL } from './wallet-client.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = () => (window.__JASA_SERVER || PAYMENT_SERVER_URL).replace(/\/$/, '');

function toast(msg, type = '') {
    const el = $('abToast');
    el.textContent = msg;
    el.className = 'ab-toast' + (type ? ' ' + type : '');
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3200);
}

/* ── Auth guard: admins only (moving money is not delegated to employee roles) ── */
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
        await Promise.all([loadConfig(), loadStats(), loadTop()]);
    } catch (err) {
        console.error('[AdminWallet] auth:', err);
        window.location.replace('index.html');
    }
});

/* ═══════ Settings ═══════ */
let cfg = normaliseWalletConfig({});

function fillForm(c) {
    $('wEnabled').checked   = c.enabled;
    $('wCashbackPct').value = c.cashbackPercent || '';
    $('wMinEarn').value     = c.minOrderForCashback || '';
    $('wMaxEarn').value     = c.maxCashbackPerOrder || '';
    $('wMinBalance').value  = c.minBalanceToUse || '';
    $('wMinOrder').value    = c.minOrderToUse || '';
    $('wMaxUsePct').value   = c.maxUsePercent;
    $('wMaxUseAmt').value   = c.maxUsePerOrder || '';
    $('wProducts').checked  = c.applyToProducts;
    $('wXerox').checked     = c.applyToXerox;
    paintMaster();
    renderCalc();
}

function readForm() {
    const n = id => Math.max(0, parseFloat($(id).value) || 0);
    return normaliseWalletConfig({
        enabled: $('wEnabled').checked,
        cashbackPercent: n('wCashbackPct'), minOrderForCashback: n('wMinEarn'), maxCashbackPerOrder: n('wMaxEarn'),
        minBalanceToUse: n('wMinBalance'), minOrderToUse: n('wMinOrder'),
        maxUsePercent: n('wMaxUsePct'), maxUsePerOrder: n('wMaxUseAmt'),
        applyToProducts: $('wProducts').checked, applyToXerox: $('wXerox').checked,
    });
}

function paintMaster() {
    const on = $('wEnabled').checked;
    $('wMaster').classList.toggle('on', on);
    $('wMasterState').textContent = on ? 'on' : 'off';
}

async function loadConfig() {
    try {
        const snap = await getDoc(doc(db, 'config', 'wallet'));
        cfg = normaliseWalletConfig(snap.exists() ? snap.data() : {});
        fillForm(cfg);
        if (snap.exists() && snap.data().updatedAt?.toDate) {
            $('wSaved').textContent = 'Last saved ' + snap.data().updatedAt.toDate().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        }
    } catch (e) {
        toast('Could not load settings: ' + e.message, 'error');
    }
}

/* the on/off switch saves straight away — it is an operational kill switch */
window.onMasterChange = async function () {
    paintMaster();
    const on = $('wEnabled').checked;
    try {
        await setDoc(doc(db, 'config', 'wallet'), { enabled: on, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid }, { merge: true });
        cfg.enabled = on;
        toast(on ? 'Wallet turned on' : 'Wallet turned off', 'success');
    } catch (e) {
        $('wEnabled').checked = !on; paintMaster();
        toast('Could not change: ' + e.message, 'error');
    }
};

window.saveWalletConfig = async function (e) {
    e.preventDefault();
    const c = readForm();
    if (c.cashbackPercent > 100) { toast('Cashback percent cannot exceed 100.', 'error'); return; }
    if (c.maxUsePercent < 1) { toast('Max usage must be at least 1%.', 'error'); return; }
    if (c.cashbackPercent > 0 && !c.applyToProducts && !c.applyToXerox) { toast('Choose at least one order type.', 'error'); return; }

    const btn = $('wSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        await setDoc(doc(db, 'config', 'wallet'), { ...c, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid }, { merge: true });
        cfg = c;
        $('wSaved').textContent = 'Saved just now';
        toast('Wallet settings saved', 'success');
    } catch (err) {
        toast('Save failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Save settings';
    }
};

/* live preview — same maths the server and checkout use */
window.renderCalc = function () {
    const c = readForm();
    const order = Math.max(0, parseFloat($('wCalcOrder').value) || 0);
    const bal   = Math.max(0, parseFloat($('wCalcBal').value) || 0);

    let earn = 0;
    if (c.cashbackPercent > 0 && order > 0 && order >= c.minOrderForCashback) {
        earn = order * c.cashbackPercent / 100;
        if (c.maxCashbackPerOrder > 0) earn = Math.min(earn, c.maxCashbackPerOrder);
        earn = Math.floor(earn * 100) / 100;
    }
    const use = computeWalletUse({ ...c, enabled: true }, bal, order, 'product');

    $('wCalcEarn').textContent = inr(earn);
    $('wCalcUse').textContent  = inr(use);
    let why = '';
    if (use === 0) {
        if (bal < c.minBalanceToUse) why = `Wallet not usable: balance is below the ${inr(c.minBalanceToUse)} minimum.`;
        else if (order < c.minOrderToUse) why = `Wallet not usable: order is below the ${inr(c.minOrderToUse)} minimum.`;
        else if (order <= 1) why = 'Enter an order value.';
    } else if (use < bal) {
        why = `Limited by ${c.maxUsePerOrder > 0 && use === c.maxUsePerOrder ? 'the per-order cap' : 'the max-usage percentage'}.`;
    }
    $('wCalcWhy').textContent = why;
};
['wCashbackPct', 'wMinEarn', 'wMaxEarn', 'wMinBalance', 'wMinOrder', 'wMaxUsePct', 'wMaxUseAmt'].forEach(id =>
    $(id).addEventListener('input', () => window.renderCalc()));

/* ═══════ Stats ═══════ */
async function loadStats() {
    try {
        const s = (await getDoc(doc(db, 'wallet_stats', 'summary'))).data() || {};
        const cash = s.issued_cashback || 0;
        const ref  = (s.issued_referral_referrer || 0) + (s.issued_referral_referee || 0);
        const adj  = s.issued_admin_adjust || 0;
        const used = s.used || 0;
        $('stCashback').textContent    = inr(cash);
        $('stReferral').textContent    = inr(ref);
        $('stUsed').textContent        = inr(used);
        $('stOutstanding').textContent = inr(cash + ref + adj - used);
    } catch (e) { console.warn('[AdminWallet] stats:', e.message); }
}

/* ═══════ Customer wallets ═══════ */
async function api(path, body) {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${base()}/api/wallet/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

const userLine = u => `${esc(u.fullName || u.email || 'User')}<small style="display:block;font-size:.68rem;color:var(--txt3);">${esc(u.email || '')}${u.mobileNumber ? ' · ' + esc(u.mobileNumber) : ''}${u.userId ? ' · ID ' + esc(u.userId) : ''}</small>`;

window.searchUser = async function () {
    const q = $('uSearch').value.trim();
    if (!q) return;
    $('uResults').innerHTML = `<div class="ab-loading"><i class="fa-solid fa-spinner fa-spin"></i> Searching…</div>`;
    $('uPanel').innerHTML = '';

    const users = collection(db, 'users');
    const tries = [];
    if (q.includes('@')) {
        tries.push(query(users, where('email', '==', q)));
        if (q !== q.toLowerCase()) tries.push(query(users, where('email', '==', q.toLowerCase())));
    } else if (/^\d{10}$/.test(q)) {
        tries.push(query(users, where('mobileNumber', '==', q)));
    } else {
        const U = q.toUpperCase();
        tries.push(query(users, where('userId', '==', U)));
        tries.push(query(users, where('referralCode', '==', U)));
    }

    try {
        const found = new Map();
        for (const t of tries) (await getDocs(t)).forEach(d => found.set(d.id, { id: d.id, ...d.data() }));
        if (!found.size && q.length >= 20) {          // pasted a raw uid
            const s = await getDoc(doc(db, 'users', q));
            if (s.exists()) found.set(s.id, { id: s.id, ...s.data() });
        }
        const list = [...found.values()];
        if (!list.length) { $('uResults').innerHTML = `<div class="ab-empty">No user found.</div>`; return; }
        if (list.length === 1) { $('uResults').innerHTML = ''; openUser(list[0].id, list[0]); return; }
        $('uResults').innerHTML = list.map(u => `
            <div class="ag-row click" onclick="openUser('${esc(u.id)}')">
                <div class="ag-row-main"><div class="ag-row-title">${userLine(u)}</div></div>
                <i class="fa-solid fa-chevron-right" style="color:var(--txt3);"></i>
            </div>`).join('');
    } catch (e) {
        $('uResults').innerHTML = `<div class="ab-empty">Search failed: ${esc(e.message)}</div>`;
    }
};

window.openUser = async function (uid, userDoc) {
    $('uPanel').innerHTML = `<div class="ab-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading wallet…</div>`;
    try {
        const [uSnap, wSnap, tSnap] = await Promise.all([
            userDoc ? Promise.resolve(null) : getDoc(doc(db, 'users', uid)),
            getDoc(doc(db, 'wallets', uid)),
            getDocs(query(collection(db, 'wallets', uid, 'transactions'), orderBy('createdAt', 'desc'), limit(30))),
        ]);
        const u = userDoc || (uSnap.exists() ? uSnap.data() : {});
        const w = wSnap.exists() ? wSnap.data() : {};
        const txns = tSnap.docs.map(d => d.data());
        const initial = (u.fullName || u.email || '?').charAt(0).toUpperCase();

        $('uPanel').innerHTML = `
        <div class="ag-card" style="margin-top:12px;">
            <div class="ag-user-head">
                <div class="ag-avatar">${esc(initial)}</div>
                <div class="ag-row-main"><div class="ag-row-title">${userLine(u)}</div></div>
                <div class="ag-balance"><span>Balance</span><b>${inr(w.balance || 0)}</b></div>
            </div>
            <div class="ag-stats" style="grid-template-columns:1fr 1fr;">
                <div class="ag-stat"><span>Total earned</span><b>${inr(w.totalEarned || 0)}</b></div>
                <div class="ag-stat"><span>Total used</span><b>${inr(w.totalSpent || 0)}</b></div>
            </div>

            <div class="ag-adjust">
                <div class="ab-label" style="margin-bottom:8px;">Manual adjustment</div>
                <div class="ag-grid">
                    <div class="ag-field">
                        <div class="ag-seg">
                            <label><input type="radio" name="adjType" value="credit" checked><span>Add money</span></label>
                            <label><input type="radio" name="adjType" value="debit"><span>Deduct</span></label>
                        </div>
                    </div>
                    <div class="ag-field">
                        <div class="ag-input-wrap pre"><span class="ag-unit">₹</span><input type="number" class="ab-input" id="adjAmount" min="1" step="0.01" placeholder="Amount"></div>
                    </div>
                    <div class="ag-field full">
                        <input type="text" class="ab-input" id="adjNote" maxlength="200" placeholder="Reason (required — shown to the customer)">
                    </div>
                </div>
                <div style="margin-top:10px;text-align:right;">
                    <button class="ab-btn-primary" id="adjBtn" onclick="submitAdjust('${esc(uid)}')">Apply adjustment</button>
                </div>
            </div>

            <div class="ab-label" style="margin:14px 0 4px;">Recent transactions</div>
            ${txns.length ? txns.map(t => {
                const m = SOURCE_LABEL[t.source] || { label: 'Wallet' };
                const plus = t.type === 'credit';
                const when = t.createdAt?.toDate ? t.createdAt.toDate().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
                return `<div class="ag-row">
                    <div class="ag-row-main"><div class="ag-row-title">${esc(m.label)}</div><div class="ag-row-sub">${esc(t.note || '')} · ${esc(when)}</div></div>
                    <div class="ag-row-amt ${plus ? 'ag-plus' : 'ag-minus'}">${plus ? '+' : '−'}${inr(t.amount)}<small>Bal ${inr(t.balanceAfter)}</small></div>
                </div>`;
            }).join('') : `<div class="ab-empty" style="padding:14px;">No transactions yet.</div>`}
        </div>`;
    } catch (e) {
        $('uPanel').innerHTML = `<div class="ab-empty">Could not load wallet: ${esc(e.message)}</div>`;
    }
};

window.submitAdjust = async function (uid) {
    const type = document.querySelector('input[name="adjType"]:checked')?.value || 'credit';
    const amt  = round2(parseFloat($('adjAmount').value));
    const note = $('adjNote').value.trim();
    if (!(amt > 0)) { toast('Enter an amount greater than 0.', 'error'); return; }
    if (!note) { toast('A reason is required.', 'error'); return; }
    if (!confirm(`${type === 'credit' ? 'Add' : 'Deduct'} ${inr(amt)} ${type === 'credit' ? 'to' : 'from'} this wallet?`)) return;

    const btn = $('adjBtn');
    btn.disabled = true;
    try {
        await api('admin/adjust', { uid, amount: type === 'credit' ? amt : -amt, note });
        toast('Wallet updated', 'success');
        await Promise.all([window.openUser(uid), loadStats(), loadTop()]);
    } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false;
    }
};

/* ═══════ Highest balances ═══════ */
export async function loadTop() {
    $('uTop').innerHTML = `<div class="ab-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>`;
    try {
        const snap = await getDocs(query(collection(db, 'wallets'), orderBy('balance', 'desc'), limit(15)));
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(w => (w.balance || 0) > 0);
        if (!rows.length) { $('uTop').innerHTML = `<div class="ab-empty">No wallet balances yet.</div>`; return; }
        const users = await Promise.all(rows.map(w => getDoc(doc(db, 'users', w.id)).then(s => s.exists() ? s.data() : {}).catch(() => ({}))));
        $('uTop').innerHTML = rows.map((w, i) => `
            <div class="ag-row click" onclick="openUser('${esc(w.id)}')">
                <div class="ag-row-main"><div class="ag-row-title">${userLine(users[i])}</div></div>
                <div class="ag-row-amt ag-plus">${inr(w.balance)}</div>
            </div>`).join('');
    } catch (e) {
        $('uTop').innerHTML = `<div class="ab-empty">Could not load: ${esc(e.message)}</div>`;
    }
}
window.loadTop = loadTop;
