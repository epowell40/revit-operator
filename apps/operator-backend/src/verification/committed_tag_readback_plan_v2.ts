import type { AssignmentSnapshotV2, OperationV2 } from '../domain/assignment-kernel/index.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';
import { existingTagRepairRequestV2, tagLeaderEndConditionV2 } from './tag_property_readback_v2.js';

/** A bounded read plan, never proof or mutation authority. The normal dynamic
 * handler still validates, admits, dispatches and settles this separate read. */
export function committedTagReadbackPlanV2(snapshot: AssignmentSnapshotV2, operation: OperationV2) {
  const result = operation.result, body = existingTagRepairRequestV2(operation.input);
  if (snapshot.terminal || snapshot.outcome !== 'active' || snapshot.completion_proposal
    || snapshot.execution_control?.state === 'paused' || snapshot.unresolved_unknown_operation_ids.length
    || !sameAssignmentBindingV2(snapshot.current_binding, operation.binding)
    || operation.admission_state !== 'admitted' || operation.dispatch_state !== 'dispatched'
    || operation.settlement_state !== 'settled' || operation.requested_effect !== 'apply'
    || operation.persistent_effect !== 'applied' || operation.request_identity?.path !== '/revit/tag-elements'
    || operation.input.method !== 'POST' || operation.input.path !== '/revit/tag-elements'
    || !result || result.status !== 'succeeded' || result.authority !== 'native-host'
    || result.native_transaction_state !== 'committed' || result.persistent_effect !== 'applied'
    || result.operation_id !== operation.operation_id || !sameAssignmentBindingV2(result.binding, operation.binding)
    || result.request_identity?.request_signature !== operation.request_identity.request_signature
    || !Number.isFinite(Date.parse(result.completed_at))
    || !body || body.dryRun === true || body.apply === false
    || !Number.isSafeInteger(body.viewId) || body.viewId <= 0
    || !result.affected_target_identities?.includes('element_id:' + body.repairExistingTagId)
    || ['leaderEndXyz', 'leaderElbowXyz'].some(k => Object.hasOwn(body, k))
    || appliedOperationHasVerifiedPostconditionV2(snapshot, operation.operation_id)) return null;
  // Do not replay an existing check or check an earlier edit after a newer one.
  if (operation.verification_operation_ids.length || Object.values(snapshot.operations).some(other =>
    other.operation_id !== operation.operation_id && other.requested_effect === 'apply'
    && other.persistent_effect !== 'none' && other.opened_at >= operation.opened_at
    && existingTagRepairRequestV2(other.input)?.repairExistingTagId === body.repairExistingTagId)) return null;
  const properties = ['OwnerViewId'];
  if (Object.hasOwn(body, 'hasLeader')) {
    if (typeof body.hasLeader !== 'boolean') return null;
    properties.push('HasLeader');
  }
  if (Object.hasOwn(body, 'tagHeadPositionXyz')) {
    if (!Array.isArray(body.tagHeadPositionXyz) || body.tagHeadPositionXyz.length !== 3
      || !body.tagHeadPositionXyz.every(Number.isFinite)) return null;
    properties.push('TagHeadPosition');
  }
  if (Object.hasOwn(body, 'leaderEndCondition')) {
    if (!tagLeaderEndConditionV2(body.leaderEndCondition)) return null;
    properties.push('LeaderEndCondition');
  }
  if (properties.length === 1) return null;
  const operations = [{ id:'tag', op:'call', target:'doc',
    memberId:'method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)', args:[body.repairExistingTagId] },
    ...properties.map(property => ({id:'read_'+property,op:'get_property',target:'$tag',property}))];
  return { method:'POST', path:'/revit/native-api-ops', body:{operations,returns:operations.map(o=>'$'+o.id)} };
}
