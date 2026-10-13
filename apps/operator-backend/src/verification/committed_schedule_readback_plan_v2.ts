import type { AssignmentSnapshotV2, OperationV2 } from '../domain/assignment-kernel/index.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

/** A separate exact-source read, not proof. Normal admission and settlement
 * decide whether its fresh native evidence satisfies the edit's postcondition. */
export function committedScheduleReadbackPlanV2(snapshot: AssignmentSnapshotV2, operation: OperationV2) {
  const r=operation.result, body=operation.input.body as Record<string,unknown> | undefined;
  if(snapshot.terminal || snapshot.outcome!=='active' || snapshot.completion_proposal
    || snapshot.execution_control?.state==='paused' || snapshot.unresolved_unknown_operation_ids.length
    || snapshot.input_invalidated_operation_ids?.includes(operation.operation_id)
    || !sameAssignmentBindingV2(snapshot.current_binding,operation.binding)
    || operation.admission_state!=='admitted' || operation.dispatch_state!=='dispatched'
    || operation.settlement_state!=='settled' || operation.requested_effect!=='apply' || operation.persistent_effect!=='applied'
    || operation.request_identity?.path!=='/revit/update-schedule-cell'
    || operation.input.method!=='POST' || operation.input.path!==operation.request_identity.path
    || !r || r.status!=='succeeded' || r.authority!=='native-host' || r.native_transaction_state!=='committed'
    || r.persistent_effect!=='applied' || r.operation_id!==operation.operation_id
    || !sameAssignmentBindingV2(r.binding,operation.binding)
    || r.request_identity?.request_signature!==operation.request_identity.request_signature
    || !Number.isFinite(Date.parse(r.completed_at)) || !body || body.dryRun===true || body.apply!==true
    || !Number.isSafeInteger(body.scheduleId) || Number(body.scheduleId)<=0
    || !['rowField','rowKey','targetField','value'].every(k=>typeof body[k]==='string' && String(body[k]).trim().length>0)
    || r.affected_target_identities?.length!==1 || !/^element_id:[1-9][0-9]*$/.test(r.affected_target_identities[0]!)
    || operation.verification_operation_ids.length || appliedOperationHasVerifiedPostconditionV2(snapshot,operation.operation_id)) return null;
  const identity=r.affected_target_identities[0]!, id=Number(identity.slice('element_id:'.length));
  if(!Number.isSafeInteger(id) || Object.values(snapshot.operations).some(other=>other.operation_id!==operation.operation_id
    && other.requested_effect==='apply' && other.persistent_effect!=='none' && other.opened_at>=operation.opened_at
    && (other.result?.affected_target_identities?.includes(identity)
      || other.input.path===operation.input.path && (other.input.body as any)?.scheduleId===body.scheduleId
        && (other.input.body as any)?.rowKey===body.rowKey))) return null;
  return {method:'POST',path:'/revit/get-parameters',body:{elementId:id,names:[...new Set([String(body.rowField),String(body.targetField)])]}};
}
