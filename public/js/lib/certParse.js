// Pull dates out of OCR'd certificate text. Dates are the high-value, most
// error-prone field to hand-type, so they're what we auto-suggest; everything
// returned is a review-before-save suggestion, never authoritative (fail-closed
// — a bad OCR read shows the admin a value to correct, it never saves itself).
//
// Pure and deterministic. See tests/certParse.test.mjs.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const pad = (n) => String(n).padStart(2, '0');
function fourDigitYear(y) {
  y = Number(y);
  if (y < 100) y += y >= 70 ? 1900 : 2000; // '70..'99 -> 1900s, '00..'69 -> 2000s
  return y;
}
function iso(y, m, d) {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// All recognizable dates as { value: 'YYYY-MM-DD', index } in text order.
function findDates(text) {
  const out = [];
  const push = (value, index) => { if (value) out.push({ value, index }); };
  // ISO  2028-06-02
  for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) push(iso(+m[1], +m[2], +m[3]), m.index);
  // US numeric  M/D/Y, M-D-Y, M.D.Y (assume US month-first — product is US trades)
  for (const m of text.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g)) push(iso(fourDigitYear(m[3]), +m[1], +m[2]), m.index);
  // Month name  "Jun 2, 2028" / "June 2 2028"
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) push(iso(+m[3], mon, +m[2]), m.index);
  }
  // "2 June 2028"
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) push(iso(+m[3], mon, +m[1]), m.index);
  }
  return out;
}

const EXPIRY_RE = /(expir|valid\s*(through|until|thru|to)\b|\bexp\.?\b|renew|good\s*(through|until))/i;
const ISSUE_RE = /(issue|earned|complet|awarded|certified\s*on)/i;

// Normalize a single date cell (e.g. a CSV "expires" value) to YYYY-MM-DD.
// Returns '' for a blank input (a cert may have no expiry), the normalized ISO
// string when it recognizes a date in any supported format, or null when the
// value is non-blank but unparseable (so callers can report a clear error).
export function normalizeDateString(s) {
  const str = (s || '').trim();
  if (!str) return '';
  const found = findDates(str);
  return found.length ? found[0].value : null;
}

export function parseCertText(rawText) {
  const text = rawText || '';
  const dates = findDates(text);

  // Classify by a keyword in the ~40 chars preceding each date.
  let expiry = null;
  let earned = null;
  for (const d of dates) {
    const ctx = text.slice(Math.max(0, d.index - 40), d.index).toLowerCase();
    if (!expiry && EXPIRY_RE.test(ctx)) expiry = d.value;
    if (!earned && ISSUE_RE.test(ctx)) earned = d.value;
  }

  const uniqueSorted = [...new Set(dates.map((d) => d.value))].sort();
  // Fallbacks when nothing was keyword-labeled: latest date is the likeliest
  // expiry; earliest (if distinct) the likeliest issue date.
  if (!expiry && uniqueSorted.length) expiry = uniqueSorted[uniqueSorted.length - 1];
  if (!earned && uniqueSorted.length > 1 && uniqueSorted[0] !== expiry) earned = uniqueSorted[0];

  return {
    earnedDate: earned || '',
    expiryDate: expiry || '',
    dates: uniqueSorted,
    text,
  };
}
