// Self-hosted, version-pinned build (js/vendor/supabase-js.js, @2.110.5) rather
// than a live https://esm.sh import: a CDN outage no longer takes the whole app
// down for every tenant, an upstream release can't land in production untested,
// and it satisfies a strict Content-Security-Policy (script-src 'self'). To
// upgrade, re-vendor the bundle — see js/vendor/README.md.
import { createClient } from '../vendor/supabase-js.js';
import { SUPABASE_URL as FALLBACK_URL, SUPABASE_ANON_KEY as FALLBACK_KEY } from './config.js';
import { resolveTenantSlug } from './tenant.js';

// Mutable — set by initSupabase(), which main.js awaits before starting the
// router. Other modules import these as live bindings and only read them
// from inside functions that run after init (never at module top-level),
// so they always see the resolved values.
export let supabase = null;
export let isConfigured = false;
export let tenantSlug = null;
export let tenantName = null;
export let tenantLogoUrl = null;
// True when the tenant registry lookup failed and we fell back to the
// single project in config.js — i.e. the resolved tenantSlug is NOT
// actually who we're connected to. Lets the UI warn "couldn't find that
// instance" instead of silently connecting to the wrong tenant.
export let usedFallback = false;

function isPlaceholder(url, anonKey) {
  return !url || !anonKey || url === 'YOUR_SUPABASE_PROJECT_URL' || anonKey === 'YOUR_SUPABASE_ANON_PUBLIC_KEY';
}

// Session storage hardening for the gate kiosk (js/pages/gateApp.js).
//
// Every other route in this app is someone's own device — supabase-js's
// default (localStorage) is the right call there: closing the tab shouldn't
// force a re-login. The gate kiosk is different on purpose (see gateApp.js's
// own header comment): it's a shared tablet bolted to a fence, left signed
// in as whichever supervisor last unlocked it, for a shift or longer.
// localStorage persists across a full device reboot; sessionStorage clears
// the moment the tab/browser closes. On a kiosk, that's a feature — a
// supervisor's session doesn't quietly outlive the browser session it was
// created in, on hardware nobody is watching. The PIN (gateSession.js) still
// handles fast re-entry within one browser session; this only shortens how
// long the underlying Supabase session can outlive that.
//
// Detected from the boot-time hash, read BEFORE the router or Supabase's own
// SDK touches it (same ordering guard as main.js's isPasswordRecoveryLink) —
// a kiosk tablet is provisioned pointed straight at #/gate-app and stays
// there, so this is a reliable one-time check at startup, not a per-route
// switch (the client is a singleton created once, before routing starts).
function isGateKioskBoot() {
  return location.hash.slice(1).split('?')[0].startsWith('/gate-app');
}

// A sessionStorage-backed Storage implementation, degrading to an in-memory
// Map on the same failure modes localStorage already has to handle
// elsewhere in this app (private browsing, quota, storage disabled) — a
// kiosk that can't persist a session at all must still work, just with a
// session that never survives a reload.
function createKioskStorage() {
  const memory = new Map();
  return {
    getItem(key) {
      try {
        return sessionStorage.getItem(key);
      } catch {
        return memory.has(key) ? memory.get(key) : null;
      }
    },
    setItem(key, value) {
      try {
        sessionStorage.setItem(key, value);
      } catch {
        memory.set(key, value);
      }
    },
    removeItem(key) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        memory.delete(key);
      }
    },
  };
}

async function fetchTenantConfig(slug) {
  const res = await fetch(`./tenant-lookup.php?tenant=${encodeURIComponent(slug)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Unknown tenant "${slug}" (${res.status})`);
  const data = await res.json();
  if (!data.url || !data.anonKey) throw new Error(`Tenant "${slug}" registry entry is missing url/anonKey`);
  return data;
}

// Resolves the current tenant, fetches its Supabase project credentials
// from the registry (tenant-lookup.php), and creates the client — each
// tenant gets its own fully separate Supabase project/database. Falls back
// to the single static project in config.js if the registry is unreachable
// (e.g. local dev without PHP running), so a single-tenant setup still
// works with zero extra moving parts.
export async function initSupabase() {
  tenantSlug = resolveTenantSlug();

  let url, anonKey, name;
  try {
    ({ url, anonKey, name } = await fetchTenantConfig(tenantSlug));
    usedFallback = false;
  } catch {
    url = FALLBACK_URL;
    anonKey = FALLBACK_KEY;
    usedFallback = true;
  }
  tenantName = name || tenantSlug;

  if (isPlaceholder(url, anonKey)) {
    isConfigured = false;
    supabase = null;
    return false;
  }

  isConfigured = true;
  supabase = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      ...(isGateKioskBoot() ? { storage: createKioskStorage() } : {}),
    },
  });

  // The registry's name is just the bootstrap label — the tenant's own
  // database is authoritative once reachable (editable from the Admin
  // screen). Reads the public_settings view, not the settings table
  // directly — the table also holds notification_email, which is
  // admin-only as of migration 013, and this runs pre-login for every role.
  try {
    const { data } = await supabase.from('public_settings').select('tenant_name, logo_url').maybeSingle();
    if (data?.tenant_name) tenantName = data.tenant_name;
    if (data?.logo_url) tenantLogoUrl = data.logo_url;
  } catch {
    // View not migrated yet on this tenant, or unreachable — keep the
    // registry's name as the fallback.
  }

  return true;
}

// Called after the Admin screen successfully updates the tenant name, so
// the top nav / login screen reflect it immediately without a reload.
export function setTenantName(name) {
  tenantName = name;
}

// Called after the Admin screen successfully updates the tenant logo.
export function setTenantLogoUrl(url) {
  tenantLogoUrl = url;
}
