// Streams a file stored in the tenant's Neon database (public.files).
// Same URL shape as file.php on the Neon branch. Workers do not run PHP.
//
// Public buckets (photos, badges, logos): anonymous Data API RPC
// get_public_file. Certificates: ?token= from create_file_grant(),
// redeemed by redeem_file_grant().
//
// No database password. The Auth URL and Data API URL are the public
// values tenant lookup already returns.

const PUBLIC_BUCKETS = new Set(['photos', 'badges', 'logos']);
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(self), payment=(), usb=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

// Anonymous Data API tokens are not user sessions. Cached per Auth URL
// inside this isolate, same 4-minute window file.php used on disk.
const anonTokens = new Map();

export function resetFileCache() {
  anonTokens.clear();
}

function fileError(status) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Cache-Control', 'private, max-age=60');
  return new Response(null, { status, headers });
}

function firstRow(data) {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

async function anonymousToken(authUrl, fetchImpl, nowMs) {
  const cached = anonTokens.get(authUrl);
  if (cached && cached.exp > nowMs + 15000) return cached.token;

  let response;
  try {
    response = await fetchImpl(`${authUrl.replace(/\/$/, '')}/token/anonymous`, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let data;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  const token = data && typeof data.token === 'string' ? data.token : '';
  if (!token) return null;
  anonTokens.set(authUrl, { token, exp: nowMs + 240000 });
  return token;
}

async function dataApi(endpoints, fn, args, fetchImpl, nowMs) {
  const token = await anonymousToken(endpoints.authUrl, fetchImpl, nowMs);
  if (!token) return null;
  let response;
  try {
    response = await fetchImpl(`${endpoints.dataApiUrl.replace(/\/$/, '')}/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let data;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  const row = firstRow(data);
  if (!row || typeof row !== 'object' || typeof row.data !== 'string') return null;
  return row;
}

function decodeBase64(data) {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export async function handleFile(request, tenants, fetchImpl, nowMs) {
  const url = new URL(request.url);
  const tenant = url.searchParams.get('tenant') ?? '';
  const bucket = url.searchParams.get('bucket') ?? '';
  const path = url.searchParams.get('path') ?? '';
  const token = url.searchParams.get('token') ?? '';

  if (!/^[a-z0-9-]{1,64}$/.test(tenant)) return fileError(400);

  const entry = tenants.find((item) => item.slug === tenant);
  if (!entry?.authUrl || !entry?.dataApiUrl) return fileError(404);

  let row;
  if (token !== '') {
    if (!/^[a-f0-9]{16,128}$/.test(token)) return fileError(400);
    row = await dataApi(entry, 'redeem_file_grant', { p_token: token }, fetchImpl, nowMs);
  } else {
    if (!PUBLIC_BUCKETS.has(bucket)) return fileError(404);
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(path)) return fileError(400);
    row = await dataApi(entry, 'get_public_file', { p_bucket: bucket, p_path: path }, fetchImpl, nowMs);
  }

  if (!row) return fileError(404);

  const bytes = decodeBase64(row.data);
  if (!bytes) return fileError(502);

  const requested = typeof row.content_type === 'string' ? row.content_type : 'application/octet-stream';
  const type = ALLOWED_TYPES.has(requested) ? requested : 'application/octet-stream';
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', type);
  headers.set('Cache-Control', 'private, max-age=60');
  if (type === 'application/octet-stream') headers.set('Content-Disposition', 'attachment');
  return new Response(bytes, { status: 200, headers });
}
