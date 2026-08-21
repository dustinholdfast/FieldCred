# Site gate QR: generate it, download it, print the sign — 2026-07-22

The site page has always shown the gate link as a text field labelled "post as
a QR at the gate", which left generating the actual QR to whoever was setting
the site up. Now the page produces it.

**Gate QR** in the site header, and a **QR** button beside the gate-link field
in Site settings, open the same dialog (`js/components/gateQrDialog.js`): the
code on screen, **Copy** for the link, **Download QR (PNG)** at 900px for
whoever prints things, and **Print gate sign** — a one-page letter sign with
the site name, a 3.3in code and the three steps a supervisor follows to point
a device at the site.

## The bug it found

`siteDetail.js` built that link as `${origin}${pathname}#/gate/${slug}` — with
no `?tenant=`. A device scanning it has never opened the app, so there is no
tenant subdomain, no `localStorage` override and no prior visit for
`resolveTenantSlug()` to fall back on; it resolved to `DEFAULT_TENANT` and
looked the site up in the wrong Supabase project. This is the same hole that
was fixed for badge QRs on 2026-07-14, and it survived on this link precisely
because nobody could conveniently scan it.

So the URL is no longer built by hand at the call site. `js/lib/publicLinks.js`
(new) owns both public URLs — `gateLinkUrl()` and `workerRecordUrl()` — as pure
functions with no imports, and `tests/publicLinks.test.mjs` round-trips them
back through `parseScannedCode()`, the code that actually has to read them off
a camera. `shareDialog.js` and `badgeCards.js` had a copy of the worker builder
each, with comments pointing at one another; both now call the shared one.

`js/lib/qrImage.js` (new) is the other half of that consolidation: rendering a
QR offscreen and pulling a PNG data URL out of it existed privately in
`badgeCards.js` and inline in `shareDialog.js`. One copy now, used by all
three surfaces.

## What the sign deliberately omits

The site's required credentials. They are live server state, they change
without anyone reprinting anything, and the requirement checkboxes on the site
page may be mid-edit and unsaved when the dialog opens. The sign's only job is
pairing; requirements are read at scan time, every time. An inactive site does
warn in the dialog — `get_public_site()` filters on `active = true`, so its
code resolves to nothing until it is reactivated.

---

# FieldCred Gate — the companion kiosk app — 2026-07-20

Built from the `design_handoff_gate_companion` bundle. A dedicated kiosk for a
shared tablet at a jobsite gate: a guard scans a badge and gets a full-screen
**CLEARED** / **NOT CLEARED** verdict; a supervisor unlocks the same device
for today's numbers, the scan log, and the site's requirements.

Route: `#/gate-app` (`js/pages/gateApp.js`). `#/scan` and `#/r/:slug` are
unchanged and still work.

## The bug this found first

`public_workers` — the only worker source an unauthenticated gate device can
read — rebuilt each certification object field by field and **silently dropped
`typeId`**. Site clearance (`js/lib/clearance.js`) matches certs to a site's
required types by exactly that field. So on every anon gate device:

- `evaluateClearance()` saw no `typeId` on any cert, every required type read
  as unmet, and `#/r/:slug` showed **"DO NOT ADMIT" for every worker** —
  fully compliant or not.
- `record_gate_scan()` reads `public.workers` directly as `SECURITY DEFINER`,
  so it *did* see `typeId` and wrote **`cleared`** for that same scan.

The screen and the audit log disagreed about the same event. The second half
is the serious one: an audit row that contradicts what the guard was shown is
worse than no audit log at all. Fixed in migration 011; the companion app
could not have produced a correct verdict without it.

## One decision, three surfaces

`js/lib/gateVerdict.js` (new) is now the single place that decides what a scan
means and the single place that logs it. `js/pages/gateApp.js` renders it as a
poster, `js/pages/publicRecord.js` renders it as a banner, and
`record_gate_scan()` re-derives it server-side as the audit row. Three
independent copies of "is this worker cleared" is precisely how a green screen
and a `blocked` log entry come to disagree.

It does **not** re-implement the decision — `clearance.js` is still the
authority. `deriveVerdict()` calls it, then does a separate display-only pass
to work out *which* cert to name ("expired MAY 12" rather than "not on file").
If those two ever diverge, clearance.js wins.

`deriveVerdict()` is pure — no DOM, no network, no clock of its own — so the
fail-closed cases are unit-tested (`tests/gateVerdict.test.mjs`, 12 tests):
expired, no-date, untagged, no-requirements, unknown worker, unknown site.
None of them can return `cleared`.

## Why a new page instead of extending `#/scan`

`#/scan` decodes a badge and then *navigates* to `#/r/:slug`. That costs a
full camera teardown and restart for every worker in a shift-change queue, and
it delivers the verdict inside a record page written for a different reader —
the worker themselves, or whoever they shared a link with.

The kiosk keeps the camera warm instead (`pause()`/`resume()` on the existing
scanner handle, never `stop()`/`start()`), and the verdict is the whole
screen: a two-word headline sized to be read at arm's length by someone
looking at the worker rather than at the tablet.

## Design fidelity

The prototype is styled in the "Modernist" system (Archivo, red `#ec3013`).
Per the handoff's own fidelity note, the layout, spacing, hierarchy, copy and
state logic are recreated as designed, and the palette and type are mapped
onto FieldCred's existing tokens: ink → `--brand` navy, accent → brand,
IBM Plex instead of Archivo (already loaded — no new font request on a tablet
with bad signal). Status colors needed no mapping; the design already used
this repo's `STATUS_META` values.

