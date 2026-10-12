/* ═══════════════════════════════════════════════
   MANAGE POSTERS — admin + manage_items
   Firestore: poster_config/main
     { gsmOptions: [{ gsm, extra }], defaultGsm,
       sizes: [{ name, widthIn, heightIn, priceOriginal, priceDiscount, enabled }] }
   Read by custom-poster.js (customize page) and server/pricing.js (order price).
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { doc, getDoc, setDoc, serverTimestamp }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

const PRESETS = [
    { name: 'A4', widthIn: 8.27,  heightIn: 11.69 },
    { name: 'A3', widthIn: 11.69, heightIn: 16.54 },
    { name: 'A2', widthIn: 16.54, heightIn: 23.39 },
    { name: 'A1', widthIn: 23.39, heightIn: 33.11 },
    { name: '12x18', widthIn: 12, heightIn: 18 },
    { name: '18x24', widthIn: 18, heightIn: 24 },
];
const SIZE_NAME = /^[A-Za-z0-9 .x×-]{1,20}$/;
const W = window.WallLayouts;
const PACK_PRESETS = [3, 7, 10, 18, 36];
const PACK_SIZE_DEFAULTS = { A5: { enabled: false, adjustPercent: -30 }, A4: { enabled: true, adjustPercent: 0 },
                             A3: { enabled: false, adjustPercent: 30 }, P13: { enabled: false, adjustPercent: 45 } };

let gsmOptions = [];
let defaultGsm = 0;
let sizes      = [];
let wallLayouts = {};   // key → { enabled, priceOriginal, priceDiscount }
let packSizes   = {};   // A5|A4|A3|P13 → { enabled, adjustPercent }
let packs       = [];   // [{ count, priceOriginal, priceDiscount }] — A4 prices

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toast(msg, type = '') {
    const el = $('mpToast');
    el.textContent = msg;
    el.className = 'mp-toast ' + type;
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

/* ─── Render ─── */
function renderGsm() {
    $('gsmList').innerHTML = gsmOptions.length ? gsmOptions.map((g, i) => `
        <div class="mp-row gsm">
            <div class="mp-field"><label>GSM</label>
                <input type="number" inputmode="numeric" min="50" max="600" value="${esc(g.gsm)}" onchange="setGsm(${i},'gsm',this.value)"></div>
            <div class="mp-field"><label>Extra ₹</label>
                <input type="number" inputmode="decimal" min="0" value="${esc(g.extra)}" onchange="setGsm(${i},'extra',this.value)"></div>
            <label class="mp-default"><input type="radio" name="defGsm" ${Number(g.gsm) === defaultGsm ? 'checked' : ''} onchange="setDefaultGsm(${i})"> Default</label>
            <button class="mp-del" title="Remove" onclick="removeGsm(${i})"><i class="fa-solid fa-trash"></i></button>
        </div>`).join('') : '<div class="mp-empty">No GSM added yet.</div>';
}

function renderSizes() {
    const have = new Set(sizes.map(s => s.name));
    $('presetRow').innerHTML = PRESETS.filter(p => !have.has(p.name))
        .map(p => `<button onclick="addPreset('${p.name}')">+ ${p.name}</button>`).join('');
    $('sizeList').innerHTML = sizes.length ? sizes.map((s, i) => `
        <div class="mp-row size">
            <div class="mp-field full"><label>Size name</label>
                <input type="text" maxlength="20" value="${esc(s.name)}" onchange="setSize(${i},'name',this.value)"></div>
            <div class="mp-field"><label>Width (in)</label>
                <input type="number" inputmode="decimal" min="1" step="0.01" value="${esc(s.widthIn)}" onchange="setSize(${i},'widthIn',this.value)"></div>
            <div class="mp-field"><label>Height (in)</label>
                <input type="number" inputmode="decimal" min="1" step="0.01" value="${esc(s.heightIn)}" onchange="setSize(${i},'heightIn',this.value)"></div>
            <div class="mp-field"><label>Price ₹ (MRP)</label>
                <input type="number" inputmode="decimal" min="0" value="${esc(s.priceOriginal)}" onchange="setSize(${i},'priceOriginal',this.value)"></div>
            <div class="mp-field"><label>Offer price ₹ (optional)</label>
                <input type="number" inputmode="decimal" min="0" value="${esc(s.priceDiscount)}" onchange="setSize(${i},'priceDiscount',this.value)"></div>
            <div class="full actions" style="grid-column:1/-1;">
                <label class="mp-on"><input type="checkbox" ${s.enabled !== false ? 'checked' : ''} onchange="setSize(${i},'enabled',this.checked)"> Available to customers</label>
                <button class="mp-del" title="Remove" onclick="removeSize(${i})"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`).join('') : '<div class="mp-empty">No sizes yet. Add one above.</div>';
}

