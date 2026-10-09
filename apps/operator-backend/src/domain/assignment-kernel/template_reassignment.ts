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
const idText = (x: unknown): number | undefined => typeof x === "string" && /^[1-9][0-9]*$/.test(x) && positiveId(Number(x)) ? Number(x) : undefined;
function parameterChange(operation: OperationV2): Row | undefined {
  const body = operation.capability_id === "revit_set_parameters" ? operation.input : row(operation.input.body);
  if (body.apply !== true || body.dryRun !== false || !Array.isArray(body.changes) || body.changes.length !== 1) return undefined;
  const change = row(body.changes[0]);
  if (Object.keys(change).some(key => !["elementId", "parameterName", "value", "expectedOldValue"].includes(key))
    || change.parameterName !== "View Template" || !positiveId(change.elementId)
    || !idText(change.value) || !idText(change.expectedOldValue) || change.value === change.expectedOldValue) return undefined;
  return change;
}
function requestView(operation: OperationV2): number | undefined {
  const body = row(operation.input.body), request = operation.request_identity;
  if (operation.requested_effect !== "apply" || !request
    || request.capability_id !== operation.capability_id || !request.request_signature) return undefined;
  if (operation.capability_id === "revit_set_parameters" || request.path === "/revit/set-parameter") {
    const change = parameterChange(operation);
    if (!change || operation.target.target_id !== `id:${change.elementId}`) return undefined;
    if (operation.capability_id === "revit_set_parameters") {
      if ((operation.operation_role ?? "root") !== "root" || request.method || request.path) return undefined;
    } else if (request.method !== "POST" || operation.input.method !== request.method || operation.input.path !== request.path) return undefined;
    return change.elementId as number;
  }
  if ((operation.operation_role ?? "root") !== "root" || request.method !== "POST" || request.path !== "/revit/visibility"
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
    || result.result_schema_id !== `operator-native/POST:${operation.request_identity?.path}/v2`
    || canonicalJsonV2(result.request_identity) !== canonicalJsonV2(operation.request_identity)
    || !commit || commit.result_id !== result.result_id
    || utf8TextSha256V2(canonicalJsonV2(commit.raw_payload)) !== result.raw_payload_hash) return undefined;
  const payload = row(commit.raw_payload), view = row(payload.view), transaction = row(payload.transaction);
  if (operation.request_identity?.path === "/revit/set-parameter") {
    const change = parameterChange(operation)!, expected = idText(change.value), old = idText(change.expectedOldValue);
    const checks = payload.verification, diffs = payload.diffs;
    if (payload.status !== "Applied and Verified" || payload.dryRun !== false || transaction.status !== "committed" || transaction.committed !== true
      || payload.requestedCount !== 1 || payload.effectiveCount !== 1 || payload.excludedCount !== 0 || payload.changedCount !== 1
      || payload.writeFailedCount !== 0 || payload.verificationPerformed !== true || payload.verifiedCount !== 1 || payload.verificationFailedCount !== 0
      || !Array.isArray(payload.unresolvedElementIds) || payload.unresolvedElementIds.length
      || !Array.isArray(payload.missingAfterElementIds) || payload.missingAfterElementIds.length
      || !Array.isArray(checks) || checks.length !== 1 || !Array.isArray(diffs) || diffs.length !== 1
      || !result.affected_target_identities?.includes(`element_id:${viewId}`)) return undefined;
    const check = row(checks[0]), diff = row(diffs[0]), actual = row(check.actual), after = row(diff.after), before = row(diff.before);
    if (check.elementId !== viewId || check.parameterName !== "View Template" || check.status !== "verified" || check.error != null
      || check.expectedValue !== change.value || actual.storageType !== "ElementId" || actual.value !== expected
      || diff.elementId !== viewId || diff.parameterName !== "View Template" || diff.ok !== true || diff.changed !== true
      || after.storageType !== "ElementId" || after.value !== expected || before.storageType !== "ElementId" || before.value !== old) return undefined;
    return { result_id: result.result_id, raw_payload_hash: result.raw_payload_hash, view_id: viewId, template_id: expected! };
  }
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
  const operations = Object.values(snapshot.operations).filter(o => o.operation_id !== operation.operation_id);
  // A native parameter child may follow only its currently admitted, independently
  // revalidated typed parent. No unrelated open apply is exempted.
  const parent = operation.parent_operation_id ? snapshot.operations[operation.parent_operation_id] : undefined;
  let allowedParent: string | undefined;
  if (parent && parent.capability_id === "revit_set_parameters" && operation.operation_role === "child"
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
    if (o.capability_id !== "revit_set_parameters" || requestView(o) !== viewId
      || (o.operation_role ?? "root") !== "root" || !sameAssignmentBindingV2(operation.binding, o.binding)
      || o.settlement_state !== "settled" || o.persistent_effect !== "none" || o.observation_retention_error
      || o.result?.status !== "completed_without_native_dispatch" || o.result.authority !== "operator-mcp-transport"
      || o.result.dispatch_state !== "not_dispatched" || o.result.persistent_effect !== "none"
      || !sameAssignmentBindingV2(o.binding, o.result.binding)) return undefined;
    const children = operations.filter(child => child.parent_operation_id === o.operation_id);
    if (children.length !== 1) return undefined;
    const child = children[0]!;
    if (!validNative(child) || child.operation_role !== "child" || child.root_operation_id !== o.operation_id
      || child.request_identity?.path !== "/revit/set-parameter"
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
