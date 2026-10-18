import {createHash} from "node:crypto";
import {retainedCreatedScheduleComparisonV2,isNativeScheduleDuplicateV2} from '../verification/created_schedule_postcondition_v2.js';
import {nativePropertyComparisonV2,NATIVE_PROPERTY_COMPARISON_FACT_V2} from "../verification/native_property_comparison_v2.js";
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type AssignmentBindingV2,type OperationV2,type OperationResultV2,type OperationPurposeV2,type ObservationCommitInputV2,type SemanticFactV2} from '../domain/assignment-kernel/index.js';
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
export function nativePropertyReadIsFreshNativeV2(applied: OperationV2, read: OperationV2 | undefined, result: OperationResultV2,
  route: '/revit/native-api-ops'|'/revit/visibility'|'/revit/schedules'|'/revit/inspect-drawing-spec' = '/revit/native-api-ops'): boolean {
  const commit = applied.result;
  const commitAt = Date.parse(commit?.completed_at ?? "");
  const readOpened = Date.parse(read?.opened_at ?? "");
  const readAt = Date.parse(result.completed_at);
  return Boolean(commit?.status === "succeeded" && commit.authority === "native-host"
    && commit.persistent_effect === "applied" && commit.native_transaction_state === "committed"
    && result.status === "succeeded" && result.authority === "native-host" && result.persistent_effect === "none"
    && result.request_identity?.path === route
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

export const ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA = "revit-operator.assignment-kernel-mcp-result/v2" as const;

export type AssignmentKernelMcpResultV2 = Readonly<{
  schema: typeof ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA;
  operation_result_v2: OperationResultV2;
  observation?: Readonly<{
    raw_payload: unknown;
    semantic_facts: readonly SemanticFactV2[];
    target_scope?: Readonly<Record<string, string | number | boolean | null>>;
    verification_relevance?: readonly string[];
  }>;
}>;

export function explicitMcpEnvelope(rawResult: unknown): AssignmentKernelMcpResultV2 {
  const root = object(rawResult);
  const structured = object(root.structuredContent ?? root.structured_content);
  if (structured.schema !== ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA) throw new Error("assignment_kernel_v2_operation_result_missing");
  if (!structured.operation_result_v2 || typeof structured.operation_result_v2 !== "object") throw new Error("assignment_kernel_v2_operation_result_missing");
  return structured as unknown as AssignmentKernelMcpResultV2;
}

export function observationCommitLimit(): number {
  const parsed = Number.parseInt(process.env.OPERATOR_OBSERVATION_COMMIT_MAX_ATTEMPTS ?? "", 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(10, parsed)) : 3;
}

/** Diagnostic native values only. Settlement retains all proof and authority decisions. */
export function nativePropertyComparisonControlFactV2(
  snapshot: AssignmentSnapshotV2 | null | undefined, operation: OperationV2 | undefined,
  verificationSubject: OperationV2 | undefined, result: OperationResultV2,
  lease: {purpose: OperationPurposeV2; fulfillment_role: string}, rawPayload: unknown,
  deterministicallyTargetBound: boolean, deterministicallySatisfied: boolean
): SemanticFactV2 | null {
  const comparisonFresh=verificationSubject?.request_identity?.path==='/revit/set-parameter'
    ?parameterReadIsFreshNativeV2(verificationSubject,operation,result)
    :verificationSubject?.request_identity?.path==='/revit/visibility'
      ?nativePropertyReadIsFreshNativeV2(verificationSubject,operation,result,'/revit/visibility')
      :['/revit/configure-schedule','/revit/create-schedule','/revit/duplicate-view'].includes(verificationSubject?.request_identity?.path??'')
        &&verificationSubject
        &&nativePropertyReadIsFreshNativeV2(verificationSubject,operation,result,'/revit/schedules');
  if(snapshot&&operation&&verificationSubject&&comparisonFresh&&deterministicallyTargetBound
    && lease.purpose==='verification'&&lease.fulfillment_role==='verification'
    && result.dispatch_state==='dispatched'&&result.native_transaction_state==='not_applicable'
    && result.receipt_id&&result.native_correlation_id&&result.raw_payload_hash===createHash("sha256").update(canonicalJsonV2(rawPayload), "utf8").digest("hex")
    && sameAssignmentBindingV2(snapshot.current_binding,operation.binding)&&sameAssignmentBindingV2(operation.binding,result.binding)
    && !snapshot.unresolved_unknown_operation_ids.length
    && !snapshot.in_flight_operation_ids.some(id=>id!==operation.operation_id)
    && !Object.values(snapshot.operations).some(other=>other.operation_id!==verificationSubject.operation_id
      &&other.requested_effect==='apply'&&other.persistent_effect!=='none'
      &&sameAssignmentBindingV2(other.binding,snapshot.current_binding)
      &&(!Number.isFinite(Date.parse(other.result?.completed_at??''))||Date.parse(other.result!.completed_at)>Date.parse(operation.opened_at)
        ||Date.parse(other.result!.completed_at)===Date.parse(operation.opened_at)
          &&!(Number.isSafeInteger(other.settled_assignment_version)&&Number.isSafeInteger(operation.admitted_assignment_version)
            &&other.settled_assignment_version!<operation.admitted_assignment_version!)))
    && !snapshot.input_invalidated_operation_ids?.some(id=>id===verificationSubject.operation_id||id===operation.operation_id)){
    const creation=verificationSubject.request_identity?.path==='/revit/create-schedule'||isNativeScheduleDuplicateV2(snapshot,verificationSubject);
    const comparison=creation?retainedCreatedScheduleComparisonV2(snapshot,verificationSubject,operation,rawPayload)
      :nativePropertyComparisonV2(verificationSubject.input,operation.input,rawPayload);
    if(comparison.state!=='unsupported')return {fact_id:NATIVE_PROPERTY_COMPARISON_FACT_V2,fact_class:'control',
      value:JSON.stringify({...comparison,...(comparison.state==='matched'&&!deterministicallySatisfied?{state:'incomplete'}:{}),scope:creation?'native_schedule_definition_only':'native_scalar_properties_only'})};
  }
  return null;
}