Two things from the design are kept deliberately against house style, both
scoped to `.gate-app` so they cannot leak:

- **Zero border radius** throughout, against the rounded `--radius-*` tokens
  everywhere else. Squareness plus 2px rules is what makes this read as
  instrumentation rather than as a web page, and it marks kiosk mode as a
  different place from the signed-in app.
- **Button labels flush left**, arrow pushed right, never centered. The label
  is read peripherally while the guard looks at the worker; a left edge is a
  fixed target, a centered one moves with the text.

The NOT CLEARED screen is a full-bleed poster in `--expired-text`. That keeps
the design's intent — the verdict is unmissable from a few feet away — using
a FieldCred status token rather than importing a second red into the brand.

## Auth: what actually gates what

Guard mode is unauthenticated on purpose; nobody signs in to a shared kiosk,
and it reads only anon-safe endpoints. Supervisor mode needs a real Supabase
session, because every screen behind it reads `gate_scans`, which RLS grants
to `authenticated` alone.

So the first exit from gate mode hands off to `#/login` and returns via
`?sup=1`; that signed-in supervisor then sets a 4-digit device PIN, and later
unlocks use the keypad from the design. **The PIN is a convenience lock, not a
security boundary** — a correct PIN with an expired session still bounces to
sign-in, and a forged PIN opens an empty shell. It is stored salted and
SHA-256 hashed, which is not because 10,000 candidates are hard to brute-force
but so a glance at localStorage during a support call doesn't hand the number
over. `js/lib/gateSession.js` says all of this at the top; read it before
changing anything there.

## Manual lookup — a deliberate widening of anon exposure

