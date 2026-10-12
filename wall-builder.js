/* ═══════════════════════════════════════════════
   JASA V2 — wall-builder.js
   Build Your Wall (?mode=wall) and Mix & Match poster pack (?mode=pack):
   pick a layout / pack, then fill every spot with a Wall Posters design or
   the customer's own photo (cropped here to the exact poster size).

   Layouts, sizes and prices: wall-layouts.js + Firestore poster_config/main
   (Poster Setup page). server/pricing.js prices the line again at checkout.
   Photos go to the private Supabase bucket (kind 'poster').
   ═══════════════════════════════════════════════ */
import { db, auth } from './firebase-init.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getUploadTarget } from './secure-files.js';

const W          = window.WallLayouts;
const MODE       = new URLSearchParams(location.search).get('mode') === 'pack' ? 'pack' : 'wall';
const IS_WALL    = MODE === 'wall';
const WORKER_URL = 'https://jasa-backend-worker.jasaessential3.workers.dev';
const CART_KEY   = 'jasa_cart';
const SAVE_KEY   = `jasa_wall_${MODE}`;
const MAX_FILE   = 50 * 1024 * 1024;
const MAX_CANVAS = 16000000;   // iOS Safari canvas limit (pixels)

const $   = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inr = n => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/* ── State ── */
let cfg = {};
let user = null;
let designs = [];                 // Wall Posters items usable as designs
let sel = { layout: null, size: null, pack: null, arrangement: 'grid' };
let sizes = [];                   // poster size of every spot
let fills = [];                   // null | { design } | { photo }
let active = null;                // spot being filled in the picker
let pickerTab = '';
let seq = 0;

onAuthStateChanged(auth, u => { user = u; renderPickerHead(); });

/* ════════ Load ════════ */
async function load() {
    $('wbTitle').textContent = IS_WALL ? 'Build Your Wall' : 'Mix & Match Posters';
    document.title = `${IS_WALL ? 'Build Your Wall' : 'Mix & Match Posters'} — JASA Essential`;
    try {
        const snap = await getDoc(doc(db, 'poster_config', 'main'));
        cfg = snap.exists() ? snap.data() : {};
    } catch (e) { console.error('poster config:', e); }

    const layouts = W.enabledLayouts(cfg);
    const packSizes = W.enabledPackSizes(cfg);
    $('wbLoading').style.display = 'none';
    if (IS_WALL ? !layouts.length : !packSizes.length) {
        $('wbUnavailable').style.display = '';
        $('wbUnavailableText').textContent = IS_WALL
            ? 'Build Your Wall is not available right now. Please check back soon.'
            : 'Poster packs are not available right now. Please check back soon.';
        return;
    }
    if (IS_WALL) sel.layout = layouts[0];
    else {
        sel.size = packSizes.includes('A4') ? 'A4' : packSizes[0];
        const packs = W.enabledPacks(cfg, sel.size);
        sel.pack = packs.includes(7) ? 7 : packs[0];
    }
    restoreSaved();
    $('wbBody').style.display = '';
    $('wbBottom').style.display = '';
    $('wbIntro').innerHTML = `<p>${IS_WALL
        ? 'Pick a wall layout, then fill every spot with our posters or your own photos. Sizes are matched for you — every poster ships ready to arrange like the preview.'
        : 'Choose a size and a pack, then pick every poster or add your own photos. Bigger packs cost less per poster.'}</p>`;
    applySizes();
    loadDesigns();
}

async function loadDesigns() {
    let items = [];
    try {
        const res = await fetch(`${WORKER_URL}/api/items?category=posters`, { cache: 'no-cache' });
        if (res.ok) items = (await res.json()).items || [];
    } catch (e) { console.warn('[wall] designs:', e.message); }
    if (!items.length) {
        try { items = JSON.parse(sessionStorage.getItem('jasa_v2_cat_posters') || '{}').data || []; } catch (_) {}
    }
    designs = items
        .filter(i => !i.customUpload && primaryImg(i))
        .map(i => ({ id: i.id, name: i.name || '', img: primaryImg(i), theme: (i.brands || [])[0] || '' }));
    if (!$('wbPicker').hidden) renderPicker();
}
const primaryImg = i => (i.images || []).find(x => x?.isPrimary)?.url || (i.images || [])[0]?.url || i.img || i.imageUrl || '';

