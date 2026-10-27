import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';

// The Worker's rate limiter is module-level state, so every test uses its own
// client IP to stay independent of the others.
let ipCounter = 0;
const nextIp = () => `203.0.113.${++ipCounter}`;

const ORIGIN = 'https://app.fieldcred.co';
const realFetch = globalThis.fetch;
const realConsoleError = console.error;

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

function captureErrors() {
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  return lines;
}

function call(path, { method = 'GET', body, headers = {}, ip = nextIp() } = {}, env = {}) {
  const init = { method, headers: { 'CF-Connecting-IP': ip, ...headers } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

const fullEnv = {
  ASSETS: { fetch: async () => new Response('asset') },
  RESEND_API_KEY: 're_test_key',
  RESEND_FROM: 'FieldCred <onboarding@fieldcred.co>',
  NOTIFY_EMAIL: 'ops@example.com',
  GEMINI_API_KEY: 'gemini-test',
  ALERT_HOOK_SECRET: 'hook-secret-for-tests',
};

test('wrangler.json sends every /api/ path to the Worker before the asset server', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.json', import.meta.url), 'utf8'));
  assert.ok(config.assets.run_worker_first.includes('/api/*'));
  assert.equal(config.observability?.enabled, true);
});

test('client errors are logged on one line with page path and hash, never the query string', async () => {
  const lines = captureErrors();
  const res = await call('/api/client-error', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: {
      kind: 'error',
      message: 'boom\nsecond line',
      stack: 'Error: boom\n    at main.js:1:1',
      url: `${ORIGIN}/?token=secret#/worker/42`,
      ua: 'TestAgent/1.0',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[client-error\] error — boom second line — page: \/#\/worker\/42 — ua: TestAgent\/1\.0 — stack: Error: boom \|/);
  assert.doesNotMatch(lines[0], /secret/);
});

test('client error reports from another origin are refused', async () => {
  const res = await call('/api/client-error', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: { kind: 'error', message: 'x' },
  });
  assert.equal(res.status, 403);
});

test('malformed, oversized, or unknown-kind client reports are rejected without logging', async () => {
  const lines = captureErrors();
  assert.equal((await call('/api/client-error', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await call('/api/client-error', { method: 'POST', body: { kind: 'other', message: 'x' } })).status, 400);
  assert.equal((await call('/api/client-error', { method: 'POST', body: { kind: 'error', message: 'x'.repeat(9000) } })).status, 413);
  assert.equal((await call('/api/client-error')).status, 405);
  assert.equal(lines.length, 0);
});

test('client error reporting is rate limited per IP', async () => {
  captureErrors();
  const ip = nextIp();
  const statuses = [];
  for (let i = 0; i < 31; i++) {
    statuses.push((await call('/api/client-error', { method: 'POST', ip, body: { kind: 'error', message: 'x' } })).status);
  }
  assert.equal(statuses.filter((s) => s === 204).length, 30);
  assert.equal(statuses.at(-1), 429);
});

test('health reports ok when everything is configured, without exposing any values', async () => {
  const res = await call('/api/health', {}, fullEnv);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, checks: { assets: true, tenants: true, signupEmail: true, directorySearch: true, blockedScanAlerts: true } });
  assert.doesNotMatch(JSON.stringify(body), /re_test_key|gemini-test|hook-secret-for-tests/);
});

test('health returns 503 and logs which checks fail when secrets are missing', async () => {
  const lines = captureErrors();
  const res = await call('/api/health', {}, { ASSETS: fullEnv.ASSETS });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks.signupEmail, false);
  assert.match(lines[0], /^\[health\] failing checks: signupEmail, directorySearch, blockedScanAlerts$/);
});

test('the email health check is hidden until MONITOR_TOKEN is set', async () => {
  const res = await call('/api/health/email', { method: 'POST' }, fullEnv);
  assert.equal(res.status, 404);
});

test('the email health check rejects a wrong token without calling Resend', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  const env = { ...fullEnv, MONITOR_TOKEN: 'right-token' };
  const res = await call('/api/health/email', { method: 'POST', headers: { Authorization: 'Bearer wrong-token' } }, env);
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test('the email health check sends only to Resend\'s test inbox from the real sender', async () => {
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response('{"id":"x"}', { status: 200 }); };
  const env = { ...fullEnv, MONITOR_TOKEN: 'right-token' };
  const res = await call('/api/health/email', { method: 'POST', headers: { Authorization: 'Bearer right-token' } }, env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(sent.url, 'https://api.resend.com/emails');
  assert.equal(sent.body.to, 'delivered@resend.dev');
  assert.equal(sent.body.from, fullEnv.RESEND_FROM);
});

test('a Resend rejection surfaces its status and message, and is logged', async () => {
  const lines = captureErrors();
  globalThis.fetch = async () => new Response(
    '{"message":"The fieldcred.co domain is not verified.","name":"validation_error","statusCode":403}',
    { status: 403 },
  );
  const env = { ...fullEnv, MONITOR_TOKEN: 'right-token' };
  const res = await call('/api/health/email', { method: 'POST', headers: { Authorization: 'Bearer right-token' } }, env);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { ok: false, status: 403, error: 'The fieldcred.co domain is not verified.' });
  assert.match(lines[0], /^\[health-email\] Resend rejected — http: 403 — The fieldcred\.co domain is not verified\.$/);
});
