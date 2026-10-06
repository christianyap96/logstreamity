import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseStanza, cronToText, splitPipes, scanSpl, triage, reportToMarkdown } from '../src/modules/splunk-triage.js';
import { parseMap, mapGet, parseAllMaps } from '../src/modules/mappings.js';
import { collapseOrChains, lintDql, wrapMakeTimeseries, buildDataParse } from '../src/modules/dql-helpers.js';
import { rowsToMarkdown, rowsToCsv } from '../src/modules/tracker.js';
import { pullWorkflows, pullWorkflowById, normalizeWorkflowList, summarizeWorkflow } from '../src/modules/workflow-client.js';
import { buildValue, validateDef } from '../src/modules/detector-client.js';

const sample = fs.readFileSync(new URL('../examples/splunk-stanza.sample.txt', import.meta.url), 'utf8');

test('parseStanza', () => {
  const s = parseStanza(sample);
  assert.equal(s.name, '_bgp_change_example_circuit'); assert.equal(s.disabled, 'true'); assert.equal(s['alert.suppress.period'], '1h');
  assert.ok(s.search.includes('ROUTING-BGP-5-ADJCHANGE_DETAIL')); assert.equal(s['eai:type'], 'alert');
  assert.equal(parseStanza('[x]\na = 1').name, 'x');
});
test('cronToText', () => {
  assert.match(cronToText('2-59/15 * * * *'), /every 15 min at minutes 2,17,32,47 \(offset 2\)/);
  assert.match(cronToText('*/5 * * * *'), /every 5 min/);
  assert.match(cronToText('0 3 * * 1'), /not auto-described/);
});
test('splitPipes ignores pipes inside quotes', () => {
  const segs = splitPipes('index=a |rex "x(\\|\\()" | table a b');
  assert.equal(segs.length, 3); assert.ok(segs[1].startsWith('rex'));
});
test('scanSpl', () => {
  const scan = scanSpl(parseStanza(sample).search);
  assert.deepEqual(scan.commands.map(c => c.cmd), ['rex', 'table']);
  assert.deepEqual(scan.referenced.host, ['router-a.example.net', 'router-b.example.net']);
  assert.deepEqual(scan.referenced.index, ['example_idx']);
  assert.deepEqual(scan.extracted, ['ip_addr', 'neighbor_ip', 'change_type', 'detailed_message']);
  assert.ok(scan.keywords.includes('ROUTING-BGP-5-ADJCHANGE_DETAIL'));
  const m = scanSpl('index=a | transaction host | lookup t x OUTPUT y | `my_macro`');
  assert.equal(m.commands.find(c => c.cmd === 'transaction').status, 'manual'); assert.equal(m.macros.length, 1);
});
test('triage: disabled alert is a RETIRE candidate; gaps and open questions surfaced', () => {
  const r = triage(parseStanza(sample), {});
  assert.equal(r.hints.classification, 'RETIRE');
  assert.ok(r.gaps.some(g => g.startsWith('Suppression') && g.includes('host') && g.includes('1h')));
  assert.ok(r.gaps.some(g => g.includes('digest_mode')));
  assert.ok(r.gaps.some(g => g.includes('minutes 2,17,32,47')));
  assert.deepEqual(r.tokens.sort(), ['result.change_type', 'result.detailed_message', 'result.host', 'result.ip_addr', 'result.neighbor_ip']);
  assert.ok(r.open.includes('No bucket mapping for index "example_idx"'));
  assert.ok(r.open.includes('No field mapping for Splunk field "host"'));
  assert.ok(r.open.some(o => o.includes('severity 3')));
  assert.ok(r.open.some(o => o.includes('example_ops_24x7')));
  assert.ok(r.open.some(o => o.includes('Action "remedy"')));
});
test('triage: mappings clear open questions; enabled alert becomes PORT workflow', () => {
  const maps = parseAllMaps({ fields: 'host = host.name', buckets: 'example_idx = example_bucket', severity: '3 = CUSTOM_ALERT', routing: 'example_ops_24x7 = ops-team\nuser1@example.com = ops-team\nuser2@example.com = ops-team' });
  const stz = parseStanza(sample); stz.disabled = 'false';
  const r = triage(stz, maps);
  assert.equal(r.hints.classification, 'PORT'); assert.equal(r.hints.target, 'workflow with scheduled DQL trigger');
  assert.ok(!r.open.some(o => /mapping/.test(o))); assert.equal(r.severity.mapped, 'CUSTOM_ALERT');
  assert.match(reportToMarkdown(r), /Classification:\*\* PORT/);
});
test('triage: manual commands force REDESIGN', () => {
  const r = triage({ name: 'x', search: 'index=a | transaction host', disabled: 'false', 'alert.digest_mode': '1' }, {});
  assert.equal(r.hints.classification, 'REDESIGN');
});
test('mappings parse', () => {
  const m = parseMap('# c\nHost = host.name\nindex -> bkt\nsev\t3');
  assert.equal(mapGet(m, 'host'), 'host.name'); assert.equal(mapGet(m, 'INDEX'), 'bkt'); assert.equal(mapGet(m, 'sev'), '3'); assert.equal(mapGet(m, 'nope'), undefined);
});
test('collapseOrChains', () => {
  const src = 'filter contains(content, "X") AND (host.name == "a.net" OR host.name == "b.net" OR host.name == "c.net")';
  const r = collapseOrChains(src);
  assert.equal(r.collapsed, 1); assert.ok(r.dql.includes('in(host.name, {"a.net", "b.net", "c.net"})'));
  assert.ok(collapseOrChains(src, 'matchesValue').dql.includes('matchesValue(host.name, {"a.net", "b.net", "c.net"})'));
  const mixed = 'filter a == "1" OR b == "2"'; assert.equal(collapseOrChains(mixed).dql, mixed);
});
test('lintDql', () => {
  const l = lintDql('fetch logs | filter contains(content, "x", caseSensitive:false) | filter host.name == "a" or true');
  assert.ok(l.some(x => /bucket/.test(x.msg))); assert.ok(l.some(x => /caseSensitive/.test(x.msg)));
  assert.ok(lintDql('fetch logs, from:-1h').some(x => /timeframe/.test(x.msg)));
  assert.ok(!lintDql('fetch logs, bucket:{"a"}').some(x => /no bucket/i.test(x.msg)));
});
test('wrapMakeTimeseries', () => {
  const r = wrapMakeTimeseries('fetch logs, bucket:{"a"}\n| filter x == "1"\n|', ['host.name', 'neighbor_ip']);
  assert.ok(r.dql.endsWith('| makeTimeseries count(), by:{host.name, neighbor_ip}, interval:1m')); assert.deepEqual(r.warnings, []);
  assert.ok(wrapMakeTimeseries('fetch logs, from:-1h | filter a', []).warnings.length);
  assert.throws(() => wrapMakeTimeseries(' ', []));
});
test('buildDataParse', () => {
  const d = buildDataParse(['line "one"', '', 'line two'], "DATA 'x' LD:y");
  assert.ok(d.startsWith('data json:"[{\\"content\\":\\"line \\\\\\"one\\\\\\"\\"},{\\"content\\":\\"line two\\"}]"'));
  assert.ok(d.includes(`| parse content, """DATA 'x' LD:y""", preserveFieldsOnFailure: true`));
  assert.throws(() => buildDataParse([], 'x')); assert.throws(() => buildDataParse(['a'], 'a"""b'));
});
test('tracker export', () => {
  const rows = [{ alert: 'a|b', classification: 'PORT', target: 't', open: 'q1; q2', status: 'todo' }];
  assert.ok(rowsToMarkdown(rows).includes('a\\|b')); assert.ok(rowsToCsv(rows).includes('"q1; q2","todo"'));
});
test('detector builder: alert_group and extra properties', () => {
  const def = { title: 't', model: 'static', query: 'timeseries avg(m), interval:1m', alertCondition: 'ABOVE', threshold: 1, violatingSamples: 1, slidingWindow: 1, dealertingSamples: 1,
    event: { name: 'n', description: 'd', type: 'CUSTOM_ALERT', alertGroup: 'ops-team', extra: [{ key: 'email.to', value: 'a@example.com' }, { key: 'event.name', value: 'dup' }] } };
  assert.deepEqual(validateDef(def), []);
  const p = buildValue(def).eventTemplate.properties;
  assert.ok(p.find(x => x.key === 'dt.alert_group' && x.value === 'ops-team')); assert.ok(p.find(x => x.key === 'email.to'));
  assert.equal(p.filter(x => x.key === 'event.name').length, 1);
  assert.ok(validateDef({ ...def, event: { ...def.event, extra: [{ key: '' }] } }).length);
});

