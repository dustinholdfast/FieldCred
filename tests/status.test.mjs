import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  certStatus,
  summarizeCertStatuses,
  workerNeedsRenewal,
  isCompliant,
  RENEWAL_WINDOW_DAYS,
} from '../js/lib/status.js';

// Base everything on the real clock: summarizeCertStatuses / workerNeedsRenewal
// / isCompliant classify against new Date() internally (no injectable "today"),
// so test fixtures must be relative to now, not a hardcoded date.
//
// Build fixtures from LOCAL calendar dates. status.js#daysUntil parses an ISO
// date as `${iso}T00:00:00` (local midnight) and compares it to local midnight
// today. Using toISOString() here would slice the UTC date instead, mixing UTC
// and local and going off-by-one whenever the run happens near the UTC day
// boundary in a non-UTC zone — which is what made the expired/expiring boundary
// tests flaky. Constructing the date from local Y/M/D + n days keeps the
// fixture in the same frame daysUntil uses, so it's deterministic at any hour.
const NOW = new Date();
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFromNow = (n) => iso(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + n));

test('certStatus classifies a far-future date as valid', () => {
  assert.equal(certStatus(daysFromNow(365), RENEWAL_WINDOW_DAYS, NOW), 'valid');
});

test('certStatus classifies a date inside the renewal window as expiring', () => {
  assert.equal(certStatus(daysFromNow(10), RENEWAL_WINDOW_DAYS, NOW), 'expiring');
  assert.equal(certStatus(daysFromNow(RENEWAL_WINDOW_DAYS), RENEWAL_WINDOW_DAYS, NOW), 'expiring');
});

test('certStatus classifies a past date as expired', () => {
  assert.equal(certStatus(daysFromNow(-1), RENEWAL_WINDOW_DAYS, NOW), 'expired');
});

test('certStatus treats a blank or invalid date as missing, not valid', () => {
  // Regression guard: a blank expiry used to fall through to 'valid' and
  // silently inflate compliance counts.
  assert.equal(certStatus('', RENEWAL_WINDOW_DAYS, NOW), 'missing');
  assert.equal(certStatus(null, RENEWAL_WINDOW_DAYS, NOW), 'missing');
  assert.equal(certStatus('not-a-date', RENEWAL_WINDOW_DAYS, NOW), 'missing');
});

test('summarizeCertStatuses counts every bucket including missing', () => {
  const certs = [
    { expiryDate: daysFromNow(365) }, // valid
    { expiryDate: daysFromNow(5) }, // expiring
    { expiryDate: daysFromNow(-5) }, // expired
    { expiryDate: '' }, // missing
  ];
  assert.deepEqual(summarizeCertStatuses(certs), { valid: 1, expiring: 1, expired: 1, missing: 1 });
});

test('workerNeedsRenewal is true when a cert is expiring, expired, or missing a date', () => {
  assert.equal(workerNeedsRenewal({ certifications: [{ expiryDate: daysFromNow(5) }] }), true);
  assert.equal(workerNeedsRenewal({ certifications: [{ expiryDate: daysFromNow(-5) }] }), true);
  assert.equal(workerNeedsRenewal({ certifications: [{ expiryDate: '' }] }), true);
  assert.equal(workerNeedsRenewal({ certifications: [{ expiryDate: daysFromNow(365) }] }), false);
});

test('isCompliant is false only when something is expired', () => {
  assert.equal(isCompliant({ certifications: [{ expiryDate: daysFromNow(365) }] }), true);
  assert.equal(isCompliant({ certifications: [{ expiryDate: daysFromNow(-1) }] }), false);
});
