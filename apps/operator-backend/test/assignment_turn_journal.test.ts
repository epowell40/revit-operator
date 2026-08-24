import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGoal, getGoal } from "../src/goals/service.js";
import {
  ensureAssignmentRunForTurn,
  journalAssignmentActions,
  journalAssignmentToolObservation,
  journalAssignmentToolResults
} from "../src/assignments/turn_journal.js";

function withWorkspace(fn: () => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-turn-journal-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); }
  finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function activeGoal() {
  return createGoal({
    title: "Move exact element", objective: "Move element 101 and verify it.",
    acceptance_criteria: ["Element 101 has the expected location."], status: "active",
    related_session_id: "session-journal",
    work_budget: { mode: "auto_goal", requested_effect: "apply", document_fingerprint: "document-1" }
  });
}

test("request-level journal covers any planner and keeps caller apply success unknown", () => {
  withWorkspace(() => {
    const goal = activeGoal();
    ensureAssignmentRunForTurn("session-journal", "chat:message-1", "outer_chat", true);
    const planned = journalAssignmentActions("session-journal", [{
      action_id: "action-1", method: "POST", path: "/revit/move-elements",
      body: { elementIds: [101], translation: { x: 1, y: 0, z: 0 }, dryRun: false }
    }], "deterministic_fast_path");
    assert.equal(planned?.attempts[0]?.admission.state, "admitted");
    assert.equal(planned?.attempts[0]?.effect.state, "none");

    const settled = journalAssignmentToolResults("session-journal", [{
      action_id: "action-1", method: "POST", path: "/revit/move-elements", status: "done",
      request_dispatched: true, result_json: { status: "Moved", movedIds: [101], rolledBack: false }
    }], "operator_desktop");
    assert.equal(settled?.attempts[0]?.effect.state, "unknown");
    assert.deepEqual(settled?.unresolved_unknown_attempt_ids, ["action-1"]);
    assert.equal(getGoal(goal.id)?.assignment_control_plane?.events.length, 4);
    assert.equal(getGoal(goal.id)?.assignment_control_plane?.quarantined_events.length, 1);
  });
});

test("recovered read-only POST result preserves explicit effect and cannot consume apply opportunity", () => {
  withWorkspace(() => {
    activeGoal();
    ensureAssignmentRunForTurn("session-journal", "chat:q01-recovered-read", "outer_chat", true);

    const settled = journalAssignmentToolResults("session-journal", [{
      action_id: "q01-schedules-read",
      method: "POST",
      // Retained q01 used the typed-tool alias. The raw native receipt later
      // canonicalized this to /revit/schedules, but recovery saw this path.
      path: "/revit/list-schedules",
      request_effect: "read",
      request_dispatched: true,
      status: "done",
      result_json: { ok: true, count: 509, rows: [] }
    }], "operator_desktop");

    assert.equal(settled?.attempts.length, 1);
    assert.equal(settled?.attempts[0]?.requested_effect, "read");
    assert.equal(settled?.attempts[0]?.effect.state, "none");
    assert.equal(settled?.apply_opportunity_consumed, false);
    assert.deepEqual(settled?.unresolved_unknown_attempt_ids, []);
  });
});

test("typed schedule observation and conditional POST neighbors retain read provenance", () => {
  withWorkspace(() => {
    activeGoal();
    ensureAssignmentRunForTurn("session-journal", "chat:q01-neighbors", "outer_chat", true);
    let projection = journalAssignmentToolObservation("session-journal", {
      action_id: "typed-schedules", server: "revit_operator", tool: "revit_list_schedules",
      success: true, arguments: {}, result: { ok: true, count: 509 }
    }, "codex_inner_mcp", "typed-schedules", "read");
    projection = journalAssignmentToolResults("session-journal", [{
      action_id: "conditional-read", method: "POST", path: "/revit/create-text",
      request_effect: "read", request_dispatched: true, status: "done",
      result_json: { ok: true, action: "list_types", count: 3 }
    }], "operator_desktop");
    assert.deepEqual(projection?.attempts.map(row => row.requested_effect), ["read", "read"]);
    assert.equal(projection?.attempts.every(row => row.effect.state === "none"), true);
    assert.equal(projection?.apply_opportunity_consumed, false);
  });
});

test("bound native apply outranks a contradictory lower-authority ToolResult effect", () => {
  withWorkspace(() => {
    activeGoal();
    const run = ensureAssignmentRunForTurn("session-journal", "chat:native-authority", "outer_chat", true)!;
    journalAssignmentActions("session-journal", [{
      action_id: "native-authority", method: "POST", path: "/revit/move-elements",
      request_effect: "apply", body: { elementIds: [101], dryRun: false }
    }], "codex");
    const settled = journalAssignmentToolResults("session-journal", [{
      action_id: "native-authority", method: "POST", path: "/revit/move-elements",
      request_effect: "read", assignment_id: run.assignmentId, assignment_run_id: run.runId,
      assignment_generation: run.generation, status: "done", request_dispatched: true,
      result_json: { canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1", assignment_id: run.assignmentId,
        attempt_id: "native-authority", run_id: run.runId, generation: run.generation,
        requested_effect: "apply", method: "POST", path: "/revit/move-elements",
        request_dispatched: true, effect_state: "applied", effect_reason: "native_commit",
        effect_authority: "native_transaction", affected_target_identities: ["element_id:101"],
        receipt_refs: ["native:101"], evidence_refs: []
      } }
    }], "operator_desktop");
    assert.equal(settled?.attempts[0]?.requested_effect, "apply");
    assert.equal(settled?.attempts[0]?.effect.state, "applied");
    assert.equal(settled?.attempts[0]?.effect.authority, "native_transaction");
  });
});

