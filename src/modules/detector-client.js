// src/modules/detector-client.js
// DQL-based Anomaly Detection custom alerts via Settings 2.0 (schema builtin:davis.anomaly-detectors).
// Docs: https://docs.dynatrace.com/docs/dynatrace-intelligence/anomaly-detection/set-up-anomaly-detectors-via-api
import { dtFetch } from './dt-platform.js';

export const SCHEMA_ID = 'builtin:davis.anomaly-detectors';
const OBJECTS = '/platform/classic/environment-api/v2/settings/objects';
const A = 'dt.statistics.ui.anomaly_detection.';
export const ANALYZERS = {
  static:   A + 'StaticThresholdAnomalyDetectionAnalyzer',
  adaptive: A + 'AutoAdaptiveAnomalyDetectionAnalyzer',
  seasonal: A + 'SeasonalBaselineAnomalyDetectionAnalyzer'
};
export const EVENT_TYPES = ['CUSTOM_INFO', 'ERROR_EVENT', 'AVAILABILITY_EVENT', 'PERFORMANCE_EVENT',
  'RESOURCE_CONTENTION_EVENT', 'CUSTOM_ALERT', 'CUSTOM_ANNOTATION', 'CUSTOM_CONFIGURATION',
  'CUSTOM_DEPLOYMENT', 'MARKED_FOR_TERMINATION'];

/** PULL: all detector objects, following nextPageKey. */
export async function pullDetectors(base, token) {
  const items = [];
  let r = await dtFetch(base, OBJECTS, { token, query: {
    schemaIds: SCHEMA_ID, pageSize: 500,
    fields: 'objectId,schemaId,schemaVersion,externalId,summary,scope,modified,updateToken,value'
  }});
  items.push(...(r.data.items || []));
  // When nextPageKey is used, all other query params must be omitted.
  while (r.data.nextPageKey) {
    r = await dtFetch(base, OBJECTS, { token, query: { nextPageKey: r.data.nextPageKey } });
    items.push(...(r.data.items || []));
  }
  return items;
}

/** PULL one detector by objectId. objectId is base64 (may contain = + /), so it is URL-encoded. */
export async function pullDetectorById(base, token, objectId) {
  const id = (objectId || '').trim();
  if (!id) throw new Error('objectId is required');
  const r = await dtFetch(base, `${OBJECTS}/${encodeURIComponent(id)}`, { token });
  return r.data;
}

/** Accepts pasted JSON text: an array, a {items:[...]} list response, or a single object. Returns an array. */
export function normalizeInput(text) {
  const data = JSON.parse(text || '[]');
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : (data && typeof data === 'object' ? [data] : []));
  if (!arr.length) throw new Error('Provide a non-empty JSON array (or a single object)');
  return arr;
}

/**
 * Pulled settings object -> body item for POST (create as NEW object).
 * Drops server-only fields (objectId, updateToken, created/modified, summary, ...).
 * opts: keepExternalId (default false), resetActor (default true: actor ids belong to the source env),
 *       disable (create with enabled=false), copySuffix (append " (copy)" to title)
 */
export function toPushable(obj, { keepExternalId = false, resetActor = true, disable = false, copySuffix = false } = {}) {
  const value = JSON.parse(JSON.stringify(obj.value || {}));
  if (resetActor && value.executionSettings) value.executionSettings.actor = null;
  if (disable) value.enabled = false;
  if (copySuffix && value.title) value.title = value.title + ' (copy)';
  const out = { schemaId: obj.schemaId || SCHEMA_ID, scope: obj.scope || 'environment', value };
  if (keepExternalId && obj.externalId) out.externalId = obj.externalId;
  return out;
}

/** Flatten analyzer.input [{key,value}] to an object. */
export const inputsToMap = (analyzer) =>
  Object.fromEntries(((analyzer && analyzer.input) || []).map(i => [i.key, i.value]));

/** One-row summary of a pulled settings object, for display. */
export function summarize(obj) {
  const v = obj.value || {};
  const inp = inputsToMap(v.analyzer);
  const kind = Object.entries(ANALYZERS).find(([, n]) => n === (v.analyzer && v.analyzer.name));
  return {
    objectId: obj.objectId, title: v.title, enabled: v.enabled, source: v.source,
    model: kind ? kind[0] : (v.analyzer && v.analyzer.name),
    condition: inp.alertCondition, threshold: inp.threshold, query: inp.query,
    externalId: obj.externalId
  };
}

/**
 * Simplified definition -> Settings object value.
 * def: { title, description?, enabled?, source?, model:'static'|'adaptive'|'seasonal', query,
 *        alertCondition, threshold?, numberOfSignalFluctuations?, tolerance?, alertOnMissingData?,
 *        violatingSamples, slidingWindow, dealertingSamples, queryOffset?,
 *        event:{ name, description, type, sourceEntity? } }
 */
