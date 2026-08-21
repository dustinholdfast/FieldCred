// One place that decides what a gate scan means, and one place that logs it.
//
// WHY THIS EXISTS: before the companion app there were two callers of "check
// this worker against this site" — js/pages/publicRecord.js (the /r/:slug
// banner) and, implicitly, the record_gate_scan() RPC on the server. The
// companion app (js/pages/gateApp.js) adds a third surface with much louder
// output: a full-screen CLEARED / NOT CLEARED poster a guard acts on in about
// two seconds. Three copies of "is this worker cleared, and was it logged" is
// precisely how a green screen and a 'blocked' audit row come to disagree
// about the same scan, so all three client paths route through here.
//
// Split deliberately in two:
//   * deriveVerdict() is PURE — no DOM, no network, no clock of its own. It is
//     what tests/gateVerdict.test.mjs exercises, and it is the only thing that
//     decides cleared vs not.
//   * resolveWorker/resolveSite/logGateScan/buildVerdict do the IO, including
//     the offline-cache fallback and the audit-log queue.
//
// The decision itself is still js/lib/clearance.js — this module does NOT
// re-implement it. It calls evaluateClearance() for the verdict and then does
// a separate, display-only pass to work out WHICH cert to name on screen
// ("expired MAY 12"). If those two ever disagree, clearance.js wins.

import { evaluateClearance } from './clearance.js';
import { certStatus, RENEWAL_WINDOW_DAYS } from './status.js';
import { store } from './state.js';
import {
  cacheWorkerRecord,
  getCachedWorkerRecord,
  cacheSite,
  getCachedSite,
  queueScan,
} from './offlineCache.js';

// Mirrors the `result` check constraint on gate_scans (migration 009) so the
// client's vocabulary and the audit log's can't drift apart.
export const VERDICT = {
  CLEARED: 'cleared',
  BLOCKED: 'blocked',
  NO_REQUIREMENTS: 'no_requirements',
  UNKNOWN_WORKER: 'unknown_worker',
  UNKNOWN_SITE: 'unknown_site',
};

const MONTHS_UPPER = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Expiry as the verdict screen shows it: a date this year reads "AUG 15",
// anything else reads just "2028". A guard scanning a queue of workers needs
// "is this about to lapse", not a full date — the year alone answers that for
// anything far out, and the day matters only when it's close.
export function shortExpiry(isoDate, today = new Date()) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).split('-').map(Number);
  if (!y || !m) return String(isoDate);
  if (y !== today.getFullYear()) return String(y);
  return `${MONTHS_UPPER[m - 1] || ''} ${d || ''}`.trim();
}

// The cert that best satisfies one required type, and its status. Same
// preference order as clearance.js (valid beats expiring), extended with a
// third tier clearance.js has no need for: if nothing valid or expiring
// exists, keep the most recently expired cert so the screen can say "expired
// MAY 12" instead of the much less useful "not on file". A cert with no date
// at all never wins that tier — "no date" is not evidence of anything.
function bestCertForType(certs, typeId, windowDays, today) {
  let best = null;
  for (const cert of certs) {
    if (!cert.typeId || cert.typeId !== typeId) continue;
    const status = certStatus(cert.expiryDate, windowDays, today);
    if (status === 'valid') return { cert, status };
    if (status === 'expiring') {
      best = { cert, status };
      continue;
    }
    if (status === 'expired' && (!best || best.status !== 'expiring')) {
      if (!best || String(cert.expiryDate) > String(best.cert.expiryDate)) best = { cert, status };
    }
  }
  return best;
}

/**
 * Turns a worker + site into everything the verdict screen renders.
 *
 * Pure. `worker` may be null (badge didn't resolve), `site` may be null (this
 * device isn't paired, or its slug no longer resolves) — both are normal at a
 * gate and both fail closed, never to a bare "cleared".
 *
 * @param {object|null} worker  as returned by store.getBySlug()
 * @param {object|null} site    as returned by store.getPublicSite()
 * @returns {{kind: string, met: object[], expiring: string[], missing: object[]}}
 */
export function deriveVerdict(worker, site, { windowDays = RENEWAL_WINDOW_DAYS, today = new Date() } = {}) {
  const empty = { met: [], expiring: [], missing: [] };
  if (!site) return { kind: VERDICT.UNKNOWN_SITE, ...empty };
  if (!worker) return { kind: VERDICT.UNKNOWN_WORKER, ...empty };

  const requiredTypes = site.requiredTypes || [];
  // No requirements is NOT clearance. A site nobody has configured yet can't
  // vouch for anyone, so this gets its own screen rather than a green one —
  // same rule as gateBannerHtml() in publicRecord.js.
  if (!requiredTypes.length) return { kind: VERDICT.NO_REQUIREMENTS, ...empty };

  const certs = worker.certifications || [];
  const nameById = new Map(requiredTypes.map((t) => [t.id, t.name]));
  const requiredIds = requiredTypes.map((t) => t.id);

  // The verdict itself — clearance.js is the authority, not the loop below.
  const result = evaluateClearance(worker, requiredIds, windowDays, today);

  const met = result.metTypeIds.map((typeId) => {
    const hit = bestCertForType(certs, typeId, windowDays, today);
    return {
      typeId,
      typeName: nameById.get(typeId) || 'Required credential',
      // A met type always has a cert behind it, but stay defensive: this
      // renders on a screen a guard trusts, so it must not throw on a shape
      // it didn't expect.
      certName: hit?.cert?.name || nameById.get(typeId) || 'Required credential',
      status: hit?.status || 'valid',
      expiryDate: hit?.cert?.expiryDate || '',
    };
  });

  const missing = result.missingTypeIds.map((typeId) => {
    const hit = bestCertForType(certs, typeId, windowDays, today);
    const expiredOn = hit?.status === 'expired' ? hit.cert.expiryDate : '';
    return {
      typeId,
      typeName: nameById.get(typeId) || 'Required credential',
      expiredOn,
      // The single line the NOT CLEARED poster prints. Naming the expiry when
      // there is one turns "go find your supervisor" into "your confined
      // space card lapsed in May" — the difference between a worker who is
      // confused and one who knows what to fix.
      line: expiredOn
        ? `${nameById.get(typeId) || 'Required credential'} — expired ${shortExpiry(expiredOn, today)}`
        : `${nameById.get(typeId) || 'Required credential'} — not on file`,
    };
  });

  return {
    kind: result.cleared ? VERDICT.CLEARED : VERDICT.BLOCKED,
    met,
    expiring: result.expiringTypeIds.map((id) => nameById.get(id) || 'Required credential'),
    missing,
  };
}

