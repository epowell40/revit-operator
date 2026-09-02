import { canonicalJsonV2 } from "../canonical.js";
import { ASSIGNMENT_VERIFICATION_WORK_UNIT_ID_V2, type AssignmentCriterionSpecV2 } from "../assignment_spec.js";
import type { AssignmentSnapshotV2 } from "../snapshot.js";
import { semanticFactIdentityV2 } from "../observation.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../outcome.js";
import { observationAdmissibilityForCriterionV2 } from "../semantic_admissibility.js";
import type { OperationInputSchemaIssueV2, OperationV2 } from "../operation.js";
import {
  EXECUTION_STRATEGY_EVIDENCE_V1,
  EXECUTION_SUBSTRATES
} from "../../../execution_strategy.js";
import {
  PROGRESS_DECISION_V2_SCHEMA,
  PROGRESS_EPOCH_V2_SCHEMA,
  PROGRESS_GAP_V2_SCHEMA,
  type AssignmentProgressBudgetV2,
  type CriterionDeltaV2,
  type ProgressDecisionV2,
  type ProgressEpochV2,
  type ProgressGapV2
} from "./contracts.js";

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function relevantObservationIds(snapshot: AssignmentSnapshotV2, criterion: AssignmentCriterionSpecV2): string[] {
  const basis = snapshot.spec.requested_effect === "apply" && (criterion.desired_state_comparisons?.length ?? 0) > 0
    ? "desired_state_equivalence" as const
    : "observation" as const;
  return Object.values(snapshot.observations)
    .filter((observation) => observationAdmissibilityForCriterionV2({ snapshot, criterion, observation, basis }).admissible)
    .filter((observation) => observation.facts.some((fact) => criterion.semantic_fact_requirements.includes(fact.fact_id)))
    .map((observation) => observation.observation_id)
    .sort();
}

const INPUT_SCHEMA_DOCUMENTATION_CAPABILITIES = new Set(["revit_tool_doc", "revit_tool_examples"]);

export function operationProposalCanResolveInputSchemaGapV2(input: Readonly<{
  rejected: OperationV2;
  capability_id: string;
  request_identity: Readonly<{
    method?: "GET" | "POST";
    path?: string;
    request_signature: string;
  }>;
}>): boolean {
  const gap = input.rejected.result?.input_schema_gap;
  if (!gap) return false;
  const exactCorrectedRetry = input.capability_id === input.rejected.capability_id
    && input.request_identity.method === gap.method
    && input.request_identity.path === gap.path
    && input.request_identity.request_signature !== gap.request_signature;
  const exactSchemaDocumentation = INPUT_SCHEMA_DOCUMENTATION_CAPABILITIES.has(input.capability_id)
    && input.request_identity.method === gap.method
    && input.request_identity.path === gap.path;
  return exactCorrectedRetry || exactSchemaDocumentation;
}

function inputSchemaIssueRequirementV2(issue: OperationInputSchemaIssueV2): string {
  const constraint = issue.expected_constraint;
  const constraintDetail = constraint.kind === "enum"
    ? `allowed_values=${canonicalJsonV2(constraint.allowed_values ?? [])}`
    : constraint.kind === "json_type"
      ? `required_type=${constraint.type ?? issue.expected_type}`
      : canonicalJsonV2(constraint);
  return `${issue.field_path}:${issue.expected_type};actual=${issue.actual_type};${constraintDetail};correction=${issue.correction_action}`;
}

