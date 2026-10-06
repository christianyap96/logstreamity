// src/modules/splunk-triage.js
// Parse a Splunk savedsearches.conf stanza and produce a migration triage report.
// Everything here is a HEURISTIC starting point; classification/target are suggestions to confirm.
import { mapGet } from './mappings.js';

const SEVERITY = { 1: 'DEBUG', 2: 'INFO', 3: 'WARN', 4: 'ERROR', 5: 'SEVERE', 6: 'FATAL' };

export function parseStanza(text) {
  const out = {}; let header = null;
  const raw = (text || '').replace(/\r/g, '').split('\n'); const lines = [];
  for (let i = 0; i < raw.length; i++) { let l = raw[i]; while (l.endsWith('\\') && i + 1 < raw.length) l = l.slice(0, -1) + raw[++i]; lines.push(l); }
  for (const l of lines) {
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const h = t.match(/^\[(.+)\]$/); if (h) { header = h[1]; continue; }
    const m = t.match(/^([^=\s][^=]*?)\s*=\s*(.*)$/); if (m) out[m[1].trim()] = m[2];
  }
  if (!out.name && header) out.name = header;
  return out;
}

export function cronToText(cron) {
  const f = (cron || '').trim().split(/\s+/);
  if (f.length !== 5) return cron || '';
  const [min, hr, dom, mon, dow] = f; let m;
  if ([hr, dom, mon, dow].every(x => x === '*')) {
    if (min === '*') return 'every minute';
    if ((m = min.match(/^\*\/(\d+)$/))) return `every ${m[1]} min (minutes 0,${m[1]},...)`;
    if ((m = min.match(/^(\d+)-(\d+)\/(\d+)$/)) || (m = min.match(/^(\d+)()\/(\d+)$/))) {
      const s = +m[1], e = m[2] === '' ? 59 : +m[2], st = +m[3], mins = []; for (let k = s; k <= e; k += st) mins.push(k);
      return `every ${st} min at minutes ${mins.join(',')} (offset ${s})`;
    }
    if (/^\d+$/.test(min)) return `hourly at minute ${min}`;
  }
  return `cron "${cron}" (not auto-described)`;
}

