import type { AssignmentSnapshotV2, OperationV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';
import { checkedEditIsCurrentV2 } from './current_postcondition_v2.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { visibilityExpectedValuesV2 } from './visibility_view_contract_v2.js';
import { boundedScheduleFieldFormatsV2 } from './schedule_field_formats_v2.js';

const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};

/** Scheduling a new read never renews proof by itself. Only explicit disjoint
 * presentation edits are understood here; revised field values must not make
 * the worker restore an obsolete intermediate request. */
function fieldFormatRefreshIsApplicable(snapshot:AssignmentSnapshotV2,op:OperationV2,body:Record<string,unknown>):boolean {
  if(op.input.method!=='POST'||op.input.path!=='/revit/configure-schedule'||op.requested_effect!=='apply'
    ||!Number.isSafeInteger(body.scheduleId)||Number(body.scheduleId)<=0||body.dryRun!==undefined&&body.dryRun!==false
    ||!boundedScheduleFieldFormatsV2(body.fieldFormats)
    ||Object.keys(body).some(k=>!['scheduleId','fieldFormats','dryRun'].includes(k))
    ||snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal
    ||snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length
    ||snapshot.in_flight_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
    ||!sameAssignmentBindingV2(snapshot.current_binding,op.binding))return false;
  const at=Date.parse(op.result?.completed_at??'');if(!Number.isFinite(at))return false;
  const later=Object.values(snapshot.operations).filter(other=>other.operation_id!==op.operation_id
    &&other.requested_effect==='apply'&&other.persistent_effect!=='none'
    &&sameAssignmentBindingV2(snapshot.current_binding,other.binding)
    &&(record(other.input.body).scheduleId===body.scheduleId
      ||other.result?.affected_target_identities?.includes('element_id:'+body.scheduleId))
    &&(!Number.isFinite(Date.parse(other.result?.completed_at??''))||Date.parse(other.result!.completed_at)>=at));
  return later.length>0&&later.every(other=>{
    const next=record(other.input.body),appearance=record(next.appearance),r=other.result;
    return other.input.path==='/revit/configure-schedule'&&other.input.method==='POST'
      &&other.request_identity?.path===other.input.path&&typeof other.request_identity.request_signature==='string'&&!!other.request_identity.request_signature
      &&next.scheduleId===body.scheduleId&&(next.dryRun===undefined||next.dryRun===false)
      &&Object.keys(next).every(k=>['scheduleId','fieldOrder','appearance','dryRun'].includes(k))
      &&(Object.hasOwn(next,'fieldOrder')||Object.keys(appearance).length>0)
      &&(!Object.hasOwn(next,'fieldOrder')||Array.isArray(next.fieldOrder)&&next.fieldOrder.length>0&&next.fieldOrder.length<=200
        &&next.fieldOrder.every(id=>Number.isSafeInteger(id)&&Number(id)>=0)&&new Set(next.fieldOrder).size===next.fieldOrder.length)
      &&(!Object.hasOwn(next,'appearance')||next.appearance!==null&&typeof next.appearance==='object'&&!Array.isArray(next.appearance))
      &&Object.entries(appearance).every(([k,v])=>['titleTextTypeId','headerTextTypeId','bodyTextTypeId'].includes(k)
        ?Number.isSafeInteger(v)&&Number(v)>0:['showTitle','showHeaders'].includes(k)&&typeof v==='boolean')
      &&other.admission_state==='admitted'&&other.dispatch_state==='dispatched'&&other.settlement_state==='settled'&&other.persistent_effect==='applied'
      &&!snapshot.input_invalidated_operation_ids?.includes(other.operation_id)&&r?.authority==='native-host'&&r.status==='succeeded'
      &&r.operation_id===other.operation_id&&r.dispatch_state==='dispatched'&&r.native_transaction_state==='committed'
      &&r.persistent_effect==='applied'&&sameAssignmentBindingV2(r.binding,other.binding)&&Number.isFinite(Date.parse(r.completed_at))
      &&r.request_identity?.request_signature===other.request_identity?.request_signature
      &&!!r.receipt_id&&!!r.native_correlation_id;
  });
}

function visibilityProperty(op:OperationV2):string|null {
  if(op.request_identity?.path!=='/revit/visibility' || !visibilityExpectedValuesV2(op.input).length)return null;
  const action=(op.input.body as Record<string,unknown>).action;
  // Category labels and enum selectors can resolve to the same native category.
  // Treat all category edits as overlapping rather than guessing equivalence.
  return ({set_phase:'phase',set_phase_filter:'phaseFilter',set_scale:'scale',
    set_detail_level:'detailLevel',set_discipline:'discipline',set_category_override:'category'} as Record<string,string>)[String(action)]??null;
}

/** Renew evidence after another explicit, disjoint property edit on this view.
 * A newer request for the same property supersedes the old expected value;
 * input-invalidated intent must never become a request to restore old work. */
export function visibilityCheckNeedsRefreshV2(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean {
  const property=visibilityProperty(op),body=op.input.body as Record<string,unknown>|undefined;
  if(!property || !body || snapshot.terminal || snapshot.outcome!=='active' || snapshot.completion_proposal
    || snapshot.execution_control?.state==='paused' || snapshot.unresolved_unknown_operation_ids.length
    || snapshot.in_flight_operation_ids.length || snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
    || !sameAssignmentBindingV2(snapshot.current_binding,op.binding)
    || !appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id) || checkedEditIsCurrentV2(snapshot,op.operation_id))return false;
  const later=Object.values(snapshot.operations).filter(other=>other.operation_id!==op.operation_id
    && other.requested_effect==='apply' && other.persistent_effect!=='none'
    && sameAssignmentBindingV2(snapshot.current_binding,other.binding)
    && (other.opened_at>op.opened_at || other.opened_at===op.opened_at
      && (other.settled_assignment_version??Infinity)>(op.settled_assignment_version??-Infinity))
    && ((other.input.body as Record<string,unknown>|undefined)?.viewId===body.viewId
      || other.result?.affected_target_identities?.includes('element_id:'+body.viewId)
      || other.target.target_id==='id:'+body.viewId));
  return later.length>0 && later.every(other=>{
    const next=visibilityProperty(other);
    return next!==null && next!==property && other.persistent_effect==='applied'
      && other.settlement_state==='settled' && !snapshot.input_invalidated_operation_ids?.includes(other.operation_id);
  });
}

export function committedCheckNeedsRefreshV2(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean {
  return regularScheduleCheckNeedsRefreshV2(snapshot,op) || visibilityCheckNeedsRefreshV2(snapshot,op);
}

/** This is read scheduling only. The native comparator must independently
 * establish the full requested postcondition again; no prior fact is promoted. */
export function regularScheduleCheckNeedsRefreshV2(snapshot:AssignmentSnapshotV2, op:OperationV2):boolean {
  const b=op.input.body as Record<string,unknown>|undefined;
  return op.request_identity?.path==='/revit/configure-schedule'
    && Boolean(b && (Object.hasOwn(b,'fieldFormats')?fieldFormatRefreshIsApplicable(snapshot,op,b)
      :['fieldOrder','columnWidths','appearance','combinedField','filters','sortGroup','filterBySheet','isItemized','showGrandTotals'].some(k=>Object.hasOwn(b,k))))
    && appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)
    && !checkedEditIsCurrentV2(snapshot,op.operation_id);
}

export function operationNeedsReadbackV2(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean {
  return !appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)
    || committedCheckNeedsRefreshV2(snapshot,op);
}
