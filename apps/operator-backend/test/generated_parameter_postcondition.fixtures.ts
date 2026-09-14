import { createHash } from "node:crypto";

export const generatedParameterSource = "public class ParameterEdit {}";
export function generatedParameterPayload(fingerprint: string, targets = [42]): any {
  const sourceHash = "sha256:" + createHash("sha256").update(generatedParameterSource).digest("hex");
  const graph = { schema: "dynamic-revit-operation-graph/v0", inputHash: "sha256:" + "a".repeat(64), graphHash: "sha256:" + "b".repeat(64),
    operations: targets.map(id => ({ operationId: "sha256:" + id.toString(16).padStart(64, "0"), kind: "set_parameter",
      targetUniqueId: `unique-${id}`, parameter: "Comments", value: `PILOT-${id}` })) };
  return { schema: "revit-operator.dynamic-revit-program-run.v1", requested_mode: "apply", execution_status: "completed", execution_ok: true,
    iteration: { source_sha256: sourceHash }, report: { Changed: String(targets.length) },
    checkpoint: { task_session_id: "task-289013d60cff4ff0a782e5a1e7ac2ce6", outcome: "committed_verified" },
    evidence: { workerOutput: { ok: true, sourceHash, graph }, hostAuthenticationReceipts: ["authenticated-bootstrap", "authenticated-snapshot"],
      snapshotReceipt: JSON.stringify({ input_hash: graph.inputHash, document: { ProjectFingerprint: "sha256:" + fingerprint, SessionId: "native-session" },
        elements: targets.map(id => ({ UniqueId: `unique-${id}`, ElementId: id })) }),
      applyReceipt: JSON.stringify({ schema: "dynamic-revit-apply-receipt/v1", outcome: "committed_verified", graph_hash: graph.graphHash,
        document_fingerprint: "sha256:" + fingerprint, document_session_id: "native-session", changed_element_ids: [...targets, 99],
        operation_results: graph.operations.map(op => ({ operation_id: op.operationId, kind: op.kind, target: op.targetUniqueId, parameter: op.parameter, after: op.value })) }) } };
}