export function buildValue(def) {
  const s = (x) => String(x);
  const input = [
    { key: 'query', value: def.query },
    { key: 'alertCondition', value: def.alertCondition },
    { key: 'alertOnMissingData', value: s(!!def.alertOnMissingData) },
    { key: 'violatingSamples', value: s(def.violatingSamples) },
    { key: 'slidingWindow', value: s(def.slidingWindow) },
    { key: 'dealertingSamples', value: s(def.dealertingSamples) }
  ];
  if (def.model === 'static') input.push({ key: 'threshold', value: s(def.threshold) });
  if (def.model === 'adaptive' && def.numberOfSignalFluctuations != null && def.numberOfSignalFluctuations !== '')
    input.push({ key: 'numberOfSignalFluctuations', value: s(def.numberOfSignalFluctuations) });
  if (def.model === 'seasonal' && def.tolerance != null && def.tolerance !== '')
    input.push({ key: 'tolerance', value: s(def.tolerance) });

  const props = [];
  if (def.event.sourceEntity) props.push({ key: 'dt.source_entity', value: def.event.sourceEntity });
  props.push({ key: 'event.type', value: def.event.type },
             { key: 'event.name', value: def.event.name },
             { key: 'event.description', value: def.event.description });
  return {
    enabled: def.enabled !== false,
    title: def.title,
    description: def.description || '',
    source: def.source || 'Rest-API',
    executionSettings: { actor: null, queryOffset: def.queryOffset === '' || def.queryOffset == null ? null : Number(def.queryOffset) },
    analyzer: { name: ANALYZERS[def.model], input },
    eventTemplate: { properties: props }
  };
}

/** Client-side checks drawn from the docs. Returns array of error strings (empty = ok). */
export function validateDef(def) {
  const e = [];
  if (!def.title) e.push('title is required');
  if (!ANALYZERS[def.model]) e.push('model must be static, adaptive or seasonal');
  const q = def.query || '';
  if (!/\b(timeseries|makeTimeseries)\b/.test(q)) e.push('query must produce a timeseries (timeseries or makeTimeseries)');
  if (!/interval\s*:\s*1m\b/.test(q)) e.push('query must set interval:1m explicitly');
  if (/\b(from|to)\s*:/.test(q.replace(/\bby\s*:\s*\{[^}]*\}/g, ''))) e.push('query must not use from:/to: (timeframe is controlled by the detector)');
  const cond = def.alertCondition;
  if (!['ABOVE', 'BELOW', 'OUTSIDE'].includes(cond)) e.push('alertCondition must be ABOVE, BELOW or OUTSIDE');
  if (def.model === 'static') {
    if (cond === 'OUTSIDE') e.push('OUTSIDE is only available for adaptive and seasonal models');
    if (def.threshold === '' || def.threshold == null || Number.isNaN(Number(def.threshold))) e.push('static model needs a numeric threshold (in the metric base unit)');
  }
  for (const k of ['violatingSamples', 'slidingWindow', 'dealertingSamples']) {
    const n = Number(def[k]);
    if (!Number.isInteger(n) || n < 1 || n > 60) e.push(`${k} must be an integer 1-60`);
  }
  if (Number(def.slidingWindow) < Number(def.violatingSamples)) e.push('slidingWindow must be >= violatingSamples');
  const ev = def.event || {};
  if (!ev.name) e.push('event.name is required');
  if (!ev.description) e.push('event.description is required');
  if (!EVENT_TYPES.includes(ev.type)) e.push('event.type must be one of the documented types');
  return e;
}

/** Accepts raw settings objects (pulled or {schemaId,scope,value}) or simplified defs; returns POST body. */
export function toCreateBody(items) {
  return items.map(it => {
    const isRaw = it.schemaId || (it.value && typeof it.value === 'object' && !it.model);
    if (isRaw) {
      const schemaId = it.schemaId || SCHEMA_ID;
      if (schemaId !== SCHEMA_ID) throw new Error(`Unexpected schemaId "${schemaId}" (this tool pushes ${SCHEMA_ID} only)`);
      if (!it.value || typeof it.value !== 'object') throw new Error('Raw item has no value object');
      return { schemaId, scope: it.scope || 'environment', value: it.value, ...(it.externalId ? { externalId: it.externalId } : {}) };
    }
    const errs = validateDef(it);
    if (errs.length) throw new Error(`"${it.title || '(untitled)'}": ${errs.join('; ')}`);
    return { schemaId: SCHEMA_ID, scope: 'environment', value: buildValue(it), ...(it.externalId ? { externalId: it.externalId } : {}) };
  });
}

/** PUSH: create detectors. validateOnly=true performs server-side validation without saving. */
export function pushDetectors(base, token, items, { validateOnly = false } = {}) {
  return dtFetch(base, OBJECTS, {
    token, method: 'POST', query: validateOnly ? { validateOnly: true } : undefined,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(toCreateBody(items))
  });
}
