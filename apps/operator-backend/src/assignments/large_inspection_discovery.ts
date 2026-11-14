import type {AssignmentSnapshotV2} from '../domain/assignment-kernel/snapshot.js';
import type {OperationV2} from '../domain/assignment-kernel/operation.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import {retainWorkPlanInspectionV2} from './work_plan_inspection.js';

/** Reuse the existing native inspection contract for a large, fresh read.
 * This grants neither inspection completion nor verification of an edit.
 * Progress callers still deduplicate the canonical selector/write interval.
 */
export function qualifiedLargeInspectionDiscoveryV2(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean {
 const ids=(op.input?.body as any)?.elementIds;
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.execution_control?.state==='paused'
  ||snapshot.provider_usage_hold||snapshot.unresolved_unknown_operation_ids.length||snapshot.in_flight_operation_ids.length
  ||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
  ||op.input?.method!=='POST'||op.input.path!=='/revit/get-element-summary'
  ||(op.input.body as any)?.includeNativeProgramEffectState!==true
  ||!Array.isArray(ids)||ids.length<=256||ids.length>4096||new Set(ids).size!==ids.length
  ||ids.some(id=>!Number.isSafeInteger(id)||id<1)
  ||op.admission_state!=='admitted'||op.requested_effect!=='read'||op.persistent_effect!=='none'
  ||op.settlement_state!=='settled'||op.dispatch_state!=='dispatched'
  ||op.result?.authority!=='native-host'||op.result.status!=='succeeded'||op.result.persistent_effect!=='none'
  ||op.result.native_transaction_state!=='not_applicable'||op.result.result_semantic_gap||op.result.error_code
  ||!op.result.receipt_id||!op.result.native_correlation_id||!op.request_identity?.request_signature
  ||op.result.request_identity?.request_signature!==op.request_identity.request_signature
  ||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)||!sameAssignmentBindingV2(op.result.binding,op.binding))return false;
 const opened=Date.parse(op.opened_at),completed=Date.parse(op.result.completed_at);
 if(!Number.isFinite(opened)||!Number.isFinite(completed)||completed<opened)return false;
 if(!(snapshot.work_plan?.items??[]).some(item=>item.kind==='inspection'&&!item.completed_at
  &&!(item.deferrals?.at(-1)&&!item.deferrals.at(-1)?.resumed_at)
  &&Date.parse(item.declared_at)<=opened))return false;
 const writes=Object.values(snapshot.operations).filter(other=>other.requested_effect==='apply'&&other.persistent_effect!=='none');
 if(!writes.length||writes.some(other=>other.persistent_effect!=='applied'||other.settlement_state!=='settled'
  ||!sameAssignmentBindingV2(other.binding,op.binding)||!Number.isFinite(Date.parse(other.result?.completed_at??''))
  ||Date.parse(other.result!.completed_at)>=opened))return false;
 try {
  const coverage=retainWorkPlanInspectionV2(snapshot,[op.operation_id]);
  return coverage.target_ids.length===ids.length&&ids.every(id=>coverage.target_ids.includes('element_id:'+id));
 }catch{return false;}
}
