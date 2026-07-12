import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendGoalAction,
  appendGoalEvidence,
  appendGoalValidation,
  appendGoalProgress,
  clearAgentGoal,
  completeGoalAfterAudit,
  createGoal,
  formatActiveGoalContext,
  getActiveGoalForSession,
  markAgentGoalBlocked,
  markAgentGoalComplete,
  requestGoalCompletionAudit,
  setAgentGoal,
  transitionGoal,
  updateGoal
} from "../src/goals/service.js";
import { classifyAutoGoalRequest } from "../src/goals/auto_goal.js";

function withWorkspace<T>(fn: () => T): T {
  const prev = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-goals-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    return fn();
  } finally {
    if (typeof prev === "string") process.env.OPERATOR_WORKSPACE_ROOT = prev;
    else delete process.env.OPERATOR_WORKSPACE_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("goal creation persists typed core fields", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "Photometric Preflight",
      objective: "Audit lighting calculation readiness.",
      acceptance_criteria: ["Fixture families are discovered.", "IES references are checked."],
      related_session_id: "session-a",
      status: "active"
    });

    assert.equal(goal.status, "active");
    assert.equal(goal.acceptance_criteria.length, 2);
    assert.equal(getActiveGoalForSession("session-a")?.id, goal.id);
  });
});

test("goal status transitions enforce pause resume cancel behavior", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "Execute PDF Redlines",
      objective: "Apply selected redlines.",
      acceptance_criteria: ["Targets are identified."],
      status: "active"
    });

    const paused = transitionGoal(goal.id, "paused");
    assert.equal(paused.status, "paused");
    const resumed = transitionGoal(goal.id, "active");
    assert.equal(resumed.status, "active");
    const canceled = transitionGoal(goal.id, "canceled");
    assert.equal(canceled.status, "canceled");
    assert.throws(() => transitionGoal(goal.id, "active"), /Invalid goal status transition/);
  });
});

test("goal logs append action evidence and validation entries", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "Fire Alarm Coverage Check",
      objective: "Check coverage against rules.",
      acceptance_criteria: ["Applicable rooms are identified."],
      status: "active"
    });

    const afterAction = appendGoalAction(goal.id, { summary: "Listed rooms in scope." });
    assert.equal(afterAction.action_log.length, 1);
    const afterEvidence = appendGoalEvidence(goal.id, { summary: "Applicable rooms are identified.", artifact_paths: ["artifacts/reports/rooms.json"] });
    assert.equal(afterEvidence.evidence_log.length, 1);
    assert.deepEqual(afterEvidence.artifacts, ["artifacts/reports/rooms.json"]);
    const afterValidation = appendGoalValidation(goal.id, { summary: "Room list count matches expected scope." });
    assert.equal(afterValidation.validation_log.length, 1);
  });
});

test("goal work package persists bounded work items and assumptions across progress turns", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "Level 4 power plans",
      objective: "Complete the bounded Level 4 power-plan package.",
      acceptance_criteria: ["Every scoped view is inspected."],
      related_session_id: "session-package",
      status: "active",
      work_items: [
        { id: "resolve-views", title: "Resolve Level 4 power views", status: "complete", scope: { kind: "level", levels: ["L4"] }, planned_actions: ["list views"] },
        { id: "inspect-views", title: "Inspect resolved power views", status: "ready", depends_on: ["resolve-views"], planned_actions: ["bounded view inventory"] }
      ],
      assumptions: [{ id: "discipline", statement: "Use electrical power-plan views only.", status: "proposed", basis: "user objective" }]
    });
    assert.equal(goal.work_items.length, 2);
    assert.equal(goal.assumptions[0].status, "proposed");

    const progressed = appendGoalProgress("session-package", {
      summary: "Inspected the resolved views.",
      work_item: { id: "inspect-views", title: "Inspect resolved power views", status: "complete", depends_on: ["resolve-views"], evidence_refs: ["step:12"], result_summary: "Three views inspected." },
      assumption: { id: "discipline", statement: "Use electrical power-plan views only.", status: "accepted", basis: "resolved view metadata", evidence_refs: ["step:11"] }
    });
    assert.equal(progressed.work_items.find(item => item.id === "inspect-views")?.status, "complete");
    assert.equal(progressed.assumptions[0].status, "accepted");
    const context = formatActiveGoalContext(progressed);
    assert.match(context, /inspect-views \[complete\] Inspect resolved power views/);
    assert.match(context, /discipline \[accepted\] Use electrical power-plan views only/);
  });
});

