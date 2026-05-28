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
