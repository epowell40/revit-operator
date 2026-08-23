import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGoal } from "../src/goals/service.js";
import { ensureAssignmentRunForTurn, journalAssignmentActions, journalAssignmentToolResults } from "../src/assignments/turn_journal.js";
import { recordAssignmentTurnProgress, settleAssignmentTurn } from "../src/assignments/turn_settlement.js";
import { assignmentModelReceiptObserver } from "../src/assignments/model_call_budget.js";

function workspace(fn: () => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-turn-settlement-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function goal(requestedEffect: "read" | "preview" | "apply" = "apply") {
  createGoal({
    title: "Canonical settlement", objective: "Change element 101 and verify it.",
    acceptance_criteria: ["Element 101 has the expected state."], status: "active",
    related_session_id: "settlement-session", work_budget: { mode: "auto_goal", requested_effect: requestedEffect }
  });
  ensureAssignmentRunForTurn("settlement-session", "run-1", "test", true);
}

function applyAndResult(native: boolean): void {
  journalAssignmentActions("settlement-session", [{
    action_id: "apply-1", method: "POST", path: "/revit/native-api-mutation-ops",
    body: { elementIds: [101], transaction: { mode: "commit" } }
  }], "codex");
  journalAssignmentToolResults("settlement-session", [{
    action_id: "apply-1", method: "POST", path: "/revit/native-api-mutation-ops", status: "done",
    request_dispatched: true,
    result_json: native ? { canonical_attempt_settlement: {
      schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "apply-1",
      requested_effect: "apply", method: "POST", path: "/revit/native-api-mutation-ops",
      request_dispatched: true, effect_state: "applied", effect_reason: "native_transaction_committed",
      effect_authority: "native_transaction", affected_target_identities: ["element_id:101"], receipt_refs: ["native:1"], evidence_refs: []
    } } : { ok: true }
  }], "desktop");
}

function verificationRead(actionId = "verify-1"): void {
  journalAssignmentActions("settlement-session", [{
    action_id: actionId, method: "POST", path: "/revit/get-element-summary", body: { elementIds: [101] }
  }], "codex");
  journalAssignmentToolResults("settlement-session", [{
    action_id: actionId, method: "POST", path: "/revit/get-element-summary", status: "done",
    request_dispatched: true, result_json: {
      elements: [{ id: 101, state: "expected" }],
      canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1", attempt_id: actionId,
        requested_effect: "read", method: "POST", path: "/revit/get-element-summary",
        request_dispatched: true, effect_state: "none", effect_reason: "read_has_no_persistent_effect",
        effect_authority: "native_host", affected_target_identities: [], receipt_refs: [`native:${actionId}`], evidence_refs: []
      }
    }
  }], "desktop");
}

test("target-bound readback reconciles unknown apply and reaches verified terminal truth", () => {
  workspace(() => {
    goal();
    applyAndResult(false);
    verificationRead();
    const settled = settleAssignmentTurn("settlement-session", "apply", {
      schema: "revit-operator.teammate-loop-receipt.v1", turn_kind: "mutation", context_state: "live", stage: "report",
      preview_action_ids: [], apply_action_id: "apply-1", verification_action_ids: ["verify-1"], apply_attempts: 1,
      verified: true, verification_mode: "target_bound_readback", verification_action_id: "verify-1",
      verification_evidence_sha256: `sha256:${"a".repeat(64)}`, blocked_reason: null
    });

    assert.equal(settled.completed, true);
    assert.equal(settled.projection?.terminal_state, "verified");
    assert.equal(settled.projection?.attempts.find(attempt => attempt.attempt_id === "apply-1")?.effect.state, "applied");
  });
});

test("explicit caller apply receipt cannot upgrade unknown canonical truth", () => {
  workspace(() => {
    goal();
    applyAndResult(false);
    const settled = settleAssignmentTurn("settlement-session", "apply", {
      schema: "revit-operator.teammate-loop-receipt.v1", turn_kind: "mutation", context_state: "live", stage: "report",
      preview_action_ids: [], apply_action_id: "apply-1", verification_action_ids: [], apply_attempts: 1,
      verified: true, verification_mode: "explicit_apply_receipt", verification_action_id: "apply-1",
      verification_evidence_sha256: `sha256:${"b".repeat(64)}`, blocked_reason: null
    });

    assert.equal(settled.completed, false);
    assert.deepEqual(settled.projection?.unresolved_unknown_attempt_ids, ["apply-1"]);
  });
});

test("native applied truth enters and passes exact bounded verification", () => {
  workspace(() => {
    goal();
    applyAndResult(true);
    verificationRead();
    const settled = settleAssignmentTurn("settlement-session", "apply", {
      schema: "revit-operator.teammate-loop-receipt.v1", turn_kind: "mutation", context_state: "live", stage: "report",
      preview_action_ids: [], apply_action_id: "apply-1", verification_action_ids: ["verify-1"], apply_attempts: 1,
      verified: true, verification_mode: "target_bound_readback", verification_action_id: "verify-1",
      verification_evidence_sha256: `sha256:${"c".repeat(64)}`, blocked_reason: null
    });
    assert.equal(settled.projection?.terminal_state, "verified");
    assert.equal(settled.projection?.attempts.find(attempt => attempt.attempt_id === "verify-1")?.verification.state, "passed");
  });
});

test("verified no-op requires two fresh observations of the same target", () => {
  workspace(() => {
    goal();
    verificationRead("read-1");
    assert.equal(settleAssignmentTurn("settlement-session", "apply").completed, false);
    verificationRead("read-2");
    const settled = settleAssignmentTurn("settlement-session", "apply");
    assert.equal(settled.completed, true);
    assert.equal(settled.verified_noop, true);
    assert.equal(settled.projection?.terminal_reason, "verified_noop_two_fresh_target_observations");
  });
});

test("production turn watchdog diagnoses, switches, then terminates repeated no progress", () => {
  workspace(() => {
    goal("read");
    journalAssignmentActions("settlement-session", [{
      action_id: "discover-1", method: "POST", path: "/revit/tool-search", body: { query: "same" }
    }], "outer");
    assert.equal(recordAssignmentTurnProgress("settlement-session", "turn-1")?.progress.decision, "continue");
    assert.equal(recordAssignmentTurnProgress("settlement-session", "turn-2")?.progress.decision, "diagnose");
    assert.equal(recordAssignmentTurnProgress("settlement-session", "turn-3")?.progress.decision, "switch_tool_family");
    const terminal = recordAssignmentTurnProgress("settlement-session", "turn-4");
    assert.equal(terminal?.progress.decision, "terminate");
    assert.equal(terminal?.terminal_state, "blocked");
  });
});

test("nested provider receipts share the Assignment watchdog budget", () => {
  workspace(() => {
    goal("read");
    let terminal = 0;
    const observe = assignmentModelReceiptObserver("settlement-session", () => { terminal += 1; });
    for (let index = 0; index < 4; index += 1) {
      observe({
        schema: "revit-operator.model-call-receipt.v1", call_id: `nested-${index}`,
        provider: "openai", route: index % 2 === 0 ? "desktop_computer" : "codex_agent",
        requested_model: "gpt-5.6-sol", model: "gpt-5.6-sol", reasoning_effort: "medium",
        started_at_utc: new Date().toISOString(), duration_ms: 1, success: true,
        response_status: "200", error_code: null,
        tokens: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 }
      });
    }
    assert.equal(terminal, 1);
  });
});
