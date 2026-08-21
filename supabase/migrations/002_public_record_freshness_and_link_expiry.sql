-- Migration 002 — public record freshness + link-expiry enforcement
-- Apply to tenants provisioned before this change. Safe to re-run.
-- Fresh projects get this automatically via schema.sql (kept in sync).
--
-- Replaces an earlier version of this file that didn't match what was
-- actually applied to the 'default' tenant (done by hand, not by running
-- this file as originally written) — see FIELDCRED-REMAINING-PLAN.md 0.2.
-- Since no tenant has this delta applied via a prior run of this exact
-- file, it's replaced in place rather than added as a new numbered delta.
--
-- Brings a tenant up to the reviewed baseline:
--   1. adds safe_to_date() — a malformed/unexpected link_expires value can
--      never throw and take the whole public_workers view down; it fails
--      closed (row drops out of the public view) instead.
--   2. recreates public.public_workers to:
--      - expose updated_at, so the public /r/:slug page can show an honest
--        "record updated <date>" freshness stamp.
--      - enforce link_expires via safe_to_date(), case/whitespace-tolerant
--        on the literal 'never'.
--      - rebuild `certifications` field-by-field so only a known-safe set
--        of keys is ever exposed publicly.
--   3. corrects Storage bucket/policy privacy: certificates is a PRIVATE
--      bucket with a role-split read policy (anon: photos/badges only;
--      authenticated: all three) — not one unrestricted-role read policy
--      across all three buckets, which would leak certificates to anon
--      regardless of the bucket's own `public` flag.

create or replace function public.safe_to_date(txt text)
returns date language plpgsql immutable as $$
begin
  return txt::date;
exception when others then
  return null;
end;
$$;

create or replace view public.public_workers as
select
  id, name, title, department, location, photo_url, skills,
  (
    select coalesce(
      jsonb_agg(jsonb_build_object(
        'name', c.value ->> 'name',
        'issuer', c.value ->> 'issuer',
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

update storage.buckets set public = false where id = 'certificates';

drop policy if exists "Public read of fieldcred images" on storage.objects;

drop policy if exists "Anon read photos and badges" on storage.objects;
create policy "Anon read photos and badges"
  on storage.objects for select
  to anon
  using (bucket_id in ('photos', 'badges'));

drop policy if exists "Authenticated read all buckets" on storage.objects;
create policy "Authenticated read all buckets"
  on storage.objects for select
  to authenticated
  using (bucket_id in ('photos', 'badges', 'certificates'));
