import { createHash } from "node:crypto";
import {
  OPERATION_RESULT_V2_SCHEMA,
  OPERATION_V2_SCHEMA,
  OBSERVATION_COMMIT_INPUT_V2_SCHEMA,
  canonicalJsonV2,
  deriveProgressGapsV2,
  evidenceClassForFulfillmentRoleV2,
  fulfillmentRoleCanCarryTaskCriteriaV2,
  normalizeSemanticFactsForEvidenceV2,
  operationFulfillmentRoleForAdmissionV2,
  sameAssignmentBindingV2,
  type AssignmentBindingV2,
  type AssignmentSnapshotV2,
  type ObservationV2,
  type OperationPurposeV2,
  type OperationFulfillmentRoleV2,
  type OperationRequestIdentityV2,
  type OperationRoleV2,
  type OperationResultV2,
  type OperationV2,
  type ObservationCommitInputV2,
  type PersistentEffectV2,
  type RequestedEffectV2,
  type SemanticFactV2
} from "../domain/assignment-kernel/index.js";
import { assertEvidenceStoreInputSafe, storeEvidence } from "../evidence/evidence_store.js";
import type { EvidenceStoreInput, EvidenceStoreResult } from "../evidence/evidence_ref.js";
import type { EvidenceProjectionV1, EvidenceRefV1 } from "../evidence/evidence_ref.js";
import { getEvidenceContextBudget } from "../evidence/model_context_budget.js";
import {
  ObservationDecoderRegistryV2,
  observationFromOperationResultV2,
  unwrapOperationResultV2
} from "../execution_truth/assignment_kernel_v2_result_adapter.js";
import {
  appendCurrentAssignmentKernelEventV2,
  getAssignmentKernelSnapshotV2
} from "./assignment_kernel_v2_store.js";
import { deriveAndSettleAssignmentKernelV2 } from "./assignment_kernel_v2_lifecycle.js";

export const ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA = "revit-operator.assignment-kernel-mcp-result/v2" as const;
export const ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA = "revit-operator.assignment-kernel-operation-context/v2" as const;

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

export type AssignmentKernelOperationLeaseV2 = Readonly<{
  schema: typeof ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA;
  assignment_id: string;
  binding: AssignmentBindingV2;
  operation_id: string;
  capability_id: string;
  requested_effect: RequestedEffectV2;
  purpose: OperationPurposeV2;
  operation_role: OperationRoleV2;
  parent_operation_id?: string;
  root_operation_id: string;
  blocks_parent_settlement: boolean;
  fulfillment_role: OperationFulfillmentRoleV2;
  delegation_authority_id?: string;
  eligible_criterion_ids: readonly string[];
  request_identity: OperationRequestIdentityV2;
  opened_at: string;
  deadline_at: string;
}>;

export type AssignmentKernelOperationSettlementV2 = Readonly<{
  snapshot: AssignmentSnapshotV2;
  result: OperationResultV2;
  observation: ObservationV2 | null;
  evidence_refs: readonly EvidenceRefV1[];
  evidence_projections: readonly EvidenceProjectionV1[];
}>;

export type AssignmentKernelRecoveryRuntimeV2 = Readonly<{
  callTool(tool: string, args: Record<string, unknown>, binding: Readonly<{
    sessionId: string;
    assignmentKernelV2: AssignmentKernelOperationLeaseV2;
  }>): Promise<unknown>;
}>;

export type AssignmentKernelObservationCommitRuntimeV2 = Readonly<{
  storeEvidence(input: EvidenceStoreInput, projectionMaxBytes?: number): EvidenceStoreResult;
}>;

const DEFAULT_OBSERVATION_COMMIT_RUNTIME: AssignmentKernelObservationCommitRuntimeV2 = { storeEvidence };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonV2(value), "utf8").digest("hex");
}

function boundedDeadline(openedAt: string): string {
  const parsed = Number.parseInt(process.env.OPERATOR_MCP_TOOL_TIMEOUT_MS ?? "", 10);
  const timeout = Number.isFinite(parsed) ? Math.max(1_000, Math.min(30 * 60_000, parsed)) : 240_000;
  return new Date(Date.parse(openedAt) + timeout).toISOString();
}

function operationEffect(effect: string): RequestedEffectV2 {
  if (effect === "preview" || effect === "apply") return effect;
  return "read";
}

