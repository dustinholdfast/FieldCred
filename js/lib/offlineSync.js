// Drains the offline gate-scan queue (js/lib/offlineCache.js) back into the
// real audit log (record_gate_scan RPC, supabase/migrations/009) once the
// device is back online. Called from main.js: once at startup (covers "the
// app was reopened after being offline") and again on the browser's
// 'online' event (covers "signal came back mid-session, tab stayed open").
//
// This is best-effort and unattended — nobody's watching a gate tablet's
// console — so every failure mode here has to degrade to "try again later,"
// never throw uncaught or lose a queued scan silently.

import { getQueuedScans, removeQueuedScan } from './offlineCache.js';
import { store } from './state.js';

let syncing = false; // re-entrancy guard — 'online' can fire in quick bursts

export async function syncQueuedScans() {
  if (syncing) return;
  syncing = true;
  try {
    let queued;
    try {
      queued = await getQueuedScans();
    } catch {
      return; // no IndexedDB, or a read failure — nothing to do this pass
    }
    for (const scan of queued) {
      try {
        // Re-derives clearance itself server-side (see migration 009) from
        // whatever the worker's record looks like NOW — not the possibly
        // stale cached copy that was on screen at scan time. That's
        // deliberate: the audit log should reflect the real credential
        // state, not a snapshot from a device that had no signal.
        await store.recordGateScan(scan.siteSlug, scan.workerSlug);
        await removeQueuedScan(scan.id);
      } catch {
        // Still offline, or this one attempt failed for some other reason —
        // leave it queued and move on to the rest; the next sync pass
        // (next 'online' event, or next app open) will retry it.
      }
    }
  } finally {
    syncing = false;
  }
}
