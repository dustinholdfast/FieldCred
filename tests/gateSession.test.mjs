// Tests for the gate device session (js/lib/gateSession.js).
//
// The module reads localStorage at call time (never at import time), so a
// minimal in-memory stand-in is enough to exercise it under plain
// `node --test` — no jsdom, matching this project's no-dependency rule.
// crypto.subtle and crypto.getRandomValues are already global in Node 18+.
//
// What's worth asserting here is narrow but load-bearing: guard mode is the
// fail-safe default, the PIN never lands in storage as clear text, and a
// storage failure degrades instead of throwing — a gate tablet in private
// mode must still boot into a working scanner.

import test from 'node:test';
import assert from 'node:assert/strict';

function installStorage(impl) {
  globalThis.localStorage = impl;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

installStorage(memoryStorage());

const {
  MODE_GUARD,
  MODE_SUPERVISOR,
  clearPairedSlug,
  clearPin,
  getMode,
  getPairedSlug,
  hasPin,
  hashPin,
  isValidPinFormat,
  setMode,
  setPairedSlug,
  setPin,
  verifyPin,
} = await import('../js/lib/gateSession.js');

test.beforeEach(() => {
  installStorage(memoryStorage());
});

test('pairing round-trips through the pre-existing localStorage key', () => {
  // The key is shared with gateConfig.js / publicRecord.js / scan.js — a
  // device paired before this app existed must stay paired.
  assert.equal(getPairedSlug(), null);
  setPairedSlug('eastline');
  assert.equal(getPairedSlug(), 'eastline');
  assert.equal(globalThis.localStorage.getItem('fieldcred_gate_site'), 'eastline');
  clearPairedSlug();
  assert.equal(getPairedSlug(), null);
});

test('an empty slug is refused rather than clearing the pairing', () => {
  setPairedSlug('eastline');
  assert.equal(setPairedSlug(''), false);
  assert.equal(getPairedSlug(), 'eastline');
});

test('guard is the default mode, and any unrecognized value falls back to it', () => {
  assert.equal(getMode(), MODE_GUARD);
  setMode(MODE_SUPERVISOR);
  assert.equal(getMode(), MODE_SUPERVISOR);
  // A corrupted entry must never leave a device sitting in supervisor mode.
  globalThis.localStorage.setItem('fieldcred_gate_mode', 'whatever');
  assert.equal(getMode(), MODE_GUARD);
});

test('only a 4-digit string is a valid PIN', () => {
  assert.equal(isValidPinFormat('1234'), true);
  assert.equal(isValidPinFormat('0000'), true);
  assert.equal(isValidPinFormat('123'), false);
  assert.equal(isValidPinFormat('12345'), false);
  assert.equal(isValidPinFormat('12a4'), false);
  assert.equal(isValidPinFormat(1234), false);
  assert.equal(isValidPinFormat(''), false);
  assert.equal(isValidPinFormat(null), false);
});

test('a set PIN verifies, a wrong one does not', async () => {
  assert.equal(hasPin(), false);
  assert.equal(await setPin('4821'), true);
  assert.equal(hasPin(), true);
  assert.equal(await verifyPin('4821'), true);
  assert.equal(await verifyPin('4822'), false);
  assert.equal(await verifyPin('482'), false);
});

test('the PIN is never stored as clear text', async () => {
  await setPin('4821');
  const raw = globalThis.localStorage.getItem('fieldcred_gate_pin');
  assert.ok(!raw.includes('4821'), 'stored record must not contain the PIN itself');
  const parsed = JSON.parse(raw);
  assert.ok(parsed.salt && parsed.hash);
  assert.equal(parsed.hash.length, 64); // SHA-256, hex
});

test('the same PIN on two devices produces different hashes', async () => {
  await setPin('4821');
  const first = JSON.parse(globalThis.localStorage.getItem('fieldcred_gate_pin'));
  installStorage(memoryStorage());
  await setPin('4821');
  const second = JSON.parse(globalThis.localStorage.getItem('fieldcred_gate_pin'));

  // Per-device salt. Without it, the ten thousand possible digests would make
  // a precomputed lookup table trivial and the hashing purely decorative.
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(await hashPin('4821', first.salt), first.hash);
});

test('clearPin removes it, and verification then fails closed', async () => {
  await setPin('4821');
  clearPin();
  assert.equal(hasPin(), false);
  assert.equal(await verifyPin('4821'), false);
});

test('a corrupted PIN record fails closed rather than throwing', async () => {
  globalThis.localStorage.setItem('fieldcred_gate_pin', 'not json');
  assert.equal(hasPin(), false);
  assert.equal(await verifyPin('4821'), false);

  globalThis.localStorage.setItem('fieldcred_gate_pin', JSON.stringify({ salt: 'abc' }));
  assert.equal(hasPin(), false);
  assert.equal(await verifyPin('4821'), false);
});

test('storage that throws degrades instead of breaking the app', async () => {
  // Private mode / storage disabled. A gate tablet that cannot remember its
  // site is still a tablet that has to show a working scanner.
  installStorage({
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  });

  assert.equal(getPairedSlug(), null);
  assert.equal(setPairedSlug('eastline'), false);
  assert.equal(getMode(), MODE_GUARD);
  assert.equal(hasPin(), false);
  assert.equal(await setPin('4821'), false);
  assert.equal(await verifyPin('4821'), false);
  assert.doesNotThrow(() => clearPin());
  assert.doesNotThrow(() => clearPairedSlug());
});
