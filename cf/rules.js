/* ═══════════════════════════════════════════════════════════════════
   OMX — access rules for the browser data API (/db/*).
   A line-by-line port of firestore.rules (kept in the repo for reference).
   The server's own code (cf/shims/firebase-admin.js) skips these, exactly
   like the Admin SDK skipped Firestore rules.

   Differences from Firestore, on purpose:
   - A query returns only the documents the caller may read (Firestore would
     refuse the whole query). Same data exposure, friendlier failure.
   - get() inside a rule sees the database before the batch (Firestore's
     get(), not getAfter()) — no rule here relied on getAfter().
   ═══════════════════════════════════════════════════════════════════ */

import { deepEqual, splitPath, StoreError } from './store.js';

const denied = (msg = 'Missing or insufficient permissions.') => new StoreError('permission-denied', msg);

const has = (obj, k) => obj && Object.prototype.hasOwnProperty.call(obj, k);
const dget = (d, k, def) => (d && has(d, k) ? d[k] : def);

/* Top-level keys whose value differs between before and after (rules' diff().affectedKeys()) */
function affectedKeys(after, before) {
    const keys = new Set([...Object.keys(after || {}), ...Object.keys(before || {})]);
    return [...keys].filter(k => !(has(after, k) && has(before, k) && deepEqual(after[k], before[k])));
}
const hasOnly = (list, allowed) => list.every(k => allowed.includes(k));
const hasAny  = (list, wanted)  => list.some(k => wanted.includes(k));

export class Rules {
    constructor(store, uid) {
        this.store = store;
        this.uid = uid || null;
        this._cache = new Map();
    }

    async _get(path) {
        if (!this._cache.has(path)) this._cache.set(path, this.store.get(path).then(d => d ? d.data : null));
        return this._cache.get(path);
    }

    isAuth() { return !!this.uid; }
    isOwner(uid) { return this.isAuth() && this.uid === uid; }

    async roles() {
        if (!this.uid) return [];
        const d = (await this._get(`users/${this.uid}`)) || {};
        const r = dget(d, 'roles', [dget(d, 'role', 'user')]);
        return Array.isArray(r) ? r : [r];
    }
    async hasRole(...names) { return this.isAuth() && hasAny(await this.roles(), names); }
    isAdmin()           { return this.hasRole('admin'); }
    isSeller()          { return this.hasRole('seller'); }
    isEmployee()        { return this.hasRole('employee'); }
    canManageItems()    { return this.hasRole('admin', 'manage_items'); }
    canManageSupport()  { return this.hasRole('admin', 'manage_support'); }
    canManageRequests() { return this.hasRole('admin', 'manage_requests'); }
    canManageBanners()  { return this.hasRole('admin', 'manage_banners'); }
    canManageXerox()    { return this.hasRole('admin', 'manage_xerox'); }
    canManageCoupons()  { return this.hasRole('admin', 'manage_coupons'); }

    async isShopMember(shopId) {
        if (!this.uid || typeof shopId !== 'string' || !shopId) return false;
        const shop = await this._get(`shops/${shopId}`);
        if (!shop) return false;
        return dget(shop, 'owners', []).includes?.(this.uid) || dget(shop, 'employees', []).includes?.(this.uid) || false;
    }
    async isShopStaff(shopId) {
        return ((await this.isSeller()) || (await this.isEmployee())) && this.isShopMember(shopId);
    }

    async paymentMode() {
        const cfg = await this._get('config/payment');
        return cfg ? dget(cfg, 'mode', 'both') : 'both';
    }
    async canUsePaymentMethod(method) {
        const mode = await this.paymentMode();
        return (mode === 'cod_only' && method === 'COD')
            || (mode === 'online_only' && method === 'razorpay')
            || (mode === 'both' && ['COD', 'razorpay'].includes(method))
            || (mode === 'partial_online' && ['partial', 'COD', 'razorpay'].includes(method));
    }

    usableRecordStatuses(d) {
        return dget(d, 'paymentMethod', 'COD') === 'COD' ? ['redeemed'] : ['redeemed', 'pending'];
    }

    async matchesQuote(d) {
        const q = await this._get(`order_quotes/${dget(d, 'groupOrderId', '_')}`);
        if (!q || !q.groups) return false;
        const g = q.groups[dget(d, 'shopId', '_')];
        if (!g) return false;
        return q.userId === this.uid
            && q.type === dget(d, 'type', 'product')
            && dget(d, 'subtotal', -1) === g.subtotal
            && dget(d, 'deliveryFee', 0) === g.deliveryFee
            && (q.type === 'xerox'
                ? deepEqual(dget(d, 'documents', []), g.documents)
                : deepEqual(dget(d, 'items', []), g.items));
    }

