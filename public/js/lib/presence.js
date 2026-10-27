// Who is on site right now, derived from the gate scan log. Pure functions:
// no storage, no network — gateApp.js feeds in rows from store.siteScanLog().
//
// A worker is on site when their LATEST scan today at this site was an entry
// that was CLEARED. Two consequences are deliberate:
//   - A blocked entry never puts anyone on site. The guard turned them away;
//     counting them would make the roll-call list people who were never let
//     in. (neon/schema.sql's site_on_site_now() does not check this, which is
//     why this list is computed here instead of with that function.)
//   - Someone who left without scanning out still shows. The list is a
//     roll-call of who came through the gate, not a headcount sensor, and
//     the screen says so.

export const DIRECTION_IN = 'in';
export const DIRECTION_OUT = 'out';

// Rows written before direction existed have none; they were all entries.
export function normalizeDirection(value) {
  return value === DIRECTION_OUT ? DIRECTION_OUT : DIRECTION_IN;
}

export function startOfLocalDay(now = new Date()) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day;
}

function workerKey(scan) {
  if (scan.workerId) return `id:${scan.workerId}`;
  if (scan.workerSlug) return `slug:${scan.workerSlug}`;
  return null;
}

function scansSince(scans, since) {
  if (!since) return scans;
  const floor = since.getTime();
  return scans.filter((s) => new Date(s.scannedAt).getTime() >= floor);
}

export function onSiteNow(scans, { since } = {}) {
  const latest = new Map();
  for (const scan of scansSince(scans, since)) {
    const key = workerKey(scan);
    if (!key) continue; // unrecognized badge: nobody to put on site
    const prev = latest.get(key);
    if (!prev || new Date(scan.scannedAt) > new Date(prev.scannedAt)) latest.set(key, scan);
  }
  return [...latest.values()]
    .filter((s) => normalizeDirection(s.direction) === DIRECTION_IN && s.result === 'cleared')
    .map((s) => ({
      workerId: s.workerId || null,
      workerSlug: s.workerSlug || null,
      workerName: s.workerName || s.workerSlug || 'Unknown worker',
      inAt: s.scannedAt,
    }))
    .sort((a, b) => new Date(b.inAt) - new Date(a.inAt));
}

// The shift summary on the supervisor HOME tab. Cleared and blocked count
// entries only: a worker scanning OUT with an expired card wasn't turned away
// from anything, and counting that exit as BLOCKED would overstate refusals.
export function scanStats(scans, { since } = {}) {
  const today = scansSince(scans, since);
  const entries = today.filter((s) => normalizeDirection(s.direction) === DIRECTION_IN);
  return {
    total: today.length,
    cleared: entries.filter((s) => s.result === 'cleared').length,
    blocked: entries.filter((s) => s.result === 'blocked').length,
    exits: today.length - entries.length,
  };
}
