import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function createWorkspaceArtifact(relativePath: string, contents: string): { path: string; sha256: string; fullPath: string } {
  const root = process.env.OPERATOR_WORKSPACE_ROOT!;
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents, "utf8");
  return {
    path: relativePath.replaceAll("\\", "/"),
    sha256: createHash("sha256").update(contents).digest("hex"),
    fullPath
  };
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
    const artifact = createWorkspaceArtifact("artifacts/sheets/e401.json", JSON.stringify({ sheet: "E401" }));
    const evidence = appendGoalEvidence(goal.id, {
      summary: "Persisted E401 sheet receipt.",
      evidence: {
        kind: "artifact",
        criterion: "Sheet evidence is recorded.",
        artifact: { path: artifact.path, sha256: artifact.sha256, scope: "workspace" }
      }
    });
    const evidenceId = evidence.evidence_log.at(-1)!.id;
    const first = requestGoalCompletionAudit(goal.id, { criteria_results: [{ criterion: "Sheet evidence is recorded.", status: "pass", evidence_refs: [`evidence:${evidenceId}`] }] });
    assert.equal(first.completion_audit?.complete, false);
    assert.deepEqual(first.completion_audit?.remaining_work, ["Prepare sheet E401"]);
    updateGoal(goal.id, { work_items: [{ id: "sheet-a", title: "Prepare sheet E401", status: "complete", evidence_refs: ["e:1"] }] });
    const second = requestGoalCompletionAudit(goal.id, { criteria_results: [{ criterion: "Sheet evidence is recorded.", status: "pass", evidence_refs: [`evidence:${evidenceId}`] }] });
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

test("completion audit allows completion only when every criterion has canonical typed evidence", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "Cleanup",
      objective: "Clean model safely.",
      acceptance_criteria: ["Changes are validated.", "Evidence is attached.", "Local review is approved."],
      status: "active"
    });

    const changeValidation = appendGoalValidation(goal.id, {
      summary: "Focused test run finished.",
      evidence: {
        kind: "validator",
        criterion: "Changes are validated.",
        validator: { identity: "node:test", method: "node --test dist/test/goals_service.test.js", status: "pass" }
      }
    });
    const changeValidationId = changeValidation.validation_log.at(-1)!.id;
    const artifact = createWorkspaceArtifact("artifacts/audit/report.json", JSON.stringify({ result: "pass" }));
    const evidence = appendGoalEvidence(goal.id, {
      summary: "Audit report persisted.",
      evidence: {
        kind: "artifact",
        criterion: "Evidence is attached.",
        artifact: { path: artifact.path, sha256: artifact.sha256, scope: "workspace" }
      }
    });
    const evidenceId = evidence.evidence_log.at(-1)!.id;
    const approval = appendGoalEvidence(goal.id, {
      summary: "Local review decision persisted.",
      evidence: {
        kind: "human_approval",
        criterion: "Local review is approved.",
        approval: { approver_identity: "local-operator", method: "manual Sidecar review", status: "approved" }
      }
    });
    const approvalId = approval.evidence_log.at(-1)!.id;
    const audited = requestGoalCompletionAudit(goal.id, {
      criteria_results: [
        { criterion: "Changes are validated.", status: "pass", evidence_refs: [`validation:${changeValidationId}`] },
        { criterion: "Evidence is attached.", status: "pass", evidence_refs: [`evidence:${evidenceId}`] },
        { criterion: "Local review is approved.", status: "pass", evidence_refs: [`evidence:${approvalId}`] }
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

test("completion audit rejects caller-declared passes without persisted evidence", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-fabricated-complete", {
      objective: "Verify native capture and validation.",
      success_criteria: ["Capture exists.", "Validation passes."]
    });
    const audited = requestGoalCompletionAudit(goal.id, {
      criteria_results: goal.acceptance_criteria.map(criterion => ({
        criterion,
        status: "pass",
        evidence_refs: ["caller says this passed"]
      })),
      evidence_summary: "Everything passed."
    });
    assert.equal(audited.completion_audit?.complete, false);
    assert.deepEqual(audited.completion_audit?.criteria_results.map(result => result.status), ["unknown", "unknown"]);
    assert.throws(() => completeGoalAfterAudit(goal.id), /completion audit passes/);
  });
});

