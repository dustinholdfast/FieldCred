import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCertText, normalizeDateString } from '../js/lib/certParse.js';

test('normalizeDateString accepts common formats, blanks, and rejects junk', () => {
  assert.equal(normalizeDateString('2028-06-02'), '2028-06-02'); // already ISO
  assert.equal(normalizeDateString('6/2/2028'), '2028-06-02'); // US M/D/YYYY (the CSV case)
  assert.equal(normalizeDateString('06/02/2028'), '2028-06-02');
  assert.equal(normalizeDateString('June 2, 2028'), '2028-06-02');
  assert.equal(normalizeDateString(''), ''); // blank is allowed (no expiry)
  assert.equal(normalizeDateString('   '), '');
  assert.equal(normalizeDateString('not a date'), null); // unparseable -> error
});

test('keyword-labeled issue + expiry dates are classified correctly', () => {
  const r = parseCertText('Issued: 2023-06-02\nExpiration Date: 2028-06-02');
  assert.equal(r.earnedDate, '2023-06-02');
  assert.equal(r.expiryDate, '2028-06-02');
});

test('US slash dates are normalized to ISO', () => {
  const r = parseCertText('Valid through 06/02/2028');
  assert.equal(r.expiryDate, '2028-06-02');
});

test('month-name dates parse', () => {
  const r = parseCertText('Expires June 2, 2028');
  assert.equal(r.expiryDate, '2028-06-02');
  const r2 = parseCertText('Exp 2 Jun 2028');
  assert.equal(r2.expiryDate, '2028-06-02');
});

test('two-digit years resolve to the 2000s / 1900s sensibly', () => {
  assert.equal(parseCertText('exp 6/2/28').expiryDate, '2028-06-02');
  assert.equal(parseCertText('issued 6/2/95').earnedDate, '1995-06-02');
});

test('with no keywords, latest date = expiry and earliest = earned', () => {
  const r = parseCertText('2023-01-10 ... 2027-01-10');
  assert.equal(r.earnedDate, '2023-01-10');
  assert.equal(r.expiryDate, '2027-01-10');
});

test('a single unlabeled date is treated as the expiry (the field that matters most)', () => {
  const r = parseCertText('OSHA 30  2028-06-02');
  assert.equal(r.expiryDate, '2028-06-02');
  assert.equal(r.earnedDate, '');
});

test('no dates yields empty suggestions, never a guess', () => {
  const r = parseCertText('OSHA 30-Hour Construction — U.S. OSHA');
  assert.equal(r.expiryDate, '');
  assert.equal(r.earnedDate, '');
  assert.deepEqual(r.dates, []);
});

test('all distinct dates are collected and de-duplicated', () => {
  const r = parseCertText('2028-06-02 and again 2028-06-02 and 2023-06-02');
  assert.deepEqual(r.dates, ['2023-06-02', '2028-06-02']);
});
