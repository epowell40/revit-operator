import type { AssignmentCriterionRecord, AssignmentOutcomeState } from "./control_plane.js";
import type { GoalWorkItem } from "../goals/service.js";

export type DeviationDecision = {
  allowed_without_advance_clarification: boolean;
  outcome: "within_envelope" | "awaiting_user_review" | "awaiting_user_input";
  reason: string;
};

export function deriveProgressiveOutcome(input: {
  criteria: readonly AssignmentCriterionRecord[];
  pendingClarification: boolean;
  pendingReview: boolean;
  autonomousProgressAvailable: boolean;
  usefulWorkRetained: boolean;
}): AssignmentOutcomeState {
  if (input.pendingClarification || input.criteria.some(criterion => criterion.state === "needs_input")) return "awaiting_user_input";
  if (input.pendingReview || input.criteria.some(criterion => criterion.state === "needs_review")) return "awaiting_user_review";
  if (input.criteria.length > 0 && input.criteria.every(criterion => criterion.state === "pass" || criterion.state === "not_applicable")) return "complete";
  if (!input.autonomousProgressAvailable && input.usefulWorkRetained
      && input.criteria.some(criterion => criterion.state === "partial" || criterion.state === "uncertain" || criterion.state === "failed")) {
    return "complete_with_issues";
  }
  return "active";
}

export function retainedWorkUnits(workItems: readonly GoalWorkItem[]): GoalWorkItem[] {
  return workItems.filter(item => item.status === "complete" && item.independently_useful && item.safe_to_retain);
}

export function rollbackScopeForFailure(workItems: readonly GoalWorkItem[], failedWorkUnitId: string): string[] {
  const failed = workItems.find(item => item.id === failedWorkUnitId);
  if (!failed) throw new Error("progressive_work_unit_not_found");
  if (failed.rollback_scope === "assignment") return workItems.map(item => item.id);
  if (failed.execution_class === "coupled_atomic" || failed.rollback_scope === "atomic_group") {
    if (!failed.atomic_group_id) throw new Error("coupled_work_unit_atomic_group_missing");
    return workItems.filter(item => item.atomic_group_id === failed.atomic_group_id).map(item => item.id);
  }
  return failed.rollback_scope === "work_unit" ? [failed.id] : [];
}

export function evaluateBoundedDeviation(input: {
  taskAllowsJudgment: boolean;
  sameSemanticScope: boolean;
  sameHost: boolean;
  withinTolerance: boolean;
  safetyOrCodeUncertain: boolean;
  reversible: boolean;
}): DeviationDecision {
  if (input.safetyOrCodeUncertain) return {
    allowed_without_advance_clarification: false,
    outcome: "awaiting_user_input",
    reason: "safety_or_code_judgment_requires_user_direction"
  };
  if (!input.taskAllowsJudgment || !input.sameSemanticScope || !input.sameHost || !input.withinTolerance || !input.reversible) return {
    allowed_without_advance_clarification: false,
    outcome: "awaiting_user_input",
    reason: !input.sameHost ? "alternative_changes_host" : !input.sameSemanticScope ? "alternative_leaves_semantic_scope"
      : !input.withinTolerance ? "alternative_exceeds_tolerance" : !input.reversible ? "alternative_not_reversible" : "task_does_not_authorize_deviation"
  };
  return {
    allowed_without_advance_clarification: true,
    outcome: "awaiting_user_review",
    reason: "bounded_reversible_deviation_retained_for_review"
  };
}
