-- FieldCred schema for Neon (Lakebase Postgres + Data API + Neon Auth).
-- Apply once per tenant database AFTER Neon Auth and the Data API are enabled
-- on that branch. Those features create the authenticated/anonymous roles and
-- auth.user_id(). This file is the new-tenant baseline (the previous public
-- schema plus the live end state of migrations 011-014). It does not copy data.
--
-- Roles live in public.staff_roles, keyed by auth.user_id(), not in a JWT
-- app_metadata claim. A user with no row is 'unassigned' (no staff access).
-- Insert the first admin by hand:
--   insert into public.staff_roles (user_id, fc_role, email)
--   values ('<neon auth user id>', 'admin', 'you@example.com');
--
-- Files (photos, badges, logos, certificates) live in public.files. The
-- browser never receives a database password. Public objects are read through
-- file.php; certificates through a short-lived grant token.
--
create extension if not exists pgcrypto;


-- Neon Data API roles. Created by the Data API; these statements cover a
-- database where the roles already exist and a re-run.
do $$ begin
  create role anonymous nologin noinherit;
exception when duplicate_object then null;
end $$;
do $$ begin
  create role authenticated nologin noinherit;
exception when duplicate_object then null;
end $$;

-- Staff roles. Not user-editable except by an admin (RLS below). The helper
-- is security definer so it can read this table before the caller's own
-- policies would allow it, and so an unassigned session cannot grant itself
-- a role by writing a row.
create table if not exists public.staff_roles (
  user_id    text primary key,
  fc_role    text not null check (fc_role in ('admin', 'safety', 'gate')),
  email      text,
  updated_at timestamptz not null default now()
);

alter table public.staff_roles enable row level security;

create or replace function public.current_fc_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select r.fc_role
      from public.staff_roles r
      where r.user_id = auth.user_id()
    ),
    'unassigned'
  );
$$;

revoke all on function public.current_fc_role() from public;
grant execute on function public.current_fc_role() to authenticated;


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
returns trigger language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workers_set_updated_at on public.workers;
create trigger workers_set_updated_at
  before update on public.workers
  for each row execute function public.set_updated_at();

-- link_expires is user-entered-adjacent (set via the share dialog's date
-- picker, but stored as free text) — safe_to_date() means a malformed or
-- unexpected value can never throw and take the whole public_workers view
-- down with it; it just fails closed (null date compares false to "still
-- valid", so the row drops out of the public view instead).
create or replace function public.safe_to_date(txt text)
returns date language plpgsql immutable
set search_path = public
as $$
begin
  return txt::date;
exception when others then
  return null;
end;
$$;

-- =========================================================================
-- RLS — role-aware as of migration 010 (admin / safety / gate). See
-- current_fc_role() below for how the role is resolved. Contact info
-- (phone/email) lives here, so anonymous gets NO direct access — public sharing
-- goes through the public_workers view below instead, which exposes only
-- the safe columns.
-- =========================================================================
alter table public.workers enable row level security;

drop policy if exists "Roles can read all workers" on public.workers;
create policy "Roles can read all workers"
  on public.workers for select
  to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));

drop policy if exists "Admin or safety can insert workers" on public.workers;
create policy "Admin or safety can insert workers"
  on public.workers for insert
  to authenticated
  with check (public.current_fc_role() in ('admin', 'safety'));

drop policy if exists "Admin or safety can update workers" on public.workers;
create policy "Admin or safety can update workers"
  on public.workers for update
  to authenticated
  using (public.current_fc_role() in ('admin', 'safety'))
  with check (public.current_fc_role() in ('admin', 'safety'));

drop policy if exists "Admin can delete workers" on public.workers;
create policy "Admin can delete workers"
  on public.workers for delete
  to authenticated
  using (public.current_fc_role() = 'admin');

-- =========================================================================
-- Settings — a single-row table for tenant-level, editable-from-the-app
-- values: display name, notification email, logo, and the digest cadence
-- expiration-alerts uses. notification_email is not public — only
-- tenant_name/logo_url are, via the public_settings view below.
-- =========================================================================
create table if not exists public.settings (
  id                   int primary key default 1,
  tenant_name          text not null default 'FieldCred',
  notification_email   text,
  logo_url             text,
  timezone             text not null default 'UTC',
  digest_cadence       text not null default 'daily' check (digest_cadence in ('daily', 'weekly')),
  digest_day_of_week   int not null default 1 check (digest_day_of_week between 0 and 6), -- 0=Sun..6=Sat; only used when digest_cadence='weekly'
  digest_hour          int not null default 13 check (digest_hour between 0 and 23), -- 0-23, local to `timezone`
  last_digest_sent_at  timestamptz,
  updated_at           timestamptz not null default now(),
  constraint settings_singleton check (id = 1)
);

