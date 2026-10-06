// src/modules/tracker.js — batch tracker helpers (pure).
export const CLASSES = ['PORT', 'REDESIGN', 'RETIRE'];
export const TARGETS = ['anomaly detector (static)', 'anomaly detector (adaptive baseline)', 'anomaly detector (seasonal baseline)',
  'workflow with scheduled DQL trigger', 'pipeline (OpenPipeline) alert', 'covered by Davis automatic detection', 'n/a (retire)'];
export const STATUSES = ['todo', 'DQL tested', 'built', 'deployed'];

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
export function rowsToMarkdown(rows) {
  const out = ['| Alert | Classification | Target construct | Open questions |', '|---|---|---|---|'];
  rows.forEach(r => out.push(`| ${esc(r.alert)} | ${esc(r.classification)} | ${esc(r.target)} | ${esc(r.open)} |`));
  return out.join('\n');
}
const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
export function rowsToCsv(rows) {
  return ['alert,classification,target,open_questions,status', ...rows.map(r => [r.alert, r.classification, r.target, r.open, r.status].map(q).join(','))].join('\n');
}
