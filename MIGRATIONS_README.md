# FieldCred — Migration & Change Workflow

Three documents, three jobs. Don't blend them.

- **`CHANGELOG.md`** — everything that changed, technical detail, for you
  and future-you.
- **`INCIDENTS.md`** — security-relevant findings only, terse, dated,
  severity-tagged. What you hand a design partner's security review.
- **`TENANTS.md`** *(create once tenant #2 exists — template below)* —
  which migrations have been applied to which Supabase project.

## The workflow, every time

1. **Write** the SQL/code change.
2. **Apply** it — paste it into the SQL editor (or ship the code) yourself.
3. **Verify** — run a check that proves it worked. Not "it should work
   now," an actual query result, fetch response, or click-through.
4. **Only then** — log it in `CHANGELOG.md`, and in `INCIDENTS.md` if
   it's security-relevant.

Step 2 is yours to do, always, even when the SQL is handed to you as
part of a file. **A file in the repo is not a change until someone has
run it against the live system.** This is not a hypothetical — it's
exactly what INC-005 was: a corrected view got committed to `schema.sql`
without the separate step of executing it, and a live worker showed
the wrong compliance status as a result until manual QA caught it.

If a fix ever gets delivered as "here's the updated file, reupload it,"
that phrasing means *the code/template is corrected* — it does **not**
mean the database has been touched. For anything that's SQL, insist on
pasting it into the editor yourself and getting a result back, the same
way `001`/`002` and the `public_workers` fixes eventually were.

## Migration numbering

Sequential, zero-padded, one file per logical change:

```
supabase/migrations/
  001_security_hardening.sql
  002_verify_security.sql
  003_certificate_bucket_privacy.sql
  004_public_workers_view_v2.sql
  ...
```

`schema.sql` stays the canonical from-scratch template for provisioning
a brand-new tenant. The numbered migrations are what you replay against
*existing* tenant projects that predate a fix — which becomes essential
the moment a second tenant exists, since `schema.sql` alone only helps
future tenants, not current ones.

## TENANTS.md — create this when tenant #2 is provisioned

```markdown
# FieldCred — Tenant Migration Status

| Tenant slug | Project ref | Migrations applied | Last verified |
|---|---|---|---|
| (internal/demo) | qiozckjlojvhdtrsjzfp | 001, 002, 003, 004 | 2026-07-11 |
| acme-electric | (new ref) | — | — |

Update this table every time a migration is applied to a project —
same apply-then-log rule as CHANGELOG.md. A tenant row with a lower
migration number than the current max is a tenant still carrying a
known, fixed vulnerability.
```

This table is what turns "did we fix that everywhere" from a question
you have to reconstruct from memory into a thing you can just look at.
