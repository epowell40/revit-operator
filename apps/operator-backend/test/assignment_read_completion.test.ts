import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createGoal,
  getGoal,
  updateGoal
} from "../src/goals/service.js";
import {
  currentAssignmentJournalContext,
  ensureAssignmentRunForTurn,
  journalAssignmentActions,
  journalAssignmentToolResults
} from "../src/assignments/turn_journal.js";
import { settleAssignmentProviderFailure, settleAssignmentTurn } from "../src/assignments/turn_settlement.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { submitReadCompletionClaim } from "../src/assignments/read_completion.js";
import type { AssignmentAttemptPurpose } from "../src/assignments/control_plane.js";
import { listVerifiedWorkPackets } from "../src/work_packets/store.js";
import { verifyVerifiedWorkPacketHash } from "../src/work_packets/generator.js";

function workspace(fn: () => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-read-completion-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); }
  finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createReadAssignment(
  sessionId: string,
  requestedEffect: "read" | "preview" | "apply" = "read",
  objective = "Return the requested inventory and its grouped result from live Revit evidence."
) {
  const goal = createGoal({
    title: "Canonical read completion",
    objective,
    acceptance_criteria: [
      "A truthful final result is returned for the requested inventory.",
      "The authoritative tool outcomes are retained in the Assignment."
    ],
    status: "active",
    related_session_id: sessionId,
    work_budget: {
      mode: "auto_goal",
      requested_effect: requestedEffect,
      document_fingerprint: "document-read-completion"
    }
  });
  const run = ensureAssignmentRunForTurn(sessionId, `run:${sessionId}`, "test", true)!;
  return { goal, run };
}

function journalRead(
  sessionId: string,
  actionId: string,
  pathValue: string,
  result: Record<string, unknown>,
  native = false,
  purpose: AssignmentAttemptPurpose = "action",
  evidenceOverride?: string | null
): string | null {
  const binding = currentAssignmentJournalContext(sessionId)!;
  const evidence = native && evidenceOverride === undefined ? storeEvidence({
    scope: {
      session_id: sessionId,
      assignment_id: binding.assignmentId,
      run_id: binding.runId,
      generation: binding.generation,
      attempt_id: actionId
    },
    source: `read-completion-test:${pathValue}`,
    media_type: "application/json",
    trust_level: "authoritative_native",
    verification_relevance: "required",
    raw: result
  }).ref : null;
  const evidenceId = evidenceOverride === undefined ? evidence?.evidence_id ?? null : evidenceOverride;
  journalAssignmentActions(sessionId, [{
    action_id: actionId,
    method: "POST",
    path: pathValue,
    request_effect: "read",
    body: { scope: "project" }
  }], "read-completion-test", { purpose });
  journalAssignmentToolResults(sessionId, [{
    action_id: actionId,
    method: "POST",
    path: pathValue,
    request_effect: "read",
    status: "done",
    request_dispatched: true,
    result_json: native ? {
      ...result,
      canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1",
        attempt_id: actionId,
        requested_effect: "read",
        method: "POST",
        path: pathValue,
        request_dispatched: true,
        effect_state: "none",
        effect_reason: "read_has_no_persistent_effect",
        effect_authority: "native_host",
        affected_target_identities: [],
        receipt_refs: [`native:${actionId}`],
        evidence_refs: evidenceId ? [evidenceId] : []
      }
    } : result
  }], "read-completion-test");
  return evidenceId;
}

function submitClaim(
  sessionId: string,
  assertions: Array<Record<string, unknown>>,
  criteria?: Array<{ criterion: string; assertion_ids: string[] }>
): void {
  const binding = currentAssignmentJournalContext(sessionId)!;
  const goal = getGoal(binding.assignmentId)!;
  submitReadCompletionClaim({
    schema: "revit-operator.assignment-read-completion-claim/v1",
    assignment_id: binding.assignmentId,
    run_id: binding.runId,
    generation: binding.generation,
    session_id: sessionId,
    criteria: criteria ?? goal.acceptance_criteria.map(criterion => ({
      criterion,
      assertion_ids: assertions.map(assertion => `${assertion.assertion_id}`)
    })),
    result: { kind: "inventory", assertions }
  }, "read-completion-test");
}

