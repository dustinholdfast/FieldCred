import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificationLink, VERIFICATION_SOURCES } from '../js/lib/verification.js';

const cert = (overrides = {}) => ({ verificationSource: '', verificationUrl: '', ...overrides });

test('NCCER source resolves to the fixed NCCER Registry portal, ignoring any verificationUrl', () => {
  const link = verificationLink(cert({ verificationSource: 'NCCER', verificationUrl: 'https://evil.example.com' }));
  assert.equal(link.url, VERIFICATION_SOURCES.NCCER.portalUrl);
  assert.match(link.label, /NCCER/);
});

test('OSHA source resolves to the fixed OSHA Card Portal', () => {
  const link = verificationLink(cert({ verificationSource: 'OSHA' }));
  assert.equal(link.url, VERIFICATION_SOURCES.OSHA.portalUrl);
  assert.match(link.label, /OSHA/);
});

test('no source (legacy cert, saved before this feature) falls back to the free-text verificationUrl', () => {
  const link = verificationLink(cert({ verificationUrl: 'https://example-state-board.gov/verify/123' }));
  assert.equal(link.url, 'https://example-state-board.gov/verify/123');
  assert.equal(link.label, 'Verify');
});

test('an unsafe verificationUrl (javascript:, data:, etc.) never comes back as a link', () => {
  const link = verificationLink(cert({ verificationUrl: 'javascript:alert(1)' }));
  assert.equal(link, null);
});

test('no source and no verificationUrl yields no link at all', () => {
  assert.equal(verificationLink(cert()), null);
});

test('an unrecognized verificationSource value falls back to verificationUrl rather than throwing', () => {
  const link = verificationLink(cert({ verificationSource: 'SomethingUnknown', verificationUrl: 'https://example.com/v' }));
  assert.equal(link.url, 'https://example.com/v');
});
