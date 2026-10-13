import type { AssignmentSnapshotV2, OperationV2 } from '../domain/assignment-kernel/index.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';
import { visibilityExpectedValuesV2 } from './visibility_view_contract_v2.js';

/** One independent native read of an explicit committed view setting.
 * Direct category overrides prove stored properties, not effective linked
 * graphics, source interpretation or complete typical scope. */
export function committedVisibilityReadbackPlanV2(snapshot: AssignmentSnapshotV2, operation: OperationV2) {
  const r = operation.result, body = operation.input.body as Record<string, unknown> | undefined;
  if (snapshot.terminal || snapshot.outcome !== 'active' || snapshot.completion_proposal
    || snapshot.execution_control?.state === 'paused' || snapshot.unresolved_unknown_operation_ids.length
    || snapshot.input_invalidated_operation_ids?.includes(operation.operation_id)
    || !sameAssignmentBindingV2(snapshot.current_binding, operation.binding)
    || operation.admission_state !== 'admitted' || operation.dispatch_state !== 'dispatched'
    || operation.settlement_state !== 'settled' || operation.requested_effect !== 'apply' || operation.persistent_effect !== 'applied'
    || operation.request_identity?.path !== '/revit/visibility' || operation.input.method !== 'POST'
    || operation.input.path !== operation.request_identity.path || !body || body.dryRun === true || body.apply === false
    || !Number.isSafeInteger(body.viewId) || Number(body.viewId) <= 0 || !visibilityExpectedValuesV2(operation.input).length
    || !r || r.status !== 'succeeded' || r.authority !== 'native-host' || r.native_transaction_state !== 'committed'
    || r.persistent_effect !== 'applied' || r.operation_id !== operation.operation_id
    || !sameAssignmentBindingV2(r.binding, operation.binding)
    || !operation.request_identity.request_signature || r.request_identity?.request_signature !== operation.request_identity.request_signature
    || !Number.isFinite(Date.parse(r.completed_at)) || !r.affected_target_identities?.includes('element_id:' + body.viewId)
    || operation.verification_operation_ids.length || appliedOperationHasVerifiedPostconditionV2(snapshot, operation.operation_id)) return null;
  if (Object.values(snapshot.operations).some(other => other.operation_id !== operation.operation_id
    && other.requested_effect === 'apply' && other.persistent_effect !== 'none' && other.opened_at >= operation.opened_at
    && ((other.input.body as any)?.viewId === body.viewId
      || other.result?.affected_target_identities?.includes('element_id:' + body.viewId)))) return null;
  return { method: 'POST', path: '/revit/visibility', body: { action: 'get', viewId: body.viewId,
    ...(body.action === 'set_category_override' ? { categoryName: body.categoryName, includeCategoryState: true, includeLinkedModels: true } : {}) } };
}
