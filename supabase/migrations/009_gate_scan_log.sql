-- Migration: gate scan audit log — 2026-07-17
--
-- Roadmap point 4, "The moat": log every gate scan with timestamp, result,
-- and who scanned. Apply ONCE per existing tenant project in the SQL Editor.
-- Depends on the tables from migration 007 and get_public_site() from 008.
-- New tenants get the same table/function from schema.sql. Idempotent.
--
-- ANON EXPOSURE — read before applying:
-- This adds exactly ONE thing an unauthenticated visitor (a gate device) can
-- reach: record_gate_scan(site_slug, worker_slug), which computes and stores
-- a scan result and returns just that result back to the caller. It is
-- SECURITY DEFINER so anon can call it without any grant on the underlying
-- tables. Nothing else changes: anon still cannot SELECT gate_scans (no
-- policy is granted for it), so a gate device can log a scan but can never
-- read the log back — only an authenticated admin can, from the app.
--
-- WHY THE FUNCTION COMPUTES CLEARANCE ITSELF, RATHER THAN TRUSTING A
-- CLIENT-SUPPLIED RESULT:
-- The whole point of an audit log is that it's trustworthy. If the browser
-- sent "cleared" as a parameter, anyone could call the RPC directly (it's a
-- public endpoint by design) and write fabricated "cleared" rows. Instead
-- the function re-derives clearance server-side from the same fail-closed
-- rule as js/lib/clearance.js: a required credential type is met only by a
-- cert of that type with a non-null expiry date that is not in the past
-- (matches both "valid" and "expiring" client-side statuses — only "expired"
-- and "missing" fail a requirement). Keep this in sync with clearance.js if
-- that logic ever changes.

create table if not exists public.gate_scans (
  id            uuid primary key default gen_random_uuid(),
  -- Denormalized site/worker name + slug alongside the (nullable) FK: a scan
  -- log is a historical record and must keep reading correctly even if a
  -- site is renamed/deleted or a worker is later removed — an audit log that
  -- goes blank when its subject is deleted defeats the purpose.
  site_id       uuid references public.sites(id) on delete set null,
  site_slug     text not null,
  site_name     text,
  worker_id     uuid references public.workers(id) on delete set null,
  worker_slug   text,
  worker_name   text,
  result        text not null check (result in ('cleared', 'blocked', 'no_requirements', 'unknown_worker', 'unknown_site')),
  missing_types jsonb not null default '[]'::jsonb,
  scanned_at    timestamptz not null default now()
);

create index if not exists gate_scans_site_scanned_idx on public.gate_scans (site_id, scanned_at desc);
create index if not exists gate_scans_scanned_idx on public.gate_scans (scanned_at desc);

-- RLS: authenticated admins can read the log (all rows — single shared admin
-- role, same as every other table). No insert/update/delete policy for
-- anyone — every write goes through record_gate_scan() below, which (being
-- SECURITY DEFINER) bypasses RLS entirely. That's deliberate: it's the only
-- write path, so there's nothing to lock down beyond "no direct policy."
alter table public.gate_scans enable row level security;
drop policy if exists "Authenticated read gate scans" on public.gate_scans;
create policy "Authenticated read gate scans"
  on public.gate_scans for select
  to authenticated using (true);

create or replace function public.record_gate_scan(p_site_slug text, p_worker_slug text)
returns table (result text, worker_name text, missing_type_names jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_site          record;
  v_worker        record;
  v_required_ids  uuid[];
  v_missing       jsonb := '[]'::jsonb;
  v_result        text;
begin
  select id, name, public_slug into v_site
  from public.sites where public_slug = p_site_slug and active = true;

  if v_site.id is null then
    insert into public.gate_scans (site_slug, worker_slug, result)
    values (p_site_slug, p_worker_slug, 'unknown_site');
    return query select 'unknown_site'::text, null::text, '[]'::jsonb;
    return;
  end if;

  -- Match what the public record page itself can see (public_workers view,
  -- public_view_enabled = true) so a scan's outcome never depends on data the
  -- worker's own share link couldn't already show.
  select id, name into v_worker
  from public.public_workers where public_slug = p_worker_slug;

  if v_worker.id is null then
    insert into public.gate_scans (site_id, site_slug, site_name, worker_slug, result)
    values (v_site.id, v_site.public_slug, v_site.name, p_worker_slug, 'unknown_worker');
    return query select 'unknown_worker'::text, null::text, '[]'::jsonb;
    return;
  end if;

  select array_agg(type_id) into v_required_ids
  from public.site_required_types where site_id = v_site.id;

  if v_required_ids is null or array_length(v_required_ids, 1) is null then
    insert into public.gate_scans (site_id, site_slug, site_name, worker_id, worker_slug, worker_name, result)
    values (v_site.id, v_site.public_slug, v_site.name, v_worker.id, p_worker_slug, v_worker.name, 'no_requirements');
    return query select 'no_requirements'::text, v_worker.name, '[]'::jsonb;
    return;
  end if;

  -- Fail-closed: a required type counts as met only if the worker has a cert
  -- of that type with a non-blank expiry date that hasn't passed yet.
  select coalesce(jsonb_agg(jsonb_build_object('id', ct.id, 'name', ct.name) order by ct.name), '[]'::jsonb)
  into v_missing
  from public.credential_types ct
  where ct.id = any(v_required_ids)
    and not exists (
      select 1
      from public.workers ww, jsonb_array_elements(ww.certifications) c
      where ww.id = v_worker.id
        and (c ->> 'typeId') = ct.id::text
        and coalesce(c ->> 'expiryDate', '') <> ''
        and (c ->> 'expiryDate')::date >= current_date
    );

  v_result := case when jsonb_array_length(v_missing) = 0 then 'cleared' else 'blocked' end;

  insert into public.gate_scans (site_id, site_slug, site_name, worker_id, worker_slug, worker_name, result, missing_types)
  values (v_site.id, v_site.public_slug, v_site.name, v_worker.id, p_worker_slug, v_worker.name, v_result, v_missing);

  return query select v_result, v_worker.name, v_missing;
end;
$$;

revoke all on function public.record_gate_scan(text, text) from public;
grant execute on function public.record_gate_scan(text, text) to anon, authenticated;
