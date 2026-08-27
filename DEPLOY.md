# Deploying FieldCred

The app is plain static files plus a few PHP endpoints — no build step, no CI.
Deploying means copying the docroot subset to the PHP-capable host serving
`app.fieldcred.co`.

Because there is no build and no pipeline, **the upload itself is the release
process**, and a partial upload is the failure mode that actually happens. This
file exists because it happened on 2026-07-20: subdirectories went up, every
root-level and hidden file did not, and the result was a site that looked fine
and had a dead camera.

---

## What to upload

Upload the whole docroot subset. Do **not** cherry-pick changed files.

The app ships **unhashed filenames** with `Cache-Control: no-cache` (see
`.htaccess`), so modules resolve by literal path at runtime. Uploading
`js/main.js` without `js/pages/gateApp.js` gives you a site that imports a 404
and dies at boot. Re-uploading unchanged files costs nothing and removes that
entire class of failure.

### Include

```
.htaccess
.well-known/
assets/
css/
guides/
help-center/
js/
index.html
knowledge-base.html
manifest.webmanifest
sitemap.xml
sw.js
rate-limit.php
signup-config.php
signup-notify.php
tenant-lookup.php
tenant-lookup-by-domain.php
tenants.php
```

### Exclude — never put these in the docroot

```
android/           Bubblewrap config + build output. Unrelated to what the
                   browser serves; also the keystore's neighbourhood.
supabase/          Migrations, provisioning scripts, node_modules.
billing-service/   Separate service with its own deploy and its own secrets.
Marketing/         Content drafts.
tests/             Node test files.
.claude/           Local tooling config.
node_modules/
*.md at the repo root (README, CHANGES, DEPLOY)
```

`supabase/` and `billing-service/` matter most here: both contain files that
must never be publicly readable.

---

## The two things that get missed

Both are invisible in most FTP/SFTP clients and file managers by default.

### 1. Hidden files and directories

- **`.htaccess`** — carries CSP, HSTS, `X-Frame-Options`, and
  `Permissions-Policy`. Most clients hide dotfiles unless you turn on "show
  hidden files".
- **`.well-known/`** — a hidden *directory*, so it is missed even by clients
  that show hidden files but do not recurse into hidden folders. Contains
  `assetlinks.json`, without which the Android TWA renders with a URL bar.

**`.htaccess` is the one that bites hardest.** A stale copy silently disables
the camera:

| `.htaccess` version | header sent | effect |
| --- | --- | --- |
| current | `camera=(self)` | scanner works |
| pre-2026-07 | `camera=()` | **getUserMedia refused on every page** |

An empty allowlist disables the feature for all origins including your own, and
it overrides whatever permission the user grants in Chrome. The app reports it
as "Camera access is off", which sends the guard into device settings to fix
something that is not fixable there.

### 2. Root-level files

Clients set to sync directories will happily upload `js/`, `css/`, `assets/`
and `help-center/` / `guides/` while leaving every file at the docroot root untouched —
`index.html`, `manifest.webmanifest`, `sw.js`, `knowledge-base.html`, the PHP
endpoints. A stale `index.html` is especially quiet: the app boots and works,
but its `<link rel="manifest">`, CSP meta tag and modulepreloads are whatever
they were at the last full upload.

---

## Verify after every deploy

Run this from the repo root. It compares what is live against what you have,
and catches both failure modes above.

```sh
# 1. Nothing 404s that shouldn't
for f in index.html manifest.webmanifest sw.js knowledge-base.html \
         .well-known/assetlinks.json js/main.js js/pages/gateApp.js \
         js/lib/gateVerdict.js js/lib/qrScanner.js help-center/index.html \
         guides/index.html sitemap.xml; do
  printf '%s  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://app.fieldcred.co/$f")" "$f"
done

# 2. The camera is actually permitted — must read camera=(self), NOT camera=()
curl -sI https://app.fieldcred.co/ | grep -i permissions-policy

# 3. Root files are current, not stale
curl -s https://app.fieldcred.co/ -o /tmp/prod-index && cmp index.html /tmp/prod-index \
  && echo "index.html current" || echo "index.html STALE"

# 4. The service worker cache name advanced (else clients keep the old shell)
curl -s https://app.fieldcred.co/sw.js | grep CACHE_NAME
```

`.php` files cannot be verified this way — the server executes them, so you
only ever see output, never source. Check those against git, not against HTTP.
A quick liveness check: `curl -s 'https://app.fieldcred.co/tenant-lookup.php?tenant=demo'`
should return that tenant's JSON (no arguments correctly returns 400).

### Full diff against production

To compare every deployable static file at once:

```sh
git ls-files | grep -vE "^(android|Marketing|billing-service|supabase|tests|\.claude)/" \
  | grep -vE "^(\.gitignore|\.gitattributes|package\.json|.*\.md)$" \
  | while read -r f; do
      case "$f" in *.php|.htaccess) continue;; esac
      code=$(curl -s -o /tmp/p -w '%{http_code}' "https://app.fieldcred.co/$f")
      if [ "$code" = 404 ]; then echo "MISSING  $f"
      elif ! cmp -s "$f" /tmp/p; then echo "STALE    $f"; fi
    done
```

Silence means production matches the working tree.

---

## Service worker

`sw.js` is network-first with a cache fallback, so a deploy is picked up on the
next load rather than being stuck behind a stale bundle. Two things still need
care:

- **Bump `CACHE_NAME`** when the precache list changes, or clients keep serving
  the old shell offline. It is `fieldcred-shell-v4` as of the gate app.
- **Add new boot-path modules to `PRECACHE_URLS`.** That list is hand-written —
  there is no build step to regenerate it — so it rots silently. It only needs
  the boot path; everything else is picked up by runtime caching.

---

## Migrations

Schema changes are **not** part of the file deploy. They are applied per tenant
by hand in each project's SQL Editor — see `supabase/MIGRATIONS_README.md`.

Deploy order matters when a release depends on one. The gate app needs
migration 011: shipped without it, every gate device shows "DO NOT ADMIT" for
every worker, because `public_workers` would still be withholding `typeId`.
Apply the migration first, then deploy the files.

---

## Android

The Play app is a Trusted Web Activity — a shell around this same website — so
**a website deploy updates the Android app on its next launch**. No APK is
involved unless Android-level config changes.

The dependency runs the other way, though: `bubblewrap update` fetches
`manifest.webmanifest` and the icons from the live host at build time, so the
site must be deployed *before* an APK can be built at all. See
`android/README.md` and `android/PRE-RELEASE-CHECKLIST.md`.
