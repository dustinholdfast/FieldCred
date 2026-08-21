// Tests for the shared gate verdict derivation (js/lib/gateVerdict.js).
//
// This is the module that decides what a guard sees on a full-screen poster
// and what /r/:slug shows in its banner, so the cases that matter most here
// are the fail-closed ones: anything ambiguous must NOT come out as cleared.
//
// Only the pure half is exercised. resolveWorker/resolveSite/logGateScan need
// Supabase and IndexedDB; deriveVerdict deliberately needs neither, which is
// what makes the actual decision testable under plain `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveVerdict, shortExpiry, VERDICT } from '../js/lib/gateVerdict.js';

const TODAY = new Date('2026-07-20T12:00:00');

const TYPE_OSHA = '11111111-1111-1111-1111-111111111111';
const TYPE_CONFINED = '22222222-2222-2222-2222-222222222222';
const TYPE_RIGGING = '33333333-3333-3333-3333-333333333333';

const site = (requiredTypes) => ({ id: 'site-1', name: 'Eastline Terminal', publicSlug: 'eastline', requiredTypes });
const worker = (certifications) => ({ name: 'Marcus Reyes', title: 'Electrician', department: 'Electrical', certifications });

const SITE_TWO_REQS = site([
  { id: TYPE_OSHA, name: 'OSHA Construction' },
  { id: TYPE_CONFINED, name: 'Confined Space Entry' },
]);

test('cleared when every required type is met by a valid cert', () => {
  const v = deriveVerdict(
    worker([
      { name: 'OSHA 30-Hour', typeId: TYPE_OSHA, expiryDate: '2028-06-02' },
      { name: 'Confined Space Entry', typeId: TYPE_CONFINED, expiryDate: '2027-02-10' },
    ]),
    SITE_TWO_REQS,
    { today: TODAY }
  );

  assert.equal(v.kind, VERDICT.CLEARED);
  assert.equal(v.missing.length, 0);
  assert.equal(v.expiring.length, 0);
  assert.deepEqual(
    v.met.map((m) => m.certName),
    ['OSHA 30-Hour', 'Confined Space Entry']
  );
});

test('an expiring cert still clears, but is surfaced by name', () => {
  const v = deriveVerdict(
    worker([
      { name: 'OSHA 30-Hour', typeId: TYPE_OSHA, expiryDate: '2028-06-02' },
      // 26 days out — inside the 60-day renewal window.
      { name: 'Confined Space Entry', typeId: TYPE_CONFINED, expiryDate: '2026-08-15' },
    ]),
    SITE_TWO_REQS,
    { today: TODAY }
  );

  assert.equal(v.kind, VERDICT.CLEARED);
  assert.deepEqual(v.expiring, ['Confined Space Entry']);
  assert.equal(v.met.find((m) => m.typeId === TYPE_CONFINED).status, 'expiring');
});

test('an expired cert does not meet a requirement, and the poster names its date', () => {
  const v = deriveVerdict(
    worker([
      { name: 'OSHA 30-Hour', typeId: TYPE_OSHA, expiryDate: '2028-06-02' },
      { name: 'Confined Space Entry', typeId: TYPE_CONFINED, expiryDate: '2026-05-12' },
    ]),
    SITE_TWO_REQS,
    { today: TODAY }
  );

  assert.equal(v.kind, VERDICT.BLOCKED);
  assert.equal(v.missing.length, 1);
  assert.equal(v.missing[0].line, 'Confined Space Entry — expired MAY 12');
});

test('a required type with no cert at all reads "not on file"', () => {
  const v = deriveVerdict(
    worker([{ name: 'OSHA 30-Hour', typeId: TYPE_OSHA, expiryDate: '2028-06-02' }]),
    SITE_TWO_REQS,
    { today: TODAY }
  );

  assert.equal(v.kind, VERDICT.BLOCKED);
  assert.equal(v.missing[0].line, 'Confined Space Entry — not on file');
  assert.equal(v.missing[0].expiredOn, '');
});

