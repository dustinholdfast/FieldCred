// Resolves which tenant this page load belongs to, checked in order:
//   1. ?tenant=slug query param — works today with no DNS changes, handy
//      for testing a tenant before wildcard subdomains are set up.
//   2. A subdomain of the app's base host (acme.<base> -> "acme").
//   3. A localStorage override (developer convenience, sticky across reloads).
//   4. DEFAULT_TENANT — the fallback when nothing else matches. Set to 'demo'
//      after the original 'default' tenant (project qiozckjlojvhdtrsjzfp) was
//      retired 2026-07-17; must always name a real entry in tenants.php.
//
// Update BASE_HOST if the app ever moves to a different domain — it's what
// subdomain detection is anchored to. The app host itself must equal this, so
// tenant subdomains are <tenant>.<BASE_HOST> (e.g. acme.app.fieldcred.co) and
// the bare app host resolves to the default tenant, not a phantom "app" one.
const BASE_HOST = 'app.fieldcred.co';
const DEFAULT_TENANT = 'demo';
const STORAGE_KEY = 'fieldcred:tenant';

function fromQueryParam() {
  return new URLSearchParams(location.search).get('tenant');
}

function fromSubdomain() {
  const host = location.hostname;
  if (host === BASE_HOST || host === `www.${BASE_HOST}`) return null;
  const suffix = `.${BASE_HOST}`;
  if (host.endsWith(suffix)) return host.slice(0, -suffix.length);
  return null;
}

function fromLocalStorage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function resolveTenantSlug() {
  return fromQueryParam() || fromSubdomain() || fromLocalStorage() || DEFAULT_TENANT;
}

// Sticky dev/testing override — e.g. run `setTenantOverride('acme')` in the
// console, or visit once with ?tenant=acme, to keep testing that tenant
// across reloads without needing a subdomain.
export function setTenantOverride(slug) {
  try {
    if (slug) localStorage.setItem(STORAGE_KEY, slug);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — override just won't stick across reloads.
  }
}
