import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import { appliedOperationHasVerifiedPostconditionV2, verificationOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { operationTargetIdentityAliasesV2 } from '../domain/assignment-kernel/operation_target_identity.js';
import { hasCompleteNativeChangeInventoryV2 } from './native_change_inventory_v2.js';

function reviewedTargets(op: AssignmentSnapshotV2['operations'][string], read: AssignmentSnapshotV2['operations'][string]) {
  // These property verifiers check every exact requested owner. Incidental
  // panel/browser modifications are not subjects of a Type or parameter proof.
  // Relationship and geometry proofs keep their broader dependency footprint.
  const ids = (read.input?.body as Record<string, unknown> | undefined)?.elementIds;
  if (['/revit/change-element-type','/revit/set-parameter'].includes(op.request_identity?.path ?? '')
    && read.request_identity?.path === '/revit/get-parameters' && Array.isArray(ids) && ids.length > 0
    && ids.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
    return ids.map(id => `element_id:${id}`).flatMap(operationTargetIdentityAliasesV2);
  }
  return [op.target.target_id, ...Object.values(op.target.semantic_scope ?? {}),
    ...(op.result?.affected_target_identities ?? [])].flatMap(operationTargetIdentityAliasesV2);
}

export function checkedEditIsCurrentV2(snapshot: AssignmentSnapshotV2, id: string): boolean {
  const op = snapshot.operations[id];
  if (!op || !sameAssignmentBindingV2(op.binding, snapshot.current_binding)
    || snapshot.input_invalidated_operation_ids?.includes(id)
    || snapshot.unresolved_unknown_operation_ids.includes(id)
    || !appliedOperationHasVerifiedPostconditionV2(snapshot, id)) return false;
  return op.verification_operation_ids.some(readId => {
    const read = snapshot.operations[readId];
    if (!read || !verificationOperationHasVerifiedPostconditionV2(snapshot, readId)
      || read.verification_of_operation_id !== id || snapshot.input_invalidated_operation_ids?.includes(readId)
      || !sameAssignmentBindingV2(read.binding, snapshot.current_binding)
      || read.result?.authority !== 'native-host' || !read.result.raw_payload_hash || !sameAssignmentBindingV2(read.result.binding, snapshot.current_binding)
      || !read.observation_ids.some(oid => {
        const observed = snapshot.observations[oid];
        return observed?.operation_id === readId && observed.authority === 'native-host'
          && sameAssignmentBindingV2(observed.binding, read.binding) && observed.raw_payload_hash === read.result?.raw_payload_hash
          && observed.facts.some(f => f.fact_id === 'verification.postcondition_satisfied' && f.fact_class === 'verification' && f.value === true);
      })) return false;
    const readAt = Date.parse(read.result.completed_at), targets = new Set(reviewedTargets(op,read));
    if (!targets.size || !Number.isFinite(readAt) || readAt < Date.parse(op.result?.completed_at ?? '')) return false;
    return !Object.values(snapshot.operations).some(later => {
      if (later.operation_id === id || later.requested_effect !== 'apply'
        || !(['applied','unknown'].includes(later.persistent_effect) || snapshot.in_flight_operation_ids.includes(later.operation_id))
        || !sameAssignmentBindingV2(later.binding, snapshot.current_binding)) return false;
      const laterAt = Date.parse(later.result?.completed_at ?? later.opened_at);
      const unsettled = later.persistent_effect === 'unknown' || snapshot.unresolved_unknown_operation_ids.includes(later.operation_id)
        || snapshot.in_flight_operation_ids.includes(later.operation_id);
      // An older opening timestamp does not settle a still-running/unknown
      // write. It may complete after the read and remains a freshness blocker.
      if (!unsettled && Number.isFinite(laterAt) && laterAt < readAt) return false;
      // Equal timestamps need retained ordering; without it, require recheck.
      if (!unsettled && laterAt === readAt && later.settled_assignment_version !== undefined && read.settled_assignment_version !== undefined
        && later.settled_assignment_version < read.settled_assignment_version) return false;
      const footprint = hasCompleteNativeChangeInventoryV2(snapshot,later)
        ? later.result!.affected_target_identities!.flatMap(operationTargetIdentityAliasesV2)
        : [later.target.target_id, ...Object.values(later.target.semantic_scope ?? {}), ...(later.result?.affected_target_identities ?? [])]
          .flatMap(operationTargetIdentityAliasesV2);
      return !footprint.length || footprint.some(target => targets.has(target));
    });
  });
}