test('a cert with no expiry date never meets a requirement', () => {
  // FC-R-002 / status.js: a blank date is "missing", not "valid". A gate must
  // never clear someone on a credential nobody has dated.
  const v = deriveVerdict(
    worker([
      { name: 'OSHA 30-Hour', typeId: TYPE_OSHA, expiryDate: '2028-06-02' },
      { name: 'Confined Space Entry', typeId: TYPE_CONFINED, expiryDate: '' },
    ]),
    SITE_TWO_REQS,
    { today: TODAY }
  );

  assert.equal(v.kind, VERDICT.BLOCKED);
  // No date means no evidence of expiry either — it must not claim one.
  assert.equal(v.missing[0].line, 'Confined Space Entry — not on file');
});

test('an untagged cert matches nothing, even with an identical name', () => {
  // Matching is by typeId, never by name — an untagged cert is fail-closed
  // until an admin maps it (see store.backfillCredentialTypesFromCerts).
  const v = deriveVerdict(
    worker([
      { name: 'OSHA 30-Hour', typeId: TYPE_OSHA, expiryDate: '2028-06-02' },
      { name: 'Confined Space Entry', typeId: null, expiryDate: '2029-01-01' },
    ]),
    SITE_TWO_REQS,
    { today: TODAY }
  );

  assert.equal(v.kind, VERDICT.BLOCKED);
});

test('a valid cert wins over an expired one of the same type', () => {
  const v = deriveVerdict(
    worker([
      { name: 'OSHA 10-Hour (old)', typeId: TYPE_OSHA, expiryDate: '2025-01-01' },
      { name: 'OSHA 30-Hour (renewed)', typeId: TYPE_OSHA, expiryDate: '2028-06-02' },
    ]),
    site([{ id: TYPE_OSHA, name: 'OSHA Construction' }]),
    { today: TODAY }
  );

  assert.equal(v.kind, VERDICT.CLEARED);
  assert.equal(v.met[0].certName, 'OSHA 30-Hour (renewed)');
});

test('with only expired certs, the most recent expiry is the one shown', () => {
  const v = deriveVerdict(
    worker([
      { name: 'Rigging (2024)', typeId: TYPE_RIGGING, expiryDate: '2024-03-01' },
      { name: 'Rigging (2026)', typeId: TYPE_RIGGING, expiryDate: '2026-05-12' },
    ]),
    site([{ id: TYPE_RIGGING, name: 'Rigging & Signaling' }]),
    { today: TODAY }
  );

  assert.equal(v.kind, VERDICT.BLOCKED);
  assert.equal(v.missing[0].line, 'Rigging & Signaling — expired MAY 12');
});

test('a site with no requirements is never a clearance', () => {
  // The screen must not read as a green CLEARED poster. A site that has never
  // said what "cleared" means cannot vouch for anyone.
  const v = deriveVerdict(worker([]), site([]), { today: TODAY });
  assert.equal(v.kind, VERDICT.NO_REQUIREMENTS);
  assert.notEqual(v.kind, VERDICT.CLEARED);
});

test('a missing worker or missing site fails closed, never cleared', () => {
  assert.equal(deriveVerdict(null, SITE_TWO_REQS, { today: TODAY }).kind, VERDICT.UNKNOWN_WORKER);
  assert.equal(deriveVerdict(worker([]), null, { today: TODAY }).kind, VERDICT.UNKNOWN_SITE);
  // Both absent: an unpaired device scanning an unknown badge still must not
  // fall through to anything green.
  assert.equal(deriveVerdict(null, null, { today: TODAY }).kind, VERDICT.UNKNOWN_SITE);
});

test('a worker with no certifications array at all does not throw', () => {
  const v = deriveVerdict({ name: 'New Hire' }, SITE_TWO_REQS, { today: TODAY });
  assert.equal(v.kind, VERDICT.BLOCKED);
  assert.equal(v.missing.length, 2);
});

test('shortExpiry: this year keeps the day, other years show only the year', () => {
  assert.equal(shortExpiry('2026-08-15', TODAY), 'AUG 15');
  assert.equal(shortExpiry('2026-05-12', TODAY), 'MAY 12');
  assert.equal(shortExpiry('2028-06-02', TODAY), '2028');
  assert.equal(shortExpiry('', TODAY), '');
  assert.equal(shortExpiry(null, TODAY), '');
});
