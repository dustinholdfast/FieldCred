import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScannedCode } from '../js/lib/qrScanner.js';

// Only parseScannedCode is exercised here — it's the pure half of
// qrScanner.js. The camera/decode half needs getUserMedia and a real video
// element, neither of which exists under `node --test`, and this project has
// no browser test runner. Importing the module at all is itself part of the
// check: it must not touch `document` or `navigator` at module scope.

const TENANT = 'acme';
const badge = (slug, tenant = TENANT) => `https://app.fieldcred.co/?tenant=${tenant}#/r/${slug}`;

test('reads a worker slug from a badge QR', () => {
  const r = parseScannedCode(badge('jane-doe-4821'), TENANT);
  assert.equal(r.kind, 'worker');
  assert.equal(r.slug, 'jane-doe-4821');
  assert.equal(r.tenant, TENANT);
});

test('reads a site slug from a gate QR', () => {
  const r = parseScannedCode(`https://app.fieldcred.co/?tenant=${TENANT}#/gate/north-yard`, TENANT);
  assert.equal(r.kind, 'gate');
  assert.equal(r.slug, 'north-yard');
});

test('accepts a badge served from a tenant subdomain', () => {
  const r = parseScannedCode(`https://acme.app.fieldcred.co/?tenant=acme#/r/jane-doe-4821`, TENANT);
  assert.equal(r.kind, 'worker');
  assert.equal(r.slug, 'jane-doe-4821');
});

// The important one: separate tenants are separate Supabase projects, so a
// foreign slug could in principle collide with a real worker here and produce
// a confident verdict for the wrong person. Must never reach a lookup.
test('refuses a badge from a different tenant instead of looking it up', () => {
  const r = parseScannedCode(badge('jane-doe-4821', 'globex'), TENANT);
  assert.equal(r.kind, 'foreign-tenant');
  assert.equal(r.tenant, 'globex');
});

test('accepts a badge with no tenant param, since it cannot be attributed', () => {
  const r = parseScannedCode('https://app.fieldcred.co/#/r/jane-doe-4821', TENANT);
  assert.equal(r.kind, 'worker');
  assert.equal(r.tenant, null);
});

test('percent-encoded slugs are decoded', () => {
  const r = parseScannedCode(`https://app.fieldcred.co/?tenant=${TENANT}#/r/jos%C3%A9-p-77`, TENANT);
  assert.equal(r.slug, 'josé-p-77');
});

test('a trailing query on the fragment does not become part of the slug', () => {
  const r = parseScannedCode(`https://app.fieldcred.co/?tenant=${TENANT}#/r/jane-doe-4821?site=north-yard`, TENANT);
  assert.equal(r.slug, 'jane-doe-4821');
});

test('surrounding whitespace is tolerated', () => {
  const r = parseScannedCode(`  ${badge('jane-doe-4821')}\n`, TENANT);
  assert.equal(r.kind, 'worker');
});

for (const [label, input] of [
  ['plain text', 'hello world'],
  ['a bare slug', 'jane-doe-4821'],
  ['an unrelated site', 'https://example.com/some/page'],
  ['a FieldCred URL with no route', 'https://app.fieldcred.co/'],
  ['an unknown route', 'https://app.fieldcred.co/#/directory'],
  ['a route that merely starts with r', 'https://app.fieldcred.co/#/reset-password'],
  ['a non-http scheme', 'javascript:alert(1)'],
  ['an empty string', ''],
  ['a null', null],
]) {
  test(`ignores ${label}`, () => {
    assert.equal(parseScannedCode(input, TENANT).kind, 'unknown');
  });
}
