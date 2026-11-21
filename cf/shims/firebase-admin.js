/* ═══════════════════════════════════════════════════════════════════
   OMX — drop-in for the parts of `firebase-admin` the server uses, backed
   by D1 (cf/store.js). wrangler aliases `firebase-admin` to this file, so
   server/*.js runs unchanged on Workers.

   Covered: admin.firestore() (collection/doc/get/set/update/create/delete/
   add/where/orderBy/limit/startAfter/count/getAll/batch/runTransaction),
   admin.firestore.FieldValue / Timestamp, admin.auth().verifyIdToken,
   admin.messaging().sendEachForMulticast (FCM HTTP v1).
   ═══════════════════════════════════════════════════════════════════ */

import { env, waitUntil } from 'cloudflare:workers';
import { notifyChanges } from '../notify.js';
import { sendToTokens } from '../fcm.js';
import { Store, StoreError, TS_PREFIX, isTs, tsToMillis, millisToTs, autoId, getField } from '../store.js';
import { verifyIdToken as verifyToken } from '../auth.js';

/* ── Timestamp / FieldValue ─────────────────────────────────────────── */

export class Timestamp {
    constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
    static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)); }
    static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
    static now() { return Timestamp.fromMillis(Date.now()); }
    toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
    toDate() { return new Date(this.toMillis()); }
    isEqual(o) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
    valueOf() { return String(this.seconds).padStart(12, '0') + '.' + String(this.nanoseconds).padStart(9, '0'); }
    toJSON() { return { _seconds: this.seconds, _nanoseconds: this.nanoseconds }; }
}

class Sentinel { constructor(op) { Object.assign(this, op); } }
export const FieldValue = {
    serverTimestamp: () => new Sentinel({ __op: 'serverTimestamp' }),
    increment: n => new Sentinel({ __op: 'increment', n: Number(n) }),
    arrayUnion: (...v) => new Sentinel({ __op: 'arrayUnion', v: v.map(encode) }),
    arrayRemove: (...v) => new Sentinel({ __op: 'arrayRemove', v: v.map(encode) }),
    delete: () => new Sentinel({ __op: 'delete' }),
};

/* JS value → stored JSON (Timestamps/Dates to "__ts:", sentinels to {__op}) */
export function encode(v) {
    if (v instanceof Timestamp) return millisToTs(v.toMillis());
    if (v instanceof Date) return millisToTs(v.getTime());
    if (v instanceof Sentinel) return { ...v };
    if (v instanceof DocumentReference) return v.path;
    if (Array.isArray(v)) return v.map(encode);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encode(x);
        return out;
    }
    return v;
}

/* stored JSON → JS value (revives Timestamps) */
export function decode(v) {
    if (isTs(v)) return Timestamp.fromMillis(tsToMillis(v));
    if (Array.isArray(v)) return v.map(decode);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) out[k] = decode(x);
        return out;
    }
    return v;
}
void TS_PREFIX;

/* ── store access ───────────────────────────────────────────────────── */

let _store = null;
const store = () => (_store ||= new Store(env.DB));

/* ── snapshots ──────────────────────────────────────────────────────── */

class DocumentSnapshot {
    constructor(ref, raw) {
        this.ref = ref;
        this.id = ref.id;
        this.exists = !!raw;
        this._raw = raw;
        this._data = raw ? decode(raw.data) : undefined;
    }
    data() { return this._data === undefined ? undefined : structuredClone(this._data); }
    get(field) { return this._data === undefined ? undefined : getField(this._data, field); }
}

class QuerySnapshot {
    constructor(docs) { this.docs = docs; }
    get size() { return this.docs.length; }
    get empty() { return this.docs.length === 0; }
    forEach(fn, thisArg) { this.docs.forEach(fn, thisArg); }
}

/* ── references & queries ───────────────────────────────────────────── */

