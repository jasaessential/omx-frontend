/* ═══════════════════════════════════════════════
   JASA V2 — custom-poster.js
   "Customize" wall poster: pick a size (and GSM), upload a picture, move /
   zoom / rotate it to fit the poster shape, then add it to the cart.

   Prices, sizes and GSM come from Firestore poster_config/main (managed in
   manage-posters.html); the server prices the order again from the same doc.

   Two files go to the private Supabase bucket (same route as xerox files):
     customPhoto   — the picture exactly as the customer chose it
     customPreview — the fitted canvas (what to print)
   ═══════════════════════════════════════════════ */
import { db, auth } from './firebase-init.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getUploadTarget } from './secure-files.js';

const CART_KEY    = 'jasa_cart';
const MAX_FILE    = 25 * 1024 * 1024;
const EXPORT_LONG = 2400;   // px on the long side of the fitted image
const MAX_ZOOM    = 5;

const $ = id => document.getElementById(id);

let currentUser = null;
onAuthStateChanged(auth, u => { currentUser = u; });

/* ── State ── */
let cfg = { sizes: [], gsmOptions: [], defaultGsm: 0 };
let sel = { size: '', gsm: 0, landscape: false };
let file = null;        // the original File
let img  = null;        // decoded HTMLImageElement
let view = { rot90: 0, fine: 0, zoom: 1, x: 0, y: 0 };   // x, y: offset as a fraction of the canvas
let busy = false;

const canvas = $('cpCanvas');
const ctx    = canvas.getContext('2d');

/* ════════ Config ════════ */
async function loadConfig() {
    try {
        const snap = await getDoc(doc(db, 'poster_config', 'main'));
        const d = snap.exists() ? snap.data() : {};
        cfg.sizes      = (d.sizes || []).filter(s => s && s.enabled !== false && Number(s.priceOriginal) > 0);
        cfg.gsmOptions = (d.gsmOptions || []).filter(g => Number(g.gsm) > 0);
        cfg.defaultGsm = Number(d.defaultGsm) || cfg.gsmOptions[0]?.gsm || 0;
    } catch (e) { console.error('poster config:', e); }

    $('cpLoading').style.display = 'none';
    if (!cfg.sizes.length || !cfg.gsmOptions.length) { $('cpUnavailable').style.display = ''; return; }
    $('cpBody').style.display = '';
    sel.size = cfg.sizes[0].name;
    sel.gsm  = cfg.gsmOptions.some(g => Number(g.gsm) === cfg.defaultGsm) ? cfg.defaultGsm : Number(cfg.gsmOptions[0].gsm);
    renderOptions();
}

const sizeOf = () => cfg.sizes.find(s => s.name === sel.size);
const gsmOf  = () => cfg.gsmOptions.find(g => Number(g.gsm) === sel.gsm);

/** Price of a size with the selected GSM (same rule as server/pricing.js) */
function priceOf(size, gsm) {
    const extra = Number(gsm?.extra) || 0;
    const o = Number(size.priceOriginal) + extra;
    const d = Number(size.priceDiscount) > 0 ? Number(size.priceDiscount) + extra : 0;
    const hasDisc = d > 0 && d < o;
    return { o, price: hasDisc ? d : o, hasDisc, disc: hasDisc ? Math.round((o - d) / o * 100) : 0 };
}
const inr = n => `₹${n.toLocaleString('en-IN')}`;
const fmtIn = n => String(Math.round(n * 100) / 100);

function renderOptions() {
    $('cpSizes').innerHTML = cfg.sizes.map(s => {
        const p = priceOf(s, gsmOf());
        return `<button type="button" class="cp-size${s.name === sel.size ? ' active' : ''}" data-size="${esc(s.name)}">
            <b>${esc(s.name)}</b><small>${fmtIn(s.widthIn)} × ${fmtIn(s.heightIn)} in</small><em>${inr(p.price)}</em></button>`;
    }).join('');
    $('cpSizes').querySelectorAll('.cp-size').forEach(b => b.onclick = () => { sel.size = b.dataset.size; renderOptions(); resizeCanvas(); });

    $('cpGsmSection').style.display = cfg.gsmOptions.length > 1 ? '' : 'none';
    $('cpGsm').innerHTML = cfg.gsmOptions.map(g => {
        const gv = Number(g.gsm), ex = Number(g.extra) || 0;
        return `<button type="button" class="id-tag id-tag-size${gv === sel.gsm ? ' active' : ''}" data-gsm="${gv}">
            <i class="fa-solid fa-scroll"></i>${gv} GSM${gv === cfg.defaultGsm ? ' (standard)' : ''}${ex > 0 ? ` +${inr(ex)}` : ''}</button>`;
    }).join('');
    $('cpGsm').querySelectorAll('button').forEach(b => b.onclick = () => { sel.gsm = Number(b.dataset.gsm); renderOptions(); });

    document.querySelectorAll('#cpOrient button').forEach(b => b.classList.toggle('active', (b.dataset.o === 'landscape') === sel.landscape));
    renderPrice();
}

