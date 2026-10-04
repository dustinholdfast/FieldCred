// Hourly credential digest for one Neon tenant.
//
// Replaces supabase/functions/expiration-alerts. Run it from cron with the
// tenant's direct DATABASE_URL. This process uses the table owner role, so
// it is not an anonymous Data API call.
//
//   DATABASE_URL=... RESEND_API_KEY=... node neon/expiration-alerts.mjs
//   FORCE=1 node neon/expiration-alerts.mjs
//
// Requires the `pg` package (the billing service already depends on it):
//   NODE_PATH=billing-service/node_modules node neon/expiration-alerts.mjs

import pg from 'pg';

const RENEWAL_WINDOW_DAYS = 60;
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function daysUntil(isoDate) {
  const target = new Date(`${isoDate}T00:00:00Z`);
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function certStatus(isoExpiryDate) {
  const diff = daysUntil(isoExpiryDate);
  if (diff < 0) return 'expired';
  if (diff <= RENEWAL_WINDOW_DAYS) return 'expiring';
  return 'valid';
}

function localParts(timezone, date) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    hour: Number(parts.hour) % 24,
    dayOfWeek: WEEKDAY_INDEX[parts.weekday],
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function shouldSendNow(settings, now, force) {
  if (force) return { send: true };
  const tz = settings.timezone || 'UTC';
  const configuredHour = settings.digest_hour ?? 13;
  const local = localParts(tz, now);
  if (local.hour !== configuredHour) {
    return { send: false, reason: `not the configured hour (local hour ${local.hour}, configured ${configuredHour})` };
  }
  if ((settings.digest_cadence || 'daily') === 'weekly' && local.dayOfWeek !== (settings.digest_day_of_week ?? 1)) {
    return { send: false, reason: 'not the configured day' };
  }
  if (settings.last_digest_sent_at) {
    const lastKey = localParts(tz, new Date(settings.last_digest_sent_at)).dateKey;
    if (lastKey === local.dateKey) return { send: false, reason: 'already sent for this local date' };
  }
  return { send: true };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const settingsRes = await client.query(
    `select tenant_name, notification_email, timezone, digest_cadence, digest_day_of_week, digest_hour, last_digest_sent_at
       from public.settings where id = 1`
  );
  const settings = settingsRes.rows[0];
  if (!settings?.notification_email) {
    console.log(JSON.stringify({ skipped: 'no notification_email configured' }));
    process.exit(0);
  }
  const gate = shouldSendNow(settings, new Date(), process.env.FORCE === '1');
  if (!gate.send) {
    console.log(JSON.stringify({ skipped: gate.reason }));
    process.exit(0);
  }
  const workers = await client.query('select name, certifications from public.workers');
  const expiring = [];
  const expired = [];
  for (const w of workers.rows) {
    for (const c of w.certifications || []) {
      if (!c.expiryDate) continue;
      const status = certStatus(c.expiryDate);
      if (status === 'valid') continue;
      (status === 'expiring' ? expiring : expired).push({
        workerName: w.name,
        certName: c.name,
        expiryDate: c.expiryDate,
      });
    }
  }
  if (!expiring.length && !expired.length) {
    console.log(JSON.stringify({ skipped: 'nothing expiring or expired' }));
    process.exit(0);
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY is not set.');
    process.exit(1);
  }
  const from = process.env.RESEND_FROM_EMAIL || 'FieldCred Alerts <onboarding@resend.dev>';
  const lines = [...expired, ...expiring]
    .map((r) => `<li>${escapeHtml(r.workerName)} — ${escapeHtml(r.certName)} — ${escapeHtml(r.expiryDate)}</li>`)
    .join('');
  const html = `<div><h2>${escapeHtml(settings.tenant_name || 'FieldCred')} — Credential Alerts</h2><ul>${lines}</ul></div>`;
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: settings.notification_email,
      subject: `FieldCred: ${expired.length} expired, ${expiring.length} expiring`,
      html,
    }),
  });
  if (!resendRes.ok) {
    console.error(await resendRes.text());
    process.exit(1);
  }
  await client.query('update public.settings set last_digest_sent_at = now() where id = 1');
  console.log(JSON.stringify({ sent: true, expiring: expiring.length, expired: expired.length }));
} finally {
  await client.end();
}