"LOOK UP BY NAME" is the fallback when a badge is damaged or left in the
truck. It needs a roster, and a gate kiosk has no session — so it needed a new
anon-reachable endpoint. Until now *no* anon caller could enumerate any roster
(see the SCOPE note in `js/lib/offlineCache.js` and migration 008's "there is
no list to enumerate").

`search_site_roster()` breaks that rule on purpose, as narrowly as it can:
one site by exact `public_slug`, only while active, only workers assigned to
it, only ones already visible in `public_workers`, returning
name/title/department/slug and nothing else, minimum 2 characters, capped at
25 rows, with LIKE metacharacters escaped so `%` can't match the roster.

Residual risk, stated plainly: anyone holding a site's gate slug — it is
printed on a QR at the gate — can probe for names on that site's roster. That
is a real trade for making a damaged badge recoverable. Tenants who don't want
it can `revoke execute ... from anon`; lookup then degrades to supervisors
only and everything else still works. Decided with Dustin, 2026-07-20.

## Two bugs found while verifying in the browser

- **Orphaned instances.** `main.js` calls `redispatch()` on *every* Supabase
  auth event — including the `INITIAL_SESSION` at startup and the token
  refresh that fires roughly hourly. Each re-entered `renderGateApp` on the
  same container while the previous instance was still fully wired: its
  window listeners, its delegated click handler, and its live `MediaStream`.
  On a tablet left in gate mode for a twelve-hour shift that is a dozen
  orphaned instances and a camera nothing can release. Now a module-level
  handle disposes the previous instance before starting a new one.
- **`SCAN NEXT` was white-on-white** on the NOT CLEARED poster. The base rule
  `.gate-app button { color: inherit }` is element+class (0,1,1) and so
  outweighed the single-class `.gate-btn-invert` (0,1,0) — the button
  inherited the poster's white. It also broke the solid button, the CHANGE
  link, the footer link and the active tab. Every button rule that sets a
  color is now `.gate-app`-prefixed, with a comment saying why.

## A third bug, found after 011 was applied

Probing the demo tenant with the anon key showed `search_site_roster` existing
but rejecting anon with `42501 permission denied for function` — and the gate
app reported that to guards as **"Couldn't search right now — no connection."**
A guard would retry that forever; it can never succeed.

The cause is older and wider than this feature. `throwIfError()` in
`js/lib/state.js` rethrew every Supabase failure as a bare
`new Error(error.message)`, **dropping `code`**. So `isPermissionError()`
(`js/lib/roles.js`) could never match `42501` on *any* store call, app-wide —
every permission denial arrived at call sites indistinguishable from a network
failure. `throwIfError` now preserves `code`/`details`/`hint`/`status`.

`isPermissionError()` also now recognizes `permission denied for …`, which is
what Postgres raises for a **missing GRANT** as opposed to a failing RLS
policy. That distinction matters here because revoking the roster search from
anon is a documented, supported opt-out — so it is a configuration the UI must
name honestly rather than blame on the network. Guard-mode lookup now says
"Look-up by name is turned off for gate devices here."

## Also

- `formatTime()` in `js/lib/format.js` — clock time alone. Everything on a
  gate screen happened in the last few hours; the date is noise.
- `store.searchSiteRoster()`, and `js/pages/publicRecord.js` refactored onto
  the shared verdict module (it no longer talks to `store` at all).
- Service worker precaches the new modules (`fieldcred-shell-v4`) so a
  rebooted tablet with no signal still boots into the kiosk.
- Web manifest gains a **Gate mode** launcher shortcut. The TWA's `startUrl`
  is deliberately *not* changed — see `android/README.md` for why and for the
  one-line change when you want it.
- `tests/gateVerdict.test.mjs` (12) and `tests/gateSession.test.mjs` (10).
  Suite is 107 passing.

## Requires

`supabase/migrations/011_gate_companion.sql`, applied per tenant. See
`supabase/MIGRATIONS_README.md` for the walkthrough and the verification
queries.

---

# Android companion app: in-app scanner + installable PWA/TWA — 2026-07-20

The gate flow's weakest link was the scan itself. "Scanning" meant the guard
leaving FieldCred, opening the phone's *native* camera app, tapping a
notification, and landing back in a browser tab — per worker, per badge, at
shift change. Everything downstream of the scan (clearance evaluation, the
offline cache, the audit log) was already solid; the first two seconds
weren't. This adds a real camera scanner inside the app, makes the app
installable, and packages it for the Play Store.

**Not a second codebase.** The Android app is a Trusted Web Activity — the
same web app, full-screen, no browser chrome. A website deploy updates the
Android app on next launch; the APK only changes when Android-level config
does. A React Native/Capacitor port would have meant a second implementation
of clearance evaluation and the offline scan queue, which is exactly the code
that must never disagree with itself.

## In-app scanner

- `js/lib/qrScanner.js` (new): camera + decode. Native `BarcodeDetector`
  where available — which includes Android Chrome, the platform the Play
  build targets — so the common path ships **zero extra bytes** and decodes
  in native code. jsQR is a fallback for iOS/Safari and older desktop Chrome,
  behind a dynamic `import()` that only runs after feature detection fails.
  Decoding is throttled to ~8/sec rather than per animation frame: a QR only
  needs catching within a fraction of a second, and at 60fps the fallback
  path's canvas readback would pin a gate tablet's CPU for no gain.
- `parseScannedCode()` is pure and separately tested. It **refuses a badge
  from a different tenant** instead of looking it up: tenants are physically
  separate Supabase projects, so a foreign slug could in principle collide
  with a real worker here and produce a confident verdict for the *wrong
  person*. Fail closed, consistent with FC-R-002 and `status.js`'s rule about
  never silently upgrading uncertainty into a clean result. A QR carrying no
  `?tenant=` at all is still accepted — it can't be attributed either way, and
  the lookup itself can't escape this tenant's database.
- `js/pages/scan.js` (new), route `#/scan`. Public, same rationale as
  `/r/:slug` and `/gate/:slug`: a gate device is a shared kiosk nobody signs
  in to, and this page displays nothing itself — it only routes to pages that
  enforce their own visibility rules.
- A successful scan **navigates to the existing `/r/:slug`** rather than
  rendering a verdict inline. That costs a camera restart per scan, and it's
  the deliberate trade: `/r/:slug` already owns clearance evaluation, the
  offline-cache fallback, the possibly-stale banner, and the gate-scan audit
  log including its offline queue. Duplicating any of that to save half a
  second is how a "cleared" verdict and the audit trail behind it drift apart.
  `?from=scan` gives the guard a "Scan another" button back to the camera.
- Haptic tick on a successful read (`navigator.vibrate`) — a gate is loud,
  often gloved, and the guard is looking at the worker, not the screen.
- The router has no per-route teardown hook, so `scan.js` releases the camera
  itself on `hashchange`/`pagehide`, and on `visibilitychange` when the app is
  backgrounded. Without that the stream and the camera indicator light survive
  navigating away.
- Unknown QR codes are ignored quietly and scanning continues — a camera
  pointed at a jobsite sees plenty of codes that aren't ours.
- `.htaccess`: `Permissions-Policy` relaxed from `camera=()` to
  `camera=(self)`, and `media-src 'self' blob:` added to the CSP. The old
  comment explicitly recorded that scanning happened in the native camera app;
  that's no longer true.
- Tests: `tests/qrScanner.test.mjs` (new, 17 cases — worker/gate/subdomain
  URLs, the cross-tenant refusal, percent-encoded slugs, and nine
  not-our-QR inputs including `javascript:` and `#/reset-password`, which must
  not be mistaken for an `#/r/` route). Full suite **85 tests, all green**.

## Installable / Play Store

- `manifest.webmanifest` (new) — there was **no manifest at all**, so nothing
  was installable and a TWA was impossible. Every URL in it is relative, so
  one file serves every tenant subdomain. `.htaccess` also needed
  `AddType application/manifest+json .webmanifest`: served as octet-stream
  (the default on many hosts) and combined with the existing `nosniff`,
  Chrome rejects it and silently drops installability.
- `assets/icon-{192,512}.png` + `icon-maskable-{192,512}.png` (new),
  generated from `icon.svg` on **white** — the mark is itself a navy hexagon,
  so a brand-navy field erases the shield and leaves a floating checkmark.
- `sw.js`: bumped to `v2`, and fixed a real bug — cache lookups are exact
  *including the query string*, so a device that cached `/?tenant=acme` while
  online missed the cache entirely when later opened offline as `/`, failing
  as though nothing had been cached. Now falls back to an `ignoreSearch`
  match, which is safe because the query is read client-side and never changes
  the bytes the server returns. Also added an install-time precache of the
  boot path (a rebooted gate tablet with zero signal previously couldn't load
  the app at all) using individual tolerant `cache.add` calls rather than
  atomic `addAll`, so one stale filename can't fail the whole install and
  leave the app with no service worker.
- `android/twa-manifest.json` + `android/README.md` (new): the full Bubblewrap
  configuration. Launches to `#/scan`, because the Android app exists for gate
  guards.
- `.well-known/assetlinks.json` + README (new). Fingerprints are placeholders:
  they depend on a signing keystore that only the Play listing's owner should
  ever hold.
- `.gitignore` (new — the repo had none): keystores, Bubblewrap's plaintext
  password cache, and generated Gradle output.

## Known constraint — multi-tenancy vs. the Play listing

A TWA verifies against **one origin**, and tenants live on subdomains. The
website side is fine (subdomains wildcard to one docroot, so they share
`assetlinks.json`), but the app side must either run gate devices on the
canonical `app.fieldcred.co/?tenant=<slug>` host — already supported by
`js/lib/tenant.js` and sticky in `localStorage` — or list every tenant
subdomain in `additionalTrustedOrigins` and ship a Play release per customer.
The canonical-host route is recommended; its catch is that gate/badge QR codes
embed `location.origin` at generation time
(`js/components/shareDialog.js`, `js/lib/badgeCards.js`), so they must be
generated from that host. See `android/README.md`.

## Not done

- The keystore and the Play Console submission — these are the listing
  owner's credentials to create and hold, not something to automate away.
- The actual `bubblewrap build`. `twa-manifest.json` is complete and its JSON
  validated, but no APK/AAB has been produced: the Android SDK install is
  interactive and didn't complete unattended (JDK 17 did — see
  `android/README.md` for exactly where setup stands), and signing needs the
  keystore above regardless.
