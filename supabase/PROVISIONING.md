# Provisioning a new tenant

Each tenant gets its own, fully separate Supabase project (own Postgres
database, own Storage buckets, own set of users).

**Preferred path (as of the 2026-07-18 Step Zero reconciliation):** `node
supabase/provision-tenant.mjs supabase/manifests/your-tenant.json` —
automates steps 1–4 below (project creation, schema/migrations, admin
invite) in roughly a minute of runtime. Requires `npm install` in
`supabase/` once, and `SUPABASE_ACCESS_TOKEN` set in your shell (never in
the manifest — see the script's own header comment and `TENANCY-MODEL.md`).
Idempotent and safe to re-run if it fails partway. Still prints the
`tenants.php` entry to paste in by hand for step 4 below — there's no
automated deploy path yet. The steps below remain the reference for what
the script does, and for provisioning by hand if you'd rather not use it.
`fleet-migrate.mjs` (also in `supabase/`) handles applying new migrations to
*existing* tenants after the fact — see its own header comment.

## 0. How requests come in (optional)

The app has a public "Request access" form at `#/signup`
(`js/pages/signup.js`, linked from the login page) — a prospective client
fills in their company name, work email, and optionally their email
domain, and it emails you via Resend (`signup-notify.php` /
`signup-config.php`) instead of provisioning anything automatically. This
is Phase 1 of self-serve: it turns "email/call me to get access" into a
form, but you still run through steps 1–6 below by hand for each request.

To activate it: get a Resend API key (see
`supabase/functions/expiration-alerts/SETUP.md` — same free-tier account
works for both, or use a separate key), then fill in `signup-config.php`
with that key and the email address you want requests sent to. Until it's
configured, submitting the form fails with a clear "not configured yet"
error rather than silently doing nothing.

You can skip this entirely and just onboard tenants you already know
about — steps 1–6 don't depend on a request having come through the form.

## 1. Create the Supabase project

1. [supabase.com](https://supabase.com) → **New project**. Name it after
   the tenant (e.g. `fieldcred-acme`) so it's identifiable in your Supabase
   org later. Save the database password somewhere.
2. **Authentication → Providers → Email** → turn off "Confirm email" (or
   set up email delivery if you'd rather keep it on).
3. **Authentication → Settings → "Allow new users to sign up"** → turn this
   OFF. Without it, this tenant's anon key (necessarily public — it's
   shipped to the browser and stored in `tenants.php`) is enough on its own
   for anyone to call `/auth/v1/signup` directly and mint themselves a
   session, completely bypassing this checklist and getting treated as
   `admin` the moment they do (see "Roles" below). **`provision-tenant.mjs`
   now does this automatically** right after project creation
   (`disableSelfServiceSignup`) — only do it by hand if you're provisioning
   outside the script.

## 2. Set up the schema

In the new project's **SQL Editor**:

1. Run `supabase/schema.sql` — as of the 2026-07-18 reconciliation this is
   the full current baseline: `workers`/`sites`/`credential_types`/
   `gate_scans` tables, the public views and RPCs, role-based RLS
   (`current_fc_role()`), and the `photos`/`badges`/`certificates`/`logos`
   Storage buckets. Running it here creates an empty project (no seed
   data) — no need to also run the numbered files in `migrations/`
   individually for a brand-new tenant, `schema.sql` alone is current
   through migration `010`.
2. Skip `seed_demo.sql` for a real tenant — that's demo data only. Run it
   if this project is for internal testing or a sales demo.
3. `schema.sql` also creates a `plan_limits` table defaulting to
   `plan_tier = 'unlimited'`, `max_workers = null` (no cap). If this
   tenant is on a plan with a worker cap, set it now:

   ```sql
   update public.plan_limits set plan_tier = 'growth', max_workers = 50 where id = 1;
   ```

   This is deliberately **not** editable from the app (no update policy
   for `authenticated`) — only reachable from the SQL Editor — so a tenant
   admin can't raise their own limit. Adding a worker beyond the cap fails
   with a clear in-app error (both a pre-check before the form loads /
   before an import runs, and a DB trigger as the real enforcement). To
   change a tenant's tier later — upgrade, downgrade, or move to
   unlimited — just re-run that same `update` statement with new values.

## 3. Create the tenant's first admin user

**Authentication → Users → Add user** — email + password. There's no
sign-up flow in the app; every account is provisioned this way (and
self-service signup is disabled per step 1.3, so this is the *only* way
in). Add more users the same way as the tenant needs them. **A new user
with no role set now has NO access** (see "Roles" below, migration 012) —
so for the tenant's first admin, immediately set `app_metadata: {"fc_role":
"admin"}` on that user (dashboard or Admin API, same as any other role
assignment) before handing over the login. `provision-tenant.mjs`'s
`inviteAdmin` step does this invite but still relies on you (or a future
script update) to set `fc_role` on the account once they set their
password — don't skip it.

## 4. Register the tenant

Copy the project's **URL** and **anon public** key from
**Project Settings → API**, then add an entry to `tenants.php`:

```php
'acme' => [
    'name' => 'Acme Corp', // shown in the top nav and on the login screen
    'url' => 'https://xxxxxxxxxxxxxxxx.supabase.co',
    'anonKey' => 'eyJ...',
    'domains' => ['acmecorp.com'], // optional — see below
],
```

`name` is the client-facing display name — it's what shows up in the app's
top nav and on the sign-in screen so it's always obvious which
tenant/database you're connected to.

`domains` is optional. If set, a client typing an email ending in one of
these domains on the login screen gets switched to this tenant
automatically — that's the *only* way to reach a non-default tenant now
(there's no Company ID field anymore), so set this for every real tenant
unless you're only ever going to hand them a direct `?tenant=` link. Only
add domains you're confident are exclusively this tenant's — the first
match wins, so don't reuse a domain (or a shared one like a generic email
provider) across tenants.

The key you're adding is the *anon* key, not `service_role` — never put a
`service_role` key in this file, it's served (indirectly) to the browser.

Re-upload `tenants.php` via FTP. That's the only file that needs to
change to add a tenant — no frontend code, no redeploy of the app itself.

## 5. Give the tenant a way in

Pick one:

- **Query param (works immediately, no DNS needed):** send them
  `https://app.fieldcred.co/?tenant=acme`. The app remembers
  this in `localStorage` after the first visit
  (`js/lib/tenant.js` → `setTenantOverride`), so they don't need to keep
  the `?tenant=` param on every link — but it's the simplest thing to
  hand someone to start.
- **Subdomain (nicer, needs one-time DNS + hosting setup):** point a
  wildcard DNS record (`*.app.fieldcred.co`) at your host, with
  a matching wildcard SSL cert. Once that's in place,
  `acme.app.fieldcred.co` resolves the tenant automatically —
  no `?tenant=` needed, and it works for anyone without them first
  visiting a magic link. Check whether your current host supports
  wildcard subdomains/certs before promising this to a tenant. This must
  match `BASE_HOST` in `js/lib/tenant.js`.

## 6. Verify

Visit the tenant's URL, confirm the login page loads (not "Backend not
configured" — that means the registry entry or DNS isn't right yet), sign
in with the admin user from step 3, and confirm the directory is empty
(or has the demo data, if you ran `seed_demo.sql`).

## Roles (admin / safety / gate)

As of migration `010_roles.sql`, users have one of three roles. The role
lives in Supabase auth **app_metadata** under the key `fc_role` — *not*
user_metadata (app_metadata can't be edited by the user via the app, which
is the point: a user must never be able to promote their own role).

| Role     | Can |
|----------|-----|
| `admin`  | Everything. |
| `safety` | Read everything; create/edit workers + certs; view scan logs. Cannot delete workers, change tenant settings, manage sites/credential types, or manage users. |
| `gate`   | Read-only directory + scan log. Intended for a signed-in gate device so scans can carry an identity. |

**As of migration `012_role_default_and_read_gating.sql`, a user with no
`fc_role` is treated as `unassigned` — no access at all**, not admin. This
closes a real gap: the old "no fc_role = admin" default meant any account
that came into existence outside this checklist (self-service signup, or a
mismatched re-invite) was automatically a full admin. Every account you
provision the normal way (Add user / invite) still needs `fc_role` set
explicitly now — see "To set a role" below — there is no more implicit
admin-by-default.

**Before applying migration 012 to a tenant that already has users**, run
the backfill in that migration's header comment first (in the SQL Editor):
it sets `fc_role: "admin"` on every existing user who's never had the claim
set, so nobody who's relying on the old default gets locked out. Apply to
the demo tenant first, confirm the demo admin can still log in, then apply
to every other live tenant via `fleet-migrate.mjs`, same deploy order as
migration 010.

**To set a role** (Supabase dashboard): **Authentication → Users →** the
user **→ app_metadata** editor → add:

```json
{ "fc_role": "safety" }
```

(or `"gate"`). Save. Equivalent via the Admin API:

```
PUT /auth/v1/admin/users/{user_id}   { "app_metadata": { "fc_role": "safety" } }
```

There's **no in-app UI** for role assignment in v1 — it's dashboard/API only,
by design (user management via the browser's anon-key client is fiddly and
was deliberately deferred).

**Enforcement is server-side.** RLS policies keyed on `current_fc_role()`
(migration 010) are what actually stop a safety user from deleting a worker
or a gate user from writing anything — the app only *hides* the controls.
Verify a role by exercising it, not just by looking at the UI (see
`MIGRATIONS_README.md` → "Applying 010", step 5).

**JWT staleness:** a role change takes effect only after the user's token
refreshes (~1h) or they sign out and back in. If a just-assigned role hasn't
kicked in, have them re-login.

## Keeping tenants in sync going forward

Every schema change (new column, new RLS policy, new bucket) has to be
run against **every** tenant project, not just one — `schema.sql` isn't
automatically re-applied anywhere. Keep a changelog of what's been run
where, or move to versioned migration files once you have more than a
couple of tenants; re-running an ad-hoc diff against N projects by memory
doesn't scale past that.
