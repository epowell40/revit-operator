import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { submitNoopCompletionClaim, NOOP_COMPLETION_CLAIM_SCHEMA, type NoopCompletionClaimInput } from "../src/assignments/noop_completion.js";
import { createGoal } from "../src/goals/service.js";
import { currentAssignmentJournalContext, ensureAssignmentRunForTurn, journalAssignmentActions, journalAssignmentToolResults } from "../src/assignments/turn_journal.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { settleAssignmentTurn } from "../src/assignments/turn_settlement.js";

function workspace(fn: () => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-noop-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function setup(sourceRequest = "Set the selected note to Current issue wording without creating a duplicate.") {
  const sessionId = "noop-session";
  const goal = createGoal({
    title: "Verified desired-state no-op",
    objective: sourceRequest,
    acceptance_criteria: ["The selected TextNote contains the requested replacement wording.", "No duplicate TextNote is created."],
    status: "active",
    related_session_id: sessionId,
    work_budget: { mode: "auto_goal", requested_effect: "apply", source_user_request: sourceRequest, document_fingerprint: "doc-noop" }
  });
  const run = ensureAssignmentRunForTurn(sessionId, "run-noop", "test", true)!;
  return { sessionId, goal, run };
}

function readNote(sessionId: string, attemptId: string, targetId = 1478627) {
  const binding = currentAssignmentJournalContext(sessionId)!;
  const stored = storeEvidence({
    scope: { session_id: sessionId, assignment_id: binding.assignmentId, run_id: binding.runId, generation: binding.generation, attempt_id: attemptId },
    source: `noop-test:${attemptId}`, media_type: "application/json", trust_level: "authoritative_readback", verification_relevance: "authoritative",
    target_scope: [`element_id:${targetId}`], raw: { text: "Current issue wording", matches: [{ id: targetId }] }
  });
  journalAssignmentActions(sessionId, [{
    action_id: attemptId, method: "POST", path: "/revit/find-text-notes", request_effect: "read", body: { textNoteId: targetId }
  }], "noop-test");
  journalAssignmentToolResults(sessionId, [{
    action_id: attemptId, method: "POST", path: "/revit/find-text-notes", request_effect: "read", status: "done", request_dispatched: true,
    result_json: { canonical_attempt_settlement: {
      schema: "revit-operator.native-attempt-settlement.v1", attempt_id: attemptId, requested_effect: "read",
      method: "POST", path: "/revit/find-text-notes", request_dispatched: true, effect_state: "none",
      effect_reason: "read_has_no_persistent_effect", effect_authority: "target_readback",
      affected_target_identities: [], receipt_refs: [`native:${attemptId}`], evidence_refs: [stored.ref.evidence_id]
    } }
  }], "noop-test");
  return stored.ref.evidence_id;
}

function claim(input: ReturnType<typeof setup>, evidence1: string, evidence2: string): NoopCompletionClaimInput {
  const fingerprint = currentAssignmentJournalContext(input.sessionId)!.projection.attempts.find(attempt => attempt.attempt_id === "observe-1")!.target_fingerprint;
  return {
    schema: NOOP_COMPLETION_CLAIM_SCHEMA,
    assignment_id: input.goal.id,
    run_id: input.run.runId,
    generation: input.run.generation,
    session_id: input.sessionId,
    target_identity: "element_id:1478627",
    target_fingerprint: fingerprint,
    desired_postcondition: { field_path: "text", expected_value: "Current issue wording" },
    desired_source: { kind: "user_request", exact_text: "Current issue wording" },
    assertions: [
      { assertion_id: "text-1", attempt_id: "observe-1", evidence_id: evidence1, operation: "field_equals", path: "text", expected: "Current issue wording" },
      { assertion_id: "unique-1", attempt_id: "observe-1", evidence_id: evidence1, operation: "array_count", path: "matches", expected_count: 1 },
      { assertion_id: "text-2", attempt_id: "observe-2", evidence_id: evidence2, operation: "field_equals", path: "text", expected: "Current issue wording" },
      { assertion_id: "unique-2", attempt_id: "observe-2", evidence_id: evidence2, operation: "array_count", path: "matches", expected_count: 1 }
    ],
    criteria: [
      { criterion: input.goal.acceptance_criteria[0], assertion_ids: ["text-1", "text-2"] },
      { criterion: input.goal.acceptance_criteria[1], assertion_ids: ["unique-1", "unique-2"] }
    ]
  };
}

test("fully specified desired state with two exact fresh observations may settle verified no-op", () => workspace(() => {
  const input = setup();
  const evidence1 = readNote(input.sessionId, "observe-1");
  const evidence2 = readNote(input.sessionId, "observe-2");
  const submitted = submitNoopCompletionClaim(claim(input, evidence1, evidence2));
  assert.equal(submitted.accepted, true);
  const settled = settleAssignmentTurn(input.sessionId, "apply");
  assert.equal(settled.completed, true);
  assert.equal(settled.verified_noop, true);
  assert.equal(settled.projection?.outcome_state, "verified_noop");
}));

test("wrong target, missing desired source, and assistant prose cannot establish a no-op", () => workspace(() => {
  const input = setup("Inspect the selected note and update it when the exact desired wording is known.");
  const evidence1 = readNote(input.sessionId, "observe-1");
  const evidence2 = readNote(input.sessionId, "observe-2");
  assert.throws(() => submitNoopCompletionClaim(claim(input, evidence1, evidence2)), /desired_source_mismatch/);
}));

test("two observations of different exact targets do not prove equivalence", () => workspace(() => {
  const input = setup();
  const evidence1 = readNote(input.sessionId, "observe-1");
  const evidence2 = readNote(input.sessionId, "observe-2", 1478628);
  const submitted = submitNoopCompletionClaim(claim(input, evidence1, evidence2));
  assert.equal(submitted.accepted, false);
  assert.equal(submitted.reason, "noop_completion_ineligible_observation");
  assert.equal(settleAssignmentTurn(input.sessionId, "apply").completed, false);
}));
