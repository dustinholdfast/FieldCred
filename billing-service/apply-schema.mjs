// One-off helper: applies billing-service/schema.sql to a fresh Postgres
// database. Run once against a brand-new database, then this file can be
// deleted — it's not part of the running service.
//
// Usage (from inside billing-service/, after `npm install`):
//   node apply-schema.mjs "postgresql://postgres:...@sakura.proxy.rlwy.net:53802/railway"
//
// Use the DATABASE_PUBLIC_URL value (the one with a public host/port), not
// DATABASE_URL (that one only resolves from inside Railway's own network,
// not from your laptop).

import { readFileSync } from 'fs';
import { Client } from 'pg';

const connectionString = process.argv[2];
if (!connectionString) {
  console.error('Usage: node apply-schema.mjs "<postgres-connection-string>"');
  process.exit(1);
}

const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(sql);
  console.log('schema.sql applied successfully.');
} finally {
  await client.end();
}
