import { escapeHtml } from '../lib/format.js';
import { keepFocusInside, focusFirst } from '../lib/focusTrap.js';

// In-app confirm modal — used instead of window.confirm(), which is
// unreliable in embedded/headless/preview browser contexts.
export function openConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');

    root.innerHTML = `
      <div class="modal-overlay" id="confirm-overlay">
        <div class="share-modal" style="width:400px;" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <div class="share-modal-header">
            <div><h2>${escapeHtml(title)}</h2></div>
          </div>
          <div style="padding:20px 22px;">
            <div style="font-size:13.5px;color:var(--text-secondary-2);line-height:1.5;">${escapeHtml(message)}</div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
              <button class="btn btn-neutral-outline" id="confirm-cancel">${escapeHtml(cancelLabel)}</button>
              <button class="btn ${danger ? 'btn-danger-outline' : 'btn-primary'}" id="confirm-ok">${escapeHtml(confirmLabel)}</button>
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
        close(false);
        return;
      }
      keepFocusInside(e, root.querySelector('.share-modal'));
    }

    root.querySelector('#confirm-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'confirm-overlay') close(false);
    });
    root.querySelector('#confirm-cancel').addEventListener('click', () => close(false));
    root.querySelector('#confirm-ok').addEventListener('click', () => close(true));
    document.addEventListener('keydown', onKeydown);
    focusFirst(root.querySelector('.share-modal'));
  });
}
