/* ═══════════════════════════════════════════════
   JASA V2 — refer.js  (Refer a Friend page)
   Everything comes from GET /api/referral/me, which also creates the
   user's code the first time (so existing users get one automatically).
   ═══════════════════════════════════════════════ */
import { auth } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { PAYMENT_SERVER_URL } from './env-config.js';
import { inr } from './wallet-client.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = () => (window.__JASA_SERVER || PAYMENT_SERVER_URL).replace(/\/$/, '');

let me = null;         // GET /api/referral/me response
let currentUser = null;

function toast(msg) {
    const el = $('wlToast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

async function api(path, opts = {}) {
    const idToken = await currentUser.getIdToken();
    const res = await fetch(`${base()}/api/referral/${path}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

onAuthStateChanged(auth, async user => {
    currentUser = user;
    if (!user) {
        $('rfGuest').style.display = 'block';
        $('rfContent').style.display = 'none';
        return;
    }
    $('rfGuest').style.display = 'none';
    $('rfContent').style.display = 'block';
    await load();
});

async function load() {
    try {
        me = await api('me');
    } catch (e) {
        toast(e.message || 'Could not load your referral details.');
        return;
    }
    /* keep the sidebar/profile cache in step */
    try {
        const raw = localStorage.getItem('jasa_user_cache');
        if (raw) { const c = JSON.parse(raw); c.referralCode = me.code; localStorage.setItem('jasa_user_cache', JSON.stringify(c)); }
    } catch (_) {}
    render();
}

/* "₹50" or "10% of their first order (up to ₹100)" */
function rewardText(type, value, max, who) {
    if (!(value > 0)) return '';
    return type === 'percent'
        ? `${value}% of ${who} first order${max > 0 ? ` (up to ${inr(max)})` : ''}`
        : inr(value);
}

function render() {
    const c = me.config;
    $('rfCode').textContent = me.code;
    $('rfOff').style.display = c.enabled ? 'none' : 'flex';

    const youGet   = rewardText(c.referrerRewardType, c.referrerRewardValue, c.referrerMaxReward, 'their');
    const theyGet  = rewardText(c.refereeRewardType,  c.refereeRewardValue,  c.refereeMaxReward,  'their');
    $('rfPitch').textContent = c.enabled && (youGet || theyGet)
        ? `${youGet ? `Earn ${youGet} in your wallet` : 'Share the love'}${theyGet ? `, and your friend gets ${theyGet}` : ''}.`
        : 'Share your code with friends and earn wallet money.';

    const when = c.trigger === 'signup'
        ? 'as soon as they add your code'
        : `after their first order${c.minFirstOrderValue > 0 ? ` of ${inr(c.minFirstOrderValue)} or more` : ''} is delivered`;
    $('rfSteps').innerHTML = [
        'Share your referral code (or link) with a friend.',
        'Your friend signs up and enters your code — each account can use a code only <b>once</b>.',
        c.enabled
            ? `Rewards land in both wallets ${when}${youGet ? ` — you get <b>${youGet}</b>` : ''}${theyGet ? `, they get <b>${theyGet}</b>` : ''}.`
            : 'Rewards are added to both wallets once the program is active.',
        'Use wallet money to pay for your next orders.',
    ].map(s => `<li>${s}</li>`).join('');

    const s = me.summary;
    $('rfTotal').textContent    = s.total;
    $('rfRewarded').textContent = s.rewarded;
    $('rfPending').textContent  = s.pending;
    $('rfEarned').textContent   = inr(s.earned);

    $('rfFriends').innerHTML = s.friends.length ? s.friends.map(f => `
        <div class="rf-friend">
            <div class="rf-friend-avatar">${esc(f.name.charAt(0).toUpperCase())}</div>
            <div class="rf-friend-body">
                <div class="rf-friend-name">${esc(f.name)}</div>
                <div class="rf-friend-date">${f.at ? new Date(f.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}</div>
            </div>
            <span class="rf-pill rf-pill-${f.status === 'rewarded' ? 'ok' : 'wait'}">
                ${f.status === 'rewarded' ? (f.reward > 0 ? `+${inr(f.reward)}` : 'Done') : 'Pending'}
            </span>
        </div>`).join('') : `<div class="wl-empty-mini">No one has used your code yet.</div>`;

    $('rfApplyCard').style.display = me.canApply ? 'block' : 'none';
    $('rfUsedCard').style.display  = me.usedCode ? 'block' : 'none';
    if (me.usedCode) {
        $('rfUsed').innerHTML = `You joined with code <b>${esc(me.usedCode.code)}</b> — ` +
            (me.usedCode.status === 'rewarded' ? 'your welcome bonus has been paid.' : 'your bonus will be added once the conditions are met.');
    }
}

/* ── Sharing ── */
const shareLink = () => new URL(`login.html?ref=${encodeURIComponent(me.code)}`, window.location.href).href;
const shareText = () => `Join me on JASA Essential — order stationery, books and xerox prints with ease! Use my referral code ${me.code} when you sign up: ${shareLink()}`;

window.copyCode = async function () {
    if (!me) return;
    try { await navigator.clipboard.writeText(me.code); toast('Referral code copied!'); }
    catch (_) { toast(`Your code: ${me.code}`); }
};
window.shareWhatsApp = function () {
    if (!me) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText())}`, '_blank', 'noopener');
};
window.shareNative = async function () {
    if (!me) return;
    if (navigator.share) {
        try { await navigator.share({ title: 'JASA Essential', text: shareText() }); } catch (_) {}
    } else {
        try { await navigator.clipboard.writeText(shareText()); toast('Invite message copied!'); }
        catch (_) { toast(shareLink()); }
    }
};

/* ── Enter a friend's code ── */
window.applyCode = async function () {
    const input = $('rfApplyInput'), btn = $('rfApplyBtn');
    const code = input.value.trim().toUpperCase();
    if (!code) { toast('Enter a referral code.'); return; }
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
        const r = await api('apply', { method: 'POST', body: JSON.stringify({ code }) });
        toast(r.reward?.refereeReward > 0 ? `Code applied! ${inr(r.reward.refereeReward)} added to your wallet.` : 'Referral code applied!');
        input.value = '';
        await load();
    } catch (e) {
        toast(e.message);
    } finally {
        btn.disabled = false; btn.textContent = 'Apply';
    }
};
