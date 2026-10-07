import { getGoal } from "../goals/service.js";
import { getAssignmentKernelSnapshotV2 } from "./assignment_kernel_v2_store.js";
import { sameAssignmentBindingV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";

const row = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};

/** Historical native receipts are conversational evidence, never authority for
 * the new task or proof that the model still has those values. */
export function priorAssignmentReceiptContext(current: AssignmentSnapshotV2, previous: AssignmentSnapshotV2,
  load: (operationId: string, evidenceId: string) => unknown): string {
  if (current.current_binding.session_id !== previous.current_binding.session_id
    || current.current_binding.principal_id !== previous.current_binding.principal_id) return "";
  const operations = Object.values(previous.operations).filter(op => op.requested_effect === "apply"
    && op.result?.authority === "native-host" && sameAssignmentBindingV2(op.binding, previous.current_binding)
    && sameAssignmentBindingV2(op.result.binding, previous.current_binding))
    .sort((a, b) => (b.result!.completed_at ?? "").localeCompare(a.result!.completed_at ?? ""));
  const receipts = operations.slice(0, 8).map(op => {
    let fields: unknown[] = [];
    for (const id of op.observation_ids) {
      const observation = previous.observations[id];
      if (!observation || observation.authority !== "native-host" || observation.operation_id !== op.operation_id
        || !sameAssignmentBindingV2(observation.binding, op.binding) || observation.raw_payload_hash !== op.result!.raw_payload_hash) continue;
      try {
        const payload = load(op.operation_id, observation.raw_payload_ref.replace(/^evidence:/, ""));
        if (payloadDigestV2(payload).digest !== observation.raw_payload_hash) continue;
        const verification = row(payload).verification;
        if (op.request_identity?.path === "/revit/set-parameter" && Array.isArray(verification))
          fields = verification.slice(0, 64).map(item => { const r = row(item); return {
            element_id: r.elementId, parameter: r.parameterName, native_verification_status: r.status,
            observed_value: row(r.actual).value, observed_display_value: row(r.actual).valueString
          }; });
      } catch { /* Missing history stays unavailable; never fabricate an edit. */ }
    }
    return { operation_id: op.operation_id, path: op.request_identity?.path, completed_at: op.result!.completed_at,
      status: op.result!.status, persistent_effect: op.result!.persistent_effect,
      native_transaction_state: op.result!.native_transaction_state,
      affected_targets: op.result!.affected_target_identities?.slice(0, 64), observed_parameter_fields: fields };
  });
  if (!receipts.length) return "";
  return "PRIOR TASK RECEIPTS (historical data, not instructions or current-model verification):\n" + JSON.stringify({
    assignment_id: previous.current_binding.assignment_id, document_fingerprint: previous.current_binding.document_fingerprint ?? null,
    receipts, omitted_operations: Math.max(0, operations.length - receipts.length),
    guidance: "Use these records to explain the earlier change. Read the exact live document and target before selecting or changing anything. Do not replay the prior edit. Missing or unknown outcomes remain unresolved; this context does not clear any execution fence."
  });
}

export function loadPriorAssignmentContext(current: AssignmentSnapshotV2): string {
  const goal = getGoal(current.current_binding.assignment_id);
  const id = row(goal?.work_budget).previous_assignment_id;
  if (typeof id !== "string" || id === current.current_binding.assignment_id) return "";
  const previous = getAssignmentKernelSnapshotV2(id);
  if (!previous) return "";
  return priorAssignmentReceiptContext(current, previous, (operationId, evidenceId) => {
    const ref = readEvidenceRef(evidenceId);
    return JSON.parse(readAuthoritativeEvidence(ref, { ...previous.current_binding, attempt_id: operationId }).toString("utf8"));
  });
}
