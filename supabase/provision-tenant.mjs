#!/usr/bin/env node
// FieldCred tenant provisioning — automates the checklist in PROVISIONING.md.
//
// Usage:
//   node provision-tenant.mjs manifests/acme.json [--dry-run] [--apply-registry] [--force-reinvite]
//
// Requires (environment, never in the manifest):
//   SUPABASE_ACCESS_TOKEN   — Management API personal access token
//                             (supabase.com/dashboard/account/tokens)
//
// A manifest is a small JSON file — see manifests/EXAMPLE.json. It holds no
// privileged credentials; SUPABASE_ACCESS_TOKEN is the only credential this
// script needs, and it must come from the environment (or a managed secret
// store — see supabase/TENANCY-MODEL.md), never committed or written into a
// manifest file.
//
// What this does, in order (each step logged so a partial failure shows
// exactly where to resume):
//   1. Create the Supabase project (skipped if a project with this name
//      already exists in the org — idempotent), and immediately disable
//      Supabase's self-service signup for it (see disableSelfServiceSignup
//      below) — otherwise anyone holding this tenant's public anon key
//      could call /auth/v1/signup directly and mint their own session,
//      bypassing this script and PROVISIONING.md step 3 entirely.
//   2. Wait for the pooler connection to become reachable (empirically,
//      project creation "succeeding" at the API level doesn't mean the
//      pooler has registered the new project's tenant yet — this polls
//      until a real connection succeeds rather than guessing a fixed delay).
//   3. Apply schema.sql, then every migrations/NNN_*.sql file in order.
//   4. Set plan_limits from the manifest's planTier/maxWorkers.
//   5. Invite the admin user by email (Supabase sends them a set-password
//      link — nothing this script generates needs to be relayed manually).
//   6. Print the exact tenants.php entry to add, and (with --apply-registry)
//      write it directly into the LOCAL tenants.php here — this still does
//      not upload it; FTP to production stays a manual step (no FTP
//      integration exists yet; see PROVISIONING.md step 4).
//   7. Print this tenant's DB connection string as a `.env.local` line.
//      This is the only moment this password is ever available — Supabase
//      never exposes it again after creation. Save it now, or
//      fleet-migrate.mjs (Phase 2.3) can never reach this tenant directly.
//
// --dry-run prints every step's plan without executing anything network-side
// except read-only existence checks (so it can tell you whether the project
// already exists).
//
// --apply-registry edits the local tenants.php (inserted before the final
// "];") instead of only printing the entry to paste in by hand. Skipped
// automatically if that slug is already present, so it's safe to combine
// with a resumed/re-run.
//
// --force-reinvite: when resuming into an already-existing project (see
// finishFromExistingProject), this script refuses by default to invite
// manifest.adminEmail if the project already has OTHER users on file and
// none of them is that email — that's exactly the shape of a slug-collision
// attack (someone else's checkout/manifest targeting an existing tenant's
// slug), not a legitimate resume. Pass this flag only if you've confirmed
// by hand that inviting a new email into that populated project is what
// you actually want (e.g. deliberately adding a second admin).
//
// Rollback: nothing here is silently destructive. If a later step fails,
// re-running is safe (every step checks current state first) — fix the
// failure and re-run rather than needing a separate rollback path. The one
// step this can't undo by re-running is project creation itself; delete the
// half-created project from the dashboard if you want to abandon it rather
// than fix-and-resume.

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Client } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const manifestPath = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const applyRegistry = args.includes('--apply-registry');
const forceReinvite = args.includes('--force-reinvite');

if (!manifestPath) {
  console.error('Usage: node provision-tenant.mjs <manifest.json> [--dry-run]');
  process.exit(1);
}

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — export it from your shell, never hardcode it here or in the manifest.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const required = ['slug', 'name', 'organizationId', 'region', 'adminEmail'];
for (const key of required) {
  if (!manifest[key]) {
    console.error(`Manifest is missing required field "${key}"`);
    process.exit(1);
  }
}
if (manifest.dbPass || manifest.password || manifest.serviceRoleKey || manifest.accessToken) {
  console.error('Manifest must not contain credentials (dbPass/password/serviceRoleKey/accessToken) — this script generates its own DB password and never persists it in the manifest.');
  process.exit(1);
}

const planTier = manifest.planTier || 'unlimited';
const maxWorkers = manifest.maxWorkers ?? null;
const projectName = `fieldcred-${manifest.slug}`;

