import { store } from '../lib/state.js';
import { icons } from '../lib/icons.js';
import { escapeHtml } from '../lib/format.js';
import { workerCardHtml } from '../components/workerCard.js';
import { navigate, redispatch } from '../lib/router.js';
import { openShareDialog } from '../components/shareDialog.js';
import { openImportDialog } from '../components/importDialog.js';
import { printBadgeCards } from '../lib/badgeCards.js';
import { isCompliant, workerNeedsRenewal, summarizeCertStatuses } from '../lib/status.js';
import { tenantName, tenantSlug } from '../lib/backendClient.js';
import { currentRole, getSession, setAppSession } from '../lib/auth.js';
import { isPermissionError, roleCan } from '../lib/roles.js';
import { isWakeStopped, wakingHtml, withWakeRetry } from '../lib/wake.js';
import {
  QUESTION_MAX,
  applyDirectoryFilter,
  chipParts,
  countAnswer,
  filterNeedsRoster,
  looksLikeQuestion,
  validateFilter,
  valueFromChip,
  workerMatchesFilter,
} from '../lib/directoryFilter.js';

const EMPTY_ROSTER = { sites: [], credentialTypes: [], requiredTypes: [], assignments: [] };

function plainHaystack(worker) {
  return [
    worker.name,
    worker.title,
    worker.department,
    ...(worker.skills || []),
    ...(worker.certifications || []).map((cert) => cert.name),
  ].join(' ').toLowerCase();
}

function aiFailureText(status, body) {
  const fromWorker = typeof body?.error === 'string' ? body.error.trim() : '';
  const safeWorker = fromWorker.length > 0 && fromWorker.length <= 160 && !/[\u0000-\u001f]/.test(fromWorker);
  if (status === 429) return 'Too many questions. Wait a moment and try again.';
  if (status === 502 || status === 503) {
    if (safeWorker) return fromWorker;
    return 'Ask is temporarily unavailable. Try again in a moment.';
  }
  if (status === 400) return 'That question is too long.';
  return "That question couldn't be turned into a filter.";
}

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

function directoryFailureHtml(err) {
  const denied = isPermissionError(err);
  // Never print the Postgres message. 42501 is "permission denied for table
  // workers" and that string is not something to put on screen.
  const detail = denied
    ? "You don't have access to the worker directory."
    : "The database didn't respond. Check your connection and try again.";
  return `<div class="empty-state" role="alert">
    <div class="empty-state-title">Couldn't load the directory.</div>
    <div>${detail}</div>
    <button class="btn btn-primary" type="button" id="directory-retry">Retry</button>
  </div>`;
}