function renderWall() {
    $('wallList').innerHTML = Object.entries(W.LAYOUTS).map(([k, l]) => {
        const v = wallLayouts[k] || {};
        return `
        <div class="mp-row wall">
            <div class="full">
                <label class="mp-on"><input type="checkbox" ${v.enabled ? 'checked' : ''} onchange="setWall('${k}','enabled',this.checked)"> ${esc(l.name)}</label>
                <small>${W.slotSizes(l).length} posters · ${esc(W.feet(l))}</small>
            </div>
            <div class="mp-field"><label>Price ₹ (MRP)</label>
                <input type="number" inputmode="decimal" min="0" value="${esc(v.priceOriginal ?? '')}" onchange="setWall('${k}','priceOriginal',this.value)"></div>
            <div class="mp-field"><label>Offer price ₹ (optional)</label>
                <input type="number" inputmode="decimal" min="0" value="${esc(v.priceDiscount ?? '')}" onchange="setWall('${k}','priceDiscount',this.value)"></div>
        </div>`;
    }).join('');
}

function renderPacks() {
    $('packSizeList').innerHTML = W.PACK_SIZES.map(s => {
        const v = packSizes[s] || PACK_SIZE_DEFAULTS[s];
        return `
        <div class="mp-row psize">
            <label class="mp-on"><input type="checkbox" ${v.enabled ? 'checked' : ''} onchange="setPackSize('${s}','enabled',this.checked)"> ${esc(W.SIZES[s].label)} posters</label>
            <div class="mp-field"><label>± % vs A4</label>
                <input type="number" inputmode="decimal" min="-90" max="300" ${s === 'A4' ? 'disabled' : ''} value="${esc(v.adjustPercent)}" onchange="setPackSize('${s}','adjustPercent',this.value)"></div>
        </div>`;
    }).join('');
    const have = new Set(packs.map(p => Number(p.count)));
    $('packPresetRow').innerHTML = PACK_PRESETS.filter(n => !have.has(n)).map(n => `<button onclick="addPack(${n})">+ ${n} posters</button>`).join('');
    $('packList').innerHTML = packs.length ? packs.map((p, i) => `
        <div class="mp-row pack">
            <div class="mp-field"><label>Posters</label>
                <input type="number" inputmode="numeric" min="1" max="${W.MAX_SLOTS}" value="${esc(p.count)}" onchange="setPack(${i},'count',this.value)"></div>
            <div class="mp-field"><label>A4 price ₹</label>
                <input type="number" inputmode="decimal" min="0" value="${esc(p.priceOriginal)}" onchange="setPack(${i},'priceOriginal',this.value)"></div>
            <div class="mp-field"><label>Offer ₹</label>
                <input type="number" inputmode="decimal" min="0" value="${esc(p.priceDiscount)}" onchange="setPack(${i},'priceDiscount',this.value)"></div>
            <button class="mp-del" title="Remove" onclick="removePack(${i})"><i class="fa-solid fa-trash"></i></button>
        </div>`).join('') : '<div class="mp-empty">No packs yet — packs are hidden from customers until you add one.</div>';
}

