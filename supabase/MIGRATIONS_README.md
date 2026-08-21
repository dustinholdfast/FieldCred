# Migrations guide

How schema changes get applied across tenants, a log of what's shipped, and a
step-by-step walkthrough for the current one (`010_roles.sql`). This
is the doc the risk register (FC-R-006, "Bus factor of one") flagged as
missing — written now, alongside the migration that prompted it.

## How this works

- Each tenant is a **fully separate Supabase project** (see
  `PROVISIONING.md`) — there's no shared database, so a migration has to be
  run once per tenant project, by hand, in that project's **SQL Editor**.
  Nothing here is automated.
- Files in `supabase/migrations/` are numbered in the order they were
  written and applied to the first (demo) tenant. Every one is written to be
  **idempotent** (`create table if not exists`, `create or replace
  function`, `drop policy if exists` before `create policy`, etc.) so
  re-running a migration that's already applied is a safe no-op, not an
  error.
- `supabase/schema.sql` is the **new-tenant baseline** — every migration
  that's shipped gets folded into it, so provisioning a brand-new tenant
  (step 2 of `PROVISIONING.md`) only ever means running one file, never
  replaying the whole migration history. If you add a migration, fold it
  into `schema.sql` in the same change.
- By convention, `schema.sql` itself is migration **`001`** — there's no
  separate `001_*.sql` file, and there never was. The numbered files here
  start at `002`.
- There is no automated tracking of which tenant has which migration
  applied. Keep a note (even just a dated line in this file, or your own
  spreadsheet) of what's been run where — with more than a couple of
  tenants this stops being trackable from memory, which is exactly the risk
  this doc exists to reduce.

## Reconciled 2026-07-18 (Step Zero)

