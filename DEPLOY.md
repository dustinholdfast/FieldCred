# Deploying FieldCred

`app.fieldcred.co` is served by the Cloudflare Worker `fieldcred`
(account `eef14117e342317b606fda458b144e58`). The Worker source is the ES
modules in `worker/` (entry `worker/index.js`), which Wrangler bundles at
deploy time; `worker/directorySearch.js` also imports the frontend's
`public/js/lib/directoryFilter.js`, so the browser and the Worker share one
filter validator. The static app it serves is everything in `public/` (the
`ASSETS` binding). Data lives in Neon, one project per tenant; provisioning,
schema and the expiration digest are in `neon/` (see `neon/README.md`).

| Worker module | Handles |
| --- | --- |
| `endpoints.js` | routing, tenant lookups, signup email, private-file refusals |
| `files.js` | `file.php` image/PDF proxy through the Data API |
| `directorySearch.js` | `directory-search.php` (Gemini → allowlisted filter) |
| `monitoring.js` | `/api/client-error`, `/api/health`, `/api/health/email` |
| `scanAlert.js` | `/api/scan-alert` — emails the site when a gate turns someone away |
| `dataApi.js` | anonymous Data API token + RPC calls (shared by files and scan alerts) |
| `http.js` | shared response helpers and security headers |
| `rate-limit.js`, `tenants.js` | per-IP limits; the tenant registry |

The old cPanel/FTP docroot and its PHP endpoints are retired. The Worker
answers the same `*.php` paths itself (`tenant-lookup.php`,
`signup-notify.php`, `directory-search.php`, …), so the frontend did not
have to change. Those routes are listed under `assets.run_worker_first` in
`wrangler.json`; any new Worker route must be added there too, or the asset
server answers it with a 404.

This repository was synced to production on 2026-10-25 from version
`fd714f98-b4cc-449c-a613-bdf5d29a9f74` — `public/` matched the live site
byte for byte, and the deployed script matched the bundle built from the
`worker/` sources (recovered from the `cursor/demo-tenant-fieldcred-domain-c103`
branch, which rebuilds it byte for byte).

To add a tenant, provision it with `neon/provision-tenant.mjs`, then add its
`slug`, `name`, `authUrl`, `dataApiUrl` and `domains` to `worker/tenants.js`
(this replaces the retired `tenants.php`) and deploy.

---

## Deploy

```sh
npm test
npx wrangler deploy --dry-run   # bundles and lists bindings, uploads nothing
npx wrangler deploy
```

`wrangler deploy` uploads the Worker and `public/` together, so the
partial-upload failures the FTP process used to have cannot happen.

`keep_vars` is on, so dashboard-set vars survive a deploy. Secrets are not
in this repo and never should be — this repo is public. Set them with
`npx wrangler secret put <NAME>`:

| Name | Kind | Used for |
| --- | --- | --- |
| `RESEND_API_KEY` | secret | signup / capacity-request emails |
| `GEMINI_API_KEY` | secret | AI directory search |
| `GEMINI_MODEL` | secret | AI directory search model id |
| `MONITOR_TOKEN` | secret | unlocks `POST /api/health/email`; same value as the GitHub secret below |
| `ALERT_HOOK_SECRET` | secret | lets the Worker claim blocked scans for alert emails; its SHA-256 is stored in each tenant database |
| `NOTIFY_EMAIL` | var (`wrangler.json`) | where signup requests go |
| `RESEND_FROM` | var (`wrangler.json`) | sender address |

### Headers

Security and cache headers for static files come from `public/_headers`
(the replacement for `.htaccess`). The Worker sets the same security
headers on its own responses. The Content-Security-Policy is a `<meta>`
tag in `public/index.html`.

`Permissions-Policy` must keep `camera=(self)`. An empty `camera=()`
disables the gate scanner on every device, and no browser setting can
override it.

---

## Database migrations

Tenant databases are changed by hand, one tenant at a time, with the files in
`neon/migrations/` (Neon SQL Editor, or `psql` with that tenant's direct
`DATABASE_URL`). Each file is idempotent. `neon/schema.sql` already includes
every migration, for new tenants only: do **not** re-run it on an existing
database, it stops at the first policy that already exists.

Apply a release's migration **before** deploying the code that needs it. The
code tolerates a missing migration (it logs and skips the feature), but the
feature does nothing until the migration is in.

### 001 — blocked-scan alerts

