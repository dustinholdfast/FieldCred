// FieldCred — expiration alert emails.
//
// Runs on an hourly pg_cron tick (see CRON.sql) and, per invocation, checks
// whether it's actually this tenant's configured moment to send — cadence
// (daily/weekly), day-of-week, hour, all local to the tenant's chosen time
// zone (Admin -> Tenant settings). If so, scans this tenant's workers for
// certifications that are expiring soon or already expired, and emails a
// summary to whatever address is set in Notification email. If that field
// is blank, or it isn't time yet, this is a no-op.
//
// Cadence moved from the pg_cron schedule itself (was a fixed daily
// 13:00 UTC) into this function's own gate, because pg_cron's schedule is
// one fixed expression for the whole project — it can't natively express
// "whatever time each tenant picks in their own time zone." Running hourly
// and gating here is the tradeoff: more invocations, but the schedule
// becomes per-tenant-configurable without touching cron.job at all.
//
// Dedup: `settings.last_digest_sent_at` records the last successful send.
// Since this now runs hourly instead of once a day, a naive gate would
// re-send every hour throughout the tenant's chosen hour unless dedup were
// separate from the hour check — comparing local *dates* (not exact
// timestamps) handles daily and weekly cadences with the same check: "have
// I already sent today?"
//
// Testing without waiting for the schedule: invoke with ?force=true (Edge
// Functions -> Invoke, or curl) to bypass the cadence/dedup gate — it still
// won't send if there's nothing expiring/expired (see below), so test
// against a tenant with real data (the demo tenant's seed data has both an
// expiring and an expired cert already).
//
// Deploy: Supabase Dashboard -> Edge Functions -> Deploy a new function ->
// name it "expiration-alerts" -> paste this file in as index.ts.
// Needs one secret set (Edge Functions -> Manage secrets): RESEND_API_KEY.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically —
// don't set those yourself.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RENEWAL_WINDOW_DAYS = 60; // matches the app's own "expiring soon" window
const RESEND_FROM = 'FieldCred Alerts <onboarding@resend.dev>'; // swap once you verify your own sending domain in Resend

