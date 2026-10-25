import { icons } from '../lib/icons.js';
import { escapeHtml, formatDateTime } from '../lib/format.js';
import { certStatus, statusLabel, STATUS_META } from '../lib/status.js';
import { formatDate } from '../lib/format.js';
import { verificationLink } from '../lib/verification.js';

// Small "Verified" badge — a deliberate admin attestation (see
// js/lib/verification.js / editProfile.js), never inferred from just having
// a link on file. includeVerifier controls whether the admin's email is
// shown: yes on the authenticated worker profile, no on the public record
// (that page already deliberately omits staff contact info).
function verifiedBadgeHtml(c, { includeVerifier }) {
  if (!c.verified) return '';
  const who = includeVerifier && c.verifiedBy ? ` by ${escapeHtml(c.verifiedBy)}` : '';
  const when = c.verifiedAt ? ` · ${escapeHtml(formatDateTime(c.verifiedAt))}` : '';
  return `<span class="pill status-valid" title="Verified${who}${when}"><span class="pill-dot"></span>Verified</span>`;
}

// Full cert row — used on the worker profile (2A) certification list.
export function certRowHtml(c) {
  const status = certStatus(c.expiryDate);
  const color = STATUS_META[status].text;
  const badge = c.badgeImageUrl ? `<img src="${escapeHtml(c.badgeImageUrl)}" alt="">` : 'BADGE';
  const verify = verificationLink(c);

  return `
    <div class="cert-row" style="border-left-color:${color};">
      <div class="badge-placeholder">${badge}</div>
      <div class="cert-body">
        <div class="cert-body-top">
          <div class="cert-name">${escapeHtml(c.name)}</div>
          <div style="display:flex;gap:6px;">
            ${verifiedBadgeHtml(c, { includeVerifier: true })}
            <span class="pill status-${status}"><span class="pill-dot"></span>${escapeHtml(statusLabel(status))}</span>
          </div>
        </div>
        <div class="cert-issuer">${escapeHtml(c.issuer)}</div>
        <div class="cert-meta-row">
          <div class="cert-meta">EARNED <span>${formatDate(c.earnedDate)}</span></div>
          <div class="cert-meta">EXPIRES <span>${formatDate(c.expiryDate)}</span></div>
          <div class="cert-actions">
            ${c.cardNumber ? `<span class="mono" style="color:var(--text-muted);font-weight:400;">Card # ${escapeHtml(c.cardNumber)}</span>` : ''}
            ${verify ? `<a href="${escapeHtml(verify.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(verify.label)} ${icons.externalLink.replace('class="icon"', 'class="icon icon-sm"')}</a>` : ''}
            ${c.certificateFileUrl ? `<button type="button" class="download-link" data-cert-path="${escapeHtml(c.certificateFileUrl)}">Download</button>` : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

// Compact cert card — used on the public mobile record.
export function publicCertCardHtml(c) {
  const status = certStatus(c.expiryDate);
  const color = STATUS_META[status].text;
  const badge = c.badgeImageUrl ? `<img src="${escapeHtml(c.badgeImageUrl)}" alt="">` : '';
  const verify = verificationLink(c);

  return `
    <div class="public-cert-card" style="border-left-color:${color};">
      <div class="public-cert-top">
        <div class="badge-placeholder">${badge}</div>
        <div style="min-width:0;flex:1;">
          <div class="public-cert-name">${escapeHtml(c.name)}</div>
          <div class="public-cert-issuer">${escapeHtml(c.issuer)}</div>
        </div>
      </div>
      <div class="public-cert-bottom">
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="pill status-${status}"><span class="pill-dot"></span>${escapeHtml(statusLabel(status))}</span>
          ${verifiedBadgeHtml(c, { includeVerifier: false })}
        </div>
        <div style="display:flex;gap:12px;align-items:center;">
          ${c.cardNumber ? `<span class="mono" style="font-size:11px;color:var(--text-secondary);">Card # ${escapeHtml(c.cardNumber)}</span>` : ''}
          ${c.certificateFileUrl ? `<a href="${escapeHtml(c.certificateFileUrl)}" target="_blank" rel="noopener noreferrer" download style="font-size:11px;font-weight:600;color:var(--text-secondary);">Download</a>` : ''}
          ${verify ? `<a href="${escapeHtml(verify.url)}" target="_blank" rel="noopener noreferrer" style="font-size:11px;font-weight:600;">${escapeHtml(verify.label)} ${icons.externalLink.replace('class="icon"', 'class="icon icon-sm"')}</a>` : ''}
        </div>
      </div>
    </div>
  `;
}
