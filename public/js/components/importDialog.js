import { icons } from '../lib/icons.js';
import { escapeHtml } from '../lib/format.js';
import { store, makeId } from '../lib/state.js';
import { parseCSVWithHeader, toCSV } from '../lib/csv.js';
import { normalizeDateString } from '../lib/certParse.js';
import { showToast } from './toast.js';

// Certs are the most painful data to hand-enter and the actual reason people
// buy the product, so the import covers them too — up to a few per worker via
// flat "Cert N ..." columns (CSV is one row per worker). Extra empty slots are
// simply ignored.
const CERT_SLOTS = [1, 2, 3];

const TEMPLATE_HEADERS = [
  'Name', 'Title', 'Department', 'Location', 'Phone', 'Email', 'Skills',
  'Cert 1 Name', 'Cert 1 Issuer', 'Cert 1 Expires',
  'Cert 2 Name', 'Cert 2 Issuer', 'Cert 2 Expires',
];
const TEMPLATE_EXAMPLE = [
  'Jane Doe',
  'Journeyman Electrician',
  'Electrical',
  'Houston, TX',
  '(555) 000-1111',
  'jane@example.com',
  'Conduit bending; Motor controls; Blueprint reading',
  'OSHA 30-Hour Construction', 'U.S. OSHA', '2028-06-02',
  'First Aid / CPR', 'American Red Cross', '2026-06-01',
];

