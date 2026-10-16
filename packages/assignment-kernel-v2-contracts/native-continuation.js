// Pure decoding of the native continuation wire contract. These functions do
// not authorize admission, trust an observation, or clear an unknown effect.
// The kernel separately verifies retained hashes, bindings and ordered history.
const row = x => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const positiveId = x => Number.isSafeInteger(x) && x > 0;
const idText = x => typeof x === 'string' && /^[1-9][0-9]*$/.test(x) && positiveId(Number(x)) ? Number(x) : undefined;

/** Complete native source enumeration, not completed work or write authority. */
export function nativeSourceInventoryRequestV1(value) {
  const o=row(value),request=row(o.request_identity),input=row(o.input),body=row(input.body);
  if(o.requested_effect!=='read'||request.method!=='POST'||input.method!==request.method||input.path!==request.path)return undefined;
  const action=typeof body.action==='string'?body.action.trim().toLowerCase():body.action??'list';
  if(request.path!=='/revit/schedules'||!['list','circuits'].includes(action)
    ||(body.scheduleId!==undefined&&body.scheduleId!==null)||(body.query!==undefined&&body.query!==null&&(typeof body.query!=='string'||body.query.trim()!==''))
    ||(body.offset!==undefined&&body.offset!==null&&body.offset!==0))return undefined;
  const kind=typeof body.kind==='string'?body.kind.trim().toLowerCase():body.kind??'regular',max=body.max??200;
  if(action==='circuits')return body.kind==null&&positiveId(max)&&max<=500?{kind:'power_circuits',max}:undefined;
  if(!['regular','panel','all'].includes(kind)||!positiveId(max)||max>2000)return undefined;
  return {kind,max};
}
export function nativeSourceInventoryWorkloadV1(value,raw) {
  const request=nativeSourceInventoryRequestV1(value),p=row(raw);
  if(!request||p.status!=='Ok'||p.offset!==0||p.max!==request.max
    ||!positiveId(p.matched)||p.matched>request.max||p.returned!==p.matched
    ||p.complete!==true||p.hasMore!==false||p.nextOffset!==null
    ||!Array.isArray(p.items)||p.items.length!==p.returned)return undefined;
  if(request.kind==='power_circuits'){
    if(p.schema!=='operator.electrical_circuit_inventory.v1'||p.scope!=='project_power_circuits'||p.read_only!==true)return undefined;
  }else if(p.schema!=='operator.schedule_inventory.v1'||p.action!=='list'||p.kind!==request.kind||p.query!==null)return undefined;
  const ids=new Set(),uids=new Set();let count=0;
  for(const item of p.items){
    const v=row(item);
    if(!positiveId(v.id)||ids.has(v.id)||typeof v.uniqueId!=='string'
      ||!/^[A-Za-z0-9_-]{16,160}$/.test(v.uniqueId)||uids.has(v.uniqueId))return undefined;
    ids.add(v.id);uids.add(v.uniqueId);
    if(request.kind==='power_circuits'){
      if(!['Circuit','Spare','Space'].includes(v.circuitType))return undefined;
      if(v.circuitType==='Circuit')count++;continue;
    }
    if(typeof v.isTemplate!=='boolean'
      ||!['schedule','panel_schedule'].includes(v.kind)
      ||(request.kind==='panel'&&v.kind!=='panel_schedule')||(request.kind==='regular'&&v.kind!=='schedule')
      ||(v.kind==='panel_schedule'&&(v.isTemplate||!positiveId(v.panelElementId)
        ||typeof v.panelUniqueId!=='string'||!/^[A-Za-z0-9_-]{16,160}$/.test(v.panelUniqueId))))return undefined;
    if(!v.isTemplate)count++;
  }
  return count?{inventory_kind:request.kind,item_count:count}:undefined;
}
export function nativeTemplateParameterChangeV1(value) {
  const o = row(value), input = row(o.input);
  const body = o.capability_id === 'revit_set_parameters' ? input : row(input.body);
  if (body.apply !== true || body.dryRun !== false || !Array.isArray(body.changes) || body.changes.length !== 1) return undefined;
  const c = row(body.changes[0]);
  if (Object.keys(c).some(k => !['elementId','parameterName','value','expectedOldValue'].includes(k))
    || c.parameterName !== 'View Template' || !positiveId(c.elementId)
    || !idText(c.value) || !idText(c.expectedOldValue) || c.value === c.expectedOldValue) return undefined;
  return { elementId:c.elementId, value:c.value, expectedOldValue:c.expectedOldValue };
}
export function nativeTemplateRequestV1(value) {
  const o=row(value), input=row(o.input), body=row(input.body), request=row(o.request_identity), target=row(o.target);
  if (o.requested_effect !== 'apply' || request.capability_id !== o.capability_id || !request.request_signature) return undefined;
  const typed=o.capability_id === 'revit_set_parameters';
  if (typed || request.path === '/revit/set-parameter') {
    const change=nativeTemplateParameterChangeV1(o);
    if (!change || target.target_id !== `id:${change.elementId}`) return undefined;
    if (typed) { if ((o.operation_role ?? 'root') !== 'root' || request.method || request.path) return undefined; }
    else if (request.method !== 'POST' || input.method !== request.method || input.path !== request.path) return undefined;
    return { view_id:change.elementId, kind:typed?'typed_parameter':'native_parameter', expected_old_id:Number(change.expectedOldValue), requested_id:Number(change.value) };
  }
  if ((o.operation_role ?? 'root') !== 'root' || request.method !== 'POST' || request.path !== '/revit/visibility'
    || input.method !== request.method || input.path !== request.path || body.action !== 'set_template'
    || !positiveId(body.viewId) || typeof body.templateName !== 'string' || !body.templateName.trim()
    || body.dryRun === true || target.target_id !== `id:${body.viewId}`) return undefined;
  return {view_id:body.viewId,kind:'native_visibility',requested_name:body.templateName.trim().toLowerCase()};
}
export function nativeTemplateResultStateV1(value, raw) {
  const request=nativeTemplateRequestV1(value), p=row(raw), view=row(p.view), transaction=row(p.transaction);
  if (!request || request.kind === 'typed_parameter') return undefined;
  if (request.kind === 'native_parameter') {
    const checks=p.verification,diffs=p.diffs;
    if (p.status !== 'Applied and Verified' || p.dryRun !== false || transaction.status !== 'committed' || transaction.committed !== true
      || p.requestedCount !== 1 || p.effectiveCount !== 1 || p.excludedCount !== 0 || p.changedCount !== 1
      || p.writeFailedCount !== 0 || p.verificationPerformed !== true || p.verifiedCount !== 1 || p.verificationFailedCount !== 0
      || !Array.isArray(p.unresolvedElementIds) || p.unresolvedElementIds.length
      || !Array.isArray(p.missingAfterElementIds) || p.missingAfterElementIds.length
      || !Array.isArray(checks) || checks.length !== 1 || !Array.isArray(diffs) || diffs.length !== 1) return undefined;
    const c=row(checks[0]),d=row(diffs[0]),actual=row(c.actual),after=row(d.after),before=row(d.before);
    if (c.elementId !== request.view_id || c.parameterName !== 'View Template' || c.status !== 'verified' || c.error != null
      || c.expectedValue !== String(request.requested_id) || actual.storageType !== 'ElementId' || actual.value !== request.requested_id
      || d.elementId !== request.view_id || d.parameterName !== 'View Template' || d.ok !== true || d.changed !== true
      || after.storageType !== 'ElementId' || after.value !== request.requested_id || before.storageType !== 'ElementId' || before.value !== request.expected_old_id) return undefined;
    return {view_id:request.view_id,template_id:request.requested_id};
  }
  if (p.success !== true || p.action !== 'set_template' || p.dryRun !== false || transaction.status !== 'committed'
    || view.id !== request.view_id || !positiveId(view.viewTemplateId) || typeof view.viewTemplate !== 'string'
    || view.viewTemplate.trim().toLowerCase() !== request.requested_name) return undefined;
  return {view_id:request.view_id,template_id:view.viewTemplateId};
}
export function nativeFamilySessionRequestV1(value) {
  const o=row(value), r=row(o.request_identity),input=row(o.input),body=row(input.body);
  if (r.method !== 'POST' || input.method !== r.method || input.path !== r.path) return undefined;
  if (r.path === '/revit/open-family-doc' || r.path === '/revit/edit-family-from-instance') return {kind:'open'};
  const id=body.docId ?? body.familyDocumentId;
  if (r.path === '/revit/close-doc' && body.saveChanges === false && typeof id === 'string' && /^[a-f0-9]{32}$/i.test(id)) return {kind:'close_without_save',session_id:id};
  return undefined;
}
