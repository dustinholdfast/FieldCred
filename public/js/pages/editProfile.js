import { store, emptyCert } from '../lib/state.js';
import { parseCertText } from '../lib/certParse.js';
import { ocrImage } from '../lib/ocr.js';
import { icons } from '../lib/icons.js';
import { escapeHtml, isSafeExternalUrl, formatDateTime } from '../lib/format.js';
import { VERIFICATION_SOURCES } from '../lib/verification.js';
import { getSession, currentRole } from '../lib/auth.js';
import { roleCan } from '../lib/roles.js';
import { navigate } from '../lib/router.js';
import { showToast, showActionError } from '../components/toast.js';
import { openConfirmDialog } from '../components/confirmDialog.js';

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function renderEditProfile(container, params) {
  container.innerHTML = `<div class="empty-state">Loading…</div>`;

  const isNew = !params.id;
  let existing = null;
  let departments = [];
  let planLimits = { planTier: 'unlimited', maxWorkers: null };
  let currentCount = 0;
  try {
    if (isNew) {
      // A new profile only needs the department list (for the dropdown) and
      // a worker count (for the plan-cap pre-check) — not every worker row.
      // countWorkers() is a count-only query; departments() selects one
      // column. Neither pulls the full table the way store.getAll() would.
      const [depts, limits, count] = await Promise.all([
        store.departments(),
        store.getPlanLimits(),
        store.countWorkers(),
      ]);
      departments = depts;
      currentCount = count;
      planLimits = limits;
    } else {
      [existing, departments] = await Promise.all([store.getById(params.id), store.departments()]);
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Couldn't load this form: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Credential-type catalog for the per-cert type picker. Best-effort — the
  // table only exists once a tenant has run migration 007; until then the
  // picker just doesn't render and certs stay untagged (fail-closed). Any
  // typeId already on a cert is still preserved through save regardless.
  let credentialTypes = [];
  try {
    credentialTypes = await store.credentialTypes();
  } catch {
    // credential_types not migrated yet on this tenant
  }

  if (params.id && !existing) {
    container.innerHTML = `<div class="empty-state">Worker not found. <a href="#/directory">Back to directory</a></div>`;
    return;
  }

  // Deleting a worker is admin-only; safety can edit but not delete (the edit
  // route itself is already gated to editWorkers, so gate never reaches here).
  const canDelete = roleCan(await currentRole(), 'deleteWorkers');

  // This is a UX shortcut, not the real guarantee — a DB trigger on
  // `workers` insert (see supabase/schema.sql) enforces the cap
  // server-side regardless of what the frontend does.
  if (isNew && planLimits.maxWorkers != null && currentCount >= planLimits.maxWorkers) {
    container.innerHTML = `
      <div class="cap-reached">
        <div class="cap-reached-title">You've reached your plan limit</div>
        <div class="cap-reached-body">The ${escapeHtml(planLimits.planTier)} plan allows up to ${planLimits.maxWorkers} active workers. Remove one to add another, or request more capacity.</div>
        <div class="cap-reached-actions">
          <a class="btn btn-primary" href="#/admin?upgrade=1">Request more capacity</a>
          <a class="btn btn-neutral-outline" href="#/directory">Back to directory</a>
        </div>
      </div>`;
    return;
  }

  // photoFile/badge "file" fields hold a pending File to upload on save;
  // the *Url fields hold what's shown in the meantime (existing Storage
  // URL, or a local data-URL preview once a new file is picked).
  let photoUrl = existing?.photoUrl || null;
  let photoFile = null;
  let skills = existing ? [...existing.skills] : [];
  let certEntries = existing
    ? existing.certifications.map((c) => ({ ...c, badgeFile: null, certificateFile: null }))
    : [{ ...emptyCert(), badgeFile: null, certificateFile: null }];

  container.innerHTML = `
    <div class="directory-header">
      <div class="form-title" style="margin:0;">${isNew ? 'New worker profile' : 'Edit worker profile'}</div>
      <div class="top-actions">
        ${existing && canDelete ? '<button class="btn btn-danger-outline" id="ep-delete">Delete profile</button>' : ''}
        <button class="btn btn-neutral-outline" id="ep-cancel">Cancel</button>
        <button class="btn btn-primary" id="ep-save">Save profile</button>
      </div>
    </div>

    <div class="form-grid">
      <div class="form-card">
        <h3>Personal information</h3>
        <div class="photo-upload-row">
          <div class="photo-placeholder" id="ep-photo-preview">${photoUrl ? `<img src="${escapeHtml(photoUrl)}" alt="">` : '<span class="mono">PHOTO</span>'}</div>
          <div class="dropzone">
            <div class="dz-title">Upload photo</div>
            <div class="dz-sub">JPG or PNG · square · max 5 MB</div>
            <input type="file" accept="image/png,image/jpeg" id="ep-photo-input">
          </div>
        </div>

        <div class="field-grid-2">
          <div class="field"><label class="field-label">FULL NAME</label><input id="f-name" value="${escapeHtml(existing?.name || '')}" placeholder="Jane Doe"></div>
          <div class="field"><label class="field-label">TITLE</label><input id="f-title" value="${escapeHtml(existing?.title || '')}" placeholder="Job title"></div>
          <div class="field">
            <label class="field-label">DEPARTMENT</label>
            <select id="f-department">
              ${departments.map((d) => `<option value="${escapeHtml(d)}" ${existing?.department === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}
              ${existing?.department && !departments.includes(existing.department) ? `<option value="${escapeHtml(existing.department)}" selected>${escapeHtml(existing.department)}</option>` : ''}
              <option value="__new__">+ Add new department…</option>
            </select>
            <div id="ep-dept-new-row" style="display:none;gap:6px;margin-top:6px;">
              <input type="text" id="ep-dept-new-input" placeholder="New department name" style="height:34px;padding:0 10px;border:1px solid var(--border-4);border-radius:7px;font-size:13px;flex:1;min-width:0;">
              <button type="button" class="btn btn-tint btn-sm" id="ep-dept-new-add">Add</button>
              <button type="button" class="btn btn-neutral-outline btn-sm" id="ep-dept-new-cancel">Cancel</button>
            </div>
          </div>
          <div class="field"><label class="field-label">LOCATION</label><input id="f-location" value="${escapeHtml(existing?.location || '')}" placeholder="City, ST"></div>
          <div class="field"><label class="field-label">PHONE</label><input class="mono" id="f-phone" value="${escapeHtml(existing?.phone || '')}" placeholder="(555) 000-0000"></div>
          <div class="field"><label class="field-label">EMAIL</label><input class="mono" id="f-email" type="email" value="${escapeHtml(existing?.email || '')}" placeholder="name@company.com"></div>
        </div>

        <div class="field" style="margin-top:14px;">
          <label class="field-label">SKILLS</label>
          <div class="skills-editor" id="ep-skills">
            <input type="text" id="ep-skill-input" placeholder="+ add skill…">
          </div>
        </div>
      </div>

      <div class="form-card">
        <div class="certs-editor-header">
          <h3>Certifications</h3>
          <button class="btn btn-tint btn-sm" id="ep-add-cert">${icons.plus} Add certification</button>
        </div>
        <div id="ep-certs"></div>
      </div>
    </div>
  `;

  // ---- department "add new" ----
  const deptSelect = container.querySelector('#f-department');
  const deptNewRow = container.querySelector('#ep-dept-new-row');
  const deptNewInput = container.querySelector('#ep-dept-new-input');

  function commitNewDepartment() {
    const name = deptNewInput.value.trim();
    if (name) {
      const existingOpt = [...deptSelect.options].find((o) => o.value === name);
      if (existingOpt) {
        existingOpt.selected = true;
      } else {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        opt.selected = true;
        deptSelect.insertBefore(opt, deptSelect.querySelector('option[value="__new__"]'));
      }
      deptNewRow.style.display = 'none';
      deptNewInput.value = '';
    } else {
      // No name entered and nothing to fall back to (e.g. this is the very
      // first department) — keep the input open rather than silently
      // reverting to an option that doesn't exist.
      const fallback = existing?.department || departments[0] || '';
      if (fallback) {
        deptSelect.value = fallback;
        deptNewRow.style.display = 'none';
        deptNewInput.value = '';
      } else {
        deptNewInput.focus();
      }
    }
  }

  function cancelNewDepartment() {
    const fallback = existing?.department || departments[0] || '';
    deptSelect.value = fallback || '__new__';
    deptNewRow.style.display = fallback ? 'none' : 'flex';
    deptNewInput.value = '';
  }

  deptSelect.addEventListener('change', () => {
    if (deptSelect.value === '__new__') {
      deptNewRow.style.display = 'flex';
      deptNewInput.focus();
    }
  });

  // The dropdown can land on "+ Add new department…" by default when there
  // are no departments yet (it's the only option) — a native <select> only
  // fires 'change' when the selection actually changes, so re-picking an
  // already-selected option does nothing. Cover that on initial render too.
  if (deptSelect.value === '__new__') {
    deptNewRow.style.display = 'flex';
  }
  container.querySelector('#ep-dept-new-add').addEventListener('click', commitNewDepartment);
  container.querySelector('#ep-dept-new-cancel').addEventListener('click', cancelNewDepartment);
  deptNewInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitNewDepartment();
    } else if (e.key === 'Escape') {
      cancelNewDepartment();
    }
  });

  // ---- photo upload (local preview now, actual Storage upload on save) ----
  container.querySelector('#ep-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    photoFile = file;
    const preview = await readFileAsDataUrl(file);
    container.querySelector('#ep-photo-preview').innerHTML = `<img src="${preview}" alt="">`;
  });

  // ---- skills chips ----
  const skillsBox = container.querySelector('#ep-skills');
  const skillInput = container.querySelector('#ep-skill-input');

  function renderSkills() {
    skillsBox.querySelectorAll('.skill-tag').forEach((el) => el.remove());
    skills.forEach((s, i) => {
      const chip = document.createElement('span');
      chip.className = 'skill-tag';
      chip.innerHTML = `${escapeHtml(s)} <button type="button" aria-label="Remove ${escapeHtml(s)}">×</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        skills.splice(i, 1);
        renderSkills();
      });
      skillsBox.insertBefore(chip, skillInput);
    });
  }
  skillInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = skillInput.value.trim();
      if (val && !skills.includes(val)) {
        skills.push(val);
        skillInput.value = '';
        renderSkills();
      }
    }
  });
  renderSkills();

  // ---- certifications repeater ----
  const certsBox = container.querySelector('#ep-certs');

  function syncCertsFromDom() {
    certsBox.querySelectorAll('.cert-editor').forEach((block, i) => {
      const e = certEntries[i];
      if (!e) return;
      e.name = block.querySelector('.ce-name').value;
      e.issuer = block.querySelector('.ce-issuer').value;
      e.earnedDate = block.querySelector('.ce-earned').value;
      e.expiryDate = block.querySelector('.ce-expiry').value;
      e.verificationSource = block.querySelector('.ce-source').value;
      e.cardNumber = block.querySelector('.ce-card-number').value;
      // .ce-url only renders when the source is blank/Other (NCCER/OSHA show
      // a fixed link instead) — leave verificationUrl untouched otherwise, so
      // switching source and back doesn't lose a previously-typed link.
      const urlInput = block.querySelector('.ce-url');
      if (urlInput) e.verificationUrl = urlInput.value;
      // The type <select> only renders when the catalog is available; when it
      // isn't, leave any existing typeId on the entry untouched (don't clobber
      // a tag just because the picker wasn't shown).
      const typeSel = block.querySelector('.ce-type');
      if (typeSel) e.typeId = typeSel.value || null;
    });
  }

  function renderCerts() {
    certsBox.innerHTML = certEntries
      .map(
        (c, i) => `
      <div class="cert-editor" data-idx="${i}">
        <div class="cert-editor-header">
          <div class="cert-editor-label">CERTIFICATION ${String(i + 1).padStart(2, '0')}</div>
          <button type="button" class="btn-danger-text" data-remove="${i}">Remove</button>
        </div>
        <div class="cert-editor-grid">
          <div class="field span-2"><label class="field-label">NAME</label><input class="ce-name" value="${escapeHtml(c.name)}" placeholder="Certification name"></div>
          ${credentialTypes.length || c.typeId ? `
          <div class="field span-2">
            <label class="field-label">CREDENTIAL TYPE <span style="font-weight:400;color:var(--text-muted);">— matches site requirements</span></label>
            <select class="ce-type">
              <option value="">— No type —</option>
              ${credentialTypes.map((t) => `<option value="${escapeHtml(t.id)}" ${c.typeId === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
              ${c.typeId && !credentialTypes.some((t) => t.id === c.typeId) ? `<option value="${escapeHtml(c.typeId)}" selected>(unknown type — was it removed?)</option>` : ''}
            </select>
          </div>` : ''}
          <div class="field"><label class="field-label">ISSUER</label><input class="ce-issuer" value="${escapeHtml(c.issuer)}" placeholder="Issuing body"></div>
          <div class="field badge-upload-cell">
            <div class="dropzone compact" style="width:100%;">
              ${icons.uploadTray.replace('class="icon"', 'class="icon icon-sm"')}&nbsp;${c.badgeFile ? escapeHtml(c.badgeFile.name) : c.badgeImageUrl ? 'Badge attached' : 'Badge image'}
              <input type="file" accept="image/png,image/jpeg" data-badge-idx="${i}">
            </div>
          </div>
          <div class="field span-2">
            <label class="field-label">CERTIFICATE PDF</label>
            <div style="display:flex;gap:8px;align-items:center;">
              <div class="dropzone compact" style="flex:1;">
                ${icons.uploadTray.replace('class="icon"', 'class="icon icon-sm"')}&nbsp;${c.certificateFile ? escapeHtml(c.certificateFile.name) : c.certificateFileUrl ? 'PDF attached' : 'Upload certificate PDF'}
                <input type="file" accept="application/pdf" data-cert-pdf-idx="${i}">
              </div>
              ${c.certificateFileUrl && !c.certificateFile ? `<button type="button" class="btn btn-neutral-outline btn-sm" style="flex-shrink:0;" data-view-cert-path="${escapeHtml(c.certificateFileUrl)}">View current</button>` : ''}
            </div>
          </div>
          <div class="field span-2">
            <label class="field-label">SCAN CERT <span style="font-weight:400;color:var(--text-muted);">— auto-fill dates from a photo (beta)</span></label>
            <div class="dropzone compact" style="width:100%;">
              ${icons.uploadTray.replace('class="icon"', 'class="icon icon-sm"')}&nbsp;<span data-scan-status="${i}">Upload a photo of the card</span>
              <input type="file" accept="image/*" data-scan-idx="${i}">
            </div>
            <div data-scan-text="${i}" style="display:none;margin-top:6px;font-size:11px;color:var(--text-muted);white-space:pre-wrap;max-height:80px;overflow:auto;border:1px solid var(--border-4);border-radius:6px;padding:6px;"></div>
          </div>
          <div class="field"><label class="field-label">EARNED</label><input class="ce-earned mono" type="date" value="${escapeHtml(c.earnedDate)}"></div>
          <div class="field"><label class="field-label">EXPIRES</label><input class="ce-expiry mono" type="date" value="${escapeHtml(c.expiryDate)}"></div>
          <div class="field span-2">
            <label class="field-label">VERIFICATION <span style="font-weight:400;color:var(--text-muted);">— NCCER/OSHA point to their real portal; check the card # there by hand</span></label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <select class="ce-source" style="flex:1;min-width:150px;height:34px;border:1px solid var(--border-4);border-radius:7px;padding:0 8px;font-size:13px;">
                <option value="" ${!c.verificationSource ? 'selected' : ''}>— Source —</option>
                <option value="NCCER" ${c.verificationSource === 'NCCER' ? 'selected' : ''}>NCCER</option>
                <option value="OSHA" ${c.verificationSource === 'OSHA' ? 'selected' : ''}>OSHA</option>
                <option value="Other" ${c.verificationSource === 'Other' ? 'selected' : ''}>State board / other</option>
              </select>
              <input class="ce-card-number mono" style="flex:1;min-width:150px;" value="${escapeHtml(c.cardNumber)}" placeholder="Card / cert #">
            </div>
            ${
              c.verificationSource === 'NCCER' || c.verificationSource === 'OSHA'
                ? `<div style="margin-top:6px;font-size:12px;color:var(--text-muted);">Fixed link: <a href="${escapeHtml(VERIFICATION_SOURCES[c.verificationSource].portalUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(VERIFICATION_SOURCES[c.verificationSource].portalLabel)}</a> — this source can't be pointed anywhere else.</div>`
                : `<input class="ce-url mono" style="margin-top:6px;width:100%;height:34px;padding:0 8px;border:1px solid var(--border-4);border-radius:7px;" value="${escapeHtml(c.verificationUrl)}" placeholder="https://… (state board or other verification link)">`
            }
            <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12.5px;cursor:pointer;">
              <input type="checkbox" class="ce-verified" ${c.verified ? 'checked' : ''}>
              ${
                c.verified
                  ? `<span style="color:var(--valid-text);font-weight:600;">Verified</span>${c.verifiedBy ? ` by ${escapeHtml(c.verifiedBy)}` : ''}${c.verifiedAt ? ` · ${escapeHtml(formatDateTime(c.verifiedAt))}` : ''}`
                  : `I checked this on the portal above and confirmed it's real`
              }
            </label>
          </div>
        </div>
      </div>
    `
      )
      .join('');

    certsBox.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        syncCertsFromDom();
        certEntries.splice(Number(btn.dataset.remove), 1);
        renderCerts();
      });
    });
    certsBox.querySelectorAll('[data-badge-idx]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        certEntries[Number(input.dataset.badgeIdx)].badgeFile = file;
        showToast('Badge image will attach on save');
        renderCerts();
      });
    });
    certsBox.querySelectorAll('[data-view-cert-path]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const url = await store.getCertificateSignedUrl(btn.dataset.viewCertPath);
          window.open(url, '_blank', 'noopener');
        } catch (err) {
          showToast(`Couldn't open certificate: ${err.message}`);
        } finally {
          btn.disabled = false;
        }
      });
    });
    certsBox.querySelectorAll('[data-cert-pdf-idx]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.type !== 'application/pdf') {
          showToast('Please choose a PDF file');
          input.value = '';
          return;
        }
        certEntries[Number(input.dataset.certPdfIdx)].certificateFile = file;
        showToast('Certificate PDF will attach on save');
        renderCerts();
      });
    });
    certsBox.querySelectorAll('.ce-source').forEach((select) => {
      select.addEventListener('change', () => {
        syncCertsFromDom();
        const idx = Number(select.closest('.cert-editor').dataset.idx);
        const entry = certEntries[idx];
        // Changing the source invalidates a prior verification — it was a
        // confirmation of a specific portal/card combination, not a
        // standing fact. Re-verifying against the new source is a
        // deliberate act, same as the first time.
        if (entry.verified) {
          entry.verified = false;
          entry.verifiedBy = null;
          entry.verifiedAt = null;
          showToast('Source changed — verification cleared, please re-check');
        }
        renderCerts();
      });
    });
    certsBox.querySelectorAll('.ce-card-number').forEach((input) => {
      input.addEventListener('change', () => {
        syncCertsFromDom();
        const idx = Number(input.closest('.cert-editor').dataset.idx);
        const entry = certEntries[idx];
        // Same reasoning as the source change above — a verification is
        // only trustworthy for the card # it was actually checked against.
        if (entry.verified) {
          entry.verified = false;
          entry.verifiedBy = null;
          entry.verifiedAt = null;
          showToast('Card # changed — verification cleared, please re-check');
        }
        renderCerts();
      });
    });
    certsBox.querySelectorAll('.ce-verified').forEach((checkbox) => {
      checkbox.addEventListener('change', async () => {
        syncCertsFromDom();
        const idx = Number(checkbox.closest('.cert-editor').dataset.idx);
        const entry = certEntries[idx];
        if (checkbox.checked) {
          checkbox.disabled = true;
          let email = null;
          try {
            const session = await getSession();
            email = session?.user?.email || null;
          } catch {
            // fall through with email = null — still record the verification,
            // just without an attributable admin identity
          }
          entry.verified = true;
          entry.verifiedBy = email;
          entry.verifiedAt = new Date().toISOString();
        } else {
          entry.verified = false;
          entry.verifiedBy = null;
          entry.verifiedAt = null;
        }
        renderCerts();
      });
    });
    certsBox.querySelectorAll('[data-scan-idx]').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const idx = Number(input.dataset.scanIdx);
        const file = e.target.files[0];
        if (!file) return;
        const statusEl = certsBox.querySelector(`[data-scan-status="${idx}"]`);
        const textEl = certsBox.querySelector(`[data-scan-text="${idx}"]`);
        const block = input.closest('.cert-editor');
        syncCertsFromDom(); // keep any manual edits before we touch this entry
        statusEl.textContent = 'Scanning… first scan loads the OCR engine (a few seconds).';
        try {
          const text = await ocrImage(file);
          const parsed = parseCertText(text);
          const entry = certEntries[idx];
          if (parsed.earnedDate) { entry.earnedDate = parsed.earnedDate; block.querySelector('.ce-earned').value = parsed.earnedDate; }
          if (parsed.expiryDate) { entry.expiryDate = parsed.expiryDate; block.querySelector('.ce-expiry').value = parsed.expiryDate; }
          const got = parsed.earnedDate || parsed.expiryDate;
          statusEl.textContent = got
            ? 'Dates auto-filled below — please review.'
            : 'No dates found — enter them manually; scanned text is below.';
          const shown = text.trim();
          textEl.textContent = shown ? `Scanned text:\n${shown.slice(0, 600)}` : '';
          textEl.style.display = shown ? '' : 'none';
        } catch (err) {
          statusEl.textContent = 'Scan failed — enter the dates manually.';
          showToast(`Couldn't scan: ${err.message}`);
        } finally {
          input.value = '';
        }
      });
    });
  }
  renderCerts();

  container.querySelector('#ep-add-cert').addEventListener('click', () => {
    syncCertsFromDom();
    certEntries.push({ ...emptyCert(), badgeFile: null, certificateFile: null });
    renderCerts();
  });

  // ---- cancel / save / delete ----
  const backTarget = existing ? `/worker/${existing.id}` : '/directory';
  container.querySelector('#ep-cancel').addEventListener('click', () => navigate(backTarget));

  const deleteBtn = container.querySelector('#ep-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const confirmed = await openConfirmDialog({
        title: 'Delete profile',
        message: `Delete ${existing.name}'s profile? This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      deleteBtn.disabled = true;
      try {
        await store.deleteWorker(existing.id);
        showToast('Profile deleted');
        navigate('/directory');
      } catch (err) {
        deleteBtn.disabled = false;
        showActionError(err, `Couldn't delete: ${err.message}`);
      }
    });
  }

  const saveBtn = container.querySelector('#ep-save');
  saveBtn.addEventListener('click', async () => {
    syncCertsFromDom();
    const name = container.querySelector('#f-name').value.trim();
    if (!name) {
      showToast('Full name is required');
      container.querySelector('#f-name').focus();
      return;
    }

    // Reject unsafe verification-link schemes (javascript:, data:, …) before
    // they're stored — these render as clickable links on the public record.
    const badCert = certEntries.find((c) => c.name.trim() && !isSafeExternalUrl(c.verificationUrl));
    if (badCert) {
      showToast('Verification links must start with http:// or https://');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      if (photoFile) {
        photoUrl = await store.uploadImage('photos', photoFile);
      }
      for (const entry of certEntries) {
        if (entry.badgeFile) {
          entry.badgeImageUrl = await store.uploadImage('badges', entry.badgeFile);
        }
        if (entry.certificateFile) {
          entry.certificateFileUrl = await store.uploadImage('certificates', entry.certificateFile);
        }
      }

      const payload = {
        name,
        title: container.querySelector('#f-title').value.trim(),
        department: deptSelect.value === '__new__' ? '' : deptSelect.value,
        location: container.querySelector('#f-location').value.trim(),
        phone: container.querySelector('#f-phone').value.trim(),
        email: container.querySelector('#f-email').value.trim(),
        photoUrl,
        skills,
        certifications: certEntries
          .filter((c) => c.name.trim())
          .map(
            ({
              id,
              name: n,
              issuer,
              typeId,
              badgeImageUrl,
              certificateFileUrl,
              earnedDate,
              expiryDate,
              verificationUrl,
              verificationSource,
              cardNumber,
              verified,
              verifiedBy,
              verifiedAt,
            }) => ({
              id,
              name: n,
              issuer,
              typeId: typeId || null, // preserve the credential-type tag through save
              badgeImageUrl: badgeImageUrl || null,
              certificateFileUrl: certificateFileUrl || null,
              earnedDate,
              expiryDate,
              verificationUrl,
              verificationSource: verificationSource || '',
              cardNumber: cardNumber || '',
              verified: !!verified,
              verifiedBy: verified ? verifiedBy || null : null,
              verifiedAt: verified ? verifiedAt || null : null,
            })
          ),
      };

      const saved = existing ? await store.updateWorker(existing.id, payload) : await store.createWorker(payload);
      showToast('Profile saved');
      navigate(`/worker/${saved.id}`);
    } catch (err) {
      showActionError(err, `Couldn't save: ${err.message}`);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save profile';
    }
  });
}