function log(step, msg) {
  console.log(`[${new Date().toISOString()}] [${step}] ${msg}`);
}

async function api(path, options = {}) {
  const res = await fetch(`https://api.supabase.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function findExistingProject() {
  const projects = await api('/v1/projects');
  return projects.find((p) => p.name === projectName && p.organization_id === manifest.organizationId);
}

// Closes the self-signup gap: without this, a tenant's anon key (which is
// necessarily public — shipped to the browser, stored in tenants.php) is
// enough on its own to call this project's /auth/v1/signup directly and
// mint a confirmed session with no invite, no app involved, and no fc_role
// set — which current_fc_role() (as of migration 012) now resolves to
// 'unassigned', but disabling signup outright is the real fix: there should
// be no way into a tenant except an explicit invite from this script or the
// dashboard.
async function disableSelfServiceSignup(ref) {
  await api(`/v1/projects/${ref}/config/auth`, {
    method: 'PATCH',
    body: JSON.stringify({ disable_signup: true }),
  });
  log('provision', 'disabled self-service signup for this project (auth.disable_signup=true) — an invite from here on is the only way in');
}

// Used by both finishFromExistingProject's --force-reinvite guard (tell
// "resuming my own tenant" apart from "someone else's checkout collided
// with an existing tenant's slug") and inviteAdmin's findUserIdByEmail
// (resolve the user id to set fc_role on when the invite call itself
// reports "already exists" instead of returning a fresh user object).
async function listExistingUsers(ref, serviceRoleKey) {
  const res = await fetch(`https://${ref}.supabase.co/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Could not list existing users for ${ref}: ${JSON.stringify(body)}`);
  return body.users || [];
}

async function createProject() {
  const dbPassword = (await import('crypto')).randomBytes(24).toString('base64').replace(/[+/=]/g, 'x');
  const project = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: projectName,
      organization_id: manifest.organizationId,
      region: manifest.region,
      db_pass: dbPassword,
      plan: manifest.billingPlan || 'free',
    }),
  });
  return { project, dbPassword };
}

// 40 attempts * 8s = ~5 minutes. Was 20 (~2.5 min) until a real run took
// over 160s and hit that ceiling (2026-07-13) — pooler registration delay
// for a brand-new project is apparently more variable than first observed.
async function waitForPooler(ref, dbPassword, maxAttempts = 40) {
  const connectionString = `postgresql://postgres.${ref}:${encodeURIComponent(dbPassword)}@aws-1-${manifest.region}.pooler.supabase.com:5432/postgres`;
  for (let i = 1; i <= maxAttempts; i++) {
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      await client.end();
      return connectionString;
    } catch (e) {
      log('provision', `pooler not ready yet (attempt ${i}/${maxAttempts}): ${e.message}`);
      try {
        await client.end();
      } catch {}
      await new Promise((r) => setTimeout(r, 8000));
    }
  }
  throw new Error('Pooler connection never became reachable — check the project region/ref and try again later.');
}

async function applySchemaAndMigrations(connectionString) {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const schemaSql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schemaSql);
    log('provision', 'applied schema.sql (baseline)');

    const migrationsDir = join(__dirname, 'migrations');
    const migrationFiles = readdirSync(migrationsDir)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();
    for (const file of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      await client.query(sql);
      log('provision', `applied migration ${file}`);
    }

    await client.query('update public.plan_limits set plan_tier = $1, max_workers = $2 where id = 1', [planTier, maxWorkers]);
    log('provision', `set plan_limits: tier=${planTier} maxWorkers=${maxWorkers ?? 'unlimited'}`);
  } finally {
    await client.end();
  }
}

