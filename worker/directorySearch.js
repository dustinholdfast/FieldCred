// POST /directory-search.php
//
// Turns one plain-English question into an allowlisted filter. The model
// never sees worker rows and never sends SQL. The browser runs the filter
// through the Data API with the caller's own Neon Auth JWT, so RLS still
// decides which workers come back.
//
// GEMINI_API_KEY is a Worker secret. When it is missing this returns
// { enabled: false } and the directory keeps plain text search.
// Optional GEMINI_MODEL overrides the default model id; it is not required.

import { enforceRateLimit } from './rate-limit.js';
import { findTenantIn } from './endpoints.js';
import {
  QUESTION_MAX,
  FilterRejected,
  filterResponseSchema,
  modelMessages,
  validateFilter,
} from '../js/lib/directoryFilter.js';

export const DIRECTORY_SEARCH_LIMIT = { bucket: 'directory-search', max: 20, windowSeconds: 60 };
const STAFF_ROLES = new Set(['admin', 'safety', 'gate']);
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

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

function geminiConfig(env) {
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  const requested = String(env.GEMINI_MODEL || '').trim();
  const model = MODEL_ID.test(requested) ? requested : DEFAULT_MODEL;
  return { apiKey, model };
}

function geminiRequestBody(question) {
  const messages = modelMessages(question);
  return {
    systemInstruction: { parts: [{ text: messages[0].content }] },
    contents: [{ role: 'user', parts: [{ text: messages[1].content }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: filterResponseSchema(),
    },
  };
}

function parseGeminiContent(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  let text = parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
  if (!text) return null;
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

  const gemini = geminiConfig(env);
  if (!gemini.apiKey) return { status: 200, body: { enabled: false } };

  let response;
  try {
    response = await fetchImpl(`${GEMINI_URL}/${encodeURIComponent(gemini.model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': gemini.apiKey,
      },
      body: JSON.stringify(geminiRequestBody(question)),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    console.error('[directory-search] gemini failed — http: 0');
    return { status: 502, body: { error: 'Search is unavailable right now.' } };
  }
  if (!response.ok) {
    console.error(`[directory-search] gemini failed — http: ${response.status}`);
    return { status: 502, body: { error: 'Search is unavailable right now.' } };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error('[directory-search] filter rejected');
    return { status: 422, body: { error: 'That question could not be turned into a safe filter.' } };
  }
  const parsed = parseGeminiContent(payload);
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
