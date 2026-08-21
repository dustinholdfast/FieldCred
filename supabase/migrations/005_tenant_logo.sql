-- Migration 005 — tenant logo upload
-- Apply to tenants provisioned before this change. Safe to re-run.
-- Fresh projects get this automatically via schema.sql (kept in sync).
--
-- Phase 3 (FIELDCRED-REMAINING-PLAN.md): a public Storage bucket for the
-- tenant's own logo, a settings column to point at it, and exposure
-- through public_settings so the public record page can render it.
-- Mirrors the existing photos/badges pattern exactly — public bucket,
-- anon-readable, authenticated-writable.

insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

drop policy if exists "Anon read photos and badges" on storage.objects;
create policy "Anon read photos and badges"
  on storage.objects for select
  to anon
  using (bucket_id in ('photos', 'badges', 'logos'));

drop policy if exists "Authenticated read all buckets" on storage.objects;
create policy "Authenticated read all buckets"
  on storage.objects for select
  to authenticated
  using (bucket_id in ('photos', 'badges', 'certificates', 'logos'));

drop policy if exists "Authenticated upload of fieldcred images" on storage.objects;
create policy "Authenticated upload of fieldcred images"
  on storage.objects for insert
  to authenticated
  with check (bucket_id in ('photos', 'badges', 'certificates', 'logos'));

drop policy if exists "Authenticated update of fieldcred images" on storage.objects;
create policy "Authenticated update of fieldcred images"
  on storage.objects for update
  to authenticated
  using (bucket_id in ('photos', 'badges', 'certificates', 'logos'));

drop policy if exists "Authenticated delete of fieldcred images" on storage.objects;
create policy "Authenticated delete of fieldcred images"
  on storage.objects for delete
  to authenticated
  using (bucket_id in ('photos', 'badges', 'certificates', 'logos'));

alter table public.settings add column if not exists logo_url text;

create or replace view public.public_settings as
select tenant_name, logo_url from public.settings where id = 1;

grant select on public.public_settings to anon, authenticated;
