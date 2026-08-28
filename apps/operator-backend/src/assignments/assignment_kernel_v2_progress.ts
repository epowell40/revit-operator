import { createHash } from "node:crypto";
import {
  buildAssignmentEfficiencyTraceV2,
  buildProgressEpochV2,
  canonicalJsonV2,
  decideAssignmentProgressV2,
  observationAdmissibilityForCriterionV2,
  type AssignmentBindingV2,
  type AssignmentEfficiencyTraceV2,
  type AssignmentProgressBudgetV2,
  type AssignmentSnapshotV2,
  type ProgressDecisionV2,
  PROVIDER_CALL_V2_SCHEMA,
  type ProviderCallV2,
  type ProviderCallStateV2,
  type ProviderUsageV2
} from "../domain/assignment-kernel/index.js";
import {
  deriveAndSettleAssignmentKernelV2,
  evaluateAssignmentObservationCriteriaV2
} from "./assignment_kernel_v2_lifecycle.js";
import {
  appendCurrentAssignmentKernelEventV2,
  getAssignmentKernelSnapshotV2
} from "./assignment_kernel_v2_store.js";

export const DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2: AssignmentProgressBudgetV2 = Object.freeze({
  max_reasoning_turns: 12,
  max_provider_calls: 16,
  max_operations: 24,
  max_equivalent_operations: 1,
  max_no_progress_epochs: 2,
  max_reconciliation_attempts: 2,
  max_wall_clock_ms: 15 * 60_000,
  max_total_tokens: 500_000
});

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonV2(value), "utf8").digest("hex");
}

export function recordAssignmentProviderCallStateV2(input: Readonly<{
  binding: AssignmentBindingV2;
  call_id: string;
  state: ProviderCallStateV2;
  occurred_at?: string;
  provider?: string;
  model?: string;
  reasoning_effort?: string | null;
  gap_ids?: readonly string[];
  criterion_ids?: readonly string[];
  expected_information?: readonly string[];
  usage?: ProviderUsageV2;
  success?: boolean;
  error_class?: "provider" | "transport" | "canceled" | "resource_exhausted";
}>): AssignmentSnapshotV2 {
  const occurredAt = input.occurred_at ?? new Date().toISOString();
  return appendCurrentAssignmentKernelEventV2({
    goal_id: input.binding.assignment_id,
    binding: input.binding,
    event_id: `provider-state:${digest({ binding: input.binding, call_id: input.call_id, state: input.state })}`,
    actor: "assignment-progress-controller",
    occurred_at: occurredAt,
    body: {
      event_type: "provider_call_state_recorded",
      call_id: input.call_id,
      state: input.state,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoning_effort !== undefined ? { reasoning_effort: input.reasoning_effort } : {}),
      ...(input.gap_ids ? { gap_ids: input.gap_ids } : {}),
      ...(input.criterion_ids ? { criterion_ids: input.criterion_ids } : {}),
      ...(input.expected_information ? { expected_information: input.expected_information } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.success !== undefined ? { success: input.success } : {}),
      ...(input.error_class ? { error_class: input.error_class } : {})
    }
  }).snapshot;
}

export function recordCompletedAssignmentProviderReceiptV2(input: Readonly<{
  binding: AssignmentBindingV2;
  call_id: string;
  controller_turn_id?: string;
  provider: string;
  model: string;
  reasoning_effort: string | null;
  gap_ids: readonly string[];
  criterion_ids: readonly string[];
  expected_information: readonly string[];
  admitted_at: string;
  completed_at?: string;
  usage: ProviderUsageV2;
  success: boolean;
  error_class?: "provider" | "transport" | "canceled" | "resource_exhausted";
}>): AssignmentSnapshotV2 {
  const completedAt = input.completed_at ?? new Date().toISOString();
  const call: ProviderCallV2 = {
    schema: PROVIDER_CALL_V2_SCHEMA,
    call_id: input.call_id,
    ...(input.controller_turn_id ? { controller_turn_id: input.controller_turn_id } : {}),
    binding: structuredClone(input.binding),
    state: "completed",
    provider: input.provider,
    model: input.model,
    reasoning_effort: input.reasoning_effort,
    gap_ids: [...new Set(input.gap_ids)].sort(),
    criterion_ids: [...new Set(input.criterion_ids)].sort(),
    expected_information: [...new Set(input.expected_information)].sort(),
    admitted_at: input.admitted_at,
    dispatched_at: input.admitted_at,
    response_started_at: input.admitted_at,
    usage_received_at: completedAt,
    completed_at: completedAt,
    usage: structuredClone(input.usage),
    success: input.success,
    ...(input.error_class ? { error_class: input.error_class } : {})
  };
  return appendCurrentAssignmentKernelEventV2({
    goal_id: input.binding.assignment_id,
    binding: input.binding,
    event_id: `provider-receipt:${digest({ binding: input.binding, call_id: input.call_id })}`,
    actor: "provider-receipt-observer",
    occurred_at: completedAt,
    body: { event_type: "provider_call_receipt_recorded", call }
  }).snapshot;
}