function daysUntil(isoDate: string): number {
  const target = new Date(isoDate + 'T00:00:00Z');
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function certStatus(isoExpiryDate: string): 'valid' | 'expiring' | 'expired' {
  const diff = daysUntil(isoExpiryDate);
  if (diff < 0) return 'expired';
  if (diff <= RENEWAL_WINDOW_DAYS) return 'expiring';
  return 'valid';
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Local hour/day-of-week/date for a tenant's chosen time zone, so cadence
// can be gated in their terms rather than UTC. A bad/unknown IANA name
// falls back to UTC (Intl throws on construction, not per-call, so this is
// checked once) rather than crashing the whole invocation.
function localParts(timezone: string, date: Date) {
  let fmt: Intl.DateTimeFormat;
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
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value])) as Record<string, string>;
  return {
    hour: Number(parts.hour) % 24, // some engines report midnight as "24" with hour12:false
    dayOfWeek: WEEKDAY_INDEX[parts.weekday],
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

interface Settings {
  tenant_name: string | null;
  notification_email: string | null;
  timezone: string | null;
  digest_cadence: string | null;
  digest_day_of_week: number | null;
  digest_hour: number | null;
  last_digest_sent_at: string | null;
}

function shouldSendNow(settings: Settings, now: Date, force: boolean): { send: boolean; reason?: string } {
  if (force) return { send: true };

  const tz = settings.timezone || 'UTC';
  const configuredHour = settings.digest_hour ?? 13;
  const configuredCadence = settings.digest_cadence || 'daily';
  const configuredDay = settings.digest_day_of_week ?? 1;
  const local = localParts(tz, now);

  if (local.hour !== configuredHour) {
    return { send: false, reason: `not the configured hour (local hour ${local.hour}, configured ${configuredHour})` };
  }
  if (configuredCadence === 'weekly' && local.dayOfWeek !== configuredDay) {
    return { send: false, reason: `not the configured day (local day ${local.dayOfWeek}, configured ${configuredDay})` };
  }
  if (settings.last_digest_sent_at) {
    const lastSentDateKey = localParts(tz, new Date(settings.last_digest_sent_at)).dateKey;
    if (lastSentDateKey === local.dateKey) {
      return { send: false, reason: 'already sent for this local date (dedup)' };
    }
  }
  return { send: true };
}

function buildEmailHtml(tenantName: string, expiring: Row[], expired: Row[]): string {
  const rowsHtml = (rows: Row[], color: string) =>
    rows
      .map(
        (r) => `<tr>
          <td style="padding:6px 10px;border-bottom:1px solid #eef1f4;">${escapeHtml(r.workerName)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eef1f4;">${escapeHtml(r.certName)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eef1f4;color:${color};font-weight:600;">${formatDate(r.expiryDate)}</td>
        </tr>`
      )
      .join('');

  return `
    <div style="font-family:sans-serif;color:#1c2430;max-width:560px;">
      <h2 style="color:#0f2148;">${escapeHtml(tenantName)} — Credential Alerts</h2>
      <p>${expired.length} expired, ${expiring.length} expiring within ${RENEWAL_WINDOW_DAYS} days.</p>
      ${
        expired.length
          ? `<h3 style="color:#b23a2e;">Expired</h3>
             <table style="width:100%;border-collapse:collapse;font-size:13px;">${rowsHtml(expired, '#b23a2e')}</table>`
          : ''
      }
      ${
        expiring.length
          ? `<h3 style="color:#c98a12;">Expiring soon</h3>
             <table style="width:100%;border-collapse:collapse;font-size:13px;">${rowsHtml(expiring, '#c98a12')}</table>`
          : ''
      }
      <p style="margin-top:24px;font-size:11px;color:#8a919e;">Sent automatically by FieldCred. Manage this in Admin -> Tenant settings.</p>
    </div>
  `;
}

interface Row {
  workerName: string;
  certName: string;
  expiryDate: string;
}

Deno.serve(async (req) => {
  const force = new URL(req.url).searchParams.get('force') === 'true';
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: settings, error: settingsError } = await supabase
    .from('settings')
    .select('tenant_name, notification_email, timezone, digest_cadence, digest_day_of_week, digest_hour, last_digest_sent_at')
    .eq('id', 1)
    .maybeSingle();

  if (settingsError) {
    return new Response(JSON.stringify({ error: settingsError.message }), { status: 500 });
  }
  if (!settings?.notification_email) {
    return new Response(JSON.stringify({ skipped: 'no notification_email configured' }), { status: 200 });
  }

  const gate = shouldSendNow(settings as Settings, new Date(), force);
  if (!gate.send) {
    return new Response(JSON.stringify({ skipped: gate.reason }), { status: 200 });
  }

  const { data: workers, error: workersError } = await supabase.from('workers').select('name, certifications');
  if (workersError) {
    return new Response(JSON.stringify({ error: workersError.message }), { status: 500 });
  }

  const expiring: Row[] = [];
  const expired: Row[] = [];

  for (const w of workers ?? []) {
    for (const c of (w.certifications ?? []) as { name: string; expiryDate: string }[]) {
      if (!c.expiryDate) continue;
      const status = certStatus(c.expiryDate);
      if (status === 'valid') continue;
      const row = { workerName: w.name, certName: c.name, expiryDate: c.expiryDate };
      (status === 'expiring' ? expiring : expired).push(row);
    }
  }

  if (!expiring.length && !expired.length) {
    return new Response(JSON.stringify({ skipped: 'nothing expiring or expired' }), { status: 200 });
  }

  expired.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  expiring.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: settings.notification_email,
      subject: `FieldCred: ${expired.length} expired, ${expiring.length} expiring credential${expiring.length === 1 ? '' : 's'}`,
      html: buildEmailHtml(settings.tenant_name || 'FieldCred', expiring, expired),
    }),
  });

  if (!resendRes.ok) {
    const body = await resendRes.text();
    return new Response(JSON.stringify({ error: `Resend API error: ${resendRes.status} ${body}` }), { status: 502 });
  }

  // Recorded only after a confirmed successful send — a failed send leaves
  // last_digest_sent_at untouched, so the next hourly tick that matches the
  // configured hour will try again rather than silently skipping a day.
  const { error: updateError } = await supabase.from('settings').update({ last_digest_sent_at: new Date().toISOString() }).eq('id', 1);
  if (updateError) {
    // The email already sent — don't report this as a failure, but do
    // surface it, since a failed dedup-timestamp write risks a duplicate
    // send on the next matching tick.
    return new Response(JSON.stringify({ sent: true, expiring: expiring.length, expired: expired.length, dedupWriteFailed: updateError.message }), { status: 200 });
  }

  return new Response(JSON.stringify({ sent: true, expiring: expiring.length, expired: expired.length }), { status: 200 });
});
