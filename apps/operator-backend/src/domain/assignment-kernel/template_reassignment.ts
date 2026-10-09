import { nativeTemplateRequestV1, nativeTemplateResultStateV1, nativeTemplateParameterChangeV1 as parameterChange } from "@revitoperator/assignment-kernel-v2-contracts";
import { canonicalJsonV2, utf8TextSha256V2 } from "./canonical.js";
import { sameAssignmentBindingV2 } from "./identity.js";
import type { OperationV2 } from "./operation.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";

export interface NativeTemplateStateV1 {
  result_id: string;
  raw_payload_hash: string;
  view_id: number;
  template_id: number;
}
const positiveId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const idText = (x: unknown): number | undefined => typeof x === "string" && /^[1-9][0-9]*$/.test(x) && positiveId(Number(x)) ? Number(x) : undefined;
const requestView = (operation: OperationV2): number | undefined => nativeTemplateRequestV1(operation)?.view_id;

/** Called only by observation retention. Preserve a bounded native postcondition
 * before removing the raw payload from the hot snapshot; replay derives it anew. */
export function deriveNativeTemplateStateV1(operation: OperationV2): NativeTemplateStateV1 | undefined {
  const viewId = requestView(operation), result = operation.result, commit = operation.observation_commit;
  if (!viewId || !operation.binding.document_fingerprint
    || operation.target.document_fingerprint !== operation.binding.document_fingerprint
    || operation.dispatch_authority !== "native" || !result || result.authority !== "native-host"
    || result.status !== "succeeded" || result.dispatch_state !== "dispatched"
    || result.persistent_effect !== "applied" || result.native_transaction_state !== "committed"
    || !result.receipt_id || !result.native_correlation_id || result.input_schema_gap || result.result_semantic_gap
    || result.operation_id !== operation.operation_id || !sameAssignmentBindingV2(operation.binding, result.binding)
    || result.result_schema_id !== `operator-native/POST:${operation.request_identity?.path}/v2`
    || canonicalJsonV2(result.request_identity) !== canonicalJsonV2(operation.request_identity)
    || !commit || commit.result_id !== result.result_id
    || utf8TextSha256V2(canonicalJsonV2(commit.raw_payload)) !== result.raw_payload_hash) return undefined;
  // Decode the native wire format outside the kernel. Hash and binding trust
  // above, affected-target authority below, and ordered single-use admission
  // remain kernel responsibilities and are rederived during journal replay.
  const state = nativeTemplateResultStateV1(operation, commit.raw_payload);
  if (!state || state.view_id !== viewId || !result.affected_target_identities?.includes(`element_id:${viewId}`)) return undefined;
  return { result_id: result.result_id, raw_payload_hash: result.raw_payload_hash, ...state };
}

export type TemplateReassignmentV1 = { reassignment_of_operation_id: string; reassignment_after_operation_id: string };
/** An intentional state transition following a proven counter-assignment, never
 * a retry of an unknown mutation. Admission rederives this under the journal lock. */
