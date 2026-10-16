import { canonicalJsonV2 } from './canonical.js';
import { sameAssignmentBindingV2 } from './identity.js';
import type { OperationV2 } from './operation.js';
import type { AssignmentSnapshotV2 } from './snapshot.js';

/** A single fresh verification read after native-confirmed non-dispatch.
 * Recomputed under the journal lock. This never admits an apply, retries a
 * dispatched/unknown read, changes a receipt, or supplies authorization.
 * Automatic callers additionally restrict the transient failure envelope.
 */
export function preDispatchReadRetryV2(s:AssignmentSnapshotV2, op:OperationV2) {
 try {
  if(op.requested_effect!=='read'||op.purpose!=='verification'||op.fulfillment_role!=='verification'
    ||(op.operation_role??'root')!=='root'||!op.verification_of_operation_id
    ||s.terminal||s.completion_proposal||s.execution_control?.state==='paused'
    ||s.unresolved_unknown_operation_ids.length||!op.binding.document_fingerprint
    ||op.target.document_fingerprint!==op.binding.document_fingerprint
    ||!sameAssignmentBindingV2(s.current_binding,op.binding))return null;
  const all=Object.values(s.operations),apply=s.operations[op.verification_of_operation_id],a=apply?.result;
  if(!apply||apply.requested_effect!=='apply'||apply.admission_state!=='admitted'
    ||apply.settlement_state!=='settled'||apply.persistent_effect!=='applied'
    ||a?.authority!=='native-host'||a.status!=='succeeded'||a.native_transaction_state!=='committed'
    ||a.persistent_effect!=='applied'||a.dispatch_state!=='dispatched'
    ||!sameAssignmentBindingV2(op.binding,apply.binding)||!sameAssignmentBindingV2(op.binding,a.binding)
    ||!apply.settled_assignment_version||s.input_invalidated_operation_ids?.includes(apply.operation_id)
    ||all.some(o=>o.requested_effect==='apply'&&(o.settlement_state!=='settled'
      ||o.persistent_effect==='unknown'||(o.admitted_assignment_version??Infinity)>apply.settled_assignment_version!)))return null;
  const prior=all.filter(o=>o.requested_effect==='read'
    &&o.verification_of_operation_id===apply.operation_id
    &&canonicalJsonV2(o.request_identity)===canonicalJsonV2(op.request_identity)
    &&canonicalJsonV2(o.input)===canonicalJsonV2(op.input)
    &&canonicalJsonV2(o.target)===canonicalJsonV2(op.target))
    .sort((x,y)=>(y.admitted_assignment_version??0)-(x.admitted_assignment_version??0))[0];
  const r=prior?.result;
  if(!prior||prior.retry_of_operation_id||all.some(o=>o.retry_of_operation_id===prior.operation_id)
    ||prior.admission_state!=='admitted'||prior.settlement_state!=='settled'
    ||prior.purpose!=='verification'||prior.fulfillment_role!=='verification'
    ||prior.dispatch_state!=='not_dispatched'||prior.persistent_effect!=='none'
    ||prior.observation_ids.length||r?.authority!=='native-host'||r.status!=='failed_before_dispatch'
    ||r.dispatch_state!=='not_dispatched'||r.persistent_effect!=='none'||r.observation_required
    ||!['not_applicable','not_started'].includes(r.native_transaction_state)
    ||!r.native_correlation_id||r.input_schema_gap||r.result_semantic_gap
    ||!sameAssignmentBindingV2(op.binding,prior.binding)||!sameAssignmentBindingV2(op.binding,r.binding)
    ||canonicalJsonV2(r.request_identity)!==canonicalJsonV2(prior.request_identity)
    ||!prior.admitted_assignment_version||!prior.settled_assignment_version
    ||prior.admitted_assignment_version<=apply.settled_assignment_version
    ||prior.settled_assignment_version>s.assignment_version
    ||s.input_invalidated_operation_ids?.includes(prior.operation_id))return null;
  return {retry_of_operation_id:prior.operation_id,retry_basis:'native_pre_dispatch_read' as const};
 }catch{return null;}
}
