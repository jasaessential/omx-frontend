/* ═══════════════════════════════════════════════════════════════════
   OMX — Firestore web SDK stand-in, backed by Cloudflare D1 through the
   omx-api Worker (/db/*). Pages import this instead of
   ./cf-firestore.js;
   the function names and behaviour match the parts of the SDK we use.

   Sign-in is still Firebase Auth: each call carries the user's ID token
   and the Worker checks it plus the access rules (cf/rules.js).

   Live listeners (onSnapshot) poll: one small request every 15 s for all
   listeners on the page, paused while the tab is hidden, re-run at once
   after this page writes. Results only travel when a collection changed.
   ═══════════════════════════════════════════════════════════════════ */

import { getApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
export const OMX_API = (window.__OMX_API || (LOCAL ? 'http://127.0.0.1:8799' : 'https://omx-api.jasaessential3.workers.dev')).replace(/\/+$/, '');
const POLL_MS = 15000;
const TS_PREFIX = '__ts:';

/* ── errors ─────────────────────────────────────────────────────────── */

export class FirestoreError extends Error {
    constructor(code, message) { super(message); this.code = code; this.name = 'FirebaseError'; }
}

/* ── Timestamp & field values ───────────────────────────────────────── */

export class Timestamp {
    constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
    static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), Math.round(((ms % 1000) + 1000) % 1000 * 1e6)); }
    static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
    static now() { return Timestamp.fromMillis(Date.now()); }
    toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
    toDate() { return new Date(this.toMillis()); }
    isEqual(o) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
    valueOf() { return String(this.seconds + 1e11).padStart(12, '0') + '.' + String(this.nanoseconds).padStart(9, '0'); }
    toJSON() { return { seconds: this.seconds, nanoseconds: this.nanoseconds }; }
    toString() { return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`; }
}

class FieldValue { constructor(op) { Object.assign(this, op); } }
export const serverTimestamp = () => new FieldValue({ __op: 'serverTimestamp' });
export const increment = n => new FieldValue({ __op: 'increment', n: Number(n) });
export const arrayUnion = (...v) => new FieldValue({ __op: 'arrayUnion', v: v.map(encode) });
export const arrayRemove = (...v) => new FieldValue({ __op: 'arrayRemove', v: v.map(encode) });
export const deleteField = () => new FieldValue({ __op: 'delete' });
export const documentId = () => '__name__';

const tsString = ms => TS_PREFIX + new Date(ms).toISOString();

function encode(v) {
    if (v instanceof Timestamp) return tsString(v.toMillis());
    if (v instanceof Date) return tsString(v.getTime());
    if (v instanceof FieldValue) return { ...v };
    if (v instanceof DocumentReference) return v.path;
    if (Array.isArray(v)) return v.map(encode);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encode(x);
        return out;
    }
    return v;
}

function decode(v) {
    if (typeof v === 'string' && v.startsWith(TS_PREFIX)) return Timestamp.fromMillis(Date.parse(v.slice(TS_PREFIX.length)));
    if (Array.isArray(v)) return v.map(decode);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) out[k] = decode(x);
        return out;
    }
    return v;
}

/* ── the database handle ────────────────────────────────────────────── */

class Firestore {
    constructor(app) { this.app = app; this.type = 'firestore'; this._auth = getAuth(app); }
    toJSON() { return { app: this.app && this.app.name }; }
}
const _instances = new Map();
export function getFirestore(app) {
    app = app || getApp();
    if (!_instances.has(app)) _instances.set(app, new Firestore(app));
    return _instances.get(app);
}
export const initializeFirestore = (app) => getFirestore(app);
export const memoryLocalCache = () => ({ kind: 'memory' });
export const persistentLocalCache = () => ({ kind: 'memory' });
export const persistentMultipleTabManager = () => ({});
export const enableIndexedDbPersistence = async () => {};
export const enableNetwork = async () => {};
export const disableNetwork = async () => {};

/* ── transport ──────────────────────────────────────────────────────── */

async function idToken(db) {
    const auth = db._auth;
    if (auth.authStateReady) await auth.authStateReady();
    const u = auth.currentUser;
    return u ? u.getIdToken() : null;
}

async function call(db, action, body, retried = false) {
    const token = await idToken(db);
    let res;
    try {
        res = await fetch(`${OMX_API}/db/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(body),
        });
    } catch (e) {
        throw new FirestoreError('unavailable', 'Could not reach the server. Check your connection.');
    }
    let j = null;
    try { j = await res.json(); } catch (_) { /* empty */ }
    if (res.ok) return j;
    const err = (j && j.error) || {};
    // An expired token: refresh once and retry
    if (res.status === 401 && token && !retried && db._auth.currentUser) {
        await db._auth.currentUser.getIdToken(true);
        return call(db, action, body, true);
    }
    throw new FirestoreError(err.code || (res.status === 403 ? 'permission-denied' : 'internal'), err.message || `Request failed (${res.status})`);
}

