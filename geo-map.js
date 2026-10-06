/* ═══════════════════════════════════════════════
   JASA V2 — geo-map.js
   Shared map picker (admin shop form + xerox order page).
   Free services only: Leaflet + OpenStreetMap tiles, Nominatim search,
   browser geolocation. No API key.
   The map pans by dragging, zooms with the mouse wheel, pinch, double-tap,
   shift-drag box and the +/- buttons.
   ═══════════════════════════════════════════════ */

const LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const NOMINATIM   = 'https://nominatim.openstreetmap.org';
const INDIA       = { lat: 20.5937, lng: 78.9629 };

/* ── distance ── */
export function haversineKm(a, b) {
    const rad = d => d * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function hasCoords(s) {
    return !!s && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))
        && s.lat !== null && s.lng !== null && s.lat !== '' && s.lng !== '';
}

/* ── lazy Leaflet loader ── */
let _leafletPromise = null;
export function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (_leafletPromise) return _leafletPromise;
    _leafletPromise = new Promise((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = LEAFLET_CSS;
        document.head.appendChild(css);
        const js = document.createElement('script');
        js.src = LEAFLET_JS;
        js.onload = () => resolve(window.L);
        js.onerror = () => { _leafletPromise = null; reject(new Error('Could not load the map. Check your connection.')); };
        document.head.appendChild(js);
    });
    return _leafletPromise;
}

/* ── geolocation + Nominatim ── */
export function getCurrentPosition() {
    return new Promise((resolve, reject) => {
        if (!('geolocation' in navigator)) return reject(new Error('Your browser cannot share its location. Pick a point on the map instead.'));
        navigator.geolocation.getCurrentPosition(
            p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
            err => reject(new Error(
                err.code === err.PERMISSION_DENIED
                    ? 'Location permission is blocked. Allow it in your browser settings, or pick a point on the map.'
                    : 'Could not get your location. Pick a point on the map instead.')),
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
        );
    });
}

function toPlace(displayName, a) {
    return {
        address: displayName,
        city:    a?.city || a?.town || a?.village || a?.state_district || a?.county || '',
        state:   a?.state || '',
        pincode: a?.postcode || ''
    };
}

export async function reverseGeocode(p) {
    try {
        const res = await fetch(`${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${p.lat}&lon=${p.lng}`, { headers: { accept: 'application/json' } });
        if (!res.ok) return null;
        const j = await res.json();
        return j.display_name ? toPlace(j.display_name, j.address) : null;
    } catch (_) { return null; }
}

