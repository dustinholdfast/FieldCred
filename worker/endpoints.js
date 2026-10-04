import { TENANTS } from './tenants.js';
import { enforceRateLimit } from './rate-limit.js';
import { handleFile } from './files.js';

// Same caps as the PHP call sites.
export const LIMITS = {
  tenantLookup: { bucket: 'tenant-lookup', max: 30, windowSeconds: 60 },
  tenantDomain: { bucket: 'tenant-domain-lookup', max: 30, windowSeconds: 60 },
  signup: { bucket: 'signup', max: 5, windowSeconds: 3600 },
};

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(self), payment=(), usb=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

// html_handling is "none", so /index.html is the file itself (200). Directory
// requests have no file at that path. Map them onto the index document the
// way Apache DirectoryIndex does, including both / and /index.html as 200s —
// sw.js precaches those as two different cache keys.
const DIRECTORY_INDEX = {
  '/': '/index.html',
  '/help-center': '/help-center/index.html',
  '/help-center/': '/help-center/index.html',
  '/guides': '/guides/index.html',
  '/guides/': '/guides/index.html',
};

// Direct requests for these files are refused. On Apache, .htaccess denies
// tenants.php and signup-config.php; rate-limit.php is only a PHP include.
// None of them are fetched by the browser. Refusing them here also keeps
// signup-config.php (Resend API key) from being served if it is ever uploaded.
const PRIVATE_PHP = new Set(['/tenants.php', '/signup-config.php', '/rate-limit.php']);

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function json(status, body, extraHeaders) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function forbidden() {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', 'text/plain; charset=UTF-8');
  headers.set('Cache-Control', 'no-store');
  return new Response('Forbidden', { status: 403, headers });
}

function limited(retryAfter) {
  return json(429, { error: 'Too many requests — please try again later.' }, {
    'Retry-After': String(retryAfter),
  });
}

function publicTenant(entry, slug) {
  return {
    name: entry.name ?? slug,
    authUrl: entry.authUrl,
    dataApiUrl: entry.dataApiUrl,
  };
}

export function findTenantIn(tenants, slug) {
  return tenants.find((entry) => entry.slug === slug) || null;
}

export function findTenantByDomainIn(tenants, domain) {
  return tenants.find((entry) => (entry.domains || []).includes(domain)) || null;
}

function handleTenantLookup(request, now, tenants) {
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
    return json(400, { error: 'Invalid tenant slug' });
  }

  const limit = enforceRateLimit(clientIp(request), LIMITS.tenantLookup.bucket, LIMITS.tenantLookup.max, LIMITS.tenantLookup.windowSeconds, now);
  if (limit.limited) return limited(limit.retryAfter);

  const entry = findTenantIn(tenants, slug);
  if (!entry) return json(404, { error: 'Unknown tenant' });
  return json(200, publicTenant(entry, slug));
}

function handleTenantLookupByDomain(request, now, tenants) {
  const email = new URL(request.url).searchParams.get('email') ?? '';
  const at = email.lastIndexOf('@');
  if (at === -1 || at === email.length - 1) {
    return json(400, { error: 'Invalid email' });
  }

  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,255}$/.test(domain)) {
    return json(400, { error: 'Invalid email domain' });
  }

  const limit = enforceRateLimit(clientIp(request), LIMITS.tenantDomain.bucket, LIMITS.tenantDomain.max, LIMITS.tenantDomain.windowSeconds, now);
  if (limit.limited) return limited(limit.retryAfter);

  const entry = findTenantByDomainIn(tenants, domain);
  if (!entry) return json(404, { error: 'No tenant found for that email domain' });
  return json(200, { slug: entry.slug, ...publicTenant(entry, entry.slug) });
}

// PHP empty(): null, false, 0, "0", "".
function phpEmpty(value) {
  return value == null || value === false || value === 0 || value === '0' || value === '';
}

function cleanField(value, maxLen) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const stripped = trimmed.replace(/[\x00-\x1F\x7F]/g, '');
  return Array.from(stripped).slice(0, maxLen).join('');
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[ch]));
}

// Matches PHP nl2br. cleanField already removes newlines, so this is a no-op
// for notes that went through cleanField — kept so the email HTML stays the
// same shape as signup-notify.php.
function nl2br(value) {
  return value.replace(/\n/g, '<br />\n');
}

