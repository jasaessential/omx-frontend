# Firebase → Cloudflare backend move (2026-11-21)

## What changed

| Before | After |
|---|---|
| Firestore (Spark plan, 50k reads/day, kept running out) | **Cloudflare D1** `omx-db` (APAC) |
| Render Express server `server-bc02.onrender.com` | **Worker `omx-api`** (`cf/api.js`), runs the same `server/` routes unchanged |
| Pages read/write Firestore with the web SDK | Pages import **`/cf-firestore.js`**, same function names, talks to `omx-api/db/*` |
| `firestore.rules` | **`cf/rules.js`**, a line-by-line port, enforced by the Worker |
| Edge worker `jasa-backend-worker` read Firestore REST | reads D1 (same binding), its 15-min cron removed |
| Settle job: Render timer + edge cron (both every 15 min) | `omx-api` cron only |

**Not moved, on purpose:** Firebase **Auth** (sign-in; free and unlimited for email/Google, and moving it would force every user to reset their password) and **FCM** push (free; Cloudflare has no push service). Customer files stay on Supabase and product images on R2, as before.

## Pieces

- `cf/store.js`: D1 document store. One row per Firestore doc (`docs`), JSON data, `ver` for optimistic concurrency, `coll_versions` for cheap change polling. Timestamps are stored as `"__ts:<ISO>"`.
- `cf/rules.js`: the access rules. `cf/dbapi.js`: `/db/get|query|count|commit|listen`.
- `cf/shims/firebase-admin.js`: the parts of firebase-admin the server uses, on D1 (transactions, batches, FieldValue, verifyIdToken, FCM v1). `razorpay.cjs`, `iconv-lite.cjs`, `dotenv.js`: small Workers stand-ins. Aliased in `cf/wrangler.toml`.
- `cf/server-app.cjs`: `server/index.js` without `listen()`/timers and without body-parser (it crashes on Workers).
- `cf-firestore.js` (site root): browser stand-in for the Firestore SDK. `onSnapshot` polls every 15 s (paused in hidden tabs, immediate after own writes); only changed collections send data.
- `cf-migrate/`: `export-firestore.cjs`, `import-d1.mjs` (`--wipe`, `--merge`), tests (`test-store.mjs`, `test-api.mjs`, `test-r2-list.mjs`, `smoke-pages.py`).

## Tests run (local, 2026-11-21)

- `test-store.mjs`: 29/29 (filters, ordering, cursors, transforms, rollback, version conflicts, concurrent increments, index use).
- `test-api.mjs`: 23/23 with real Firebase ID tokens (profile rules, quote → order rules, foreign reads blocked, cancel rules, listeners, transactions, server referral transaction, CORS, edge admin check).
- Settle cron runs; R2 listing through the AWS SDK works on Workers.
- `smoke-pages.py`: 14 public/customer pages load with no JS errors, and nothing loads the real Firestore SDK.
- **Not yet tested:** pages with real data and signed-in staff/admin pages (needs the export), Razorpay payments end to end, push sends.

## Cutover runbook

Do it at a quiet hour. Steps 4 to 7 should take about 15 minutes.

1. **Firestore quota** must have reset (13:30 IST). `node cf-migrate/export-firestore.cjs --count` (cheap) to size it; a full export costs one read per doc.
2. **Secrets for omx-api**: already copied from Render into `cf/.secrets.json` (gitignored). They upload with step 3; delete the file after the deploy.
   `cd cf && npx wrangler secret put <NAME>` for RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, SERVER_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL, FIREBASE_SERVICE_ACCOUNT (whole JSON), plus the public FIREBASE_API_KEY / FIREBASE_AUTH_DOMAIN / FIREBASE_STORAGE_BUCKET / FIREBASE_MESSAGING_SENDER_ID / FIREBASE_APP_ID / FIREBASE_MEASUREMENT_ID / CLOUDINARY_* / WORKER_URL that `/api/config/public` returns.
   Always use `export XDG_CONFIG_HOME="D:/SwiftMind/.wrangler-jasa"` (jasaessential3 login).
