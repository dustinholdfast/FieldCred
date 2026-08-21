// Fallback project, used only if the tenant registry (tenant-lookup.php)
// is unreachable — e.g. local dev without PHP running. In normal
// operation each tenant's real URL/key comes from tenants.php instead;
// see supabase/PROVISIONING.md. The anon/public key is safe to ship in
// client-side code — it only grants what the RLS policies in
// supabase/schema.sql allow.
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

export const SUPABASE_URL = 'https://qiozckjlojvhdtrsjzfp.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpb3pja2psb2p2aGR0cnNqemZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MTIxMTIsImV4cCI6MjA5OTA4ODExMn0.jzW1T1UyHieK5HhUGFCCHbHFRtq6JHhxKDBRdhtOoFo';
