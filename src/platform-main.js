// src/platform-main.js — wiring for platform.html
import { normalizePlatformBase, formatApiError } from './modules/dt-platform.js';
import { validateLookupPath, csvHeaderToDpl, testPattern, uploadLookup, deleteLookup, verifyDql } from './modules/lookup-client.js';
import { pullDetectors, pullDetectorById, pushDetectors, summarize, toCreateBody, toPushable, normalizeInput, EVENT_TYPES } from './modules/detector-client.js';

const $ = (id) => document.getElementById(id);
const log = (m) => { const el = $('log'); el.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`; el.scrollTop = el.scrollHeight; };
const guard = (fn) => async () => { try { await fn(); } catch (e) { log('ERROR ' + formatApiError(e)); } };

// ---------- connections ----------
const src = () => ({ base: normalizePlatformBase($('src-base').value), token: $('src-token').value.trim() });
const tgt = () => $('same-as-src').checked ? src() : { base: normalizePlatformBase($('tgt-base').value), token: $('tgt-token').value.trim() };
const refreshTargetLabel = () => { $('target-label').textContent = tgt().base || '(not set)'; };
function syncTargetInputs() {
  const same = $('same-as-src').checked;
  $('tgt-base').disabled = same; $('tgt-token').disabled = same;
  refreshTargetLabel();
}
['same-as-src'].forEach(id => $(id).addEventListener('change', syncTargetInputs));
['src-base', 'tgt-base'].forEach(id => $(id).addEventListener('input', refreshTargetLabel));
syncTargetInputs();

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll('.pt-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.pt-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  refreshTargetLabel();
}
document.querySelectorAll('.pt-tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- clipboard / download ----------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
          const ok = document.execCommand && document.execCommand('copy'); ta.remove(); return !!ok; }
}

// ================= TAB 1: PULL =================
let pulled = [];
const checked = () => new Set([...document.querySelectorAll('#ad-table input.row-sel:checked')].map(c => c.dataset.id));
const selectedObjs = () => { const s = checked(); return s.size ? pulled.filter(o => s.has(o.objectId)) : pulled; };
const showJson = (objs) => { $('pull-json').value = JSON.stringify(objs, null, 2); };

function renderTable() {
  const cols = ['title', 'enabled', 'model', 'condition', 'threshold', 'source', 'externalId', 'objectId'];
  $('ad-table').querySelector('thead').innerHTML = '<tr><th class="p-1 border-b"></th>' + cols.map(c => `<th class="text-left p-1 border-b">${c}</th>`).join('') + '<th class="p-1 border-b"></th></tr>';
  const tb = $('ad-table').querySelector('tbody'); tb.innerHTML = '';
  for (const o of pulled) {
    const r = summarize(o); const tr = document.createElement('tr');
    const cb = document.createElement('td'); cb.className = 'p-1 border-b';
    const box = document.createElement('input'); box.type = 'checkbox'; box.className = 'row-sel'; box.dataset.id = o.objectId; cb.appendChild(box); tr.appendChild(cb);
    for (const c of cols) { const td = document.createElement('td'); td.className = 'p-1 border-b align-top'; td.style.wordBreak = 'break-all'; td.textContent = r[c] ?? ''; tr.appendChild(td); }
    const view = document.createElement('td'); view.className = 'p-1 border-b';
    const vb = document.createElement('button'); vb.className = 'pt-btn pt-btn-outline'; vb.textContent = 'View JSON';
    vb.onclick = () => showJson([o]); view.appendChild(vb); tr.appendChild(view);
    tb.appendChild(tr);
  }
}

$('ad-pull').onclick = guard(async () => {
  const { base, token } = src(); pulled = await pullDetectors(base, token);
  renderTable(); showJson(pulled); log(`Pulled ${pulled.length} detector(s) from ${base}`);
});
$('ad-pull-id').onclick = guard(async () => {
  const { base, token } = src(); const o = await pullDetectorById(base, token, $('ad-id').value);
  const i = pulled.findIndex(x => x.objectId === o.objectId);
  if (i >= 0) pulled[i] = o; else pulled.push(o);
  renderTable(); showJson([o]); log(`Pulled detector ${o.objectId} from ${base}`);
});
$('ad-show-sel').onclick = () => { const s = checked(); if (!s.size) return log('No rows selected'); showJson(pulled.filter(o => s.has(o.objectId))); };
$('ad-show-all').onclick = () => { if (!pulled.length) return log('Nothing pulled yet'); showJson(pulled); };
$('pull-copy').onclick = async () => { const t = $('pull-json').value; if (!t) return log('Nothing to copy'); log((await copyText(t)) ? 'JSON copied to clipboard' : 'Copy failed: select the text and press Ctrl+C'); };
$('pull-download').onclick = () => {
  const t = $('pull-json').value; if (!t) return log('Nothing to download');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'application/json' }));
  a.download = 'anomaly-detectors.json'; a.click();
};
$('ad-send').onclick = guard(async () => {
  const objs = selectedObjs(); if (!objs.length) throw new Error('Pull detectors first');
  const opts = { resetActor: $('o-reset-actor').checked, keepExternalId: $('o-keep-ext').checked, disable: $('o-disable').checked, copySuffix: $('o-suffix').checked };
  $('push-json').value = JSON.stringify(objs.map(o => toPushable(o, opts)), null, 2);
  showTab('push'); log(`Sent ${objs.length} detector(s) to the Edit & push tab`);
});

// ================= TAB 2: PUSH =================
EVENT_TYPES.forEach(t => { const o = document.createElement('option'); o.textContent = t; $('f-etype').appendChild(o); });
$('f-etype').value = 'CUSTOM_ALERT';

$('ad-import').onchange = async (e) => { const f = e.target.files[0]; if (f) $('push-json').value = await f.text(); };
$('push-format').onclick = guard(async () => { $('push-json').value = JSON.stringify(normalizeInput($('push-json').value), null, 2); });
$('ad-fill').onclick = guard(async () => {
  const [v, w, d] = $('f-win').value.split('/').map(s => Number(s.trim()));
  const def = {
    title: $('f-title').value.trim(), model: $('f-model').value, query: $('f-query').value.trim(),
    alertCondition: $('f-cond').value, threshold: $('f-thr').value.trim(),
    violatingSamples: v, slidingWindow: w, dealertingSamples: d, alertOnMissingData: false,
    event: { name: $('f-ename').value.trim(), description: $('f-edesc').value.trim(), type: $('f-etype').value, sourceEntity: $('f-ent').value.trim() || undefined }
  };
  if ($('f-ext').value.trim()) def.externalId = $('f-ext').value.trim();
  $('push-json').value = JSON.stringify([def], null, 2);
});
$('ad-validate').onclick = guard(async () => {
  const { base, token } = tgt(); const items = normalizeInput($('push-json').value); toCreateBody(items); // client-side checks first
  const r = await pushDetectors(base, token, items, { validateOnly: true });
  log(`Server validation on ${base} (nothing saved): HTTP ${r.status}\n` + JSON.stringify(r.data, null, 2));
});
$('ad-push').onclick = guard(async () => {
  const { base, token } = tgt(); const items = normalizeInput($('push-json').value); toCreateBody(items);
  if (!confirm(`Create ${items.length} NEW anomaly detector(s) in:\n${base}\n\nContinue?`)) return;
  const r = await pushDetectors(base, token, items);
  log(`Created on ${base}: HTTP ${r.status}\n` + JSON.stringify(r.data, null, 2));
});

// ================= TAB 3: LOOKUPS (target env) =================
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
  const { base, token } = tgt(); const r = await testPattern(base, token, lkFile(), lkParams());
  log('Test OK:\n' + JSON.stringify(r.data, null, 2).slice(0, 4000));
});
$('lk-upload').onclick = guard(async () => {
  const { base, token } = tgt(); const p = lkParams(); const r = await uploadLookup(base, token, lkFile(), p);
  log(`Upload OK (HTTP ${r.status}) → ${p.filePath} on ${base}\nVerify in a Notebook:\n  ${verifyDql(p.filePath).join('\n  ')}`);
});
$('lk-delete').onclick = guard(async () => {
  const { base, token } = tgt(); const path = $('lk-path').value.trim();
  const err = validateLookupPath(path); if (err) throw new Error(err);
  if (prompt(`Deletion on ${base} is irreversible. Type the path to confirm:\n${path}`) !== path) { log('Delete cancelled'); return; }
  await deleteLookup(base, token, path); log('Deleted ' + path);
});
