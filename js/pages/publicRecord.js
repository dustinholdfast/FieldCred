import { navigate } from '../lib/router.js';
import { escapeHtml, formatDate, formatDateTime } from '../lib/format.js';
import { publicCertCardHtml } from '../components/certCard.js';
import { summarizeCertStatuses } from '../lib/status.js';
import { deriveVerdict, logGateScan, resolveSite, resolveWorker, VERDICT } from '../lib/gateVerdict.js';
import { shieldLogo, logoImage } from '../components/logo.js';
import { avatarHtml } from '../components/avatar.js';
import { tenantName, tenantLogoUrl, tenantSlug } from '../lib/supabaseClient.js';
import { isStale } from '../lib/offlineCache.js';

// Offline fallback banner — shown when this record or the gate site came
// from the local cache (js/lib/offlineCache.js) instead of a live fetch.
// Scope note lives in offlineCache.js: this only ever has cached data for a
// worker/site this device has actually seen while online before.
function offlineBannerHtml(label, cachedAt) {
  const stale = isStale(cachedAt);
  const when = cachedAt ? formatDateTime(cachedAt) : 'an earlier visit';
  return `<div style="padding:12px 16px;border-radius:12px;margin-bottom:14px;background:#fdf3e0;border-left:5px solid #c98a12;color:#5b4a10;font-size:12.5px;">
    <strong>Offline — ${escapeHtml(label)} from ${escapeHtml(when)}.</strong>
    ${stale ? ' That\'s over 24 hours old — confirm another way if you can.' : ' May not reflect changes made since.'}
  </div>`;
}

// Which site this device checks against, if configured via /gate/:slug. Kept in
// localStorage so a gate tablet is set once (by scanning the site's QR) and
// then every worker scan shows clearance for that site.
const GATE_KEY = 'fieldcred_gate_site';

// Renders a verdict from js/lib/gateVerdict.js. That module — not this page —
// decides cleared vs not, and the companion gate app (js/pages/gateApp.js)
// renders the same verdict object as a full-screen poster. Keeping one
// decision behind two presentations is the whole point: a banner here and a
// poster there that disagreed about the same worker would be worse than
// either one alone.
function gateBannerHtml(verdict, site) {
  const list = (items) => items.map((m) => escapeHtml(m.typeName)).join(', ');

  if (verdict.kind === VERDICT.NO_REQUIREMENTS) {
    return `<div class="gate-verdict gate-verdict-neutral">
      <div class="gate-verdict-icon">—</div>
      <div><div class="gate-verdict-label mono">SITE CHECK</div><div class="gate-verdict-title">No requirements set</div>
      <div class="gate-verdict-detail">${escapeHtml(site.name)} has no credential requirements yet.</div></div>
    </div>`;
  }

  if (verdict.kind === VERDICT.CLEARED) {
    const detail = verdict.expiring.length
      ? `<div class="gate-verdict-detail gate-verdict-warn">Renew soon: ${verdict.expiring.map(escapeHtml).join(', ')}</div>`
      : '<div class="gate-verdict-detail">All required credentials are current.</div>';
    return `<div class="gate-verdict gate-verdict-clear" role="status">
      <div class="gate-verdict-icon">✓</div>
      <div><div class="gate-verdict-label mono">CLEARED FOR ENTRY</div><div class="gate-verdict-title">${escapeHtml(site.name)}</div>
      ${detail}</div>
    </div>`;
  }

  return `<div class="gate-verdict gate-verdict-block" role="alert">
    <div class="gate-verdict-icon">×</div>
    <div><div class="gate-verdict-label mono">DO NOT ADMIT</div><div class="gate-verdict-title">Not cleared for ${escapeHtml(site.name)}</div>
    <div class="gate-verdict-detail">Missing or expired: ${list(verdict.missing)}</div></div>
  </div>`;
}

// An honest at-a-glance summary for the person scanning the QR — a safety
// auditor is exactly who must not be shown a blanket "Verified" when certs
// on the same record are expired. Leads with the worst status present.
function statusPillsHtml(summary) {
  const pills = [];
  if (summary.expired) pills.push(`<span class="pill status-expired"><span class="pill-dot"></span>${summary.expired} expired</span>`);
  if (summary.expiring) pills.push(`<span class="pill status-expiring"><span class="pill-dot"></span>${summary.expiring} expiring</span>`);
  if (summary.missing) pills.push(`<span class="pill status-missing"><span class="pill-dot"></span>${summary.missing} no date</span>`);
  if (summary.valid) pills.push(`<span class="pill status-valid"><span class="pill-dot"></span>${summary.valid} valid</span>`);
  if (!pills.length) pills.push(`<span class="pill status-expiring"><span class="pill-dot"></span>No certifications on file</span>`);
  return `<div class="pill-row public-status-row">${pills.join('')}</div>`;
}

