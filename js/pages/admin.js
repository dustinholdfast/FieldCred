import { store } from '../lib/state.js';
import { escapeHtml, formatDate } from '../lib/format.js';
import { navigate, redispatch } from '../lib/router.js';
import { certStatus, statusLabel, STATUS_META, isCompliant } from '../lib/status.js';
import { tenantName, tenantSlug, setTenantName, setTenantLogoUrl } from '../lib/supabaseClient.js';
import { BILLING_SERVICE_URL } from '../lib/config.js';
import { getSession, currentRole } from '../lib/auth.js';
import { roleCan } from '../lib/roles.js';
import { showToast, showActionError } from '../components/toast.js';
import { icons } from '../lib/icons.js';
import { avatarHtml } from '../components/avatar.js';
import { openConfirmDialog } from '../components/confirmDialog.js';

const RANGE_OPTIONS = [
  { value: 30, label: 'Last 30 days' },
  { value: 60, label: 'Last 60 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 180, label: 'Last 180 days' },
];

// Curated rather than the full IANA list (~400 zones) — FieldCred's
// customer base is US trades/compliance (see supabase/TENANCY-MODEL.md),
// so this covers every US time zone plus UTC rather than making an admin
// hunt through a giant picker for one they'll never need.
const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Arizona (Phoenix, no DST)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
  { value: 'UTC', label: 'UTC' },
];