window.setWall = (k, f, v) => {
    wallLayouts[k] = { ...(wallLayouts[k] || {}) };
    wallLayouts[k][f] = f === 'enabled' ? !!v : (v === '' ? '' : Number(v));
};
window.setPackSize = (s, f, v) => {
    packSizes[s] = { ...(packSizes[s] || PACK_SIZE_DEFAULTS[s]) };
    packSizes[s][f] = f === 'enabled' ? !!v : (v === '' ? 0 : Number(v));
};
window.addPack    = n => { packs.push({ count: n || '', priceOriginal: '', priceDiscount: '' }); renderPacks(); };
window.setPack    = (i, f, v) => { packs[i][f] = v === '' ? '' : Number(v); if (f === 'count') renderPacks(); };
window.removePack = i => { packs.splice(i, 1); renderPacks(); };

/* ─── Edit handlers ─── */
window.addGsm = () => { gsmOptions.push({ gsm: '', extra: 0 }); renderGsm(); };
window.setGsm = (i, k, v) => {
    gsmOptions[i][k] = v === '' ? '' : Number(v);
    if (k === 'gsm' && Number(gsmOptions[i].gsm) !== defaultGsm && !gsmOptions.some(g => Number(g.gsm) === defaultGsm)) defaultGsm = 0;
    renderGsm();
};
window.setDefaultGsm = i => { defaultGsm = Number(gsmOptions[i].gsm) || 0; };
window.removeGsm = i => {
    const [g] = gsmOptions.splice(i, 1);
    if (Number(g.gsm) === defaultGsm) defaultGsm = 0;
    renderGsm();
};

window.addSize   = () => { sizes.push({ name: '', widthIn: '', heightIn: '', priceOriginal: '', priceDiscount: '', enabled: true }); renderSizes(); };
window.addPreset = n => { sizes.push({ ...PRESETS.find(p => p.name === n), priceOriginal: '', priceDiscount: '', enabled: true }); renderSizes(); };
window.setSize = (i, k, v) => {
    sizes[i][k] = k === 'name' ? v.trim() : k === 'enabled' ? !!v : (v === '' ? '' : Number(v));
    if (k === 'name') renderSizes();
};
window.removeSize = i => { sizes.splice(i, 1); renderSizes(); };

/* ─── Load / save ─── */
async function load() {
    const snap = await getDoc(doc(db, 'poster_config', 'main'));
    const d = snap.exists() ? snap.data() : {};
    gsmOptions = Array.isArray(d.gsmOptions) ? d.gsmOptions.map(g => ({ gsm: g.gsm, extra: g.extra || 0 })) : [];
    defaultGsm = Number(d.defaultGsm) || 0;
    sizes      = Array.isArray(d.sizes) ? d.sizes.map(s => ({ ...s })) : [];
    wallLayouts = { ...(d.wall?.layouts || {}) };
    packSizes   = { ...PACK_SIZE_DEFAULTS, ...(d.pack?.sizes || {}) };
    packs       = Array.isArray(d.pack?.packs) ? d.pack.packs.map(p => ({ ...p })) : [];
    renderGsm();
    renderSizes();
    renderWall();
    renderPacks();
    if (d.updatedAt?.toDate) $('savedAt').textContent = `Last saved ${d.updatedAt.toDate().toLocaleString('en-IN')}`;
}

