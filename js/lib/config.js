// Fallback project, used only if the tenant registry (tenant-lookup.php)
// is unreachable — e.g. local dev without PHP running. In normal
// operation each tenant's Auth URL and Data API URL come from tenants.php
// (or the billing registry). See neon/README.md.
//
// These are public endpoints, like the old anon key: they grant only what
// neon/schema.sql grants the anonymous and authenticated roles. Leave them
// empty until a real Neon branch exists. Do not put a database password here.
// Billing service origin — the Node service on Railway that owns Stripe
// and the tenant registry (see billing-service/README.md). Used by the
// admin page's capacity button to open a Stripe Customer Portal session
// for tenants that have a billing record.
//
// THREE THINGS MUST AGREE or the browser silently refuses the request:
//   1. this constant
//   2. index.html's CSP `connect-src` allowlist
//   3. the CORS allowlist in billing-service/server.mjs
// Change one, change all three.
//
// Setting this to '' disables the portal path — the button then falls back
// to the signup-notify.php email request, which is the right behaviour for
// pilot tenants with no Stripe record anyway.
export const BILLING_SERVICE_URL = 'https://billing-service-production-783a.up.railway.app';

export const NEON_AUTH_URL = '';
export const NEON_DATA_API_URL = '';