Previously this section documented a gap: migrations `002`–`006` existed
only in a second, unversioned working copy
(`C:\Users\dusti\OneDrive\Desktop\QR App\fieldcred\supabase\`), never
committed here, and `schema.sql` was believed "kept in sync column-by-column"
without those files actually being folded in. That was checked, not assumed
— verified live against the `demo` tenant (every migration `002`–`010`
confirmed genuinely applied via direct object lookups, not just inferred
from a checklist) — and closed:

- Migrations `002`–`006` are now committed here, ported from that second copy.
- `schema.sql` is rebuilt from a known-good baseline (the old copy's version,
  which already had `002`–`006` correctly folded, including the
  `schema_migrations` table `004` added) plus `007`–`010` folded in on top.
  It had been missing both `schema_migrations` and the `010` role system —
  a real gap, not just a documentation one; a tenant provisioned from the
  old `schema.sql` would have come up with no role enforcement.
- `demo`'s own `schema_migrations` table has been backfilled with rows for
  `007`–`010` (applied by hand at the time, never recorded) — it now
  accurately reflects live state, which is what `fleet-migrate.mjs` trusts.
- One live fix folded in along the way: `010`'s storage write policy had
  dropped the `logos` bucket from the admin/safety upload/update/delete
  grant (apparent oversight — `005`'s own comment says logo upload should
  mirror the photos/badges pattern exactly). The new `schema.sql` includes
  it; run the matching policy fix against any tenant provisioned before this
  reconciliation.

## Migration log

| # | File | What it does | Depends on |
|---|------|---------------|------------|
| 001 | `../schema.sql` | Baseline: `workers`, `settings`/`public_settings`, `public_workers` view, RLS, Storage buckets, `plan_limits` + cap trigger. By convention only — not a separate file. |  |
| 002 | `002_public_record_freshness_and_link_expiry.sql` | `safe_to_date()`, `public_workers` exposes `updated_at` + enforces `link_expires`, corrected Storage bucket privacy (`certificates` private, role-split read policies). | `schema.sql` base |
| 003 | `003_function_search_path.sql` | Fixed `search_path` on `set_updated_at`, `enforce_worker_limit`, `safe_to_date` — clears the Supabase advisor's mutable-search-path warnings. | 002 |
| 004 | `004_schema_migrations_table.sql` | Adds `public.schema_migrations` — the version-tracking table `fleet-migrate.mjs` reads/writes. | `schema.sql` base |
| 005 | `005_tenant_logo.sql` | `logos` public Storage bucket + RLS, `settings.logo_url`, exposed via `public_settings`. | `schema.sql` base |
| 006 | `006_digest_cadence_and_timezone.sql` | `settings.timezone`/`digest_cadence`/`digest_day_of_week`/`digest_hour`/`last_digest_sent_at` — configurable per-tenant digest schedule with dedup, defaults reproduce the old hardcoded behavior. | `schema.sql` base |
| 007 | `007_sites_and_credential_types.sql` | Credential-type catalog, `sites`, `site_required_types`, `site_assignments` (rosters). Foundation for site/project-based requirements. | `schema.sql` base (`workers`, `set_updated_at()`) |
| 008 | `008_public_gate_clearance.sql` | `get_public_site(slug)` — the one anon-reachable RPC that lets the public `/r/:slug` gate flow look up a site's requirements without exposing the `sites` table. | 007 |
| 009 | `009_gate_scan_log.sql` | `gate_scans` table + `record_gate_scan(site_slug, worker_slug)` RPC — logs every gate scan (timestamp, result, missing credentials) server-side. | 007, 008 |
| 011 | `011_gate_companion.sql` | **Bug fix**: adds `typeId` to the `public_workers` view's certifications — without it every anon gate verdict read "not cleared" while `record_gate_scan()` logged "cleared" for the same scan. Plus `search_site_roster(site_slug, query)` for the gate companion's look-up-by-name. | 007, 008, 009 |
| 010 | `010_roles.sql` | Real roles (admin / safety / gate). `current_fc_role()` helper + role-keyed RLS on `workers`, `settings`, `sites`, `site_required_types`, `site_assignments`, `credential_types`, and Storage. Policy changes only — no new tables/columns. Existing users (no `fc_role`) default to `admin`, so it's a no-op on deploy day. | 007–009, `schema.sql` base |

## Applying 011 (current)

Backs the FieldCred Gate companion app (`#/gate-app`). Two changes — one is a
correctness fix that matters on its own, one widens anon exposure and is a
deliberate decision. Read the header comment in the migration before applying.

1. Supabase dashboard → SQL Editor → New query, on the tenant's project.
2. Paste the full contents of `supabase/migrations/011_gate_companion.sql`
   and run it. Idempotent — safe to re-run.
3. Verify the bug fix — `typeId` must now come back on a public record:

   ```sql
   select jsonb_agg(c -> 'typeId')
   from public_workers w, jsonb_array_elements(w.certifications) c
   limit 1;
   ```

   If this returns all `null`s, the certs simply aren't tagged yet on this
   tenant (run the credential-type backfill from the Admin screen); if the
   key is *absent* from the objects, the view didn't update.

4. Verify the roster search is scoped and capped:

   ```sql
   -- Returns matching workers on that site only; a 1-char query returns none.
   select * from search_site_roster('<a-site-public-slug>', 'an');
   select * from search_site_roster('<a-site-public-slug>', 'a');   -- 0 rows
   select * from search_site_roster('<a-site-public-slug>', '%');   -- 0 rows
   ```

### If you do not want anon roster lookup

The look-up-by-name screen is the only thing that needs it, and it degrades
cleanly — supervisors (who are signed in) keep full lookup either way:

```sql
revoke execute on function public.search_site_roster(text, text) from anon;
```

Do **not** skip the `public_workers` half of the migration to avoid this. That
half is the bug fix, and leaving it unapplied keeps the gate showing verdicts
that contradict its own audit log.

## Applying 010

Budget ~5 minutes per tenant. This one changes RLS on existing tables, so
**apply it to the demo tenant first, verify, then other live tenants, and
deploy the frontend last** (see the ordering note in the migration header and
`PROVISIONING.md` → "Roles"). Making RLS strict for a role that the *old*
frontend assumes can still write is the one unsafe order; the migration alone,
with the old frontend, is a no-op because every existing user resolves to
`admin`.

1. Open the tenant's Supabase project → **SQL Editor**.
2. Paste the full contents of `supabase/migrations/010_roles.sql` and run it.
   It only drops/recreates policies and creates `current_fc_role()` — no data
   is touched, and it's safe to re-run.
3. **Verify the helper defaults existing users to admin.** With no `fc_role`
   set on your own account yet, from the SQL Editor (which runs as a superuser,
   so `auth.jwt()` is empty and the coalesce kicks in):
   ```sql
   select public.current_fc_role();  -- expect: admin
   ```
4. **Assign a role to a test user** — Authentication → Users → the user →
   **app_metadata** (the "Raw app meta data" / user metadata editor, NOT
   user_metadata) → add `{"fc_role": "safety"}` (or `"gate"`). Save.
5. **Verify RLS actually blocks, not just the UI.** Sign in as that safety
   user in the app, open the browser console, and try a delete directly
   against the API (bypassing the hidden button):
   ```js
   await window.__fieldcred /* or your supabase client */;
   // As safety: an UPDATE on a worker succeeds; a DELETE returns a 403 /
   // 42501 row-level-security error. As gate: both fail.
   ```
   The point is that the block comes from the database, not from the hidden
   control. A safety user editing a worker should succeed; deleting one should
   fail with a permission error surfaced as the "Your role can't do this" toast.
6. Deploy the frontend changes (`js/lib/roles.js`, `js/lib/auth.js`,
   `js/components/topNav.js`, `js/components/toast.js`, `js/main.js`,
   `js/pages/{directory,profile,editProfile,admin,sites,siteDetail}.js`)
   **after** step 2 on every tenant that will get the new frontend.
7. Repeat for every existing tenant. New tenants from `schema.sql` already
   have these policies.

**JWT staleness:** a role change only reaches the client after the user's
token refreshes (~1h) or they sign out and back in. Tell users to re-login if
a just-assigned role hasn't taken effect.

## Rolling back 010

The pre-010 behavior is "every authenticated user is a full admin." To
restore it without dropping the helper, widen the policies back to
`using (true)` / `with check (true)` — or simply give every user
`{"fc_role":"admin"}` (or leave it unset, which already resolves to admin).
There's no destructive change to undo: 010 creates no tables and deletes no
data, so a rollback is only ever about policy shape, not recovery.

## Applying 009

Budget ~5 minutes per tenant.

1. Open the tenant's Supabase project → **SQL Editor**.
2. Paste the full contents of `supabase/migrations/009_gate_scan_log.sql` and
   run it. It's additive only (new table, new indexes, new RLS policy, new
   function) — nothing existing is altered, and it's safe to re-run if
   you're not sure it already applied.
