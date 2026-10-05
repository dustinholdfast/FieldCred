import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest, findTenantByDomainIn, LIMITS } from '../worker/endpoints.js';
import { collectAssetPaths } from '../scripts/stage-assets.mjs';
import { resetRateLimits } from '../worker/rate-limit.js';
import { resetFileCache } from '../worker/files.js';
import { TENANTS } from '../worker/tenants.js';

const ORIGIN = 'https://fieldcred.example.workers.dev';

function req(path, { method = 'GET', body, headers = {}, ip = '203.0.113.5' } = {}) {
  const init = {
    method,
    headers: { 'CF-Connecting-IP': ip, ...headers },
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
  }
  return new Request(`${ORIGIN}${path}`, init);
}

async function readJson(response) {
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('worker registry matches tenants.php and publishes Neon URLs only', () => {
  const source = readFileSync(new URL('../tenants.php', import.meta.url), 'utf8');
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  const entries = [];
  const entryRe = /['"]([a-z0-9-]+)['"]\s*=>\s*\[([\s\S]*?)\n\s*\]/g;
  let match;
  while ((match = entryRe.exec(stripped))) {
    const slug = match[1];
    const block = match[2];
    const field = (name) => {
      const found = block.match(new RegExp(`['"]${name}['"]\\s*=>\\s*(['"])([\\s\\S]*?)\\1`));
      return found ? found[2] : undefined;
    };
    const domains = [];
    const domainsBlock = block.match(/['"]domains['"]\s*=>\s*\[([\s\S]*?)\]/);
    if (domainsBlock) {
      const domainRe = /['"]([^'"]+)['"]/g;
      let domainMatch;
      while ((domainMatch = domainRe.exec(domainsBlock[1]))) domains.push(domainMatch[1]);
    }
    entries.push({
      slug,
      name: field('name') ?? slug,
      authUrl: field('authUrl'),
      dataApiUrl: field('dataApiUrl'),
      domains,
    });
  }

  assert.deepEqual(TENANTS, entries);
  for (const entry of TENANTS) {
    assert.equal(entry.authUrl.includes('supabase.co'), false);
    assert.equal(entry.dataApiUrl.includes('supabase.co'), false);
    assert.equal(entry.authUrl.startsWith('https://'), true);
    assert.equal(entry.dataApiUrl.endsWith('/rest/v1'), true);
  }
});

test('wrangler config is the fieldcred Worker with no custom domain', () => {
  const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(json.name, 'fieldcred');
  assert.equal(json.compatibility_date, '2026-10-04');
  assert.equal(json.main, 'worker/index.js');
  assert.equal(json.workers_dev, true);
  assert.equal(json.assets.binding, 'ASSETS');
  assert.equal(json.assets.directory, './dist');
  assert.equal(json.build.command, 'node scripts/stage-assets.mjs');
  assert.equal(json.route, undefined);
  assert.equal(json.routes, undefined);
  assert.ok(json.assets.run_worker_first.includes('/'));
  assert.ok(json.assets.run_worker_first.includes('/tenant-lookup.php'));
  assert.ok(json.assets.run_worker_first.includes('/tenant-lookup-by-domain.php'));
  assert.ok(json.assets.run_worker_first.includes('/signup-notify.php'));
  assert.equal(json.vars.RESEND_API_KEY, undefined);
  assert.equal(/re_[A-Za-z0-9]{10,}/.test(raw), false);

  const ignore = readFileSync(new URL('../.assetsignore', import.meta.url), 'utf8');
  for (const line of ['*.php', '/billing-service/', '/neon/', '/supabase/', '/worker/', '/Marketing/', '/dist/']) {
    assert.ok(ignore.includes(line), line);
  }
  assert.ok(json.assets.run_worker_first.includes('/file.php'));
});

test('staged assets are the public app and not the PHP sources', async () => {
  const files = await collectAssetPaths();
  for (const required of [
    'index.html',
    'sw.js',
    'js/main.js',
    'js/vendor/jsqr.mjs',
    'js/vendor/neon-js.js',
    'js/lib/backendClient.js',
    'manifest.webmanifest',
    '.well-known/assetlinks.json',
    '_headers',
    'js/vendor/tesseract/eng.traineddata.gz',
  ]) {
    assert.ok(files.includes(required), required);
  }
  for (const blocked of files) {
    assert.equal(blocked.endsWith('.php'), false, blocked);
    assert.equal(blocked.startsWith('billing-service/'), false, blocked);
    assert.equal(blocked.startsWith('supabase/'), false, blocked);
    assert.equal(blocked.startsWith('neon/'), false, blocked);
    assert.equal(blocked.endsWith('supabase-js.js'), false, blocked);
    assert.equal(blocked.startsWith('worker/'), false, blocked);
    assert.equal(blocked.includes('node_modules'), false, blocked);
  }
});

test('tenant lookup returns the demo registry entry', async () => {
  resetRateLimits();
  const res = await readJson(await handleRequest(req('/tenant-lookup.php?tenant=demo', { ip: '203.0.113.21' })));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(res.body, {
    name: 'Demo',
    authUrl: 'https://ep-falling-dream-b4s5gk7v.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth',
    dataApiUrl: 'https://ep-falling-dream-b4s5gk7v.apirest.c-6.us-east-2.aws.neon.tech/neondb/rest/v1',
  });
  assert.equal(JSON.stringify(res.body).includes('supabase.co'), false);
  assert.equal('url' in res.body, false);
  assert.equal('anonKey' in res.body, false);
  assert.equal('domains' in res.body, false);
});

test('tenant lookup rejects a bad slug before counting it, and 404s unknown slugs', async () => {
  resetRateLimits();
  const bad = await readJson(await handleRequest(req('/tenant-lookup.php?tenant=Demo', { ip: '203.0.113.22' })));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'Invalid tenant slug');

  const missing = await readJson(await handleRequest(req('/tenant-lookup.php?tenant=nope', { ip: '203.0.113.22' })));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'Unknown tenant');
});

test('tenant lookup rate limit matches the PHP cap', async () => {
  resetRateLimits();
  for (let i = 0; i < LIMITS.tenantLookup.max; i++) {
    const res = await handleRequest(req('/tenant-lookup.php?tenant=demo', { ip: '203.0.113.20' }), {}, { now: () => 1_000 });
    assert.equal(res.status, 200);
  }
  const blocked = await readJson(await handleRequest(req('/tenant-lookup.php?tenant=demo', { ip: '203.0.113.20' }), {}, { now: () => 1_000 }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'Too many requests — please try again later.');
  assert.equal(blocked.headers.get('retry-after'), String(LIMITS.tenantLookup.windowSeconds));

  const otherIp = await handleRequest(req('/tenant-lookup.php?tenant=demo', { ip: '203.0.113.9' }), {}, { now: () => 1_000 });
  assert.equal(otherIp.status, 200);
});

test('domain lookup validates email and returns one tenant', async () => {
  resetRateLimits();
  const tenants = [{
    slug: 'acme',
    name: 'Acme Corp',
    authUrl: 'https://ep-example.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth',
    dataApiUrl: 'https://ep-example.apirest.c-6.us-east-2.aws.neon.tech/neondb/rest/v1',
    domains: ['acmecorp.com'],
  }];
  const bad = await readJson(await handleRequest(req('/tenant-lookup-by-domain.php?email=not-an-email', { ip: '203.0.113.23' }), {}, { tenants }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'Invalid email');

  const badDomain = await readJson(await handleRequest(req('/tenant-lookup-by-domain.php?email=a@has_underscore.com', { ip: '203.0.113.23' }), {}, { tenants }));
  assert.equal(badDomain.status, 400);
  assert.equal(badDomain.body.error, 'Invalid email domain');

  const none = await readJson(await handleRequest(req('/tenant-lookup-by-domain.php?email=jane@other.com', { ip: '203.0.113.23' }), {}, { tenants }));
  assert.equal(none.status, 404);
  assert.equal(none.body.error, 'No tenant found for that email domain');

  const hit = await readJson(await handleRequest(req('/tenant-lookup-by-domain.php?email=Jane@AcmeCorp.com', { ip: '203.0.113.23' }), {}, { tenants }));
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.body, {
    slug: 'acme',
    name: 'Acme Corp',
    authUrl: 'https://ep-example.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth',
    dataApiUrl: 'https://ep-example.apirest.c-6.us-east-2.aws.neon.tech/neondb/rest/v1',
  });
  assert.equal(findTenantByDomainIn(TENANTS, 'acmecorp.com'), null);
});

test('dustin@fieldcred.co resolves to the demo tenant', async () => {
  resetRateLimits();
  const res = await readJson(await handleRequest(req('/tenant-lookup-by-domain.php?email=dustin@fieldcred.co', { ip: '203.0.113.31' })));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res.body, {
    slug: 'demo',
    name: 'Demo',
    authUrl: 'https://ep-falling-dream-b4s5gk7v.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth',
    dataApiUrl: 'https://ep-falling-dream-b4s5gk7v.apirest.c-6.us-east-2.aws.neon.tech/neondb/rest/v1',
  });
  assert.equal('domains' in res.body, false);
});

test('signup notify keeps the PHP response shapes', async () => {
  resetRateLimits();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"id":"email_1"}', { status: 200 });
  };
  const env = {
    RESEND_API_KEY: 'test-key',
    RESEND_FROM: 'FieldCred <onboarding@fieldcred.co>',
    NOTIFY_EMAIL: 'dustin@fieldcred.co',
  };
  const deps = { fetchImpl, now: () => 5_000 };

  const get = await readJson(await handleRequest(req('/signup-notify.php', { ip: '203.0.113.24' }), env, deps));
  assert.equal(get.status, 405);
  assert.equal(get.body.error, 'Method not allowed');

  const junk = await readJson(await handleRequest(req('/signup-notify.php', { method: 'POST', body: 'not-json', ip: '203.0.113.24' }), env, deps));
  assert.equal(junk.status, 400);
  assert.equal(junk.body.error, 'Invalid request body');

  const trap = await readJson(await handleRequest(req('/signup-notify.php', {
    method: 'POST',
    ip: '203.0.113.24',
    body: { companyName: 'Spam Co', adminEmail: 'a@b.co', website: 'http://spam.example' },
  }), env, deps));
  assert.equal(trap.status, 200);
  assert.deepEqual(trap.body, { ok: true });
  assert.equal(calls.length, 0);

  const noCompany = await readJson(await handleRequest(req('/signup-notify.php', {
    method: 'POST',
    ip: '203.0.113.24',
    body: { companyName: '   ', adminEmail: 'a@b.co' },
  }), env, deps));
  assert.equal(noCompany.status, 400);
  assert.equal(noCompany.body.error, 'Company name is required');

  const badEmail = await readJson(await handleRequest(req('/signup-notify.php', {
    method: 'POST',
    ip: '203.0.113.24',
    body: { companyName: 'Acme', adminEmail: 'nope' },
  }), env, deps));
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.body.error, 'A valid admin email is required');

  const badDomain = await readJson(await handleRequest(req('/signup-notify.php', {
    method: 'POST',
    ip: '203.0.113.24',
    body: { companyName: 'Acme', adminEmail: 'a@b.co', domain: 'not a domain' },
  }), env, deps));
  assert.equal(badDomain.status, 400);
  assert.equal(badDomain.body.error, "That domain doesn't look right");

  resetRateLimits();
  const unconfigured = await readJson(await handleRequest(req('/signup-notify.php', {
    method: 'POST',
    ip: '203.0.113.24',
    body: { companyName: 'Acme', adminEmail: 'a@b.co' },
  }), {}, deps));
  assert.equal(unconfigured.status, 500);
  assert.equal(unconfigured.body.error, 'Signup notifications are not configured yet');

  const sent = await readJson(await handleRequest(req('/signup-notify.php', {
    method: 'POST',
    ip: '203.0.113.24',
    body: {
      companyName: 'Acme <script>',
      adminEmail: 'a@b.co',
      domain: 'acme.com',
      note: 'line1\nline2',
      kind: 'upgrade',
    },
  }), env, deps));
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.from, env.RESEND_FROM);
  assert.equal(payload.to, env.NOTIFY_EMAIL);
  assert.equal(payload.reply_to, 'a@b.co');
  assert.equal(payload.subject, 'FieldCred signup request: Acme <script>');
  assert.match(payload.html, /Acme &lt;script&gt;/);
  assert.equal(payload.html.includes('\n'), false);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.stringify(sent.body).includes('test-key'), false);

  fetchImpl.fail = true;
  const failingFetch = async () => new Response('nope', { status: 403 });
  const failed = await readJson(await handleRequest(req('/signup-notify.php', {
    method: 'POST',
    ip: '203.0.113.24',
    body: { companyName: 'Acme', adminEmail: 'a@b.co' },
  }), env, { fetchImpl: failingFetch, now: () => 5_000 }));
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, 'Could not send notification email');
});

