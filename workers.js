/**
 * Production Worker v6 - Complete E-Commerce Backend with Cache Control
 * Endpoints: /api/items, /api/config/xerox, /api/shops/all, /api/cache/*
 * 
 * Cache Strategy: No automatic expiry - manual control via admin panel
 * 
 * Deploy to Cloudflare Workers:
 * 1. Cloudflare Dashboard → Workers → product-pagination-worker
 * 2. Delete all code, paste this entire file
 * 3. Save & Deploy
 * 4. Admin endpoints take the caller's Firebase ID token (see verifyAdmin); FIREBASE_PROJECT_ID must be set
 */

const FIRESTORE_DB_URL = 'https://firestore.googleapis.com/v1/projects';

// ═════════════════════════════════════════════════════════════════
// LOGGER SERVICE
// ═════════════════════════════════════════════════════════════════

class Logger {
    static log(module, message, data = null) {
        const prefix = `[${new Date().toISOString()}] ${module}`;
        if (data) console.log(`${prefix} ${message}`, data);
        else console.log(`${prefix} ${message}`);
    }
}

// ═════════════════════════════════════════════════════════════════
// GOOGLE AUTH SERVICE (OAuth2 / JWT RS256)
// ═════════════════════════════════════════════════════════════════

class GoogleAuth {
    static base64UrlEncode(str) {
        let base64 = btoa(str);
        return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    static async sign(payload, privateKeyPem) {
        const header = this.base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
        const data = new TextEncoder().encode(`${header}.${encodedPayload}`);

        // Pem cleanup
        const pem = privateKeyPem
            .replace(/-----BEGIN PRIVATE KEY-----/g, "")
            .replace(/-----END PRIVATE KEY-----/g, "")
            .replace(/\s/g, "");
            
        const binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0));

        const key = await crypto.subtle.importKey(
            "pkcs8",
            binaryKey,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["sign"]
        );

        const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
        const encodedSignature = this.base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));

        return `${header}.${encodedPayload}.${encodedSignature}`;
    }

    static async getAccessToken(serviceAccount) {
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            iss: serviceAccount.client_email,
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: "https://oauth2.googleapis.com/token",
            exp: now + 3600,
            iat: now
        };

        const jwt = await this.sign(payload, serviceAccount.private_key);

        const response = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
        });

        if (!response.ok) throw new Error(`Google Auth failed: ${await response.text()}`);
        const data = await response.json();
        return data.access_token;
    }
}

class FCMV1Service {
    constructor(serviceAccountJson) {
        try {
            this.config = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
        } catch (e) {
            this.config = null;
            Logger.log('FCMV1', 'Invalid Service Account JSON');
        }
        this._token = null;
        this._tokenExpiry = 0;
    }

    async getAuthToken() {
        if (this._token && Date.now() < this._tokenExpiry) return this._token;
        const token = await GoogleAuth.getAccessToken(this.config);
        this._token = token;
        this._tokenExpiry = Date.now() + 3500 * 1000; // Cache for 58 mins
        return token;
    }