function operationPurpose(effect: string, snapshot: AssignmentSnapshotV2): OperationPurposeV2 {
  if (snapshot.unresolved_unknown_operation_ids.length > 0 && ["read", "discovery", "navigation"].includes(effect)) {
    return "reconciliation";
  }
  if (effect === "evidence_read") return "evidence_read";
  if (effect === "discovery" || effect === "navigation") return "discovery";
  if (effect === "read" && snapshot.spec.requested_effect === "apply"
      && Object.values(snapshot.operations).some(operation => operation.requested_effect === "apply" && operation.persistent_effect === "applied")) {
    return "verification";
  }
  if (effect === "read" && snapshot.spec.requested_effect === "apply") return "discovery";
  return "work";
}

function admittedWorkUnit(snapshot: AssignmentSnapshotV2, suggestedEffect: RequestedEffectV2, purpose: OperationPurposeV2): AssignmentSnapshotV2["spec"]["work_units"][number] {
  const preferred = purpose === "evidence_read" ? "work-evidence"
    : purpose === "verification" ? "work-verification"
      : purpose === "discovery" && snapshot.spec.requested_effect !== "read" ? "work-discovery"
        : suggestedEffect === "preview" && snapshot.spec.requested_effect === "apply" ? "work-preview"
          : "work-primary";
  const unit = snapshot.spec.work_units.find(candidate => candidate.work_unit_id === preferred && candidate.requested_effect === suggestedEffect)
    ?? snapshot.spec.work_units.find(candidate => candidate.requested_effect === suggestedEffect);
  if (!unit) throw new Error("assignment_kernel_v2_work_unit_not_admitted");
  return unit;
}

function canonicalInput(value: unknown): Record<string, unknown> {
  const source = object(value);
  const forbidden = new Set([
    "assignmentId", "assignment_id", "runId", "run_id", "generation", "sessionId", "session_id",
    "principalId", "principal_id", "operationId", "operation_id"
  ]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !forbidden.has(key)));
}

function canonicalMethod(value: unknown): "GET" | "POST" | undefined {
  const method = String(value ?? "").trim().toUpperCase();
  return method === "GET" || method === "POST" ? method : undefined;
}

function requestIdentity(input: Readonly<{
  capability_id: string;
  arguments: unknown;
  method?: unknown;
  path?: unknown;
}>): OperationRequestIdentityV2 {
  const args = canonicalInput(input.arguments);
  const method = canonicalMethod(input.method ?? args.method);
  const path = String(input.path ?? args.path ?? "").trim() || undefined;
  const signatureInput = input.capability_id === "revit_call_tool"
    ? { capability_id: input.capability_id, method, path, body: args.body ?? null }
    : { capability_id: input.capability_id, input: args };
  return {
    capability_id: input.capability_id,
    ...(method ? { method } : {}),
    ...(path ? { path } : {}),
    request_signature: stableHash(signatureInput)
  };
}

function canonicalTargetId(targetTokens: readonly string[]): string | undefined {
  const exactIds = [...new Set(targetTokens.filter(token => /^id:[^\s]{1,240}$/.test(token)))];
  if (exactIds.length === 1) return exactIds[0];
  return targetTokens.length === 1 ? targetTokens[0] : undefined;
}

function verificationSubject(snapshot: AssignmentSnapshotV2, targetTokens: readonly string[]): OperationV2 | null {
  const tokens = new Set(targetTokens);
  return Object.values(snapshot.operations)
    .filter(operation => operation.requested_effect === "apply"
      && operation.persistent_effect === "applied"
      && operation.settlement_state === "settled"
      && Boolean(operation.target.target_id)
      && tokens.has(operation.target.target_id!))
    .sort((left, right) => `${right.settled_at ?? right.opened_at}:${right.operation_id}`
      .localeCompare(`${left.settled_at ?? left.opened_at}:${left.operation_id}`))[0] ?? null;
}