insert into public.settings (id, tenant_name) values (1, 'FieldCred')
on conflict (id) do nothing;

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

alter table public.settings enable row level security;

-- Admin-only read: notification_email and the digest cadence/day/hour are
-- not needed by safety or gate roles anywhere in the UI (editTenantSettings
-- is admin-only, js/lib/roles.js) — see migration 013 for the full
-- rationale. public_settings below (tenant_name + logo_url only) is what
-- every other role and the pre-login screen actually need.
drop policy if exists "Authenticated can read settings" on public.settings;
drop policy if exists "Roles can read settings" on public.settings;
create policy "Admin can read settings"
  on public.settings for select
  to authenticated
  using (public.current_fc_role() = 'admin');

drop policy if exists "Admin can update settings" on public.settings;
create policy "Admin can update settings"
  on public.settings for update
  to authenticated
  using (id = 1 and public.current_fc_role() = 'admin')
  with check (id = 1 and public.current_fc_role() = 'admin');

-- Anon-safe subset — just the display name + logo, read on the login screen
-- before anyone's authenticated.
create or replace view public.public_settings as
select tenant_name, logo_url from public.settings where id = 1;

grant select on public.public_settings to anonymous, authenticated;

-- =========================================================================
-- Public record view — what the /r/:slug page and QR code resolve through.
-- Deliberately omits phone/email. `updated_at` is exposed for an honest
-- "record updated <date>" freshness stamp. link_expires is enforced here,
-- not just decoratively — a row past its expiry drops out of the view
-- entirely. certifications is rebuilt field-by-field so only known-safe
-- keys are ever exposed publicly.
-- =========================================================================
create or replace view public.public_workers as
select
  id, name, title, department, location, photo_url, skills,
  (
    select coalesce(
      jsonb_agg(jsonb_build_object(
        'name', c.value ->> 'name',
        'issuer', c.value ->> 'issuer',
        -- Required by js/lib/clearance.js to match a cert to a site's
        -- required credential types. Omitting it (as this view did before
        -- migration 011) makes every anonymous gate verdict read "not cleared"
        -- while record_gate_scan() logs "cleared" for the same scan — see
        -- the long note in the gate companion migration.
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

grant select on public.public_workers to anonymous, authenticated;

-- =========================================================================
-- Files — replaces Supabase Storage. photos/badges/logos are world-readable
-- via get_public_file() (same exposure as a public bucket URL). certificates
-- are private: only create_file_grant() (a recognized staff role) mints a
-- short-lived token, and redeem_file_grant() is what file.php calls.
-- Direct table access is denied to anonymous and authenticated; the
-- functions are security definer.
-- =========================================================================
create table if not exists public.files (
  bucket       text not null check (bucket in ('photos', 'badges', 'certificates', 'logos')),
  path         text not null check (path ~ '^[A-Za-z0-9._-]{1,200}$'),
  content_type text not null,
  bytes        bytea not null,
  created_at   timestamptz not null default now(),
  primary key (bucket, path)
);

alter table public.files enable row level security;
revoke all on public.files from anonymous, authenticated;

create table if not exists public.file_grants (
  token      text primary key,
  path       text not null,
  expires_at timestamptz not null
);

alter table public.file_grants enable row level security;
revoke all on public.file_grants from anonymous, authenticated;

create or replace function public.upload_file(
  p_bucket text,
  p_path text,
  p_content_type text,
  p_data text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bytes bytea;
begin
  if public.current_fc_role() not in ('admin', 'safety') then
    raise exception 'permission denied for upload' using errcode = '42501';
  end if;
  if p_bucket not in ('photos', 'badges', 'certificates', 'logos') then
    raise exception 'unknown bucket %', p_bucket using errcode = '22023';
  end if;
  if p_path !~ '^[A-Za-z0-9._-]{1,200}$' then
    raise exception 'invalid file path' using errcode = '22023';
  end if;
  v_bytes := decode(p_data, 'base64');
  if octet_length(v_bytes) > 8000000 then
    raise exception 'file exceeds 8MB' using errcode = '54000';
  end if;
  insert into public.files (bucket, path, content_type, bytes)
  values (p_bucket, p_path, coalesce(nullif(btrim(p_content_type), ''), 'application/octet-stream'), v_bytes)
  on conflict (bucket, path) do update
    set content_type = excluded.content_type,
        bytes = excluded.bytes,
        created_at = now();
  return p_path;
end;
$$;

revoke all on function public.upload_file(text, text, text, text) from public;
grant execute on function public.upload_file(text, text, text, text) to authenticated;

create or replace function public.get_public_file(p_bucket text, p_path text)
returns table (content_type text, data text)
language sql
security definer
set search_path = public
as $$
  select f.content_type, encode(f.bytes, 'base64')
  from public.files f
  where f.bucket = p_bucket
    and f.path = p_path
    and f.bucket in ('photos', 'badges', 'logos');
$$;

revoke all on function public.get_public_file(text, text) from public;
grant execute on function public.get_public_file(text, text) to anonymous, authenticated;

create or replace function public.create_file_grant(p_path text, p_seconds int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
  v_seconds int;
begin
  if public.current_fc_role() not in ('admin', 'safety', 'gate') then
    raise exception 'permission denied for certificate' using errcode = '42501';
  end if;
  if not exists (select 1 from public.files f where f.bucket = 'certificates' and f.path = p_path) then
    raise exception 'certificate not found' using errcode = 'P0002';
  end if;
  v_seconds := least(greatest(coalesce(p_seconds, 300), 30), 3600);
  v_token := encode(gen_random_bytes(24), 'hex');
  insert into public.file_grants (token, path, expires_at)
  values (v_token, p_path, now() + make_interval(secs => v_seconds));
  return v_token;
end;
$$;

revoke all on function public.create_file_grant(text, int) from public;
grant execute on function public.create_file_grant(text, int) to authenticated;

create or replace function public.redeem_file_grant(p_token text)
returns table (content_type text, data text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_path text;
begin
  delete from public.file_grants where expires_at <= now();
  select g.path into v_path
  from public.file_grants g
  where g.token = p_token and g.expires_at > now();
  if v_path is null then
    return;
  end if;
  return query
  select f.content_type, encode(f.bytes, 'base64')
  from public.files f
  where f.bucket = 'certificates' and f.path = v_path;
end;
$$;

revoke all on function public.redeem_file_grant(text) from public;
grant execute on function public.redeem_file_grant(text) to anonymous, authenticated;

-- =========================================================================
-- Plan limits — caps how many active workers (rows in `workers`) a tenant
-- can have. No insert/update/delete policy for `authenticated` at all —
-- only the SQL editor (postgres/service_role, bypasses RLS) can change it.
-- See neon/README.md for how to set it per tenant.
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
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));

-- Enforced server-side so it can't be bypassed by calling the REST API
-- directly with a valid session.
create or replace function public.enforce_worker_limit()
returns trigger language plpgsql
set search_path = public
as $$
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
-- Credential-type catalog — the managed vocabulary that makes free-text cert
-- names matchable. Sites require entries from here; certs are tagged with
-- them (workers.certifications jsonb, a data/frontend concern, not DDL).
-- Uniqueness is case-insensitive.
-- =========================================================================
create table if not exists public.credential_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  issuer     text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists credential_types_name_key on public.credential_types (lower(name));

alter table public.credential_types enable row level security;
drop policy if exists "Authenticated manage credential types" on public.credential_types;
drop policy if exists "Roles can read credential types" on public.credential_types;
create policy "Roles can read credential types"
  on public.credential_types for select to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));
drop policy if exists "Admin manage credential types" on public.credential_types;
create policy "Admin manage credential types"
  on public.credential_types for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

-- =========================================================================
-- Sites — a jobsite or project. public_slug backs the site-aware public
-- gate (get_public_site() below).
-- =========================================================================
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
create policy "Roles can read sites"
  on public.sites for select to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));
drop policy if exists "Admin manage sites" on public.sites;
create policy "Admin manage sites"
  on public.sites for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

-- =========================================================================
-- Site requirements — which credential types a site demands. Join table so
-- clearance can be computed by joining worker certs -> types -> site
-- requirements. on delete cascade so removing a site or a type cleans up
-- its requirement rows.
-- =========================================================================
create table if not exists public.site_required_types (
  site_id uuid not null references public.sites(id) on delete cascade,
  type_id uuid not null references public.credential_types(id) on delete cascade,
  primary key (site_id, type_id)
);

alter table public.site_required_types enable row level security;
drop policy if exists "Authenticated manage site requirements" on public.site_required_types;
drop policy if exists "Roles can read site requirements" on public.site_required_types;
create policy "Roles can read site requirements"
  on public.site_required_types for select to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));
