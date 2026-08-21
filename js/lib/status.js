// Certification status is always derived from expiryDate vs today — never stored.
// valid: expiry > renewal window out · expiring: within the window · expired: in
// the past · missing: no expiry date on file (needs one entered — it is NOT the
// same as "valid", which is the bug this state fixes: a blank date used to fall
// through to 'valid' and silently inflate the compliance count).

export const RENEWAL_WINDOW_DAYS = 60;

export function daysUntil(isoDate, today = new Date()) {
  const target = new Date(isoDate + 'T00:00:00');
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - start) / 86400000);
}

export function certStatus(isoExpiryDate, windowDays = RENEWAL_WINDOW_DAYS, today = new Date()) {
  if (!isoExpiryDate) return 'missing';
  const diff = daysUntil(isoExpiryDate, today);
  if (Number.isNaN(diff)) return 'missing';
  if (diff < 0) return 'expired';
  if (diff <= windowDays) return 'expiring';
  return 'valid';
}

export const STATUS_META = {
  valid: { label: 'Valid', text: '#158060', bg: '#e4f3ec' },
  expiring: { label: 'Expiring', text: '#c98a12', bg: '#f8efdc' },
  expired: { label: 'Expired', text: '#b23a2e', bg: '#f9e8e5' },
  missing: { label: 'No date', text: '#5b6472', bg: '#eef1f4' },
};

export function statusLabel(status) {
  return STATUS_META[status]?.label ?? status;
}

export function summarizeCertStatuses(certs, windowDays = RENEWAL_WINDOW_DAYS) {
  const summary = { valid: 0, expiring: 0, expired: 0, missing: 0 };
  for (const cert of certs) {
    summary[certStatus(cert.expiryDate, windowDays)]++;
  }
  return summary;
}

export function workerStatusSummary(worker, windowDays = RENEWAL_WINDOW_DAYS) {
  return summarizeCertStatuses(worker.certifications, windowDays);
}

export function workerNeedsRenewal(worker, windowDays = RENEWAL_WINDOW_DAYS) {
  const s = workerStatusSummary(worker, windowDays);
  // Missing counts as "needs attention" — a cert with no expiry date can't be
  // confirmed current, so it belongs in the same follow-up bucket as renewals.
  return s.expiring > 0 || s.expired > 0 || s.missing > 0;
}

export function isCompliant(worker) {
  const s = workerStatusSummary(worker);
  return s.expired === 0;
}
