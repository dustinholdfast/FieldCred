# FieldCred

Worker credential platform — directory, profiles, admin compliance dashboard, and a
public QR-shareable mobile record. Built from the Claude Design handoff
(`design_handoff_fieldcred/`).

Ships as a website and, from the same code, as an installable app — including
an Android build on the Play Store. See [Android app](#android-app).

## Stack & why

No build step: vanilla JS (ES modules) + hash-based client routing, no framework.
The handoff suggested React + TypeScript as a reasonable default *if* tooling is
available, but this environment has no Node/npm installed, so a build-dependent
stack couldn't actually be run or verified here. This app is structured the way a
React app would be (small pure render functions per page/component, a thin data
layer) so porting to React later is mostly a mechanical translation of
`js/pages/*.js` and `js/components/*.js` into components, with `js/lib/state.js`
becoming a data-fetching hook.

Backend: [Neon](https://neon.com) Postgres, Neon Auth, and the Neon Data API.
The browser talks to those public HTTPS endpoints through a vendored
`@neondatabase/neon-js` build (`js/vendor/neon-js.js`). It never receives a
database password. Files live in Postgres (`public.files`) and are streamed
by `file.php`.

**Multi-tenant**: each tenant gets its own Neon project (own database, own
users) — not a shared database filtered by a tenant column. The frontend
resolves which tenant it's serving, looks up that tenant's public Auth URL
and Data API URL from a small server-side registry, and only then connects.
See `neon/README.md` for the checklist, and `js/lib/tenant.js` /
`js/lib/backendClient.js` for how resolution + connection works.

## Backend setup (single tenant / local dev)

Follow `neon/README.md`. Short version: create a Neon project, enable Auth
and the Data API, apply `neon/schema.sql`, create an admin and a
`staff_roles` row, then put the two public URLs in `tenants.php` (or
`js/lib/config.js` for a PHP-less fallback). Env var names are listed in
that doc. Do not commit the values.

## Running it

The tenant registry (`tenant-lookup.php`) needs a **PHP-capable** static
host — that's what `js/lib/backendClient.js` fetches from to find each
tenant's Neon Auth and Data API URLs. Locally:

```
php -S 127.0.0.1:8844 -t .
```

(`npx serve .` or similar won't execute `tenant-lookup.php` — the app will
still boot in that case, just always falling back to the single project in
`js/lib/config.js`, which is fine for quick single-tenant testing.)

Then open `http://localhost:8844/`. Routing is hash-based (`#/directory`,
`#/worker/:id`, …) so it needs no server rewrite rules.

## Structure

- `tenants.php` — the tenant registry: maps a tenant slug to its Neon Auth
  URL and Data API URL. Add one entry per tenant (see `neon/README.md`).
  Never fetched directly by the browser — only read server-side via `require`.
- `tenant-lookup.php` — the only thing the frontend actually calls
  (`?tenant=slug`); looks up one entry in `tenants.php` and returns just
  that tenant's `{ name, authUrl, dataApiUrl }`, never the whole registry.
- `js/lib/tenant.js` — resolves which tenant the current page load is for:
  `?tenant=` query param → subdomain → `localStorage` override → `'default'`.
- `js/lib/config.js` — fallback Auth URL and Data API URL, used only if
  `tenant-lookup.php` is unreachable (e.g. local dev without PHP running).
  Both are public. Row-level security is what limits them.
- `js/lib/backendClient.js` — `initBackend()` resolves the tenant, fetches
  its URLs from the registry (or falls back to `config.js`), and creates
  the Neon client; `main.js` awaits this before starting the router.
  Exports live bindings (`db`, `isConfigured`, `tenantSlug`) that other
  modules read lazily, after init has run.
- `js/lib/auth.js` — sign in/out, session, auth state changes.
- `js/lib/state.js` — async data access (`getAll`, `getById`, `getBySlug`,
  `createWorker`, `updateWorker`, `deleteWorker`, `setPublicView`,
  `uploadImage`) backed by the Neon Data API. Certifications and skills are stored as
  `jsonb` on the `workers` row rather than a separate table — matches the
  app's existing data shape and avoids a join for what's a small embedded
  list per worker.
- `js/lib/status.js` — certification status is always *derived* from
  `expiryDate` vs. today, never stored.
- `js/lib/router.js` — minimal hash router; `redispatch()` re-evaluates the
  current route on auth state changes (e.g. sign-out redirects away from a
  protected page without a hash change).
- `js/components/` — shared UI: top nav (shows the signed-in user + sign
  out), worker card, cert card/row, status pill, the share/QR modal, toast,
  confirm dialog.
- `manifest.webmanifest` — makes the app installable (add-to-home-screen, and
  the Play Store build). Every URL inside it is relative, so this single file
  serves every tenant subdomain correctly.
- `js/lib/qrScanner.js` — camera + QR decode for the gate scanner. Native
  `BarcodeDetector` where available (all Android Chrome), with
  `js/vendor/jsqr.mjs` lazily imported only as a fallback.
- `js/pages/` — one module per route: `login`, `directory`, `profile` (2A
  sidebar layout — 2B banner layout from the handoff was not built per
  project decision), `admin`, `editProfile` (handles both create and edit),
  `publicRecord` (the standalone page a scanned QR opens), `scan` (the in-app
  camera scanner), `gateApp` (the FieldCred Gate kiosk — see below).
- `js/lib/gateVerdict.js` — **the** decision point for "is this worker
  cleared for this site", plus the audit-log write and its offline queue.
  `js/pages/gateApp.js` and `js/pages/publicRecord.js` both render verdicts
  from here rather than each deriving their own; a green screen and a
  `blocked` audit row that disagree about the same scan is the exact failure
  this centralization exists to prevent. The decision itself still comes from
  `js/lib/clearance.js` — this module calls it, never re-implements it.
- `js/lib/gateSession.js` — per-device gate state: which site the tablet is
  paired to, guard vs. supervisor mode, and the supervisor re-entry PIN. Read
  the header comment before touching the PIN: it is a convenience lock, not a
  security boundary, and the real gate is the Neon Auth session behind it.
- `neon/schema.sql` — per-tenant backend setup: tables, RLS policies, and
  file storage in Postgres. Run once per tenant database after Auth and the
  Data API are enabled.
- `neon/README.md` — how to point a tenant at Neon and how to confirm
  reads and writes.
- `supabase/` — historical schema and the old provisioner. New tenants do
  not use it.

## Auth model

The entire staff-facing app (directory, profiles, admin, edit) requires a
signed-in Neon Auth session — those pages show phone/email and compliance
data that the public share page deliberately hides, so leaving them open
would undercut that. Only the gate-device routes skip the auth check — a gate
is a shared kiosk that nobody signs in to:

- `#/login`
- `#/r/:slug` — the public record a QR code/share link opens. It reads from
  the `public_workers` Postgres view, not the `workers` table directly, so
  phone/email are enforced hidden server-side (by the view's column list),
  not just hidden in the UI.
- `#/gate/:slug` — points a device at a site (remembered in `localStorage`).
- `#/scan` — the in-app camera scanner. Shows no data of its own; it only
  routes to the two routes above, which enforce their own visibility rules.
- `#/gate-app` — the FieldCred Gate kiosk (see below). Its **guard** half is
  public and reads only anon-safe endpoints; its **supervisor** half needs a
  real session and is gated by RLS, not by the route.

## FieldCred Gate (`#/gate-app`)

The kiosk that runs on a shared tablet at a jobsite gate. A guard scans a
badge and gets a full-screen **CLEARED** / **NOT CLEARED** verdict; a
supervisor unlocks the same device for today's numbers, the scan log, and the
site's requirements.

How it differs from `#/scan`: that page decodes a badge and then *navigates*
to `#/r/:slug`, which restarts the camera for every worker and buries the
verdict in a record page written for a different reader. The gate app keeps
the camera warm (`pause()`/`resume()`, not `stop()`/`start()`) and renders a
verdict sized to be read at arm's length by someone looking at the worker
rather than the tablet. `#/scan` and `#/r/:slug` are unchanged and still
work; all three share `js/lib/gateVerdict.js`.

**Modes.** Guard mode is unauthenticated on purpose — nobody signs in to a
shared kiosk. Leaving gate mode requires a real Neon Auth sign-in (it hands
off to `#/login` and returns via `?sup=1`); that signed-in supervisor then
sets a 4-digit device PIN so later unlocks are fast. The PIN is convenience
only: every supervisor screen reads `gate_scans`, which RLS grants to
`authenticated` alone, so a forged PIN opens an empty shell.

**Pairing** uses the existing `fieldcred_gate_site` localStorage key and the
existing `#/gate/:slug` QR — a device paired before this app shipped stays
paired. Scanning a site QR *inside* the app re-pairs it.

**Offline** behaves like the rest of the gate flow: verdicts fall back to
`js/lib/offlineCache.js`, say so on screen with the cache timestamp, and
queue their audit rows for `js/lib/offlineSync.js` to drain. Nothing cached
and no signal fails closed — it never renders a verdict it can't stand behind.

Requires the gate functions in `neon/schema.sql`.

There's no self-serve sign-up flow — create the user in Neon Auth, then
insert a row in `public.staff_roles`. Each user has one of three roles,
enforced server-side by RLS. `js/lib/roles.js` only hides controls.

- **admin** — everything.
- **safety** — read everything; create/edit workers and certs; view scan
  logs. Cannot delete workers, change tenant settings, or manage
  sites/credential types.
- **gate** — read-only directory + scan log (for a signed-in gate device).

A user with no `staff_roles` row is `unassigned` in the database and cannot
read staff tables. The UI still treats a missing client claim as admin; the
database does not. After sign-in the client stamps `current_fc_role()` onto
the session so the two agree. See `neon/README.md`.

## Android app

The Play Store build is a **Trusted Web Activity** — an Android shell running
this same site full-screen with no browser UI. There is no second codebase:
deploying the website updates the Android app on its next launch, and the APK
only changes when Android-level config (icon, name, launch URL) does.

It launches to `#/scan`, because the reason to have an Android app here is the
gate guard: open the app, camera is live, scan, verdict, scan the next person.

Full build and release instructions — including the two different signing
fingerprints, which are the usual reason TWA verification fails — are in
[`android/README.md`](android/README.md) and
[`.well-known/README.md`](.well-known/README.md). One constraint worth knowing
before rollout: a TWA verifies against a single origin, so tenant *subdomains*
need either the canonical `?tenant=` host or a Play release per customer; see
`android/README.md`.

Nothing in this repo needs to be rebuilt to serve the app — `android/` is
build tooling and must **not** be deployed to the web host.

## Notes

- QR codes are real, generated client-side from each worker's public record
  URL (`js/vendor/qrcode.min.js`), not the decorative placeholder from the
  prototype.
- Photos, certification badge images, and certificate PDFs upload into
  `public.files` when you hit Save on the edit form; the preview shown while
  editing is a local `FileReader` data URL until then. Photos, badges, and
  logos are read through `file.php`. Certificates use a short-lived grant
  token. The badge image is a small thumbnail; the certificate PDF is the
  document "Download" links to.
- Share links now resolve from any device (not just the browser that created
  them), since data lives in Postgres instead of browser storage — the thing
  that made `localStorage`-only persistence insufficient for real sharing.
