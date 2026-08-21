import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeExternalUrl, isSafeExternalUrl } from '../js/lib/format.js';

// Regression test for a real bug found 2026-07-17: safeExternalUrl used to
// resolve against the browser-only `location.origin` global, which doesn't
// exist outside a browser — every call threw, was swallowed by the
// function's own catch, and it silently returned '' for every URL, safe
// ones included. This file is the first thing to actually run it in Node.

test('a full https URL passes through unchanged', () => {
  assert.equal(safeExternalUrl('https://registry.nccer.org/'), 'https://registry.nccer.org/');
});

test('a full http URL passes through unchanged', () => {
  assert.equal(safeExternalUrl('http://example.com/verify'), 'http://example.com/verify');
});

test('a javascript: URL is rejected', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'), '');
});

test('a data: URL is rejected', () => {
  assert.equal(safeExternalUrl('data:text/html,<script>alert(1)</script>'), '');
});

test('a relative path is rejected (must be fully-qualified)', () => {
  assert.equal(safeExternalUrl('/some/path'), '');
});

test('blank/empty input is rejected without throwing', () => {
  assert.equal(safeExternalUrl(''), '');
  assert.equal(safeExternalUrl(null), '');
  assert.equal(safeExternalUrl(undefined), '');
});

test('isSafeExternalUrl treats blank as safe (no link = nothing to reject) but garbage as unsafe', () => {
  assert.equal(isSafeExternalUrl(''), true);
  assert.equal(isSafeExternalUrl('https://example.com'), true);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
});
