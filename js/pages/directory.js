import { store } from '../lib/state.js';
import { icons } from '../lib/icons.js';
import { escapeHtml } from '../lib/format.js';
import { workerCardHtml } from '../components/workerCard.js';
import { navigate, redispatch } from '../lib/router.js';
import { openShareDialog } from '../components/shareDialog.js';
import { openImportDialog } from '../components/importDialog.js';
import { printBadgeCards } from '../lib/badgeCards.js';
import { isCompliant, workerNeedsRenewal, summarizeCertStatuses } from '../lib/status.js';
import { tenantName } from '../lib/supabaseClient.js';
import { currentRole } from '../lib/auth.js';
import { roleCan } from '../lib/roles.js';

// A grid of shimmer cards matching the real worker-card footprint, so the
// layout doesn't jump when the data arrives.
function skeletonGridHtml(count = 6) {
  const card = `
    <div class="sk-card">
      <div class="sk-row">
        <div class="skeleton sk-avatar"></div>
        <div style="flex:1;min-width:0;">
          <div class="skeleton sk-line" style="width:60%;"></div>
          <div class="skeleton sk-line" style="width:40%;margin-top:8px;"></div>
          <div class="skeleton sk-line" style="width:50%;margin-top:8px;"></div>
        </div>
      </div>
      <div class="sk-pills"><div class="skeleton sk-pill"></div><div class="skeleton sk-pill"></div></div>
    </div>`;
  return `<div class="worker-grid">${card.repeat(count)}</div>`;
}

export async function renderDirectory(container, params, query) {
  container.innerHTML = skeletonGridHtml();

  let allWorkers;
  try {
    allWorkers = await store.getAll();
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Couldn't load the directory: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Add/import mutate the roster — hidden for roles that can't edit workers
  // (gate). RLS enforces it regardless; this just keeps the buttons honest.
  const canEdit = roleCan(await currentRole(), 'editWorkers');

  const state = {
    q: query.get('q') || '',
    department: 'all',
    certStatus: 'all',
    needsRenewal: false,
  };

  const departments = [...new Set(allWorkers.map((w) => w.department).filter(Boolean))].sort();

  container.innerHTML = `
    <div class="directory-header">
      <div>
        <div class="directory-title">Field Workforce Directory</div>
        <div class="directory-subline" id="directory-subline"></div>
      </div>
      <div class="top-actions">
        <button class="btn btn-neutral-outline" id="print-badges-btn">${icons.download} Print badges</button>
        ${canEdit ? `<button class="btn btn-neutral-outline" id="import-csv-btn">${icons.uploadTray} Import CSV</button>` : ''}
        ${canEdit ? `<button class="btn btn-primary" id="add-worker-btn">${icons.plus} Add worker</button>` : ''}
      </div>
    </div>

    <div class="filter-row">
      <div class="filter-search">
        ${icons.search.replace('class="icon"', 'class="icon icon-sm"')}
        <input type="text" id="dir-search" placeholder="Search by name, skill, or certification…" autocomplete="off">
      </div>
      <label class="filter-chip">
        <select id="dir-department">
          <option value="all">All departments</option>
          ${departments.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('')}
        </select>
        <span class="chev">${icons.chevronDown.replace('class="icon"', 'class="icon icon-sm"')}</span>
      </label>
      <label class="filter-chip">
        <select id="dir-cert-status">
          <option value="all">Cert status</option>
          <option value="valid">Has valid</option>
          <option value="expiring">Has expiring</option>
          <option value="expired">Has expired</option>
          <option value="missing">Missing date</option>
        </select>
        <span class="chev">${icons.chevronDown.replace('class="icon"', 'class="icon icon-sm"')}</span>
      </label>
      <div class="filter-chip" id="dir-needs-renewal">${icons.alert.replace('class="icon"', 'class="icon icon-sm"')} Needs renewal</div>
    </div>

    <div class="worker-grid" id="worker-grid"></div>
  `;

  const grid = container.querySelector('#worker-grid');
  const subline = container.querySelector('#directory-subline');
  const searchInput = container.querySelector('#dir-search');
  const deptSelect = container.querySelector('#dir-department');
  const certSelect = container.querySelector('#dir-cert-status');
  const renewalChip = container.querySelector('#dir-needs-renewal');

  searchInput.value = state.q;

  function matches(w) {
    if (state.department !== 'all' && w.department !== state.department) return false;
    if (state.certStatus !== 'all') {
      const summary = summarizeCertStatuses(w.certifications);
      if (!summary[state.certStatus]) return false;
    }
    if (state.needsRenewal && !workerNeedsRenewal(w)) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      const haystack = [
        w.name,
        w.title,
        w.department,
        ...w.skills,
        ...w.certifications.map((c) => c.name),
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }

  function renderGrid() {
    const filtered = allWorkers.filter(matches);
    const compliantCount = allWorkers.filter(isCompliant).length;
    const compliantPct = allWorkers.length ? Math.round((compliantCount / allWorkers.length) * 100) : 0;

    subline.innerHTML = `${allWorkers.length} workers · ${departments.length} departments · <span class="ok">${compliantPct}% compliant</span>`;

    // Distinguish "you have no workers yet" (first run) from "none match the
    // current filters" — the first is a chance to point at the primary action.
    const emptyHtml = allWorkers.length === 0
      ? `<div class="empty-state" style="grid-column:1/-1;">
           <div class="empty-state-title">No workers yet</div>
           ${canEdit ? 'Add your first worker, or import a roster from CSV.' : 'No workers have been added yet.'}
           ${canEdit ? `<div><button class="btn btn-primary" id="empty-add-worker">${icons.plus} Add worker</button></div>` : ''}
         </div>`
      : `<div class="empty-state" style="grid-column:1/-1;">No workers match your filters.</div>`;

    grid.innerHTML = filtered.length ? filtered.map(workerCardHtml).join('') : emptyHtml;

    grid.querySelector('#empty-add-worker')?.addEventListener('click', () => navigate('/worker/new'));

    grid.querySelectorAll('[data-worker-id]').forEach((card) => {
      card.addEventListener('click', () => navigate(`/worker/${card.dataset.workerId}`));
      card.addEventListener('keydown', (e) => {
        // Enter and Space both activate a role="button" element, per WAI-ARIA.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate(`/worker/${card.dataset.workerId}`);
        }
      });
    });
    grid.querySelectorAll('[data-share-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openShareDialog(btn.dataset.shareId);
      });
    });
  }

  searchInput.addEventListener('input', () => {
    state.q = searchInput.value;
    renderGrid();
  });
  deptSelect.addEventListener('change', () => {
    state.department = deptSelect.value;
    renderGrid();
  });
  certSelect.addEventListener('change', () => {
    state.certStatus = certSelect.value;
    renderGrid();
  });
  renewalChip.addEventListener('click', () => {
    state.needsRenewal = !state.needsRenewal;
    renewalChip.classList.toggle('active', state.needsRenewal);
    renderGrid();
  });
  container.querySelector('#add-worker-btn')?.addEventListener('click', () => navigate('/worker/new'));
  container.querySelector('#import-csv-btn')?.addEventListener('click', () => {
    openImportDialog(() => redispatch());
  });
  // Prints whatever's currently in view (respects the active filters/search),
  // so "print badges for the Electrical dept" is just filter-then-print.
  container.querySelector('#print-badges-btn').addEventListener('click', () => {
    printBadgeCards(allWorkers.filter(matches), { tenantName });
  });

  renderGrid();
}
