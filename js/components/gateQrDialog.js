// Gate QR for one site — opened from the site page (js/pages/siteDetail.js).
//
// The gate link has always been on that page as a text field with a note
// saying "post as a QR at the gate", which left the actual QR as an exercise
// for whoever was setting up the site. This is that step: the code on screen,
// a PNG to send to whoever prints things, and a print-ready sign to tape up at
// the gate itself.
//
// Scanning it with a plain phone camera opens #/gate/:slug, which remembers
// the site on that device (js/pages/gateConfig.js). Scanning it from inside
// the FieldCred Gate app pairs the kiosk to the site (js/pages/gateApp.js).
// One code, both paths — see gateLinkUrl() in js/lib/publicLinks.js.
//
// Deliberately says nothing about the site's required credentials. Those are
// live server state, they change without anyone reprinting a sign, and the
// requirement checkboxes on the site page may be mid-edit and unsaved when
// this opens. The sign's whole job is pairing; the requirements are read at
// scan time, every time.

import { icons } from '../lib/icons.js';
import { escapeHtml } from '../lib/format.js';
import { showToast } from './toast.js';
import { keepFocusInside, focusFirst } from '../lib/focusTrap.js';
import { qrDataUrl, qrNodeDataUrl } from '../lib/qrImage.js';

const QR_INK = '#0f2148';

