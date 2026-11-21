/* ═══════════════════════════════════════════════════════════════════
   OMX — D1 document store (replaces Firestore)

   Every Firestore document is one row in `docs`:
     path  'orders/abc'  or  'wallets/u1/transactions/t9'
     coll  'orders'      or  'wallets/u1/transactions'
     data  the document as JSON (see value encoding below)
     ver   bumped on every write (optimistic concurrency, like Firestore's
           update time)
   `coll_versions` holds one counter per collection, bumped on every write
   to it. Pages that "listen" (onSnapshot) poll that counter and only re-run
   their query when it changed — one row read per poll.

   Value encoding in `data`:
     Timestamp / Date  → "__ts:2026-11-21T02:09:24.123Z"  (sorts as text)
     everything else   → plain JSON
   Write sentinels (sent by the client shim and the admin shim):
     { "__op": "serverTimestamp" } { "__op": "increment", "n": 1 }
     { "__op": "arrayUnion", "v": [..] } { "__op": "arrayRemove", "v": [..] }
     { "__op": "delete" }
   ═══════════════════════════════════════════════════════════════════ */

export const TS_PREFIX = '__ts:';

export const isTs = v => typeof v === 'string' && v.startsWith(TS_PREFIX);
export const tsToMillis = v => Date.parse(v.slice(TS_PREFIX.length));
export const millisToTs = ms => TS_PREFIX + new Date(ms).toISOString();

export class StoreError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

/* ── paths ──────────────────────────────────────────────────────────── */

export function splitPath(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    for (const p of parts) {
        if (p === '.' || p === '..' || p.length > 300) throw new StoreError('invalid-argument', `Bad path segment "${p}"`);
    }
    return parts;
}

export function docParts(path) {
    const parts = splitPath(path);
    if (parts.length < 2 || parts.length % 2) throw new StoreError('invalid-argument', `"${path}" is not a document path`);
    return { path: parts.join('/'), coll: parts.slice(0, -1).join('/'), id: parts[parts.length - 1] };
}

export function collPath(path) {
    const parts = splitPath(path);
    if (!parts.length || parts.length % 2 === 0) throw new StoreError('invalid-argument', `"${path}" is not a collection path`);
    return parts.join('/');
}

/* Firestore-style auto id (20 chars) */
export function autoId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    let id = '';
    for (const b of bytes) id += chars[b % 62];
    return id;
}

/* ── value helpers ──────────────────────────────────────────────────── */

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSentinel = v => isPlainObject(v) && typeof v.__op === 'string';

/* Deep equality with Firestore semantics (map key order ignored). */
export function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        return a.every((x, i) => deepEqual(x, b[i]));
    }
    if (isPlainObject(a)) {
        if (!isPlainObject(b)) return false;
        const ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
    }
    return false;
}

/* Field path "a.b.c" → ['a','b','c'] (also accepts arrays) */
const fieldSegs = f => Array.isArray(f) ? f : String(f).split('.');

export function getField(data, field) {
    let cur = data;
    for (const s of fieldSegs(field)) {
        if (!isPlainObject(cur) || !(s in cur)) return undefined;
        cur = cur[s];
    }
    return cur;
}

function setField(data, segs, value) {
    let cur = data;
    for (let i = 0; i < segs.length - 1; i++) {
        if (!isPlainObject(cur[segs[i]])) cur[segs[i]] = {};
        cur = cur[segs[i]];
    }
    if (value === undefined) delete cur[segs[segs.length - 1]];
    else cur[segs[segs.length - 1]] = value;
}

/* Resolve one sentinel against the field's current value. */
function applySentinel(op, current, nowTs) {
    switch (op.__op) {
        case 'serverTimestamp': return nowTs;
        case 'delete':          return undefined;
        case 'increment': {
            const base = typeof current === 'number' ? current : 0;
            return base + Number(op.n || 0);
        }
        case 'arrayUnion': {
            const arr = Array.isArray(current) ? current.slice() : [];
            for (const v of op.v || []) if (!arr.some(x => deepEqual(x, v))) arr.push(v);
            return arr;
        }
        case 'arrayRemove': {
            const arr = Array.isArray(current) ? current : [];
            return arr.filter(x => !(op.v || []).some(v => deepEqual(x, v)));
        }
        default: throw new StoreError('invalid-argument', `Unknown field transform ${op.__op}`);
    }
}

