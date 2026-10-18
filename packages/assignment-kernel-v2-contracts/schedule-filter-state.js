// Wire decoding only. Native authority, journal order and single-use admission
// are enforced separately by the assignment kernel.
const row = x => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const ops = new Map([['equals','Equal'],['not_equals','NotEqual'],['contains','Contains'],['not_contains','NotContains'],
  ['begins_with','BeginsWith'],['ends_with','EndsWith'],['has_value','HasValue'],['has_no_value','HasNoValue']]);
function rules(value, native) {
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const result = [];
  for (const item of value) {
    const f = row(item), op = native ? [...ops].find(([,v]) => v === f.op)?.[0] : f.op;
    if (!Number.isSafeInteger(f.fieldId) || f.fieldId < 0 || !ops.has(op)) return undefined;
    const noValue = op === 'has_value' || op === 'has_no_value';
    if (!noValue && !(typeof f.value === 'string' && f.value.length <= 8192 || typeof f.value === 'number' && Number.isFinite(f.value))) return undefined;
    if (!native && Object.keys(f).some(k => !['fieldId','op','value','valueType'].includes(k))) return undefined;
    result.push([f.fieldId,op,noValue ? null : f.value]);
  }
  return JSON.stringify(result);
}
export function nativeScheduleFilterRequestV1(value) {
  const o=row(value),input=row(o.input),body=row(input.body),request=row(o.request_identity),target=row(o.target);
  if (o.requested_effect !== 'apply' || (o.operation_role ?? 'root') !== 'root'
    || request.capability_id !== o.capability_id || !request.request_signature || request.method !== 'POST'
    || request.path !== '/revit/configure-schedule' || input.method !== request.method || input.path !== request.path
    || !Number.isSafeInteger(body.scheduleId) || body.scheduleId <= 0 || target.target_id !== `id:${body.scheduleId}`
    || body.replaceFilters !== true || body.dryRun !== false || body.replaceSortGroup != null && body.replaceSortGroup !== false
    || Object.keys(body).some(k => !['scheduleId','filters','replaceFilters','replaceSortGroup','dryRun'].includes(k))) return undefined;
  const state=rules(body.filters,false);
  return state === undefined ? undefined : { schedule_id:body.scheduleId,state };
}
export function nativeScheduleFilterResultStateV1(value,raw) {
  const request=nativeScheduleFilterRequestV1(value),p=row(raw),transaction=row(p.transaction),tracking=row(p.changeTracking);
  const state=rules(p.filterReadback,true);
  if (!request || p.error || p.truncated === true || p.success !== true || p.status !== 'Success' || p.dryRun !== false
    || row(p.schedule).id !== request.schedule_id || typeof row(p.schedule).uniqueId !== 'string' || !row(p.schedule).uniqueId
    || transaction.status !== 'committed' || transaction.committed !== true
    || tracking.documentChangedObserved !== true || tracking.exhaustiveChangeInventory !== true
    || tracking.captureFailureCount !== 0 || state !== request.state) return undefined;
  return {schedule_id:request.schedule_id,state};
}