/* ── references & queries ───────────────────────────────────────────── */

const clean = parts => parts.flatMap(p => String(p).split('/')).filter(Boolean);

function autoId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    return Array.from(bytes, b => chars[b % 62]).join('');
}

export class Query {
    constructor(firestore, coll, q) {
        this.firestore = firestore; this.type = 'query';
        this._coll = coll;
        this._q = q || { coll, filters: [], orderBy: [] };
    }
    withConverter() { return this; }
}

export class CollectionReference extends Query {
    constructor(firestore, path) {
        super(firestore, path);
        this.type = 'collection'; this.path = path; this.id = path.split('/').pop();
    }
    get parent() {
        const p = this.path.split('/');
        return p.length > 1 ? new DocumentReference(this.firestore, p.slice(0, -1).join('/')) : null;
    }
}

export class DocumentReference {
    constructor(firestore, path) {
        this.firestore = firestore; this.type = 'document'; this.path = path; this.id = path.split('/').pop();
    }
    get parent() { return new CollectionReference(this.firestore, this.path.split('/').slice(0, -1).join('/')); }
    withConverter() { return this; }
}

const dbOf = x => (x instanceof Firestore ? x : x.firestore);
const basePath = x => (x instanceof Firestore ? [] : clean([x.path]));

export function collection(parent, ...segments) {
    const parts = [...basePath(parent), ...clean(segments)];
    if (parts.length % 2 === 0) throw new FirestoreError('invalid-argument', `Invalid collection reference: ${parts.join('/')}`);
    return new CollectionReference(dbOf(parent), parts.join('/'));
}

export function doc(parent, ...segments) {
    let parts = [...basePath(parent), ...clean(segments)];
    if (parent instanceof CollectionReference && !segments.length) parts.push(autoId());
    if (parts.length % 2 === 1) throw new FirestoreError('invalid-argument', `Invalid document reference: ${parts.join('/')}`);
    return new DocumentReference(dbOf(parent), parts.join('/'));
}

class Constraint { constructor(apply) { this._apply = apply; } }

export const where = (field, op, value) => new Constraint(q => {
    const f = typeof field === 'string' ? field : (field && field._name) || String(field);
    q.filters.push({ field: f, op, value: encode(value) });
});
export const orderBy = (field, dir = 'asc') => new Constraint(q => { q.orderBy.push({ field: String(field), dir }); });
export const limit = n => new Constraint(q => { q.limit = n; delete q.limitToLast; });
export const limitToLast = n => new Constraint(q => { q.limitToLast = n; delete q.limit; });

const cursor = kind => (...args) => new Constraint(q => {
    let vals = args;
    if (args.length === 1 && args[0] instanceof DocumentSnapshot) {
        const s = args[0];
        vals = [...q.orderBy.filter(o => o.field !== '__name__').map(o => s.get(o.field)), s.id];
    }
    q[kind] = vals.map(encode);
});
export const startAt = cursor('startAt');
export const startAfter = cursor('startAfter');
export const endAt = cursor('endAt');
export const endBefore = cursor('endBefore');

export function query(base, ...constraints) {
    const q = structuredClone(base._q);
    for (const c of constraints.flat()) if (c && c._apply) c._apply(q);
    return new Query(base.firestore, base._coll, q);
}

/* ── snapshots ──────────────────────────────────────────────────────── */

const META = Object.freeze({ hasPendingWrites: false, fromCache: false, isEqual: () => true });

export class DocumentSnapshot {
    constructor(ref, raw) {
        this.ref = ref; this.id = ref.id; this.metadata = META;
        this._raw = raw || null;
        this._data = raw ? decode(raw.data) : undefined;
    }
    exists() { return this._data !== undefined; }
    /* a fresh copy each call, like the SDK (decode rebuilds Timestamps) */
    data() { return this._raw ? decode(this._raw.data) : undefined; }
    get(field) {
        let cur = this._data;
        for (const s of String(field).split('.')) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[s]; }
        return cur;
    }
}

export class QueryDocumentSnapshot extends DocumentSnapshot {}

