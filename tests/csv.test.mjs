import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, parseCSVWithHeader, toCSV } from '../js/lib/csv.js';

test('parseCSV handles quoted fields with commas and newlines', () => {
  const text = 'name,note\n"Doe, Jane","line1\nline2"\nJohn,plain';
  assert.deepEqual(parseCSV(text), [
    ['name', 'note'],
    ['Doe, Jane', 'line1\nline2'],
    ['John', 'plain'],
  ]);
});

test('parseCSV unescapes doubled quotes inside a quoted field', () => {
  assert.deepEqual(parseCSV('a,"she said ""hi"""'), [['a', 'she said "hi"']]);
});

test('parseCSV tolerates CRLF line endings and a missing trailing newline', () => {
  assert.deepEqual(parseCSV('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]);
});

test('parseCSV drops fully blank rows', () => {
  assert.deepEqual(parseCSV('a,b\n\nc,d\n'), [['a', 'b'], ['c', 'd']]);
});

test('parseCSVWithHeader keys rows by lowercased, trimmed headers', () => {
  const rows = parseCSVWithHeader(' Name , Title \nJane, Welder ');
  assert.deepEqual(rows, [{ name: 'Jane', title: 'Welder' }]);
});

test('toCSV round-trips through parseCSV', () => {
  const header = ['name', 'note'];
  const data = [['Doe, Jane', 'has "quotes"'], ['John', 'plain']];
  const parsed = parseCSV(toCSV(header, data));
  assert.deepEqual(parsed, [header, ...data]);
});