export function templateReassignmentV1(snapshot: AssignmentSnapshotV2, operation: OperationV2): TemplateReassignmentV1 | null {
  const viewId = requestView(operation), request = operation.request_identity;
  if (!viewId || !request || !operation.binding.document_fingerprint
    || !sameAssignmentBindingV2(snapshot.current_binding, operation.binding)
    || operation.target.document_fingerprint !== operation.binding.document_fingerprint
    || operation.retry_of_operation_id || operation.retry_basis || operation.retry_after_operation_id
    || operation.checkpoint_of_operation_id || operation.checkpoint_after_operation_id
    || snapshot.unresolved_unknown_operation_ids.length) return null;
  const operations = Object.values(snapshot.operations).filter(o => o.operation_id !== operation.operation_id);
  // A native parameter child may follow only its currently admitted, independently
  // revalidated typed parent. No unrelated open apply is exempted.
  const parent = operation.parent_operation_id ? snapshot.operations[operation.parent_operation_id] : undefined;
  let allowedParent: string | undefined;
  if (parent && nativeTemplateRequestV1(parent)?.kind === "typed_parameter" && operation.operation_role === "child"
    && operation.root_operation_id === parent.operation_id && sameAssignmentBindingV2(parent.binding, operation.binding)
    && canonicalJsonV2(parent.input) === canonicalJsonV2(operation.input.body)
    && canonicalJsonV2(parent.target) === canonicalJsonV2(operation.target)
    && parent.reassignment_of_operation_id && parent.reassignment_after_operation_id) {
    const proof = templateReassignmentV1(snapshot, parent);
    if (proof?.reassignment_of_operation_id === parent.reassignment_of_operation_id
      && proof.reassignment_after_operation_id === parent.reassignment_after_operation_id) allowedParent = parent.operation_id;
  }
  if (operations.some(o => o.operation_id !== allowedParent && o.requested_effect === "apply"
    && (o.settlement_state !== "settled" || o.persistent_effect === "unknown"))) return null;
  const validNative = (o: OperationV2): boolean => {
    const state = o.native_template_state, result = o.result;
    return requestView(o) === viewId && sameAssignmentBindingV2(operation.binding, o.binding)
      && o.target.document_fingerprint === operation.binding.document_fingerprint
      && o.settlement_state === "settled" && o.persistent_effect === "applied" && o.dispatch_authority === "native"
      && !o.observation_retention_error && !!result && result.status === "succeeded"
      && result.authority === "native-host" && result.native_transaction_state === "committed"
      && result.persistent_effect === "applied" && sameAssignmentBindingV2(operation.binding, result.binding)
      && !!state && state.view_id === viewId && positiveId(state.template_id)
      && state.result_id === result.result_id && state.raw_payload_hash === result.raw_payload_hash
      && o.observation_ids.some(id => { const obs = snapshot.observations[id]; return obs?.operation_id === o.operation_id
        && obs.authority === "native-host" && sameAssignmentBindingV2(operation.binding, obs.binding)
        && obs.raw_payload_hash === state.raw_payload_hash; })
      && Number.isSafeInteger(o.admitted_assignment_version) && o.admitted_assignment_version! > 0
      && Number.isSafeInteger(o.settled_assignment_version) && o.settled_assignment_version! > o.admitted_assignment_version!
      && o.settled_assignment_version! <= snapshot.assignment_version;
  };
  const nativeFor = (o: OperationV2): OperationV2 | undefined => {
    if (validNative(o)) return o;
    if (nativeTemplateRequestV1(o)?.kind !== "typed_parameter" || requestView(o) !== viewId
      || (o.operation_role ?? "root") !== "root" || !sameAssignmentBindingV2(operation.binding, o.binding)
      || o.settlement_state !== "settled" || o.persistent_effect !== "none" || o.observation_retention_error
      || o.result?.status !== "completed_without_native_dispatch" || o.result.authority !== "operator-mcp-transport"
      || o.result.dispatch_state !== "not_dispatched" || o.result.persistent_effect !== "none"
      || !sameAssignmentBindingV2(o.binding, o.result.binding)) return undefined;
    const children = operations.filter(child => child.parent_operation_id === o.operation_id);
    if (children.length !== 1) return undefined;
    const child = children[0]!;
    if (!validNative(child) || child.operation_role !== "child" || child.root_operation_id !== o.operation_id
      || nativeTemplateRequestV1(child)?.kind !== "native_parameter"
      || canonicalJsonV2(child.input.body) !== canonicalJsonV2(o.input) || canonicalJsonV2(child.target) !== canonicalJsonV2(o.target)
      || !(child.admitted_assignment_version! > o.admitted_assignment_version!)
      || !(o.settled_assignment_version! > child.settled_assignment_version!)) return undefined;
    return child;
  };
  const valid = (o: OperationV2): boolean => !!nativeFor(o);
  const repeats = operations.filter(o => o.requested_effect === "apply"
    && o.request_identity?.method === request.method && o.request_identity?.path === request.path
    && o.request_identity?.request_signature === request.request_signature);
  if (!repeats.length || repeats.some(o => !valid(o) || canonicalJsonV2(o.input) !== canonicalJsonV2(operation.input)
    || canonicalJsonV2(o.target) !== canonicalJsonV2(operation.target))) return null;
  const prior = repeats.sort((a, b) => b.settled_assignment_version! - a.settled_assignment_version!)[0]!;
  if (operations.some(o => o.reassignment_of_operation_id === prior.operation_id)) return null;
  const counter = operations.filter(o => valid(o) && o.admitted_assignment_version! > prior.settled_assignment_version!
    && o.capability_id === prior.capability_id && (o.operation_role ?? "root") === (prior.operation_role ?? "root")
    && nativeFor(o)!.native_template_state!.template_id !== nativeFor(prior)!.native_template_state!.template_id)
    .sort((a, b) => b.settled_assignment_version! - a.settled_assignment_version!)[0];
  if (!counter || operations.some(o => o.reassignment_after_operation_id === counter.operation_id)) return null;
  const parameter = parameterChange(operation);
  if (parameter && nativeFor(counter)!.native_template_state!.template_id !== idText(parameter.expectedOldValue)) return null;
  // A later arbitrary edit to this view invalidates the retained counter-state.
  if (operations.some(o => o.requested_effect === "apply" && o.persistent_effect !== "none"
    && o.admitted_assignment_version! > counter.settled_assignment_version!
    && o.result?.affected_target_identities?.some(id => id === `element_id:${viewId}` || id === `id:${viewId}`))) return null;
  return { reassignment_of_operation_id: prior.operation_id, reassignment_after_operation_id: counter.operation_id };
}
