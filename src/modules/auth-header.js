// src/modules/auth-header.js
// One place that decides the Authorization header for log ingest.
//  - Classic API token  -> "Api-Token <token>"   (scope: logs.ingest)
//  - Platform token     -> "Bearer <token>"      (scope: openpipeline:logs:ingest)
// The UI passes a platform token as "Bearer <token>"; a bare token is treated as a classic token.
export function authHeader(token) {
  const t = String(token ?? '').trim();
  return /^(Bearer|Api-Token)\s+/i.test(t) ? t : `Api-Token ${t}`;
}

/** Combine the raw token field and the token-type selector into the string the ingest code expects. */
export function credential(rawToken, scheme) {
  const t = String(rawToken ?? '').trim();
  if (!t) return '';
  return scheme === 'platform' ? `Bearer ${t}` : t;
}
