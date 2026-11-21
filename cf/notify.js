/* ═══════════════════════════════════════════════════════════════════
   OMX — order push notifications (Zomato-style), sent by the Worker
   whenever an orders/* document is written, from any source (customer
   checkout, staff status change, payment webhook, settle job).

   Staff (admins + that shop's owners/employees):
     a new COD order, or an online order once its payment succeeded.
   Customer:
     every change of the order's status, and "payment received".

   Recipients' devices are users/{uid}.fcmTokens (saved by /omx-push.js).
   Dead tokens are removed from the user doc when FCM reports them.
   ═══════════════════════════════════════════════════════════════════ */

import { Store } from './store.js';
import { sendToTokens, fcmConfigured, isStaleToken } from './fcm.js';

const SITE = 'https://ordermyxerox.com';
const PAID = ['paid', 'partial_paid'];
const rupees = n => '₹' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-IN');
const shortId = (id, o) => o.groupOrderId || String(id).slice(0, 8).toUpperCase();

function countLines(o) {
    if (Array.isArray(o.items) && o.items.length) return `${o.items.length} item${o.items.length > 1 ? 's' : ''}`;
    if (Array.isArray(o.documents) && o.documents.length) return `${o.documents.length} file${o.documents.length > 1 ? 's' : ''} to print`;
    return o.type === 'xerox' ? 'xerox order' : 'order';
}

/* Customer message for a status (lower-cased key) */
function statusMessage(status, o, id) {
    const shop = o.shopName ? ` from ${o.shopName}` : '';
    const ref = `#${shortId(id, o)}`;
    switch (String(status || '').toLowerCase()) {
        case 'confirmed':
        case 'accepted':          return ['✅ Order confirmed', `Your order ${ref}${shop} is confirmed. We'll let you know when it's ready.`];
        case 'processing':
        case 'printing':          return [o.type === 'xerox' ? '🖨️ Printing your order' : '📦 Packing your order', `Order ${ref}${shop} is being prepared.`];
        case 'ready':
        case 'ready for pickup':  return ['🛍️ Ready for pickup', `Order ${ref} is ready${o.shopName ? ` at ${o.shopName}` : ''}.`];
        case 'out for delivery':
        case 'shipped':           return ['🛵 Out for delivery', `Order ${ref} is on the way to you.`];
        case 'delivered':
        case 'completed':         return ['🎉 Delivered', `Order ${ref} has been delivered. Thank you for ordering with Order My Xerox!`];
        case 'cancelled':         return ['Order cancelled', `Order ${ref} was cancelled.${PAID.includes(o.paymentStatus) ? ' Any amount paid will be refunded.' : ''}`];
        case 'rejected':          return ['Order not accepted', `Sorry, ${o.shopName || 'the shop'} couldn't take order ${ref}.${PAID.includes(o.paymentStatus) ? ' Any amount paid will be refunded.' : ''}`];
        default:                  return ['Order update', `Order ${ref} is now ${status}.`];
    }
}

/** Work out which notifications a batch of writes calls for. changes: [{ path, before, after }] */
export function plan(changes) {
    const jobs = [];
    for (const c of changes) {
        const m = /^orders\/([^/]+)$/.exec(c.path);
        if (!m || !c.after) continue;
        const id = m[1], o = c.after, b = c.before;

        // Staff: new COD order, or online order that just got paid
        const createdCod = !b && o.paymentStatus === 'cod';
        const justPaid = PAID.includes(o.paymentStatus) && !(b && PAID.includes(b.paymentStatus));
        if ((createdCod || justPaid) && !['cancelled', 'rejected'].includes(String(o.status || '').toLowerCase())) {
            jobs.push({ kind: 'new_order', id, o });
        }

        // Customer: payment received
        if (b && justPaid && o.userId) {
            jobs.push({
                kind: 'customer', id, o, uid: o.userId,
                title: '💳 Payment received',
                body: `We got ${rupees(o.amountPaid || o.totalAmount)} for order #${shortId(id, o)}. The shop will confirm it soon.`,
            });
        }

        // Customer: status changed (not for checkouts that were never paid and got swept)
        if (b && o.userId && o.status && String(o.status) !== String(b.status || '') && o.paymentStatus !== 'abandoned') {
            const [title, body] = statusMessage(o.status, o, id);
            jobs.push({ kind: 'customer', id, o, uid: o.userId, title, body, statusTag: true });
        }
    }
    return jobs;
}

async function tokensOf(store, uids) {
    const docs = await store.getMany([...new Set(uids)].map(u => `users/${u}`));
    const out = [];
    for (const d of docs) {
        if (!d) continue;
        const u = d.data || {};
        if (u.notificationsEnabled === false) continue;
        const list = Array.isArray(u.fcmTokens) ? u.fcmTokens : (u.fcmToken ? [u.fcmToken] : []);
        for (const token of list) if (typeof token === 'string' && token.length > 20) out.push({ uid: d.id, token, roles: u.roles || [u.role || 'user'] });
    }
    return out;
}

