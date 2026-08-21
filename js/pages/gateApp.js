// FieldCred Gate — the mobile companion app (route #/gate-app).
//
// WHAT THIS IS: the kiosk that lives on a tablet at a jobsite gate. A guard
// scans a badge and gets a full-screen CLEARED / NOT CLEARED poster in about
// two seconds; a supervisor unlocks the same device to see today's numbers,
// the scan log and the site's requirements.
//
// HOW IT DIFFERS FROM js/pages/scan.js: that page decodes a badge and then
// NAVIGATES to /r/:slug, which costs a camera restart per worker and buries
// the verdict inside a record page built for a different reader (the worker
// themselves, or someone they shared a link with). This app keeps the camera
// warm — startScanner()'s pause()/resume(), not stop()/start() — and renders
// a verdict screen designed to be read at arm's length by someone who is
// looking at the worker, not the tablet. /scan and /r/:slug stay exactly as
// they are; both apps share their clearance and logging through
// js/lib/gateVerdict.js so the two surfaces can't drift.
//
// AUTH SHAPE: guard mode is unauthenticated on purpose — a shared gate kiosk
// is not something anyone signs in to, and the screens it can reach (scan,
// verdict, lookup) read only anon-safe endpoints. Supervisor mode requires a
// real Supabase session, because every screen behind it reads gate_scans,
// which RLS grants to `authenticated` only. The PIN is fast re-entry on top
// of that session, never a substitute for it — see js/lib/gateSession.js.
//
// This is one page module with several screens rather than several routes, on
// purpose: the camera, the paired-site context and the offline state are all
// one continuous session at a gate, and routing between them would tear the
// camera down and rebuild it between every worker in the shift-change queue.

import { startScanner, parseScannedCode } from '../lib/qrScanner.js';
import { navigate, getPath } from '../lib/router.js';
import { escapeHtml, formatTime, initials } from '../lib/format.js';
import { tenantSlug } from '../lib/supabaseClient.js';
import { getSession } from '../lib/auth.js';
import { isPermissionError, roleFromSession, roleLabel } from '../lib/roles.js';
import { store } from '../lib/state.js';
import { buildVerdict, resolveSite, shortExpiry, VERDICT } from '../lib/gateVerdict.js';
import {
  MODE_GUARD,
  MODE_SUPERVISOR,
  PIN_LENGTH,
  clearPairedSlug,
  clearPin,
  getMode,
  getPairedSlug,
  hasPin,
  queuedScanCount,
  setMode,
  setPairedSlug,
  setPin,
  verifyPin,
} from '../lib/gateSession.js';

// Haptics. A gate is loud, often gloved, and the guard is looking at the
// worker rather than the screen — the buzz is frequently the only feedback
// that actually lands. Three distinguishable patterns so the verdict is
// legible without looking. Silently unsupported on desktop and iOS Safari.
const BUZZ = {
  cleared: 40,
  blocked: [60, 60, 60],
  unknown: 220,
};

function buzz(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {}
}

// ---------- shared chrome -------------------------------------------------

function topBarHtml(title, { closeLabel = 'CLOSE', tone = 'light' } = {}) {
  return `
    <div class="gate-topbar gate-topbar-${tone}">
      <div class="gate-topbar-title">${escapeHtml(title)}</div>
      <button class="gate-topbar-close" type="button" data-action="close">${escapeHtml(closeLabel)}</button>
    </div>`;
}

function offlineBannerHtml(ctx) {
  if (!ctx.offline) return '';
  const from = ctx.cachedAt ? ` from ${escapeHtml(formatTime(ctx.cachedAt))}` : '';
  const queued = ctx.queued
    ? ` ${ctx.queued} scan${ctx.queued > 1 ? 's' : ''} queued to sync.`
    : ' Scans queue and sync later.';
  return `<div class="gate-offline-banner">● OFFLINE — verdicts use cached data${from}.${queued}</div>`;
}

function initialsSquareHtml(name, className) {
  return `<div class="${className}">${escapeHtml(initials(name || '') || '—')}</div>`;
}

function arrowButtonHtml(label, action, variant) {
  return `<button class="gate-btn gate-btn-${variant}" type="button" data-action="${action}">
    <span>${escapeHtml(label)}</span><span aria-hidden="true">→</span>
  </button>`;
}

// The site caption every screen carries: "Eastline Terminal · Gate 2". A site
// has no separate "gate" field in the schema, so `location` fills that slot
// when it's set — it's what a site's second line already holds in the admin UI.
function siteLabel(site, pairedSlug) {
  if (!site) return pairedSlug ? 'Site unavailable' : 'No site paired';
  return site.location ? `${site.name} · ${site.location}` : site.name;
}

// ---------- screens -------------------------------------------------------

function guardHomeHtml(ctx) {
  const label = siteLabel(ctx.site, ctx.pairedSlug);
  return `
    <div class="gate-screen">
      <div class="gate-header">
        <div class="gate-brand">FIELDCRED GATE</div>
        <div class="gate-header-row">
          <div>
            <div class="gate-kicker">CHECKING AGAINST</div>
            <div class="gate-site-name">${escapeHtml(label)}</div>
          </div>
          <button class="gate-change-link" type="button" data-action="pairing">CHANGE</button>
        </div>
      </div>
      ${offlineBannerHtml(ctx)}
      ${
        ctx.pairedSlug
          ? ''
          : `<div class="gate-unpaired-note">This device isn't paired to a site yet. Scan the QR posted at the gate — verdicts can't be issued until it is.</div>`
      }
      <div class="gate-body gate-body-guard">
        <button class="gate-scan-target" type="button" data-action="scanner">
          <span class="gate-reticle" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span class="gate-scan-target-label">TAP TO SCAN A BADGE<span aria-hidden="true">→</span></span>
        </button>
        ${arrowButtonHtml('LOOK UP BY NAME', 'lookup', 'outline')}
      </div>
      <button class="gate-footer-link" type="button" data-action="supervisor">
        DEVICE LOCKED TO GATE MODE · SUPERVISOR ${ctx.needsSignIn ? 'SIGN-IN' : 'PIN'} TO EXIT →
      </button>
    </div>`;
}

