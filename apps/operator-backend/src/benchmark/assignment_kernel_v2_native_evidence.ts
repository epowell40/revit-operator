import {
  OBSERVATION_V2_SCHEMA,
  OPERATION_RESULT_V2_SCHEMA,
  OPERATION_V2_SCHEMA
} from "../domain/assignment-kernel/index.js";
import {
  ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA,
  ASSIGNMENT_SNAPSHOT_V2_SCHEMA,
  parseAssignmentKernelPublicationV2
} from "@revitoperator/assignment-kernel-v2-contracts";
import { BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA } from "./assignment_kernel_v2_collection.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
}

function bindingMatches(left: JsonRecord, right: JsonRecord): boolean {
  return ["assignment_id", "run_id", "generation", "session_id", "principal_id"]
    .every((key) => left[key] === right[key]);
}

export function nativeOperationIdentityFromResultSchemaV2(value: unknown): {
  method: "GET" | "POST";
  path: string;
} | null {
  const match = /^operator-native\/(GET|POST):(\/revit\/[a-z0-9][a-z0-9/-]*)\/v\d+$/i
    .exec(String(value ?? "").trim());
  return match ? { method: match[1]!.toUpperCase() as "GET" | "POST", path: match[2]!.toLowerCase() } : null;
}

export type AssignmentKernelNativeOperationOutcomeV2 =
  | "completed"
  | "pending"
  | "rejected_no_effect"
  | "failed"
  | "outcome_unknown";

export type AssignmentKernelNativeOperationEvidenceV2 = Readonly<{
  assignment_id: string;
  operation_id: string;
  capability_id: string;
  requested_effect: "read" | "preview" | "apply";
  method: "GET" | "POST";
  path: string;
  outcome: AssignmentKernelNativeOperationOutcomeV2;
  result_status: string;
  result_id: string;
  observation_ids: readonly string[];
  retry_of_operation_id: string | null;
  dispatched_at: string | null;
  completed_at: string | null;
}>;

export type AssignmentKernelNativeEvidenceProjectionV2 = Readonly<{
  present: boolean;
  malformed: boolean;
  operations: readonly AssignmentKernelNativeOperationEvidenceV2[];
}>;

/**
 * Projects actual native execution from exact V2 results. In particular, the
 * native route comes from the result-schema contract, never from a wrapper's
 * documentation target or a Sidecar notification alias.
 */
export function assignmentKernelNativeEvidenceProjectionV2(value: unknown): AssignmentKernelNativeEvidenceProjectionV2 {
  const bundle = record(value);
  if (Object.keys(bundle).length === 0) return { present: false, malformed: false, operations: [] };
  if (bundle.schema !== BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA) {
    return { present: true, malformed: true, operations: [] };
  }
  const assignmentIds = strings(bundle.assignment_ids);
  const publications = records(bundle.assignments);
  if (records(bundle.failures).length > 0
      || new Set(assignmentIds).size !== assignmentIds.length
      || publications.length !== assignmentIds.length) {
    return { present: assignmentIds.length > 0 || publications.length > 0, malformed: true, operations: [] };
  }

  let malformed = false;
  const projected: AssignmentKernelNativeOperationEvidenceV2[] = [];
  for (const publicationValue of publications) {
    let publication: JsonRecord;
    try {
      publication = record(parseAssignmentKernelPublicationV2(publicationValue));
    } catch {
      malformed = true;
      continue;
    }
    const assignmentId = String(publication.assignment_id ?? "").trim();
    const snapshot = record(publication.snapshot);
    const binding = record(snapshot.current_binding);
    if (publication.schema !== ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA
        || snapshot.schema !== ASSIGNMENT_SNAPSHOT_V2_SCHEMA
        || !assignmentId
        || !assignmentIds.includes(assignmentId)
        || binding.assignment_id !== assignmentId
        || Number(publication.assignment_version) !== Number(snapshot.assignment_version)) {
      malformed = true;
      continue;
    }
    const observations = record(snapshot.observations);
    for (const operationValue of Object.values(record(snapshot.operations))) {
      const operation = record(operationValue);
      const result = record(operation.result);
      const nativeIdentity = nativeOperationIdentityFromResultSchemaV2(result.result_schema_id);
      if (!nativeIdentity) continue;
      const operationId = String(operation.operation_id ?? "").trim();
      const resultId = String(result.result_id ?? "").trim();
      const capabilityId = String(operation.capability_id ?? "").trim();
      const requestedEffect = String(operation.requested_effect ?? "").trim();
      const resultRequest = record(result.request_identity);
      const observationIds = strings(operation.observation_ids);
      const matchingObservationIds = observationIds.filter((observationId) => {
        const observation = record(observations[observationId]);
        return observation.schema === OBSERVATION_V2_SCHEMA
          && observation.observation_id === observationId
          && observation.operation_id === operationId
          && observation.result_schema_id === result.result_schema_id
          && bindingMatches(binding, record(observation.binding));
      });
      const observationCommitted = result.observation_required !== true || matchingObservationIds.length > 0;
      const valid = operation.schema === OPERATION_V2_SCHEMA
        && result.schema === OPERATION_RESULT_V2_SCHEMA
        && Boolean(operationId) && Boolean(resultId) && Boolean(capabilityId)
        && ["read", "preview", "apply"].includes(requestedEffect)
        && result.operation_id === operationId
        && bindingMatches(binding, record(operation.binding))
        && bindingMatches(binding, record(result.binding))
        && (!resultRequest.method || String(resultRequest.method).toUpperCase() === nativeIdentity.method)
        && (!resultRequest.path || String(resultRequest.path).toLowerCase() === nativeIdentity.path);
      if (!valid) {
        malformed = true;
        continue;
      }

      const resultStatus = String(result.status ?? "");
      const dispatched = operation.dispatch_state === "dispatched" && result.dispatch_state === "dispatched";
      const settled = operation.settlement_state === "settled";
      let outcome: AssignmentKernelNativeOperationOutcomeV2;
      if (result.persistent_effect === "unknown" || operation.persistent_effect === "unknown") {
        outcome = "outcome_unknown";
      } else if (resultStatus === "succeeded") {
        if (dispatched && settled && !observationCommitted) {
          malformed = true;
          continue;
        }
        outcome = dispatched && settled && observationCommitted ? "completed" : "pending";
      } else if (resultStatus === "failed_before_dispatch"
          && result.dispatch_state === "not_dispatched"
          && result.persistent_effect === "none") {
        outcome = "rejected_no_effect";
      } else if (["failed_after_dispatch", "timed_out", "canceled"].includes(resultStatus)) {
        outcome = "failed";
      } else {
        malformed = true;
        continue;
      }
      projected.push({
        assignment_id: assignmentId,
        operation_id: operationId,
        capability_id: capabilityId,
        requested_effect: requestedEffect as "read" | "preview" | "apply",
        method: nativeIdentity.method,
        path: nativeIdentity.path,
        outcome,
        result_status: resultStatus,
        result_id: resultId,
        observation_ids: matchingObservationIds,
        retry_of_operation_id: typeof operation.retry_of_operation_id === "string"
          ? operation.retry_of_operation_id : null,
        dispatched_at: typeof operation.dispatched_at === "string" ? operation.dispatched_at : null,
        completed_at: typeof result.completed_at === "string" ? result.completed_at : null
      });
    }
  }
  return {
    present: assignmentIds.length > 0 || publications.length > 0,
    malformed,
    operations: malformed ? [] : projected.sort((left, right) =>
      String(left.completed_at ?? "").localeCompare(String(right.completed_at ?? ""))
      || left.operation_id.localeCompare(right.operation_id))
  };
}