window.saveConfig = async function () {
    const gsms = gsmOptions.map(g => ({ gsm: Number(g.gsm), extra: Number(g.extra) || 0 }));
    // GSM only matters for the single custom poster (sizes below).
    if (sizes.length || gsms.length) {
        if (!gsms.length) return toast('Add at least one GSM.', 'error');
        if (gsms.some(g => !(g.gsm >= 50 && g.gsm <= 600) || g.extra < 0)) return toast('Each GSM must be between 50 and 600.', 'error');
        if (new Set(gsms.map(g => g.gsm)).size !== gsms.length) return toast('The same GSM is listed twice.', 'error');
        if (!gsms.some(g => g.gsm === defaultGsm)) return toast('Choose a default GSM.', 'error');
    }

    /* Build your wall */
    const wallOut = {};
    for (const [k, v] of Object.entries(wallLayouts)) {
        if (!W.LAYOUTS[k]) continue;
        const o = Number(v.priceOriginal) || 0, d = Number(v.priceDiscount) || 0;
        if (v.enabled && !(o > 0)) return toast(`Enter a price for ${W.LAYOUTS[k].name} (or untick it).`, 'error');
        if (d && d >= o) return toast(`The offer price of ${W.LAYOUTS[k].name} must be lower than its price.`, 'error');
        if (v.enabled || o > 0) wallOut[k] = { enabled: !!v.enabled, priceOriginal: o, priceDiscount: d };
    }

    /* Poster packs */
    const packSizesOut = {};
    for (const s of W.PACK_SIZES) {
        const v = packSizes[s] || PACK_SIZE_DEFAULTS[s];
        const adj = s === 'A4' ? 0 : Number(v.adjustPercent) || 0;
        if (adj < -90 || adj > 300) return toast(`The ${W.SIZES[s].label} percent must be between -90 and 300.`, 'error');
        packSizesOut[s] = { enabled: !!v.enabled, adjustPercent: adj };
    }
    const packsOut = [];
    for (const p of packs) {
        const n = Number(p.count), o = Number(p.priceOriginal) || 0, d = Number(p.priceDiscount) || 0;
        if (!Number.isInteger(n) || n < 1 || n > W.MAX_SLOTS) return toast(`A pack must have 1 to ${W.MAX_SLOTS} posters.`, 'error');
        if (!(o > 0)) return toast(`Enter a price for the ${n}-poster pack.`, 'error');
        if (d && d >= o) return toast(`The offer price of the ${n}-poster pack must be lower than its price.`, 'error');
        packsOut.push({ count: n, priceOriginal: o, priceDiscount: d });
    }
    if (new Set(packsOut.map(p => p.count)).size !== packsOut.length) return toast('Two packs have the same number of posters.', 'error');
    packsOut.sort((a, b) => a.count - b.count);
    if (packsOut.length && !Object.values(packSizesOut).some(s => s.enabled)) return toast('Tick at least one pack size.', 'error');

    const out = [];
    for (const s of sizes) {
        const name = String(s.name || '').trim();
        if (!SIZE_NAME.test(name)) return toast(`Size name "${name}" is invalid. Use letters, numbers, space, . x - (max 20).`, 'error');
        const w = Number(s.widthIn), h = Number(s.heightIn), o = Number(s.priceOriginal), d = Number(s.priceDiscount) || 0;
        if (!(w > 0 && h > 0)) return toast(`Enter the width and height of ${name}.`, 'error');
        if (s.enabled !== false && !(o > 0)) return toast(`Enter a price for ${name} (or untick "Available").`, 'error');
        if (d && d >= o) return toast(`The offer price of ${name} must be lower than its price.`, 'error');
        out.push({ name, widthIn: w, heightIn: h, priceOriginal: o || 0, priceDiscount: d, enabled: s.enabled !== false });
    }
    if (new Set(out.map(s => s.name)).size !== out.length) return toast('Two sizes have the same name.', 'error');
    const anyWall = Object.values(wallOut).some(v => v.enabled);
    if (!out.some(s => s.enabled && s.priceOriginal > 0) && !anyWall && !packsOut.length) return toast('Add at least one priced size, wall layout or pack.', 'error');

    const btn = $('saveBtn');
    btn.disabled = true;
    try {
        await setDoc(doc(db, 'poster_config', 'main'), {
            gsmOptions: gsms, defaultGsm, sizes: out,
            wall: { layouts: wallOut },
            pack: { sizes: packSizesOut, packs: packsOut },
            updatedAt: serverTimestamp(),
        });
        toast('Saved. Customers see the new prices now.');
        load();
    } catch (e) {
        console.error(e);
        toast('Could not save: ' + (e.code === 'permission-denied' ? 'no permission' : e.message), 'error');
    }
    btn.disabled = false;
};

/* ─── Auth guard: admin or manage_items ─── */
onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace('login.html?redirect=' + encodeURIComponent(location.pathname)); return; }
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        const d = snap.exists() ? snap.data() : {};
        const roles = d.roles || [d.role || 'user'];
        if (!roles.includes('admin') && !roles.includes('manage_items')) { window.location.replace('index.html'); return; }
        await load();
    } catch (e) {
        console.error('[ManagePosters]', e);
        toast('Could not load settings.', 'error');
    }
});