function inputSchemaGapResolvedV2(snapshot: AssignmentSnapshotV2, rejected: OperationV2): boolean {
  const gap = rejected.result?.input_schema_gap;
  if (!gap) return false;
  return Object.values(snapshot.operations).some((candidate) => {
    if (candidate.operation_id === rejected.operation_id
        || !candidate.resolves_gap_ids.includes(gap.gap_id)
        || candidate.settlement_state !== "settled"
        || !["succeeded", "completed_without_native_dispatch"].includes(candidate.result?.status ?? "")
        || candidate.binding.run_id !== rejected.binding.run_id
        || candidate.binding.generation !== rejected.binding.generation) return false;
    const correctedRetry = candidate.retry_of_operation_id === rejected.operation_id
      && candidate.retry_basis === "corrected_input"
      && Boolean(candidate.request_identity)
      && operationProposalCanResolveInputSchemaGapV2({
        rejected,
        capability_id: candidate.capability_id,
        request_identity: candidate.request_identity!
      })
      && candidate.result?.dispatch_state === "dispatched"
      && candidate.observation_ids.length > 0;
    const documentationChildren = Object.values(snapshot.operations).filter((child) =>
      child.parent_operation_id === candidate.operation_id
      && child.settlement_state === "settled"
      && child.result?.status === "succeeded"
      && child.observation_ids.length > 0
      && (child.fulfillment_role === "supporting_control" || child.fulfillment_role === "prerequisite"));
    const documentation = candidate.fulfillment_role === "supporting_control"
      && INPUT_SCHEMA_DOCUMENTATION_CAPABILITIES.has(candidate.capability_id)
      && String(candidate.input.method ?? "").toUpperCase() === gap.method
      && String(candidate.input.path ?? "") === gap.path
      && (candidate.observation_ids.length > 0 || documentationChildren.length > 0);
    return correctedRetry || documentation;
  });
}

