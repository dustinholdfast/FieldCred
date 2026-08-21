import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateLinkUrl, workerRecordUrl } from '../js/lib/publicLinks.js';
import { parseScannedCode } from '../js/lib/qrScanner.js';

// These two builders and parseScannedCode() are the two ends of one physical
// loop: a URL is printed onto a code here and read back off a camera there.
// So the tests round-trip rather than assert on strings — a printed sign is
// expensive to be wrong about.

const HERE = { origin: 'https://app.fieldcred.co', pathname: '/' };
const TENANT = 'acme';

test('a gate link reads back as its site', () => {
  const url = gateLinkUrl({ ...HERE, tenant: TENANT, slug: 'north-yard' });
  const r = parseScannedCode(url, TENANT);
  assert.equal(r.kind, 'gate');
  assert.equal(r.slug, 'north-yard');
  assert.equal(r.tenant, TENANT);
});

test('a badge link reads back as its worker', () => {
  const url = workerRecordUrl({ ...HERE, tenant: TENANT, slug: 'jane-doe-4821' });
  const r = parseScannedCode(url, TENANT);
  assert.equal(r.kind, 'worker');
  assert.equal(r.slug, 'jane-doe-4821');
});

// The regression these builders exist for. Without ?tenant= the scanning
// device falls through to DEFAULT_TENANT (js/lib/tenant.js) and looks the slug
// up in the wrong Supabase project — a gate sign that pairs to nothing.
test('both links carry the tenant', () => {
  for (const url of [
    gateLinkUrl({ ...HERE, tenant: TENANT, slug: 'north-yard' }),
    workerRecordUrl({ ...HERE, tenant: TENANT, slug: 'jane-doe-4821' }),
  ]) {
    assert.equal(new URL(url).searchParams.get('tenant'), TENANT);
  }
});

// The app is served from a subdirectory on some deployments, and the hash
// router needs the file path kept intact ahead of the '#'.
test('keeps the current path and puts the slug in the fragment', () => {
  const url = gateLinkUrl({ origin: 'https://acme.app.fieldcred.co', pathname: '/app/index.html', tenant: TENANT, slug: 'north-yard' });
  assert.equal(url, 'https://acme.app.fieldcred.co/app/index.html?tenant=acme#/gate/north-yard');
  assert.equal(parseScannedCode(url, TENANT).slug, 'north-yard');
});

test('escapes a tenant or slug that needs it', () => {
  const url = gateLinkUrl({ ...HERE, tenant: 'a b', slug: 'yard #2' });
  assert.equal(new URL(url).searchParams.get('tenant'), 'a b');
  assert.equal(parseScannedCode(url, 'a b').slug, 'yard #2');
});
