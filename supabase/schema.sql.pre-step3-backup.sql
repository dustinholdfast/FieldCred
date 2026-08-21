-- FieldCred — Supabase schema
-- Run this once in your project's SQL Editor (Supabase dashboard → SQL Editor → New query → paste → Run).
-- Safe to re-run: uses "if not exists" / "or replace" / "on conflict do nothing" throughout.

create extension if not exists pgcrypto;

-- =========================================================================
-- Workers (certifications + skills are embedded as jsonb, matching the
-- app's existing data shape — avoids a separate certifications table and
-- the extra CRUD/joins that would require, at the cost of not being able
-- to query/index individual certifications directly. Fine at this scale.)
-- =========================================================================
create table if not exists public.workers (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  title                text not null default '',
  department           text not null default '',
  location             text not null default '',
  phone                text not null default '',
  email                text not null default '',
  photo_url            text,
  skills               jsonb not null default '[]'::jsonb,
  certifications       jsonb not null default '[]'::jsonb,
  public_view_enabled  boolean not null default true,
  public_slug          text not null unique,
  link_expires         text not null default 'never',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists workers_public_slug_idx on public.workers (public_slug);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =========================================================================
-- Roles — admin / safety / gate. Each user's role lives in Supabase auth
-- app_metadata under key `fc_role` (not user_metadata: app_metadata is not
-- user-editable, so a user can't promote themselves). current_fc_role()
-- reads it off the JWT and defaults to 'admin' for any user without the
-- claim, so existing single-admin setups keep working unchanged. The RLS
-- policies below key off this. See supabase/migrations/010_roles.sql for the
-- standalone migration and the full rationale, and js/lib/roles.js for the
-- frontend mirror. NOT named current_role() — that collides with the SQL
-- reserved word.
-- =========================================================================
create or replace function public.current_fc_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(auth.jwt() -> 'app_metadata' ->> 'fc_role', ''),
    'admin'
  );
$$;

revoke all on function public.current_fc_role() from public;
grant execute on function public.current_fc_role() to authenticated, anon;

drop trigger if exists workers_set_updated_at on public.workers;
create trigger workers_set_updated_at
  before update on public.workers
  for each row execute function public.set_updated_at();

-- =========================================================================
-- RLS: only authenticated (logged-in staff) can read/write the base table.
-- Contact info (phone/email) lives here, so anon gets NO direct access —
-- public sharing goes through the public_workers view below instead, which
-- exposes only the safe columns. This enforces "contact details stay
-- hidden" server-side, not just by hiding fields in the UI.
--
-- Role-aware (admin/safety/gate, via current_fc_role() above): all three
-- roles read; admin + safety create/edit; only admin deletes. gate is
-- read-only. See supabase/migrations/010_roles.sql.
-- =========================================================================
alter table public.workers enable row level security;

drop policy if exists "Authenticated can read all workers" on public.workers;
drop policy if exists "Roles can read all workers" on public.workers;
create policy "Roles can read all workers"
  on public.workers for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can insert workers" on public.workers;
drop policy if exists "Admin or safety can insert workers" on public.workers;
create policy "Admin or safety can insert workers"
  on public.workers for insert
  to authenticated
  with check (public.current_fc_role() in ('admin', 'safety'));

drop policy if exists "Authenticated can update workers" on public.workers;
drop policy if exists "Admin or safety can update workers" on public.workers;
create policy "Admin or safety can update workers"
  on public.workers for update
  to authenticated
  using (public.current_fc_role() in ('admin', 'safety'))
  with check (public.current_fc_role() in ('admin', 'safety'));

drop policy if exists "Authenticated can delete workers" on public.workers;
drop policy if exists "Admin can delete workers" on public.workers;
create policy "Admin can delete workers"
  on public.workers for delete
  to authenticated
  using (public.current_fc_role() = 'admin');

-- =========================================================================
-- Settings — a single-row table for tenant-level, editable-from-the-app
-- values: display name (shown in the top nav and on the login screen), an
-- optional logo, the notification email expiration alerts get sent to, and
-- the per-tenant digest schedule (timezone + cadence + day-of-week + hour)
-- the expiration-alerts Edge Function evaluates each run
-- (see supabase/functions/expiration-alerts). last_digest_sent_at is written
-- by that function for once-a-day dedup. notification_email and the schedule
-- fields are not public — only tenant_name is, via the public_settings view
-- below — so the base table is authenticated-only read, unlike earlier
-- versions of this schema that allowed anon to read the whole row.
-- =========================================================================
create table if not exists public.settings (
  id                  int primary key default 1,
  tenant_name         text not null default 'FieldCred',
  notification_email  text,
  logo_url            text,
  timezone            text not null default 'UTC',        -- IANA tz; scheduling is evaluated in this zone
  digest_cadence      text not null default 'daily',      -- 'daily' | 'weekly'
  digest_day_of_week  int  not null default 1,            -- 0=Sun .. 6=Sat; only used when cadence = 'weekly'
  digest_hour         int  not null default 13,           -- 0..23, local to `timezone`
  last_digest_sent_at timestamptz,                        -- set by the Edge Function after a successful send (dedup)
  updated_at          timestamptz not null default now(),
  constraint settings_singleton check (id = 1)
);

insert into public.settings (id, tenant_name) values (1, 'FieldCred')
on conflict (id) do nothing;

-- add-column-if-not-exists for projects provisioned from an older version of
-- this file, so re-running brings them up to the current shape.
alter table public.settings add column if not exists notification_email text;
alter table public.settings add column if not exists logo_url text;
alter table public.settings add column if not exists timezone text not null default 'UTC';
alter table public.settings add column if not exists digest_cadence text not null default 'daily';
alter table public.settings add column if not exists digest_day_of_week int not null default 1;
alter table public.settings add column if not exists digest_hour int not null default 13;
alter table public.settings add column if not exists last_digest_sent_at timestamptz;

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

alter table public.settings enable row level security;

-- Drop the old anon-readable policy from earlier versions of this schema —
-- notification_email must not be exposed through it.
drop policy if exists "Public can read settings" on public.settings;

drop policy if exists "Authenticated can read settings" on public.settings;
create policy "Authenticated can read settings"
  on public.settings for select
  to authenticated
  using (true);

-- Only admin can change tenant settings (safety/gate are read-only here).
drop policy if exists "Authenticated can update settings" on public.settings;
drop policy if exists "Admin can update settings" on public.settings;
create policy "Admin can update settings"
  on public.settings for update
  to authenticated
  using (id = 1 and public.current_fc_role() = 'admin')
  with check (id = 1 and public.current_fc_role() = 'admin');

-- Anon-safe subset — just the display name, read on the login screen
-- before anyone's authenticated. Same "view as security barrier" pattern
-- as public_workers below.
create or replace view public.public_settings as
select tenant_name from public.settings where id = 1;

grant select on public.public_settings to anon, authenticated;

-- =========================================================================
-- Public record view — what the /r/:slug page and QR code resolve through.
-- Deliberately omits phone/email. Views run with the owner's privileges
-- (this is created by the postgres role via the SQL editor), so granting
-- select on the view to anon exposes just this subset without needing —
-- or wanting — an anon RLS policy on the base table.
-- =========================================================================
create or replace view public.public_workers as
select
  id, name, title, department, location, photo_url,
  skills, certifications, public_view_enabled, public_slug
from public.workers
where public_view_enabled = true;

grant select on public.public_workers to anon, authenticated;

-- =========================================================================
-- Storage — worker photos and certification badge images.
-- Buckets are public (readable by anyone with the URL, no auth required —
-- needed since these show up on the public share page); writes require
-- an authenticated session.
-- =========================================================================
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('badges', 'badges', true)
on conflict (id) do nothing;

-- Certificate PDFs (the actual document, distinct from the small "badge"
-- thumbnail image) — same public-read / authenticated-write shape.
insert into storage.buckets (id, name, public)
values ('certificates', 'certificates', true)
on conflict (id) do nothing;

drop policy if exists "Public read of fieldcred images" on storage.objects;
create policy "Public read of fieldcred images"
  on storage.objects for select
  using (bucket_id in ('photos', 'badges', 'certificates'));

-- Writing images requires admin or safety (they create/edit workers + certs);
-- gate is read-only. Public read is unchanged above. See migration 010.
drop policy if exists "Authenticated upload of fieldcred images" on storage.objects;
drop policy if exists "Admin or safety upload of fieldcred images" on storage.objects;
create policy "Admin or safety upload of fieldcred images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id in ('photos', 'badges', 'certificates')
    and public.current_fc_role() in ('admin', 'safety')
  );

