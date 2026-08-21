# Tenancy model — decision record

Decided 2026-07-13, as part of Phase 2 planning in `FIELDCRED-REMAINING-PLAN.md`.

## Decision

**Dedicated Supabase project per tenant.** This confirms and documents the
model the codebase already implements (see `README.md`'s "Multi-tenant"
section, `tenants.php`, `supabase/PROVISIONING.md`) — it was not revisited
as a live option against shared-project-with-RLS or a hybrid model, because
switching now would mean reworking the schema (every table needs a
`tenant_id`), every RLS policy, the tenant-resolution logic in
`js/lib/tenant.js`/`supabaseClient.js`, and the whole migration convention
in `supabase/migrations/` — a rewrite, not a config change, with no proven
need driving it.

## Cost floor

**Confirmed empirically 2026-07-13**, not from documentation: Supabase's
free tier allows a maximum of **2 active free projects per user account**,
counted across every organization where that user is an admin/owner —
provisioning the `fieldcred-demo` project hit this cap immediately (the org
already had `FieldCred` production + an unrelated `Focusdeck` project) and
required pausing `Focusdeck` to make room.

**Update 2026-07-18:** the `default` (production) project was deleted on
purpose — it never held live customer data, only test data, so this was a
clean removal, not an incident. Practical effect: only `demo` occupies a
free-tier slot now, so there's a free slot open again for the next tenant
provisioned (via Handoff 04's Stripe flow or otherwise). **Not yet
confirmed: whether the Supabase org's Pro-tier upgrade (see "Backup" below)
is still active, or whether it's worth downgrading given only one project
is running.** Check the org's billing page before quoting a customer margin
figure for the first Stripe-provisioned tenant — the answer changes the
actual cost floor for tenant #2 (post-`demo`) meaningfully.

Original math, for reference: **the 3rd tenant project (and every one
after) requires a paid Supabase plan** — Pro tier, currently ~$25/mo per
project (confirm current pricing at supabase.com/pricing before quoting a
customer margin figure). This is a real, roughly-fixed cost of goods sold
per tenant beyond the second one, not shared/amortized infrastructure.
Worth keeping in view against the $250/mo Starter price set 2026-07-13 —
healthy margin at that price, but not infrastructure that scales to zero.
With `default` gone, that "3rd tenant" threshold has effectively moved out
by one.

## Free-tier pausing

Free-tier Supabase projects auto-pause after a period of inactivity (and
can also be paused manually via the Management API — used directly this
session to free up the project slot above; `POST
/v1/projects/{ref}/pause`, reversible via the dashboard or API). A paused
free-tier tenant project going dark unexpectedly is a real risk for any
tenant kept on free tier past evaluation/demo use — **the demo tenant
(`fieldcred-demo`) is on free tier and can auto-pause; the reset procedure
in `reset_demo.sql`/`seed_demo.sql` does not un-pause a paused project**,
so if the public sample-record link on `fieldcred.co` ever 404s/times out,
check whether `fieldcred-demo` paused before assuming an app bug.

## Isolation

Full: separate Postgres instance, separate `auth.users`, separate Storage
buckets, separate API keys per tenant. There is no shared schema and no
tenant-scoping column that a bug or bypassed RLS policy could ever cross —
the strongest isolation available short of separate physical infrastructure
per tenant, which this effectively already is. This is the main thing the
per-project model buys over shared-with-RLS, and it's why it wasn't
revisited: the security posture already documented throughout this
project (contact info stays server-side hidden, certificates bucket
private, etc.) compounds with structural cross-tenant isolation for free.

## Backup

**Resolved 2026-07-13.** The FieldCred Supabase organization was upgraded
to the **Pro plan** (`GET /v1/organizations/{id}` → `"plan":"pro"`,
confirmed same day). Daily physical (walg) backups are now running and
completing successfully for both projects — verified via
`GET /v1/projects/{ref}/database/backups`, most recent completed run for
production (`qiozckjlojvhdtrsjzfp`) at 2026-07-13T09:42:13Z, and for demo
(`kaktjqbbijyjejulbpgy`) at 2026-07-13T19:54:43Z (the latter's first
backup, taken right after the org-wide upgrade).

**Note:** `pitr_enabled` is `false` on both projects. Point-in-time
recovery is a separate paid add-on on top of Pro (restore to any second,
not just the daily snapshot) — daily backups give a recovery point up to
~24h old, which closes the original "zero recovery path" risk but isn't
sub-day granularity. Revisit PITR if the acceptable data-loss window for
production ever needs to shrink below a day.

**Update 2026-07-18:** the production project referenced above
(`qiozckjlojvhdtrsjzfp`) has been deleted — see "Cost floor" for context.
`demo` (`kaktjqbbijyjejulbpgy`) is the only project left; its backup status
should still be as described above but wasn't re-verified as part of this
update.

## Regional requirements

Each project is pinned to one region at creation (production and demo are
both `us-east-2`). For a US trades/compliance customer base this is fine
as the default; a future tenant with a specific data-residency requirement
(e.g. EU) is straightforward to accommodate by creating that one project
in a different region — impossible to do selectively under a shared-project
model without much more work.

## Migration complexity

The direct cost of this model: every schema change has to be applied to
every tenant project individually, not once. `supabase/migrations/` plus
its applied-version checklist is the current mitigation (manual but
tracked); Phase 2.3 (fleet migration automation) is the planned fix for
the operational toil this creates as tenant count grows.

## Operational ownership

Currently fully manual, one operator, per `supabase/PROVISIONING.md`'s
step-by-step checklist (~15 minutes/tenant). Phase 2.2 targets automating
project creation, schema/migration application, and registry updates to
bring that down to roughly a minute of operator time — see that phase for
the acceptance criteria.
