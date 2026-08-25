import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  __testOnlyResetGoalListCache,
  appendGoalAction,
  appendGoalEvidence,
  appendGoalValidation,
  appendGoalProgress,
  clearAgentGoal,
  completeGoalAfterAudit,
  configureGoalEvidenceAuthorityProvider,
  createGoal,
  formatActiveGoalContext,
  getActiveGoalForSession,
  getGoal,
  getCurrentGoalForSession,
  listGoals,
  markAgentGoalBlocked,
  markAgentGoalComplete,
  requestGoalCompletionAudit,
  setAgentGoal,
  transitionGoal,
  updateGoal,
  type GoalRecord
} from "../src/goals/service.js";
import { classifyAutoGoalRequest } from "../src/goals/auto_goal.js";
import { completeAutoGoalFromValidatedTurn, createAutoGoalTurnObserver, findInterruptedAutoGoalForSession, recordAutoGoalToolObservation, settleSidecarComputerGoal, supersedeBlockedAutoGoalForFreshRequest } from "../src/goals/auto_goal_runtime.js";
import { reconcileTeammateReceiptWithAssistant } from "../src/teammate_loop_runtime.js";
import { ensureAssignmentRunForTurn, journalAssignmentActions, journalAssignmentToolResults } from "../src/assignments/turn_journal.js";
import { normalizeAssignmentControlPlane, reduceAssignmentControlPlane } from "../src/assignments/control_plane.js";
import {
  createDefaultLocalGoalEvidenceAuthority,
  createLocalGoalEvidenceAuthority,
  type LocalGoalEvidenceAuthority
} from "../src/goals/authority.js";

const TEST_AUTHORITY_SECRET = "goal-authority-unit-test-secret-32-bytes-minimum";