function scannerHtml(ctx) {
  const label = siteLabel(ctx.site, ctx.pairedSlug);
  return `
    <div class="gate-screen gate-screen-dark">
      ${topBarHtml('SCAN BADGE', { tone: 'dark' })}
      <div class="gate-scanner-strip">${escapeHtml(
        `${ctx.offline ? '● OFFLINE · ' : ''}CHECKING AGAINST ${label.toUpperCase()}`
      )}</div>
      <div class="gate-viewport">
        <video class="gate-video" playsinline muted autoplay></video>
        <div class="gate-reticle gate-reticle-lg" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></div>
        <div class="gate-viewport-hint" id="gate-hint">Point the camera at the QR on the worker's badge.</div>
      </div>
    </div>`;
}

function scannerErrorHtml(title, detail, { showRetry }) {
  return `
    <div class="gate-screen gate-screen-dark">
      ${topBarHtml('SCAN BADGE', { tone: 'dark' })}
      <div class="gate-scan-error">
        <div class="gate-scan-error-title">${escapeHtml(title)}</div>
        <div class="gate-scan-error-detail">${escapeHtml(detail)}</div>
        ${showRetry ? arrowButtonHtml('TRY AGAIN', 'scanner', 'invert') : ''}
        ${arrowButtonHtml('LOOK UP BY NAME', 'lookup', 'invert')}
      </div>
    </div>`;
}

// Verdict footers all read the same shape: what happened to the audit row,
// then the one action worth taking. The audit line is not decoration — it is
// the app telling the guard whether a record of this decision actually
// exists, which is the difference between a compliance artifact and a guess.
function auditLineHtml(v, hapticLabel) {
  if (!v.loggable) return `✕ NOT LOGGED — BADGE FROM ANOTHER ORGANIZATION`;
  if (v.logged) return `✓ LOGGED TO SITE LOG · HAPTIC: ${hapticLabel}`;
  if (v.queued) return `✓ QUEUED FOR SITE LOG · HAPTIC: ${hapticLabel}`;
  return `⌁ NOT LOGGED — NO SIGNAL AND NO LOCAL QUEUE`;
}

function verdictKickerHtml(v) {
  const via = v.via === 'lookup' ? 'MANUAL LOOKUP' : 'SCAN RESULT';
  return `<div class="gate-verdict-kicker">${escapeHtml(via)} · ${escapeHtml(formatTime(v.at))}</div>`;
}

function cachedNoteHtml(v, className) {
  if (!v.fromCache) return '';
  const when = v.cachedAt ? ` (${formatTime(v.cachedAt)})` : '';
  return `<div class="${className}">● Verdict from cached data${escapeHtml(when)} — confirm another way if you can.</div>`;
}

function clearedHtml(v, ctx) {
  const rows = v.met
    .map((m) => {
      const expiring = m.status === 'expiring';
      const tag = expiring
        ? `EXPIRING · ${shortExpiry(m.expiryDate, v.at)}`
        : `VALID · ${shortExpiry(m.expiryDate, v.at)}`;
      return `<div class="gate-req-row">
        <span class="gate-req-name">${escapeHtml(m.certName)}</span>
        <span class="gate-req-tag ${expiring ? 'is-expiring' : 'is-valid'}">${escapeHtml(tag)}</span>
      </div>`;
    })
    .join('');

  return `
    <div class="gate-screen">
      ${topBarHtml('FIELDCRED GATE')}
      <div class="gate-body gate-body-scroll">
        ${verdictKickerHtml(v)}
        <div class="gate-headline gate-headline-cleared">CLEARED</div>
        <div class="gate-rule"></div>
        <div class="gate-worker-row">
          ${initialsSquareHtml(v.worker?.name, 'gate-avatar')}
          <div>
            <div class="gate-worker-name">${escapeHtml(v.worker?.name || '')}</div>
            <div class="gate-worker-sub">${escapeHtml(workerSubline(v.worker))}</div>
          </div>
        </div>
        <div class="gate-kicker gate-kicker-spaced">REQUIRED FOR ${escapeHtml(siteLabel(v.site, ctx.pairedSlug).toUpperCase())}</div>
        <div class="gate-req-list">${rows}</div>
        ${
          v.expiring.length
            ? `<div class="gate-note gate-note-warn">⌁ ${escapeHtml(v.expiring.join(', '))} expiring within 60 days — still met today.</div>`
            : ''
        }
        ${cachedNoteHtml(v, 'gate-note gate-note-warn')}
      </div>
      <div class="gate-verdict-footer">
        <div class="gate-audit-line">${escapeHtml(auditLineHtml(v, 'SHORT BUZZ'))}</div>
        ${arrowButtonHtml('SCAN NEXT', 'scanner', 'solid')}
      </div>
    </div>`;
}

function blockedHtml(v, ctx) {
  const rows = v.missing
    .map((m) => `<div class="gate-missing-row">✕ ${escapeHtml(m.line)}</div>`)
    .join('');

  return `
    <div class="gate-screen gate-screen-alert">
      ${topBarHtml('FIELDCRED GATE', { tone: 'alert' })}
      <div class="gate-body gate-body-scroll">
        ${verdictKickerHtml(v)}
        <div class="gate-headline gate-headline-blocked">NOT<br>CLEARED</div>
        <div class="gate-rule gate-rule-invert"></div>
        <div class="gate-worker-row">
          ${initialsSquareHtml(v.worker?.name, 'gate-avatar gate-avatar-invert')}
          <div>
            <div class="gate-worker-name">${escapeHtml(v.worker?.name || '')}</div>
            <div class="gate-worker-sub">${escapeHtml(workerSubline(v.worker))}</div>
          </div>
        </div>
        <div class="gate-kicker gate-kicker-spaced">MISSING FOR ${escapeHtml(siteLabel(v.site, ctx.pairedSlug).toUpperCase())}</div>
        <div class="gate-missing-list">${rows}</div>
        <div class="gate-note">Direct the worker to their supervisor. This scan was logged as blocked.</div>
        ${cachedNoteHtml(v, 'gate-note')}
      </div>
      <div class="gate-verdict-footer">
        <div class="gate-audit-line">${escapeHtml(auditLineHtml(v, 'DOUBLE BUZZ'))}</div>
        ${arrowButtonHtml('SCAN NEXT', 'scanner', 'invert')}
      </div>
    </div>`;
}

