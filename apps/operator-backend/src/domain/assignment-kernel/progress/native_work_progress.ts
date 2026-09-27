import { canonicalJsonV2 } from "../canonical.js";
import { sameAssignmentBindingV2 } from "../identity.js";
import { operationMatchesTargetIdentityV2 } from "../operation_target_identity.js";
import type { OperationV2 } from "../operation.js";
import type { AssignmentSnapshotV2 } from "../snapshot.js";

function retainedNativeSuccess(snapshot: AssignmentSnapshotV2, operation: OperationV2): boolean {
  const result = operation.result;
  return operation.admission_state === "admitted" && operation.dispatch_state === "dispatched"
    && operation.settlement_state === "settled" && sameAssignmentBindingV2(operation.binding, snapshot.current_binding)
    && !snapshot.input_invalidated_operation_ids?.includes(operation.operation_id)
    && result?.authority === "native-host" && result.status === "succeeded"
    && result.dispatch_state === "dispatched" && result.operation_id === operation.operation_id
    && sameAssignmentBindingV2(result.binding, operation.binding) && !result.result_semantic_gap
    && operation.observation_ids.some(id => {
      const observation = snapshot.observations[id];
      return observation?.authority === "native-host" && observation.operation_id === operation.operation_id
        && sameAssignmentBindingV2(observation.binding, operation.binding)
        && observation.capability_id === operation.capability_id
        && Boolean(observation.raw_payload_hash) && observation.raw_payload_hash === result.raw_payload_hash
        && observation.facts.some(f => f.fact_id === "control.domain_succeeded" && f.value === true);
    });
}

/** A native commit is useful work before its separate engineering verification.
 * This does not pass a criterion, enlarge a hard budget, or close a work item. */
export function nativeCommitProgressIdentityV2(snapshot: AssignmentSnapshotV2, operation: OperationV2): string | null {
  const result = operation.result;
  if (snapshot.spec.requested_effect !== "apply" || operation.requested_effect !== "apply" || operation.purpose !== "work"
      || operation.fulfillment_role !== "delegated_task_execution" || operation.persistent_effect !== "applied"
      || result?.persistent_effect !== "applied" || result.native_transaction_state !== "committed"
      || !result.receipt_id || !result.affected_target_identities?.length || !retainedNativeSuccess(snapshot, operation)) return null;
  return canonicalJsonV2({ document: operation.binding.document_fingerprint, native_receipt: result.receipt_id });
}

/** Count a retained, exact-target read once per native edit and selector shape.
 * Repeated reads, changed timestamps and new observation/receipt IDs add no
 * credit. The actual postcondition remains a separate, stricter contract. */
export function nativeVerificationProgressIdentityV2(
  snapshot: AssignmentSnapshotV2, operation: OperationV2, readIdentities: Readonly<Record<string, string>>
): string | null {
  const subject = operation.verification_of_operation_id ? snapshot.operations[operation.verification_of_operation_id] : undefined;
  const readIdentity = readIdentities[operation.operation_id];
  const subjectIdentity = subject && nativeCommitProgressIdentityV2(snapshot, subject);
  if (!subject || !subjectIdentity || !readIdentity || readIdentity.length > 100_000
      || operation.purpose !== "verification" || operation.requested_effect !== "read"
      || operation.fulfillment_role !== "verification" || operation.persistent_effect !== "none"
      || operation.result?.persistent_effect !== "none" || operation.result.native_transaction_state !== "not_applicable"
      || !subject.verification_operation_ids.includes(operation.operation_id) || !retainedNativeSuccess(snapshot, operation)
      || !(Date.parse(operation.opened_at) >= Date.parse(subject.result!.completed_at))
      || operation.target.document_fingerprint !== subject.target.document_fingerprint) return null;
  const targets = [operation.target.target_id, ...Object.values(operation.target.semantic_scope ?? {})]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (!targets.length || !targets.every(target => operationMatchesTargetIdentityV2(subject, [target]))) return null;
  return canonicalJsonV2({ native_change: subjectIdentity, read: readIdentity });
}
