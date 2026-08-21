import { startScanner, parseScannedCode } from '../lib/qrScanner.js';
import { navigate, getPath } from '../lib/router.js';
import { escapeHtml } from '../lib/format.js';
import { shieldLogo } from '../components/logo.js';
import { tenantSlug } from '../lib/supabaseClient.js';
import { getCachedSite } from '../lib/offlineCache.js';
import { store } from '../lib/state.js';

// In-app gate scanner. Public route, no auth — same rationale as /r/:slug and
// /gate/:slug: a gate device is a shared kiosk that nobody signs in to, and
// this page reveals nothing on its own (it only routes to pages that already
// enforce their own visibility rules).
//
// On a successful worker scan this NAVIGATES to the existing /r/:slug page
// rather than rendering a verdict inline. That costs a camera restart per
// scan, which is the honest tradeoff: /r/:slug already owns clearance
// evaluation, the offline cache fallback, the possibly-stale banner, and the
// gate-scan audit log (including the offline queue). Duplicating any of that
// here to save half a second is exactly how a "cleared" verdict and the audit
// trail behind it drift apart.

const GATE_KEY = 'fieldcred_gate_site'; // shared with pages/gateConfig.js + pages/publicRecord.js

function readGateSlug() {
  try {
    return localStorage.getItem(GATE_KEY);
  } catch {
    return null;
  }
}

// Best-effort label for the site this device checks against. Tries the live
// record, falls back to the offline cache, and finally to the raw slug — this
// is a header caption, so it must never block or break the scanner.
async function gateSiteLabel(slug) {
  if (!slug) return null;
  try {
    const site = await store.getPublicSite(slug);
    if (site?.name) return site.name;
  } catch {
    // no signal — fall through to cache
  }
  try {
    const cached = await getCachedSite(slug);
    if (cached?.data?.name) return cached.data.name;
  } catch {}
  return slug;
}