test("unknown effect only admits an exact-target reconciliation read", () => {
  withWorkspace(() => {
    activeGoal();
    ensureAssignmentRunForTurn("session-journal", "chat:message-1", "outer_chat", true);
    journalAssignmentActions("session-journal", [{
      action_id: "apply-1", method: "POST", path: "/revit/move-elements",
      body: { elementIds: [101], translation: { x: 1 }, dryRun: false }
    }], "codex");
    journalAssignmentToolResults("session-journal", [{
      action_id: "apply-1", method: "POST", path: "/revit/move-elements", status: "failed",
      request_dispatched: true, outcome_unknown: true, reconciliation_required: true, error: "timeout"
    }], "operator_desktop");

    const unrelated = journalAssignmentActions("session-journal", [{
      action_id: "discover-1", method: "POST", path: "/revit/tool-search", body: { query: "move" }
    }], "codex");
    assert.equal(unrelated?.attempts.some(attempt => attempt.attempt_id === "discover-1"), false);

    const reconciliation = journalAssignmentActions("session-journal", [{
      action_id: "reconcile-1", method: "POST", path: "/revit/get-element-summary", body: { elementIds: [101] }
    }], "codex");
    assert.equal(reconciliation?.attempts.at(-1)?.purpose, "reconciliation");
    assert.equal(reconciliation?.attempts.at(-1)?.reconciliation_of_attempt_id, "apply-1");
    assert.equal(reconciliation?.phase, "reconciling");
  });
});

test("a late outer callback is fenced by the attempt's original generation", () => {
  withWorkspace(() => {
    const goal = activeGoal();
    ensureAssignmentRunForTurn("session-journal", "chat:message-1", "outer_chat", true);
    journalAssignmentActions("session-journal", [{
      action_id: "old-action", method: "POST", path: "/revit/move-elements", body: { elementIds: [101], dryRun: false }
    }], "codex");
    ensureAssignmentRunForTurn("session-journal", "chat:message-2", "outer_chat", true);
    journalAssignmentToolResults("session-journal", [{
      action_id: "old-action", method: "POST", path: "/revit/move-elements", status: "done",
      request_dispatched: true, result_json: { status: "Moved", rolledBack: false }
    }], "late_sidecar");
    const persisted = getGoal(goal.id)!;
    assert.equal(persisted.assignment_control_plane?.quarantined_events.length, 1);
    assert.match(persisted.assignment_control_plane?.quarantined_events[0]?.reason ?? "", /stale or superseded/);
    const old = persisted.assignment_control_plane?.events.find(entry => entry.attempt_id === "old-action" && entry.kind === "attempt_opened");
    assert.equal(old?.generation, 1);
  });
});

test("native transaction settlement upgrades raw apply truth and ignores caller wording", () => {
  withWorkspace(() => {
    activeGoal();
    ensureAssignmentRunForTurn("session-journal", "chat:message-native", "outer_chat", true);
    journalAssignmentActions("session-journal", [{
      action_id: "native-apply", method: "POST", path: "/revit/native-api-mutation-ops",
      body: { elementIds: [101], transaction: { mode: "commit" } }
    }], "codex");
    const settled = journalAssignmentToolResults("session-journal", [{
      action_id: "native-apply", method: "POST", path: "/revit/native-api-mutation-ops", status: "done",
      result_json: {
        assistant_message: "I could not make the change.",
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1",
          attempt_id: "native-apply", requested_effect: "apply", method: "POST", path: "/revit/native-api-mutation-ops",
          request_dispatched: true, effect_state: "applied", effect_reason: "native_transaction_committed",
          effect_authority: "native_transaction", affected_target_identities: ["element_id:101"],
          receipt_refs: ["native:transaction:1"], evidence_refs: [], settled_at_utc: new Date().toISOString()
        }
      }
    }], "operator_desktop");

    assert.equal(settled?.attempts[0]?.effect.state, "applied");
    assert.equal(settled?.attempts[0]?.effect.authority, "native_transaction");
    assert.equal(settled?.phase, "verifying");
  });
});

test("a native settlement bound to another attempt cannot alter canonical truth", () => {
  withWorkspace(() => {
    activeGoal();
    ensureAssignmentRunForTurn("session-journal", "chat:message-native", "outer_chat", true);
    journalAssignmentActions("session-journal", [{
      action_id: "real-attempt", method: "POST", path: "/revit/move-elements",
      body: { elementIds: [101], dryRun: false }
    }], "codex");
    const settled = journalAssignmentToolResults("session-journal", [{
      action_id: "real-attempt", method: "POST", path: "/revit/move-elements", status: "done",
      result_json: { canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1",
        attempt_id: "different-attempt", requested_effect: "apply", method: "POST", path: "/revit/move-elements",
        request_dispatched: true, effect_state: "applied", effect_reason: "spoofed",
        effect_authority: "native_transaction", affected_target_identities: [], receipt_refs: [], evidence_refs: []
      } }
    }], "operator_desktop");

    assert.equal(settled?.attempts[0]?.effect.state, "unknown");
    assert.equal(settled?.attempts[0]?.effect.authority, "dispatch_transport");
    assert.equal(settled?.attempts[0]?.effect.reason, "dispatch_occurred_effect_unsettled");
  });
});
