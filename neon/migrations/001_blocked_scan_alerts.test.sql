-- Behaviour test for 001_blocked_scan_alerts.sql. Run against a THROWAWAY
-- database that has neon/schema.sql and the migration applied (plus an
-- auth.user_id() stub). Never against a tenant: it inserts and deletes rows.
--
--   psql -v ON_ERROR_STOP=1 -d <scratch db> -f neon/migrations/001_blocked_scan_alerts.test.sql
--
-- Each check raises an exception on failure; a clean run prints PASS lines.

\set QUIET on
set client_min_messages = notice;

do $$
declare
  v_site  uuid;
  v_site2 uuid;
  v_type  uuid;
  v_row   record;
  v_count int;
  v_old   uuid;
begin
  -- Fixture: a site that requires OSHA 30, a worker without it.
  insert into public.credential_types (name) values ('OSHA 30 (test)') returning id into v_type;
  insert into public.sites (name, location, public_slug) values ('North Gate (test)', 'Toledo, OH', 'north-gate-test') returning id into v_site;
  insert into public.sites (name, public_slug, alert_email) values ('East Gate (test)', 'east-gate-test', 'east-safety@example.com') returning id into v_site2;
  insert into public.site_required_types (site_id, type_id) values (v_site, v_type), (v_site2, v_type);
  insert into public.workers (name, public_slug) values ('Pat Lane (test)', 'pat-lane-test');
  update public.settings set notification_email = 'safety@example.com', timezone = 'America/New_York' where id = 1;

  -- A real blocked entry, written the way the gate writes it: as the
  -- anonymous Data API role through record_gate_scan().
  set local role anonymous;
  perform public.record_gate_scan('north-gate-test', 'pat-lane-test', 'in', 'gate-0123456789', 'M. Reyes');
  reset role;
  select count(*) into v_count from public.gate_scans where site_slug = 'north-gate-test' and result = 'blocked' and direction = 'in';
  if v_count <> 1 then raise exception 'FAIL: record_gate_scan did not log one blocked entry (got %)', v_count; end if;
  raise notice 'PASS record_gate_scan logs the blocked entry';

  -- No secret configured: nothing is released, and nothing is marked.
  select count(*) into v_count from public.claim_blocked_scan_alert('north-gate-test', 'pat-lane-test', 'a-secret-that-is-long-enough');
  if v_count <> 0 then raise exception 'FAIL: released a scan with no secret configured'; end if;
  raise notice 'PASS no secret configured releases nothing';

  insert into public.alert_hook_secret (id, secret_hash) values (1, digest('correct-horse-battery-staple', 'sha256'))
  on conflict (id) do update set secret_hash = excluded.secret_hash;

  -- Wrong or short secret: nothing released, scan stays claimable.
  select count(*) into v_count from public.claim_blocked_scan_alert('north-gate-test', 'pat-lane-test', 'wrong-secret-but-long-enough');
  if v_count <> 0 then raise exception 'FAIL: released a scan for a wrong secret'; end if;
  select count(*) into v_count from public.claim_blocked_scan_alert('north-gate-test', 'pat-lane-test', 'short');
  if v_count <> 0 then raise exception 'FAIL: released a scan for a short secret'; end if;
  select count(*) into v_count from public.gate_scans where site_slug = 'north-gate-test' and alert_sent_at is not null;
  if v_count <> 0 then raise exception 'FAIL: a rejected caller marked the scan as alerted'; end if;
  raise notice 'PASS wrong and short secrets release nothing';

  -- Anonymous role can call the function (the Worker uses an anonymous token)
  -- but cannot read the secret table.
  set local role anonymous;
  begin
    perform 1 from public.alert_hook_secret;
    raise exception 'FAIL: anonymous could read alert_hook_secret';
  exception when insufficient_privilege then null;
  end;
  select * into v_row from public.claim_blocked_scan_alert('north-gate-test', 'pat-lane-test', 'correct-horse-battery-staple');
  reset role;
  if v_row.scan_id is null then raise exception 'FAIL: correct secret released nothing'; end if;
  if v_row.recipient <> 'safety@example.com' then raise exception 'FAIL: recipient % should fall back to settings', v_row.recipient; end if;
  if v_row.site_name <> 'North Gate (test)' or v_row.site_location <> 'Toledo, OH' then raise exception 'FAIL: site fields %/%', v_row.site_name, v_row.site_location; end if;
  if v_row.worker_name <> 'Pat Lane (test)' then raise exception 'FAIL: worker name %', v_row.worker_name; end if;
  if v_row.missing_types->0->>'name' <> 'OSHA 30 (test)' then raise exception 'FAIL: missing types %', v_row.missing_types; end if;
  if v_row.device_id <> 'gate-0123456789' or v_row.guard_label <> 'M. Reyes' then raise exception 'FAIL: device/guard %/%', v_row.device_id, v_row.guard_label; end if;
  if v_row.timezone <> 'America/New_York' then raise exception 'FAIL: timezone %', v_row.timezone; end if;
  raise notice 'PASS correct secret releases the scan to the anonymous role, with settings fallback recipient';

  -- Once only.
  select count(*) into v_count from public.claim_blocked_scan_alert('north-gate-test', 'pat-lane-test', 'correct-horse-battery-staple');
  if v_count <> 0 then raise exception 'FAIL: the same scan was released twice'; end if;
  raise notice 'PASS each blocked scan is released once';

  -- A second blocked entry is a new alert; the per-site address wins.
  insert into public.gate_scans (site_id, site_slug, site_name, worker_slug, worker_name, result, missing_types, direction)
  values (v_site2, 'east-gate-test', 'East Gate (test)', 'pat-lane-test', 'Pat Lane (test)', 'blocked', '[{"id":"x","name":"OSHA 30 (test)"}]', 'in');
  select * into v_row from public.claim_blocked_scan_alert('east-gate-test', 'pat-lane-test', 'correct-horse-battery-staple');
  if v_row.recipient <> 'east-safety@example.com' then raise exception 'FAIL: per-site recipient not used (got %)', v_row.recipient; end if;
  raise notice 'PASS per-site alert_email overrides the tenant address';

  -- Not alertable: a cleared entry, a blocked exit, and a blocked entry older than 15 minutes.
  insert into public.gate_scans (site_id, site_slug, worker_slug, result, direction)
  values (v_site, 'north-gate-test', 'pat-lane-test', 'cleared', 'in'),
         (v_site, 'north-gate-test', 'pat-lane-test', 'blocked', 'out');
  insert into public.gate_scans (site_id, site_slug, worker_slug, result, direction, scanned_at)
  values (v_site, 'north-gate-test', 'pat-lane-test', 'blocked', 'in', now() - interval '20 minutes')
  returning id into v_old;
  select count(*) into v_count from public.claim_blocked_scan_alert('north-gate-test', 'pat-lane-test', 'correct-horse-battery-staple');
  if v_count <> 0 then raise exception 'FAIL: released a cleared entry, an exit, or a stale entry'; end if;
  raise notice 'PASS cleared entries, exits and entries older than 15 minutes are never released';

  -- Clean up the fixture.
  delete from public.gate_scans where site_slug in ('north-gate-test', 'east-gate-test');
  delete from public.workers where public_slug = 'pat-lane-test';
  delete from public.sites where public_slug in ('north-gate-test', 'east-gate-test');
  delete from public.credential_types where id = v_type;
  delete from public.alert_hook_secret;
  update public.settings set notification_email = null where id = 1;
  raise notice 'PASS all checks';
end $$;
