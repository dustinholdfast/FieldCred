#!/usr/bin/env node
// FieldCred fleet migration runner — Phase 2.3 of FIELDCRED-REMAINING-PLAN.md.
//
// Each tenant is a fully separate Supabase project (see TENANCY-MODEL.md),
// so a schema change has to be applied to every tenant's database
// individually. This enumerates tenants from tenants.php, checks each
// one's actual applied-migration state (public.schema_migrations, added in
// migration 004 — not the hand-maintained checklist in
// migrations/README.md, which can and did drift), applies whatever's
// pending, and reports what happened.
//
// Usage:
//   node fleet-migrate.mjs [--dry-run] [--tenant=<slug>] [--include-production] [--force]
//
// Requires (environment, never hardcoded):
//   SUPABASE_ACCESS_TOKEN     — Management API token, used only for the
//                               pre-flight backup-freshness check.
//   TENANT_<SLUG>_DB_URL      — one per tenant, e.g. TENANT_DEFAULT_DB_URL,
//                               TENANT_DEMO_DB_URL. provision-tenant.mjs
//                               prints this for every new tenant it
//                               creates — that's the only moment the DB
//                               password is ever available, so it must be
//                               saved into .env.local then or never.
//
// Targeting (canary gate): with no flags, targets every tenant EXCEPT
// 'default' (the real production tenant with real customer data) — you
// have to pass --include-production explicitly to touch it, or
// --tenant=default to target only it. This is the "test/canary/production"
// batching the plan calls for, sized to what this fleet actually is today
// (two tenants, one of them real) rather than a fictional three-tier setup.
//
// Backup check, not backup trigger: Supabase's Management API has no
// endpoint to take an on-demand backup, but Pro-tier projects get daily
// automatic ones (confirmed empirically 2026-07-13 — see TENANCY-MODEL.md).
// So instead of triggering a fresh one, this refuses to proceed against a
// tenant whose most recent completed backup is older than 36 hours, unless
// --force is passed.
//
// Each pending migration file is applied in its own transaction, and
// recorded into schema_migrations immediately after — so a failure partway
// through a tenant's pending list leaves a precise, resumable record of
// how far it got, not an all-or-nothing rollback across unrelated deltas.

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Client } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const includeProduction = args.includes('--include-production');
const explicitTenant = args.find((a) => a.startsWith('--tenant='))?.split('=')[1];

const managementToken = process.env.SUPABASE_ACCESS_TOKEN;
if (!managementToken && !dryRun) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — needed for the backup-freshness check (use --force to skip it, not recommended).');
}

function log(slug, msg) {
  console.log(`[${new Date().toISOString()}] [${slug}] ${msg}`);
}

function readTenantRegistry() {
  const source = readFileSync(join(projectRoot, 'tenants.php'), 'utf8');
  // Top-level tenant entries are indented exactly 4 spaces; nested keys
  // (e.g. 'domains' => [...]) sit one level deeper and must not match.
  const slugs = [...source.matchAll(/^ {4}'([a-z0-9_-]+)'\s*=>\s*\[/gm)].map((m) => m[1]);
  const entries = {};
  for (const slug of slugs) {
    const block = source.slice(source.indexOf(`'${slug}' =>`));
    const url = block.match(/'url'\s*=>\s*'([^']+)'/)?.[1];
    const ref = url?.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
    entries[slug] = { url, ref };
  }
  return entries;
}

function resolveConnectionString(slug) {
  const envKey = `TENANT_${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DB_URL`;
  return { envKey, connectionString: process.env[envKey] || null };
}

function pendingMigrationFiles() {
  return readdirSync(join(__dirname, 'migrations'))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((file) => ({ file, version: file.match(/^(\d+)_/)[1] }));
}

