// src/modules/mappings.js — user-maintained mapping tables ("key = value" lines). Local only.
export const MAP_NAMES = ['fields', 'buckets', 'severity', 'routing'];

/** Parse lines like `host = host.name`, `index -> bucket`, or `key<TAB>value`. '#' starts a comment. */
export function parseMap(text) {
  const m = new Map();
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const mm = line.match(/^(.+?)\s*(?:->|=>|=|\t)\s*(.+)$/);
    if (mm) m.set(mm[1].trim().toLowerCase(), mm[2].trim());
  }
  return m;
}
export const mapGet = (map, key) => (map && key != null ? map.get(String(key).trim().toLowerCase()) : undefined);

/** {fields:'text',...} -> {fields:Map,...} */
export function parseAllMaps(texts = {}) {
  return Object.fromEntries(MAP_NAMES.map(n => [n, parseMap(texts[n] || '')]));
}