3. **Verify the table exists and RLS is on:**
   ```sql
   select relrowsecurity from pg_class where relname = 'gate_scans';
   -- expect: t
   ```
4. **Verify the function is callable and fails closed for a bogus site:**
   ```sql
   select * from record_gate_scan('does-not-exist', 'does-not-exist');
   -- expect one row: result = 'unknown_site'
   select count(*) from gate_scans where result = 'unknown_site';
   -- expect: 1 (the call above just wrote it)
   ```
5. **End-to-end check with real data**, once you have at least one active
   site with a required credential type and one worker: visit that site's
   gate link (`#/gate/<site-slug>`) on a device, then open a worker's public
   record (or scan their badge) — either cleared or blocked, a row should
   appear within a few seconds at **Sites → that site → Scan log**
   (`#/site/:id/log`) in the app.
6. Deploy the frontend changes (`js/pages/publicRecord.js`,
   `js/pages/siteScanLog.js`, `js/lib/state.js`, `js/lib/format.js`,
   `js/main.js`, `js/pages/siteDetail.js`) **after** step 2 — the frontend
   calls `record_gate_scan` and reads `gate_scans` unconditionally. If the
   frontend goes out first, gate scans just silently stop logging
   (`recordGateScan()` fails closed/silent by design) rather than breaking
   the gate itself, so the order matters for *data completeness*, not
   uptime — but do the SQL first anyway to avoid the gap.
7. Repeat 1–6 for every existing tenant. New tenants provisioned from
   `schema.sql` after this change already have it — skip them.

## Rolling back 009

Not expected to be needed (additive-only), but if you must:

```sql
drop function if exists public.record_gate_scan(text, text);
drop table if exists public.gate_scans;
```

This removes the log entirely, including any scans already recorded — there's
no soft-disable. If you just want to stop new logging without losing history,
revoke execute instead: `revoke execute on function public.record_gate_scan(text, text) from anon, authenticated;` (the frontend call will then fail silently, same as any other logging error).