test("passing-after: retained q01-shaped settled reads cross the evidence-backed canonical completion handoff", () => {
  workspace(() => {
    const sessionId = "read-completion-q01";
    const { goal } = createReadAssignment(sessionId);
    journalRead(sessionId, "schedule-read", "/revit/schedules", { ok: true, schedules: [] }, true);
    const inventoryEvidence = journalRead(sessionId, "inventory-read", "/revit/find-elements", {
      ok: true,
      count: 509,
      itemsComplete: true,
      items: [
        { family: "Family A", type: "Type 1" },
        { family: "Family B", type: "Type 2" }
      ]
    }, true)!;
    submitClaim(sessionId, [
      {
        assertion_id: "inventory-total",
        attempt_id: "inventory-read",
        evidence_id: inventoryEvidence,
        operation: "field_equals",
        path: "count",
        expected: 509
      },
      {
        assertion_id: "inventory-groups",
        attempt_id: "inventory-read",
        evidence_id: inventoryEvidence,
        operation: "group_count",
        path: "items",
        group_by: ["family", "type"],
        expected_total: 2,
        expected_groups: [
          { values: ["Family A", "Type 1"], count: 1 },
          { values: ["Family B", "Type 2"], count: 1 }
        ]
      }
    ]);

    const before = currentAssignmentJournalContext(sessionId)!.projection;
    assert.equal(before.quiescent, true);
    assert.equal(before.in_flight_count, 0);
    assert.equal(before.unresolved_unknown_attempt_ids.length, 0);
    assert.equal(before.apply_opportunity_consumed, false);

    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, true);
    assert.equal(settled.projection?.terminal_reason, "authoritative_read_completed");
    assert.equal(getGoal(goal.id)?.finished_at !== null, true);
    const packets = listVerifiedWorkPackets(goal.id);
    assert.equal(packets.length, 1);
    assert.equal(packets[0]!.status, "verified_complete");
    assert.equal(packets[0]!.assignment.requested_effect, "read");
    assert.equal(packets[0]!.actions.some(action => action.requested_effect === "apply"), false);
    assert.equal(verifyVerifiedWorkPacketHash(packets[0]!), true);
    assert.match(JSON.stringify(packets[0]!.acceptance_criteria[0]!.observed_value), /structured_result_digest/);
  });
});

test("a stale-generation completion claim is rejected before evidence validation", () => {
  workspace(() => {
    const sessionId = "read-completion-stale-generation";
    const { goal, run } = createReadAssignment(sessionId);
    assert.throws(() => submitReadCompletionClaim({
      schema: "revit-operator.assignment-read-completion-claim/v1",
      assignment_id: goal.id,
      run_id: run.runId,
      generation: run.generation + 1,
      session_id: sessionId,
      criteria: [{ criterion: goal.acceptance_criteria[0]!, assertion_ids: ["stale"] }],
      result: {
        kind: "inventory",
        assertions: [{
          assertion_id: "stale",
          attempt_id: "attempt-stale",
          evidence_id: `ev1_${"a".repeat(32)}`,
          operation: "field_equals",
          path: "count",
          expected: 1
        }]
      }
    }, "read-completion-test"), /read_completion_claim_binding_mismatch/);
  });
});

test("one authoritative action read and one complete structured claim terminalize exactly once", () => {
  workspace(() => {
    const sessionId = "read-completion-single";
    const { goal } = createReadAssignment(sessionId, "read", "Return the requested lookup result from live Revit evidence.");
    const evidenceId = journalRead(sessionId, "context-read", "/revit/get-context", { title: "Coordination Model" }, true)!;
    submitClaim(sessionId, [{
      assertion_id: "title", attempt_id: "context-read", evidence_id: evidenceId,
      operation: "field_equals", path: "title", expected: "Coordination Model"
    }]);
    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, true);
    assert.equal(settled.projection?.terminal_reason, "authoritative_read_completed");
    assert.equal(getGoal(goal.id)!.assignment_control_plane!.events.filter(event => event.kind === "assignment_terminal").length, 1);
  });
});

test("failing-before: an action-level native read cannot complete without a task-level completion claim", () => {
  workspace(() => {
    const sessionId = "read-completion-no-claim";
    createReadAssignment(sessionId, "read", "Return the requested lookup result from live Revit evidence.");
    journalRead(sessionId, "native-read", "/revit/find-elements", {
      ok: true,
      count: 1,
      items: [{ id: 101, name: "Observed item" }]
    }, true);

    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, false);
    assert.equal(settled.reason, "read_completion_claim_missing");
  });
});

