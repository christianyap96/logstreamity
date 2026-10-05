// src/modules/lookup-client.js
// Grail lookup files via Resource Store API.
// Docs: https://docs.dynatrace.com/docs/platform/grail/lookup-data
import { dtFetch } from './dt-platform.js';

const RS = '/platform/storage/resource-store/v1/files';

/** File-path rules from the docs. Returns an error string, or null if valid. */
export function validateLookupPath(p) {
  if (!p) return 'File path is required';
  if (!/^[A-Za-z0-9\-_./]+$/.test(p)) return 'Only a-z A-Z 0-9 - _ . / are allowed';
  if (!p.startsWith('/')) return 'Must start with /';
  if (!/[A-Za-z0-9]$/.test(p)) return 'Must end with an alphanumeric character';
  if ((p.match(/\//g) || []).length < 2) return 'Must contain at least two / characters';
  const segs = p.split('/').slice(1);
  if (segs.some(s => !/[A-Za-z0-9]/.test(s))) return 'Each path segment needs at least one alphanumeric character';
  if (segs[0] !== 'lookups') return 'Lookup files must live under /lookups/';
  return null;
}

/** Turn a CSV header line into a DPL pattern, e.g. a,b,c -> LD:a ',' LD:b ',' LD:c
 *  Naive: no quoted-field support. Always run Test first. */
export function csvHeaderToDpl(headerLine, delimiter = ',') {
  const cols = headerLine.replace(/^\uFEFF/, '').trim().split(delimiter)
    .map(c => c.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1'));
  if (!cols.length || cols.some(c => !c)) throw new Error('Could not derive field names from header');
  if (new Set(cols).size !== cols.length) throw new Error('Duplicate column names in header');
  return { pattern: cols.map(c => `LD:${c}`).join(` '${delimiter}' `), fields: cols, skippedRecords: 1 };
}

function buildForm(file, params) {
  const req = {};
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined && v !== null) req[k] = v;
  const fd = new FormData();
  fd.append('request', JSON.stringify(req));
  fd.append('content', file, file.name || 'lookup.dat');
  return fd;
}

/** Preview parsing without storing (returns match count + up to 100 records). */
export function testPattern(base, token, file, { parsePattern, lookupField, skippedRecords, autoFlatten }) {
  return dtFetch(base, `${RS}/tabular/lookup:test-pattern`, {
    token, method: 'POST', headers: { accept: '*/*' },
    body: buildForm(file, { parsePattern, lookupField, skippedRecords, autoFlatten })
  });
}

/** Upload / replace a lookup file. Set overwrite=true to replace an existing filePath. */
export function uploadLookup(base, token, file, p) {
  const err = validateLookupPath(p.filePath);
  if (err) return Promise.reject(new Error(err));
  if (!p.parsePattern || !p.lookupField) return Promise.reject(new Error('parsePattern and lookupField are required'));
  return dtFetch(base, `${RS}/tabular/lookup:upload`, {
    token, method: 'POST', headers: { accept: '*/*' },
    body: buildForm(file, {
      parsePattern: p.parsePattern, lookupField: p.lookupField, filePath: p.filePath,
      displayName: p.displayName, description: p.description,
      overwrite: p.overwrite ? true : undefined,
      skippedRecords: p.skippedRecords, autoFlatten: p.autoFlatten
    })
  });
}

/** Irreversible. */
export function deleteLookup(base, token, filePath) {
  const err = validateLookupPath(filePath);
  if (err) return Promise.reject(new Error(err));
  return dtFetch(base, `${RS}:delete`, {
    token, method: 'POST', headers: { accept: '*/*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath })
  });
}

/** DQL snippets to verify an upload in a Notebook (the Grail query API is not called from here). */
export const verifyDql = (filePath) => [
  'fetch dt.system.files',
  `load "${filePath}"`
];
