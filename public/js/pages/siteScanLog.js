// Gate scan audit log for one site (roadmap point 4, "The moat"). Every scan
// at this site's gate — cleared, blocked, or a lookup that failed to resolve
// — is written server-side by record_gate_scan() (supabase/migrations/009)
// the moment it happens; this page just reads that log back. Authenticated
// only: RLS grants gate_scans SELECT to authenticated, never anon.

import { store } from '../lib/state.js';
import { escapeHtml, formatDateTime } from '../lib/format.js';
import { toCSV } from '../lib/csv.js';

const RESULT_META = {
  cleared: { label: 'Cleared', pill: 'status-valid' },
  blocked: { label: 'Blocked', pill: 'status-expired' },
  no_requirements: { label: 'No requirements', pill: 'status-missing' },
  unknown_worker: { label: 'Unrecognized badge', pill: 'status-expiring' },
  unknown_site: { label: 'Unrecognized gate', pill: 'status-expiring' },
};

function resultPillHtml(result) {
  const meta = RESULT_META[result] || { label: result, pill: 'status-missing' };
  return `<span class="pill ${meta.pill}"><span class="pill-dot"></span>${escapeHtml(meta.label)}</span>`;
}

// Same rows as the table, in CSV form — includes every scan currently
// loaded (up to store.siteScanLog's default 200/most-recent), not just what
// a filter has narrowed the table to. For a full date-ranged export, use the
// "Audit pack" button on the site page instead — this is the quick "give me
// a spreadsheet of what's on screen" export.
function scanLogCSV(scans) {
  const header = ['Time', 'Worker', 'Result', 'Missing types'];
  const rows = scans.map((scan) => [
    formatDateTime(scan.scannedAt),
    scan.workerName || scan.workerSlug || 'Unknown',
    (RESULT_META[scan.result] || { label: scan.result }).label,
    scan.missingTypes.map((t) => t.name).join('; '),
  ]);
  return toCSV(header, rows);
}

function rowHtml(scan) {
  const who = scan.workerName
    ? escapeHtml(scan.workerName)
    : `<span style="color:var(--text-muted);">${scan.workerSlug ? escapeHtml(scan.workerSlug) : 'unknown'}</span>`;
  const missing = scan.missingTypes.length
    ? `<span style="color:var(--expired-text);">Missing: ${scan.missingTypes.map((t) => escapeHtml(t.name)).join(', ')}</span>`
    : '';
  return `
    <div class="table-row" style="grid-template-columns:1.3fr 1.4fr 1fr 1.6fr;">
      <div class="mono" style="font-size:12px;color:var(--text-secondary);align-self:center;">${escapeHtml(formatDateTime(scan.scannedAt))}</div>
      <div style="align-self:center;font-size:13px;font-weight:600;">${who}</div>
      <div class="table-status" style="align-self:center;">${resultPillHtml(scan.result)}</div>
      <div style="align-self:center;font-size:12px;">${missing}</div>
    </div>`;
}

export async function renderSiteScanLog(container, params) {
  container.innerHTML = `<div class="empty-state">Loading scan log…</div>`;

  let site, scans;
  try {
    site = await store.getSite(params.id);
    if (!site) {
      container.innerHTML = `<div class="empty-state">Site not found. <a href="#/sites">Back to sites</a></div>`;
      return;
    }
    scans = await store.siteScanLog(site.id);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Couldn't load the scan log: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const clearedCount = scans.filter((s) => s.result === 'cleared').length;
  const blockedCount = scans.filter((s) => s.result === 'blocked').length;

  container.innerHTML = `
    <div class="directory-header">
      <div>
        <div class="directory-title">${escapeHtml(site.name)} — Scan log</div>
        <div class="directory-subline"><a href="#/sites">Sites</a> · <a href="#/site/${escapeHtml(site.id)}">${escapeHtml(site.name)}</a></div>
      </div>
    </div>

    <div class="admin-card admin-card-body">
      <div class="admin-card-header">
        <h3>Every gate scan, timestamped</h3>
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="font-size:12px;color:var(--text-muted);">
            ${scans.length ? `${scans.length} shown · ${clearedCount} cleared · ${blockedCount} blocked` : ''}
          </div>
          ${scans.length ? `<a href="#" id="scan-log-export">Export CSV</a>` : ''}
        </div>
      </div>
      ${
        scans.length
          ? `
        <div class="table-row" style="grid-template-columns:1.3fr 1.4fr 1fr 1.6fr;font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--text-muted);border-top:none;padding-bottom:8px;">
          <div>Time</div><div>Worker</div><div>Result</div><div>Detail</div>
        </div>
        ${scans.map(rowHtml).join('')}
      `
          : `<div class="empty-state" style="padding:10px;">No scans logged yet at this gate.</div>`
      }
    </div>
  `;

  container.querySelector('#scan-log-export')?.addEventListener('click', (e) => {
    e.preventDefault();
    const blob = new Blob([scanLogCSV(scans)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fieldcred-${site.publicSlug || 'site'}-scan-log.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
}
