// End-to-end test of the local omx-api (:8799) + edge worker (:8798) with real
// Firebase ID tokens. Creates two throwaway Firebase Auth users and deletes them
// at the end, plus every tst_* document it wrote.
//   node test-api.mjs
import assert from 'node:assert/strict';
import { getPlatformProxy } from 'wrangler';
import { Store } from '../cf/store.js';

const API = 'http://127.0.0.1:8799';
const EDGE = 'http://127.0.0.1:8798';
const KEY = 'AIzaSyCFfeTweRCrvjKp8ScXKTvL7jwI_4vmvQU';   // public web API key (firebase-init.js)
const ORIGIN = 'http://localhost:5500';

const { env, dispose } = await getPlatformProxy({ configPath: '../cf/wrangler.toml', persist: { path: '../cf/.wrangler/state/v3' } });
const store = new Store(env.DB);

async function signUp(tag) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `omx-d1-test-${tag}-${Date.now()}@example.com`, password: 'Test-' + crypto.randomUUID(), returnSecureToken: true }),
    });
    const j = await r.json();
    if (!j.idToken) throw new Error('signUp failed: ' + JSON.stringify(j.error));
    return { uid: j.localId, token: j.idToken, email: j.email };
}
async function delUser(u) {
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: u.token }),
    });
}

