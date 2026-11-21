/* ═══════════════════════════════════════════════════════════════════
   Load cf-migrate/export/*.jsonl into D1.

     node import-d1.mjs              local D1 (what `wrangler dev` in cf/ uses)
     node import-d1.mjs --remote     the real omx-db on Cloudflare
     node import-d1.mjs --remote --wipe   empty docs + coll_versions first
     node import-d1.mjs --remote --merge  cutover catch-up: add docs created in
         Firestore after the first import, and refresh docs Firestore changed
         that D1 has not changed since (ver = 1). D1 edits always win.

   Upserts (path is the key), so re-running is safe. Values go in as bound
   parameters: no 100 KB statement limit, no SQL escaping.
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPORT = path.join(HERE, 'export');
const remote = process.argv.includes('--remote');
const wipe = process.argv.includes('--wipe');
const merge = process.argv.includes('--merge');
if (wipe && merge) { console.error('--wipe and --merge do not go together'); process.exit(1); }

// Same D1 as cf/wrangler.toml; remote = true switches the binding to Cloudflare
const base = fs.readFileSync(path.join(HERE, '..', 'cf', 'wrangler.toml'), 'utf8');
const dbId = base.match(/database_id\s*=\s*"([^"]+)"/)[1];
if (remote && /^0{8}-/.test(dbId)) { console.error('Set the real database_id in cf/wrangler.toml first.'); process.exit(1); }
const cfg = path.join(HERE, '.import.wrangler.toml');
fs.writeFileSync(cfg, `name = "omx-import"
compatibility_date = "2025-10-01"
[[d1_databases]]
binding = "DB"
database_name = "omx-db"
database_id = "${dbId}"
${remote ? 'remote = true' : ''}
`);

const { env, dispose } = await getPlatformProxy({
    configPath: cfg,
    persist: { path: path.join(HERE, '..', 'cf', '.wrangler', 'state', 'v3') },
    ...(remote ? { remoteBindings: true } : {}),
});
const DB = env.DB;
console.log(`Importing into ${remote ? 'REMOTE' : 'local'} D1 omx-db`);

if (wipe) {
    await DB.batch([DB.prepare('DELETE FROM docs'), DB.prepare('DELETE FROM coll_versions')]);
    console.log('wiped');
}

const upsert = DB.prepare(`INSERT INTO docs (path, coll, id, data, ver, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    ${merge ? 'WHERE docs.ver = 1 AND docs.data != excluded.data' : ''}`);
const before = merge ? (await DB.prepare('SELECT COUNT(*) AS n FROM docs').first()).n : 0;

const files = fs.readdirSync(EXPORT).filter(f => f.endsWith('.jsonl')).sort();
let total = 0, big = 0;
const now = Date.now();
for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(EXPORT, f)) });
    let batch = [], n = 0, bytes = 0;
    const flush = async () => { if (batch.length) { await DB.batch(batch); batch = []; bytes = 0; } };
    for await (const line of rl) {
        if (!line.trim()) continue;
        const { path: p, data } = JSON.parse(line);
        const parts = p.split('/');
        const json = JSON.stringify(data);
        if (json.length > 1_900_000) { console.warn(`\n  ! ${p} is ${json.length} bytes — over D1's 2 MB row limit, skipped`); continue; }
        if (json.length > 100_000) big++;
        batch.push(upsert.bind(p, parts.slice(0, -1).join('/'), parts[parts.length - 1], json, now, now));
        bytes += json.length;
        n++;
        if (batch.length >= 50 || bytes > 800_000) await flush();
    }
    await flush();
    total += n;
    console.log(`${f.replace('.jsonl', '').padEnd(28)} ${n}`);
}

// Collection versions: start every collection at 1 (listeners compare for change only)
await DB.prepare(`INSERT INTO coll_versions (coll, v) SELECT DISTINCT coll, 1 FROM docs WHERE true
    ON CONFLICT(coll) DO UPDATE SET v = coll_versions.v + 1`).run();

if (merge) {
    const after = (await DB.prepare('SELECT COUNT(*) AS n FROM docs').first()).n;
    console.log(`\nmerge: ${after - before} docs added that were created in Firestore after the first import`);
}
const { results } = await DB.prepare('SELECT coll, COUNT(*) AS n FROM docs GROUP BY coll ORDER BY n DESC LIMIT 15').all();
console.log(`\nimported ${total} docs (${big} over 100 KB). Biggest collections now in D1:`);
for (const r of results) console.log('  ', r.coll.padEnd(30), r.n);
await dispose();
fs.unlinkSync(cfg);
