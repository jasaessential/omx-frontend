/* ═══════════════════════════════════════════════
   JASA V2 — coupon-client.js
   Shared by cart.js and xerox-order.js.
   The server (/api/coupon/*) is the source of truth;
   calcDiscount() only mirrors it for live display.
   ═══════════════════════════════════════════════ */
import { PAYMENT_SERVER_URL } from './env-config.js';

const base = () => (window.__JASA_SERVER || PAYMENT_SERVER_URL).replace(/\/$/, '');

async function call(user, path, body) {
    if (!user) throw new Error('Please sign in to use a coupon.');
    const idToken = await user.getIdToken();
    let res;
    try {
        res = await fetch(`${base()}/api/coupon/${path}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body:    JSON.stringify(body),
            signal:  AbortSignal.timeout(30000),
        });
    } catch (_) {
        throw new Error('Could not reach the server. Please try again in a few seconds.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Coupon error (${res.status})`);
    return data;
}

/** Preview a coupon. Returns { code, name, description, discount, type, value, maxDiscount, minOrderAmount } */
export const validateCoupon = (user, { code, subtotal, orderType, shopIds }) =>
    call(user, 'validate', { code, subtotal, orderType, shopIds });

/** Record the redemption for an order. Returns { discount } (server-authoritative).
 *  paymentMode 'online' = counted only after payment is confirmed; anything else = counted now. */
export const redeemCoupon = (user, { code, groupOrderId, subtotal, orderType, shopIds, paymentMode }) =>
    call(user, 'redeem', { code, groupOrderId, subtotal, orderType, shopIds, paymentMode });

/** Undo a redemption after a failed/cancelled payment. Never throws. */
export async function releaseCoupon(user, groupOrderId) {
    try { await call(user, 'release', { groupOrderId }); }
    catch (e) { console.warn('[coupon] release failed:', e.message); }
}

/** Local mirror of the server calculation, for live totals. */
export function calcDiscount(coupon, subtotal) {
    if (!coupon || !(subtotal > 0)) return 0;
    if (subtotal < (coupon.minOrderAmount || 0)) return 0;
    let d = coupon.type === 'percentage' ? subtotal * coupon.value / 100 : coupon.value;
    if (coupon.type === 'percentage' && coupon.maxDiscount > 0) d = Math.min(d, coupon.maxDiscount);
    return Math.round(Math.min(d, subtotal) * 100) / 100;
}

/** Split a discount across amounts proportionally; the last share absorbs rounding. */
export function splitDiscount(amounts, discount) {
    const total = amounts.reduce((s, a) => s + a, 0);
    if (!(total > 0) || !(discount > 0)) return amounts.map(() => 0);
    let left = discount;
    return amounts.map((a, i) => {
        const share = i === amounts.length - 1
            ? left
            : Math.round(discount * a / total * 100) / 100;
        left = Math.round((left - share) * 100) / 100;
        return share;
    });
}
