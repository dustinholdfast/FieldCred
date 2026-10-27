import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker/endpoints.js';
import { resetRateLimits } from '../worker/rate-limit.js';
import { resetTokenCache } from '../worker/dataApi.js';
import { formatScanTime, scanAlertEmail } from '../worker/scanAlert.js';
import { requestBlockedScanAlert, shouldRequestAlert } from '../public/js/lib/scanAlert.js';

const ORIGIN = 'https://app.fieldcred.example';
const TENANTS = [{ slug: 'acme', name: 'Acme', authUrl: 'https://auth.example/neondb/auth', dataApiUrl: 'https://data.example/rest/v1' }];
const ENV = {
  ALERT_HOOK_SECRET: 'hook-secret-0123456789',
  RESEND_API_KEY: 're_test_key',
  RESEND_FROM: 'FieldCred <onboarding@fieldcred.co>',
};

const CLAIMED = {
  scan_id: '7a4e…',
  site_id: '11111111-2222-3333-4444-555555555555',
  site_name: 'North Gate',
  site_location: 'Toledo, OH',
  worker_name: 'Pat <b>Lane</b>',
  missing_types: [{ id: 't1', name: 'OSHA 30' }, { id: 't2', name: 'Confined Space' }],
  scanned_at: '2026-10-27T13:05:00Z',
  device_id: 'gate-0123456789',
  guard_label: 'M. Reyes',
  recipient: 'north-safety@example.com',
  timezone: 'America/New_York',
};

let ip = 0;
const realError = console.error;
let logs;
beforeEach(() => {
  resetRateLimits();
  resetTokenCache();
  logs = [];
  console.error = (...a) => logs.push(a.join(' '));
});
afterEach(() => { console.error = realError; });

