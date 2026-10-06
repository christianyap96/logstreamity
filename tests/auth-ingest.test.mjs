import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { authHeader, credential } from '../src/modules/auth-header.js';
import { processEndpointUrl } from '../src/ingest.js';
import { ingestSequential } from '../src/modules/ingest-sequential.js';

test('authHeader / credential', () => {
  assert.equal(authHeader('dt0c01.abc'), 'Api-Token dt0c01.abc');
  assert.equal(authHeader('Bearer dt0s16.abc'), 'Bearer dt0s16.abc');
  assert.equal(authHeader('api-token x'), 'api-token x');
  assert.equal(credential('  dt0s16.abc ', 'platform'), 'Bearer dt0s16.abc');
  assert.equal(credential('dt0c01.abc', 'classic'), 'dt0c01.abc');
  assert.equal(credential('', 'platform'), '');
});

test('processEndpointUrl: apps host maps to live host, live unchanged', () => {
  assert.equal(processEndpointUrl('https://hca.apps.dynatrace.com'), 'https://hca.live.dynatrace.com/api/v2/logs/ingest');
  assert.equal(processEndpointUrl('hca.apps.dynatrace.com/ui/x#y'), 'https://hca.live.dynatrace.com/api/v2/logs/ingest');
  assert.equal(processEndpointUrl('https://abc12345.live.dynatrace.com'), 'https://abc12345.live.dynatrace.com/api/v2/logs/ingest');
  assert.equal(processEndpointUrl('https://abc.sprint.apps.dynatracelabs.com'), 'https://abc.sprint.dynatracelabs.com/api/v2/logs/ingest');
});

test('ingestSequential sends the right Authorization header', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(init.headers.Authorization); return { ok: true, status: 200, headers: { get: () => null }, text: async () => '' }; };
  // ingestSequential never stops its RateLimiter interval (harmless in a browser tab); unref it so the test process can exit
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { const t = realSetInterval(fn, ms); if (t && t.unref) t.unref(); return t; };
  try {
    await ingestSequential({ lines: ['a'], batchSize: 1, delayMs: 0, url: 'https://x/api/v2/logs/ingest', token: 'Bearer P1' });
    await ingestSequential({ lines: ['a'], batchSize: 1, delayMs: 0, url: 'https://x/api/v2/logs/ingest', token: 'C1' });
  } finally { globalThis.setInterval = realSetInterval; }
  assert.deepEqual(seen, ['Bearer P1', 'Api-Token C1']);
});

async function runWorker(token) {
  const src = fs.readFileSync(new URL('../src/webhook-worker.js', import.meta.url), 'utf8');
  const headers = [], msgs = [];
  const self = { postMessage: (m) => msgs.push(m) };
  const ctx = { self, console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Map, Set, Array, Object, String, Number, parseInt, isFinite, Uint32Array,
    AbortController, crypto: globalThis.crypto,
    fetch: async (url, init) => { headers.push({ url, auth: init.headers.Authorization }); return { ok: true, status: 200, headers: { get: () => null }, text: async () => '' }; } };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  await self.onmessage({ data: { type: 'START_INGEST', config: { endpoint: 'https://x/api/v2/logs/ingest', token, mode: 'sequential', delayMs: 0, batchSize: 1, randomize: false, attributes: {}, rateLimitPerSecond: 90, loop: false }, lines: ['hello'], workerInfo: { id: 'w1', name: 'w' } } });
  return { headers, msgs };
}
test('webhook worker: platform token goes out as Bearer, classic as Api-Token', async () => {
  const p = await runWorker('Bearer PLAT'); assert.ok(p.headers.length >= 1, JSON.stringify(p.msgs)); assert.equal(p.headers[0].auth, 'Bearer PLAT');
  const c = await runWorker('CLASSIC'); assert.equal(c.headers[0].auth, 'Api-Token CLASSIC');
});

test('no hardcoded Api-Token header remains in ingest code', () => {
  for (const f of ['../src/ingest.js', '../src/modules/ingest-sequential.js', '../src/webhook-worker.js'])
    assert.ok(!/Api-Token \$\{token\}/.test(fs.readFileSync(new URL(f, import.meta.url), 'utf8')), f);
});