test("assistant-like success wording without a structured evidence claim cannot complete", () => {
  workspace(() => {
    const sessionId = "read-completion-prose-only";
    const { goal } = createReadAssignment(sessionId, "read", "Return the requested lookup result.");
    updateGoal(goal.id, { progress_summary: "Complete: I found the requested result." });
    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, false);
    assert.equal(settled.reason, "read_completion_claim_missing");
  });
});

test("failing-before: discovery-only quiescence cannot complete a read Assignment", () => {
  workspace(() => {
    const sessionId = "read-completion-discovery-only";
    createReadAssignment(sessionId, "read", "Return the requested total count from live Revit evidence.");
    const evidenceId = journalRead(sessionId, "tool-search", "/revit/search-tools", {
      ok: true,
      tools: [{ method: "POST", path: "/revit/find-elements" }]
    }, true, "discovery")!;
    submitClaim(sessionId, [{
      assertion_id: "discovery-result",
      attempt_id: "tool-search",
      evidence_id: evidenceId,
      operation: "array_count",
      path: "tools",
      expected_count: 1
    }]);

    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, false);
    assert.equal(settled.reason, "read_completion_discovery_only");
  });
});

test("quiescent authoritative read with an unsupported requested answer remains incomplete", () => {
  workspace(() => {
    const sessionId = "read-completion-wrong-answer";
    createReadAssignment(sessionId, "read", "Return the requested total count from live Revit evidence.");
    const evidenceId = journalRead(sessionId, "inventory-read", "/revit/find-elements", { count: 2, items: [] }, true)!;
    submitClaim(sessionId, [{
      assertion_id: "claimed-total", attempt_id: "inventory-read", evidence_id: evidenceId,
      operation: "field_equals", path: "count", expected: 509
    }]);
    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, false);
    assert.equal(settled.reason, "read_completion_result_not_supported");
  });
});

test("a claim that does not cover every acceptance criterion remains incomplete", () => {
  workspace(() => {
    const sessionId = "read-completion-criterion-gap";
    createReadAssignment(sessionId);
    const evidenceId = journalRead(sessionId, "inventory-read", "/revit/find-elements", { count: 2 }, true)!;
    assert.throws(() => submitClaim(sessionId, [{
      assertion_id: "total", attempt_id: "inventory-read", evidence_id: evidenceId,
      operation: "field_equals", path: "count", expected: 2
    }], [{ criterion: "A truthful final result is returned for the requested inventory.", assertion_ids: ["total"] }]), /read_completion_criteria_incomplete/);
    assert.equal(settleAssignmentTurn(sessionId, "read").completed, false);
  });
});

test("an apply Assignment cannot be promoted through the read-completion path", () => {
  workspace(() => {
    const sessionId = "read-completion-apply-excluded";
    createReadAssignment(sessionId, "apply");
    const evidenceId = journalRead(sessionId, "supporting-read", "/revit/find-elements", { count: 1 }, true)!;
    submitClaim(sessionId, [{
      assertion_id: "read", attempt_id: "supporting-read", evidence_id: evidenceId,
      operation: "field_equals", path: "count", expected: 1
    }]);
    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, false);
    assert.equal(settled.reason, "read_completion_unexpected_apply");
  });
});

test("a preview Assignment containing successful reads cannot use read completion", () => {
  workspace(() => {
    const sessionId = "read-completion-preview-excluded";
    createReadAssignment(sessionId, "preview", "Return a rollback preview of the requested work.");
    const evidenceId = journalRead(sessionId, "supporting-read", "/revit/get-context", { title: "Model" }, true)!;
    submitClaim(sessionId, [{
      assertion_id: "context", attempt_id: "supporting-read", evidence_id: evidenceId,
      operation: "field_equals", path: "title", expected: "Model"
    }]);
    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, false);
    assert.equal(settled.reason, "read_completion_unexpected_apply");
  });
});

test("a read-completion claim is deferred until the exact Assignment is quiescent", () => {
  workspace(() => {
    const sessionId = "read-completion-quiescent-barrier";
    createReadAssignment(sessionId, "read", "Return the requested lookup result.");
    const evidenceId = journalRead(sessionId, "result-read", "/revit/get-context", { title: "Model A" }, true)!;
    journalAssignmentActions(sessionId, [{
      action_id: "pending-read", method: "POST", path: "/revit/schedules", request_effect: "read", body: {}
    }], "read-completion-test", { purpose: "discovery" });
    submitClaim(sessionId, [{
      assertion_id: "title", attempt_id: "result-read", evidence_id: evidenceId,
      operation: "field_equals", path: "title", expected: "Model A"
    }]);
    const deferred = settleAssignmentTurn(sessionId, "read");
    assert.equal(deferred.completed, false);
    assert.equal(deferred.reason, "read_completion_not_quiescent");
    journalRead(sessionId, "pending-read", "/revit/schedules", { schedules: [] }, true, "discovery");
    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, true);
    assert.equal(settled.projection?.read_completion.status, "accepted");
  });
});

