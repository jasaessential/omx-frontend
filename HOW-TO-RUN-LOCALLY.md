# How to Run JASA V2 Locally

Since the move to Cloudflare (2026-11-21, see `cf/README.md`) the backend is two
Workers plus a D1 database. On `localhost` the site automatically talks to the
local Workers below (see `env-config.js` and `cf-firestore.js`).

Use the jasaessential3 wrangler login in every terminal (Git Bash):

```
export XDG_CONFIG_HOME="D:/SwiftMind/.wrangler-jasa"
```

## 1. API worker (omx-api): data API + the old Node server routes, port 8799

```
cd D:/SwiftMind/JASA-V2/JASA-V2/cf
npx wrangler d1 execute omx-db --local --file schema.sql    # first time only
npx wrangler dev --port 8799 --test-scheduled
```

Secrets for local runs go in `cf/.dev.vars` (gitignored; same names as `server/.env`).
Local data: `cd cf-migrate && node import-d1.mjs` loads `cf-migrate/export/*.jsonl`.

## 2. Edge worker (jasa-backend-worker): items/banners/config cache, port 8798

```
cd D:/SwiftMind/JASA-V2/JASA-V2
npx wrangler dev --port 8798 --persist-to cf/.wrangler/state
```

`--persist-to` makes it use the same local D1 as the API worker.

## 3. The site, port 5500

```
cd D:/SwiftMind/JASA-V2/JASA-V2
python -m http.server 5500 --bind 127.0.0.1
```

Open http://localhost:5500/index.html.

## Checks

- `curl http://127.0.0.1:8799/health` → `{"status":"ok",...,"db":"d1"}`
- `cd cf-migrate && npm i` once, then `node test-store.mjs` (store) and `node test-api.mjs` (needs both workers running).
- `D:/Studio/claude-seo/.venv/Scripts/python.exe cf-migrate/smoke-pages.py` loads the pages headless and lists console errors.
- Cron (settle job): `curl "http://127.0.0.1:8799/__scheduled?cron=*/15+*+*+*+*"`