    async subscribeToTopic(token, topic) {
        const authToken = await this.getAuthToken();
        const response = await fetch(`https://iid.googleapis.com/iid/v1/${token}/rel/topics/${topic}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json',
                'access_token_auth': 'true' // Required for IID with OAuth2
            }
        });
        if (!response.ok) throw new Error(`IID Subscribe failed: ${await response.text()}`);
        return await response.json();
    }

    async sendToTopic(topic, notification) {
        const authToken = await this.getAuthToken();
        const url = `https://fcm.googleapis.com/v1/projects/${this.config.project_id}/messages:send`;
        
        const body = {
            message: {
                topic: topic,
                notification: {
                    title: notification.title,
                    body: notification.body,
                    image: notification.image || null
                },
                webpush: {
                    headers: {
                        image: notification.image || ""
                    },
                    notification: {
                        icon: "https://jasajasa12345.pages.dev/assets/logo.png",
                        image: notification.image || null
                    },
                    fcm_options: {
                        link: notification.link || "https://jasajasa12345.pages.dev/home.html"
                    }
                }
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) throw new Error(`FCM V1 Send failed: ${await response.text()}`);
        return await response.json();
    }

    async sendToToken(token, notification) {
        const authToken = await this.getAuthToken();
        const url = `https://fcm.googleapis.com/v1/projects/${this.config.project_id}/messages:send`;
        
        const body = {
            message: {
                token: token,
                notification: {
                    title: notification.title,
                    body: notification.body,
                    image: notification.image || null
                },
                webpush: {
                    headers: {
                        image: notification.image || ""
                    },
                    notification: {
                        icon: "https://jasajasa12345.pages.dev/assets/logo.png",
                        image: notification.image || null
                    },
                    fcm_options: {
                        link: notification.link || "https://jasajasa12345.pages.dev/home.html"
                    }
                }
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) throw new Error(`FCM V1 Send to token failed: ${await response.text()}`);
        return await response.json();
    }
}

// ═════════════════════════════════════════════════════════════════
// FIRESTORE SERVICE
// ═════════════════════════════════════════════════════════════════

class FirestoreService {
    constructor(projectId, apiKey) {
        this.projectId = projectId;
        this.apiKey = apiKey;
        this.baseUrl = `${FIRESTORE_DB_URL}/${projectId}/databases/(default)/documents`;
    }

    // ─── Fetch ALL Items by Category (loops batches internally, returns full list) ───
    async fetchItemsByCategory(category, _lastDocId = null, signal, fetchAll = false) {
        const batchSize = 300; // Firestore REST safe batch size
        let allItems = [];
        let cursor   = null;
        let fetchMore = true;

        while (fetchMore) {
            const structuredQuery = {
                from:    [{ collectionId: 'items' }],
                orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
                // Request batchSize + 1 so we can tell whether a next page exists.
                // NOTE: Firestore REST also appends one sentinel {} element to the response,
                // so the actual check must count only real documents — see below.
                limit: batchSize + 1
            };

            // Apply category filter only for single-category fetches
            if (!fetchAll) {
                structuredQuery.where = {
                    fieldFilter: {
                        field: { fieldPath: 'category' },
                        op:    'EQUAL',
                        value: { stringValue: category }
                    }
                };
            }

            // Cursor: start AFTER the last document from the previous batch
            if (cursor) {
                structuredQuery.startAt = {
                    values: [{
                        referenceValue: `projects/${this.projectId}/databases/(default)/documents/items/${cursor}`
                    }],
                    before: false  // exclusive cursor
                };
            }

            try {
                const response = await fetch(
                    `${this.baseUrl}:runQuery?key=${this.apiKey}`,
                    {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ structuredQuery }),
                        signal
                    }
                );

                if (!response.ok) { fetchMore = false; break; }

                const data = await response.json();

                // Filter out the sentinel element ({} with no .document property)
                const docs = data.filter(item => item.document);

                // Take only up to batchSize real items
                const batch = docs.slice(0, batchSize).map(item => ({
                    id: item.document.name.split('/').pop(),
                    ...this.flattenFields(item.document.fields)
                }));

                allItems = allItems.concat(batch);

                // A next page exists when Firestore returned batchSize+1 real documents.
                // Using docs.length (real docs only) avoids the off-by-one caused by
                // the trailing sentinel that is present in every Firestore REST response.
                if (docs.length > batchSize && batch.length === batchSize) {
                    cursor = batch[batch.length - 1].id; // advance to next page
                    Logger.log('FirestoreService', `Batch done, cursor → ${cursor}, total so far: ${allItems.length}`);
                } else {
                    fetchMore = false; // last page reached
                }
            } catch (error) {
                Logger.log('FirestoreService', `Error fetching items for ${category}:`, error.message);
                fetchMore = false;
                if (allItems.length === 0) throw new Error(`Firestore query failed: ${error.message}`);
                // If we already have some items, return what we have rather than failing completely
            }
        }

        Logger.log('FirestoreService', `Fetched ${allItems.length} items for category: ${category}`);
        return { items: allItems, hasNextPage: false, lastDocId: null };
    }

    // ─── Fetch All Documents from a Collection ───
    async fetchCollection(collectionId, signal) {
        try {
            const response = await fetch(
                `${this.baseUrl}/${collectionId}?key=${this.apiKey}`,
                { signal }
            );

            if (!response.ok) return [];
            const data = await response.json();
            return this.extractDocuments(data);
        } catch (error) {
            Logger.log('FirestoreService', `Error fetching collection ${collectionId}:`, error.message);
            throw error;
        }
    }

    // ─── Fetch Xerox Configuration ───
    async getXeroxConfig(signal) {
        const collections = ['xerox_config_paper', 'xerox_config_binding', 'xerox_config_lamination', 'xerox_services'];
        const results = {};

        try {
            const promises = collections.map(collectionId => this.fetchCollection(collectionId, signal));
            const responses = await Promise.all(promises);

            results.paper = responses[0];
            results.binding = responses[1];
            results.lamination = responses[2];
            results.services = responses[3];

            Logger.log('FirestoreService', 'Xerox config & services fetched ✓');
            return results;
        } catch (error) {
            Logger.log('FirestoreService', 'Error fetching xerox config:', error.message);
            throw error;
        }
    }

    // ─── Fetch States, Districts, Cities (location hierarchy) ───
    async fetchLocations(signal) {
        try {
            const [statesRaw, districtsRaw, citiesRaw] = await Promise.all([
                this.fetchCollection('states',    signal),
                this.fetchCollection('districts', signal),
                this.fetchCollection('cities',    signal),
            ]);
            Logger.log('FirestoreService', `Locations fetched ✓ states:${statesRaw.length} districts:${districtsRaw.length} cities:${citiesRaw.length}`);
            return { states: statesRaw, districts: districtsRaw, cities: citiesRaw };
        } catch (error) {
            Logger.log('FirestoreService', 'Error fetching locations:', error.message);
            throw error;
        }
    }

    // ─── Fetch All Shops ───
    async fetchXeroxShops(signal) {
        try {
            const allShops = await this.fetchCollection('shops', signal);
            return allShops.filter(s => {
                const active = s.status === undefined || String(s.status).toLowerCase() === 'active';
                const hasXerox = !s.services ||
                                 (Array.isArray(s.services) && (s.services.length === 0 || s.services.some(sv => String(sv).toLowerCase() === 'xerox'))) ||
                                 (typeof s.services === 'string' && s.services.toLowerCase().includes('xerox')) ||
                                 !!s.xeroxConfig || !!s.deliveryPrices?.xerox;
                return active && hasXerox;
            });
        } catch (error) {
            Logger.log('FirestoreService', 'Error fetching shops:', error.message);
            throw error;
        }
    }

    // ─── Parse Shop Documents ───
    parseShops(data) {
        if (!data) return [];
        return data
            .filter(item => item.document)
            .map(item => ({
                id: item.document.name.split('/').pop(),
                ...this.flattenFields(item.document.fields)
            }));
    }

    // ─── Parse Results (Items) ───
    parseResults(data, pageSize) {
        if (!data) return { items: [], hasNextPage: false, lastDocId: null };
        
        const docs = data.filter(item => item.document);
        const items = docs.slice(0, pageSize).map(item => ({
            id: item.document.name.split('/').pop(),
            ...this.flattenFields(item.document.fields)
        }));

        let lastDocId = null;
        if (items.length > 0) {
            lastDocId = items[items.length - 1].id;
        }

        const hasNextPage = docs.length > pageSize;
        return { items, hasNextPage, lastDocId };
    }

    // ─── Extract Documents from Collection ───
    extractDocuments(response) {
        if (!response.documents) return [];
        return response.documents.map(doc => ({
            id: doc.name.split('/').pop(),
            ...this.flattenFields(doc.fields)
        }));
    }

    // ─── Extract Array Values ───
    extractArray(arrayField) {
        if (!arrayField || !arrayField.arrayValue || !arrayField.arrayValue.values) return [];
        return arrayField.arrayValue.values.map(v => this.flattenValue(v));
    }

    // ─── Parse Map Values ───
    parseMapValue(mapField) {
        if (!mapField || !mapField.mapValue || !mapField.mapValue.fields) return {};
        return this.flattenFields(mapField.mapValue.fields);
    }

    // ─── Add Document to Collection ───
    async addDocument(collectionId, data) {
        const body = {
            fields: this.formatFields(data)
        };

        try {
            const response = await fetch(
                `${this.baseUrl}/${collectionId}?key=${this.apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                }
            );

            if (!response.ok) throw new Error(`Add document failed: ${await response.text()}`);
            return await response.json();
        } catch (error) {
            Logger.log('FirestoreService', `Error adding to ${collectionId}:`, error.message);
            throw error;
        }
    }

    // ─── Search Documents (Run Query) ───
    async searchDocuments(collectionId, options = {}) {
        const query = {
            structuredQuery: {
                from: [{ collectionId: collectionId }],
                limit: options.limit || 20
            }
        };

        if (options.where) {
            query.structuredQuery.where = options.where;
        }

        try {
            const response = await fetch(
                `${this.baseUrl}:runQuery?key=${this.apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(query)
                }
            );

            if (!response.ok) throw new Error(`Search failed: ${await response.text()}`);
            const data = await response.json();
            
            // Format results
            if (!Array.isArray(data)) return [];
            return data
                .filter(item => item.document)
                .map(item => ({
                    id: item.document.name.split('/').pop(),
                    ...this.flattenFields(item.document.fields)
                }));
        } catch (error) {
            Logger.log('FirestoreService', `Error searching ${collectionId}:`, error.message);
            throw error;
        }
    }

    // ─── Format Fields for Write ───
    formatFields(data) {
        const fields = {};
        Object.entries(data).forEach(([key, value]) => {
            if (typeof value === 'string') fields[key] = { stringValue: value };
            else if (typeof value === 'number') {
                if (Number.isInteger(value)) fields[key] = { integerValue: value.toString() };
                else fields[key] = { doubleValue: value };
            }
            else if (typeof value === 'boolean') fields[key] = { booleanValue: value };
            else if (value === null) fields[key] = { nullValue: null };
            else if (Array.isArray(value)) {
                fields[key] = { arrayValue: { values: value.map(v => this.formatValue(v)) } };
            }
            else if (typeof value === 'object') {
                fields[key] = { mapValue: { fields: this.formatFields(value) } };
            }
        });
        return fields;
    }

    formatValue(value) {
        if (typeof value === 'string') return { stringValue: value };
        if (typeof value === 'number') return { doubleValue: value };
        if (typeof value === 'boolean') return { booleanValue: value };
        return { nullValue: null };
    }

    flattenValue(value) {
        if (!value) return null;
        if ('stringValue' in value) return value.stringValue;
        if ('integerValue' in value) return parseInt(value.integerValue);
        if ('doubleValue' in value) return parseFloat(value.doubleValue);
        if ('booleanValue' in value) return value.booleanValue;
        if ('timestampValue' in value) return value.timestampValue;
        if ('mapValue' in value) return this.flattenFields(value.mapValue.fields);
        if ('arrayValue' in value) return this.extractArray(value);
        if ('nullValue' in value) return null;
        return null;
    }

    // ─── Flatten All Fields ───
    flattenFields(fields) {
        if (!fields) return {};
        const result = {};
        Object.entries(fields).forEach(([key, value]) => {
            result[key] = this.flattenValue(value);
        });
        return result;
    }

    // ─── Delete Document ───
    async deleteDocument(collectionId, docId) {
        try {
            const response = await fetch(
                `${this.baseUrl}/${collectionId}/${docId}?key=${this.apiKey}`,
                {
                    method: 'DELETE'
                }
            );

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to delete document: ${error}`);
            }

            Logger.log('FirestoreService', `Deleted document ${docId} from ${collectionId}`);
            return true;
        } catch (error) {
            Logger.log('FirestoreService', `Error deleting document ${docId}:`, error.message);
            throw error;
        }
    }
}

// ═════════════════════════════════════════════════════════════════
// CACHE SERVICE
// ═════════════════════════════════════════════════════════════════

class CacheService {
    static getCacheKey(namespace, category = null, suffix = null, version = '2.2') {
        const v = `v${version}_`;
        if (category && suffix) return `${v}${namespace}_${category}_${suffix}`;
        if (category) return `${v}${namespace}_${category}`;
        return `${v}${namespace}`;
    }

    static async get(env, key) {
        try {
            const cached = await env.CACHE.get(key);
            if (cached) {
                Logger.log('Cache', `HIT: ${key}`);
                const cacheData = JSON.parse(cached);
                // Support both old format (direct data) and new format (with metadata)
                if (cacheData.data && cacheData.cachedAt) {
                    return { data: cacheData.data, source: 'cache', cachedAt: cacheData.cachedAt };
                }
                return { data: cacheData, source: 'cache' };
            }
        } catch (e) {
            Logger.log('Cache', `Error reading ${key}:`, e.message);
        }
        return null;
    }

    static async set(env, key, data, ttl = null) {
        try {
            // Store with metadata including timestamp
            const cacheData = {
                data: data,
                cachedAt: new Date().toISOString(),
                version: '2.2'
            };
            
            // No expiry - cache persists until manually cleared
            await env.CACHE.put(key, JSON.stringify(cacheData));
            Logger.log('Cache', `SET: ${key} (No expiry - manual control)`);
        } catch (e) {
            Logger.log('Cache', `Error writing ${key}:`, e.message);
        }
    }
    
    static async delete(env, key) {
        try {
            await env.CACHE.delete(key);
            Logger.log('Cache', `DELETED: ${key}`);
            return true;
        } catch (e) {
            Logger.log('Cache', `Error deleting ${key}:`, e.message);
            return false;
        }
    }
    
    static async list(env, prefix = '') {
        try {
            const list = await env.CACHE.list({ prefix: prefix });
            return list.keys.map(k => k.name);
        } catch (e) {
            Logger.log('Cache', `Error listing keys:`, e.message);
            return [];
        }
    }
}

// ═════════════════════════════════════════════════════════════════
// HANDLERS
// ═════════════════════════════════════════════════════════════════

// Handler: GET /api/items  (always returns ALL items for a category)
async function handleGetItemsByCategory(request, env) {
    const url      = new URL(request.url);
    const category = url.searchParams.get('category');
    const v        = url.searchParams.get('v') || '2.2';

    // ?bust=1 forces a cache bypass — only allowed for authenticated admins
    const forceBust = url.searchParams.get('bust') === '1' && (await verifyAdmin(request, env));

    // Reject missing or 'all' category — the client must always request a specific category.
    // The 'all' cross-category key is only written by the admin refresh endpoint.
    if (!category || category === 'all') {
        return new Response(JSON.stringify({ error: 'category param is required (stationary | books | electronic | posters)' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    // Cache key is per-category: v2.2_items_stationary_all
    const cacheKey = CacheService.getCacheKey('items', category, 'all', v);

    if (!forceBust) {
        const cached = await CacheService.get(env, cacheKey);
        if (cached) {
            Logger.log('GetItems', `Cache HIT for category: ${category}`);
            return new Response(JSON.stringify({ ...cached.data, source: 'cache' }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=3600'
                }
            });
        }
    }

    try {
        const fs         = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 25000);

        // Always fetch a single specific category — no cross-category dumps on this endpoint
        const result = await fs.fetchItemsByCategory(category, null, controller.signal, false);

        clearTimeout(timeoutId);

        Logger.log('GetItems', `Fetched ${result.items.length} items for ${category} from Firestore`);

        // Atomically replace the old KV entry with fresh data
        await CacheService.delete(env, cacheKey);
        await CacheService.set(env, cacheKey, result);

        return new Response(JSON.stringify({ ...result, source: 'firestore' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=3600'
            }
        });
    } catch (error) {
        Logger.log('GetItems', `Error for ${category}:`, error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: GET /api/config/xerox
async function handleGetXeroxConfig(request, env) {
    const url = new URL(request.url);
    const v = url.searchParams.get('v') || '2.2';
    const cacheKey = CacheService.getCacheKey('config', 'xerox', null, v);

    const cached = await CacheService.get(env, cacheKey);
    if (cached) {
        return new Response(JSON.stringify({ ...cached.data, source: 'cache' }), {
            status: 200,
            headers: { 
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400'
            }
        });
    }

    try {
        const fs = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const config = await fs.getXeroxConfig(controller.signal);
        clearTimeout(timeoutId);

        await CacheService.set(env, cacheKey, config);

        return new Response(JSON.stringify({ ...config, source: 'firestore' }), {
            status: 200,
            headers: { 
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400'
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: GET /api/shops/all
async function handleGetShopsAll(request, env) {
    const url = new URL(request.url);
    const v = url.searchParams.get('v') || '2.2';
    const cacheKey = CacheService.getCacheKey('shops', 'all', null, v);
    const cached = await CacheService.get(env, cacheKey);
    if (cached) {
        return new Response(JSON.stringify({ ...cached.data, source: 'cache' }), {
            status: 200,
            headers: { 
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400'
            }
        });
    }

    try {
        const fs = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const shops = await fs.fetchXeroxShops(controller.signal);
        clearTimeout(timeoutId);

        await CacheService.set(env, cacheKey, { shops });

        return new Response(JSON.stringify({ shops, source: 'firestore' }), {
            status: 200,
            headers: { 
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400'
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: GET /api/locations/all
async function handleGetLocations(request, env) {
    const url = new URL(request.url);
    const v = url.searchParams.get('v') || '2.2';
    const cacheKey = CacheService.getCacheKey('locations', 'all', null, v);

    const cached = await CacheService.get(env, cacheKey);
    if (cached) {
        return new Response(JSON.stringify({ ...cached.data, source: 'cache' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400'
            }
        });
    }

    try {
        const fs = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const locations = await fs.fetchLocations(controller.signal);
        clearTimeout(timeoutId);

        await CacheService.set(env, cacheKey, locations);

        return new Response(JSON.stringify({ ...locations, source: 'firestore' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400'
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: GET /api/data (Universal Collection Handler)
async function handleGetData(request, env) {
    const url = new URL(request.url);
    const collectionId = url.searchParams.get('collection');
    const docId = url.searchParams.get('id');
    const v = url.searchParams.get('v') || '2.2';

    if (!collectionId) {
        return new Response(JSON.stringify({ error: 'Missing collection parameter' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    const cacheKey = CacheService.getCacheKey('data', collectionId, docId || 'all', v);
    const cached = await CacheService.get(env, cacheKey);
    if (cached) {
        return new Response(JSON.stringify({ ...cached.data, source: 'cache' }), {
            status: 200,
            headers: { 
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=3600'
            }
        });
    }

    try {
        const fs = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        let result;
        if (docId) {
            // Fetch single document
            const response = await fetch(`${fs.baseUrl}/${collectionId}/${docId}?key=${fs.apiKey}`, { signal: controller.signal });
            if (!response.ok) throw new Error(`Fetch doc ${docId} failed`);
            const data = await response.json();
            result = { id: docId, ...fs.flattenFields(data.fields) };
        } else {
            // Fetch entire collection
            result = await fs.fetchCollection(collectionId, controller.signal);
        }

        clearTimeout(timeoutId);
        await CacheService.set(env, cacheKey, result); // No TTL

        return new Response(JSON.stringify({ data: result, source: 'firestore' }), {
            status: 200,
            headers: { 
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=3600'
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: POST /api/send-notification (DEPRECATED - kept for backward compatibility)
async function handleSendNotification(request, env) {
    if (request.method === 'POST' && !(await verifyAdmin(request, env, ['admin', 'manage_marketing']))) return unauthorized();
    if (request.method !== 'POST' && request.method !== 'OPTIONS') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

    try {
        const { title, body, topic = 'offers', image = null, link = null } = await request.json();
        if (!title || !body) return new Response('Missing title or body', { status: 400 });

        if (!env.FIREBASE_SERVICE_ACCOUNT) {
            return new Response('FIREBASE_SERVICE_ACCOUNT not configured', { status: 500 });
        }

        const fcm = new FCMV1Service(env.FIREBASE_SERVICE_ACCOUNT);
        const result = await fcm.sendToTopic(topic, { title, body, image, link });
        
        // Log to Firestore History
        try {
            const firestore = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
            await firestore.addDocument('sent_notifications', {
                title,
                body,
                topic,
                image,
                link,
                sent_at: new Date().toISOString(),
                status: 'success'
            });
        } catch (dbErr) {
            console.error('Failed to log notification history:', dbErr);
        }

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: POST /api/send-push-all (NEW - sends to all user tokens)
async function handleSendPushAll(request, env) {
    if (request.method === 'POST' && !(await verifyAdmin(request, env, ['admin', 'manage_marketing']))) return unauthorized();
    if (request.method !== 'POST' && request.method !== 'OPTIONS') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

    try {
        const { title, body, image = null, link = null, tokens = [] } = await request.json();
        
        if (!title || !body) {
            return new Response(JSON.stringify({ error: 'Missing title or body' }), { 
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        if (!tokens || tokens.length === 0) {
            return new Response(JSON.stringify({ error: 'No tokens provided' }), { 
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        if (!env.FIREBASE_SERVICE_ACCOUNT) {
            return new Response(JSON.stringify({ error: 'FIREBASE_SERVICE_ACCOUNT not configured' }), { 
                status: 500,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        const fcm = new FCMV1Service(env.FIREBASE_SERVICE_ACCOUNT);
        
        // Send to all tokens
        let successCount = 0;
        let failureCount = 0;
        const errors = [];
        const invalidTokens = []; // tokens that are stale/unregistered

        for (const token of tokens) {
            try {
                await fcm.sendToToken(token, { title, body, image, link });
                successCount++;
            } catch (err) {
                failureCount++;
                errors.push({ token: token.substring(0, 20) + '...', error: err.message });
                // Detect stale/unregistered tokens so the client can clean them up
                if (err.message.includes('registration-token-not-registered') ||
                    err.message.includes('invalid-registration-token') ||
                    err.message.includes('Requested entity was not found')) {
                    invalidTokens.push(token);
                }
            }
        }

        // Log to Firestore History
        try {
            const firestore = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
            await firestore.addDocument('sent_notifications', {
                title,
                body,
                image,
                link,
                recipientCount: tokens.length,
                successCount,
                failureCount,
                sent_at: new Date().toISOString(),
                status: 'success'
            });
        } catch (dbErr) {
            console.error('Failed to log notification history:', dbErr);
        }

        return new Response(JSON.stringify({ 
            success: true,
            successCount,
            failureCount,
            totalTokens: tokens.length,
            invalidTokens, // caller can use these to clean up Firestore
            errors: errors.slice(0, 10) // Return first 10 errors only
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: POST /api/subscribe
async function handleSubscribe(request, env) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
        const { token, topic = 'offers' } = await request.json();
        if (!token) return new Response('Missing token', { status: 400 });

        if (!env.FIREBASE_SERVICE_ACCOUNT) {
            return new Response('FIREBASE_SERVICE_ACCOUNT not configured', { status: 500 });
        }

        const fcm = new FCMV1Service(env.FIREBASE_SERVICE_ACCOUNT);
        const result = await fcm.subscribeToTopic(token, topic);

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// ═════════════════════════════════════════════════════════════════
// CACHE CONTROL HANDLERS
// ═════════════════════════════════════════════════════════════════

// ── Admin authentication ──────────────────────────────────────────
// Admin pages send their own Firebase ID token (Authorization: Bearer <idToken>).
// The token's signature is checked against Google's public keys and the role is
// read from the caller's users/{uid} doc (Firestore rules let users read their
// own doc). There is no shared admin key any more, so nothing secret ever has to
// reach a browser.
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let _jwks = { keys: null, exp: 0 };

function b64urlBytes(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
const b64urlJson = str => JSON.parse(new TextDecoder().decode(b64urlBytes(str)));

async function firebaseJwks() {
    if (_jwks.keys && Date.now() < _jwks.exp) return _jwks.keys;
    const res = await fetch(FIREBASE_JWKS_URL);
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1]) || 3600;
    _jwks = { keys: (await res.json()).keys || [], exp: Date.now() + maxAge * 1000 };
    return _jwks.keys;
}

/** Returns the token's payload ({ sub = uid, ... }) or null if it isn't a valid ID token for this project. */
async function verifyFirebaseIdToken(token, projectId) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !projectId) return null;
    try {
        const header  = b64urlJson(parts[0]);
        const payload = b64urlJson(parts[1]);
        const now = Math.floor(Date.now() / 1000);
        if (header.alg !== 'RS256' || !payload.sub
            || payload.aud !== projectId
            || payload.iss !== `https://securetoken.google.com/${projectId}`
            || !(payload.exp > now) || payload.iat > now + 300) return null;
        const jwk = (await firebaseJwks()).find(k => k.kid === header.kid);
        if (!jwk) return null;
        const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]),
            new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
        return ok ? payload : null;
    } catch (e) {
        console.warn('[auth] id token check failed:', e.message);
        return null;
    }
}

