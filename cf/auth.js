/* ═══════════════════════════════════════════════════════════════════
   OMX — Firebase Auth ID-token check on Workers (WebCrypto, no SDK).
   Sign-in stays on Firebase Auth (free, unlimited for email/Google);
   only the data moved to D1.
   ═══════════════════════════════════════════════════════════════════ */

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let _jwks = { keys: null, exp: 0 };

function b64urlBytes(str) {
    let b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
const b64urlJson = str => JSON.parse(new TextDecoder().decode(b64urlBytes(str)));

async function jwks() {
    if (_jwks.keys && Date.now() < _jwks.exp) return _jwks.keys;
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1]) || 3600;
    _jwks = { keys: (await res.json()).keys || [], exp: Date.now() + maxAge * 1000 };
    return _jwks.keys;
}

/** Decoded token ({ uid, sub, email, ... }) or null when it is not a valid ID token for projectId. */
export async function verifyIdToken(token, projectId) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !projectId) return null;
    try {
        const header = b64urlJson(parts[0]);
        const payload = b64urlJson(parts[1]);
        const now = Math.floor(Date.now() / 1000);
        if (header.alg !== 'RS256' || !payload.sub
            || payload.aud !== projectId
            || payload.iss !== `https://securetoken.google.com/${projectId}`
            || !(payload.exp > now) || payload.iat > now + 300) return null;
        const jwk = (await jwks()).find(k => k.kid === header.kid);
        if (!jwk) return null;
        const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]),
            new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
        return ok ? { ...payload, uid: payload.sub } : null;
    } catch (e) {
        console.warn('[auth] id token check failed:', e.message);
        return null;
    }
}

/** Token from "Authorization: Bearer ..." */
export function bearer(request) {
    const h = request.headers.get('Authorization') || '';
    return h.startsWith('Bearer ') ? h.slice(7) : '';
}
