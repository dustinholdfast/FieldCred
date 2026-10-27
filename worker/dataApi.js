// Anonymous calls to a tenant's Neon Data API. Shared by files.js and
// scanAlert.js. No database password: the Auth URL and Data API URL are the
// public values tenant lookup already returns, and what an anonymous caller
// can do is whatever the SECURITY DEFINER functions grant to `anonymous`.

// Anonymous Data API tokens are not user sessions. Cached per Auth URL
// inside this isolate, same 4-minute window file.php used on disk.
const anonTokens = new Map();

export function resetTokenCache() {
  anonTokens.clear();
}

export async function anonymousToken(authUrl, fetchImpl, nowMs) {
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

// POST /rpc/<fn>. Never throws: { ok, status, rows } where status 0 means the
// call never got an HTTP answer (no token, network failure, bad JSON).
export async function callRpc(endpoints, fn, args, fetchImpl, nowMs) {
  const token = await anonymousToken(endpoints.authUrl, fetchImpl, nowMs);
  if (!token) return { ok: false, status: 0, rows: [] };
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
    return { ok: false, status: 0, rows: [] };
  }
  if (!response.ok) return { ok: false, status: response.status, rows: [] };
  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, status: 0, rows: [] };
  }
  const rows = Array.isArray(data) ? data : data == null ? [] : [data];
  return { ok: true, status: response.status, rows };
}
