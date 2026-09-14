import { createHash } from "node:crypto";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import { sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from "../domain/assignment-kernel/index.js";
import { postconditionSatisfiedByPayloadV2 } from "../postcondition_verification_v2.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
function receipt(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length > 16_000_000) return {};
  try { return record(JSON.parse(value)); } catch { return {}; }
}

/** Derive expectations from the retained executed graph and native commit, never
 * C# text interpretation, program reports, or model-authored success claims.
 * This adapter covers complete basic parameter graphs only. Other graph kinds
 * require their own reviewed postconditions and cannot be partially verified.
 */
export function generatedParameterPostconditionInputV2(
  snapshot: AssignmentSnapshotV2, subject: OperationV2, readResult: OperationResultV2
): { changes: Array<{ elementId: number; parameterName: string; value: string }> } | null {
  if (subject.capability_id !== "operator_run_dynamic_revit_program" || subject.requested_effect !== "apply"
      || subject.persistent_effect !== "applied" || subject.settlement_state !== "settled"
      || !sameAssignmentBindingV2(subject.binding, snapshot.current_binding)
      || subject.result?.authority !== "dynamic-runtime" || subject.result.status !== "succeeded"
      || subject.result.result_schema_id !== "operator-dynamic-runtime/mcp-program/v2"
      || subject.result.native_transaction_state !== "committed"
      || readResult.authority !== "native-host" || readResult.status !== "succeeded"
      || readResult.dispatch_state !== "dispatched" || readResult.persistent_effect !== "none"
      || !sameAssignmentBindingV2(readResult.binding, snapshot.current_binding)) return null;
  const args = record(record(subject.input).arguments ?? subject.input);
  if (args.mode !== "apply" || typeof args.source !== "string") return null;
  const sourceHash = "sha256:" + createHash("sha256").update(args.source.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
  for (const id of subject.observation_ids) {
    const observation = snapshot.observations[id];
    if (!observation || observation.operation_id !== subject.operation_id || observation.authority !== "dynamic-runtime" || observation.evidence_class !== "task_result"
        || !sameAssignmentBindingV2(observation.binding, snapshot.current_binding)
        || observation.raw_payload_hash !== subject.result.raw_payload_hash) continue;
    try {
      const ref = readEvidenceRef(observation.raw_payload_ref.replace(/^evidence:/, ""));
      if (ref.byte_count > 32_000_000) continue;
      const bytes = readAuthoritativeEvidence(ref, { ...snapshot.current_binding, attempt_id: subject.operation_id });
      const payload = record(JSON.parse(bytes.toString("utf8")));
      if (payloadDigestV2(payload).digest !== observation.raw_payload_hash || payload.requested_mode !== "apply"
          || payload.schema !== "revit-operator.dynamic-revit-program-run.v1"
          || payload.execution_ok !== true || payload.execution_status !== "completed"
          || record(payload.iteration).source_sha256 !== sourceHash) continue;
      const evidence = record(payload.evidence), worker = record(evidence.workerOutput);
      const graph = record(worker.graph), applied = receipt(evidence.applyReceipt), captured = receipt(evidence.snapshotReceipt);
      const doc = record(captured.document);
      const fingerprint = snapshot.current_binding.document_fingerprint?.replace(/^sha256:/, "");
      if (!fingerprint || doc.ProjectFingerprint !== "sha256:" + fingerprint
          || applied.document_fingerprint !== doc.ProjectFingerprint || !doc.SessionId || applied.document_session_id !== doc.SessionId
          || worker.sourceHash !== sourceHash || worker.ok !== true
          || !hash(graph.inputHash) || graph.inputHash !== captured.input_hash
          || graph.schema !== "dynamic-revit-operation-graph/v0" || !hash(graph.graphHash) || applied.graph_hash !== graph.graphHash
          || applied.schema !== "dynamic-revit-apply-receipt/v1" || applied.outcome !== "committed_verified"
          || !Array.isArray(evidence.hostAuthenticationReceipts) || evidence.hostAuthenticationReceipts.length < 2
          || !Array.isArray(graph.operations) || graph.operations.length < 1 || graph.operations.length > 256
          || !Array.isArray(applied.operation_results) || applied.operation_results.length !== graph.operations.length
          || !Array.isArray(captured.elements) || captured.elements.length > 1000) continue;
      const targets = new Map<string, number>(), elementIds = new Set<number>();
      for (const item of captured.elements) {
        const row = record(item);
        if (typeof row.UniqueId !== "string" || !Number.isSafeInteger(row.ElementId) || Number(row.ElementId) <= 0 || targets.has(row.UniqueId) || elementIds.has(row.ElementId as number)) return null;
        targets.set(row.UniqueId, row.ElementId as number);
        elementIds.add(row.ElementId as number);
      }
      const changes: Array<{ elementId: number; parameterName: string; value: string }> = [];
      const operationIds = new Set<string>(), assignments = new Set<string>();
      for (let index = 0; index < graph.operations.length; index++) {
        const op = record(graph.operations[index]), result = record(applied.operation_results[index]);
        const target = typeof op.targetUniqueId === "string" ? targets.get(op.targetUniqueId) : undefined;
        if (op.kind !== "set_parameter" || !hash(op.operationId) || operationIds.has(op.operationId) || !target
            || typeof op.parameter !== "string" || !op.parameter.length || op.parameter.length > 128
            || typeof op.value !== "string" || op.value.length > 32768
            || result.operation_id !== op.operationId || result.kind !== op.kind || result.target !== op.targetUniqueId
            || result.parameter !== op.parameter || result.after !== op.value
            || !Array.isArray(applied.changed_element_ids) || !applied.changed_element_ids.includes(target)) return null;
        const key = JSON.stringify([target, op.parameter]);
        if (assignments.has(key)) return null; // Repeated writes need an explicit final-state contract.
        operationIds.add(op.operationId); assignments.add(key);
        changes.push({ elementId: target, parameterName: op.parameter, value: op.value });
      }
      return { changes };
    } catch { /* Missing, corrupt or foreign evidence cannot establish verification. */ }
  }
  return null;
}

/** Consume only the reviewed native parameter-read rows, not nested reports or
 * echoed request/diagnostic containers that happen to contain expected values. */
export function generatedParameterPostconditionSatisfiedV2(
  snapshot: AssignmentSnapshotV2, subject: OperationV2, readResult: OperationResultV2, payload: unknown
): boolean {
  if (readResult.request_identity?.path !== "/revit/get-parameters" || readResult.request_identity.method !== "POST") return false;
  const expected = generatedParameterPostconditionInputV2(snapshot, subject, readResult);
  const rows = record(payload).items;
  if (!expected || !Array.isArray(rows) || !rows.length || rows.length > 1000) return false;
  const ids = new Set<number>(), items = [];
  for (const item of rows) {
    const row = record(item), parameters = record(row.parameters);
    if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || ids.has(row.id as number)
        || Object.values(parameters).some(value => value !== null && !["string", "number", "boolean"].includes(typeof value))) return false;
    ids.add(row.id as number); items.push({ id: row.id, parameters });
  }
  return postconditionSatisfiedByPayloadV2(expected, { items });
}