function renderPrice() {
    const s = sizeOf();
    if (!s) return;
    const p = priceOf(s, gsmOf());
    $('cpSummary').textContent = `${s.name} · ${fmtIn(sel.landscape ? s.heightIn : s.widthIn)} × ${fmtIn(sel.landscape ? s.widthIn : s.heightIn)} in · ${sel.gsm} GSM`;
    $('cpPrice').textContent = inr(p.price);
    $('cpPriceOrig').textContent = inr(p.o);
    $('cpPriceDisc').textContent = `${p.disc}% OFF`;
    $('cpPriceOrig').style.display = $('cpPriceDisc').style.display = p.hasDisc ? '' : 'none';
}

document.querySelectorAll('#cpOrient button').forEach(b => b.onclick = () => {
    sel.landscape = b.dataset.o === 'landscape';
    renderOptions(); resizeCanvas();
});

/* ════════ Editor ════════ */
function aspect() {
    const s = sizeOf();
    const w = Number(s.widthIn), h = Number(s.heightIn);
    return sel.landscape ? h / w : w / h;     // canvas width / height
}

/** Shape the canvas like the chosen poster; keep resolution crisp on phones. */
function resizeCanvas() {
    if (!img || !sizeOf()) return;
    const cssW = canvas.clientWidth || 340;
    const dpr  = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssW * dpr / aspect());
    syncZoomRange();
    draw(ctx, canvas.width, canvas.height);
}

/** Geometry shared by the preview and the exported image. */
function metrics(W, H) {
    const swap = view.rot90 % 2 !== 0;
    const iw = swap ? img.naturalHeight : img.naturalWidth;
    const ih = swap ? img.naturalWidth  : img.naturalHeight;
    return { cover: Math.max(W / iw, H / ih), contain: Math.min(W / iw, H / ih) };
}

function minZoom() {
    const { cover, contain } = metrics(canvas.width, canvas.height);
    return Math.min(1, contain / cover);
}

function draw(c, W, H) {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, W, H);
    if (!img) return;
    const { cover } = metrics(W, H);
    const s = cover * view.zoom;
    c.save();
    c.translate(W / 2 + view.x * W, H / 2 + view.y * H);
    c.rotate((view.rot90 * 90 + view.fine) * Math.PI / 180);
    c.scale(s, s);
    c.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    c.restore();
}

function syncZoomRange() {
    const lo = Math.max(0.05, Math.floor(minZoom() * 100) / 100);
    $('cpZoom').min = lo;
    view.zoom = Math.min(MAX_ZOOM, Math.max(lo, view.zoom));
    $('cpZoom').value = view.zoom;
}

function redraw() { draw(ctx, canvas.width, canvas.height); }

function resetView() {
    view = { rot90: 0, fine: 0, zoom: 1, x: 0, y: 0 };
    $('cpAngle').value = 0; $('cpAngleVal').textContent = '0°';
    syncZoomRange(); redraw();
}

function setZoom(z) {
    const lo = Number($('cpZoom').min);
    view.zoom = Math.min(MAX_ZOOM, Math.max(lo, z));
    $('cpZoom').value = view.zoom;
    redraw();
}

$('cpZoom').oninput  = e => setZoom(Number(e.target.value));
$('cpAngle').oninput = e => { view.fine = Number(e.target.value); $('cpAngleVal').textContent = `${view.fine}°`; redraw(); };
$('cpRotL').onclick  = () => { view.rot90 = (view.rot90 + 3) % 4; syncZoomRange(); redraw(); };
$('cpRotR').onclick  = () => { view.rot90 = (view.rot90 + 1) % 4; syncZoomRange(); redraw(); };
$('cpReset').onclick = resetView;
window.addEventListener('resize', () => { if (img) resizeCanvas(); });

/* Drag to move, pinch / wheel to zoom */
const pointers = new Map();
let pinchDist = 0;
canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinchDist = dist();
});
canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p || !img) return;
    const rect = canvas.getBoundingClientRect();
    if (pointers.size === 1) {
        view.x = clamp(view.x + (e.clientX - p.x) / rect.width,  -1, 1);
        view.y = clamp(view.y + (e.clientY - p.y) / rect.height, -1, 1);
        Object.assign(p, { x: e.clientX, y: e.clientY });
        redraw();
    } else {
        Object.assign(p, { x: e.clientX, y: e.clientY });
        const d = dist();
        if (pinchDist > 0 && d > 0) setZoom(view.zoom * d / pinchDist);
        pinchDist = d;
    }
});
const endPointer = e => { pointers.delete(e.pointerId); pinchDist = pointers.size === 2 ? dist() : 0; };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', e => { e.preventDefault(); setZoom(view.zoom * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

