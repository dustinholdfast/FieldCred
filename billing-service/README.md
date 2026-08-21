# FieldCred billing service

Stripe Checkout → auto-provisioned tenant (Handoff 04). This is a separate,
always-on Node service — it does NOT run on the fieldcred.co PHP host. It
holds `STRIPE_SECRET_KEY` and `SUPABASE_ACCESS_TOKEN`; same rule as
`admin-dashboard/server.mjs`, stated in its own header comment: those
secrets must never sit behind a shared/public web host.

## What this does, and what it still doesn't (read this first)

1. **`checkout.session.completed`** → builds a provisioning manifest from
   the Checkout Session, writes a `signups` row, acks Stripe immediately,
   then runs `provision-tenant.mjs` (from `../supabase/`) as a child
   process in the background — creates the Supabase project, applies
   schema + all migrations, sets `plan_limits`, invites the admin (Supabase
   sends the set-password email — that's the "welcome email" from the
   customer's side).
2. **`customer.subscription.updated`** → maps the new price to a plan
   tier and updates that tenant's `plan_limits` directly (needs the
   tenant's DB connection string, captured once at provisioning and stored
   in this service's own database — see "Security" below).
3. **`customer.subscription.deleted`** → marks the tenant canceled with a
   grace period. Does NOT drop the Supabase project or edit `tenants.php`
   automatically — alerts you instead (see the gap below).
4. **`POST /api/portal-session`** → verifies the caller against the
   tenant's own Supabase auth, then returns a Stripe Customer Portal URL.
   This is what the admin page's upgrade button should call, replacing the
   at-cap mailto link.

**What's still manual, on purpose:** `provision-tenant.mjs` only ever
*prints* the `tenants.php` entry — it has no way to FTP-deploy it to the
production PHP host (`PROVISIONING.md` calls this out as "Phase 2.2's
remaining gap," and it's still open). So after a successful signup, this
service emails you (`OPERATOR_ALERT_EMAIL`) the exact entry to paste in and
deploy, and marks the `signups` row `awaiting_deploy`. **A paying customer
cannot actually log in until you do that FTP step.** Closing this gap for
real — automated FTP/SFTP deploy, or moving `tenants.php` to something this
service can write to directly — is the natural next piece of work, not
built here.

## Architecture

```
Stripe → POST /webhooks/stripe → [this service] → provision-tenant.mjs (child process) → Supabase
                                        ↓
                              email you: tenants.php entry to deploy
```

Provisioning reuses `../supabase/provision-tenant.mjs` directly via
`child_process` rather than re-implementing its logic — that script is
already battle-tested (pooler-readiness retries, resume-after-failure).
Set `SUPABASE_TOOLING_PATH` if this service isn't deployed as a sibling
directory to `supabase/`.

## Crash recovery (v1, not a real job queue)

Provisioning takes minutes. If this service restarts mid-run, `server.mjs`
sweeps `signups` for anything stuck in `pending`/`provisioning` on startup
and re-runs it — safe because `provision-tenant.mjs` itself checks current
state before redoing any step. This is a reasonable v1 given no queue
infra (Redis/BullMQ) exists yet; if signup volume grows enough that
in-process retry isn't reliable enough, that's the natural upgrade.

## Security

This service's own database (`BILLING_DB_URL`) is now **exactly as
sensitive as `SUPABASE_ACCESS_TOKEN`** — `tenant_billing.db_url` holds a
live Postgres connection string per tenant (captured once at creation,
since Supabase never shows it again). Treat this database with the same
care: never on a public host, restrict network access to this service
only, and never log connection strings or the Stripe secret key.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in real values
psql "$BILLING_DB_URL" -f schema.sql
npm run dev                   # local dev, or `npm start` in production
```

## Stripe dashboard setup (you have to do this — I have no access to your Stripe account)

1. **Create a Product + Price per plan tier**, matching the tiers your
   `plan_limits` table actually enforces (see `supabase/schema.sql`). Copy
   each Price ID into `PRICE_TIER_MAP_JSON`.
2. **Configure Checkout** (Payment Link or a Checkout Session you create)
   with two custom fields, exact keys:
   - `company_name` (text)
   - `slug` (text) — desired subdomain; tell customers it must be
     lowercase letters/digits/hyphens only
   Customer email is collected automatically by Checkout — don't add a
   redundant field for it.
3. **Add the webhook endpoint**: Developers → Webhooks → your deployed
   URL + `/webhooks/stripe`, events `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Copy
   the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. **Enable the Customer Portal** (Settings → Billing → Customer portal) —
   at minimum, allow plan switching between your configured Prices and
   cancellation.
5. **Test mode first.** Use Stripe CLI (`stripe listen --forward-to
   localhost:3000/webhooks/stripe`) to test the whole flow against `demo`
   or a throwaway Supabase org before pointing live keys at real
   provisioning — see the handoff doc's "Gotchas" section: test end to end
   before production keys touch it.

## Verification checklist (from the handoff doc)

- Test-mode checkout → tenant exists, schema at latest migration, admin
  invite received, `awaiting_deploy` alert email arrives with a correct
  `tenants.php` entry.
- Deploy that entry by hand → `curl
  https://app.fieldcred.co/tenant-lookup.php?tenant=<slug>` confirms it's
  live → mark the signup `status = 'live'`.
- Upgrade/downgrade in the Customer Portal → `plan_limits` reflects it
  within a minute (check via that tenant's SQL Editor).
- `stripe events resend` on a `checkout.session.completed` event → no
  duplicate `signups` row (unique on `stripe_session_id`), no duplicate
  provisioning attempt.
- Kill the service mid-provisioning (`Ctrl+C` during a test run) → restart
  → confirm the startup sweep log line shows it resuming, not restarting
  from scratch.
