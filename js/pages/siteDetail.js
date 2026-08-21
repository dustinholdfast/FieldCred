import { store } from '../lib/state.js';
import { escapeHtml } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { showToast, showActionError } from '../components/toast.js';
import { openConfirmDialog } from '../components/confirmDialog.js';
import { openAuditPackDialog } from '../components/auditPackDialog.js';
import { openGateQrDialog } from '../components/gateQrDialog.js';
import { avatarHtml } from '../components/avatar.js';
import { gateLinkUrl } from '../lib/publicLinks.js';
import { tenantSlug } from '../lib/supabaseClient.js';
import { icons } from '../lib/icons.js';
import { evaluateClearance } from '../lib/clearance.js';
import { buildAuditPackHtml } from '../lib/auditPack.js';
import { currentRole } from '../lib/auth.js';
import { roleCan } from '../lib/roles.js';

export async function renderSiteDetail(container, params) {
  container.innerHTML = `<div class="empty-state">Loading site…</div>`;

  let site, credentialTypes, workers, reqIds, rosterIds;
  try {
    [site, credentialTypes, workers] = await Promise.all([
      store.getSite(params.id),
      store.credentialTypes(),
      store.getAll(),
    ]);
    if (!site) {
      container.innerHTML = `<div class="empty-state">Site not found. <a href="#/sites">Back to sites</a></div>`;
      return;
    }
    [reqIds, rosterIds] = await Promise.all([store.siteRequiredTypeIds(site.id), store.siteWorkerIds(site.id)]);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Couldn't load this site: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Site management (requirements, roster, settings, delete) is admin-only.
  // Safety reaches this page (viewSites) to read readiness/roster; its edit
  // controls are hidden/disabled below. RLS is the real enforcement.
  const canManage = roleCan(await currentRole(), 'manageSites');

  const typeName = new Map(credentialTypes.map((t) => [t.id, t.name]));
  const workerById = new Map(workers.map((w) => [w.id, w]));

  // Live selections — readiness reflects these as they change; Save persists.
  const reqSel = new Set(reqIds);
  const rosterSel = new Set(rosterIds);

  // The device-config link for this site — post it as a QR at the gate; a
  // supervisor scans it once to point their device at this site. Carries
  // ?tenant= because it is scanned on a device that has never opened the app
  // (see js/lib/publicLinks.js); without it the code resolved against the
  // fallback tenant and found no such site.
  const gateUrl = gateLinkUrl({ slug: site.publicSlug, tenant: tenantSlug });

  container.innerHTML = `
    <div class="directory-header">
      <div>
        <div class="directory-title">${escapeHtml(site.name)}</div>
        <div class="directory-subline"><a href="#/sites">Sites</a> · ${escapeHtml(site.location || 'No location set')}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-outline btn-sm" id="gate-qr-btn">Gate QR</button>
        <button class="btn btn-outline btn-sm" id="audit-pack-btn">Audit pack</button>
        <a href="#/site/${escapeHtml(site.id)}/log" class="btn btn-outline btn-sm">Scan log</a>
      </div>
    </div>

    <div class="admin-grid" style="align-items:start;">
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="admin-card admin-card-body">
          <div class="admin-card-header"><h3>Required credential types</h3>${canManage ? '<button class="btn btn-primary btn-sm" id="reqs-save">Save</button>' : ''}</div>
          <div style="font-size:12px;color:var(--text-muted);margin:2px 0 12px;">A worker is cleared for this site only when they hold a valid (or expiring) cert of every type checked here.</div>
          <div id="reqs-list"></div>
        </div>

        <div class="admin-card admin-card-body">
          <div class="admin-card-header"><h3>Crew roster</h3>${canManage ? '<button class="btn btn-primary btn-sm" id="roster-save">Save</button>' : ''}</div>
          <input id="roster-search" placeholder="Filter workers…" style="width:100%;height:34px;padding:0 10px;border:1px solid var(--border-4);border-radius:7px;font-size:13px;margin:4px 0 12px;">
          <div id="roster-list" style="max-height:340px;overflow:auto;"></div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="admin-card admin-card-body">
          <div class="admin-card-header"><h3>Readiness</h3><a href="#" id="readiness-export">Export CSV</a></div>
          <div id="readiness-body"></div>
        </div>

        <div class="admin-card admin-card-body" style="max-width:520px;">
          <h3 style="margin-bottom:14px;">Site settings</h3>
          <div class="field"><label class="field-label">NAME</label><input id="site-name" value="${escapeHtml(site.name)}" ${canManage ? '' : 'disabled'}></div>
          <div class="field" style="margin-top:12px;"><label class="field-label">LOCATION</label><input id="site-location" value="${escapeHtml(site.location)}" placeholder="City, ST" ${canManage ? '' : 'disabled'}></div>
          <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="site-active" ${site.active ? 'checked' : ''} ${canManage ? '' : 'disabled'}> Active
          </label>
          <div class="field" style="margin-top:14px;">
            <label class="field-label">GATE LINK <span style="font-weight:400;color:var(--text-muted);">— points a device at this site</span></label>
            <div style="display:flex;gap:8px;align-items:center;">
              <input class="mono" id="site-gate-link" readonly value="${escapeHtml(gateUrl)}" style="font-size:12px;flex:1;min-width:0;" title="Click to select, then copy">
              <button class="btn btn-outline btn-sm" id="site-gate-qr" style="flex-shrink:0;display:flex;align-items:center;gap:6px;">${icons.qr} QR</button>
            </div>
          </div>
          ${canManage ? `<div style="margin-top:14px;display:flex;gap:8px;">
            <button class="btn btn-primary btn-sm" id="site-save">Save settings</button>
            <button class="btn-danger-text" id="site-delete">Delete site</button>
          </div>` : ''}
        </div>
      </div>
    </div>
  `;

  const reqsList = container.querySelector('#reqs-list');
  const rosterList = container.querySelector('#roster-list');
  const readinessBody = container.querySelector('#readiness-body');

  // ---- required types ----
  function renderReqs() {
    if (!credentialTypes.length) {
      reqsList.innerHTML = `<div class="empty-state" style="padding:10px;">No credential types yet. Add them in Admin → Credential types first.</div>`;
      return;
    }
    reqsList.innerHTML = credentialTypes
      .map(
        (t) => `
      <label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-req="${escapeHtml(t.id)}" ${reqSel.has(t.id) ? 'checked' : ''} ${canManage ? '' : 'disabled'}>
        <span>${escapeHtml(t.name)}${t.issuer ? ` <span style="color:var(--text-muted);">· ${escapeHtml(t.issuer)}</span>` : ''}</span>
      </label>`
      )
      .join('');
    reqsList.querySelectorAll('[data-req]').forEach((cb) => {
      cb.addEventListener('change', () => {
        cb.checked ? reqSel.add(cb.dataset.req) : reqSel.delete(cb.dataset.req);
        renderReadiness();
      });
    });
  }

  // ---- roster ----
  function renderRoster(filter = '') {
    const f = filter.trim().toLowerCase();
    const list = workers.filter((w) => !f || w.name.toLowerCase().includes(f) || (w.title || '').toLowerCase().includes(f));
    rosterList.innerHTML = list.length
      ? list
          .map(
            (w) => `
      <label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-roster="${escapeHtml(w.id)}" ${rosterSel.has(w.id) ? 'checked' : ''} ${canManage ? '' : 'disabled'}>
        ${avatarHtml(w.name, w.photoUrl, { className: 'avatar-sm' })}
        <span>${escapeHtml(w.name)}${w.title ? ` <span style="color:var(--text-muted);">· ${escapeHtml(w.title)}</span>` : ''}</span>
      </label>`
          )
          .join('')
      : `<div class="empty-state" style="padding:10px;">No workers match.</div>`;
    rosterList.querySelectorAll('[data-roster]').forEach((cb) => {
      cb.addEventListener('change', () => {
        cb.checked ? rosterSel.add(cb.dataset.roster) : rosterSel.delete(cb.dataset.roster);
        renderReadiness();
      });
    });
  }

  // ---- readiness (from live selections) ----
  function readinessRows() {
    const required = [...reqSel];
    return [...rosterSel]
      .map((id) => workerById.get(id))
      .filter(Boolean)
      .map((w) => ({ worker: w, result: evaluateClearance(w, required) }))
      .sort((a, b) => Number(a.result.cleared) - Number(b.result.cleared) || a.worker.name.localeCompare(b.worker.name));
  }

  function renderReadiness() {
    const rows = readinessRows();
    if (!rosterSel.size) {
      readinessBody.innerHTML = `<div class="empty-state" style="padding:10px;">No crew assigned yet. Check workers in the roster to see their clearance.</div>`;
      return;
    }
    const clearedCount = rows.filter((r) => r.result.cleared).length;
    const names = (ids) => ids.map((id) => escapeHtml(typeName.get(id) || 'unknown type')).join(', ');

    readinessBody.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:var(--text-secondary);">
        <strong style="color:${clearedCount === rows.length ? 'var(--valid-text)' : 'var(--expiring-text)'};">${clearedCount}/${rows.length} cleared</strong>
        ${reqSel.size ? '' : ' · no requirements set, so everyone is trivially cleared'}
      </div>
      ${rows
        .map(
          (r) => `
        <div class="table-row" style="grid-template-columns:1.4fr 0.8fr 1.8fr;cursor:pointer;" data-worker-id="${escapeHtml(r.worker.id)}">
          <div class="table-worker">${avatarHtml(r.worker.name, r.worker.photoUrl, { className: 'avatar-sm' })}<div class="table-worker-name">${escapeHtml(r.worker.name)}</div></div>
          <div class="table-status"><span class="pill status-${r.result.cleared ? 'valid' : 'expired'}"><span class="pill-dot"></span>${r.result.cleared ? 'Cleared' : 'Blocked'}</span></div>
          <div style="align-self:center;font-size:12px;">
            ${r.result.missingTypeIds.length ? `<span style="color:var(--expired-text);">Missing: ${names(r.result.missingTypeIds)}</span>` : ''}
            ${r.result.expiringTypeIds.length ? `<span style="color:var(--expiring-text);${r.result.missingTypeIds.length ? 'margin-left:8px;' : ''}">Expiring: ${names(r.result.expiringTypeIds)}</span>` : ''}
            ${r.result.cleared && !r.result.expiringTypeIds.length ? '<span style="color:var(--text-muted);">All required credentials current</span>' : ''}
          </div>
        </div>`
        )
        .join('')}
    `;
    readinessBody.querySelectorAll('[data-worker-id]').forEach((row) => {
      row.addEventListener('click', () => navigate(`/worker/${row.dataset.workerId}`));
    });
  }

  renderReqs();
  renderRoster();
  renderReadiness();

  container.querySelector('#roster-search').addEventListener('input', (e) => renderRoster(e.target.value));

  const gateLinkEl = container.querySelector('#site-gate-link');
  gateLinkEl.addEventListener('click', () => gateLinkEl.select());

  // Gate QR — same dialog from the header and from the gate-link field, since
  // whoever wants it is either setting the site up or standing at the gate.
  // `site` is re-read here rather than captured: a rename saved above should
  // show up on the sign without a reload. Tenant name is a nicety on the
  // printed sign, so a failure to read it is not worth blocking on.
  async function openGateQr() {
    let tenantName = null;
    try {
      tenantName = await store.getTenantName();
    } catch {
      tenantName = null;
    }
    openGateQrDialog(site, { url: gateUrl, tenantName });
  }
  container.querySelector('#gate-qr-btn').addEventListener('click', openGateQr);
  container.querySelector('#site-gate-qr').addEventListener('click', openGateQr);

  container.querySelector('#reqs-save')?.addEventListener('click', async () => {
    try {
      await store.setSiteRequiredTypes(site.id, [...reqSel]);
      showToast('Requirements saved');
    } catch (err) {
      showActionError(err, `Couldn't save requirements: ${err.message}`);
    }
  });

  container.querySelector('#roster-save')?.addEventListener('click', async () => {
    try {
      await store.setSiteAssignments(site.id, [...rosterSel]);
      showToast('Roster saved');
    } catch (err) {
      showActionError(err, `Couldn't save roster: ${err.message}`);
    }
  });

  container.querySelector('#site-save')?.addEventListener('click', async () => {
    const name = container.querySelector('#site-name').value.trim();
    if (!name) return showToast('Site name is required');
    try {
      const updated = await store.updateSite(site.id, {
        name,
        location: container.querySelector('#site-location').value,
        active: container.querySelector('#site-active').checked,
      });
      site = updated;
      showToast('Settings saved');
      container.querySelector('.directory-title').textContent = updated.name;
    } catch (err) {
      showActionError(err, `Couldn't save: ${err.message}`);
    }
  });

  container.querySelector('#site-delete')?.addEventListener('click', async () => {
    const confirmed = await openConfirmDialog({
      title: 'Delete site',
      message: `Delete ${site.name}? Its requirements and roster are removed. Worker records and their certs are untouched.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await store.deleteSite(site.id);
      showToast('Site deleted');
      navigate('/sites');
    } catch (err) {
      showActionError(err, `Couldn't delete: ${err.message}`);
    }
  });

  // ---- readiness CSV export ----
  container.querySelector('#readiness-export').addEventListener('click', (e) => {
    e.preventDefault();
    const rows = readinessRows();
    const header = 'Worker,Status,Missing,Expiring\n';
    const nm = (ids) => ids.map((id) => typeName.get(id) || 'unknown').join('; ');
    const body = rows
      .map((r) =>
        [r.worker.name, r.result.cleared ? 'Cleared' : 'Blocked', nm(r.result.missingTypeIds), nm(r.result.expiringTypeIds)]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fieldcred-${site.publicSlug || 'site'}-readiness.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ---- audit pack export ----
  // Reads the *saved* requirements/roster (fresh store calls below), not the
  // live reqSel/rosterSel selections above — this document goes to an
  // auditor, so it should reflect what's actually persisted, not whatever an
  // admin has mid-edited in this browser tab and not yet saved.
  container.querySelector('#audit-pack-btn').addEventListener('click', async () => {
    const picked = await openAuditPackDialog();
    if (!picked) return;
    const { from, to, win } = picked;
    if (!win) {
      showToast("Allow pop-ups to generate the audit pack");
      return;
    }
    try {
      const [tenantName, extendedSettings, freshReqIds, freshRosterIds] = await Promise.all([
        store.getTenantName(),
        store.getExtendedSettings(),
        store.siteRequiredTypeIds(site.id),
        store.siteWorkerIds(site.id),
      ]);
      const scans = await store.siteScanLog(site.id, {
        from: `${from}T00:00:00.000Z`,
        to: `${to}T23:59:59.999Z`,
        limit: 5000,
      });
      const html = buildAuditPackHtml({
        tenant: { name: tenantName, logoUrl: extendedSettings.logoUrl },
        site,
        requiredTypes: credentialTypes.filter((t) => freshReqIds.includes(t.id)),
        workers: freshRosterIds.map((id) => workerById.get(id)).filter(Boolean),
        scans,
        range: { from, to },
        generatedAt: new Date().toISOString(),
      });
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.focus();
      const doPrint = () => setTimeout(() => win.print(), 150);
      if (win.document.readyState === 'complete') doPrint();
      else win.addEventListener('load', doPrint);
    } catch (err) {
      win.close();
      showActionError(err, `Couldn't generate audit pack: ${err.message}`);
    }
  });
}