/* ════════ Spots ════════ */
function currentLayout() {
    if (IS_WALL) return sel.layout ? W.LAYOUTS[sel.layout] : null;
    return sel.size && sel.pack ? W.packLayout(sel.arrangement, sel.size, sel.pack) : null;
}

/** Keeps the spots in step with the chosen layout / pack (fills carry over in order). */
function applySizes() {
    if (!IS_WALL && sel.size && sel.pack && !W.arrangementsFor(sel.size, sel.pack).includes(sel.arrangement)) sel.arrangement = 'grid';
    const next = IS_WALL ? W.slotSizes(W.LAYOUTS[sel.layout]) : Array.from({ length: sel.pack }, () => sel.size);
    const old = fills;
    const dropped = old.slice(next.length).filter(Boolean).length;
    sizes = next;
    fills = next.map((_, i) => old[i] || null);
    next.forEach((size, i) => {
        const p = fills[i]?.photo;
        if (!p || p.size === size) return;
        if (!p.photo) { fills[i] = null; return; }          // restored photo: must be added again
        const cx = p.crop.x + p.crop.w / 2, cy = p.crop.y + p.crop.h / 2;
        const cc = centreCrop(p.photo.width / p.photo.height, size);
        p.size = size;
        p.crop = { x: clamp(cx - cc.w / 2, 0, 1 - cc.w), y: clamp(cy - cc.h / 2, 0, 1 - cc.h), w: cc.w, h: cc.h };
        restart(p);
    });
    if (dropped) toast(`${dropped} poster${dropped === 1 ? '' : 's'} removed — they did not fit the new ${IS_WALL ? 'layout' : 'pack'}`);
    render();
}

const filledCount = () => fills.filter(Boolean).length;
const photos      = () => fills.filter(f => f?.photo).map(f => f.photo);
const uploading   = () => photos().filter(p => p.working || (!p.fileUrl && !p.error)).length;
const failed      = () => photos().filter(p => p.error).length;
const tooSmall    = () => photos().filter(p => quality(p) === 'bad').length;
function nextEmpty(from = -1) {
    for (let k = 1; k <= sizes.length; k++) {
        const i = (from + k) % sizes.length;
        if (!fills[i]) return i;
    }
    return null;
}

/* ════════ Render ════════ */
function render() {
    renderSteps();
    renderWall();
    renderStatus();
    if (!$('wbPicker').hidden) renderPicker();
}

