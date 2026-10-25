// One retry budget for a Neon compute that just woke from scale-to-zero.
//
// What actually fails (checked against Neon and PostgREST docs, not guessed):
// - Neon documents the first request after suspend as "Couldn't connect to
//   compute node" or "Failed to fetch", and names SQLSTATE 57P01
//   (admin_shutdown), 08006 (connection_failure), and 08003
//   (connection_does_not_exist). 57P03 is Postgres "the database system is
//   starting up".
// - The Data API is PostgREST. It forwards those SQLSTATEs as JSON
//   { code, message } and maps 08* and PGRST000–PGRST002 to HTTP 503,
//   57* and XX* (including XX000 "Couldn't connect to compute node") to
//   HTTP 500, and PGRST003 (pool wait) to HTTP 504.
// - Neon Auth keeps the HTTP status on the thrown error (401 stays 401,
//   5xx stays 5xx). A wrong password is 401. It is not a cold start.
// - Postgres 42501 is HTTP 403 for an authenticated role and HTTP 401 for
//   anonymous. Either way it is a real permission denial. Do not retry it.
//
// The HTTP status lives on the PostgREST result, not on the error object.
// js/lib/state.js copies it onto the Error so this helper can see 503 vs 42501.

import { db } from './backendClient.js';
import { isPermissionError } from './roles.js';

export const WAKE_BUDGET_MS = 25000;
export const WAKING_TITLE = 'Waking up the database…';

const BASE_DELAY_MS = 1000;
const ATTEMPT_TIMEOUT_MS = 12000;

const WAKE_SNIPPETS = [
  "couldn't connect to compute node",
  'could not connect to compute node',
  'the database system is starting up',
  'the database system is shutting down',
  'terminating connection due to administrator command',
  'connection terminated unexpectedly',
  'failed to fetch',
  'fetch failed',
  'networkerror',
  'network request failed',
  'timeout',
  'timed out',
  'econnreset',
  'econnrefused',
  'etimedout',
  'socket hang up',
  'control plane request failed',
];

function statusOf(err) {
  const status = Number(err?.status ?? err?.statusCode);
  return Number.isFinite(status) ? status : null;
}

function textOf(err) {
  return `${err?.name || ''} ${err?.message || ''} ${err?.details || ''}`.toLowerCase();
}

// Real auth and permission failures. These must surface on the first try.
export function isAuthOrPermissionError(err) {
  if (!err) return false;
  if (isPermissionError(err)) return true;
  const status = statusOf(err);
  return status === 401 || status === 403;
}

export function isTransientWakeError(err) {
  if (!err || isAuthOrPermissionError(err)) return false;
  const text = textOf(err);
  // 55000 is the roster rate limit. PostgREST maps 55* to HTTP 500, which
  // would otherwise look like a cold start.
  if (text.includes('rate limit') || err.code === '55000') return false;

  const status = statusOf(err);
  if (status === 408 || status === 0) return true;
  if (status !== null && status >= 500 && status <= 599) return true;

  const code = String(err.code || '').toUpperCase();
  if (/^08/.test(code) || /^53/.test(code)) return true;
  if (code === '57P01' || code === '57P02' || code === '57P03' || code === 'XX000') return true;
  if (/^PGRST00[0-3]$/.test(code)) return true;

  return WAKE_SNIPPETS.some((snippet) => text.includes(snippet));
}

function stopped() {
  const err = new Error('stopped');
  err.code = 'WAKE_STOPPED';
  return err;
}

export function isWakeStopped(err) {
  return err?.code === 'WAKE_STOPPED';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs fn, and on a transient wake failure waits and tries again until about
// 25 seconds have passed. onWaiting fires once, when the first retry is
// about to start, so a fast success never flashes the waking state.
// isCurrent() lets a page abandon the loop after the user navigates away.
export async function withWakeRetry(fn, options = {}) {
  const budgetMs = options.budgetMs ?? WAKE_BUDGET_MS;
  const timeoutMs = options.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const start = now();
  let attempt = 0;
  let announced = false;

  for (;;) {
    if (options.isCurrent && !options.isCurrent()) throw stopped();
    let timer;
    try {
      const attemptPromise = Promise.resolve().then(fn);
      if (!(timeoutMs > 0)) return await attemptPromise;
      return await Promise.race([
        attemptPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error('timeout');
            err.status = 408;
            reject(err);
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      if (err?.code === 'WAKE_STOPPED' || !isTransientWakeError(err)) throw err;
      const remaining = budgetMs - (now() - start);
      if (remaining < 250) throw err;
      if (!announced) {
        announced = true;
        options.onWaiting?.(err);
      }
      if (options.isCurrent && !options.isCurrent()) throw stopped();
      await wait(Math.min(BASE_DELAY_MS * 2 ** attempt, remaining));
      attempt += 1;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function wakingHtml() {
  return `<div class="empty-state wake-state" role="status" aria-live="polite">
    <div class="empty-state-title">${WAKING_TITLE}</div>
    <div>This usually takes a few seconds after it's been idle.</div>
  </div>`;
}

// One anonymous-safe read. public_settings is already granted to anonymous;
// this does not add a role or a grant. Fire-and-forget: the real query still
// retries if the compute is not up yet.
export function warmDatabase() {
  if (!db) return;
  db.from('public_settings').select('tenant_name').limit(1).then(() => {}, () => {});
}
