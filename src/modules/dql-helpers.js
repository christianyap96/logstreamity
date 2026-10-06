// src/modules/dql-helpers.js — pure text helpers for DQL produced by translators (e.g. DMA). Nothing here runs queries.

/** Collapse `f == "a" OR f == "b" ...` (same field) into in(f, {"a","b"}) or case-insensitive matchesValue(). */
export function collapseOrChains(dql, mode = 'in') {
  const term = '[\\w.`]+\\s*==\\s*"(?:[^"\\\\]|\\\\.)*"';
  const re = new RegExp(`${term}(?:\\s+OR\\s+${term})+`, 'gi');
  let count = 0;
  const out = dql.replace(re, (chain) => {
    const parts = chain.split(/\s+OR\s+/i).map(p => p.match(/^([\w.`]+)\s*==\s*("(?:[^"\\]|\\.)*")$/));
    if (parts.some(p => !p)) return chain;
    const field = parts[0][1];
    if (parts.some(p => p[1] !== field)) return chain;
    count++;
    const vals = parts.map(p => p[2]).join(', ');
    return mode === 'matchesValue' ? `matchesValue(${field}, {${vals}})` : `in(${field}, {${vals}})`;
  });
  return { dql: out, collapsed: count };
}

/** Heuristic lint. Returns [{level:'warn'|'info', msg}]. */
export function lintDql(dql) {
  const w = [];
  if (/fetch\s+logs/i.test(dql) && !/bucket\s*:/i.test(dql)) w.push({ level: 'warn', msg: 'fetch logs has no bucket filter: add bucket:{"..."} to cut scanned data (needs your bucket mapping).' });
  if (/\b(from|to|timeframe)\s*:/i.test(dql.replace(/\bby\s*:\s*\{[^}]*\}/g, ''))) w.push({ level: 'warn', msg: 'Query sets its own timeframe (from:/to:/timeframe:). Anomaly detectors forbid from:/to:; for workflows decide whether the query or the task controls the window.' });
  if (new RegExp('[\\w.`]+\\s*==\\s*"[^"]*"(?:\\s+OR\\s+[\\w.`]+\\s*==\\s*"[^"]*")+', 'i').test(dql)) w.push({ level: 'warn', msg: 'OR-chain of equality tests on one field: collapse with the tidy tool.' });
  if (/caseSensitive\s*:/i.test(dql)) w.push({ level: 'info', msg: 'caseSensitive:false is used as a named parameter; the DQL reference documents contains(field, "x", false) positionally. Verify it parses in a Notebook.' });
  if (/==\s*"/.test(dql)) w.push({ level: 'info', msg: 'String == / in() are case-sensitive. Splunk field=value matching is case-insensitive; use matchesValue(field, "x") if casing varies.' });
  if (/preserveFieldsOnFailure\s*:\s*true/i.test(dql)) w.push({ level: 'info', msg: 'preserveFieldsOnFailure:true keeps rows that fail to parse (fields null), like Splunk rex. Add filter isNotNull(field) if you only want parsed rows.' });
  if (!/\b(makeTimeseries|timeseries)\b/.test(dql)) w.push({ level: 'info', msg: 'No timeseries: fine for workflows and Records-type alerts. Timeseries-type detectors need makeTimeseries/timeseries with interval:1m.' });
  if (!/\|\s*fields\b|\bsummarize\b|\bmakeTimeseries\b/.test(dql)) w.push({ level: 'info', msg: 'No fields/summarize: consider selecting only the fields you need.' });
  return w;
}

/** Wrap a filter/parse pipeline as a log-count timeseries for a timeseries-type detector. */
export function wrapMakeTimeseries(query, by = [], agg = 'count()') {
  let q = (query || '').trim().replace(/\|\s*$/, '').trim();
  if (!q) throw new Error('Query is empty');
  const warnings = [];
  if (/\bsummarize\b/.test(q)) warnings.push('Query already contains summarize: makeTimeseries needs record-level input.');
  if (/\b(from|to)\s*:/.test(q.replace(/\bby\s*:\s*\{[^}]*\}/g, ''))) warnings.push('Remove from:/to: from the fetch line: detectors do not allow them.');
  const dims = by.map(s => s.trim()).filter(Boolean);
  const byPart = dims.length ? `, by:{${dims.join(', ')}}` : '';
  return { dql: `${q}\n| makeTimeseries ${agg}${byPart}, interval:1m`, warnings };
}

/** DQL that tests a DPL pattern against pasted sample lines using static data (nothing is ingested). */
export function buildDataParse(lines, pattern, { preserve = true, field = 'content' } = {}) {
  const rows = (lines || []).map(l => l.replace(/\r$/, '')).filter(l => l.trim().length);
  if (!rows.length) throw new Error('Paste at least one sample line');
  if (!pattern || !pattern.trim()) throw new Error('DPL pattern is empty');
  if (pattern.includes('"""')) throw new Error('Pattern contains """ which cannot be wrapped');
  const json = JSON.stringify(JSON.stringify(rows.map(l => ({ [field]: l }))));
  return `data json:${json}\n| parse ${field}, """${pattern.trim()}"""${preserve ? ', preserveFieldsOnFailure: true' : ''}`;
}
