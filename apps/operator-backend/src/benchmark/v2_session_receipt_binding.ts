import {
  ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA,
  ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA,
  ASSIGNMENT_SNAPSHOT_V2_SCHEMA,
  parseAssignmentKernelPublicationV2
} from "@revitoperator/assignment-kernel-v2-contracts";
import { BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA } from "./assignment_kernel_v2_collection.js";

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

export type SessionReceiptAuthorityPolicyV2 = {
  mode: "exact_v2_operation_binding" | "legacy_v1_notification_projection";
  binding_required: boolean;
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

function sessionPublicationPresenceV2(value: unknown, expectedSessionId: string):
  | { state: "absent" }
  | { state: "present"; assignment_ids: string[] }
  | { state: "invalid"; assignment_ids: string[]; reason: string } {
  const bundle = record(value);
  if (Object.keys(bundle).length === 0) return { state: "absent" };
  const bundleIds = Array.isArray(bundle.assignment_ids)
    ? bundle.assignment_ids.map(normalizedText).filter(Boolean)
    : [];
  const publications = Array.isArray(bundle.assignments) ? bundle.assignments.map(record) : [];
  const sessionIndex = record(bundle.session_index);
  if (bundle.schema !== BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA) {
    return bundleIds.length > 0 || publications.length > 0 || Object.keys(sessionIndex).length > 0
      ? { state: "invalid", assignment_ids: bundleIds, reason: "v2_publication_bundle_invalid" }
      : { state: "absent" };
  }
  if (Object.keys(sessionIndex).length === 0) {
    return bundleIds.length > 0 || publications.length > 0
      ? { state: "invalid", assignment_ids: bundleIds, reason: "v2_session_index_missing" }
      : { state: "absent" };
  }
  if (sessionIndex.schema !== ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA
      || normalizedText(sessionIndex.session_id) !== expectedSessionId) {
    return {
      state: "invalid",
      assignment_ids: bundleIds,
      reason: "v2_session_index_invalid"
    };
  }
  try {
    const publicationIds = publications.map((publication) =>
      normalizedText(record(parseAssignmentKernelPublicationV2(publication)).assignment_id));
    if (publicationIds.length !== bundleIds.length
        || new Set(publicationIds).size !== publicationIds.length
        || publicationIds.some((assignmentId) => !bundleIds.includes(assignmentId))) {
      return { state: "invalid", assignment_ids: bundleIds, reason: "v2_exact_publication_set_invalid" };
    }
  } catch {
    return { state: "invalid", assignment_ids: bundleIds, reason: "v2_exact_publication_invalid" };
  }
  const entries = (Array.isArray(sessionIndex.assignments) ? sessionIndex.assignments : []).map(record);
  const indexedIds = [...new Set(entries.map((entry) => normalizedText(entry.assignment_id)).filter(Boolean))];
  if (entries.length === 0) {
    return bundleIds.length > 0 || publications.length > 0
      ? { state: "invalid", assignment_ids: bundleIds, reason: "v2_session_index_empty" }
      : { state: "absent" };
  }
  if (indexedIds.length !== entries.length || indexedIds.some((assignmentId) => !bundleIds.includes(assignmentId))) {
    return {
      state: "invalid",
      assignment_ids: indexedIds,
      reason: "v2_session_index_assignment_invalid"
    };
  }
  return { state: "present", assignment_ids: indexedIds };
}

export function sessionReceiptAuthorityPolicyV2(input: {
  assignmentKernelV2: unknown;
  expectedSessionId: string;
}): SessionReceiptAuthorityPolicyV2 {
  const presence = sessionPublicationPresenceV2(input.assignmentKernelV2, input.expectedSessionId);
  return presence.state === "absent"
    ? { mode: "legacy_v1_notification_projection", binding_required: false }
    : { mode: "exact_v2_operation_binding", binding_required: true };
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
    const presence = sessionPublicationPresenceV2(input.assignmentKernelV2, input.expectedSessionId);
    if (presence.state === "absent") {
      return { state: "not_v2_tagged", assignment_id: null, operation_id: null };
    }
    return {
      state: "unresolved",
      assignment_id: presence.assignment_ids.length === 1 ? presence.assignment_ids[0]! : null,
      operation_id: null,
      reason: presence.state === "invalid" ? presence.reason : "v2_evidence_projection_missing"
    };
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
  let publication: JsonRecord;
  try {
    publication = record(parseAssignmentKernelPublicationV2(publications[0]));
  } catch {
    return unresolved("v2_exact_publication_invalid");
  }
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
