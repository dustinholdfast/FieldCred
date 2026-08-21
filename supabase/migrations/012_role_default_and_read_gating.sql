-- Migration 012: close the fail-open admin-by-default role, and stop gating
-- reads on "authenticated" alone — 2026-07-22.
--
-- Two changes, same root cause:
--
--   1. current_fc_role() used to default an absent fc_role claim to
--      'admin'. That was fine when the only way to get a JWT was Dustin
--      adding you by hand (PROVISIONING.md step 3), but it also silently
--      grants admin to:
--        - anyone who signs up directly against this project's
--          /auth/v1/signup with the public anon key, if Supabase's
--          self-service signup is still enabled for this project (see
--          PROVISIONING.md's updated step 1.2 — disable it per tenant), and
--        - anyone re-invited into this project via provision-tenant.mjs's
--          resume path with a mismatched email (see that script's updated
--          finishFromExistingProject guard).
--      This migration changes the default to 'unassigned' — a role with NO
--      grants anywhere below. A stray/attacker-created account is now
--      powerless instead of a full admin.
--
--   2. Several tables had a blanket `using (true)` SELECT policy scoped only
--      to `to authenticated` — i.e. ANY signed-in session, regardless of
--      role, could read workers' phone/email/certifications, settings,
--      sites, etc. That was originally fine too, back when "authenticated"
--      and "admin" were the same thing by default. Now that an
--      authenticated session can legitimately be 'unassigned' (an
--      unprivileged account), those policies need to actually check for a
--      recognized role, not just "signed in at all".
--
-- ============================================================================
-- REQUIRED BEFORE APPLYING THIS to any tenant with existing users: run this
-- once in that project's SQL Editor FIRST. It backfills fc_role='admin' onto
-- every existing user who has never had the claim set — i.e. it preserves
-- today's behavior for every real user you already provisioned, so nobody
-- gets locked out when the default below changes out from under them on
-- their next token refresh.
--
--   update auth.users
--   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"fc_role":"admin"}'::jsonb
--   where raw_app_meta_data->>'fc_role' is null;
--
-- Apply to the demo tenant first, verify login still works for the demo
-- admin, then every other live tenant, same deploy order as migration 010.
--
-- Every drop/create pair below drops both this migration's target policy
-- name AND whatever name migration 010 originally used for that table, so
-- this is safe to re-run even against a tenant whose live state has drifted
-- from what the numbered migration files alone would produce (e.g. a policy
-- renamed by hand at some point). If a fresh run still fails on a policy
-- name this file doesn't already account for, check the actual policy list
-- on that table (`select policyname from pg_policies where tablename =
-- '<table>'`) and drop the unexpected one before retrying.
-- ============================================================================

-- =========================================================================
-- Role helper. No longer defaults to 'admin' — an absent/unrecognized
-- fc_role now resolves to 'unassigned', which matches none of the
-- role-gated policies below or in migration 010 (they all check for
-- 'admin'/'safety'/'gate' explicitly), so an unassigned session gets
-- nothing beyond what an anonymous visitor could already get from the
-- public views/RPCs.
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
    'unassigned'
  );
$$;

revoke all on function public.current_fc_role() from public;
grant execute on function public.current_fc_role() to authenticated;
revoke execute on function public.current_fc_role() from anon;

-- =========================================================================
-- workers — SELECT now requires a recognized role, not just "authenticated".
-- Insert/update/delete policies from migration 010 are unchanged (they
-- already checked current_fc_role()).
-- =========================================================================
drop policy if exists "Roles can read all workers" on public.workers;
create policy "Roles can read all workers"
  on public.workers for select
  to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));

-- =========================================================================
-- settings — SELECT now requires a recognized role. (Splitting this further
-- into an admin-only full table + a narrow view for safety/gate is tracked
-- separately — this migration only closes the "any signed-in session"
-- gap, it doesn't yet scope safety/gate down to the minimal fields.)
-- =========================================================================
drop policy if exists "Authenticated can read settings" on public.settings;
drop policy if exists "Roles can read settings" on public.settings;
create policy "Roles can read settings"
  on public.settings for select
  to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));

-- =========================================================================
-- sites / credential_types / site_required_types / site_assignments —
-- same change: SELECT requires a recognized role instead of bare
-- "authenticated". ALL (admin-only) policies from migration 010 unchanged.
-- =========================================================================
drop policy if exists "Roles can read sites" on public.sites;
create policy "Roles can read sites"
  on public.sites for select to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));

drop policy if exists "Roles can read credential types" on public.credential_types;
create policy "Roles can read credential types"
  on public.credential_types for select to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));

drop policy if exists "Roles can read site requirements" on public.site_required_types;
create policy "Roles can read site requirements"
  on public.site_required_types for select to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));

drop policy if exists "Roles can read site assignments" on public.site_assignments;
create policy "Roles can read site assignments"
  on public.site_assignments for select to authenticated
  using (public.current_fc_role() in ('admin', 'safety', 'gate'));

-- =========================================================================
-- gate_scans — same change. Writes still only ever happen through
-- record_gate_scan() (SECURITY DEFINER), unaffected by this migration.
-- =========================================================================
drop policy if exists "Roles can read gate scans" on public.gate_scans;
create policy "Roles can read gate scans"
  on public.gate_scans for select
  to authenticated using (public.current_fc_role() in ('admin', 'safety', 'gate'));
