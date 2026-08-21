-- Migration: credential-type catalog + sites + rosters — 2026-07-17
--
-- Foundation for point 2 (site/project-based credential requirements). Apply
-- ONCE per existing tenant project in the SQL Editor. New tenants get the same
-- tables from schema.sql. Idempotent — safe to re-run.
--
-- Depends on public.set_updated_at() and public.workers, both from schema.sql
-- (already present on every provisioned tenant).
--
-- NOTE — certs gain a `typeId`: matching a worker's certs to a site's required
-- credentials works by tagging each cert (in the workers.certifications jsonb)
-- with the id of a credential_types row. That's a data/frontend change, not
-- DDL, so there's nothing to run for it here — see the Phase A frontend work.
-- Public (anon) views for the site-aware gate are deliberately NOT in this
-- migration; they land in a later, separately reviewed migration (Phase C).

create extension if not exists pgcrypto;

-- =========================================================================
-- Credential-type catalog — the managed vocabulary that makes free-text cert
-- names matchable. Sites require entries from here; certs are tagged with
-- them. Authenticated admins manage it (single shared admin role, like the
-- rest of this schema). Uniqueness is case-insensitive so "OSHA 30" and
-- "osha 30" can't both exist.
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
create policy "Authenticated manage credential types"
  on public.credential_types for all
  to authenticated using (true) with check (true);

-- =========================================================================
-- Sites — a jobsite or project. public_slug is reserved for the site-aware
-- public gate (Phase C); it's set now so links are stable before that ships.
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
create policy "Authenticated manage sites"
  on public.sites for all
  to authenticated using (true) with check (true);

-- =========================================================================
-- Site requirements — which credential types a site demands. Join table
-- (not a jsonb array on sites) because clearance is computed by joining
-- worker certs -> types -> site requirements, and a real relation keeps that
-- query and the readiness counts straightforward. on delete cascade so
-- removing a site or a type cleans up its requirement rows.
-- =========================================================================
create table if not exists public.site_required_types (
  site_id uuid not null references public.sites(id) on delete cascade,
  type_id uuid not null references public.credential_types(id) on delete cascade,
  primary key (site_id, type_id)
);

alter table public.site_required_types enable row level security;
drop policy if exists "Authenticated manage site requirements" on public.site_required_types;
create policy "Authenticated manage site requirements"
  on public.site_required_types for all
  to authenticated using (true) with check (true);

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
create policy "Authenticated manage site assignments"
  on public.site_assignments for all
  to authenticated using (true) with check (true);