// vCard (RFC 6350) text-value escaping: backslash first, then comma,
// semicolon, and newline. Without this, a worker name/title/department
// containing any of those characters doesn't just render oddly — a comma or
// semicolon is a field/component separator in the vCard grammar, so it can
// corrupt the FN/TITLE/ORG line it's in, and an embedded newline can
// terminate the current line early and inject fabricated vCard lines
// (including a second BEGIN:VCARD) that the importing contacts app reads as
// legitimate. All three fields below are admin/safety-entered free text, not
// something this app can otherwise constrain, so the download path has to
// escape rather than trust the input is clean.
function escapeVCardText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function downloadVCard(w) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${escapeVCardText(w.name)}`,
    `TITLE:${escapeVCardText(w.title)}`,
    w.department ? `ORG:${escapeVCardText(w.department)}` : '',
    `NOTE:FieldCred record — ${location.origin}${location.pathname}?tenant=${encodeURIComponent(tenantSlug)}#/r/${w.publicSlug}`,
    'END:VCARD',
  ].filter(Boolean);
  const blob = new Blob([lines.join('\n')], { type: 'text/vcard' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${w.publicSlug}.vcf`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function renderPublicRecord(container, params, query) {
  container.innerHTML = `<div class="public-page"><div class="public-unavailable">Loading…</div></div>`;

  // resolveWorker() owns the live-fetch / offline-cache fallback and the
  // "no such worker" vs "no signal" distinction — see js/lib/gateVerdict.js.
  // Both are needed here: the first is fail-closed, the second is a reason to
  // reach for the cache rather than give up.
  const resolved = await resolveWorker(params.slug);
  const w = resolved.worker;
  const workerOffline = resolved.fromCache;
  const workerCachedAt = resolved.cachedAt;
  const noSignal = resolved.noSignal;

  // A row coming back at all (live or cached) means it was meant to be
  // visible — no separate flag check needed here.
  if (!w) {
    container.innerHTML = `
      <div class="public-page">
        <div class="public-unavailable">
          <div>
            <div style="width:24px;margin:0 auto 12px;">${shieldLogo()}</div>
            <div style="font-weight:600;margin-bottom:4px;">This record isn't available</div>
            <div style="font-size:13px;">
              ${
                noSignal
                  ? "No signal, and this device hasn't cached this worker before — connect once online, then this record works offline too."
                  : 'The link may have expired, been turned off, or removed.'
              }
            </div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // Gate context: a ?site=<slug> in the link sets (and remembers) which site
  // this device checks against; otherwise fall back to whatever was stored by
  // a prior /gate/:slug scan. Fail-closed — an unknown slug shows a notice, not
  // a clearance.
  let gateSlug = query?.get('site') || null;
  if (gateSlug) {
    try { localStorage.setItem(GATE_KEY, gateSlug); } catch {}
  } else {
    try { gateSlug = localStorage.getItem(GATE_KEY); } catch {}
  }
  let gateHtml = '';
  let gateActive = false;
  let siteOffline = false;
  let siteCachedAt = null;
  if (gateSlug) {
    gateActive = true;
    const resolvedSite = await resolveSite(gateSlug);
    const site = resolvedSite.site;
    siteOffline = resolvedSite.fromCache;
    siteCachedAt = resolvedSite.cachedAt;

    gateHtml = site
      ? gateBannerHtml(deriveVerdict(w, site), site)
      : `<div class="gate-verdict gate-verdict-neutral"><div class="gate-verdict-icon">?</div><div><div class="gate-verdict-label mono">SITE CHECK UNAVAILABLE</div><div class="gate-verdict-title">Site not recognized</div><div class="gate-verdict-detail">It may be inactive or has not been cached on this device.</div></div></div>`;
    if (site && (workerOffline || siteOffline)) {
      // Whichever piece came from cache — worker, site, or both — drives one
      // combined banner rather than showing it twice; the older of the two
      // timestamps is the honest "as of" bound for what's on screen.
      const cachedAt = [workerCachedAt, siteCachedAt].filter(Boolean).sort()[0] || null;
      gateHtml = offlineBannerHtml('cleared against cached data', cachedAt) + gateHtml;
    }

    // Audit log (roadmap point 4): log this scan server-side, keyed only off
    // the slugs already resolved above — the RPC re-derives clearance itself
    // rather than trusting anything computed here. logGateScan() falls back to
    // the local queue when that fails (most likely: no signal), which
    // js/lib/offlineSync.js drains once the device is back online, so the
    // audit log doesn't silently lose gate activity. Deliberately not awaited
    // — the record renders whether or not the logging round trip lands.
    logGateScan(gateSlug, params.slug);
  } else if (workerOffline) {
    // No gate configured on this device, but the worker record itself came
    // from cache (e.g. scanning a worker's own QR directly) — still worth
    // flagging, just without the "cleared against" framing that only makes
    // sense in a gate context.
    gateHtml = offlineBannerHtml('showing cached record', workerCachedAt);
  } else {
    // Deliberately subtle, not a colored banner — most visits to this page
    // are just someone viewing/sharing a worker's own record and have
    // nothing to do with a gate, so this shouldn't read as an error state
    // for them. It exists for the other case: someone AT a gate expecting a
    // clearance banner, who hasn't realized this device was never pointed
    // at that site (found via Dustin's real support case, 2026-07-17 — no
    // banner showed for ANY worker, compliant or not, because the site's
    // own gate link was never opened on that device first).
    gateHtml = `<div style="text-align:center;margin-bottom:14px;font-size:11px;color:var(--text-muted-2);letter-spacing:0.02em;">Not checking against a site — open a site's gate link on this device to enable clearance checks.</div>`;
  }

  const summary = summarizeCertStatuses(w.certifications);
  const freshness = w.updatedAt ? `Record updated ${formatDate(w.updatedAt.slice(0, 10), { withDay: true })}` : '';

  // Arrived here from the in-app scanner (js/pages/scan.js). Without a way
  // back to the camera the guard has to find the scanner again by hand
  // between every worker in the queue, which defeats the point of it.
  const fromScan = query?.get('from') === 'scan';

  container.innerHTML = `
    <div class="public-page">
      ${gateHtml}
      ${gateActive ? `<div class="gate-context-actions"><button id="gate-clear">Change gate site</button></div>` : ''}
      <div class="public-header">
        <div class="public-brand">${logoImage({ width: 120 })}</div>
        ${tenantLogoUrl ? `<img src="${escapeHtml(tenantLogoUrl)}" alt="${escapeHtml(tenantName || '')}" class="public-tenant-logo">` : ''}
        ${tenantName ? `<div class="public-tenant-name">${escapeHtml(tenantName)}</div>` : ''}
        ${avatarHtml(w.name, w.photoUrl, { className: 'photo-placeholder public-photo' })}
        <div class="public-name">${escapeHtml(w.name)}</div>
        <div class="public-title">${escapeHtml(w.title)}</div>
        ${statusPillsHtml(summary)}
        ${freshness ? `<div class="public-freshness mono">${escapeHtml(freshness)}</div>` : ''}
      </div>

      <div class="public-body">
        <div class="public-facts">
          <div class="public-fact-card"><div class="public-fact-label mono">DEPARTMENT</div><div class="public-fact-value">${escapeHtml(w.department || '—')}</div></div>
          <div class="public-fact-card"><div class="public-fact-label mono">LOCATION</div><div class="public-fact-value">${escapeHtml(w.location || '—')}</div></div>
        </div>
        <div class="public-certs-heading">CERTIFICATIONS</div>
        ${w.certifications.length ? w.certifications.map(publicCertCardHtml).join('') : '<div class="empty-state">No certifications on file.</div>'}
      </div>

      <div class="public-footer">
        ${
          fromScan
            ? `<div class="scan-again-row">
                 <button class="btn btn-neutral-outline" id="public-save-contact">Save contact</button>
                 <button class="btn btn-primary" id="public-scan-again">Scan another</button>
               </div>`
            : `<button class="btn btn-primary btn-block" id="public-save-contact">Save contact</button>`
        }
      </div>
    </div>
  `;

  container.querySelector('#public-save-contact').addEventListener('click', () => downloadVCard(w));

  const scanAgain = container.querySelector('#public-scan-again');
  if (scanAgain) {
    scanAgain.addEventListener('click', () => navigate('/scan'));
  }

  const gateClear = container.querySelector('#gate-clear');
  if (gateClear) {
    gateClear.addEventListener('click', () => {
      try { localStorage.removeItem(GATE_KEY); } catch {}
      // Preserve from=scan across the re-render — clearing the gate site
      // shouldn't also strip the guard's way back to the camera.
      renderPublicRecord(container, params, new URLSearchParams(fromScan ? 'from=scan' : ''));
    });
  }
}
