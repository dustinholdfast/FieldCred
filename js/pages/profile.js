import { store } from '../lib/state.js';
import { icons } from '../lib/icons.js';
import { escapeHtml } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { openShareDialog } from '../components/shareDialog.js';
import { certRowHtml } from '../components/certCard.js';
import { summarizeCertStatuses } from '../lib/status.js';
import { showToast } from '../components/toast.js';
import { avatarHtml } from '../components/avatar.js';
import { currentRole } from '../lib/auth.js';
import { roleCan } from '../lib/roles.js';

export async function renderProfile(container, params) {
  container.innerHTML = `<div class="empty-state">Loading profile…</div>`;

  let w;
  try {
    w = await store.getById(params.id);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Couldn't load this profile: ${escapeHtml(err.message)}</div>`;
    return;
  }

  if (!w) {
    container.innerHTML = `<div class="empty-state">Worker not found. <a href="#/directory">Back to directory</a></div>`;
    return;
  }

  const summary = summarizeCertStatuses(w.certifications);

  // Gate (read-only) users can view a profile but not edit it. Share/QR
  // stays available to everyone.
  const canEdit = roleCan(await currentRole(), 'editWorkers');

    container.innerHTML = `
      <div class="profile-breadcrumb" style="margin-bottom:16px;">
        <a href="#/directory">‹ Directory</a> / ${escapeHtml(w.name)}
      </div>

      <div class="profile-layout">
        <div class="profile-sidebar">
          ${avatarHtml(w.name, w.photoUrl, { className: 'photo-placeholder profile-photo' })}
          <div class="profile-name">${escapeHtml(w.name)}</div>
          <div class="profile-title">${escapeHtml(w.title)}</div>
          ${w.department ? `<div class="profile-dept-chip">${escapeHtml(w.department)}</div>` : ''}

          <div class="profile-divider"></div>
          <div class="contact-block">
            <div><div class="field-label">LOCATION</div><div class="field-value">${escapeHtml(w.location || '—')}</div></div>
            <div><div class="field-label">PHONE</div><div class="field-value mono">${escapeHtml(w.phone || '—')}</div></div>
            <div><div class="field-label">EMAIL</div><div class="field-value mono small">${escapeHtml(w.email || '—')}</div></div>
          </div>

          <div class="profile-divider"></div>
          <div class="skills-label">SKILLS</div>
          <div class="skill-chip-row">
            ${w.skills.map((s) => `<span class="skill-chip">${escapeHtml(s)}</span>`).join('') || '<span class="worker-card-meta">No skills listed</span>'}
          </div>

          <div class="sidebar-actions">
            ${canEdit ? '<button class="btn btn-outline" id="profile-edit-btn">Edit</button>' : ''}
            <button class="btn btn-primary" id="profile-share-btn">${icons.share} Share / QR</button>
          </div>
        </div>

        <div class="profile-main">
          <div class="profile-main-header">
            <h2>Certifications</h2>
            <div class="mono" style="font-size:11px;color:var(--text-muted);">${w.certifications.length} TOTAL</div>
          </div>
          <div class="status-summary">
            <div class="status-tile valid"><div class="num">${summary.valid}</div><div class="lbl">Valid</div></div>
            <div class="status-tile expiring"><div class="num">${summary.expiring}</div><div class="lbl">Expiring</div></div>
            <div class="status-tile expired"><div class="num">${summary.expired}</div><div class="lbl">Expired</div></div>
            ${summary.missing ? `<div class="status-tile missing"><div class="num">${summary.missing}</div><div class="lbl">No date</div></div>` : ''}
          </div>
          <div class="cert-list">
            ${w.certifications.length ? w.certifications.map(certRowHtml).join('') : '<div class="empty-state">No certifications on file yet.</div>'}
          </div>
        </div>
      </div>
    `;

  container.querySelector('#profile-edit-btn')?.addEventListener('click', () => navigate(`/worker/${w.id}/edit`));
  container.querySelector('#profile-share-btn').addEventListener('click', () => openShareDialog(w.id));

  container.querySelectorAll('[data-cert-path]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const url = await store.getCertificateSignedUrl(btn.dataset.certPath);
        window.open(url, '_blank', 'noopener');
      } catch (err) {
        showToast(`Couldn't open certificate: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    });
  });
}