function withWorkspace<T>(fn: (authority: LocalGoalEvidenceAuthority) => T): T {
  const prev = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-goals-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const authority = createLocalGoalEvidenceAuthority({ secret: TEST_AUTHORITY_SECRET });
  configureGoalEvidenceAuthorityProvider(authority);
  try {
    return fn(authority);
  } finally {
    configureGoalEvidenceAuthorityProvider(null);
    if (typeof prev === "string") process.env.OPERATOR_WORKSPACE_ROOT = prev;
    else delete process.env.OPERATOR_WORKSPACE_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function authorityContext(goal: GoalRecord, criterion: string) {
  return {
    goal_id: goal.id,
    session_id: goal.related_session_id ?? null,
    criterion,
    goal_owner_principal_id: goal.created_by ?? null
  };
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

test("repeated goal listings reuse durable records and observe in-process creates and updates", () => {
  withWorkspace(() => {
    __testOnlyResetGoalListCache();
    for (let index = 0; index < 200; index += 1) {
      createGoal({
        title: `Cached goal ${index}`,
        objective: "Exercise durable goal listing.",
        acceptance_criteria: ["The record remains visible."],
        status: "active"
      });
    }
    const originalReadFileSync = fs.readFileSync;
    let goalReads = 0;
    try {
      fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
        if (`${args[0]}`.includes(`${path.sep}artifacts${path.sep}goals${path.sep}`)
          && `${args[0]}`.endsWith(`${path.sep}goal.json`)) goalReads += 1;
        return originalReadFileSync(...args as [fs.PathOrFileDescriptor, BufferEncoding]);
      }) as typeof fs.readFileSync;
      assert.equal(listGoals(200).length, 200);
      assert.ok(goalReads >= 200);
      goalReads = 0;
      for (let index = 0; index < 20; index += 1) assert.equal(listGoals(200).length, 200);
      assert.equal(goalReads, 0);

      const created = createGoal({
        title: "New cached goal",
        objective: "Appear without a historical rescan.",
        acceptance_criteria: ["The new goal is listed."],
        status: "active"
      });
      const updated = updateGoal(created.id, { progress_summary: "Observed update." });
      goalReads = 0;
      assert.equal(listGoals(200).find(goal => goal.id === created.id)?.revision, updated.revision);
      assert.equal(goalReads, 0);
    } finally {
      fs.readFileSync = originalReadFileSync;
      __testOnlyResetGoalListCache();
    }
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
  withWorkspace(authority => {
    const goal = createGoal({
      title: "Cleanup",
      objective: "Clean model safely.",
      acceptance_criteria: ["Changes are validated.", "Evidence is attached.", "Local review is approved."],
      created_by: "goal-owner",
      status: "active"
    });

    const changeValidation = appendGoalValidation(goal.id, {
      summary: "Focused test run finished.",
      evidence: {
        kind: "validator",
        criterion: "Changes are validated.",
        validator: {
          authority: authority.issueValidatorExecutionReceipt({
            ...authorityContext(goal, "Changes are validated."),
            validator_id: "node:test",
            method: "node --test dist/test/goals_service.test.js",
            status: "pass"
          })
        }
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
        approval: {
          authority: authority.issueHumanApproval({
            ...authorityContext(goal, "Local review is approved."),
            authenticated_principal: { principal_id: "local-operator", roles: ["goal_approver"] },
            method: "manual Sidecar review",
            status: "approved"
          })
        }
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

test("unknown or failed trusted validator receipts cannot complete", () => {
  withWorkspace(authority => {
    const goal = setAgentGoal("session-validator-results", {
      objective: "Require explicit validator outcomes.",
      success_criteria: ["Static validation passes.", "Runtime validation passes."]
    });
    assert.throws(
      () => appendGoalValidation(goal.id, {
        summary: "Caller-attested validator result.",
        evidence: {
          kind: "validator",
          criterion: "Static validation passes.",
          validator: { identity: "", method: "npm test", status: "pass" }
        }
      }),
      /trusted server-issued execution receipt/
    );
    const unknown = appendGoalValidation(goal.id, {
      summary: "Static validator had no conclusive result.",
      evidence: {
        kind: "validator",
        criterion: "Static validation passes.",
        validator: {
          authority: authority.issueValidatorExecutionReceipt({
            ...authorityContext(goal, "Static validation passes."),
            validator_id: "typescript-compiler",
            method: "npm run build",
            status: "unknown"
          })
        }
      }
    }).validation_log.at(-1)!;
    const failed = appendGoalValidation(goal.id, {
      summary: "Runtime validator failed.",
      evidence: {
        kind: "validator",
        criterion: "Runtime validation passes.",
        validator: {
          authority: authority.issueValidatorExecutionReceipt({
            ...authorityContext(goal, "Runtime validation passes."),
            validator_id: "node-test-runner",
            method: "node --test goals_service",
            status: "fail"
          })
        }
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

test("caller-forged validator passes and human approvals are rejected", () => {
  withWorkspace(authority => {
    const goal = createGoal({
      title: "Reject caller authority claims",
      objective: "Accept only independently verified authority evidence.",
      acceptance_criteria: ["Validation passes.", "Review is approved."],
      created_by: "alice",
      related_session_id: "session-forgery",
      status: "active"
    });
    assert.throws(() => appendGoalValidation(goal.id, {
      summary: "Caller claims the validator passed.",
      evidence: {
        kind: "validator",
        criterion: "Validation passes.",
        validator: { identity: "trusted-validator", method: "npm test", status: "pass" }
      }
    }), /caller-provided identity or status is not accepted/);
    assert.throws(() => appendGoalEvidence(goal.id, {
      summary: "Caller claims a human approved.",
      evidence: {
        kind: "human_approval",
        criterion: "Review is approved.",
        approval: { approver_identity: "admin", method: "manual review", status: "approved", approver_role: "administrator" }
      }
    }), /caller-provided identity or status is not accepted/);
    assert.throws(() => authority.issueHumanApproval({
      ...authorityContext(goal, "Review is approved."),
      authenticated_principal: { principal_id: "bob", roles: ["user"] },
      method: "manual review",
      status: "approved"
    }), /does not hold an authorized approval role/i);
    assert.throws(() => authority.issueHumanApproval({
      ...authorityContext(goal, "Review is approved."),
      authenticated_principal: { principal_id: "alice", roles: ["goal_approver"] },
      method: "manual review",
      status: "approved"
    }), /owners cannot approve their own goal completion/i);
  });
});

test("signed approval from the goal owner is rejected even by a configured verifier callback", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "No self approval",
      objective: "Require a distinct approval principal.",
      acceptance_criteria: ["Review is approved."],
      created_by: "alice",
      related_session_id: "session-self-approval",
      status: "active"
    });
    configureGoalEvidenceAuthorityProvider({
      provider_id: "private-verifier-test",
      verifyValidatorExecutionReceipt() {
        throw new Error("not used");
      },
      verifyHumanApproval() {
        return {
          provider_id: "private-verifier-test",
          receipt_id: "signed-self-approval",
          approver_principal_id: "ALICE",
          approver_role: "goal_approver",
          method: "authenticated private approval",
          status: "approved",
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString()
        };
      }
    });
    assert.throws(() => appendGoalEvidence(goal.id, {
      summary: "Owner attempted to approve their own goal.",
      evidence: {
        kind: "human_approval",
        criterion: "Review is approved.",
        approval: { authority: { provider_id: "private-verifier-test", assertion: "opaque-signed-assertion" } }
      }
    }), /owners cannot approve their own goal completion/i);
  });
});

test("validator receipts reject replay, cross-goal use, and cross-session use", () => {
  withWorkspace(authority => {
    const first = createGoal({
      title: "First receipt scope",
      objective: "Bind the receipt to the first goal and session.",
      acceptance_criteria: ["Validation passes."],
      related_session_id: "session-a",
      status: "active"
    });
    const receipt = authority.issueValidatorExecutionReceipt({
      ...authorityContext(first, "Validation passes."),
      validator_id: "node-test",
      method: "node --test",
      status: "pass"
    });
    appendGoalValidation(first.id, {
      summary: "Trusted validation completed.",
      evidence: { kind: "validator", criterion: "Validation passes.", validator: { authority: receipt } }
    });
    assert.throws(() => appendGoalValidation(first.id, {
      summary: "Replay the same trusted receipt.",
      evidence: { kind: "validator", criterion: "Validation passes.", validator: { authority: receipt } }
    }), /receipt replay/i);

    const otherGoal = createGoal({
      title: "Other goal receipt scope",
      objective: "Reject a receipt issued to another goal.",
      acceptance_criteria: ["Validation passes."],
      related_session_id: "session-a",
      status: "active"
    });
    assert.throws(() => appendGoalValidation(otherGoal.id, {
      summary: "Cross-goal receipt attempt.",
      evidence: { kind: "validator", criterion: "Validation passes.", validator: { authority: receipt } }
    }), /not valid for this goal, session, criterion, or owner/i);

    const crossSessionReceipt = authority.issueValidatorExecutionReceipt({
      ...authorityContext(otherGoal, "Validation passes."),
      session_id: "different-session",
      validator_id: "node-test",
      method: "node --test",
      status: "pass"
    });
    assert.throws(() => appendGoalValidation(otherGoal.id, {
      summary: "Cross-session receipt attempt.",
      evidence: { kind: "validator", criterion: "Validation passes.", validator: { authority: crossSessionReceipt } }
    }), /not valid for this goal, session, criterion, or owner/i);
  });
});

test("validator receipts reject expiry and invalid signatures", () => {
  withWorkspace(() => {
    let current = new Date("2026-07-27T12:00:00.000Z");
    const authority = createLocalGoalEvidenceAuthority({ secret: TEST_AUTHORITY_SECRET, now: () => current });
    configureGoalEvidenceAuthorityProvider(authority);
    const goal = createGoal({
      title: "Receipt cryptographic checks",
      objective: "Reject stale or modified validator receipts.",
      acceptance_criteria: ["Validation passes."],
      related_session_id: "session-crypto",
      status: "active"
    });
    const expiring = authority.issueValidatorExecutionReceipt({
      ...authorityContext(goal, "Validation passes."),
      validator_id: "node-test",
      method: "node --test",
      status: "pass",
      ttl_seconds: 1
    });
    current = new Date(current.getTime() + 2_000);
    assert.throws(() => appendGoalValidation(goal.id, {
      summary: "Expired receipt attempt.",
      evidence: { kind: "validator", criterion: "Validation passes.", validator: { authority: expiring } }
    }), /expired/i);

    current = new Date("2026-07-27T12:00:00.000Z");
    const auditExpiryGoal = createGoal({
      title: "Receipt expiry at completion",
      objective: "Reverify receipt freshness before final completion.",
      acceptance_criteria: ["Validation passes."],
      related_session_id: "session-audit-expiry",
      status: "active"
    });
    const shortLived = authority.issueValidatorExecutionReceipt({
      ...authorityContext(auditExpiryGoal, "Validation passes."),
      validator_id: "node-test",
      method: "node --test",
      status: "pass",
      ttl_seconds: 1
    });
    const persisted = appendGoalValidation(auditExpiryGoal.id, {
      summary: "Short-lived receipt persisted.",
      evidence: { kind: "validator", criterion: "Validation passes.", validator: { authority: shortLived } }
    });
    const persistedId = persisted.validation_log.at(-1)!.id;
    assert.equal(requestGoalCompletionAudit(auditExpiryGoal.id, {
      criteria_results: [{ criterion: "Validation passes.", status: "pass", evidence_refs: [`validation:${persistedId}`] }]
    }).completion_audit?.complete, true);
    current = new Date(current.getTime() + 2_000);
    assert.throws(() => completeGoalAfterAudit(auditExpiryGoal.id), /no longer passes verification/i);

    current = new Date("2026-07-27T12:00:00.000Z");
    const signed = authority.issueValidatorExecutionReceipt({
      ...authorityContext(goal, "Validation passes."),
      validator_id: "node-test",
      method: "node --test",
      status: "pass"
    });
    const token = String(signed.assertion);
    const separator = token.indexOf(".");
    const signature = token.slice(separator + 1);
    const forged = `${token.slice(0, separator + 1)}${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    assert.throws(() => appendGoalValidation(goal.id, {
      summary: "Modified signature attempt.",
      evidence: {
        kind: "validator",
        criterion: "Validation passes.",
        validator: { authority: { ...signed, assertion: forged } }
      }
    }), /signature is invalid/i);
  });
});

test("local and self-hosted authority receipts provide a valid completion path", () => {
  withWorkspace(configuredAuthority => {
    const previousSecret = process.env.OPERATOR_GOAL_AUTHORITY_SECRET;
    try {
      process.env.OPERATOR_GOAL_AUTHORITY_SECRET = TEST_AUTHORITY_SECRET;
      configureGoalEvidenceAuthorityProvider(null);
      const localAuthority = createDefaultLocalGoalEvidenceAuthority();
      const goal = createGoal({
        title: "Local trusted validation",
        objective: "Complete through a server-issued local validator receipt.",
        acceptance_criteria: ["Validation passes."],
        created_by: "local-agent",
        related_session_id: "session-local-authority",
        status: "active"
      });
      const receipt = localAuthority.issueValidatorExecutionReceipt({
        ...authorityContext(goal, "Validation passes."),
        validator_id: "local-node-test-runner",
        method: "node --test dist/test/goals_service.test.js",
        status: "pass"
      });
      const validated = appendGoalValidation(goal.id, {
        summary: "Local trusted validation passed.",
        evidence: { kind: "validator", criterion: "Validation passes.", validator: { authority: receipt } }
      });
      const validationId = validated.validation_log.at(-1)!.id;
      const audited = requestGoalCompletionAudit(goal.id, {
        criteria_results: [{ criterion: "Validation passes.", status: "pass", evidence_refs: [`validation:${validationId}`] }]
      });
      assert.equal(audited.completion_audit?.complete, true);
      assert.equal(completeGoalAfterAudit(goal.id).status, "complete");
    } finally {
      if (previousSecret === undefined) delete process.env.OPERATOR_GOAL_AUTHORITY_SECRET;
      else process.env.OPERATOR_GOAL_AUTHORITY_SECRET = previousSecret;
      configureGoalEvidenceAuthorityProvider(configuredAuthority);
    }
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

test("auto goal classifier creates assignments for live Revit work", () => {
  const decision = classifyAutoGoalRequest("Add receptacles where marked in these redlines and verify the placement.");
  assert.equal(decision.shouldStart, true);
  assert.ok(decision.signals.length >= 2);
  assert.equal(decision.requestedEffect, "apply");

  const single = classifyAutoGoalRequest("Open sheet E101.");
  assert.equal(single.shouldStart, true);

  const airCount = classifyAutoGoalRequest("Please count the air devices on the project and break the different types down too.");
  assert.equal(airCount.shouldStart, true);
  assert.ok(airCount.signals.includes("live Revit model work"));
  assert.equal(airCount.requestedEffect, "read");

  const noWriteConstrainedAirCount = classifyAutoGoalRequest(
    "Count all air devices in the project and break the total down by family and type. You may inspect an existing air-device schedule. Do not change the model."
  );
  assert.equal(noWriteConstrainedAirCount.shouldStart, true);
  assert.equal(noWriteConstrainedAirCount.requestedEffect, "read");

  const delegatedAirCount = classifyAutoGoalRequest(
    "Inspect the open Revit model and count all HVAC air terminal diffusers. Break the total out by family/type and report the selection criteria used."
  );
  assert.equal(delegatedAirCount.shouldStart, true);
  assert.equal(delegatedAirCount.requestedEffect, "read");

  const liveAirCountWithOpenModelQuestion = classifyAutoGoalRequest(
    "Please count all Air Terminal (air device) instances in the open project and break the total down by family and type. Use project-wide Revit data or the relevant schedule; do not just tell me which model is open."
  );
  assert.equal(liveAirCountWithOpenModelQuestion.shouldStart, true);
  assert.equal(liveAirCountWithOpenModelQuestion.requestedEffect, "read");

  const namedOpenModelCapture = classifyAutoGoalRequest(
    "Read-only observe-and-verify loop: locate an eligible existing plan view in the open Snowdon Towers Sample HVAC model. Capture an image, inspect its visible elements, and do not modify the model, views, or document."
  );
  assert.equal(namedOpenModelCapture.shouldStart, true);
  assert.equal(namedOpenModelCapture.requestedEffect, "read");

  const exactLiveObserveAndVerify = classifyAutoGoalRequest(
    "Read-only observe-and-verify loop: locate an eligible non-template plan view in the open Snowdon Towers Sample HVAC model, capture an image of that plan view, then export/inspect its visible elements. Do not change, save, or modify the model."
  );
  assert.equal(exactLiveObserveAndVerify.shouldStart, true);
  assert.equal(exactLiveObserveAndVerify.requestedEffect, "read");

  const exactExpandedLiveObserveAndVerify = classifyAutoGoalRequest(
    "Read-only observe-and-verify loop: identify one eligible plan view in the open model, capture an image of that plan view, then run/inspect its visible-element export. Do not modify, save, or otherwise change the Revit model."
  );
  assert.equal(exactExpandedLiveObserveAndVerify.shouldStart, true);
  assert.equal(exactExpandedLiveObserveAndVerify.requestedEffect, "read");

  const readOnlyFamilyEvolutionPlan = classifyAutoGoalRequest(
    "Read-only inspection only: find one editable loaded Mechanical Equipment family instance and provide a family-evolution plan with verification and rollback steps. Do not edit, save, load, reload, duplicate, or swap anything."
  );
  assert.equal(readOnlyFamilyEvolutionPlan.shouldStart, true);
  assert.equal(readOnlyFamilyEvolutionPlan.requestedEffect, "read");

  const expandedReadOnlyFamilyEvolutionPlan = classifyAutoGoalRequest(
    "Read-only discovery only; do not edit, create, save, reload, or swap anything. Find one loaded Mechanical Equipment family and return a family-evolution plan with exact future steps. This is a plan/preview only—perform no model modifications and no family reload."
  );
  assert.equal(expandedReadOnlyFamilyEvolutionPlan.requestedEffect, "read");
  const exactSidecarExpandedFamilyEvolutionPlan = classifyAutoGoalRequest(
    "Read-only investigation and bounded family-evolution plan only. In the open Snowdon Towers Sample HVAC model, find one placed equipment family instance that is a defensible candidate for adding a 36-inch service clearance on its electrical/right side and a Yes/No visibility parameter. Inspect the source family/type, host view, footprint, and existing clearance geometry. Return exact future steps for a new family/type, reload collision handling, an isolated pilot swap, rollback, and plan plus screenshot verification. Do NOT edit, create, save, duplicate, reload, or swap any family/type/instance. Return no modifications / no-op receipt."
  );
  assert.equal(exactSidecarExpandedFamilyEvolutionPlan.shouldStart, true);
  assert.equal(exactSidecarExpandedFamilyEvolutionPlan.requestedEffect, "read");
  const actualSidecarExpandedFamilyEvolutionPlan = classifyAutoGoalRequest(
    "Read-only investigation only; do not edit the model, open/edit/reload any family, change types, swap instances, or create files. In the currently open Snowdon Towers Revit model, find one placed equipment family instance that has no visible service-clearance representation in a suitable plan/3D view. Inspect enough geometry/parameters/view evidence to identify a defensible candidate and an exact suitable verification view. Produce a bounded family-evolution plan for a COPIED TEST family/type only, covering: clearance geometry (location/dimensions concept), visibility control (family/type/instance and detail level/visibility settings), reload conflict handling, isolated single-instance type swap, plan-view visibility, and screenshot verification criteria. Return the selected instance (family/type, category, element id/unique id if available), evidence no clearance representation is currently visible, view name/id for verification, and a stepwise plan explicitly marked not executed. No changes whatsoever."
  );
  assert.equal(actualSidecarExpandedFamilyEvolutionPlan.shouldStart, true);
  assert.equal(actualSidecarExpandedFamilyEvolutionPlan.requestedEffect, "read");
  const dryRunLabeledReadOnlyFamilyPlan = classifyAutoGoalRequest(
    "Read-only, bounded family-evolution preflight. Do not edit, save, duplicate, reload, swap, or place anything. Produce an implementation-ready plan with exact future steps and explicitly state that this is a dry-run."
  );
  assert.equal(dryRunLabeledReadOnlyFamilyPlan.requestedEffect, "read");
  const exactLiveReadOnlyFamilyEvolutionPlan = classifyAutoGoalRequest(
    "READ-ONLY ONLY. Do not modify, save, edit, open Family Editor, create types, reload families, or swap instances. In the currently open model, find exactly one loaded Mechanical Equipment family instance that is editable. Produce a precise family-evolution plan for creating a TEST-ONLY type. Then state read-only proposed steps: 1) edit family, 2) duplicate source type, 3) parameter handling, 4) reload, 5) swap only a pilot instance, 6) verification and rollback. No model edits whatsoever."
  );
  assert.equal(exactLiveReadOnlyFamilyEvolutionPlan.shouldStart, true);
  assert.equal(exactLiveReadOnlyFamilyEvolutionPlan.requestedEffect, "read");
  assert.equal(classifyAutoGoalRequest(
    "Read-only discovery and executable PREVIEW only—find one writable schedule value and preview a rollback transaction. Do not apply."
  ).requestedEffect, "preview");
  assert.equal(classifyAutoGoalRequest(
    "Read-only planning first, then execute a dry-run preview of the proposed family change. Do not apply."
  ).requestedEffect, "preview");

  const openButtonCommand = classifyAutoGoalRequest(
    "Click the Open button to open Snowdon Towers Sample HVAC model, then inspect its air terminals."
  );
  assert.equal(openButtonCommand.requestedEffect, "apply");

  const explicitOpen = classifyAutoGoalRequest("Open this Revit model, then inspect its air terminals.");
  assert.equal(explicitOpen.shouldStart, true);
  assert.equal(explicitOpen.requestedEffect, "apply");

  const preview = classifyAutoGoalRequest("Preview changing all HRU Marks to ERU, but do not commit it.");
  assert.equal(preview.requestedEffect, "preview");
  const topologyPreview = classifyAutoGoalRequest(
    "Identify one clearly missing unit branch and the analogous neighboring branch, then preview copying its topology, system, level, size, and fittings to the target. Do not create anything."
  );
  assert.equal(topologyPreview.shouldStart, true);
  assert.ok(topologyPreview.signals.includes("live Revit model work"));
  assert.equal(topologyPreview.requestedEffect, "preview");
  const applyPastPreview = classifyAutoGoalRequest(
    "Rename sheet M000, verify it, then rename it back and verify it. Do the work; do not stop at a preview."
  );
  assert.equal(applyPastPreview.requestedEffect, "apply");
  const applyAfterPreflight = classifyAutoGoalRequest(
    "Find every mechanical-equipment Mark beginning with HRU, preflight collisions and read-only targets, apply the complete bounded HRU-to-ERU set, then query all affected IDs and verify the result."
  );
  assert.equal(applyAfterPreflight.requestedEffect, "apply");
  assert.equal(classifyAutoGoalRequest(
    "Preflight changing every HRU Mark to ERU, but do not apply or save anything."
  ).requestedEffect, "preview");
  assert.equal(classifyAutoGoalRequest(
    "Rename sheet M000 and return it to the original name. Execute both writes; do not return only a dry run."
  ).requestedEffect, "apply");

  const fixtureTransition = classifyAutoGoalRequest(
    "Use revit_open_model to open Snowdon Towers Sample Plumbing.rvt. Do not modify model content."
  );
  assert.equal(fixtureTransition.requestedEffect, "apply");
  const titleBlockInitials = classifyAutoGoalRequest(
    "Put EP for drawn by and QA for checked by on all the mechanical sheets."
  );
  assert.equal(titleBlockInitials.shouldStart, true);
  assert.equal(titleBlockInitials.requestedEffect, "apply");
  const titleBlockWithScopedExclusion = classifyAutoGoalRequest(
    "Update every mechanical drawing sheet so Drawn By is EP and Checked By is QA. First identify the writable parameters, then apply the changes and verify by readback. Do not modify non-mechanical sheets or any other content."
  );
  assert.equal(titleBlockWithScopedExclusion.requestedEffect, "apply");
  assert.equal(classifyAutoGoalRequest(
    "Inspect every mechanical sheet and report the initials. Do not modify the model."
  ).requestedEffect, "read");
  for (const prompt of [
    "Fill the Comments parameter on every mechanical equipment instance.",
    "Match the odd equipment tag to the adjacent tags.",
    "Turn off Rooms in the Level 4 HVAC view.",
    "Restore sheet M000 name to Cover Sheet and verify the restored name in the live Revit model.",
    "Revert the Level 2 plan to its previous view template.",
    "Reset the enlarged plan scale to 1/8 inch.",
    "Clear the obsolete sheet comments and adjust the view range."
  ]) {
    assert.equal(classifyAutoGoalRequest(prompt).requestedEffect, "apply", prompt);
  }
  const inspectBeforeOpen = classifyAutoGoalRequest("Before opening the Revit model, inspect the path only.");
  assert.equal(inspectBeforeOpen.requestedEffect, "read");

  const conceptual = classifyAutoGoalRequest("Explain why construction documents use schedules.");
  assert.equal(conceptual.shouldStart, false);
});

test("auto goal completion requires evidence at the requested read, preview, or apply effect", () => {
  withWorkspace(() => {
    const previewGoal = setAgentGoal("session-effect-preview", {
      title: "Preview marks", objective: "Preview changing HRU Marks; do not commit.",
      acceptance_criteria: ["The preview is verified."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Preview", status: "in_progress" }]
    });
    const readOnly = createAutoGoalTurnObserver("session-effect-preview");
    readOnly.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/find-elements", body: {} }, result: { count: 37 } });
    readOnly.finish("turn-read-only", "Found 37 candidates.");
    assert.equal(getGoal(previewGoal.id)?.status, "active");

    const preview = createAutoGoalTurnObserver("session-effect-preview");
    preview.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/set-parameter", body: { dryRun: true, apply: false } }, result: { candidateCount: 37, rolledBack: true } });
    preview.finish("turn-preview", "Previewed 37 changes and verified rollback.");
    assert.equal(getGoal(previewGoal.id)?.status, "complete");

    const applyGoal = setAgentGoal("session-effect-apply", {
      title: "Apply marks", objective: "Change all HRU Marks to ERU.",
      acceptance_criteria: ["The changes are applied and verified."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Apply", status: "in_progress" }]
    });
    const applyPreviewOnly = createAutoGoalTurnObserver("session-effect-apply");
    applyPreviewOnly.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/set-parameter", body: { dryRun: true, apply: false } }, result: { candidateCount: 37 } });
    applyPreviewOnly.finish("turn-apply-preview", "Preview complete; apply has not run.");
    assert.equal(getGoal(applyGoal.id)?.status, "active");
  });
});

test("a certified teammate preview receipt remains integrity-only without trusted transaction evidence", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-preview-receipt-settlement", {
      title: "Preview an enlarged plan",
      objective: "Duplicate, crop, and scale an enlarged plan in a rollback preview; do not create anything.",
      acceptance_criteria: ["The enlarged-plan preview is grounded in a successful rollback receipt."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Preview enlarged plan", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-preview-receipt-settlement");
    observer.observe({
      server: "revit_operator",
      tool: "revit_call_tool",
      success: true,
      arguments: {
        method: "POST",
        path: "/revit/transaction-plan",
        body: { actions: [{ kind: "duplicateView", sourceViewId: 1363433, resultRef: "enlargedL4" }] }
      },
      result: { impact: { added: [1542996] }, actions: [{ kind: "duplicateView", success: true }] }
    });
    observer.finish("turn-preview-receipt-settlement", "Rollback preview duplicated the view and independent readback confirmed it does not persist.", {
      stage: "report",
      verified: false,
      apply_attempts: 0,
      preview_receipts: [{
        action_id: "mcp:1",
        path: "/revit/transaction-plan",
        status: "success",
        evidence_sha256: `sha256:${"a".repeat(64)}`
      }]
    });
    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "active");
    assert.equal(persisted?.completion_audit, null);
    assert.equal(persisted?.work_items[0]?.status, "in_progress");

    const malformedGoal = setAgentGoal("session-preview-receipt-malformed", {
      title: "Preview another enlarged plan",
      objective: "Duplicate another enlarged plan in a rollback preview; do not create anything.",
      acceptance_criteria: ["The preview is grounded in a successful rollback receipt."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Preview enlarged plan", status: "in_progress" }]
    });
    const malformed = createAutoGoalTurnObserver("session-preview-receipt-malformed");
    malformed.observe({
      server: "revit_operator",
      tool: "revit_call_tool",
      success: true,
      arguments: { method: "POST", path: "/revit/transaction-plan", body: { actions: [] } },
      result: { warnings: ["No executable actions"] }
    });
    malformed.finish("turn-preview-receipt-malformed", "Preview complete.", {
      stage: "report",
      verified: false,
      apply_attempts: 0,
      preview_receipts: [{
        action_id: "mcp:1",
        path: "/revit/transaction-plan",
        status: "success",
        evidence_sha256: "sha256:not-a-digest"
      }]
    });
    assert.equal(getGoal(malformedGoal.id)?.status, "active");
    assert.equal(getGoal(malformedGoal.id)?.completion_audit, null);

    const nonfinalGoal = setAgentGoal("session-preview-receipt-nonfinal", {
      title: "Preview a third enlarged plan",
      objective: "Duplicate a third enlarged plan in a rollback preview; do not create anything.",
      acceptance_criteria: ["The preview reaches a final report state."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Preview enlarged plan", status: "in_progress" }]
    });
    const nonfinal = createAutoGoalTurnObserver("session-preview-receipt-nonfinal");
    nonfinal.finish("turn-preview-receipt-nonfinal", "The preview is still in progress.", {
      stage: "preview",
      verified: false,
      apply_attempts: 0,
      preview_receipts: [{
        action_id: "mcp:1",
        path: "/revit/transaction-plan",
        status: "success",
        evidence_sha256: `sha256:${"b".repeat(64)}`
      }]
    });
    assert.equal(getGoal(nonfinalGoal.id)?.status, "active");
    assert.equal(getGoal(nonfinalGoal.id)?.completion_audit, null);
  });
});

test("the live c03 preview trace retains final teammate receipts without treating them as preview authority", () => {
  withWorkspace(() => {
    const sessionId = "session-live-c03-preview-receipt";
    const goal = setAgentGoal(sessionId, {
      title: "Make an enlarged mechanical plan",
      objective: "Make an enlarged mechanical plan for Level 4 around the live/work units. Resolve a sensible source and crop region, then preview it; do not create anything.",
      acceptance_criteria: [
        "The requested Revit work is completed or a concrete blocker is reported.",
        "The reported result is grounded in successful live Revit tool evidence from this assignment."
      ],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver(sessionId);
    observer.observe({ server: "revit_operator", tool: "operator_discover_capabilities", success: true, result: { status: "available" } });
    observer.observe({ server: "revit_operator", tool: "revit_search_tools", success: true, result: { total_matches: 8 } });
    observer.observe({ server: "revit_operator", tool: "revit_tool_registry", success: true, result: { total: 246 } });
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { method: "POST", path: "/revit/views", body: { action: "list" } }, result: { status: "ok", count: 4 } });
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { method: "POST", path: "/revit/rooms", body: { action: "list" } }, result: { status: "ok", spaces: [403, 405, 407, 408, 409, 410] } });
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { method: "POST", path: "/revit/visibility", body: { action: "get", viewId: 1363433 } }, result: { status: "Ok", action: "get", dryRun: false } });
    observer.observe({ server: "revit_operator", tool: "revit_tool_doc", success: true, arguments: { method: "POST", path: "/revit/transaction-plan" }, result: { title: "Plan Transaction" } });
    observer.observe({
      server: "revit_operator",
      tool: "revit_call_tool",
      success: true,
      arguments: {
        method: "POST",
        path: "/revit/transaction-plan",
        body: { actions: [{ kind: "createDependentView", sourceViewId: 1363433, resultRef: "enlargedView" }] }
      },
      result: { impact: { added: [1543200], modified: [1543200], deleted: [] }, actions: [{ kind: "createDependentView", success: true }] }
    });
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { method: "POST", path: "/revit/views", body: { action: "list", viewNames: ["L4 - Live Work Enlarged PREVIEW"] } }, result: { status: "ok", count: 0, views: [] } });
    const assistantText = "## Preview completed — nothing created\n\n- **Source:** Mechanical floor plan **L4** (view **1363433**), scale 1:96.\n- **Scope:** Live/work spaces **403, 405, 407, 408, 409, 410**.\n- Successfully previewed a dependent view with the crop and scale in a rolled-back transaction.\n\nReadback found **zero** views named `L4 - Live Work Enlarged PREVIEW`, confirming no view was retained.";
    const terminalReceipt = reconcileTeammateReceiptWithAssistant({
        schema: "revit-operator.teammate-loop-receipt.v1",
        turn_kind: "inspection",
        context_state: "live",
        stage: "preview",
        preview_action_ids: ["mcp:1"],
        verified: false,
        apply_attempts: 0,
        apply_action_id: null,
        verification_action_ids: [],
        verification_mode: "none",
        verification_action_id: null,
        verification_evidence_sha256: null,
        blocked_reason: null,
        preview_receipts: [{
          action_id: "mcp:1",
          path: "/revit/transaction-plan",
          status: "success",
          evidence_sha256: `sha256:${"1b9c52220e3fc9c4c867168e35092e4d18df2b34d31ec8800d90a0d4d06d5652"}`
        }]
      }, assistantText);
    assert.equal(terminalReceipt?.stage, "report");
    observer.finish("turn-live-c03-preview-receipt", assistantText, terminalReceipt);
    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "active");
    assert.equal(persisted?.completion_audit, null);
    assert.equal(persisted?.work_items[0]?.status, "in_progress");
  });
});

test("an already-satisfied apply assignment completes only as a substantive, zero-apply verified no-op", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-verified-noop", {
      title: "Clean view names", objective: "Rename Level 2 HVAC floor plans only when they do not match the established level-name pattern.",
      acceptance_criteria: ["Every Level 2 HVAC floor plan follows the established pattern."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and rename", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-verified-noop");
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/views", body: { action: "list", discipline: "Mechanical" } },
      result: { views: [{ id: 9948, name: "L2", levelName: "L2" }, { id: 9949, name: "L3", levelName: "L3" }] }
    });
    observer.finish(
      "turn-verified-noop",
      "Pattern: view names match their associated level names. L2 already conforms. Renames: none required; no model changes made.",
      { stage: "discover", verified: false, apply_attempts: 0 }
    );
    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "complete");
    assert.equal(persisted?.work_budget?.completion_mode, "verified_noop");
    assert.equal(persisted?.completion_audit?.complete, true);
    assert.match(persisted?.completion_audit?.evidence_summary || "", /Verified no-op/);

    const terminalPhrasing = setAgentGoal("session-terminal-verified-noop", {
      title: "Clean view names", objective: "Rename Level 2 HVAC floor plans only when they do not match the established level-name pattern.",
      acceptance_criteria: ["Every Level 2 HVAC floor plan follows the established pattern."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and rename", status: "in_progress" }]
    });
    const terminalObserver = createAutoGoalTurnObserver("session-terminal-verified-noop");
    terminalObserver.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/views", body: { action: "list", includeTemplates: false } },
      result: [{ type: "inputText", text: JSON.stringify({ status: "ok", views: [{ id: 9948, name: "L2", levelName: "L2" }] }) }]
    });
    terminalObserver.finish(
      "turn-terminal-verified-noop",
      "Level 2 floor plan L2 already conforms. Final readback confirms L2. Renames: none. No elements were modified.",
      { stage: "discover", verified: false, apply_attempts: 0 }
    );
    assert.equal(getGoal(terminalPhrasing.id)?.status, "complete");
    assert.equal(getGoal(terminalPhrasing.id)?.work_budget?.completion_mode, "verified_noop");

    const unsupported = setAgentGoal("session-unsupported-noop", {
      title: "Rename a view", objective: "Rename the requested view.",
      acceptance_criteria: ["The view is renamed."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Rename", status: "in_progress" }]
    });
    const unsupportedObserver = createAutoGoalTurnObserver("session-unsupported-noop");
    unsupportedObserver.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/views" }, result: { views: [] } });
    unsupportedObserver.finish("turn-unsupported-noop", "No model changes were made because the requested target was unavailable.");
    assert.equal(getGoal(unsupported.id)?.status, "active");
    assert.equal(getGoal(unsupported.id)?.completion_audit, null);
  });
});

test("a preview assignment with zero candidates completes as a substantive verified no-op", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-preview-verified-noop", {
      title: "Preview sheet number cleanup",
      objective: "Preview replacing dashes in Mechanical sheet numbers with dots; do not apply changes.",
      acceptance_criteria: ["Every dashed Mechanical sheet number has an exact collision-free preview, or live evidence proves there are no candidates."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-preview-verified-noop");
    observer.observe({
      server: "revit_operator", tool: "revit_list_sheets", success: true,
      arguments: { discipline: "Mechanical" },
      result: { sheets: [{ id: 1, number: "M000" }, { id: 2, number: "M101" }, { id: 3, number: "M206" }] }
    });
    observer.finish(
      "turn-preview-verified-noop",
      "All Mechanical sheets were inspected. candidate_count: 0. Model changes: none. No renaming action is necessary.",
      { stage: "report", verified: false, apply_attempts: 0 }
    );
    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "complete");
    assert.equal(persisted?.work_budget?.requested_effect, "preview");
    assert.equal(persisted?.work_budget?.completion_mode, "verified_noop");
    assert.equal(persisted?.completion_audit?.complete, true);

    const naturalLanguage = setAgentGoal("session-preview-natural-language-noop", {
      title: "Preview sheet number cleanup",
      objective: "Preview replacing dashes in Mechanical sheet numbers with dots; do not apply changes.",
      acceptance_criteria: ["Every dashed Mechanical sheet number has an exact collision-free preview, or live evidence proves there are no candidates."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const naturalLanguageObserver = createAutoGoalTurnObserver("session-preview-natural-language-noop");
    naturalLanguageObserver.observe({
      server: "revit_operator", tool: "revit_list_sheets", success: true,
      arguments: { discipline: "Mechanical" },
      result: { sheets: Array.from({ length: 17 }, (_, index) => ({ id: index + 1, number: `M${String(index).padStart(3, "0")}` })) }
    });
    naturalLanguageObserver.finish(
      "turn-preview-natural-language-noop",
      "No mechanical sheet numbers contain a dash, so the preview table is empty. All 17 sheets are mechanical M-sheets. No sheets were renamed or modified.",
      { stage: "report", verified: false, apply_attempts: 0 }
    );
    assert.equal(getGoal(naturalLanguage.id)?.status, "complete");
    assert.equal(getGoal(naturalLanguage.id)?.work_budget?.completion_mode, "verified_noop");

    const liveMarkdownReceipt = setAgentGoal("session-preview-live-markdown-noop", {
      title: "Preview sheet number cleanup",
      objective: "Preview replacing dashes in Mechanical sheet numbers with dots; do not apply changes.",
      acceptance_criteria: ["Every dashed Mechanical sheet number has an exact collision-free preview, or live evidence proves there are no candidates."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const liveMarkdownObserver = createAutoGoalTurnObserver("session-preview-live-markdown-noop");
    liveMarkdownObserver.observe({
      server: "revit_operator", tool: "revit_list_sheets", success: true,
      arguments: { discipline: "Mechanical" },
      result: { sheets: Array.from({ length: 17 }, (_, index) => ({ id: index + 1, number: `M${String(index).padStart(3, "0")}` })) }
    });
    liveMarkdownObserver.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/renumber-sheets", body: { changes: [], dryRun: true } },
      result: { status: "NoOp", dryRun: true, requestedCount: 0, candidateCount: 0, modelModified: false, completionEligible: false }
    });
    liveMarkdownObserver.finish(
      "turn-preview-live-markdown-noop",
      "## Preview result\n- Mechanical sheets: **17**\n- Sheet numbers containing dashes: **0**\n- Proposed mappings: none\n- No sheets were renamed.",
      { stage: "report", verified: false, apply_attempts: 0 }
    );
    assert.equal(getGoal(liveMarkdownReceipt.id)?.status, "complete");
    assert.equal(getGoal(liveMarkdownReceipt.id)?.work_budget?.completion_mode, "verified_noop");

    const liveNumericReceipt = setAgentGoal("session-preview-live-numeric-noop", {
      title: "Preview sheet number cleanup",
      objective: "Preview replacing dashes in Mechanical sheet numbers with dots; do not apply changes.",
      acceptance_criteria: ["Every dashed Mechanical sheet number has an exact collision-free preview, or live evidence proves there are no candidates."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const liveNumericObserver = createAutoGoalTurnObserver("session-preview-live-numeric-noop");
    liveNumericObserver.observe({
      server: "revit_operator", tool: "revit_list_sheets", success: true,
      arguments: { action: "list", exact: true, all: true },
      result: { totalSheets: 17, items: Array.from({ length: 17 }, (_, index) => ({ id: index + 1, sheetNumber: `M${String(index).padStart(3, "0")}` })) }
    });
    liveNumericObserver.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { method: "POST", path: "/revit/renumber-sheets", body: { behavior: "replace_dash_with_dot", dryRun: true, changes: [] } },
      result: [{
        type: "inputText",
        text: JSON.stringify({
          status: "NoOp", dryRun: true, behavior: "replace_dash_with_dot",
          requestedCount: 0, candidateCount: 0, results: [], modelModified: false,
          completionEligible: false, summary: "No sheet renumber candidates were supplied; the model was not modified."
        })
      }]
    });
    liveNumericObserver.finish(
      "turn-preview-live-numeric-noop",
      "## Preview complete — no changes\n- **17 sheets checked**\n- **0** sheet numbers contain a dash\n- **0** planned changes\n- Dry-run result: **NoOp**\n- Model modified: **No**"
    );
    assert.equal(getGoal(liveNumericReceipt.id)?.status, "complete");
    assert.equal(getGoal(liveNumericReceipt.id)?.work_budget?.completion_mode, "verified_noop");
    assert.equal(getGoal(liveNumericReceipt.id)?.completion_audit?.complete, true);

    const recoveredNamedCandidateReceipt = setAgentGoal("session-preview-recovered-named-candidate-noop", {
      title: "Preview area-name cleanup",
      objective: "Preview changing Area 1 and Area 2 view and sheet names to Area A and Area B; do not apply changes.",
      acceptance_criteria: ["Every applicable view and sheet has an exact collision-free preview, or live evidence proves there are no candidates."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const recoveredNamedCandidateObserver = createAutoGoalTurnObserver("session-preview-recovered-named-candidate-noop");
    recoveredNamedCandidateObserver.observe({
      server: "revit_operator", tool: "revit_call_tool", success: false,
      arguments: { path: "/revit/get-parameters", body: { elementIds: [1], categories: ["Views"] } },
      error: "get-parameters accepts exactly one selector"
    });
    recoveredNamedCandidateObserver.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/views", body: { action: "list", discipline: "Mechanical" } },
      result: { count: 36, views: [{ id: 1363413, name: "L1 Block 37" }] }
    });
    recoveredNamedCandidateObserver.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/renumber-sheets", body: { changes: [], dryRun: true } },
      result: { status: "NoOp", requestedCount: 0, candidateCount: 0, modelModified: false, completionEligible: false }
    });
    recoveredNamedCandidateObserver.observe({
      server: "revit_operator", tool: "revit_list_sheets", success: true,
      result: { sheets: [{ id: 1, number: "M101", name: "Plan HVAC L1" }, { id: 2, number: "M201", name: "RCP HVAC L1" }] }
    });
    recoveredNamedCandidateObserver.finish(
      "turn-preview-recovered-named-candidate-noop",
      "Found 0 mechanical views and 0 sheets containing Area 1 or Area 2; therefore no exact rename candidates exist. Dry-run returned NoOp, modelModified:false. Post-preview readback confirmed both sheets unchanged. Concrete blocker: the requested source terminology does not exist in the live model."
    );
    const recoveredNamedCandidate = getGoal(recoveredNamedCandidateReceipt.id);
    assert.equal(recoveredNamedCandidate?.status, "blocked");
    assert.equal(recoveredNamedCandidate?.completion_audit, null);

    const missingTarget = setAgentGoal("session-preview-missing-target", {
      title: "Preview one requested sheet rename",
      objective: "Preview renaming the specifically requested sheet; do not apply changes.",
      acceptance_criteria: ["The requested sheet has an exact preview."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const missingTargetObserver = createAutoGoalTurnObserver("session-preview-missing-target");
    missingTargetObserver.observe({
      server: "revit_operator", tool: "revit_list_sheets", success: true,
      result: { sheets: [{ id: 1, number: "M000" }] }
    });
    missingTargetObserver.finish("turn-preview-missing-target", "No sheet matches the requested target. No sheets were modified.");
    assert.notEqual(getGoal(missingTarget.id)?.status, "complete");

    const unsupported = setAgentGoal("session-preview-unproved-noop", {
      title: "Preview sheet number cleanup",
      objective: "Preview replacing dashes in Mechanical sheet numbers with dots; do not apply changes.",
      acceptance_criteria: ["The preview is grounded."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const unsupportedObserver = createAutoGoalTurnObserver("session-preview-unproved-noop");
    unsupportedObserver.observe({
      server: "revit_operator", tool: "revit_search_tools", success: true,
      result: { tools: ["revit_list_sheets"] }
    });
    unsupportedObserver.finish("turn-preview-unproved-noop", "candidate_count: 0. Model changes: none.");
    assert.equal(getGoal(unsupported.id)?.status, "active");
    assert.equal(getGoal(unsupported.id)?.completion_audit, null);
  });
});

test("a grounded preview may complete when the requested state is already correct and no edit is defensible", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-preview-already-correct", {
      title: "Fix view range", objective: "Preview fixing the view range so the floor below is not visible.",
      acceptance_criteria: ["The view-range result is grounded."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-preview-already-correct");
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { method: "POST", path: "/revit/views", body: { action: "get_view_range", viewId: 9948 } },
      result: { viewId: 9948, name: "L2", bottomLevel: "L2", bottomOffset: 0, depthLevel: "L2", depthOffset: 0, underlay: null }
    });
    observer.finish("turn-preview-already-correct", "Chosen view: L2, ID 9948. Bottom and View Depth already stop at L2 and underlay is disabled. preview_status: rejected_no_defensible_edit. proposed_edit: none. model_altered: false. No change applied.");
    const completed = getGoal(goal.id);
    assert.equal(completed?.status, "complete");
    assert.equal(completed?.work_budget?.completion_mode, "verified_noop");
  });
});

test("read-only export evidence does not impersonate an apply during a structured dry-run preview", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-preview-with-export", {
      title: "Preview one tag", objective: "Preview adding one matching tag; do not create it.",
      acceptance_criteria: ["The tag preview is grounded and no model change is committed."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Preview tag", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-preview-with-export");
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { method: "POST", path: "/revit/export-visible-elements", body: { viewId: 1626564 } },
      result: { count: 42, artifact_path: "capture.jpg" }
    });
    assert.deepEqual(getGoal(goal.id)?.action_log.at(-1)?.artifact_paths, ["capture.jpg"]);
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { method: "POST", path: "/revit/tag-elements", body: { elementIds: [1544911], dryRun: true } },
      result: { status: "Dry Run", dryRun: true, plannedToTag: 1 }
    });
    observer.finish("turn-preview-with-export", "Preview complete; no model changes were applied.");
    assert.equal(getGoal(goal.id)?.status, "complete");
  });
});

test("auto goal journaling extracts nested artifact files from successful export receipts", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-export-artifact", {
      title: "Observe a view", objective: "Capture and inspect a plan without changing the model.",
      acceptance_criteria: ["The captured view is grounded."],
      work_budget: { mode: "auto_goal", requested_effect: "read" },
      work_items: [{ id: "auto.revit-work", title: "Capture and inspect", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-export-artifact");
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { method: "POST", path: "/revit/export-visible-elements", body: { viewId: 9948 } },
      result: [{ type: "inputText", text: JSON.stringify({
        status: "ok",
        count: 684,
        path_rel: "C:/Users/Eli/AppData/Local/RevitOperator/Workspace/artifacts/captures/selection/Revit_9948_inventory.jpg",
        open_path_url: "op://open-folder?path=artifacts/captures"
      }) }]
    });
    const action = getGoal(goal.id)?.action_log.at(-1);
    assert.deepEqual(action?.artifact_paths, [
      "C:/Users/Eli/AppData/Local/RevitOperator/Workspace/artifacts/captures/selection/Revit_9948_inventory.jpg"
    ]);
    observer.finish("turn-export-artifact", "Captured L2 and inspected 684 visible elements. No model changes were performed.");
    assert.equal(getGoal(goal.id)?.status, "complete");
  });
});

test("a verified no-op fails closed when a later read changes the stable request target", () => {
  withWorkspace(() => {
    const recovered = setAgentGoal("session-recovered-verified-noop", {
      title: "Clean view names", objective: "Rename Level 2 HVAC floor plans only when they do not match the established level-name pattern.",
      acceptance_criteria: ["Every Level 2 HVAC floor plan follows the established pattern."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and rename", status: "in_progress" }]
    });
    const recoveredObserver = createAutoGoalTurnObserver("session-recovered-verified-noop");
    recoveredObserver.observe({ server: "revit_operator", tool: "revit_call_tool", success: false, arguments: { path: "/revit/views", body: { semanticGroups: ["unsupported"] } }, error: "unsupported semantic group" });
    recoveredObserver.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/views", body: { disciplines: ["Mechanical"] } }, result: { views: [{ id: 9948, name: "L2", levelName: "L2" }] } });
    recoveredObserver.finish("turn-recovered-verified-noop", "Pattern: each HVAC floor-plan view matches its associated level name. L2 already conforms. No rename was needed; no elements were changed.", { stage: "discover", verified: false, apply_attempts: 0 });
    const completed = getGoal(recovered.id);
    assert.equal(completed?.status, "blocked");
    assert.equal(completed?.completion_audit, null);

    const unrecovered = setAgentGoal("session-unrecovered-verified-noop", {
      title: "Clean view names", objective: "Rename Level 2 HVAC floor plans only when needed.",
      acceptance_criteria: ["Every Level 2 HVAC floor plan follows the established pattern."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and rename", status: "in_progress" }]
    });
    const unrecoveredObserver = createAutoGoalTurnObserver("session-unrecovered-verified-noop");
    unrecoveredObserver.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/views" }, result: { views: [{ id: 9948, name: "L2" }] } });
    unrecoveredObserver.observe({ server: "revit_operator", tool: "revit_call_tool", success: false, arguments: { path: "/revit/views" }, error: "final readback failed" });
    unrecoveredObserver.finish("turn-unrecovered-verified-noop", "L2 already conforms and no rename was needed.");
    assert.equal(getGoal(unrecovered.id)?.status, "blocked");
    assert.equal(getGoal(unrecovered.id)?.completion_audit, null);
  });
});

test("auto goal effect classification preserves serialized rollback previews from generic and dynamic tools", () => {
  withWorkspace(() => {
    const genericGoal = setAgentGoal("session-serialized-preview", {
      title: "Preview tags", objective: "Preview tagging the selected equipment; do not commit.",
      acceptance_criteria: ["The rollback preview is verified."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Preview", status: "in_progress" }]
    });
    const generic = createAutoGoalTurnObserver("session-serialized-preview");
    generic.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/tag-elements", body: JSON.stringify({ apply: false, dryRun: true, elementIds: [42] }) },
      result: { preview: true, affectedIds: [42], rollbackVerified: true }
    });
    generic.finish("turn-serialized-preview", "Previewed one tag and verified rollback.");
    assert.equal(getGoal(genericGoal.id)?.status, "complete");

    const dynamicGoal = setAgentGoal("session-dynamic-preview", {
      title: "Preview marks", objective: "Preview changing HRU Marks; do not commit.",
      acceptance_criteria: ["The generated-program rollback preview is verified."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Preview", status: "in_progress" }]
    });
    const dynamic = createAutoGoalTurnObserver("session-dynamic-preview");
    dynamic.observe({
      server: "revit_operator", tool: "run_dynamic_revit_program", success: true,
      arguments: JSON.stringify({ mode: "preview", source: "context.Plan.SetParameter(element, \"Mark\", \"ERU-1\");" }),
      result: { requested_mode: "preview", rollback_truth: true, projected_changed_element_ids: [42] }
    });
    dynamic.finish("turn-dynamic-preview", "Previewed one generated-program change and verified rollback.");
    assert.equal(getGoal(dynamicGoal.id)?.status, "complete");
  });
});

test("an apply operation during a read-only assignment is blocked for reconciliation", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-effect-unexpected-apply", {
      title: "Inspect marks", objective: "Inspect Marks without changing them.",
      acceptance_criteria: ["The inspection is reported."],
      work_budget: { mode: "auto_goal", requested_effect: "read" },
      work_items: [{ id: "auto.revit-work", title: "Inspect", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-effect-unexpected-apply");
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/set-parameter", body: { apply: true, dryRun: false } }, result: { committed: true } });
    observer.finish("turn-unexpected-apply", "Inspection complete.");
    assert.equal(getGoal(goal.id)?.status, "blocked");
    assert.match(getGoal(goal.id)?.blocker || "", /effect reconciliation/);
  });
});

test("performing an observational image export remains read evidence when dryRun is false", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-effect-image-capture", {
      title: "Capture the cover sheet", objective: "Capture M000 as an image without changing the model.",
      acceptance_criteria: ["The capture artifact path is reported."],
      work_budget: { mode: "auto_goal", requested_effect: "read" },
      work_items: [{ id: "auto.revit-work", title: "Capture", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-effect-image-capture");
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: {
        method: "POST", path: "/revit/export-images",
        body: { viewIds: [1420963], fileNameTemplate: "M000_titleblock_review", dryRun: false }
      },
      result: { status: "Success", outputs: [{ path: "artifacts/captures/M000_titleblock_review.jpg" }] }
    });
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: {
        method: "POST", path: "/revit/capture-sheet-region",
        body: { sheetNumber: "M000", fileName: "M000_titleblock_review.png", includeOcr: false }
      },
      result: { export: { path: "artifacts/captures/selection/M000_titleblock_review_titleblock_crop.png" } }
    });
    observer.finish("turn-image-capture", "Captured M000 and reported both artifact paths. No model changes were made.");

    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "complete");
    assert.doesNotMatch(persisted?.blocker || "", /effect reconciliation/);
    assert.match(persisted?.completion_audit?.evidence_summary || "", /2 successful live Revit tool calls/);
  });
});

test("successful live tools complete a quick auto assignment with trusted evidence", () => {
  withWorkspace(() => {
    setAgentGoal("session-auto-complete", {
      title: "Count air devices",
      objective: "Count all air devices and break down their types.",
      acceptance_criteria: ["The count is returned.", "The result uses live Revit evidence."],
      work_budget: { mode: "auto_goal" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    recordAutoGoalToolObservation("session-auto-complete", { tool: "revit_call_tool", success: true, status: "completed" });
    completeAutoGoalFromValidatedTurn("session-auto-complete", {
      turn_id: "turn-air-count",
      successful_tools: 3,
      assistant_summary: "Found 509 air terminals across seven types."
    });
    const completed = getActiveGoalForSession("session-auto-complete");
    assert.equal(completed, null);
    const persisted = listGoals(10).find(goal => goal.related_session_id === "session-auto-complete");
    assert.equal(persisted?.status, "complete");
    assert.equal(persisted?.completion_audit?.complete, true);
    assert.equal(persisted?.work_items[0]?.status, "complete");
    assert.equal(persisted?.validation_log.length, 2);
  });
});

test("nested non-dispatch and uncertainty envelopes cannot complete or verify an auto goal", () => {
  withWorkspace(() => {
    const nonDispatchedGoal = setAgentGoal("session-auto-nested-not-dispatched", {
      title: "Confirm an existing mark", objective: "Confirm the requested mark is already present.",
      acceptance_criteria: ["The live state is verified."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Confirm mark", status: "in_progress" }]
    });
    const nonDispatched = createAutoGoalTurnObserver("session-auto-nested-not-dispatched");
    nonDispatched.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/find-elements", body: { category: "Mechanical Equipment" } },
      result: [{ type: "inputText", text: JSON.stringify({ result: { request_dispatched: false, count: 1 } }) }]
    });
    nonDispatched.finish("turn-auto-nested-not-dispatched", "The requested state is already satisfied; no change is needed.");
    const nonDispatchedPersisted = getGoal(nonDispatchedGoal.id);
    assert.equal(nonDispatchedPersisted?.status, "active");
    assert.equal(nonDispatchedPersisted?.completion_audit, null);
    assert.equal(nonDispatchedPersisted?.work_items[0]?.status, "in_progress");

    const uncertainGoal = setAgentGoal("session-auto-nested-uncertain", {
      title: "Read live equipment", objective: "Read the live equipment count.",
      acceptance_criteria: ["The count is authoritative."],
      work_budget: { mode: "auto_goal", requested_effect: "read" },
      work_items: [{ id: "auto.revit-work", title: "Read count", status: "in_progress" }]
    });
    const uncertain = createAutoGoalTurnObserver("session-auto-nested-uncertain");
    uncertain.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/quantify", body: { category: "Mechanical Equipment" } },
      result: [{ type: "inputText", text: JSON.stringify({ content: [{ text: JSON.stringify({ outcome_unknown: true }) }] }) }]
    });
    uncertain.finish("turn-auto-nested-uncertain", "The live count is 42.");
    assert.equal(getGoal(uncertainGoal.id)?.status, "blocked");
    assert.equal(getGoal(uncertainGoal.id)?.completion_audit, null);
  });
});
test("depth-limit encoded lifecycle and no-effect flags cannot promote auto-goal completion", () => {
  withWorkspace(() => {
    const encodedAtDepth = (leaf: Record<string, unknown>, wrapperCount: number) => {
      let value: unknown = JSON.stringify(leaf);
      for (let index = 0; index < wrapperCount; index += 1) value = { wrapper: value };
      return [{ type: "inputText", text: JSON.stringify(value) }];
    };
    const lifecycleCases = [
      ["not-dispatched", { request_dispatched: false }],
      ["outcome-unknown", { outcome_unknown: true }],
      ["reconciliation", { reconciliation_required: true }],
      ["not-ok", { ok: false }]
    ] as const;
    for (const [suffix, leaf] of lifecycleCases) {
      const sessionId = `session-auto-depth-${suffix}`;
      const goal = setAgentGoal(sessionId, {
        title: `Inspect ${suffix}`, objective: "Inspect the live model and verify the requested state.",
        acceptance_criteria: ["The live result is authoritative."],
        work_budget: { mode: "auto_goal", requested_effect: "apply" },
        work_items: [{ id: "auto.revit-work", title: "Inspect state", status: "in_progress" }]
      });
      const observer = createAutoGoalTurnObserver(sessionId);
      observer.observe({
        server: "revit_operator", tool: "revit_call_tool", success: true,
        arguments: { path: "/revit/find-elements", body: { category: "Mechanical Equipment" } },
        result: encodedAtDepth(leaf, 6)
      });
      observer.finish(`turn-auto-depth-${suffix}`, "The requested state is already satisfied; no model change was needed.");
      const persisted = getGoal(goal.id);
      assert.notEqual(persisted?.status, "complete", suffix);
      assert.equal(persisted?.completion_audit, null, suffix);
    }

    const noEffectGoal = setAgentGoal("session-auto-depth-completion-ineligible", {
      title: "Confirm no-op eligibility", objective: "Confirm whether a requested model edit is necessary.",
      acceptance_criteria: ["Any no-op is supported by authoritative evidence."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Confirm eligibility", status: "in_progress" }]
    });
    const noEffect = createAutoGoalTurnObserver("session-auto-depth-completion-ineligible");
    noEffect.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/find-elements", body: { category: "Mechanical Equipment" } },
      // The old depth-six walker returned false before parsing this encoded leaf.
      result: encodedAtDepth({ completionEligible: false, count: 1 }, 4)
    });
    noEffect.finish("turn-auto-depth-completion-ineligible", "The requested state is already satisfied; no model change was needed.");
    const noEffectPersisted = getGoal(noEffectGoal.id);
    assert.equal(noEffectPersisted?.status, "active");
    assert.equal(noEffectPersisted?.completion_audit, null);

    const blockingGoal = setAgentGoal("session-auto-depth-blocking-no-effect", {
      title: "Inspect blocked effect", objective: "Inspect whether the requested model effect can be satisfied.",
      acceptance_criteria: ["The requested effect is satisfied."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Inspect effect", status: "in_progress" }]
    });
    const blocking = createAutoGoalTurnObserver("session-auto-depth-blocking-no-effect");
    blocking.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/find-elements", body: { category: "Mechanical Equipment" } },
      result: encodedAtDepth({ requestedEffectSatisfied: false, count: 1 }, 4)
    });
    blocking.finish("turn-auto-depth-blocking-no-effect", "Inspection completed.");
    assert.equal(getGoal(blockingGoal.id)?.status, "blocked");
    assert.equal(getGoal(blockingGoal.id)?.completion_audit, null);
  });
});

test("authenticated Sidecar settlement records reported completion without minting trusted validation", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-sidecar-complete", {
      title: "Compute air terminal counts",
      objective: "Use Dynamic Revit code execution to compute counts by level.",
      acceptance_criteria: ["The requested work is complete.", "The result is supported by execution evidence."],
      work_budget: { mode: "sidecar_computer", source: "operator_desktop", requested_effect: "preview" },
      work_items: [{ id: "sidecar.requested-work", title: "Complete and verify the requested work", status: "in_progress" }]
    });

    const settled = settleSidecarComputerGoal("session-sidecar-complete", {
      outcome: "complete",
      turn_id: "dynamic-run-1",
      assistant_summary: "Computed 509 air terminals and verified the level sum.",
      successful_tools: 2,
      failed_tools: 3,
      verification_kind: "dynamic_revit_trusted_evidence",
      evidence: {
        run_id: "dynamic-run-1",
        execution_ok: true,
        report: { total: 509 },
        function_tools: [
          {
            tool_name: "revit_action",
            call_id: "action-1",
            path: "/revit/update-schedule-cell",
            status: "success",
            request_effect: "apply",
            request_dispatched: true,
            result: { ok: true, evidence: { result_json: { status: "Dry Run", candidateCount: 1 } } }
          },
          { tool_name: "revit_action", path: "/revit/unknown", status: "success", result: { outcome_unknown: true } },
          { tool_name: "revit_action", path: "/revit/reconcile", status: "success", result: { reconciliation_required: true } },
          { tool_name: "revit_action", path: "/revit/not-ok", status: "success", result: { ok: false } },
          {
            tool_name: "revit_action", path: "/revit/nested-unknown", status: "success",
            result: { wrapper: [{ result: { outcome_unknown: true } }] }
          },
          {
            tool_name: "revit_action", path: "/revit/content-reconcile", status: "success",
            result: [{ type: "inputText", text: JSON.stringify({ result: { reconciliation_required: true } }) }]
          },
          { tool_name: "revit_action", path: "/revit/ignored", status: "pending" },
          { tool_name: "", status: "failed" }
        ]
      }
    });

    assert.equal(settled.status, "active");
    assert.equal(settled.current_phase, "complete_with_issues");
    assert.equal(settled.work_budget?.completion_mode, "reported_complete");
    assert.equal(settled.work_budget?.terminal_reason, "verification_incomplete");
    assert.equal(settled.work_budget?.latest_authoritative_outcome, "verification_incomplete");
    assert.equal(settled.work_items[0]?.status, "complete");
    assert.equal(settled.completion_audit?.complete, false);
    assert.equal(settled.validation_log.length, 0);
    assert.match(settled.completion_audit?.recommendation || "", /retain complete-with-issues truth/);
    assert.match(JSON.stringify(getGoal(goal.id)?.evidence_log), /dynamic-run-1/);
    const reportedAction = settled.action_log.find(entry => entry.summary.includes("\/revit\/update-schedule-cell"));
    assert.match(reportedAction?.summary || "", /revit_action \/revit\/update-schedule-cell success/);
    assert.equal((reportedAction?.details as any)?.source, "operator_desktop_reported");
    assert.equal((reportedAction?.details as any)?.request_effect, "apply");
    assert.equal((reportedAction?.details as any)?.request_dispatched, true);
    assert.match(`${(reportedAction?.details as any)?.result_evidence_sha256 || ""}`, /^sha256:[a-f0-9]{64}$/);
    assert.match(`${(reportedAction?.details as any)?.receipt_sha256 || ""}`, /^sha256:[a-f0-9]{64}$/);
    const reportedActions = settled.action_log.filter(entry => (entry.details as any)?.source === "operator_desktop_reported");
    assert.equal(reportedActions.length, 6);
    assert.deepEqual(reportedActions.filter(entry => (entry.details as any)?.status === "failed").map(entry => (entry.details as any)?.path).sort(), [
      "/revit/content-reconcile", "/revit/nested-unknown", "/revit/not-ok", "/revit/reconcile", "/revit/unknown"
    ]);
    assert.equal(settled.work_budget?.reported_failed_tool_count, 3);
    assert.equal(settled.work_budget?.recovered_failure_count, 0);
  });
});

test("Sidecar settlement blocks rather than completing when the local run fails", () => {
  withWorkspace(() => {
    setAgentGoal("session-sidecar-blocked", {
      title: "Run a bounded Revit program",
      objective: "Run a bounded Revit program.",
      acceptance_criteria: ["The program completes."],
      work_budget: { mode: "sidecar_computer", source: "operator_desktop" },
      work_items: [{ id: "sidecar.requested-work", title: "Complete and verify the requested work", status: "in_progress" }]
    });
    const settled = settleSidecarComputerGoal("session-sidecar-blocked", {
      outcome: "blocked",
      turn_id: "dynamic-run-failed",
      reason: "Compilation failed before Revit dispatch.",
      successful_tools: 0,
      failed_tools: 1,
      evidence: { request_dispatched: false }
    });
    assert.equal(settled.status, "blocked");
    assert.equal(settled.work_items[0]?.status, "blocked");
    assert.equal(settled.work_budget?.terminal_reason, "execution_failure");
    assert.equal(settled.work_budget?.latest_authoritative_outcome, "blocked");
    assert.match(settled.blocker || "", /Compilation failed/);
    assert.equal(settled.completion_audit, null);
  });
});

test("canonical Sidecar settlement completes only from a bound native rollback preview", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-sidecar-canonical-preview", {
      title: "Preview one exact change", objective: "Preview one exact change without committing it.",
      acceptance_criteria: ["The exact preview completed and rolled back."],
      work_budget: { mode: "sidecar_computer", source: "operator_desktop", requested_effect: "preview" },
      work_items: [{ id: "sidecar.requested-work", title: "Complete and verify the requested work", status: "in_progress" }]
    });
    const run = ensureAssignmentRunForTurn("session-sidecar-canonical-preview", "sidecar-run-1", "outer_chat", true)!;
    const action = {
      action_id: "preview-1", method: "POST" as const, path: "/revit/native-api-mutation-ops",
      request_effect: "preview" as const,
      body: { elementIds: [101], transaction: { mode: "rollback" } }
    };
    journalAssignmentActions("session-sidecar-canonical-preview", [action], "outer_desktop");
    journalAssignmentToolResults("session-sidecar-canonical-preview", [{
      action_id: action.action_id, method: action.method, path: action.path, status: "done",
      request_dispatched: true,
      result_json: { canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1",
        assignment_id: goal.id, attempt_id: action.action_id, run_id: run.runId, generation: run.generation,
        requested_effect: "preview", method: action.method, path: action.path,
        action_signature: (action as any).action_signature, target_fingerprint: (action as any).target_fingerprint,
        request_dispatched: true, effect_state: "none", effect_reason: "native_transaction_rolled_back",
        effect_authority: "native_rollback", affected_target_identities: ["element_id:101"],
        receipt_refs: ["native:rollback:preview-1"], evidence_refs: [], settled_at_utc: new Date().toISOString()
      } }
    }], "operator_desktop");

    const settled = settleSidecarComputerGoal("session-sidecar-canonical-preview", {
      outcome: "complete", turn_id: "sidecar-turn-1", assistant_summary: "Preview completed.",
      assignment_run_id: run.runId, assignment_generation: run.generation,
      evidence: { function_tools: [] }
    });
    assert.equal(settled.status, "complete");
    assert.equal(settled.current_phase, "settled");
    assert.ok(settled.finished_at);
    assert.match(JSON.stringify(settled.assignment_control_plane), /native_rollback_preview_verified/);
  });
});

test("bound Sidecar action reports journal through the canonical contract but cannot self-prove apply", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-sidecar-reported-apply", {
      title: "Apply one exact change", objective: "Apply and verify one exact change.",
      acceptance_criteria: ["The exact change is independently verified."],
      work_budget: { mode: "sidecar_computer", source: "operator_desktop", requested_effect: "apply" },
      work_items: [{ id: "sidecar.requested-work", title: "Complete and verify the requested work", status: "in_progress" }]
    });
    const run = ensureAssignmentRunForTurn("session-sidecar-reported-apply", "sidecar-run-reported", "operator_desktop", true)!;

    const settled = settleSidecarComputerGoal("session-sidecar-reported-apply", {
      outcome: "complete", turn_id: "sidecar-turn-reported", assistant_summary: "The change succeeded.",
      assignment_run_id: run.runId, assignment_generation: run.generation,
      evidence: { function_tools: [{
        tool_name: "revit_action", call_id: "reported-apply-1", method: "POST", path: "/revit/move-elements",
        status: "success", request_effect: "apply", request_dispatched: true,
        result: { ok: true, canonical_attempt_settlement: { effect_state: "applied", effect_authority: "native_transaction" } }
      }] }
    });

    const projection = getGoal(goal.id)?.assignment_control_plane;
    assert.equal(settled.status, "active");
    assert.equal(settled.current_phase, "reconciling");
    assert.match(JSON.stringify(projection), /reported-apply-1/);
    assert.match(JSON.stringify(projection), /caller_report_requires_independent_settlement/);
    assert.equal(settled.completion_audit?.complete, false);
  });
});

test("a Sidecar delegate controller receipt never becomes a canonical Revit mutation attempt", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-sidecar-controller", {
      title: "Update one note", objective: "Update one note after obtaining required wording.",
      acceptance_criteria: ["The note is updated in place."],
      work_budget: { mode: "sidecar_computer", source: "operator_desktop", requested_effect: "apply" },
      work_items: [{ id: "sidecar.requested-work", title: "Complete and verify the requested work", status: "in_progress" }]
    });
    const run = ensureAssignmentRunForTurn("session-sidecar-controller", "sidecar-run-controller", "operator_desktop", true)!;
    journalAssignmentActions("session-sidecar-controller", [{
      action_id: "nested-note-read", method: "POST", path: "/revit/find-text-notes", request_effect: "read",
      body: { selected_only: true }
    }], "codex_app_server");
    journalAssignmentToolResults("session-sidecar-controller", [{
      action_id: "nested-note-read", method: "POST", path: "/revit/find-text-notes", request_effect: "read",
      status: "done", request_dispatched: true,
      result_json: { ok: true, notes: [{ element_id: 1478627, text: "Chase for Electrical Conduit" }] }
    }], "mcp_runtime");

    const settled = settleSidecarComputerGoal("session-sidecar-controller", {
      outcome: "complete", turn_id: "sidecar-turn-controller", assistant_summary: "I need the exact replacement wording.",
      assignment_run_id: run.runId, assignment_generation: run.generation,
      evidence: { function_tools: [
        {
          tool_name: "delegate_revit_task", call_id: "controller-call-1", method: "POST", path: "/chat",
          status: "success", request_effect: "apply", request_dispatched: true,
          result: { ok: true, teammate_loop_receipt: { turn_kind: "mutation", apply_action_id: null } }
        },
        {
          tool_name: "operator_request_clarification", call_id: "support-call-1", method: "POST", path: "/assignments/clarifications",
          status: "success", request_effect: "read", request_dispatched: true,
          result: { ok: true, status: "awaiting_user_input" }
        }
      ] }
    });

    const durable = getGoal(goal.id)!;
    const projection = reduceAssignmentControlPlane(
      goal.id,
      normalizeAssignmentControlPlane(durable.assignment_control_plane).events
    ).projection;
    assert.equal(settled.status, "active");
    assert.equal(projection.apply_opportunity_consumed, false);
    assert.equal(projection.unresolved_unknown_attempt_ids.length, 0);
    assert.equal(projection.attempts.length, 1);
    assert.equal(projection.attempts[0]?.action_path, "/revit/find-text-notes");
    assert.equal(projection.attempts[0]?.requested_effect, "read");
    assert.equal(projection.attempts[0]?.effect.state, "none");
    assert.ok((projection.attempts[0]?.receipt_refs.length ?? 0) > 0);
    assert.equal(projection.attempts.some((attempt) => attempt.action_path === "/chat"), false);
    assert.equal(projection.attempts.some((attempt) => attempt.action_path === "/assignments/clarifications"), false);
    assert.match(JSON.stringify(getGoal(goal.id)?.action_log), /delegate_revit_task \/chat success/);
    assert.match(JSON.stringify(getGoal(goal.id)?.action_log), /operator_request_clarification \/assignments\/clarifications success/);
  });
});

test("stale Sidecar callback is quarantined and cannot block an unknown canonical effect", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-sidecar-canonical-unknown", {
      title: "Apply one exact change", objective: "Apply one exact change.",
      acceptance_criteria: ["The exact change is independently verified."],
      work_budget: { mode: "sidecar_computer", source: "operator_desktop", requested_effect: "apply" },
      work_items: [{ id: "sidecar.requested-work", title: "Complete and verify the requested work", status: "in_progress" }]
    });
    const run = ensureAssignmentRunForTurn("session-sidecar-canonical-unknown", "sidecar-run-current", "outer_chat", true)!;
    journalAssignmentActions("session-sidecar-canonical-unknown", [{
      action_id: "apply-unknown", method: "POST", path: "/revit/move-elements", body: { elementIds: [101] }
    }], "outer_desktop");
    journalAssignmentToolResults("session-sidecar-canonical-unknown", [{
      action_id: "apply-unknown", method: "POST", path: "/revit/move-elements", status: "failed",
      request_dispatched: true, outcome_unknown: true, reconciliation_required: true, error: "courier timeout"
    }], "operator_desktop");

    const settled = settleSidecarComputerGoal("session-sidecar-canonical-unknown", {
      outcome: "blocked", turn_id: "stale-turn", reason: "I think it failed.",
      assignment_run_id: "sidecar-run-old", assignment_generation: run.generation - 1,
      evidence: { function_tools: [{ tool_name: "revit_action", path: "/revit/move-elements", status: "failed", request_dispatched: true, result: { outcome_unknown: true } }] }
    });
    assert.equal(settled.status, "active");
    assert.equal(settled.current_phase, "reconciling");
    assert.equal(settled.work_items[0]?.status, "in_progress");
    assert.equal(settled.work_budget?.latest_authoritative_outcome, "stale_or_unbound_outer_report");
    assert.match(JSON.stringify(getGoal(goal.id)?.action_log), /operator_desktop_quarantined_report/);
  });
});

test("a recovered Revit tool failure remains visible in trusted completion evidence", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-auto-recovered", {
      title: "Count air devices", objective: "Count live Revit air devices.",
      acceptance_criteria: ["The live count is verified."],
      work_budget: { mode: "auto_goal", requested_effect: "read" },
      work_items: [{ id: "auto.revit-work", title: "Count", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-auto-recovered");
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: false, arguments: { path: "/revit/quantify", body: { category: "Air Terminals" } }, error: "transient courier error" });
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/quantify", body: { category: "Air Terminals" } }, result: { total: 509 } });
    observer.finish("turn-recovered", "Found 509 air terminals.");

    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "complete");
    assert.match(JSON.stringify(persisted?.validation_log[0]?.evidence || {}), /after 1 earlier failed call; the final completion-relevant call succeeded/);
    assert.equal(persisted?.work_budget?.completion_mode, "successful_read");
    assert.equal(persisted?.work_budget?.terminal_reason, "completed_after_recovery");
    assert.equal(persisted?.work_budget?.latest_authoritative_outcome, "succeeded");
    assert.equal(persisted?.work_budget?.recovered_failure_count, 1);
    assert.match(`${persisted?.action_log.find(entry => entry.summary.includes("failed"))?.summary || ""}`, /transient courier error/);
  });
});

test("a later authoritative same-route success clears a predispatch contract failure with corrected arguments", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-predispatch-contract-recovery", {
      title: "Preview a view", objective: "Preview one exact Revit view creation.",
      acceptance_criteria: ["The preview receipt is verified."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Preview view", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-predispatch-contract-recovery");
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: false,
      arguments: { path: "/revit/create-view", body: { planType: "invalid", dryRun: true } },
      error: "Request violates published tool contract: planType is invalid."
    });
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/create-view", body: { viewType: "FloorPlan", levelId: 30, dryRun: true } },
      result: { ok: true, rollback_verified: true, temporaryElementIds: [404] }
    });
    observer.finish("turn-predispatch-contract-recovery", "The corrected rollback preview completed.");
    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "complete");
    assert.equal(persisted?.work_budget?.terminal_reason, "completed_after_recovery");
    assert.equal(persisted?.work_budget?.recovered_failure_count, 1);
  });
});

test("failed apply settlement cannot be recovered by a later read, a different target, or an uncertain receipt", () => {
  withWorkspace(() => {
    const blockedByRead = setAgentGoal("session-failed-apply-then-read", {
      title: "Update one mark", objective: "Apply and verify one exact Mark change.",
      acceptance_criteria: ["The exact target is updated and verified."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Update mark", status: "in_progress" }]
    });
    const readObserver = createAutoGoalTurnObserver("session-failed-apply-then-read");
    readObserver.observe({
      server: "revit_operator", tool: "revit_call_tool", success: false,
      arguments: { path: "/revit/set-parameter", body: { elementId: 101, parameter: "Mark", value: "ERU-1", apply: true } },
      error: "apply failed after dispatch"
    });
    readObserver.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/get-parameters", body: { elementIds: [101], parameterNames: ["Mark"] } },
      result: { values: [{ elementId: 101, Mark: "HRU-1" }] }
    });
    readObserver.finish("turn-failed-apply-then-read", "Read the unchanged Mark after the apply failed.");
    assert.equal(getGoal(blockedByRead.id)?.status, "blocked");

    const blockedByTarget = setAgentGoal("session-failed-apply-other-target", {
      title: "Update one mark", objective: "Apply and verify one exact Mark change.",
      acceptance_criteria: ["The exact target is updated and verified."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Update mark", status: "in_progress" }]
    });
    const targetObserver = createAutoGoalTurnObserver("session-failed-apply-other-target");
    targetObserver.observe({
      server: "revit_operator", tool: "revit_call_tool", success: false,
      arguments: { path: "/revit/set-parameter", body: { elementId: 101, parameter: "Mark", value: "ERU-1", apply: true } },
      error: "target 101 failed after dispatch"
    });
    targetObserver.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/set-parameter", body: { elementId: 202, parameter: "Mark", value: "ERU-2", apply: true } },
      result: { ok: true, changedElementIds: [202] }
    });
    targetObserver.finish("turn-failed-apply-other-target", "Updated target 202, but target 101 remains unresolved.");
    assert.equal(getGoal(blockedByTarget.id)?.status, "blocked");

    for (const [suffix, result] of [
      ["unknown", { outcome_unknown: true }],
      ["reconcile", { reconciliation_required: true }],
      ["not-ok", { ok: false }]
    ] as const) {
      const goal = setAgentGoal(`session-uncertain-${suffix}`, {
        title: "Inspect one target", objective: "Read and verify one exact target.",
        acceptance_criteria: ["The target state is verified."],
        work_budget: { mode: "auto_goal", requested_effect: "read" },
        work_items: [{ id: "auto.revit-work", title: "Inspect target", status: "in_progress" }]
      });
      const observer = createAutoGoalTurnObserver(`session-uncertain-${suffix}`);
      observer.observe({
        server: "revit_operator", tool: "revit_call_tool", success: true,
        arguments: { path: "/revit/get-parameters", body: { elementIds: [101], parameterNames: ["Mark"] } },
        result
      });
      observer.finish(`turn-uncertain-${suffix}`, "The receipt did not establish a trustworthy outcome.");
      assert.equal(getGoal(goal.id)?.status, "blocked");
    }
  });
});
test("a rollback preview may finish when exact temporary element readback proves absence", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-preview-rollback-absence", {
      title: "Preview a similar receptacle",
      objective: "Preview creating a similar receptacle and prove the rollback removed it.",
      acceptance_criteria: ["The preview is grounded and leaves no persistent element."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Preview and verify rollback", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-preview-rollback-absence");
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: false,
      arguments: { path: "/revit/audit-electrical-circuit-loading", body: { panelName: "P403", maxElements: 500 } },
      error: "Discovered electrical fixture inventory exceeds maxElements (500)."
    });
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/audit-electrical-circuit-loading", body: { panelName: "P403", maxElements: 5000 } },
      result: { panel: "P403", circuits: [{ circuit: "1" }] }
    });
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/create-similar-from-instance", body: { exemplarElementId: 1556486, dryRun: true } },
      result: [{ type: "inputText", text: JSON.stringify({
        status: "Planned", dryRun: true,
        placements: [{ elementId: null, temporaryElementId: 1735508 }]
      }) }]
    });
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: false,
      arguments: { path: "/revit/get-placement-context", body: { elementId: 1735508 } },
      error: "RevitCourierError: revit_action_failed: Element 1735508 not found."
    });
    observer.finish("turn-preview-rollback-absence", "Previewed temporary element 1735508 and confirmed it did not persist. Nothing was created or applied.", {
      stage: "report", verified: false, apply_attempts: 0, blocked_reason: null,
      preview_receipts: [{
        action_id: "mcp:1", path: "/revit/create-similar-from-instance", status: "success",
        evidence_sha256: `sha256:${"a".repeat(64)}`
      }]
    });

    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "complete");
    assert.equal(persisted?.completion_audit?.complete, true);
    assert.match(persisted?.completion_audit?.evidence_summary || "", /after 1 recovered failure/);
    assert.match(`${persisted?.action_log.find(entry => entry.summary.includes("Element 1735508 not found"))?.summary || ""}`, /Element 1735508 not found/);
  });
});

test("an unbound missing element cannot impersonate rollback verification", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-preview-unbound-absence", {
      title: "Preview a similar receptacle",
      objective: "Preview creating a similar receptacle and verify it.",
      acceptance_criteria: ["The preview is grounded and verified."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Preview and verify", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-preview-unbound-absence");
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/create-similar-from-instance", body: { exemplarElementId: 1556486, dryRun: true } },
      result: { status: "Planned", dryRun: true, placements: [{ temporaryElementId: 1735508 }] }
    });
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: false,
      arguments: { path: "/revit/get-placement-context", body: { elementId: 1556486 } },
      error: "RevitCourierError: revit_action_failed: Element 1556486 not found."
    });
    observer.finish("turn-preview-unbound-absence", "The requested verification did not complete.");

    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "blocked");
    assert.equal(persisted?.completion_audit, null);
  });
});

test("auto goal completion requires clean Revit evidence and rejects unrelated successes", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-auto-mixed", {
      title: "Count devices",
      objective: "Count live Revit devices.",
      acceptance_criteria: ["The live count is verified."],
      work_budget: { mode: "auto_goal" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-auto-mixed");
    observer.observe({ server: "browser", tool: "browser_open", success: true });
    observer.observe({ server: "revit_operator", tool: "revit_query", success: false, error: "bridge failed" });
    observer.finish("turn-mixed", "The browser step succeeded.");
    const persisted = listGoals(10).find(item => item.id === goal.id);
    assert.equal(persisted?.status, "blocked");
    assert.equal(persisted?.completion_audit?.complete ?? false, false);
    assert.equal(persisted?.validation_log.length, 0);
  });
});

test("discovery-only Revit calls cannot server-sign assignment completion", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-auto-discovery", {
      title: "Count devices",
      objective: "Count live Revit devices.",
      acceptance_criteria: ["The live count is verified."],
      work_budget: { mode: "auto_goal" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-auto-discovery");
    observer.observe({ server: "revit_operator", tool: "revit_search_tools", success: true, result: { tools: ["revit_query"] } });
    observer.observe({
      server: "revit_operator",
      tool: "revit_call_tool",
      success: true,
      arguments: { method: "POST", path: "/revit/regenerate", body: { refreshActiveView: true } },
      result: { ok: true }
    });
    observer.finish("turn-discovery", "I found the requested result.");
    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "active");
    assert.equal(persisted?.completion_audit, null);
    assert.equal(persisted?.validation_log.length, 0);

    const substantive = createAutoGoalTurnObserver("session-auto-discovery");
    substantive.observe({ server: "revit_operator", tool: "revit_query", success: true, result: { total: 509 } });
    substantive.finish("turn-query", "Found 509 air terminals.");
    assert.equal(getGoal(goal.id)?.status, "complete");
  });
});

test("incidental assignment-journaling text cannot block otherwise clean live Revit evidence", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-auto-incidental-goal-error", {
      title: "Count devices",
      objective: "Count live Revit devices.",
      acceptance_criteria: ["The live count is verified."],
      work_budget: { mode: "auto_goal" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-auto-incidental-goal-error");
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, result: { total: 509, family_type_count: 7 } });
    observer.finish("turn-clean-query", "Found 509 air terminals across seven types. Goal-status persistence failed because this embedded thread has no Codex goal.");
    assert.equal(getGoal(goal.id)?.status, "complete");
  });
});

test("an explicit task-level blocker still blocks after a successful discovery or partial read", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-auto-real-blocker", {
      title: "Count devices",
      objective: "Count live Revit devices.",
      acceptance_criteria: ["The live count is verified."],
      work_budget: { mode: "auto_goal" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-auto-real-blocker");
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, result: { partial_count: 20 } });
    observer.finish("turn-partial-query", "I could not complete the requested task because the model query was truncated; the result is not fully verified.");
    assert.equal(getGoal(goal.id)?.status, "blocked");
  });
});

test("a recovered exploratory read preserves the later model-state blocker in assignment truth", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-recovered-model-blocker", {
      title: "Preview a pipe connection",
      objective: "Find a compatible two-owner open connector pair and preview the route.",
      acceptance_criteria: ["The preview is grounded in a complete connector scan."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-recovered-model-blocker");
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: false,
      arguments: { path: "/revit/get-connectors", body: {} }, error: "elementIds is required"
    });
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { path: "/revit/get-connectors", body: { elementIds: [1680136], onlyOpenPhysicalConnectors: true } },
      result: { requestedCount: 1, scannedElementCount: 1, failedElementCount: 0, openPhysicalConnectorCount: 2 }
    });
    const blocker = "## Blocked — no feasible pair\nBoth open piping connectors belong to the same accessory, so no valid two-owner route exists. Nothing was modified.";
    observer.finish("turn-recovered-model-blocker", blocker);

    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "blocked");
    assert.match(persisted?.blocker || "", /both open piping connectors belong to the same accessory/i);
    assert.doesNotMatch(persisted?.blocker || "", /clean verified turn/i);
    assert.match(persisted?.action_log.find((entry) => entry.summary.includes("failed"))?.summary || "", /elementIds is required/i);
  });
});

test("a blocked heading or missing qualifying target cannot be server-signed as completion", () => {
  withWorkspace(() => {
    for (const [sessionId, assistantText] of [
      ["session-blocked-heading", "## Blocked — no qualifying row\nThe schedule has no writable airflow row."],
      ["session-blocker-heading", "**Blocker:** No defensible genuine duplicate was proven after rollback preview and readback."],
      ["session-explicit-incomplete", "No defensible candidate was proven, so the assignment remains incomplete rather than falsely identifying one."],
      ["session-missing-target", "The requested schedule was not found in the active Revit model."]
    ]) {
      const goal = setAgentGoal(sessionId, {
        title: "Update schedule", objective: "Preview the requested schedule update.",
        acceptance_criteria: ["The schedule preview is verified."],
        work_budget: { mode: "auto_goal", requested_effect: "preview" },
        work_items: [{ id: "auto.revit-work", title: "Preview", status: "in_progress" }]
      });
      const observer = createAutoGoalTurnObserver(sessionId);
      observer.observe({
        server: "revit_operator", tool: "revit_call_tool", success: true,
        arguments: { path: "/revit/update-schedule-cell", body: JSON.stringify({ apply: false, dryRun: true }) },
        result: { ok: true, candidateCount: 0 }
      });
      observer.finish(`turn-${sessionId}`, assistantText);
      assert.equal(getGoal(goal.id)?.status, "blocked");
      assert.equal(getGoal(goal.id)?.completion_audit?.complete ?? false, false);
    }
  });
});

test("a focused request for missing selection and placement context blocks a mutation assignment", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-missing-selection-clarification", {
      title: "Create similar",
      objective: "Add another device like the selected instance at the indicated location.",
      acceptance_criteria: ["The create-similar preview is grounded."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-missing-selection-clarification");
    observer.observe({
      server: "revit_operator",
      tool: "revit_get_context",
      success: true,
      result: { activeViewName: "COVER SHEET", selection: [] }
    });
    const clarification = [
      "The live selection is empty, and the active view is the COVER SHEET, so here has no model placement point.",
      "Could you open the intended model view, select the source device, and indicate the target location? I'll then preview Create Similar without applying it."
    ].join("\n\n");
    observer.finish("turn-missing-selection-clarification", clarification);

    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "blocked");
    assert.match(persisted?.blocker || "", /selection is empty/i);
    assert.equal(persisted?.completion_audit, null);
    assert.equal(persisted?.work_items[0]?.status, "blocked");
  });
});

test("a focused imperative clarification without a question mark blocks the assignment", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-imperative-selection-clarification", {
      title: "Add another selected device",
      objective: "Preview another device like the selected exemplar.",
      acceptance_criteria: ["The preview is grounded in the selected exemplar and target point."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-imperative-selection-clarification");
    observer.observe({
      server: "revit_operator",
      tool: "revit_get_context",
      success: true,
      result: { activeViewName: "COVER SHEET", selection: [] }
    });
    const clarification = "No device is selected, and the active view is the COVER SHEET. Please open the intended model view, select the exemplar device, and indicate the placement point for “here.”";
    observer.finish("turn-imperative-selection-clarification", clarification);

    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "blocked");
    assert.equal(persisted?.blocker, clarification);
    assert.equal(persisted?.completion_audit, null);
    assert.equal(persisted?.work_items[0]?.status, "blocked");
  });
});

test("a natural clarification with an adverbial missing-selection report blocks the assignment", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-currently-selection-clarification", {
      title: "Preview create similar",
      objective: "Add another one like the selected device, but preview only.",
      acceptance_criteria: ["The preview is grounded in the selected exemplar and target point."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-currently-selection-clarification");
    observer.observe({
      server: "revit_operator",
      tool: "revit_get_context",
      success: true,
      output: { document_title: "Snowdon Towers Sample Electrical", selection_count: 0 }
    });
    const clarification = "No device is currently selected in the live model. Please select the device you want copied and indicate the intended placement point, then I’ll preview Create Similar without applying it.";
    observer.finish("turn-currently-selection-clarification", clarification);
    const updated = getGoal(goal.id);
    assert.equal(updated?.status, "blocked");
    assert.equal(updated?.blocker, clarification);
  });
});

test("a rejected mutation cannot be server-signed by a later transaction preview", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-auto-preview-after-rejection", {
      title: "Duplicate a view", objective: "Duplicate and verify an HVAC floor plan.",
      acceptance_criteria: ["The duplicated view is verified."], work_budget: { mode: "auto_goal" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-auto-preview-after-rejection");
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/views", body: { action: "list" } }, result: { views: [{ id: 9948, name: "L2" }] } });
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: false, arguments: { path: "/revit/duplicate-view", body: { viewId: 9948 } }, error: "matching successful preview required" });
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/transaction-plan", body: { actions: [{ kind: "duplicateView" }] } }, result: { warnings: ["unknown kind"] } });
    observer.finish("turn-view-rejected", "Blocked by the enforced preview gate. Apply was rejected and verification is incomplete.");
    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "blocked");
    assert.equal(persisted?.completion_audit?.complete ?? false, false);
    assert.equal(persisted?.validation_log.length, 0);
  });
});

test("a blocked mutation receipt overrides successful tool observations in durable assignment state", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-auto-receipt-blocked", {
      title: "Create a schedule", objective: "Create and verify a mechanical equipment schedule.",
      acceptance_criteria: ["The new schedule is verified in Revit."], work_budget: { mode: "auto_goal" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-auto-receipt-blocked");
    observer.observe({ server: "revit_operator", tool: "revit_create_schedule", success: true, result: { id: 1542917 } });
    observer.observe({ server: "revit_operator", tool: "revit_list_schedules", success: true, result: { id: 1542917, fieldCount: 4 } });
    observer.finish("turn-receipt-blocked", "Created the schedule.", {
      stage: "blocked", verified: false, apply_attempts: 1, blocked_reason: "post_apply_verification_required"
    });
    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "blocked");
    assert.equal(persisted?.completion_audit?.complete ?? false, false);
    assert.equal(persisted?.validation_log.length, 0);
  });
});

test("a failed exploratory Revit call without stable identity cannot be repaired by an unrelated success", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-auto-recovered", {
      title: "Inspect a family", objective: "Inspect a family and produce a verified plan.",
      acceptance_criteria: ["The plan is grounded in live evidence."], work_budget: { mode: "auto_goal" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-auto-recovered");
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: false, error: "First request used the wrong argument shape." });
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, result: { family: "HeatRecoveryUnit", type: "HRU" } });
    observer.finish("turn-recovered", "Recovered with the documented argument shape and completed the read-only family plan. The family appears editable, but direct family-file confirmation was blocked by the inspection-only gate. No model changes were made.");
    assert.equal(getGoal(goal.id)?.status, "blocked");
  });
});

test("a canonical non-dispatched registry rejection does not poison a corrected substantive read", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-registry-retry", {
      title: "Observe a plan", objective: "Capture and inspect one plan without changing the model.",
      acceptance_criteria: ["The plan observation is grounded."],
      work_budget: { mode: "auto_goal", requested_effect: "read" },
      work_items: [{ id: "auto.revit-work", title: "Observe plan", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-registry-retry");
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: false,
      arguments: { method: "GET", path: "/revit/views?limit=200" },
      result: [{ type: "inputText", text: JSON.stringify({
        schema: "revit-operator.mcp-pre-dispatch-failure.v1",
        ok: false,
        code: "mcp_unknown_tool_path",
        phase: "registry_validation",
        retryable: true,
        request_dispatched: false,
        outcome_unknown: false,
        method: "GET",
        path: "/revit/views?limit=200"
      }) }],
      error: "Unknown tool path; the target request was not dispatched."
    });
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { method: "POST", path: "/revit/views", body: { action: "list", limit: 200 } },
      result: { views: [{ id: 9948, name: "L2", type: "FloorPlan" }] }
    });
    observer.finish("turn-registry-retry", "Captured and inspected L2. No model changes were performed.");
    const completed = getGoal(goal.id);
    assert.equal(completed?.status, "complete");
    assert.match(JSON.stringify(completed?.validation_log[0]?.evidence || {}), /no failed calls/);
    assert.match(completed?.action_log.find((entry) => entry.summary.includes("failed"))?.summary || "", /not dispatched/i);
  });
});

test("view activation is navigation rather than an apply during a preview-only assignment", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-preview-navigation", {
      title: "Inspect view range",
      objective: "Preview the smallest defensible view-range change without applying it.",
      acceptance_criteria: ["The selected plan and its current visibility settings are verified."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-preview-navigation");
    observer.observe({
      server: "revit_operator",
      tool: "revit_call_tool",
      success: true,
      arguments: { method: "POST", path: "/revit/activate-view", body: { viewId: 9948, zoomToFit: false } },
      result: { ok: true, activeViewId: 9948, activeViewName: "L2" }
    });
    observer.observe({
      server: "revit_operator",
      tool: "revit_call_tool",
      success: true,
      arguments: { method: "POST", path: "/revit/native-api-ops", body: { operations: [{ op: "call", memberId: "ViewPlan.GetViewRange" }] } },
      result: { ok: true, read_only: true, bottom: "L2 + 0 ft", view_depth: "L2 + 0 ft", underlay: "None" }
    });
    observer.finish("turn-preview-navigation", [
      "Chosen view L2 (9948).",
      "Bottom and View Depth are L2 + 0 ft; Underlay is None.",
      "No defensible change was identified; the Revit model was not modified."
    ].join("\n"));
    assert.equal(getGoal(goal.id)?.status, "complete");
    assert.doesNotMatch(getGoal(goal.id)?.blocker || "", /effect reconciliation/);
  });
});

test("a corrected MCP argument rejection can finish a grounded already-satisfied preview", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-view-range-noop", {
      title: "Fix the view range",
      objective: "Preview the smallest defensible view-range change without applying it.",
      acceptance_criteria: ["The selected plan and its current view range are verified."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview the view range", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-view-range-noop");
    observer.observe({
      server: "revit_operator", tool: "revit_native_api_ops", success: true,
      result: { viewId: 9948, viewName: "L2", bottom: { level: "L2", offset: 0 }, viewDepth: { level: "L2", offset: 0 } }
    });
    observer.observe({
      server: "revit_operator", tool: "revit_native_api_ops", success: false,
      error: "MCP error -32602: Input validation error: Invalid arguments for tool revit_native_api_ops: Array must contain at most 16 element(s)"
    });
    observer.observe({
      server: "revit_operator", tool: "revit_native_api_ops", success: true,
      result: { underlay: "None", viewId: 9948, associatedLevelId: 9946 }
    });
    observer.finish("turn-view-range-noop", [
      "## Preview blocked — model unchanged",
      "Chosen eligible plan: **L2** — ID `9948`.",
      "Bottom and View Depth already stop at L2 + 0 ft; Underlay is already **None**.",
      "No defensible adjustment was identified.",
      '{ "status": "blocked_no_defensible_change", "proposedChange": null, "modelAltered": false }'
    ].join("\n"));
    const completed = getGoal(goal.id);
    assert.equal(completed?.status, "complete");
    assert.equal(completed?.work_budget?.completion_mode, "verified_noop");
    assert.match(JSON.stringify(completed?.validation_log[0]?.evidence || {}), /schema or registry rejection was recorded before dispatch/i);
    assert.match(completed?.action_log.find((entry) => entry.summary.includes("failed"))?.summary || "", /MCP error -32602/i);
  });
});

test("a structured no-op preview with an empty change set completes as verified no-op", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-structured-view-range-noop", {
      title: "Fix the view range",
      objective: "Preview the smallest defensible view-range change without applying it.",
      acceptance_criteria: ["The selected plan and its current view range are verified."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview the view range", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-structured-view-range-noop");
    observer.observe({
      server: "revit_operator", tool: "revit_native_api_ops", success: true,
      result: { viewId: 9948, viewName: "L2", bottom: { level: "L2", offset: 0 }, viewDepth: { level: "L2", offset: 0 }, underlay: "None" }
    });
    observer.finish("turn-structured-view-range-noop", [
      "## View Range preview",
      "Chosen view: L2 — ID 9948.",
      "No change. Bottom and View Depth already stop at L2. Altering it would not be defensible without evidence that View Range is causing the visibility.",
      '{ "status": "no_op", "proposedChanges": [], "dryRun": true, "applied": false, "modelModified": false }'
    ].join("\n"));
    const completed = getGoal(goal.id);
    assert.equal(completed?.status, "complete");
    assert.equal(completed?.work_budget?.completion_mode, "verified_noop");
  });
});

test("a later verified no-op remains authoritative after an earlier rejected no-effect preview", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-rejected-preview-then-verified-noop", {
      title: "Fix the view range",
      objective: "Preview the smallest defensible view-range change without applying it.",
      acceptance_criteria: ["The selected plan and its current view range are verified."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview the view range", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-rejected-preview-then-verified-noop");
    observer.observe({
      server: "revit_operator", tool: "revit_native_api_ops", success: true,
      arguments: { mode: "preview" },
      result: { status: "NoOp", completionEligible: false, modelModified: false }
    });
    observer.observe({
      server: "revit_operator", tool: "revit_native_api_ops", success: true,
      arguments: { mode: "read" },
      result: { viewId: 9948, viewName: "L2", bottom: "L2 + 0 ft", viewDepth: "L2 + 0 ft", underlay: "None" }
    });
    observer.finish("turn-rejected-preview-then-verified-noop", [
      "Chosen view L2 (9948).",
      "Bottom and View Depth already stop at L2 + 0 ft; Underlay is already None.",
      "No change was required and the Revit model was not modified."
    ].join("\n"));

    const completed = getGoal(goal.id);
    assert.equal(completed?.status, "complete");
    assert.equal(completed?.work_budget?.latest_authoritative_outcome, "succeeded");
    assert.equal(completed?.work_budget?.completion_mode, "verified_noop");
    assert.equal(completed?.work_budget?.terminal_reason, "verified_noop");
    assert.equal(completed?.work_budget?.rejected_no_effect_count, 1);
  });
});

test("a natural no-op receipt that says the model was not modified completes as verified no-op", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-natural-view-range-noop", {
      title: "Fix the view range",
      objective: "Preview the smallest defensible view-range change without applying it.",
      acceptance_criteria: ["The selected plan and its current view range are verified."],
      work_budget: { mode: "auto_goal", requested_effect: "preview" },
      work_items: [{ id: "auto.revit-work", title: "Inspect and preview the view range", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-natural-view-range-noop");
    observer.observe({
      server: "revit_operator", tool: "revit_native_api_ops", success: true,
      result: { viewId: 9948, viewName: "L2", bottom: { level: "L2", offset: 0 }, viewDepth: { level: "L2", offset: 0 }, underlay: "None" }
    });
    observer.finish("turn-natural-view-range-noop", [
      "## Dry-run preview — no change",
      "Status: no_op",
      "View Depth already equals the Bottom plane.",
      "Raising View Depth is neither possible nor defensible without also raising Bottom.",
      "No transaction was applied and the model was not modified."
    ].join("\n"));
    const completed = getGoal(goal.id);
    assert.equal(completed?.status, "complete");
    assert.equal(completed?.work_budget?.completion_mode, "verified_noop");
  });
});

test("only the current paused or blocked assignment gates dispatch and prevents duplicates", () => {
  withWorkspace(() => {
    const historical = setAgentGoal("session-current-only", {
      title: "Old task", objective: "Old task.", acceptance_criteria: ["Old task done."]
    });
    transitionGoal(historical.id, "canceled", "Superseded.");
    const current = setAgentGoal("session-current-only", {
      title: "Current task", objective: "Current task.", acceptance_criteria: ["Current task done."]
    });
    assert.equal(findInterruptedAutoGoalForSession("session-current-only"), null);
    markAgentGoalBlocked("session-current-only", "Needs explicit recovery.");
    assert.equal(findInterruptedAutoGoalForSession("session-current-only")?.id, current.id);
    assert.equal(getCurrentGoalForSession("session-current-only")?.status, "blocked");
    assert.throws(() => setAgentGoal("session-current-only", {
      title: "Duplicate", objective: "Must not start.", acceptance_criteria: ["No duplicate."]
    }), /explicitly resume or clear/);
    assert.equal(listGoals(10).filter(goal => goal.related_session_id === "session-current-only").length, 2);
  });
});

test("a verified apply is not poisoned by a later known pre-dispatch busy response", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-verified-before-busy", {
      title: "Rename HRUs", objective: "Rename all HRUs to ERUs and verify the Mark values.",
      acceptance_criteria: ["Every changed Mark is verified."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-verified-before-busy");
    observer.observe({
      server: "revit_operator", tool: "run_dynamic_revit_program", success: true,
      arguments: { mode: "apply" }, result: { committed: true, verified: true, modifiedCount: 37 }
    });
    observer.observe({
      server: "revit_operator", tool: "run_dynamic_revit_program", success: false,
      arguments: { mode: "read" },
      error: "Bridge returned 409: {\"code\":\"revit_external_event_busy\",\"retryable\":true,\"outcome_unknown\":false}"
    });
    observer.finish("turn-verified-before-busy", "Renamed and verified all 37 equipment Marks.");
    assert.equal(getGoal(goal.id)?.status, "complete");
  });
});

test("an explicit no-effect success cannot server-sign apply completion", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-explicit-no-effect", {
      title: "Open plumbing model", objective: "Open and activate the plumbing sample model.",
      acceptance_criteria: ["The plumbing model is active."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Open model", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-explicit-no-effect");
    observer.observe({
      server: "revit_operator", tool: "revit_open_model", success: true,
      arguments: { filePath: "Snowdon Towers Sample Plumbing.rvt", discardExistingOpenDocument: false },
      result: {
        status: "Already Loaded As Link",
        completionEligible: false,
        requiresExplicitUnloadAndOpen: true,
        linkedHosts: [{ hostTitle: "Snowdon Towers Sample HVAC" }]
      }
    });
    observer.finish("turn-explicit-no-effect", "The target is loaded as a link and must be explicitly unloaded before it can be activated.");
    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "blocked");
    assert.equal(persisted?.completion_audit?.complete ?? false, false);
    assert.equal(persisted?.validation_log.length, 0);
  });
});

test("a substantive retry may recover after an explicit no-effect response", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-explicit-no-effect-recovered", {
      title: "Open plumbing model", objective: "Open and activate the plumbing sample model.",
      acceptance_criteria: ["The plumbing model is active."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" },
      work_items: [{ id: "auto.revit-work", title: "Open model", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-explicit-no-effect-recovered");
    observer.observe({
      server: "revit_operator", tool: "revit_open_model", success: true,
      arguments: { filePath: "Snowdon Towers Sample Plumbing.rvt", discardExistingOpenDocument: false },
      result: { status: "Already Loaded As Link", requiresExplicitUnloadAndOpen: true }
    });
    observer.observe({
      server: "revit_operator", tool: "revit_open_model", success: true,
      arguments: { filePath: "Snowdon Towers Sample Plumbing.rvt", discardExistingOpenDocument: true },
      result: { status: "Unloaded Link and Activated", title: "Snowdon Towers Sample Plumbing" }
    });
    observer.finish("turn-explicit-no-effect-recovered", "Opened and activated the plumbing sample model after unloading its link from the HVAC host.");
    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "complete");
    assert.equal(persisted?.completion_audit?.complete, true);
    assert.match(JSON.stringify(persisted?.validation_log[0]?.evidence || {}), /after 1 earlier failed call/);
  });
});

test("a fresh executable request may supersede a blocked automatic assignment", () => {
  withWorkspace(() => {
    const blocked = setAgentGoal("session-fresh-retry", {
      title: "Rename HRUs",
      objective: "Rename all HRUs to ERUs and keep the numbers.",
      acceptance_criteria: ["All matching Mark values are changed and verified."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" }
    });
    markAgentGoalBlocked("session-fresh-retry", "Known pre-dispatch write rejection.");

    assert.equal(supersedeBlockedAutoGoalForFreshRequest("session-fresh-retry"), true);
    assert.equal(getGoal(blocked.id)?.status, "canceled");
    assert.equal(getCurrentGoalForSession("session-fresh-retry"), null);

    const retry = setAgentGoal("session-fresh-retry", {
      title: "Rename HRUs retry",
      objective: "Rename all HRUs to ERUs and keep the numbers.",
      acceptance_criteria: ["All matching Mark values are changed and verified."],
      work_budget: { mode: "auto_goal", requested_effect: "apply" }
    });
    assert.equal(retry.status, "active");
    assert.notEqual(retry.id, blocked.id);
  });
});

test("fresh-request supersession never clears paused or manual assignments", () => {
  withWorkspace(() => {
    const paused = setAgentGoal("session-paused", {
      title: "Paused",
      objective: "Pause this assignment.",
      acceptance_criteria: ["Resume explicitly."],
      work_budget: { mode: "auto_goal" }
    });
    transitionGoal(paused.id, "paused", "User paused.");
    assert.equal(supersedeBlockedAutoGoalForFreshRequest("session-paused"), false);
    assert.equal(getGoal(paused.id)?.status, "paused");

    const manual = setAgentGoal("session-manual", {
      title: "Manual",
      objective: "A manually structured assignment.",
      acceptance_criteria: ["Resume explicitly."],
      work_budget: { mode: "manual" }
    });
    markAgentGoalBlocked("session-manual", "Needs a decision.");
    assert.equal(supersedeBlockedAutoGoalForFreshRequest("session-manual"), false);
    assert.equal(getGoal(manual.id)?.status, "blocked");
  });
});

test("current session lookup is not evicted by unrelated global goal history", () => {
  withWorkspace(() => {
    const current = setAgentGoal("session-outside-window", {
      title: "Paused assignment", objective: "Remain current.", acceptance_criteria: ["Explicitly resumed or cleared."]
    });
    transitionGoal(current.id, "paused", "Checkpointed.");
    for (let index = 0; index < 205; index += 1) {
      createGoal({
        title: `Unrelated ${index}`,
        objective: "Unrelated durable history.",
        acceptance_criteria: ["History exists."],
        related_session_id: `other-session-${index}`
      });
    }
    assert.equal(getCurrentGoalForSession("session-outside-window")?.id, current.id);
    assert.throws(() => setAgentGoal("session-outside-window", {
      title: "Duplicate", objective: "Must not start.", acceptance_criteria: ["No duplicate."]
    }), /explicitly resume or clear/);
  });
});

test("active session progress and clearing are not evicted by unrelated global goal history", () => {
  withWorkspace(() => {
    const active = setAgentGoal("session-active-outside-window", {
      title: "Active assignment", objective: "Remain writable.", acceptance_criteria: ["Progress can be recorded."]
    });
    for (let index = 0; index < 205; index += 1) {
      createGoal({
        title: `Newer unrelated ${index}`,
        objective: "Unrelated durable history.",
        acceptance_criteria: ["History exists."],
        related_session_id: `newer-other-session-${index}`
      });
    }
    assert.equal(getActiveGoalForSession("session-active-outside-window")?.id, active.id);
    assert.equal(appendGoalProgress("session-active-outside-window", { summary: "Still reachable." }).id, active.id);
    assert.equal(clearAgentGoal("session-active-outside-window", "Done testing.")?.id, active.id);
    assert.equal(getGoal(active.id)?.status, "canceled");
  });
});

test("goal JSON uses revisions and recovers the last complete copy after primary corruption", () => {
  withWorkspace(() => {
    const created = setAgentGoal("session-atomic", {
      title: "Atomic goal", objective: "Persist atomically.", acceptance_criteria: ["State survives corruption."]
    });
    const updated = updateGoal(created.id, { progress_summary: "Second revision." });
    assert.equal(updated.revision, 2);
    const filePath = path.join(process.env.OPERATOR_WORKSPACE_ROOT!, "artifacts", "goals", created.id, "goal.json");
    fs.writeFileSync(filePath, "{torn", "utf8");
    const recovered = getGoal(created.id);
    assert.equal(recovered?.id, created.id);
    assert.equal(recovered?.revision, 1);
  });
});