function thumbSvg(layout) {
    const g = W.geometry(layout);
    return `<svg viewBox="0 0 ${g.width} ${g.height}" preserveAspectRatio="xMidYMid meet">${g.slots.map(s => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="0.8"/>`).join('')}</svg>`;
}

function renderSteps() {
    let n = 0;
    const step = (title, body) => `<div class="id-section"><div class="wb-step-title"><span class="wb-num">${++n}</span> ${title}</div>${body}</div>`;
    let html = '';
    if (IS_WALL) {
        html += step('Pick your wall layout', `<div class="wb-rail">${W.enabledLayouts(cfg).map(k => {
            const l = W.LAYOUTS[k], p = W.wallPrice(cfg, k);
            return `<button type="button" class="wb-choice${k === sel.layout ? ' active' : ''}" data-layout="${k}">
                <span class="wb-thumb">${thumbSvg(l)}</span><b>${esc(l.name)}</b>
                <small>${W.slotSizes(l).length} posters · ${W.feet(l)}</small><em>${inr(p.price)}</em></button>`;
        }).join('')}</div>`);
    } else {
        html += step('Pick your size', `<div class="wb-chips">${W.enabledPackSizes(cfg).map(s =>
            `<button type="button" class="wb-chip${s === sel.size ? ' active' : ''}" data-size="${s}">${esc(W.SIZES[s].label)}</button>`).join('')}</div>`);
        const packs = W.enabledPacks(cfg, sel.size);
        const base = packs.length ? W.packPrice(cfg, sel.size, packs[0]).price / packs[0] : 0;
        html += step('Pick your pack', `<div class="wb-rail">${packs.map(q => {
            const p = W.packPrice(cfg, sel.size, q);
            const save = base ? Math.round((1 - p.price / q / base) * 100) : 0;
            return `<button type="button" class="wb-choice${q === sel.pack ? ' active' : ''}" data-pack="${q}">
                <b>${q} posters</b><em>${inr(p.price)}</em><small>${inr(Math.round(p.price / q))} each</small>
                ${save >= 3 ? `<span class="wb-save">Save ${save}%</span>` : ''}</button>`;
        }).join('')}</div>`);
        html += step('Pick your arrangement', `<div class="wb-rail">${W.arrangementsFor(sel.size, sel.pack).map(st => {
            const l = W.packLayout(st, sel.size, sel.pack);
            return `<button type="button" class="wb-choice${st === sel.arrangement ? ' active' : ''}" data-arr="${st}">
                <span class="wb-thumb">${thumbSvg(l)}</span><b>${W.ARRANGEMENTS[st]}</b><small>${W.feet(l)}</small></button>`;
        }).join('')}</div>`);
    }
    $('wbSteps').innerHTML = html;
    $('wbFillNum').textContent = n + 1;
}

$('wbSteps').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.layout && b.dataset.layout !== sel.layout) { sel.layout = b.dataset.layout; applySizes(); }
    else if (b.dataset.size && b.dataset.size !== sel.size) {
        sel.size = b.dataset.size;
        const packs = W.enabledPacks(cfg, sel.size);
        if (!packs.includes(sel.pack)) sel.pack = packs.includes(7) ? 7 : packs[0];
        applySizes();
    } else if (b.dataset.pack && Number(b.dataset.pack) !== sel.pack) { sel.pack = Number(b.dataset.pack); applySizes(); }
    else if (b.dataset.arr && b.dataset.arr !== sel.arrangement) { sel.arrangement = b.dataset.arr; render(); }
});

function slotInner(f, size, compact) {
    if (!f) return `<i class="fa-solid fa-plus"></i>${compact ? '' : `<small>${esc(W.SIZES[size].label)}</small>`}`;
    if (f.design) return `<img class="full" src="${esc(f.design.img)}" alt="${esc(f.design.name)}" loading="lazy">`;
    const p = f.photo;
    let pic;
    if (p.photo) {
        const { x, y, w, h } = p.crop;
        pic = `<img class="win" src="${p.photo.url}" alt="" style="width:${100 / w}%;height:${100 / h}%;left:${(-x / w) * 100}%;top:${(-y / h) * 100}%">`;
    } else pic = p.thumb ? `<img class="full" src="${p.thumb}" alt="">` : '';
    const q = quality(p);
    return pic
        + (p.working ? '<span class="wb-over"><span class="wb-spin"></span></span>' : '')
        + (p.error ? '<span class="wb-over err"><i class="fa-solid fa-rotate-right"></i></span>' : '')
        + (!p.working && !p.error && q !== 'ok' ? `<i class="fa-solid fa-triangle-exclamation wb-warn${q === 'bad' ? ' bad' : ''}"></i>` : '');
}

function renderWall() {
    const layout = currentLayout();
    if (!layout) return;
    const g = W.geometry(layout);
    const scroll = $('wbWall').parentElement;
    const avail = (scroll.clientWidth || 340) - 24;
    const scale = Math.max(Math.min(avail / g.width, 520 / g.height), 46 / W.SIZES.A5.widthCm);
    const wall = $('wbWall');
    wall.style.width = `${g.width * scale + 24}px`;
    wall.style.height = `${g.height * scale + 24}px`;
    wall.innerHTML = g.slots.map((s, i) => {
        const f = fills[i];
        const compact = s.w * scale < 40;
        return `<button type="button" class="wb-slot${f ? ' filled' : ''}${active === i ? ' active' : ''}" data-slot="${i}"
            aria-label="Spot ${i + 1}, ${esc(W.SIZES[s.size].name)}${f ? '' : ', empty'}"
            style="left:${12 + s.x * scale}px;top:${12 + s.y * scale}px;width:${s.w * scale}px;height:${s.h * scale}px">${slotInner(f, s.size, compact)}</button>`;
    }).join('');
    $('wbWallHint').textContent = `About ${W.feet(layout)} on your wall · ${layout.description}`;
}
window.addEventListener('resize', () => renderWall());

$('wbWall').addEventListener('click', e => {
    const b = e.target.closest('[data-slot]');
    if (!b) return;
    const i = Number(b.dataset.slot);
    if (fills[i]) openMenu(i); else openPicker(i);
});

function price() {
    return IS_WALL ? W.wallPrice(cfg, sel.layout) : W.packPrice(cfg, sel.size, sel.pack);
}

function renderStatus() {
    const n = filledCount(), total = sizes.length;
    $('wbFilled').textContent = `${n} of ${total} filled`;
    $('wbBar').style.width = `${total ? (n / total) * 100 : 0}%`;
    $('wbClear').disabled = !n;
    const p = price();
    $('wbPrice').textContent = p ? inr(p.price) : '—';
    $('wbPriceOrig').textContent = p && p.original > p.price ? inr(p.original) : '';
    $('wbSummary').textContent = IS_WALL ? `${total} posters` : `${total} × ${W.SIZES[sel.size].label}`;
    const left = total - n;
    $('wbAddCart').textContent = left ? `Fill ${left} more spot${left === 1 ? '' : 's'}` : uploading() ? 'Uploading photos…' : 'Add to cart';

    const soft = photos().filter(ph => !ph.error && quality(ph) === 'warn').length;
    const notes = [
        uploading() && ['info', 'fa-cloud-arrow-up', `Uploading ${uploading()} photo${uploading() === 1 ? '' : 's'}… keep this page open`],
        failed() && ['bad', 'fa-circle-exclamation', `${failed()} photo${failed() === 1 ? '' : 's'} did not upload — tap ${failed() === 1 ? 'it' : 'them'} to retry`],
        tooSmall() && ['bad', 'fa-triangle-exclamation', `${tooSmall()} photo${tooSmall() === 1 ? ' is' : 's are'} too small for a sharp print — use the original photo, not a WhatsApp copy`],
        soft && ['warn', 'fa-triangle-exclamation', `${soft} photo${soft === 1 ? '' : 's'} may print a little soft`],
    ].filter(Boolean);
    $('wbNotices').innerHTML = notes.map(([c, ic, t]) => `<li class="${c}"><i class="fa-solid ${ic}"></i> ${esc(t)}</li>`).join('');
}

/* ════════ Design picker ════════ */
function openPicker(i) {
    active = i;
    pickerTab = '';
    $('wbPicker').hidden = false;
    document.body.style.overflow = 'hidden';
    renderPicker();
    renderWall();
}
function closePicker() {
    $('wbPicker').hidden = true;
    document.body.style.overflow = '';
    active = null;
    renderWall();
}

function renderPickerHead() {
    if (active === null || $('wbPicker').hidden) return;
    $('wbPickTitle').textContent = `Spot ${active + 1} · ${W.SIZES[sizes[active]].name}`;
    $('wbPickSub').textContent = `${filledCount()} of ${sizes.length} filled`;
    $('wbPickBar').style.width = `${sizes.length ? (filledCount() / sizes.length) * 100 : 0}%`;
    $('wbPickPhotoSub').textContent = user ? 'From your gallery — we fit it to this poster' : 'Sign in to print your own photos';
}

function renderPicker() {
    renderPickerHead();
    const themes = [...new Set(designs.map(d => d.theme).filter(Boolean))].sort();
    $('wbTabs').innerHTML = themes.length
        ? [['', 'All designs'], ...themes.map(t => [t, t])].map(([v, l]) =>
            `<button type="button" class="wb-chip${v === pickerTab ? ' active' : ''}" data-tab="${esc(v)}">${esc(l)}</button>`).join('')
        : '';
    const list = designs.filter(d => !pickerTab || d.theme === pickerTab);
    const here = fills[active]?.design?.id;
    $('wbGrid').innerHTML = list.length ? list.map(d => {
        const uses = fills.filter(f => f?.design?.id === d.id).length;
        return `<button type="button" class="wb-design${d.id === here ? ' here' : ''}" data-design="${esc(d.id)}">
            <span class="pic"><img src="${esc(d.img)}" alt="${esc(d.name)}" loading="lazy">${uses ? `<span class="uses">×${uses}</span>` : ''}</span>
            <span class="nm">${esc(d.name)}</span></button>`;
    }).join('') : `<div class="wb-empty">${designs.length ? 'No designs in this theme yet.' : 'No poster designs yet — add your own photo to this spot.'}</div>`;
}

$('wbPicker').addEventListener('click', e => {
    if (e.target === $('wbPicker') || e.target.closest('[data-close]')) return closePicker();
    const tab = e.target.closest('[data-tab]');
    if (tab) { pickerTab = tab.dataset.tab; renderPicker(); return; }
    const d = e.target.closest('[data-design]');
    if (!d) return;
    const design = designs.find(x => x.id === d.dataset.design);
    fills[active] = { design };
    const next = nextEmpty(active);
    render();
    if (next === null) { closePicker(); toast('Every spot is filled — tap a poster to change it'); }
    else { active = next; renderPicker(); renderWall(); }
});
$('wbPickPhoto').onclick = () => { const i = active; closePicker(); requestPhoto(i); };

/* ════════ Spot menu ════════ */
function openMenu(i) {
    const f = fills[i];
    $('wbMenuTitle').textContent = `Spot ${i + 1} · ${W.SIZES[sizes[i]].name}`;
    $('wbMenuSub').textContent = f.design ? f.design.name : f.photo.error ? `Upload failed — ${f.photo.error}` : 'Your photo';
    const acts = [];
    if (f.photo?.error) acts.push(['retry', 'fa-rotate-right', 'Retry upload']);
    if (f.photo?.photo) acts.push(['crop', 'fa-crop-simple', 'Adjust position']);
    acts.push(['change', 'fa-right-left', 'Change design or photo'], ['remove', 'fa-trash-can', 'Remove']);
    $('wbMenuActions').innerHTML = acts.map(([a, ic, t]) =>
        `<button type="button" class="wb-action${a === 'remove' ? ' danger' : ''}" data-act="${a}" data-slot="${i}"><i class="fa-solid ${ic}"></i>${t}</button>`).join('');
    $('wbMenu').hidden = false;
}
$('wbMenu').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (e.target !== $('wbMenu') && !b) return;
    $('wbMenu').hidden = true;
    if (!b) return;
    const i = Number(b.dataset.slot), f = fills[i];
    if (b.dataset.act === 'retry') restart(f.photo);
    if (b.dataset.act === 'crop') openCrop(f.photo.photo, sizes[i], f.photo.crop, crop => { f.photo.crop = crop; restart(f.photo); render(); });
    if (b.dataset.act === 'change') openPicker(i);
    if (b.dataset.act === 'remove') { releaseFill(fills[i]); fills[i] = null; render(); }
});

/* ════════ Photos ════════ */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const posterAspect = s => W.SIZES[s].widthCm / W.SIZES[s].heightCm;
function centreCrop(photoAspect, size) {
    const pa = posterAspect(size);
    if (photoAspect > pa) { const w = pa / photoAspect; return { x: (1 - w) / 2, y: 0, w, h: 1 }; }
    const h = photoAspect / pa;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
}
const dpiOf = (srcWidth, crop, size) => Math.round(Math.min(srcWidth * crop.w, W.SIZES[size].printW) / (W.SIZES[size].widthCm / 2.54));
const qualityFor = dpi => (dpi >= 100 ? 'ok' : dpi >= 60 ? 'warn' : 'bad');
const quality = p => qualityFor(dpiOf(p.srcWidth, p.crop, p.size));

async function loadPhoto(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Please choose a JPG, PNG or WEBP photo.');
    if (file.size > MAX_FILE) throw new Error('This photo is over 50 MB.');
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { throw new Error('This photo could not be opened — try a JPG or PNG.'); }
    return { bitmap, width: bitmap.width, height: bitmap.height, url: URL.createObjectURL(file) };
}
function releaseFill(f) {
    const ph = f?.photo?.photo;
    if (ph && !fills.some(x => x !== f && x?.photo?.photo === ph)) { ph.bitmap.close?.(); URL.revokeObjectURL(ph.url); }
}
function newPhoto(photo, size, crop) {
    return { id: ++seq, photo, srcWidth: photo.width, crop: crop || centreCrop(photo.width / photo.height, size), size,
             version: 0, working: false, fileUrl: '', thumb: '', error: '' };
}

let photoSlot = null;
function requestPhoto(i) {
    if (!user) return askSignIn();
    photoSlot = i;
    $('wbFile').click();
}
$('wbFile').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    const i = photoSlot;
    if (!f || i === null) return;
    try {
        const photo = await loadPhoto(f);
        openCrop(photo, sizes[i], null, crop => {
            releaseFill(fills[i]);
            const p = newPhoto(photo, sizes[i], crop);
            fills[i] = { photo: p };
            restart(p);
            render();
        }, () => { photo.bitmap.close?.(); URL.revokeObjectURL(photo.url); });
    } catch (err) { toast(err.message, 'error'); }
};

$('wbAddPhotos').onclick = () => {
    if (!sizes.some((_, i) => !fills[i])) return toast('Every spot is filled — tap a poster to change it');
    if (!user) return askSignIn();
    $('wbFiles').click();
};
$('wbFiles').onchange = async e => {
    const files = [...e.target.files];
    e.target.value = '';
    const empty = sizes.map((_, i) => i).filter(i => !fills[i]);
    let added = 0;
    for (const f of files.slice(0, empty.length)) {
        try {
            const i = empty[added];
            const p = newPhoto(await loadPhoto(f), sizes[i]);
            fills[i] = { photo: p };
            restart(p);
            added++;
        } catch (err) { toast(`${f.name}: ${err.message}`, 'error'); }
    }
    render();
    if (files.length > empty.length) toast(`Only ${empty.length} spots were free — added the first ${empty.length} photos`);
    else if (added) toast(`${added} photo${added === 1 ? '' : 's'} added — tap one to adjust it`);
};

/* Render the chosen window at print size (never upscaled) and upload it — one at a time. */
const queue = [];
let running = false;
function restart(p) {
    p.version++;
    p.fileUrl = ''; p.error = '';
    if (!queue.includes(p)) queue.push(p);
    pump();
}
const inUse = p => fills.some(f => f?.photo === p);

async function renderPoster(p) {
    const d = W.SIZES[p.size], ph = p.photo;
    const sx = Math.round(p.crop.x * ph.width), sy = Math.round(p.crop.y * ph.height);
    const sw = Math.max(1, Math.min(ph.width - sx, Math.round(p.crop.w * ph.width)));
    const sh = Math.max(1, Math.min(ph.height - sy, Math.round(p.crop.h * ph.height)));
    const scale = Math.min(1, d.printW / sw, Math.sqrt(MAX_CANVAS / (sw * sh)));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(sw * scale)); cv.height = Math.max(1, Math.round(sh * scale));
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ph.bitmap, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    const blob = await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('Could not prepare the photo')), 'image/jpeg', 0.9));
    const t = document.createElement('canvas');
    t.width = 60; t.height = Math.round(60 / posterAspect(p.size));
    t.getContext('2d').drawImage(cv, 0, 0, t.width, t.height);
    const thumb = t.toDataURL('image/jpeg', 0.7);
    cv.width = cv.height = 0;
    return { blob, thumb };
}

async function pump() {
    if (running) return;
    running = true;
    try {
        while (queue.length) {
            const p = queue.shift();
            if (!inUse(p) || !p.photo) continue;
            const version = p.version;
            const stale = () => version !== p.version || !inUse(p);
            p.working = true;
            render();
            try {
                const { blob, thumb } = await renderPoster(p);
                if (stale()) continue;
                p.thumb = thumb;
                const target = await getUploadTarget('poster', `wall_${p.size}_${Date.now().toString(36)}.jpg`);
                const res = await fetch(target.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
                if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`);
                if (stale()) continue;
                p.fileUrl = target.fileUrl;
            } catch (err) {
                if (!stale()) p.error = err.message || 'upload failed';
            } finally {
                if (version === p.version) p.working = false;
                render();
            }
        }
    } finally { running = false; }
}