    async validCouponOnOrder(d) {
        if (dget(d, 'discountAmount', 0) === 0) return true;
        if (typeof dget(d, 'couponCode', null) !== 'string') return false;
        const u = await this._get(`coupon_usages/${dget(d, 'groupOrderId', '') + '__' + d.couponCode}`);
        return !!u
            && u.userId === this.uid
            && this.usableRecordStatuses(d).includes(u.status)
            && d.discountAmount <= u.discountAmount
            && dget(d, 'totalAmount', 0) >= dget(d, 'subtotal', 0) - d.discountAmount - dget(d, 'walletAmount', 0) + dget(d, 'deliveryFee', 0) - 0.01;
    }

    async validWalletOnOrder(d) {
        if (dget(d, 'walletAmount', 0) === 0) return true;
        if (typeof dget(d, 'groupOrderId', null) !== 'string') return false;
        const u = await this._get(`wallet_usages/${d.groupOrderId}`);
        return !!u
            && u.userId === this.uid
            && this.usableRecordStatuses(d).includes(u.status)
            && d.walletAmount <= u.amount
            && d.walletAmount <= dget(d, 'subtotal', 0) - dget(d, 'discountAmount', 0) + dget(d, 'deliveryFee', 0)
            && dget(d, 'totalAmount', 0) >= dget(d, 'subtotal', 0) - dget(d, 'discountAmount', 0) - d.walletAmount + dget(d, 'deliveryFee', 0) - 0.01;
    }

    isPendingOrder(o) { return ['Pending', 'pending'].includes(dget(o, 'status', 'Pending')); }

    /* ── read ─────────────────────────────────────────────────────── */

    /** May the caller read the doc at `path` whose data is `res` (null = missing)? */
    async canRead(path, res) {
        const s = splitPath(path);
        const [c, id] = s;
        const uid = this.uid;
        const r = res || null;
        const own = () => r !== null && this.isAuth() && r.userId === uid;

        if (s.length === 4 && c === 'wallets' && s[2] === 'transactions') return this.isOwner(id) || this.isAdmin();
        if (s.length !== 2) return false;

        switch (c) {
            case 'users': return this.isOwner(id) || this.isAdmin();
            case 'orders':
            case 'order_status':
                if (!this.isAuth() || r === null) return false;
                return own() || (await this.isAdmin()) || this.isShopStaff(r.shopId);
            case 'shops': case 'states': case 'districts': case 'cities':
            case 'items': case 'categoryData': case 'categories': case 'metadata':
            case 'itemAttributes': case 'poster_config':
            case 'xerox_config_paper': case 'xerox_config_binding':
            case 'xerox_config_lamination': case 'xerox_services':
            case 'site_banners': case 'site_config': case 'config':
                return true;
            case 'product_requests': return this.isAuth() && r !== null && (own() || this.canManageRequests());
            case 'support_queries':  return this.isAuth() && r !== null && (own() || this.canManageSupport());
            case 'cloudinary_images': return this.isAdmin();
            case 'payments': case 'payment_receipts': case 'wallet_usages':
                return this.isAuth() && r !== null && (own() || this.isAdmin());
            case 'coupons': return this.canManageCoupons();
            case 'coupon_usages': return (await this.canManageCoupons()) || own();
            case 'order_quotes': return own();
            case 'coupon_user_usage': return this.canManageCoupons();
            case 'wallets': return this.isOwner(id) || this.isAdmin();
            case 'wallet_stats': case 'referral_codes': case 'sent_notifications': return this.isAdmin();
            case 'referrals':
                return this.isAuth() && r !== null
                    && (r.refereeUid === uid || r.referrerUid === uid || this.isAdmin());
            case 'fcm_tokens': return this.isOwner(id);
            default: return false;
        }
    }

    /* ── write ────────────────────────────────────────────────────── */

    /** Throws permission-denied unless the write is allowed. before/after: data or null. */
    async checkWrite(path, before, after) {
        if (!(await this._allowWrite(path, before, after))) throw denied();
    }

