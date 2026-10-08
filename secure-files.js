/* ═══════════════════════════════════════════════
   JASA V2 — secure-files.js
   Customer files live in a private Supabase bucket. The browser never holds a
   Supabase key: the server (routes/files.js) hands out a signed upload URL,
   and opening a file asks it for a 15-minute signed link.

   getUploadTarget(kind, name, orderId?) → { uploadUrl, fileUrl }
       PUT the file to uploadUrl, then store fileUrl on the order.
   Links rendered as <a data-secure-file data-order-id="…" href="<fileUrl>">
   open through the server automatically (click handler below).
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

document.addEventListener('click', e => {
    const a = e.target.closest?.('a[data-secure-file]');
    if (!a) return;
    e.preventDefault();
    openSecureFile(a.dataset.path
        ? { path: a.dataset.path }
        : { orderId: a.dataset.orderId, url: a.getAttribute('href') });
});
