-- Migration: gate companion app — 2026-07-20
--
-- Backs the FieldCred Gate companion (js/pages/gateApp.js): the kiosk-mode
-- scan/verdict app that replaces "scan a badge, land on /r/:slug" with
-- dedicated full-screen verdict posters. Apply ONCE per existing tenant
-- project in the SQL Editor. New tenants get the same objects from
-- schema.sql. Idempotent — safe to re-run.
--
-- Depends on migration 007 (credential_types, sites, site_required_types,
-- site_assignments) and 008 (get_public_site).
--
-- Two changes, both anon-facing. Read the exposure notes on each.

-- =========================================================================
-- 1. BUG FIX — public_workers.certifications must carry `typeId`.
-- =========================================================================
-- This is a live correctness bug, not a new feature.
--
-- Site clearance (js/lib/clearance.js) matches a worker's certs to a site's
-- required credential types by `cert.typeId`. The public_workers view — the
-- ONLY worker source an unauthenticated gate device can read — rebuilt each
-- cert object field by field and silently dropped typeId. Consequences on
-- every anon gate device today:
--
--   * evaluateClearance() sees no typeId on any cert, so EVERY required type
--     reads as unmet and /r/:slug renders "DO NOT ADMIT" for every worker,
--     fully compliant or not.
--   * record_gate_scan() (migration 009) reads public.workers directly as
--     SECURITY DEFINER, so it DOES see typeId and writes 'cleared' for that
--     same scan. The screen and the audit log disagree about the same event.
--
-- The second half is the serious one: an audit log whose rows contradict what
-- the guard was shown is worse than no log at all.
--
-- EXPOSURE: adds one opaque uuid per cert to an already anon-readable view.
-- It is a foreign key into credential_types, whose *names* are already anon-
-- readable for a site's required set via get_public_site() (migration 008).
-- No new table is reachable, no PII is added, and a bare uuid on its own
-- identifies nothing — anon still cannot enumerate credential_types.
--
-- Every other column is carried over verbatim from schema.sql's definition;
-- only the 'typeId' line below is new. Keep this in sync if either changes.
create or replace view public.public_workers as
select
  id, name, title, department, location, photo_url, skills,
  (
    select coalesce(
      jsonb_agg(jsonb_build_object(
        'name', c.value ->> 'name',
        'issuer', c.value ->> 'issuer',
        'typeId', c.value ->> 'typeId',
        'earnedDate', c.value ->> 'earnedDate',
        'expiryDate', c.value ->> 'expiryDate',
        'verificationUrl', c.value ->> 'verificationUrl',
        'badgeImageUrl', c.value ->> 'badgeImageUrl'
      )),
      '[]'::jsonb
    )
    from jsonb_array_elements(w.certifications) c(value)
  ) as certifications,
  public_view_enabled, public_slug, updated_at
from public.workers w
where public_view_enabled = true
  and (
    trim(lower(link_expires)) = 'never'
    or (safe_to_date(link_expires) is not null and safe_to_date(link_expires) >= current_date)
  );

grant select on public.public_workers to anon, authenticated;

-- =========================================================================
-- 2. Manual lookup by name at the gate — search_site_roster().
-- =========================================================================
-- The companion app's "LOOK UP BY NAME" screen: a badge is damaged, soaked,
-- or the worker left it in the truck, and the guard needs the same clearance
-- check without a QR. A gate device is a shared kiosk nobody signs in to, so
-- this has to be anon-reachable or the screen cannot exist.
--
-- EXPOSURE — this is a DELIBERATE WIDENING, decided with Dustin 2026-07-20.
-- Until now no anon caller could enumerate ANY roster (see the SCOPE note in
-- js/lib/offlineCache.js, and migration 008's "there is no list to
-- enumerate"). This function breaks that rule on purpose, as narrowly as it
-- can while still being useful:
--
--   * Scoped to ONE site, by exact public_slug, and only while that site is
--     active. There is still no way to list sites.
--   * Only workers actually ASSIGNED to that site (site_assignments) — not
--     the tenant directory.
--   * Only workers already visible in public_workers (sharing on, link not
--     expired), so this can never reveal someone whose own share link is off.
--   * Returns name, title, department and public_slug ONLY. No phone, no
--     email, no certs, no photo, no location, no ids.
--   * Requires >= 2 non-blank characters and returns at most 25 rows, so it
--     is a lookup, not a bulk export. A blank/1-char query returns nothing
--     rather than the whole roster.
--
-- Residual risk, stated plainly: someone who obtains a site's gate slug (it
-- is printed on a QR at the gate) can probe for names on that site's roster.
-- That is a real trade for making a damaged badge recoverable at the gate.
-- If a tenant does not want it, revoke execute from anon — the app degrades
-- to lookup being supervisor-only, which still works.
create or replace function public.search_site_roster(p_site_slug text, p_query text)
returns table (public_slug text, name text, title text, department text)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select
      nullif(btrim(coalesce(p_query, '')), '') as term
  ),
  -- Escape the LIKE metacharacters before wrapping in %…%, or a query of
  -- '%' would match the entire roster — exactly the bulk read the row cap
  -- and minimum length above exist to prevent.
  esc as (
    select replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') as term
    from q where length(term) >= 2
  )
  select pw.public_slug, pw.name, pw.title, pw.department
  from public.sites s
  join public.site_assignments sa on sa.site_id = s.id
  join public.public_workers pw on pw.id = sa.worker_id
  cross join esc
  where s.public_slug = p_site_slug
    and s.active = true
    and (pw.name ilike '%' || esc.term || '%' escape '\'
      or pw.title ilike '%' || esc.term || '%' escape '\')
  order by pw.name
  limit 25;
$$;

revoke all on function public.search_site_roster(text, text) from public;
grant execute on function public.search_site_roster(text, text) to anon, authenticated;
