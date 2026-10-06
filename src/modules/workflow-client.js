// src/modules/workflow-client.js
// Pull Dynatrace Automation workflows (platform Automation v1). Read-only.
// Path /platform/automation/v1/workflows, offset pagination (limit/offset/search), scope automation:workflows:read.
// The exact list-response envelope is not confirmed from docs, so several shapes are accepted.
import { dtFetch } from './dt-platform.js';

const WF = '/platform/automation/v1/workflows';

/** Accepts a bare array, {results:[...]}, or {items:[...]}. */
export function normalizeWorkflowList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

/** PULL all workflows, following offset pagination (stops on empty page, count reached, or 100 pages). */
export async function pullWorkflows(base, token, { search } = {}) {
  const all = [];
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const r = await dtFetch(base, WF, { token, query: { offset: offset || undefined, search: search || undefined } });
    const items = normalizeWorkflowList(r.data);
    if (!items.length) break;
    all.push(...items);
    offset += items.length;
    const total = r.data && typeof r.data.count === 'number' ? r.data.count : null;
    if (total !== null && offset >= total) break;
    if (total === null && items.length < 1) break;
  }
  return all;
}

/** PULL one workflow by id (UUID). */
export async function pullWorkflowById(base, token, id) {
  const v = (id || '').trim();
  if (!v) throw new Error('Workflow id is required');
  const r = await dtFetch(base, `${WF}/${encodeURIComponent(v)}`, { token });
  return r.data;
}

/** One-row summary incl. the event-trigger filter (how the workflow "picks up" events). */
export function summarizeWorkflow(w) {
  const trig = (w && w.trigger) || {};
  const kinds = Object.keys(trig).filter(k => trig[k] && typeof trig[k] === 'object');
  const kind = kinds[0] || (w && w.type) || '';
  const t = trig[kind] || {};
  const cfg = (t.triggerConfiguration && t.triggerConfiguration.value) || {};
  return {
    id: w.id, title: w.title, trigger: kind,
    active: t.isActive === undefined ? '' : String(t.isActive),
    filter: cfg.customFilter || (cfg.query ? String(cfg.query) : ''),
    tasks: w.tasks ? Object.keys(w.tasks).length : 0,
    owner: w.owner || ''
  };
}