function downloadTemplate() {
  const csv = toCSV(TEMPLATE_HEADERS, [TEMPLATE_EXAMPLE]);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'fieldcred-worker-import-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Maps a raw CSV row (lowercased header keys from parseCSVWithHeader) to a
// worker-shaped object, or returns { error } if it's not usable.
function rowToWorkerCandidate(raw) {
  const name = (raw.name || '').trim();
  if (!name) return { error: 'Missing name' };

  const email = (raw.email || '').trim();
  if (email && !EMAIL_RE.test(email)) return { error: `Invalid email "${email}"` };

  const skills = (raw.skills || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  const certifications = [];
  for (const n of CERT_SLOTS) {
    const certName = (raw[`cert ${n} name`] || '').trim();
    if (!certName) continue; // empty slot
    const rawExpires = (raw[`cert ${n} expires`] || '').trim();
    const expires = normalizeDateString(rawExpires); // '' if blank, ISO if recognized, null if unparseable
    if (expires === null) {
      return { error: `Cert ${n} "expires" isn't a recognizable date (got "${rawExpires}") — use YYYY-MM-DD or M/D/YYYY` };
    }
    certifications.push({
      id: makeId(),
      name: certName,
      issuer: (raw[`cert ${n} issuer`] || '').trim(),
      typeId: null, // auto-mapped to a credential type by name after parsing (see handleFile)
      badgeImageUrl: null,
      certificateFileUrl: null,
      earnedDate: '',
      expiryDate: expires,
      // Verification (js/lib/verification.js) always starts blank/unverified
      // from a bulk import — there's no column for it in the CSV template,
      // and attestation has to be a deliberate per-cert admin action anyway.
      verificationUrl: '',
      verificationSource: '',
      cardNumber: '',
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
    });
  }

  return {
    worker: {
      name,
      title: (raw.title || '').trim(),
      department: (raw.department || '').trim(),
      location: (raw.location || '').trim(),
      phone: (raw.phone || '').trim(),
      email,
      skills,
      certifications,
    },
  };
}

// onImported(count) — called after a successful import so the caller
// (Directory page) can refresh its list.
export function openImportDialog(onImported) {
  const root = document.getElementById('modal-root');
  let rows = null; // { valid: [...], errors: [{line, reason}], duplicates: [...] } once a file's parsed

  function render() {
    root.innerHTML = `
      <div class="modal-overlay" id="import-overlay">
        <div class="share-modal" style="width:560px;" role="dialog" aria-modal="true" aria-label="Import workers">
          <div class="share-modal-header">
            <div>
              <h2>Import workers</h2>
              <div class="sub">Bulk-create workers from a CSV file</div>
            </div>
            <div class="icon-btn" id="import-close" title="Close">${icons.close}</div>
          </div>
          <div style="padding:22px;">
            <div class="row-btn" id="import-download-template" style="cursor:pointer;margin-bottom:16px;">
              ${icons.download} Download CSV template
            </div>

            <div class="dropzone" style="text-align:center;">
              <div class="dz-title">Choose a CSV file</div>
              <div class="dz-sub">Name, Title, Department, Location, Phone, Email, Skills, plus optional Cert 1–3 columns. Skills use semicolons; cert dates accept YYYY-MM-DD or M/D/YYYY. Download the template for the exact headers.</div>
              <input type="file" accept=".csv,text/csv" id="import-file-input">
            </div>

            <div id="import-preview"></div>

            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;">
              <button class="btn btn-neutral-outline" id="import-cancel">Cancel</button>
              <button class="btn btn-primary" id="import-confirm" disabled>Import</button>
            </div>
          </div>
        </div>
      </div>
    `;

    root.querySelector('#import-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'import-overlay') close();
    });
    root.querySelector('#import-close').addEventListener('click', close);
    root.querySelector('#import-cancel').addEventListener('click', close);
    root.querySelector('#import-download-template').addEventListener('click', downloadTemplate);

    root.querySelector('#import-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await handleFile(file);
    });

    root.querySelector('#import-confirm').addEventListener('click', handleConfirm);

    document.addEventListener('keydown', onKeydown);
  }

  async function handleFile(file) {
    const previewEl = root.querySelector('#import-preview');
    previewEl.innerHTML = `<div class="empty-state">Reading file…</div>`;

    let raw;
    try {
      raw = await readFileAsText(file);
    } catch {
      previewEl.innerHTML = `<div class="empty-state">Couldn't read that file.</div>`;
      return;
    }

    const parsed = parseCSVWithHeader(raw);
    if (!parsed.length) {
      previewEl.innerHTML = `<div class="empty-state">No rows found in that file.</div>`;
      return;
    }

    let existing, planLimits;
    try {
      [existing, planLimits] = await Promise.all([store.getAll(), store.getPlanLimits()]);
    } catch (err) {
      previewEl.innerHTML = `<div class="empty-state">Couldn't check existing workers: ${escapeHtml(err.message)}</div>`;
      return;
    }
    const existingEmails = new Set(existing.map((w) => w.email.toLowerCase()).filter(Boolean));

    // Credential-type catalog for auto-tagging imported certs (point 2). Best-
    // effort and separate from the load above — on a tenant without migration
    // 007 the table is absent, and import should still work (certs just stay
    // untagged, which is fail-closed).
    let credTypeByName = new Map();
    try {
      const types = await store.credentialTypes();
      credTypeByName = new Map(types.map((t) => [t.name.trim().toLowerCase(), t.id]));
    } catch {
      // credential_types not available on this tenant
    }

    const valid = [];
    const errors = [];
    const duplicates = [];
    const seenInFile = new Set();

    parsed.forEach((raw, i) => {
      const line = i + 2; // +1 for header row, +1 for 1-indexing
      const result = rowToWorkerCandidate(raw);
      if (result.error) {
        errors.push({ line, reason: result.error });
        return;
      }
      const email = result.worker.email.toLowerCase();
      if (email && (existingEmails.has(email) || seenInFile.has(email))) {
        duplicates.push({ line, name: result.worker.name, email: result.worker.email });
        return;
      }
      if (email) seenInFile.add(email);
      valid.push(result.worker);
    });

    // Trim to whatever's left under the plan cap rather than letting the
    // whole batch fail server-side (a single INSERT statement, so the DB
    // trigger in supabase/schema.sql would otherwise reject the entire
    // import once any row crosses the limit).
    let overLimitCount = 0;
    if (planLimits.maxWorkers != null) {
      const remaining = Math.max(0, planLimits.maxWorkers - existing.length);
      if (valid.length > remaining) {
        overLimitCount = valid.length - remaining;
        valid.length = remaining;
      }
    }

    // Auto-tag imported certs with a credential type by exact normalized name
    // match, so they immediately count toward site clearance (point 2). Only
    // fills an empty typeId; unmatched certs stay untagged (fail-closed).
    let certsTagged = 0;
    for (const w of valid) {
      for (const c of w.certifications) {
        if (c.typeId) continue;
        const id = credTypeByName.get((c.name || '').trim().toLowerCase());
        if (id) { c.typeId = id; certsTagged++; }
      }
    }

    rows = { valid, errors, duplicates };

    previewEl.innerHTML = `
      <div style="margin-top:16px;padding:14px;background:var(--surface-subtle);border-radius:9px;font-size:13px;">
        <div style="color:var(--valid-text);font-weight:600;">${valid.length} worker${valid.length === 1 ? '' : 's'} ready to import</div>
        ${certsTagged ? `<div style="color:var(--text-secondary);margin-top:4px;">${certsTagged} cert${certsTagged === 1 ? '' : 's'} matched a credential type</div>` : ''}
        ${duplicates.length ? `<div style="color:var(--expiring-text-dark);margin-top:4px;">${duplicates.length} skipped — email already in use (row${duplicates.length === 1 ? '' : 's'} ${duplicates.map((d) => d.line).join(', ')})</div>` : ''}
        ${errors.length ? `<div style="color:var(--expired-text);margin-top:4px;">${errors.length} skipped — ${errors.map((e) => `row ${e.line}: ${escapeHtml(e.reason)}`).join('; ')}</div>` : ''}
        ${overLimitCount ? `<div style="color:var(--expired-text);margin-top:4px;">${overLimitCount} skipped — over your plan's ${planLimits.maxWorkers}-worker limit</div>` : ''}
      </div>
    `;

    root.querySelector('#import-confirm').disabled = valid.length === 0;
  }

  async function handleConfirm() {
    if (!rows || !rows.valid.length) return;
    const btn = root.querySelector('#import-confirm');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const created = await store.bulkCreateWorkers(rows.valid);
      showToast(`Imported ${created.length} worker${created.length === 1 ? '' : 's'}`);
      close();
      onImported?.(created.length);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Import';
      showToast(`Couldn't import: ${err.message}`);
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  function close() {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKeydown);
  }

  render();
}
