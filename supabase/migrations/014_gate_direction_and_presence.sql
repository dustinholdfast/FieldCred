-- Migration: gate direction + presence — 2026-08-21
--
-- Turns gate_scans from a pure scan log into a presence system:
--   * direction (in/out) on every scan
--   * optional device_id / guard_label for audit
--   * site_on_site_now() — workers whose latest scan today is "in"
--
-- Apply ONCE per tenant project. New tenants should get the same from schema.sql.
-- Idempotent where possible.
--
-- Depends on migration 009 (gate_scans, record_gate_scan).

-- =========================================================================
-- 1. Columns on gate_scans
-- =========================================================================
alter table public.gate_scans
  add column if not exists direction text not null default 'in';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'gate_scans_direction_check'
      and conrelid = 'public.gate_scans'::regclass
  ) then
    alter table public.gate_scans
      add constraint gate_scans_direction_check
      check (direction in ('in', 'out'));
  end if;
end $$;

alter table public.gate_scans
  add column if not exists device_id text,
  add column if not exists guard_label text;

create index if not exists gate_scans_site_worker_scanned_idx
  on public.gate_scans (site_id, worker_id, scanned_at desc);

-- =========================================================================
-- 2. record_gate_scan — same clearance logic as 009, plus direction metadata
-- =========================================================================
drop function if exists public.record_gate_scan(text, text);

create or replace function public.record_gate_scan(
  p_site_slug text,
  p_worker_slug text,
  p_direction text default 'in',
  p_device_id text default null,
  p_guard_label text default null
)
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
  v_direction     text;
begin
  v_direction := case
    when lower(coalesce(p_direction, '')) in ('in', 'out') then lower(p_direction)
    else 'in'
  end;

  select id, name, public_slug into v_site
  from public.sites where public_slug = p_site_slug and active = true;

  if v_site.id is null then
    insert into public.gate_scans (site_slug, worker_slug, result, direction, device_id, guard_label)
    values (p_site_slug, p_worker_slug, 'unknown_site', v_direction,
            nullif(btrim(coalesce(p_device_id, '')), ''),
            nullif(btrim(coalesce(p_guard_label, '')), ''));
    return query select 'unknown_site'::text, null::text, '[]'::jsonb;
    return;
  end if;

  select id, name into v_worker
  from public.public_workers where public_slug = p_worker_slug;

  if v_worker.id is null then
    insert into public.gate_scans (site_id, site_slug, site_name, worker_slug, result, direction, device_id, guard_label)
    values (v_site.id, v_site.public_slug, v_site.name, p_worker_slug, 'unknown_worker', v_direction,
            nullif(btrim(coalesce(p_device_id, '')), ''),
            nullif(btrim(coalesce(p_guard_label, '')), ''));
    return query select 'unknown_worker'::text, null::text, '[]'::jsonb;
    return;
  end if;

  select array_agg(type_id) into v_required_ids
  from public.site_required_types where site_id = v_site.id;

  if v_required_ids is null or array_length(v_required_ids, 1) is null then
    insert into public.gate_scans (site_id, site_slug, site_name, worker_id, worker_slug, worker_name, result, direction, device_id, guard_label)
    values (v_site.id, v_site.public_slug, v_site.name, v_worker.id, p_worker_slug, v_worker.name, 'no_requirements', v_direction,
            nullif(btrim(coalesce(p_device_id, '')), ''),
            nullif(btrim(coalesce(p_guard_label, '')), ''));
    return query select 'no_requirements'::text, v_worker.name, '[]'::jsonb;
    return;
  end if;

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

  insert into public.gate_scans (site_id, site_slug, site_name, worker_id, worker_slug, worker_name, result, missing_types, direction, device_id, guard_label)
  values (v_site.id, v_site.public_slug, v_site.name, v_worker.id, p_worker_slug, v_worker.name, v_result, v_missing, v_direction,
          nullif(btrim(coalesce(p_device_id, '')), ''),
          nullif(btrim(coalesce(p_guard_label, '')), ''));

  return query select v_result, v_worker.name, v_missing;
end;
$$;

revoke all on function public.record_gate_scan(text, text, text, text, text) from public;
grant execute on function public.record_gate_scan(text, text, text, text, text) to anon, authenticated;

-- =========================================================================
-- 3. ON SITE NOW — latest scan today is "in"
-- =========================================================================
create or replace function public.site_on_site_now(p_site_id uuid)
returns table (
  worker_id uuid,
  worker_name text,
  worker_slug text,
  last_in_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with latest as (
    select distinct on (gs.worker_id)
      gs.worker_id,
      gs.worker_name,
      gs.worker_slug,
      gs.direction,
      gs.scanned_at
    from public.gate_scans gs
    where gs.site_id = p_site_id
      and gs.worker_id is not null
      and gs.scanned_at >= date_trunc('day', now())
    order by gs.worker_id, gs.scanned_at desc
  )
  select
    worker_id,
    worker_name,
    worker_slug,
    scanned_at as last_in_at
  from latest
  where direction = 'in'
  order by last_in_at desc;
$$;

revoke all on function public.site_on_site_now(uuid) from public;
grant execute on function public.site_on_site_now(uuid) to authenticated;