drop policy if exists "Admin manage site requirements" on public.site_required_types;
create policy "Admin manage site requirements"
  on public.site_required_types for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

-- =========================================================================
-- Roster — which workers are assigned to a site. Answers "is THIS site's
-- crew cleared?" and drives per-site readiness counts.
-- =========================================================================
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
create policy "Roles can read site assignments"
  on public.site_assignments for select to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));
drop policy if exists "Admin manage site assignments" on public.site_assignments;
create policy "Admin manage site assignments"
  on public.site_assignments for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

-- =========================================================================
-- Public gate clearance lookup — the ONE thing an unauthenticated visitor
-- can reach: a single active site (by exact public_slug) and the names of
-- the credential types it requires. SECURITY DEFINER so anonymous can call it
-- without any select grant on the underlying tables — there is no list to
-- enumerate. Rosters, worker PII, inactive sites, and locations are never
-- exposed. A missing/inactive slug returns no rows (fail-closed).
-- =========================================================================
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
grant execute on function public.get_public_site(text) to anonymous, authenticated;

-- =========================================================================
-- Manual lookup by name at the gate (companion app, migration 011) — the
-- fallback when a badge is damaged or left behind. Anon-reachable because a
-- gate device is a shared kiosk nobody signs in to.
--
-- This is the ONE place an anonymous caller can enumerate any roster, and it is
-- deliberately narrow: one active site by exact public_slug, only workers
-- assigned to it, only ones already visible in public_workers, only
-- name/title/department/slug, >= 2 characters, at most 25 rows. See the
-- full exposure rationale in migrations/011_gate_companion.sql before
-- widening any of those. Revoke from anonymous to turn the feature off.
--
-- Also rate-limited per site (migration 013) — no per-caller identity
-- exists to key on (callers are anonymous by design), so the cap is shared
-- across everyone hitting one site: generous for legitimate kiosk use,
-- tight enough to slow a scripted roster-enumeration attempt to a crawl.
-- =========================================================================
create table if not exists public.roster_lookup_throttle (
  site_id       uuid not null references public.sites(id) on delete cascade,
  window_start  timestamptz not null,
  request_count int not null default 0,
  primary key (site_id, window_start)
);

