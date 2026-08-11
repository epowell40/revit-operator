import assert from "node:assert/strict";
import test from "node:test";
import type { GoalRecord, GoalWorkItem } from "../src/goals/service.js";
import {
  ASSIGNMENT_PROJECTION_SCHEMA,
  buildAssignmentProjection,
  projectGoalAssignment,
  projectTaskAssignment
} from "../src/assignments/projection.js";

const CREATED_AT = "2026-08-11T12:00:00.000Z";

function workItem(id: string, status: GoalWorkItem["status"]): GoalWorkItem {
  return {
    id,
    title: `Step ${id}`,
    status,
    scope: null,
    depends_on: [],
    planned_actions: [],
    evidence_refs: [],
    blocker: status === "blocked" ? "Needs user input" : null,
    result_summary: status === "complete" ? "Done" : null,
    updated_at: CREATED_AT
  };
}

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: "goal-1",
    title: "Audit the model",
    objective: "Count and classify air devices",
    acceptance_criteria: ["Report an authoritative count"],
    non_goals: [],
    created_at: CREATED_AT,
    updated_at: "2026-08-11T12:05:00.000Z",
    status: "active",
    current_phase: "verifying",
    current_step: "Read back totals",
    progress_summary: "Checking the schedule totals",
    work_budget: {},
    work_items: [],
    assumptions: [],
    evidence_log: [],
    action_log: [],
    validation_log: [],
    related_session_id: "session-1",
    artifacts: [],
    ...overrides
  };
}

test("goal projection exposes canonical lifecycle and checkpoint-derived progress", () => {
  const assignment = projectGoalAssignment(goal({
    work_items: [workItem("inspect", "complete"), workItem("verify", "in_progress"), workItem("report", "pending")]
  }));

  assert.equal(assignment.schema, ASSIGNMENT_PROJECTION_SCHEMA);
  assert.equal(assignment.lifecycle.phase, "verifying");
  assert.deepEqual(assignment.progress, {
    determinate: true,
    total: 3,
    completed: 1,
    active: 1,
    pending: 1,
    blocked: 0,
    failed: 0,
    skipped: 0,
    ratio: 1 / 3
  });
  assert.deepEqual(assignment.truth, {
    stale: null,
    outcome_uncertain: null,
    reconciliation_required: null
  });
});

test("projection does not manufacture a percentage when no checkpoints exist", () => {
  const assignment = projectGoalAssignment(goal());
  assert.deepEqual(assignment.progress, {
    determinate: false,
    total: null,
    completed: null,
    active: null,
    pending: null,
    blocked: null,
    failed: null,
    skipped: null,
    ratio: null
  });
});

test("task projection preserves preview approval, target binding, effects, and uncertain truth", () => {
  const assignment = projectTaskAssignment({
    id: "task-1",
    title: "Place devices",
    status: "awaiting_approval",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    executor_kind: "revit_delegate",
    source: {
      backend_surface: "revit_batch",
      session_id: "session-1",
      user_request: "Place two air terminals",
      target_context: {
        project_id: "project-1",
        project_fingerprint: "fingerprint-1",
        document_title: "Snowdon Towers Sample HVAC"
      }
    },
    plan: {
      approval: {
        required: true,
        preview_hash: `sha256:${"a".repeat(64)}`,
        preview_binding_schema: "revit-operator.batch-preview-binding.v1",
        preview_hash_verified: true
      },
      preview_items: [{ action: "create", category: "Air Terminals" }]
    },
    progress: { total: 2, succeeded: 0, running: 0, pending: 2, failed: 0, skipped: 0 },
    result: {
      reconciliation_required: true,
      outcome_uncertain: true,
      stale: true,
      effect_summary: { create_count: 2, created_ids: ["101", "102"] }
    },
    evidence: { output_paths: ["Workspace/artifacts/report.csv"] },
    artifacts: { workspace_paths: ["Workspace/artifacts/report.csv"] },
    related: { batch_job_id: "batch-1" },
    verification: { status: "unknown", evidence_paths: [], notes: [] },
    events: []
  });

  assert.equal(assignment.lifecycle.phase, "awaiting_approval");
  assert.equal(assignment.approvals[0]?.status, "awaiting");
  assert.equal(assignment.approvals[0]?.preview_hash, `sha256:${"a".repeat(64)}`);
  assert.equal(assignment.approvals[0]?.binding_status, "bound");
  assert.equal(assignment.target.document_fingerprint, "fingerprint-1");
  assert.deepEqual(assignment.effects.created_ids, ["101", "102"]);
  assert.deepEqual(assignment.truth, {
    stale: true,
    outcome_uncertain: true,
    reconciliation_required: true
  });
  assert.equal(assignment.artifacts[0]?.role, "deliverable");
});

test("task projection never calls an unverified caller-supplied preview hash bound", () => {
  const assignment = projectTaskAssignment({
    id: "task-forged-preview", title: "Forged preview", status: "awaiting_approval",
    created_at: CREATED_AT, updated_at: CREATED_AT,
    source: { backend_surface: "caller" },
    plan: { approval: { required: true, preview_hash: `sha256:${"b".repeat(64)}` } },
    progress: {}, result: {}, evidence: {}, artifacts: {}, related: {}, verification: {}, events: []
  });
  assert.equal(assignment.approvals[0]?.binding_status, "unbound");
});

test("only explicit goal relations merge Task and Goal records", () => {
  const linkedTask = {
    id: "task-linked",
    title: "Execute batch",
    status: "running",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    source: { session_id: "session-1" },
    related: { goal_id: "goal-1", batch_job_id: "batch-linked" },
    progress: { total: 4, succeeded: 1, running: 1, pending: 2, failed: 0, skipped: 0 },
    verification: {},
    result: {},
    evidence: {},
    artifacts: {},
    events: []
  };
  const sameSessionButUnlinked = {
    ...linkedTask,
    id: "task-unlinked",
    related: { batch_job_id: "batch-unlinked" }
  };

  const assignments = buildAssignmentProjection([goal()], [linkedTask, sameSessionButUnlinked]);
  assert.equal(assignments.length, 2);
  const projectedGoal = assignments.find(value => value.id === "goal:goal-1");
  assert.deepEqual(projectedGoal?.execution.task_ids, ["task-linked"]);
  assert.deepEqual(projectedGoal?.execution.batch_job_ids, ["batch-linked"]);
  assert.equal(projectedGoal?.progress.total, 4);
  assert.ok(assignments.some(value => value.id === "task:task-unlinked"));
});
