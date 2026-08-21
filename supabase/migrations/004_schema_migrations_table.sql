-- Migration 004 — schema-version tracking table
-- Apply to tenants provisioned before this change. Safe to re-run.
-- Fresh projects get this automatically via schema.sql (kept in sync).
--
-- Backs fleet-migrate.mjs (see supabase/PROVISIONING.md and
-- FIELDCRED-REMAINING-PLAN.md Phase 2.3): records which numbered delta
-- files under migrations/ have been applied to THIS tenant's database, so
-- "what's pending" is a query against real state instead of the
-- hand-maintained checklist in migrations/README.md — which can drift
-- (the 'demo' tenant was never added to that checklist despite already
-- having 002 and 003 applied at creation, a live example of exactly the
-- drift this table replaces).
--
-- Deliberately tracks only migrations/NNN_*.sql deltas (002 onward), not
-- schema.sql itself — a tenant that exists at all necessarily already has
-- the baseline applied (that's how provisioning works), so there's
-- nothing to "check" for schema.sql specifically.

create table if not exists public.schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

alter table public.schema_migrations enable row level security;
-- Deliberately no anon/authenticated policies — this table is never
-- queried over PostgREST, only via the direct Postgres connection
-- fleet-migrate.mjs and provision-tenant.mjs use (which bypasses RLS).