export function openAssignmentKernelOperationV2(input: Readonly<{
  snapshot: AssignmentSnapshotV2;
  controller_request_id: string | number;
  provider_turn_id: string;
  capability_id: string;
  classified_effect: string;
  target_tokens?: readonly string[];
  arguments: unknown;
  opened_at?: string;
}>): AssignmentKernelOperationLeaseV2 {
  const suggestedEffect = operationEffect(input.classified_effect);
  const purpose = operationPurpose(input.classified_effect, input.snapshot);
  if (input.snapshot.unresolved_unknown_operation_ids.length > 0 && purpose !== "reconciliation") {
    throw new Error("assignment_kernel_v2_unknown_effect_requires_reconciliation");
  }
  const unit = admittedWorkUnit(input.snapshot, suggestedEffect, purpose);
  const effect = unit.requested_effect;
  const openedAt = input.opened_at ?? new Date().toISOString();
  const operationId = `opv2_${stableHash({
    assignment_id: input.snapshot.spec.binding.assignment_id,
    generation: input.snapshot.current_binding.generation,
    provider_turn_id: input.provider_turn_id,
    controller_request_id: String(input.controller_request_id),
    capability_id: input.capability_id
  })}`;
  const targetTokens = [...new Set((input.target_tokens ?? []).map(String).filter(Boolean))].sort();
  const targetId = canonicalTargetId(targetTokens);
  const verifies = purpose === "verification" ? verificationSubject(input.snapshot, targetTokens) : null;
  if (purpose === "verification" && !verifies) {
    throw new Error("assignment_kernel_v2_verification_target_unbound");
  }
  const fulfillmentRole = operationFulfillmentRoleForAdmissionV2({
    purpose,
    capability_id: input.capability_id
  });
  const advancesCriterionIds = fulfillmentRoleCanCarryTaskCriteriaV2(fulfillmentRole)
    ? [...new Set(unit.criterion_ids)].sort()
    : [];
  const eligibleCriterionIds = fulfillmentRoleCanCarryTaskCriteriaV2(fulfillmentRole)
    ? advancesCriterionIds
    : [];
  const delegationAuthorityId = fulfillmentRoleCanCarryTaskCriteriaV2(fulfillmentRole)
    ? `delegation:${operationId}`
    : undefined;
  const currentGaps = deriveProgressGapsV2(input.snapshot);
  const resolvesGapIds = currentGaps
    .filter((gap) => gap.work_unit_ids.includes(unit.work_unit_id)
      || gap.criterion_ids.some((criterionId) => advancesCriterionIds.includes(criterionId))
      || (purpose === "reconciliation" && gap.kind === "effect_unknown"))
    .map((gap) => gap.gap_id)
    .sort();
  const currentIdentity = requestIdentity({ capability_id: input.capability_id, arguments: input.arguments });
  const correctedPredecessor = Object.values(input.snapshot.operations)
    .filter(candidate => candidate.capability_id === input.capability_id
      && candidate.settlement_state === "settled"
      && candidate.persistent_effect === "none"
      && Boolean(candidate.result?.input_schema_gap)
      && candidate.request_identity?.method === currentIdentity.method
      && candidate.request_identity?.path === currentIdentity.path
      && candidate.request_identity?.request_signature !== currentIdentity.request_signature
      && !Object.values(input.snapshot.operations).some(retry => retry.retry_of_operation_id === candidate.operation_id))
    .sort((left, right) => `${right.settled_at ?? right.opened_at}:${right.operation_id}`
      .localeCompare(`${left.settled_at ?? left.opened_at}:${left.operation_id}`))[0];
  const operation: OperationV2 = {
    schema: OPERATION_V2_SCHEMA,
    operation_id: operationId,
    binding: structuredClone(input.snapshot.current_binding),
    work_unit_id: unit.work_unit_id,
    capability_id: input.capability_id,
    requested_effect: effect,
    purpose,
    operation_role: "root",
    fulfillment_role: fulfillmentRole,
    ...(delegationAuthorityId ? { delegation_authority_id: delegationAuthorityId } : {}),
    blocks_parent_settlement: false,
    request_identity: currentIdentity,
    advances_criterion_ids: advancesCriterionIds,
    eligible_criterion_ids: eligibleCriterionIds,
    resolves_gap_ids: resolvesGapIds,
    target: {
      ...(targetId ? { target_id: targetId } : {}),
      ...(input.snapshot.current_binding.document_fingerprint ? { document_fingerprint: input.snapshot.current_binding.document_fingerprint } : {}),
      ...(targetTokens.length > 1 ? { semantic_scope: Object.fromEntries(targetTokens.map((token, index) => [`target_${index}`, token])) } : {})
    },
    input: canonicalInput(input.arguments),
    admission_state: "admitted",
    dispatch_state: "not_dispatched",
    persistent_effect: "none",
    settlement_state: "open",
    observation_ids: [], verification_operation_ids: [],
    ...(correctedPredecessor ? {
      retry_of_operation_id: correctedPredecessor.operation_id,
      retry_basis: "corrected_input" as const
    } : {}),
    ...(verifies ? { verification_of_operation_id: verifies.operation_id } : {}),
    ...(purpose === "reconciliation" ? {
      reconciliation_of_operation_id: input.snapshot.unresolved_unknown_operation_ids[0]
    } : {}),
    opened_at: openedAt,
    deadline_at: boundedDeadline(openedAt)
  };
  appendCurrentAssignmentKernelEventV2({
    goal_id: input.snapshot.spec.binding.assignment_id,
    binding: input.snapshot.current_binding,
    event_id: `operation-admitted:${operationId}`,
    actor: "codex-app-server",
    occurred_at: openedAt,
    body: { event_type: "operation_admitted", operation }
  });
  return {
    schema: ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA,
    assignment_id: input.snapshot.spec.binding.assignment_id,
    binding: structuredClone(input.snapshot.current_binding),
    operation_id: operationId,
    capability_id: input.capability_id,
    requested_effect: effect,
    purpose,
    operation_role: "root",
    fulfillment_role: fulfillmentRole,
    ...(delegationAuthorityId ? { delegation_authority_id: delegationAuthorityId } : {}),
    eligible_criterion_ids: eligibleCriterionIds,
    root_operation_id: operationId,
    blocks_parent_settlement: false,
    request_identity: structuredClone(operation.request_identity!),
    opened_at: openedAt,
    deadline_at: operation.deadline_at
  };
}