test('signup notify rate limit is 5 per hour per IP', async () => {
  resetRateLimits();
  const env = {
    RESEND_API_KEY: 'test-key',
    RESEND_FROM: 'FieldCred <onboarding@fieldcred.co>',
    NOTIFY_EMAIL: 'dustin@fieldcred.co',
  };
  const deps = {
    now: () => 9_000,
    fetchImpl: async () => new Response('{}', { status: 200 }),
  };
  for (let i = 0; i < LIMITS.signup.max; i++) {
    const res = await handleRequest(req('/signup-notify.php', {
      method: 'POST',
      ip: '203.0.113.25',
      body: { companyName: 'Acme', adminEmail: 'a@b.co' },
    }), env, deps);
    assert.equal(res.status, 200);
  }
  const blocked = await readJson(await handleRequest(req('/signup-notify.php', {
    method: 'POST',
    ip: '203.0.113.25',
    body: { companyName: 'Acme', adminEmail: 'a@b.co' },
  }), env, deps));
  assert.equal(blocked.status, 429);
});

test('private PHP files are not served, and unknown paths fall through to assets', async () => {
  resetRateLimits();
  for (const path of ['/tenants.php', '/signup-config.php', '/rate-limit.php']) {
    const res = await handleRequest(req(path));
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.equal(text, 'Forbidden');
    assert.equal(text.includes('anonKey'), false);
    assert.equal(text.includes('resend'), false);
  }

  let forwarded = null;
  const env = {
    ASSETS: {
      async fetch(request) {
        forwarded = request.url;
        return new Response('missing', { status: 404 });
      },
    },
  };
  const missing = await handleRequest(req('/not-a-real-page.txt'), env);
  assert.equal(missing.status, 404);
  assert.equal(forwarded, `${ORIGIN}/not-a-real-page.txt`);

  const shell = await handleRequest(req('/index.html'), env);
  assert.equal(shell.status, 404);
  assert.equal(forwarded, `${ORIGIN}/index.html`);

  const root = await handleRequest(req('/'), env);
  assert.equal(root.status, 404);
  assert.equal(forwarded, `${ORIGIN}/index.html`);

  const guides = await handleRequest(req('/guides/'), env);
  assert.equal(guides.status, 404);
  assert.equal(forwarded, `${ORIGIN}/guides/index.html`);
});

