import { enforceRateLimit } from './rate-limit.js';
import { clientIp, json, forbidden, limited, escapeHtml } from './http.js';
import { callRpc } from './dataApi.js';

// POST /api/scan-alert — the gate app calls this right after a scan comes
// back BLOCKED. Body: { tenant, site, worker } (slugs only).
//
// The browser's word is never trusted: this route claims the scan through
// claim_blocked_scan_alert() (neon/migrations/001), which only releases a
// real blocked entry from the last 15 minutes, only once, and only to a
// caller holding ALERT_HOOK_SECRET. Everything it needs for the email comes
// from that row, not from the request.
//
// The response is always 202 with the same body, whether or not an email went
// out, so the route can't be used to probe which scans or addresses exist.
// What actually happened is logged under [scan-alert] for Workers Logs.

const SCAN_ALERT_LIMIT = { bucket: 'scan-alert', max: 30, windowSeconds: 60 };
const SLUG = /^[a-z0-9-]{1,64}$/;
const PUBLIC_SLUG = /^[A-Za-z0-9_-]{1,128}$/;

function accepted() {
  return json(202, { ok: true });
}

function missingNames(missingTypes) {
  if (!Array.isArray(missingTypes)) return [];
  return missingTypes
    .map((t) => (t && typeof t.name === 'string' ? t.name : ''))
    .filter(Boolean);
}

// "Oct 27, 2026, 9:05 AM EDT" in the tenant's timezone. Explicit parts, not
// dateStyle/timeStyle: those can't be combined with timeZoneName. Never
// throws — a bad timezone falls back to UTC, and anything else to ISO.
export function formatScanTime(iso, timezone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const options = {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  };
  for (const timeZone of [timezone || 'UTC', 'UTC']) {
    try {
      return new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(date);
    } catch {
      // try the next timezone
    }
  }
  return date.toISOString();
}

// Built only from the claimed row, so every value is escaped once here.
export function scanAlertEmail(row, appOrigin) {
  const missing = missingNames(row.missing_types);
  const when = formatScanTime(row.scanned_at, row.timezone);
  const site = row.site_location ? `${row.site_name} · ${row.site_location}` : row.site_name;
  const gate = [row.guard_label, row.device_id].filter(Boolean).join(' · ') || 'Not recorded';
  const logUrl = row.site_id ? `${appOrigin}/#/site/${encodeURIComponent(row.site_id)}/log` : `${appOrigin}/`;
  const worker = row.worker_name || 'Unknown worker';

  const subject = `Turned away at ${row.site_name || 'a site'}: ${worker}`;
  const rows = [
    ['Worker', worker],
    ['Site', site || 'Unknown site'],
    ['When', when],
    ['Gate', gate],
  ];
  const html = '<div style="font-family:sans-serif;color:#1c2430;max-width:560px;">'
    + '<h2 style="color:#b42318;margin-bottom:4px;">Worker turned away at the gate</h2>'
    + '<p style="margin-top:0;color:#5b6472;">A gate scan came back NOT CLEARED. The worker was told to see their supervisor.</p>'
    + '<table style="width:100%;border-collapse:collapse;font-size:14px;">'
    + rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#5b6472;width:120px;">${escapeHtml(k)}</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(String(v))}</td></tr>`).join('')
    + '</table>'
    + '<p style="margin-bottom:4px;"><strong>Missing or not current:</strong></p>'
    + (missing.length
      ? '<ul style="margin-top:0;">' + missing.map((m) => `<li>${escapeHtml(m)}</li>`).join('') + '</ul>'
      : '<p style="margin-top:0;color:#5b6472;">Not listed on the scan.</p>')
    + `<p><a href="${escapeHtml(logUrl)}" style="color:#0f2148;font-weight:600;">Open this site's scan log →</a></p>`
    + '<p style="margin-top:20px;font-size:11px;color:#8a919e;">Sent by FieldCred once per blocked scan. Change where these go on the site\'s settings page.</p>'
    + '</div>';
  const text = [
    'Worker turned away at the gate',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    `Missing or not current: ${missing.length ? missing.join(', ') : 'not listed on the scan'}`,
    '',
    `Scan log: ${logUrl}`,
  ].join('\n');
  return { subject, html, text };
}

export async function handleScanAlert(request, env, tenants, fetchImpl, now, nowMs) {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  const appOrigin = new URL(request.url).origin;
  const origin = request.headers.get('Origin');
  if (origin && origin !== appOrigin) return forbidden();

  const limit = enforceRateLimit(clientIp(request), SCAN_ALERT_LIMIT.bucket, SCAN_ALERT_LIMIT.max, SCAN_ALERT_LIMIT.windowSeconds, now);
  if (limit.limited) return limited(limit.retryAfter);

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const tenant = typeof body?.tenant === 'string' ? body.tenant : '';
  const site = typeof body?.site === 'string' ? body.site : '';
  const worker = typeof body?.worker === 'string' ? body.worker : '';
  if (!SLUG.test(tenant) || !PUBLIC_SLUG.test(site) || !PUBLIC_SLUG.test(worker)) {
    return json(400, { error: 'Invalid request' });
  }

  const secret = String(env.ALERT_HOOK_SECRET || '').trim();
  if (!secret) {
    console.error('[scan-alert] ALERT_HOOK_SECRET is not set; blocked-scan alerts are off');
    return accepted();
  }
  const entry = tenants.find((t) => t.slug === tenant);
  if (!entry?.authUrl || !entry?.dataApiUrl) return accepted();

  const claim = await callRpc(entry, 'claim_blocked_scan_alert', {
    p_site_slug: site,
    p_worker_slug: worker,
    p_secret: secret,
  }, fetchImpl, nowMs);
  if (!claim.ok) {
    const hint = claim.status === 404 ? ' (apply neon/migrations/001_blocked_scan_alerts.sql to this tenant)' : '';
    console.error(`[scan-alert] claim failed for tenant ${tenant} — http: ${claim.status}${hint}`);
    return accepted();
  }
  const row = claim.rows[0];
  // Nothing to claim is the normal outcome for a duplicate request, an old
  // scan, or a wrong secret. The function deliberately doesn't say which.
  if (!row || typeof row !== 'object') return accepted();

  const recipient = typeof row.recipient === 'string' ? row.recipient.trim() : '';
  if (!recipient) {
    console.error(`[scan-alert] no alert address for site "${row.site_name}" (tenant ${tenant}); set one on the site or in settings`);
    return accepted();
  }
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey || !env.RESEND_FROM) {
    console.error('[scan-alert] Resend is not configured');
    return accepted();
  }

  const { subject, html, text } = scanAlertEmail(row, appOrigin);
  let response;
  let responseText = '';
  try {
    response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.RESEND_FROM, to: recipient, subject, html, text }),
      signal: AbortSignal.timeout(15000),
    });
    responseText = await response.text();
  } catch (err) {
    console.error(`[scan-alert] Resend unreachable — ${err && err.message ? err.message : 'none'}`);
    return accepted();
  }
  if (response.status >= 300) {
    console.error(`[scan-alert] Resend send failed — http: ${response.status} — body: ${responseText.slice(0, 300)}`);
  }
  return accepted();
}
