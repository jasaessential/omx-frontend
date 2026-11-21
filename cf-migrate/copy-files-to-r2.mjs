// Copy every object in a Supabase Storage bucket "files" into the private R2
// bucket used by server/routes/files.js. Safe to run again: objects already in
// R2 with the same size are skipped. Nothing is deleted from Supabase.
//
//   SB_URL=https://<ref>.supabase.co SB_KEY=<secret key> node copy-files-to-r2.mjs
//   add LEGACY=1 for an older project  → keys go under legacy/<ref>/
//   add DRY=1 to only list and total the files (no R2 writes)
//
// R2 credentials come from ../server/.env (R2_ACCOUNT_ID, R2_FILES_ACCESS_KEY_ID,
// R2_FILES_SECRET_ACCESS_KEY, R2_FILES_BUCKET).
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../server/.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
const { S3Client, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const SB_URL = (process.env.SB_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SB_KEY || '';
const DRY    = !!process.env.DRY;
if (!SB_URL || !SB_KEY) { console.error('Set SB_URL and SB_KEY'); process.exit(1); }
const ref    = new URL(SB_URL).hostname.split('.')[0];
const PREFIX = process.env.LEGACY ? `legacy/${ref}/` : '';
const BUCKET = process.env.R2_FILES_BUCKET || 'omx-customer-files';

const sbHeaders = { apikey: SB_KEY, ...(SB_KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${SB_KEY}` }) };
const enc = p => p.split('/').map(encodeURIComponent).join('/');

async function list(prefix = '', depth = 0) {
    if (depth > 6) return [];
    let out = [], offset = 0;
    for (;;) {
        const r = await fetch(`${SB_URL}/storage/v1/object/list/files`, {
            method: 'POST', headers: { ...sbHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
        });
        if (!r.ok) throw new Error(`list ${prefix}: ${r.status} ${await r.text()}`);
        const items = await r.json();
        for (const it of items) {
            if (it.name === '.emptyFolderPlaceholder') continue;
            if (!it.id) out = out.concat(await list(`${prefix}${it.name}/`, depth + 1));
            else out.push({ path: prefix + it.name, size: it.metadata?.size ?? null, type: it.metadata?.mimetype || null });
        }
        if (items.length < 1000) break;
        offset += 1000;
    }
    return out;
}

const r2 = DRY ? null : new S3Client({
    region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_FILES_ACCESS_KEY_ID || '', secretAccessKey: process.env.R2_FILES_SECRET_ACCESS_KEY || '' },
});

async function copyOne(f) {
    const Key = PREFIX + f.path;
    try {
        const h = await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
        if (f.size == null || h.ContentLength === f.size) return 'skipped';
    } catch (e) { if (e.$metadata?.httpStatusCode !== 404 && e.name !== 'NotFound') throw e; }
    const r = await fetch(`${SB_URL}/storage/v1/object/authenticated/files/${enc(f.path)}`, { headers: sbHeaders });
    if (!r.ok) throw new Error(`download ${r.status}`);
    const body = Buffer.from(await r.arrayBuffer());
    await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: body,
        ContentType: f.type || r.headers.get('content-type') || 'application/octet-stream' }));
    return 'copied';
}

const files = await list();
const total = files.reduce((s, f) => s + (f.size || 0), 0);
const byTop = {};
for (const f of files) { const t = f.path.split('/')[0]; byTop[t] = (byTop[t] || 0) + (f.size || 0); }
console.log(`${ref}: ${files.length} files, ${(total / 1e9).toFixed(3)} GB`);
for (const [t, s] of Object.entries(byTop)) console.log(`  ${t}/  ${(s / 1e6).toFixed(1)} MB`);

const result = { ref, prefix: PREFIX, bucket: BUCKET, at: new Date().toISOString(), files: files.length, bytes: total, copied: 0, skipped: 0, failed: [] };
if (!DRY) {
    let i = 0, done = 0;
    const worker = async () => {
        while (i < files.length) {
            const f = files[i++];
            try { result[await copyOne(f)]++; }
            catch (e) { result.failed.push({ path: f.path, error: e.message }); }
            if (++done % 50 === 0) console.log(`  ${done}/${files.length}`);
        }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    console.log(`copied ${result.copied}, skipped ${result.skipped}, failed ${result.failed.length}`);
    result.failed.slice(0, 20).forEach(f => console.log('  FAIL', f.path, f.error));
}
mkdirSync(new URL('./export/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./export/files-${ref}${DRY ? '-dry' : ''}.json`, import.meta.url),
    JSON.stringify({ ...result, list: files }, null, 1));
process.exit(result.failed.length ? 2 : 0);
