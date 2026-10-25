// Date-range picker for the "Download audit pack" action on the site detail
// page. Modeled on confirmDialog.js's structure (modal-root, focus trap) —
// shareDialog.js's QR/toggle machinery doesn't apply here.
//
// Opens the print window itself, synchronously inside the "Generate" click
// handler, and hands the window reference back to the caller along with the
// chosen range. This mirrors js/lib/badgeCards.js's documented reasoning:
// window.open() has to happen inside a real user-gesture click handler or
// pop-up blockers can eat it, and the caller (siteDetail.js) needs to run a
// few async store calls (tenant settings, fresh roster/requirements, scan
// log) before it has HTML to write — by the time those awaits resolve, the
// "Generate" click is no longer the current call stack, so opening the
// window has to happen before the awaits, not after.
import { escapeHtml } from '../lib/format.js';
import { keepFocusInside, focusFirst } from '../lib/focusTrap.js';

function isoDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Resolves to { from, to, win } on Generate ('win' is the pre-opened print
// window, or null if a pop-up blocker ate it) or null on cancel/escape.
export function openAuditPackDialog() {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const today = new Date();
    const defaultFrom = isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30));
    const defaultTo = isoDate(today);

    root.innerHTML = `
      <div class="modal-overlay" id="audit-overlay">
        <div class="share-modal" style="width:400px;" role="dialog" aria-modal="true" aria-label="Download audit pack">
          <div class="share-modal-header">
            <div>
              <h2>Download audit pack</h2>
              <div class="sub">Choose the date range for the scan history.</div>
            </div>
          </div>
          <div style="padding:20px 22px;">
            <div style="display:flex;gap:12px;">
              <div class="field" style="flex:1;">
                <label class="field-label">FROM</label>
                <input type="date" id="audit-from" value="${escapeHtml(defaultFrom)}" max="${escapeHtml(defaultTo)}">
              </div>
              <div class="field" style="flex:1;">
                <label class="field-label">TO</label>
                <input type="date" id="audit-to" value="${escapeHtml(defaultTo)}" max="${escapeHtml(defaultTo)}">
              </div>
            </div>
            <div id="audit-error" style="color:var(--expired-text);font-size:12.5px;margin-top:8px;display:none;"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
              <button class="btn btn-neutral-outline" id="audit-cancel">Cancel</button>
              <button class="btn btn-primary" id="audit-generate">Generate</button>
            </div>
          </div>
        </div>
      </div>
    `;

    function close(result) {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') {
        close(null);
        return;
      }
      keepFocusInside(e, root.querySelector('.share-modal'));
    }

    root.querySelector('#audit-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'audit-overlay') close(null);
    });
    root.querySelector('#audit-cancel').addEventListener('click', () => close(null));
    root.querySelector('#audit-generate').addEventListener('click', () => {
      const from = root.querySelector('#audit-from').value;
      const to = root.querySelector('#audit-to').value;
      const errEl = root.querySelector('#audit-error');
      if (!from || !to) {
        errEl.textContent = 'Pick both dates.';
        errEl.style.display = 'block';
        return;
      }
      if (from > to) {
        errEl.textContent = '"From" must be on or before "To".';
        errEl.style.display = 'block';
        return;
      }
      // Synchronous, inside this click handler — see file header.
      const win = window.open('', '_blank');
      if (win) win.document.write('<!doctype html><title>Preparing…</title><body style="font-family:system-ui;padding:40px;color:#5b6472;">Preparing audit pack…</body>');
      close({ from, to, win });
    });
    document.addEventListener('keydown', onKeydown);
    focusFirst(root.querySelector('.share-modal'));
  });
}
