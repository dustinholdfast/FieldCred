#!/usr/bin/env node
// FieldCred local provisioning dashboard — a form that writes a tenant
// manifest and runs provision-tenant.mjs for you, streaming its output
// live into the browser. Binds to 127.0.0.1, never 0.0.0.0, so
// SUPABASE_ACCESS_TOKEN (read once here from the environment, same as the
// CLI script) is harder to reach from the network by default — but that
// bind address is NOT authentication on its own: an SSH tunnel, a reverse
// proxy, or running this inside a container/VM whose loopback gets
// forwarded can all expose it despite the 127.0.0.1 bind. This server also
// requires a shared-secret token (ADMIN_DASHBOARD_TOKEN) on every request,
// checked with a constant-time comparison, so a bind-address slip doesn't
// by itself hand out the ability to create billed Supabase projects and
// invite arbitrary emails as tenant admins.
//
// Usage:
//   1. Generate a token once: openssl rand -hex 32
//   2. ADMIN_DASHBOARD_TOKEN=<that value> SUPABASE_ACCESS_TOKEN=sbp_... node server.mjs
//   3. Open http://127.0.0.1:4173/?token=<that value> — the page stores it
//      in sessionStorage and strips it from the visible URL, then sends it
//      as an X-Admin-Token header on every /provision call. Closing the tab
//      clears it; re-open with the ?token= link again next time.
//
// Requires `npm install` in supabase/ first (this reuses provision-tenant.mjs
// as a child process, so only needs the `pg` dependency that script already
// declares — nothing new to install here).

import { createServer } from 'http';
import { spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { timingSafeEqual, createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4173;

if (!process.env.SUPABASE_ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set. Export it before starting this server:');
  console.error('  SUPABASE_ACCESS_TOKEN=sbp_... node server.mjs');
  process.exit(1);
}

const ADMIN_TOKEN = process.env.ADMIN_DASHBOARD_TOKEN;
if (!ADMIN_TOKEN) {
  console.error('ADMIN_DASHBOARD_TOKEN is not set. This dashboard holds SUPABASE_ACCESS_TOKEN in its');
  console.error('process and can create billed projects / invite tenant admins — binding to 127.0.0.1');
  console.error('alone is not authentication (a tunnel, proxy, or container network can still expose it).');
  console.error('Generate one and export it before starting:');
  console.error('  openssl rand -hex 32');
  console.error('  ADMIN_DASHBOARD_TOKEN=<value> SUPABASE_ACCESS_TOKEN=sbp_... node server.mjs');
  process.exit(1);
}

function isAuthorized(req, url) {
  const supplied = req.headers['x-admin-token'] || url.searchParams.get('token') || '';
  // Compare fixed-length hashes rather than the raw values, so a
  // wrong-length guess doesn't hit a different code path than a
  // right-length-wrong-value one — timingSafeEqual requires equal-length
  // buffers, and hashing first sidesteps that without leaking length.
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(ADMIN_TOKEN).digest();
  return timingSafeEqual(a, b);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function validateManifest(m) {
  const errors = [];
  if (!m.slug || !SLUG_RE.test(m.slug)) errors.push('Slug must be lowercase letters/numbers/hyphens, 3–40 characters, not starting or ending with a hyphen.');
  if (!m.name || !m.name.trim()) errors.push('Company name is required.');
  if (!m.adminEmail || !EMAIL_RE.test(m.adminEmail)) errors.push('A valid admin email is required.');
  if (!m.organizationId) errors.push('Missing organization ID.');
  if (!m.region) errors.push('Missing region.');
  if (m.dbPass || m.password || m.serviceRoleKey || m.accessToken) errors.push('Manifest must not contain credential fields.');
  return errors;
}

async function handleProvision(req, res) {
  const raw = await readBody(req);
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const manifest = {
    slug: (input.slug || '').trim().toLowerCase(),
    name: (input.name || '').trim(),
    organizationId: input.organizationId || 'nsbnntisxkfvxyiaffyk',
    region: input.region || 'us-east-2',
    adminEmail: (input.adminEmail || '').trim(),
    domains: (input.domains || '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean),
    planTier: input.planTier || 'unlimited',
    maxWorkers: input.maxWorkers ? Number(input.maxWorkers) : null,
    billingPlan: input.billingPlan || 'free',
  };

  const errors = validateManifest(manifest);
  if (errors.length) return sendJson(res, 400, { error: errors.join(' ') });

  const manifestsDir = join(__dirname, '..', 'manifests');
  const manifestPath = join(manifestsDir, `${manifest.slug}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Stream the actual CLI script's output live via Server-Sent Events —
  // reuses provision-tenant.mjs as-is (spawned as a real child process,
  // not re-implemented here) so this dashboard can never drift from what
  // the documented, independently-tested CLI path actually does.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('log', `Wrote manifest to supabase/manifests/${manifest.slug}.json`);

  const child = spawn(
    process.execPath,
    [join(__dirname, '..', 'provision-tenant.mjs'), manifestPath, '--apply-registry'],
    { cwd: join(__dirname, '..'), env: process.env }
  );

  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) send('log', line);
    }
  });
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) send('log', line);
    }
  });
  child.on('close', (code) => {
    send(code === 0 ? 'done' : 'failed', { code });
    res.end();
  });

  req.on('close', () => {
    if (!child.killed) child.kill();
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    if (!isAuthorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized — open this page with ?token=<ADMIN_DASHBOARD_TOKEN>.');
      return;
    }
    const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/provision') {
    if (!isAuthorized(req, url)) {
      return sendJson(res, 401, { error: 'Unauthorized — missing or invalid X-Admin-Token.' });
    }
    try {
      await handleProvision(req, res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    }
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FieldCred provisioning dashboard: http://127.0.0.1:${PORT}/?token=${ADMIN_TOKEN}`);
  console.log('Bound to 127.0.0.1 by default, but every request also requires that token —');
  console.log('open the exact URL above (it strips the token from the visible address bar itself).');
});