export function deriveProgressGapsV2(snapshot: AssignmentSnapshotV2): readonly ProgressGapV2[] {
  const gaps: ProgressGapV2[] = [];
  for (const operation of Object.values(snapshot.operations)) {
    const inputGap = operation.result?.input_schema_gap;
    if (!inputGap) continue;
    const resolved = inputSchemaGapResolvedV2(snapshot, operation);
    if (resolved) continue;
    gaps.push({
      schema: PROGRESS_GAP_V2_SCHEMA,
      gap_id: inputGap.gap_id,
      kind: "operation_input_schema_invalid",
      criterion_ids: operation.advances_criterion_ids,
      work_unit_ids: [operation.work_unit_id],
      required_fact_ids: inputGap.issues.map(inputSchemaIssueRequirementV2).sort(),
      current_observation_ids: [],
      reason: `Operation ${operation.operation_id} was safely rejected before dispatch because its structured input did not satisfy ${inputGap.input_schema_id}. `
        + `Correct the exact ${inputGap.method} ${inputGap.path} request or inspect that route's exact schema documentation; unrelated capability discovery cannot resolve this gap. `
        + `Issues: ${inputGap.issues.map(inputSchemaIssueRequirementV2).join(" | ")}`
    });
  }
  for (const variableId of snapshot.pending_input_variable_ids) {
    const workUnits = snapshot.spec.work_units.filter((unit) => unit.input_variable_ids.includes(variableId));
    gaps.push({
      schema: PROGRESS_GAP_V2_SCHEMA,
      gap_id: `input:${variableId}`,
      kind: "input_missing",
      criterion_ids: unique(workUnits.flatMap((unit) => unit.criterion_ids)),
      work_unit_ids: unique(workUnits.map((unit) => unit.work_unit_id)),
      required_fact_ids: [],
      current_observation_ids: [],
      reason: `Required authenticated input ${variableId} is missing.`
    });
  }
  for (const operationId of snapshot.unresolved_unknown_operation_ids) {
    const operation = snapshot.operations[operationId];
    gaps.push({
      schema: PROGRESS_GAP_V2_SCHEMA,
      gap_id: `effect:${operationId}`,
      kind: "effect_unknown",
      criterion_ids: operation?.advances_criterion_ids ?? [],
      work_unit_ids: operation ? [operation.work_unit_id] : [],
      required_fact_ids: [],
      current_observation_ids: operation?.observation_ids ?? [],
      reason: "A possibly dispatched mutation requires target-bound reconciliation."
    });
  }
  for (const operation of Object.values(snapshot.operations)) {
    if (operation.requested_effect !== "apply"
        || operation.persistent_effect !== "applied"
        || operation.settlement_state !== "settled"
        || appliedOperationHasVerifiedPostconditionV2(snapshot, operation.operation_id)) continue;
    const verificationOperationIds = operation.verification_operation_ids
      .filter((operationId) => Boolean(snapshot.operations[operationId]));
    gaps.push({
      schema: PROGRESS_GAP_V2_SCHEMA,
      gap_id: `verification:${operation.operation_id}`,
      kind: "verification_required",
      criterion_ids: operation.advances_criterion_ids,
      work_unit_ids: snapshot.spec.work_units.some((unit) => unit.work_unit_id === ASSIGNMENT_VERIFICATION_WORK_UNIT_ID_V2)
        ? [ASSIGNMENT_VERIFICATION_WORK_UNIT_ID_V2]
        : [operation.work_unit_id],
      required_fact_ids: ["verification.postcondition_satisfied"],
      current_observation_ids: verificationOperationIds
        .flatMap((operationId) => snapshot.operations[operationId]?.observation_ids ?? [])
        .sort(),
      reason: `Applied operation ${operation.operation_id} requires a successful target-bound readback before completion.`
    });
  }
  for (const criterion of snapshot.spec.criteria.filter((candidate) => candidate.required)) {
    const evaluation = snapshot.criteria[criterion.criterion_id];
    if (evaluation?.status === "pass" || evaluation?.status === "not_applicable") continue;
    const observations = relevantObservationIds(snapshot, criterion);
    const present = new Set(observations.flatMap((id) => snapshot.observations[id]?.facts.map((fact) => fact.fact_id) ?? []));
    const missing = criterion.semantic_fact_requirements.filter((factId) => !present.has(factId));
    const workUnits = snapshot.spec.work_units.filter((unit) => unit.criterion_ids.includes(criterion.criterion_id));
    gaps.push({
      schema: PROGRESS_GAP_V2_SCHEMA,
      gap_id: `criterion:${criterion.criterion_id}`,
      kind: evaluation?.status === "uncertain" ? "criterion_uncertain" : "criterion_fact_missing",
      criterion_ids: [criterion.criterion_id],
      work_unit_ids: workUnits.map((unit) => unit.work_unit_id).sort(),
      required_fact_ids: missing.length > 0 ? missing : criterion.semantic_fact_requirements,
      current_observation_ids: observations,
      reason: evaluation?.reason ?? "Required criterion has not been evaluated from authoritative facts."
    });
  }
  return gaps.sort((left, right) => left.gap_id.localeCompare(right.gap_id));
}

export function criteriaPendingEvaluationV2(snapshot: AssignmentSnapshotV2): Readonly<Record<string, readonly string[]>> {
  const pending: Record<string, readonly string[]> = {};
  for (const criterion of snapshot.spec.criteria) {
    const observations = relevantObservationIds(snapshot, criterion);
    if (observations.length === 0) continue;
    const newestObservationVersion = Math.max(...observations.map((id) => snapshot.observation_versions[id] ?? 0));
    const evaluatedVersion = snapshot.criterion_evaluation_versions[criterion.criterion_id] ?? 0;
    if (newestObservationVersion > evaluatedVersion) pending[criterion.criterion_id] = observations;
  }
  return pending;
}

