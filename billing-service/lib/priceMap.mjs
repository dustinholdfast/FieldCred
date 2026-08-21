// Maps a Stripe Price ID to a FieldCred plan tier + worker cap. Tiers here
// MUST mirror what's actually enforced in each tenant's plan_limits table
// (see supabase/schema.sql's "Plan limits" section and PROVISIONING.md
// step 2.3) — this file is the only place that mapping lives, so a
// mismatch here means a customer gets billed for one tier and provisioned
// with another.
//
// Configure via PRICE_TIER_MAP_JSON (see .env.example) rather than editing
// this file directly, so pricing changes don't require a redeploy — but
// the fallback below documents the expected shape and fails loudly if
// unset, rather than silently defaulting anyone to 'unlimited'.

let map = null;

function loadMap() {
  if (map) return map;

  const raw = process.env.PRICE_TIER_MAP_JSON;
  if (!raw) {
    throw new Error(
      'PRICE_TIER_MAP_JSON is not set. Expected JSON like: ' +
      '{"price_123abc": {"planTier": "growth", "maxWorkers": 50}}. ' +
      'Create your Prices in the Stripe dashboard first, then set this — ' +
      'see README.md "Stripe dashboard setup."'
    );
  }

  try {
    map = JSON.parse(raw);
  } catch (e) {
    throw new Error(`PRICE_TIER_MAP_JSON is not valid JSON: ${e.message}`);
  }

  return map;
}

/** Throws (does not silently fall back) on an unrecognized price ID — an
 * unmapped price means either a Stripe dashboard change wasn't reflected
 * here, or a customer somehow reached Checkout with a stale/wrong price.
 * Either way, provisioning nothing and alerting is safer than guessing a
 * tier. */
export function resolvePlanForPrice(priceId) {
  const m = loadMap();
  const entry = m[priceId];
  if (!entry) {
    throw new Error(`No plan tier mapped for Stripe price "${priceId}" — check PRICE_TIER_MAP_JSON.`);
  }
  return entry; // { planTier, maxWorkers }
}
