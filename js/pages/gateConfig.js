import { store } from '../lib/state.js';
import { navigate } from '../lib/router.js';
import { escapeHtml } from '../lib/format.js';
import { shieldLogo } from '../components/logo.js';

// Public device-config page. A site's QR (posted at the gate) points here;
// visiting it remembers the site on this device (localStorage), so subsequent
// worker-badge scans (/r/:slug) show clearance against it. No login, no list.
const GATE_KEY = 'fieldcred_gate_site';

export async function renderGateConfig(container, params) {
  container.innerHTML = `<div class="public-page"><div class="public-unavailable">Setting up gate…</div></div>`;

  let site = null;
  try {
    site = await store.getPublicSite(params.slug);
  } catch {
    site = null;
  }

  if (!site) {
    container.innerHTML = `
      <div class="public-page">
        <div class="public-unavailable">
          <div>
            <div style="width:24px;margin:0 auto 12px;">${shieldLogo()}</div>
            <div style="font-weight:600;margin-bottom:4px;">Gate site not found</div>
            <div style="font-size:13px;">This gate link may be inactive or mistyped.</div>
          </div>
        </div>
      </div>`;
    return;
  }

  try { localStorage.setItem(GATE_KEY, site.publicSlug); } catch {}

  const reqs = site.requiredTypes.length
    ? site.requiredTypes.map((t) => `<span class="gate-ready-chip">${escapeHtml(t.name)}</span>`).join('')
    : '<span class="gate-ready-empty">No credential requirements are set yet.</span>';

  container.innerHTML = `
    <div class="gate-ready-page">
      <div class="gate-ready-brand"><span>${shieldLogo()}</span>FieldCred <small>Gate</small></div>
      <div class="gate-ready-card">
        <div class="gate-ready-check" aria-hidden="true">✓</div>
        <div class="gate-ready-eyebrow">Device configured</div>
        <h1>${escapeHtml(site.name)}</h1>
        <p>Every badge scanned on this device will be checked against this site's live requirements.</p>
        <div class="gate-ready-rule"></div>
        <div class="gate-ready-label mono">REQUIRED CREDENTIALS</div>
        <div class="gate-ready-chips">${reqs}</div>
      </div>
      <div class="gate-ready-actions">
        <button class="gate-ready-primary" id="gate-start-scanning">Open scanner <span>→</span></button>
        <div class="gate-ready-note"><span></span> Site saved on this device</div>
      </div>
    </div>`;

  // Setting up a gate device and then scanning workers is one continuous
  // task, so hand straight off to the camera rather than making whoever set
  // the device up go find the scanner themselves.
  container.querySelector('#gate-start-scanning').addEventListener('click', () => navigate('/scan'));
}
