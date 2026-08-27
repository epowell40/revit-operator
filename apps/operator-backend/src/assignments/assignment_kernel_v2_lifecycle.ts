import { createHash } from "node:crypto";
import {
  canonicalJsonV2,
  evaluateCriterionV2,
  type AssignmentOutcomeV2,
  type AssignmentSnapshotV2
} from "../domain/assignment-kernel/index.js";
import { getGoal } from "../goals/service.js";
import { persistVerifiedWorkPacket } from "../work_packets/store.js";
import { persistWorkReturn } from "../work_returns/store.js";
import { normalizeAssignmentInputsV2, type AssignmentInputAliasRegistryV2 } from "./assignment_kernel_v2_input_adapter.js";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { appendCurrentAssignmentKernelEventV2, getAssignmentKernelSnapshotV2 } from "./assignment_kernel_v2_store.js";

export type AssignmentKernelBindingInputV2 = Readonly<{
  session_id: string;
  assignment_id: string;
  run_id: string;
  generation: number;
}>;

export type CriterionObservationClaimV2 = Readonly<{
  criterion_id: string;
  observation_ids: readonly string[];
  basis?: "observation" | "desired_state_equivalence";
}>;

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonV2(value), "utf8").digest("hex");
}

function context(binding: AssignmentKernelBindingInputV2) {
  const resolved = assignmentKernelV2ForBinding(binding);
  if (!resolved) throw new Error("assignment_kernel_v2_binding_stale_or_mismatched");
  if (resolved.snapshot.terminal) throw new Error("assignment_terminal_immutable");
  return resolved;
}

function terminalOutcome(outcome: AssignmentOutcomeV2): outcome is Exclude<AssignmentOutcomeV2, "active" | "awaiting_user_input" | "awaiting_user_review"> {
  return ["complete", "complete_with_issues", "verified_noop", "blocked", "failed"].includes(outcome);
}

function persistTerminalArtifacts(assignmentId: string, snapshot: AssignmentSnapshotV2): void {
  const goal = getGoal(assignmentId);
  if (!goal) throw new Error("assignment_kernel_v2_goal_not_found");
  persistVerifiedWorkPacket(goal, snapshot);
  persistWorkReturn(goal, snapshot);
}

export function deriveAndSettleAssignmentKernelV2(binding: AssignmentKernelBindingInputV2, reason: string): AssignmentSnapshotV2 {
  let snapshot = context(binding).snapshot;
  appendCurrentAssignmentKernelEventV2({
    goal_id: binding.assignment_id,
    binding: snapshot.current_binding,
    event_id: `outcome-derived:${digest({ version: snapshot.assignment_version, outcome: snapshot.outcome })}`,
    actor: "assignment-kernel-v2",
    body: { event_type: "outcome_derived", outcome: snapshot.outcome, reason }
  });
  snapshot = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  if (!terminalOutcome(snapshot.outcome)) return snapshot;
  const terminal = appendCurrentAssignmentKernelEventV2({
    goal_id: binding.assignment_id,
    binding: snapshot.current_binding,
    event_id: `assignment-terminal:${digest({ binding: snapshot.current_binding, outcome: snapshot.outcome })}`,
    actor: "assignment-kernel-v2",
    body: { event_type: "assignment_terminal", outcome: snapshot.outcome, reason }
  }).snapshot;
  persistTerminalArtifacts(binding.assignment_id, terminal);
  return terminal;
}

/**
 * Canonical V2 completion handoff. The caller selects stable criteria and
 * observations; the trusted kernel evaluator derives status and supporting
 * facts. A controller cannot author a passing status or a transport-shaped proof.
 */
