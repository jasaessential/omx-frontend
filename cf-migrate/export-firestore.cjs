/* ═══════════════════════════════════════════════════════════════════
   Export every Firestore document to cf-migrate/export/<collection>.jsonl
   (one {"path","data"} per line, values already in D1 encoding).

     node cf-migrate/export-firestore.cjs            all collections
     node cf-migrate/export-firestore.cjs orders     just these
     node cf-migrate/export-firestore.cjs --count    counts only (cheap)

   One Firestore read per document (Spark plan: 50,000 reads/day).
   Finished collections get a .done marker and are skipped on the next run,
   so a run cut off by the daily quota can be resumed the next day.
   Uses server/.env credentials. The export holds customer data: it stays on
   this PC (gitignored) and is deleted after the import is checked.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const fs = require('fs');
const SERVER = path.join(__dirname, '..', 'server');
require(path.join(SERVER, 'node_modules', 'dotenv')).config({ path: path.join(SERVER, '.env') });
const admin = require(path.join(SERVER, 'node_modules', 'firebase-admin'));
const { db } = require(path.join(SERVER, 'firebase.js'));

const OUT = path.join(__dirname, 'export');
const SUBCOLLECTION_GROUPS = ['transactions'];   // wallets/{uid}/transactions
const PAGE = 400;

const { Timestamp, GeoPoint, DocumentReference } = admin.firestore;

function enc(v) {
    if (v === null || v === undefined) return v === undefined ? undefined : null;
    if (v instanceof Timestamp) return '__ts:' + v.toDate().toISOString();
    if (v instanceof Date) return '__ts:' + v.toISOString();
    if (v instanceof GeoPoint) return { latitude: v.latitude, longitude: v.longitude };
    if (v instanceof DocumentReference) return v.path;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('base64');
    if (Array.isArray(v)) return v.map(enc);
    if (typeof v === 'object') {
        const o = {};
        for (const [k, x] of Object.entries(v)) { const e = enc(x); if (e !== undefined) o[k] = e; }
        return o;
    }
    if (typeof v === 'number' && !Number.isFinite(v)) return null;   // NaN/Infinity aren't JSON
    return v;
}

async function exportQuery(name, baseQuery) {
    const file = path.join(OUT, `${name}.jsonl`);
    const done = file + '.done';
    if (fs.existsSync(done)) { console.log(`skip ${name} (done)`); return 0; }
    const out = fs.createWriteStream(file);
    let last = null, n = 0;
    for (;;) {
        let q = baseQuery.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        for (const d of snap.docs) {
            out.write(JSON.stringify({ path: d.ref.path, data: enc(d.data()) }) + '\n');
            n++;
        }
        if (snap.size < PAGE) break;
        last = snap.docs[snap.docs.length - 1];
        process.stdout.write(`\r${name}: ${n}`);
    }
    await new Promise(r => out.end(r));
    fs.writeFileSync(done, String(n));
    console.log(`\r${name}: ${n} docs`);
    return n;
}

(async () => {
    const args = process.argv.slice(2);
    const countOnly = args.includes('--count');
    const only = args.filter(a => !a.startsWith('--'));
    fs.mkdirSync(OUT, { recursive: true });

    const cols = (await db.listCollections()).map(c => c.id).filter(c => !only.length || only.includes(c));
    let total = 0;
    for (const c of cols) {
        if (countOnly) {
            const n = (await db.collection(c).count().get()).data().count;
            console.log(c.padEnd(28), n); total += n; continue;
        }
        total += await exportQuery(c, db.collection(c));
    }
    for (const g of SUBCOLLECTION_GROUPS) {
        if (only.length && !only.includes(g)) continue;
        if (countOnly) {
            const n = (await db.collectionGroup(g).count().get()).data().count;
            console.log(('[group] ' + g).padEnd(28), n); total += n; continue;
        }
        // collectionGroup ordered by documentId needs full paths as cursors: page by snapshot instead
        total += await exportQuery(`_group_${g}`, db.collectionGroup(g));
    }
    console.log('TOTAL', total);
    process.exit(0);
})().catch(e => { console.error('\nexport failed:', e.code || '', e.message); process.exit(1); });