function req(body, { method = 'POST', origin = ORIGIN, address = `198.51.100.${++ip}` } = {}) {
  const headers = { 'CF-Connecting-IP': address, 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}/api/scan-alert`, {
    method,
    headers,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

// claim: what /rpc/claim_blocked_scan_alert answers; resend: Resend's status.
function upstream({ claim = [CLAIMED], claimStatus = 200, resend = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/token/anonymous')) return Response.json({ token: 'anon-token' });
    if (String(url).endsWith('/rpc/claim_blocked_scan_alert')) {
      return claimStatus === 200 ? Response.json(claim) : new Response('{}', { status: claimStatus });
    }
    if (String(url) === 'https://api.resend.com/emails') return new Response('{"id":"e1"}', { status: resend });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetchImpl };
}

const body = { tenant: 'acme', site: 'north-gate-ab12', worker: 'pat-lane-cd34' };
const send = (request, env, up) => handleRequest(request, env, { tenants: TENANTS, fetchImpl: up.fetchImpl, nowMs: () => 1_000 });

test('a claimed blocked scan is emailed to the address the database returns', async () => {
  const up = upstream();
  const res = await send(req(body), ENV, up);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });

  const rpc = up.calls.find((c) => c.url.endsWith('/rpc/claim_blocked_scan_alert'));
  assert.equal(rpc.url, 'https://data.example/rest/v1/rpc/claim_blocked_scan_alert');
  assert.equal(rpc.init.headers.Authorization, 'Bearer anon-token');
  assert.deepEqual(rpc.body, { p_site_slug: 'north-gate-ab12', p_worker_slug: 'pat-lane-cd34', p_secret: ENV.ALERT_HOOK_SECRET });

  const mail = up.calls.find((c) => c.url === 'https://api.resend.com/emails');
  assert.equal(mail.body.to, 'north-safety@example.com');
  assert.equal(mail.body.from, ENV.RESEND_FROM);
  assert.equal(mail.body.subject, 'Turned away at North Gate: Pat <b>Lane</b>');
  assert.match(mail.body.html, /Pat &lt;b&gt;Lane&lt;\/b&gt;/);
  assert.doesNotMatch(mail.body.html, /<b>Lane<\/b>/);
  assert.match(mail.body.html, /OSHA 30/);
  assert.match(mail.body.html, /Confined Space/);
  assert.match(mail.body.html, /M\. Reyes · gate-0123456789/);
  assert.match(mail.body.html, /https:\/\/app\.fieldcred\.example\/#\/site\/11111111-2222-3333-4444-555555555555\/log/);
  assert.match(mail.body.text, /Missing or not current: OSHA 30, Confined Space/);
  assert.equal(logs.length, 0);
});

test('nothing to claim sends nothing and answers exactly like a send', async () => {
  const up = upstream({ claim: [] });
  const res = await send(req(body), ENV, up);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(up.calls.some((c) => c.url.includes('resend')), false);
  assert.equal(logs.length, 0);
});

test('with no ALERT_HOOK_SECRET nothing is called and the gap is logged', async () => {
  const up = upstream();
  const res = await send(req(body), { ...ENV, ALERT_HOOK_SECRET: '' }, up);
  assert.equal(res.status, 202);
  assert.equal(up.calls.length, 0);
  assert.match(logs[0], /^\[scan-alert\] ALERT_HOOK_SECRET is not set/);
});

test('a tenant without the migration is logged with the fix, not surfaced', async () => {
  const up = upstream({ claimStatus: 404 });
  const res = await send(req(body), ENV, up);
  assert.equal(res.status, 202);
  assert.match(logs[0], /claim failed for tenant acme — http: 404 \(apply neon\/migrations\/001_blocked_scan_alerts\.sql/);
  assert.equal(up.calls.some((c) => c.url.includes('resend')), false);
});

test('no recipient anywhere is logged and nothing is sent', async () => {
  const up = upstream({ claim: [{ ...CLAIMED, recipient: null }] });
  await send(req(body), ENV, up);
  assert.match(logs[0], /no alert address for site "North Gate"/);
  assert.equal(up.calls.some((c) => c.url.includes('resend')), false);
});

test('a Resend rejection is logged but the gate still gets 202', async () => {
  const up = upstream({ resend: 403 });
  const res = await send(req(body), ENV, up);
  assert.equal(res.status, 202);
  assert.match(logs[0], /^\[scan-alert\] Resend send failed — http: 403/);
});

test('unknown tenants, bad slugs, other origins and GETs are refused without upstream calls', async () => {
  const up = upstream();
  assert.equal((await send(req({ ...body, tenant: 'nope' }), ENV, up)).status, 202);
  assert.equal((await send(req({ ...body, tenant: 'BAD!' }), ENV, up)).status, 400);
  assert.equal((await send(req({ ...body, site: '../x' }), ENV, up)).status, 400);
  assert.equal((await send(req('not json'), ENV, up)).status, 400);
  assert.equal((await send(req(body, { origin: 'https://evil.example' }), ENV, up)).status, 403);
  assert.equal((await send(req(null, { method: 'GET' }), ENV, up)).status, 405);
  assert.equal(up.calls.length, 0);
});

test('a request with no Origin header (keepalive from some browsers) is accepted', async () => {
  const up = upstream();
  const res = await send(req(body, { origin: null }), ENV, up);
  assert.equal(res.status, 202);
  assert.ok(up.calls.some((c) => c.url.includes('resend')));
});

test('the route is rate limited per IP', async () => {
  const up = upstream({ claim: [] });
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await send(req(body, { address: '192.0.2.77' }), ENV, up)).status);
  assert.equal(statuses.filter((s) => s === 202).length, 30);
  assert.equal(statuses.at(-1), 429);
});

test('scan time is shown in the tenant timezone, falling back to UTC', () => {
  assert.equal(formatScanTime('2026-10-27T13:05:00Z', 'America/New_York'), 'Oct 27, 2026, 9:05 AM EDT');
  assert.equal(formatScanTime('2026-10-27T13:05:00Z', 'Not/AZone'), 'Oct 27, 2026, 1:05 PM UTC');
  assert.equal(formatScanTime('garbage', 'UTC'), '');
});

test('the email copes with a scan that has no missing list, gate details or site id', () => {
  const mail = scanAlertEmail({ ...CLAIMED, missing_types: null, device_id: null, guard_label: null, site_id: null, site_location: '' }, ORIGIN);
  assert.match(mail.html, /Not listed on the scan/);
  assert.match(mail.html, /Not recorded/);
  assert.match(mail.text, /Scan log: https:\/\/app\.fieldcred\.example\//);
});

test('the gate only asks for an alert on a blocked entry, by the server result', () => {
  assert.equal(shouldRequestAlert('blocked', 'in'), true);
  assert.equal(shouldRequestAlert('blocked', undefined), true);
  assert.equal(shouldRequestAlert('blocked', 'out'), false);
  assert.equal(shouldRequestAlert('cleared', 'in'), false);
  assert.equal(shouldRequestAlert('no_requirements', 'in'), false);
  assert.equal(shouldRequestAlert(undefined, 'in'), false);
});

test('the gate posts slugs only, with keepalive, and never throws', async () => {
  const sent = [];
  const fake = (url, init) => { sent.push({ url, init }); return Promise.resolve(new Response(null, { status: 202 })); };
  assert.equal(requestBlockedScanAlert('acme', 'north-gate-ab12', 'pat-lane-cd34', fake), true);
  assert.equal(sent[0].url, './api/scan-alert');
  assert.equal(sent[0].init.keepalive, true);
  assert.deepEqual(JSON.parse(sent[0].init.body), body);

  assert.equal(requestBlockedScanAlert(null, 's', 'w', fake), false);
  assert.equal(requestBlockedScanAlert('acme', '', 'w', fake), false);
  assert.equal(sent.length, 1);

  assert.equal(requestBlockedScanAlert('acme', 's', 'w', () => Promise.reject(new Error('offline'))), true);
  assert.equal(requestBlockedScanAlert('acme', 's', 'w', () => { throw new Error('boom'); }), false);
  await new Promise((r) => setTimeout(r, 0)); // let the rejected promise settle without an unhandled rejection
});
