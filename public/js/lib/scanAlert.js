// Asks the Worker (POST /api/scan-alert, worker/scanAlert.js) to email the
// site's alert contact when a worker is turned away at the gate.
//
// Sends slugs only. The Worker re-reads the scan from the database and only
// alerts on a real blocked entry from the last 15 minutes, once, so a stray or
// repeated request here is harmless. Fire-and-forget like errorReporting.js:
// an alert must never delay or block the verdict on the guard's screen.

const ALERT_ENDPOINT = './api/scan-alert';

// The server's result decides, never the tablet's own verdict. Exits never
// alert: nobody is refused on the way out.
export function shouldRequestAlert(result, direction) {
  return result === 'blocked' && direction !== 'out';
}

export function requestBlockedScanAlert(tenant, siteSlug, workerSlug, fetchImpl = globalThis.fetch) {
  if (!tenant || !siteSlug || !workerSlug || typeof fetchImpl !== 'function') return false;
  try {
    fetchImpl(ALERT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant, site: siteSlug, worker: workerSlug }),
      keepalive: true,
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
