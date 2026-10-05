// src/platform-main.js — wiring for platform.html
import { normalizePlatformBase, formatApiError } from './modules/dt-platform.js';
import { validateLookupPath, csvHeaderToDpl, testPattern, uploadLookup, deleteLookup, verifyDql } from './modules/lookup-client.js';
import { pullDetectors, pushDetectors, summarize, toCreateBody, EVENT_TYPES } from './modules/detector-client.js';

const $ = (id) => document.getElementById(id);
const log = (m) => { const el = $('log'); el.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`; el.scrollTop = el.scrollHeight; };
const conn = () => ({ base: normalizePlatformBase($('base').value), token: $('ptoken').value.trim() });
const guard = (fn) => async () => { try { await fn(); } catch (e) { log('ERROR ' + formatApiError(e)); } };
let pulled = [];

// ---------- Lookups ----------
const lkFile = () => { const f = $('lk-file').files[0]; if (!f) throw new Error('Choose a file first'); return f; };
const lkParams = () => ({
  parsePattern: $('lk-pattern').value.trim(), lookupField: $('lk-field').value.trim(), filePath: $('lk-path').value.trim(),
  displayName: $('lk-display').value.trim(), description: $('lk-desc').value.trim(),
  overwrite: $('lk-overwrite').checked, skippedRecords: $('lk-skip').value === '' ? undefined : Number($('lk-skip').value)
});

$('lk-preset-jsonl').onclick = () => { $('lk-pattern').value = 'JSON:json'; $('lk-skip').value = ''; };
$('lk-preset-csv').onclick = guard(async () => {
  const text = await lkFile().slice(0, 64 * 1024).text();
  const d = csvHeaderToDpl(text.split(/\r?\n/)[0]);
  $('lk-pattern').value = d.pattern; $('lk-skip').value = d.skippedRecords;
  if (!$('lk-field').value) $('lk-field').value = d.fields[0];
  log(`CSV pattern derived (fields: ${d.fields.join(', ')}). Naive: no quoted fields. Run "Test pattern".`);
});
$('lk-test').onclick = guard(async () => {
  const { base, token } = conn(); const p = lkParams();
  const r = await testPattern(base, token, lkFile(), p);
  log('Test OK:\n' + JSON.stringify(r.data, null, 2).slice(0, 4000));
});
$('lk-upload').onclick = guard(async () => {
  const { base, token } = conn(); const p = lkParams();
  const r = await uploadLookup(base, token, lkFile(), p);
  log(`Upload OK (HTTP ${r.status}) → ${p.filePath}\nVerify in a Notebook:\n  ${verifyDql(p.filePath).join('\n  ')}`);
});
$('lk-delete').onclick = guard(async () => {
  const { base, token } = conn(); const path = $('lk-path').value.trim();
  const err = validateLookupPath(path); if (err) throw new Error(err);
  if (prompt(`Deletion is irreversible. Type the path to confirm:\n${path}`) !== path) { log('Delete cancelled'); return; }
  await deleteLookup(base, token, path); log('Deleted ' + path);
});

// ---------- Detectors ----------
EVENT_TYPES.forEach(t => { const o = document.createElement('option'); o.textContent = t; $('f-etype').appendChild(o); });
$('f-etype').value = 'CUSTOM_ALERT';

function renderTable(rows) {
  const cols = ['title', 'enabled', 'model', 'condition', 'threshold', 'source', 'externalId', 'query'];
  $('ad-table').querySelector('thead').innerHTML = '<tr>' + cols.map(c => `<th class="text-left p-1 border-b">${c}</th>`).join('') + '</tr>';
  const tb = $('ad-table').querySelector('tbody'); tb.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const c of cols) { const td = document.createElement('td'); td.className = 'p-1 border-b align-top'; td.textContent = r[c] ?? ''; tr.appendChild(td); }
    tb.appendChild(tr);
  }
}
$('ad-pull').onclick = guard(async () => {
  const { base, token } = conn(); pulled = await pullDetectors(base, token);
  renderTable(pulled.map(summarize)); log(`Pulled ${pulled.length} detector(s)`);
});
$('ad-export').onclick = () => {
  if (!pulled.length) return log('Nothing pulled yet');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(pulled, null, 2)], { type: 'application/json' }));
  a.download = 'anomaly-detectors-export.json'; a.click();
};
$('ad-import').onchange = async (e) => { const f = e.target.files[0]; if (f) $('ad-json').value = await f.text(); };
$('ad-fill').onclick = guard(async () => {
  const [v, w, d] = $('f-win').value.split('/').map(s => Number(s.trim()));
  const def = {
    title: $('f-title').value.trim(), model: $('f-model').value, query: $('f-query').value.trim(),
    alertCondition: $('f-cond').value, threshold: $('f-thr').value.trim(),
    violatingSamples: v, slidingWindow: w, dealertingSamples: d, alertOnMissingData: false,
    event: { name: $('f-ename').value.trim(), description: $('f-edesc').value.trim(), type: $('f-etype').value, sourceEntity: $('f-ent').value.trim() || undefined }
  };
  if ($('f-ext').value.trim()) def.externalId = $('f-ext').value.trim();
  $('ad-json').value = JSON.stringify([def], null, 2);
});
const parseItems = () => { const items = JSON.parse($('ad-json').value || '[]'); if (!Array.isArray(items) || !items.length) throw new Error('Provide a non-empty JSON array'); return items; };
$('ad-validate').onclick = guard(async () => {
  const { base, token } = conn(); const items = parseItems(); toCreateBody(items); // client-side checks first
  const r = await pushDetectors(base, token, items, { validateOnly: true });
  log(`Server validation (nothing saved): HTTP ${r.status}\n` + JSON.stringify(r.data, null, 2));
});
$('ad-push').onclick = guard(async () => {
  const { base, token } = conn(); const items = parseItems(); toCreateBody(items);
  if (!confirm(`Create ${items.length} anomaly detector(s) in this tenant?`)) return;
  const r = await pushDetectors(base, token, items);
  log(`Created: HTTP ${r.status}\n` + JSON.stringify(r.data, null, 2));
});