function budgetBlocker(snapshot: AssignmentSnapshotV2, budget: AssignmentProgressBudgetV2, now: string): string | null {
  const providerCalls = Object.keys(snapshot.provider_calls).length;
  const operationCount = Object.keys(snapshot.operations).length;
  const latest = snapshot.progress_epochs.at(-1);
  const noProgress = latest && !latest.genuine_progress
    ? [...snapshot.progress_epochs].reverse().findIndex((epoch) => epoch.genuine_progress
      || canonicalJsonV2(epoch.unresolved_gap_ids) !== canonicalJsonV2(latest.unresolved_gap_ids))
    : 0;
  const consecutiveNoProgress = noProgress < 0 ? snapshot.progress_epochs.length : noProgress;
  const reasoningTurns = Object.values(snapshot.provider_calls).filter((call) => call.state !== "admitted").length;
  const tokens = Object.values(snapshot.provider_calls).reduce((sum, call) => sum + (call.usage?.total_tokens ?? 0), 0);
  if (providerCalls >= budget.max_provider_calls) return "provider_call_budget_exhausted";
  if (reasoningTurns >= budget.max_reasoning_turns) return "reasoning_turn_budget_exhausted";
  if (operationCount >= budget.max_operations) return "operation_budget_exhausted";
  if (consecutiveNoProgress >= budget.max_no_progress_epochs) return "no_progress_budget_exhausted";
  if (tokens >= budget.max_total_tokens) return "token_budget_exhausted";
  if (Date.parse(now) - Date.parse(snapshot.spec.created_at) >= budget.max_wall_clock_ms) return "execution_lease_exhausted";
  return null;
}

function decisionBase(snapshot: AssignmentSnapshotV2, now: string, decision: string, reason: string) {
  return {
    schema: PROGRESS_DECISION_V2_SCHEMA,
    assignment_version: snapshot.assignment_version,
    binding: snapshot.current_binding,
    decision_id: canonicalJsonV2({ assignment_id: snapshot.current_binding.assignment_id, version: snapshot.assignment_version, decision, reason }),
    decided_at: now,
    reason
  } as const;
}

export function decideAssignmentProgressV2(input: Readonly<{
  snapshot: AssignmentSnapshotV2;
  budget: AssignmentProgressBudgetV2;
  now: string;
}>): ProgressDecisionV2 {
  const { snapshot, budget, now } = input;
  if (snapshot.terminal) {
    return { ...decisionBase(snapshot, now, "terminal", "Assignment is already terminal."), decision: "terminal", outcome: snapshot.outcome as "complete" | "complete_with_issues" | "verified_noop" | "blocked" | "failed" };
  }
  if (snapshot.in_flight_provider_call_ids.length > 0) {
    return { ...decisionBase(snapshot, now, "await_provider", "Canonical provider requests remain in flight."), decision: "await_provider", provider_call_ids: snapshot.in_flight_provider_call_ids };
  }
  if (snapshot.in_flight_operation_ids.length > 0) {
    return { ...decisionBase(snapshot, now, "await_operation", "Canonical operations remain in flight."), decision: "await_operation", operation_ids: snapshot.in_flight_operation_ids };
  }
  if (snapshot.unresolved_unknown_operation_ids.length > 0) {
    const reconciliationAttempts = Object.values(snapshot.operations).filter((operation) => operation.purpose === "reconciliation").length;
    if (reconciliationAttempts >= budget.max_reconciliation_attempts) {
      return { ...decisionBase(snapshot, now, "blocked", "reconciliation_budget_exhausted"), decision: "blocked", outcome: "blocked", gap_ids: snapshot.unresolved_unknown_operation_ids.map((id) => `effect:${id}`) };
    }
    const operationId = snapshot.unresolved_unknown_operation_ids[0];
    return { ...decisionBase(snapshot, now, "reconcile_operation", "Unknown persistent effect must be reconciled before other work."), decision: "reconcile_operation", operation_id: operationId, gap_ids: [`effect:${operationId}`] };
  }
  const pendingCriteria = criteriaPendingEvaluationV2(snapshot);
  const criterionIds = Object.keys(pendingCriteria).sort();
  if (criterionIds.length > 0) {
    return {
      ...decisionBase(snapshot, now, "evaluate_criteria", "New authoritative observations can advance criteria."),
      decision: "evaluate_criteria",
      criterion_ids: criterionIds,
      observation_ids: unique(criterionIds.flatMap((id) => pendingCriteria[id] ?? []))
    };
  }
  if (snapshot.pending_input_variable_ids.length > 0 || snapshot.outcome === "awaiting_user_input") {
    const gaps = deriveProgressGapsV2(snapshot).filter((gap) => gap.kind === "input_missing");
    return { ...decisionBase(snapshot, now, "request_user_input", "Authenticated execution-critical input is missing."), decision: "request_user_input", gap_ids: gaps.map((gap) => gap.gap_id), criterion_ids: unique(gaps.flatMap((gap) => gap.criterion_ids)) };
  }
  if (snapshot.pending_review_ids.length > 0 || snapshot.outcome === "awaiting_user_review") {
    return { ...decisionBase(snapshot, now, "request_user_review", "A bounded user review decision is pending."), decision: "request_user_review", gap_ids: snapshot.pending_review_ids.map((id) => `review:${id}`), work_unit_ids: [] };
  }
  if (snapshot.outcome !== "active") {
    return { ...decisionBase(snapshot, now, "terminal", "Canonical criteria and operation state derive a terminal outcome."), decision: "terminal", outcome: snapshot.outcome };
  }
  const gaps = deriveProgressGapsV2(snapshot);
  const exhausted = budgetBlocker(snapshot, budget, now);
  if (exhausted) {
    return { ...decisionBase(snapshot, now, "blocked", exhausted), decision: "blocked", outcome: "blocked", gap_ids: gaps.map((gap) => gap.gap_id) };
  }
  if (gaps.length === 0) {
    return { ...decisionBase(snapshot, now, "blocked", "Active quiescent Assignment has no admissible unresolved work."), decision: "blocked", outcome: "blocked", gap_ids: [] };
  }
  return {
    ...decisionBase(snapshot, now, "admit_reasoning_turn", "Bounded reasoning is justified by explicit unresolved criterion gaps."),
    decision: "admit_reasoning_turn",
    gap_ids: gaps.map((gap) => gap.gap_id),
    criterion_ids: unique(gaps.flatMap((gap) => gap.criterion_ids)),
    expected_information: unique(gaps.flatMap((gap) => gap.required_fact_ids))
  };
}

