import { createHash } from 'node:crypto';
import { MAX_NATIVE_AFFECTED_TARGETS_V2 } from '@revitoperator/assignment-kernel-v2-contracts';
import { canonicalJsonV2 } from '../domain/assignment-kernel/canonical.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import type { OperationV2, OperationResultV2 } from '../domain/assignment-kernel/operation.js';

export const COMPLETE_NATIVE_CHANGE_INVENTORY_FACT_V2 = 'control.native_change_inventory_complete';
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const positiveId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** A commit alone does not certify an exhaustive change inventory. Derive this
 * presentation fact only from the retained native event diagnostics and all
 * three change sets, bound to the exact result digest and settlement identities.
 * It is not a postcondition pass or authority to retry a write. */
export function nativeChangeInventoryCompleteV2(operation: OperationV2 | undefined, result: OperationResultV2, payload: unknown): boolean {
  if (!operation || operation.requested_effect !== 'apply' || result.persistent_effect !== 'applied'
    || result.native_transaction_state !== 'committed' || result.status !== 'succeeded'
    || result.authority !== 'native-host' || result.dispatch_state !== 'dispatched'
    || result.operation_id !== operation.operation_id || !sameAssignmentBindingV2(result.binding, operation.binding)
    || !result.receipt_id || !result.native_correlation_id || !result.raw_payload_hash
    || !operation.request_identity?.request_signature
    || result.request_identity?.request_signature !== operation.request_identity.request_signature
    || result.request_identity.path !== operation.request_identity.path
    || result.request_identity.method !== operation.request_identity.method
    || result.result_semantic_gap || result.error_code) return false;
  const root = object(payload), tx = object(root.transaction), tracking = object(root.changeTracking);
  if (root.error || root.truncated === true || root.success === false || tx.status !== 'committed' || tx.committed !== true
    || tracking.documentChangedObserved !== true || tracking.exhaustiveChangeInventory !== true
    || tracking.captureFailureCount !== 0 || !positiveId(tracking.matchingEventCount)
    || !positiveId(tracking.eventCount) || tracking.matchingEventCount > tracking.eventCount) return false;
  const sets = ['added_element_ids', 'modified_element_ids', 'deleted_element_ids', 'affected_element_ids'].map(key => tx[key]);
  if (!sets.every((ids): ids is number[] => Array.isArray(ids) && ids.length <= MAX_NATIVE_AFFECTED_TARGETS_V2
    && ids.every(positiveId) && new Set(ids).size === ids.length)) return false;
  const union = [...new Set(sets.slice(0,3).flat())].sort((a,b) => a-b);
  const affected = [...sets[3]!].sort((a,b) => a-b);
  const identities = union.map(id => `element_id:${id}`).sort();
  return union.length > 0 && canonicalJsonV2(union) === canonicalJsonV2(affected)
    && canonicalJsonV2(identities) === canonicalJsonV2(result.affected_target_identities)
    && createHash('sha256').update(canonicalJsonV2(payload)).digest('hex') === result.raw_payload_hash;
}

/** Only the host-derived, hash-bound retained fact permits using an affected
 * set as an exhaustive write footprint. Missing historical facts stay cautious. */
export function hasCompleteNativeChangeInventoryV2(snapshot: AssignmentSnapshotV2, operation: OperationV2): boolean {
  const result = operation.result;
  return Boolean(operation.persistent_effect === 'applied' && operation.settlement_state === 'settled'
    && result?.authority === 'native-host' && result.persistent_effect === 'applied'
    && result.native_transaction_state === 'committed' && result.status === 'succeeded'
    && sameAssignmentBindingV2(operation.binding, snapshot.current_binding)
    && sameAssignmentBindingV2(result.binding, operation.binding) && result.affected_target_identities?.length
    && result.raw_payload_hash && operation.observation_ids.some(id => {
      const observed = snapshot.observations[id];
      return observed?.operation_id === operation.operation_id && observed.authority === 'native-host'
        && sameAssignmentBindingV2(observed.binding, operation.binding) && observed.raw_payload_hash === result.raw_payload_hash
        && observed.facts.some(f => f.fact_id === COMPLETE_NATIVE_CHANGE_INVENTORY_FACT_V2 && f.fact_class === 'control' && f.value === true);
    }));
}
