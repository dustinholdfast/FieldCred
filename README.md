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

Backend: [Supabase](https://supabase.com) — Postgres + Storage + Auth, called
directly from the browser via `@supabase/supabase-js` (loaded from a CDN, no
build step needed either).

**Multi-tenant**: each tenant gets its own, fully separate Supabase project
(own database, own Storage, own users) — not a shared database filtered by a
tenant column. The frontend resolves which tenant it's serving, looks up
that tenant's project credentials from a small server-side registry, and
only then connects. See `supabase/PROVISIONING.md` for the full checklist to
add a tenant, and `js/lib/tenant.js` / `js/lib/supabaseClient.js` for how
resolution + connection works.

## Backend setup (single tenant / local dev)

The steps below get one tenant ("default") working — enough for local
development or a single-customer deployment. For additional tenants, see
`supabase/PROVISIONING.md` instead.

1. Create a free project at [supabase.com](https://supabase.com).
2. In **Authentication → Providers → Email**, turn off "Confirm email" (or set
   up email delivery) so sign-in works without a confirmation step.
3. In **Authentication → Users**, add yourself as a user — this app has no
   sign-up flow, admins are provisioned directly in the Supabase dashboard.
4. In **SQL Editor**, run `supabase/schema.sql` — creates the `workers` table,
   the `public_workers` view, RLS policies, and the `photos`/`badges`/
   `certificates` Storage buckets and their policies. Optionally also run
   `supabase/seed_demo.sql` to get 8 demo workers.
5. In **Project Settings → API**, copy the **Project URL** and **anon public**
   key into **both**:
   - `js/lib/config.js` (the fallback used if the tenant registry below is
     unreachable), and
   - `tenants.php`, under the `'default'` key (the registry entry actually
     used in normal operation).
6. Reload the app and sign in.

## Running it

The tenant registry (`tenant-lookup.php`) needs a **PHP-capable** static
host — that's what `js/lib/supabaseClient.js` fetches from to find each
tenant's Supabase project. Locally:

```
php -S 127.0.0.1:8844 -t .
```

(`npx serve .` or similar won't execute `tenant-lookup.php` — the app will
still boot in that case, just always falling back to the single project in
`js/lib/config.js`, which is fine for quick single-tenant testing.)

Then open `http://localhost:8844/`. Routing is hash-based (`#/directory`,
`#/worker/:id`, …) so it needs no server rewrite rules.

## Structure

- `tenants.php` — the tenant registry: maps a tenant slug to its Supabase
  project URL + anon key. Add one entry per tenant (see
  `supabase/PROVISIONING.md`). Never fetched directly by the browser —
  only read server-side via `require`.
- `tenant-lookup.php` — the only thing the frontend actually calls
  (`?tenant=slug`); looks up one entry in `tenants.php` and returns just
  that tenant's `{ url, anonKey }`, never the whole registry.
- `js/lib/tenant.js` — resolves which tenant the current page load is for:
  `?tenant=` query param → subdomain → `localStorage` override → `'default'`.
- `js/lib/config.js` — fallback Supabase Project URL + anon key, used only
  if `tenant-lookup.php` is unreachable (e.g. local dev without PHP
  running). The anon key is safe to ship client-side either way — it only
  grants what the RLS policies in `supabase/schema.sql` allow.
- `js/lib/supabaseClient.js` — `initSupabase()` resolves the tenant, fetches
  its credentials from the registry (or falls back to `config.js`), and
  creates the Supabase client; `main.js` awaits this before starting the
  router. Exports live bindings (`supabase`, `isConfigured`, `tenantSlug`)
  that other modules read lazily, after init has run.
- `js/lib/auth.js` — sign in/out, session, auth state changes.
- `js/lib/state.js` — async data access (`getAll`, `getById`, `getBySlug`,
  `createWorker`, `updateWorker`, `deleteWorker`, `setPublicView`,
  `uploadImage`) backed by Supabase. Certifications and skills are stored as
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
  security boundary, and the real gate is the Supabase session behind it.
- `supabase/schema.sql` — per-tenant backend setup: tables, RLS policies,
  storage buckets + policies. Run once per tenant project. Safe to re-run.
- `supabase/seed_demo.sql` — optional demo data (8 sample workers); run
  separately, only for local dev or a demo tenant — not real tenants.
- `supabase/PROVISIONING.md` — step-by-step checklist for adding a new
  tenant (new Supabase project, schema, admin user, registry entry).
- `supabase/MIGRATIONS_README.md` — how per-tenant SQL migrations work, a
  log of what's shipped, and the walkthrough for applying/verifying the
  current one.

## Auth model

The entire staff-facing app (directory, profiles, admin, edit) requires a
signed-in Supabase session — those pages show phone/email and compliance
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
shared kiosk. Leaving gate mode requires a real Supabase sign-in (it hands
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

Requires `supabase/migrations/011_gate_companion.sql`.

There's no self-serve sign-up flow — users are provisioned by adding them
directly in the Supabase dashboard. Each user has one of three roles, stored
in Supabase auth `app_metadata` under `fc_role` and enforced server-side by
RLS (`supabase/migrations/010_roles.sql`; the frontend mirror is
`js/lib/roles.js`, which only hides controls — the database is the real
boundary):

- **admin** — everything (the default: a user with no `fc_role` is treated as
  admin, so existing single-admin setups are unchanged).
- **safety** — read everything; create/edit workers and certs; view scan
  logs. Cannot delete workers, change tenant settings, or manage
  sites/credential types/users.
- **gate** — read-only directory + scan log (for a signed-in gate device).

Roles are assigned from the Supabase dashboard (Auth → user → app_metadata:
`{"fc_role":"safety"}`), not from the app — see `supabase/PROVISIONING.md`.
A role change reaches the client only after the user's JWT refreshes (~1h) or
they re-login.

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
- Photos, certification badge images, and certificate PDFs upload to
  Supabase Storage (`photos` / `badges` / `certificates` buckets, all
  public-read) when you hit Save on the edit form; the preview shown while
  editing is a local `FileReader` data URL until then. The badge image is
  just a small thumbnail; the certificate PDF is the actual document and is
  what "Download" on the profile page and public record links to.
- Share links now resolve from any device (not just the browser that created
  them), since data lives in Postgres instead of browser storage — the thing
  that made `localStorage`-only persistence insufficient for real sharing.
