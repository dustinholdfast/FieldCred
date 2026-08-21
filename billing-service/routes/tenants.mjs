// Tenant registry lookup — the endpoints that replace hand-editing
// tenants.php for every new customer.
//
// Save as: billing-service/routes/tenants.mjs
//
// Called by tenant-lookup.php / tenant-lookup-by-domain.php on the PHP
// host, which proxy to here and fall back to the flat tenants.php file if
// this service is unreachable. That fallback is deliberate and load-
// bearing: tenant resolution happens before anyone can sign in, so making
// this service a hard dependency would turn any Railway outage into a
// total login outage for every tenant. Keep the fallback.
//
// WHAT THIS ENDPOINT DELIBERATELY EXPOSES
//
// It is unauthenticated, and it has to be — the app must resolve a tenant
// before there's any session to authenticate. What it returns (project URL
// + anon key) is public by design: the anon key grants only what that
// tenant's RLS policies allow, which is why the app already ships it to
// the browser today (see js/lib/config.js and the repo README's "Auth
// model"). It reads from tenant_registry, which holds no secrets at all —
// notably not tenant_billing.db_url. See migrations/002_tenant_registry.sql
// for why that separation exists.
//
// WHAT IT DELIBERATELY DOESN'T DO
//
// No listing, no prefix search, no fuzzy match — exact slug or exact
// domain only, mirroring what tenant-lookup.php does today. There is no
// endpoint here that enumerates tenants, because the customer list is
// competitive information and a public enumeration endpoint hands it over.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;

// Browsers and the PHP proxy both cache; this is the backstop that keeps a
// scripted caller from turning tenant lookup into a free database load
// generator. In-memory and per-instance — fine for a single Railway
// instance, and the failure mode if you scale out is "the limit is N times
// looser," not "it breaks."
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const hits = new Map();

function rateLimited(key) {
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    hits.set(key, { start: now, count: 1 });

    // Opportunistic sweep — no timer, no unbounded growth from one-off IPs.
    if (hits.size > 5_000) {
      for (const [k, v] of hits) {
        if (now - v.start > RATE_LIMIT_WINDOW_MS) hits.delete(k);
      }
    }
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

/**
 * Fail-closed resolution rules, in one place so both routes share them.
 *
 *   active    -> serve
 *   past_due  -> serve. A failed card must not lock a paying customer out
 *                of their own data mid-billing-cycle; that's what the
 *                grace period and dunning are for.
 *   canceled  -> serve only while grace_period_ends_at is still in the
 *                future. Past that, 404 — which is precisely the manual
 *                "remove their tenants.php entry" step this table removes.
 *
 * A canceled tenant with a NULL grace_period_ends_at is treated as expired
 * rather than infinite. Erring toward "off" is the right default for the
 * ambiguous case here.
 */
function isResolvable(row) {
  if (row.status !== 'canceled') return true;
  return row.grace_period_ends_at != null && new Date(row.grace_period_ends_at) > new Date();
}

function shape(row) {
  // Key names match what tenant-lookup.php already returns, so
  // js/lib/supabaseClient.js needs no change whatsoever.
  return { url: row.supabase_url, anonKey: row.supabase_anon_key, slug: row.slug };
}

export function registerTenantRoutes(app, pool) {
  // GET /api/tenant/:slug
  app.get('/api/tenant/:slug', async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'rate limited' });

    const slug = String(req.params.slug || '').trim().toLowerCase();

    // 404 rather than 400 on a malformed slug: a distinct error code would
    // tell a prober "that shape is valid, keep going," and there's nothing
    // a legitimate caller does with the distinction.
    if (!SLUG_RE.test(slug)) return res.status(404).json({ error: 'not found' });

    try {
      const { rows } = await pool.query(
        `select slug, supabase_url, supabase_anon_key, status, grace_period_ends_at
           from tenant_registry
          where slug = $1`,
        [slug]
      );

      const row = rows[0];
      if (!row || !isResolvable(row)) return res.status(404).json({ error: 'not found' });

      res.set('Cache-Control', 'public, max-age=60');
      return res.json(shape(row));
    } catch (err) {
      // Log the slug, never the error's full context — pg errors can carry
      // query text and parameters into your logs.
      console.error(`[tenant-lookup] query failed for slug "${slug}": ${err.message}`);
      return res.status(500).json({ error: 'lookup failed' });
    }
  });

  // GET /api/tenant-by-domain?domain=example.com
  app.get('/api/tenant-by-domain', async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'rate limited' });

    // Accept a bare domain or a full email — the login screen has the
    // address in hand and shouldn't have to split it correctly.
    let domain = String(req.query.domain || '').trim().toLowerCase();
    if (domain.includes('@')) domain = domain.slice(domain.lastIndexOf('@') + 1);

    if (!DOMAIN_RE.test(domain)) return res.status(404).json({ error: 'not found' });

    try {
      const { rows } = await pool.query(
        `select slug, supabase_url, supabase_anon_key, status, grace_period_ends_at
           from tenant_registry
          where $1 = any(domains)
          limit 2`,
        [domain]
      );

      // The unique-domain trigger in 002 should make this impossible.
      // If it happens anyway, refusing to guess beats sending someone to
      // the wrong company's sign-in screen.
      if (rows.length > 1) {
        console.error(`[tenant-lookup] domain "${domain}" matched multiple tenants — refusing to guess.`);
        return res.status(404).json({ error: 'not found' });
      }

      const row = rows[0];
      if (!row || !isResolvable(row)) return res.status(404).json({ error: 'not found' });

      res.set('Cache-Control', 'public, max-age=60');
      return res.json(shape(row));
    } catch (err) {
      console.error(`[tenant-lookup] domain query failed for "${domain}": ${err.message}`);
      return res.status(500).json({ error: 'lookup failed' });
    }
  });
}