export function operationProgressIdentityV2(operation: OperationV2): string {
  return canonicalJsonV2({
    capability_id: operation.capability_id,
    requested_effect_value: operation.requested_effect,
    purpose: operation.purpose,
    target: operation.target,
    input: operation.input,
    advances_criterion_ids: [...operation.advances_criterion_ids].sort(),
    eligible_criterion_ids: [...(operation.eligible_criterion_ids ?? [])].sort(),
    fulfillment_role: operation.fulfillment_role ?? null,
    resolves_gap_ids: [...operation.resolves_gap_ids].sort(),
    operation_role: operation.operation_role ?? "root",
    parent_operation_id: operation.parent_operation_id ?? null,
    request_identity: operation.request_identity ?? null
  });
}

export function assertOperationAdvancesProgressV2(input: Readonly<{
  snapshot: AssignmentSnapshotV2;
  operation: OperationV2;
  budget: AssignmentProgressBudgetV2;
}>): void {
  const gaps = new Map(deriveProgressGapsV2(input.snapshot).map((gap) => [gap.gap_id, gap]));
  if (input.operation.advances_criterion_ids.length === 0 && input.operation.resolves_gap_ids.length === 0) throw new Error("operation_progress_binding_missing");
  for (const gapId of input.operation.resolves_gap_ids) if (!gaps.has(gapId)) throw new Error("operation_progress_gap_not_current");
  const unresolvedCriteria = new Set([...gaps.values()].flatMap((gap) => gap.criterion_ids));
  for (const criterionId of input.operation.advances_criterion_ids) if (!unresolvedCriteria.has(criterionId)) throw new Error("operation_progress_criterion_not_unresolved");
  assertOperationDoesNotRepeatSchemaRejectedInputV2(input);
  const identity = operationProgressIdentityV2(input.operation);
  const equivalents = Object.values(input.snapshot.operations).filter((operation) => operationProgressIdentityV2(operation) === identity);
  if (equivalents.length >= input.budget.max_equivalent_operations && !input.operation.retry_of_operation_id && input.operation.purpose !== "reconciliation") {
    throw new Error("operation_progress_equivalent_budget_exhausted");
  }
}