function signHtml({ siteName, location: siteLocation, tenantName, url, qrSrc }) {
  const qr = qrSrc
    ? `<img class="gs-qr" src="${qrSrc}" alt="Gate QR code">`
    : `<div class="gs-qr gs-qr-missing">QR unavailable — open the link below by hand</div>`;
  // No inline <script>: printing is triggered by the opener (see printSign)
  // so the strict script-src 'self' CSP this about:blank window inherits
  // doesn't block it. Same reasoning as js/lib/badgeCards.js.
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(siteName)} — gate sign</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0.5in; background: #fff; color: #1c2430;
    font-family: 'Segoe UI', system-ui, sans-serif; text-align: center;
  }
  .gs-sheet { border: 3px solid ${QR_INK}; border-radius: 18px; padding: 34px 30px 26px; }
  .gs-tenant { font-size: 13px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #5b6472; }
  .gs-eyebrow { font-size: 12px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: ${QR_INK}; margin-top: 22px; }
  .gs-site { font-size: 42px; font-weight: 800; line-height: 1.08; margin: 8px 0 4px; }
  .gs-location { font-size: 16px; color: #5b6472; }
  .gs-qr-wrap { margin: 26px auto 8px; width: 3.3in; }
  .gs-qr { width: 3.3in; height: 3.3in; display: block; }
  .gs-qr-missing {
    height: 3.3in; display: flex; align-items: center; justify-content: center;
    border: 2px dashed #d8dde3; color: #b23a2e; font-size: 14px; padding: 20px;
  }
  .gs-instruction { font-size: 20px; font-weight: 700; margin-top: 14px; }
  .gs-steps {
    margin: 16px auto 0; padding: 0; list-style: none; max-width: 5in;
    text-align: left; font-size: 14.5px; line-height: 1.5; color: #303a48;
  }
  .gs-steps li { display: flex; gap: 10px; padding: 4px 0; }
  .gs-num {
    flex: 0 0 22px; height: 22px; border-radius: 50%; background: ${QR_INK}; color: #fff;
    font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center;
  }
  .gs-rule { height: 1px; background: #e3e7ec; margin: 22px 0 14px; }
  .gs-url { font-family: 'Courier New', monospace; font-size: 11.5px; color: #5b6472; word-break: break-all; }
  .gs-foot { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #8a919e; margin-top: 10px; }
  @page { margin: 0.35in; }
</style></head><body>
  <div class="gs-sheet">
    ${tenantName ? `<div class="gs-tenant">${escapeHtml(tenantName)}</div>` : ''}
    <div class="gs-eyebrow">Gate check-in</div>
    <div class="gs-site">${escapeHtml(siteName)}</div>
    ${siteLocation ? `<div class="gs-location">${escapeHtml(siteLocation)}</div>` : ''}
    <div class="gs-qr-wrap">${qr}</div>
    <div class="gs-instruction">Scan to set up this gate device</div>
    <ul class="gs-steps">
      <li><span class="gs-num">1</span><span>Point the camera of the phone or tablet you'll scan badges with at the code above.</span></li>
      <li><span class="gs-num">2</span><span>Open the link it offers. The device is now set to this site.</span></li>
      <li><span class="gs-num">3</span><span>Scan each worker's badge. Every badge is checked against this site's current requirements.</span></li>
    </ul>
    <div class="gs-rule"></div>
    <div class="gs-url">${escapeHtml(url)}</div>
    <div class="gs-foot">FieldCred · scan a badge, not a binder</div>
  </div>
</body></html>`;
}

// site: { name, location, active, publicSlug }. url: the gate link, already
// built with ?tenant= by the caller (js/lib/publicLinks.js).
export function openGateQrDialog(site, { url, tenantName } = {}) {
  const root = document.getElementById('modal-root');

  root.innerHTML = `
    <div class="modal-overlay" id="gate-qr-overlay">
      <div class="share-modal" role="dialog" aria-modal="true" aria-label="Gate QR code">
        <div class="share-modal-header">
          <div>
            <h2>Gate QR</h2>
            <div class="sub">${escapeHtml(site.name)}${site.location ? ` · ${escapeHtml(site.location)}` : ''}</div>
          </div>
          <button type="button" class="icon-btn" id="gate-qr-close" title="Close" aria-label="Close">${icons.close}</button>
        </div>
        <div class="share-modal-body">
          <div class="qr-block">
            <div class="qr-frame"><div id="gate-qr-target"></div></div>
            <div class="qr-caption">SCAN TO SET UP A GATE DEVICE</div>
          </div>
          <div class="share-actions-col">
            <div class="field-label" style="margin-bottom:6px;">GATE LINK</div>
            <div class="link-row">
              <div class="link-field" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
              <button class="btn btn-primary" id="gate-qr-copy">Copy</button>
            </div>
            <div class="share-secondary-actions">
              <button class="row-btn" id="gate-qr-print">${icons.printer} Print gate sign</button>
              <button class="row-btn" id="gate-qr-download">${icons.download} Download QR (PNG)</button>
            </div>
            <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.5;margin-top:14px;">
              Post this at the gate. A phone camera opens the setup page; the FieldCred Gate app pairs the kiosk to this site.
            </div>
            ${
              site.active
                ? ''
                : `<div style="display:flex;gap:8px;margin-top:12px;font-size:12.5px;color:var(--expired-text);line-height:1.45;">
                     ${icons.alert}<span>This site is inactive, so the code won't resolve until you reactivate it.</span>
                   </div>`
            }
          </div>
        </div>
      </div>
    </div>
  `;

  const qrTarget = root.querySelector('#gate-qr-target');
  // eslint-disable-next-line no-undef
  new QRCode(qrTarget, {
    text: url,
    width: 176,
    height: 176,
    colorDark: QR_INK,
    colorLight: '#ffffff',
    // eslint-disable-next-line no-undef
    correctLevel: QRCode.CorrectLevel.M,
  });

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

  root.querySelector('#gate-qr-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'gate-qr-overlay') close();
  });
  root.querySelector('#gate-qr-close').addEventListener('click', close);

  root.querySelector('#gate-qr-copy').addEventListener('click', async () => {
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
    showToast('Gate link copied');
  });

  root.querySelector('#gate-qr-download').addEventListener('click', async () => {
    // Re-render at print resolution rather than downloading the 176px one on
    // screen — this file gets handed to a print shop or dropped into a slide.
    const src = (await qrDataUrl(url, { size: 900, colorDark: QR_INK })) || qrNodeDataUrl(qrTarget);
    if (!src) {
      showToast("Couldn't generate the QR image");
      return;
    }
    const a = document.createElement('a');
    a.href = src;
    a.download = `fieldcred-gate-${site.publicSlug}.png`;
    a.click();
  });

  root.querySelector('#gate-qr-print').addEventListener('click', async () => {
    // Opened synchronously inside the click handler so pop-up blockers don't
    // eat it while the high-resolution QR renders — see js/lib/badgeCards.js.
    const win = window.open('', '_blank');
    if (!win) {
      showToast('Allow pop-ups to print the gate sign');
      return;
    }
    win.document.write('<!doctype html><title>Preparing…</title><body style="font-family:system-ui;padding:40px;color:#5b6472;">Preparing gate sign…</body>');

    const qrSrc = (await qrDataUrl(url, { size: 900, colorDark: QR_INK })) || qrNodeDataUrl(qrTarget);
    win.document.open();
    win.document.write(signHtml({ siteName: site.name, location: site.location, tenantName, url, qrSrc }));
    win.document.close();
    win.focus();

    const doPrint = () => setTimeout(() => win.print(), 150);
    if (win.document.readyState === 'complete') doPrint();
    else win.addEventListener('load', doPrint);
  });

  document.addEventListener('keydown', onKeydown);
  focusFirst(root.querySelector('.share-modal'));
}