function unknownHtml(v, body) {
  return `
    <div class="gate-screen">
      ${topBarHtml('FIELDCRED GATE')}
      <div class="gate-body gate-body-scroll">
        ${verdictKickerHtml(v)}
        <div class="gate-headline gate-headline-unknown">UNRECOGNIZED<br>BADGE</div>
        <div class="gate-rule"></div>
        <div class="gate-copy">${escapeHtml(body)}</div>
        ${arrowButtonHtml('LOOK UP BY NAME', 'lookup', 'outline')}
      </div>
      <div class="gate-verdict-footer">
        <div class="gate-audit-line">${escapeHtml(auditLineHtml(v, 'LONG BUZZ'))}</div>
        ${arrowButtonHtml('SCAN AGAIN', 'scanner', 'solid')}
      </div>
    </div>`;
}

// A site with no requirements configured can't clear anyone, and must never
// render as a green CLEARED poster — the guard would read "this worker is
// good for this site" from a site that has never said what good means. Same
// rule as gateBannerHtml() in publicRecord.js.
function neutralVerdictHtml(v, ctx, { headline, body }) {
  return `
    <div class="gate-screen">
      ${topBarHtml('FIELDCRED GATE')}
      <div class="gate-body gate-body-scroll">
        ${verdictKickerHtml(v)}
        <div class="gate-headline gate-headline-neutral">${headline}</div>
        <div class="gate-rule"></div>
        ${
          v.worker
            ? `<div class="gate-worker-row">
                 ${initialsSquareHtml(v.worker.name, 'gate-avatar')}
                 <div>
                   <div class="gate-worker-name">${escapeHtml(v.worker.name)}</div>
                   <div class="gate-worker-sub">${escapeHtml(workerSubline(v.worker))}</div>
                 </div>
               </div>`
            : ''
        }
        <div class="gate-copy">${escapeHtml(body)}</div>
        ${cachedNoteHtml(v, 'gate-note gate-note-warn')}
      </div>
      <div class="gate-verdict-footer">
        <div class="gate-audit-line">${escapeHtml(auditLineHtml(v, 'LONG BUZZ'))}</div>
        ${arrowButtonHtml('SCAN NEXT', 'scanner', 'solid')}
      </div>
    </div>`;
}

function workerSubline(worker) {
  if (!worker) return '';
  return [worker.title, worker.department].filter(Boolean).join(' · ');
}

function lookupHtml(ctx) {
  const rows = ctx.lookupResults
    .map(
      (w) => `
      <button class="gate-lookup-row" type="button" data-action="check" data-slug="${escapeHtml(w.publicSlug)}">
        ${initialsSquareHtml(w.name, 'gate-avatar gate-avatar-sm')}
        <span class="gate-lookup-copy">
          <span class="gate-lookup-name">${escapeHtml(w.name)}</span>
          <span class="gate-lookup-sub">${escapeHtml([w.title, w.department].filter(Boolean).join(' · '))}</span>
        </span>
        <span class="gate-lookup-cta">CHECK →</span>
      </button>`
    )
    .join('');

  let listHtml = rows;
  if (!ctx.lookupResults.length) {
    if (ctx.lookupBusy) listHtml = `<div class="gate-lookup-empty">Searching…</div>`;
    else if (ctx.lookupError) listHtml = `<div class="gate-lookup-empty">${escapeHtml(ctx.lookupError)}</div>`;
    else if (ctx.lookupQuery.trim().length >= 2)
      listHtml = `<div class="gate-lookup-empty">No workers match "${escapeHtml(ctx.lookupQuery.trim())}".</div>`;
    else listHtml = `<div class="gate-lookup-empty">Type at least two letters of the worker's name.</div>`;
  }

  return `
    <div class="gate-screen">
      ${topBarHtml('LOOK UP BY NAME')}
      <div class="gate-lookup-search">
        <input class="gate-input" id="gate-lookup-input" type="search" autocomplete="off"
               placeholder="Worker name…" value="${escapeHtml(ctx.lookupQuery)}">
        <div class="gate-lookup-hint">Manual lookups get the same clearance check and are logged the same way.</div>
      </div>
      <div class="gate-body gate-body-scroll gate-body-flush">${listHtml}</div>
    </div>`;
}

function pairingHtml(ctx) {
  const cards = ctx.pairingSites
    .map(
      (s) => `
      <button class="gate-site-card ${s.publicSlug === ctx.pairedSlug ? 'is-paired' : ''}" type="button"
              data-action="pair" data-slug="${escapeHtml(s.publicSlug)}">
        <span class="gate-site-card-head">
          <span class="gate-site-card-name">${escapeHtml(siteLabel(s, s.publicSlug))}</span>
          ${s.publicSlug === ctx.pairedSlug ? '<span class="gate-paired-tag">PAIRED</span>' : ''}
        </span>
        <span class="gate-site-card-reqs">Requires: ${escapeHtml(
          s.requiredTypeNames?.length ? s.requiredTypeNames.join(', ') : 'nothing yet'
        )}</span>
      </button>`
    )
    .join('');

  return `
    <div class="gate-screen">
      ${topBarHtml('PAIR TO A SITE')}
      <div class="gate-explainer">In the field, pair by scanning the QR posted at the gate. Verdicts on this device are then checked against that site's requirements — set once, kept offline.</div>
      <div class="gate-body gate-body-scroll">
        ${arrowButtonHtml('SCAN THE GATE QR', 'scanner', 'outline')}
        ${
          ctx.pairingSites.length
            ? `<div class="gate-kicker gate-kicker-spaced">OR CHOOSE A SITE</div>${cards}`
            : `<div class="gate-lookup-empty">${escapeHtml(
                ctx.pairingError ||
                  'Choosing from a list needs a supervisor sign-in. At the gate, scan the site QR instead.'
              )}</div>`
        }
      </div>
    </div>`;
}

