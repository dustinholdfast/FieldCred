// Applies a .sql file to the billing database. A stand-in for
// `psql -f <file>` when psql isn't installed — uses the `pg` driver
// already present in billing-service/node_modules.
//
// Run from inside billing-service/:
//
//   node apply-sql.mjs migrations/002_tenant_registry.sql "postgresql://..."
//
// Or set BILLING_DB_URL and omit the second argument. Use Railway's
// DATABASE_PUBLIC_URL (the *.proxy.rlwy.net host) — the plain DATABASE_URL
// points at postgres.railway.internal and won't resolve from your machine.
//
// The whole file runs inside a single transaction. Postgres DDL is
// transactional, so a syntax error on the last statement rolls back the
// first one too — you never end up half-migrated. Safe to re-run: the
// migration itself is written with `if not exists` / `or replace`
// throughout.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const [, , sqlPathArg, urlArg] = process.argv;
const connectionString = urlArg || process.env.BILLING_DB_URL;

if (!sqlPathArg || !connectionString) {
  console.error('Usage: node apply-sql.mjs <file.sql> "postgresql://..."');
  console.error('   or: set BILLING_DB_URL and pass just the .sql file.');
  process.exit(1);
}

const sqlPath = resolve(process.cwd(), sqlPathArg);
let sql;
try {
  sql = await readFile(sqlPath, 'utf8');
} catch (err) {
  console.error(`Could not read ${sqlPath}: ${err.message}`);
  process.exit(1);
}

console.log(`Applying ${sqlPath} (${sql.length.toLocaleString()} chars)\n`);

// Railway's TCP proxy generally wants TLS but presents a cert that won't
// chain to a public root — try TLS first, fall back rather than dying on
// an opaque handshake error.
async function connect() {
  for (const ssl of [{ rejectUnauthorized: false }, false]) {
    const client = new pg.Client({ connectionString, ssl });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      if (ssl === false) throw err;
      console.log(`(TLS connect failed — ${err.message}; retrying without TLS)\n`);
    }
  }
}

const client = await connect();

try {
  await client.query('begin');
  // One call with no parameters uses the simple query protocol, which
  // handles a multi-statement script including dollar-quoted function
  // bodies. Do not add parameters here — that switches protocols and
  // breaks on the first semicolon.
  await client.query(sql);
  await client.query('commit');
  console.log('✓ Applied and committed.\n');

  const { rows } = await client.query(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
      order by table_name`
  );
  console.log('Tables now in public:');
  for (const r of rows) console.log(`  - ${r.table_name}`);
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error('\n✗ FAILED — rolled back, nothing was changed.\n');
  console.error(`  ${err.message}`);
  if (err.position) {
    // Turn the byte offset Postgres reports into something findable.
    const upto = sql.slice(0, Number(err.position));
    const line = upto.split('\n').length;
    console.error(`  at line ${line} of ${sqlPathArg}`);
  }
  if (err.hint) console.error(`  hint: ${err.hint}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
