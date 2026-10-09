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
type Row = Record<string, unknown>;
const row = (x: unknown): Row => x && typeof x === "object" && !Array.isArray(x) ? x as Row : {};
const positiveId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
function requestView(operation: OperationV2): number | undefined {
  const body = row(operation.input.body), request = operation.request_identity;
  if (operation.requested_effect !== "apply" || (operation.operation_role ?? "root") !== "root"
    || request?.method !== "POST" || request.path !== "/revit/visibility"
    || operation.input.method !== request.method || operation.input.path !== request.path
    || request.capability_id !== operation.capability_id || !request.request_signature
    || body.action !== "set_template" || !positiveId(body.viewId)
    || typeof body.templateName !== "string" || !body.templateName.trim() || body.dryRun === true
    || operation.target.target_id !== `id:${body.viewId}`) return undefined;
  return body.viewId;
}

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
    || result.result_schema_id !== "operator-native/POST:/revit/visibility/v2"
    || canonicalJsonV2(result.request_identity) !== canonicalJsonV2(operation.request_identity)
    || !commit || commit.result_id !== result.result_id
    || utf8TextSha256V2(canonicalJsonV2(commit.raw_payload)) !== result.raw_payload_hash) return undefined;
  const payload = row(commit.raw_payload), view = row(payload.view), transaction = row(payload.transaction);
  if (payload.success !== true || payload.action !== "set_template" || payload.dryRun !== false
    || transaction.status !== "committed" || view.id !== viewId || !positiveId(view.viewTemplateId)
    || typeof view.viewTemplate !== "string"
    || view.viewTemplate.trim().toLowerCase() !== String(row(operation.input.body).templateName).trim().toLowerCase()
    || !result.affected_target_identities?.includes(`element_id:${viewId}`)) return undefined;
  return { result_id: result.result_id, raw_payload_hash: result.raw_payload_hash,
    view_id: viewId, template_id: view.viewTemplateId };
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
  const operations = Object.values(snapshot.operations);
  if (operations.some(o => o.requested_effect === "apply" && (o.settlement_state !== "settled" || o.persistent_effect === "unknown"))) return null;
  const valid = (o: OperationV2): boolean => {
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
  const repeats = operations.filter(o => o.requested_effect === "apply"
    && o.request_identity?.method === request.method && o.request_identity?.path === request.path
    && o.request_identity?.request_signature === request.request_signature);
  if (!repeats.length || repeats.some(o => !valid(o) || canonicalJsonV2(o.input) !== canonicalJsonV2(operation.input)
    || canonicalJsonV2(o.target) !== canonicalJsonV2(operation.target))) return null;
  const prior = repeats.sort((a, b) => b.settled_assignment_version! - a.settled_assignment_version!)[0]!;
  if (operations.some(o => o.reassignment_of_operation_id === prior.operation_id)) return null;
  const counter = operations.filter(o => valid(o) && o.admitted_assignment_version! > prior.settled_assignment_version!
    && o.native_template_state!.template_id !== prior.native_template_state!.template_id)
    .sort((a, b) => b.settled_assignment_version! - a.settled_assignment_version!)[0];
  if (!counter || operations.some(o => o.reassignment_after_operation_id === counter.operation_id)) return null;
  // A later arbitrary edit to this view invalidates the retained counter-state.
  if (operations.some(o => o.requested_effect === "apply" && o.persistent_effect !== "none"
    && o.admitted_assignment_version! > counter.settled_assignment_version!
    && o.result?.affected_target_identities?.some(id => id === `element_id:${viewId}` || id === `id:${viewId}`))) return null;
  return { reassignment_of_operation_id: prior.operation_id, reassignment_after_operation_id: counter.operation_id };
}