drop policy if exists "Authenticated update of fieldcred images" on storage.objects;
drop policy if exists "Admin or safety update of fieldcred images" on storage.objects;
create policy "Admin or safety update of fieldcred images"
  on storage.objects for update
  to authenticated
  using (
    bucket_id in ('photos', 'badges', 'certificates')
    and public.current_fc_role() in ('admin', 'safety')
  );

drop policy if exists "Authenticated delete of fieldcred images" on storage.objects;
drop policy if exists "Admin or safety delete of fieldcred images" on storage.objects;
create policy "Admin or safety delete of fieldcred images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id in ('photos', 'badges', 'certificates')
    and public.current_fc_role() in ('admin', 'safety')
  );

-- =========================================================================
-- Plan limits — caps how many active workers (rows in `workers`) a tenant
-- can have, based on what they're sold on. Deliberately a separate table
-- from `settings`: that table is authenticated-writable from the Admin
-- screen, and a cap living there could be raised by any signed-in tenant
-- admin via a raw REST call. This table has no insert/update/delete policy
-- for `authenticated` at all — only the SQL editor (postgres/service_role,
-- which bypasses RLS) can change it. See supabase/PROVISIONING.md for how
-- to set it per tenant.
-- =========================================================================
create table if not exists public.plan_limits (
  id          int primary key default 1,
  plan_tier   text not null default 'unlimited',
  max_workers int, -- null = no cap
  updated_at  timestamptz not null default now(),
  constraint plan_limits_singleton check (id = 1)
);