export async function renderDirectory(container, params, query) {
  container.innerHTML = skeletonGridHtml();
  const renderToken = {};
  container.__directoryRender = renderToken;
  const stillHere = () => container.__directoryRender === renderToken;

  let allWorkers;
  try {
    allWorkers = await withWakeRetry(async () => {
      // A stale UI session (Neon client already signed out) must not fall
      // through to the anonymous token. That token is granted nothing on
      // workers, and the select comes back as permission denied.
      const session = await getSession();
      if (!session) {
        const err = new Error('Sign in required');
        err.status = 401;
        throw err;
      }
      return store.getAll();
    }, {
      isCurrent: stillHere,
      onWaiting() {
        if (stillHere()) container.innerHTML = wakingHtml();
      },
    });
  } catch (err) {
    if (!stillHere() || isWakeStopped(err)) return;
    if (err.status === 401 && !isPermissionError(err)) {
      setAppSession(null);
      navigate('/login?next=/directory');
      return;
    }
    container.innerHTML = directoryFailureHtml(err);
    container.querySelector('#directory-retry')?.addEventListener('click', () => {
      renderDirectory(container, params, query);
    });
    return;
  }
  if (!stillHere()) return;

  // Add/import mutate the roster — hidden for roles that can't edit workers
  // (gate). RLS enforces it regardless; this just keeps the buttons honest.
  const canEdit = roleCan(await currentRole(), 'editWorkers');

  const state = {
    q: query.get('q') || '',
    department: 'all',
    certStatus: 'all',
    needsRenewal: false,
    ask: false,
    holdPlain: false,
    askAvailable: true,
    askPending: false,
    filter: null,
    mode: null,
    label: '',
    roster: null,
    aiError: '',
    aiNote: '',
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
        <input type="text" id="dir-search" placeholder="Search by name, skill, or certification, or ask a question…" autocomplete="off">
      </div>
      <button type="button" class="filter-chip" id="dir-ask" aria-pressed="false">Ask</button>
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
    <div class="ai-filter" id="ai-filter" hidden></div>

    <div class="worker-grid" id="worker-grid"></div>
  `;

  const grid = container.querySelector('#worker-grid');
  const subline = container.querySelector('#directory-subline');
  const searchInput = container.querySelector('#dir-search');
  const deptSelect = container.querySelector('#dir-department');
  const certSelect = container.querySelector('#dir-cert-status');
  const renewalChip = container.querySelector('#dir-needs-renewal');
  const askBtn = container.querySelector('#dir-ask');
  const aiHost = container.querySelector('#ai-filter');

  searchInput.value = state.q;
  let askSeq = 0;
  let askTimer = 0;

  function wantsAsk() {
    if (state.holdPlain) return false;
    const q = state.q.trim();
    if (!q) return false;
    return state.ask || looksLikeQuestion(q);
  }

  function matches(w) {
    if (state.department !== 'all' && w.department !== state.department) return false;
    if (state.certStatus !== 'all') {
      const summary = summarizeCertStatuses(w.certifications);
      if (!summary[state.certStatus]) return false;
    }
    if (state.needsRenewal && !workerNeedsRenewal(w)) return false;
    if (state.filter) return workerMatchesFilter(w, state.filter, state.roster || EMPTY_ROSTER, new Date());
    if (state.askPending || state.aiError) return true;
    const q = state.q.trim().toLowerCase();
    if (q && !plainHaystack(w).includes(q)) return false;
    return true;
  }

  function currentCount() {
    if (state.mode !== 'count' || !state.filter) return null;
    return applyDirectoryFilter(allWorkers, state.filter, state.roster || EMPTY_ROSTER, new Date()).length;
  }

  function aiSignature() {
    return JSON.stringify({
      filter: state.filter,
      mode: state.mode,
      count: currentCount(),
      error: state.aiError,
      note: state.aiNote,
      pending: state.askPending,
    });
  }

  function renderAi() {
    const sig = aiSignature();
    if (aiHost.dataset.sig === sig) return;
    aiHost.dataset.sig = sig;
    const bits = [];
    if (state.askPending) bits.push('<span class="ai-filter-note">Reading your question…</span>');
    if (state.aiNote) bits.push(`<span class="ai-filter-note">${escapeHtml(state.aiNote)}</span>`);
    if (state.aiError) bits.push(`<span class="ai-filter-error" role="alert">${escapeHtml(state.aiError)}</span>`);
    if (!state.askPending && state.mode === 'count' && state.filter) {
      const label = state.filter.conditions.length ? 'match' : 'workers';
      bits.push(`<span class="ai-count" role="status">${escapeHtml(countAnswer(currentCount(), label))}</span>`);
    }
    if (state.filter && state.filter.conditions.length) {
      state.filter.conditions.forEach((condition, index) => {
        const parts = chipParts(condition);
        bits.push(
          `<span class="ai-chip" data-chip="${escapeHtml(parts.text)}">`
          + `<span>${escapeHtml(parts.label)}</span>`
          + `<input data-ai-value="${index}" value="${escapeHtml(parts.shown)}" aria-label="${escapeHtml(parts.text)}">`
          + `<button type="button" class="ai-chip-x" data-ai-clear="${index}" aria-label="Remove ${escapeHtml(parts.text)}">×</button>`
          + `</span>`,
        );
      });
    }
    if (state.filter && (state.mode === 'count' || state.filter.conditions.length)) {
      bits.push('<button type="button" class="ai-clear" id="ai-clear-all">Clear</button>');
    }
    const show = bits.length > 0;
    aiHost.hidden = !show;
    aiHost.innerHTML = bits.join('');
    aiHost.querySelectorAll('[data-ai-value]').forEach((input) => {
      input.addEventListener('input', () => editChip(Number(input.dataset.aiValue), input.value));
    });
    aiHost.querySelectorAll('[data-ai-clear]').forEach((btn) => {
      btn.addEventListener('click', () => removeChip(Number(btn.dataset.aiClear)));
    });
    aiHost.querySelector('#ai-clear-all')?.addEventListener('click', clearAsk);
  }

  function editChip(index, shown) {
    if (!state.filter) return;
    const draft = {
      conditions: state.filter.conditions.map((condition, i) => (
        i === index
          ? { field: condition.field, op: condition.op, value: valueFromChip(shown) }
          : { field: condition.field, op: condition.op, value: condition.value }
      )),
    };
    try {
      state.filter = validateFilter(draft, { today: new Date() });
      state.aiError = '';
      aiHost.querySelector('.ai-filter-error')?.remove();
      aiHost.dataset.sig = aiSignature();
      renderGrid();
    } catch {
      state.aiError = 'That value is not allowed.';
      const alert = aiHost.querySelector('.ai-filter-error');
      if (alert) alert.textContent = state.aiError;
      else renderAi();
    }
  }

  function removeChip(index) {
    if (!state.filter) return;
    const kept = state.filter.conditions.filter((_, i) => i !== index);
    if (!kept.length) {
      clearAsk();
      return;
    }
    state.filter = { conditions: kept };
    renderGrid();
  }

  function clearAsk() {
    state.holdPlain = true;
    state.ask = false;
    state.filter = null;
    state.mode = null;
    state.label = '';
    state.aiError = '';
    state.aiNote = '';
    state.askPending = false;
    askBtn.classList.remove('active');
    askBtn.setAttribute('aria-pressed', 'false');
    window.clearTimeout(askTimer);
    renderGrid();
  }

  function renderGrid() {
    renderAi();
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

  function scheduleAsk(delay = 400) {
    window.clearTimeout(askTimer);
    const q = state.q.trim();
    if (!wantsAsk()) {
      state.askPending = false;
      if (!state.holdPlain) {
        state.filter = null;
        state.mode = null;
        state.label = '';
        state.aiError = '';
        state.aiNote = '';
      }
      renderGrid();
      return;
    }
    if (q.length > QUESTION_MAX) {
      state.askPending = false;
      state.filter = null;
      state.mode = null;
      state.label = '';
      state.aiNote = '';
      state.aiError = 'That question is too long.';
      renderGrid();
      return;
    }
    if (state.askAvailable === false) {
      state.askPending = false;
      state.filter = null;
      state.mode = null;
      state.label = '';
      state.aiError = '';
      state.aiNote = 'Ask is off, so this stays a plain text search.';
      renderGrid();
      return;
    }
    state.aiError = '';
    state.aiNote = '';
    state.askPending = true;
    renderGrid();
    const seq = ++askSeq;
    askTimer = window.setTimeout(() => { runAsk(seq); }, delay);
  }

  async function loadRoster() {
    if (state.roster) return state.roster;
    const [sites, credentialTypes, requiredTypes, assignments] = await withWakeRetry(() => Promise.all([
      store.sites(),
      store.credentialTypes(),
      store.allSiteRequiredTypes(),
      store.allSiteAssignments(),
    ]), {
      isCurrent: stillHere,
      onWaiting() {
        if (!stillHere()) return;
        state.aiNote = 'Waking up the database…';
        renderAi();
      },
    });
    state.roster = { sites, credentialTypes, requiredTypes, assignments };
    return state.roster;
  }

  async function runAsk(seq) {
    if (!stillHere() || seq !== askSeq) return;
    const question = state.q.trim();
    try {
      const session = await withWakeRetry(() => getSession(), {
        isCurrent: stillHere,
        onWaiting() {
          if (!stillHere()) return;
          state.aiNote = 'Waking up the database…';
          renderAi();
        },
      });
      // Neon maps the auth JWT onto access_token. The raw better-auth
      // session uses token. Either one is the signed-in bearer.
      const token = session?.access_token || session?.token;
      if (!token) {
        setAppSession(null);
        navigate('/login?next=/directory');
        return;
      }
      const res = await fetch('./directory-search.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tenant: tenantSlug, question }),
      });
      const body = await res.json().catch(() => ({}));
      if (!stillHere() || seq !== askSeq) return;
      if (res.status === 401) {
        setAppSession(null);
        navigate('/login?next=/directory');
        return;
      }
      state.askPending = false;
      if (body.enabled === false) {
        state.askAvailable = false;
        state.filter = null;
        state.mode = null;
        state.label = '';
        state.aiError = '';
        state.aiNote = 'Ask is off, so this stays a plain text search.';
        renderGrid();
        return;
      }
      if (!res.ok || !body.filter || (body.mode != null && body.mode !== 'count' && body.mode !== 'filter')) {
        state.filter = null;
        state.mode = null;
        state.label = '';
        state.aiNote = '';
        state.aiError = aiFailureText(res.status, body);
        renderGrid();
        return;
      }
      const mode = body.mode === 'count' ? 'count' : 'filter';
      const slim = {
        conditions: (body.filter.conditions || []).map((condition) => ({
          field: condition.field,
          op: condition.op,
          value: condition.value,
        })),
      };
      state.filter = validateFilter(slim, { today: new Date(), allowEmpty: mode === 'count' });
      state.mode = mode;
      state.label = mode === 'count' ? (state.filter.conditions.length ? 'match' : 'workers') : '';
      state.aiError = '';
      state.aiNote = '';
      if (filterNeedsRoster(state.filter)) await loadRoster();
      if (!stillHere() || seq !== askSeq) return;
      renderGrid();
    } catch (err) {
      if (!stillHere() || isWakeStopped(err) || seq !== askSeq) return;
      if (err.status === 401 && !isPermissionError(err)) {
        setAppSession(null);
        navigate('/login?next=/directory');
        return;
      }
      state.askPending = false;
      state.filter = null;
      state.mode = null;
      state.label = '';
      state.aiNote = '';
      state.aiError = "That question couldn't be turned into a filter.";
      renderGrid();
    }
  }

  searchInput.addEventListener('input', () => {
    state.q = searchInput.value;
    state.holdPlain = false;
    scheduleAsk();
  });
  askBtn.addEventListener('click', () => {
    state.ask = !state.ask;
    state.holdPlain = false;
    askBtn.classList.toggle('active', state.ask);
    askBtn.setAttribute('aria-pressed', state.ask ? 'true' : 'false');
    scheduleAsk(0);
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
  if (wantsAsk()) scheduleAsk(0);
}
