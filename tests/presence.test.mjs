import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DIRECTION_IN,
  DIRECTION_OUT,
  normalizeDirection,
  onSiteNow,
  scanStats,
  startOfLocalDay,
} from '../public/js/lib/presence.js';
import { queuedScanMeta } from '../public/js/lib/offlineCache.js';

const since = new Date('2026-10-25T00:00:00');
const at = (hhmm) => new Date(`2026-10-25T${hhmm}:00`).toISOString();
const scan = (workerId, time, result, direction, extra = {}) => ({
  workerId,
  workerSlug: workerId ? `${workerId}-slug` : null,
  workerName: workerId ? `Worker ${workerId}` : null,
  scannedAt: at(time),
  result,
  direction,
  ...extra,
});

test('a cleared entry puts a worker on site', () => {
  const list = onSiteNow([scan('a', '07:00', 'cleared', 'in')], { since });
  assert.deepEqual(list, [{ workerId: 'a', workerSlug: 'a-slug', workerName: 'Worker a', inAt: at('07:00') }]);
});

test('a blocked entry never puts anyone on site', () => {
  assert.deepEqual(onSiteNow([scan('a', '07:00', 'blocked', 'in')], { since }), []);
  assert.deepEqual(onSiteNow([scan('a', '07:00', 'no_requirements', 'in')], { since }), []);
});

test('a later blocked re-scan takes a worker off the list even after a cleared entry', () => {
  const list = onSiteNow([
    scan('a', '07:00', 'cleared', 'in'),
    scan('a', '09:00', 'blocked', 'in'),
  ], { since });
  assert.deepEqual(list, []);
});

test('scanning out removes a worker, and scanning back in returns them', () => {
  const scans = [scan('a', '07:00', 'cleared', 'in'), scan('a', '12:00', 'cleared', 'out')];
  assert.deepEqual(onSiteNow(scans, { since }), []);
  scans.push(scan('a', '12:45', 'cleared', 'in'));
  assert.deepEqual(onSiteNow(scans, { since }).map((p) => p.inAt), [at('12:45')]);
});

test('an exit counts regardless of its clearance result', () => {
  const list = onSiteNow([scan('a', '07:00', 'cleared', 'in'), scan('a', '16:00', 'blocked', 'out')], { since });
  assert.deepEqual(list, []);
});

test('order of rows does not matter; the latest scan wins', () => {
  const list = onSiteNow([scan('a', '16:00', 'cleared', 'out'), scan('a', '07:00', 'cleared', 'in')], { since });
  assert.deepEqual(list, []);
});

test('scans before the start of the day are ignored', () => {
  const yesterday = { ...scan('a', '07:00', 'cleared', 'in'), scannedAt: new Date('2026-10-24T22:00:00').toISOString() };
  assert.deepEqual(onSiteNow([yesterday], { since }), []);
});

test('rows written before direction existed count as entries', () => {
  const legacy = scan('a', '07:00', 'cleared', undefined);
  assert.equal(onSiteNow([legacy], { since }).length, 1);
  assert.equal(normalizeDirection(undefined), DIRECTION_IN);
  assert.equal(normalizeDirection('sideways'), DIRECTION_IN);
  assert.equal(normalizeDirection('out'), DIRECTION_OUT);
});

test('unrecognized badges are skipped and slug-only rows still key by slug', () => {
  const list = onSiteNow([
    scan(null, '07:00', 'unknown_worker', 'in'),
    { workerId: null, workerSlug: 'jo', workerName: 'Jo', scannedAt: at('07:05'), result: 'cleared', direction: 'in' },
    { workerId: null, workerSlug: 'jo', workerName: 'Jo', scannedAt: at('08:05'), result: 'cleared', direction: 'out' },
  ], { since });
  assert.deepEqual(list, []);
});

test('the list is newest entry first', () => {
  const list = onSiteNow([
    scan('a', '07:00', 'cleared', 'in'),
    scan('b', '08:30', 'cleared', 'in'),
    scan('c', '06:15', 'cleared', 'in'),
  ], { since });
  assert.deepEqual(list.map((p) => p.workerId), ['b', 'a', 'c']);
});

test('stats count cleared and blocked entries only, and exits separately', () => {
  const stats = scanStats([
    scan('a', '07:00', 'cleared', 'in'),
    scan('b', '07:10', 'blocked', 'in'),
    scan('c', '07:20', 'blocked', 'out'),
    scan('a', '16:00', 'cleared', 'out'),
    scan(null, '07:30', 'unknown_worker', 'in'),
  ], { since });
  assert.deepEqual(stats, { total: 5, cleared: 1, blocked: 1, exits: 2 });
});

test('startOfLocalDay is local midnight of the given day', () => {
  const day = startOfLocalDay(new Date('2026-10-25T15:42:10'));
  assert.equal(day.getHours(), 0);
  assert.equal(day.getMinutes(), 0);
  assert.equal(day.getDate(), 25);
});

test('queued scans from before this change sync as entries with no device or guard', () => {
  assert.deepEqual(queuedScanMeta({ siteSlug: 's', workerSlug: 'w' }), { direction: 'in', deviceId: null, guardLabel: null });
  assert.deepEqual(
    queuedScanMeta({ direction: 'out', deviceId: 'gate-0123456789', guardLabel: 'M. Reyes' }),
    { direction: 'out', deviceId: 'gate-0123456789', guardLabel: 'M. Reyes' },
  );
});

test('presence.js and scanAlert.js are precached, since precached gate modules import them', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/js\/lib\/presence\.js'/);
  assert.doesNotMatch(sw, /fieldcred-shell-v[56]'/);
  assert.match(sw, /'\.\/js\/lib\/scanAlert\.js'/);
});
