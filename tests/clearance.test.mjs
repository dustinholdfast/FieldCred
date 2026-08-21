import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClearance } from '../js/lib/clearance.js';

// Fixtures from LOCAL calendar dates, matching status.js#daysUntil (see the
// note in status.test.mjs). Deterministic at any hour / timezone.
const NOW = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFromNow = (n) => iso(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + n));

const cert = (typeId, daysOut) => ({ typeId, expiryDate: daysFromNow(daysOut) });
const worker = (...certs) => ({ certifications: certs });

test('a worker with a valid cert of each required type is cleared', () => {
  const w = worker(cert('A', 365), cert('B', 200));
  const r = evaluateClearance(w, ['A', 'B'], 60, NOW);
  assert.equal(r.cleared, true);
  assert.deepEqual(r.missingTypeIds, []);
  assert.deepEqual(r.expiringTypeIds, []);
});

test('a required type with no matching cert blocks clearance (fail closed)', () => {
  const w = worker(cert('A', 365));
  const r = evaluateClearance(w, ['A', 'B'], 60, NOW);
  assert.equal(r.cleared, false);
  assert.deepEqual(r.missingTypeIds, ['B']);
});

test('an expired cert does not meet a requirement', () => {
  const w = worker(cert('A', -1));
  const r = evaluateClearance(w, ['A'], 60, NOW);
  assert.equal(r.cleared, false);
  assert.deepEqual(r.missingTypeIds, ['A']);
});

test('an expiring cert still clears but is flagged', () => {
  const w = worker(cert('A', 20));
  const r = evaluateClearance(w, ['A'], 60, NOW);
  assert.equal(r.cleared, true);
  assert.deepEqual(r.expiringTypeIds, ['A']);
  assert.deepEqual(r.missingTypeIds, []);
});

test('an untagged cert (no typeId) does not satisfy a requirement', () => {
  const w = worker({ typeId: null, expiryDate: daysFromNow(365) });
  const r = evaluateClearance(w, ['A'], 60, NOW);
  assert.equal(r.cleared, false);
  assert.deepEqual(r.missingTypeIds, ['A']);
});

test('a valid cert outranks an expired one of the same type', () => {
  const w = worker(cert('A', -5), cert('A', 365));
  const r = evaluateClearance(w, ['A'], 60, NOW);
  assert.equal(r.cleared, true);
  assert.deepEqual(r.expiringTypeIds, []);
});

test('no requirements means trivially cleared', () => {
  const r = evaluateClearance(worker(), [], 60, NOW);
  assert.equal(r.cleared, true);
});