export function evaluateAssignmentObservationCriteriaV2(input: Readonly<{
  binding: AssignmentKernelBindingInputV2;
  claims: readonly CriterionObservationClaimV2[];
}>): AssignmentSnapshotV2 {
  let snapshot = context(input.binding).snapshot;
  if (!snapshot.quiescent) throw new Error("assignment_kernel_v2_criteria_not_quiescent");
  if (input.claims.length < 1) throw new Error("assignment_kernel_v2_criterion_claim_required");
  for (const claim of input.claims) {
    const evaluation = evaluateCriterionV2({
      snapshot,
      criterion_id: claim.criterion_id,
      observation_ids: [...new Set(claim.observation_ids)],
      evaluator_authority: "operator-runtime",
      evaluated_at: new Date().toISOString(),
      ...(claim.basis ? { basis: claim.basis } : {})
    });
    snapshot = appendCurrentAssignmentKernelEventV2({
      goal_id: input.binding.assignment_id,
      binding: snapshot.current_binding,
      event_id: `criterion-evaluated:${digest(evaluation)}`,
      actor: evaluation.evaluator_authority,
      occurred_at: evaluation.evaluated_at,
      body: { event_type: "criterion_evaluated", evaluation }
    }).snapshot;
  }
  return deriveAndSettleAssignmentKernelV2(input.binding, "criterion_observations_evaluated");
}

export function requestAssignmentInputV2(input: Readonly<{
  binding: AssignmentKernelBindingInputV2;
  clarification_id: string;
  variable_ids: readonly string[];
  question: string;
}>): AssignmentSnapshotV2 {
  let snapshot = context(input.binding).snapshot;
  const clarificationId = input.clarification_id.trim();
  const question = input.question.trim();
  const variableIds = [...new Set(input.variable_ids.map(value => value.trim()).filter(Boolean))];
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(clarificationId)) throw new Error("assignment_kernel_v2_clarification_id_invalid");
  if (!question) throw new Error("assignment_kernel_v2_clarification_question_required");
  if (variableIds.length < 1) throw new Error("assignment_kernel_v2_input_variable_required");
  for (const variableId of variableIds) {
    if (!snapshot.spec.input_variables.some(variable => variable.variable_id === variableId)) throw new Error("assignment_kernel_v2_input_variable_unknown");
    snapshot = appendCurrentAssignmentKernelEventV2({
      goal_id: input.binding.assignment_id,
      binding: snapshot.current_binding,
      event_id: `input-requested:${clarificationId}:${variableId}`,
      actor: "operator-runtime",
      body: { event_type: "input_requested", variable_id: variableId, clarification_id: clarificationId, question: question.slice(0, 1_200) }
    }).snapshot;
  }
  const pendingGoal = getGoal(input.binding.assignment_id);
  if (pendingGoal) persistWorkReturn(pendingGoal);
  return snapshot;
}

export function supplyAssignmentInputV2(input: Readonly<{
  binding: AssignmentKernelBindingInputV2;
  clarification_id: string;
  external_values: Readonly<Record<string, unknown>>;
  aliases?: AssignmentInputAliasRegistryV2;
}>): AssignmentSnapshotV2 {
  let snapshot = context(input.binding).snapshot;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(input.clarification_id.trim())) throw new Error("assignment_kernel_v2_clarification_id_invalid");
  const normalized = normalizeAssignmentInputsV2({ spec: snapshot.spec, external_values: input.external_values, aliases: input.aliases });
  if (Object.keys(normalized).length < 1) throw new Error("assignment_kernel_v2_input_value_required");
  for (const [variableId, value] of Object.entries(normalized)) {
    snapshot = appendCurrentAssignmentKernelEventV2({
      goal_id: input.binding.assignment_id,
      binding: snapshot.current_binding,
      event_id: `input-supplied:${input.clarification_id}:${variableId}:${digest(value)}`,
      actor: "authenticated-user",
      body: { event_type: "input_supplied", variable_id: variableId, clarification_id: input.clarification_id, value }
    }).snapshot;
  }
  const resumedGoal = getGoal(input.binding.assignment_id);
  if (resumedGoal) persistWorkReturn(resumedGoal);
  return snapshot;
}