export function assertOperationDoesNotRepeatSchemaRejectedInputV2(input: Readonly<{
  snapshot: AssignmentSnapshotV2;
  operation: OperationV2;
}>): void {
  const repeatsSchemaRejectedInput = Object.values(input.snapshot.operations).some((candidate) => {
    const gap = candidate.result?.input_schema_gap;
    return Boolean(gap
      && candidate.capability_id === input.operation.capability_id
      && gap.method === input.operation.request_identity?.method
      && gap.path === input.operation.request_identity?.path
      && gap.request_signature === input.operation.request_identity?.request_signature);
  });
  if (repeatsSchemaRejectedInput) throw new Error("operation_progress_identical_input_schema_retry");
}

function statusRank(status: string): number {
  return ({ unevaluated: 0, uncertain: 1, needs_input: 1, needs_review: 1, failed: 1, partial: 2, pass: 3, not_applicable: 3 } as Record<string, number>)[status] ?? 0;
}

function executionStrategySelectionIdentityV2(operation: OperationV2): string | null {
  const selectedSubstrate = operation.input.selected_substrate;
  if (operation.capability_id !== "operator_record_execution_strategy"
      || operation.purpose !== "discovery"
      || operation.fulfillment_role !== "supporting_control"
      || operation.settlement_state !== "settled"
      || operation.result?.status !== "completed_without_native_dispatch"
      || operation.result.dispatch_state !== "not_dispatched"
      || operation.input.schema !== EXECUTION_STRATEGY_EVIDENCE_V1
      || typeof selectedSubstrate !== "string"
      || !(EXECUTION_SUBSTRATES as readonly string[]).includes(selectedSubstrate)) return null;
  return canonicalJsonV2({
    work_unit_id: operation.work_unit_id,
    selected_substrate: selectedSubstrate,
    resolves_gap_ids: [...operation.resolves_gap_ids].sort()
  });
}

function introducesExecutionStrategySelectionV2(input: Readonly<{
  before: AssignmentSnapshotV2;
  after: AssignmentSnapshotV2;
  admitted_operation_ids: readonly string[];
  stated_gap_ids: readonly string[];
}>): boolean {
  const currentGaps = new Set(input.stated_gap_ids);
  const previous = new Set(Object.values(input.before.operations)
    .map(executionStrategySelectionIdentityV2)
    .filter((identity): identity is string => identity !== null));
  return input.admitted_operation_ids.some((operationId) => {
    const operation = input.after.operations[operationId];
    if (!operation || !operation.resolves_gap_ids.some((gapId) => currentGaps.has(gapId))) return false;
    const identity = executionStrategySelectionIdentityV2(operation);
    return identity !== null && !previous.has(identity);
  });
}

