/* ═══════════════════════════════════════════════
   JASA V2 — secure-files.js
   Customer files live in a private Supabase bucket. The browser never holds a
   Supabase key: the server (routes/files.js) hands out a signed upload URL,
   and opening a file asks it for a 15-minute signed link.

   getUploadTarget(kind, name, orderId?) → { uploadUrl, fileUrl }
       PUT the file to uploadUrl, then store fileUrl on the order.
   Links rendered as <a data-secure-file data-order-id="…" href="<fileUrl>">
   get a signed href automatically (signLinks below), or open through the
   server on click.
   ═══════════════════════════════════════════════ */
import { auth } from './firebase-init.js';
import { SERVER_URL } from './env-config.js';

const base = () => (window.__JASA_SERVER || SERVER_URL).replace(/\/$/, '');

async function filesApi(path, init = {}) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error('Please sign in again.');
    const res = await fetch(`${base()}/api/files/${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}`, ...(init.headers || {}) },
        signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

export const getUploadTarget = (kind, name, orderId) =>
    filesApi('upload-url', { method: 'POST', body: JSON.stringify({ kind, name, orderId }) });

/** Signed link for a file on an order (or, for admins, a bucket path). */
export async function getViewUrl({ orderId, url, path }) {
    return (await filesApi('view-url', { method: 'POST', body: JSON.stringify({ orderId, url, path }) })).url;
}

export const listFiles   = prefix => filesApi(`list?prefix=${encodeURIComponent(prefix || '')}`);
export const deleteFiles = paths  => filesApi('delete', { method: 'POST', body: JSON.stringify({ paths }) });

/** Opens a signed link in a new tab (tab opened first so pop-up blockers allow it). */
export async function openSecureFile(args) {
    const win = window.open('', '_blank');
    try {
        const url = await getViewUrl(args);
        if (win) win.location.href = url; else window.location.href = url;
    } catch (e) {
        win?.close();
        alert(`Could not open the file: ${e.message}`);
    }
}

/* Order file links get a signed URL in their href as soon as they render, so
   a tap in the Android app, long-press → open / download, or "open in new tab"
   all reach the file (the stored link 404s: the bucket is private). The stored
   link moves to data-src. Signed links last 15 min; older ones are re-signed
   on click. */
const SIGNED_FRESH_MS = 12 * 60 * 1000;
const isFresh = a => Date.now() - Number(a.dataset.signedAt || 0) < SIGNED_FRESH_MS;
const storedLink = a => a.dataset.src || a.getAttribute('href');

async function signLinks() {
    const byOrder = new Map();
    document.querySelectorAll('a[data-secure-file][data-order-id]:not([data-signing])').forEach(a => {
        if (isFresh(a)) return;
        a.dataset.signing = '';
        const id = a.dataset.orderId;
        if (!byOrder.has(id)) byOrder.set(id, []);
        byOrder.get(id).push(a);
    });
    for (const [orderId, links] of byOrder) {
        try {
            const { urls } = await filesApi('view-urls', {
                method: 'POST', body: JSON.stringify({ orderId, urls: links.map(storedLink) }),
            });
            for (const a of links) {
                const src = storedLink(a), signed = urls[src];
                if (!signed) continue;
                a.dataset.src = src;
                a.href = signed;
                a.dataset.signedAt = String(Date.now());
            }
        } catch (e) {
            console.warn('secure-files: could not sign links', e.message);   // click still works
        } finally {
            links.forEach(a => delete a.dataset.signing);
        }
    }
}

let _signTimer = 0;
const scheduleSign = () => { clearTimeout(_signTimer); _signTimer = setTimeout(signLinks, 150); };
new MutationObserver(scheduleSign).observe(document.documentElement, { childList: true, subtree: true });
auth.onAuthStateChanged?.(u => { if (u) scheduleSign(); });
setInterval(() => { if (document.visibilityState === 'visible') signLinks(); }, 60 * 1000);

document.addEventListener('click', e => {
    const a = e.target.closest?.('a[data-secure-file]');
    if (!a || (!a.dataset.path && isFresh(a))) return;   // fresh signed href: let the browser open it
    e.preventDefault();
    openSecureFile(a.dataset.path
        ? { path: a.dataset.path }
        : { orderId: a.dataset.orderId, url: storedLink(a) });
});
