// POST /directory-search.php
//
// Turns one plain-English question into an allowlisted filter. The model
// never sees worker rows and never sends SQL. The browser runs the filter
// through the Data API with the caller's own Neon Auth JWT, so RLS still
// decides which workers come back.
//
// NEON_AI_GATEWAY_TOKEN and NEON_AI_GATEWAY_BASE_URL are Worker secrets.
// When either is missing this returns { enabled: false } and the directory
// keeps plain text search. Optional NEON_AI_GATEWAY_MODEL overrides the
// default model id.

import { enforceRateLimit } from './rate-limit.js';
import { findTenantIn } from './endpoints.js';
import {
  QUESTION_MAX,
  FilterRejected,
  modelMessages,
  validateFilter,
} from '../js/lib/directoryFilter.js';

export const DIRECTORY_SEARCH_LIMIT = { bucket: 'directory-search', max: 20, windowSeconds: 60 };
const STAFF_ROLES = new Set(['admin', 'safety', 'gate']);
const DEFAULT_MODEL = 'gemini-3-flash';

function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  try {
    const pad = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = pad + '='.repeat((4 - (pad.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

async function requireStaff(request, dataApiUrl, fetchImpl, nowMs) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return { status: 401, body: { error: 'Sign in required' } };
  const token = match[1];
  if (token.length > 8000) return { status: 401, body: { error: 'Sign in required' } };
  const payload = decodeJwtPayload(token);
  if (!payload || payload.role !== 'authenticated') {
    return { status: 401, body: { error: 'Sign in required' } };
  }
  if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 200) {
    return { status: 401, body: { error: 'Sign in required' } };
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) {
    return { status: 401, body: { error: 'Sign in required' } };
  }

  let response;
  try {
    response = await fetchImpl(`${dataApiUrl}/rpc/current_fc_role`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { status: 503, body: { error: 'The database is waking up. Try again in a moment.' } };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: 401, body: { error: 'Sign in required' } };
  }
  if (!response.ok) {
    return { status: 503, body: { error: 'The database is waking up. Try again in a moment.' } };
  }
  let role;
  try {
    role = await response.json();
  } catch {
    return { status: 401, body: { error: 'Sign in required' } };
  }
  if (Array.isArray(role)) role = role[0];
  if (!STAFF_ROLES.has(role)) {
    return { status: 403, body: { error: "You don't have access to directory search." } };
  }
  return { sub: payload.sub };
}

function gatewayEnv(env) {
  const token = String(env.NEON_AI_GATEWAY_TOKEN || '').trim();
  const baseUrl = String(env.NEON_AI_GATEWAY_BASE_URL || '').trim().replace(/\/+$/, '');
  const model = String(env.NEON_AI_GATEWAY_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  return { token, baseUrl, model };
}

function parseModelContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
  } else {
    return null;
  }
  text = text.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function directorySearchResult(request, env = {}, deps = {}) {
  if (request.method !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed' } };
  }

  const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs() : (Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now());
  const now = typeof deps.now === 'function' ? deps.now() : (Number.isFinite(deps.now) ? deps.now : Math.floor(nowMs / 1000));
  const fetchImpl = deps.fetchImpl || fetch;
  const tenants = deps.tenants || [];

  let raw = '';
  try {
    raw = await request.text();
  } catch {
    return { status: 400, body: { error: 'Invalid request body' } };
  }
  if (raw.length > 4000) return { status: 400, body: { error: 'Question is too long.' } };

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: 'Invalid request body' } };
  }
  if (!body || typeof body !== 'object') return { status: 400, body: { error: 'Invalid request body' } };

  const tenant = typeof body.tenant === 'string' ? body.tenant : '';
  if (!/^[a-z0-9-]{1,64}$/.test(tenant)) return { status: 400, body: { error: 'Invalid tenant' } };
  const entry = findTenantIn(tenants, tenant);
  if (!entry?.dataApiUrl) return { status: 404, body: { error: 'Unknown tenant' } };

  if (typeof body.question !== 'string') return { status: 400, body: { error: 'Question is required' } };
  const question = body.question.trim();
  if (!question) return { status: 400, body: { error: 'Question is required' } };

  const staff = await requireStaff(request, entry.dataApiUrl, fetchImpl, nowMs);
  if (staff.status) return staff;
  if (question.length > QUESTION_MAX) return { status: 400, body: { error: 'Question is too long.' } };

  const limit = enforceRateLimit(
    staff.sub,
    DIRECTORY_SEARCH_LIMIT.bucket,
    DIRECTORY_SEARCH_LIMIT.max,
    DIRECTORY_SEARCH_LIMIT.windowSeconds,
    now,
  );
  if (limit.limited) {
    return {
      status: 429,
      body: { error: 'Too many requests — please try again later.' },
      headers: { 'Retry-After': String(limit.retryAfter) },
    };
  }

  const gateway = gatewayEnv(env);
  if (!gateway.token || !gateway.baseUrl) return { status: 200, body: { enabled: false } };

  let response;
  try {
    response = await fetchImpl(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: gateway.model,
        temperature: 0,
        messages: modelMessages(question),
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    console.error('[directory-search] gateway failed — http: 0');
    return { status: 502, body: { error: 'Search is unavailable right now.' } };
  }
  if (!response.ok) {
    console.error(`[directory-search] gateway failed — http: ${response.status}`);
    return { status: 502, body: { error: 'Search is unavailable right now.' } };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error('[directory-search] filter rejected');
    return { status: 422, body: { error: 'That question could not be turned into a safe filter.' } };
  }
  const parsed = parseModelContent(payload);
  if (!parsed) {
    console.error('[directory-search] filter rejected');
    return { status: 422, body: { error: 'That question could not be turned into a safe filter.' } };
  }
  try {
    const today = typeof deps.today === 'function' ? deps.today() : (deps.today instanceof Date ? deps.today : new Date(nowMs));
    const filter = validateFilter(parsed, { today });
    return { status: 200, body: { enabled: true, filter } };
  } catch (err) {
    if (err instanceof FilterRejected) {
      console.error('[directory-search] filter rejected');
      return { status: 422, body: { error: 'That question could not be turned into a safe filter.' } };
    }
    throw err;
  }
}
