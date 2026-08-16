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
import { completeAutoGoalFromValidatedTurn, createAutoGoalTurnObserver, findInterruptedAutoGoalForSession, recordAutoGoalToolObservation, supersedeBlockedAutoGoalForFreshRequest } from "../src/goals/auto_goal_runtime.js";
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

  const delegatedAirCount = classifyAutoGoalRequest(
    "Inspect the open Revit model and count all HVAC air terminal diffusers. Break the total out by family/type and report the selection criteria used."
  );
  assert.equal(delegatedAirCount.shouldStart, true);
  assert.equal(delegatedAirCount.requestedEffect, "read");

  const namedOpenModelCapture = classifyAutoGoalRequest(
    "Read-only observe-and-verify loop: locate an eligible existing plan view in the open Snowdon Towers Sample HVAC model. Capture an image, inspect its visible elements, and do not modify the model, views, or document."
  );
  assert.equal(namedOpenModelCapture.shouldStart, true);
  assert.equal(namedOpenModelCapture.requestedEffect, "read");

  const openButtonCommand = classifyAutoGoalRequest(
    "Click the Open button to open Snowdon Towers Sample HVAC model, then inspect its air terminals."
  );
  assert.equal(openButtonCommand.requestedEffect, "apply");

  const explicitOpen = classifyAutoGoalRequest("Open this Revit model, then inspect its air terminals.");
  assert.equal(explicitOpen.shouldStart, true);
  assert.equal(explicitOpen.requestedEffect, "apply");

  const preview = classifyAutoGoalRequest("Preview changing all HRU Marks to ERU, but do not commit it.");
  assert.equal(preview.requestedEffect, "preview");

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
    "Turn off Rooms in the Level 4 HVAC view."
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
    observer.observe({
      server: "revit_operator", tool: "revit_call_tool", success: true,
      arguments: { method: "POST", path: "/revit/tag-elements", body: { elementIds: [1544911], dryRun: true } },
      result: { status: "Dry Run", dryRun: true, plannedToTag: 1 }
    });
    observer.finish("turn-preview-with-export", "Preview complete; no model changes were applied.");
    assert.equal(getGoal(goal.id)?.status, "complete");
  });
});

test("a verified no-op can recover from an exploratory Revit error only after a later substantive read succeeds", () => {
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
    assert.equal(completed?.status, "complete");
    assert.equal(completed?.work_budget?.completion_mode, "verified_noop");
    assert.match(completed?.completion_audit?.evidence_summary || "", /after 1 recovered failure/);
    assert.match(JSON.stringify(completed?.validation_log[0]?.evidence || {}), /after 1 earlier failed call; the final completion-relevant call succeeded/);

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

test("a recovered Revit tool failure remains visible in trusted completion evidence", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-auto-recovered", {
      title: "Count air devices", objective: "Count live Revit air devices.",
      acceptance_criteria: ["The live count is verified."],
      work_budget: { mode: "auto_goal", requested_effect: "read" },
      work_items: [{ id: "auto.revit-work", title: "Count", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-auto-recovered");
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: false, arguments: { path: "/revit/quantify" }, error: "invalid category token" });
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, arguments: { path: "/revit/quantify" }, result: { total: 509 } });
    observer.finish("turn-recovered", "Found 509 air terminals.");

    const persisted = getGoal(goal.id);
    assert.equal(persisted?.status, "complete");
    assert.match(JSON.stringify(persisted?.validation_log[0]?.evidence || {}), /after 1 earlier failed call; the final completion-relevant call succeeded/);
    assert.match(`${persisted?.action_log.find(entry => entry.summary.includes("failed"))?.summary || ""}`, /invalid category token/);
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

test("a blocked heading or missing qualifying target cannot be server-signed as completion", () => {
  withWorkspace(() => {
    for (const [sessionId, assistantText] of [
      ["session-blocked-heading", "## Blocked — no qualifying row\nThe schedule has no writable airflow row."],
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

test("a failed exploratory Revit call can be repaired by a later substantive success", () => {
  withWorkspace(() => {
    const goal = setAgentGoal("session-auto-recovered", {
      title: "Inspect a family", objective: "Inspect a family and produce a verified plan.",
      acceptance_criteria: ["The plan is grounded in live evidence."], work_budget: { mode: "auto_goal" },
      work_items: [{ id: "auto.revit-work", title: "Complete and verify the requested Revit work", status: "in_progress" }]
    });
    const observer = createAutoGoalTurnObserver("session-auto-recovered");
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: false, error: "First request used the wrong argument shape." });
    observer.observe({ server: "revit_operator", tool: "revit_call_tool", success: true, result: { family: "HeatRecoveryUnit", type: "HRU" } });
    observer.finish("turn-recovered", "Recovered with the documented argument shape and completed the read-only family plan.");
    assert.equal(getGoal(goal.id)?.status, "complete");
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