const db = async (u, action, body) => {
    const r = await fetch(`${API}/db/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(u ? { Authorization: `Bearer ${u.token}` } : {}) },
        body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
};
const api = async (u, method, path, body, base = API) => {
    const r = await fetch(base + path, {
        method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(u ? { Authorization: `Bearer ${u.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const ts = { __op: 'serverTimestamp' };

let pass = 0;
const t = async (name, fn) => {
    try { await fn(); pass++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      ')); process.exitCode = 1; }
};

const A = await signUp('a');
const B = await signUp('b');
console.log('test users created');
try {
    await store.commit([
        { op: 'set', path: 'items/tst_item', data: { name: 'Test pen', priceOriginal: 60, priceDiscount: 50, category: 'stationary' } },
        { op: 'set', path: 'shops/tst_shop', data: { name: 'Test shop', owners: ['nobody'], status: 'active', deliveryPrices: { others: [{ min: 0, max: null, fee: 10 }] } } },
    ]);

    await t('A creates own profile as plain user', async () => {
        const r = await db(A, 'commit', { writes: [{ op: 'set', path: `users/${A.uid}`, data: { fullName: 'A', email: A.email, role: 'user', roles: ['user'], createdAt: ts } }] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
    });
    await t('B cannot create a profile with admin role', async () => {
        const r = await db(B, 'commit', { writes: [{ op: 'set', path: `users/${B.uid}`, data: { fullName: 'B', roles: ['admin'] } }] });
        assert.equal(r.status, 403);
    });
    await t('A cannot write B\'s profile', async () => {
        assert.equal((await db(A, 'commit', { writes: [{ op: 'set', path: `users/${B.uid}`, data: { fullName: 'x' } }] })).status, 403);
    });
    await t('A cannot promote self', async () => {
        assert.equal((await db(A, 'commit', { writes: [{ op: 'update', path: `users/${A.uid}`, data: { roles: ['admin'] } }] })).status, 403);
    });
    await t('A can edit own name; B cannot read A', async () => {
        assert.equal((await db(A, 'commit', { writes: [{ op: 'update', path: `users/${A.uid}`, data: { fullName: 'A2' } }] })).status, 200);
        assert.equal((await db(B, 'get', { paths: [`users/${A.uid}`] })).status, 403);
        assert.equal((await db(A, 'get', { paths: [`users/${A.uid}`] })).body.docs[0].data.fullName, 'A2');
    });

    let quote;
    await t('server prices the checkout (/api/orders/quote)', async () => {
        const r = await api(A, 'POST', '/api/orders/quote', { groupOrderId: 'tstg1', type: 'product', groups: [{ shopId: 'tst_shop', items: [{ id: 'tst_item', qty: 2, name: 'pen' }] }] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        quote = r.body.groups[0];
        assert.equal(quote.subtotal, 100);
        assert.equal(quote.deliveryFee, 10);
    });
    const order = () => ({
        userId: A.uid, groupOrderId: 'tstg1', shopId: 'tst_shop', type: 'product', items: quote.items,
        subtotal: quote.subtotal, deliveryFee: quote.deliveryFee, totalAmount: 110,
        paymentMethod: 'COD', paymentStatus: 'cod', status: 'Pending', createdAt: ts,
    });
    await t('order matching the quote is accepted', async () => {
        const r = await db(A, 'commit', { writes: [{ op: 'create', path: 'orders/tst_o1', data: order() }] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
    });
    await t('order with a changed subtotal is refused', async () => {
        assert.equal((await db(A, 'commit', { writes: [{ op: 'create', path: 'orders/tst_o2', data: { ...order(), subtotal: 1 } }] })).status, 403);
    });
    await t('order marked paid by the customer is refused', async () => {
        assert.equal((await db(A, 'commit', { writes: [{ op: 'create', path: 'orders/tst_o3', data: { ...order(), paidAt: ts } }] })).status, 403);
    });
    await t('B cannot read A\'s order; B\'s query sees nothing', async () => {
        assert.equal((await db(B, 'get', { paths: ['orders/tst_o1'] })).status, 403);
        const r = await db(B, 'query', { q: { coll: 'orders', filters: [{ field: 'userId', op: '==', value: A.uid }] } });
        assert.equal(r.body.docs.length, 0);
    });
    let v0;
    await t('A lists own orders newest first', async () => {
        const r = await db(A, 'query', { q: { coll: 'orders', filters: [{ field: 'userId', op: '==', value: A.uid }], orderBy: [{ field: 'createdAt', dir: 'desc' }] } });
        assert.equal(r.body.docs.map(d => d.id).join(), 'tst_o1');
        assert.ok(r.body.docs[0].data.createdAt.startsWith('__ts:'));
    });
    await t('listen: first call returns data, repeat returns nothing', async () => {
        const q = { coll: 'orders', filters: [{ field: 'userId', op: '==', value: A.uid }] };
        const r1 = await db(A, 'listen', { targets: [{ key: 'k', q }] });
        v0 = r1.body.changes.k.v;
        assert.equal(r1.body.changes.k.docs.length, 1);
        const r2 = await db(A, 'listen', { targets: [{ key: 'k', q, v: v0 }] });
        assert.deepEqual(r2.body.changes, {});
    });
    await t('A cannot change the total of own order', async () => {
        assert.equal((await db(A, 'commit', { writes: [{ op: 'update', path: 'orders/tst_o1', data: { totalAmount: 1 } }] })).status, 403);
    });
    await t('A can cancel own Pending order; listener sees the change', async () => {
        const r = await db(A, 'commit', { writes: [{ op: 'update', path: 'orders/tst_o1', data: { status: 'Cancelled', cancelledAt: ts } }] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const q = { coll: 'orders', filters: [{ field: 'userId', op: '==', value: A.uid }] };
        const r2 = await db(A, 'listen', { targets: [{ key: 'k', q, v: v0 }] });
        assert.equal(r2.body.changes.k.docs[0].data.status, 'Cancelled');
    });
    await t('transaction precondition: stale version is refused', async () => {
        const cur = (await db(A, 'get', { paths: [`users/${A.uid}`] })).body.docs[0];
        await db(A, 'commit', { writes: [{ op: 'update', path: `users/${A.uid}`, data: { phone: '1' } }] });
        const r = await db(A, 'commit', { writes: [{ op: 'update', path: `users/${A.uid}`, data: { phone: '2' }, precondition: { ver: cur.ver } }] });
        assert.equal(r.status, 409);
    });
    await t('check op on an unreadable doc is refused', async () => {
        assert.equal((await db(B, 'commit', { writes: [{ op: 'check', path: `users/${A.uid}`, precondition: { ver: 1 } }] })).status, 403);
    });
    await t('anonymous: public items readable, wallets not', async () => {
        assert.equal((await db(null, 'get', { paths: ['items/tst_item'] })).status, 200);
        assert.equal((await db(null, 'get', { paths: [`wallets/${A.uid}`] })).status, 403);
    });
    await t('referral code via server transaction (/api/referral/me)', async () => {
        const r = await api(A, 'GET', '/api/referral/me');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.match(r.body.code, /^[A-Z0-9]{4,}$/);
        const again = await api(A, 'GET', '/api/referral/me');
        assert.equal(again.body.code, r.body.code);
        assert.equal((await store.get(`users/${A.uid}`)).data.referralCode, r.body.code);
    });
    await t('coupon validate with token reaches D1', async () => {
        const r = await api(A, 'POST', '/api/coupon/validate', { code: 'NOPE123', subtotal: 100, orderType: 'product', shopIds: ['tst_shop'] });
        assert.equal(r.status, 400); assert.match(r.body.error, /Invalid coupon/);
    });
    await t('bad token is refused', async () => {
        const r = await fetch(`${API}/db/get`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x.y.z' }, body: '{"paths":["items/tst_item"]}' });
        assert.equal(r.status, 401);
    });
    await t('CORS: unknown origin refused, local origin allowed', async () => {
        const bad = await fetch(`${API}/db/get`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"paths":[]}' });
        assert.equal(bad.status, 403);
        const ok = await fetch(`${API}/db/get`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
        assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    });
    await t('edge worker admin check reads roles from D1', async () => {
        assert.equal((await api(A, 'GET', '/api/cache/status', null, EDGE)).status, 401);
        await store.commit([{ op: 'update', path: `users/${A.uid}`, data: { roles: ['admin'] } }]);
        assert.equal((await api(A, 'GET', '/api/cache/status', null, EDGE)).status, 200);
    });
    await t('push: new COD order reaches FCM for shop staff; dead token is removed', async () => {
        // B owns the shop and has one fake device token; FCM must reject it and the Worker drop it
        const fake = 'fake-token-' + 'x'.repeat(40);
        await store.commit([
            { op: 'set', path: `users/${B.uid}`, data: { fullName: 'B', roles: ['seller'], fcmTokens: [fake] } },
            { op: 'update', path: 'shops/tst_shop', data: { owners: [B.uid] } },
        ]);
        const q = await api(A, 'POST', '/api/orders/quote', { groupOrderId: 'tstg2', type: 'product', groups: [{ shopId: 'tst_shop', items: [{ id: 'tst_item', qty: 1, name: 'pen' }] }] });
        const g = q.body.groups[0];
        const r = await db(A, 'commit', { writes: [{ op: 'create', path: 'orders/tst_o4', data: {
            userId: A.uid, groupOrderId: 'tstg2', shopId: 'tst_shop', type: 'product', items: g.items,
            subtotal: g.subtotal, deliveryFee: g.deliveryFee, totalAmount: g.subtotal + g.deliveryFee,
            paymentMethod: 'COD', paymentStatus: 'cod', status: 'Pending', createdAt: ts } }] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        let left;
        for (let i = 0; i < 20; i++) {
            await new Promise(res => setTimeout(res, 500));
            left = (await store.get(`users/${B.uid}`)).data.fcmTokens;
            if (!left.length) break;
        }
        assert.deepEqual(left, [], 'fake token should have been removed after FCM rejected it');
    });
    await t('push: seller confirming the order triggers the customer push', async () => {
        const fake = 'fake-token-' + 'y'.repeat(40);
        await store.commit([{ op: 'update', path: `users/${A.uid}`, data: { fcmTokens: [fake] } }]);
        const r = await db(B, 'commit', { writes: [{ op: 'update', path: 'orders/tst_o4', data: { status: 'Confirmed' } }] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        let left;
        for (let i = 0; i < 20; i++) {
            await new Promise(res => setTimeout(res, 500));
            left = (await store.get(`users/${A.uid}`)).data.fcmTokens;
            if (!left.length) break;
        }
        assert.deepEqual(left, []);
    });
    await t('admin A can read B-less orders list and any order', async () => {
        assert.equal((await db(A, 'get', { paths: ['orders/tst_o1'] })).status, 200);
        assert.equal((await db(A, 'count', { q: { coll: 'orders' } })).body.count >= 1, true);
    });
} finally {
    const del = ['items/tst_item', 'shops/tst_shop', 'orders/tst_o1', 'orders/tst_o4', 'order_quotes/tstg1', 'order_quotes/tstg2', `users/${A.uid}`, `users/${B.uid}`];
    const u = await store.get(`users/${A.uid}`);
    if (u?.data.referralCode) del.push(`referral_codes/${u.data.referralCode}`);
    await store.commit(del.map(p => ({ op: 'delete', path: p })));
    await delUser(A); await delUser(B);
    console.log(`\n${pass} passed — test docs and test users removed`);
    await dispose();
}