/* ════════ Photo fit editor ════════ */
let crop = null;
function openCrop(photo, size, initial, onDone, onCancel) {
    const aspect = photo.width / photo.height, pa = posterAspect(size);
    const cover = centreCrop(aspect, size);
    crop = { photo, size, aspect, pa, cover, c: initial || cover, onDone, onCancel };
    $('wbCropTitle').textContent = `Fit your photo — ${W.SIZES[size].name}`;
    $('wbCropImg').src = photo.url;
    $('wbCrop').hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(drawCrop);
}
function fitCrop(cx, cy, w) {
    const { cover, aspect, pa } = crop;
    w = clamp(w, cover.w / 6, cover.w);
    const h = (w * aspect) / pa;
    return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}
function drawCrop() {
    if (!crop) return;
    const area = $('wbCropArea');
    const fw = Math.max(0, Math.min(area.clientWidth - 32, (area.clientHeight - 32) * crop.pa));
    const frame = $('wbCropFrame');
    frame.style.width = `${fw}px`;
    frame.style.height = `${fw / crop.pa}px`;
    const { x, y, w, h } = crop.c;
    Object.assign($('wbCropImg').style, { width: `${100 / w}%`, height: `${100 / h}%`, left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%` });
    $('wbCropZoom').value = Math.round(((crop.cover.w / w - 1) / 5) * 100);
    const dpi = dpiOf(crop.photo.width, crop.c, crop.size), q = qualityFor(dpi);
    const qEl = $('wbCropQuality');
    qEl.className = `wb-quality ${q}`;
    qEl.innerHTML = q === 'ok' ? '<i class="fa-solid fa-circle-check"></i> Good print quality'
        : q === 'warn' ? '<i class="fa-solid fa-triangle-exclamation"></i> May print a little soft — zoom out or use the original photo'
        : '<i class="fa-solid fa-triangle-exclamation"></i> Too small for a sharp print — zoom out or pick a bigger photo';
}
function closeCrop(ok) {
    const c = crop;
    crop = null;
    $('wbCrop').hidden = true;
    document.body.style.overflow = '';
    if (ok) c.onDone(c.c); else c.onCancel?.();
}
$('wbCropOk').onclick = () => closeCrop(true);
$('wbCropCancel').onclick = () => closeCrop(false);
$('wbCropReset').onclick = () => { crop.c = crop.cover; drawCrop(); };
$('wbCropZoom').oninput = e => {
    const w = crop.cover.w / (1 + (Number(e.target.value) / 100) * 5);
    crop.c = fitCrop(crop.c.x + crop.c.w / 2, crop.c.y + crop.c.h / 2, w);
    drawCrop();
};
window.addEventListener('resize', drawCrop);

/* Drag to move, pinch / wheel to zoom */
const pointers = new Map();
let gesture = null;
const snapshot = () => {
    const pts = [...pointers.values()];
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { cx, cy, dist };
};
const frameEl = $('wbCropFrame');
frameEl.addEventListener('pointerdown', e => {
    frameEl.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture = { c: crop.c, ...snapshot() };
});
frameEl.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !gesture || !crop) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = snapshot(), fw = frameEl.clientWidth;
    const w = gesture.dist && now.dist ? (gesture.c.w * gesture.dist) / now.dist : gesture.c.w;
    const cx = gesture.c.x + gesture.c.w / 2 - ((now.cx - gesture.cx) * w) / fw;
    const cy = gesture.c.y + gesture.c.h / 2 - ((now.cy - gesture.cy) * w * crop.aspect) / fw;
    crop.c = fitCrop(cx, cy, w);
    drawCrop();
});
const endPointer = e => { pointers.delete(e.pointerId); gesture = pointers.size && crop ? { c: crop.c, ...snapshot() } : null; };
frameEl.addEventListener('pointerup', endPointer);
frameEl.addEventListener('pointercancel', endPointer);
frameEl.addEventListener('wheel', e => {
    e.preventDefault();
    crop.c = fitCrop(crop.c.x + crop.c.w / 2, crop.c.y + crop.c.h / 2, crop.c.w * (e.deltaY > 0 ? 1.08 : 1 / 1.08));
    drawCrop();
}, { passive: false });

/* ════════ Sign in (keeps the wall) ════════ */
function askSignIn() {
    $('wbMenuTitle').textContent = 'Sign in to add photos';
    $('wbMenuSub').textContent = 'Your photos are uploaded privately to your account for printing. Your picks stay as they are.';
    $('wbMenuActions').innerHTML = `<button type="button" class="wb-action" id="wbGoSignIn"><i class="fa-solid fa-right-to-bracket"></i>Sign in</button>
        <button type="button" class="wb-action" data-act="none"><i class="fa-solid fa-xmark"></i>Not now</button>`;
    $('wbMenu').hidden = false;
    $('wbGoSignIn').onclick = () => {
        saveState();
        leaving = true;
        location.href = `login.html?redirect=${encodeURIComponent(`wall-builder.html?mode=${MODE}`)}`;
    };
}
function saveState() {
    try {
        sessionStorage.setItem(SAVE_KEY, JSON.stringify({
            sel,
            fills: fills.map(f => f?.design ? { design: f.design }
                : f?.photo?.fileUrl ? { fileUrl: f.photo.fileUrl, thumb: f.photo.thumb, size: f.photo.size, srcWidth: f.photo.srcWidth, crop: f.photo.crop } : null),
        }));
    } catch (_) {}
}
function restoreSaved() {
    let s;
    try { s = JSON.parse(sessionStorage.getItem(SAVE_KEY) || 'null'); sessionStorage.removeItem(SAVE_KEY); } catch (_) { return; }
    if (!s) return;
    if (IS_WALL && W.wallPrice(cfg, s.sel?.layout)) sel.layout = s.sel.layout;
    if (!IS_WALL && W.packPrice(cfg, s.sel?.size, s.sel?.pack)) Object.assign(sel, { size: s.sel.size, pack: s.sel.pack, arrangement: s.sel.arrangement || 'grid' });
    const next = IS_WALL ? W.slotSizes(W.LAYOUTS[sel.layout]) : Array.from({ length: sel.pack }, () => sel.size);
    fills = next.map((size, i) => {
        const f = (s.fills || [])[i];
        if (f?.design) return { design: f.design };
        if (f?.fileUrl && f.size === size) return { photo: { id: ++seq, photo: null, srcWidth: f.srcWidth, crop: f.crop, size, version: 0, working: false, fileUrl: f.fileUrl, thumb: f.thumb, error: '' } };
        return null;
    });
}

/* ════════ Cart ════════ */
$('wbAddCart').onclick = () => {
    const left = sizes.length - filledCount();
    if (left) {
        toast(`Fill ${left} more spot${left === 1 ? '' : 's'} to continue`);
        const n = nextEmpty();
        if (n !== null) openPicker(n);
        return;
    }
    if (failed()) return toast(`${failed()} photo${failed() === 1 ? '' : 's'} did not upload — tap to retry`, 'error');
    if (uploading()) return toast('Hold on — your photos are still uploading…');
    if (tooSmall()) return toast(`${tooSmall()} photo${tooSmall() === 1 ? ' is' : 's are'} too small for a sharp print — replace or zoom out`, 'error');
    const p = price();
    if (!p) return toast('This option is not available right now.', 'error');

    const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const layout = currentLayout();
    const line = {
        id: IS_WALL ? `wall-poster__${sel.layout}__${tag}` : `poster-pack__${sel.size}-${sel.pack}__${tag}`,
        baseId: IS_WALL ? 'wall-poster' : 'poster-pack',
        name: IS_WALL ? `Build Your Wall — ${layout.name} (${sizes.length} posters)` : `Poster Pack — ${sel.pack} × ${W.SIZES[sel.size].label}`,
        price: p.price, originalPrice: p.original, discountPercent: p.discountPercent,
        img: fills.find(f => f.design)?.design.img || fills[0].photo?.thumb || '',
        category: 'posters', wallPoster: MODE, qty: 1,
        ...(IS_WALL ? { wallLayout: sel.layout } : { packSize: sel.size, packCount: sel.pack, arrangement: sel.arrangement }),
        wallSlots: fills.map((f, i) => f.design
            ? { size: sizes[i], itemId: f.design.id, name: f.design.name, img: f.design.img }
            : { size: sizes[i], photo: f.photo.fileUrl, thumb: f.photo.thumb }),
    };
    let cart = [];
    try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch (_) {}
    cart.push(line);
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateBadge(cart);
    window.dispatchEvent(new CustomEvent('cartUpdated', { detail: cart }));
    fills.forEach(releaseFill);
    fills = sizes.map(() => null);
    render();
    toast(IS_WALL ? 'Your wall is in the cart!' : 'Your pack is in the cart!');
};

$('wbClear').onclick = () => {
    if (!filledCount() || !confirm('Clear every spot?')) return;
    fills.forEach(releaseFill);
    fills = sizes.map(() => null);
    render();
};
$('wbBack').onclick = () => {
    if (filledCount() && !confirm('Leave? The posters you picked will be lost.')) return;
    if (history.length > 1) history.back(); else location.href = 'categories.html?cat=posters';
};
let leaving = false;   // set when we navigate away on purpose (sign-in keeps the wall)
window.addEventListener('beforeunload', e => { if (filledCount() && !leaving) e.preventDefault(); });

/* ════════ Helpers ════════ */
function updateBadge(cart) {
    let c = cart;
    if (!c) { try { c = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch (_) { c = []; } }
    const total = c.reduce((s, i) => s + (i.qty || 0), 0);
    $('cartBadge').textContent = total;
    $('cartBadge').style.display = total > 0 ? 'flex' : 'none';
}
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
load();
