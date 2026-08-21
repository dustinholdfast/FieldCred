import { icons } from '../lib/icons.js';
import { escapeHtml } from '../lib/format.js';
import { summarizeCertStatuses } from '../lib/status.js';
import { countPill } from './statusPill.js';
import { avatarHtml } from './avatar.js';

export function workerCardHtml(w) {
  const summary = summarizeCertStatuses(w.certifications);
  const pills = ['expired', 'expiring', 'valid', 'missing']
    .filter((s) => summary[s] > 0)
    .map((s) => countPill(s, summary[s]))
    .join('');

  const meta = `${w.department.toUpperCase()} · ${w.location.toUpperCase()}`;

  return `
    <div class="worker-card" data-worker-id="${w.id}" role="button" tabindex="0">
      <div class="worker-card-top">
        ${avatarHtml(w.name, w.photoUrl, { style: 'width:54px;height:54px;' })}
        <div style="min-width:0;flex:1;">
          <div class="worker-card-name">${escapeHtml(w.name)}</div>
          <div class="worker-card-title">${escapeHtml(w.title)}</div>
          <div class="worker-card-meta mono">${escapeHtml(meta)}</div>
        </div>
        <button type="button" class="icon-btn" data-share-id="${w.id}" title="Share / QR" aria-label="Share ${escapeHtml(w.name)}'s record">${icons.share}</button>
      </div>
      <div class="worker-card-divider"></div>
      <div class="pill-row">${pills || '<span class="worker-card-meta">No certifications on file</span>'}</div>
    </div>
  `;
}
