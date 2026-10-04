// Creates an empty Neon project for a new FieldCred tenant.
// Does not copy data from Supabase and does not invent Auth or Data API URLs.
//
// Env:
//   NEON_API_KEY     required
//   NEON_ORG_ID      optional; required when the key can see more than one org
//
// Usage:
//   node neon/provision-tenant.mjs path/to/manifest.json
//
// The manifest is the same JSON the billing service already builds
// (slug, companyName, adminEmail). On success this prints a tenants.php
// entry ONLY when the Neon API actually returned Auth and Data API URLs.
// Enabling those two features is a console step when the API call below
// does not return them — see neon/README.md.
//
// Scale to zero: the create request asks for suspend_timeout_seconds = -1
// (never sleep). The Free plan rejects that. The script then creates the
// project with the plan default and says so. Run neon/configure-compute.mjs
// again after moving the project to Launch or Scale.

import { readFile } from 'node:fs/promises';

const manifestPath = process.argv[2];
const apiKey = process.env.NEON_API_KEY;

if (!manifestPath || !apiKey) {
  console.error('Usage: NEON_API_KEY=... node neon/provision-tenant.mjs <manifest.json>');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const slug = String(manifest.slug || '').trim();
if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
  console.error('manifest.slug must be a lowercase tenant slug');
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${apiKey}`,
  'content-type': 'application/json',
  accept: 'application/json',
};

async function createProject(suspend) {
  const project = {
    name: `fieldcred-${slug}`,
    region_id: process.env.NEON_REGION_ID || 'aws-us-east-2',
    pg_version: 17,
    org_id: process.env.NEON_ORG_ID || undefined,
    default_endpoint_settings: {
      autoscaling_limit_min_cu: 0.25,
      autoscaling_limit_max_cu: 0.25,
    },
  };
  if (suspend) project.default_endpoint_settings.suspend_timeout_seconds = -1;
  const res = await fetch('https://console.neon.tech/api/v2/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ project }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

let created = await createProject(true);
let scaleToZeroDisabled = true;
if (!created.ok && created.status === 412) {
  scaleToZeroDisabled = false;
  console.error('Neon refused suspend_timeout_seconds=-1. This plan cannot disable scale to zero.');
  console.error('The project will be created with the plan default (Free: suspend after 5 idle minutes).');
  console.error('Gate and directory loads can fail on the first request after the compute sleeps.');
  console.error('Move the project to Launch or Scale, then run neon/configure-compute.mjs.');
  created = await createProject(false);
}
if (!created.ok) {
  console.error(`Neon create project failed (${created.status}).`);
  console.error(created.text);
  process.exit(1);
}

const body = JSON.parse(created.text);
const projectId = body.project?.id;
const connectionUri = body.connection_uris?.[0]?.connection_uri || '';
console.log(`Created Neon project ${projectId}. Scale-to-zero disabled: ${scaleToZeroDisabled ? 'yes' : 'NO'}.`);
console.log('Apply neon/schema.sql on this database with a direct (non-pooler) connection.');
console.log('Enable Neon Auth and the Data API on the default branch, then add the trusted domain for the app origin.');
console.log('No Supabase data was copied.');

if (connectionUri) {
  console.log('--- .env.local entry (DATABASE_URL) ---');
  console.log(`DATABASE_URL=${connectionUri}`);
  console.log('Add that line to .env.local');
}

console.log('Auth and Data API URLs are not available until those features are enabled.');
console.log('Do not write a tenants.php entry until both URLs are copied from the Neon console.');
console.log(`Example shape for slug ${slug}: authUrl + dataApiUrl. See neon/README.md.`);
