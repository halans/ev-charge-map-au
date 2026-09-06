'use strict';
/**
 * Minimal RFC-4180 CSV reader/writer. Zero dependencies.
 *
 * Handles the things that actually break on real government CSV exports:
 *  - UTF-8 BOM prefix (TfNSW ships one)
 *  - quoted fields containing commas and newlines (QLD addresses do)
 *  - escaped double quotes ("")
 *  - CRLF and bare LF line endings
 *  - ragged rows (short rows are padded, long rows keep the overflow)
 */

/**
 * Parse CSV text into an array of arrays.
 * @param {string} text
 * @returns {string[][]}
 */
function parseRows(text) {
  if (typeof text !== 'string') throw new TypeError('parseRows expects a string');
  // Strip UTF-8 BOM.
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      sawAny = true;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAny = false;
    } else if (ch === '\r') {
      // ignore; handled by the \n branch
    } else {
      field += ch;
      sawAny = true;
    }
  }

  if (sawAny || field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Parse CSV text into objects keyed by header row.
 * Duplicate header names get a numeric suffix so no column is silently lost.
 * @param {string} text
 * @returns {Array<Record<string,string>>}
 */
function parse(text) {
  const rows = parseRows(text);
  if (!rows.length) return [];

  const seen = new Map();
  const headers = rows[0].map((h) => {
    const key = String(h).trim();
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    return n === 0 ? key : `${key}_${n + 1}`;
  });

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip fully blank lines (trailing newline artefacts).
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const rec = {};
    for (let c = 0; c < headers.length; c++) {
      rec[headers[c]] = cells[c] === undefined ? '' : cells[c];
    }
    out.push(rec);
  }
  return out;
}

/** Quote a single CSV cell if needed. */
function quote(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise objects to CSV text with a stable column order.
 * @param {Array<Record<string,unknown>>} records
 * @param {string[]} [columns]
 * @returns {string}
 */
function stringify(records, columns) {
  const cols =
    columns ||
    Array.from(
      records.reduce((set, r) => {
        Object.keys(r).forEach((k) => set.add(k));
        return set;
      }, new Set())
    );
  const lines = [cols.map(quote).join(',')];
  for (const rec of records) lines.push(cols.map((c) => quote(rec[c])).join(','));
  return lines.join('\n') + '\n';
}

module.exports = { parse, parseRows, stringify };
