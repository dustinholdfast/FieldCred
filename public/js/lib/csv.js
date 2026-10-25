// Minimal RFC 4180-ish CSV parser — handles quoted fields, escaped quotes
// ("" inside a quoted field), and commas/newlines inside quotes. Good
// enough for hand-edited spreadsheets exported from Excel/Sheets/Numbers.

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  // last field/row (files not always newline-terminated)
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

// Parses CSV text with a header row into an array of plain objects keyed
// by (trimmed, case-insensitive) header names.
export function parseCSVWithHeader(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = (r[i] ?? '').trim()));
    return obj;
  });
}

export function toCSV(headerRow, dataRows) {
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headerRow.map(escape).join(',')];
  for (const row of dataRows) {
    lines.push(row.map(escape).join(','));
  }
  return lines.join('\n');
}