/* Walk a value, resolving sentinels nested inside maps (set / set-merge). */
function resolveDeep(value, current, nowTs) {
    if (isSentinel(value)) return applySentinel(value, current, nowTs);
    if (isPlainObject(value)) {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const r = resolveDeep(v, isPlainObject(current) ? current[k] : undefined, nowTs);
            if (r !== undefined) out[k] = r;
        }
        return out;
    }
    if (Array.isArray(value)) return value.map(v => resolveDeep(v, undefined, nowTs)).filter(v => v !== undefined);
    return value;
}

/* Deep merge for set(..., {merge:true}): maps merge, everything else replaces. */
function mergeInto(target, src, nowTs) {
    const out = isPlainObject(target) ? { ...target } : {};
    for (const [k, v] of Object.entries(src)) {
        if (isSentinel(v)) {
            const r = applySentinel(v, out[k], nowTs);
            if (r === undefined) delete out[k]; else out[k] = r;
        } else if (isPlainObject(v)) {
            out[k] = mergeInto(out[k], v, nowTs);
        } else if (v !== undefined) {
            out[k] = resolveDeep(v, undefined, nowTs);
        }
    }
    return out;
}

/**
 * Compute the document after one write.
 * w = { op: 'set'|'create'|'update'|'delete', data, merge?, mergeFields? }
 * before = current data or null. Returns new data, or null for delete.
 */
export function applyWrite(before, w, nowTs) {
    if (w.op === 'delete') return null;
    const data = w.data || {};
    if (w.op === 'create' || (w.op === 'set' && !w.merge && !w.mergeFields)) {
        return resolveDeep(data, null, nowTs);
    }
    if (w.op === 'set' && w.mergeFields) {
        const out = isPlainObject(before) ? structuredClone(before) : {};
        for (const f of w.mergeFields) {
            const segs = fieldSegs(f);
            setField(out, segs, resolveDeep(getField(data, segs), getField(out, segs), nowTs));
        }
        return out;
    }
    if (w.op === 'set') return mergeInto(before, data, nowTs);
    if (w.op === 'update') {
        // Keys are field paths ("a.b" updates nested a.b); values replace whole.
        const out = isPlainObject(before) ? structuredClone(before) : {};
        for (const [k, v] of Object.entries(data)) {
            const segs = fieldSegs(k);
            setField(out, segs, resolveDeep(v, getField(out, segs), nowTs));
        }
        return out;
    }
    throw new StoreError('invalid-argument', `Unknown write op ${w.op}`);
}

/* ── query compilation ──────────────────────────────────────────────── */

