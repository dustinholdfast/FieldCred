import assert from 'node:assert/strict';
import test from 'node:test';
import { grantedFileUrl, publicFileUrl } from '../js/lib/files.js';

test('public file URL stays on this origin and names the tenant', () => {
  const url = publicFileUrl('demo', 'photos', 'abc.jpg');
  assert.equal(url, 'file.php?tenant=demo&bucket=photos&path=abc.jpg');
});

test('granted certificate URL carries the token, not the object path', () => {
  const url = grantedFileUrl('acme', 'abcd');
  assert.equal(url, 'file.php?tenant=acme&token=abcd');
  assert.equal(url.includes('certificates'), false);
});
