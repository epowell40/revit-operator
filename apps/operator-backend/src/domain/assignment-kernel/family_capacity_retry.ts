import { nativeFamilySessionRequestV1 } from "@revitoperator/assignment-kernel-v2-contracts";
import { canonicalJsonV2 } from "./canonical.js";
import { sameAssignmentBindingV2 } from "./identity.js";
import type { OperationV2 } from "./operation.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";

const isOpen = (operation: OperationV2) => nativeFamilySessionRequestV1(operation)?.kind === "open";

/** One retry after a native-confirmed no-save close frees a retained family slot.
 * Recomputed by the reducer: provider labels, clocks, and wrapper success are
 * not proof. Neither an unknown effect nor a successful open can be retried. */
export function familyCapacityRetryV2(snapshot: AssignmentSnapshotV2, operation: OperationV2) {
  const request = operation.request_identity;
  if (operation.requested_effect !== "apply" || (operation.operation_role ?? "root") !== "root"
      || !request || request.method !== "POST" || !isOpen(operation)
      || operation.input.path !== request.path || operation.input.method !== request.method
      || !operation.binding.document_fingerprint
      || operation.target.document_fingerprint !== operation.binding.document_fingerprint
      || !sameAssignmentBindingV2(snapshot.current_binding, operation.binding)
      || snapshot.unresolved_unknown_operation_ids.length) return null;
  const operations = Object.values(snapshot.operations);
  if (operations.some(o => o.requested_effect === "apply" && (o.settlement_state !== "settled" || o.persistent_effect === "unknown"))) return null;
  const nativeNone = (o: OperationV2) => {
    const r = o.result;
    return sameAssignmentBindingV2(operation.binding, o.binding)
      && o.target.document_fingerprint === operation.binding.document_fingerprint
      && o.requested_effect === "apply" && o.settlement_state === "settled" && o.persistent_effect === "none"
      && o.dispatch_authority === "native" && !o.observation_retention_error && o.observation_ids.length > 0
      && r?.authority === "native-host" && r.dispatch_state === "dispatched" && r.persistent_effect === "none"
      && r.native_transaction_state === "not_applicable" && r.receipt_id && r.native_correlation_id && r.raw_payload_hash
      && sameAssignmentBindingV2(operation.binding, r.binding)
      && canonicalJsonV2(r.request_identity) === canonicalJsonV2(o.request_identity)
      && !r.input_schema_gap && !r.result_semantic_gap
      && Number.isSafeInteger(o.admitted_assignment_version) && o.admitted_assignment_version! > 0
      && Number.isSafeInteger(o.settled_assignment_version) && o.settled_assignment_version! > o.admitted_assignment_version!
      && o.settled_assignment_version! <= snapshot.assignment_version;
  };
  const hasFacts = (o: OperationV2, expected: Record<string, unknown>) => o.observation_ids.some(id => {
    const obs = snapshot.observations[id];
    return obs?.authority === "native-host" && obs.operation_id === o.operation_id
      && sameAssignmentBindingV2(operation.binding, obs.binding) && obs.raw_payload_hash === o.result?.raw_payload_hash
      && Boolean(obs.raw_payload_ref)
      && Object.entries(expected).every(([key, value]) => obs.facts.some(f => f.fact_id === `control.field.${key}` && f.value === value));
  });
  const prior = operations.filter(o => canonicalJsonV2(o.request_identity) === canonicalJsonV2(request)
    && canonicalJsonV2(o.input) === canonicalJsonV2(operation.input)
    && canonicalJsonV2(o.target) === canonicalJsonV2(operation.target))
    .sort((a, b) => (b.admitted_assignment_version ?? 0) - (a.admitted_assignment_version ?? 0))[0];
  if (!prior || !nativeNone(prior) || prior.result?.status !== "failed_after_dispatch"
      || prior.result.error_code !== "family_session_capacity_reached"
      || operations.some(o => o.retry_of_operation_id === prior.operation_id)) return null;
  const closed = operations.filter(o => {
    const close = nativeFamilySessionRequestV1(o);
    const sid = close?.kind === "close_without_save" ? close.session_id : undefined;
    if (!nativeNone(o) || o.result?.status !== "succeeded" || o.request_identity?.method !== "POST"
        || close?.kind !== "close_without_save"
        || typeof sid !== "string" || !/^[a-f0-9]{32}$/i.test(sid)
        || o.admitted_assignment_version! <= prior.settled_assignment_version!
        || !hasFacts(o, { ok: true, closed: true, saved: false, family_document_id: sid })
        || operations.some(used => used.retry_after_operation_id === o.operation_id)) return false;
    // The freed slot must be one this same assignment demonstrably held.
    const opened = operations.some(p => nativeNone(p) && p.result?.status === "succeeded"
      && isOpen(p) && p.settled_assignment_version! < prior.admitted_assignment_version!
      && hasFacts(p, { ok: true, family_document_id: sid }));
    // A later successful open has already consumed the available capacity.
    return opened && !operations.some(p => isOpen(p)
      && p.result?.status === "succeeded" && p.admitted_assignment_version! > o.settled_assignment_version!);
  }).sort((a, b) => b.settled_assignment_version! - a.settled_assignment_version!)[0];
  return closed ? { retry_of_operation_id: prior.operation_id,
    retry_basis: "family_session_capacity_released" as const, retry_after_operation_id: closed.operation_id } : null;
}
