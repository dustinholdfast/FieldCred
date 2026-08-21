// Invokes the existing, battle-tested supabase/provision-tenant.mjs as a
// child process rather than re-implementing its logic here. Deliberate
// choice: that script already handles pooler-readiness retries, resume-
// after-partial-failure, and the exact ordering Supabase's API needs —
// duplicating that in a second codepath would be a correctness risk for
// no real benefit. This module's job is just: build the manifest file,
// run the script, parse its stdout for the two things it prints that nothing
// else can recover (the tenants.php entry, the DB connection string), and
// record what happened.

import { execFile } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Path to the supabase/ tooling folder, relative to wherever this service
// is deployed. Defaults to a sibling directory, matching this repo's
// layout (billing-service/ and supabase/ side by side) — override via
// SUPABASE_TOOLING_PATH if this service is deployed with a different
// checkout structure.
const TOOLING_PATH = process.env.SUPABASE_TOOLING_PATH || join(process.cwd(), '..', 'supabase');

// Provisioning legitimately takes minutes (pooler-readiness retry alone can
// take ~320s worst case per provision-tenant.mjs's own comment) — timeout
// generously rather than killing a run that's still making progress.
const PROVISION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs provision-tenant.mjs against a freshly-built manifest.
 * @returns {{ ok: true, tenantsPhpEntry: string, dbUrlLine: string|null, stdout: string }
 *         | { ok: false, error: string, stdout: string }}
 */
export async function runProvisioning(manifest) {
  const dir = await mkdtemp(join(tmpdir(), 'fc-manifest-'));
  const manifestPath = join(dir, `${manifest.slug}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  try {
    // Deliberately NOT passing --apply-registry: that flag edits a LOCAL
    // tenants.php copy on whatever host runs this script, which is not the
    // production PHP host and has no automated path to reach it (see
    // PROVISIONING.md's "known gap" note). Editing a copy nobody deploys is
    // worse than not editing it — instead, parse the printed entry below
    // and hand it to the operator directly.
    const { stdout } = await execFileAsync(
      'node',
      [join(TOOLING_PATH, 'provision-tenant.mjs'), manifestPath],
      {
        env: process.env, // SUPABASE_ACCESS_TOKEN must already be set for this process
        timeout: PROVISION_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    return {
      ok: true,
      tenantsPhpEntry: extractBetween(stdout, '--- tenants.php entry ---', 'Paste that into tenants.php')
        ?? extractBetween(stdout, '--- tenants.php entry ---', null),
      dbUrlLine: extractBetween(stdout, '--- .env.local entry', 'Add that line to .env.local'),
      stdout,
    };
  } catch (err) {
    // execFile rejects on non-zero exit (provision-tenant.mjs exits 1 on
    // failure, per its own `main().catch(...) { process.exit(1) }`) — the
    // useful error text is in err.stdout/err.stderr, not err.message alone.
    const combined = `${err.stdout || ''}\n${err.stderr || ''}`.trim() || err.message;
    return { ok: false, error: combined, stdout: err.stdout || '' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extractBetween(text, startMarker, endMarker) {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;
  const contentStart = startIdx + startMarker.length;
  const endIdx = endMarker ? text.indexOf(endMarker, contentStart) : text.length;
  if (endMarker && endIdx === -1) return text.slice(contentStart).trim();
  return text.slice(contentStart, endIdx).trim();
}