insert into public.plan_limits (id, plan_tier, max_workers) values (1, 'unlimited', null)
on conflict (id) do nothing;

alter table public.plan_limits enable row level security;

drop policy if exists "Authenticated can read plan limits" on public.plan_limits;
create policy "Authenticated can read plan limits"
  on public.plan_limits for select
  to authenticated
  using (true);

-- Enforced server-side so it can't be bypassed by calling the REST API
-- directly with a valid session — the frontend also pre-checks this (see
-- js/pages/editProfile.js, js/components/importDialog.js) purely for
-- instant UI feedback, but this trigger is what actually guarantees it.
create or replace function public.enforce_worker_limit()
returns trigger language plpgsql as $$
declare
  cap int;
  current_count int;
begin
  select max_workers into cap from public.plan_limits where id = 1;
  if cap is null then
    return new;
  end if;

  select count(*) into current_count from public.workers;
  if current_count >= cap then
    raise exception 'Worker limit reached — this plan allows up to % active workers.', cap;
  end if;

  return new;
end;
$$;

drop trigger if exists workers_enforce_limit on public.workers;
create trigger workers_enforce_limit
  before insert on public.workers
  for each row execute function public.enforce_worker_limit();

-- =========================================================================
-- Sites + credential-type catalog (point 2: site/project-based credential
-- requirements). Certs are tagged with a credential_types id (a field on the
-- workers.certifications jsonb — no DDL here) so a site's required types can
-- be matched against a worker's certs. Anon/public views for the site-aware
-- gate are added separately (Phase C), not here. See
-- supabase/migrations/007_sites_and_credential_types.sql for the same
-- tables as a standalone migration for already-provisioned tenants.
-- =========================================================================
create table if not exists public.credential_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  issuer     text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists credential_types_name_key on public.credential_types (lower(name));