export function openAssignmentKernelChildOperationV2(input: Readonly<{
  binding: AssignmentBindingV2;
  parent_operation_id: string;
  child_ordinal: number;
  operation_role: Exclude<OperationRoleV2, "root">;
  capability_id: string;
  classified_effect: string;
  method?: "GET" | "POST";
  path?: string;
  arguments: unknown;
  blocks_parent_settlement?: boolean;
  fulfillment_role?: OperationFulfillmentRoleV2;
  delegation_authority_id?: string;
  eligible_criterion_ids?: readonly string[];
  opened_at?: string;
}>): AssignmentKernelOperationLeaseV2 {
  const snapshot = getAssignmentKernelSnapshotV2(input.binding.assignment_id);
  if (!snapshot || !sameAssignmentBindingV2(snapshot.current_binding, input.binding)) {
    throw new Error("assignment_kernel_v2_binding_stale_or_mismatched");
  }
  const parent = snapshot.operations[input.parent_operation_id];
  if (!parent || !["open", "awaiting_result", "retaining_observation"].includes(parent.settlement_state)) {
    throw new Error("assignment_kernel_v2_parent_operation_invalid");
  }
  if (!Number.isSafeInteger(input.child_ordinal) || input.child_ordinal < 0) {
    throw new Error("assignment_kernel_v2_child_ordinal_invalid");
  }
  const suggestedEffect = operationEffect(input.classified_effect);
  const purpose = input.operation_role === "prerequisite" ? "discovery" : operationPurpose(input.classified_effect, snapshot);
  const unit = admittedWorkUnit(snapshot, suggestedEffect, purpose);
  const identity = requestIdentity({
    capability_id: input.capability_id,
    arguments: input.arguments,
    method: input.method,
    path: input.path
  });
  const operationId = `opv2_${stableHash({
    assignment_id: input.binding.assignment_id,
    generation: input.binding.generation,
    parent_operation_id: parent.operation_id,
    child_ordinal: input.child_ordinal,
    operation_role: input.operation_role,
    request_identity: identity
  })}`;
  const existing = snapshot.operations[operationId];
  if (existing) {
    if (existing.parent_operation_id !== parent.operation_id
        || existing.request_identity?.request_signature !== identity.request_signature
        || existing.fulfillment_role !== (input.operation_role === "prerequisite" ? "prerequisite" : input.fulfillment_role ?? "supporting_control")
        || canonicalJsonV2(existing.eligible_criterion_ids ?? []) !== canonicalJsonV2([...new Set(input.eligible_criterion_ids ?? [])].sort())
        || existing.delegation_authority_id !== input.delegation_authority_id) {
      throw new Error("assignment_kernel_v2_child_operation_identity_conflict");
    }
    return leaseFromOperation(existing);
  }
  const openedAt = input.opened_at ?? new Date().toISOString();
  // Topology never grants semantic fulfillment. Ordinary children default to
  // supporting control with no criterion eligibility; only the trusted edge
  // may explicitly delegate a parent-approved criterion subset.
  const fulfillmentRole = input.operation_role === "prerequisite"
    ? "prerequisite"
    : input.fulfillment_role ?? "supporting_control";
  const requestedEligible = [...new Set(input.eligible_criterion_ids ?? [])].sort();
  if (!fulfillmentRoleCanCarryTaskCriteriaV2(fulfillmentRole) && requestedEligible.length > 0) {
    throw new Error("assignment_kernel_v2_support_operation_criterion_forbidden");
  }
  const parentEligible = new Set(parent.eligible_criterion_ids ?? []);
  if (requestedEligible.some((criterionId) => !parentEligible.has(criterionId))) {
    throw new Error("assignment_kernel_v2_delegated_criterion_widening");
  }
  if (fulfillmentRoleCanCarryTaskCriteriaV2(fulfillmentRole)
      && (!parent.delegation_authority_id || input.delegation_authority_id !== parent.delegation_authority_id)) {
    throw new Error("assignment_kernel_v2_delegation_authority_invalid");
  }
  const eligibleCriterionIds = fulfillmentRoleCanCarryTaskCriteriaV2(fulfillmentRole)
    ? requestedEligible
    : [];
  const advancesCriterionIds = [...eligibleCriterionIds];
  const resolvesGapIds = eligibleCriterionIds.length > 0
    ? [...new Set(parent.resolves_gap_ids)].sort()
    : [];
  const operation: OperationV2 = {
    schema: OPERATION_V2_SCHEMA,
    operation_id: operationId,
    binding: structuredClone(snapshot.current_binding),
    work_unit_id: unit.work_unit_id,
    capability_id: input.capability_id,
    requested_effect: unit.requested_effect,
    purpose,
    operation_role: input.operation_role,
    fulfillment_role: fulfillmentRole,
    ...(input.delegation_authority_id ? { delegation_authority_id: input.delegation_authority_id } : {}),
    parent_operation_id: parent.operation_id,
    root_operation_id: parent.root_operation_id ?? parent.operation_id,
    blocks_parent_settlement: input.blocks_parent_settlement !== false,
    request_identity: identity,
    advances_criterion_ids: advancesCriterionIds,
    eligible_criterion_ids: eligibleCriterionIds,
    resolves_gap_ids: resolvesGapIds,
    target: structuredClone(parent.target),
    input: canonicalInput(input.arguments),
    admission_state: "admitted",
    dispatch_state: "not_dispatched",
    persistent_effect: "none",
    settlement_state: "open",
    observation_ids: [],
    verification_operation_ids: [],
    opened_at: openedAt,
    deadline_at: boundedDeadline(openedAt)
  };
  appendCurrentAssignmentKernelEventV2({
    goal_id: snapshot.spec.binding.assignment_id,
    binding: snapshot.current_binding,
    event_id: `operation-admitted:${operationId}`,
    actor: "assignment-kernel-v2-child-edge",
    occurred_at: openedAt,
    body: { event_type: "operation_admitted", operation }
  });
  return leaseFromOperation(operation);
}