3. DONE 2026-11-21 10:55 IST (secrets uploaded, file deleted; later deploys: plain `npx wrangler deploy`). Was: `cd cf && npx wrangler deploy --secrets-file .secrets.json` (omx-api, new URL `https://omx-api.jasaessential3.workers.dev`). Check `/health`. The site doesn't use it yet.
4. `node cf-migrate/export-firestore.cjs`, then `cd cf-migrate && node import-d1.mjs --remote` (**no --wipe**: omx-api has been live since 2026-11-21 10:55 IST, so keep anything already written to D1).
5. `npx wrangler deploy` in the repo root (edge worker now reads D1; its cron is removed).
6. Deploy the site (Pages direct upload from a clean `git archive`, see memory `ordermyxerox-deploy`). In the clean copy, also delete `cf/` and `cf-migrate/`. Keep `cf-firestore.js`: the pages need it.
7. Catch-up: delete `cf-migrate/export/*.done`, run the export again, then `node import-d1.mjs --remote --merge` (adds docs written to Firestore during steps 4 to 6; D1 edits win).
8. **Razorpay dashboard → Webhooks:** change the URL from `https://server-bc02.onrender.com/api/payment/webhook` to `https://omx-api.jasaessential3.workers.dev/api/payment/webhook` (same secret).
9. Watch: place a COD test order, an online test payment, open admin orders and confirm new orders show up within 15 s. `npx wrangler tail omx-api`.
10. After a week without problems: suspend the Render service; delete `cf-migrate/export/` (customer data); set Firestore rules to deny all writes so nothing writes there by mistake.

## Rollback

The Firestore data stays as it was. Re-deploy the previous site build plus the previous `workers.js`/`wrangler.toml` (git), and point the Razorpay webhook back to Render. Orders placed on D1 in the meantime would need copying back by hand, so decide within the first hours.

## Limits to know

- Live updates are polling (15 s), not instant. Staff see new orders within about 15 s.
- A query returns only the docs the caller may read. Firestore would reject the whole query instead.
- D1 row max is 2 MB (Firestore doc max 1 MB, so this is fine).
- The old Flutter app (E:\Clients\JayaRam\Ordermyxerox) still talks to Firestore directly. The Play app is the TWA (`omx-twa`), so this matters only if someone still has the old Flutter build installed.

## Order notifications (added 2026-11-21)

Before this, no page ever saved a push token (the marketing page read `fcmTokens` that nobody wrote), and `firebase-messaging-sw.js` was registered on the same scope as `sw.js`, so the two replaced each other.

- `omx-push.js` (loaded by `auth-header.js` and `order-details.js`): after sign-in, a "Turn on" card (staff: "a ping for every new order"; customers: "track your orders live"). With permission, the FCM token goes to `users/{uid}.fcmTokens`. Pushes that arrive while the app is open still show as a notification, with a chime for new orders. "Later" hides the card for 3 days.
- `firebase-messaging-sw.js` now runs on its own scope `/firebase-cloud-messaging-push-scope` and shows the data-only order pushes. New-order pushes stay on screen until tapped.
- `cf/notify.js` + `cf/fcm.js`: on every write to `orders/*`, from the browser or the server:
  - **Staff** (all admins + the shop's owners/employees): a new COD order, or an online order once payment succeeds. Tapping opens the right details page for that role.
  - **Customer:** each status change (confirmed / printing or packing / ready / out for delivery / delivered / cancelled / rejected) and "payment received". Never for unpaid checkouts the settle job sweeps.
  - Dead tokens are removed when FCM rejects them.
- **Play app (TWA):** nothing to rebuild. `omx-twa` already has notification delegation and `POST_NOTIFICATIONS`, so the site's pushes show as app notifications.
- Tested: `test-notify-plan.mjs` 9/9; `test-api.mjs` 25/25 (FCM call with the service account, dead-token removal for staff and customer); the card shows for a signed-in user (`smoke-push-card.py`). **Not tested:** delivery to a real phone. Headless Chromium has no push service, so this needs a real device after deploy.

## The Play app is the Flutter app (found 2026-11-21)

Production "Order My Xerox" on Play = **Flutter** `com.ordermyxerox.ordermyxerox` (E:\Clients\JayaRam\Ordermyxerox\Ordermyxerox, 53 monthly users). `com.omx.twa` is only in closed testing.

- Flutter now uses `lib/core/db/omx_firestore.dart`: a Dart stand-in for `cloud_firestore` on the same `/db` API (38 imports switched, plugin removed). `serverUrl` → omx-api. Version **1.0.6+7**. `flutter analyze`: 0 errors; the debug APK builds. Backup of the old code: `D:\SwiftMind\_backups\ordermyxerox-flutter-before-cloudflare-2026-11-21`.
- Notifications in the app: order pushes carry an `android.notification` block (channel "orders", high importance, created in MainActivity and set as the FCM default in the manifest). A tap opens the order (customer, admin, seller or employee screen, via `openSiteLink`).
- **Bridge for the old app version** (`cf/bridge.js`, `BRIDGE_FIRESTORE=1`, cron every 5 min): copies new orders (+ order_status), paid orders, new users, payments, support queries and product requests from Firestore into D1 (merge rule; D1 edits win), and staff get the push. Keep the **Render server running** until users have updated: the old app's quotes, coupons and payments go there. Not covered: status changes that staff make *inside the old app* (staff should use the website or the new app).
- Rollout: upload the 1.0.6+7 AAB to **internal testing** first, test on a phone against the live Worker, then promote to production (this replaces the 1.0.5 release in review).