export function recordAssignmentProgressEpochV2(input: Readonly<{
  before: AssignmentSnapshotV2;
  after: AssignmentSnapshotV2;
  stated_gap_ids: readonly string[];
  admitted_reasoning_call_ids?: readonly string[];
  admitted_operation_ids?: readonly string[];
  recorded_at?: string;
}>): AssignmentSnapshotV2 {
  const recordedAt = input.recorded_at ?? new Date().toISOString();
  const epoch = buildProgressEpochV2({ ...input, recorded_at: recordedAt });
  return appendCurrentAssignmentKernelEventV2({
    goal_id: input.after.current_binding.assignment_id,
    binding: input.after.current_binding,
    event_id: `progress-epoch:${digest(epoch)}`,
    actor: "assignment-progress-controller",
    occurred_at: recordedAt,
    body: { event_type: "progress_epoch_recorded", epoch }
  }).snapshot;
}

export function advanceAssignmentKernelProgressV2(input: Readonly<{
  binding: AssignmentBindingV2;
  budget?: AssignmentProgressBudgetV2;
  now?: string;
}>): Readonly<{ snapshot: AssignmentSnapshotV2; decision: ProgressDecisionV2 }> {
  const now = input.now ?? new Date().toISOString();
  let snapshot = getAssignmentKernelSnapshotV2(input.binding.assignment_id);
  if (!snapshot) throw new Error("assignment_kernel_v2_not_found");
  let decision = decideAssignmentProgressV2({ snapshot, budget: input.budget ?? DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, now });
  if (decision.decision === "evaluate_criteria") {
    const evaluationDecision = decision;
    const claims = evaluationDecision.criterion_ids.map((criterionId) => ({
      criterion_id: criterionId,
      observation_ids: evaluationDecision.observation_ids.filter((observationId) => {
        const observation = snapshot!.observations[observationId];
        const criterion = snapshot!.spec.criteria.find((candidate) => candidate.criterion_id === criterionId);
        return Boolean(observation && criterion
          && observationAdmissibilityForCriterionV2({ snapshot: snapshot!, criterion, observation, evaluated_at: now }).admissible
          && observation.facts.some((fact) => criterion.semantic_fact_requirements.includes(fact.fact_id)));
      })
    }));
    snapshot = evaluateAssignmentObservationCriteriaV2({ binding: input.binding, claims });
    if (snapshot.terminal) return { snapshot, decision: decideAssignmentProgressV2({ snapshot, budget: input.budget ?? DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, now }) };
    decision = decideAssignmentProgressV2({ snapshot, budget: input.budget ?? DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, now });
  }
  if (decision.decision === "blocked") {
    snapshot = appendCurrentAssignmentKernelEventV2({
      goal_id: input.binding.assignment_id,
      binding: snapshot.current_binding,
      event_id: `progress-blocked:${digest({ binding: snapshot.current_binding, code: decision.reason, gap_ids: decision.gap_ids })}`,
      actor: "assignment-progress-controller",
      occurred_at: now,
      body: { event_type: "progress_blocked", code: decision.reason, gap_ids: decision.gap_ids }
    }).snapshot;
    snapshot = deriveAndSettleAssignmentKernelV2(input.binding, decision.reason);
    decision = decideAssignmentProgressV2({ snapshot, budget: input.budget ?? DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, now });
  } else if (decision.decision === "terminal") {
    snapshot = deriveAndSettleAssignmentKernelV2(input.binding, decision.reason);
    decision = decideAssignmentProgressV2({ snapshot, budget: input.budget ?? DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, now });
  }
  return { snapshot, decision };
}

export function assignmentEfficiencyTraceV2(assignmentId: string, observedAt?: string): AssignmentEfficiencyTraceV2 {
  const snapshot = getAssignmentKernelSnapshotV2(assignmentId);
  if (!snapshot) throw new Error("assignment_kernel_v2_not_found");
  return buildAssignmentEfficiencyTraceV2(snapshot, observedAt);
}
