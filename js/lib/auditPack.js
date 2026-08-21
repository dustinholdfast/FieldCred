// Site audit pack — a printable/PDF-able compliance report for a date range.
// Roadmap: "never fail a site audit" — the data already exists across four
// screens (roster, cert statuses, verification stamps, gate scan log); this
// assembles it into one document an auditor or GC can actually receive.
//
// Pure and deterministic given `today`/`generatedAt` — see
// tests/auditPack.test.mjs. Reuses evaluateClearance (clearance.js) for the
// cleared/missing/expiring determination rather than re-deriving it — that
// logic is fail-closed and unit-tested; this module only adds the per-cert
// display details (expiry, card #, verification stamp) on top of it.
//
// Print pattern matches js/lib/badgeCards.js: build an HTML string, write it
// into a new window opened by the caller, print from the opener. No PDF
// library — "PDF" is the browser's print-to-PDF. This module never touches
// `window`/`document` itself, so it stays testable under plain Node.

import { escapeHtml, formatDate, formatDateTime } from './format.js';
import { certStatus, statusLabel, STATUS_META, RENEWAL_WINDOW_DAYS } from './status.js';
import { evaluateClearance } from './clearance.js';
import { verificationStampText } from './verification.js';

// Scan-result labels — mirrors js/pages/siteScanLog.js's RESULT_META (kept as
// a small separate copy rather than a shared import: that file's version is
// paired with app-CSS pill classes that don't exist in this bare print doc).
const RESULT_LABEL = {
  cleared: 'Cleared',
  blocked: 'Blocked',
  no_requirements: 'No requirements',
  unknown_worker: 'Unrecognized badge',
  unknown_site: 'Unrecognized gate',
};

// Same "valid beats expiring beats nothing" precedence as evaluateClearance's
// internal loop, but returns the winning cert itself (not just a status) so
// the report can show its expiry/card number/verification stamp. Kept in
// exact lockstep with clearance.js's loop so a type's displayed status here
// can never disagree with whether evaluateClearance called it met.
function bestCertForType(certs, typeId, windowDays, today) {
  let best = null;
  for (const c of certs) {
    if (!c.typeId || c.typeId !== typeId) continue;
    const s = certStatus(c.expiryDate, windowDays, today);
    if (s === 'valid') return c;
    if (s === 'expiring') best = c;
  }
  return best;
}

// Per-worker report row: overall clearance plus, for each required type, the
// status and the actual cert backing it (null when missing) — and any certs
// on file that don't map to a required type ("other credentials on file").
function computeWorkerRow(worker, requiredTypes, windowDays, today) {
  const requiredTypeIds = requiredTypes.map((t) => t.id);
  const clearance = evaluateClearance(worker, requiredTypeIds, windowDays, today);
  const certs = worker.certifications || [];

  const requiredRows = requiredTypes.map((t) => {
    const status = clearance.missingTypeIds.includes(t.id)
      ? 'missing'
      : clearance.expiringTypeIds.includes(t.id)
        ? 'expiring'
        : 'valid';
    const cert = status === 'missing' ? null : bestCertForType(certs, t.id, windowDays, today);
    return { typeId: t.id, typeName: t.name, status, cert };
  });

  const otherCerts = certs.filter((c) => !c.typeId || !requiredTypeIds.includes(c.typeId));

  return { worker, clearance, requiredRows, otherCerts };
}

// Roll-up used both in the report's summary line and independently testable
// without scraping the HTML string.
export function auditPackSummary(rows) {
  const total = rows.length;
  const fullyCleared = rows.filter((r) => r.clearance.cleared).length;
  return { total, fullyCleared, withGaps: total - fullyCleared };
}

// For an actual cert's own status (valid/expiring/expired/missing-expiry-date)
// — used in the "other credentials on file" section. Reuses status.js's
// labels/colors directly since this is exactly the concept STATUS_META models.
function certStatusPillHtml(status) {
  const meta = STATUS_META[status];
  return `<span class="ap-pill" style="color:${meta.text};background:${meta.bg};">${escapeHtml(statusLabel(status))}</span>`;
}

