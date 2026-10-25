// Lightweight global error capture. The app previously had no visibility into
// client-side failures — an error on a tenant's device just vanished. This
// installs window 'error'/'unhandledrejection' handlers so failures are at
// least logged consistently, and forwards them to REPORT_ENDPOINT — the
// Worker's /api/client-error route, which writes each report to Workers Logs
// under a [client-error] prefix. Set it to '' to keep reports console-only.
//
// Deliberately dependency-free and fire-and-forget: reporting must never throw
// or block the app, and it must not need a bundler or an SDK.

const REPORT_ENDPOINT = './api/client-error';
const MAX_REPORTS = 20; // per page load — a runaway loop shouldn't spam the endpoint

let sent = 0;

function report(kind, detail) {
  // eslint-disable-next-line no-console
  console.error(`[fieldcred:${kind}]`, detail);
  if (!REPORT_ENDPOINT || sent >= MAX_REPORTS) return;
  sent++;
  try {
    const body = JSON.stringify({
      kind,
      message: detail?.message || String(detail),
      stack: detail?.stack || null,
      url: location.href,
      ua: navigator.userAgent,
      at: new Date().toISOString(),
    });
    // keepalive so it still sends if the error is mid-navigation.
    fetch(REPORT_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {
    // Never let reporting itself surface an error.
  }
}

export function installErrorReporting() {
  window.addEventListener('error', (e) => report('error', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => report('unhandledrejection', e.reason));
}
