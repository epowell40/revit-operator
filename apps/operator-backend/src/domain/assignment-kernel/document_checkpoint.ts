import { canonicalJsonV2 } from "./canonical.js";
import { sameAssignmentBindingV2 } from "./identity.js";
import type { OperationResultV2, OperationV2 } from "./operation.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";

export type DocumentCheckpointContinuationV2 = Readonly<{
  checkpoint_of_operation_id: string;
  checkpoint_after_operation_id: string;
}>;
const normalizedPath = (value: string) => value.replace(/\\/g, "/").toLowerCase();

/** A new save of changed document contents, never a retry of an applied edit.
 * Only retained native receipts and reducer-stamped journal order are proof.
 * The reducer repeats this derivation under its journal lock. */
export function documentCheckpointContinuationV2(snapshot: AssignmentSnapshotV2, operation: OperationV2,
  validateNativeCheckpoint: (result: OperationResultV2) => boolean): DocumentCheckpointContinuationV2 | null {
  const request = operation.request_identity;
  if (operation.requested_effect !== "apply" || (operation.operation_role ?? "root") !== "root"
      || operation.retry_of_operation_id || operation.retry_basis || operation.retry_after_operation_id
      || !operation.binding.document_fingerprint || !sameAssignmentBindingV2(snapshot.current_binding, operation.binding)
      || operation.target.document_fingerprint !== operation.binding.document_fingerprint
      || !request?.method || !request.path
      || request.capability_id !== operation.capability_id || !request.request_signature
      || operation.input.method !== request.method || operation.input.path !== request.path
      || snapshot.unresolved_unknown_operation_ids.length > 0) return null;
  const operations = Object.values(snapshot.operations);
  // A checkpoint cannot race an admitted write, even if its effect is not yet known.
  if (operations.some(candidate => candidate.requested_effect === "apply"
      && (candidate.settlement_state !== "settled" || candidate.persistent_effect === "unknown"))) return null;

  const nativeApplied = (candidate: OperationV2): boolean => {
    const result = candidate.result;
    return sameAssignmentBindingV2(operation.binding, candidate.binding)
      && candidate.target.document_fingerprint === operation.binding.document_fingerprint
      && candidate.requested_effect === "apply" && candidate.settlement_state === "settled"
      && candidate.persistent_effect === "applied" && candidate.dispatch_authority === "native"
      && !candidate.observation_retention_error && candidate.observation_ids.length > 0
      && Boolean(result && (result.status === "succeeded" || result.status === "failed_after_dispatch") && result.authority === "native-host"
        && result.dispatch_state === "dispatched" && result.persistent_effect === "applied"
        && result.receipt_id && result.native_correlation_id && result.raw_payload_hash
        && !result.input_schema_gap && !result.result_semantic_gap
        && sameAssignmentBindingV2(operation.binding, result.binding)
        && result.request_identity && candidate.request_identity
        && canonicalJsonV2(result.request_identity) === canonicalJsonV2(candidate.request_identity))
      && Number.isSafeInteger(candidate.admitted_assignment_version) && candidate.admitted_assignment_version! > 0
      && Number.isSafeInteger(candidate.settled_assignment_version)
      && candidate.settled_assignment_version! > candidate.admitted_assignment_version!
      && candidate.settled_assignment_version! <= snapshot.assignment_version;
  };
  const isCheckpoint = (candidate: OperationV2): boolean => {
    const result = candidate.result, receipt = result?.native_artifact_receipt, saved = receipt?.save_document;
    const body = candidate.input.body as Record<string, unknown> | undefined;
    return nativeApplied(candidate) && result?.status === "succeeded" && (candidate.operation_role ?? "root") === "root"
      && Boolean(result && validateNativeCheckpoint(result))
      && saved?.same_document === true && saved.before.project_fingerprint === operation.binding.document_fingerprint
      && saved.after?.project_fingerprint === operation.binding.document_fingerprint
      && typeof body?.filePath === "string" && normalizedPath(body.filePath) === normalizedPath(saved.after.path)
      && candidate.target.target_id === `path:${normalizedPath(saved.after.path)}`;
  };
  // These are precisely the requests covered by the existing duplicate-write guard.
  // Every historical match must be this same successful checkpoint, not a failed,
  // differently bound, relabelled, or partially retained operation.
  const repeats = operations.filter(candidate => candidate.requested_effect === "apply"
    && candidate.request_identity?.method === request.method && candidate.request_identity?.path === request.path
    && candidate.request_identity?.request_signature === request.request_signature);
  if (repeats.length === 0 || repeats.some(candidate => !isCheckpoint(candidate)
      || candidate.capability_id !== operation.capability_id
      || canonicalJsonV2(candidate.request_identity) !== canonicalJsonV2(request)
      || canonicalJsonV2(candidate.target) !== canonicalJsonV2(operation.target)
      || canonicalJsonV2(candidate.input) !== canonicalJsonV2(operation.input))) return null;
  const prior = repeats.sort((a, b) => b.admitted_assignment_version! - a.admitted_assignment_version!)[0]!;
  if (operations.some(candidate => candidate.checkpoint_of_operation_id === prior.operation_id)) return null;
  // A different successful Save As also consumes earlier document changes.
  const lastCheckpoint = operations.filter(isCheckpoint)
    .sort((a, b) => b.settled_assignment_version! - a.settled_assignment_version!)[0]!;
  // A failed post-commit readback does not erase a proven document change.
  // It permits saving that change, not retrying the edit or claiming success.
  const changed = operations.filter(candidate => nativeApplied(candidate)
    && candidate.result!.native_transaction_state === "committed" && !candidate.result!.native_artifact_receipt
    && candidate.admitted_assignment_version! > lastCheckpoint.settled_assignment_version!
    && candidate.result!.affected_target_identities?.some(id => /^(?:element_id|id):[1-9]\d*$/.test(id))
    && !operations.some(consumed => consumed.checkpoint_after_operation_id === candidate.operation_id))
    .sort((a, b) => b.settled_assignment_version! - a.settled_assignment_version!)[0];
  return changed ? { checkpoint_of_operation_id: prior.operation_id, checkpoint_after_operation_id: changed.operation_id } : null;
}
