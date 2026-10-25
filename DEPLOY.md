# Deploying FieldCred

`app.fieldcred.co` is served by the Cloudflare Worker `fieldcred`
(account `eef14117e342317b606fda458b144e58`). The Worker script is
`worker/index.js`; the static app it serves is everything in `public/`
(the `ASSETS` binding). Data lives in Neon, one project per tenant.

The old cPanel/FTP docroot and its PHP endpoints are retired. The Worker
answers the same `*.php` paths itself (`tenant-lookup.php`,
`signup-notify.php`, `directory-search.php`, …), so the frontend did not
have to change. Those routes are listed under `assets.run_worker_first` in
`wrangler.json`; any new Worker route must be added there too, or the asset
server answers it with a 404.

This repository was synced to production on 2026-10-25 from version
`fd714f98-b4cc-449c-a613-bdf5d29a9f74` — `public/` matched the live site
byte for byte, and `worker/index.js` matched the deployed script's etag.

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
(currently `fieldcred-shell-v5`) when the precache list changes, and add new
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

- `billing-service/` deploys to Railway (`railway.json`).
- `supabase/` is the pre-October backend: migrations, provisioning scripts
  and Edge Functions. It is kept for reference; production data is in Neon.
