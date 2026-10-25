export function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Returns the URL only if it's a safe, fully-qualified http(s) link,
// otherwise ''. Verification URLs are typed by staff and rendered as
// clickable links on the (public) QR record, so a `javascript:` or `data:`
// value would be a stored-XSS vector that escapeHtml alone doesn't stop —
// escaping makes the attribute value safe, but the browser still runs
// `javascript:` when the link is clicked. Callers treat '' as "no link".
// isSafeExternalUrl is the boolean form, for validation on save.
//
// Deliberately `new URL(url)` with NO base argument (was `new URL(url,
// location.origin)` — a real bug, fixed 2026-07-17 while adding
// tests/verification.test.mjs, the first test to actually exercise this
// function: `location` is a browser-only global, so outside a browser this
// threw on every call, was swallowed by the catch below, and silently
// returned '' for every URL, safe ones included. A relative path resolving
// against location.origin was never a case any real caller needed anyway —
// every verificationUrl in practice is a full https:// link to an outside
// site — so requiring an absolute URL here is both the fix and, if
// anything, the more correct fail-closed behavior for "external" link.
export function safeExternalUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

export function isSafeExternalUrl(url) {
  return !url || safeExternalUrl(url) !== '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// '2026-03-14' -> 'Mar 2026' (short) or 'Mar 14, 2026' (full)
export function formatDate(isoDate, { withDay = false } = {}) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m) return isoDate;
  const month = MONTHS[m - 1];
  return withDay ? `${month} ${d}, ${y}` : `${month} ${y}`;
}

// ISO timestamptz -> 'Jul 17, 2026, 3:32 PM' in the viewer's local timezone —
// used for the gate scan audit log, where the reader wants to know when a
// scan happened at a glance more than compute-friendly precision.
export function formatDateTime(isoTimestamp) {
  if (!isoTimestamp) return '—';
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp;
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${date}, ${hours}:${minutes} ${ampm}`;
}

// Clock time alone — '3:32 PM' — in the viewer's local timezone. The gate
// companion app (js/pages/gateApp.js) stamps verdicts and scan-log rows with
// this: everything on that screen happened at this gate in the last few
// hours, so the date is noise and the minute is the whole signal.
export function formatTime(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}

export function slugify(name) {
  const parts = name.trim().toLowerCase().split(/\s+/);
  const last = parts[parts.length - 1] || 'worker';
  const initial = parts.length > 1 ? parts[0][0] : '';
  return `${initial}${last}`.replace(/[^a-z0-9]/g, '');
}

export function shortCode(seed) {
  let hash = 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).slice(0, 4).padEnd(4, '0');
}

export function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}