export function splitPipes(spl) {
  const segs = []; let cur = '', q = false, depth = 0;
  for (let i = 0; i < spl.length; i++) {
    const c = spl[i];
    if (q) { cur += c; if (c === '\\') cur += spl[++i] ?? ''; else if (c === '"') q = false; continue; }
    if (c === '"') { q = true; cur += c; continue; }
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth = Math.max(0, depth - 1);
    if (c === '|' && depth === 0) { segs.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  segs.push(cur.trim());
  return segs;
}

const CMD = {
  search: ['filter / search', 'maps'], where: ['filter', 'maps'], fields: ['fields / fieldsRemove', 'maps'], table: ['fields', 'maps'],
  rename: ['fieldsRename', 'maps'], sort: ['sort', 'maps'], head: ['limit', 'maps'], dedup: ['dedup', 'maps'], stats: ['summarize', 'maps'],
  tail: ['sort + limit', 'partial'], eval: ['fieldsAdd', 'partial', 'eval functions need case-by-case translation'],
  rex: ['parse (DPL)', 'partial', 'regex must be rewritten as DPL; test on real sample lines'], regex: ['filter matchesRegex()', 'partial'],
  timechart: ['makeTimeseries', 'partial'], chart: ['summarize', 'partial'], top: ['summarize + sort + limit', 'partial'], rare: ['summarize + sort + limit', 'partial'],
  lookup: ['lookup (needs lookup file in Grail)', 'partial', 'upload the lookup file first'], inputlookup: ['load (lookup file)', 'partial'],
  spath: ['parse with JSON matcher', 'partial'], mvexpand: ['expand', 'partial'], bin: ['bin()', 'partial'], bucket: ['bin()', 'partial'], fillnull: ['coalesce()', 'partial'],
  join: ['join', 'partial', 'check cost and subsearch limits'], append: ['append', 'partial'], multisearch: ['append', 'partial'],
  eventstats: [null, 'manual', 'no direct equivalent'], streamstats: [null, 'manual', 'no direct equivalent'],
  transaction: [null, 'manual', 'no direct equivalent: redesign'], map: [null, 'manual', 'no direct equivalent: redesign'],
  tstats: [null, 'manual', 'depends on data model / summaries: redesign'], outputlookup: [null, 'manual', 'writes lookups: redesign'], appendcols: [null, 'manual', 'review']
};

export function scanSpl(spl) {
  const segs = splitPipes(spl || '');
  const base = segs[0] || '';
  const commands = [];
  segs.slice(1).forEach(s => {
    const c = (s.match(/^([A-Za-z_]+)/) || [])[1]; if (!c) return;
    const k = c.toLowerCase(); const e = CMD[k];
    commands.push({ cmd: k, dql: e ? e[0] : null, status: e ? e[1] : 'manual', note: e && e[2] ? e[2] : (e ? '' : 'unknown command: review') });
  });
  const refs = {}; const used = [];
  base.replace(/([A-Za-z_][\w.]*)\s*(?:!=|>=|<=|=|>|<)\s*("[^"]*"|[^\s()|]+)/g, (full, k, v) => {
    (refs[k] = refs[k] || []).push(v.replace(/^"|"$/g, '')); used.push(full); return full;
  });
  let rest = base; used.forEach(u => { rest = rest.replace(u, ' '); });
  const keywords = rest.split(/\s+/).map(x => x.replace(/[()]/g, '')).filter(x => x && !/^(OR|AND|NOT)$/i.test(x) && !/^search$/i.test(x));
  const extracted = []; (spl || '').replace(/\(\?P?<([A-Za-z_]\w*)>/g, (m, n) => { if (!extracted.includes(n)) extracted.push(n); return m; });
  return { base, commands, referenced: refs, keywords, extracted, macros: (spl.match(/`[^`]+`/g) || []), subsearch: /\[\s*(search|\|)/i.test(spl || '') };
}

export function extractTokens(stz) {
  const set = new Set();
  for (const [k, v] of Object.entries(stz)) {
    if (!/^action\./.test(k) && !/useNSSubject/.test(k)) continue;
    (String(v).match(/\$([\w.]+)\$/g) || []).forEach(t => set.add(t.slice(1, -1)));
  }
  return [...set];
}

export function triage(stz, maps = {}) {
  const bool = k => /^(1|true|yes)$/i.test(String(stz[k] ?? '').trim());
  const spl = stz.search || stz.qualifiedSearch || '';
  const scan = scanSpl(spl);
  const disabled = bool('disabled');
  const actions = (stz.actions || '').split(',').map(s => s.trim()).filter(Boolean).map(name => {
    const pre = `action.${name}.`; const params = {};
    Object.entries(stz).forEach(([k, v]) => { if (k.startsWith(pre)) params[k.slice(pre.length)] = v; });
    return { name, params };
  });
  const recipients = (stz['action.email.to'] || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const tokens = extractTokens(stz);
  const sevNum = stz['alert.severity']; const sevLabel = SEVERITY[sevNum] || '';
  const sevMapped = mapGet(maps.severity, sevNum) ?? mapGet(maps.severity, sevLabel);
  const suppress = bool('alert.suppress');
  const perResult = !bool('alert.digest_mode');
  const hasManual = scan.commands.some(c => c.status === 'manual');
  const resultTokens = tokens.filter(t => t.startsWith('result.'));
  const aggregates = scan.commands.some(c => ['stats', 'timechart', 'chart', 'top', 'rare'].includes(c.cmd));

  const reasons = []; let classification, target;
  if (disabled) { classification = 'RETIRE'; target = 'n/a (retire)'; reasons.push('Disabled in Splunk: confirm with the owner before migrating anything'); }
  else if (hasManual || scan.macros.length || scan.subsearch) {
    classification = 'REDESIGN'; target = 'workflow with scheduled DQL trigger';
    if (hasManual) reasons.push('SPL uses commands with no direct DQL equivalent: ' + scan.commands.filter(c => c.status === 'manual').map(c => c.cmd).join(', '));
    if (scan.macros.length) reasons.push('SPL uses macros: ' + scan.macros.join(' '));
    if (scan.subsearch) reasons.push('SPL contains a subsearch');
  } else if (aggregates && !resultTokens.length) {
    classification = 'PORT'; target = 'anomaly detector (static)'; reasons.push('Aggregating search with a threshold: start static, but check whether a baseline model would be less noisy');
  } else {
    classification = 'PORT'; target = 'workflow with scheduled DQL trigger';
    reasons.push(resultTokens.length ? 'Actions use per-result fields (' + resultTokens.map(t => '$' + t + '$').join(', ') + '): a workflow keeps row-level fields, a detector only carries dimensions' : 'Event-style search: a scheduled DQL workflow preserves per-event behavior');
  }

  const gaps = [];
  if (suppress) gaps.push(`Suppression: Splunk suppresses by [${stz['alert.suppress.fields'] || 'all results'}] for ${stz['alert.suppress.period'] || '?'}. Nothing generated reproduces this automatically; decide how duplicates are handled (detector dealerting/sliding window, workflow-side logic, problem merging) and verify.`);
  if (perResult) gaps.push('alert.digest_mode = false: Splunk fires actions once per result row (one ticket/email per event). Verify the target produces the same cardinality.');
  if (stz.cron_schedule) gaps.push(`Schedule: ${cronToText(stz.cron_schedule)}, window ${stz['dispatch.earliest_time'] || '?'} → ${stz['dispatch.latest_time'] || '?'}. A workflow schedule trigger must match both the cadence and the query timeframe; detectors evaluate continuously on 1-minute samples, so timing differs.`);
  if (stz.alert_type) gaps.push(`Trigger: ${stz.alert_type} ${stz.alert_comparator || ''} ${stz.alert_threshold || ''}`.trim() + '. Make sure the DQL result condition reproduces this.');
  if (bool('realtime_schedule')) gaps.push('realtime_schedule = true (Splunk may skip/skew runs): timing parity is approximate.');
  scan.commands.filter(c => c.status !== 'maps').forEach(c => gaps.push(`SPL "${c.cmd}": ${c.status}${c.dql ? ' → ' + c.dql : ''}${c.note ? ' (' + c.note + ')' : ''}`));
  if (resultTokens.length) gaps.push('Result tokens used in actions: ' + resultTokens.map(t => '$' + t + '$').join(', ') + '. These fields must exist in the DQL output / event properties.');
  actionsGaps(actions, gaps);

  const open = [];
  for (const [k, vals] of Object.entries(scan.referenced)) {
    if (k.toLowerCase() === 'index') vals.forEach(v => { if (mapGet(maps.buckets, v) === undefined) open.push(`No bucket mapping for index "${v}"`); });
    else if (mapGet(maps.fields, k) === undefined) open.push(`No field mapping for Splunk field "${k}"`);
  }
  scan.extracted.forEach(f => { /* extracted by rex: created in DQL by parse, not mapped */ });
  if (sevNum && sevMapped === undefined) open.push(`No severity mapping for Splunk severity ${sevNum} (${sevLabel})`);
  const routeVals = [...recipients]; const rp = actions.find(a => a.name === 'remedy')?.params || {}; const ag = rp['param.assigned_group'] ?? rp.assigned_group; if (ag) routeVals.push(ag);
  routeVals.forEach(v => { if (mapGet(maps.routing, v) === undefined) open.push(`No routing mapping for "${v}"`); });
  actions.filter(a => !['email'].includes(a.name)).forEach(a => open.push(`Action "${a.name}": how should it be delivered in Dynatrace (ticketing integration / webhook)?`));
  if (scan.macros.length) open.push('Macro definitions needed: ' + scan.macros.join(' '));

  return {
    name: stz.name || '', disabled, description: stz.description || '',
    schedule: { cron: stz.cron_schedule || '', text: cronToText(stz.cron_schedule), earliest: stz['dispatch.earliest_time'] || '', latest: stz['dispatch.latest_time'] || '', realtime: bool('realtime_schedule') },
    trigger: { type: stz.alert_type || '', comparator: stz.alert_comparator || '', threshold: stz.alert_threshold || '', perResult },
    suppression: { enabled: suppress, fields: stz['alert.suppress.fields'] || '', period: stz['alert.suppress.period'] || '' },
    severity: { num: sevNum || '', label: sevLabel, mapped: sevMapped ?? null },
    actions, recipients, tokens, spl, scan,
    hints: { classification, target, reasons }, gaps, open
  };
}

function actionsGaps(actions, gaps) {
  actions.forEach(a => {
    const n = Object.keys(a.params).length;
    if (a.name === 'email') gaps.push(`Email action → recipients/subject need a workflow email task or routing label (${n} params in stanza).`);
    else gaps.push(`Action "${a.name}" (${n} params): no automatic mapping; map its parameters to your event properties / ticketing payload.`);
  });
}

export function reportToMarkdown(r) {
  const L = [];
  L.push(`### ${r.name}`);
  L.push(`1. **Classification:** ${r.hints.classification} (suggested). ${r.hints.reasons.join('; ')}`);
  L.push(`2. **Target construct:** ${r.hints.target} (suggested)`);
  L.push('3. **DQL:** unverified until tested in a Notebook. Use your translated DQL; run it through DQL helpers (tidy + lint).');
  L.push(`4. **Routing / severity:** severity ${r.severity.num} ${r.severity.label}${r.severity.mapped ? ' → ' + r.severity.mapped : ' → (unmapped)'}; recipients: ${r.recipients.join(', ') || 'none'}; actions: ${r.actions.map(a => a.name).join(', ') || 'none'}`);
  L.push('5. **Gaps:**'); r.gaps.forEach(g => L.push(`   - ${g}`));
  if (r.open.length) { L.push('**Open questions:**'); r.open.forEach(o => L.push(`   - ${o}`)); }
  return L.join('\n');
}
