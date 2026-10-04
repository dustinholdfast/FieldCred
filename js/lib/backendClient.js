// Neon Auth + Data API client. Vendored build: js/vendor/neon-js.js
// (@neondatabase/neon-js 0.7.0-beta). Each tenant is its own Neon project.
// The registry returns that project's public Auth URL and Data API URL —
// there is no anon key. Anonymous Data API calls use a short-lived token
// the SDK fetches itself (allowAnonymous).
import { createClient, SupabaseAuthAdapter } from '../vendor/neon-js.js';
import { NEON_AUTH_URL as FALLBACK_AUTH_URL, NEON_DATA_API_URL as FALLBACK_DATA_API_URL } from './config.js';
import { resolveTenantSlug } from './tenant.js';

// Mutable — set by initBackend(), which main.js awaits before starting the
// router. Other modules import these as live bindings and only read them
// from inside functions that run after init.
export let db = null;
export let isConfigured = false;
export let tenantSlug = null;
export let tenantName = null;
export let tenantLogoUrl = null;
export let authUrl = null;
export let dataApiUrl = null;
// True when the tenant registry lookup failed and we fell back to the
// single project in config.js — the resolved tenantSlug is NOT who we're
// connected to. The login screen warns instead of silently using the
// wrong database.
export let usedFallback = false;

function isPlaceholder(auth, dataApi) {
  return !auth || !dataApi || auth.includes('YOUR_NEON') || dataApi.includes('YOUR_NEON');
}

async function fetchTenantConfig(slug) {
  const res = await fetch(`./tenant-lookup.php?tenant=${encodeURIComponent(slug)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Unknown tenant "${slug}" (${res.status})`);
  const data = await res.json();
  if (!data.authUrl || !data.dataApiUrl) {
    throw new Error(`Tenant "${slug}" registry entry is missing authUrl/dataApiUrl`);
  }
  return data;
}

// Resolves the current tenant and creates the Neon client. Falls back to
// the URLs in config.js when the registry is unreachable (local dev without
// PHP). Those fallbacks are empty until someone fills them in — this file
// does not ship a live database address.
export async function initBackend() {
  tenantSlug = resolveTenantSlug();

  let auth, dataApi, name;
  try {
    ({ authUrl: auth, dataApiUrl: dataApi, name } = await fetchTenantConfig(tenantSlug));
    usedFallback = false;
  } catch {
    auth = FALLBACK_AUTH_URL;
    dataApi = FALLBACK_DATA_API_URL;
    usedFallback = true;
  }
  authUrl = auth || null;
  dataApiUrl = dataApi || null;
  tenantName = name || tenantSlug;

  if (isPlaceholder(auth, dataApi)) {
    isConfigured = false;
    db = null;
    return false;
  }

  isConfigured = true;
  db = createClient({
    auth: {
      url: auth,
      adapter: SupabaseAuthAdapter(),
      allowAnonymous: true,
    },
    dataApi: {
      url: dataApi,
    },
  });

  // The registry's name is the bootstrap label. The tenant database is
  // authoritative once reachable (editable from Admin). public_settings
  // exposes tenant_name and logo_url only — notification_email stays
  // admin-only, and this runs before login.
  try {
    const { data } = await db.from('public_settings').select('tenant_name, logo_url').maybeSingle();
    if (data?.tenant_name) tenantName = data.tenant_name;
    if (data?.logo_url) tenantLogoUrl = data.logo_url;
  } catch {
    // View not applied yet, or the compute is still waking. Keep the
    // registry name.
  }

  return true;
}

export function setTenantName(name) {
  tenantName = name;
}

export function setTenantLogoUrl(url) {
  tenantLogoUrl = url;
}