class Query {
    constructor(coll, q = {}) { this._coll = coll; this._q = { coll, filters: [], orderBy: [], ...q }; }
    _with(patch) { return new Query(this._coll, { ...this._q, ...patch }); }
    where(field, op, value) {
        const f = typeof field === 'object' && field && field.segments ? field.segments.join('.') : String(field);
        return this._with({ filters: [...this._q.filters, { field: f === '__name__' ? '__name__' : f, op, value: encode(value) }] });
    }
    orderBy(field, dir = 'asc') { return this._with({ orderBy: [...this._q.orderBy, { field: String(field), dir }] }); }
    limit(n) { return this._with({ limit: n, limitToLast: undefined }); }
    limitToLast(n) { return this._with({ limitToLast: n, limit: undefined }); }
    offset(n) { return this._with({ offset: n }); }
    select() { return this; }
    _cursor(kind, args) {
        let vals = args;
        if (args.length === 1 && args[0] instanceof DocumentSnapshot) {
            const s = args[0];
            vals = [...this._q.orderBy.filter(o => o.field !== '__name__').map(o => s.get(o.field)), s.id];
        }
        return this._with({ [kind]: vals.map(encode) });
    }
    startAt(...a) { return this._cursor('startAt', a); }
    startAfter(...a) { return this._cursor('startAfter', a); }
    endAt(...a) { return this._cursor('endAt', a); }
    endBefore(...a) { return this._cursor('endBefore', a); }
    async get() {
        const rows = await store().query(this._q);
        const db = firestoreInstance;
        return new QuerySnapshot(rows.map(r => new DocumentSnapshot(db.doc(r.path), r)));
    }
    count() {
        const q = this._q;
        return { get: async () => { const n = await store().count(q); return { data: () => ({ count: n }) }; } };
    }
}

class CollectionReference extends Query {
    constructor(path) { super(path); this.path = path; this.id = path.split('/').pop(); }
    get parent() { const p = this.path.split('/'); return p.length > 1 ? new DocumentReference(p.slice(0, -1).join('/')) : null; }
    doc(id) { return new DocumentReference(`${this.path}/${id === undefined ? autoId() : id}`); }
    async add(data) { const ref = this.doc(); await ref.set(data); return ref; }
}

class DocumentReference {
    constructor(path) { this.path = path; this.id = path.split('/').pop(); }
    get parent() { return new CollectionReference(this.path.split('/').slice(0, -1).join('/')); }
    collection(sub) { return new CollectionReference(`${this.path}/${sub}`); }
    async get() { return new DocumentSnapshot(this, await store().get(this.path)); }
    async set(data, opts = {}) { await commit([setWrite(this, data, opts)]); return writeResult(); }
    async update(data, ...rest) { await commit([updateWrite(this, data, rest)]); return writeResult(); }
    async create(data) { await commit([{ op: 'create', path: this.path, data: encode(data) }]); return writeResult(); }
    async delete() { await commit([{ op: 'delete', path: this.path }]); return writeResult(); }
    isEqual(o) { return o instanceof DocumentReference && o.path === this.path; }
}

const writeResult = () => ({ writeTime: Timestamp.now() });

function setWrite(ref, data, opts = {}) {
    const w = { op: 'set', path: ref.path, data: encode(data) };
    if (opts.merge) w.merge = true;
    if (opts.mergeFields) w.mergeFields = opts.mergeFields.map(String);
    return w;
}
function updateWrite(ref, data, rest) {
    // update(field, value, field2, value2...) form
    if (typeof data === 'string') {
        const obj = { [data]: rest[0] };
        for (let i = 1; i + 1 < rest.length; i += 2) obj[rest[i]] = rest[i + 1];
        data = obj;
    }
    return { op: 'update', path: ref.path, data: encode(data) };
}

/* Server writes to orders/* (payment success, settle job, ...) trigger the same
   order pushes as browser writes. Runs after the response, never blocks it. */
function afterCommit(results) {
    const changes = (results || []).filter(r => r.path.startsWith('orders/')).map(r => ({ path: r.path, before: r.before, after: r.data }));
    if (!changes.length) return;
    const p = notifyChanges(env, changes);
    try { waitUntil(p); } catch (_) { /* older runtime: best effort */ }
}

async function commit(writes) {
    let results;
    try { results = await store().commit(writes); }
    catch (e) { throw toAdminError(e); }
    afterCommit(results);
    return results;
}

function toAdminError(e) {
    if (e instanceof StoreError) {
        const codes = { 'not-found': 5, 'already-exists': 6, 'permission-denied': 7, 'aborted': 10, 'invalid-argument': 3 };
        const err = new Error(`${codes[e.code] || 2} ${e.code.toUpperCase().replace(/-/g, '_')}: ${e.message}`);
        err.code = codes[e.code] || 2;
        return err;
    }
    return e;
}

/* ── batch & transaction ────────────────────────────────────────────── */

