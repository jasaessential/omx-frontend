/* ═══════════════════════════════════════════════════════════════════
   OMX — browser data API, used by /cf-firestore.js (the Firestore shim).

   POST /db/get     { paths: [..] }                      → { docs: [doc|null] }
   POST /db/query   { q }                                → { docs: [doc] }
   POST /db/count   { q }                                → { count }
   POST /db/commit  { writes: [..] }                     → { results: [{path, ver}] }
   POST /db/listen  { targets: [{ key, path | q, v }] }  → { changes: { key: { v, doc | docs } } }

   doc = { path, id, data, ver }   (data keeps the "__ts:" timestamp strings)
   Every call checks cf/rules.js with the caller's Firebase ID token.
   ═══════════════════════════════════════════════════════════════════ */

import { Store, StoreError, docParts, collPath } from './store.js';
import { Rules } from './rules.js';
import { verifyIdToken, bearer } from './auth.js';
import { notifyChanges } from './notify.js';

const MAX_BODY = 4 * 1024 * 1024;

const STATUS = {
    'permission-denied': 403, 'unauthenticated': 401, 'not-found': 404,
    'already-exists': 409, 'aborted': 409, 'failed-precondition': 412,
    'invalid-argument': 400, 'resource-exhausted': 429,
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' },
    });
}

export function errorResponse(e) {
    if (e instanceof StoreError) return json({ error: { code: e.code, message: e.message } }, STATUS[e.code] || 400);
    console.error('[db] internal error:', e && e.stack || e);
    return json({ error: { code: 'internal', message: 'Something went wrong on the server.' } }, 500);
}

async function readBody(request) {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_BODY) throw new StoreError('invalid-argument', 'Request too large');
    const text = await request.text();
    if (text.length > MAX_BODY) throw new StoreError('invalid-argument', 'Request too large');
    try { return text ? JSON.parse(text) : {}; } catch (_) { throw new StoreError('invalid-argument', 'Body is not JSON'); }
}

async function readable(rules, docs) {
    const ok = await Promise.all(docs.map(d => rules.canRead(d.path, d.data)));
    return docs.filter((_, i) => ok[i]);
}

async function runGet(store, rules, paths) {
    if (!Array.isArray(paths) || paths.length > 300) throw new StoreError('invalid-argument', 'paths must be a list (max 300)');
    const docs = await store.getMany(paths);
    return Promise.all(paths.map(async (p, i) => {
        const d = docs[i];
        if (!(await rules.canRead(docParts(p).path, d ? d.data : null))) throw new StoreError('permission-denied', 'Missing or insufficient permissions.');
        return d;
    }));
}

async function runQuery(store, rules, q) {
    if (!q || typeof q !== 'object') throw new StoreError('invalid-argument', 'q is required');
    return readable(rules, await store.query(q));
}

export async function handleDb(request, env, ctx) {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/db\//, '');
    try {
        if (request.method !== 'POST') throw new StoreError('invalid-argument', 'Use POST');
        const token = bearer(request);
        let uid = null;
        if (token) {
            const claims = await verifyIdToken(token, env.FIREBASE_PROJECT_ID);
            if (!claims) throw new StoreError('unauthenticated', 'Session expired. Please sign in again.');
            uid = claims.uid;
        }
        const store = new Store(env.DB);
        const rules = new Rules(store, uid);
        const body = await readBody(request);

        switch (action) {
            case 'get':
                return json({ docs: await runGet(store, rules, body.paths) });

            case 'query':
                return json({ docs: await runQuery(store, rules, body.q) });

            case 'count': {
                // Count only what the caller may read: run the query and filter.
                // Public collections (rules return true without looking at data) use COUNT(*).
                const q = body.q;
                if (await rules.canRead(`${collPath(q.coll)}/_probe_`, { __probe: true })
                    && !['users', 'wallets', 'fcm_tokens'].includes(collPath(q.coll))) {
                    // probe doc readable without owner fields → collection is public
                    return json({ count: await store.count(q) });
                }
                return json({ count: (await runQuery(store, rules, q)).length });
            }

            case 'commit': {
                if (!Array.isArray(body.writes)) throw new StoreError('invalid-argument', 'writes must be a list');
                for (const w of body.writes) {
                    if (!['set', 'create', 'update', 'delete', 'check'].includes(w && w.op)) throw new StoreError('invalid-argument', 'Unknown write');
                }
                // A transaction's read-only version check must not reveal docs the caller can't read
                const checks = body.writes.filter(w => w.op === 'check').map(w => w.path);
                if (checks.length) await runGet(store, rules, checks);
                const results = await store.commit(body.writes, {
                    check: (path, before, after) => rules.checkWrite(path, before, after),
                });
                // Order pushes (new order → staff, status → customer) after the write is safe
                const changes = results.filter(r => r.path.startsWith('orders/')).map(r => ({ path: r.path, before: r.before, after: r.data }));
                if (changes.length && ctx) ctx.waitUntil(notifyChanges(env, changes));
                return json({ results: results.map(r => ({ path: r.path, id: r.id, ver: r.ver })) });
            }

            case 'listen': {
                const targets = Array.isArray(body.targets) ? body.targets.slice(0, 30) : [];
                const collOf = t => t.path ? docParts(t.path).coll : collPath(t.q.coll);
                const versions = await store.collVersions(targets.map(collOf));
                const changes = {};
                for (const t of targets) {
                    const v = versions[collPath(collOf(t))] || 0;
                    if (t.v !== undefined && t.v !== null && Number(t.v) === v) continue;
                    try {
                        if (t.path) changes[t.key] = { v, doc: (await runGet(store, rules, [t.path]))[0] };
                        else changes[t.key] = { v, docs: await runQuery(store, rules, t.q) };
                    } catch (e) {
                        changes[t.key] = { v, error: { code: e.code || 'internal', message: e.message } };
                    }
                }
                return json({ changes });
            }

            default:
                throw new StoreError('not-found', `Unknown data call /db/${action}`);
        }
    } catch (e) {
        return errorResponse(e);
    }
}
