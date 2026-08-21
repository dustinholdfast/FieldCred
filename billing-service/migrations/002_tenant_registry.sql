-- FieldCred billing service — tenant registry
--
-- Apply to the billing database (BILLING_DB_URL), once:
--   node apply-schema.mjs            (if that script picks up migrations/)
--   or: psql "$BILLING_DB_URL" -f migrations/002_tenant_registry.sql
--
-- WHY THIS IS A SEPARATE TABLE FROM tenant_billing
--
-- tenant_billing already carries slug + supabase_url + supabase_anon_key,
-- so serving tenant lookups straight off it looks tempting. Two reasons not
-- to:
--
--   1. Its columns are NOT NULL across stripe_customer_id, db_url,
--      plan_tier — it structurally assumes every tenant arrived through
--      Stripe Checkout. The `demo` tenant, and anything provisioned by
--      hand, cannot be represented without inventing a fake customer id
--      and recovering a db_url that Supabase only ever printed once.
--      A registry has to serve tenants that aren't paying customers.
--
--   2. tenant_billing.db_url is a live Postgres superuser connection
--      string per tenant — the single most sensitive value this service
--      holds. The tenant-lookup endpoint is unauthenticated by necessity
--      (the app has to resolve a tenant before anyone can sign in). Those
--      two facts should not meet in the same table. Here they don't: this
--      table holds no secret at all, so a `select *` bug in the lookup
--      route leaks nothing that isn't already public.
--
-- Everything in this table is safe to serve to an anonymous caller. The
-- Supabase anon key is public by design — RLS is the actual boundary (see
-- the repo README's "Auth model" section and supabase/schema.sql).

create table if not exists tenant_registry (
  slug                 text primary key,
  supabase_url         text not null,
  supabase_anon_key    text not null,

  -- Email domains that map to this tenant, backing
  -- tenant-lookup-by-domain.php (the login screen's "figure out which
  -- tenant this person belongs to" step). Matches the `domains` array in
  -- the provisioning manifest. Stored lowercase; see the trigger below.
  domains              text[] not null default '{}',

  -- Mirrors tenant_billing.status for Stripe-provisioned tenants, and is
  -- simply 'active' for manual ones. Kept in sync by
  -- handleSubscriptionChange(). Same CHECK values as tenant_billing so the
  -- two can never disagree about what a valid status is.
  status               text not null default 'active'
                         check (status in ('active', 'past_due', 'canceled')),
  grace_period_ends_at timestamptz,

  -- 'stripe' = written by the provisioning webhook. 'manual' = inserted by
  -- hand (demo, pilots, anything provisioned before billing existed).
  -- Purely informational, but it makes "why is this tenant here?"
  -- answerable a year from now.
  source               text not null default 'stripe'
                         check (source in ('stripe', 'manual')),

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Domain lookup is an array containment search; GIN makes it an index hit
-- instead of a sequential scan. Small table today, but this is on the
-- login path and the index costs nothing.
create index if not exists tenant_registry_domains_idx
  on tenant_registry using gin (domains);

-- Case-insensitive domain matching, enforced on write rather than read:
-- lowercasing at query time would defeat the GIN index above.
create or replace function tenant_registry_normalize()
returns trigger language plpgsql as $$
begin
  new.slug    := lower(btrim(new.slug));
  new.domains := coalesce(
    (select array_agg(lower(btrim(d))) from unnest(new.domains) d where btrim(d) <> ''),
    '{}'
  );
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tenant_registry_normalize_trg on tenant_registry;
create trigger tenant_registry_normalize_trg
  before insert or update on tenant_registry
  for each row execute function tenant_registry_normalize();

-- A domain must not resolve to two tenants — the login screen would have
-- no basis to choose between them, and picking wrong sends someone to
-- another company's sign-in. Enforced rather than assumed.
create or replace function tenant_registry_domains_unique()
returns trigger language plpgsql as $$
declare
  clash record;
begin
  select r.slug, d into clash
  from tenant_registry r, unnest(r.domains) d
  where r.slug <> new.slug and d = any(new.domains)
  limit 1;

  if found then
    raise exception 'domain "%" already belongs to tenant "%"', clash.d, clash.slug
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_registry_domains_unique_trg on tenant_registry;
create trigger tenant_registry_domains_unique_trg
  after insert or update of domains on tenant_registry
  for each row execute function tenant_registry_domains_unique();


-- =====================================================================
-- BACKFILL — run this once, with demo's real values from tenants.php.
--
-- Until this row exists, app.fieldcred.co's demo tenant resolves only
-- through the flat-file fallback in tenant-lookup.php. That fallback is
-- meant to be the safety net, not the primary path, so don't skip this.
-- =====================================================================

-- insert into tenant_registry (slug, supabase_url, supabase_anon_key, domains, source)
-- values (
--   'demo',
--   'https://REPLACE.supabase.co',   -- tenants.php -> 'demo' -> 'url'
--   'REPLACE_ANON_KEY',              -- tenants.php -> 'demo' -> 'anonKey'
--   '{}',                            -- or '{"fieldcred.co"}' if demo should own a domain
--   'manual'
-- )
-- on conflict (slug) do update set
--   supabase_url      = excluded.supabase_url,
--   supabase_anon_key = excluded.supabase_anon_key,
--   domains           = excluded.domains,
--   updated_at        = now();
