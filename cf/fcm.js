/* ═══════════════════════════════════════════════════════════════════
   OMX — Firebase Cloud Messaging (HTTP v1) from Workers, no SDK.
   Credentials: FIREBASE_SERVICE_ACCOUNT (whole JSON, raw or base64) or the
   split FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY / FIREBASE_PROJECT_ID.
   ═══════════════════════════════════════════════════════════════════ */

export function serviceAccount(env) {
    const raw = String(env.FIREBASE_SERVICE_ACCOUNT || env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (raw) {
        const sa = JSON.parse(raw.startsWith('{') ? raw : atob(raw));
        sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
        return sa;
    }
    return {
        project_id: env.FIREBASE_PROJECT_ID,
        client_email: env.FIREBASE_CLIENT_EMAIL,
        private_key: String(env.FIREBASE_PRIVATE_KEY || '').trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n'),
    };
}

export const fcmConfigured = env => {
    try { const sa = serviceAccount(env); return !!(sa.client_email && sa.private_key && sa.project_id); }
    catch (_) { return false; }
};

const _toks = new Map();   // scope → { token, exp }
export async function accessToken(sa, scope = 'https://www.googleapis.com/auth/firebase.messaging') {
    const c = _toks.get(scope);
    if (c && Date.now() < c.exp - 60_000) return c.token;
    const b64u = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({
        iss: sa.client_email, scope,
        aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    }));
    const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '');
    const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`)));
    let bin = '';
    for (const b of sig) bin += String.fromCharCode(b);
    const jwt = `${head}.${body}.${b64u(bin)}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const j = await res.json();
    if (!res.ok || !j.access_token) throw new Error(`Google token failed: ${j.error_description || j.error || res.status}`);
    _toks.set(scope, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
    return j.access_token;
}

export const FCM_CODES = {
    UNREGISTERED: 'messaging/registration-token-not-registered',
    NOT_FOUND: 'messaging/registration-token-not-registered',
    INVALID_ARGUMENT: 'messaging/invalid-argument',
    SENDER_ID_MISMATCH: 'messaging/mismatched-credential',
    QUOTA_EXCEEDED: 'messaging/message-rate-exceeded',
    UNAVAILABLE: 'messaging/server-unavailable',
    INTERNAL: 'messaging/internal-error',
};

/**
 * Send one v1 message body (without `token`) to each token.
 * Returns [{ token, success, error?: { code, message } }].
 */
export async function sendToTokens(env, tokens, message) {
    const sa = serviceAccount(env);
    const bearer = await accessToken(sa);
    const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
    const out = [];
    for (let i = 0; i < tokens.length; i += 6) {
        out.push(...await Promise.all(tokens.slice(i, i + 6).map(async token => {
            try {
                const r = await fetch(url, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: { ...message, token } }),
                });
                if (r.ok) return { token, success: true };
                const err = (await r.json().catch(() => ({}))).error || {};
                const detail = (err.details || []).find(d => d.errorCode)?.errorCode || err.status || 'INTERNAL';
                return { token, success: false, error: { code: FCM_CODES[detail] || 'messaging/unknown-error', message: err.message || detail } };
            } catch (e) {
                return { token, success: false, error: { code: 'messaging/internal-error', message: e.message } };
            }
        })));
    }
    return out;
}

export const isStaleToken = code => code === FCM_CODES.UNREGISTERED || code === FCM_CODES.INVALID_ARGUMENT;