// Resolves ok even if the user was already invited on a prior run of this
// script — that's exactly the "resume after partial failure" case, not an
// error.
//
// As of migration 012, current_fc_role() no longer defaults an absent
// fc_role claim to 'admin' — it defaults to 'unassigned' (no access). That
// means this step MUST explicitly set fc_role="admin" on the invited user,
// or every newly-provisioned tenant's first admin would be invited into an
// account with no access at all. This is what makes the safer default in
// migration 012 safe rather than a silent onboarding break.
async function inviteAdmin(ref, serviceRoleKey) {
  const res = await fetch(`https://${ref}.supabase.co/auth/v1/invite`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: manifest.adminEmail }),
  });
  const body = await res.json();
  let userId = body?.id || null;
  if (!res.ok) {
    if (body.error_code === 'email_exists' || body.code === 422) {
      log('provision', `admin ${manifest.adminEmail} already invited/exists — looking up their user id to confirm fc_role is set`);
      userId = await findUserIdByEmail(ref, serviceRoleKey, manifest.adminEmail);
    } else {
      throw new Error(`Admin invite failed: ${JSON.stringify(body)}`);
    }
  } else {
    log('provision', `invited admin ${manifest.adminEmail} — they'll receive a set-password email`);
  }

  if (!userId) {
    log('provision', `WARNING: could not resolve a user id for ${manifest.adminEmail} to set fc_role — set app_metadata {"fc_role":"admin"} on this user by hand via the dashboard (Authentication -> Users), or they will have NO access once they set their password (migration 012's default is "unassigned", not "admin").`);
    return;
  }
  await setFcRole(ref, serviceRoleKey, userId, 'admin');
}

async function findUserIdByEmail(ref, serviceRoleKey, email) {
  const users = await listExistingUsers(ref, serviceRoleKey);
  const match = users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
  return match?.id || null;
}

async function setFcRole(ref, serviceRoleKey, userId, role) {
  const res = await fetch(`https://${ref}.supabase.co/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ app_metadata: { fc_role: role } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Invited ${manifest.adminEmail} but failed to set app_metadata.fc_role="${role}" on them ` +
        `(${JSON.stringify(body)}) — set it by hand via the dashboard before handing over the login, ` +
        `or they will have no access at all once they set their password.`
    );
  }
  log('provision', `set app_metadata.fc_role="${role}" on ${manifest.adminEmail} — required since migration 012 removed the implicit admin-by-default`);
}

async function finishFromExistingProject(project) {
  // Deliberately does NOT re-run schema/migrations here: Supabase never
  // exposes a project's DB password after creation, so reconnecting would
  // require resetting it — riskier than it's worth for the common case,
  // where schema application already succeeded (it runs immediately after
  // this script generates and holds the password itself, during fresh
  // creation). But that assumption can be WRONG — a real run (2026-07-13)
  // failed at the pooler-wait step, after the project existed but before
  // schema ever applied. Silently resuming straight to invite/registry in
  // that case would produce a tenant that looks provisioned but has no
  // database schema at all. Check for real before trusting the assumption.
  const keys = await api(`/v1/projects/${project.ref}/api-keys`);
  const publishable = keys.find((k) => k.type === 'publishable');
  const serviceRole = keys.find((k) => k.name === 'service_role');
  if (!publishable) throw new Error('Could not find a publishable API key for this project');

  const schemaCheck = await fetch(`https://${project.ref}.supabase.co/rest/v1/public_workers?select=id&limit=1`, {
    headers: { apikey: publishable.api_key },
  });
  if (!schemaCheck.ok) {
    throw new Error(
      `Project "${projectName}" exists but its schema doesn't look applied yet ` +
        `(public_workers query returned ${schemaCheck.status}). This can happen if a previous ` +
        `run failed before schema application finished. Since the DB password from creation ` +
        `can't be recovered, this script can't safely apply schema.sql/migrations to an ` +
        `already-existing project — either wait a few minutes and re-run (if the project is ` +
        `still settling), or run schema.sql + migrations by hand via this project's SQL Editor, ` +
        `then re-run this script to finish the invite/registry steps.`
    );
  }
  log('provision', 'schema check passed (public_workers is queryable) — safe to proceed with invite/registry');

  const existingUsers = await listExistingUsers(project.ref, serviceRole.api_key);
  const existingEmails = existingUsers.map((u) => (u.email || '').toLowerCase());
  const targetEmail = manifest.adminEmail.toLowerCase();
  if (existingEmails.length && !existingEmails.includes(targetEmail)) {
    if (!forceReinvite) {
      throw new Error(
        `Project "${projectName}" already has ${existingEmails.length} user(s) on file and none of ` +
          `them is "${manifest.adminEmail}". Refusing to invite a new email into an already-populated ` +
          `tenant — this is exactly the shape of a slug-collision attack (someone else's checkout/manifest ` +
          `targeting an existing tenant's slug), not a normal resume. If you've confirmed by hand that ` +
          `this really is legitimate, re-run with --force-reinvite.`
      );
    }
    log('provision', `--force-reinvite set — proceeding to invite ${manifest.adminEmail} into a project that already has other users`);
  }

  await inviteAdmin(project.ref, serviceRole.api_key);
  printRegistryEntry(project.ref, publishable.api_key);
}