function jsonPath(field) {
    if (field === '__name__') return null;
    const segs = fieldSegs(field);
    for (const s of segs) {
        if (!s || /["'\\]/.test(s)) throw new StoreError('invalid-argument', `Bad field name "${field}"`);
    }
    return '$.' + segs.map(s => `"${s}"`).join('.');
}

/* SQL bind value for a JSON scalar. Booleans → 1/0 (json_extract returns ints). */
function bindVal(v) {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === undefined) return null;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
}

/* json_type() values that Firestore would consider comparable with v */
function typeGuard(expr, v) {
    if (typeof v === 'number')  return `json_type(data, ${expr}) IN ('integer','real')`;
    if (typeof v === 'string')  return `json_type(data, ${expr}) = 'text'`;
    if (typeof v === 'boolean') return `json_type(data, ${expr}) IN ('true','false')`;
    return `json_type(data, ${expr}) IS NOT NULL`;
}

/**
 * q = { coll, filters:[{field,op,value}], orderBy:[{field,dir}], limit, limitToLast,
 *       offset, startAt/startAfter/endAt/endBefore: [values...] (orderBy fields, then id) }
 * Returns { sql, binds }.
 */
export function compileQuery(q, { count = false } = {}) {
    const where = ['coll = ?'];
    const binds = [collPath(q.coll)];

    for (const f of q.filters || []) {
        const local = [];
        where.push('(' + compileFilterSafe(f, local) + ')');
        binds.push(...local);
    }

    const orders = (q.orderBy || []).map(o => ({ field: o.field, dir: (o.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC' }));
    // Firestore leaves out docs that lack an orderBy field
    for (const o of orders) {
        if (o.field === '__name__') continue;
        where.push(`json_type(data, ?) IS NOT NULL`);
        binds.push(jsonPath(o.field));
    }

    // Cursors: compare (orderBy values..., id) lexicographically
    const lastDir = orders.length ? orders[orders.length - 1].dir : 'ASC';
    const keyCols = [...orders.map(o => o.field), '__name__'];
    const keyDirs = [...orders.map(o => o.dir), lastDir];
    const cursorClause = (vals, kind) => {
        // kind: 'startAt' | 'startAfter' | 'endAt' | 'endBefore'
        if (!Array.isArray(vals) || !vals.length) return null;
        const n = Math.min(vals.length, keyCols.length);
        const after = kind === 'startAt' || kind === 'startAfter';
        const inclusive = kind === 'startAt' || kind === 'endAt';
        const ors = [];
        const lb = [];
        for (let i = 0; i < n; i++) {
            const parts = [];
            for (let j = 0; j < i; j++) { parts.push(`${colExpr(keyCols[j], lb)} = ?`); lb.push(bindVal(cursorVal(keyCols[j], vals[j]))); }
            const asc = keyDirs[i] === 'ASC';
            const gt = after === asc;
            const isLast = i === n - 1;
            const op = gt ? (isLast && inclusive ? '>=' : '>') : (isLast && inclusive ? '<=' : '<');
            parts.push(`${colExpr(keyCols[i], lb)} ${op} ?`); lb.push(bindVal(cursorVal(keyCols[i], vals[i])));
            ors.push('(' + parts.join(' AND ') + ')');
        }
        return { sql: '(' + ors.join(' OR ') + ')', binds: lb };
    };
    for (const kind of ['startAt', 'startAfter', 'endAt', 'endBefore']) {
        const c = cursorClause(q[kind], kind);
        if (c) { where.push(c.sql); binds.push(...c.binds); }
    }

    if (count) return inlinePaths(`SELECT COUNT(*) AS n FROM docs WHERE ${where.join(' AND ')}`, binds);

    const reverse = !!q.limitToLast;
    const orderSql = [];
    for (const o of orders) {
        const dir = reverse ? (o.dir === 'ASC' ? 'DESC' : 'ASC') : o.dir;
        if (o.field === '__name__') orderSql.push(`id ${dir}`);
        else { orderSql.push(`json_extract(data, ?) ${dir}`); binds.push(jsonPath(o.field)); }
    }
    if (!orders.some(o => o.field === '__name__')) orderSql.push(`id ${reverse ? (lastDir === 'ASC' ? 'DESC' : 'ASC') : lastDir}`);

    let sql = `SELECT path, id, data, ver FROM docs WHERE ${where.join(' AND ')} ORDER BY ${orderSql.join(', ')}`;
    const lim = q.limitToLast || q.limit;
    if (lim) { sql += ' LIMIT ?'; binds.push(Math.max(0, Math.floor(lim))); }
    if (q.offset) { if (!lim) sql += ' LIMIT -1'; sql += ' OFFSET ?'; binds.push(Math.max(0, Math.floor(q.offset))); }
    return { ...inlinePaths(sql, binds), reverse };
}

/* Paths are bound as "?" while building; inline them as literals so SQLite can
   use the expression indexes in schema.sql. Path placeholders are exactly the
   ones written as "(data, ?". jsonPath() already rejected quotes. */
function inlinePaths(sql, binds) {
    let i = 0;
    const out = [];
    const text = sql.replace(/(\(data, )?\?/g, (m, pre) => {
        const v = binds[i++];
        if (pre) return pre + "'" + v + "'";
        out.push(v);
        return "?";
    });
    return { sql: text, binds: out };
}

function colExpr(field, binds) {
    if (field === '__name__') return 'id';
    binds.push(jsonPath(field));
    return 'json_extract(data, ?)';
}
const cursorVal = (field, v) => field === '__name__' ? String(v).split('/').pop() : v;

/* One where() clause → SQL; pushes its own binds in placeholder order. */
function compileFilterSafe(f, b) {
    const { field, op, value } = f;
    if (field === "__name__") {
        // documentId() filters compare the doc id (value may be a full path)
        const idOf = v => String(v).split("/").pop();
        if (op === "in" || op === "not-in") {
            const list = (value || []).map(idOf);
            if (!list.length) return op === "in" ? "0" : "1";
            b.push(...list);
            return `id ${op === "in" ? "IN" : "NOT IN"} (${list.map(() => "?").join(",")})`;
        }
        const sqlOp = { "==": "=", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=" }[op];
        if (!sqlOp) throw new StoreError("invalid-argument", `Unsupported op ${op} on documentId`);
        b.push(idOf(value));
        return `id ${sqlOp} ?`;
    }
    const p = jsonPath(field);
    switch (op) {
        case "==":
            if (value === null) { b.push(p); return "json_type(data, ?) = 'null'"; }
            if (Array.isArray(value) || isPlainObject(value)) {
                b.push(p, JSON.stringify(value));
                return "json_extract(data, ?) = json(?)";
            }
            b.push(p, p, bindVal(value));
            return `${typeGuard("?", value)} AND json_extract(data, ?) = ?`;
        case "!=":
            // Firestore "!=" skips docs without the field and docs where it is null
            if (value === null) { b.push(p); return "json_type(data, ?) NOT IN ('null')"; }
            b.push(p, p, bindVal(value));
            return "json_type(data, ?) NOT IN ('null') AND json_extract(data, ?) IS NOT ?";
        case "<": case "<=": case ">": case ">=":
            b.push(p, p, bindVal(value));
            return `${typeGuard("?", value)} AND json_extract(data, ?) ${op} ?`;
        case "in": {
            const list = Array.isArray(value) ? value : [];
            if (!list.length) return "0";
            b.push(p, ...list.map(bindVal));
            return `json_extract(data, ?) IN (${list.map(() => "?").join(",")})`;
        }
        case "not-in": {
            const list = Array.isArray(value) ? value : [];
            b.push(p, p, ...list.map(bindVal));
            return `json_type(data, ?) NOT IN ('null') AND json_extract(data, ?) NOT IN (${list.map(() => "?").join(",") || "NULL"})`;
        }
        case "array-contains":
        case "array-contains-any": {
            const list = op === "array-contains" ? [value] : (Array.isArray(value) ? value : []);
            if (!list.length) return "0";
            b.push(p, p, ...list.map(bindVal));
            return `json_type(data, ?) = 'array' AND EXISTS (SELECT 1 FROM json_each(data, ?) WHERE value IN (${list.map(() => "?").join(",")}))`;
        }
        default:
            throw new StoreError("invalid-argument", `Unsupported query operator ${op}`);
    }
}

/* In-memory version of a filter (used by rules and by the client for re-checks). */
export function matchesFilter(data, f) {
    const v = f.field === '__name__' ? undefined : getField(data, f.field);
    switch (f.op) {
        case '==': return v !== undefined && deepEqual(v, f.value);
        case '!=': return v !== undefined && v !== null && !deepEqual(v, f.value);
        case 'in': return v !== undefined && (f.value || []).some(x => deepEqual(x, v));
        case 'array-contains': return Array.isArray(v) && v.some(x => deepEqual(x, f.value));
        default: return true;
    }
}

/* ── the store ──────────────────────────────────────────────────────── */

export class Store {
    constructor(d1) {
        if (!d1) throw new Error('D1 binding DB is missing');
        this.d1 = d1;
    }

    static parseRow(row) {
        return row ? { path: row.path, id: row.id, data: JSON.parse(row.data), ver: row.ver } : null;
    }

    async get(path) {
        const { path: p } = docParts(path);
        const row = await this.d1.prepare('SELECT path, id, data, ver FROM docs WHERE path = ?').bind(p).first();
        return Store.parseRow(row);
    }

    async getMany(paths) {
        if (!paths.length) return [];
        const norm = paths.map(p => docParts(p).path);
        const out = new Map();
        // D1 limits bound parameters per statement (100); chunk.
        for (let i = 0; i < norm.length; i += 90) {
            const chunk = norm.slice(i, i + 90);
            const { results } = await this.d1.prepare(
                `SELECT path, id, data, ver FROM docs WHERE path IN (${chunk.map(() => '?').join(',')})`
            ).bind(...chunk).all();
            for (const r of results) out.set(r.path, Store.parseRow(r));
        }
        return norm.map(p => out.get(p) || null);
    }

    async query(q) {
        const { sql, binds, reverse } = compileQuery(q);
        const { results } = await this.d1.prepare(sql).bind(...binds).all();
        const docs = results.map(Store.parseRow);
        return reverse ? docs.reverse() : docs;
    }

    async count(q) {
        const { sql, binds } = compileQuery(q, { count: true });
        const row = await this.d1.prepare(sql).bind(...binds).first();
        return row ? row.n : 0;
    }

    async collVersions(colls) {
        if (!colls.length) return {};
        const uniq = [...new Set(colls.map(collPath))];
        const { results } = await this.d1.prepare(
            `SELECT coll, v FROM coll_versions WHERE coll IN (${uniq.map(() => '?').join(',')})`
        ).bind(...uniq).all();
        const out = Object.fromEntries(uniq.map(c => [c, 0]));
        for (const r of results) out[r.coll] = r.v;
        return out;
    }

    /**
     * Apply writes atomically.
     * writes: [{ op, path, data?, merge?, mergeFields?, precondition? }]
     *   precondition: { exists: true|false } or { ver: n } (n = version read)
     * opts.check(path, before, after, write) — optional async hook (rules);
     *   throw to refuse.
     * opts.retries — re-read and retry when a concurrent write slipped in
     *   (only when no explicit ver preconditions were given).
     * Returns [{ path, id, data, ver }] (data null for deletes).
     */
    async commit(writes, opts = {}) {
        if (!Array.isArray(writes) || !writes.length) return [];
        if (writes.length > 500) throw new StoreError('invalid-argument', 'Too many writes in one batch (max 500)');
        const hasVerPre = writes.some(w => w.precondition && 'ver' in w.precondition);
        const attempts = hasVerPre ? 1 : (opts.retries ?? 5);

        for (let attempt = 0; attempt < attempts; attempt++) {
            const norm = writes.map(w => ({ ...w, ...docParts(w.path) }));
            const uniq = [...new Set(norm.map(w => w.path))];
            const current = new Map();
            (await this.getMany(uniq)).forEach((d, i) => current.set(uniq[i], d));
            const readVer = new Map(uniq.map(p => [p, current.get(p)?.ver ?? null]));

            const now = Date.now();
            const nowTs = millisToTs(now);
            const results = [];
            const state = new Map([...current].map(([p, d]) => [p, d ? { data: d.data, ver: d.ver } : null]));

            const touched = new Set();
            for (const w of norm) {
                const cur = state.get(w.path);
                const pre = w.precondition || {};
                if (pre.exists === true && !cur) throw new StoreError('not-found', `No document to update: ${w.path}`);
                if (pre.exists === false && cur) throw new StoreError('already-exists', `Document already exists: ${w.path}`);
                if ('ver' in pre && (cur?.ver ?? null) !== (pre.ver ?? null)) throw new StoreError('aborted', 'The document changed; retry.');
                if (w.op === 'check') continue;   // read-only guard (transactions)
                if (w.op === 'update' && !cur) throw new StoreError('not-found', `No document to update: ${w.path}`);
                if (w.op === 'create' && cur) throw new StoreError('already-exists', `Document already exists: ${w.path}`);

                const after = applyWrite(cur ? cur.data : null, w, nowTs);
                if (opts.check) await opts.check(w.path, cur ? cur.data : null, after, w);
                const ver = after === null ? null : (cur?.ver || 0) + 1;
                state.set(w.path, after === null ? null : { data: after, ver });
                touched.add(w.path);
                results.push({ path: w.path, id: w.id, coll: w.coll, before: cur ? cur.data : null, data: after, ver });
            }

            // Guards: every touched doc must still be at the version we read.
            // json('x') raises an error, which rolls back the whole batch.
            const stmts = [];
            for (const p of uniq) {
                const v = readVer.get(p);
                stmts.push(this.d1.prepare(
                    `SELECT CASE WHEN (SELECT ver FROM docs WHERE path = ?) IS ? THEN 1 ELSE json('version conflict') END`
                ).bind(p, v));
            }
            const colls = new Set();
            for (const p of uniq) {
                if (!touched.has(p)) continue;
                const fin = state.get(p);
                const { coll, id } = docParts(p);
                colls.add(coll);
                if (fin === null) {
                    if (current.get(p)) stmts.push(this.d1.prepare('DELETE FROM docs WHERE path = ?').bind(p));
                } else {
                    stmts.push(this.d1.prepare(
                        `INSERT INTO docs (path, coll, id, data, ver, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(path) DO UPDATE SET data = excluded.data, ver = excluded.ver, updated_at = excluded.updated_at`
                    ).bind(p, coll, id, JSON.stringify(fin.data), fin.ver, now, now));
                }
            }
            for (const c of colls) {
                stmts.push(this.d1.prepare(
                    `INSERT INTO coll_versions (coll, v) VALUES (?, 1) ON CONFLICT(coll) DO UPDATE SET v = v + 1`
                ).bind(c));
            }
            try {
                await this.d1.batch(stmts);
                return results;
            } catch (e) {
                if (/version conflict|malformed JSON/i.test(String(e.message))) {
                    if (attempt + 1 < attempts) continue;
                    throw new StoreError('aborted', 'Too much contention on these documents; please retry.');
                }
                throw e;
            }
        }
        throw new StoreError('aborted', 'Commit failed');
    }
}
