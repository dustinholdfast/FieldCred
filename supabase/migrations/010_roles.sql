-- Migration: real roles — admin / safety / gate — 2026-07-17
--
-- Closes the gap with the marketing site's "admin, safety, and gate roles"
-- claim. Until now every signed-in user was a full admin. Apply ONCE per
-- existing tenant project in the SQL Editor. New tenants get the same
-- policies from schema.sql. Idempotent — safe to re-run.
--
-- Depends on the tables from migrations 007-009 (sites, credential_types,
-- site_required_types, site_assignments, gate_scans) plus workers/settings
-- from schema.sql — i.e. a tenant that's current through 009, which every
-- live tenant is. It only redefines policies; it adds no tables or columns.
--
-- DEPLOY ORDER (see supabase/PROVISIONING.md "Roles"): apply this to the demo
-- tenant first, verify, then other live tenants, THEN deploy the frontend.
-- The reverse is unsafe: making RLS strict for a role the OLD frontend still
-- assumes can write would break that frontend. This migration on its own,
-- with the old frontend, is harmless — every existing user has no fc_role and
-- so resolves to 'admin' (see the coalesce below), i.e. today's behavior.
--
-- WHERE ROLES LIVE: in Supabase auth **app_metadata**, key `fc_role`
-- ({"fc_role":"safety"}), NOT user_metadata. app_metadata is not editable by
-- the user via the client — that's the entire point; a user must never be
-- able to promote their own role. Roles are assigned from the dashboard or
-- the Admin API (no in-app UI in v1). See PROVISIONING.md.
--
--   | role   | can                                                          |
--   |--------|--------------------------------------------------------------|
--   | admin  | everything (today's behavior)                                |
--   | safety | read all; create/edit workers+certs; view scan log. NOT:     |
--   |        | delete workers, change settings, manage sites/types, users   |
--   | gate   | read-only directory + scan log                               |
--
-- Enforcement is server-side here. The frontend (js/lib/roles.js) only hides
-- controls; this file is what actually stops a hidden/forged request.

-- =========================================================================
-- Role helper. Reads fc_role off the JWT's app_metadata, defaulting to
-- 'admin' so every existing user (no fc_role) keeps full access on deploy
-- day without having to touch a single user record first.
--
-- NOT named current_role(): that collides with the SQL reserved word
-- `current_role`, which the parser resolves to the built-in even when a
-- same-named function exists in the search path. current_fc_role() is
-- unambiguous everywhere it's referenced below.
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

-- =========================================================================
-- workers — per-verb policies. Read: all three roles. Insert/update: admin
-- + safety. Delete: admin only.
-- =========================================================================
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
-- settings — everyone reads (tenant name etc.), only admin updates.
-- =========================================================================
-- SELECT policy unchanged (all authenticated read); re-created for idempotency.
drop policy if exists "Authenticated can read settings" on public.settings;
create policy "Authenticated can read settings"
  on public.settings for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can update settings" on public.settings;
drop policy if exists "Admin can update settings" on public.settings;
create policy "Admin can update settings"
  on public.settings for update
  to authenticated
  using (id = 1 and public.current_fc_role() = 'admin')
  with check (id = 1 and public.current_fc_role() = 'admin');

-- =========================================================================
-- sites / site_required_types / site_assignments / credential_types —
-- managed by admin only; readable by all authenticated roles. Two permissive
-- policies per table: an open SELECT, plus an admin-only ALL. RLS OR's
-- permissive policies, so SELECT stays open to everyone while
-- INSERT/UPDATE/DELETE resolve to admin-only (the open SELECT doesn't apply
-- to those verbs). Replaces the single blanket "Authenticated manage X" ALL
-- policy from migration 007.
-- =========================================================================
drop policy if exists "Authenticated manage sites" on public.sites;
drop policy if exists "Roles can read sites" on public.sites;
drop policy if exists "Admin manage sites" on public.sites;
create policy "Roles can read sites"
  on public.sites for select to authenticated using (true);
create policy "Admin manage sites"
  on public.sites for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

drop policy if exists "Authenticated manage credential types" on public.credential_types;
drop policy if exists "Roles can read credential types" on public.credential_types;
drop policy if exists "Admin manage credential types" on public.credential_types;
create policy "Roles can read credential types"
  on public.credential_types for select to authenticated using (true);
create policy "Admin manage credential types"
  on public.credential_types for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

drop policy if exists "Authenticated manage site requirements" on public.site_required_types;
drop policy if exists "Roles can read site requirements" on public.site_required_types;
drop policy if exists "Admin manage site requirements" on public.site_required_types;
create policy "Roles can read site requirements"
  on public.site_required_types for select to authenticated using (true);
create policy "Admin manage site requirements"
  on public.site_required_types for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

drop policy if exists "Authenticated manage site assignments" on public.site_assignments;
drop policy if exists "Roles can read site assignments" on public.site_assignments;
drop policy if exists "Admin manage site assignments" on public.site_assignments;
create policy "Roles can read site assignments"
  on public.site_assignments for select to authenticated using (true);
create policy "Admin manage site assignments"
  on public.site_assignments for all to authenticated
  using (public.current_fc_role() = 'admin')
  with check (public.current_fc_role() = 'admin');

-- =========================================================================
-- gate_scans — SELECT stays open to all three roles (unchanged; every write
-- still goes through record_gate_scan(), SECURITY DEFINER). Re-created for
-- idempotency / documentation.
-- =========================================================================
drop policy if exists "Authenticated read gate scans" on public.gate_scans;
drop policy if exists "Roles can read gate scans" on public.gate_scans;
create policy "Roles can read gate scans"
  on public.gate_scans for select
  to authenticated using (true);

-- =========================================================================
-- Storage — writing worker photos / badge thumbnails / certificate PDFs
-- requires admin or safety (they create/edit workers and certs). Gate is
-- read-only; public read of these buckets is unchanged (needed for the
-- public record page). Replaces the "Authenticated {upload,update,delete}"
-- policies from schema.sql.
-- =========================================================================
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