// For a required-type row's status: valid/expiring (a cert of that type covers
// it) or 'missing' meaning no cert of this type meets the requirement at all.
// Deliberately NOT the same thing as a cert's own certStatus() 'missing' (that
// means "cert on file with no expiry date entered") — reusing STATUS_META's
// 'missing' here would mislabel this row "No date" when the real story is
// "no cert of this type exists," so this gets its own small label/color map.
const REQUIRED_ROW_META = {
  valid: STATUS_META.valid,
  expiring: STATUS_META.expiring,
  missing: STATUS_META.expired,
};
const REQUIRED_ROW_LABEL = { valid: 'Valid', expiring: 'Expiring', missing: 'Missing' };
function requiredStatusPillHtml(status) {
  const meta = REQUIRED_ROW_META[status];
  return `<span class="ap-pill" style="color:${meta.text};background:${meta.bg};">${escapeHtml(REQUIRED_ROW_LABEL[status])}</span>`;
}

function workerBlockHtml(row) {
  const { worker, clearance, requiredRows, otherCerts } = row;
  const overall = clearance.cleared
    ? `<span class="ap-pill" style="color:${STATUS_META.valid.text};background:${STATUS_META.valid.bg};">Cleared</span>`
    : `<span class="ap-pill" style="color:${STATUS_META.expired.text};background:${STATUS_META.expired.bg};">Blocked</span>`;

  const reqRowsHtml = requiredRows.length
    ? requiredRows
        .map((r) => {
          const stamp = r.cert ? verificationStampText(r.cert) : null;
          return `
        <tr>
          <td>${escapeHtml(r.typeName)}</td>
          <td>${requiredStatusPillHtml(r.status)}</td>
          <td>${r.cert ? escapeHtml(formatDate(r.cert.expiryDate, { withDay: true })) : '—'}</td>
          <td>${r.cert && r.cert.cardNumber ? escapeHtml(r.cert.cardNumber) : '—'}</td>
          <td>${stamp ? escapeHtml(stamp) : '—'}</td>
        </tr>`;
        })
        .join('')
    : `<tr><td colspan="5" class="ap-muted">No credential types are required at this site.</td></tr>`;

  const otherHtml = otherCerts.length
    ? `
      <div class="ap-other">
        <div class="ap-other-title">Other credentials on file</div>
        <table class="ap-table">
          <thead><tr><th>Name</th><th>Status</th><th>Expiry</th><th>Card #</th><th>Verification</th></tr></thead>
          <tbody>
            ${otherCerts
              .map((c) => {
                const status = certStatus(c.expiryDate);
                const stamp = verificationStampText(c);
                return `
              <tr>
                <td>${escapeHtml(c.name || '(untitled)')}${c.issuer ? ` <span class="ap-muted">· ${escapeHtml(c.issuer)}</span>` : ''}</td>
                <td>${certStatusPillHtml(status)}</td>
                <td>${escapeHtml(formatDate(c.expiryDate, { withDay: true }))}</td>
                <td>${c.cardNumber ? escapeHtml(c.cardNumber) : '—'}</td>
                <td>${stamp ? escapeHtml(stamp) : '—'}</td>
              </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>`
    : '';

  return `
    <div class="ap-worker">
      <div class="ap-worker-head">
        <div class="ap-worker-name">${escapeHtml(worker.name)}${worker.title ? ` <span class="ap-muted">· ${escapeHtml(worker.title)}</span>` : ''}</div>
        ${overall}
      </div>
      <table class="ap-table">
        <thead><tr><th>Required type</th><th>Status</th><th>Expiry</th><th>Card #</th><th>Verification</th></tr></thead>
        <tbody>${reqRowsHtml}</tbody>
      </table>
      ${otherHtml}
    </div>`;
}

function scanRowHtml(scan) {
  const who = scan.workerName || scan.workerSlug || 'unknown';
  const missing = scan.missingTypes && scan.missingTypes.length
    ? scan.missingTypes.map((t) => escapeHtml(t.name)).join(', ')
    : '';
  return `
    <tr>
      <td>${escapeHtml(formatDateTime(scan.scannedAt))}</td>
      <td>${escapeHtml(who)}</td>
      <td>${escapeHtml(RESULT_LABEL[scan.result] || scan.result)}</td>
      <td class="ap-muted">${missing ? `Missing: ${missing}` : ''}</td>
    </tr>`;
}

export function buildAuditPackHtml({
  tenant = {},
  site,
  requiredTypes = [],
  workers = [],
  scans = [],
  range,
  generatedAt,
  windowDays = RENEWAL_WINDOW_DAYS,
  today = new Date(),
}) {
  const rows = workers.map((w) => computeWorkerRow(w, requiredTypes, windowDays, today));
  const summary = auditPackSummary(rows);
  const clearedScans = scans.filter((s) => s.result === 'cleared').length;
  const blockedScans = scans.filter((s) => s.result === 'blocked').length;

  const title = `${site.name} — audit pack`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: #f5f6f8; font-family: 'Segoe UI', system-ui, sans-serif; color: #1c2430; }
  .ap-cover { border: 1.5px solid #0f2148; border-radius: 12px; padding: 22px 24px; background: #fff; margin-bottom: 20px; }
  .ap-cover-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .ap-tenant { display: flex; align-items: center; gap: 10px; }
  .ap-tenant img { height: 34px; max-width: 140px; object-fit: contain; }
  .ap-tenant-name { font-size: 13px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #5b6472; }
  .ap-title { font-size: 21px; font-weight: 700; margin-top: 10px; }
  .ap-subline { font-size: 13px; color: #5b6472; margin-top: 4px; }
  .ap-generated { font-size: 11.5px; color: #8a919e; margin-top: 10px; }
  .ap-summary { margin-top: 16px; font-size: 14px; font-weight: 600; padding-top: 14px; border-top: 1px solid #e5e8ec; }
  .ap-summary .ap-gap { color: #b23a2e; }
  .ap-req-list { font-size: 12.5px; color: #5b6472; margin-top: 6px; }
  h2.ap-section { font-size: 15px; margin: 22px 0 10px; }
  .ap-worker { background: #fff; border: 1px solid #dfe3e8; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; break-inside: avoid; }
  .ap-worker-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .ap-worker-name { font-size: 14.5px; font-weight: 700; }
  .ap-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .ap-table th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; color: #8a919e; font-weight: 700; padding: 4px 6px; border-bottom: 1px solid #e5e8ec; }
  .ap-table td { padding: 5px 6px; border-bottom: 1px solid #f0f2f4; vertical-align: top; }
  .ap-other { margin-top: 10px; }
  .ap-other-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #8a919e; margin-bottom: 4px; }
  .ap-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .ap-muted { color: #8a919e; }
  .ap-scan-summary { font-size: 12px; color: #5b6472; margin-bottom: 8px; }
  @media print {
    body { background: #fff; padding: 0.4in; }
    .ap-worker { break-inside: avoid; }
  }
</style></head><body>
  <div class="ap-cover">
    <div class="ap-cover-top">
      <div class="ap-tenant">
        ${tenant.logoUrl ? `<img src="${escapeHtml(tenant.logoUrl)}" alt="">` : ''}
        <div class="ap-tenant-name">${escapeHtml(tenant.name || '')}</div>
      </div>
    </div>
    <div class="ap-title">${escapeHtml(site.name)} — Audit pack</div>
    <div class="ap-subline">${escapeHtml(site.location || '')}${site.location ? ' · ' : ''}${range ? `${escapeHtml(formatDate(range.from, { withDay: true }))} – ${escapeHtml(formatDate(range.to, { withDay: true }))}` : ''}</div>
    <div class="ap-generated">Generated ${escapeHtml(formatDateTime(generatedAt))} — status reflects credential data as of this moment; a report generated earlier may no longer match today.</div>
    <div class="ap-req-list">Required credential types: ${requiredTypes.length ? requiredTypes.map((t) => escapeHtml(t.name)).join(', ') : 'none set'}</div>
    <div class="ap-summary">${summary.total} worker${summary.total === 1 ? '' : 's'}, ${summary.fullyCleared} fully cleared, <span class="${summary.withGaps ? 'ap-gap' : ''}">${summary.withGaps} with gap${summary.withGaps === 1 ? '' : 's'}</span></div>
  </div>

  <h2 class="ap-section">Roster</h2>
  ${rows.length ? rows.map(workerBlockHtml).join('') : '<div class="ap-muted">No workers assigned to this site.</div>'}

  <h2 class="ap-section">Gate scan history</h2>
  <div class="ap-scan-summary">${scans.length ? `${scans.length} scan${scans.length === 1 ? '' : 's'} · ${clearedScans} cleared · ${blockedScans} blocked` : 'No scans logged in this range.'}</div>
  ${
    scans.length
      ? `<table class="ap-table"><thead><tr><th>Time</th><th>Worker</th><th>Result</th><th>Detail</th></tr></thead><tbody>${scans.map(scanRowHtml).join('')}</tbody></table>`
      : ''
  }
</body></html>`;
}