class WriteBatch {
    constructor() { this._w = []; }
    set(ref, data, opts) { this._w.push(setWrite(ref, data, opts)); return this; }
    update(ref, data, ...rest) { this._w.push(updateWrite(ref, data, rest)); return this; }
    create(ref, data) { this._w.push({ op: 'create', path: ref.path, data: encode(data) }); return this; }
    delete(ref) { this._w.push({ op: 'delete', path: ref.path }); return this; }
    async commit() { if (this._w.length) await commit(this._w); return [writeResult()]; }
}

class Transaction extends WriteBatch {
    constructor() { super(); this._reads = new Map(); }
    async get(refOrQuery) {
        if (refOrQuery instanceof Query) return refOrQuery.get();   // queries are not version-checked
        if (this._w.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
        const raw = await store().get(refOrQuery.path);
        this._reads.set(refOrQuery.path, raw ? raw.ver : null);
        return new DocumentSnapshot(refOrQuery, raw);
    }
    async getAll(...refs) { return Promise.all(refs.map(r => this.get(r))); }
}

async function runTransaction(fn, { maxAttempts = 5 } = {}) {
    let lastErr;
    for (let i = 0; i < maxAttempts; i++) {
        const tx = new Transaction();
        const result = await fn(tx);
        // Docs read must be unchanged at commit; docs only written get no check.
        const writes = tx._w.map(w => tx._reads.has(w.path) ? { ...w, precondition: { ver: tx._reads.get(w.path) } } : w);
        if (!writes.length) return result;
        // Docs read but not written still need a version check
        for (const [path, ver] of tx._reads) {
            if (!writes.some(w => w.path === path)) writes.push({ op: 'check', path, precondition: { ver } });
        }
        try {
            afterCommit(await store().commit(writes));
            return result;
        } catch (e) {
            if (e instanceof StoreError && e.code === 'aborted') { lastErr = e; continue; }
            throw toAdminError(e);
        }
    }
    throw toAdminError(lastErr || new StoreError('aborted', 'Transaction failed'));
}

/* ── Firestore ──────────────────────────────────────────────────────── */

class Firestore {
    collection(path) { return new CollectionReference(path); }
    doc(path) { return new DocumentReference(path); }
    batch() { return new WriteBatch(); }
    runTransaction(fn, opts) { return runTransaction(fn, opts); }
    async getAll(...refs) {
        const raws = await store().getMany(refs.map(r => r.path));
        return refs.map((r, i) => new DocumentSnapshot(r, raws[i]));
    }
    settings() {}
}
const firestoreInstance = new Firestore();

export function firestore() { return firestoreInstance; }
firestore.FieldValue = FieldValue;
firestore.Timestamp = Timestamp;
firestore.FieldPath = { documentId: () => '__name__' };

/* ── auth ───────────────────────────────────────────────────────────── */

const projectId = () => env.FIREBASE_PROJECT_ID || (globalThis.process && process.env.FIREBASE_PROJECT_ID);

export function auth() {
    return {
        async verifyIdToken(token) {
            const claims = await verifyToken(token, projectId());
            if (!claims) { const e = new Error('Firebase ID token is invalid or expired'); e.code = 'auth/argument-error'; throw e; }
            return claims;
        },
    };
}

/* ── messaging (FCM HTTP v1, cf/fcm.js) ────────────────────────────── */

function v1Message(m) {
    const msg = {};
    if (m.notification) {
        const { imageUrl, ...rest } = m.notification;
        msg.notification = { ...rest, ...(imageUrl ? { image: imageUrl } : {}) };
    }
    if (m.data) msg.data = m.data;
    if (m.webpush) {
        const { fcmOptions, ...rest } = m.webpush;
        msg.webpush = { ...rest, ...(fcmOptions ? { fcm_options: fcmOptions } : {}) };
    }
    if (m.android) msg.android = m.android;
    if (m.apns) msg.apns = m.apns;
    return msg;
}

export function messaging() {
    return {
        async sendEachForMulticast(m) {
            const res = await sendToTokens(env, m.tokens || [], v1Message(m));
            const responses = res.map(r => r.success ? { success: true } : { success: false, error: r.error });
            const successCount = responses.filter(r => r.success).length;
            return { responses, successCount, failureCount: responses.length - successCount };
        },
    };
}

/* ── app bootstrap (no-ops: credentials come from Worker env) ───────── */

export const apps = [];
export function initializeApp() { if (!apps.length) apps.push({ name: '[DEFAULT]' }); return apps[0]; }
export const credential = { cert: x => x, applicationDefault: () => ({}) };

const admin = { apps, initializeApp, credential, firestore, auth, messaging };
export default admin;
