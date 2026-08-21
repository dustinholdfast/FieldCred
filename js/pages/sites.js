import { store } from '../lib/state.js';
import { escapeHtml } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { showToast, showActionError } from '../components/toast.js';
import { evaluateClearance } from '../lib/clearance.js';
import { currentRole } from '../lib/auth.js';
import { roleCan } from '../lib/roles.js';

function group(rows, keyField, valField) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[keyField])) m.set(r[keyField], []);
    m.get(r[keyField]).push(r[valField]);
  }
  return m;
}

export async function renderSites(container) {
  container.innerHTML = `<div class="empty-state">Loading sites…</div>`;

  let sites, workers, reqRows, asgRows;
  try {
    [sites, workers, reqRows, asgRows] = await Promise.all([
      store.sites(),
      store.getAll(),
      store.allSiteRequiredTypes(),
      store.allSiteAssignments(),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Sites aren't enabled on this tenant yet. <span style="color:var(--text-muted);">(${escapeHtml(err.message)})</span></div>`;
    return;
  }

  // Creating sites is admin-only; safety sees the list read-only.
  const canManage = roleCan(await currentRole(), 'manageSites');

  const workerById = new Map(workers.map((w) => [w.id, w]));
  const reqBySite = group(reqRows, 'site_id', 'type_id');
  const rosterBySite = group(asgRows, 'site_id', 'worker_id');

  function summary(site) {
    const required = reqBySite.get(site.id) || [];
    const roster = rosterBySite.get(site.id) || [];
    let cleared = 0;
    for (const wid of roster) {
      const w = workerById.get(wid);
      if (w && evaluateClearance(w, required).cleared) cleared++;
    }
    return { requiredCount: required.length, rosterCount: roster.length, cleared };
  }

  container.innerHTML = `
    <div class="directory-header">
      <div>
        <div class="directory-title">Sites</div>
        <div class="directory-subline">Per-site credential requirements &amp; crew readiness</div>
      </div>
      ${canManage ? '<button class="btn btn-primary btn-sm" id="sites-new-toggle">New site</button>' : ''}
    </div>

    <div class="admin-card admin-card-body" id="sites-new-form" style="display:none;max-width:520px;margin-bottom:16px;">
      <div class="cert-editor-grid">
        <div class="field span-2"><label class="field-label">SITE NAME</label><input id="site-new-name" placeholder="e.g. Odessa Refinery Turnaround"></div>
        <div class="field span-2"><label class="field-label">LOCATION <span style="font-weight:400;color:var(--text-muted);">(optional)</span></label><input id="site-new-location" placeholder="City, ST"></div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;">
        <button class="btn btn-primary btn-sm" id="site-new-create">Create site</button>
        <button class="btn btn-neutral-outline btn-sm" id="site-new-cancel">Cancel</button>
      </div>
    </div>

    <div class="site-cards" id="sites-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;"></div>
  `;

  const listEl = container.querySelector('#sites-list');
  listEl.innerHTML = sites.length
    ? sites
        .map((s) => {
          const { requiredCount, rosterCount, cleared } = summary(s);
          const clearedColor = rosterCount && cleared === rosterCount ? 'var(--valid-text)' : 'var(--expiring-text)';
          return `
        <div class="admin-card" data-site-id="${escapeHtml(s.id)}" style="cursor:pointer;padding:16px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="min-width:0;">
              <div class="table-cert-name">${escapeHtml(s.name)}</div>
              <div class="table-cert-issuer">${escapeHtml(s.location || '—')}</div>
            </div>
            ${s.active ? '' : '<span class="pill status-missing"><span class="pill-dot"></span>Inactive</span>'}
          </div>
          <div style="margin-top:14px;display:flex;gap:18px;">
            <div><div class="stat-label">REQUIRED</div><div class="stat-value" style="font-size:20px;">${requiredCount}</div></div>
            <div><div class="stat-label">CREW</div><div class="stat-value" style="font-size:20px;">${rosterCount}</div></div>
            <div><div class="stat-label">CLEARED</div><div class="stat-value" style="font-size:20px;color:${clearedColor};">${cleared}/${rosterCount}</div></div>
          </div>
        </div>`;
        })
        .join('')
    : `<div class="empty-state">No sites yet. Create one to define its required credentials and assign a crew.</div>`;

  listEl.querySelectorAll('[data-site-id]').forEach((card) => {
    card.addEventListener('click', () => navigate(`/site/${card.dataset.siteId}`));
  });

  // Create-site controls only render for admins (canManage); guard the
  // listeners so this is a no-op for a safety user viewing the list.
  if (canManage) {
    const newForm = container.querySelector('#sites-new-form');
    const nameEl = container.querySelector('#site-new-name');
    container.querySelector('#sites-new-toggle').addEventListener('click', () => {
      newForm.style.display = newForm.style.display === 'none' ? '' : 'none';
      if (newForm.style.display !== 'none') nameEl.focus();
    });
    container.querySelector('#site-new-cancel').addEventListener('click', () => {
      newForm.style.display = 'none';
    });
    container.querySelector('#site-new-create').addEventListener('click', async () => {
      const name = nameEl.value.trim();
      if (!name) return showToast('Site name is required');
      try {
        const site = await store.createSite({ name, location: container.querySelector('#site-new-location').value });
        navigate(`/site/${site.id}`);
      } catch (err) {
        showActionError(err, `Couldn't create site: ${err.message}`);
      }
    });
  }
}
