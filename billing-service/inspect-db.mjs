// One-off inspection of the FieldCred billing database.
// Read-only — runs three SELECTs and prints the results. Writes nothing.
//
// Run from inside billing-service/ (that's where the `pg` dependency lives):
//
//   cd D:\Claude\Projects\fieldcred\billing-service
//   node inspect-db.mjs "postgresql://postgres:PASSWORD@HOST.proxy.rlwy.net:PORT/railway"
//
// Or set BILLING_DB_URL and run it with no argument. Use Railway's
// DATABASE_PUBLIC_URL (the *.proxy.rlwy.net host) — the plain DATABASE_URL
// points at postgres.railway.internal, which only resolves inside Railway.
//
// Deliberately never prints db_url, supabase_anon_key, or any password:
// those columns are reported as booleans only, so the output is safe to
// paste into a chat.

import pg from 'pg';

const connectionString = process.argv[2] || process.env.BILLING_DB_URL;

if (!connectionString) {
  console.error('Usage: node inspect-db.mjs "postgresql://..."');
  console.error('   or: set BILLING_DB_URL and run with no argument.');
  process.exit(1);
}

// Railway's TCP proxy generally wants TLS but presents a cert that won't
// chain to a public root — try TLS first, fall back to plaintext rather
// than failing with an opaque handshake error.
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

function table(rows) {
  if (!rows.length) return '  (no rows)';
  const cols = Object.keys(rows[0]);
  const width = (c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length));
  const widths = Object.fromEntries(cols.map((c) => [c, width(c)]));
  const line = (cells) =>
    '  ' + cols.map((c) => String(cells[c] ?? '').padEnd(widths[c])).join('  |  ');
  const header = line(Object.fromEntries(cols.map((c) => [c, c])));
  const rule = '  ' + cols.map((c) => '-'.repeat(widths[c])).join('--+--');
  return [header, rule, ...rows.map(line)].join('\n');
}

const client = await connect();

try {
  console.log('=== 1. tenant_billing columns ===\n');
  const { rows: cols } = await client.query(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = 'tenant_billing'
      order by ordinal_position`
  );
  console.log(table(cols));

  console.log('\n=== 2. tenant_billing constraints ===\n');
  const { rows: cons } = await client.query(
    `select con.conname as name, pg_get_constraintdef(con.oid) as definition
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace ns on ns.oid = rel.relnamespace
      where ns.nspname = 'public' and rel.relname = 'tenant_billing'
      order by con.conname`
  );
  console.log(table(cons));

  console.log('\n=== 3. tenant_billing rows (secrets shown as booleans only) ===\n');
  const { rows: tenants } = await client.query(
    `select slug,
            status,
            plan_tier,
            supabase_url is not null   as has_url,
            supabase_anon_key is not null as has_key,
            db_url is not null         as has_db,
            grace_period_ends_at
       from tenant_billing
      order by slug`
  );
  console.log(table(tenants));

  console.log('\n=== 4. recent signups ===\n');
  const { rows: signups } = await client.query(
    `select slug,
            status,
            left(coalesce(last_error, ''), 90) as last_error,
            created_at
       from signups
      order by created_at desc
      limit 10`
  );
  console.log(table(signups));

  console.log('\n=== 5. row counts ===\n');
  const { rows: counts } = await client.query(
    `select 'tenant_billing' as tbl, count(*)::int from tenant_billing
     union all select 'signups', count(*)::int from signups
     union all select 'processed_stripe_events', count(*)::int from processed_stripe_events`
  );
  console.log(table(counts));

  console.log('\nDone. Nothing was modified.');
} finally {
  await client.end();
}
