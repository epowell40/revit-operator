import { ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA } from "../assignments/assignment_kernel_v2_publication.js";
import { ASSIGNMENT_SNAPSHOT_V2_SCHEMA } from "../domain/assignment-kernel/index.js";
import { BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA } from "./assignment_kernel_v2_collection.js";
import { ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA } from "@revitoperator/assignment-kernel-v2-contracts";

type JsonRecord = Record<string, unknown>;
type RequestedEffect = "read" | "preview" | "apply";

export type SessionReceiptOperationBindingV2 = {
  state: "bound";
  assignment_id: string;
  operation_id: string;
  capability_id: string;
  requested_effect: RequestedEffect;
  method: string | null;
  path: string | null;
};

export type SessionReceiptOperationResolutionV2 = SessionReceiptOperationBindingV2 | {
  state: "not_v2_tagged" | "unresolved";
  assignment_id: string | null;
  operation_id: string | null;
  reason?: string;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function requestedEffect(value: unknown): RequestedEffect | null {
  return value === "read" || value === "preview" || value === "apply" ? value : null;
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function operationKey(assignmentId: string, operationId: string): string {
  return `${assignmentId}\n${operationId}`;
}

type NotificationOperationReferenceV2 = {
  assignment_id: string;
  operation_id: string;
  run_id: string;
  generation: number;
};

function sameBinding(
  value: unknown,
  expected: NotificationOperationReferenceV2 & { session_id: string }
): boolean {
  const binding = record(value);
  return normalizedText(binding.assignment_id) === expected.assignment_id
    && normalizedText(binding.run_id) === expected.run_id
    && Number(binding.generation) === expected.generation
    && normalizedText(binding.session_id) === expected.session_id;
}

function notificationOperationReferenceV2(parsedResult: JsonRecord):
  | { state: "not_v2_tagged" }
  | { state: "unresolved"; assignment_id: string | null; operation_id: string | null; reason: string }
  | ({ state: "referenced" } & NotificationOperationReferenceV2) {
  const projections = (Array.isArray(parsedResult.evidence_projections) ? parsedResult.evidence_projections : [])
    .map(record)
    .filter((projection) => projection.schema === "revit-operator.evidence-projection.v1"
      && normalizedText(projection.source).startsWith("assignment_kernel_v2:"));
  if (projections.length === 0) return { state: "not_v2_tagged" };
  const candidates = projections.map((projection) => ({
    assignment_id: normalizedText(projection.assignment_id),
    operation_id: normalizedText(projection.attempt_id),
    run_id: normalizedText(projection.run_id),
    generation: Number.isSafeInteger(projection.generation) && Number(projection.generation) >= 1
      ? Number(projection.generation)
      : 0
  }));
  const first = candidates[0]!;
  if (candidates.some((reference) => !reference.assignment_id || !reference.operation_id
      || !reference.run_id || reference.generation < 1)) {
    return {
      state: "unresolved",
      assignment_id: first.assignment_id || null,
      operation_id: first.operation_id || null,
      reason: "v2_evidence_projection_invalid"
    };
  }
  const unique = new Map(candidates.map((reference) => [
    operationKey(reference.assignment_id, reference.operation_id),
    reference
  ]));
  if (unique.size !== 1) {
    return {
      state: "unresolved",
      assignment_id: first.assignment_id,
      operation_id: first.operation_id,
      reason: "v2_evidence_projection_ambiguous"
    };
  }
  const reference = [...unique.values()][0]!;
  if (candidates.some((candidate) => candidate.run_id !== reference.run_id
      || candidate.generation !== reference.generation)) {
    return {
      state: "unresolved",
      assignment_id: reference.assignment_id,
      operation_id: reference.operation_id,
      reason: "v2_evidence_projection_binding_conflict"
    };
  }
  return { state: "referenced", ...reference };
}

/**
 * Binds a Sidecar notification to the exact session-scoped OperationV2 that
 * produced its evidence projection. Typed MCP aliases are capabilities, not
 * native routes, so their requested effect must never be reconstructed by
 * mechanically converting an alias into a path.
 */
export function resolveSessionReceiptOperationV2(input: {
  assignmentKernelV2: unknown;
  expectedSessionId: string;
  toolName: string;
  explicitMethod?: string;
  explicitPath?: string;
  parsedResult: JsonRecord;
}): SessionReceiptOperationResolutionV2 {
  const reference = notificationOperationReferenceV2(input.parsedResult);
  if (reference.state === "not_v2_tagged") {
    return { state: "not_v2_tagged", assignment_id: null, operation_id: null };
  }
  if (reference.state === "unresolved") return reference;
  const unresolved = (reason: string): SessionReceiptOperationResolutionV2 => ({
    state: "unresolved",
    assignment_id: reference.assignment_id,
    operation_id: reference.operation_id,
    reason
  });
  const bundle = record(input.assignmentKernelV2);
  if (bundle.schema !== BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA) {
    return unresolved("v2_publication_bundle_invalid");
  }
  const sessionIndex = record(bundle.session_index);
  if (sessionIndex.schema !== ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA
      || normalizedText(sessionIndex.session_id) !== input.expectedSessionId) {
    return unresolved("v2_session_index_invalid");
  }
  const indexEntries = (Array.isArray(sessionIndex.assignments) ? sessionIndex.assignments : [])
    .map(record)
    .filter((entry) => normalizedText(entry.assignment_id) === reference.assignment_id);
  if (indexEntries.length !== 1 || !sameBinding(indexEntries[0]?.binding, {
    ...reference,
    session_id: input.expectedSessionId
  })) {
    return unresolved("v2_assignment_not_session_indexed");
  }
  const bundleAssignmentIds = Array.isArray(bundle.assignment_ids)
    ? bundle.assignment_ids.map(normalizedText).filter(Boolean)
    : [];
  if (!bundleAssignmentIds.includes(reference.assignment_id)) {
    return unresolved("v2_assignment_id_not_collected");
  }
  const publications = (Array.isArray(bundle.assignments) ? bundle.assignments : [])
    .map(record)
    .filter((candidate) => normalizedText(candidate.assignment_id) === reference.assignment_id);
  if (publications.length !== 1 || publications[0]?.schema !== ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA) {
    return unresolved("v2_exact_publication_missing");
  }
  const publication = publications[0]!;
  const snapshot = record(publication.snapshot);
  if (snapshot.schema !== ASSIGNMENT_SNAPSHOT_V2_SCHEMA
      || !sameBinding(snapshot.current_binding, { ...reference, session_id: input.expectedSessionId })) {
    return unresolved("v2_snapshot_binding_mismatch");
  }
  const snapshotOperation = record(record(snapshot.operations)[reference.operation_id]);
  const operationBinding = record(snapshotOperation.binding);
  const result = record(snapshotOperation.result);
  const resultBinding = record(result.binding);
  const requestIdentity = record(result.request_identity);
  const capabilityId = normalizedText(snapshotOperation.capability_id);
  const effect = requestedEffect(snapshotOperation.requested_effect);
  if (normalizedText(snapshotOperation.operation_id) !== reference.operation_id
      || !sameBinding(operationBinding, { ...reference, session_id: input.expectedSessionId })
      || normalizedText(result.operation_id) !== reference.operation_id
      || !sameBinding(resultBinding, { ...reference, session_id: input.expectedSessionId })
      || !effect || !capabilityId || normalizedText(requestIdentity.capability_id) !== capabilityId) {
    return unresolved("v2_operation_result_binding_invalid");
  }
  if (capabilityId !== input.toolName) {
    return unresolved("v2_capability_mismatch");
  }
  const explicitMethod = normalizedText(input.explicitMethod).toUpperCase();
  const explicitPath = normalizedText(input.explicitPath).toLowerCase();
  const method = normalizedText(requestIdentity.method).toUpperCase() || null;
  const path = normalizedText(requestIdentity.path).toLowerCase() || null;
  if ((method && explicitMethod && method !== explicitMethod)
      || (path && explicitPath && path !== explicitPath)) {
    return unresolved("v2_transport_identity_mismatch");
  }
  return {
    state: "bound",
    assignment_id: reference.assignment_id,
    operation_id: reference.operation_id,
    capability_id: capabilityId,
    requested_effect: effect,
    method,
    path
  };
}
