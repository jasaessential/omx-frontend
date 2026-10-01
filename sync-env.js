/**
 * sync-env.js
 * -----------
 * Previously generated env-config.js with hardcoded values.
 *
 * As of JASA V2 (Node backend), env-config.js is NO LONGER generated
 * by this script. Config is now served at runtime by the Node server
 * via GET /api/config/public — no secrets are ever baked into a JS file.
 *
 * This script now only generates the server/.env file for the Node
 * backend if it doesn't already exist, as a convenience for local dev.
 *
 * LOCAL DEV:
 *   1. Copy .env.example → .env and fill in your values
 *   2. Copy server/.env.example → server/.env and fill in your values
 *   3. Run: node server/index.js
 *
 * CI / HOSTING (Cloudflare Pages):
 *   - Set all env vars in the Cloudflare Pages dashboard
 *   - The Node server reads them from process.env at startup
 *   - No build step needed for env-config.js
 */

const fs   = require('fs');
const path = require('path');

function loadDotEnv(envPath) {
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key   = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!(key in process.env)) process.env[key] = value;
    }
}

loadDotEnv(path.join(__dirname, '.env'));

/* ── Validate required keys ── */
const REQUIRED = [
    'FIREBASE_API_KEY',
    'FIREBASE_AUTH_DOMAIN',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_APP_ID',
];
const e       = process.env;
const missing = REQUIRED.filter(k => !e[k]);
if (missing.length) {
    console.error('[sync-env] ✖ Missing required env vars:', missing.join(', '));
    process.exit(1);
}

console.log('[sync-env] ✔ All required env vars present.');
console.log('[sync-env] ℹ  env-config.js is no longer generated — config is served by the Node backend at runtime.');
console.log('[sync-env] ℹ  Start the server: cd server && npm install && npm start');