// Supabase never exposes a project's DB password after creation — this is
// the one and only moment this script (or anything else) ever holds it. If
// it's not saved now, fleet-migrate.mjs (see FIELDCRED-REMAINING-PLAN.md
// Phase 2.3) has no way to reach this tenant's database directly, ever
// again, short of resetting the password by hand via the dashboard.
function printDbUrl(connectionString) {
  const envKey = `TENANT_${manifest.slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DB_URL`;
  console.log(`\n--- .env.local entry (save this now — it cannot be recovered later) ---\n`);
  console.log(`${envKey}=${connectionString}\n`);
  console.log(`Add that line to .env.local — fleet-migrate.mjs needs it to reach this tenant's database.\n`);
}

function registryEntryPhp(ref, anonKey) {
  const lines = [
    `    '${manifest.slug}' => [`,
    `        'name' => ${JSON.stringify(manifest.name)},`,
    `        'url' => 'https://${ref}.supabase.co',`,
    `        'anonKey' => ${JSON.stringify(anonKey)},`,
  ];
  if (manifest.domains?.length) {
    lines.push(`        'domains' => ${JSON.stringify(manifest.domains)},`);
  }
  lines.push('    ],');
  return lines.join('\n');
}

function printRegistryEntry(ref, anonKey) {
  const entry = registryEntryPhp(ref, anonKey);
  console.log('\n--- tenants.php entry ---\n');
  console.log(entry + '\n');

  if (!applyRegistry) {
    console.log('Paste that into tenants.php and upload via FTP — see PROVISIONING.md step 4 (no automated deploy path yet), or re-run with --apply-registry to write it into the local file for you.');
    return;
  }

  const tenantsPath = join(__dirname, '..', 'tenants.php');
  const contents = readFileSync(tenantsPath, 'utf8');
  if (contents.includes(`'${manifest.slug}' =>`)) {
    log('provision', `tenants.php already has an entry for "${manifest.slug}" — not touching it, left as-is`);
    return;
  }
  const marker = '];';
  const lastIndex = contents.lastIndexOf(marker);
  if (lastIndex === -1) {
    console.error("Couldn't find the closing '];' in tenants.php — leaving it untouched, paste the entry above in by hand.");
    return;
  }
  const updated = contents.slice(0, lastIndex) + entry + '\n\n' + contents.slice(lastIndex);
  writeFileSync(tenantsPath, updated);
  log('provision', `wrote the ${manifest.slug} entry into local tenants.php — still needs FTP upload to production (PROVISIONING.md step 4)`);
}

async function main() {
  log('provision', `starting for slug="${manifest.slug}" (${dryRun ? 'DRY RUN' : 'LIVE'})`);

  const existing = await findExistingProject();
  if (existing) {
    log('provision', `project "${projectName}" already exists (ref ${existing.ref}, status ${existing.status}) — resuming from the API-key/invite step (schema/migrations only run on fresh creation, see code comment)`);
    if (dryRun) {
      log('provision', 'dry run complete — would resume by fetching API keys, (re-)inviting the admin, and printing the tenants.php entry');
      return;
    }
    await finishFromExistingProject(existing);
    log('provision', 'done (resumed)');
    return;
  }

  if (dryRun) {
    log('provision', `would create project "${projectName}" in org ${manifest.organizationId}, region ${manifest.region}`);
    log('provision', 'would apply schema.sql + migrations, set plan_limits, invite admin, and print the tenants.php entry');
    return;
  }

  const { project, dbPassword } = await createProject();
  log('provision', `created project ${project.ref}`);

  await disableSelfServiceSignup(project.ref);

  const connectionString = await waitForPooler(project.ref, dbPassword);
  log('provision', 'pooler reachable');

  await applySchemaAndMigrations(connectionString);

  const keys = await api(`/v1/projects/${project.ref}/api-keys`);
  const publishable = keys.find((k) => k.type === 'publishable');
  const serviceRole = keys.find((k) => k.name === 'service_role');
  if (!publishable) throw new Error('Could not find a publishable API key for the new project');

  await inviteAdmin(project.ref, serviceRole.api_key);
  printRegistryEntry(project.ref, publishable.api_key);
  printDbUrl(connectionString);
  log('provision', 'done');
}

main().catch((err) => {
  console.error(`\n[FAILED] ${err.message}\nRe-run this same command after fixing the issue — every step checks current state first, so it is safe to resume.`);
  process.exit(1);
});