test("completion audit refuses passing criteria while typed work items remain incomplete", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "Sheet package",
      objective: "Prepare two sheets.",
      acceptance_criteria: ["Sheet evidence is recorded."],
      status: "active",
      work_items: [{ id: "sheet-a", title: "Prepare sheet E401", status: "ready" }]
    });
    const first = requestGoalCompletionAudit(goal.id, { criteria_results: [{ criterion: "Sheet evidence is recorded.", status: "pass", evidence_refs: ["e:1"] }] });
    assert.equal(first.completion_audit?.complete, false);
    assert.deepEqual(first.completion_audit?.remaining_work, ["Prepare sheet E401"]);
    updateGoal(goal.id, { work_items: [{ id: "sheet-a", title: "Prepare sheet E401", status: "complete", evidence_refs: ["e:1"] }] });
    const second = requestGoalCompletionAudit(goal.id, { criteria_results: [{ criterion: "Sheet evidence is recorded.", status: "pass", evidence_refs: ["e:1"] }] });
    assert.equal(second.completion_audit?.complete, true);
  });
});

test("goal work package rejects malformed and duplicate bounded entries", () => {
  withWorkspace(() => {
    const base = { title: "Bounded package", objective: "Validate package bounds.", acceptance_criteria: ["Package is valid."] };
    assert.throws(() => createGoal({ ...base, work_items: {} }), /work_items must be an array/);
    assert.throws(() => createGoal({ ...base, work_items: [{ id: "same", title: "A" }, { id: "same", title: "B" }] }), /Duplicate work_items id/);
    assert.throws(() => createGoal({ ...base, assumptions: [{ id: "a", statement: "" }] }), /statement is required/);
    assert.throws(() => createGoal({ ...base, work_items: new Array(201).fill(null).map((_, i) => ({ id: `w-${i}`, title: `Work ${i}` })) }), /at most 200/);
  });
});

test("completion audit refuses incomplete goals", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "Model Audit",
      objective: "Audit the model.",
      acceptance_criteria: ["Warnings are summarized.", "Report artifact is produced."],
      status: "active"
    });

    const audited = requestGoalCompletionAudit(goal.id, {
      criteria_results: [
        { criterion: "Warnings are summarized.", status: "pass", evidence_refs: ["validation:1"] },
        { criterion: "Report artifact is produced.", status: "unknown", evidence_refs: [] }
      ]
    });
    assert.equal(audited.completion_audit?.complete, false);
    assert.throws(() => completeGoalAfterAudit(goal.id), /completion audit passes/);
  });
});

test("completion audit allows completion only when all criteria pass", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "Cleanup",
      objective: "Clean model safely.",
      acceptance_criteria: ["Changes are validated.", "Evidence is attached."],
      status: "active"
    });

    const audited = requestGoalCompletionAudit(goal.id, {
      criteria_results: [
        { criterion: "Changes are validated.", status: "pass", evidence_refs: ["validation:1"] },
        { criterion: "Evidence is attached.", status: "pass", evidence_refs: ["evidence:1"] }
      ]
    });
    assert.equal(audited.completion_audit?.complete, true);
    const completed = completeGoalAfterAudit(goal.id);
    assert.equal(completed.status, "complete");
    assert.throws(() => updateGoal(goal.id, { progress_summary: "resume" }), /Cannot edit a complete goal/);
  });
});

test("agent goal facade supports set progress block clear lifecycle", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-native", {
      objective: "Add receptacles where marked.",
      success_criteria: ["Placement is attempted.", "Placement is verified."],
      current_step: "observe"
    });
    assert.equal(goal.status, "active");
    assert.equal(getActiveGoalForSession("session-native")?.id, goal.id);

    const progressed = appendGoalProgress("session-native", {
      observation: { activeView: "Level 1" },
      action: { tool: "spatial-context" },
      result: "room context gathered"
    });
    assert.equal(progressed.action_log.length, 1);

    const blocked = markAgentGoalBlocked("session-native", "Unknown destructive dialog.", { dialog_id: "TaskDialog_Example" });
    assert.equal(blocked.status, "blocked");
    const cleared = clearAgentGoal("session-native");
    assert.equal(cleared?.status, "canceled");
  });
});

test("agent goal facade can complete with supplied evidence", () => {
  withWorkspace(() => {
    setAgentGoal("session-complete", {
      objective: "Verify native capture.",
      success_criteria: ["Capture exists."]
    });
    const completed = markAgentGoalComplete("session-complete", { capturePath: "artifacts/captures/a.png" });
    assert.equal(completed.status, "complete");
  });
});

test("auto goal classifier enters goal mode for spatial redline outcomes", () => {
  const decision = classifyAutoGoalRequest("Add receptacles where marked in these redlines and verify the placement.");
  assert.equal(decision.shouldStart, true);
  assert.ok(decision.signals.length >= 2);

  const single = classifyAutoGoalRequest("Open sheet E101.");
  assert.equal(single.shouldStart, false);
});
