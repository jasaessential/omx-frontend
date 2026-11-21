// Store tests against the local D1 (wrangler getPlatformProxy). Uses a throwaway collection.
//   cd cf-migrate && npm i && node test-store.mjs
import { getPlatformProxy } from 'wrangler';
import { Store, millisToTs } from '../cf/store.js';
import assert from 'node:assert/strict';

const { env, dispose } = await getPlatformProxy({ configPath: '../cf/wrangler.toml', persist: { path: '../cf/.wrangler/state/v3' } });
const s = new Store(env.DB);
const C = 't_' + Date.now();
let pass = 0;
const t = async (name, fn) => {
    try { await fn(); pass++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n     ', e.message); process.exitCode = 1; }
};
const ids = docs => docs.map(d => d.id).join(',');
const Q = (extra) => s.query({ coll: C, ...extra });

await t('set + get', async () => {
    await s.commit([{ op: 'set', path: `${C}/a`, data: { n: 1, s: 'x', b: true, tags: ['p', 'q'], m: { k: 1 }, createdAt: millisToTs(1000) } }]);
    const d = await s.get(`${C}/a`);
    assert.equal(d.data.n, 1); assert.equal(d.ver, 1);
});
await t('more docs', async () => {
    await s.commit([
        { op: 'set', path: `${C}/b`, data: { n: 2, s: 'y', b: false, tags: ['q'], createdAt: millisToTs(2000), userId: 'u1' } },
        { op: 'set', path: `${C}/c`, data: { n: 3, s: 'z', tags: [], createdAt: millisToTs(3000), userId: 'u1', status: null } },
        { op: 'set', path: `${C}/d`, data: { n: '4', s: 'w' } },
    ]);
});
await t('== number (type strict)', async () => assert.equal(ids(await Q({ filters: [{ field: 'n', op: '==', value: 2 }] })), 'b'));
await t('== string', async () => assert.equal(ids(await Q({ filters: [{ field: 'n', op: '==', value: '4' }] })), 'd'));
await t('== bool', async () => assert.equal(ids(await Q({ filters: [{ field: 'b', op: '==', value: false }] })), 'b'));
await t('== null', async () => assert.equal(ids(await Q({ filters: [{ field: 'status', op: '==', value: null }] })), 'c'));
await t('> number skips strings', async () => assert.equal(ids(await Q({ filters: [{ field: 'n', op: '>', value: 1 }] })), 'b,c'));
await t('in', async () => assert.equal(ids(await Q({ filters: [{ field: 's', op: 'in', value: ['x', 'z'] }] })), 'a,c'));
await t('array-contains', async () => assert.equal(ids(await Q({ filters: [{ field: 'tags', op: 'array-contains', value: 'q' }] })), 'a,b'));
await t('array-contains-any', async () => assert.equal(ids(await Q({ filters: [{ field: 'tags', op: 'array-contains-any', value: ['p', 'zz'] }] })), 'a'));
await t('!= skips missing', async () => assert.equal(ids(await Q({ filters: [{ field: 'userId', op: '!=', value: 'u2' }] })), 'b,c'));
await t('nested field', async () => assert.equal(ids(await Q({ filters: [{ field: 'm.k', op: '==', value: 1 }] })), 'a'));
await t('orderBy desc + limit, skips missing', async () => assert.equal(ids(await Q({ orderBy: [{ field: 'createdAt', dir: 'desc' }], limit: 2 })), 'c,b'));
await t('where ts >=', async () => assert.equal(ids(await Q({ filters: [{ field: 'createdAt', op: '>=', value: millisToTs(2000) }] })), 'b,c'));
await t('two filters', async () => assert.equal(ids(await Q({ filters: [{ field: 'userId', op: '==', value: 'u1' }, { field: 'n', op: '<', value: 3 }] })), 'b'));
await t('startAfter cursor', async () => assert.equal(ids(await Q({ orderBy: [{ field: 'createdAt', dir: 'asc' }], startAfter: [millisToTs(1000), 'a'] })), 'b,c'));
await t('limitToLast', async () => assert.equal(ids(await Q({ orderBy: [{ field: 'n', dir: 'asc' }], limitToLast: 2 })), 'c,d'));   // strings sort after numbers, as in Firestore
await t('documentId in', async () => assert.equal(ids(await Q({ filters: [{ field: '__name__', op: 'in', value: ['a', `${C}/c`] }] })), 'a,c'));
await t('count', async () => assert.equal(await s.count({ coll: C, filters: [{ field: 'userId', op: '==', value: 'u1' }] }), 2));
await t('update dotted + increment + arrayUnion + serverTimestamp + delete', async () => {
    await s.commit([{ op: 'update', path: `${C}/a`, data: {
        'm.k': { __op: 'increment', n: 5 }, 'm.z': 'new', tags: { __op: 'arrayUnion', v: ['q', 'r'] },
        at: { __op: 'serverTimestamp' }, s: { __op: 'delete' } } }]);
    const d = (await s.get(`${C}/a`)).data;
    assert.deepEqual(d.m, { k: 6, z: 'new' }); assert.deepEqual(d.tags, ['p', 'q', 'r']);
    assert.ok(d.at.startsWith('__ts:')); assert.equal('s' in d, false);
});
await t('set merge deep', async () => {
    await s.commit([{ op: 'set', path: `${C}/a`, merge: true, data: { m: { y: 2 }, n: { __op: 'increment', n: 1 } } }]);
    const d = (await s.get(`${C}/a`)).data;
    assert.deepEqual(d.m, { k: 6, z: 'new', y: 2 }); assert.equal(d.n, 2);
});
await t('update missing doc → not-found', async () => {
    await assert.rejects(s.commit([{ op: 'update', path: `${C}/nope`, data: { a: 1 } }]), e => e.code === 'not-found');
});
await t('create existing → already-exists, batch rolled back', async () => {
    await assert.rejects(s.commit([{ op: 'set', path: `${C}/e`, data: { a: 1 } }, { op: 'create', path: `${C}/a`, data: {} }]), e => e.code === 'already-exists');
    assert.equal(await s.get(`${C}/e`), null);
});
await t('ver precondition conflict', async () => {
    const d = await s.get(`${C}/b`);
    await s.commit([{ op: 'update', path: `${C}/b`, data: { n: 20 } }]);
    await assert.rejects(s.commit([{ op: 'update', path: `${C}/b`, data: { n: 21 }, precondition: { ver: d.ver } }]), e => e.code === 'aborted');
    assert.equal((await s.get(`${C}/b`)).data.n, 20);
});
await t('check op guards a read-only doc', async () => {
    const d = await s.get(`${C}/c`);
    await s.commit([{ op: 'update', path: `${C}/c`, data: { n: 30 } }]);
    await assert.rejects(s.commit([{ op: 'check', path: `${C}/c`, precondition: { ver: d.ver } }, { op: 'set', path: `${C}/f`, data: {} }]), e => e.code === 'aborted');
    assert.equal(await s.get(`${C}/f`), null);
});
await t('concurrent increments are not lost', async () => {
    await s.commit([{ op: 'set', path: `${C}/ctr`, data: { v: 0 } }]);
    await Promise.all(Array.from({ length: 10 }, () =>
        s.commit([{ op: 'update', path: `${C}/ctr`, data: { v: { __op: 'increment', n: 1 } } }], { retries: 20 })));
    assert.equal((await s.get(`${C}/ctr`)).data.v, 10);
});
await t('subcollection', async () => {
    await s.commit([{ op: 'set', path: `${C}/a/sub/s1`, data: { x: 1 } }]);
    assert.equal(ids(await s.query({ coll: `${C}/a/sub` })), 's1');
});
await t('coll versions bump', async () => {
    const v1 = (await s.collVersions([C]))[C];
    await s.commit([{ op: 'delete', path: `${C}/d` }]);
    assert.equal((await s.collVersions([C]))[C], v1 + 1);
});
await t('index used for userId query', async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT path FROM docs WHERE coll = 'orders' AND json_extract(data, '$."userId"') = 'u'`).all();
    assert.match(JSON.stringify(results), /docs_userId/);
});

await env.DB.prepare('DELETE FROM docs WHERE coll LIKE ?').bind(C + '%').run();
await env.DB.prepare('DELETE FROM coll_versions WHERE coll LIKE ?').bind(C + '%').run();
console.log(`\n${pass} passed`);
await dispose();