test('boot files do not send the browser to supabase.co', () => {
  const files = [
    'index.html',
    'sw.js',
    'js/lib/config.js',
    'js/lib/backendClient.js',
    'js/main.js',
    'worker/tenants.js',
    'tenants.php',
  ];
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(text.includes('supabase.co'), false, file);
  }
});

test('file.php streams a public photo through the Data API and not Postgres', async () => {
  resetFileCache();
  const calls = [];
  const png = btoa('png-bytes');
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith('/token/anonymous')) {
      return Response.json({ token: 'anon-token', expires_at: '2099-01-01T00:00:00Z' });
    }
    return Response.json([{ content_type: 'image/png', data: png }]);
  };
  const res = await handleRequest(req('/file.php?tenant=demo&bucket=photos&path=abc.png'), {}, {
    fetchImpl,
    nowMs: () => 1_000,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(new TextDecoder().decode(body), 'png-bytes');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${TENANTS[0].authUrl}/token/anonymous`);
  assert.equal(calls[1].url, `${TENANTS[0].dataApiUrl}/rpc/get_public_file`);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer anon-token');
  assert.equal(JSON.stringify(calls).includes('supabase.co'), false);
  assert.equal(calls.some((call) => String(call.url).includes('postgres')), false);
});

test('file.php refuses a private bucket and a bad grant, and 404s an empty file', async () => {
  resetFileCache();
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/token/anonymous')) return Response.json({ token: 'anon-token' });
    return Response.json([]);
  };
  const cert = await handleRequest(req('/file.php?tenant=demo&bucket=certificates&path=secret.pdf'), {}, { fetchImpl, nowMs: () => 2_000 });
  assert.equal(cert.status, 404);

  const badToken = await handleRequest(req('/file.php?tenant=demo&token=short'), {}, { fetchImpl, nowMs: () => 2_000 });
  assert.equal(badToken.status, 400);

  const missing = await handleRequest(req('/file.php?tenant=demo&bucket=photos&path=missing.png'), {}, { fetchImpl, nowMs: () => 2_000 });
  assert.equal(missing.status, 404);

  const unknown = await handleRequest(req('/file.php?tenant=nope&bucket=photos&path=a.png'), {}, { fetchImpl, nowMs: () => 2_000 });
  assert.equal(unknown.status, 404);
});
