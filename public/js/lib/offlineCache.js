// Offline support for the public gate scan flow (roadmap "Platform" phase —
// "Jobsite gates have poor connectivity; a scan that fails on no-signal
// breaks the core promise.").
//
// SCOPE, DELIBERATE: opportunistic caching only. A worker's record is cached
// here the first time it's successfully fetched online; there is no
// proactive roster pre-fetch. Rosters are never exposed to anonymous gate
// devices today (see supabase/migrations/007/008 — deliberate: "no list to
// enumerate"), and building a new anon-reachable roster endpoint to enable
// pre-fetch is a bigger, separate security-surface decision — not bundled
// into this change (confirmed with Dustin 2026-07-17). Practical effect: a
// worker who has never passed through this specific gate while online can't
// be verified with zero signal; a worker who has, can — which covers the
// common case (a regular, returning crew) without adding any new anon data
// exposure.
//
// Two things live here: (1) a cache of the last-known worker/site records
// keyed by slug, each stamped with when it was fetched, and (2) a queue of
// gate scans that happened with no signal and still need to reach the
// record_gate_scan audit log (migration 009) once the device is back online
// — see js/lib/offlineSync.js, which drains this queue.

const DB_NAME = 'fieldcred-offline';
const DB_VERSION = 1;
const STORE_WORKERS = 'workers';
const STORE_SITES = 'sites';
const STORE_SCAN_QUEUE = 'scanQueue';

// How old cached data can be before the UI should call it out as possibly
// stale rather than presenting it silently as current. This is a labeling
// threshold, not a cutoff — better a clearly-flagged possibly-stale
// "cleared" than nothing at all when there's no signal, matching this app's
// existing "never silently upgrade uncertainty into a clean result" rule
// (see js/lib/status.js on blank expiry dates). Exported so it's
// independently testable without touching IndexedDB at all.
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

export function isStale(cachedAt, now = Date.now()) {
  if (!cachedAt) return true;
  const t = new Date(cachedAt).getTime();
  if (Number.isNaN(t)) return true;
  return now - t > STALE_AFTER_MS;
}

let dbPromise = null;
// Lazy + memoized — never touches the `indexedDB` global at module load
// time, only when a caller actually asks for data. That's what keeps this
// file importable from tests/offlineCache.test.mjs under plain Node (no
// browser, no `indexedDB` global) to exercise isStale() above without
// needing an IndexedDB polyfill this no-dependency project doesn't have.
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_WORKERS)) db.createObjectStore(STORE_WORKERS, { keyPath: 'slug' });
      if (!db.objectStoreNames.contains(STORE_SITES)) db.createObjectStore(STORE_SITES, { keyPath: 'slug' });
      if (!db.objectStoreNames.contains(STORE_SCAN_QUEUE)) db.createObjectStore(STORE_SCAN_QUEUE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function readOne(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function readAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function write(storeName, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    fn(t.objectStore(storeName));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---- worker records — cache is best-effort; a failure here (private mode,
// storage quota, older Safari) must never break the online path, so every
// call site wraps these in try/catch and treats a rejection as "no cache". ----
export async function cacheWorkerRecord(slug, data) {
  await write(STORE_WORKERS, (store) => store.put({ slug, data, cachedAt: new Date().toISOString() }));
}

export async function getCachedWorkerRecord(slug) {
  return readOne(STORE_WORKERS, slug);
}

// ---- sites ----
export async function cacheSite(slug, data) {
  await write(STORE_SITES, (store) => store.put({ slug, data, cachedAt: new Date().toISOString() }));
}

export async function getCachedSite(slug) {
  return readOne(STORE_SITES, slug);
}

// ---- offline scan queue ----
export async function queueScan(siteSlug, workerSlug) {
  await write(STORE_SCAN_QUEUE, (store) => store.add({ siteSlug, workerSlug, queuedAt: new Date().toISOString() }));
}

export async function getQueuedScans() {
  return readAll(STORE_SCAN_QUEUE);
}

export async function removeQueuedScan(id) {
  await write(STORE_SCAN_QUEUE, (store) => store.delete(id));
}