async function checkBackupFreshness(ref) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/backups`, {
    headers: { Authorization: `Bearer ${managementToken}` },
  });
  if (!res.ok) throw new Error(`backup check failed: ${res.status}`);
  const body = await res.json();
  const completed = (body.backups || []).filter((b) => b.status === 'COMPLETED');
  if (!completed.length) return { fresh: false, reason: 'no completed backups found' };
  const mostRecent = completed.sort((a, b) => new Date(b.inserted_at) - new Date(a.inserted_at))[0];
  const ageHours = (Date.now() - new Date(mostRecent.inserted_at)) / 36e5;
  return { fresh: ageHours <= 36, ageHours, mostRecent: mostRecent.inserted_at };
}

async function migrateTenant(slug, ref) {
  const report = { slug, ref, appliedThisRun: [], alreadyApplied: [], wouldApply: [], skipped: false, error: null };

  const { envKey, connectionString } = resolveConnectionString(slug);
  if (!connectionString) {
    report.skipped = true;
    report.error = `no DB connection configured — set ${envKey} in .env.local (see provision-tenant.mjs output from when this tenant was created)`;
    log(slug, `SKIP — ${report.error}`);
    return report;
  }

  if (!force) {
    if (!managementToken) {
      report.skipped = true;
      report.error = 'SUPABASE_ACCESS_TOKEN not set — cannot verify backup freshness; re-run with --force to skip this check';
      log(slug, `SKIP — ${report.error}`);
      return report;
    }
    try {
      const backup = await checkBackupFreshness(ref);
      if (!backup.fresh) {
        report.skipped = true;
        report.error = `most recent backup is too old or missing (${backup.reason || backup.ageHours.toFixed(1) + 'h ago'}) — re-run with --force to proceed anyway`;
        log(slug, `SKIP — ${report.error}`);
        return report;
      }
      log(slug, `backup check passed (most recent: ${backup.mostRecent})`);
    } catch (err) {
      report.skipped = true;
      report.error = `backup check failed: ${err.message} — re-run with --force to proceed anyway`;
      log(slug, `SKIP — ${report.error}`);
      return report;
    }
  } else {
    log(slug, 'backup check skipped (--force)');
  }

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(`
      create table if not exists public.schema_migrations (
        version    text primary key,
        applied_at timestamptz not null default now()
      );
      alter table public.schema_migrations enable row level security;
    `);

    const { rows } = await client.query('select version from public.schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    report.alreadyApplied = [...applied].sort();

    const pending = pendingMigrationFiles().filter((m) => !applied.has(m.version));
    if (!pending.length) {
      log(slug, `up to date (highest applied: ${report.alreadyApplied.at(-1) || 'none'})`);
      return report;
    }

    log(slug, `${pending.length} pending: ${pending.map((m) => m.version).join(', ')}`);
    if (dryRun) {
      log(slug, 'dry run — not applying');
      report.wouldApply = pending.map((m) => m.version);
      return report;
    }

    for (const { file, version } of pending) {
      const sql = readFileSync(join(__dirname, 'migrations', file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into public.schema_migrations (version) values ($1) on conflict (version) do nothing', [version]);
        await client.query('commit');
        report.appliedThisRun.push(version);
        log(slug, `applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        report.error = `failed applying ${file}: ${err.message}`;
        log(slug, `FAILED at ${file}: ${err.message} — earlier migrations this run were already committed individually and stay applied`);
        return report;
      }
    }
  } finally {
    await client.end();
  }
  return report;
}

async function main() {
  const registry = readTenantRegistry();
  const allSlugs = Object.keys(registry);

  let targets;
  if (explicitTenant) {
    if (!registry[explicitTenant]) {
      console.error(`Tenant '${explicitTenant}' not found in tenants.php. Known tenants: ${allSlugs.join(', ')}`);
      process.exit(1);
    }
    targets = [explicitTenant];
  } else {
    targets = allSlugs.filter((s) => s !== 'default' || includeProduction);
    if (!includeProduction && allSlugs.includes('default')) {
      log('fleet', `skipping 'default' (production) — pass --include-production to include it, or --tenant=default to target only it`);
    }
  }

  log('fleet', `${dryRun ? 'DRY RUN — ' : ''}targeting: ${targets.join(', ') || '(none)'}`);

  const reports = [];
  for (const slug of targets) {
    const { ref } = registry[slug];
    if (!ref) {
      reports.push({ slug, skipped: true, error: `could not parse project ref from tenants.php url` });
      log(slug, `SKIP — could not parse project ref from tenants.php url`);
      continue;
    }
    reports.push(await migrateTenant(slug, ref));
  }

  console.log('\n--- Fleet migration report ---\n');
  for (const r of reports) {
    if (r.skipped) {
      console.log(`${r.slug.padEnd(12)} SKIPPED — ${r.error}`);
    } else if (r.error) {
      console.log(`${r.slug.padEnd(12)} FAILED  — ${r.error} (applied this run: ${r.appliedThisRun.join(', ') || 'none'})`);
    } else if (r.appliedThisRun.length) {
      console.log(`${r.slug.padEnd(12)} APPLIED — ${r.appliedThisRun.join(', ')}`);
    } else if (r.wouldApply?.length) {
      console.log(`${r.slug.padEnd(12)} WOULD APPLY (dry run) — ${r.wouldApply.join(', ')}`);
    } else {
      console.log(`${r.slug.padEnd(12)} up to date`);
    }
  }

  const anyFailed = reports.some((r) => r.error && !r.skipped);
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n[FATAL] ${err.message}`);
  process.exit(1);
});
