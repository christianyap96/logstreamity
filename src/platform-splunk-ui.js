// src/platform-splunk-ui.js — Splunk triage, tracker, DQL helpers, mappings (all local, nothing is sent anywhere)
import { parseStanza, triage, reportToMarkdown } from './modules/splunk-triage.js';
import { parseAllMaps, MAP_NAMES } from './modules/mappings.js';
import { collapseOrChains, lintDql, wrapMakeTimeseries, buildDataParse } from './modules/dql-helpers.js';
import { rowsToMarkdown, rowsToCsv, CLASSES, TARGETS, STATUSES } from './modules/tracker.js';

const $ = (id) => document.getElementById(id);
const log = (m) => { const el = $('log'); el.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`; el.scrollTop = el.scrollHeight; };
const guard = (fn) => async () => { try { await fn(); } catch (e) { log('ERROR ' + (e && e.message || e)); } };
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); const ok = document.execCommand && document.execCommand('copy'); ta.remove(); return !!ok; }
}
const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); };
const fillSelect = (el, opts) => { el.innerHTML = ''; opts.forEach(o => { const x = document.createElement('option'); x.textContent = o; el.appendChild(x); }); };
const setList = (ul, items, empty) => { ul.innerHTML = ''; (items.length ? items : [empty]).forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }); };

// ================= MAPPINGS =================
const MAP_KEY = 'lsty.mappings';
const mapTexts = () => Object.fromEntries(MAP_NAMES.map(n => [n, $('mp-' + n).value]));
function loadMaps() { const t = store.get(MAP_KEY, {}); MAP_NAMES.forEach(n => { $('mp-' + n).value = t[n] || ''; }); }
loadMaps();
$('mp-save').onclick = () => log(store.set(MAP_KEY, mapTexts()) ? 'Mappings saved in this browser' : 'Could not save (storage unavailable)');
$('mp-export').onclick = () => download('splunk-migration-mappings.json', JSON.stringify(mapTexts(), null, 2), 'application/json');
$('mp-import').onchange = guard(async (e) => {
  const f = e.target.files[0]; if (!f) return; const t = JSON.parse(await f.text());
  MAP_NAMES.forEach(n => { if (typeof t[n] === 'string') $('mp-' + n).value = t[n]; }); store.set(MAP_KEY, mapTexts()); log('Mappings imported and saved');
});

// ================= TRACKER =================
const TR_KEY = 'lsty.tracker';
let rows = store.get(TR_KEY, []);
const saveRows = () => store.set(TR_KEY, rows);
function renderTracker() {
  const tb = $('tr-table').querySelector('tbody'); tb.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    const cell = (child) => { const td = document.createElement('td'); td.className = 'p-1 border-b align-top'; td.appendChild(child); tr.appendChild(td); };
    const input = (k) => { const x = document.createElement('input'); x.className = 'pt-in'; x.style.marginTop = 0; x.value = r[k] || ''; x.oninput = () => { r[k] = x.value; saveRows(); }; return x; };
    const area = (k) => { const x = document.createElement('textarea'); x.className = 'pt-in'; x.style.marginTop = 0; x.rows = 3; x.value = r[k] || ''; x.oninput = () => { r[k] = x.value; saveRows(); }; return x; };
    const sel = (k, opts) => { const x = document.createElement('select'); x.className = 'pt-in'; x.style.marginTop = 0; fillSelect(x, opts); x.value = r[k] || opts[0]; x.onchange = () => { r[k] = x.value; saveRows(); }; return x; };
    cell(input('alert')); cell(sel('classification', CLASSES)); cell(sel('target', TARGETS)); cell(area('open')); cell(sel('status', STATUSES));
    const del = document.createElement('button'); del.className = 'pt-btn pt-btn-outline'; del.textContent = '✕'; del.onclick = () => { rows.splice(i, 1); saveRows(); renderTracker(); }; cell(del);
    tb.appendChild(tr);
  });
}
const newRow = (o = {}) => ({ alert: '', classification: CLASSES[0], target: TARGETS[0], open: '', status: STATUSES[0], ...o });
$('tr-add').onclick = () => { rows.push(newRow()); saveRows(); renderTracker(); };
$('tr-md').onclick = async () => { if (!rows.length) return log('Tracker is empty'); log((await copyText(rowsToMarkdown(rows))) ? 'Markdown table copied' : 'Copy failed'); };
$('tr-csv').onclick = () => { if (!rows.length) return log('Tracker is empty'); download('migration-tracker.csv', rowsToCsv(rows), 'text/csv'); };
$('tr-json-out').onclick = () => { if (!rows.length) return log('Tracker is empty'); download('migration-tracker.json', JSON.stringify(rows, null, 2), 'application/json'); };
$('tr-json-in').onchange = guard(async (e) => {
  const f = e.target.files[0]; if (!f) return; const d = JSON.parse(await f.text());
  if (!Array.isArray(d)) throw new Error('Expected a JSON array'); rows = rows.concat(d.map(newRow)); saveRows(); renderTracker(); log(`Imported ${d.length} row(s)`);
});
$('tr-clear').onclick = () => { if (confirm('Delete all tracker rows? (Export first if you need them.)')) { rows = []; saveRows(); renderTracker(); } };
renderTracker();

// ================= TRIAGE =================
fillSelect($('tz-class'), CLASSES); fillSelect($('tz-target'), TARGETS);
let lastReport = null;
function renderReport(r) {
  lastReport = r; $('tz-out').style.display = 'block';
  $('tz-class').value = r.hints.classification; $('tz-target').value = r.hints.target;
  $('tz-reasons').textContent = 'Why (heuristic): ' + r.hints.reasons.join(' · ');
  const facts = [
    ['Name', r.name], ['Disabled', String(r.disabled)], ['Schedule', r.schedule.text], ['Window', `${r.schedule.earliest} → ${r.schedule.latest}`],
    ['Trigger', `${r.trigger.type} ${r.trigger.comparator} ${r.trigger.threshold}`.trim() + (r.trigger.perResult ? ' (fires per result)' : ' (digest)')],
    ['Suppression', r.suppression.enabled ? `by [${r.suppression.fields}] for ${r.suppression.period}` : 'none'],
    ['Severity', `${r.severity.num} ${r.severity.label} → ${r.severity.mapped ?? '(unmapped)'}`],
    ['Actions', r.actions.map(a => a.name).join(', ') || 'none'], ['Recipients', r.recipients.join(', ') || 'none'],
    ['Result tokens', r.tokens.map(t => '$' + t + '$').join(', ') || 'none'],
    ['Base search terms', r.scan.keywords.join(' ') || '—'],
    ['Fields referenced', Object.entries(r.scan.referenced).map(([k, v]) => `${k}=${v.join('|')}`).join('  ') || '—'],
    ['Fields extracted by rex', r.scan.extracted.join(', ') || '—']
  ];
  const tb = $('tz-facts').querySelector('tbody'); tb.innerHTML = '';
  facts.forEach(([k, v]) => { const tr = document.createElement('tr'); const a = document.createElement('td'); a.className = 'p-1 border-b font-semibold align-top'; a.style.width = '12rem'; a.textContent = k; const b = document.createElement('td'); b.className = 'p-1 border-b'; b.style.wordBreak = 'break-all'; b.textContent = v; tr.append(a, b); tb.appendChild(tr); });
  const cb = $('tz-cmds').querySelector('tbody'); cb.innerHTML = '';
  r.scan.commands.forEach(c => { const tr = document.createElement('tr'); [c.cmd, c.dql || '—', c.status, c.note].forEach(t => { const td = document.createElement('td'); td.className = 'p-1 border-b'; td.textContent = t; tr.appendChild(td); }); cb.appendChild(tr); });
  setList($('tz-gaps'), r.gaps, 'None detected');
  setList($('tz-open'), r.open, 'None: all referenced items are mapped');
}
$('tz-run').onclick = guard(async () => {
  const stz = parseStanza($('tz-in').value); if (!Object.keys(stz).length) throw new Error('Paste a stanza (key = value lines) first');
  renderReport(triage(stz, parseAllMaps(mapTexts())));
});
$('tz-sample').onclick = guard(async () => {
  const r = await fetch('examples/splunk-stanza.sample.txt'); if (!r.ok) throw new Error('Could not load sample (HTTP ' + r.status + ')');
  $('tz-in').value = await r.text();
});
$('tz-copy').onclick = async () => { if (!lastReport) return; const md = reportToMarkdown({ ...lastReport, hints: { ...lastReport.hints, classification: $('tz-class').value, target: $('tz-target').value } }); log((await copyText(md)) ? 'Report copied' : 'Copy failed'); };
$('tz-add').onclick = () => {
  if (!lastReport) return;
  rows.push(newRow({ alert: lastReport.name, classification: $('tz-class').value, target: $('tz-target').value, open: lastReport.open.join('; ') }));
  saveRows(); renderTracker(); log(`Added "${lastReport.name}" to the tracker`);
};

// ================= DQL HELPERS =================
$('dq-tidy').onclick = guard(async () => {
  const src = $('dq-in').value; if (!src.trim()) throw new Error('Paste DQL first');
  const r = collapseOrChains(src, $('dq-mode').value); $('dq-out').value = r.dql;
  const items = lintDql(r.dql).map(x => `[${x.level}] ${x.msg}`); if (r.collapsed) items.unshift(`[done] collapsed ${r.collapsed} OR-chain(s)`);
  setList($('dq-lint'), items, 'No findings');
});
$('dq-copy').onclick = async () => { const t = $('dq-out').value; if (t) log((await copyText(t)) ? 'Copied' : 'Copy failed'); };
$('dq-use').onclick = () => { $('mt-in').value = $('dq-out').value; };
$('mt-run').onclick = guard(async () => {
  const r = wrapMakeTimeseries($('mt-in').value, $('mt-by').value.split(','), $('mt-agg').value.trim() || 'count()');
  $('mt-out').value = r.dql; setList($('mt-warn'), r.warnings, '');
});
$('mt-copy').onclick = async () => { const t = $('mt-out').value; if (t) log((await copyText(t)) ? 'Copied' : 'Copy failed'); };
$('ps-run').onclick = guard(async () => { $('ps-out').value = buildDataParse($('ps-lines').value.split('\n'), $('ps-pattern').value, { preserve: $('ps-preserve').checked }); });
$('ps-copy').onclick = async () => { const t = $('ps-out').value; if (t) log((await copyText(t)) ? 'Copied' : 'Copy failed'); };
