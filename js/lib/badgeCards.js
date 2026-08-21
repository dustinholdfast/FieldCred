// Bulk printable QR badge cards — "Print QR badge cards for all 40 workers".
// Field crews live on physical badge cards, so this turns the directory (or
// whatever's currently filtered) into a print-ready sheet of credential cards,
// each with a QR that opens the worker's public record.
//
// Each QR is rendered into a detached node in THIS document and inlined into
// the new window as a data URI (js/lib/qrImage.js) — the print window has no
// scripts or library of its own.

import { escapeHtml } from './format.js';
import { showToast } from '../components/toast.js';
import { tenantSlug } from './supabaseClient.js';
import { workerRecordUrl } from './publicLinks.js';
import { qrDataUrl } from './qrImage.js';

function cardHtml({ w, src }, tenantName) {
  const qr = src ? `<img class="bc-qr" src="${src}" alt="QR code">` : `<div class="bc-qr bc-qr-missing">QR unavailable</div>`;
  return `
    <div class="bc-card">
      <div class="bc-info">
        ${tenantName ? `<div class="bc-tenant">${escapeHtml(tenantName)}</div>` : ''}
        <div class="bc-name">${escapeHtml(w.name)}</div>
        <div class="bc-title">${escapeHtml(w.title || '')}</div>
        ${w.department ? `<div class="bc-dept">${escapeHtml(w.department)}</div>` : ''}
        <div class="bc-scan">Scan to verify credentials</div>
      </div>
      <div class="bc-qr-wrap">${qr}</div>
    </div>`;
}

function documentHtml(cards, tenantName) {
  const title = tenantName ? `${tenantName} — credential badge cards` : 'Credential badge cards';
  // No inline <script> here — printing is triggered by the opener (see
  // printBadgeCards) so a strict script-src 'self' CSP, inherited by this
  // about:blank window, doesn't block it.
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: #f5f6f8; font-family: 'Segoe UI', system-ui, sans-serif; color: #1c2430; }
  .bc-sheet { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .bc-card {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    border: 1.5px solid #0f2148; border-radius: 12px; padding: 16px 18px;
    background: #fff; min-height: 2in; break-inside: avoid;
  }
  .bc-info { min-width: 0; }
  .bc-tenant { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #5b6472; margin-bottom: 6px; }
  .bc-name { font-size: 19px; font-weight: 700; line-height: 1.15; }
  .bc-title { font-size: 12.5px; font-weight: 600; color: #0f2148; margin-top: 3px; }
  .bc-dept { font-size: 11.5px; color: #5b6472; margin-top: 2px; }
  .bc-scan { font-size: 9.5px; letter-spacing: 0.04em; text-transform: uppercase; color: #8a919e; margin-top: 12px; }
  .bc-qr-wrap { flex-shrink: 0; }
  .bc-qr { width: 108px; height: 108px; display: block; }
  .bc-qr-missing { width: 108px; height: 108px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #b23a2e; border: 1px dashed #d8dde3; text-align: center; }
  @media print {
    body { background: #fff; padding: 0; }
    .bc-card { break-inside: avoid; }
  }
</style></head><body>
  <div class="bc-sheet">${cards.map((c) => cardHtml(c, tenantName)).join('')}</div>
</body></html>`;
}

// workers: array of worker objects (already filtered by the caller).
export async function printBadgeCards(workers, { tenantName } = {}) {
  if (!workers.length) {
    showToast('No workers to print');
    return;
  }
  // Open the window synchronously (inside the click handler) so pop-up
  // blockers don't eat it while we await QR generation.
  const win = window.open('', '_blank');
  if (!win) {
    showToast('Allow pop-ups to print badge cards');
    return;
  }
  win.document.write('<!doctype html><title>Preparing…</title><body style="font-family:system-ui;padding:40px;color:#5b6472;">Preparing badge cards…</body>');

  showToast(`Preparing ${workers.length} badge card${workers.length === 1 ? '' : 's'}…`);
  const cards = [];
  for (const w of workers) {
    // eslint-disable-next-line no-await-in-loop
    const src = await qrDataUrl(workerRecordUrl({ slug: w.publicSlug, tenant: tenantSlug }));
    cards.push({ w, src });
  }

  win.document.open();
  win.document.write(documentHtml(cards, tenantName));
  win.document.close();
  win.focus();

  // Trigger the print dialog from here (the opener) rather than an inline
  // script in the child window — QR images are inline data: URIs, so they're
  // ready almost immediately; the small delay lets layout settle first.
  const doPrint = () => setTimeout(() => win.print(), 150);
  if (win.document.readyState === 'complete') doPrint();
  else win.addEventListener('load', doPrint);
}