- Live camera verification on real hardware. The decoder, the CSP, the
  permission-denied path and the parser are verified; actual camera frames
  need a physical device.
- Push notifications for expiring credentials. A TWA can do this, but it needs
  a real notification strategy first, not just the plumbing.

---

# One-click "audit pack" export per site — 2026-07-18

Handoff: `HANDOFF-02-AUDIT-PACK.md`. Product promise is "never fail a site
audit" — the underlying data was already captured (per-worker cert statuses,
structured NCCER/OSHA verification attestations, per-site required
credential types, the fail-closed gate scan log from migration 009) but it
lived across four screens. This turns it into one document an auditor or GC
can actually receive. **Deployed and confirmed working in a live test**
(2026-07-18).

A "Audit pack" button on the site detail page opens a date-range dialog
(default: last 30 days) and produces a printable report for that range:
cover (tenant name/logo, site, date range, generated-at timestamp, required
credential types), a per-worker roster section (status/expiry/card
number/verification stamp for each required type, plus an "other
credentials on file" subsection), the gate scan log for the range, and a
summary line (N workers, N fully cleared, N with gaps). "PDF" is the
browser's print-to-PDF, same as the existing badge-card printing — no PDF
library added.

- `js/lib/auditPack.js` (new): pure `buildAuditPackHtml(...)` — reuses
  `evaluateClearance` (clearance.js) for the cleared/missing/expiring
  determination rather than re-deriving it, and only adds the per-cert
  display details (expiry, card #, verification stamp) on top. Testable
  under plain Node, no `window`/`document` access.
- `js/components/auditPackDialog.js` (new): the date-range dialog, modeled
  on `confirmDialog.js`'s structure. Opens the print window synchronously
  inside its own "Generate" click handler (not after the async store calls
  that follow) so pop-up blockers don't eat it — same reasoning as
  `badgeCards.js`'s existing pop-up-blocker handling.
- `js/lib/state.js`: `siteScanLog(siteId, { from, to, limit })` — added an
  optional date-range filter (`gte`/`lte` on `scanned_at`) and raised the
  default caller-facing ceiling; the old `siteScanLog(siteId, limit)`
  call shape from `js/pages/siteScanLog.js` still works unchanged (default
  `{}`, same 200-row default).
- `js/lib/verification.js`: `verificationStampText(cert)` — plain-text form
  of the "Verified by X on Y" attestation, for the audit pack's bare print
  document where the app's styled badge (`certCard.js`'s
  `verifiedBadgeHtml`) doesn't apply.
- `js/pages/siteDetail.js`: the button + wiring. Deliberately re-fetches the
  *saved* required types and roster at generate-time rather than reusing
  the page's live, unsaved `reqSel`/`rosterSel` checkbox state — this
  report goes to an auditor, so it reflects what's actually persisted, not
  whatever's mid-edited in the admin's browser tab.
- Tests: `tests/auditPack.test.mjs` (new, 7 cases — summary counts,
  verification stamp only rendering when `verified` is true, missing
  required types, "other credentials on file," blocked scans listing their
  missing types, empty roster/scan-log). Full suite **68 tests, all green**;
  every changed/new JS file passes `node --check`.

## Out of scope (per the handoff)

- Scheduled/emailed audit packs (pairs later with the digest infrastructure
  in `supabase/functions/expiration-alerts`).
- Tenant-wide (all-sites) compliance report — ship the per-site version
  first.
- Any server-side PDF rendering.

---

# Real roles: admin / safety / gate — 2026-07-17

Closes the gap between the fieldcred.co marketing site ("admin, safety, and
gate roles") and the app, which until now had exactly one role — every
signed-in user was a full admin who could delete workers, change tenant
settings, and edit site requirements. This was called out as a needed
follow-up in the 2026-07-14 "Aesthetic & technical hardening" entry below.

**Roles live in Supabase auth `app_metadata` under `fc_role`** (not
user_metadata — app_metadata isn't user-editable, so a user can't promote
their own role). Three roles:

- **admin** — everything (today's behavior).
- **safety** — read all; create/edit workers + certs; view scan logs. Cannot
  delete workers, change tenant settings, or manage sites/credential
  types/users.
- **gate** — read-only directory + scan log (for a signed-in gate device).

**Deploy-safe by construction:** every existing production user has no
`fc_role`, and `current_fc_role()` coalesces a missing claim to `'admin'`, so
applying the migration changes nothing until a role is explicitly assigned.
No user record has to be touched on deploy day.

- `supabase/migrations/010_roles.sql` (new): the `current_fc_role()` helper
  (reads `auth.jwt() -> 'app_metadata' ->> 'fc_role'`, defaults `'admin'`;
  **not** named `current_role()` — that collides with the SQL reserved word)
  and role-keyed RLS replacing the blanket `authenticated` policies on
  `workers`, `settings`, `sites`, `site_required_types`, `site_assignments`,
  `credential_types`, and the Storage buckets. Read stays open to all three
  roles; writes narrow to admin (or admin+safety for worker/cert edits).
  `gate_scans` SELECT stays open to all three. Policy changes only — no new
  tables or columns. Idempotent (drops both old and new policy names before
  re-creating), so it's safe to re-run.
- `supabase/schema.sql`: same end-state folded into the new-tenant baseline,
  so fresh tenants get identical policies (verified name-for-name against the
  migration for re-runnability).
- `js/lib/roles.js` (new): pure role→capability map mirroring the RLS
  policies, plus `roleFromSession`, `normalizeRole`, `roleLabel`, and
  `isPermissionError` (recognizes a 42501/403 RLS denial). Enforcement is
  server-side; this module only decides which controls to *show*.
- `js/lib/auth.js`: `currentRole()` off the session JWT.
- `js/components/topNav.js`: nav links filtered by role (gate sees Directory
  only); a small role badge for non-admins so the reduced UI reads as
  intentional.
- `js/components/toast.js`: `showActionError()` — turns an RLS denial into a
  plain "Your role can't do this" toast instead of a raw Postgres error,
  used across the mutating pages.
- `js/main.js`: route guards bounce a role away from a page it can't use
  (gate → `/directory`) rather than landing it on an all-disabled screen.
- `js/pages/{directory,profile,editProfile,admin,sites,siteDetail}.js`:
  hide/disable the controls each role can't use (Add/Import, Edit, Delete,
  tenant-settings + credential-type cards, site create/manage).
- Docs: `supabase/PROVISIONING.md` (new "Roles" section + how to assign one),
  `supabase/MIGRATIONS_README.md` ("Applying 010" walkthrough + rollback),
  `README.md` "Auth model".
- Tests: `tests/roles.test.mjs` (new, 14 cases — normalize/session/capability
  matrix/permission-error). Full suite **61 tests, all green**; every changed
  JS file passes `node --check`. **Not yet deployed** — apply the migration
  (demo tenant first, verify, then live tenants) before shipping the frontend.

## Out of scope (deferred, per the handoff)

- Per-guard identity *display* in the scan-log UI — the named `gate` role
  makes a signed-in gate mode possible, but wiring identity into
  `record_gate_scan`/the log UI is a separate follow-up.
- Self-serve user invitations and any in-app role-assignment UI (dashboard/
  API only in v1).

---

# Follow-up: hint when a device isn't in gate mode — 2026-07-17

Root-caused a support case from Dustin: no clearance banner (red or green)
was showing for any worker. Not a bug in `evaluateClearance`/
`gateBannerHtml` — verified both directly, they're correct — the actual
cause was the test device never having opened the site's own GATE LINK
(`#/gate/:slug`, on that site's detail page), which is the one-time step
that points a device at a site. Scanning a worker's own share link/QR
directly (which is also the everyday, non-gate use of that page) never
carries that context, so no banner shows at all — expected, but easy to
mistake for broken clearance logic when it happens.

- `js/pages/publicRecord.js`: when no gate context is active, shows a small,
  low-emphasis line — "Not checking against a site — open a site's gate
  link on this device to enable clearance checks." Deliberately subtle (not
  a colored banner): most visits to this page are just someone viewing or
  sharing a worker's own record and have nothing to do with a gate, so this
  shouldn't read as an error state for them.
- **Deployed and confirmed working** (2026-07-17).
- `node --check` + full test suite (47 tests) pass.

---

# Offline / cached gate-scan mode — roadmap "Platform" phase — 2026-07-17

Addresses "jobsite gates have poor connectivity; a scan that fails on
no-signal breaks the core promise" (FC-R-002). **Deployed and confirmed
working in a real-device test** (2026-07-17).

**Scope, deliberately narrowed — confirmed with Dustin before writing any
code:** this is opportunistic caching, not a full offline roster. A
worker's record is cached on a device the first time it's successfully
fetched online; there is no proactive pre-fetch of a site's whole roster.
Rosters are never exposed to anonymous gate devices today (deliberate, see
migrations 007/008 — "no list to enumerate"), and adding a new anon-reachable
roster endpoint to enable pre-fetch would be a real change to that security
surface, not a small addition — held out of this change on purpose. Net
effect: a worker who's never passed through this specific gate while online
can't be checked with zero signal; a worker who has, can. That covers the
common case (a regular, returning crew) without opening any new exposure.

- `js/lib/offlineCache.js` (new): IndexedDB-backed cache for worker/site
  records (each stamped with `cachedAt`) plus a queue for gate scans
  attempted with no signal. `isStale(cachedAt)` (24h threshold) is the one
  pure piece, pulled out specifically so it's unit-testable without an
  IndexedDB polyfill — everything else touches the browser-only
  `indexedDB` global, but lazily (never at module load), so the file still
  imports cleanly under plain Node.
- `sw.js` (new) + registered in `js/main.js`: a narrow service worker that
  only caches same-origin GET requests (the app's own JS/CSS/HTML/assets),
  network-first falling back to cache. Solves a different problem than the
  cache above — the app failing to even *load* with zero signal — and
  deliberately never touches Supabase calls (cross-origin, and non-GET is
  skipped entirely).
- `js/pages/publicRecord.js`: on a live fetch, both the worker record and
  the gate site get written through to the cache. On a fetch failure
  (network/API error — NOT the same as "no such worker," which still fails
  closed same as before), falls back to the cached copy if one exists and
  shows an explicit "Offline — showing cached data from …" banner, calling
  out data over 24h old specifically. A gate scan that can't reach
  `record_gate_scan` gets queued locally instead of silently dropped.
- `js/lib/offlineSync.js` (new): drains that queue back into the real audit
  log via `store.recordGateScan()` — re-deriving clearance from the
  worker's *current* record, not the stale cached snapshot that was on
  screen when the scan happened. Called once at app startup and again on
  the browser's `online` event (both wired in `js/main.js`).
- Tests: `tests/offlineCache.test.mjs` (5 cases, `isStale()` only — the rest
  is IndexedDB glue, not independently testable under Node). 47 total,
  passing.

## ⚠️ Follow-ups

- If this ever needs the bigger version (verify a first-time worker with
  zero signal), that's the roster-pre-fetch path called out above — a
  separate, deliberate security-surface conversation, not a small follow-up.

---

# Follow-up: show the card # next to the Verify link — 2026-07-17

Caught by Dustin right after the structured-verification feature (below)
shipped: the "Verify" link on an NCCER/OSHA cert pointed to that source's
general portal homepage, but the card/cert number needed to actually look
anything up there was never displayed anywhere except the edit form — so the
link was present on both the staff profile and the public mobile record, but
not actually usable at the gate.

- `js/components/certCard.js`: both `certRowHtml` (staff profile) and
  `publicCertCardHtml` (public `/r/:slug` record) now show `Card # …` next
  to the Verify link whenever `cert.cardNumber` is set. Showing it on the
  public page is deliberate, not an oversight — a card number is meant to be
  shown (it's printed on the physical badge a worker already hands over at
  a gate), which is exactly the scenario this page exists for.
- No data/schema change — `cardNumber` was already being saved, just not
  rendered anywhere. `node --check` + full test suite (42 tests) still pass.
- Deployed.

---

# Structured cert verification (NCCER/OSHA) — roadmap "The moat" — 2026-07-17

Replaced the old free-text "Verification URL" field with a structured
attestation model. **This is not an API integration** — researched first,
before writing any code: neither NCCER nor OSHA offers a public API for a
third party like FieldCred to check a card programmatically. NCCER's Online
Verification is a login-gated lookup-by-card-number tool on their own site
([nccer.my.site.com](https://nccer.my.site.com/Support/s/article/Verifying-Credentials),
portal at `registry.nccer.org`); OSHA 10/30 verification is fragmented
across whichever Authorized Training Organization issued the card — there's
no single OSHA-run verification service (aggregators like
[oshacardportal.com](https://www.oshacardportal.com/portalapp/verify/) cover
many but not all providers). So instead of pretending to verify
automatically, FieldCred now points staff at the *real* portal and records
that a human actually checked it — closer to what a compliance buyer
actually wants from "verification" than a URL nobody's confirmed resolves
anywhere.

- `js/lib/verification.js` (new): `VERIFICATION_SOURCES` (NCCER, OSHA — each
  with a fixed, hardcoded canonical portal URL, confirmed by research, not
  assumed) and `verificationLink(cert)`, which resolves the outbound link —
  fixed portal for NCCER/OSHA, falling back to the legacy free-text
  `verificationUrl` for everything else (state boards, or any cert saved
  before this change — `verificationSource` is undefined on those records,
  so they fall straight into the same backward-compatible branch and keep
  working exactly as before).
- Each cert gains: `verificationSource` ('' / 'NCCER' / 'OSHA' / 'Other'),
  `cardNumber`, `verified` (boolean), `verifiedBy` (the signed-in admin's
  email, captured at the moment they check the box), `verifiedAt`. All jsonb
  on the existing `workers.certifications` column — **no SQL migration**,
  since certs were already schemaless there.
- `js/pages/editProfile.js`: the verification field is now a source picker +
  card/cert # + (for NCCER/OSHA) a fixed, non-editable portal link, or (for
  Other/legacy) the old free-text URL box — plus a "Verified" checkbox.
  Checking it stamps `verifiedBy`/`verifiedAt` from the live session.
  Changing the source or card # after verifying **clears the verified
  flag** — a verification is an attestation about one specific
  source+card-number pair, not a standing fact that survives editing either.
- `js/components/certCard.js`: both the authenticated worker-profile view
  and the public record now show a green "Verified" pill when
  `cert.verified` is true, and use `verificationLink()` for the outbound
  link/label instead of the raw URL. The public view omits `verifiedBy` (an
  admin's email) — same "don't leak staff contact info to a public QR page"
  rule the rest of that page already follows.
- **Found and fixed a real, previously-untested bug** in
  `js/lib/format.js#safeExternalUrl`: it resolved URLs against
  `location.origin`, a browser-only global. Outside a browser (e.g. Node,
  where `tests/verification.test.mjs` is the first thing to ever actually
  call this function) it threw on every invocation, was swallowed by the
  function's own `catch`, and silently returned `''` for every URL — safe
  ones included. Fixed by dropping the base argument entirely
  (`new URL(url)`, requiring a fully-qualified URL, which is what every real
  caller already provides). Added `tests/format.test.mjs` to cover it going
  forward.
- Tests: `tests/verification.test.mjs` (6 cases) + `tests/format.test.mjs`
  (7 cases) — 13 new, 42 total, all passing.

## ⚠️ Follow-ups

- **No migration to run** — this is a pure frontend/jsonb change.
- **Deployed and confirmed live** (2026-07-17).
- If NCCER ever does grant real API access, the honest place to plug it in
  is `verificationLink()`/a new `verifyAgainstSource()` — the UI (checkbox +
  verifiedBy/verifiedAt) barely changes, only how `verified` gets set
  (automatically instead of by hand) would.
- Card-number format isn't validated (free text) — low risk, since it's a
  human-in-the-loop check, not something a wrong format would silently trust.

---

# Gate scan audit log — roadmap point 4, "The moat" — 2026-07-17

Every gate scan is now logged server-side: timestamp, site, worker, result
(cleared / blocked / no requirements / unrecognized badge / unrecognized
gate), and — for a blocked scan — which credential types were missing. Both
a safety record and a sellable audit artifact, per the roadmap item.

- `supabase/migrations/009_gate_scan_log.sql` (new, apply once per existing
  tenant) + folded into `supabase/schema.sql` for new tenants: a `gate_scans`
  table and a `record_gate_scan(site_slug, worker_slug)` SECURITY DEFINER
  function, same anon-reachable pattern as `get_public_site` (migration 008).
  The function **computes clearance itself**, server-side, fail-closed —
  mirrors `js/lib/clearance.js` — rather than trusting a client-supplied
  result, since this RPC is a public endpoint by design and a client-trusted
  result could be spoofed into fabricating "cleared" rows. Site/worker names
  are denormalized onto the row so the log stays readable after a rename or
  delete. RLS grants `authenticated` SELECT only; there is no INSERT policy
  for anyone — the SECURITY DEFINER function is the only write path.
- `js/lib/state.js`: `recordGateScan()` (calls the RPC) and `siteScanLog()`
  (authenticated read, newest first).
- `js/pages/publicRecord.js`: fires `recordGateScan()` on every `/r/:slug`
  view where a gate site is active, fire-and-forget — a logging failure must
  never block the clearance banner the person at the gate needs to see.
- `js/pages/siteScanLog.js` (new) + route `#/site/:id/log`: an admin-facing,
  per-site log table (time, worker, result, missing types), linked from the
  "Scan log" button on the site detail page.
- `js/lib/format.js`: added `formatDateTime()` for the log's timestamp column.

## ⚠️ Deploy + follow-ups

- **Apply the SQL migration before deploying the frontend.** Run
  `supabase/migrations/009_gate_scan_log.sql` in the SQL Editor for every
  existing tenant project. The frontend calls `record_gate_scan` and reads
  `gate_scans` unconditionally — deploying JS first would 404 the RPC on
  every gate scan (though `recordGateScan()` fails silently by design, so
  this degrades to "no logging," not a broken gate) until the migration runs.
- New tenants provisioned from `supabase/schema.sql` after this change get
  the table/function automatically — no separate migration needed for them.
- **Deployed and confirmed live** (2026-07-17), migration applied and a real
  gate scan verified end-to-end.
- Roadmap's "who scanned" is necessarily device/worker-level, not a named
  person — the gate flow (`/r/:slug`, `/gate/:slug`) has no login by design
  (that's the point of a QR-scannable public record). If per-guard identity
  is ever wanted, that's a bigger auth change, not a follow-up to this one.

---

# Retire the 'default' tenant; 'demo' becomes the fallback — 2026-07-17

Retired the original `default` tenant (Supabase project `qiozckjlojvhdtrsjzfp`),
a leftover scaffold superseded by `demo` (`kaktjqbbijyjejulbpgy`), which is where
points 1 and 2 were actually deployed and tested.

- `tenants.php`: removed the `default` entry and its `holdfastcyber.us` domain
  mapping. The registry now holds only `demo` (plus the commented `acme` template).
- `js/lib/tenant.js`: `DEFAULT_TENANT` changed `'default'` → `'demo'`, so a bare
  visit (no `?tenant=`, no domain match) resolves to the demo project instead of
  the retired one. Also updated `BASE_HOST` to `app.fieldcred.co` (subdomain
  routing was still anchored to the old `fieldcred.holdfastcyber.us`).

## ⚠️ Deploy + follow-ups

- FTP **both** `tenants.php` and `js/lib/tenant.js` — the registry entry and the
  fallback constant are a coupled pair; deploying only one breaks the bare URL.
- After deploy, the `qiozckjlojvhdtrsjzfp` Supabase project can be deleted or
  archived — nothing routes to it anymore.
- Edge case: a device with `default` cached in `localStorage` (`fieldcred:tenant`)
  from an old `?tenant=default` link will hit "not configured" until it visits
  `?tenant=demo` once or clears the key. `default` was only ever the silent
  fallback, so this should affect no one in practice.

---

# Reconcile expiration-alerts with production — 2026-07-16

Discovered the deployed `expiration-alerts` Edge Function is materially ahead
of what was in this repo: production runs hourly and gates sending on each
tenant's own timezone / cadence (daily|weekly) / day-of-week / hour, with a
`?force=true` test bypass and date-based dedup via
`settings.last_digest_sent_at`. The repo held only the original fixed
13:00-UTC daily digest.

Pulled the live function source back into `supabase/functions/expiration-alerts/index.ts`
so source control matches reality again. No functional change to production —
this is the repo catching up to the deployed code.

Also updated `CRON.sql` to match the live job (`fieldcred-expiration-alerts`,
hourly `0 * * * *`) — verified against the live `cron.job` table. The repo's
old daily-13:00-UTC `CRON.sql` was stale; production has been hourly all along
(which is what the hourly-gating function requires).

Brought `supabase/schema.sql` `settings` in line with the live table
(verified via `information_schema.columns`): added `logo_url`, `timezone`
(default `'UTC'`), `digest_cadence` (`'daily'`), `digest_day_of_week` (`1`),
`digest_hour` (`13`), and `last_digest_sent_at`, both in the `create table`
and as idempotent `add column if not exists` statements for older projects.
Rewrote `SETUP.md` for the hourly-cron + per-tenant-schedule + `?force=true`
reality.

Repo and production are back in sync for the expiration-alerts feature.

---

# Aesthetic & technical hardening — 2026-07-14

A pass over the app's look and technical posture. Several earlier suggestions
were already live in production (honest public-record status pills, real
link-expiry, private certificate bucket with signed URLs, password reset) and
were left as-is.

## ⚠️ Read before deploying

This working copy was reconciled with production for **front-end files only**
(JS / CSS / HTML / assets), which are downloadable and were verified byte-for-byte.
The **server-side files could not be** — PHP executes rather than serving its
source, and the `supabase/` SQL migrations referenced by the app
(`002`, `005`, `006`) are not present in this copy. Therefore:

- **Deploy only the front-end changes** (everything under `js/`, `css/`,
  `assets/`, plus `index.html` and `.htaccess`). The list of changed files is in
  `git log`/`git diff` on the reconciliation commits.
- **Do not** overwrite the live `*.php` files or re-run `supabase/schema.sql`
  from this copy — they are older than production. `tenants.php` /
  `signup-config.php` in particular hold live credentials and tenant config.
- `.htaccess` is new; confirm it doesn't conflict with an existing one on the host.

## What changed

### Aesthetics
- **Logo weight cut ~88%** — the 1 MB / 1254px `logo.png` is downscaled to
  `logo-360.png` (~118 KB); `logo.js` points at it. Biggest win on the public
  record page (opened at a gate, on cellular).
- **Real favicons + touch icon** — `assets/icon.svg` (shield), plus generated
  32/16 PNGs and a 180px `apple-touch-icon.png`. Added to `index.html` with
  `theme-color` and Open Graph / Twitter tags so shared links preview properly.
- **Initials avatars** replace the diagonal-stripe placeholders (which read as
  an unfinished wireframe) across worker cards, profile, admin table, public
  record, and the top-nav user chip (`js/components/avatar.js`). Deterministic
  tint per name. Remaining placeholders softened from stripes to a calm fill.
- **Loading skeletons** on the directory instead of a bare "Loading…" line, and
  a distinct first-run empty state ("No workers yet" + Add worker CTA).
- **Accessibility** — the worker-card share control and the share-dialog close
  control are now real `<button>`s; both modals trap Tab focus and restore it on
  close (`js/lib/focusTrap.js`); worker cards activate on Space as well as Enter.

### Technical
- **Supabase self-hosted & version-pinned** — was imported live from
  `https://esm.sh/@supabase/supabase-js@2` (a floating tag, 16 chained
  cross-origin requests). Now vendored to `js/vendor/supabase-js.js` at
  `@2.110.5`. Removes a runtime CDN dependency and single point of failure.
- **Security headers** — a `<meta>` CSP in `index.html` (`script-src 'self'`,
  no `unsafe-eval`) plus `.htaccess` for the header-only directives (HSTS,
  `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`) and a cache policy that avoids stale-module breakage on
  this unhashed deploy.
- **`javascript:` URL hole closed** — verification links are now scheme-checked
  (`safeExternalUrl`) at render and rejected at save; they render on the public
  page, so a `javascript:`/`data:` value was a stored-XSS vector.
- **Blank expiry no longer counts as "valid"** — a cert with no expiry date is
  now classified `missing` (its own neutral pill/tile and a directory filter),
  instead of silently inflating the compliance count.
- **Perf** — `modulepreload` hints warm the critical module graph; the badge-card
  print window no longer needs an inline script (drives print from the opener),
  keeping it CSP-clean.
- **Error capture** — global `error` / `unhandledrejection` handlers
  (`js/lib/errorReporting.js`), ready for a reporting endpoint / Sentry DSN.
- **Tests** — `npm test` (Node's built-in runner) covers the status logic and
  CSV parser — 13 tests. No dependencies, no build.
- **Optional rate limiter** — `rate-limit.php`, a drop-in per-IP cap for the
  public PHP endpoints (see the file header to enable).

## Follow-ups that need operator action (not code)

- **Roles / RBAC** — the marketing site advertises "admin, safety, and gate
  roles," but the app is still a single shared admin (any signed-in user can
  delete any worker and change tenant settings). Real separation belongs in
  Supabase (auth metadata + RLS policies), which must be done against the live
  schema — a client-only gate wouldn't be security. This is the item a
  compliance buyer asks about first; treat it as roadmap or soften the copy.
- **Error reporting endpoint** — set `REPORT_ENDPOINT` in
  `js/lib/errorReporting.js` (a Sentry ingest URL or a small collector) to start
  capturing tenant-side failures.
- **Uptime + backups** — add an uptime check on `app.fieldcred.co`, and enable
  Supabase Point-in-Time Recovery (or schedule per-tenant exports); free-tier
  defaults don't cover this.
- **Enable the rate limiter** — wire `rate-limit.php` into the current
  `signup-notify.php` per its header.
