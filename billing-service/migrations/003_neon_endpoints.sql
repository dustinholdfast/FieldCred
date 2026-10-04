-- Point the billing registry at Neon Auth + Data API URLs.
-- Apply once to the billing database (BILLING_DB_URL):
--   psql "$BILLING_DB_URL" -f migrations/003_neon_endpoints.sql
--
-- auth_url and data_api_url are public (same class as the old anon key).
-- They are nullable so existing rows survive until each tenant is filled in.
-- The old supabase_url / supabase_anon_key columns stay in place so this
-- migration does not destroy a value you still need during cutover; the
-- app no longer reads them.

alter table tenant_registry add column if not exists auth_url text;
alter table tenant_registry add column if not exists data_api_url text;
alter table tenant_registry alter column supabase_url drop not null;
alter table tenant_registry alter column supabase_anon_key drop not null;

alter table tenant_billing add column if not exists auth_url text;
alter table tenant_billing add column if not exists data_api_url text;
alter table tenant_billing alter column supabase_url drop not null;
alter table tenant_billing alter column supabase_anon_key drop not null;