-- Role-aware: all authenticated roles read; only admin manages. Two permissive
-- policies — an open SELECT plus an admin-only ALL — so SELECT stays open while
-- INSERT/UPDATE/DELETE resolve to admin-only. See migration 010.
alter table public.credential_types enable row level security;
drop policy if exists "Authenticated manage credential types" on public.credential_types;
drop policy if exists "Roles can read credential types" on public.credential_types;
drop policy if exists "Admin manage credential types" on public.credential_types;
create policy "Roles can read credential types"
  on public.credential_types for select to authenticated using (true);
create policy "Admin manage credential types"
  on public.credential_types for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

create table if not exists public.sites (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  location    text not null default '',
  active      boolean not null default true,
  public_slug text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists sites_set_updated_at on public.sites;
create trigger sites_set_updated_at
  before update on public.sites
  for each row execute function public.set_updated_at();

alter table public.sites enable row level security;
drop policy if exists "Authenticated manage sites" on public.sites;
drop policy if exists "Roles can read sites" on public.sites;
drop policy if exists "Admin manage sites" on public.sites;
create policy "Roles can read sites"
  on public.sites for select to authenticated using (true);
create policy "Admin manage sites"
  on public.sites for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

create table if not exists public.site_required_types (
  site_id uuid not null references public.sites(id) on delete cascade,
  type_id uuid not null references public.credential_types(id) on delete cascade,
  primary key (site_id, type_id)
);

alter table public.site_required_types enable row level security;
drop policy if exists "Authenticated manage site requirements" on public.site_required_types;
drop policy if exists "Roles can read site requirements" on public.site_required_types;
drop policy if exists "Admin manage site requirements" on public.site_required_types;
create policy "Roles can read site requirements"
  on public.site_required_types for select to authenticated using (true);
create policy "Admin manage site requirements"
  on public.site_required_types for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

create table if not exists public.site_assignments (
  site_id     uuid not null references public.sites(id) on delete cascade,
  worker_id   uuid not null references public.workers(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (site_id, worker_id)
);

create index if not exists site_assignments_worker_idx on public.site_assignments (worker_id);

alter table public.site_assignments enable row level security;
drop policy if exists "Authenticated manage site assignments" on public.site_assignments;
drop policy if exists "Roles can read site assignments" on public.site_assignments;
drop policy if exists "Admin manage site assignments" on public.site_assignments;
create policy "Roles can read site assignments"
  on public.site_assignments for select to authenticated using (true);
create policy "Admin manage site assignments"
  on public.site_assignments for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

-- Public gate clearance lookup (Phase C). The ONLY anon-reachable path to site
-- data: returns a single active site by its exact public_slug plus the names of
-- its required credential types. SECURITY DEFINER so anon needs no table grants
-- and there's no list to enumerate; rosters, PII, inactive sites and locations
-- stay private. See supabase/migrations/008_public_gate_clearance.sql.
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

revoke all on function public.get_public_site(text) from public;
grant execute on function public.get_public_site(text) to anon, authenticated;

-- Gate scan audit log (roadmap point 4, "The moat"): logs every gate scan
-- with timestamp, result, and who scanned. See
-- supabase/migrations/009_gate_scan_log.sql for full rationale — site/worker
-- names are denormalized so the log stays readable after a rename/delete, and
-- record_gate_scan() computes clearance itself (fail-closed, mirrors
-- js/lib/clearance.js) rather than trusting a client-supplied result, since
-- it's a public/anon-reachable endpoint.
create table if not exists public.gate_scans (
  id            uuid primary key default gen_random_uuid(),
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

-- Readable by all three roles (admin/safety/gate). Every write still goes
-- through record_gate_scan() (SECURITY DEFINER), so there's no write policy.
alter table public.gate_scans enable row level security;
drop policy if exists "Authenticated read gate scans" on public.gate_scans;
drop policy if exists "Roles can read gate scans" on public.gate_scans;
create policy "Roles can read gate scans"
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

-- Demo seed data (8 sample workers) moved to seed_demo.sql — run that
-- separately, and only for local testing / demo tenants. Real tenant
-- projects provisioned from this file should start empty.
