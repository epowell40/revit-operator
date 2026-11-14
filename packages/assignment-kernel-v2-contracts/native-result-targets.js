const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const validIds = ids => Array.isArray(ids) && ids.length > 0 && ids.length <= 256
  && ids.every(id => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length;

/** A requested check scope, never write authority or proof. A result field is
 * a single JSON property containing IDs, not executable code or a query. */
export function normalizeNativeResultTargets(value, mode) {
  if (value === undefined) return undefined;
  const r = record(value), keys = Object.keys(r);
  if (mode !== 'apply' || !keys.length || keys.some(k => !['element_ids', 'result_field'].includes(k))
      || Object.hasOwn(r, 'element_ids') && !validIds(r.element_ids)
      || Object.hasOwn(r, 'result_field') && (typeof r.result_field !== 'string'
        || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(r.result_field)
        || ['constructor','prototype'].includes(r.result_field)))
    throw new Error('Native result_targets require bounded explicit IDs and/or a top-level JSON result field in apply mode.');
  return { ...(r.element_ids ? {element_ids:[...r.element_ids]} : {}),
    ...(r.result_field ? {result_field:r.result_field} : {}) };
}

/** Caller must independently authenticate the receipt and validate every ID
 * against its actual transaction footprint. Program output is not evidence
 * that the selected elements have the intended state. */
export function resolveNativeResultTargets(value, programResult) {
  const r = normalizeNativeResultTargets(value, 'apply');
  if (!r) return undefined;
  let returned = [];
  if (r.result_field) {
    if (typeof programResult !== 'string' || new TextEncoder().encode(programResult).byteLength > 32768)
      throw new Error('Native result target field has no bounded JSON program result.');
    const result = record(JSON.parse(programResult));
    if (!Object.hasOwn(result, r.result_field) || !validIds(result[r.result_field]))
      throw new Error('Native result target field is missing or invalid.');
    returned = result[r.result_field];
  }
  const ids = [...new Set([...(r.element_ids ?? []), ...returned])].sort((a,b)=>a-b);
  if (!validIds(ids)) throw new Error('Native result target scope exceeds 256 elements.');
  return ids;
}