function pinHtml(ctx) {
  const dots = Array.from({ length: PIN_LENGTH })
    .map((_, i) => `<span class="gate-pin-dot ${i < ctx.pin.length ? 'is-filled' : ''}"></span>`)
    .join('');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0']
    .map(
      (k) =>
        `<button class="gate-pin-key ${k === '⌫' ? 'gate-pin-key-back' : ''}" type="button" data-action="pin-key" data-key="${escapeHtml(k)}">${escapeHtml(k)}</button>`
    )
    .join('');

  const settingUp = ctx.screen === 'setPin';
  return `
    <div class="gate-screen">
      ${topBarHtml(settingUp ? 'SET A SUPERVISOR PIN' : 'SUPERVISOR PIN', { closeLabel: 'CANCEL' })}
      <div class="gate-pin-body">
        <div>
          <div class="gate-copy">${
            settingUp
              ? 'Choose a 4-digit PIN. It reopens supervisor mode on this device without signing in again.'
              : 'Enter the supervisor PIN to leave gate mode.'
          }</div>
          <div class="gate-pin-dots">${dots}</div>
          ${ctx.pinError ? `<div class="gate-pin-error">${escapeHtml(ctx.pinError)}</div>` : ''}
          ${
            settingUp
              ? `<div class="gate-pin-hint">The PIN is convenience only — supervisor data still comes from your signed-in session.</div>`
              : `<button class="gate-pin-alt" type="button" data-action="supervisor-signin">Forgot it? Sign in instead →</button>`
          }
        </div>
        <div class="gate-pin-keypad">${keys}</div>
      </div>
    </div>`;
}

const LOG_META = {
  cleared: { label: 'CLEARED', className: 'is-cleared' },
  blocked: { label: 'BLOCKED', className: 'is-blocked' },
  no_requirements: { label: 'NO REQUIREMENTS', className: 'is-unknown' },
  unknown_worker: { label: 'UNRECOGNIZED', className: 'is-unknown' },
  unknown_site: { label: 'UNRECOGNIZED GATE', className: 'is-unknown' },
};

function logRowHtml(scan, { withMissing = false } = {}) {
  const meta = LOG_META[scan.result] || { label: String(scan.result).toUpperCase(), className: 'is-unknown' };
  const who = scan.workerName || scan.workerSlug || 'unknown badge';
  const missing =
    withMissing && scan.missingTypes.length
      ? `<div class="gate-log-missing">Missing: ${escapeHtml(scan.missingTypes.map((t) => t.name).join(', '))}</div>`
      : '';
  return `<div class="gate-log-row">
    <div class="gate-log-line">
      <span class="gate-log-who">${escapeHtml(formatTime(scan.scannedAt))} · ${escapeHtml(who)}</span>
      <span class="gate-log-tag ${meta.className}">${escapeHtml(meta.label)}</span>
    </div>
    ${missing}
  </div>`;
}

function supervisorHtml(ctx) {
  const label = siteLabel(ctx.site, ctx.pairedSlug);
  const tab = ctx.supTab;

  let body;
  if (ctx.logError) {
    body = `<div class="gate-lookup-empty">${escapeHtml(ctx.logError)}</div>`;
  } else if (tab === 'home') {
    body = `
      <div class="gate-sup-stack">
        <div class="gate-stats">
          <div class="gate-stat"><div class="gate-stat-value">${ctx.stats.total}</div><div class="gate-kicker">SCANS TODAY</div></div>
          <div class="gate-stat"><div class="gate-stat-value is-cleared">${ctx.stats.cleared}</div><div class="gate-kicker">CLEARED</div></div>
          <div class="gate-stat"><div class="gate-stat-value is-blocked">${ctx.stats.blocked}</div><div class="gate-kicker">BLOCKED</div></div>
        </div>
        ${arrowButtonHtml('SCAN A BADGE', 'scanner', 'solid')}
        <div>
          <div class="gate-kicker">RECENT SCANS${ctx.site?.location ? ` · ${escapeHtml(ctx.site.location.toUpperCase())}` : ''}</div>
          <div class="gate-log-list">
            ${
              ctx.scans.length
                ? ctx.scans.slice(0, 5).map((s) => logRowHtml(s)).join('')
                : '<div class="gate-lookup-empty">No scans logged yet at this gate.</div>'
            }
          </div>
        </div>
      </div>`;
  } else if (tab === 'log') {
    body = `
      <div class="gate-sup-title">Scan log</div>
      <div class="gate-sup-sub">Every scan at this gate — cleared, blocked, or unrecognized — is written to the site audit log the moment it happens.</div>
      <div class="gate-log-list">
        ${
          ctx.scans.length
            ? ctx.scans.map((s) => logRowHtml(s, { withMissing: true })).join('')
            : '<div class="gate-lookup-empty">No scans logged yet at this gate.</div>'
        }
      </div>
      ${
        ctx.queued
          ? `<div class="gate-note gate-note-warn">● ${ctx.queued} offline scan${ctx.queued > 1 ? 's' : ''} queued — will sync to the site log when back online.</div>`
          : ''
      }`;
  } else {
    const reqs = ctx.site?.requiredTypes || [];
    body = `
      <div class="gate-sup-title">${escapeHtml(ctx.site?.name || label)}</div>
      <div class="gate-kicker gate-kicker-spaced">REQUIRED CREDENTIAL TYPES</div>
      <div class="gate-req-list gate-req-list-plain">
        ${
          reqs.length
            ? reqs.map((t) => `<div class="gate-req-plain">${escapeHtml(t.name)}</div>`).join('')
            : '<div class="gate-lookup-empty">No credential requirements are set for this site yet — no one can be cleared against it.</div>'
        }
      </div>
      <div class="gate-note">A worker is cleared only when every required type is met by a valid or expiring credential — never an expired one, never one with no date.</div>
      ${arrowButtonHtml('CHANGE PAIRED SITE', 'pairing', 'outline')}
      ${arrowButtonHtml('RETURN TO GATE MODE', 'return-gate', 'solid')}`;
  }

  return `
    <div class="gate-screen">
      <div class="gate-header gate-header-sup">
        <div>
          <div class="gate-brand">FIELDCRED</div>
          <div class="gate-sup-ident">${escapeHtml(label)} · ${escapeHtml(ctx.userLabel)}</div>
        </div>
        ${initialsSquareHtml(ctx.userName, 'gate-avatar gate-avatar-sm')}
      </div>
      ${offlineBannerHtml(ctx)}
      <div class="gate-body gate-body-scroll">${body}</div>
      <div class="gate-tabs">
        <button class="gate-tab ${tab === 'home' ? 'is-active' : ''}" type="button" data-action="tab" data-tab="home">HOME</button>
        <button class="gate-tab" type="button" data-action="lookup">LOOKUP</button>
        <button class="gate-tab ${tab === 'log' ? 'is-active' : ''}" type="button" data-action="tab" data-tab="log">LOG</button>
        <button class="gate-tab ${tab === 'site' ? 'is-active' : ''}" type="button" data-action="tab" data-tab="site">SITE</button>
      </div>
    </div>`;
}