test("missing and cross-run EvidenceRefs cannot support read completion", () => {
  for (const variant of ["missing", "cross-run"] as const) workspace(() => {
    const sessionId = `read-completion-${variant}`;
    const { goal, run } = createReadAssignment(sessionId, "read", "Return the requested lookup result.");
    const evidenceId = variant === "missing"
      ? "ev1_0123456789abcdefghijklmnopqrstuv"
      : storeEvidence({
          scope: { session_id: sessionId, assignment_id: goal.id, run_id: "older-run", generation: run.generation, attempt_id: "read" },
          source: "cross-run-test", trust_level: "authoritative_native", verification_relevance: "required", raw: { value: 42 }
        }).ref.evidence_id;
    journalRead(sessionId, "read", "/revit/get-context", { value: 42 }, true, "action", evidenceId);
    submitClaim(sessionId, [{
      assertion_id: "value", attempt_id: "read", evidence_id: evidenceId,
      operation: "field_equals", path: "value", expected: 42
    }]);
    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, false);
    assert.equal(settled.reason, variant === "missing" ? "read_completion_missing_evidence" : "read_completion_cross_run_evidence");
  });
});

test("an authoritative EvidenceRef from another Assignment is rejected", () => {
  workspace(() => {
    const sourceSession = "read-completion-source-assignment";
    const source = createReadAssignment(sourceSession, "read", "Return a source lookup result.");
    const foreignEvidence = storeEvidence({
      scope: {
        session_id: sourceSession,
        assignment_id: source.goal.id,
        run_id: source.run.runId,
        generation: source.run.generation,
        attempt_id: "source-read"
      },
      source: "cross-assignment-test",
      trust_level: "authoritative_native",
      verification_relevance: "required",
      raw: { value: 42 }
    }).ref.evidence_id;

    const targetSession = "read-completion-target-assignment";
    createReadAssignment(targetSession, "read", "Return the requested lookup result.");
    journalRead(targetSession, "target-read", "/revit/get-context", { value: 42 }, true, "action", foreignEvidence);
    submitClaim(targetSession, [{
      assertion_id: "value", attempt_id: "target-read", evidence_id: foreignEvidence,
      operation: "field_equals", path: "value", expected: 42
    }]);
    const settled = settleAssignmentTurn(targetSession, "read");
    assert.equal(settled.completed, false);
    assert.equal(settled.reason, "read_completion_cross_run_evidence");
  });
});

test("a native receipt without retained required evidence cannot falsely complete", () => {
  workspace(() => {
    const sessionId = "read-completion-retention-failed";
    createReadAssignment(sessionId, "read", "Return the requested lookup result.");
    journalRead(sessionId, "native-read", "/revit/get-context", { value: 42 }, true, "action", null);
    submitClaim(sessionId, [{
      assertion_id: "value", attempt_id: "native-read", evidence_id: "ev1_0123456789abcdefghijklmnopqrstuv",
      operation: "field_equals", path: "value", expected: 42
    }]);
    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, false);
    assert.equal(settled.reason, "read_completion_missing_evidence");
  });
});

test("read timeout settles honestly through the existing failure path and never becomes completion", () => {
  workspace(() => {
    const sessionId = "read-completion-timeout";
    const { goal, run } = createReadAssignment(sessionId, "read", "Return the requested lookup result.");
    journalAssignmentActions(sessionId, [{
      action_id: "timed-out-read", method: "POST", path: "/revit/get-context", request_effect: "read", body: {}
    }], "read-completion-test", { purpose: "action" });
    journalAssignmentToolResults(sessionId, [{
      action_id: "timed-out-read", method: "POST", path: "/revit/get-context", request_effect: "read",
      status: "failed", request_dispatched: true, result_json: { ok: false, error: "read_timeout" }
    }], "read-completion-test");
    assert.equal(settleAssignmentTurn(sessionId, "read").completed, false);
    const blocked = settleAssignmentProviderFailure(sessionId, goal.id, run.runId, run.generation, "read_timeout");
    assert.equal(blocked.accepted, true);
    assert.ok(["blocked", "failed"].includes(blocked.projection?.terminal_state ?? ""));
  });
});