1. Generate one random secret (32+ characters), e.g.
   `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
2. In each tenant database, apply `neon/migrations/001_blocked_scan_alerts.sql`,
   then store the secret's hash:
   ```sql
   insert into public.alert_hook_secret (id, secret_hash)
   values (1, digest('<the secret>', 'sha256'))
   on conflict (id) do update set secret_hash = excluded.secret_hash;
   ```
3. `npx wrangler secret put ALERT_HOOK_SECRET` with the same secret.
4. Set where alerts go: the account notification address (Admin settings) and,
   optionally, a per-site address on each site's settings card.
5. Deploy. `/api/health` reports `blockedScanAlerts` and fails until step 3
   is done, so the monitor flags a half-finished rollout.

To test the database side against a scratch Postgres (never a tenant), apply
`neon/schema.sql` with an `auth.user_id()` stub and run
`neon/migrations/001_blocked_scan_alerts.test.sql`.

---

## CI and monitoring

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and push to
  `main`: unit tests, a parse check of the Worker and monitor scripts, and
  `wrangler deploy --dry-run`. It needs no Cloudflare credentials.
- **Monitor** (`.github/workflows/monitor.yml`) runs `scripts/monitor.sh`
  against production every 30 minutes: app shell, camera header, tenant
  lookup, auth on directory search, signup validation, and `/api/health`.
  Once a day it also asks the Worker to send one message to Resend's test
  inbox (`delivered@resend.dev`), which proves the API key and sending domain
  still work without emailing anyone. A failed run makes GitHub email the repo
  owner; that email is the alert. Run it by hand from the Actions tab
  ("Monitor" → Run workflow) or locally with `bash scripts/monitor.sh`.

  The daily email check needs the same random value in two places:

  ```sh
  npx wrangler secret put MONITOR_TOKEN          # Worker
  gh secret set MONITOR_TOKEN                    # GitHub Actions
  ```

  Without it the check is skipped with a warning; everything else still runs.
  GitHub only runs schedules from `main`, and pauses them after 60 days with
  no repository activity.

- **Worker logs**: `observability` is enabled in `wrangler.json`, so
  `console.error` output is kept in Workers Logs (dashboard → Workers →
  fieldcred → Logs). Failures use fixed prefixes worth searching or alerting
  on: `[signup-notify]`, `[health]`, `[health-email]`, `[client-error]`,
  `[directory-search]`.
- **Client errors**: `public/js/lib/errorReporting.js` posts uncaught errors
  and unhandled rejections to `POST /api/client-error`. The Worker logs one
  line each, with the page path and hash, never the query string. Rate
  limited to 30 per minute per IP.
- **`GET /api/health`** reports which pieces are configured (assets, tenant
  registry, signup email, directory search) as booleans, never values. It
  returns 503 if any are missing.

---

## Rollback

```sh
npx wrangler deployments list --name fieldcred
npx wrangler rollback <version-id>
```

Known-good versions: `fd714f98-b4cc-449c-a613-bdf5d29a9f74` (synced here)
and `857c9972-9342-41c7-8fcd-85772e80cbd8` (the version before it).

---

## Verify after every deploy

```sh
# Nothing 404s that shouldn't
for f in index.html manifest.webmanifest sw.js .well-known/assetlinks.json \
         js/main.js js/pages/gateApp.js help-center/index.html guides/index.html; do
  printf '%s  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://app.fieldcred.co/$f")" "$f"
done

# Camera allowed: must read camera=(self)
curl -sI https://app.fieldcred.co/ | grep -i permissions-policy

# Worker routes alive: no tenant -> 400, demo -> JSON
curl -s 'https://app.fieldcred.co/tenant-lookup.php?tenant=demo'

# Every public file matches what's live; silence means it does
cd public && find . -type f ! -name _headers | sed 's#^\./##' | while read -r f; do
  curl -s -o /tmp/p "https://app.fieldcred.co/$f"; cmp -s "$f" /tmp/p || echo "DIFF $f"
done
```

---

## Service worker

`public/sw.js` is network-first with a cache fallback. Bump `CACHE_NAME`
(currently `fieldcred-shell-v7`) when the precache list changes, and add new
boot-path modules to `PRECACHE_URLS` by hand — there is no build step to
regenerate it.

---

## Android

The Play app is a Trusted Web Activity around this site, so a deploy
updates it on next launch. `bubblewrap update` fetches the manifest and
icons from the live host, so deploy before building an APK. See
`android/README.md`.

---

## Not part of this deploy

- `billing-service/` would deploy to Railway (`railway.json`), but is not
  currently deployed; the app's capacity button falls back to email.
- `neon/` scripts run from a shell with the env vars in `neon/README.md`.
- `supabase/` is the pre-October backend: migrations, provisioning scripts
  and Edge Functions. It is kept for reference; production data is in Neon.
