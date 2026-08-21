-- Billing service bookkeeping schema — NOT the tenant app schema (that's
-- supabase/schema.sql, one copy per tenant project). This is the billing
-- service's own small database: one shared source of truth for money,
-- deliberately separate from any tenant's own Postgres. Run this once
-- against whatever Postgres backs the billing service (see README.md for
-- the "which database" decision).

-- =========================================================================
-- Idempotency. Stripe retries webhooks (network blips, slow acks, etc.) —
-- every event gets processed exactly once by checking this table first.
-- Deliberately keyed on Stripe's own event id, not on any derived key, so
-- a retried delivery of the same event is trivially a no-op regardless of
-- what the handler logic does.
-- =========================================================================
create table if not exists processed_stripe_events (
  event_id     text primary key,
  event_type   text not null,
  processed_at timestamptz not null default now()
);

-- =========================================================================
-- Signups — one row per Checkout session that completed. Tracks the
-- provisioning pipeline's progress so a crash mid-provision (provisioning
-- takes minutes, see provision-tenant.mjs's pooler-readiness comment) is
-- resumable instead of silently lost, and so "what's stuck" is a query,
-- not a memory exercise.
--
-- status values:
--   pending      — webhook received, provisioning not yet started/finished
--   provisioning — in progress (set right before invoking provision-tenant.mjs)
--   awaiting_deploy — Supabase project + admin user created; tenants.php
--                      entry generated but NOT yet FTP-deployed (that step
--                      is still manual — see README.md's "known gap")
--   failed       — provisioning errored; see last_error. Resumable via
--                  provision-tenant.mjs's own resume support.
--   live         — Dustin confirmed the registry entry is deployed
--                  (marked via the /internal/mark-live endpoint or by hand)
-- =========================================================================
create table if not exists signups (
  id                  uuid primary key default gen_random_uuid(),
  stripe_event_id     text not null references processed_stripe_events(event_id),
  stripe_session_id   text not null unique,
  stripe_customer_id  text not null,
  slug                text not null,
  company_name        text not null,
  admin_email         text not null,
  price_id            text not null,
  plan_tier           text not null,
  max_workers         int,
  status              text not null default 'pending'
                        check (status in ('pending', 'provisioning', 'awaiting_deploy', 'failed', 'live')),
  tenants_php_entry    text, -- the exact snippet to paste into tenants.php, generated once provisioning succeeds
  last_error          text,
  supabase_project_ref text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists signups_status_idx on signups (status) where status not in ('live');

-- =========================================================================
-- Tenant <-> Stripe mapping — one source of truth for "which Stripe
-- customer/subscription owns which tenant," used by the Customer Portal
-- endpoint and the subscription.updated/deleted webhook. Deliberately
-- central here rather than stored per-tenant (see HANDOFF-04's design
-- section: "prefer central — one source of truth for money").
-- =========================================================================
-- SECURITY NOTE: db_url below holds a live Postgres connection string per
-- tenant (the same value provision-tenant.mjs prints once at creation and
-- can never recover afterward). Storing it here is what lets the
-- subscription webhook update plan_limits directly without a human in the
-- loop — but it means THIS TABLE is now exactly as sensitive as
-- SUPABASE_ACCESS_TOKEN. Same rule applies: this database must never be
-- reachable from a public host, and BILLING_DB_URL must never be logged.
create table if not exists tenant_billing (
  slug                  text primary key,
  stripe_customer_id    text not null unique,
  stripe_subscription_id text,
  price_id              text,
  plan_tier             text not null,
  db_url                text not null,
  supabase_url          text not null, -- https://<ref>.supabase.co — used by the Customer Portal endpoint to verify the caller's session against THIS tenant's own auth
  supabase_anon_key     text not null, -- anon key only, never service_role — same rule as tenants.php
  status                text not null default 'active'
                          check (status in ('active', 'past_due', 'canceled')),
  grace_period_ends_at  timestamptz,
  updated_at            timestamptz not null default now()
);

create index if not exists tenant_billing_customer_idx on tenant_billing (stripe_customer_id);
