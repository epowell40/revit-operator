import { createHash } from "node:crypto";
import {
  OPERATION_RESULT_V2_SCHEMA,
  OPERATION_V2_SCHEMA,
  canonicalJsonV2,
  deriveProgressGapsV2,
  sameAssignmentBindingV2,
  type AssignmentBindingV2,
  type AssignmentSnapshotV2,
  type ObservationV2,
  type OperationPurposeV2,
  type OperationResultV2,
  type OperationV2,
  type PersistentEffectV2,
  type RequestedEffectV2,
  type SemanticFactV2
} from "../domain/assignment-kernel/index.js";
import { storeEvidence } from "../evidence/evidence_store.js";
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
  const advancesCriterionIds = [...new Set(unit.criterion_ids)].sort();
  const currentGaps = deriveProgressGapsV2(input.snapshot);
  const resolvesGapIds = currentGaps
    .filter((gap) => gap.work_unit_ids.includes(unit.work_unit_id)
      || gap.criterion_ids.some((criterionId) => advancesCriterionIds.includes(criterionId))
      || (purpose === "reconciliation" && gap.kind === "effect_unknown"))
    .map((gap) => gap.gap_id)
    .sort();
  const operation: OperationV2 = {
    schema: OPERATION_V2_SCHEMA,
    operation_id: operationId,
    binding: structuredClone(input.snapshot.current_binding),
    work_unit_id: unit.work_unit_id,
    capability_id: input.capability_id,
    requested_effect: effect,
    purpose,
    advances_criterion_ids: advancesCriterionIds,
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
    opened_at: openedAt,
    deadline_at: operation.deadline_at
  };
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
  rawResult: unknown
): AssignmentKernelOperationSettlementV2 {
  const envelope = explicitMcpEnvelope(rawResult);
  const result = unwrapOperationResultV2({ transport: "typed_mcp", structured_content: { operation_result_v2: envelope.operation_result_v2 } });
  if (result.operation_id !== lease.operation_id || !sameAssignmentBindingV2(result.binding, lease.binding)) {
    throw new Error("assignment_kernel_v2_result_binding_mismatch");
  }
  recordNativeDispatchIfNeeded(lease, result);
  appendCurrentAssignmentKernelEventV2({
    goal_id: lease.assignment_id, binding: lease.binding,
    event_id: `operation-result:${result.result_id}`,
    actor: result.authority,
    occurred_at: result.completed_at,
    body: { event_type: "operation_result_recorded", result }
  });
  if (!result.observation_required) {
    return {
      snapshot: getAssignmentKernelSnapshotV2(lease.assignment_id)!, result,
      observation: null, evidence_refs: [], evidence_projections: []
    };
  }
  if (!envelope.observation) throw new Error("assignment_kernel_v2_observation_payload_missing");
  const facts = validateFacts(envelope.observation.semantic_facts);
  try {
    const stored = storeEvidence({
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
      raw: envelope.observation.raw_payload
    }, getEvidenceContextBudget().item_bytes);
    const registry = new ObservationDecoderRegistryV2();
    registry.register(result.result_schema_id, () => facts);
    const observation = observationFromOperationResultV2({
      result,
      expected_binding: lease.binding,
      observation_id: `obsv2_${stableHash({ operation_id: lease.operation_id, evidence_id: stored.ref.evidence_id })}`,
      raw_payload_ref: `evidence:${stored.ref.evidence_id}`,
      raw_payload: envelope.observation.raw_payload,
      target_scope: envelope.observation.target_scope,
      verification_relevance: envelope.observation.verification_relevance,
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
    const errorCode = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
    appendCurrentAssignmentKernelEventV2({
      goal_id: lease.assignment_id, binding: lease.binding,
      event_id: `observation-retention-failed:${result.result_id}`,
      actor: "operator-evidence-store",
      body: { event_type: "observation_retention_failed", operation_id: lease.operation_id, error_code: errorCode || "observation_retention_failed" }
    });
    throw error;
  }
}

export function failAssignmentKernelOperationV2(
  lease: AssignmentKernelOperationLeaseV2,
  error: unknown,
  dispatch: "not_dispatched" | "dispatching" | "dispatched"
): AssignmentSnapshotV2 {
  const current = getAssignmentKernelSnapshotV2(lease.assignment_id)?.operations[lease.operation_id];
  if (!current || current.settlement_state === "settled") return getAssignmentKernelSnapshotV2(lease.assignment_id)!;
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
    error_code: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
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

function leaseFromOperation(operation: OperationV2): AssignmentKernelOperationLeaseV2 {
  return {
    schema: ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA,
    assignment_id: operation.binding.assignment_id,
    binding: structuredClone(operation.binding),
    operation_id: operation.operation_id,
    capability_id: operation.capability_id,
    requested_effect: operation.requested_effect,
    purpose: operation.purpose,
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
