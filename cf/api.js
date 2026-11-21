/* ═══════════════════════════════════════════════════════════════════
   OMX API Worker — replaces the Render server and Firestore.
   - /db/*      browser data API (cf/dbapi.js), used by /cf-firestore.js
   - /api/*     the Express routes from ../server, unchanged, running on
                Workers' node:http support; firebase-admin → D1 shim
   - cron       wallet / referral / abandoned-checkout settle (was the
                Render timer + jasa-backend-worker cron)
   ═══════════════════════════════════════════════════════════════════ */
import { httpServerHandler } from 'cloudflare:node';
import app from './server-app.cjs';
import { handleDb } from './dbapi.js';
import { settleAll } from '../server/settle.js';
import { bridgeFromFirestore } from './bridge.js';

const PORT = 3001;
app.listen(PORT);
const node = httpServerHandler({ port: PORT });

function corsOrigin(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (!origin) return null;
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);
    const dev = env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
    return dev || allowed.includes(origin) ? origin : null;
}

function withCors(res, origin) {
    const h = new Headers(res.headers);
    if (origin) {
        h.set('Access-Control-Allow-Origin', origin);
        h.set('Access-Control-Allow-Credentials', 'true');
        h.append('Vary', 'Origin');
    }
    return new Response(res.body, { status: res.status, headers: h });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/db/')) {
            const origin = corsOrigin(request, env);
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    status: origin ? 204 : 403,
                    headers: origin ? {
                        'Access-Control-Allow-Origin': origin,
                        'Access-Control-Allow-Methods': 'POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                        'Access-Control-Allow-Credentials': 'true',
                        'Access-Control-Max-Age': '86400',
                        'Vary': 'Origin',
                    } : {},
                });
            }
            if (request.headers.get('Origin') && !origin) {
                return new Response(JSON.stringify({ error: { code: 'permission-denied', message: 'Origin not allowed' } }), { status: 403 });
            }
            return withCors(await handleDb(request, env, ctx), origin);
        }
        return node.fetch(request, env, ctx);
    },

    // Every 5 min: the old-app bridge (while BRIDGE_FIRESTORE is set).
    // Every 15 min: settle (wallet cashback / refunds / stale holds / abandoned checkouts).
    async scheduled(event, env, ctx) {
        ctx.waitUntil(bridgeFromFirestore(env).catch(e => console.error('[cron] bridge failed:', e.message)));
        const minute = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
        if (minute % 15 < 5) {
            ctx.waitUntil(settleAll().then(r => console.log('[cron] settle', JSON.stringify(r)))
                .catch(e => console.error('[cron] settle failed:', e.message)));
        }
    },
};