// ---- IO ------------------------------------------------------------------

// Live fetch, falling back to whatever this device cached the last time it
// saw this worker online. Distinguishes "no such worker" (a clean null — the
// badge is genuinely unknown) from "no signal" (fetch threw), because those
// two mean completely different things at a gate: the first is an
// UNRECOGNIZED BADGE verdict, the second is a reason to reach for the cache.
export async function resolveWorker(slug) {
  try {
    const worker = await store.getBySlug(slug);
    // Only cache the clean-success case — never a null. Caching "not found"
    // would let a worker whose sharing was since turned off keep resolving
    // from this device's cache. (Same reasoning as publicRecord.js.)
    if (worker) {
      try { await cacheWorkerRecord(slug, worker); } catch {}
    }
    return { worker, fromCache: false, cachedAt: null, noSignal: false };
  } catch {
    try {
      const cached = await getCachedWorkerRecord(slug);
      if (cached) return { worker: cached.data, fromCache: true, cachedAt: cached.cachedAt, noSignal: true };
    } catch {}
    return { worker: null, fromCache: false, cachedAt: null, noSignal: true };
  }
}

export async function resolveSite(slug) {
  if (!slug) return { site: null, fromCache: false, cachedAt: null, noSignal: false };
  try {
    const site = await store.getPublicSite(slug);
    if (site) {
      try { await cacheSite(slug, site); } catch {}
    }
    return { site, fromCache: false, cachedAt: null, noSignal: false };
  } catch {
    try {
      const cached = await getCachedSite(slug);
      if (cached) return { site: cached.data, fromCache: true, cachedAt: cached.cachedAt, noSignal: true };
    } catch {}
    return { site: null, fromCache: false, cachedAt: null, noSignal: true };
  }
}

/**
 * Writes the scan to the server-side audit log, or queues it if that fails.
 *
 * Never throws and never returns a reason to block the UI — a guard must get
 * a verdict whether or not the logging round trip worked. Returns whether the
 * scan is queued rather than logged, purely so the screen can say "QUEUED FOR
 * SITE LOG" instead of claiming it landed.
 *
 * The RPC re-derives clearance server-side and ignores anything we computed
 * here; that's the point (see migration 009). This function deliberately does
 * not pass the client's verdict anywhere.
 */
export async function logGateScan(siteSlug, workerSlug) {
  if (!siteSlug || !workerSlug) return { logged: false, queued: false };
  try {
    await store.recordGateScan(siteSlug, workerSlug);
    return { logged: true, queued: false };
  } catch {
    try {
      await queueScan(siteSlug, workerSlug);
      return { logged: false, queued: true };
    } catch {
      // No IndexedDB (private mode, quota) AND no signal. Nothing left to try
      // — say so on screen rather than implying an audit row exists.
      return { logged: false, queued: false };
    }
  }
}

/**
 * The whole flow for one check: resolve, decide, log.
 *
 * `via` is 'scan' or 'lookup' — a manual lookup gets an identical clearance
 * check and an identical audit row, and differs only in the kicker on screen.
 * Set `log:false` for a check that must NOT be written to the audit log; the
 * only such case today is a badge from another tenant (see gateApp.js).
 */
export async function buildVerdict(siteSlug, workerSlug, { via = 'scan', log = true, today = new Date() } = {}) {
  const [w, s] = await Promise.all([resolveWorker(workerSlug), resolveSite(siteSlug)]);
  const verdict = deriveVerdict(w.worker, s.site, { today });

  // The older of the two cache stamps is the honest "as of" bound for what's
  // on screen — a fresh site record doesn't make a day-old worker record new.
  const fromCache = w.fromCache || s.fromCache;
  const cachedAt = [w.cachedAt, s.cachedAt].filter(Boolean).sort()[0] || null;

  let logResult = { logged: false, queued: false };
  if (log && siteSlug && workerSlug) {
    logResult = await logGateScan(siteSlug, workerSlug);
  }

  return {
    ...verdict,
    via,
    at: today,
    worker: w.worker,
    site: s.site,
    fromCache,
    cachedAt,
    noSignal: w.noSignal || s.noSignal,
    logged: logResult.logged,
    queued: logResult.queued,
    loggable: log,
  };
}
