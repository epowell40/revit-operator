import { canonicalJsonV2, utf8TextSha256V2 } from "./canonical.js";
import { sameAssignmentBindingV2 } from "./identity.js";
import type { OperationV2 } from "./operation.js";

/** Reducer-derived failure context, not a caller-supplied retry authorization. */
export interface NativeFailureContextV1 {
  schema: "revit-operator.native-failure-context/v1";
  operation_id: string;
  result_id: string;
  raw_payload_hash: string;
  receipt_id: string;
  native_correlation_id: string;
  request_signature: string;
  dependencies: readonly Readonly<{ element_id: string; target_element_ids: readonly string[] }>[];
}

/** Called only after authoritative observation retention. The raw payload stays
 * in the immutable result event; cold replay derives the same bounded context.
 * A malformed, incomplete or merely incidental diagnostic grants no credit. */
export function deriveNativeFailureContextV1(operation: OperationV2, dependencies: NativeFailureContextV1["dependencies"] | undefined): NativeFailureContextV1 | undefined {
  const result = operation.result, commit = operation.observation_commit, request = operation.request_identity;
  if (operation.requested_effect !== "apply" || (operation.operation_role ?? "root") !== "root"
      || operation.dispatch_authority !== "native" || !operation.binding.document_fingerprint
      || operation.target.document_fingerprint !== operation.binding.document_fingerprint
      || !result || result.status !== "failed_after_dispatch" || result.dispatch_state !== "dispatched"
      || result.authority !== "native-host" || result.persistent_effect !== "none"
      || result.native_transaction_state !== "rolled_back" || !result.observation_required
      || !result.receipt_id || !result.native_correlation_id || !result.raw_payload_hash
      || result.input_schema_gap || result.result_semantic_gap
      || result.operation_id !== operation.operation_id || !sameAssignmentBindingV2(operation.binding, result.binding)
      || !request || request.method !== "POST" || !request.path
      || result.result_schema_id !== `operator-native/POST:${request.path}/v2`
      || canonicalJsonV2(result.request_identity ?? null) !== canonicalJsonV2(request)
      || !commit || commit.schema !== "revit-operator.observation-commit-input/v2" || commit.result_id !== result.result_id) return undefined;
  if (!dependencies?.length || utf8TextSha256V2(canonicalJsonV2(commit.raw_payload)) !== result.raw_payload_hash) return undefined;
  return { schema: "revit-operator.native-failure-context/v1", operation_id: operation.operation_id,
    result_id: result.result_id, raw_payload_hash: result.raw_payload_hash, receipt_id: result.receipt_id,
    native_correlation_id: result.native_correlation_id, request_signature: request.request_signature,
    dependencies };
}

/** Additional path to the existing single-use committed-target correction.
 * Both the named dependency and its original target must actually be affected;
 * an incidental target change by an unrelated request remains insufficient. */
export function committedNativeFailureDependencyV1(prior: OperationV2, declaredCorrection: ReadonlySet<string>, affected: ReadonlySet<string>, targets: ReadonlySet<string>): boolean {
  const context = prior.native_failure_context, result = prior.result;
  if (!context || context.schema !== "revit-operator.native-failure-context/v1" || !result
      || context.operation_id !== prior.operation_id || context.result_id !== result.result_id
      || context.raw_payload_hash !== result.raw_payload_hash || context.receipt_id !== result.receipt_id
      || context.native_correlation_id !== result.native_correlation_id
      || context.request_signature !== prior.request_identity?.request_signature) return false;
  return context.dependencies.some(dependency => declaredCorrection.has(dependency.element_id) && affected.has(dependency.element_id)
    && dependency.target_element_ids.some(id => targets.has(id) && affected.has(id)));
}