/** Roles on users/{uid}, read with the caller's own token */
async function userRoles(uid, idToken, projectId) {
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`,
        { headers: { Authorization: `Bearer ${idToken}` } });
    if (!res.ok) return [];
    const f = (await res.json()).fields || {};
    const list = f.roles?.arrayValue?.values?.map(v => v.stringValue).filter(Boolean);
    return list?.length ? list : [f.role?.stringValue || 'user'];
}

/**
 * True when the request carries a valid Firebase ID token of a user holding one of
 * `allowed` roles. Default: admins and manage_items employees (same as before).
 */
async function verifyAdmin(request, env, allowed = ['admin', 'manage_items']) {
    const auth  = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const claims = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
    if (!claims) return false;
    const roles = await userRoles(claims.sub, token, env.FIREBASE_PROJECT_ID);
    return roles.some(r => allowed.includes(r));
}

const unauthorized = () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
});

// Handler: GET /api/cache/status - Get cache status
async function handleCacheStatus(request, env) {
    if (!(await verifyAdmin(request, env))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        const allKeys = await CacheService.list(env, 'v2.2_');
        const status  = [];

        // Per-category health: track item counts and R2 image coverage
        const CAT_NAMES = ['stationary', 'books', 'electronic', 'posters'];
        const catHealth = {};
        CAT_NAMES.forEach(c => {
            catHealth[c] = { cached: false, itemCount: 0, withImages: 0, cachedAt: null };
        });

        for (const key of allKeys) {
            const raw = await env.CACHE.get(key);
            if (!raw) continue;

            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (_) {}

            const entry = {
                key,
                cachedAt: parsed?.cachedAt || 'Unknown',
                size: new Blob([raw]).size,
            };

            // If this is a per-category items key, extract item count + image health
            // Key shape: v2.2_items_<category>_all
            const catMatch = key.match(/^v[\d.]+_items_([a-z]+)_all$/);
            if (catMatch) {
                const cat = catMatch[1];
                if (catHealth[cat] !== undefined) {
                    const items = parsed?.data?.items || [];
                    const withImg = items.filter(it => {
                        if (!Array.isArray(it.images) || !it.images.length) return false;
                        const url = (it.images.find(i => i?.isPrimary) || it.images[0])?.url || '';
                        return url.startsWith('http');
                    }).length;

                    catHealth[cat] = {
                        cached:     true,
                        itemCount:  items.length,
                        withImages: withImg,
                        cachedAt:   parsed?.cachedAt || null,
                    };
                    // Annotate the table entry too
                    entry.itemCount  = items.length;
                    entry.withImages = withImg;
                }
            }

            status.push(entry);
        }

        return new Response(JSON.stringify({
            total: status.length,
            caches: status,
            categoryHealth: catHealth,
            timestamp: new Date().toISOString()
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: DELETE /api/cache/clear - Clear specific or all caches
async function handleCacheClear(request, env) {
    if (!(await verifyAdmin(request, env))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        const url = new URL(request.url);
        const type = url.searchParams.get('type'); // items, config, shops, all
        const category = url.searchParams.get('category'); // for items
        const v = url.searchParams.get('v') || '2.2';

        let deletedKeys = [];

        if (type === 'all') {
            // Clear all caches
            const allKeys = await CacheService.list(env, 'v2.2_');
            for (const key of allKeys) {
                await CacheService.delete(env, key);
                deletedKeys.push(key);
            }
        } else if (type === 'items') {
            if (category) {
                // Clear specific category
                const key = CacheService.getCacheKey('items', category, 'all', v);
                await CacheService.delete(env, key);
                deletedKeys.push(key);
            } else {
                // Clear all item caches
                const allKeys = await CacheService.list(env, `v${v}_items_`);
                for (const key of allKeys) {
                    await CacheService.delete(env, key);
                    deletedKeys.push(key);
                }
            }
        } else if (type === 'config') {
            const key = CacheService.getCacheKey('config', 'xerox', null, v);
            await CacheService.delete(env, key);
            deletedKeys.push(key);
        } else if (type === 'shops') {
            const key = CacheService.getCacheKey('shops', 'all', null, v);
            await CacheService.delete(env, key);
            deletedKeys.push(key);
        } else if (type === 'locations') {
            const key = CacheService.getCacheKey('locations', 'all', null, v);
            await CacheService.delete(env, key);
            deletedKeys.push(key);
        } else if (type === 'data') {
            // Clear all data caches
            const allKeys = await CacheService.list(env, `v${v}_data_`);
            for (const key of allKeys) {
                await CacheService.delete(env, key);
                deletedKeys.push(key);
            }
        } else {
            return new Response(JSON.stringify({ error: 'Invalid type parameter' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        return new Response(JSON.stringify({ 
            success: true,
            deleted: deletedKeys.length,
            keys: deletedKeys,
            timestamp: new Date().toISOString()
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: POST /api/cache/refresh - Clear and refetch data
//
// For type='items':
//   - category=null or category='all'  → fetch ALL items, then write one KV key
//     PER CATEGORY (stationary/books/electronic/posters) so /api/items?category=X always
//     gets a warm cache, PLUS the cross-category 'all' key.
//   - category='stationary'|'books'|'electronic'|'posters'  → refresh only that category.
async function handleCacheRefresh(request, env) {
    if (!(await verifyAdmin(request, env))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        const body = await request.json();
        const type     = body.type;
        // Normalise: treat 'all' the same as null (both mean "every category")
        const category = (body.category && body.category !== 'all') ? body.category : null;
        const v = '2.2';

        const fs = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 30000);

        let result;
        let writtenKeys = [];
        let totalItems  = 0;

        if (type === 'items') {
            if (!category) {
                // ── FULL REFRESH: fetch every category, write one key per category ──
                const CATS = ['stationary', 'books', 'electronic', 'posters'];

                // Also clear the legacy 'all' cross-category key
                const allKey = CacheService.getCacheKey('items', 'all', 'all', v);
                await CacheService.delete(env, allKey);

                for (const cat of CATS) {
                    const catKey = CacheService.getCacheKey('items', cat, 'all', v);
                    await CacheService.delete(env, catKey);

                    const catResult = await fs.fetchItemsByCategory(cat, null, controller.signal, false);
                    await CacheService.set(env, catKey, catResult);

                    writtenKeys.push(catKey);
                    totalItems += catResult.items?.length || 0;

                    Logger.log('CacheRefresh', `${cat}: ${catResult.items?.length || 0} items → ${catKey}`);
                }

                result = { items: [], writtenKeys };   // summary placeholder
            } else {
                // ── PER-CATEGORY REFRESH ──
                const catKey = CacheService.getCacheKey('items', category, 'all', v);
                await CacheService.delete(env, catKey);

                const catResult = await fs.fetchItemsByCategory(category, null, controller.signal, false);
                await CacheService.set(env, catKey, catResult);

                writtenKeys.push(catKey);
                totalItems = catResult.items?.length || 0;
                result     = catResult;

                Logger.log('CacheRefresh', `${category}: ${totalItems} items → ${catKey}`);
            }

        } else if (type === 'config') {
            const cacheKey = CacheService.getCacheKey('config', 'xerox', null, v);
            await CacheService.delete(env, cacheKey);
            result = await fs.getXeroxConfig(controller.signal);
            await CacheService.set(env, cacheKey, result);
            writtenKeys.push(cacheKey);

        } else if (type === 'shops') {
            const cacheKey = CacheService.getCacheKey('shops', 'all', null, v);
            await CacheService.delete(env, cacheKey);
            const shops = await fs.fetchXeroxShops(controller.signal);
            result = { shops };
            await CacheService.set(env, cacheKey, result);
            writtenKeys.push(cacheKey);
            totalItems = shops.length;

        } else if (type === 'locations') {
            const cacheKey = CacheService.getCacheKey('locations', 'all', null, v);
            await CacheService.delete(env, cacheKey);
            result = await fs.fetchLocations(controller.signal);
            await CacheService.set(env, cacheKey, result);
            writtenKeys.push(cacheKey);

        } else {
            clearTimeout(timeoutId);
            return new Response(JSON.stringify({ error: 'Invalid type' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        clearTimeout(timeoutId);

        return new Response(JSON.stringify({
            success:    true,
            type:       type,
            category:   category || 'all',
            writtenKeys,
            itemCount:  totalItems || (type === 'shops' ? result.shops?.length : null),
            timestamp:  new Date().toISOString()
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// ═════════════════════════════════════════════════════════════════
// MAIN ROUTER
// ═════════════════════════════════════════════════════════════════

export default {
    async fetch(request, env) {
        // CORS Preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                }
            });
        }

        const url = new URL(request.url);
        const pathname = url.pathname;

        // Route to handlers
        if (pathname === '/api/items' && request.method === 'GET') {
            return handleGetItemsByCategory(request, env);
        }

        if (pathname === '/api/config/xerox' && request.method === 'GET') {
            return handleGetXeroxConfig(request, env);
        }

        if (pathname === '/api/shops/all' && request.method === 'GET') {
            return handleGetShopsAll(request, env);
        }

        if (pathname === '/api/locations/all' && request.method === 'GET') {
            return handleGetLocations(request, env);
        }

        if (pathname === '/api/notification-history' && request.method === 'GET') {
            return handleGetHistory(request, env);
        }

        if (pathname === '/api/notification-history' && request.method === 'DELETE') {
            return handleDeleteHistory(request, env);
        }

        if (pathname === '/api/data' && request.method === 'GET') {
            return handleGetData(request, env);
        }

        if (pathname === '/api/send-notification') {
            return handleSendNotification(request, env);
        }

        if (pathname === '/api/send-push-all') {
            return handleSendPushAll(request, env);
        }

        if (pathname === '/api/subscribe') {
            return handleSubscribe(request, env);
        }

        // Cache control endpoints
        if (pathname === '/api/cache/status' && request.method === 'GET') {
            return handleCacheStatus(request, env);
        }

        if (pathname === '/api/cache/refresh' && request.method === 'POST') {
            return handleCacheRefresh(request, env);
        }

        if (pathname === '/api/cloudinary/all' && request.method === 'GET') {
            return handleGetCloudinaryResources(request, env);
        }

        if (pathname === '/api/cloudinary/delete' && request.method === 'POST') {
            return handleDeleteCloudinaryResource(request, env);
        }

        // R2 product image endpoints (admin — require Authorization: Bearer <Firebase ID token>)
        if (pathname === '/api/r2/images' && request.method === 'GET') {
            return handleR2ListImages(request, env);
        }

        if (pathname === '/api/r2/delete' && request.method === 'POST') {
            return handleR2DeleteImages(request, env);
        }

        // Banner endpoints
        if (pathname === '/api/banners' && request.method === 'GET') {
            return handleGetBanners(request, env);
        }

        if (pathname === '/api/banners' && request.method === 'POST') {
            return handleSetBanners(request, env);
        }

        if (pathname === '/api/site-config' && request.method === 'GET') {
            return handleGetSiteConfig(request, env);
        }

        if (pathname === '/api/site-config' && request.method === 'POST') {
            return handleSetSiteConfig(request, env);
        }

        if (pathname === '/api/config/other-shops' && request.method === 'GET') {
            return handleGetOtherShops(request, env);
        }

        if (pathname === '/api/config/other-shops' && request.method === 'POST') {
            return handleSetOtherShops(request, env);
        }

        if (pathname === '/api/cache/refresh-banners' && request.method === 'POST') {
            return handleRefreshBannersCache(request, env);
        }

        // Payment config endpoints
        if ((pathname === '/api/config/payment' || pathname === '/api/config/payment/version')
                && request.method === 'GET') {
            return handleGetPaymentConfig(request, env);
        }

        if (pathname === '/api/config/payment' && request.method === 'POST') {
            return handleSetPaymentConfig(request, env);
        }

        // Payment-specific cache clear (bust only payment KV key)
        if (pathname === '/api/cache/clear' && request.method === 'DELETE') {
            const url = new URL(request.url);
            if (url.searchParams.get('type') === 'payment') {
                if (!(await verifyAdmin(request, env))) {
                    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                        status: 401,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }
                await CacheService.delete(env, PAYMENT_CONFIG_CACHE_KEY);
                return new Response(JSON.stringify({
                    success: true,
                    deleted: [PAYMENT_CONFIG_CACHE_KEY],
                    timestamp: new Date().toISOString()
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
            // All other ?type= values handled by the generic cache clear handler below
            return handleCacheClear(request, env);
        }

        // Default health check
        return new Response(JSON.stringify({ 
            message: '✅ API Ready v6 - Cache Control Enabled',
            endpoints: [
                '/api/items?category=stationary',
                '/api/config/xerox',
                '/api/shops/all',
                '/api/data?collection=metadata&id=item_filters',
                '/api/notification-history',
                '/api/banners (GET - public, POST - admin invalidate)',
                '/api/site-config (GET - public, POST - admin invalidate)',
                '/api/config/other-shops (GET - public, POST - admin write KV)',
                '/api/config/payment (GET - public, POST - admin write KV)',
                '/api/config/payment/version (GET - public, version check)',
                '/api/cache/status (GET - Admin)',
                '/api/cache/clear?type=items (DELETE - Admin)',
                '/api/cache/clear?type=payment (DELETE - Admin)',
                '/api/cache/refresh (POST - Admin)',
                '/api/cache/refresh-banners (POST - Admin)',
                '/api/r2/images (GET - Admin, ?prefix=products/)',
                '/api/r2/delete (POST - Admin, { keys: [...] })'
            ],
            cacheInfo: 'Caches persist indefinitely - manual control via admin panel',
            timestamp: new Date().toISOString()
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    },

    /* Cron (wrangler.toml [triggers]) — runs the payment server's wallet settle +
       abandoned-checkout sweep every 15 min, waking Render if it is asleep.
       Needs PAYMENT_SERVER_URL (var) and SERVER_SECRET (secret, same value as on Render). */
    async scheduled(_event, env, ctx) {
        if (!env.PAYMENT_SERVER_URL || !env.SERVER_SECRET) return;
        ctx.waitUntil(fetch(`${env.PAYMENT_SERVER_URL.replace(/\/$/, '')}/api/wallet/settle-all`, {
            method:  'POST',
            headers: { 'x-server-secret': env.SERVER_SECRET },
        }).then(r => console.log('[cron] settle-all', r.status))
          .catch(e => console.error('[cron] settle-all failed:', e.message)));
    }
};

// ─── standalone handlers ───

// Handler: GET /api/notification-history
async function handleGetHistory(request, env) {
    if (!(await verifyAdmin(request, env, ['admin', 'manage_marketing']))) return unauthorized();
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

    try {
        const firestore = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
        // Fetch up to 10 recent notifications
        const result = await firestore.searchDocuments('sent_notifications', {
            limit: 10
        });

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: DELETE /api/notification-history
async function handleDeleteHistory(request, env) {
    if (!(await verifyAdmin(request, env, ['admin', 'manage_marketing']))) return unauthorized();
    if (request.method !== 'DELETE') return new Response('Method Not Allowed', { status: 405 });

    try {
        const url = new URL(request.url);
        const docId = url.searchParams.get('id');
        const deleteAll = url.searchParams.get('all') === 'true';

        const firestore = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);

        if (deleteAll) {
            // Delete all notification history
            const docs = await firestore.searchDocuments('sent_notifications', { limit: 100 });
            let deletedCount = 0;

            for (const doc of docs) {
                try {
                    await firestore.deleteDocument('sent_notifications', doc.id);
                    deletedCount++;
                } catch (err) {
                    console.error(`Failed to delete doc ${doc.id}:`, err);
                }
            }

            return new Response(JSON.stringify({ 
                success: true, 
                message: `Deleted ${deletedCount} notification(s)`,
                deletedCount 
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        } else if (docId) {
            // Delete single notification
            await firestore.deleteDocument('sent_notifications', docId);

            return new Response(JSON.stringify({ 
                success: true, 
                message: 'Notification deleted successfully' 
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        } else {
            return new Response(JSON.stringify({ error: 'Missing id or all parameter' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: GET /api/cloudinary/all
async function handleGetCloudinaryResources(request, env) {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

    if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
        return new Response(JSON.stringify({ error: 'Cloudinary credentials not configured in Worker' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        const expression = "resource_type:image";
        const max_results = 500;
        const ts = Math.round(Date.now() / 1000);

        // Helper for HMAC SHA-1 is complicated in Workers, but we can just use Basic Auth for Admin API
        const auth = btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`);
        
        const response = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/search`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                expression,
                max_results
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error?.message || "Cloudinary Search Failed");
        }

        const data = await response.json();
        const resources = (data.resources || []).map(r => ({
            public_id: r.public_id,
            url: r.secure_url,
            bytes: r.bytes,
            width: r.width,
            height: r.height,
            uploadedAt: r.created_at,
            format: r.format
        }));

        return new Response(JSON.stringify(resources), {
            status: 200,
            headers: { 
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// Handler: POST /api/cloudinary/delete
// Body: { public_id: string } or { public_ids: string[] }
// Uses Cloudinary Admin API (Basic Auth with api_key:api_secret) routed through
// the Worker so the api_secret never touches the client.
async function handleDeleteCloudinaryResource(request, env) {
    if (!(await verifyAdmin(request, env))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
        return new Response(JSON.stringify({ error: 'Cloudinary credentials not configured in Worker env' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        const body = await request.json();
        // Accept a single public_id or a batch array
        const ids = body.public_ids
            ? (Array.isArray(body.public_ids) ? body.public_ids : [body.public_ids])
            : (body.public_id ? [body.public_id] : []);

        if (!ids.length) {
            return new Response(JSON.stringify({ error: 'No public_id(s) provided' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        const auth = btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`);
        const results = { deleted: {}, failed: {} };

        // Cloudinary destroy endpoint accepts one public_id per call.
        // For batches we run them in parallel (max 20 at a time to stay safe).
        const CHUNK = 20;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            await Promise.all(chunk.map(async pid => {
                try {
                    // Use the Admin API destroy endpoint
                    const ts  = Math.floor(Date.now() / 1000);
                    const res = await fetch(
                        `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/destroy`,
                        {
                            method: 'POST',
                            headers: {
                                'Authorization': `Basic ${auth}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ public_id: pid, invalidate: true })
                        }
                    );
                    const data = await res.json();
                    if (data.result === 'ok' || data.result === 'not found') {
                        results.deleted[pid] = data.result;
                    } else {
                        results.failed[pid] = data.error?.message || data.result || 'unknown';
                    }
                } catch (err) {
                    results.failed[pid] = err.message;
                }
            }));
        }

        const deletedCount = Object.keys(results.deleted).length;
        const failedCount  = Object.keys(results.failed).length;

        return new Response(JSON.stringify({
            success: failedCount === 0,
            deleted: deletedCount,
            failed:  failedCount,
            results
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// ─── Banner & Site Config Handlers ───────────────────────────────────────────

const BANNERS_CACHE_KEY = 'v2.2_site_banners';
const SITE_CONFIG_CACHE_KEY = 'v2.2_site_config_category_images';

/**
 * GET /api/banners
 * Returns active banners ordered by `order` field.
 * Served from KV cache; falls back to Firestore if cache miss.
 */
async function handleGetBanners(request, env) {
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get('refresh') === '1';

    if (!forceRefresh) {
        const cached = await CacheService.get(env, BANNERS_CACHE_KEY);
        if (cached) {
            return new Response(JSON.stringify({ banners: cached.data, source: 'cache' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
    }

    try {
        const fs = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        // Fetch site_banners collection
        const response = await fetch(
            `${fs.baseUrl}/site_banners?key=${fs.apiKey}`,
            { signal: controller.signal }
        );
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`Firestore fetch failed: ${response.status}`);

        const data = await response.json();
        const docs = (data.documents || []).map(doc => ({
            id: doc.name.split('/').pop(),
            ...fs.flattenFields(doc.fields)
        }));

        // Filter active, sort by order
        const banners = docs
            .filter(b => b.active !== false)
            .sort((a, b) => (a.order || 0) - (b.order || 0));

        await CacheService.set(env, BANNERS_CACHE_KEY, banners);

        return new Response(JSON.stringify({ banners, source: 'firestore' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        Logger.log('Banners', 'Fetch failed:', error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

/**
 * POST /api/banners
 * Admin: invalidates the banners KV cache (triggers re-fetch on next GET).
 * Called by admin-banners.js after any banner create/update/delete/reorder.
 */
async function handleSetBanners(request, env) {
    if (!(await verifyAdmin(request, env, ['admin', 'manage_banners']))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        await CacheService.delete(env, BANNERS_CACHE_KEY);
        Logger.log('Banners', 'Cache invalidated by admin');
        return new Response(JSON.stringify({ success: true, message: 'Banner cache cleared. Next request will fetch fresh data.' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

/**
 * GET /api/site-config
 * Returns category images config from KV cache or Firestore.
 */
async function handleGetSiteConfig(request, env) {
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get('refresh') === '1';

    if (!forceRefresh) {
        const cached = await CacheService.get(env, SITE_CONFIG_CACHE_KEY);
        if (cached) {
            return new Response(JSON.stringify({ config: cached.data, source: 'cache' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
    }

    try {
        const fs = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(
            `${fs.baseUrl}/site_config/category_images?key=${fs.apiKey}`,
            { signal: controller.signal }
        );
        clearTimeout(timeoutId);

        if (!response.ok) {
            // Doc may not exist yet — return empty config
            return new Response(JSON.stringify({ config: {}, source: 'firestore' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        const data = await response.json();
        const config = fs.flattenFields(data.fields || {});

        await CacheService.set(env, SITE_CONFIG_CACHE_KEY, config);

        return new Response(JSON.stringify({ config, source: 'firestore' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        Logger.log('SiteConfig', 'Fetch failed:', error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

/**
 * POST /api/site-config
 * Admin: invalidates the site config KV cache.
 */
async function handleSetSiteConfig(request, env) {
    if (!(await verifyAdmin(request, env, ['admin', 'manage_banners']))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        await CacheService.delete(env, SITE_CONFIG_CACHE_KEY);
        Logger.log('SiteConfig', 'Cache invalidated by admin');
        return new Response(JSON.stringify({ success: true, message: 'Site config cache cleared.' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// ─── Other Shops Config Handlers ─────────────────────────────────────────────

const OTHER_SHOPS_CACHE_KEY = 'v2.2_config_other_shops';

/**
 * GET /api/config/other-shops
 * Public — returns the admin-configured fallback shop IDs per category.
 * Shape: { stationary: shopId|null, books: shopId|null, xerox: shopId|null, kits: shopId|null }
 * Only the four category keys are returned — internal fields (updatedAt, source) are stripped.
 */
async function handleGetOtherShops(request, env) {
    const cached = await CacheService.get(env, OTHER_SHOPS_CACHE_KEY);
    if (cached) {
        // Return only the four category fields — never leak updatedAt or internal keys
        const { stationary = null, books = null, xerox = null, kits = null } = cached.data || {};
        return new Response(JSON.stringify({ stationary, books, xerox, kits, source: 'cache' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400'
            }
        });
    }
    // No config yet — return clean empty defaults
    return new Response(JSON.stringify({
        stationary: null, books: null, xerox: null, kits: null, source: 'default'
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}

/**
 * POST /api/config/other-shops
 * Admin — writes the fallback shop IDs per category into KV.
 * Body: { stationary?: string|null, books?: string|null, xerox?: string|null, kits?: string|null }
 * Values must be non-empty strings (shop IDs) or null/omitted to clear.
 */
async function handleSetOtherShops(request, env) {
    if (!(await verifyAdmin(request, env))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
    try {
        const body = await request.json();

        // Sanitise: accept only non-empty strings, everything else becomes null
        const sanitiseId = v => (v && typeof v === 'string' && v.trim() !== '') ? v.trim() : null;

        const config = {
            stationary: sanitiseId(body.stationary),
            books:      sanitiseId(body.books),
            xerox:      sanitiseId(body.xerox),
            kits:       sanitiseId(body.kits),
            updatedAt:  new Date().toISOString()
        };

        // Delete old entry first, then write fresh — avoids stale reads during the window
        await CacheService.delete(env, OTHER_SHOPS_CACHE_KEY);
        await CacheService.set(env, OTHER_SHOPS_CACHE_KEY, config);

        Logger.log('OtherShops', 'KV updated', { xerox: config.xerox, stationary: config.stationary, books: config.books, kits: config.kits });

        // Return only the category fields in the response
        const { stationary, books, xerox, kits } = config;
        return new Response(JSON.stringify({ success: true, config: { stationary, books, xerox, kits }, timestamp: config.updatedAt }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        Logger.log('OtherShops', 'POST error:', error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// ─── Payment Config Handlers ─────────────────────────────────────────────────

const PAYMENT_CONFIG_CACHE_KEY = 'v2.2_config_payment';

/**
 * GET /api/config/payment
 * Public — returns the current payment config.
 * Served from KV cache; on miss, fetches from Firestore and stores in KV (no TTL).
 *
 * GET /api/config/payment/version
 * Public — returns only { version } for cheap client-side staleness check.
 */
async function handleGetPaymentConfig(request, env) {
    const url = new URL(request.url);
    const isVersionOnly = url.pathname === '/api/config/payment/version';

    // ── Single KV read — used for both /payment and /payment/version ─────────
    const cached = await CacheService.get(env, PAYMENT_CONFIG_CACHE_KEY);

    if (cached) {
        // Version-only endpoint — return just the version number
        if (isVersionOnly) {
            return new Response(JSON.stringify({ version: cached.data?.version ?? 1 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
        // Full config endpoint
        return new Response(JSON.stringify({ ...cached.data, source: 'cache' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=43200'   // 12-hr browser hint
            }
        });
    }

    // ── KV miss — fetch from Firestore and warm the cache ────────────────────
    try {
        const fs = new FirestoreService(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(
            `${fs.baseUrl}/config/payment?key=${fs.apiKey}`,
            { signal: controller.signal }
        );
        clearTimeout(timeoutId);

        let config;
        if (response.ok) {
            const data = await response.json();
            config = fs.flattenFields(data.fields || {});
        } else {
            // Document doesn't exist yet — safe defaults
            // onlineDepositPercent defaults to 30 so partial_online is usable immediately
            config = {
                mode:                 'both',
                onlineDepositPercent: 30,
                applyToCart:          true,
                applyToXerox:         true,
                version:              1,
            };
        }

        // Store in KV — no TTL, manual control by admin
        await CacheService.set(env, PAYMENT_CONFIG_CACHE_KEY, config);
        Logger.log('PaymentConfig', `Warmed KV cache (mode=${config.mode}, v${config.version})`);

        // Version-only response after warming
        if (isVersionOnly) {
            return new Response(JSON.stringify({ version: config.version ?? 1 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        return new Response(JSON.stringify({ ...config, source: 'firestore' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=43200'
            }
        });
    } catch (error) {
        Logger.log('PaymentConfig', 'GET error:', error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

/**
 * POST /api/config/payment
 * Admin-only — receives the new payment config from the admin page,
 * writes it to KV (busting the old entry), and returns the stored value.
 *
 * The admin page has ALREADY written to Firestore directly via the client
 * SDK. This endpoint only handles the KV layer so the worker stays as
 * the single source for the cached config.
 *
 * Body: { mode, onlineDepositPercent, applyToCart, applyToXerox, version, updatedBy }
 */
async function handleSetPaymentConfig(request, env) {
    if (!(await verifyAdmin(request, env))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        const body = await request.json();

        // Validate required fields
        const VALID_MODES = ['cod_only', 'online_only', 'both', 'partial_online'];
        if (!body.mode || !VALID_MODES.includes(body.mode)) {
            return new Response(JSON.stringify({ error: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}` }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        if (body.mode === 'partial_online') {
            const pct = parseInt(body.onlineDepositPercent, 10);
            if (isNaN(pct) || pct < 1 || pct > 99) {
                return new Response(JSON.stringify({ error: 'onlineDepositPercent must be 1–99 for partial_online mode.' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        const config = {
            mode:                 body.mode,
            // Always store the actual deposit value the admin set.
            // For non-partial modes this is still recorded so switching back
            // to partial_online restores the last-configured percentage.
            onlineDepositPercent: parseInt(body.onlineDepositPercent, 10) || 30,
            applyToCart:          body.applyToCart  !== false,
            applyToXerox:         body.applyToXerox !== false,
            version:              parseInt(body.version, 10) || 1,
            updatedBy:            body.updatedBy || 'admin',
            updatedAt:            new Date().toISOString(),
        };

        // Delete old KV entry then write fresh — ensures no stale data lingers
        await CacheService.delete(env, PAYMENT_CONFIG_CACHE_KEY);
        await CacheService.set(env, PAYMENT_CONFIG_CACHE_KEY, config);

        Logger.log('PaymentConfig', `KV updated — mode=${config.mode}, v${config.version} by ${config.updatedBy}`);

        return new Response(JSON.stringify({
            success:   true,
            cacheKey:  PAYMENT_CONFIG_CACHE_KEY,
            config,
            timestamp: new Date().toISOString()
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        Logger.log('PaymentConfig', 'POST error:', error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/cache/refresh-banners
 * Admin: clears both banner and site-config caches, then pre-warms them
 * by fetching fresh data from Firestore and storing in KV.
 */
async function handleRefreshBannersCache(request, env) {
    if (!(await verifyAdmin(request, env, ['admin', 'manage_banners']))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        // Delete both caches
        await Promise.all([
            CacheService.delete(env, BANNERS_CACHE_KEY),
            CacheService.delete(env, SITE_CONFIG_CACHE_KEY)
        ]);

        // Pre-warm: fetch fresh data and store in KV
        const [bannersRes, configRes] = await Promise.allSettled([
            handleGetBanners(new Request(`${new URL(request.url).origin}/api/banners?refresh=1`), env),
            handleGetSiteConfig(new Request(`${new URL(request.url).origin}/api/site-config?refresh=1`), env)
        ]);

        const bannersOk = bannersRes.status === 'fulfilled';
        const configOk = configRes.status === 'fulfilled';

        Logger.log('RefreshBanners', `Banners: ${bannersOk ? 'OK' : 'FAILED'}, Config: ${configOk ? 'OK' : 'FAILED'}`);

        return new Response(JSON.stringify({
            success: true,
            message: 'Banner and category image caches refreshed.',
            banners: bannersOk ? 'refreshed' : 'failed',
            siteConfig: configOk ? 'refreshed' : 'failed'
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// ═════════════════════════════════════════════════════════════════
// R2 PRODUCT IMAGE HANDLERS
// Uses the R2 bucket binding named "PRODUCT_IMAGES" in wrangler.toml
// Both endpoints require: Authorization: Bearer <Firebase ID token> of an admin / manage_items user
// ═════════════════════════════════════════════════════════════════

/**
 * GET /api/r2/images?prefix=products/
 * Lists all objects under the given prefix (default: products/).
 * Returns: { objects: [{ key, url, size, lastModified }], count }
 *
 * Requires the R2 bucket to have a custom domain / public access URL
 * set as the R2_PUBLIC_URL Worker env var.
 */
async function handleR2ListImages(request, env) {
    if (!(await verifyAdmin(request, env))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }

    // R2 bucket binding and public URL must be configured in wrangler.toml / Worker env
    if (!env.PRODUCT_IMAGES) {
        return new Response(JSON.stringify({ error: 'R2 bucket binding PRODUCT_IMAGES not configured.' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }

    const url       = new URL(request.url);
    const prefix    = url.searchParams.get('prefix') || 'products/';
    const publicBase = (env.R2_PUBLIC_URL || '').replace(/\/$/, '');

    try {
        const listed  = await env.PRODUCT_IMAGES.list({ prefix, limit: 1000 });
        const objects = listed.objects.map(obj => ({
            key:          obj.key,
            url:          publicBase ? `${publicBase}/${obj.key}` : obj.key,
            size:         obj.size,
            lastModified: obj.uploaded,   // R2 uses 'uploaded' not 'LastModified'
        }));

        return new Response(JSON.stringify({ objects, count: objects.length }), {
            status: 200,
            headers: {
                'Content-Type':                'application/json',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (err) {
        Logger.log('R2', 'handleR2ListImages error:', err.message);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }
}

/**
 * POST /api/r2/delete
 * Body: { keys: ["products/stationary/pen/uuid.jpg", ...] }
 * Deletes each key from the R2 bucket.
 * Returns: { deleted: number, failed: number, errors: [...] }
 */
async function handleR2DeleteImages(request, env) {
    if (!(await verifyAdmin(request, env))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }

    if (!env.PRODUCT_IMAGES) {
        return new Response(JSON.stringify({ error: 'R2 bucket binding PRODUCT_IMAGES not configured.' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }

    let keys;
    try {
        const body = await request.json();
        keys = body.keys;
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }

    if (!Array.isArray(keys) || keys.length === 0) {
        return new Response(JSON.stringify({ error: 'keys must be a non-empty array.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }

    // Safety: only allow deleting inside products/
    const safe   = keys.filter(k => typeof k === 'string' && k.startsWith('products/'));
    const unsafe = keys.filter(k => !safe.includes(k));

    let deleted = 0;
    let failed  = 0;
    const errors = [];

    for (const key of safe) {
        try {
            await env.PRODUCT_IMAGES.delete(key);
            deleted++;
        } catch (err) {
            failed++;
            errors.push({ key, error: err.message });
            Logger.log('R2', `Delete failed for ${key}:`, err.message);
        }
    }

    return new Response(JSON.stringify({
        deleted,
        failed:  failed + unsafe.length,
        skipped: unsafe.length,
        errors,
        timestamp: new Date().toISOString(),
    }), {
        status: 200,
        headers: {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
}