alter table public.roster_lookup_throttle enable row level security;
revoke all on public.roster_lookup_throttle from anonymous, authenticated;

create or replace function public.search_site_roster(p_site_slug text, p_query text)
returns table (public_slug text, name text, title text, department text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_window  timestamptz := date_trunc('hour', now()) + (floor(date_part('minute', now()) / 10) * interval '10 minutes');
  v_count   int;
  v_limit   constant int := 60; -- per site, per 10-minute window
begin
  select id into v_site_id from public.sites where public_slug = p_site_slug and active = true;
  if v_site_id is null then
    return;
  end if;

  insert into public.roster_lookup_throttle (site_id, window_start, request_count)
  values (v_site_id, v_window, 1)
  on conflict (site_id, window_start)
    do update set request_count = roster_lookup_throttle.request_count + 1
  returning request_count into v_count;

  delete from public.roster_lookup_throttle
  where site_id = v_site_id and window_start < v_window;

  if v_count > v_limit then
    raise exception 'roster lookup rate limit exceeded for this site — try again shortly'
      using errcode = '55000';
  end if;

  return query
  with q as (
    select nullif(btrim(coalesce(p_query, '')), '') as term
  ),
  -- Escape LIKE metacharacters before wrapping in %…%, or a query of '%'
  -- would match the whole roster — the bulk read the row cap exists to stop.
  esc as (
    select replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') as term
    from q where length(term) >= 2
  )
  select pw.public_slug, pw.name, pw.title, pw.department
  from public.site_assignments sa
  join public.public_workers pw on pw.id = sa.worker_id
  cross join esc
  where sa.site_id = v_site_id
    and (pw.name ilike '%' || esc.term || '%' escape '\'
      or pw.title ilike '%' || esc.term || '%' escape '\')
  order by pw.name
  limit 25;
end;
$$;

revoke all on function public.search_site_roster(text, text) from public;
grant execute on function public.search_site_roster(text, text) to anonymous, authenticated;

-- =========================================================================
-- Gate scan audit log — logs every gate scan (timestamp, result, missing
-- credentials) server-side. The only write path is record_gate_scan() below
-- (SECURITY DEFINER) — no direct insert/update/delete policy for anyone,
-- deliberately. Denormalized site/worker name+slug alongside the nullable
-- FK so the log reads correctly even after a site/worker is renamed or
-- removed.
-- =========================================================================
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
  direction     text not null default 'in' check (direction in ('in', 'out')),
  device_id     text,
  guard_label   text,
  scanned_at    timestamptz not null default now()
);

create index if not exists gate_scans_site_scanned_idx on public.gate_scans (site_id, scanned_at desc);
create index if not exists gate_scans_scanned_idx on public.gate_scans (scanned_at desc);
create index if not exists gate_scans_site_worker_scanned_idx
  on public.gate_scans (site_id, worker_id, scanned_at desc);

alter table public.gate_scans enable row level security;
drop policy if exists "Authenticated read gate scans" on public.gate_scans;
drop policy if exists "Roles can read gate scans" on public.gate_scans;
create policy "Roles can read gate scans"
  on public.gate_scans for select
  to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));

