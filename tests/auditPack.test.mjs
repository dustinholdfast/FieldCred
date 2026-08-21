import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditPackHtml, auditPackSummary } from '../js/lib/auditPack.js';

// Same local-date fixture pattern as tests/clearance.test.mjs — deterministic
// at any hour/timezone, matches status.js#daysUntil.
const NOW = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFromNow = (n) => iso(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + n));

const TYPE_A = { id: 'type-a', name: 'OSHA 30', issuer: 'OSHA' };
const TYPE_B = { id: 'type-b', name: 'NCCER Core', issuer: 'NCCER' };
const REQUIRED_TYPES = [TYPE_A, TYPE_B];

function cert(overrides = {}) {
  return {
    id: `cert-${Math.random()}`,
    name: 'A cert',
    issuer: '',
    typeId: null,
    expiryDate: '',
    cardNumber: '',
    verified: false,
    verifiedBy: null,
    verifiedAt: null,
    ...overrides,
  };
}

const site = { id: 'site-1', name: 'Riverside Yard', location: 'Columbus, OH' };
const range = { from: daysFromNow(-30), to: daysFromNow(0) };
const generatedAt = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12, 0, 0).toISOString();

test('summary counts: fully cleared vs. worker with a gap', () => {
  const clearedWorker = {
    name: 'Alice Cho',
    certifications: [
      cert({ typeId: 'type-a', name: 'OSHA 30', expiryDate: daysFromNow(365) }),
      cert({ typeId: 'type-b', name: 'NCCER Core', expiryDate: daysFromNow(200) }),
    ],
  };
  const blockedWorker = {
    name: 'Bo Jackson',
    certifications: [cert({ typeId: 'type-a', name: 'OSHA 30', expiryDate: daysFromNow(365) })], // missing type-b
  };

  const html = buildAuditPackHtml({
    tenant: { name: 'Acme Contracting' },
    site,
    requiredTypes: REQUIRED_TYPES,
    workers: [clearedWorker, blockedWorker],
    scans: [],
    range,
    generatedAt,
  });

  assert.match(html, /2 workers, 1 fully cleared/);
  assert.match(html, /1 with gap/);
});

test('auditPackSummary counts total/fullyCleared/withGaps directly', () => {
  const rows = [{ clearance: { cleared: true } }, { clearance: { cleared: false } }, { clearance: { cleared: true } }];
  assert.deepEqual(auditPackSummary(rows), { total: 3, fullyCleared: 2, withGaps: 1 });
});

test('verification stamp renders only for the cert that was actually verified', () => {
  const worker = {
    name: 'Casey Nguyen',
    certifications: [
      cert({
        typeId: 'type-a',
        name: 'OSHA 30',
        expiryDate: daysFromNow(365),
        cardNumber: '12345',
        verified: true,
        verifiedBy: 'admin@acme.com',
        verifiedAt: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 5).toISOString(),
      }),
      cert({ typeId: 'type-b', name: 'NCCER Core', expiryDate: daysFromNow(365) }), // never verified
    ],
  };

  const html = buildAuditPackHtml({
    tenant: {},
    site,
    requiredTypes: REQUIRED_TYPES,
    workers: [worker],
    scans: [],
    range,
    generatedAt,
  });

  assert.match(html, /Verified by admin@acme\.com/);
  // The NCCER Core row must show the "no verification" placeholder, not a
  // stamp — count the stamp occurrences to make sure it isn't leaking onto
  // the unverified row.
  const stampCount = (html.match(/Verified by/g) || []).length;
  assert.equal(stampCount, 1);
});

test('a required type with no matching cert shows as missing with no cert details', () => {
  const worker = {
    name: 'Dee Park',
    certifications: [cert({ typeId: 'type-a', name: 'OSHA 30', expiryDate: daysFromNow(365) })],
  };
  const html = buildAuditPackHtml({
    tenant: {},
    site,
    requiredTypes: REQUIRED_TYPES,
    workers: [worker],
    scans: [],
    range,
    generatedAt,
  });
  assert.match(html, /Missing/);
});

test('certs beyond the site\'s required types appear under "other credentials on file"', () => {
  const worker = {
    name: 'Evan Ruiz',
    certifications: [
      cert({ typeId: 'type-a', name: 'OSHA 30', expiryDate: daysFromNow(365) }),
      cert({ typeId: null, name: 'Forklift Operator', expiryDate: daysFromNow(100) }),
    ],
  };
  const html = buildAuditPackHtml({
    tenant: {},
    site,
    requiredTypes: [TYPE_A],
    workers: [worker],
    scans: [],
    range,
    generatedAt,
  });
  assert.match(html, /Other credentials on file/);
  assert.match(html, /Forklift Operator/);
});

test('a blocked scan lists its missing credential types', () => {
  const html = buildAuditPackHtml({
    tenant: {},
    site,
    requiredTypes: REQUIRED_TYPES,
    workers: [],
    scans: [
      {
        workerName: 'Frank Lee',
        result: 'blocked',
        missingTypes: [{ id: 'type-b', name: 'NCCER Core' }],
        scannedAt: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 9, 30).toISOString(),
      },
      {
        workerName: 'Grace Kim',
        result: 'cleared',
        missingTypes: [],
        scannedAt: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 10, 0).toISOString(),
      },
    ],
    range,
    generatedAt,
  });
  assert.match(html, /Missing: NCCER Core/);
  assert.match(html, /1 cleared/);
  assert.match(html, /1 blocked/);
});

test('an empty roster and empty scan log still render without throwing', () => {
  const html = buildAuditPackHtml({
    tenant: { name: 'Acme Contracting' },
    site,
    requiredTypes: REQUIRED_TYPES,
    workers: [],
    scans: [],
    range,
    generatedAt,
  });
  assert.match(html, /No workers assigned to this site/);
  assert.match(html, /No scans logged in this range/);
  assert.match(html, /0 workers, 0 fully cleared/);
});
