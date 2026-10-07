import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestUrl, parseLogs, prepareRecords, parseExtra, authHeader } from '../src/modules/custom-log-client.js';

test('ingestUrl converts apps->live', () => {
  assert.equal(ingestUrl('https://abc.apps.dynatrace.com/ui'), 'https://abc.live.dynatrace.com/api/v2/logs/ingest');
  assert.equal(ingestUrl('abc.live.dynatrace.com'), 'https://abc.live.dynatrace.com/api/v2/logs/ingest');
  assert.equal(ingestUrl(''), '');
});
test('parse single pretty-printed object', () => {
  const r = parseLogs('{\n "a":1,\n "host.name":"x"\n}');
  assert.deepEqual(r.records, [{ a: 1, 'host.name': 'x' }]); assert.equal(r.format, 'json');
});
test('parse array, NDJSON, and concatenated objects', () => {
  assert.equal(parseLogs('[{"a":1},{"a":2}]').records.length, 2);
  assert.equal(parseLogs('{"a":1}\n{"a":2}').records.length, 2);
  assert.equal(parseLogs('{"a":"}{"}\n{"a":2}').records.length, 2);
});
test('plain text lines become content', () => {
  const r = parseLogs('line one\n\nline two'); assert.equal(r.format, 'text');
  assert.deepEqual(r.records, [{ content: 'line one' }, { content: 'line two' }]);
});
test('rejects empty and non-object JSON', () => {
  assert.throws(() => parseLogs('  '));
  assert.throws(() => parseLogs('[1,2]'));
});
test('prepareRecords stamps time and keeps record values over extras', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const [a, b] = prepareRecords([{ content: 'x', k: 'rec' }, { content: 'y' }], { stampNow: true, extra: { k: 'extra', e: '1' }, now });
  assert.equal(a.timestamp, '2026-10-07T12:00:00.000Z'); assert.equal(b.timestamp, '2026-10-07T12:00:00.001Z');
  assert.equal(a.k, 'rec'); assert.equal(b.k, 'extra'); assert.equal(b.e, '1');
});
test('parseExtra and authHeader', () => {
  assert.deepEqual(parseExtra('a=1\nb = x=y\nbad'), { a: '1', b: 'x=y' });
  assert.equal(authHeader('classic', 't'), 'Api-Token t'); assert.equal(authHeader('platform', 't'), 'Bearer t');
  assert.throws(() => authHeader('classic', ''));
});
