// Builds a provision-tenant.mjs-compatible manifest from a completed
// Stripe Checkout Session. See supabase/manifests/EXAMPLE.json for the
// target shape and provision-tenant.mjs's header comment for what each
// field does.
//
// Reads company name / admin email / slug from Checkout Session custom
// fields — Stripe Checkout supports up to 3 custom_fields collected at
// checkout time. Configure your Checkout Session (or Payment Link) with
// custom fields using these exact keys:
//   - company_name  (text)
//   - slug          (text) — desired subdomain, lowercase letters/digits/hyphens
// Admin email comes from customer_details.email (Stripe always collects
// this), not a custom field — one less thing to mistype at checkout.

const RESERVED_SLUGS = new Set([
  'demo', 'www', 'app', 'api', 'admin', 'staging', 'test', 'mail', 'ftp',
  'default', 'support', 'help', 'status', 'billing', 'fieldcred',
]);

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

export class ManifestValidationError extends Error {}

function getCustomField(session, key) {
  const field = (session.custom_fields || []).find((f) => f.key === key);
  return field?.text?.value?.trim() || field?.dropdown?.value || null;
}

/**
 * @param {import('stripe').Stripe.Checkout.Session} session — expand
 *   ['line_items'] when retrieving this session (see webhookHandlers.mjs)
 *   so line_items.data[0].price.id is populated.
 * @param {(priceId: string) => {planTier: string, maxWorkers: number|null}} resolvePlan
 */
export function buildManifestFromSession(session, resolvePlan) {
  const companyName = getCustomField(session, 'company_name');
  const rawSlug = getCustomField(session, 'slug');
  const adminEmail = session.customer_details?.email;

  const missing = [];
  if (!companyName) missing.push('company_name (custom field)');
  if (!rawSlug) missing.push('slug (custom field)');
  if (!adminEmail) missing.push('customer email');
  if (missing.length) {
    throw new ManifestValidationError(
      `Checkout session ${session.id} is missing required fields: ${missing.join(', ')}. ` +
      `Check the Checkout Session/Payment Link's custom_fields configuration.`
    );
  }

  const slug = rawSlug.toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new ManifestValidationError(
      `Slug "${slug}" is invalid — must be lowercase letters/digits/hyphens, ` +
      `3-40 chars, not starting/ending with a hyphen.`
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new ManifestValidationError(`Slug "${slug}" is reserved and cannot be provisioned.`);
  }

  const priceId = session.line_items?.data?.[0]?.price?.id;
  if (!priceId) {
    throw new ManifestValidationError(
      `Checkout session ${session.id} has no line item price — was it retrieved with ` +
      `{expand: ['line_items']}?`
    );
  }
  const { planTier, maxWorkers } = resolvePlan(priceId);

  return {
    manifest: {
      slug,
      name: companyName,
      // organizationId and region are deliberately NOT set here — they're
      // deployment-environment config (which Supabase org/region this
      // service provisions into), not per-customer data. Set
      // SUPABASE_ORG_ID / SUPABASE_REGION env vars; see .env.example.
      organizationId: process.env.SUPABASE_ORG_ID,
      region: process.env.SUPABASE_REGION || 'us-east-2',
      adminEmail,
      domains: [],
      planTier,
      maxWorkers,
      billingPlan: 'free', // Supabase project tier — see TENANCY-MODEL.md's cost floor for when this needs to be 'pro'
    },
    priceId,
    planTier,
    maxWorkers,
  };
}