export function markAssignmentKernelOperationDispatchStartedV2(lease: AssignmentKernelOperationLeaseV2): void {
  appendCurrentAssignmentKernelEventV2({
    goal_id: lease.assignment_id, binding: lease.binding,
    event_id: `operation-dispatch-started:${lease.operation_id}`,
    actor: "mcp-client", body: { event_type: "operation_dispatch_started", operation_id: lease.operation_id }
  });
}

function explicitMcpEnvelope(rawResult: unknown): AssignmentKernelMcpResultV2 {
  const root = object(rawResult);
  const structured = object(root.structuredContent ?? root.structured_content);
  if (structured.schema !== ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA) throw new Error("assignment_kernel_v2_operation_result_missing");
  if (!structured.operation_result_v2 || typeof structured.operation_result_v2 !== "object") throw new Error("assignment_kernel_v2_operation_result_missing");
  return structured as unknown as AssignmentKernelMcpResultV2;
}

function validateFacts(value: unknown): readonly SemanticFactV2[] {
  if (!Array.isArray(value)) throw new Error("assignment_kernel_v2_semantic_facts_missing");
  return value.map((candidate, index) => {
    const fact = object(candidate);
    if (typeof fact.fact_id !== "string" || !fact.fact_id.trim() || !("value" in fact)) {
      throw new Error(`assignment_kernel_v2_semantic_fact_invalid:${index}`);
    }
    return structuredClone(candidate) as SemanticFactV2;
  });
}

function observationCommitLimit(): number {
  const parsed = Number.parseInt(process.env.OPERATOR_OBSERVATION_COMMIT_MAX_ATTEMPTS ?? "", 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(10, parsed)) : 3;
}

