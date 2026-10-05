// src/modules/dt-platform.js
// Shared helpers for Dynatrace *platform* APIs (Bearer auth, *.apps.dynatrace.com).
// Separate from the Logs v2 ingest path (Api-Token, *.live.dynatrace.com).

/**
 * Normalize a tenant URL to the platform base: https://<env>.apps.dynatrace.com
 * Only the documented live -> apps conversion is applied. For any other domain
 * (sprint/dev/managed) paste the *.apps.* URL yourself; it is used as-is.
 */
export function normalizePlatformBase(input) {
  if (!input) return '';
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return ''; }
  u.hostname = u.hostname.replace(/\.live\.dynatrace\.com$/i, '.apps.dynatrace.com');
  return u.origin;
}

export class DtApiError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    this.body = body;
  }
}

/** Fetch wrapper: Bearer token, parses JSON when possible, throws DtApiError on !ok. */
export async function dtFetch(base, path, { token, method = 'GET', query, headers = {}, body } = {}) {
  if (!base) throw new Error('Platform base URL is missing or invalid');
  if (!token) throw new Error('Platform token is missing');
  const url = new URL(path, base);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers },
    body
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  if (!res.ok) throw new DtApiError(res.status, parsed, url.pathname);
  return { status: res.status, data: parsed };
}

/** Compact, human-readable rendering of an API error (incl. constraint violations). */
export function formatApiError(err) {
  if (!(err instanceof DtApiError)) return String(err && err.message || err);
  const b = err.body;
  const items = Array.isArray(b) ? b : [b];
  const lines = [`${err.message}`];
  for (const it of items) {
    const e = it && (it.error || it);
    if (e && e.message) lines.push(`  ${e.message}`);
    for (const cv of (e && e.constraintViolations) || []) lines.push(`  - ${cv.path ? cv.path + ': ' : ''}${cv.message}`);
  }
  if (lines.length === 1 && b) lines.push('  ' + (typeof b === 'string' ? b : JSON.stringify(b)));
  return lines.join('\n');
}
