// Billing service's own bookkeeping database — NOT a tenant's Supabase
// project. See schema.sql and README.md for what lives here and why it's
// separate. Connection string comes from BILLING_DB_URL only, never
// hardcoded (same rule as every other secret in this codebase).

import { Pool } from 'pg';

const connectionString = process.env.BILLING_DB_URL;
if (!connectionString) {
  throw new Error('BILLING_DB_URL is not set — see .env.example.');
}

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

/**
 * True if this Stripe event has already been processed. Check this FIRST,
 * before any side-effecting work, and insert (via markEventProcessed) only
 * after that work succeeds — see webhookHandlers.mjs for the exact ordering
 * and why.
 */
export async function isEventProcessed(eventId) {
  const { rows } = await pool.query(
    'select 1 from processed_stripe_events where event_id = $1',
    [eventId]
  );
  return rows.length > 0;
}

export async function markEventProcessed(eventId, eventType) {
  await pool.query(
    `insert into processed_stripe_events (event_id, event_type)
     values ($1, $2)
     on conflict (event_id) do nothing`,
    [eventId, eventType]
  );
}

/** Recover any signup rows that never reached a terminal state — called
 * once at server startup so a crash/restart mid-provisioning doesn't
 * silently strand a paying customer. See README.md's "Crash recovery" note
 * for why this is a startup sweep rather than a real job queue in v1. */
export async function findResumableSignups() {
  const { rows } = await pool.query(
    `select * from signups where status in ('pending', 'provisioning') order by created_at asc`
  );
  return rows;
}
