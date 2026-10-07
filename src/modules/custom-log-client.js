// src/modules/custom-log-client.js
// Paste-and-send custom logs to Dynatrace Logs API v2 (POST /api/v2/logs/ingest).
// Accepts: one JSON object, a JSON array, NDJSON (one object per line), several pretty-printed objects
// back to back, or plain text lines (each line becomes {content: line}).
import { isProxyOn } from './dt-platform.js';

/** https://<env>.apps.dynatrace.com | .live. | bare host -> https://<env>.live.dynatrace.com/api/v2/logs/ingest */
export function ingestUrl(input) {
  if (!input) return '';
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u; try { u = new URL(s); } catch { return ''; }
  u.hostname = u.hostname.replace(/\.apps\.dynatrace\.com$/i, '.live.dynatrace.com');
  return `${u.origin}/api/v2/logs/ingest`;
}

/** Split text into top-level JSON values by brace/bracket depth (string-aware). Returns null if text isn't JSON-ish. */
function splitJsonValues(text) {
  const out = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { if (depth === 0) return null; inStr = true; continue; }
    if (c === '{' || c === '[') { if (depth === 0) start = i; depth++; }
    else if (c === '}' || c === ']') { depth--; if (depth < 0) return null; if (depth === 0) out.push(text.slice(start, i + 1)); }
    else if (depth === 0 && !/\s|,/.test(c)) return null; // stray text between values -> not JSON
  }
  return depth === 0 && out.length ? out : null;
}

/**
 * Parse pasted text into an array of log records (objects).
 * @returns {{records: object[], format: string}}
 */
export function parseLogs(text) {
  const t = (text || '').trim();
  if (!t) throw new Error('Nothing to send: paste a log first');
  const chunks = splitJsonValues(t);
  if (chunks) {
    const records = [];
    for (const c of chunks) {
      const v = JSON.parse(c);
      if (Array.isArray(v)) v.forEach(x => records.push(x)); else records.push(v);
    }
    if (records.some(r => r === null || typeof r !== 'object' || Array.isArray(r))) throw new Error('Every JSON log must be an object');
    return { records, format: 'json' };
  }
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return { records: lines.map(content => ({ content })), format: 'text' };
}

/** Apply options: stamp timestamp = now (ISO) and merge extra attributes that the record doesn't already set. */
export function prepareRecords(records, { stampNow = false, extra = {}, now = new Date() } = {}) {
  return records.map((r, i) => {
    const o = { ...extra, ...r };
    if (stampNow) o.timestamp = new Date(now.getTime() + i).toISOString(); // +i ms keeps order
    if (o.content !== undefined && typeof o.content !== 'string') o.content = JSON.stringify(o.content);
    return o;
  });
}

/** Parse "k=v" lines into an object. */
export function parseExtra(text) {
  const o = {};
  for (const l of (text || '').split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return o;
}

export function authHeader(tokenType, token) {
  if (!token) throw new Error('Token is missing');
  return tokenType === 'platform' ? `Bearer ${token}` : `Api-Token ${token}`;
}

/** POST records. Returns {status, body}. Never throws on HTTP errors; throws on network failure. */
export async function sendLogs({ endpoint, token, tokenType, records }) {
  const url = ingestUrl(endpoint); if (!url) throw new Error('Tenant URL is missing or invalid');
  const u = new URL(url);
  const target = isProxyOn() ? `/_dtproxy/${u.host}${u.pathname}` : url;
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { Authorization: authHeader(tokenType, token), 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
      body: JSON.stringify(records)
    });
  } catch (e) { throw new Error(`Request to ${u.host} failed (network/CORS): ${e && e.message || e}`); }
  const body = await res.text();
  return { status: res.status, body, url };
}
