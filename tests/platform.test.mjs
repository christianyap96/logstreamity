import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlatformBase, dtFetch, formatApiError, DtApiError } from '../src/modules/dt-platform.js';
import { validateLookupPath, csvHeaderToDpl, uploadLookup, deleteLookup } from '../src/modules/lookup-client.js';
import { validateDef, buildValue, toCreateBody, pullDetectors, pushDetectors, ANALYZERS } from '../src/modules/detector-client.js';

const good = () => ({ title: 't', model: 'static', query: 'timeseries avg(m), by:{x}, interval:1m', alertCondition: 'BELOW',
  threshold: 10, violatingSamples: 3, slidingWindow: 5, dealertingSamples: 5, event: { name: 'n', description: 'd', type: 'CUSTOM_ALERT' } });

test('base url', () => {
  assert.equal(normalizePlatformBase('abc.live.dynatrace.com/x'), 'https://abc.apps.dynatrace.com');
  assert.equal(normalizePlatformBase('https://abc.apps.dynatrace.com'), 'https://abc.apps.dynatrace.com');
});
test('lookup path rules', () => {
  assert.equal(validateLookupPath('/lookups/my_team/allow_list'), null);
  for (const bad of ['', 'lookups/a', '/lookups/', '/lookups/a/', '/lookups//a', '/other/a', '/lookups/a b', '/lookups/-/a', '/lookups'])
    assert.ok(validateLookupPath(bad), bad);
});
test('csv header -> dpl', () => {
  const d = csvHeaderToDpl('Code,Category,Message');
  assert.equal(d.pattern, "LD:code ',' LD:category ',' LD:message");
  assert.equal(d.skippedRecords, 1);
  assert.throws(() => csvHeaderToDpl('a,a'));
});
test('detector validation', () => {
  assert.deepEqual(validateDef(good()), []);
  assert.ok(validateDef({ ...good(), query: 'timeseries avg(m)' }).some(e => /interval:1m/.test(e)));
  assert.ok(validateDef({ ...good(), query: 'timeseries avg(m), interval:1m, from:-1h' }).some(e => /from:/.test(e)));
  assert.ok(validateDef({ ...good(), query: 'fetch logs | summarize interval:1m' }).some(e => /timeseries/.test(e)));
  assert.ok(validateDef({ ...good(), slidingWindow: 2 }).length);
  assert.ok(validateDef({ ...good(), alertCondition: 'OUTSIDE' }).length);
  assert.ok(validateDef({ ...good(), threshold: '' }).length);
  assert.equal(validateDef({ ...good(), model: 'adaptive', alertCondition: 'OUTSIDE', threshold: undefined }).length, 0);
});
test('buildValue matches documented shape', () => {
  const v = buildValue(good());
  assert.equal(v.analyzer.name, ANALYZERS.static);
  assert.deepEqual(v.executionSettings, { actor: null, queryOffset: null });
  assert.ok(v.analyzer.input.find(i => i.key === 'threshold' && i.value === '10'));
  assert.ok(v.eventTemplate.properties.find(p => p.key === 'event.type'));
  const s = buildValue({ ...good(), model: 'seasonal', tolerance: 4 });
  assert.ok(s.analyzer.input.find(i => i.key === 'tolerance') && !s.analyzer.input.find(i => i.key === 'threshold'));
});
test('toCreateBody: raw passthrough + simplified', () => {
  const b = toCreateBody([good(), { schemaId: 'builtin:davis.anomaly-detectors', value: { a: 1 } }]);
  assert.equal(b[0].scope, 'environment'); assert.equal(b[1].scope, 'environment');
  assert.throws(() => toCreateBody([{ ...good(), title: '' }]));
});

function mockFetch(handler) { const calls = []; globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); }; return calls; }
const resp = (status, obj) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });

test('pull paginates with nextPageKey only on later pages', async () => {
  const calls = mockFetch((u, i, n) => resp(200, n === 1 ? { items: [{ objectId: 'a' }], nextPageKey: 'K' } : { items: [{ objectId: 'b' }], nextPageKey: null }));
  const items = await pullDetectors('https://e.apps.dynatrace.com', 'tok');
  assert.equal(items.length, 2);
  const u1 = new URL(calls[0].url), u2 = new URL(calls[1].url);
  assert.equal(u1.pathname, '/platform/classic/environment-api/v2/settings/objects');
  assert.equal(u1.searchParams.get('schemaIds'), 'builtin:davis.anomaly-detectors');
  assert.deepEqual([...u2.searchParams.keys()], ['nextPageKey']);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
});
test('push: validateOnly query + body', async () => {
  const calls = mockFetch(() => resp(200, [{ code: 200 }]));
  await pushDetectors('https://e.apps.dynatrace.com', 'tok', [good()], { validateOnly: true });
  assert.equal(new URL(calls[0].url).searchParams.get('validateOnly'), 'true');
  assert.equal(JSON.parse(calls[0].init.body)[0].schemaId, 'builtin:davis.anomaly-detectors');
  await pushDetectors('https://e.apps.dynatrace.com', 'tok', [good()]);
  assert.equal(new URL(calls[1].url).searchParams.get('validateOnly'), null);
});
test('lookup upload/delete requests', async () => {
  const calls = mockFetch(() => resp(200, {}));
  const file = new File(['{"code":1}\n'], 'x.jsonl');
  await uploadLookup('https://e.apps.dynatrace.com', 'tok', file, { parsePattern: 'JSON:json', lookupField: 'code', filePath: '/lookups/t/x', overwrite: true });
  assert.equal(new URL(calls[0].url).pathname, '/platform/storage/resource-store/v1/files/tabular/lookup:upload');
  const req = JSON.parse(calls[0].init.body.get('request'));
  assert.deepEqual(req, { parsePattern: 'JSON:json', lookupField: 'code', filePath: '/lookups/t/x', overwrite: true });
  assert.ok(calls[0].init.body.get('content'));
  await deleteLookup('https://e.apps.dynatrace.com', 'tok', '/lookups/t/x');
  assert.equal(new URL(calls[1].url).pathname, '/platform/storage/resource-store/v1/files:delete');
  await assert.rejects(uploadLookup('https://e.apps.dynatrace.com', 'tok', file, { parsePattern: 'x', lookupField: 'c', filePath: '/bad' }));
});
test('error formatting', async () => {
  mockFetch(() => resp(400, [{ code: 400, error: { message: 'Constraints violated.', constraintViolations: [{ path: 'value.title', message: 'must not be blank' }] } }]));
  try { await dtFetch('https://e.apps.dynatrace.com', '/x', { token: 't' }); assert.fail(); }
  catch (e) { assert.ok(e instanceof DtApiError); assert.match(formatApiError(e), /value\.title: must not be blank/); }
});
