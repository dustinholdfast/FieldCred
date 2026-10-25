// Per-device state for the gate companion app (js/pages/gateApp.js): which
// site this tablet is paired to, whether it's currently in guard or
// supervisor mode, and the supervisor's quick re-entry PIN.
//
// WHAT THE PIN IS, AND WHAT IT ISN'T — read before changing anything here.
//
// The PIN is a CONVENIENCE LOCK, not a security boundary. It stops a guard (or
// a worker who picks the tablet up) from wandering out of kiosk mode into the
// supervisor tabs. It grants no data access on its own and it is not what
// protects anything: every supervisor screen reads gate_scans and the site
// roster, which RLS grants to `authenticated` only (migrations 009/010). No
// session, no data — a forged PIN gets you an empty shell.
//
// So the real gate is a Supabase sign-in. The flow is:
//   1. First exit from gate mode requires a real sign-in (gateApp.js hands
//      off to the existing /login page).
//   2. That signed-in supervisor sets a 4-digit PIN on the device.
//   3. Later exits use the PIN — but only while a valid session still exists.
//      Session gone (expired, signed out) => back to step 1, PIN or no PIN.
//
// The PIN is stored salted-and-hashed rather than in clear text. That is NOT
// because SHA-256 makes a 4-digit secret hard to recover — 10,000 candidates
// is nothing, and anyone with devtools on the device can brute-force it in
// milliseconds. It's so that a casual look at localStorage (a screenshot, a
// support session, a shared debugging screen) doesn't hand the number over,
// and so that a PIN a supervisor reuses elsewhere isn't sitting in plain text.
// Do not let this file grow into something that reads like real auth.

import { getQueuedScans } from './offlineCache.js';
import { DIRECTION_IN, DIRECTION_OUT } from './presence.js';

// Existing key, shared with js/pages/gateConfig.js, js/pages/publicRecord.js
// and js/pages/scan.js. DO NOT RENAME — a device paired by scanning a gate QR
// before this app existed must stay paired after it ships.
const GATE_KEY = 'fieldcred_gate_site';
const MODE_KEY = 'fieldcred_gate_mode';
const PIN_KEY = 'fieldcred_gate_pin';
const DIRECTION_KEY = 'fieldcred_gate_direction';
const DEVICE_KEY = 'fieldcred_gate_device';
const GUARD_KEY = 'fieldcred_gate_guard';

export const MODE_GUARD = 'guard';
export const MODE_SUPERVISOR = 'supervisor';

// localStorage throws in private mode / with storage disabled, and a gate
// tablet that can't remember its site is still a tablet that must show a
// scanner. Every access here degrades to "not set" rather than propagating.
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

// ---- pairing -------------------------------------------------------------

export function getPairedSlug() {
  return read(GATE_KEY);
}

export function setPairedSlug(slug) {
  if (!slug) return false;
  return write(GATE_KEY, slug);
}

export function clearPairedSlug() {
  remove(GATE_KEY);
}

// ---- mode ----------------------------------------------------------------
// Guard is the default and the fail-safe: an unrecognized or absent value
// means guard, so a corrupted localStorage entry can never leave a device
// sitting in supervisor mode.

export function getMode() {
  return read(MODE_KEY) === MODE_SUPERVISOR ? MODE_SUPERVISOR : MODE_GUARD;
}

export function setMode(mode) {
  write(MODE_KEY, mode === MODE_SUPERVISOR ? MODE_SUPERVISOR : MODE_GUARD);
}

// ---- scan context ----------------------------------------------------------
// Written onto every gate_scans row so the log can answer "which tablet, which
// guard, in or out" — and so presence.js can tell who is still on site.

// Entry is the default and the fail-safe, the same way guard is for mode: an
// absent or corrupted value means scans count as entries, which is how every
// scan was recorded before direction existed.
export function getDirection() {
  return read(DIRECTION_KEY) === DIRECTION_OUT ? DIRECTION_OUT : DIRECTION_IN;
}

export function setDirection(direction) {
  write(DIRECTION_KEY, direction === DIRECTION_OUT ? DIRECTION_OUT : DIRECTION_IN);
}

// A random id minted once per device. Not a secret and not an identity check —
// just enough to tell two tablets at the same gate apart in the log. If
// storage is unavailable the id lasts for this page load only.
let memoDeviceId = null;

export function getDeviceId() {
  const stored = read(DEVICE_KEY);
  if (stored && /^gate-[a-f0-9]{10}$/.test(stored)) return stored;
  if (memoDeviceId) return memoDeviceId;
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  memoDeviceId = `gate-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  write(DEVICE_KEY, memoDeviceId);
  return memoDeviceId;
}

export const GUARD_LABEL_MAX = 60;

export function cleanGuardLabel(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, GUARD_LABEL_MAX);
}

// Who is on duty at this tablet, as a supervisor typed it. Free text and
// self-reported: it labels log rows, it doesn't authenticate anyone.
export function getGuardLabel() {
  return cleanGuardLabel(read(GUARD_KEY));
}

export function setGuardLabel(label) {
  const clean = cleanGuardLabel(label);
  if (clean) write(GUARD_KEY, clean);
  else remove(GUARD_KEY);
  return clean;
}

export function scanMeta() {
  return {
    direction: getDirection(),
    deviceId: getDeviceId(),
    guardLabel: getGuardLabel() || null,
  };
}

// ---- PIN -----------------------------------------------------------------

export const PIN_LENGTH = 4;

export function isValidPinFormat(pin) {
  return typeof pin === 'string' && new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

// Exported for tests. `salt` is per-device and random, so the same PIN on two
// devices produces two different hashes — otherwise a lookup table of the ten
// thousand possible digests would make the hashing entirely decorative.
export async function hashPin(pin, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hasPin() {
  const raw = read(PIN_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.salt && parsed?.hash);
  } catch {
    return false;
  }
}

export async function setPin(pin) {
  if (!isValidPinFormat(pin)) return false;
  const salt = randomSalt();
  const hash = await hashPin(pin, salt);
  return write(PIN_KEY, JSON.stringify({ salt, hash, setAt: new Date().toISOString() }));
}

export async function verifyPin(pin) {
  if (!isValidPinFormat(pin)) return false;
  const raw = read(PIN_KEY);
  if (!raw) return false;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed?.salt || !parsed?.hash) return false;
  return (await hashPin(pin, parsed.salt)) === parsed.hash;
}

// Called when a supervisor hands the device back for good, and whenever the
// paired site changes — a PIN set by the supervisor of one site shouldn't
// silently carry over to another crew's gate.
export function clearPin() {
  remove(PIN_KEY);
}

// ---- offline queue depth -------------------------------------------------
// Drives the "N scans queued to sync" counter on the home screens. Best-effort
// like everything else that touches IndexedDB here.

export async function queuedScanCount() {
  try {
    return (await getQueuedScans()).length;
  } catch {
    return 0;
  }
}
