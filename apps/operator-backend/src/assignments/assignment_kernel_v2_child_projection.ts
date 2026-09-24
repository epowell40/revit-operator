import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";

type RecordValue = Record<string, unknown>;
const row = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/** The MCP alias has no Observation; only an exact native child can supply it. */
export function nativeChildProjectionReferencesV2(
  snapshot: AssignmentSnapshotV2,
  parentOperationId: string,
  mcpResult: unknown
): Array<{ operation_id: string; evidence_id: string }> {
  const parent = snapshot.operations[parentOperationId];
  const structured = row(row(mcpResult).structuredContent ?? row(mcpResult).structured_content);
  const result = row(structured.operation_result_v2);
  if (!parent || string(result.operation_id) !== parentOperationId
      || parent.result?.observation_required !== false) return [];
  const children = Array.isArray(structured.child_operation_results_v2)
    ? structured.child_operation_results_v2.map(row) : [];
  const references: Array<{ operation_id: string; evidence_id: string }> = [];
  const seen = new Set<string>();
  for (const entry of children) {
    const operationId = string(entry.operation_id);
    const child = snapshot.operations[operationId];
    const identity = row(child?.request_identity);
    const resultIdentity = row(child?.result?.request_identity);
    const entryIdentity = row(entry.request_identity);
    const method = string(identity.method).toUpperCase();
    const path = string(identity.path).toLowerCase();
    if (!child || child.operation_role !== "child"
        || seen.has(operationId)
        || child.parent_operation_id !== parentOperationId
        || child.root_operation_id !== parentOperationId
        || string(entry.parent_operation_id) !== parentOperationId
        || child.result?.operation_id !== operationId
        || child.result.observation_required !== true
        || child.requested_effect !== parent.requested_effect
        || !["GET", "POST"].includes(method)
        || !/^\/revit\/[a-z0-9/-]+$/.test(path)
        || child.capability_id !== `native:${method}:${path}`
        || string(identity.capability_id) !== child.capability_id
        || string(resultIdentity.capability_id) !== child.capability_id
        || string(entryIdentity.capability_id) !== child.capability_id
        || string(resultIdentity.method).toUpperCase() !== method
        || string(entryIdentity.method).toUpperCase() !== method
        || string(resultIdentity.path).toLowerCase() !== path
        || string(entryIdentity.path).toLowerCase() !== path
        || child.binding.assignment_id !== parent.binding.assignment_id
        || child.binding.run_id !== parent.binding.run_id
        || child.binding.generation !== parent.binding.generation
        || child.binding.session_id !== parent.binding.session_id) return [];
    seen.add(operationId);
    const projections = Array.isArray(entry.evidence_projections) ? entry.evidence_projections.map(row) : [];
    if (projections.length !== 1 || child.observation_ids.length !== 1) return [];
    const projection = projections[0]!;
    const observation = snapshot.observations[child.observation_ids[0]!];
    const evidenceId = string(projection.evidence_id);
    if (!observation || observation.operation_id !== operationId
        || observation.raw_payload_ref !== `evidence:${evidenceId}`
        || string(projection.source) !== `assignment_kernel_v2:${child.capability_id}`
        || string(projection.attempt_id) !== operationId
        || string(projection.assignment_id) !== parent.binding.assignment_id
        || string(projection.run_id) !== parent.binding.run_id
        || Number(projection.generation) !== parent.binding.generation) return [];
    references.push({ operation_id: operationId, evidence_id: evidenceId });
  }
  return references;
}