function signupHtml({ companyName, adminEmail, domain, note }) {
  return '<div style="font-family:sans-serif;color:#1c2430;max-width:560px;">'
    + '<h2 style="color:#0f2148;">New FieldCred signup request</h2>'
    + '<table style="width:100%;border-collapse:collapse;font-size:14px;">'
    + '<tr><td style="padding:6px 0;color:#5b6472;">Company</td><td style="padding:6px 0;font-weight:600;">' + escapeHtml(companyName) + '</td></tr>'
    + '<tr><td style="padding:6px 0;color:#5b6472;">Admin email</td><td style="padding:6px 0;font-weight:600;">' + escapeHtml(adminEmail) + '</td></tr>'
    + '<tr><td style="padding:6px 0;color:#5b6472;">Domain</td><td style="padding:6px 0;font-weight:600;">' + (domain !== '' ? escapeHtml(domain) : '<em>not given</em>') + '</td></tr>'
    + '</table>'
    + (note !== '' ? '<p style="color:#5b6472;"><strong>Note:</strong><br>' + nl2br(escapeHtml(note)) + '</p>' : '')
    + '<p style="margin-top:20px;font-size:11px;color:#8a919e;">Provision this in Neon, then add an entry to tenants.php — see neon/README.md.</p>'
    + '</div>';
}

async function handleSignup(request, env, fetchImpl, now) {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const limit = enforceRateLimit(clientIp(request), LIMITS.signup.bucket, LIMITS.signup.max, LIMITS.signup.windowSeconds, now);
  if (limit.limited) return limited(limit.retryAfter);

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (body === null || typeof body !== 'object') {
    return json(400, { error: 'Invalid request body' });
  }

  if (!phpEmpty(body.website)) {
    return json(200, { ok: true });
  }

  const companyName = cleanField(body.companyName, 200);
  const adminEmail = cleanField(body.adminEmail, 200);
  const domain = cleanField(body.domain, 255);
  const note = cleanField(body.note, 2000);

  if (companyName === '') return json(400, { error: 'Company name is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    return json(400, { error: 'A valid admin email is required' });
  }
  if (domain !== '' && !/^[a-z0-9.-]{1,255}$/i.test(domain)) {
    return json(400, { error: "That domain doesn't look right" });
  }

  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const resendFrom = env.RESEND_FROM || '';
  const notifyEmail = env.NOTIFY_EMAIL || '';
  if (!apiKey || apiKey === 'YOUR_RESEND_API_KEY' || !resendFrom || !notifyEmail) {
    return json(500, { error: 'Signup notifications are not configured yet' });
  }

  const html = signupHtml({ companyName, adminEmail, domain, note });
  let response;
  let responseText = '';
  try {
    response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: resendFrom,
        to: notifyEmail,
        reply_to: adminEmail,
        subject: `FieldCred signup request: ${companyName}`,
        html,
      }),
      signal: AbortSignal.timeout(15000),
    });
    responseText = await response.text();
  } catch (err) {
    console.error(
      '[signup-notify] Resend send failed'
      + ` — curl: ${err && err.message ? err.message : 'none'}`
      + ' — http: 0'
      + ` — from: ${resendFrom}`
    );
    return json(502, { error: 'Could not send notification email' });
  }

  if (response.status >= 300) {
    console.error(
      '[signup-notify] Resend send failed'
      + ' — curl: none'
      + ` — http: ${response.status}`
      + ` — from: ${resendFrom}`
      + ` — body: ${responseText.slice(0, 500)}`
    );
    return json(502, { error: 'Could not send notification email' });
  }

  return json(200, { ok: true });
}

export async function handleRequest(request, env = {}, deps = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const fetchImpl = deps.fetchImpl || fetch;
  const tenants = deps.tenants || TENANTS;

  if (PRIVATE_PHP.has(path)) return forbidden();
  if (path === '/tenant-lookup.php') return handleTenantLookup(request, now, tenants);
  if (path === '/tenant-lookup-by-domain.php') return handleTenantLookupByDomain(request, now, tenants);
  if (path === '/signup-notify.php') return handleSignup(request, env, fetchImpl, now);
  if (path === '/file.php') {
    const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
    return handleFile(request, tenants, fetchImpl, nowMs);
  }

  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return json(404, { error: 'Not found' });
  }
  const indexPath = DIRECTORY_INDEX[path];
  if (indexPath) {
    return env.ASSETS.fetch(new Request(new URL(indexPath, request.url), request));
  }
  return env.ASSETS.fetch(request);
}
