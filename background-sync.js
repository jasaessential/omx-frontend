/**
 * JASA V2 — Background Sync Manager
 * Saves pending orders to IndexedDB when offline.
 * SW retries them via the 'sync' event when back online.
 */

const DB_NAME    = 'jasa-sync-db';
const DB_VERSION = 1;
const STORE      = 'pending_orders';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE))
                db.createObjectStore(STORE, { keyPath: 'localId' });
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
    });
}

function dbPut(record) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).put(record);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    }));
}

function dbGetAll() {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    }));
}

function dbDelete(localId) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).delete(localId);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    }));
}

/**
 * Save a pending order and register background sync.
 * @param {object} payload - Full order object to send to Firestore
 * @returns {string} localId
 */
export async function savePendingOrder(payload) {
    const localId = 'order_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    await dbPut({ localId, savedAt: new Date().toISOString(), attempts: 0, payload });
    console.log('[Sync] Saved pending order:', localId);
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        const reg = await navigator.serviceWorker.ready;
        await reg.sync.register('sync-pending-orders').catch(() => {});
    }
    return localId;
}

export async function getPendingOrders()       { return dbGetAll(); }
export async function removePendingOrder(id)   { return dbDelete(id); }
export async function hasPendingOrders()       { return (await dbGetAll()).length > 0; }

export function onSyncMessage(cb) {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', evt => {
        if (evt.data?.type === 'SYNC_RESULT') cb(evt.data);
    });
}

/**
 * Show a bottom banner if pending orders exist.
 * Called on page load by head-cache.js.
 */
export async function checkAndShowPendingBanner() {
    const pending = await getPendingOrders();
    if (!pending.length) return;

    const p = window.location.pathname;
    if (p.includes('offline') || p.includes('login')) return;

    const existing = document.getElementById('pending-sync-banner');
    if (existing) return;

    const banner = document.createElement('div');
    banner.id = 'pending-sync-banner';
    banner.style.cssText = `
        position:fixed; bottom:calc(var(--bnh,64px) + 12px); left:50%;
        transform:translateX(-50%);
        background:#f97316; color:#fff; border-radius:14px;
        padding:11px 18px; font-size:.82rem; font-weight:700;
        box-shadow:0 8px 24px rgba(0,0,0,.18); z-index:9999;
        display:flex; align-items:center; gap:10px;
        max-width:340px; width:90%;
        animation:jasaBannerUp .3s ease;
    `;
    banner.innerHTML = `
        <style>
            @keyframes jasaBannerUp {
                from { opacity:0; transform:translateX(-50%) translateY(20px); }
                to   { opacity:1; transform:translateX(-50%) translateY(0); }
            }
        </style>
        <i class="fa-solid fa-rotate" style="font-size:1rem;flex-shrink:0;"></i>
        <span>${pending.length} order${pending.length > 1 ? 's' : ''} pending — will sync when online</span>
        <button onclick="document.getElementById('pending-sync-banner').remove()"
                style="background:none;border:none;color:#fff;font-size:1.1rem;cursor:pointer;padding:0;margin-left:auto;line-height:1;">✕</button>
    `;
    document.body.appendChild(banner);
    setTimeout(() => banner?.remove(), 6000);
}
