import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, STALE_AFTER_MS } from '../js/lib/offlineCache.js';

// Only isStale() is tested here — it's the one pure piece of offlineCache.js.
// Everything else touches the browser-only `indexedDB` global (lazily, never
// at module load, which is exactly what lets this file import the module at
// all under plain Node with no polyfill).

test('missing cachedAt is always stale (fail closed, not fail open)', () => {
  assert.equal(isStale(null), true);
  assert.equal(isStale(undefined), true);
  assert.equal(isStale(''), true);
});

test('an unparseable cachedAt is stale rather than throwing', () => {
  assert.equal(isStale('not-a-date'), true);
});

test('data cached just now is not stale', () => {
  const now = Date.parse('2026-07-17T12:00:00Z');
  assert.equal(isStale('2026-07-17T12:00:00Z', now), false);
});

test('data right at the edge of the window is not yet stale', () => {
  const now = Date.parse('2026-07-17T12:00:00Z');
  const cachedAt = new Date(now - STALE_AFTER_MS + 1000).toISOString();
  assert.equal(isStale(cachedAt, now), false);
});

test('data older than the window is stale', () => {
  const now = Date.parse('2026-07-17T12:00:00Z');
  const cachedAt = new Date(now - STALE_AFTER_MS - 1000).toISOString();
  assert.equal(isStale(cachedAt, now), true);
});