async function adminUids(store) {
    const rows = await store.query({ coll: 'users', filters: [{ field: 'roles', op: 'array-contains', value: 'admin' }] });
    const legacy = await store.query({ coll: 'users', filters: [{ field: 'role', op: '==', value: 'admin' }] });
    return [...new Set([...rows, ...legacy].map(r => r.id))];
}

async function send(env, store, targets, buildMessage) {
    if (!targets.length) return { sent: 0, failed: 0 };
    // one push per device, even if a user appears twice (admin + shop owner)
    const seen = new Set();
    const uniq = targets.filter(t => !seen.has(t.token) && seen.add(t.token));
    const stale = new Map();
    let sent = 0, failed = 0;
    // group by message (URL differs per role)
    const groups = new Map();
    for (const t of uniq) {
        const msg = buildMessage(t);
        const key = JSON.stringify(msg);
        if (!groups.has(key)) groups.set(key, { msg, list: [] });
        groups.get(key).list.push(t);
    }
    for (const { msg, list } of groups.values()) {
        const res = await sendToTokens(env, list.map(t => t.token), msg);
        res.forEach((r, i) => {
            if (r.success) { sent++; return; }
            failed++;
            if (isStaleToken(r.error?.code)) {
                const uid = list[i].uid;
                if (!stale.has(uid)) stale.set(uid, []);
                stale.get(uid).push(r.token);
            }
        });
    }
    if (stale.size) {
        await store.commit([...stale].map(([uid, toks]) => ({
            op: 'update', path: `users/${uid}`, data: { fcmTokens: { __op: 'arrayRemove', v: toks } },
        }))).catch(e => console.warn('[notify] stale token cleanup failed:', e.message));
    }
    return { sent, failed };
}

/* Data-only web push: the service worker (firebase-messaging-sw.js) shows it,
   so the look is the same in Chrome, the installed PWA and the Play (TWA) app. */
function webMessage({ title, body, url, tag, kind }) {
    return {
        data: { title, body, url, tag, kind },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } },
        // The Flutter Play app (com.ordermyxerox.ordermyxerox): Android shows this block
        // itself when the app is in the background, on its high-importance "orders"
        // channel; a tap opens data.url in the app (NotificationService).
        // Web browsers ignore the android block.
        android: {
            priority: 'high',
            ttl: '86400s',
            notification: {
                title, body, tag,
                channel_id: 'orders',
                default_sound: true,
                default_vibrate_timings: true,
                notification_priority: 'PRIORITY_HIGH',
            },
        },
    };
}

export async function notifyChanges(env, changes) {
    try {
        if (!changes || !changes.length || !fcmConfigured(env)) return;
        const jobs = plan(changes);
        if (!jobs.length) return;
        const store = new Store(env.DB);

        for (const j of jobs) {
            if (j.kind === 'new_order') {
                const o = j.o;
                const shop = o.shopId ? await store.get(`shops/${o.shopId}`) : null;
                const owners = shop?.data?.owners || [];
                const employees = shop?.data?.employees || [];
                const admins = await adminUids(store);
                const targets = await tokensOf(store, [...admins, ...owners, ...employees]);
                const title = `🔔 New ${o.type === 'xerox' ? 'xerox ' : ''}order #${shortId(j.id, o)}`;
                const body = [rupees(o.totalAmount), countLines(o), o.userName, o.paymentStatus === 'cod' ? 'Cash on delivery' : 'Paid online',
                    owners.length || employees.length ? '' : o.shopName].filter(Boolean).join(' · ');
                const r = await send(env, store, targets, t => {
                    const isAdmin = admins.includes(t.uid);
                    const isOwner = owners.includes(t.uid);
                    const url = isAdmin ? `/admin-order-details.html?orderId=${j.id}`
                        : isOwner ? `/seller-order-details.html?orderId=${j.id}&shopId=${encodeURIComponent(o.shopId || '')}`
                        : `/employee-order-details.html?orderId=${j.id}`;
                    return webMessage({ title, body, url, tag: `new-${j.id}`, kind: 'new_order' });
                });
                console.log(`[notify] new order ${j.id}: ${r.sent} sent, ${r.failed} failed`);
            } else {
                const targets = await tokensOf(store, [j.uid]);
                const r = await send(env, store, targets, () => webMessage({
                    title: j.title, body: j.body, url: `/order-details.html?id=${j.id}`,
                    tag: `order-${j.id}`, kind: 'order_status',
                }));
                console.log(`[notify] customer ${j.id} "${j.title}": ${r.sent} sent, ${r.failed} failed`);
            }
        }
    } catch (e) {
        console.error('[notify] failed:', e && e.stack || e);
    }
}

export { SITE };
