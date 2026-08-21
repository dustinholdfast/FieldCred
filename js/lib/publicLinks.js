// The two public URLs FieldCred prints on a QR code: a worker's record
// (#/r/:slug) and a site's gate link (#/gate/:slug).
//
// Pure string builders, no imports — so tests/publicLinks.test.mjs can
// round-trip them through parseScannedCode() (js/lib/qrScanner.js), which is
// the code that has to read them back off a camera. origin/pathname default
// to the current page in a browser and must be passed explicitly under node.
//
// Both URLs MUST carry ?tenant=. They are scanned on a device that has never
// visited the app before, so there is no tenant subdomain, no localStorage
// override and no prior visit for resolveTenantSlug() (js/lib/tenant.js) to
// fall back on — without the param it silently resolves to DEFAULT_TENANT,
// which "works" by accident for that one tenant and shows nothing for every
// other. That surfaced through a real badge scan on the demo tenant on
// 2026-07-14; the gate link on the site page carried the same hole until
// 2026-07-22, when it grew a QR of its own and started being scanned.

function here() {
  if (typeof location === 'undefined') return { origin: '', pathname: '' };
  return { origin: location.origin, pathname: location.pathname };
}

function publicUrl({ origin, pathname, tenant, hashPath }) {
  const base = origin === undefined || pathname === undefined ? here() : { origin, pathname };
  return `${base.origin}${base.pathname}?tenant=${encodeURIComponent(tenant)}#${hashPath}`;
}

// Public record for one worker — what a printed badge card resolves to.
export function workerRecordUrl({ slug, tenant, origin, pathname }) {
  return publicUrl({ origin, pathname, tenant, hashPath: `/r/${encodeURIComponent(slug)}` });
}

// Gate link for one site. Scanned by a phone camera it opens the device-config
// page (js/pages/gateConfig.js); scanned from inside the FieldCred Gate app it
// pairs that device to the site (js/pages/gateApp.js). Same URL either way.
export function gateLinkUrl({ slug, tenant, origin, pathname }) {
  return publicUrl({ origin, pathname, tenant, hashPath: `/gate/${encodeURIComponent(slug)}` });
}
