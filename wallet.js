/* ═══════════════════════════════════════════════
   JASA V2 — wallet.js  (customer wallet page)
   Reads: config/wallet, wallets/{uid}, wallets/{uid}/transactions
   Writes nothing — all money movement is done by the Node server.
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { collection, doc, getDoc, getDocs, query, orderBy, limit }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { loadWalletConfig, syncWallet, inr, SOURCE_LABEL } from './wallet-client.js';


const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let txns = [];
let filter = 'all';

function toast(msg) {
    const el = $('wlToast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3500);
}

onAuthStateChanged(auth, async user => {
    if (!user) {
        $('wlGuest').style.display = 'block';
        $('wlContent').style.display = 'none';
        return;
    }
    $('wlGuest').style.display = 'none';
    $('wlContent').style.display = 'block';

    /* let the server credit anything that is due (cashback, refunds, referral rewards) first */
    const sync = await syncWallet(user, { force: true });
    if (sync?.cashback > 0) toast(`${inr(sync.cashback)} cashback added to your wallet 🎉`);
    else if (sync?.refunded > 0) toast(`${inr(sync.refunded)} returned to your wallet`);
    else if (sync?.referral) toast('Referral reward added to your wallet 🎉');

    const cfg = await loadWalletConfig(true);
    renderRules(cfg);
    await Promise.all([loadBalance(user), loadTxns(user)]);
    loadReferralHint(user);
});

async function loadBalance(user) {
    try {
        const snap = await getDoc(doc(db, 'wallets', user.uid));
        const w = snap.exists() ? snap.data() : {};
        $('wlBalance').textContent = inr(w.balance || 0);
        $('wlEarned').textContent  = inr(w.totalEarned || 0);
        $('wlSpent').textContent   = inr(w.totalSpent || 0);
    } catch (e) {
        console.warn('[wallet] balance:', e.message);
        $('wlBalance').textContent = '—';
    }
}

async function loadTxns(user) {
    try {
        const snap = await getDocs(query(
            collection(db, 'wallets', user.uid, 'transactions'), orderBy('createdAt', 'desc'), limit(50)));
        txns = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.warn('[wallet] txns:', e.message);
        $('wlTxns').innerHTML = `<div class="wl-empty-mini">Could not load transactions.</div>`;
        return;
    }
    renderTxns();
}

function renderRules(cfg) {
    $('wlOff').style.display = cfg.enabled ? 'none' : 'flex';
    const rules = [];
    if (cfg.enabled) {
        if (cfg.cashbackPercent > 0) {
            rules.push(`<b>Earn ${cfg.cashbackPercent}% cashback</b> on every delivered order` +
                (cfg.minOrderForCashback > 0 ? ` of ${inr(cfg.minOrderForCashback)} or more` : '') +
                (cfg.maxCashbackPerOrder > 0 ? ` (up to ${inr(cfg.maxCashbackPerOrder)} per order)` : '') + '.');
        }
        rules.push(`<b>Pay with your wallet</b> at checkout — up to ${cfg.maxUsePercent}% of an order` +
            (cfg.maxUsePerOrder > 0 ? `, maximum ${inr(cfg.maxUsePerOrder)} per order` : '') + '.');
        if (cfg.minOrderToUse > 0) rules.push(`Wallet can be used on orders of <b>${inr(cfg.minOrderToUse)}</b> or more.`);
        if (cfg.minBalanceToUse > 0) rules.push(`You need at least <b>${inr(cfg.minBalanceToUse)}</b> in your wallet to use it.`);
        const where = [cfg.applyToProducts && 'product orders', cfg.applyToXerox && 'xerox orders'].filter(Boolean);
        if (where.length) rules.push(`Works on ${where.join(' and ')}.`);
        rules.push('Delivery charges are not covered by cashback.');
    }
    $('wlRulesCard').style.display = rules.length ? 'block' : 'none';
    $('wlRules').innerHTML = rules.map(r => `<li>${r}</li>`).join('');
}

/* show the live referral reward in the banner, if the program is on */
async function loadReferralHint(user) {
    try {
        const snap = await getDoc(doc(db, 'config', 'referral'));
        const c = snap.exists() ? snap.data() : {};
        if (c.enabled && Number(c.referrerRewardValue) > 0) {
            $('wlReferSub').textContent = c.referrerRewardType === 'percent'
                ? `Earn ${c.referrerRewardValue}% of your friend's first order`
                : `Earn ${inr(c.referrerRewardValue)} for every friend who joins`;
        }
    } catch (_) { /* keep the default text */ }
}

window.setTxnFilter = function (f, btn) {
    filter = f;
    document.querySelectorAll('#wlTabs button').forEach(b => b.classList.toggle('active', b === btn));
    renderTxns();
};

function fmtDate(t) {
    const d = t?.toDate ? t.toDate() : null;
    return d ? d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function renderTxns() {
    const list = txns.filter(t => filter === 'all' || (filter === 'in' ? t.type === 'credit' : t.type === 'debit'));
    if (!list.length) {
        $('wlTxns').innerHTML = `<div class="wl-empty-mini">${txns.length ? 'Nothing here yet.' : 'No transactions yet. Cashback and rewards will show up here.'}</div>`;
        return;
    }
    $('wlTxns').innerHTML = list.map(t => {
        const meta = SOURCE_LABEL[t.source] || { label: 'Wallet', icon: 'fa-solid fa-wallet', tone: t.type === 'credit' ? 'in' : 'out' };
        const plus = t.type === 'credit';
        return `
        <div class="wl-txn">
            <div class="wl-txn-icon wl-tone-${plus ? 'in' : 'out'}"><i class="${meta.icon}"></i></div>
            <div class="wl-txn-body">
                <div class="wl-txn-title">${esc(meta.label)}</div>
                <div class="wl-txn-note">${esc(t.note || '')}</div>
                <div class="wl-txn-date">${esc(fmtDate(t.createdAt))}</div>
            </div>
            <div class="wl-txn-amt">
                <b class="wl-tone-${plus ? 'in' : 'out'}">${plus ? '+' : '−'}${inr(t.amount)}</b>
                <span>Bal ${inr(t.balanceAfter)}</span>
            </div>
        </div>`;
    }).join('');
}