    async _allowWrite(path, before, after) {
        const s = splitPath(path);
        const [c, id] = s;
        const uid = this.uid;
        const op = after === null ? 'delete' : before === null ? 'create' : 'update';
        const req = after || {};
        const res = before || {};
        const diff = () => affectedKeys(after, before);

        if (s.length !== 2) return false;   // wallets/*/transactions: server only

        switch (c) {
            case 'users':
                if (op === 'create') {
                    return this.isOwner(id)
                        && hasOnly(Object.keys(req), ['fullName', 'email', 'phone', 'mobileNumber', 'altMobiles',
                            'addresses', 'userId', 'role', 'roles', 'createdAt', 'fcmTokens', 'notificationsEnabled', 'photoURL'])
                        && dget(req, 'role', 'user') === 'user'
                        && deepEqual(dget(req, 'roles', ['user']), ['user']);
                }
                if (op === 'update') {
                    return (this.isOwner(id) && !hasAny(diff(), ['roles', 'role', 'userShops', 'referralCode', 'referredBy', 'referredByCode']))
                        || this.isAdmin();
                }
                return this.isAdmin();

            case 'orders':
                if (op === 'create') {
                    return this.isAuth()
                        && req.userId === uid
                        && dget(req, 'status', 'Pending') === 'Pending'
                        && dget(req, 'amountPaid', 0) === 0
                        && !hasAny(Object.keys(req), ['cashbackCredited', 'walletRefunded', 'paidAt', 'razorpayPaymentId'])
                        && ['pending', 'cod'].includes(dget(req, 'paymentStatus', 'pending'))
                        && (await this.canUsePaymentMethod(dget(req, 'paymentMethod', 'COD')))
                        && (await this.matchesQuote(req))
                        && (await this.validCouponOnOrder(req))
                        && (await this.validWalletOnOrder(req));
                }
                if (op === 'update') {
                    if ((await this.isAdmin()) || (await this.isShopStaff(res.shopId))) return true;
                    // customer may only cancel their own Pending order
                    return this.isAuth() && res.userId === uid && this.isPendingOrder(res)
                        && hasOnly(diff(), ['status', 'cancelledAt'])
                        && req.status === 'Cancelled';
                }
                return this.isAdmin();

            case 'order_status':
                if (op === 'create') {
                    return this.isAuth() && req.userId === uid && dget(req, 'status', 'Pending') === 'Pending';
                }
                if (op === 'update') {
                    if ((await this.isAdmin()) || (await this.isShopStaff(res.shopId))) return true;
                    return this.isAuth() && res.userId === uid && this.isPendingOrder(res)
                        && req.status === 'Cancelled'
                        && hasOnly(diff(), ['status', 'updatedAt', 'lastUpdatedBy']);
                }
                return this.isAdmin();

            case 'shops':
                if (op === 'update') {
                    return (await this.isAdmin())
                        || (await this.isShopMember(id))
                        || (this.isAuth() && hasOnly(diff(), ['newOrdersCount']));
                }
                return this.isAdmin();

            case 'states': case 'districts': case 'cities':
                return this.isAdmin();

            case 'items': case 'categoryData': case 'categories': case 'metadata':
            case 'itemAttributes': case 'poster_config':
                return this.canManageItems();

            case 'xerox_config_paper': case 'xerox_config_binding':
            case 'xerox_config_lamination': case 'xerox_services':
                return this.canManageXerox();

            case 'site_banners': case 'site_config':
                return this.canManageBanners();

            case 'config':
                if (id === 'payment') {
                    if (op === 'delete') return this.isAdmin();
                    const pct = req.onlineDepositPercent;
                    return (await this.isAdmin())
                        && ['cod_only', 'online_only', 'both', 'partial_online'].includes(req.mode)
                        && Number.isInteger(pct) && pct >= 1 && pct <= 99
                        && Number.isInteger(req.version) && req.version >= 1
                        && typeof req.applyToCart === 'boolean'
                        && typeof req.applyToXerox === 'boolean';
                }
                return this.isAdmin();

            case 'product_requests':
                if (op === 'create') return this.isAuth() && req.userId === uid;
                if (op === 'update') return this.canManageRequests();
                return this.isAdmin();

            case 'support_queries':
                if (op === 'create') return this.isAuth() && req.userId === uid;
                if (op === 'update') return this.canManageSupport();
                return this.isAdmin();

            case 'cloudinary_images':
                return this.isAdmin();

            case 'coupons':
                return this.canManageCoupons();

            case 'fcm_tokens':
                return this.isOwner(id);

            // payments, payment_receipts, coupon_usages, order_quotes, coupon_user_usage,
            // wallets, wallet_usages, wallet_stats, referral_codes, referrals,
            // sent_notifications: server only
            default:
                return false;
        }
    }
}