test("generic update and transition paths cannot bypass the completion audit", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "No completion bypass",
      objective: "Require the audited completion path.",
      acceptance_criteria: ["Evidence is verified."],
      status: "active"
    });
    assert.throws(() => updateGoal(goal.id, { status: "complete" }), /Invalid goal status transition/);
    assert.throws(() => transitionGoal(goal.id, "complete"), /Invalid goal status transition/);
  });
});

test("criterion text copied into prose or legacy details is never completion evidence", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-prose-evidence", {
      objective: "Verify capture without trusting prose.",
      success_criteria: ["Capture exists."]
    });
    const note = appendGoalEvidence(goal.id, {
      summary: "Capture exists.",
      details: { criterion: "Capture exists.", status: "pass" },
      artifact_paths: ["artifacts/captures/nonexistent.png"]
    });
    const noteId = note.evidence_log.at(-1)!.id;
    const audited = requestGoalCompletionAudit(goal.id, {
      criteria_results: [{ criterion: "Capture exists.", status: "pass", evidence_refs: [`evidence:${noteId}`] }]
    });
    assert.equal(audited.completion_audit?.complete, false);
    assert.equal(audited.completion_audit?.criteria_results[0].status, "unknown");
  });
});

test("artifact evidence requires workspace scope, existence, and a matching SHA-256 at append and audit time", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-artifact-integrity", {
      objective: "Verify a hash-bound report.",
      success_criteria: ["Report artifact is verified."]
    });
    const missingHash = "0".repeat(64);
    assert.throws(
      () => appendGoalEvidence(goal.id, {
        summary: "Missing report.",
        evidence: {
          kind: "artifact",
          criterion: "Report artifact is verified.",
          artifact: { path: "artifacts/reports/missing.json", sha256: missingHash, scope: "workspace" }
        }
      }),
      /does not exist/
    );

    const artifact = createWorkspaceArtifact("artifacts/reports/report.json", JSON.stringify({ count: 3 }));
    assert.throws(
      () => appendGoalEvidence(goal.id, {
        summary: "Hash-mismatched report.",
        evidence: {
          kind: "artifact",
          criterion: "Report artifact is verified.",
          artifact: { path: artifact.path, sha256: missingHash, scope: "workspace" }
        }
      }),
      /SHA-256 mismatch/
    );
    assert.throws(
      () => appendGoalEvidence(goal.id, {
        summary: "Unscoped report.",
        evidence: {
          kind: "artifact",
          criterion: "Report artifact is verified.",
          artifact: { path: artifact.path, sha256: artifact.sha256, scope: "host" }
        }
      }),
      /scope must be 'workspace'/
    );

    const persisted = appendGoalEvidence(goal.id, {
      summary: "Hash-bound report persisted.",
      evidence: {
        kind: "artifact",
        criterion: "Report artifact is verified.",
        artifact: { path: artifact.path, sha256: artifact.sha256, scope: "workspace" }
      }
    });
    const entry = persisted.evidence_log.at(-1)!;
    assert.equal(entry.evidence?.kind, "artifact");
    if (entry.evidence?.kind === "artifact") {
      assert.equal(entry.evidence.artifact.sha256, artifact.sha256);
      assert.equal(entry.evidence.artifact.scope, "workspace");
      assert.ok(entry.evidence.artifact.size_bytes > 0);
    }
    const audited = requestGoalCompletionAudit(goal.id, {
      criteria_results: [{ criterion: "Report artifact is verified.", status: "pass", evidence_refs: [`evidence:${entry.id}`] }]
    });
    assert.equal(audited.completion_audit?.complete, true);
    fs.writeFileSync(artifact.fullPath, JSON.stringify({ count: 4 }), "utf8");
    assert.throws(() => completeGoalAfterAudit(goal.id), /no longer passes verification/);
    const refreshed = getActiveGoalForSession("session-artifact-integrity");
    assert.equal(refreshed?.completion_audit?.complete, false);
    assert.equal(refreshed?.completion_audit?.criteria_results[0].status, "fail");
  });
});

