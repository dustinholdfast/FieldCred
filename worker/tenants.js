// Public tenant registry for the Worker. Mirrors tenants.php — anon keys only.
// tests/worker-endpoints.test.mjs fails if the two drift.
//
// The Resend API key in signup-config.php is intentionally not copied here.
// Set it on the Worker with `npx wrangler secret put RESEND_API_KEY`.

export const TENANTS = [
  {
    slug: 'demo',
    name: 'FieldCred Demo',
    url: 'https://kaktjqbbijyjejulbpgy.supabase.co',
    anonKey: 'sb_publishable_rdzQYMIOkkFvkcOCOqIW3Q_RV_DAJZo',
    domains: [],
  },
];