export function buildProgressEpochV2(input: Readonly<{
  before: AssignmentSnapshotV2;
  after: AssignmentSnapshotV2;
  stated_gap_ids: readonly string[];
  admitted_reasoning_call_ids?: readonly string[];
  admitted_operation_ids?: readonly string[];
  recorded_at: string;
}>): ProgressEpochV2 {
  const beforeFacts = new Set(Object.values(input.before.observations).flatMap((observation) => observation.facts.map(semanticFactIdentityV2)));
  const newObservations = Object.keys(input.after.observations).filter((id) => !input.before.observations[id]).sort();
  const newFactRecords = newObservations.flatMap((id) =>
    input.after.observations[id]?.facts.map((fact) => ({ fact, identity: semanticFactIdentityV2(fact) })) ?? [])
    .filter(({ identity }) => !beforeFacts.has(identity));
  const newFacts = unique(newFactRecords.map(({ identity }) => identity));
  const criterionDeltas: CriterionDeltaV2[] = input.after.spec.criteria.map((criterion) => ({
    criterion_id: criterion.criterion_id,
    before_status: input.before.criteria[criterion.criterion_id]?.status ?? "unevaluated",
    after_status: input.after.criteria[criterion.criterion_id]?.status ?? "unevaluated"
  })).filter((delta) => delta.before_status !== delta.after_status);
  const beforeGaps = deriveProgressGapsV2(input.before).map((gap) => gap.gap_id);
  const afterGaps = deriveProgressGapsV2(input.after).map((gap) => gap.gap_id);
  const progressReasons: ProgressEpochV2["progress_reasons"][number][] = [];
  if (criterionDeltas.some((delta) => statusRank(delta.after_status) > statusRank(delta.before_status))) progressReasons.push("criterion_advanced");
  if (afterGaps.length < beforeGaps.length || beforeGaps.some((gap) => !afterGaps.includes(gap))) progressReasons.push("gap_narrowed");
  if (afterGaps.some((gap) => gap.startsWith("input-schema:") && !beforeGaps.includes(gap))) progressReasons.push("correction_gap_identified");
  if (newFactRecords.some(({ fact }) => fact.fact_class === "control")) progressReasons.push("controller_knowledge_added");
  if (newFactRecords.some(({ fact }) => fact.fact_class !== "control")) progressReasons.push("authoritative_observation_added");
  if (input.after.pending_input_variable_ids.length > input.before.pending_input_variable_ids.length) progressReasons.push("input_requested");
  if (input.after.pending_input_variable_ids.length < input.before.pending_input_variable_ids.length) progressReasons.push("input_resolved");
  if (input.after.pending_review_ids.length > input.before.pending_review_ids.length) progressReasons.push("review_requested");
  if (input.after.pending_review_ids.length < input.before.pending_review_ids.length) progressReasons.push("review_resolved");
  if (input.after.unresolved_unknown_operation_ids.length < input.before.unresolved_unknown_operation_ids.length) progressReasons.push("uncertainty_reconciled");
  if (introducesExecutionStrategySelectionV2({
    before: input.before,
    after: input.after,
    admitted_operation_ids: input.admitted_operation_ids ?? [],
    stated_gap_ids: input.stated_gap_ids
  })) progressReasons.push("execution_strategy_selected");
  if (canonicalJsonV2(input.before.work_unit_states) !== canonicalJsonV2(input.after.work_unit_states)) progressReasons.push("work_unit_changed");
  if (input.before.outcome !== input.after.outcome && input.after.outcome !== "active") progressReasons.push("terminal_derived");
  return {
    schema: PROGRESS_EPOCH_V2_SCHEMA,
    epoch_id: canonicalJsonV2({ assignment_id: input.after.current_binding.assignment_id, before: input.before.assignment_version, after: input.after.assignment_version, gaps: input.stated_gap_ids }),
    binding: input.after.current_binding,
    before_assignment_version: input.before.assignment_version,
    after_assignment_version: input.after.assignment_version,
    unresolved_gap_ids: [...input.stated_gap_ids].sort(),
    admitted_reasoning_call_ids: unique(input.admitted_reasoning_call_ids ?? []),
    admitted_operation_ids: unique(input.admitted_operation_ids ?? []),
    new_observation_ids: newObservations,
    new_fact_identities: newFacts,
    criterion_deltas: criterionDeltas,
    progress_fingerprint: canonicalJsonV2({ gaps: afterGaps, criteria: input.after.criteria, observations: Object.keys(input.after.observations).sort(), work_units: input.after.work_unit_states, generation: input.after.current_binding.generation }),
    genuine_progress: progressReasons.length > 0,
    progress_reasons: progressReasons,
    recorded_at: input.recorded_at
  };
}
