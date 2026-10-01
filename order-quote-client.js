/* ═══════════════════════════════════════════════
   JASA V2 — order-quote-client.js
   Shared by cart.js and xerox-order.js.
   POST /api/orders/quote prices a checkout on the server. Firestore rules
   only accept an order whose lines, subtotal and delivery fee equal the
   quote, so the order must be written from the returned values verbatim.
   ═══════════════════════════════════════════════ */
import { PAYMENT_SERVER_URL } from './env-config.js';
import { db } from './firebase-init.js';
import { doc, updateDoc, serverTimestamp, increment }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const base = () => (window.__JASA_SERVER || PAYMENT_SERVER_URL).replace(/\/$/, '');

/**
 * @param user  Firebase user
 * @param body  { groupOrderId, type: 'product'|'xerox', isPickup, groups: [{ shopId, items|documents }] }
 * @returns     { groups: [{ shopId, items|documents, subtotal, deliveryFee }], subtotal, deliveryFee }
 */
export async function quoteOrder(user, body) {
    if (!user) throw new Error('Please sign in to place an order.');
    const idToken = await user.getIdToken();
    let res;
    try {
        res = await fetch(`${base()}/api/orders/quote`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body:    JSON.stringify(body),
            signal:  AbortSignal.timeout(60000),   // Render may be waking up
        });
    } catch (_) {
        throw new Error('Could not reach the server. Please try again in a few seconds.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Could not price the order (${res.status})`);
    return data;
}

/** True when the server's total differs from what the customer was shown */
export const priceChanged = (shown, quoted) => Math.abs((Number(shown) || 0) - (Number(quoted) || 0)) > 0.01;

/** The customer closed the payment window: cancel the unpaid orders so they don't
    sit as Pending at the shop. Never throws — the server sweep cleans up leftovers. */
export async function cancelUnpaidOrders(orders) {
    await Promise.all(orders.map(({ id, shopId }) => Promise.all([
        updateDoc(doc(db, 'orders', id), { status: 'Cancelled', cancelledAt: serverTimestamp() }),
        updateDoc(doc(db, 'order_status', id), { status: 'Cancelled', updatedAt: serverTimestamp(), lastUpdatedBy: 'user' }),
        shopId && shopId !== 'unknown'
            ? updateDoc(doc(db, 'shops', shopId), { newOrdersCount: increment(-1) }) : null,
    ]).catch(e => console.warn('[order] cancel unpaid failed:', e.message))));
}