function mockFetch(handler) { const calls = []; globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); }; return calls; }
const resp = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
test('workflows: pagination by offset, envelope shapes, by-id', async () => {
  const calls = mockFetch((u, i, n) => resp(n === 1 ? { count: 3, results: [{ id: 'a' }, { id: 'b' }] } : { count: 3, results: [{ id: 'c' }] }));
  const all = await pullWorkflows('https://e.apps.dynatrace.com', 'tok', { search: 'pci' });
  assert.deepEqual(all.map(w => w.id), ['a', 'b', 'c']);
  const u1 = new URL(calls[0].url), u2 = new URL(calls[1].url);
  assert.equal(u1.pathname, '/platform/automation/v1/workflows'); assert.equal(u1.searchParams.get('search'), 'pci'); assert.equal(u1.searchParams.get('offset'), null);
  assert.equal(u2.searchParams.get('offset'), '2');
  assert.equal(normalizeWorkflowList([{ id: 1 }]).length, 1); assert.equal(normalizeWorkflowList({ items: [{}] }).length, 1); assert.equal(normalizeWorkflowList({}).length, 0);
  const c2 = mockFetch(() => resp({ id: 'x', title: 'T' }));
  assert.equal((await pullWorkflowById('https://e.apps.dynatrace.com', 'tok', 'a/b')).id, 'x');
  assert.ok(c2[0].url.endsWith('/platform/automation/v1/workflows/a%2Fb')); await assert.rejects(pullWorkflowById('https://e.apps.dynatrace.com', 'tok', ''));
  const s = summarizeWorkflow({ id: 'i', title: 'W', owner: 'o', trigger: { eventTrigger: { isActive: true, triggerConfiguration: { value: { customFilter: 'matchesValue(x, "y")' } } } }, tasks: { a: {}, b: {} } });
  assert.deepEqual(s, { id: 'i', title: 'W', trigger: 'eventTrigger', active: 'true', filter: 'matchesValue(x, "y")', tasks: 2, owner: 'o' });
});
