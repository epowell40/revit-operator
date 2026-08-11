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
import { completeAutoGoalFromValidatedTurn, recordAutoGoalToolObservation } from "../src/goals/auto_goal_runtime.js";
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

  const single = classifyAutoGoalRequest("Open sheet E101.");
  assert.equal(single.shouldStart, true);

  const airCount = classifyAutoGoalRequest("Please count the air devices on the project and break the different types down too.");
  assert.equal(airCount.shouldStart, true);
  assert.ok(airCount.signals.includes("live Revit model work"));

  const conceptual = classifyAutoGoalRequest("Explain why construction documents use schedules.");
  assert.equal(conceptual.shouldStart, false);
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