// ---------- the app -------------------------------------------------------

// Teardown hook for whichever instance is currently live.
//
// WHY THIS IS NEEDED: the router has no per-route teardown, and main.js calls
// redispatch() on EVERY Supabase auth event (main.js:262) — including the
// INITIAL_SESSION that fires on startup and the token refresh that fires
// roughly hourly. Each of those re-enters renderGateApp on the same container
// while the previous instance is still fully wired: its window/document
// listeners, its delegated click handler, and — the one that actually hurts —
// its live MediaStream. On a tablet left in gate mode for a twelve-hour
// shift that is a dozen orphaned instances, a dozen click handlers racing to
// render into the same node, and a camera nothing can release.
//
// Disposing the previous instance before starting a new one is the whole fix.
let activeDispose = null;

export async function renderGateApp(container, _params, query) {
  activeDispose?.();

  const ctx = {
    screen: 'guardHome',
    mode: getMode(),
    supTab: 'home',
    pairedSlug: getPairedSlug(),
    site: null,
    offline: false,
    cachedAt: null,
    queued: 0,
    verdict: null,
    lookupQuery: '',
    lookupResults: [],
    lookupBusy: false,
    lookupError: '',
    pairingSites: [],
    pairingError: '',
    pin: '',
    pinError: '',
    scans: [],
    stats: { total: 0, cleared: 0, blocked: 0 },
    logError: '',
    session: null,
    userName: '',
    userLabel: '',
    needsSignIn: true,
  };

  let scanner = null;
  let disposed = false;
  let lookupTimer = null;
  let statusTimer = null;

  // ---- camera lifecycle. Two levels of teardown, and the difference matters
  // exactly as much as it does in js/pages/scan.js:
  //   releaseCamera() — let the hardware go but stay wired up, so the page can
  //     bring it back. Used when the app is merely backgrounded.
  //   dispose() — that, plus unhooking every listener. Used when leaving the
  //     page for good. Calling it on a mere backgrounding would strand the
  //     guard on a permanently black camera with nothing left to restart it.
  function releaseCamera() {
    scanner?.stop();
    scanner = null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (activeDispose === dispose) activeDispose = null;
    if (lookupTimer) clearTimeout(lookupTimer);
    if (statusTimer) clearTimeout(statusTimer);
    releaseCamera();
    window.removeEventListener('hashchange', onHashChange);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', releaseCamera);
    window.removeEventListener('pageshow', onShow);
    window.removeEventListener('online', onConnectionChange);
    window.removeEventListener('offline', onConnectionChange);
    container.removeEventListener('click', onClick);
    container.removeEventListener('input', onInput);
  }

  // The router has no per-route teardown hook, so releasing the camera is this
  // page's own responsibility. Without this the stream — and the camera
  // indicator light — survives navigating away.
  function onHashChange() {
    if (getPath() !== '/gate-app') dispose();
  }

  function onVisibility() {
    if (document.hidden) releaseCamera();
    else if (!disposed && ctx.screen === 'scanner' && !scanner) startCamera();
  }

  // bfcache restore. visibilitychange covers ordinary backgrounding, but a
  // page restored from the back/forward cache fires pageshow instead — and
  // would otherwise come back with no camera and no way to get one.
  function onShow(event) {
    if (event.persisted && !disposed && ctx.screen === 'scanner' && !scanner) startCamera();
  }

  async function onConnectionChange() {
    await refreshContext();
    render();
  }

  activeDispose = dispose;
  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', releaseCamera);
  window.addEventListener('pageshow', onShow);
  window.addEventListener('online', onConnectionChange);
  window.addEventListener('offline', onConnectionChange);
  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);

  // ---- data

  // Offline is derived from an actual failed fetch (or a cache hit), not from
  // navigator.onLine alone — a gate tablet on a jobsite wifi network with no
  // uplink reports itself as perfectly online. navigator.onLine is only used
  // as an extra hint, never as the sole signal. (Same rule as publicRecord.js.)
  async function refreshContext() {
    ctx.pairedSlug = getPairedSlug();
    ctx.mode = getMode();
    if (ctx.pairedSlug) {
      const resolved = await resolveSite(ctx.pairedSlug);
      ctx.site = resolved.site;
      ctx.offline = resolved.noSignal || resolved.fromCache || !navigator.onLine;
      ctx.cachedAt = resolved.cachedAt;
    } else {
      ctx.site = null;
      ctx.offline = !navigator.onLine;
      ctx.cachedAt = null;
    }
    ctx.queued = await queuedScanCount();
  }

  async function refreshSession() {
    try {
      ctx.session = await getSession();
    } catch {
      ctx.session = null;
    }
    const email = ctx.session?.user?.email || '';
    ctx.userName = ctx.session?.user?.user_metadata?.full_name || email.split('@')[0] || 'Supervisor';
    ctx.userLabel = ctx.session ? `${ctx.userName}, ${roleLabel(roleFromSession(ctx.session))}` : 'Signed out';
    ctx.needsSignIn = !ctx.session;
  }

  async function loadScanLog() {
    ctx.logError = '';
    if (!ctx.site?.id) {
      ctx.scans = [];
      ctx.stats = { total: 0, cleared: 0, blocked: 0 };
      ctx.logError = ctx.pairedSlug
        ? "This site isn't reachable right now, so its scan log can't be loaded."
        : 'Pair this device to a site to see its scan log.';
      return;
    }
    try {
      ctx.scans = await store.siteScanLog(ctx.site.id);
    } catch {
      ctx.scans = [];
      // The one failure worth naming specifically: the supervisor's session
      // lapsed. RLS grants gate_scans to authenticated only, so this reads as
      // an empty log rather than an error unless we say what happened.
      ctx.logError = ctx.session
        ? "Couldn't load the scan log — no connection to the server."
        : 'Sign in again to read this site\'s scan log.';
      return;
    }
    // "Today" is the device's local day, which is the same day the guard is
    // working — the audit page (js/pages/siteScanLog.js) shows everything, so
    // this is a shift-shaped summary, not a second source of truth.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = ctx.scans.filter((s) => new Date(s.scannedAt) >= startOfDay);
    ctx.stats = {
      total: today.length,
      cleared: today.filter((s) => s.result === 'cleared').length,
      blocked: today.filter((s) => s.result === 'blocked').length,
    };
  }

  async function loadPairingSites() {
    ctx.pairingError = '';
    // Choosing from a list needs the authenticated sites table — there is
    // deliberately no anon endpoint that enumerates sites (migration 008).
    // In guard mode this list is simply absent and the screen falls back to
    // "scan the gate QR", which is how pairing is meant to happen anyway.
    if (!ctx.session) {
      ctx.pairingSites = [];
      return;
    }
    try {
      const [sites, requiredRows, types] = await Promise.all([
        store.sites(),
        store.allSiteRequiredTypes(),
        store.credentialTypes(),
      ]);
      const typeName = new Map(types.map((t) => [t.id, t.name]));
      const bySite = new Map();
      for (const row of requiredRows) {
        if (!bySite.has(row.site_id)) bySite.set(row.site_id, []);
        bySite.get(row.site_id).push(typeName.get(row.type_id) || 'Unnamed type');
      }
      ctx.pairingSites = sites
        .filter((s) => s.active)
        .map((s) => ({ ...s, requiredTypeNames: (bySite.get(s.id) || []).sort() }));
    } catch {
      ctx.pairingSites = [];
      ctx.pairingError = "Couldn't load the site list. At the gate, scan the site QR instead.";
    }
  }

  // ---- rendering

  function render() {
    if (disposed) return;
    const before = container.querySelector('.gate-video') ? 'scanner' : null;

    let html;
    switch (ctx.screen) {
      case 'scanner':
        html = scannerHtml(ctx);
        break;
      case 'verdict':
        html = verdictHtml();
        break;
      case 'lookup':
        html = lookupHtml(ctx);
        break;
      case 'pairing':
        html = pairingHtml(ctx);
        break;
      case 'pin':
      case 'setPin':
        html = pinHtml(ctx);
        break;
      case 'supHome':
        html = supervisorHtml(ctx);
        break;
      default:
        html = guardHomeHtml(ctx);
    }
    container.innerHTML = `<div class="gate-app">${html}</div>`;

    if (ctx.screen === 'scanner' && !scanner) startCamera();
    // Left the scanner — the camera must go with the markup that held it.
    if (before === 'scanner' && ctx.screen !== 'scanner') releaseCamera();

    if (ctx.screen === 'lookup') {
      const input = container.querySelector('#gate-lookup-input');
      if (input) {
        input.focus();
        // Caret to the end — re-rendering on each keystroke would otherwise
        // jump it to the start and reverse everything typed after the first
        // character.
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    }
  }

  function verdictHtml() {
    const v = ctx.verdict;
    if (!v) return guardHomeHtml(ctx);
    switch (v.kind) {
      case VERDICT.CLEARED:
        return clearedHtml(v, ctx);
      case VERDICT.BLOCKED:
        return blockedHtml(v, ctx);
      case VERDICT.NO_REQUIREMENTS:
        return neutralVerdictHtml(v, ctx, {
          headline: 'NO<br>REQUIREMENTS',
          body: `${v.site?.name || 'This site'} has no credential requirements set, so no one can be cleared against it. A supervisor needs to set them before this gate can issue verdicts.`,
        });
      case VERDICT.UNKNOWN_SITE:
        return neutralVerdictHtml(v, ctx, {
          headline: 'SITE NOT<br>RECOGNIZED',
          body: "This device is paired to a site that no longer resolves — it may have been deactivated, or it has never been loaded on this device while online. Re-pair by scanning the QR posted at the gate.",
        });
      default:
        return unknownHtml(v, v.foreignTenant
          ? `This badge belongs to a different FieldCred account (${v.foreignTenant}). It can't be checked on this device, and nothing was written to this site's log.`
          : "This QR isn't a FieldCred badge for this organization — or the record was removed. Check the badge, or look the worker up by name.");
    }
  }

  function setHint(message) {
    const el = container.querySelector('#gate-hint');
    if (!el) return;
    if (statusTimer) clearTimeout(statusTimer);
    el.textContent = message;
    statusTimer = setTimeout(() => {
      const hint = container.querySelector('#gate-hint');
      if (hint) hint.textContent = "Point the camera at the QR on the worker's badge.";
    }, 4000);
  }

  // ---- camera

  async function startCamera() {
    const video = container.querySelector('.gate-video');
    if (!video || scanner) return;
    try {
      scanner = await startScanner({ video, onResult: handleDecode, onError: handleCameraError });
    } catch (err) {
      handleCameraError({ code: 'camera-failed', message: err?.message });
      return;
    }
    // Navigated away while getUserMedia was still resolving — stop the stream
    // we were just handed instead of leaking it.
    if (disposed || ctx.screen !== 'scanner') releaseCamera();
  }

  function handleCameraError({ code, message }) {
    const copy = {
      'permission-denied': [
        'Camera access is off',
        'FieldCred needs the camera to read badge QR codes. Allow camera access for this app, then try again.',
      ],
      'no-camera': [
        'No camera found',
        'This device has no camera available, so badges have to be looked up by name instead.',
      ],
      'no-decoder': [
        'Scanning not supported',
        "This browser can't decode QR codes. Look the worker up by name instead.",
      ],
      'insecure-context': [
        'Camera needs a secure connection',
        'Browsers only allow the camera over HTTPS. Open this app on its https:// address — or, if this is a dev server on a LAN IP, add that exact origin to Chrome’s "Insecure origins treated as secure" flag.',
      ],
      'camera-failed': ['Camera could not start', message || 'Another app may be using the camera.'],
    }[code] || ['Camera could not start', message || 'Something went wrong starting the camera.'];

    releaseCamera();
    container.innerHTML = `<div class="gate-app">${scannerErrorHtml(copy[0], copy[1], {
      showRetry: code !== 'no-camera' && code !== 'no-decoder',
    })}</div>`;
  }

  async function handleDecode(raw) {
    if (ctx.screen !== 'scanner') return;
    const parsed = parseScannedCode(raw, tenantSlug);

    if (parsed.kind === 'gate') {
      // Pairing by QR — the intended way a device gets pointed at a site.
      buzz(BUZZ.cleared);
      setPairedSlug(parsed.slug);
      // A PIN set by one site's supervisor shouldn't silently carry over to
      // another crew's gate.
      clearPin();
      await refreshContext();
      ctx.screen = ctx.mode === MODE_SUPERVISOR ? 'supHome' : 'guardHome';
      render();
      return;
    }

    if (parsed.kind === 'worker') {
      await runCheck(parsed.slug, 'scan');
      return;
    }

    if (parsed.kind === 'foreign-tenant') {
      // Deliberately NOT looked up and deliberately NOT logged. Each tenant is
      // a physically separate Supabase project, so a slug from another tenant
      // could collide with a DIFFERENT real worker here and produce a
      // confident verdict for the wrong person — and record_gate_scan() would
      // write that same wrong row to the audit log. See the cross-tenant note
      // in js/lib/qrScanner.js.
      buzz(BUZZ.unknown);
      pauseScanner();
      ctx.verdict = {
        kind: VERDICT.UNKNOWN_WORKER,
        met: [],
        expiring: [],
        missing: [],
        via: 'scan',
        at: new Date(),
        worker: null,
        site: ctx.site,
        fromCache: false,
        cachedAt: null,
        logged: false,
        queued: false,
        loggable: false,
        foreignTenant: parsed.tenant,
      };
      ctx.screen = 'verdict';
      render();
      return;
    }

    // A camera pointed at a jobsite sees plenty of QR codes that aren't ours
    // — a shipping label, a tool asset tag, a poster. Say so quietly and keep
    // scanning rather than throwing up a verdict screen for each one.
    setHint('Not a FieldCred badge — still scanning.');
  }

  // Suspend decoding while a verdict is up, rather than tearing the camera
  // down: SCAN NEXT then resumes instantly instead of paying a fresh
  // getUserMedia permission-and-warmup round trip for every worker in the
  // shift-change queue. This is the whole reason this app exists rather than
  // routing to /r/:slug like js/pages/scan.js does.
  function pauseScanner() {
    scanner?.pause();
  }

  // ---- the check itself

  async function runCheck(workerSlug, via) {
    pauseScanner();
    if (!ctx.pairedSlug) {
      // Fail closed: with no paired site there is nothing to check against,
      // and "no requirements to fail" must never render as cleared.
      buzz(BUZZ.unknown);
      ctx.verdict = {
        kind: VERDICT.UNKNOWN_SITE,
        met: [],
        expiring: [],
        missing: [],
        via,
        at: new Date(),
        worker: null,
        site: null,
        fromCache: false,
        cachedAt: null,
        logged: false,
        queued: false,
        loggable: false,
      };
      ctx.screen = 'verdict';
      render();
      return;
    }

    const verdict = await buildVerdict(ctx.pairedSlug, workerSlug, { via });
    buzz(verdict.kind === VERDICT.CLEARED ? BUZZ.cleared : verdict.kind === VERDICT.BLOCKED ? BUZZ.blocked : BUZZ.unknown);

    ctx.verdict = verdict;
    ctx.offline = verdict.fromCache || verdict.noSignal || !navigator.onLine;
    if (verdict.cachedAt) ctx.cachedAt = verdict.cachedAt;
    ctx.queued = await queuedScanCount();
    ctx.screen = 'verdict';
    render();
  }

  // ---- lookup

  function scheduleLookup() {
    if (lookupTimer) clearTimeout(lookupTimer);
    // Debounced: this hits an RPC, and a guard typing a name would otherwise
    // fire one request per keystroke over a jobsite connection.
    lookupTimer = setTimeout(runLookup, 250);
  }

  async function runLookup() {
    const term = ctx.lookupQuery.trim();
    ctx.lookupError = '';
    if (term.length < 2) {
      ctx.lookupResults = [];
      ctx.lookupBusy = false;
      render();
      return;
    }
    // An unpaired guard device has nothing to search: the roster RPC is scoped
    // to one site by slug. Say that, rather than returning zero rows and
    // letting it read as "this worker doesn't exist" — which at a gate is a
    // very different and much more consequential statement.
    if (!ctx.session && !ctx.pairedSlug) {
      ctx.lookupResults = [];
      ctx.lookupBusy = false;
      ctx.lookupError = 'Pair this device to a site before looking workers up by name.';
      render();
      return;
    }

    ctx.lookupBusy = true;
    render();
    try {
      // In supervisor mode the full directory is readable and more useful
      // (a worker not yet on this site's roster still needs checking); in
      // guard mode only this site's roster is anon-reachable at all.
      if (ctx.session) {
        const all = await store.getAll();
        const q = term.toLowerCase();
        ctx.lookupResults = all
          .filter((w) => w.publicSlug && (w.name.toLowerCase().includes(q) || (w.title || '').toLowerCase().includes(q)))
          .slice(0, 25)
          .map((w) => ({ publicSlug: w.publicSlug, name: w.name, title: w.title, department: w.department }));
      } else {
        ctx.lookupResults = await store.searchSiteRoster(ctx.pairedSlug, term);
      }
    } catch (err) {
      ctx.lookupResults = [];
      // Three distinct failure shapes need three distinct messages — see
      // isPermissionError() in roles.js and migration 013's rate limit on
      // search_site_roster(). Conflating any pair of these tells a guard the
      // wrong thing to do: "no signal" invites retrying a thing that will
      // never work, "turned off" invites giving up on something that will
      // work again in a few minutes.
      const rateLimited = (err?.message || '').includes('rate limit exceeded');
      ctx.lookupError = rateLimited
        ? 'Too many look-ups here right now — wait a few minutes and try again, or scan the badge instead.'
        : isPermissionError(err)
          ? 'Look-up by name is turned off for gate devices here. Scan the badge, or ask a supervisor to check.'
          : "Couldn't search right now — no connection. Scan the badge if you can.";
    }
    ctx.lookupBusy = false;
    render();
  }

  function onInput(event) {
    if (event.target.id !== 'gate-lookup-input') return;
    ctx.lookupQuery = event.target.value;
    scheduleLookup();
  }

  // ---- supervisor entry

  async function enterSupervisor() {
    await refreshSession();
    if (!ctx.session) {
      // No session, so nothing behind the PIN would load anyway — hand off to
      // the app's real login page and come back here.
      dispose();
      navigate(`/login?next=${encodeURIComponent('/gate-app?sup=1')}`);
      return;
    }
    ctx.pin = '';
    ctx.pinError = '';
    ctx.screen = hasPin() ? 'pin' : 'setPin';
    render();
  }

  async function openSupervisorHome() {
    setMode(MODE_SUPERVISOR);
    ctx.mode = MODE_SUPERVISOR;
    ctx.supTab = 'home';
    ctx.screen = 'supHome';
    ctx.pin = '';
    ctx.pinError = '';
    render();
    await loadScanLog();
    render();
  }

  async function handlePinKey(key) {
    if (key === '⌫') {
      ctx.pin = ctx.pin.slice(0, -1);
      ctx.pinError = '';
      render();
      return;
    }
    if (ctx.pin.length >= PIN_LENGTH) return;
    ctx.pin += key;
    ctx.pinError = '';
    render();
    if (ctx.pin.length < PIN_LENGTH) return;

    // Auto-submit at 4 digits — no confirm key, per the design.
    if (ctx.screen === 'setPin') {
      const ok = await setPin(ctx.pin);
      if (!ok) {
        ctx.pin = '';
        ctx.pinError = "Couldn't save the PIN on this device. You can still continue.";
        render();
      }
      await openSupervisorHome();
      return;
    }

    const ok = await verifyPin(ctx.pin);
    if (!ok) {
      ctx.pin = '';
      ctx.pinError = 'Wrong PIN — try again.';
      render();
      return;
    }
    // A correct PIN is not enough on its own — re-check the session, because
    // it may have expired since the PIN was set, and every supervisor screen
    // needs it.
    await refreshSession();
    if (!ctx.session) {
      dispose();
      navigate(`/login?next=${encodeURIComponent('/gate-app?sup=1')}`);
      return;
    }
    await openSupervisorHome();
  }

  // ---- events

  function homeScreen() {
    return ctx.mode === MODE_SUPERVISOR ? 'supHome' : 'guardHome';
  }

  async function onClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el || !container.contains(el)) return;
    const action = el.dataset.action;

    switch (action) {
      case 'scanner':
        ctx.screen = 'scanner';
        // Resume rather than restart when the camera is still alive — this is
        // the fast path between two workers in a queue.
        if (scanner) scanner.resume();
        render();
        break;

      case 'close':
        ctx.screen = homeScreen();
        ctx.verdict = null;
        releaseCamera();
        await refreshContext();
        if (ctx.screen === 'supHome') await loadScanLog();
        render();
        break;

      case 'lookup':
        ctx.screen = 'lookup';
        ctx.lookupQuery = '';
        ctx.lookupResults = [];
        ctx.lookupError = '';
        releaseCamera();
        render();
        break;

      case 'check':
        await runCheck(el.dataset.slug, 'lookup');
        break;

      case 'pairing':
        ctx.screen = 'pairing';
        releaseCamera();
        render();
        await loadPairingSites();
        render();
        break;

      case 'pair':
        setPairedSlug(el.dataset.slug);
        clearPin();
        await refreshContext();
        ctx.screen = homeScreen();
        if (ctx.screen === 'supHome') await loadScanLog();
        render();
        break;

      case 'supervisor':
        await enterSupervisor();
        break;

      case 'supervisor-signin':
        dispose();
        navigate(`/login?next=${encodeURIComponent('/gate-app?sup=1')}`);
        break;

      case 'pin-key':
        await handlePinKey(el.dataset.key);
        break;

      case 'tab':
        ctx.supTab = el.dataset.tab;
        render();
        if (ctx.supTab === 'home' || ctx.supTab === 'log') {
          await loadScanLog();
          render();
        }
        break;

      case 'return-gate':
        setMode(MODE_GUARD);
        ctx.mode = MODE_GUARD;
        ctx.screen = 'guardHome';
        await refreshContext();
        render();
        break;

      default:
        break;
    }
  }

  // ---- boot

  container.innerHTML = `<div class="gate-app"><div class="gate-booting">Starting gate…</div></div>`;
  await refreshSession();
  await refreshContext();

  // ?sup=1 is how the login page hands control back after a supervisor signs
  // in (see enterSupervisor above). Landing straight in supervisor mode is
  // the whole reason they signed in; asking for a PIN first would be asking
  // twice. Setting a PIN, if there isn't one, is the one thing still worth
  // stopping for — it's what makes the NEXT unlock fast.
  if (query?.get('sup') === '1' && ctx.session) {
    if (hasPin()) {
      await openSupervisorHome();
    } else {
      ctx.pin = '';
      ctx.screen = 'setPin';
      render();
    }
    return;
  }

  ctx.screen = homeScreen();
  render();
  if (ctx.screen === 'supHome') {
    await loadScanLog();
    render();
  }
}
