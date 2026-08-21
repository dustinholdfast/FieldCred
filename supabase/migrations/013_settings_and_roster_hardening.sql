-- Migration 013: settings least-privilege split, and a DB-level rate limit
-- on search_site_roster() — 2026-07-22. Resumes the security-review items
-- paused mid-Stripe-launch work; see PROVISIONING.md for the full list.
--
-- PART 1 — settings least privilege.
-- All three roles could previously SELECT the full settings row, including
-- notification_email (an internal contact address) and the digest
-- cadence/day/hour/timezone. Nothing in the UI reads these outside the
-- admin-only settings screen (editTenantSettings capability, js/lib/roles.js)
-- — safety and gate have no legitimate reason to see them, and UPDATE was
-- already admin-only. Restricting SELECT closes the gap between "the UI
-- hides it" and "the database actually enforces it." public_settings
-- (tenant_name + logo_url only) is untouched — that's what the pre-login
-- screen and every role's top nav need, and stays anon+authenticated
-- readable.
drop policy if exists "Authenticated can read settings" on public.settings;
drop policy if exists "Roles can read settings" on public.settings;
create policy "Admin can read settings"
  on public.settings for select
  to authenticated
  using (public.current_fc_role() = 'admin');

-- PART 2 — search_site_roster() rate limiting.
-- Migration 011 scoped this anon RPC tightly (one active site, only workers
-- assigned to it, only ones already public, name/title/department only,
-- 2-char minimum, 25-row cap) but never bounded CALL VOLUME. Nothing stopped
-- a scripted caller from issuing thousands of two-letter queries against a
-- known gate slug (printed on a QR at the gate — not a secret) to
-- reconstruct a site's roster piece by piece over time. This adds a blunt,
-- per-site throttle. There's no per-caller identity to key on — callers are
-- anon by design — so the cap is shared across everyone hitting one site,
-- which is the right shape for a kiosk feature: a busy gate doing
-- legitimate manual lookups all shift stays well under it, while a scripted
-- enumeration attempt hits the wall in minutes instead of finishing in
-- minutes.
create table if not exists public.roster_lookup_throttle (
  site_id       uuid not null references public.sites(id) on delete cascade,
  window_start  timestamptz not null,
  request_count int not null default 0,
  primary key (site_id, window_start)
);

-- No client ever reads or writes this directly — only search_site_roster()
-- below (SECURITY DEFINER) touches it. Locking it down anyway rather than
-- leaving it ungranted-by-omission.
alter table public.roster_lookup_throttle enable row level security;
revoke all on public.roster_lookup_throttle from anon, authenticated;

create or replace function public.search_site_roster(p_site_slug text, p_query text)
returns table (public_slug text, name text, title text, department text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  -- 10-minute fixed window, bucketed off the hour.
  v_window  timestamptz := date_trunc('hour', now()) + (floor(date_part('minute', now()) / 10) * interval '10 minutes');
  v_count   int;
  -- 60 lookups per site per 10-minute window: generous for a guard typing
  -- names all shift (a handful a minute, in bursts), tight enough that
  -- enumerating a roster takes hours per site instead of minutes. Revisit
  -- if a real tenant's usage pattern needs headroom.
  v_limit   constant int := 60;
begin
  select id into v_site_id from public.sites where public_slug = p_site_slug and active = true;
  -- Unknown/inactive site: behave exactly as before (empty result), and
  -- don't spend a throttle row on a slug that was never real — someone
  -- probing random slugs shouldn't be able to grow this table.
  if v_site_id is null then
    return;
  end if;

  insert into public.roster_lookup_throttle (site_id, window_start, request_count)
  values (v_site_id, v_window, 1)
  on conflict (site_id, window_start)
    do update set request_count = roster_lookup_throttle.request_count + 1
  returning request_count into v_count;

  -- Sweep old windows on write rather than a separate cron job — this table
  -- only ever holds a handful of rows per site, so a scan here is cheap and
  -- there's nothing extra to schedule or maintain.
  delete from public.roster_lookup_throttle
  where site_id = v_site_id and window_start < v_window;

  if v_count > v_limit then
    -- Distinct SQLSTATE from 42501 (permission denied) and from an actual
    -- connection failure, so the client (js/pages/gateApp.js) can eventually
    -- tell "your role can't do this" apart from "no signal" apart from
    -- "slow down" — see roleFromSession()/isPermissionError() in
    -- js/lib/roles.js, which this deliberately does not reuse.
    raise exception 'roster lookup rate limit exceeded for this site — try again shortly'
      using errcode = '55000';
  end if;

  return query
  with q as (
    select nullif(btrim(coalesce(p_query, '')), '') as term
  ),
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
grant execute on function public.search_site_roster(text, text) to anon, authenticated;
