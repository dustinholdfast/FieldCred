-- Migration 006 — configurable digest cadence, timezone, and dedup
-- Apply to tenants provisioned before this change. Safe to re-run.
-- Fresh projects get this automatically via schema.sql (kept in sync).
--
-- Phase 3 (FIELDCRED-REMAINING-PLAN.md): the expiration-alerts Edge
-- Function was daily, hardcoded to 13:00 UTC, with no dedup beyond "it's
-- scheduled once a day so duplicates can't happen" (see that function's
-- SETUP.md — true today, not once cadence becomes configurable and the
-- cron tick has to run more often than the chosen send time). This adds
-- the settings the function now reads to decide, per invocation, whether
-- it's actually time to send for this tenant, plus a recorded last-sent
-- timestamp so a more-frequent cron tick can't double-send.
--
-- Defaults reproduce the exact previous hardcoded behavior (daily, 13:00
-- UTC) — an existing tenant that never touches the new Admin settings
-- sees no change until CRON.sql is updated to the more frequent tick and
-- the new index.ts is deployed.

alter table public.settings add column if not exists timezone text not null default 'UTC';
alter table public.settings add column if not exists digest_cadence text not null default 'daily';
alter table public.settings add column if not exists digest_day_of_week int not null default 1; -- 0=Sun..6=Sat; only used when digest_cadence='weekly'
alter table public.settings add column if not exists digest_hour int not null default 13; -- 0-23, local to `timezone`
alter table public.settings add column if not exists last_digest_sent_at timestamptz;

alter table public.settings drop constraint if exists settings_digest_cadence_check;
alter table public.settings add constraint settings_digest_cadence_check
  check (digest_cadence in ('daily', 'weekly'));

alter table public.settings drop constraint if exists settings_digest_day_of_week_check;
alter table public.settings add constraint settings_digest_day_of_week_check
  check (digest_day_of_week between 0 and 6);

alter table public.settings drop constraint if exists settings_digest_hour_check;
alter table public.settings add constraint settings_digest_hour_check
  check (digest_hour between 0 and 23);
