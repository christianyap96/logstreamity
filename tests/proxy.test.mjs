import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer, defaultHostAllowed } from '../server/local-proxy.mjs';
import { setProxy, dtFetch } from '../src/modules/dt-platform.js';
import { pullDetectors } from '../src/modules/detector-client.js';
import { uploadLookup } from '../src/modules/lookup-client.js';

const realFetch = globalThis.fetch;
const upstreamCalls = [];
let srv, port;
const upstream = async (url, init) => {
  upstreamCalls.push({ url, init });
  if (url.includes('/settings/objects') && !url.includes('/settings/objects/')) return new Response(JSON.stringify({ items: [{ objectId: 'a' }] }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1', 'x-test': 'y' } });
  return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1', 'x-test': 'y' } });
};
before(async () => { srv = createProxyServer({ upstream }); await new Promise(r => srv.listen(0, '127.0.0.1', r)); port = srv.address().port; });
after(() => { globalThis.fetch = realFetch; setProxy(false); srv.close(); });

const raw = (p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() })); });
  r.on('error', reject); if (body) r.write(body); r.end();
});

test('hostAllowed only accepts dynatrace domains', () => {
  for (const ok of ['abc.apps.dynatrace.com', 'abc.live.dynatrace.com', 'x.sprint.apps.dynatracelabs.com']) assert.ok(defaultHostAllowed(ok), ok);
  for (const bad of ['evil.com', 'dynatrace.com.evil.com', 'abc.dynatrace.com.evil.com', '127.0.0.1', 'localhost', '', 'a.b/c.dynatrace.com']) assert.ok(!defaultHostAllowed(bad), bad);
});
test('health + static files', async () => {
  assert.equal(JSON.parse((await raw('/_dtproxy/health')).body).proxy, true);
  const idx = await raw('/platform.html'); assert.equal(idx.status, 200); assert.match(idx.headers['content-type'], /text\/html/); assert.ok(idx.body.includes('Platform tools'));
  assert.equal((await raw('/src/platform-main.js')).status, 200);
});
test('static: traversal, dotfiles and server dir are refused', async () => {
  for (const p of ['/..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/.git/config', '/server/local-proxy.mjs', '/nope.html'])
    assert.ok([403, 404].includes((await raw(p)).status), p);
});
test('refuses bad Host header (DNS rebinding) and cross-origin Origin', async () => {
  assert.equal((await raw('/_dtproxy/health', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await raw('/platform.html', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await raw('/_dtproxy/health', { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
});
test('proxy refuses non-dynatrace hosts and odd methods', async () => {
  const n = upstreamCalls.length;
  assert.equal((await raw('/_dtproxy/evil.com/platform/x')).status, 403);
  assert.equal((await raw('/_dtproxy/abc.dynatrace.com.evil.com/x')).status, 403);
  assert.equal((await raw('/_dtproxy/abc.apps.dynatrace.com/x', { method: 'PATCH' })).status, 405);
  assert.equal(upstreamCalls.length, n);
});
test('proxy forwards path/query/auth, strips cookies and origin, drops set-cookie', async () => {
  const r = await raw('/_dtproxy/abc.apps.dynatrace.com/platform/classic/environment-api/v2/settings/objects/ab%2Bc%3D%3D?offset=2',
    { headers: { Authorization: 'Bearer T', Cookie: 'sid=1', Referer: 'http://x/', Accept: 'application/json', 'X-Evil': '1' } });
  assert.equal(r.status, 201); assert.equal(r.headers['x-test'], 'y'); assert.equal(r.headers['set-cookie'], undefined);
  const c = upstreamCalls.at(-1);
  assert.equal(c.url, 'https://abc.apps.dynatrace.com/platform/classic/environment-api/v2/settings/objects/ab%2Bc%3D%3D?offset=2');
  assert.deepEqual(Object.keys(c.init.headers).sort(), ['accept', 'authorization']); assert.equal(c.init.headers.authorization, 'Bearer T');
  assert.equal(c.init.redirect, 'manual');
});
test('proxy forwards POST body', async () => {
  await raw('/_dtproxy/abc.apps.dynatrace.com/p', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[{"a":1}]' });
  const c = upstreamCalls.at(-1); assert.equal(c.init.method, 'POST'); assert.equal(Buffer.from(c.init.body).toString(), '[{"a":1}]'); assert.equal(c.init.headers['content-type'], 'application/json');
});

// ---- real client modules through the real proxy ----
function viaProxy() { globalThis.fetch = (u, init) => realFetch(String(u).startsWith('/') ? `http://127.0.0.1:${port}${u}` : u, init); setProxy(true); }
test('client: detectors pull goes through the proxy', async () => {
  viaProxy();
  const items = await pullDetectors('https://abc.apps.dynatrace.com', 'TOK');
  assert.deepEqual(items.map(i => i.objectId), ['a']);
  const c = upstreamCalls.at(-1); assert.ok(c.url.startsWith('https://abc.apps.dynatrace.com/platform/classic/environment-api/v2/settings/objects?')); assert.equal(c.init.headers.authorization, 'Bearer TOK');
});
test('client: multipart lookup upload survives the proxy', async () => {
  viaProxy();
  await uploadLookup('https://abc.apps.dynatrace.com', 'TOK', new File(['{"code":1}\n'], 'x.jsonl'), { parsePattern: 'JSON:json', lookupField: 'code', filePath: '/lookups/t/x', overwrite: true });
  const c = upstreamCalls.at(-1); assert.match(c.init.headers['content-type'], /^multipart\/form-data; boundary=/);
  const body = Buffer.from(c.init.body).toString(); assert.ok(body.includes('name="request"') && body.includes('"parsePattern":"JSON:json"') && body.includes('name="content"') && body.includes('{"code":1}'));
});
test('client: without proxy a blocked fetch explains CORS', async () => {
  setProxy(false); globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(dtFetch('https://abc.apps.dynatrace.com', '/x', { token: 't' }), /CORS[\s\S]*run-local-proxy\.cmd/);
});
