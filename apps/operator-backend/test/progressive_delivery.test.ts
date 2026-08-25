import assert from "node:assert/strict";
import test from "node:test";

import { deriveProgressiveOutcome, evaluateBoundedDeviation, retainedWorkUnits, rollbackScopeForFailure } from "../src/assignments/progressive_delivery.js";
import type { AssignmentCriterionRecord } from "../src/assignments/control_plane.js";
import type { GoalWorkItem } from "../src/goals/service.js";

function item(id: string, options: Partial<GoalWorkItem> = {}): GoalWorkItem {
  return {
    id, title: id, status: "pending", scope: null, depends_on: [], planned_actions: [], evidence_refs: [],
    blocker: null, result_summary: null, updated_at: "2026-08-24T00:00:00.000Z",
    execution_class: "independent_safe_to_keep", atomic_group_id: null, independently_useful: true,
    safe_to_retain: true, rollback_scope: "none", verification_method: null,
    unresolved_decision_variables: [], deviation_envelope: null, acceptance_criteria: [], attempt_ids: [], primary_artifact_refs: [],
    ...options
  };
}

function criterion(id: string, state: AssignmentCriterionRecord["state"]): AssignmentCriterionRecord {
  return { criterion_id: id, criterion: id, state, reason: "", evidence_refs: [], work_unit_ids: [], updated_at: "2026-08-24T00:00:00.000Z", updated_by: "test" };
}

test("eight independent results survive while two criteria await clarification", () => {
  const work = Array.from({ length: 10 }, (_, index) => item(`redline-${index + 1}`, {
    status: index < 8 ? "complete" : "blocked",
    blocker: index < 8 ? null : "required_input_missing"
  }));
  assert.equal(retainedWorkUnits(work).length, 8);
  assert.equal(deriveProgressiveOutcome({
    criteria: [...Array.from({ length: 8 }, (_, index) => criterion(`c${index}`, "pass")), criterion("c8", "needs_input"), criterion("c9", "needs_input")],
    pendingClarification: true, pendingReview: false, autonomousProgressAvailable: false, usefulWorkRetained: true
  }), "awaiting_user_input");
});

test("a coupled failure rolls back only its atomic group and retains an unrelated schedule edit", () => {
  const work = [
    item("schedule", { status: "complete", primary_artifact_refs: ["schedule:Air Devices"] }),
    item("reroute-a", { status: "complete", execution_class: "coupled_atomic", atomic_group_id: "reroute", safe_to_retain: false, rollback_scope: "atomic_group" }),
    item("reroute-b", { status: "failed", execution_class: "coupled_atomic", atomic_group_id: "reroute", safe_to_retain: false, rollback_scope: "atomic_group" })
  ];
  assert.deepEqual(rollbackScopeForFailure(work, "reroute-b"), ["reroute-a", "reroute-b"]);
  assert.deepEqual(retainedWorkUnits(work).map(entry => entry.id), ["schedule"]);
});

test("bounded deviations retain only reversible same-host alternatives inside tolerance", () => {
  assert.deepEqual(evaluateBoundedDeviation({
    taskAllowsJudgment: true, sameSemanticScope: true, sameHost: true, withinTolerance: true,
    safetyOrCodeUncertain: false, reversible: true
  }), {
    allowed_without_advance_clarification: true,
    outcome: "awaiting_user_review",
    reason: "bounded_reversible_deviation_retained_for_review"
  });
  assert.equal(evaluateBoundedDeviation({
    taskAllowsJudgment: true, sameSemanticScope: true, sameHost: false, withinTolerance: true,
    safetyOrCodeUncertain: false, reversible: true
  }).reason, "alternative_changes_host");
  assert.equal(evaluateBoundedDeviation({
    taskAllowsJudgment: true, sameSemanticScope: true, sameHost: true, withinTolerance: false,
    safetyOrCodeUncertain: false, reversible: true
  }).outcome, "awaiting_user_input");
  assert.equal(evaluateBoundedDeviation({
    taskAllowsJudgment: true, sameSemanticScope: true, sameHost: true, withinTolerance: true,
    safetyOrCodeUncertain: true, reversible: true
  }).reason, "safety_or_code_judgment_requires_user_direction");
});

test("partial work is never derived as complete", () => {
  assert.equal(deriveProgressiveOutcome({
    criteria: [criterion("placed", "pass"), criterion("second", "failed")],
    pendingClarification: false, pendingReview: false, autonomousProgressAvailable: false, usefulWorkRetained: true
  }), "complete_with_issues");
  assert.equal(deriveProgressiveOutcome({
    criteria: [criterion("all", "pass")], pendingClarification: false, pendingReview: false,
    autonomousProgressAvailable: false, usefulWorkRetained: true
  }), "complete");
});