function dist() {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ════════ Choose a picture ════════ */
$('cpFile').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return say('Please choose an image file (JPG, PNG…).', 'err');
    if (f.size > MAX_FILE) return say('This picture is over 25 MB. Please choose a smaller one.', 'err');

    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
        file = f; img = im;
        $('cpUploadBox').style.display = 'none';
        $('cpEditor').style.display = '';
        say('');
        resizeCanvas();
        resetView();
    };
    im.onerror = () => { URL.revokeObjectURL(url); say('This picture could not be opened. Try another one (JPG or PNG).', 'err'); };
    im.src = url;
};

function say(msg, cls = '') { const el = $('cpStatus'); el.textContent = msg; el.className = `id-upload-status ${cls}`; }

/* ════════ Add to cart ════════ */
function toBlob(c, type, q) { return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Could not create the image')), type, q)); }

/** The fitted picture at print resolution (long side EXPORT_LONG px). */
async function renderFitted() {
    const a = aspect();
    const W = a >= 1 ? EXPORT_LONG : Math.round(EXPORT_LONG * a);
    const H = a >= 1 ? Math.round(EXPORT_LONG / a) : EXPORT_LONG;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    draw(c.getContext('2d'), W, H);
    return { blob: await toBlob(c, 'image/jpeg', 0.92) };
}

async function putFile(name, blob, type) {
    const target = await getUploadTarget('poster', name);
    const res = await fetch(target.uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return target.fileUrl;
}

function thumbnail() {
    const c = document.createElement('canvas');
    c.width = 160; c.height = Math.round(160 / aspect());
    draw(c.getContext('2d'), c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
}

async function buildLine() {
    if (!currentUser) { toast('Please sign in to continue.', 'error'); setTimeout(() => location.href = 'login.html', 1200); return null; }
    if (!img || !file) { toast('Please upload your picture first.', 'error'); return null; }
    if (busy) return null;
    busy = true;
    document.body.classList.add('cp-busy');
    say('Uploading your poster…');
    try {
        const s   = sizeOf();
        const tag = `g${sel.gsm}-${Date.now().toString(36)}`;
        const base = `${tag}_${s.name.replace(/[^A-Za-z0-9]/g, '')}`;
        const { blob } = await renderFitted();
        const ext = (file.name.match(/\.[A-Za-z0-9]{1,5}$/) || ['.jpg'])[0];
        const [original, fitted] = await Promise.all([
            putFile(`${base}_original${ext}`, file, file.type),
            putFile(`${base}_fitted.jpg`, blob, 'image/jpeg'),
        ]);
        say('Uploaded.', 'ok');
        const p = priceOf(s, gsmOf());
        return {
            id: `custom-poster__${s.name}__${tag}`,
            baseId: 'custom-poster', size: s.name, gsm: sel.gsm,
            name: `Custom Poster (${s.name}, ${sel.gsm} GSM)`,
            price: p.price, originalPrice: p.o, discountPercent: p.disc,
            img: thumbnail(), category: 'posters', customPoster: true,
            customPhoto: original, customPreview: fitted,
            customNote: $('cpNote').value.trim().slice(0, 300),
            customLayout: { rotate: view.rot90 * 90 + view.fine, zoom: +view.zoom.toFixed(3), x: +view.x.toFixed(4), y: +view.y.toFixed(4), landscape: sel.landscape },
        };
    } catch (e) {
        console.error(e);
        say(`Upload failed (${e.message}). Please try again.`, 'err');
        return null;
    } finally {
        busy = false;
        document.body.classList.remove('cp-busy');
    }
}

function addLine(line) {
    let cart = [];
    try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch (_) {}
    cart.push({ ...line, qty: 1 });
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateBadge(cart);
    window.dispatchEvent(new CustomEvent('cartUpdated', { detail: cart }));
}

$('cpAddCart').onclick = async () => {
    const line = await buildLine();
    if (!line) return;
    addLine(line);
    toast('Custom poster added to cart!');
};
$('cpBuyNow').onclick = async () => {
    const line = await buildLine();
    if (!line) return;
    addLine(line);
    location.href = 'cart.html';
};

/* ════════ Helpers ════════ */
function updateBadge(cart) {
    let c = cart;
    if (!c) { try { c = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch (_) { c = []; } }
    const total = c.reduce((s, i) => s + (i.qty || 0), 0);
    const badge = $('cartBadge');
    badge.textContent = total;
    badge.style.display = total > 0 ? 'flex' : 'none';
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

let toastTimer;
function toast(msg, type = 'success') {
    const el = $('idToast');
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.className = `id-toast ${type}`;
    el.classList.add('show');
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

updateBadge();
loadConfig();
