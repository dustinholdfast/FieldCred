-- Schedules the expiration-alerts Edge Function. Runs HOURLY by design: the
-- function self-gates on each tenant's own timezone / cadence / hour (see the
-- header of index.ts) and only actually sends at that tenant's configured
-- local hour, so it must be invoked every hour and left to decide. A
-- once-a-day schedule would only fire at a single UTC moment and miss any
-- tenant whose configured local hour didn't line up with it.
--
-- Run this in the SQL Editor AFTER the function is deployed. This matches the
-- live job (jobname 'fieldcred-expiration-alerts', schedule '0 * * * *').

-- Enable the two extensions (safe to run even if already enabled):
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace both placeholders below before running:
--   <PROJECT_REF>  — from your project URL, https://<PROJECT_REF>.supabase.co
--   <ANON_KEY>     — Project Settings -> API -> anon public key (same one in tenants.php)
select cron.schedule(
  'fieldcred-expiration-alerts',
  '0 * * * *', -- top of every hour (UTC). The function no-ops except at each tenant's configured local hour.
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/expiration-alerts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <ANON_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To check it's registered:
select jobid, jobname, schedule, active from cron.job where jobname = 'fieldcred-expiration-alerts';

-- To remove it later:
-- select cron.unschedule('fieldcred-expiration-alerts');
