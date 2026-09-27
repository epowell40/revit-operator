import { committedNativeFailureDependencyV1 } from "./native_failure_context.js";
import { sameAssignmentBindingV2 } from "./identity.js";
import type { OperationV2 } from "./operation.js";
import { operationProgressIdentityV2 } from "./progress/controller.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";

/** Only canonical document-global element IDs, never names, connector indices,
 * inferred result inventories, or incidental transaction dependencies. */
function declaredElementIds(operation: OperationV2): Set<string> {
  return new Set([operation.target.target_id, ...Object.values(operation.target.semantic_scope ?? {})]
    .filter((value): value is string => typeof value === "string" && /^id:[1-9]\d*$/.test(value))
    .map(value => value.slice(3)));
}

export type CommittedTargetChangeRetryV2 = Readonly<{
  retry_of_operation_id: string;
  retry_basis: "committed_target_change";
  retry_after_operation_id: string;
}>;

/** Derive a single-use correction from canonical native history. The reducer
 * calls this again under the journal lock; caller-supplied retry labels are
 * never authority. Journal versions establish order without trusting clocks. */
export function committedTargetChangeRetryV2(snapshot: AssignmentSnapshotV2, operation: OperationV2): CommittedTargetChangeRetryV2 | null {
  if (operation.requested_effect !== "apply" || (operation.operation_role ?? "root") !== "root"
      || !operation.binding.document_fingerprint
      || operation.target.document_fingerprint !== operation.binding.document_fingerprint
      || !sameAssignmentBindingV2(snapshot.current_binding, operation.binding)) return null;
  const operations = Object.values(snapshot.operations);
  const identity = operationProgressIdentityV2(operation);
  const prior = operations.filter(candidate => sameAssignmentBindingV2(operation.binding, candidate.binding)
    && operationProgressIdentityV2(candidate) === identity)
    .sort((a, b) => (b.admitted_assignment_version ?? 0) - (a.admitted_assignment_version ?? 0))[0];
  if (!prior || prior.settlement_state !== "settled" || prior.persistent_effect !== "none"
      || prior.result?.status !== "failed_after_dispatch" || prior.result.authority !== "native-host"
      || prior.result.persistent_effect !== "none" || prior.dispatch_authority !== "native"
      || !["not_started", "rolled_back"].includes(prior.result.native_transaction_state)
      || prior.observation_retention_error || !prior.settled_assignment_version
      || prior.result.input_schema_gap || prior.result.result_semantic_gap
      || operations.some(candidate => candidate.retry_of_operation_id === prior.operation_id)) return null;
  const targets = declaredElementIds(operation);
  if (targets.size === 0) return null;
  const changed = operations.filter(candidate => {
    const result = candidate.result;
    if (!sameAssignmentBindingV2(operation.binding, candidate.binding)
        || candidate.target.document_fingerprint !== operation.binding.document_fingerprint
        || candidate.requested_effect !== "apply" || candidate.settlement_state !== "settled"
        || candidate.persistent_effect !== "applied" || candidate.dispatch_authority !== "native"
        || candidate.observation_retention_error || !result || result.authority !== "native-host"
        || result.status !== "succeeded" || result.dispatch_state !== "dispatched"
        || result.persistent_effect !== "applied" || result.native_transaction_state !== "committed"
        || !result.receipt_id || !result.native_correlation_id
        || !sameAssignmentBindingV2(operation.binding, result.binding)
        || !candidate.admitted_assignment_version || !candidate.settled_assignment_version
        || candidate.admitted_assignment_version <= prior.settled_assignment_version!
        || candidate.settled_assignment_version <= candidate.admitted_assignment_version
        || candidate.settled_assignment_version > snapshot.assignment_version) return false;
    const declared = declaredElementIds(candidate);
    const affected = new Set((result.affected_target_identities ?? []).flatMap(identity => {
      const match = /^(?:element_id|id):([1-9]\d*)$/.exec(identity);
      return match ? [match[1]!] : [];
    }));
    return [...affected].some(id => targets.has(id) && declared.has(id))
      || committedNativeFailureDependencyV1(prior, declared, affected, targets);
  }).sort((a, b) => b.settled_assignment_version! - a.settled_assignment_version!)[0];
  return changed ? { retry_of_operation_id: prior.operation_id, retry_basis: "committed_target_change",
    retry_after_operation_id: changed.operation_id } : null;
}