export class QuerySnapshot {
    constructor(query, docs, changes) {
        this.query = query; this.docs = docs; this.metadata = META;
        this._changes = changes;
    }
    get size() { return this.docs.length; }
    get empty() { return this.docs.length === 0; }
    forEach(fn, thisArg) { this.docs.forEach(fn, thisArg); }
    docChanges() { return this._changes || this.docs.map((d, i) => ({ type: 'added', doc: d, oldIndex: -1, newIndex: i })); }
}

const docSnap = (db, raw, path) => new QueryDocumentSnapshot(new DocumentReference(db, raw ? raw.path : path), raw);

/* ── reads ──────────────────────────────────────────────────────────── */

export async function getDoc(ref) {
    const { docs } = await call(ref.firestore, 'get', { paths: [ref.path] });
    return new DocumentSnapshot(ref, docs[0]);
}
export const getDocFromServer = getDoc;
export const getDocFromCache = getDoc;

export async function getDocs(q) {
    const { docs } = await call(q.firestore, 'query', { q: q._q });
    return new QuerySnapshot(q, docs.map(d => docSnap(q.firestore, d)));
}
export const getDocsFromServer = getDocs;
export const getDocsFromCache = getDocs;

export async function getCountFromServer(q) {
    const { count } = await call(q.firestore, 'count', { q: q._q });
    return { data: () => ({ count }) };
}

/* ── writes ─────────────────────────────────────────────────────────── */

function setW(ref, data, opts = {}) {
    const w = { op: 'set', path: ref.path, data: encode(data) };
    if (opts && opts.merge) w.merge = true;
    if (opts && opts.mergeFields) w.mergeFields = opts.mergeFields.map(String);
    return w;
}
function updateW(ref, data, rest) {
    if (typeof data === 'string') {
        const obj = { [data]: rest[0] };
        for (let i = 1; i + 1 < rest.length; i += 2) obj[rest[i]] = rest[i + 1];
        data = obj;
    }
    return { op: 'update', path: ref.path, data: encode(data) };
}

async function commit(db, writes) {
    if (!writes.length) return;
    await call(db, 'commit', { writes });
    poller.kick();
}

export const setDoc = (ref, data, opts) => commit(ref.firestore, [setW(ref, data, opts)]);
export const updateDoc = (ref, data, ...rest) => commit(ref.firestore, [updateW(ref, data, rest)]);
export const deleteDoc = ref => commit(ref.firestore, [{ op: 'delete', path: ref.path }]);
export async function addDoc(coll, data) {
    const ref = doc(coll);
    await commit(coll.firestore, [{ op: 'create', path: ref.path, data: encode(data) }]);
    return ref;
}

class WriteBatch {
    constructor(db) { this._db = db; this._w = []; }
    set(ref, data, opts) { this._w.push(setW(ref, data, opts)); return this; }
    update(ref, data, ...rest) { this._w.push(updateW(ref, data, rest)); return this; }
    delete(ref) { this._w.push({ op: 'delete', path: ref.path }); return this; }
    commit() { return commit(this._db, this._w); }
}
export const writeBatch = db => new WriteBatch(db);

class Transaction extends WriteBatch {
    constructor(db) { super(db); this._reads = new Map(); }
    async get(ref) {
        const { docs } = await call(this._db, 'get', { paths: [ref.path] });
        this._reads.set(ref.path, docs[0] ? docs[0].ver : null);
        return new DocumentSnapshot(ref, docs[0]);
    }
}

export async function runTransaction(db, fn, { maxAttempts = 5 } = {}) {
    let last;
    for (let i = 0; i < maxAttempts; i++) {
        const tx = new Transaction(db);
        const result = await fn(tx);
        const writes = tx._w.map(w => tx._reads.has(w.path) ? { ...w, precondition: { ver: tx._reads.get(w.path) } } : w);
        if (!writes.length) return result;
        for (const [path, ver] of tx._reads) {
            if (!writes.some(w => w.path === path)) writes.push({ op: 'check', path, precondition: { ver } });
        }
        try { await commit(db, writes); return result; }
        catch (e) { if (e.code === 'aborted') { last = e; continue; } throw e; }
    }
    throw last || new FirestoreError('aborted', 'Transaction failed');
}

/* ── live listeners (polling) ───────────────────────────────────────── */

