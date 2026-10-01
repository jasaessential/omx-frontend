# How to Run JASA V2 Locally

You need **two things running at the same time**:
1. The Node.js backend server (port 3001)
2. A frontend file server (Live Server / any static server)

---

## Step 1 — Start the Node Backend

Open a **PowerShell terminal** and run:

```
cd C:\Users\ELCOT\Desktop\USER\JASA-V2\server
npm run dev
```

You should see:
```
JASA Payment Server running on port 3001
Mode: development (all localhost origins allowed)
```

Keep this terminal open. Do not close it.

---

## Step 2 — Open the Frontend

Open **VS Code**, go to the `JASA-V2` folder, right-click `index.html` and click **"Open with Live Server"**.

The site will open at `http://127.0.0.1:8080` (or similar).

> If you don't have Live Server, install it from VS Code Extensions (`Ctrl+Shift+X` → search "Live Server" by Ritwick Dey → Install).

---

## Step 3 — Verify It's Working

Open browser DevTools (`F12`) → Console tab.

You should see **no red errors**. The page loads normally with Firebase data.

To double-check the backend is running, open a new PowerShell and run:
```
Invoke-WebRequest http://127.0.0.1:3001/health -UseBasicParsing
```
Expected response: `{"status":"ok","ts":...}`

---

## Every Time You Come Back

Just repeat Steps 1 and 2:

| Terminal | Command |
|---|---|
| PowerShell 1 | `cd C:\Users\ELCOT\Desktop\USER\JASA-V2\server` then `npm run dev` |
| VS Code | Right-click `index.html` → Open with Live Server |

---

## Troubleshooting

| Error | Fix |
|---|---|
| `ERR_CONNECTION_REFUSED` on port 3001 | Backend is not running — go to Step 1 |
| `EADDRINUSE` port 3001 already in use | Run `taskkill /F /IM node.exe` then `npm run dev` again |
| CORS error in console | Make sure `env-config.js` has `SERVER_URL = 'http://127.0.0.1:3001'` |
| `npm` not recognized | Close PowerShell and reopen it — Node.js PATH needs a fresh session |

---

## When Going to Production (Cloudflare)

1. Deploy the `server/` folder to Railway / Render / Cloudflare Workers
2. Change `SERVER_URL` in `env-config.js` to your deployed server URL
3. Push to Git → Cloudflare Pages auto-deploys the frontend
