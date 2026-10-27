-- 001 — Blocked-scan alerts.
--
-- Apply once to each existing tenant database (Neon SQL Editor, or psql with
-- that tenant's direct DATABASE_URL). Idempotent: safe to re-run. New tenants
-- get the same objects from neon/schema.sql.
--
-- When a gate turns a worker away, the gate app asks the Worker
-- (POST /api/scan-alert) to email the site's alert address. The Worker claims
-- the scan through claim_blocked_scan_alert() below, which:
--   - only answers a caller holding the shared alert-hook secret. The Data API
--     is public and the gate device is anonymous, so without the secret anyone
--     could read a refused worker's name, missing credentials and the alert
--     address;
--   - releases each blocked entry at most once (alert_sent_at), so the route
--     cannot be used to send repeat emails;
--   - only releases entries from the last 15 minutes.
--
-- After applying, set the secret (the same value as the Worker's
-- ALERT_HOOK_SECRET; see DEPLOY.md):
--   insert into public.alert_hook_secret (id, secret_hash)
--   values (1, digest('<the secret>', 'sha256'))
--   on conflict (id) do update set secret_hash = excluded.secret_hash;

create extension if not exists pgcrypto;

-- Per-site recipient. Blank falls back to settings.notification_email.
alter table public.sites add column if not exists alert_email text;

-- Set when an alert for this scan has been claimed (sent or attempted).
alter table public.gate_scans add column if not exists alert_sent_at timestamptz;

create table if not exists public.alert_hook_secret (
  id          int primary key default 1,
  secret_hash bytea not null,
  constraint alert_hook_secret_singleton check (id = 1)
);
alter table public.alert_hook_secret enable row level security;
revoke all on public.alert_hook_secret from anonymous, authenticated;

create or replace function public.claim_blocked_scan_alert(
  p_site_slug   text,
  p_worker_slug text,
  p_secret      text
)
returns table (
  scan_id       uuid,
  site_id       uuid,
  site_name     text,
  site_location text,
  worker_name   text,
  missing_types jsonb,
  scanned_at    timestamptz,
  device_id     text,
  guard_label   text,
  recipient     text,
  timezone      text
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_hash  bytea;
  v_scan  public.gate_scans%rowtype;
  v_site  public.sites%rowtype;
  v_email text;
  v_tz    text;
begin
  select s.secret_hash into v_hash from public.alert_hook_secret s where s.id = 1;
  if v_hash is null or p_secret is null or length(p_secret) < 16
     or digest(p_secret, 'sha256') <> v_hash then
    return;
  end if;

  select gs.* into v_scan
  from public.gate_scans gs
  where gs.site_slug = p_site_slug
    and gs.worker_slug = p_worker_slug
    and gs.result = 'blocked'
    and gs.direction = 'in'
    and gs.alert_sent_at is null
    and gs.scanned_at >= now() - interval '15 minutes'
  order by gs.scanned_at desc
  limit 1
  for update skip locked;
  if not found then
    return;
  end if;

  update public.gate_scans set alert_sent_at = now() where id = v_scan.id;

  select * into v_site from public.sites where id = v_scan.site_id;
  select nullif(btrim(coalesce(st.notification_email, '')), ''), st.timezone
    into v_email, v_tz
  from public.settings st where st.id = 1;

  return query select
    v_scan.id,
    v_scan.site_id,
    coalesce(v_site.name, v_scan.site_name),
    coalesce(v_site.location, ''),
    v_scan.worker_name,
    v_scan.missing_types,
    v_scan.scanned_at,
    v_scan.device_id,
    v_scan.guard_label,
    coalesce(nullif(btrim(coalesce(v_site.alert_email, '')), ''), v_email),
    coalesce(v_tz, 'UTC');
end;
$$;

revoke all on function public.claim_blocked_scan_alert(text, text, text) from public;
grant execute on function public.claim_blocked_scan_alert(text, text, text) to anonymous, authenticated;
