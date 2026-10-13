import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import type { WorkPlanScopeRequestV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { readEvidenceRef, readAuthoritativeEvidence } from '../evidence/evidence_store.js';
import { checkTagScopeReadbackV1 } from '../verification/tag_scope_readback_v1.js';
import { checkCategoryGraphicsScopeV1 } from '../verification/category_graphics_scope_v1.js';
import { validCategoryGraphicsScopeV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import type { WorkPlanScopeV1 } from '../domain/assignment-kernel/work_plan_scope.js';

const requestBody=(v:any)=>{try{return typeof v?.body==='string'?JSON.parse(v.body):v?.body;}catch{return null;}};
/** Select references, never a favorable result. The existing checker still
 * authenticates every byte, complete census, binding and post-edit freshness.
 * A newer failed/truncated matching read wins over an earlier good one. */
export function selectWorkPlanScopeReadIdsV1(snapshot:AssignmentSnapshotV2,scope:WorkPlanScopeV1) {
  const edits=Object.values(snapshot.operations).filter(o=>o.requested_effect==='apply'&&o.persistent_effect!=='none')
    .map(o=>Date.parse(o.result?.completed_at??o.opened_at));
  if(edits.some(t=>!Number.isFinite(t)))throw Error('scope_check_edit_time_invalid');
  const lastEdit=Math.max(0,...edits),graphics=validCategoryGraphicsScopeV1(scope);
  const reads=Object.values(snapshot.operations).filter(o=>o.requested_effect==='read'
    &&sameAssignmentBindingV2(o.binding,snapshot.current_binding)&&Date.parse(o.opened_at)>lastEdit)
    .sort((a,b)=>Date.parse(a.opened_at)-Date.parse(b.opened_at)||a.operation_id.localeCompare(b.operation_id));
  const latest=new Map<string,string>(),extras:string[]=[];
  for(const o of reads){const i=o.input as any,b=requestBody(i);if(i?.method!=='POST'||!b)continue;
    if(graphics){
      if(i.path==='/revit/views'&&b.action==='list'&&b.includeTemplates===true
        &&Object.keys(b).every(k=>['action','includeTemplates','disciplines','limit','offset'].includes(k))
        &&(b.offset===undefined||b.offset===0)
        &&(b.disciplines===undefined||Array.isArray(b.disciplines)&&b.disciplines.length===scope.disciplines.length
          &&new Set(b.disciplines).size===b.disciplines.length&&b.disciplines.every((d:string)=>scope.disciplines.includes(d))))latest.set('inventory',o.operation_id);
      else if(i.path==='/revit/visibility'&&b.action==='get'&&b.categoryName===scope.category&&b.includeCategoryState===true
        &&Number.isSafeInteger(b.viewId)&&b.viewId>0)latest.set('view:'+b.viewId,o.operation_id);
    }else {
      if(i.path==='/revit/find-elements'&&b.category===scope.category
        &&Object.entries(b).every(([k,v])=>['category','limit','includeGeometry'].includes(k)||v===null||v===undefined))latest.set('inventory',o.operation_id);
      else if(i.path==='/revit/get-parameters'&&Array.isArray(b.names)&&b.names.includes('Family'))extras.push(o.operation_id);
      else if(i.path==='/revit/native-api-ops'&&Array.isArray(b.operations)&&b.operations.length
        &&b.operations.every((op:any)=>op?.op==='call'&&['method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)',
          'method:Autodesk.Revit.DB.IndependentTag.GetTaggedLocalElements()'].includes(op.memberId)
          ||op?.op==='get_property'&&['OwnerViewId','HasLeader','TagHeadPosition','LeaderEndCondition','TagText'].includes(op.property)))extras.push(o.operation_id);
    }
  }
  const ids=[...latest.values(),...extras];
  if(ids.length>128)throw Error('scope_check_read_reference_limit: use explicit bounded references to one complete scope; do not narrow the declared scope');
  return ids;
}

/** Recompute from retained native bytes. The worker supplies a selector and
 * read IDs, never the result. Unknown effects and later edits invalidate it. */
export function checkWorkPlanScopeV1(snapshot:AssignmentSnapshotV2, request:WorkPlanScopeRequestV1) {
  try {
    if(snapshot.unresolved_unknown_operation_ids.length||snapshot.in_flight_operation_ids.length)throw Error('scope_check_unsettled');
    const editTimes=Object.values(snapshot.operations).filter(op=>op.requested_effect==='apply'&&op.persistent_effect!=='none')
      .map(op=>Date.parse(op.result?.completed_at??op.opened_at));
    if(editTimes.some(t=>!Number.isFinite(t)))throw Error('scope_check_edit_time_invalid');
    const lastEdit=Math.max(0,...editTimes);
    const readTimes:number[]=[];
    const requestedAt=Date.parse(request.requested_at);
    if(!Number.isFinite(requestedAt))throw Error('scope_check_request_time_invalid');
    if(!request.operation_ids.length)throw Error('scope_check_no_current_native_reads');
    const reads=request.operation_ids.map(id=>{
      const op=snapshot.operations[id],r=op?.result;
      const openedAt=Date.parse(op?.opened_at??''),completedAt=Date.parse(r?.completed_at??'');
      if(!op||op.requested_effect!=='read'||op.persistent_effect!=='none'||op.settlement_state!=='settled'
        ||op.dispatch_state!=='dispatched'||r?.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'
        ||snapshot.input_invalidated_operation_ids?.includes(id)||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)
        ||!sameAssignmentBindingV2(r.binding,snapshot.current_binding)||!Number.isFinite(openedAt)||!Number.isFinite(completedAt)
        ||openedAt<=lastEdit||completedAt<openedAt||completedAt>requestedAt)throw Error('scope_check_current_native_reads_required');
      readTimes.push(completedAt);
      for(const oid of op.observation_ids) {
        const o=snapshot.observations[oid];
        if(!o||o.operation_id!==id||o.authority!=='native-host'||o.raw_payload_hash!==r.raw_payload_hash
          ||!sameAssignmentBindingV2(o.binding,snapshot.current_binding))continue;
        const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));
        if(ref.byte_count>8_000_000)continue;
        const payload=JSON.parse(readAuthoritativeEvidence(ref,{...snapshot.current_binding,attempt_id:id}).toString('utf8'));
        if(payloadDigestV2(payload).digest!==o.raw_payload_hash)continue;
        return {operation_id:id,input:op.input,payload};
      }
      throw Error('scope_check_native_payload_required');
    });
    return {item_id:request.item_id,requested_at:request.requested_at,available:true as const,
      ...(validCategoryGraphicsScopeV1(request.scope)?checkCategoryGraphicsScopeV1(request.scope,reads):checkTagScopeReadbackV1(request.scope,reads)),
      readback_window:{first_completed_at:new Date(Math.min(...readTimes)).toISOString(),last_completed_at:new Date(Math.max(...readTimes)).toISOString()},
      freshness_notice:'As of the retained native readbacks. Later assignment edits invalidate this check; changes outside this assignment require new reads.'};
  } catch(error) {
    const reason=error instanceof Error?error.message:'scope_check_unavailable';
    return {item_id:request.item_id,requested_at:request.requested_at,available:false as const,
      declared_scope_satisfied:false,reason,
      ...(['scope_check_no_current_native_reads','scope_check_current_native_reads_required'].includes(reason)?{
        guidance:'Collect complete native scope inventory and every candidate read after the latest model edit or SaveAs, then check_scope again. Omit operationIds for host selection. This does not repeat or authorize any model edit.'
      }:{}),
      ...(reason==='scope_check_unsettled'?{
        blocking_operation_ids:[...new Set([...snapshot.in_flight_operation_ids,...snapshot.unresolved_unknown_operation_ids])].sort(),
        guidance:'Saved operation settlement must be resolved before this scope check can run. More inventory reads or changing the declared scope will not resolve it; do not repeat uncertain edits.'
      }:{})};
  }
}
export function projectWorkPlanScopeChecksV1(snapshot:AssignmentSnapshotV2) {
  const latest=new Map<string,WorkPlanScopeRequestV1>();
  for(const request of snapshot.work_plan_scope_requests??[])latest.set(request.item_id,request);
  return [...latest.values()].map(request=>checkWorkPlanScopeV1(snapshot,request));
}
