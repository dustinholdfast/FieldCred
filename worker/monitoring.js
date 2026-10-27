import { enforceRateLimit } from './rate-limit.js';
import { SECURITY_HEADERS, clientIp, json, forbidden, limited, cleanField } from './http.js';

// Client error collection and health checks. Everything here reports through
// console.error with a fixed [prefix] so failures land in Workers Logs, where
// they can be searched and alerted on; nothing is stored.
//   POST /api/client-error  — from js/lib/errorReporting.js
//   GET  /api/health        — which pieces are configured, as booleans
//   POST /api/health/email  — MONITOR_TOKEN-gated Resend check (scripts/monitor.sh)

const CLIENT_ERROR_LIMIT = { bucket: 'client-error', max: 30, windowSeconds: 60 };
const HEALTH_EMAIL_LIMIT = { bucket: 'health-email', max: 10, windowSeconds: 3600 };
const CLIENT_ERROR_KINDS = new Set(['error', 'unhandledrejection']);
const CLIENT_ERROR_MAX_BYTES = 8192;

// Resend's test inbox: the send is validated like a real one (key, sending
// domain) but nobody receives it.
const MONITOR_RECIPIENT = 'delivered@resend.dev';

function oneLine(value, maxLen) {
  return cleanField(typeof value === 'string' ? value.replace(/\s+/g, ' ') : '', maxLen);
}

// Page path and hash only. The query string can carry tokens, so it is dropped.
function reportedPage(value) {
  try {
    const url = new URL(String(value));
    return Array.from(url.pathname + url.hash).slice(0, 300).join('');
  } catch {
    return '';
  }
}

export async function handleClientError(request, now) {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return forbidden();

  const limit = enforceRateLimit(clientIp(request), CLIENT_ERROR_LIMIT.bucket, CLIENT_ERROR_LIMIT.max, CLIENT_ERROR_LIMIT.windowSeconds, now);
  if (limit.limited) return limited(limit.retryAfter);

  const text = await request.text();
  if (text.length > CLIENT_ERROR_MAX_BYTES) return json(413, { error: 'Report too large' });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (body === null || typeof body !== 'object' || !CLIENT_ERROR_KINDS.has(body.kind)) {
    return json(400, { error: 'Invalid report' });
  }

  const message = oneLine(body.message, 500) || '(no message)';
  const stack = cleanField(typeof body.stack === 'string' ? body.stack.replace(/[\r\n]+/g, ' | ') : '', 2000);
  console.error(
    `[client-error] ${body.kind} — ${message} — page: ${reportedPage(body.url) || '?'} — ua: ${oneLine(body.ua, 200) || '?'}`
      + (stack ? ` — stack: ${stack}` : '')
  );
  return new Response(null, { status: 204, headers: new Headers(SECURITY_HEADERS) });
}

function resendConfigured(env) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  return Boolean(apiKey && apiKey !== 'YOUR_RESEND_API_KEY' && env.RESEND_FROM);
}

export function handleHealth(request, env, tenants) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { error: 'Method not allowed' });
  }
  const checks = {
    assets: Boolean(env.ASSETS && typeof env.ASSETS.fetch === 'function'),
    tenants: tenants.length > 0,
    signupEmail: resendConfigured(env) && Boolean(env.NOTIFY_EMAIL),
    directorySearch: Boolean(String(env.GEMINI_API_KEY || '').trim()),
  };
  const ok = Object.values(checks).every(Boolean);
  if (!ok) console.error(`[health] failing checks: ${Object.keys(checks).filter((k) => !checks[k]).join(', ')}`);
  return json(ok ? 200 : 503, { ok, checks });
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleHealthEmail(request, env, fetchImpl, now) {
  const token = String(env.MONITOR_TOKEN || '').trim();
  if (!token) return json(404, { error: 'Not found' });
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  const auth = request.headers.get('Authorization') || '';
  if (!sameSecret(auth, `Bearer ${token}`)) return json(401, { error: 'Unauthorized' });

  const limit = enforceRateLimit(clientIp(request), HEALTH_EMAIL_LIMIT.bucket, HEALTH_EMAIL_LIMIT.max, HEALTH_EMAIL_LIMIT.windowSeconds, now);
  if (limit.limited) return limited(limit.retryAfter);

  if (!resendConfigured(env)) {
    console.error('[health-email] Resend is not configured');
    return json(503, { ok: false, error: 'Resend is not configured' });
  }

  let response;
  let responseText = '';
  try {
    response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: MONITOR_RECIPIENT,
        subject: 'FieldCred monitor check',
        text: "Automated check that the Resend key and sending domain still work. Sent to Resend's test inbox; nobody receives it.",
      }),
      signal: AbortSignal.timeout(15000),
    });
    responseText = await response.text();
  } catch (err) {
    console.error(`[health-email] Resend unreachable — ${err && err.message ? err.message : 'none'}`);
    return json(502, { ok: false, status: 0, error: 'Resend unreachable' });
  }

  if (response.status >= 300) {
    let detail = '';
    try {
      detail = JSON.parse(responseText).message || '';
    } catch {
      detail = responseText;
    }
    console.error(`[health-email] Resend rejected — http: ${response.status} — ${oneLine(detail, 300)}`);
    return json(502, { ok: false, status: response.status, error: oneLine(detail, 300) });
  }
  return json(200, { ok: true });
}
