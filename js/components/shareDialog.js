import { icons } from '../lib/icons.js';
import { escapeHtml, formatDate } from '../lib/format.js';
import { store } from '../lib/state.js';
import { showToast } from './toast.js';
import { tenantSlug } from '../lib/supabaseClient.js';
import { keepFocusInside, focusFirst } from '../lib/focusTrap.js';
import { workerRecordUrl } from '../lib/publicLinks.js';
import { qrNodeDataUrl } from '../lib/qrImage.js';

// link_expires is stored as the literal 'never' or an ISO 'YYYY-MM-DD' date.
function expiryDisplay(value) {
  return !value || value === 'never' ? 'never' : formatDate(value, { withDay: true });
}

// Today + N days as a 'YYYY-MM-DD' string (local date, no time component).
function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export async function openShareDialog(workerId) {
  const root = document.getElementById('modal-root');

  let worker;
  try {
    worker = await store.getById(workerId);
  } catch (err) {
    showToast(`Couldn't load record: ${err.message}`);
    return;
  }
  if (!worker) return;

  function render(w) {
    const url = workerRecordUrl({ slug: w.publicSlug, tenant: tenantSlug });

    root.innerHTML = `
      <div class="modal-overlay" id="share-overlay">
        <div class="share-modal" role="dialog" aria-modal="true" aria-label="Share this record">
          <div class="share-modal-header">
            <div>
              <h2>Share this record</h2>
              <div class="sub">${escapeHtml(w.name)} · ${escapeHtml(w.title)}</div>
            </div>
            <button type="button" class="icon-btn" id="share-close" title="Close" aria-label="Close">${icons.close}</button>
          </div>
          <div class="share-modal-body">
            <div class="qr-block">
              <div class="qr-frame"><div id="qr-target"></div></div>
              <div class="qr-caption">SCAN TO OPEN</div>
            </div>
            <div class="share-actions-col">
              <div class="field-label" style="margin-bottom:6px;">PUBLIC RECORD LINK</div>
              <div class="link-row">
                <div class="link-field" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
                <button class="btn btn-primary" id="share-copy">Copy</button>
              </div>
              <div class="share-secondary-actions">
                <button class="row-btn" id="share-download">${icons.download} Download QR (PNG)</button>
                <button class="row-btn" id="share-send">${icons.mail} Send link by email / SMS</button>
              </div>
              <div class="public-toggle-card">
                <div class="public-toggle-top">
                  <div class="public-toggle-title">Public view</div>
                  <button class="toggle ${w.publicViewEnabled ? 'on' : ''}" id="share-toggle" role="switch" aria-checked="${w.publicViewEnabled}">
                    <span class="knob"></span>
                  </button>
                </div>
                <div class="public-toggle-help">Anyone with the link sees photo, role &amp; certifications. Contact details stay hidden.</div>
              </div>
              <div class="link-expires" id="link-expires-block">LINK EXPIRES · <span class="le-value">${escapeHtml(expiryDisplay(w.linkExpires))}</span> · <span class="change-link" id="le-change">change</span></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const qrTarget = root.querySelector('#qr-target');
    qrTarget.innerHTML = '';
    // eslint-disable-next-line no-undef
    new QRCode(qrTarget, {
      text: url,
      width: 176,
      height: 176,
      colorDark: '#1c2430',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });

    root.querySelector('#share-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'share-overlay') close();
    });
    root.querySelector('#share-close').addEventListener('click', close);

    root.querySelector('#share-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Clipboard API unavailable — fall back to a manual copy affordance.
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast('Copied');
    });

    root.querySelector('#share-download').addEventListener('click', () => {
      const src = qrNodeDataUrl(qrTarget);
      if (!src) return;
      const a = document.createElement('a');
      a.href = src;
      a.download = `fieldcred-${w.publicSlug}-qr.png`;
      a.click();
    });

    root.querySelector('#share-send').addEventListener('click', () => {
      const subject = encodeURIComponent(`${w.name} — FieldCred record`);
      const body = encodeURIComponent(`Here is ${w.name}'s FieldCred record: ${url}`);
      window.location.href = `mailto:?subject=${subject}&body=${body}`;
    });

    const toggleBtn = root.querySelector('#share-toggle');
    toggleBtn.addEventListener('click', async () => {
      toggleBtn.disabled = true;
      try {
        const updated = await store.setPublicView(w.id, !w.publicViewEnabled);
        render(updated);
      } catch (err) {
        toggleBtn.disabled = false;
        showToast(`Couldn't update: ${err.message}`);
      }
    });

    // Link expiry — a real, enforced control (the public_workers view drops
    // rows whose expiry has passed), not a decorative label. Picking an
    // option persists it and re-renders; the QR still encodes the same slug,
    // so an existing printed code stops resolving once the link expires.
    root.querySelector('#le-change').addEventListener('click', () => {
      const block = root.querySelector('#link-expires-block');
      block.innerHTML = `LINK EXPIRES ·
        <select id="le-select" class="le-select">
          <option value="never" ${w.linkExpires === 'never' ? 'selected' : ''}>never</option>
          <option value="7">in 7 days</option>
          <option value="30">in 30 days</option>
          <option value="90">in 90 days</option>
        </select>
        <span class="change-link" id="le-cancel">cancel</span>`;
      const sel = block.querySelector('#le-select');
      sel.focus();
      block.querySelector('#le-cancel').addEventListener('click', () => render(w));
      sel.addEventListener('change', async () => {
        const value = sel.value === 'never' ? 'never' : addDaysISO(Number(sel.value));
        sel.disabled = true;
        try {
          const updated = await store.updateWorker(w.id, { linkExpires: value });
          render(updated);
          showToast(value === 'never' ? 'Link set to never expire' : `Link expires ${expiryDisplay(value)}`);
        } catch (err) {
          showToast(`Couldn't update: ${err.message}`);
          render(w);
        }
      });
    });
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      close();
      return;
    }
    keepFocusInside(e, root.querySelector('.share-modal'));
  }

  function close() {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKeydown);
  }

  render(worker);
  // One document-level listener for the dialog's lifetime (render() runs again
  // on each toggle/expiry change, but re-adding per render would stack them).
  document.addEventListener('keydown', onKeydown);
  focusFirst(root.querySelector('.share-modal'));
}
