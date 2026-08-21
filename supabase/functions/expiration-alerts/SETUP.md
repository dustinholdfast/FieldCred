# Setting up expiration alert emails

This is per-tenant, like everything else in `supabase/` — repeat this for
each tenant project that wants alerts. Budget ~15 minutes.

The function runs on an hourly cron and decides, each run, whether it's this
tenant's configured moment to send — based on the timezone / cadence /
day-of-week / hour set in **Admin → Tenant settings**. So most hourly
invocations are deliberate no-ops; it sends at most one digest per tenant per
day (or per week).

## 1. Create a Resend account

1. [resend.com](https://resend.com) → sign up (free tier: 3,000 emails/month,
   100/day — plenty for this).
2. **API Keys** → **Create API Key** → copy it (starts with `re_`). You won't
   be able to see it again after leaving the page.
3. Sending domain: to start, you can send from Resend's shared test address
   (`onboarding@resend.dev` — already set in `index.ts`) with no setup. When
   you're ready for a real "from" address, **Domains** → add your domain →
   add the DNS records Resend gives you → wait for verification → then
   change `RESEND_FROM` in `index.ts` to something like
   `FieldCred Alerts <alerts@yourdomain.com>` and redeploy.

## 2. Deploy the Edge Function

1. Supabase Dashboard → **Edge Functions** → **Deploy a new function**.
2. Name it exactly `expiration-alerts` (the cron job in `CRON.sql` calls it
   by this name).
3. Paste the contents of `index.ts` in as the function body.
4. Deploy.
5. **Edge Functions → Manage secrets** → add `RESEND_API_KEY` with the key
   from step 1. (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already
   available to every function automatically — don't add those yourself.)

## 3. Schedule it (hourly)

Run `CRON.sql` in the SQL Editor, after filling in your project ref and
anon key (both explained inline in that file, same values as everywhere
else in this project's setup). It registers an **hourly** job named
`fieldcred-expiration-alerts` — hourly on purpose, so the function can fire
at whatever local hour each tenant picks. Don't switch it to daily.

## 4. Set the notification email + digest schedule

In the app itself: **Admin → Tenant settings**.

- **Notification email** — where alerts are sent. Leave it blank and the
  function no-ops (`"skipped: no notification_email configured"`) rather than
  erroring.
- **Timezone / cadence / day / hour** — when the digest goes out, in the
  tenant's own time zone. Defaults (from `schema.sql`) are `UTC`, `daily`,
  and hour `13`. These map to the `timezone`, `digest_cadence`,
  `digest_day_of_week`, and `digest_hour` columns on `settings`.

## 5. Test it without waiting for the schedule

Invoke with **`?force=true`** to bypass the timezone/cadence/hour gate:

```bash
curl -i -X POST 'https://<PROJECT_REF>.supabase.co/functions/v1/expiration-alerts?force=true' \
  -H 'Authorization: Bearer <ANON_KEY>' -H 'Content-Type: application/json' -d '{}'
```

(or the dashboard's Invoke button, with `?force=true` on the URL). It still
won't send if nothing is expiring/expired, so test against a tenant with real
data — the demo seed has both an expiring and an expired cert. Read the
function's **Logs** tab for the JSON response (`{"sent":true,...}`,
`{"skipped":...}`, or an error) rather than guessing from whether an email
arrived.

## Notes

- Only sends when there's something to report (at least one expiring or
  expired credential) — no "all clear" noise.
- Without `?force=true`, a run no-ops unless the current time matches the
  tenant's configured hour (and day, for weekly), and it hasn't already sent
  for that local date. So a normal manual invoke will usually log
  `"skipped: not the configured hour ..."` — that's expected, not a fault.
- The 60-day "expiring soon" window is hardcoded in `index.ts`
  (`RENEWAL_WINDOW_DAYS`) to match the app's own default — edit both if you
  want to change it, they're not shared code (the function can't import the
  app's JS modules since it's deployed as a single pasted file, not part of
  a repo checkout).
- If you hit `relation "cron.job" does not exist` or similar when running
  `CRON.sql`, the `pg_cron`/`pg_net` extensions likely aren't enabled yet —
  see step 1 of that file, or enable them via Database → Extensions in the
  dashboard first.