function shellHtml({ gateLabel }) {
  const gateBar = gateLabel
    ? `<div class="scan-gate-bar">
         <span class="scan-gate-dot"></span>
         <div class="scan-site-copy"><span class="scan-site-kicker">Active site</span><strong class="scan-site-name">${escapeHtml(gateLabel)}</strong></div>
         <button class="scan-site-change" id="scan-site-change" type="button">Change</button>
       </div>`
    : `<div class="scan-gate-bar scan-gate-bar-warn">
         <span class="scan-gate-dot"></span>
         <div class="scan-site-copy"><span class="scan-site-kicker">Site not set</span><strong>Scan the site's setup QR first</strong></div>
       </div>`;

  return `
    <div class="scan-page">
      <div class="scan-topbar">
        <div class="scan-brand">
          <span class="scan-brand-mark">${shieldLogo()}</span>
          <span><span class="scan-brand-name">FieldCred</span><span class="scan-brand-mode">Gate scanner</span></span>
        </div>
        <a class="scan-exit" href="#/directory">Close</a>
      </div>
      ${gateBar}
      <div class="scan-viewport">
        <video class="scan-video" playsinline muted autoplay></video>
        <div class="scan-shade" aria-hidden="true"></div>
        <div class="scan-reticle" aria-hidden="true"><span></span><span></span><span></span><span></span><i></i></div>
        <div class="scan-hint" id="scan-hint"><strong>Align the badge QR in the frame</strong><span>Verification starts automatically</span></div>
      </div>
      <div class="scan-lower">
        <div class="scan-connection" id="scan-connection"><span></span><strong>${navigator.onLine ? 'Online' : 'Offline mode'}</strong></div>
        <div class="scan-status" id="scan-status" role="status" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function errorHtml(title, detail, { showRetry = false } = {}) {
  return `
    <div class="scan-page">
      <div class="scan-topbar">
        <div class="scan-brand"><span class="scan-brand-mark">${shieldLogo()}</span>Scan badge</div>
        <a class="scan-exit" href="#/directory">Close</a>
      </div>
      <div class="scan-error">
        <div class="scan-error-title">${escapeHtml(title)}</div>
        <div class="scan-error-detail">${escapeHtml(detail)}</div>
        ${showRetry ? `<button class="btn btn-primary" id="scan-retry">Try again</button>` : ''}
        <a class="scan-error-alt" href="#/directory">Use the directory instead</a>
      </div>
    </div>
  `;
}

// Short haptic tick on a successful read. A gate is loud, often gloved, and
// the guard is looking at the worker rather than the screen — the buzz is
// frequently the only feedback that actually lands. Silently unsupported on
// desktop and iOS Safari, which is fine.
function buzz(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {}
}

export async function renderScan(container) {
  const gateSlug = readGateSlug();
  container.innerHTML = shellHtml({ gateLabel: gateSlug ? '…' : null });

  const video = container.querySelector('.scan-video');
  const statusEl = container.querySelector('#scan-status');

  // Resolve the site caption in the background — the camera should come up
  // immediately rather than waiting on a network round trip at a gate with
  // bad signal.
  if (gateSlug) {
    gateSiteLabel(gateSlug).then((label) => {
      const name = container.querySelector('.scan-site-name');
      if (name && label) name.textContent = label;
    });
  }

  const changeSite = container.querySelector('#scan-site-change');
  if (changeSite) {
    changeSite.addEventListener('click', () => {
      try { localStorage.removeItem(GATE_KEY); } catch {}
      restart();
    });
  }

  let scanner = null;
  let disposed = false;
  let statusTimer = null;

  function setStatus(message, tone = 'info') {
    if (statusTimer) clearTimeout(statusTimer);
    statusEl.className = `scan-status scan-status-${tone}`;
    statusEl.textContent = message;
    if (message) {
      statusTimer = setTimeout(() => {
        statusEl.textContent = '';
        statusEl.className = 'scan-status';
      }, 4000);
    }
  }

  // Two different levels of teardown, and the difference matters:
  //
  // releaseCamera() — let go of the hardware but stay wired up, so the page
  //   can bring it back. Used when the app is merely backgrounded.
  // dispose() — that, plus unhooking every listener. Used when we're actually
  //   leaving the page. Calling this on a mere backgrounding would strand the
  //   guard on a permanently black camera, since nothing would be left
  //   listening to restart it.
  function releaseCamera() {
    scanner?.stop();
    scanner = null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (statusTimer) clearTimeout(statusTimer);
    releaseCamera();
    window.removeEventListener('hashchange', onHashChange);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', releaseCamera);
    window.removeEventListener('pageshow', onShow);
    window.removeEventListener('online', updateConnection);
    window.removeEventListener('offline', updateConnection);
  }

  // Tears down this render pass and starts a fresh one. Restarting beats
  // resuming: Android frequently revokes a camera stream while the app is
  // backgrounded, so the old MediaStream often can't be revived anyway.
  function restart() {
    dispose();
    renderScan(container);
  }

  // The router has no per-route teardown hook, so releasing the camera is this
  // page's own responsibility. Without this the stream — and the camera
  // indicator light — survives navigating away.
  function onHashChange() {
    if (getPath() !== '/scan') dispose();
  }

  // Backgrounding the app (home button, screen lock, app switcher) should
  // release the camera rather than hold it open behind a black screen.
  function onVisibility() {
    if (document.hidden) releaseCamera();
    else if (!disposed && getPath() === '/scan' && !scanner) restart();
  }

  // bfcache restore. visibilitychange usually covers backgrounding on its own,
  // but a page restored from the back/forward cache fires pageshow instead —
  // and would otherwise come back with no camera and no way to get one.
  function onShow(event) {
    if (event.persisted && !disposed && getPath() === '/scan' && !scanner) restart();
  }

  function updateConnection() {
    const el = container.querySelector('#scan-connection');
    if (!el) return;
    el.classList.toggle('is-offline', !navigator.onLine);
    const label = el.querySelector('strong');
    if (label) label.textContent = navigator.onLine ? 'Online' : 'Offline mode';
  }

  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', releaseCamera);
  window.addEventListener('pageshow', onShow);
  window.addEventListener('online', updateConnection);
  window.addEventListener('offline', updateConnection);
  updateConnection();

  function handleResult(raw) {
    const parsed = parseScannedCode(raw, tenantSlug);

    if (parsed.kind === 'worker') {
      buzz(40);
      dispose();
      // ?from=scan makes /r/:slug offer "Scan another" instead of stranding
      // the guard on the record with no way back to the camera.
      navigate(`/r/${encodeURIComponent(parsed.slug)}?from=scan`);
      return;
    }

    if (parsed.kind === 'gate') {
      buzz(40);
      dispose();
      navigate(`/gate/${encodeURIComponent(parsed.slug)}`);
      return;
    }

    if (parsed.kind === 'foreign-tenant') {
      // Deliberately loud and deliberately not looked up — see the
      // cross-tenant note in js/lib/qrScanner.js.
      buzz([60, 60, 60]);
      setStatus(`That badge belongs to a different FieldCred account (${parsed.tenant}). It can't be checked on this device.`, 'error');
      return;
    }

    // Unknown QR: a camera pointed at a jobsite sees plenty of codes that
    // aren't ours. Say so quietly and keep scanning — no buzz, no modal.
    setStatus('Not a FieldCred badge — still scanning.', 'muted');
  }

  function handleError({ code, message }) {
    const copy = {
      'permission-denied': [
        'Camera access is off',
        'FieldCred needs the camera to read badge QR codes. Allow camera access for this app in your browser or system settings, then try again.',
      ],
      'no-camera': ['No camera found', 'This device has no camera available, so badges have to be looked up by name in the directory instead.'],
      'no-decoder': ['Scanning not supported', "This browser can't decode QR codes. Use the phone's camera app on the badge QR, or look the worker up in the directory."],
      'insecure-context': ['Camera needs a secure connection', 'Browsers only allow the camera over HTTPS. Open this app on its https:// address instead.'],
      'camera-failed': ['Camera could not start', message || 'Another app may be using the camera. Close it and try again.'],
    }[code] || ['Camera could not start', message || 'Something went wrong starting the camera.'];

    dispose();
    container.innerHTML = errorHtml(copy[0], copy[1], { showRetry: code !== 'no-camera' && code !== 'no-decoder' });
    const retry = container.querySelector('#scan-retry');
    if (retry) retry.addEventListener('click', () => renderScan(container));
  }

  try {
    scanner = await startScanner({ video, onResult: handleResult, onError: handleError });
  } catch (err) {
    handleError({ code: 'camera-failed', message: err?.message });
    return;
  }

  // The page was navigated away from while getUserMedia was still resolving —
  // stop the stream we were just handed instead of leaking it.
  if (disposed) {
    scanner?.stop();
  }
}
