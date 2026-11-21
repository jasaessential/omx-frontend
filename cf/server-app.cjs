/* OMX — the Render Express app (server/index.js) without app.listen() and the
   15-minute timer; the Worker's cron runs settleAll instead. Routes and
   business code are the unchanged files in ../server. */
'use strict';

const express = require('../server/node_modules/express');
const cors    = require('../server/node_modules/cors');

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);
const isDev = process.env.NODE_ENV !== 'production';

app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (isDev && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods:        ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-server-secret'],
    credentials:    true,
}));

/* Body parsing without express.json()/raw(): body-parser pulls in iconv-lite,
   whose bundled form crashes on Workers. Same results: the webhook gets the raw
   Buffer (signature check), other JSON requests get the parsed object. */
const MAX_JSON = 2 * 1024 * 1024;
app.use((req, res, next) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().includes('application/json') || req.method === 'GET' || req.method === 'HEAD') return next();
    const chunks = [];
    let size = 0;
    req.on('data', c => {
        size += c.length;
        if (size > MAX_JSON) { res.status(413).json({ error: 'Request too large' }); req.destroy(); return; }
        chunks.push(Buffer.from(c));
    });
    req.on('error', next);
    req.on('end', () => {
        if (res.headersSent) return;
        const buf = Buffer.concat(chunks);
        if (req.originalUrl.startsWith('/api/payment/webhook')) { req.body = buf; return next(); }
        if (!buf.length) { req.body = {}; return next(); }
        try { req.body = JSON.parse(buf.toString('utf8')); }
        catch (_) { return res.status(400).json({ error: 'Invalid JSON body' }); }
        next();
    });
});

app.use('/api/payment',   require('../server/routes/payment'));
app.use('/api/config',    require('../server/routes/config'));
app.use('/api/upload',    require('../server/routes/upload'));
app.use('/api/coupon',    require('../server/routes/coupon'));
app.use('/api/wallet',    require('../server/routes/wallet'));
app.use('/api/referral',  require('../server/routes/referral'));
app.use('/api/orders',    require('../server/routes/orders'));
app.use('/api/files',     require('../server/routes/files').router);
app.use('/api/marketing', require('../server/routes/marketing'));

app.get('/health', (_req, res) => res.json({
    status: 'ok', ts: Date.now(), runtime: 'cloudflare-workers', db: 'd1',
    files: require('../server/routes/files').filesConfigured(),
}));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
    const origin = req.headers.origin || '';
    if (allowedOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    console.error('[Server Error]', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
