/* ═══════════════════════════════════════════════════════════════════
   OMX — temporary Firestore → D1 bridge for the OLD Play app.

   Until users update the Flutter app (the new build talks to D1), the old
   build keeps writing to Firestore (with the Render server). This runs from
   the omx-api cron and copies what the old app creates into D1:
     new orders (+ their order_status docs), orders that got paid, new users,
     payments, support queries, product requests.
   Rules, same as `import-d1.mjs --merge`:
     - a doc missing in D1 is added;
     - a doc D1 hasn't changed since the bridge/import wrote it (ver = 1) is
       refreshed; anything edited in D1 wins.
   New/paid orders go through cf/notify.js, so staff get the push.

   Cost: each query reads only docs created/paid since the last run (plus one
   read per empty query). Turn off by removing BRIDGE_FIRESTORE.
   ═══════════════════════════════════════════════════════════════════ */

import { serviceAccount, accessToken } from './fcm.js';
import { notifyChanges } from './notify.js';

const SCOPE = 'https://www.googleapis.com/auth/datastore';
const OVERLAP_MS = 3 * 60 * 1000;          // re-read a little to cover clock skew / slow writes
const FIRST_RUN_LOOKBACK_MS = 6 * 3600 * 1000;

/* Firestore REST value → our stored JSON */
function val(v) {
    if (!v || typeof v !== 'object') return null;
    if ('nullValue' in v) return null;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('stringValue' in v) return v.stringValue;
    if ('timestampValue' in v) return '__ts:' + new Date(v.timestampValue).toISOString();
    if ('geoPointValue' in v) return { latitude: v.geoPointValue.latitude || 0, longitude: v.geoPointValue.longitude || 0 };
    if ('referenceValue' in v) return v.referenceValue.split('/documents/')[1] || v.referenceValue;
    if ('bytesValue' in v) return v.bytesValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
    if ('mapValue' in v) return fields(v.mapValue.fields);
    return null;
}
const fields = f => Object.fromEntries(Object.entries(f || {}).map(([k, x]) => [k, val(x)]));
const docPath = name => name.split('/documents/')[1];

async function runQuery(base, token, collectionId, field, sinceIso) {
    const res = await fetch(`${base}:runQuery`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredQuery: {
            from: [{ collectionId }],
            where: { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: sinceIso } } },
            limit: 500,
        } }),
    });
    if (!res.ok) throw new Error(`Firestore ${collectionId}.${field}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).filter(r => r.document).map(r => ({ path: docPath(r.document.name), data: fields(r.document.fields) }));
}

async function batchGet(base, token, projectId, paths) {
    if (!paths.length) return [];
    const res = await fetch(`${base}:batchGet`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: paths.map(p => `projects/${projectId}/databases/(default)/documents/${p}`) }),
    });
    if (!res.ok) throw new Error(`Firestore batchGet: ${res.status}`);
    return (await res.json()).filter(r => r.found).map(r => ({ path: docPath(r.found.name), data: fields(r.found.fields) }));
}

/** Upsert by the merge rule; returns [{ path, before, after, isNew }] for docs actually written. */
async function upsert(DB, docs) {
    const out = [];
    if (!docs.length) return out;
    const now = Date.now();
    for (let i = 0; i < docs.length; i += 50) {
        const part = docs.slice(i, i + 50);
        const { results } = await DB.prepare(`SELECT path, data, ver FROM docs WHERE path IN (${part.map(() => '?').join(',')})`)
            .bind(...part.map(d => d.path)).all();
        const cur = new Map(results.map(r => [r.path, r]));
        const stmts = [];
        for (const d of part) {
            const json = JSON.stringify(d.data);
            const row = cur.get(d.path);
            const parts = d.path.split('/');
            if (!row) {
                stmts.push(DB.prepare(`INSERT INTO docs (path, coll, id, data, ver, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
                    ON CONFLICT(path) DO NOTHING`).bind(d.path, parts.slice(0, -1).join('/'), parts[parts.length - 1], json, now, now));
                out.push({ path: d.path, before: null, after: d.data, isNew: true });
            } else if (row.ver === 1 && row.data !== json) {
                stmts.push(DB.prepare(`UPDATE docs SET data = ?, updated_at = ? WHERE path = ? AND ver = 1`).bind(json, now, d.path));
                out.push({ path: d.path, before: JSON.parse(row.data), after: d.data, isNew: false });
            }
        }
        if (stmts.length) await DB.batch(stmts);
    }
    const colls = [...new Set(out.map(o => o.path.split('/').slice(0, -1).join('/')))];
    if (colls.length) {
        await DB.batch(colls.map(c => DB.prepare(`INSERT INTO coll_versions (coll, v) VALUES (?, 1) ON CONFLICT(coll) DO UPDATE SET v = v + 1`).bind(c)));
    }
    return out;
}

export async function bridgeFromFirestore(env) {
    if (!env.BRIDGE_FIRESTORE) return { skipped: true };
    const t0 = Date.now();
    const DB = env.DB;
    await DB.prepare(`CREATE TABLE IF NOT EXISTS bridge_state (k TEXT PRIMARY KEY, v TEXT)`).run();
    const last = await DB.prepare(`SELECT v FROM bridge_state WHERE k = 'since'`).first();
    const sinceMs = last ? Number(last.v) - OVERLAP_MS : t0 - FIRST_RUN_LOOKBACK_MS;
    const sinceIso = new Date(sinceMs).toISOString();

    const sa = serviceAccount(env);
    const token = await accessToken(sa, SCOPE);
    const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;

    let failed = 0;
    const q = (c, f) => runQuery(base, token, c, f, sinceIso).catch(e => { failed++; console.warn('[bridge]', e.message); return []; });
    const [orders, paidOrders, users, payments, support, requests] = await Promise.all([
        q('orders', 'createdAt'), q('orders', 'paidAt'), q('users', 'createdAt'),
        q('payments', 'createdAt'), q('support_queries', 'createdAt'), q('product_requests', 'createdAt'),
    ]);
    const orderMap = new Map([...orders, ...paidOrders].map(d => [d.path, d]));
    const statusDocs = await batchGet(base, token, sa.project_id,
        [...orderMap.keys()].map(p => p.replace(/^orders\//, 'order_status/'))).catch(e => { failed++; console.warn('[bridge]', e.message); return []; });

    const written = await upsert(DB, [...orderMap.values(), ...statusDocs, ...users, ...payments, ...support, ...requests]);
    // Push only for fresh events: a first run or catch-up must not re-alert staff about old orders
    const fresh = d => {
        const t = [d.paidAt, d.createdAt].map(v => (typeof v === 'string' && v.startsWith('__ts:')) ? Date.parse(v.slice(5)) : 0);
        return Math.max(...t) > t0 - 20 * 60 * 1000;
    };
    const orderChanges = written.filter(w => w.path.startsWith('orders/') && fresh(w.after))
        .map(w => ({ path: w.path, before: w.before, after: w.after }));
    if (orderChanges.length) await notifyChanges(env, orderChanges);

    // Only move the marker after a complete run, so nothing created during an outage is skipped
    if (!failed) await DB.prepare(`INSERT INTO bridge_state (k, v) VALUES ('since', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(t0)).run();
    const summary = { since: sinceIso, read: orderMap.size + statusDocs.length + users.length + payments.length + support.length + requests.length,
        written: written.length, failedQueries: failed, newOrders: written.filter(w => w.isNew && w.path.startsWith('orders/')).length, ms: Date.now() - t0 };
    console.log('[bridge]', JSON.stringify(summary));
    return summary;
}