const poller = {
    targets: new Map(),   // key → { db, path | q, v, prev, onNext, onError, ref | query }
    timer: null,
    seq: 0,
    running: false,
    again: false,

    add(t) {
        const key = 'l' + (++this.seq);
        this.targets.set(key, t);
        this.kick();
        return () => { this.targets.delete(key); };
    },

    kick() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.poll(), 0);
    },

    schedule() {
        clearTimeout(this.timer);
        if (!this.targets.size) return;
        this.timer = setTimeout(() => this.poll(), document.hidden ? 60000 : POLL_MS);
    },

    async poll() {
        if (this.running) { this.again = true; return; }
        if (!this.targets.size) return;
        if (document.hidden) { this.schedule(); return; }
        this.running = true;
        try {
            // One request per database handle
            const byDb = new Map();
            for (const [key, t] of this.targets) {
                if (!byDb.has(t.db)) byDb.set(t.db, []);
                byDb.get(t.db).push([key, t]);
            }
            for (const [db, list] of byDb) {
                const targets = list.map(([key, t]) => t.path ? { key, path: t.path, v: t.v } : { key, q: t.q, v: t.v });
                let changes;
                try { ({ changes } = await call(db, 'listen', { targets })); }
                catch (e) {
                    // Network blips: keep listening; permission errors go to the listener
                    if (e.code !== 'unavailable') list.forEach(([, t]) => { if (t.v == null) t.onError(e); });
                    continue;
                }
                for (const [key, ch] of Object.entries(changes || {})) {
                    const t = this.targets.get(key);
                    if (!t) continue;
                    if (ch.error) { t.v = ch.v; t.onError(new FirestoreError(ch.error.code, ch.error.message)); continue; }
                    t.v = ch.v;
                    try { t.deliver(ch); } catch (e) { console.error('[onSnapshot] listener threw:', e); }
                }
            }
        } finally {
            this.running = false;
            if (this.again) { this.again = false; this.kick(); } else this.schedule();
        }
    },
};

document.addEventListener('visibilitychange', () => { if (!document.hidden) poller.kick(); });

// Signing in / out changes what the rules allow: re-read everything
const _watchedAuth = new WeakSet();
function watchAuth(db) {
    if (_watchedAuth.has(db._auth)) return;
    _watchedAuth.add(db._auth);
    onAuthStateChanged(db._auth, () => {
        for (const t of poller.targets.values()) if (t.db === db) t.v = null;
        poller.kick();
    });
}

function docChangesBetween(prev, next) {
    const changes = [];
    const prevIdx = new Map(prev.map((d, i) => [d.ref.path, i]));
    const nextIdx = new Map(next.map((d, i) => [d.ref.path, i]));
    prev.forEach((d, i) => { if (!nextIdx.has(d.ref.path)) changes.push({ type: 'removed', doc: d, oldIndex: i, newIndex: -1 }); });
    next.forEach((d, i) => {
        if (!prevIdx.has(d.ref.path)) changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i });
        else {
            const old = prev[prevIdx.get(d.ref.path)];
            if (old._raw.ver !== d._raw.ver) changes.push({ type: 'modified', doc: d, oldIndex: prevIdx.get(d.ref.path), newIndex: i });
        }
    });
    return changes;
}

export function onSnapshot(target, ...args) {
    // onSnapshot(ref, [options], next, [error], [complete]) or (ref, [options], observer)
    if (args[0] && typeof args[0] === 'object' && !('next' in args[0]) && typeof args[1] !== 'undefined') args.shift();
    let onNext, onError;
    if (typeof args[0] === 'object' && args[0]) { onNext = args[0].next; onError = args[0].error; }
    else { onNext = args[0]; onError = args[1]; }
    onNext = onNext || (() => {});
    const errFn = onError || (e => console.error('[onSnapshot]', e.code, e.message));

    const db = target.firestore;
    watchAuth(db);
    let stopped = false;
    let unsub = () => {};
    const t = { db, v: null, onError: e => { if (!stopped) errFn(e); } };

    if (target instanceof DocumentReference) {
        t.path = target.path;
        let lastVer;
        t.deliver = ch => {
            const raw = ch.doc;
            const ver = raw ? raw.ver : null;
            if (ver === lastVer) return;
            lastVer = ver;
            if (!stopped) onNext(new DocumentSnapshot(target, raw));
        };
    } else {
        t.q = target._q;
        let prev = null;
        t.deliver = ch => {
            const docs = (ch.docs || []).map(d => docSnap(db, d));
            const changes = prev === null ? null : docChangesBetween(prev, docs);
            if (prev !== null && !changes.length) return;   // collection changed, this query didn't
            prev = docs;
            if (!stopped) onNext(new QuerySnapshot(target, docs, changes));
        };
    }
    unsub = poller.add(t);
    return () => { stopped = true; unsub(); };
}

/* misc SDK helpers some pages may touch */
export const refEqual = (a, b) => a && b && a.path === b.path;
export const queryEqual = (a, b) => JSON.stringify(a._q) === JSON.stringify(b._q);
export const snapshotEqual = (a, b) => a === b;