test("evidence expansion may support presentation but cannot masquerade as fresh Revit truth", () => {
  workspace(() => {
    const sessionId = "read-completion-expansion";
    createReadAssignment(sessionId, "read", "Return the requested lookup result.");
    const nativeEvidence = journalRead(sessionId, "native-read", "/revit/get-context", { value: 42 }, true)!;
    journalRead(sessionId, "evidence-expansion", "/evidence/retrieve", { value: 42 }, true, "evidence_read");
    submitClaim(sessionId, [{
      assertion_id: "native-value", attempt_id: "native-read", evidence_id: nativeEvidence,
      operation: "field_equals", path: "value", expected: 42
    }]);
    assert.equal(settleAssignmentTurn(sessionId, "read").completed, true);
  });
});

test("contradictory structured assertions cannot complete even when each cites authoritative evidence", () => {
  workspace(() => {
    const sessionId = "read-completion-conflict";
    createReadAssignment(sessionId, "read", "Return the requested total count.");
    const first = journalRead(sessionId, "count-a", "/revit/find-elements", { count: 2 }, true)!;
    const second = journalRead(sessionId, "count-b", "/revit/find-elements", { count: 3 }, true)!;
    submitClaim(sessionId, [
      { assertion_id: "count-a", attempt_id: "count-a", evidence_id: first, operation: "field_equals", path: "count", expected: 2 },
      { assertion_id: "count-b", attempt_id: "count-b", evidence_id: second, operation: "field_equals", path: "count", expected: 3 }
    ]);
    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, false);
    assert.equal(settled.reason, "read_completion_conflicting_evidence");
  });
});

test("assistant-like failure wording cannot erase authoritative structured completion", () => {
  workspace(() => {
    const sessionId = "read-completion-prose-contradiction";
    const { goal } = createReadAssignment(sessionId, "read", "Return the requested lookup result.");
    const evidenceId = journalRead(sessionId, "native-read", "/revit/get-context", { value: 42 }, true)!;
    updateGoal(goal.id, { progress_summary: "I could not complete the request." });
    submitClaim(sessionId, [{
      assertion_id: "value", attempt_id: "native-read", evidence_id: evidenceId,
      operation: "field_equals", path: "value", expected: 42
    }]);
    const settled = settleAssignmentTurn(sessionId, "read");
    assert.equal(settled.completed, true);
    assert.equal(settled.projection?.terminal_reason, "authoritative_read_completed");
  });
});

test("durable claim and evidence survive a restart-shaped reload before validation", () => {
  workspace(() => {
    const sessionId = "read-completion-restart";
    const { goal } = createReadAssignment(sessionId, "read", "Return the requested lookup result.");
    const evidenceId = journalRead(sessionId, "native-read", "/revit/get-context", { value: 42 }, true)!;
    submitClaim(sessionId, [{
      assertion_id: "value", attempt_id: "native-read", evidence_id: evidenceId,
      operation: "field_equals", path: "value", expected: 42
    }]);
    const reloaded = getGoal(goal.id)!;
    assert.equal(reloaded.assignment_control_plane!.events.some(event => event.kind === "read_completion_claimed"), true);
    assert.equal(settleAssignmentTurn(sessionId, "read").completed, true);
  });
});

test("duplicate read-completion submission is idempotent and cannot resurrect the terminal Assignment", () => {
  workspace(() => {
    const sessionId = "read-completion-idempotent";
    const { goal } = createReadAssignment(sessionId, "read", "Return the requested lookup result.");
    const evidenceId = journalRead(sessionId, "read", "/revit/get-context", { value: 42 }, true)!;
    const assertions = [{
      assertion_id: "value", attempt_id: "read", evidence_id: evidenceId,
      operation: "field_equals", path: "value", expected: 42
    }];
    submitClaim(sessionId, assertions);
    assert.equal(settleAssignmentTurn(sessionId, "read").completed, true);
    const terminal = getGoal(goal.id)!;
    const claim = terminal.assignment_control_plane!.events.find(event => event.kind === "read_completion_claimed")!.data.claim as Record<string, unknown>;
    const duplicate = submitReadCompletionClaim(claim, "read-completion-test");
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.projection.terminal_state, "complete");
    assert.equal(getGoal(goal.id)!.assignment_control_plane!.events.filter(event => event.kind === "assignment_terminal").length, 1);
  });
});