const DAY_OPTIONS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hourLabel(h) {
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${period}`;
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB — a logo, not a photo; keeps public-record load light

export async function renderAdmin(container, query) {
  container.innerHTML = `<div class="empty-state">Loading dashboard…</div>`;

  let allWorkers;
  try {
    allWorkers = await store.getAll();
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Couldn't load the dashboard: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Best-effort — the notification_email column only exists once a tenant
  // has run the expiration-alerts migration. Don't let that block the rest
  // of the dashboard; just leave the field blank until they do.
  let notificationEmail = '';
  try {
    notificationEmail = await store.getNotificationEmail();
  } catch {
    // column not migrated yet on this tenant
  }

  // Same best-effort pattern for migrations 005/006 (logo + digest cadence).
  let extendedSettings = { logoUrl: null, timezone: 'UTC', digestCadence: 'daily', digestDayOfWeek: 1, digestHour: 13 };
  try {
    extendedSettings = await store.getExtendedSettings();
  } catch {
    // columns not migrated yet on this tenant
  }
  let pendingLogoFile = null; // set on file input change, uploaded on Save (matches photo/badge pattern)

  // Credential-type catalog (migration 007). Best-effort — hide the whole card
  // on tenants that haven't run it yet, rather than showing controls that error.
  let credentialTypes = [];
  let credentialTypesAvailable = false;
  try {
    credentialTypes = await store.credentialTypes();
    credentialTypesAvailable = true;
  } catch {
    // credential_types not migrated yet on this tenant
  }

  const planLimits = await store.getPlanLimits();

  // Tenant settings + credential-type management are admin-only writes. A
  // safety user reaches this page for the read-only compliance dashboard, so
  // those two cards are hidden for them (RLS blocks the writes regardless).
  const isAdmin = roleCan(await currentRole(), 'editTenantSettings');

  const departments = [...new Set(allWorkers.map((w) => w.department).filter(Boolean))].sort();

  let windowDays = 90;

  // Usage-based upgrade nudge — surface it before the hard stop so an upgrade
  // can happen while there's still headroom, and turn "you're at your cap"
  // from a dead-end into an action (the reason the cap system exists is to
  // eventually be a revenue lever, not just a wall).
  const cap = planLimits.maxWorkers;
  const usage = allWorkers.length;
  const usagePct = cap ? Math.round((usage / cap) * 100) : 0;
  const showUpgradeBanner = cap != null && usagePct >= 80;
  const atCap = cap != null && usage >= cap;
  const upgradeBannerHtml = showUpgradeBanner
    ? `<div class="usage-banner ${atCap ? 'at-cap' : ''}" id="admin-upgrade-banner">
        <div>
          <div class="usage-banner-title">${atCap ? "You've reached your plan limit" : "You're close to your plan limit"}</div>
          <div class="usage-banner-sub">Using ${usage} of ${cap} worker slots on the ${escapeHtml(planLimits.planTier)} plan.</div>
        </div>
        <button class="btn btn-primary btn-sm" id="request-capacity-btn">Request more capacity</button>
      </div>`
    : '';

  container.innerHTML = `
    <div class="admin-header">
      <div>
        <div class="directory-title">Compliance Operations Dashboard</div>
        <div class="directory-subline">Workforce credential health at a glance</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="pill status-valid" title="Every table on this page exports to CSV"><span class="pill-dot"></span>Audit export ready</span>
        <label class="range-select">
          <select id="admin-range">
            ${RANGE_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === windowDays ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </label>
      </div>
    </div>

    ${upgradeBannerHtml}

    <div class="stat-grid" id="admin-stats"></div>

    <div class="admin-grid">
      <div class="admin-card">
        <div class="admin-card-header">
          <h3>Expiring &amp; expired certifications</h3>
          <a href="#" id="admin-export">Export CSV</a>
        </div>
        <div class="table-head" style="grid-template-columns:1.1fr 0.9fr 1.3fr 0.8fr 0.9fr;">
          <div>WORKER</div><div>ROLE</div><div>CERTIFICATION</div><div>EXPIRES</div><div style="text-align:right;">STATUS</div>
        </div>
        <div id="admin-table-body"></div>
      </div>

      <div class="admin-card admin-card-body">
        <h3 style="margin-bottom:16px;">Compliance by department</h3>
        <div class="dept-row" id="admin-depts"></div>
      </div>
    </div>

    ${isAdmin ? `
    <div class="admin-card admin-card-body" style="margin-top:16px;max-width:560px;">
      <h3 style="margin-bottom:16px;">Tenant settings</h3>
      <div class="field">
        <label class="field-label">DISPLAY NAME</label>
        <input id="tenant-name-input" value="${escapeHtml(tenantName || '')}" placeholder="Client name">
      </div>

      <div class="field" style="margin-top:14px;">
        <label class="field-label">LOGO <span style="font-weight:400;color:var(--text-muted);">(optional — shown on the public record page)</span></label>
        <div style="display:flex;gap:8px;align-items:center;">
          <div class="dropzone compact" style="flex:1;">
            ${icons.uploadTray.replace('class="icon"', 'class="icon icon-sm"')}&nbsp;<span id="logo-filename">${extendedSettings.logoUrl ? 'Logo attached' : 'Upload logo (PNG/JPG/SVG, max 2 MB)'}</span>
            <input type="file" accept="image/png,image/jpeg,image/svg+xml" id="logo-input">
          </div>
          ${extendedSettings.logoUrl ? `<img src="${escapeHtml(extendedSettings.logoUrl)}" alt="" style="height:32px;width:32px;object-fit:contain;border-radius:4px;">` : ''}
        </div>
      </div>

      <div class="field" style="margin-top:14px;">
        <label class="field-label">NOTIFICATION EMAIL</label>
        <input id="notification-email-input" type="email" value="${escapeHtml(notificationEmail || '')}" placeholder="alerts@yourcompany.com">
      </div>
      <div style="margin-top:6px;font-size:12px;color:var(--text-muted);">Where expiring/expired credential alerts get sent. Leave blank to turn alerts off.</div>

      <div class="cert-editor-grid" style="margin-top:14px;">
        <div class="field">
          <label class="field-label">TIME ZONE</label>
          <select id="digest-timezone-input">
            ${TIMEZONE_OPTIONS.map((tz) => `<option value="${tz.value}" ${tz.value === extendedSettings.timezone ? 'selected' : ''}>${escapeHtml(tz.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field-label">ALERT FREQUENCY</label>
          <select id="digest-cadence-input">
            <option value="daily" ${extendedSettings.digestCadence === 'daily' ? 'selected' : ''}>Daily</option>
            <option value="weekly" ${extendedSettings.digestCadence === 'weekly' ? 'selected' : ''}>Weekly</option>
          </select>
        </div>
        <div class="field" id="digest-day-field" style="${extendedSettings.digestCadence === 'weekly' ? '' : 'display:none;'}">
          <label class="field-label">DAY</label>
          <select id="digest-day-input">
            ${DAY_OPTIONS.map((d, i) => `<option value="${i}" ${i === extendedSettings.digestDayOfWeek ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field-label">TIME</label>
          <select id="digest-hour-input">
            ${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === extendedSettings.digestHour ? 'selected' : ''}>${hourLabel(h)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div style="margin-top:12px;">
        <button class="btn btn-primary btn-sm" id="tenant-settings-save">Save</button>
      </div>
    </div>` : ''}

    ${credentialTypesAvailable && isAdmin ? `
    <div class="admin-card admin-card-body" style="margin-top:16px;max-width:560px;">
      <div class="admin-card-header">
        <h3>Credential types</h3>
        <button class="btn btn-neutral-outline btn-sm" id="ct-backfill">Backfill from existing certs</button>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin:2px 0 14px;">The shared vocabulary sites require and certs are tagged with. Backfill seeds it from names already on your workers and tags matching certs; ambiguous names are left untagged.</div>
      <div id="ct-list"></div>
      <div class="cert-editor-grid" style="margin-top:14px;">
        <div class="field span-2"><label class="field-label">NEW TYPE NAME</label><input id="ct-new-name" placeholder="e.g. OSHA 30-Hour Construction"></div>
        <div class="field span-2"><label class="field-label">ISSUER <span style="font-weight:400;color:var(--text-muted);">(optional)</span></label><input id="ct-new-issuer" placeholder="e.g. U.S. OSHA"></div>
      </div>
      <div style="margin-top:10px;"><button class="btn btn-primary btn-sm" id="ct-add">Add type</button></div>
    </div>` : ''}
  `;

  function computeRows() {
    const rows = [];
    for (const w of allWorkers) {
      for (const c of w.certifications) {
        const status = certStatus(c.expiryDate, windowDays);
        // This table is specifically expiring + expired; 'valid' and 'missing'
        // (no date on file) are surfaced elsewhere (directory filter, profile).
        if (status === 'valid' || status === 'missing') continue;
        rows.push({ worker: w, cert: c, status });
      }
    }
    rows.sort((a, b) => a.cert.expiryDate.localeCompare(b.cert.expiryDate));
    return rows;
  }

  function paint() {
    const all = allWorkers;
    const rows = computeRows();

    let validCount = 0, expiringCount = 0, expiredCount = 0, missingCount = 0;
    for (const w of all) {
      for (const c of w.certifications) {
        const s = certStatus(c.expiryDate, windowDays);
        if (s === 'valid') validCount++;
        else if (s === 'expiring') expiringCount++;
        else if (s === 'expired') expiredCount++;
        else missingCount++;
      }
    }
    // Missing dates count toward the denominator (they drag down the cleared %,
    // as they should) but are not "expired".
    const totalCerts = validCount + expiringCount + expiredCount + missingCount;
    const compliantPct = totalCerts ? Math.round((validCount / totalCerts) * 100) : 0;

    const cap = planLimits.maxWorkers;
    const nearCap = cap != null && all.length >= cap;
    const workersNote = cap != null
      ? `of ${cap} on the ${planLimits.planTier} plan`
      : `across ${departments.length} departments`;

    const stats = [
      { label: 'CLEARED', value: `${compliantPct}%`, note: missingCount ? `${validCount} valid · ${missingCount} missing a date` : `${validCount} valid certifications`, color: 'var(--valid-text)' },
      { label: `EXPIRING · ${windowDays} DAYS`, value: expiringCount, note: 'renewal needed', color: 'var(--expiring-text)' },
      { label: 'EXPIRED', value: expiredCount, note: 'action required', color: 'var(--expired-text)' },
      {
        label: 'TOTAL WORKERS',
        value: cap != null ? `${all.length} / ${cap}` : all.length,
        note: workersNote,
        color: nearCap ? 'var(--expired-text)' : 'var(--text-primary)',
      },
    ];

    container.querySelector('#admin-stats').innerHTML = stats
      .map(
        (s) => `
      <div class="stat-card" style="border-top-color:${s.color};">
        <div class="stat-label">${s.label}</div>
        <div class="stat-value" style="color:${s.color};">${s.value}</div>
        <div class="stat-note">${s.note}</div>
      </div>`
      )
      .join('');

    container.querySelector('#admin-table-body').innerHTML = rows.length
      ? rows
          .slice(0, 10)
          .map(
            (r) => `
        <div class="table-row" data-worker-id="${r.worker.id}" style="cursor:pointer;grid-template-columns:1.1fr 0.9fr 1.3fr 0.8fr 0.9fr;">
          <div class="table-worker">
            ${avatarHtml(r.worker.name, r.worker.photoUrl, { className: 'avatar-sm' })}
            <div class="table-worker-name">${escapeHtml(r.worker.name)}</div>
          </div>
          <div class="table-cert-issuer" style="align-self:center;">${escapeHtml(r.worker.title || '—')}</div>
          <div>
            <div class="table-cert-name">${escapeHtml(r.cert.name)}</div>
            <div class="table-cert-issuer">${escapeHtml(r.cert.issuer)}</div>
          </div>
          <div class="table-expiry">${formatDate(r.cert.expiryDate, { withDay: true })}</div>
          <div class="table-status">
            <span class="pill status-${r.status}"><span class="pill-dot"></span>${escapeHtml(statusLabel(r.status))}</span>
          </div>
        </div>`
          )
          .join('')
      : `<div class="empty-state">Nothing expiring or expired in this window.</div>`;

    container.querySelectorAll('#admin-table-body [data-worker-id]').forEach((row) => {
      row.addEventListener('click', () => navigate(`/worker/${row.dataset.workerId}`));
    });

    const depts = departments.map((name) => {
      const workers = all.filter((w) => w.department === name);
      const compliant = workers.filter(isCompliant).length;
      const pct = workers.length ? Math.round((compliant / workers.length) * 100) : 0;
      const color = pct >= 90 ? STATUS_META.valid.text : STATUS_META.expiring.text;
      return { name, pct, color };
    });

    container.querySelector('#admin-depts').innerHTML = depts
      .map(
        (d) => `
      <div>
        <div class="dept-item-head"><span class="name">${escapeHtml(d.name)}</span><span class="pct mono" style="color:${d.color};">${d.pct}%</span></div>
        <div class="dept-track"><div class="dept-fill" style="width:${d.pct}%;background:${d.color};"></div></div>
      </div>`
      )
      .join('');
  }

  container.querySelector('#admin-range').addEventListener('change', (e) => {
    windowDays = Number(e.target.value);
    paint();
  });

  container.querySelector('#admin-export').addEventListener('click', (e) => {
    e.preventDefault();
    const rows = computeRows();
    const header = 'Worker,Certification,Issuer,Expires,Status\n';
    const body = rows
      .map((r) => [r.worker.name, r.cert.name, r.cert.issuer, r.cert.expiryDate, statusLabel(r.status)].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fieldcred-expiring-expired.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  // Tenant-settings card only exists for admins (see markup above); guard the
  // whole handler block so it doesn't dereference null elements for others.
  if (isAdmin) {
  const tenantNameInput = container.querySelector('#tenant-name-input');
  const notificationEmailInput = container.querySelector('#notification-email-input');
  const logoInput = container.querySelector('#logo-input');
  const logoFilenameLabel = container.querySelector('#logo-filename');
  const timezoneInput = container.querySelector('#digest-timezone-input');
  const cadenceInput = container.querySelector('#digest-cadence-input');
  const dayField = container.querySelector('#digest-day-field');
  const dayInput = container.querySelector('#digest-day-input');
  const hourInput = container.querySelector('#digest-hour-input');
  const settingsSaveBtn = container.querySelector('#tenant-settings-save');

  cadenceInput.addEventListener('change', () => {
    dayField.style.display = cadenceInput.value === 'weekly' ? '' : 'none';
  });

  logoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      showToast('Logo is too large — max 2 MB');
      logoInput.value = '';
      return;
    }
    pendingLogoFile = file;
    logoFilenameLabel.textContent = file.name;
  });

  settingsSaveBtn.addEventListener('click', async () => {
    const name = tenantNameInput.value.trim();
    const email = notificationEmailInput.value.trim();
    if (!name) {
      showToast('Display name is required');
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('That doesn’t look like a valid email');
      return;
    }
    settingsSaveBtn.disabled = true;
    try {
      let logoUrl = extendedSettings.logoUrl;
      if (pendingLogoFile) {
        logoUrl = await store.uploadImage('logos', pendingLogoFile);
      }
      const [savedName] = await Promise.all([
        store.setTenantName(name),
        store.setNotificationEmail(email),
        store.updateExtendedSettings({
          logoUrl,
          timezone: timezoneInput.value,
          digestCadence: cadenceInput.value,
          digestDayOfWeek: Number(dayInput.value),
          digestHour: Number(hourInput.value),
        }),
      ]);
      setTenantName(savedName);
      setTenantLogoUrl(logoUrl);
      showToast('Settings saved');
      redispatch(); // refreshes the top nav (and this page) with the new name
    } catch (err) {
      settingsSaveBtn.disabled = false;
      showActionError(err, `Couldn't save: ${err.message}`);
    }
  });
  } // end if (isAdmin) — tenant-settings handlers

  // Capacity request — TWO paths, tried in order, because tenants fall into
  // two genuinely different situations:
  //
  //   1. Tenant HAS a Stripe billing record (arrived via Checkout) -> open a
  //      Stripe Customer Portal session so they change plan themselves.
  //   2. Tenant has NO billing record (pilots, hand-provisioned tenants,
  //      `demo`) -> the existing signup-notify.php email request, which
  //      reaches whoever provisions tenants. See supabase/PROVISIONING.md.
  //
  // The fallback is not a nicety: /api/portal-session reads tenant_billing,
  // and during the free-pilot phase NO tenant has a row there. Replacing the
  // email path outright would give every current tenant a dead button.
  //
  // A 404 from the portal means exactly "no billing record" — that's the
  // signal to fall through, not an error worth showing anyone.
  const requestBtn = container.querySelector('#request-capacity-btn');
  if (requestBtn) {
    requestBtn.addEventListener('click', async () => {
      requestBtn.disabled = true;
      requestBtn.textContent = 'Sending…';

      const session = await getSession();

      // ---- Path 1: Stripe Customer Portal --------------------------------
      if (BILLING_SERVICE_URL && session?.access_token) {
        try {
          const res = await fetch(`${BILLING_SERVICE_URL}/api/portal-session`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ slug: tenantSlug }),
          });

          if (res.ok) {
            const { url } = await res.json();
            if (url) {
              requestBtn.textContent = 'Opening billing…';
              location.href = url; // leaves the app for Stripe
              return;
            }
          } else if (res.status === 401) {
            requestBtn.disabled = false;
            requestBtn.textContent = 'Request more capacity';
            showToast('Your session expired — sign in again to manage billing');
            return;
          } else if (res.status === 403) {
            requestBtn.disabled = false;
            requestBtn.textContent = 'Request more capacity';
            showToast('Only admins can manage billing');
            return;
          }
          // 404 (no billing record) or 502 (Stripe unreachable) -> fall
          // through to the email request rather than dead-ending them.
        } catch {
          // Network error, CORS refusal, or CSP block. Deliberately silent:
          // the email path below still gets their request to a human, which
          // is the outcome that actually matters to them.
        }
      }

      // ---- Path 2: email the operator ------------------------------------
      try {
        const res = await fetch('./signup-notify.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'upgrade',
            companyName: tenantName || 'FieldCred tenant',
            adminEmail: session?.user?.email || '',
            note: `Plan upgrade request — currently using ${usage} of ${cap} worker slots on the ${planLimits.planTier} plan.`,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not send that request');
        showToast("Request sent — we'll be in touch");
        requestBtn.textContent = 'Request sent';
      } catch (err) {
        requestBtn.disabled = false;
        requestBtn.textContent = 'Request more capacity';
        showToast(`Couldn't send: ${err.message}`);
      }
    });

    // Arriving from the at-cap screen (#/admin?upgrade=1) — pull the banner
    // into view so the next step is obvious.
    if (query?.get('upgrade')) {
      container.querySelector('#admin-upgrade-banner')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ---- credential-type catalog card (admin-only) ----
  if (credentialTypesAvailable && isAdmin) {
    const ctList = container.querySelector('#ct-list');
    const inputStyle = 'flex:1;min-width:0;height:34px;padding:0 10px;border:1px solid var(--border-4);border-radius:7px;font-size:13px;';

    function renderCtList() {
      if (!credentialTypes.length) {
        ctList.innerHTML = `<div class="empty-state" style="padding:12px;">No credential types yet. Add one below, or backfill from your existing certs.</div>`;
        return;
      }
      ctList.innerHTML = credentialTypes
        .map(
          (t) => `
        <div class="ct-row" data-id="${escapeHtml(t.id)}" style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
          <input class="ct-name" value="${escapeHtml(t.name)}" style="${inputStyle}">
          <input class="ct-issuer" value="${escapeHtml(t.issuer)}" placeholder="Issuer" style="${inputStyle}">
          <button type="button" class="btn btn-neutral-outline btn-sm" data-ct-save>Save</button>
          <button type="button" class="btn-danger-text" data-ct-del>Delete</button>
        </div>`
        )
        .join('');

      ctList.querySelectorAll('.ct-row').forEach((row) => {
        const id = row.dataset.id;
        row.querySelector('[data-ct-save]').addEventListener('click', async () => {
          const name = row.querySelector('.ct-name').value.trim();
          const issuer = row.querySelector('.ct-issuer').value.trim();
          if (!name) return showToast('Type name is required');
          try {
            const updated = await store.updateCredentialType(id, { name, issuer });
            const idx = credentialTypes.findIndex((x) => x.id === id);
            if (idx >= 0) credentialTypes[idx] = updated;
            credentialTypes.sort((a, b) => a.name.localeCompare(b.name));
            showToast('Type updated');
            renderCtList();
          } catch (err) {
            showToast(`Couldn't update: ${err.message}`);
          }
        });
        row.querySelector('[data-ct-del]').addEventListener('click', async () => {
          const confirmed = await openConfirmDialog({
            title: 'Delete credential type',
            message: 'Delete this type? It will be removed from any site that requires it. Certs tagged with it keep the tag but match no requirement until retagged.',
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!confirmed) return;
          try {
            await store.deleteCredentialType(id);
            credentialTypes = credentialTypes.filter((x) => x.id !== id);
            showToast('Type deleted');
            renderCtList();
          } catch (err) {
            showToast(`Couldn't delete: ${err.message}`);
          }
        });
      });
    }

    container.querySelector('#ct-add').addEventListener('click', async () => {
      const nameEl = container.querySelector('#ct-new-name');
      const issuerEl = container.querySelector('#ct-new-issuer');
      const name = nameEl.value.trim();
      if (!name) return showToast('Type name is required');
      try {
        const created = await store.createCredentialType(name, issuerEl.value.trim());
        credentialTypes.push(created);
        credentialTypes.sort((a, b) => a.name.localeCompare(b.name));
        nameEl.value = '';
        issuerEl.value = '';
        showToast('Type added');
        renderCtList();
      } catch (err) {
        showToast(`Couldn't add: ${err.message}`);
      }
    });

    const backfillBtn = container.querySelector('#ct-backfill');
    backfillBtn.addEventListener('click', async () => {
      const confirmed = await openConfirmDialog({
        title: 'Backfill credential types',
        message: 'Seed the catalog from cert names already on your workers, and tag each matching cert. Only fills certs that have no type yet; ambiguous names are left untagged. Safe to run more than once.',
        confirmLabel: 'Run backfill',
      });
      if (!confirmed) return;
      backfillBtn.disabled = true;
      backfillBtn.textContent = 'Working…';
      try {
        const r = await store.backfillCredentialTypesFromCerts();
        credentialTypes = await store.credentialTypes();
        renderCtList();
        showToast(`Backfill done — ${r.typesCreated} types created, ${r.certsTagged} certs tagged${r.certsUntagged ? `, ${r.certsUntagged} untagged` : ''}`);
      } catch (err) {
        showToast(`Backfill failed: ${err.message}`);
      } finally {
        backfillBtn.disabled = false;
        backfillBtn.textContent = 'Backfill from existing certs';
      }
    });

    renderCtList();
  }

  paint();
}
