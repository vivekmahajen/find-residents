'use strict';

// Pick the delimiter from the header line: comma for CSV, tab for spreadsheet
// paste (copying cells out of Excel/Sheets/Numbers yields tab-separated text).
function detectDelimiter(text) {
  const firstLine = String(text || '').replace(/\r\n/g, '\n').split('\n')[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

// Minimal RFC-4180-ish parser (quotes, escaped quotes, embedded newlines).
// Delimiter defaults to comma; pass '\t' for spreadsheet paste.
function parseCsv(text, delimiter = ',') {
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQ = true; i += 1; continue; }
    if (c === delimiter) { row.push(field); field = ''; i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0].trim() === ''));
}

function csvToObjects(text) {
  const rows = parseCsv(text, detectDelimiter(text));
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, idx) => { o[h] = (r[idx] != null ? r[idx] : '').trim(); });
    return o;
  });
}

module.exports = { parseCsv, csvToObjects, detectDelimiter };