-- Re-derives clearance server-side from the same fail-closed rule as
-- js/lib/clearance.js — never trusts a client-supplied result, since this
-- is a public endpoint by design. Keep in sync with clearance.js if that
-- logic ever changes.
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
grant execute on function public.record_gate_scan(text, text, text, text, text) to anonymous, authenticated;





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
  select worker_id, worker_name, worker_slug, scanned_at as last_in_at
  from latest
  where direction = 'in'
  order by last_in_at desc;
$$;

revoke all on function public.site_on_site_now(uuid) from public;
grant execute on function public.site_on_site_now(uuid) to authenticated;

-- current_fc_role() is defined near the top of this file.

-- =========================================================================
-- Migration tracking — backs fleet-migrate.mjs (see PROVISIONING.md and
-- TENANCY-MODEL.md). Records which numbered delta files under migrations/
-- have been applied to THIS tenant's database, so "what's pending" is a
-- query against real state instead of a hand-maintained checklist.
-- Deliberately tracks only migrations/NNN_*.sql deltas, not schema.sql
-- itself — a tenant that exists at all necessarily already has the
-- baseline applied.
-- =========================================================================
create table if not exists public.schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

alter table public.schema_migrations enable row level security;
-- Deliberately no anonymous/authenticated policies — never queried over
-- PostgREST, only via the direct Postgres connection fleet-migrate.mjs and
-- provision-tenant.mjs use (which bypasses RLS regardless).

-- Demo seed data (8 sample workers) lives in seed_demo.sql — run that
-- separately, and only for local testing / demo tenants. Real tenant
-- projects provisioned from this file should start empty.

-- Views run as the owner so anonymous can read the curated columns without
-- a SELECT grant on the base tables (phone/email stay off the public path).
alter view public.public_workers set (security_invoker = false);
alter view public.public_settings set (security_invoker = false);

grant usage on schema public to anonymous, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- Lock the tables that must only be touched by security definer functions.
revoke all on public.files from authenticated;
revoke all on public.file_grants from authenticated;
revoke all on public.roster_lookup_throttle from authenticated;
revoke all on public.schema_migrations from authenticated;

grant select on public.public_workers, public.public_settings to anonymous;
grant execute on function public.get_public_site(text) to anonymous;
grant execute on function public.search_site_roster(text, text) to anonymous;
grant execute on function public.record_gate_scan(text, text, text, text, text) to anonymous;
grant execute on function public.get_public_file(text, text) to anonymous;
grant execute on function public.redeem_file_grant(text) to anonymous;

revoke execute on function public.current_fc_role() from anonymous;
revoke execute on function public.upload_file(text, text, text, text) from anonymous;
revoke execute on function public.create_file_grant(text, int) from anonymous;
revoke all on public.staff_roles from anonymous;

-- Admin manages role rows. The helper itself is definer, so this policy
-- cannot lock the helper out. No insert policy for a user's own id.
drop policy if exists "Admin manages staff roles" on public.staff_roles;
create policy "Admin manages staff roles"
  on public.staff_roles for all
  to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');