test("unknown or failed validators cannot complete and verifier identity and method are mandatory", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-validator-results", {
      objective: "Require explicit validator outcomes.",
      success_criteria: ["Static validation passes.", "Runtime validation passes."]
    });
    assert.throws(
      () => appendGoalValidation(goal.id, {
        summary: "Anonymous validator result.",
        evidence: {
          kind: "validator",
          criterion: "Static validation passes.",
          validator: { identity: "", method: "npm test", status: "pass" }
        }
      }),
      /validator.identity/
    );
    const unknown = appendGoalValidation(goal.id, {
      summary: "Static validator had no conclusive result.",
      evidence: {
        kind: "validator",
        criterion: "Static validation passes.",
        validator: { identity: "typescript-compiler", method: "npm run build", status: "unknown" }
      }
    }).validation_log.at(-1)!;
    const failed = appendGoalValidation(goal.id, {
      summary: "Runtime validator failed.",
      evidence: {
        kind: "validator",
        criterion: "Runtime validation passes.",
        validator: { identity: "node-test-runner", method: "node --test goals_service", status: "fail" }
      }
    }).validation_log.at(-1)!;
    const audited = requestGoalCompletionAudit(goal.id, {
      criteria_results: [
        { criterion: "Static validation passes.", status: "pass", evidence_refs: [`validation:${unknown.id}`] },
        { criterion: "Runtime validation passes.", status: "pass", evidence_refs: [`validation:${failed.id}`] }
      ]
    });
    assert.equal(audited.completion_audit?.complete, false);
    assert.deepEqual(audited.completion_audit?.criteria_results.map(result => result.status), ["unknown", "fail"]);
  });
});

test("completion audit does not reuse unrelated evidence across criteria", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-unrelated-evidence", {
      objective: "Verify capture and validation independently.",
      success_criteria: ["Capture exists.", "Validation passes."]
    });
    const artifact = createWorkspaceArtifact("artifacts/captures/a.png", "png receipt");
    const withCapture = appendGoalEvidence(goal.id, {
      summary: "Capture receipt persisted.",
      evidence: {
        kind: "artifact",
        criterion: "Capture exists.",
        artifact: { path: artifact.path, sha256: artifact.sha256, scope: "workspace" }
      }
    });
    const evidenceId = withCapture.evidence_log.at(-1)!.id;
    const audited = requestGoalCompletionAudit(goal.id, {
      criteria_results: goal.acceptance_criteria.map(criterion => ({
        criterion,
        status: "pass",
        evidence_refs: [`evidence:${evidenceId}`]
      }))
    });
    assert.equal(audited.completion_audit?.complete, false);
    assert.deepEqual(audited.completion_audit?.criteria_results.map(result => result.status), ["pass", "unknown"]);
  });
});

test("agent goal facade completes only with criterion-linked persisted evidence", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-complete", {
      objective: "Verify native capture.",
      success_criteria: ["Capture exists."]
    });
    assert.throws(
      () => markAgentGoalComplete("session-complete", { evidence_summary: "Capture exists because the caller says so." }),
      /completion audit passes/
    );
    const artifact = createWorkspaceArtifact("artifacts/captures/a.png", "verified capture bytes");
    const withEvidence = appendGoalEvidence(goal.id, {
      summary: "Capture receipt persisted.",
      evidence: {
        kind: "artifact",
        criterion: "Capture exists.",
        artifact: { path: artifact.path, sha256: artifact.sha256, scope: "workspace" }
      }
    });
    const evidenceId = withEvidence.evidence_log.at(-1)!.id;
    const completed = markAgentGoalComplete("session-complete", {
      criteria_results: [{ criterion: "Capture exists.", status: "pass", evidence_refs: [`evidence:${evidenceId}`] }],
      evidence_summary: "Capture artifact is persisted."
    });
    assert.equal(completed.status, "complete");
  });
});

test("session-specific goal lookup never falls back to an unbound goal", () => {
  withWorkspace(() => {
    const unbound = createGoal({
      title: "Unbound maintenance goal",
      objective: "Remain outside agent sessions.",
      acceptance_criteria: ["Maintenance is recorded."],
      status: "active"
    });
    assert.equal(getActiveGoalForSession()?.id, unbound.id);
    assert.equal(getActiveGoalForSession("different-session"), null);
    assert.equal(clearAgentGoal("different-session"), null);
    assert.equal(getActiveGoalForSession()?.id, unbound.id);
  });
});

test("auto goal classifier enters goal mode for spatial redline outcomes", () => {
  const decision = classifyAutoGoalRequest("Add receptacles where marked in these redlines and verify the placement.");
  assert.equal(decision.shouldStart, true);
  assert.ok(decision.signals.length >= 2);

  const single = classifyAutoGoalRequest("Open sheet E101.");
  assert.equal(single.shouldStart, false);
});
