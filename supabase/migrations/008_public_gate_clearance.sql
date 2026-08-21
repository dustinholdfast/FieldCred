-- Migration: public gate clearance lookup — 2026-07-17 (Phase C)
--
-- Apply ONCE per tenant project in the SQL Editor. Depends on the tables from
-- migration 007. Idempotent (create or replace / revoke+grant). New tenants
-- get the same function from schema.sql.
--
-- ANON EXPOSURE — read before applying:
-- This adds exactly ONE thing an unauthenticated visitor can reach:
-- get_public_site(slug), which returns a SINGLE active site (by its exact
-- public_slug) and the names of the credential types it requires. It is
-- SECURITY DEFINER, so anon can call it without any select grant on the
-- underlying tables — which is the point: there is no list to enumerate, and
-- the sites / site_required_types / credential_types tables stay
-- authenticated-only. Rosters (site_assignments), worker PII, inactive sites,
-- and site locations are never exposed. A missing or inactive slug returns no
-- rows (fail-closed: the gate treats "no site" as unverifiable, not cleared).

create or replace function public.get_public_site(slug text)
returns table (id uuid, name text, public_slug text, required_types jsonb)
language sql
security definer
set search_path = public
as $$
  select
    s.id, s.name, s.public_slug,
    coalesce(
      jsonb_agg(jsonb_build_object('id', ct.id, 'name', ct.name) order by ct.name)
        filter (where ct.id is not null),
      '[]'::jsonb
    ) as required_types
  from public.sites s
  left join public.site_required_types srt on srt.site_id = s.id
  left join public.credential_types ct on ct.id = srt.type_id
  where s.public_slug = slug and s.active = true
  group by s.id, s.name, s.public_slug;
$$;

-- Lock down execution to exactly the roles that should have it. revoke from
-- PUBLIC first (functions are executable by PUBLIC by default), then grant to
-- the app's two roles only.
revoke all on function public.get_public_site(text) from public;
grant execute on function public.get_public_site(text) to anon, authenticated;
