// Public tenant registry for the Worker. Mirrors tenants.php.
// tests/worker-endpoints.test.mjs fails if the two drift.
//
// authUrl and dataApiUrl are public Neon endpoints. There is no anon key
// and no database password in this file.
//
// The Resend API key in signup-config.php is intentionally not copied here.
// Set it on the Worker with `npx wrangler secret put RESEND_API_KEY`.

export const TENANTS = [
  {
    slug: 'demo',
    name: 'FieldCred Demo',
    authUrl: 'https://ep-falling-dream-b4s5gk7v.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth',
    dataApiUrl: 'https://ep-falling-dream-b4s5gk7v.apirest.c-6.us-east-2.aws.neon.tech/neondb/rest/v1',
    domains: [],
  },
];
