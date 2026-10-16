import {sameAssignmentBindingV2,type AssignmentBindingV2,type OperationV2,type OperationResultV2,type OperationPurposeV2,type ObservationCommitInputV2,type SemanticFactV2} from '../domain/assignment-kernel/index.js';
import type {EvidenceStoreInput} from '../evidence/evidence_ref.js';

/** Native read freshness and immutable observation inputs. Callers retain
 * settlement, operation targeting and deterministic postcondition admission. */
export function scheduleCellReadIsFreshNativeV2(applied: OperationV2, read: OperationV2 | undefined, result: OperationResultV2): boolean {
  const commit = applied.result, commitAt = Date.parse(commit?.completed_at ?? ""), readOpened = Date.parse(read?.opened_at ?? ""), readAt = Date.parse(result.completed_at);
  return Boolean(commit?.status === "succeeded" && commit.authority === "native-host" && commit.persistent_effect === "applied"
    && commit.native_transaction_state === "committed" && result.status === "succeeded" && result.authority === "native-host"
    && result.persistent_effect === "none" && read?.requested_effect === "read" && result.request_identity?.path === "/revit/get-parameters"
    && result.request_identity?.request_signature === read.request_identity?.request_signature
    && sameAssignmentBindingV2(commit.binding, result.binding) && Number.isFinite(commitAt) && Number.isFinite(readOpened) && Number.isFinite(readAt)
    && readOpened >= commitAt && readAt >= readOpened);
}
export function parameterReadIsFreshNativeV2(applied: OperationV2, read: OperationV2 | undefined, result: OperationResultV2): boolean {
  const commit = applied.result, commitAt = Date.parse(commit?.completed_at ?? ""), opened = Date.parse(read?.opened_at ?? ""), completed = Date.parse(result.completed_at);
  return Boolean(commit?.status === "succeeded" && commit.authority === "native-host" && commit.native_transaction_state === "committed"
    && result.status === "succeeded" && result.authority === "native-host" && result.persistent_effect === "none" && read?.requested_effect === "read"
    && (["/revit/get-parameters", "/revit/verify-parameter-on-sheet"].includes(result.request_identity?.path ?? "") || read.capability_id === "revit_get_parameters")
    && result.request_identity?.request_signature === read.request_identity?.request_signature
    && sameAssignmentBindingV2(commit.binding,result.binding) && Number.isFinite(commitAt) && Number.isFinite(opened) && Number.isFinite(completed)
    && opened >= commitAt && completed >= opened);
}
export function nativePropertyReadIsFreshNativeV2(applied: OperationV2, read: OperationV2 | undefined, result: OperationResultV2): boolean {
  const commit = applied.result;
  const commitAt = Date.parse(commit?.completed_at ?? "");
  const readOpened = Date.parse(read?.opened_at ?? "");
  const readAt = Date.parse(result.completed_at);
  return Boolean(commit?.status === "succeeded" && commit.authority === "native-host"
    && commit.persistent_effect === "applied" && commit.native_transaction_state === "committed"
    && result.status === "succeeded" && result.authority === "native-host" && result.persistent_effect === "none"
    && result.request_identity?.path === "/revit/native-api-ops"
    && result.request_identity?.request_signature === read?.request_identity?.request_signature
    && sameAssignmentBindingV2(commit.binding, result.binding)
    && Number.isFinite(commitAt) && Number.isFinite(readOpened) && Number.isFinite(readAt)
    && readOpened >= commitAt && readAt >= readOpened);
}
export function circuitReadIsFreshNativeV2(applied: OperationV2, read: OperationV2 | undefined, result: OperationResultV2): boolean {
  const commit = applied.result, committed = Date.parse(commit?.completed_at ?? ""), opened = Date.parse(read?.opened_at ?? ""), completed = Date.parse(result.completed_at);
  return Boolean(commit?.status === "succeeded" && commit.authority === "native-host" && commit.native_transaction_state === "committed"
    && result.status === "succeeded" && result.authority === "native-host" && result.persistent_effect === "none" && read?.requested_effect === "read"
    && result.native_transaction_state === "not_applicable" && result.request_identity?.path === "/revit/get-element-summary"
    && result.request_identity?.request_signature === read.request_identity?.request_signature
    && sameAssignmentBindingV2(commit.binding, result.binding) && Number.isFinite(committed) && Number.isFinite(opened) && Number.isFinite(completed)
    && opened >= committed && completed >= opened);
}

export function scheduleFilterReadIsFreshNativeV2(applied: OperationV2, read: OperationV2 | undefined, result: OperationResultV2): boolean {
  const commit=applied.result, committed=Date.parse(commit?.completed_at??''), opened=Date.parse(read?.opened_at??''), completed=Date.parse(result.completed_at);
  return Boolean(commit?.status==='succeeded'&&commit.authority==='native-host'&&commit.native_transaction_state==='committed'
    && commit.persistent_effect==='applied'&&result.status==='succeeded'&&result.authority==='native-host'&&result.persistent_effect==='none'
    && read?.requested_effect==='read'&&result.native_transaction_state==='not_applicable'&&result.request_identity?.path==='/revit/schedules'
    && result.request_identity.request_signature===read.request_identity?.request_signature&&sameAssignmentBindingV2(commit.binding,result.binding)
    && Number.isFinite(committed)&&Number.isFinite(opened)&&Number.isFinite(completed)&&opened>=committed&&completed>=opened);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function validateFacts(value: unknown): readonly SemanticFactV2[] {
  if (!Array.isArray(value)) throw new Error("assignment_kernel_v2_semantic_facts_missing");
  return value.map((candidate, index) => {
    const fact = object(candidate);
    if (typeof fact.fact_id !== "string" || !fact.fact_id.trim() || !("value" in fact)) {
      throw new Error(`assignment_kernel_v2_semantic_fact_invalid:${index}`);
    }
    return structuredClone(candidate) as SemanticFactV2;
  });
}

type EvidenceLease = {binding: AssignmentBindingV2;capability_id: string;purpose: OperationPurposeV2;operation_id: string};
export function evidenceInput(
  lease: EvidenceLease,
  result: OperationResultV2,
  commit: ObservationCommitInputV2
): EvidenceStoreInput {
  return {
    scope: {
      session_id: lease.binding.session_id,
      assignment_id: lease.binding.assignment_id,
      run_id: lease.binding.run_id,
      generation: lease.binding.generation,
      attempt_id: lease.operation_id
    },
    source: `assignment_kernel_v2:${lease.capability_id}`,
    media_type: "application/json",
    trust_level: result.authority === "native-host" ? "authoritative_native" : "host_observed",
    bounded_summary: `Authoritative result for operation ${lease.operation_id}.`,
    verification_relevance: lease.purpose === "verification" ? "authoritative" : "required",
    raw: commit.raw_payload
  };
}
