// Site clearance: does a worker meet a site's required credential types?
//
// A required type is "met" when the worker holds at least one cert tagged with
// that type (cert.typeId) whose status is valid or expiring — i.e. still within
// its validity today. Fail-closed (FC-R-002): a required type with no matching
// cert, or only expired / no-date certs, is NOT met. "expiring" still counts as
// met (the cert hasn't lapsed) but is surfaced separately so the UI can warn.
//
// Pure and deterministic given a `today` — see tests/clearance.test.mjs.

import { certStatus, RENEWAL_WINDOW_DAYS } from './status.js';

export function evaluateClearance(worker, requiredTypeIds, windowDays = RENEWAL_WINDOW_DAYS, today = new Date()) {
  const certs = worker.certifications || [];
  const metTypeIds = [];
  const expiringTypeIds = [];
  const missingTypeIds = [];

  for (const typeId of requiredTypeIds) {
    let best = null; // 'valid' beats 'expiring' beats nothing
    for (const c of certs) {
      if (!c.typeId || c.typeId !== typeId) continue;
      const s = certStatus(c.expiryDate, windowDays, today);
      if (s === 'valid') { best = 'valid'; break; }
      if (s === 'expiring' && best !== 'valid') best = 'expiring';
    }
    if (best === 'valid') metTypeIds.push(typeId);
    else if (best === 'expiring') { metTypeIds.push(typeId); expiringTypeIds.push(typeId); }
    else missingTypeIds.push(typeId);
  }

  return {
    cleared: missingTypeIds.length === 0,
    metTypeIds,
    expiringTypeIds,
    missingTypeIds,
  };
}