export async function searchPlaces(query) {
    const res = await fetch(`${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=in&q=${encodeURIComponent(query)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('Search is unavailable right now. Pick a point on the map instead.');
    const rows = await res.json();
    return rows.map(r => ({ lat: Number(r.lat), lng: Number(r.lon), ...toPlace(r.display_name, r.address) }));
}

/* ── styles (injected once) ── */
function injectStyles() {
    if (document.getElementById('gmStyles')) return;
    const st = document.createElement('style');
    st.id = 'gmStyles';
    st.textContent = `
.gm-wrap{display:flex;flex-direction:column;gap:8px;}
.gm-bar{display:flex;gap:8px;}
.gm-input{flex:1;min-width:0;padding:10px 12px;border:1.5px solid var(--border,#e5e7eb);border-radius:10px;font:inherit;font-size:.85rem;background:var(--bg-white,#fff);color:var(--txt1,#1a1d23);}
.gm-input:focus{outline:none;border-color:var(--primary,#2D8CF0);}
.gm-btn{padding:10px 12px;border:1.5px solid var(--border,#e5e7eb);border-radius:10px;background:var(--bg,#f2f4f8);color:var(--txt2,#374151);font:inherit;font-size:.8rem;font-weight:700;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;}
.gm-btn:hover{background:var(--border,#e5e7eb);}
.gm-btn:disabled{opacity:.6;cursor:wait;}
.gm-results{list-style:none;margin:0;padding:0;max-height:150px;overflow-y:auto;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:var(--bg-white,#fff);font-size:.8rem;}
.gm-results button{display:block;width:100%;text-align:left;padding:9px 12px;border:0;background:none;font:inherit;color:inherit;cursor:pointer;}
.gm-results button:hover{background:var(--bg,#f2f4f8);}
.gm-map{width:100%;border-radius:12px;border:1px solid var(--border,#e5e7eb);overflow:hidden;z-index:0;background:#e8eef5;touch-action:none;}
.gm-hint{font-size:.72rem;color:var(--txt3,#6b7280);font-weight:500;}
.gm-hint.err{color:#ef4444;}
.gm-pin{width:22px;height:22px;border-radius:50% 50% 50% 0;background:#2563eb;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45);transform:rotate(-45deg);}
.gm-shop{width:16px;height:16px;border-radius:50%;background:#f59e0b;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);}
.gm-shop.sel{background:#16a34a;width:20px;height:20px;}
`;
    document.head.appendChild(st);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * createMapPicker(host, opts)
 *   host    — empty element to build the picker into
 *   opts.value      {lat,lng} | null
 *   opts.onChange   (point, place?) fired on click / drag / search result / "my location"
 *   opts.withAddress  reverse-geocode each pick and pass it as `place`
 *   opts.radiusKm   draw a catchment circle around the pin
 *   opts.height     map height in px (default 300)
 *   opts.autoLocate jump to the visitor's position when there is no value yet
 * Returns { setValue, setRadius, setShops, invalidate, destroy }
 */
export async function createMapPicker(host, opts = {}) {
    injectStyles();
    const { onChange = () => {}, withAddress = false, height = 300, autoLocate = false } = opts;
    let value = opts.value || null;
    let radiusKm = opts.radiusKm || 0;

    host.innerHTML = `
      <div class="gm-wrap">
        <div class="gm-bar">
          <input class="gm-input" type="search" placeholder="Search area, landmark or address" aria-label="Search a place">
          <button type="button" class="gm-btn" data-act="search">Search</button>
          <button type="button" class="gm-btn" data-act="locate" title="Use my current location"><i class="fa-solid fa-location-crosshairs"></i><span>My location</span></button>
        </div>
        <ul class="gm-results" style="display:none;"></ul>
        <div class="gm-map" style="height:${height}px;"><div style="padding:16px;font-size:.8rem;color:#6b7280;">Loading map…</div></div>
        <div class="gm-hint"></div>
      </div>`;
    const $ = sel => host.querySelector(sel);
    const input = $('.gm-input'), results = $('.gm-results'), mapEl = $('.gm-map'), hint = $('.gm-hint');
    const searchBtn = $('[data-act="search"]'), locateBtn = $('[data-act="locate"]');

    const setHint = (msg, err = false) => { hint.textContent = msg; hint.classList.toggle('err', !!err); };
    const defaultHint = () => setHint(value
        ? `Pinned at ${value.lat.toFixed(5)}, ${value.lng.toFixed(5)}. Drag the pin, tap the map, or zoom with scroll / pinch.`
        : 'Tap the map to drop a pin, search for a place, or use your current location. Drag to move, scroll or pinch to zoom.');

    let L;
    try { L = await loadLeaflet(); }
    catch (e) { mapEl.innerHTML = ''; setHint(e.message, true); return { setValue() {}, setRadius() {}, setShops() {}, invalidate() {}, destroy() {} }; }
    mapEl.innerHTML = '';

    const map = L.map(mapEl, {
        zoomControl: true,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        touchZoom: true,
        dragging: true,
        boxZoom: true,
        keyboard: true
    }).setView([(value || INDIA).lat, (value || INDIA).lng], value ? 15 : 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    let marker = null, circle = null;
    const shopLayer = L.layerGroup().addTo(map);

    async function pick(point, place, zoom) {
        value = { lat: point.lat, lng: point.lng };
        paint();
        map.setView([point.lat, point.lng], zoom || Math.max(map.getZoom(), 15));
        defaultHint();
        let p = place;
        if (!p && withAddress) p = await reverseGeocode(point);
        onChange(value, p || undefined);
    }

    function paint() {
        if (!value) {
            if (marker) { marker.remove(); marker = null; }
            if (circle) { circle.remove(); circle = null; }
            return;
        }
        const ll = [value.lat, value.lng];
        if (!marker) {
            const icon = L.divIcon({ className: '', html: '<div class="gm-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 22] });
            marker = L.marker(ll, { draggable: true, icon }).addTo(map);
            marker.on('dragend', () => { const p = marker.getLatLng(); pick({ lat: p.lat, lng: p.lng }, null, map.getZoom()); });
        } else marker.setLatLng(ll);
        if (radiusKm) {
            if (!circle) circle = L.circle(ll, { radius: radiusKm * 1000, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).addTo(map);
            else circle.setLatLng(ll).setRadius(radiusKm * 1000);
        } else if (circle) { circle.remove(); circle = null; }
    }

    map.on('click', e => pick({ lat: e.latlng.lat, lng: e.latlng.lng }));
    paint();
    defaultHint();

    async function locate() {
        locateBtn.disabled = true;
        try { await pick(await getCurrentPosition(), null, 17); }
        catch (e) { setHint(e.message, true); }
        finally { locateBtn.disabled = false; }
    }
    async function search() {
        const q = input.value.trim();
        if (q.length < 3) return;
        searchBtn.disabled = true;
        try {
            const found = await searchPlaces(q);
            if (!found.length) { setHint('No place found. Try a landmark or area name.', true); results.style.display = 'none'; return; }
            results.innerHTML = found.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.address)}</button></li>`).join('');
            results.style.display = 'block';
            results.onclick = ev => {
                const b = ev.target.closest('button[data-i]');
                if (!b) return;
                const r = found[+b.dataset.i];
                results.style.display = 'none';
                input.value = '';
                pick({ lat: r.lat, lng: r.lng }, r, 16);
            };
        } catch (e) { setHint(e.message, true); }
        finally { searchBtn.disabled = false; }
    }
    locateBtn.addEventListener('click', locate);
    searchBtn.addEventListener('click', search);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    if (autoLocate && !value) locate();

    /* Other shops drawn on the map (xerox order page). list: [{lat,lng,name,selected}] */
    function setShops(list = []) {
        shopLayer.clearLayers();
        list.forEach(s => {
            if (!hasCoords(s)) return;
            const icon = L.divIcon({ className: '', html: `<div class="gm-shop${s.selected ? ' sel' : ''}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
            L.marker([Number(s.lat), Number(s.lng)], { icon, title: s.name || '' }).bindTooltip(esc(s.name || ''), { direction: 'top' }).addTo(shopLayer);
        });
    }

    return {
        setValue(p, zoom) { value = p ? { lat: p.lat, lng: p.lng } : null; paint(); if (value) map.setView([value.lat, value.lng], zoom || 15); defaultHint(); },
        setRadius(km) { radiusKm = km || 0; paint(); },
        setShops,
        invalidate() { map.invalidateSize(); },
        destroy() { map.remove(); host.innerHTML = ''; }
    };
}