function evidenceInput(
  lease: AssignmentKernelOperationLeaseV2,
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

function commitInput(envelope: AssignmentKernelMcpResultV2, result: OperationResultV2): ObservationCommitInputV2 | undefined {
  if (!result.observation_required) return undefined;
  if (!envelope.observation) throw new Error("assignment_kernel_v2_observation_payload_missing");
  return {
    schema: OBSERVATION_COMMIT_INPUT_V2_SCHEMA,
    result_id: result.result_id,
    raw_payload: structuredClone(envelope.observation.raw_payload),
    semantic_facts: validateFacts(envelope.observation.semantic_facts),
    ...(envelope.observation.target_scope ? { target_scope: structuredClone(envelope.observation.target_scope) } : {}),
    ...(envelope.observation.verification_relevance ? { verification_relevance: [...envelope.observation.verification_relevance] } : {})
  };
}

function recordNativeDispatchIfNeeded(lease: AssignmentKernelOperationLeaseV2, result: OperationResultV2): void {
  if (result.dispatch_state !== "dispatched") return;
  const native = result.authority === "native-host" || result.authority === "dynamic-runtime";
  appendCurrentAssignmentKernelEventV2({
    goal_id: lease.assignment_id, binding: lease.binding,
    event_id: `${native ? "native" : "operation"}-dispatch:${lease.operation_id}`,
    actor: result.authority,
    body: native
      ? { event_type: "native_dispatch_recorded", operation_id: lease.operation_id, ...(result.native_correlation_id ? { native_correlation_id: result.native_correlation_id } : {}) }
      : { event_type: "operation_dispatch_recorded", operation_id: lease.operation_id, authority: "mcp", ...(result.native_correlation_id ? { correlation_id: result.native_correlation_id } : {}) }
  });
}

export function settleAssignmentKernelOperationV2(
  lease: AssignmentKernelOperationLeaseV2,
  rawResult: unknown,
  observationCommitRuntime: AssignmentKernelObservationCommitRuntimeV2 = DEFAULT_OBSERVATION_COMMIT_RUNTIME
): AssignmentKernelOperationSettlementV2 {
  const envelope = explicitMcpEnvelope(rawResult);
  const result = unwrapOperationResultV2({ transport: "typed_mcp", structured_content: { operation_result_v2: envelope.operation_result_v2 } });
  if (result.operation_id !== lease.operation_id || !sameAssignmentBindingV2(result.binding, lease.binding)) {
    throw new Error("assignment_kernel_v2_result_binding_mismatch");
  }
  const commit = commitInput(envelope, result);
  if (commit) assertEvidenceStoreInputSafe(evidenceInput(lease, result, commit));
  recordNativeDispatchIfNeeded(lease, result);
  appendCurrentAssignmentKernelEventV2({
    goal_id: lease.assignment_id, binding: lease.binding,
    event_id: `operation-result:${result.result_id}`,
    actor: result.authority,
    occurred_at: result.completed_at,
    body: { event_type: "operation_result_recorded", result, ...(commit ? { observation_commit: commit } : {}) }
  });
  if (!result.observation_required) {
    return {
      snapshot: getAssignmentKernelSnapshotV2(lease.assignment_id)!, result,
      observation: null, evidence_refs: [], evidence_projections: []
    };
  }
  return commitAssignmentKernelObservationV2(lease, observationCommitRuntime);
}

/**
 * Completes only the durable Observation stage for an already recorded native
 * result. It cannot dispatch native work or create another OperationV2.
 */
export function commitAssignmentKernelObservationV2(
  lease: AssignmentKernelOperationLeaseV2,
  runtime: AssignmentKernelObservationCommitRuntimeV2 = DEFAULT_OBSERVATION_COMMIT_RUNTIME
): AssignmentKernelOperationSettlementV2 {
  const snapshot = getAssignmentKernelSnapshotV2(lease.assignment_id);
  const operation = snapshot?.operations[lease.operation_id];
  if (!snapshot || !operation || !operation.result || !sameAssignmentBindingV2(snapshot.current_binding, lease.binding)) {
    throw new Error("assignment_kernel_v2_observation_commit_operation_missing");
  }
  if (operation.settlement_state === "settled") {
    const observation = operation.observation_ids.length > 0
      ? snapshot.observations[operation.observation_ids[operation.observation_ids.length - 1]!]
      : undefined;
    return { snapshot, result: operation.result, observation: observation ?? null, evidence_refs: [], evidence_projections: [] };
  }
  if (operation.settlement_state !== "retaining_observation" || !operation.observation_commit) {
    throw new Error("assignment_kernel_v2_observation_commit_not_pending");
  }
  const result = operation.result;
  const commit = operation.observation_commit;
  const attempt = (operation.observation_commit_attempts ?? 0) + 1;
  try {
    const stored = runtime.storeEvidence(evidenceInput(lease, result, commit), getEvidenceContextBudget().item_bytes);
    const fulfillmentRole = operation.fulfillment_role
      ?? operationFulfillmentRoleForAdmissionV2({
        purpose: operation.purpose,
        capability_id: operation.capability_id,
        prerequisite: operation.operation_role === "prerequisite"
      });
    const evidenceClass = evidenceClassForFulfillmentRoleV2(fulfillmentRole);
    const semanticFacts = normalizeSemanticFactsForEvidenceV2(evidenceClass, commit.semantic_facts);
    const registry = new ObservationDecoderRegistryV2();
    registry.register(result.result_schema_id, () => semanticFacts);
    const observation = observationFromOperationResultV2({
      result,
      expected_binding: lease.binding,
      observation_id: `obsv2_${stableHash({ operation_id: lease.operation_id, evidence_id: stored.ref.evidence_id })}`,
      raw_payload_ref: `evidence:${stored.ref.evidence_id}`,
      raw_payload: commit.raw_payload,
      target_scope: commit.target_scope,
      verification_relevance: commit.verification_relevance,
      fulfillment_role: fulfillmentRole,
      evidence_class: evidenceClass,
      capability_id: operation.capability_id,
      eligible_criterion_ids: operation.eligible_criterion_ids ?? [],
      registry
    });
    appendCurrentAssignmentKernelEventV2({
      goal_id: lease.assignment_id, binding: lease.binding,
      event_id: `observation-retained:${observation.observation_id}`,
      actor: "operator-evidence-store",
      occurred_at: observation.observed_at,
      body: { event_type: "observation_retained", observation }
    });
    return {
      snapshot: getAssignmentKernelSnapshotV2(lease.assignment_id)!, result, observation,
      evidence_refs: [stored.ref], evidence_projections: [stored.projection]
    };
  } catch (error) {
    const errorCode = (error instanceof Error ? error.message : String(error)).slice(0, 240) || "observation_commit_failed";
    const terminal = attempt >= observationCommitLimit();
    appendCurrentAssignmentKernelEventV2({
      goal_id: lease.assignment_id, binding: lease.binding,
      event_id: `${terminal ? "observation-commit-failed" : "observation-commit-retry"}:${result.result_id}:${attempt}`,
      actor: "operator-evidence-store",
      body: terminal
        ? { event_type: "observation_commit_failed", operation_id: lease.operation_id, result_id: result.result_id, attempt, error_code: errorCode }
        : { event_type: "observation_commit_retry_recorded", operation_id: lease.operation_id, result_id: result.result_id, attempt, error_code: errorCode }
    });
    if (terminal) deriveAndSettleAssignmentKernelV2(lease.binding, "observation_commit_failed");
    throw error;
  }
}

export function failAssignmentKernelOperationV2(
  lease: AssignmentKernelOperationLeaseV2,
  error: unknown,
  dispatch: "not_dispatched" | "dispatching" | "dispatched"
): AssignmentSnapshotV2 {
  const current = getAssignmentKernelSnapshotV2(lease.assignment_id)?.operations[lease.operation_id];
  if (!current || current.settlement_state === "settled" || current.result) return getAssignmentKernelSnapshotV2(lease.assignment_id)!;
  const effectiveDispatch = current.dispatch_state === "dispatched" ? "dispatched" : dispatch;
  const effect: PersistentEffectV2 = lease.requested_effect === "apply" && effectiveDispatch !== "not_dispatched" ? "unknown" : "none";
  if (effectiveDispatch === "dispatched" && current.dispatch_state !== "dispatched") {
    appendCurrentAssignmentKernelEventV2({
      goal_id: lease.assignment_id, binding: lease.binding,
      event_id: `native-dispatch:${lease.operation_id}`,
      actor: "mcp-client",
      body: { event_type: "native_dispatch_recorded", operation_id: lease.operation_id }
    });
  }
  const completedAt = new Date().toISOString();
  const result: OperationResultV2 = {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: `result-failure:${lease.operation_id}`,
    operation_id: lease.operation_id,
    binding: structuredClone(lease.binding),
    status: effectiveDispatch === "not_dispatched" ? "failed_before_dispatch" : "failed_after_dispatch",
    dispatch_state: effectiveDispatch,
    persistent_effect: effect,
    native_transaction_state: effect === "unknown" ? "unknown" : "not_applicable",
    authority: "operator-mcp-transport",
    result_schema_id: "operation-transport-failure/v2",
    observation_required: false,
    completed_at: completedAt,
    error_code: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
    request_identity: structuredClone(lease.request_identity)
  };
  recordNativeDispatchIfNeeded(lease, result);
  appendCurrentAssignmentKernelEventV2({
    goal_id: lease.assignment_id, binding: lease.binding,
    event_id: `operation-result:${result.result_id}`,
    actor: result.authority,
    occurred_at: completedAt,
    body: { event_type: "operation_result_recorded", result }
  });
  return getAssignmentKernelSnapshotV2(lease.assignment_id)!;
}

export function leaseFromOperation(operation: OperationV2): AssignmentKernelOperationLeaseV2 {
  if (!operation.request_identity) throw new Error("assignment_kernel_v2_operation_request_identity_missing");
  return {
    schema: ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA,
    assignment_id: operation.binding.assignment_id,
    binding: structuredClone(operation.binding),
    operation_id: operation.operation_id,
    capability_id: operation.capability_id,
    requested_effect: operation.requested_effect,
    purpose: operation.purpose,
    operation_role: operation.operation_role ?? "root",
    fulfillment_role: operation.fulfillment_role ?? operationFulfillmentRoleForAdmissionV2({
      purpose: operation.purpose,
      capability_id: operation.capability_id,
      prerequisite: operation.operation_role === "prerequisite"
    }),
    ...(operation.delegation_authority_id ? { delegation_authority_id: operation.delegation_authority_id } : {}),
    eligible_criterion_ids: [...(operation.eligible_criterion_ids ?? [])],
    ...(operation.parent_operation_id ? { parent_operation_id: operation.parent_operation_id } : {}),
    root_operation_id: operation.root_operation_id ?? operation.operation_id,
    blocks_parent_settlement: operation.blocks_parent_settlement !== false,
    request_identity: structuredClone(operation.request_identity),
    opened_at: operation.opened_at,
    deadline_at: operation.deadline_at
  };
}

/**
 * Resumes only the same durable courier operation identity. It never opens a
 * replacement operation and never replays a direct native mutation. The
 * existing courier idempotency record is the execution authority after restart.
 */
export async function recoverAssignmentKernelOperationsV2(input: Readonly<{
  snapshot: AssignmentSnapshotV2;
  runtime: AssignmentKernelRecoveryRuntimeV2;
  observation_commit_runtime?: AssignmentKernelObservationCommitRuntimeV2;
  now?: Date;
  transport?: string;
}>): Promise<AssignmentSnapshotV2> {
  let snapshot = input.snapshot;
  const now = input.now ?? new Date();
  const transport = (input.transport ?? process.env.OPERATOR_REVIT_TRANSPORT ?? "direct").trim().toLowerCase();
  for (const operationId of snapshot.in_flight_operation_ids) {
    const operation = snapshot.operations[operationId];
    if (!operation || operation.settlement_state === "settled") continue;
    const lease = leaseFromOperation(operation);
    if (operation.settlement_state === "retaining_observation" && operation.result) {
      if (!operation.observation_commit) {
        appendCurrentAssignmentKernelEventV2({
          goal_id: lease.assignment_id,
          binding: lease.binding,
          event_id: `observation-commit-failed:${operation.result.result_id}:missing-input`,
          actor: "assignment-kernel-v2-recovery",
          body: {
            event_type: "observation_commit_failed",
            operation_id: lease.operation_id,
            result_id: operation.result.result_id,
            attempt: (operation.observation_commit_attempts ?? 0) + 1,
            error_code: "observation_commit_payload_missing"
          }
        });
        snapshot = deriveAndSettleAssignmentKernelV2(lease.binding, "observation_commit_failed");
        continue;
      }
      try {
        snapshot = commitAssignmentKernelObservationV2(
          lease,
          input.observation_commit_runtime ?? DEFAULT_OBSERVATION_COMMIT_RUNTIME
        ).snapshot;
      } catch {
        snapshot = getAssignmentKernelSnapshotV2(lease.assignment_id)!;
      }
      continue;
    }
    if (Date.parse(operation.deadline_at) <= now.getTime()) {
      snapshot = failAssignmentKernelOperationV2(
        lease,
        new Error("assignment_kernel_v2_operation_deadline_elapsed"),
        operation.dispatch_state
      );
      continue;
    }
    if (transport !== "courier") {
      snapshot = failAssignmentKernelOperationV2(
        lease,
        new Error("assignment_kernel_v2_direct_operation_not_replayable_after_restart"),
        operation.dispatch_state
      );
      continue;
    }
    try {
      const rawResult = await input.runtime.callTool(operation.capability_id, structuredClone(operation.input), {
        sessionId: operation.binding.session_id,
        assignmentKernelV2: lease
      });
      snapshot = settleAssignmentKernelOperationV2(lease, rawResult).snapshot;
    } catch (error) {
      snapshot = failAssignmentKernelOperationV2(lease, error, operation.dispatch_state);
    }
  }
  return snapshot;
}
