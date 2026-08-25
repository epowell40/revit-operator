import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requestAssignmentClarification } from "../src/assignments/interaction.js";
import { ensureAssignmentRunForTurn } from "../src/assignments/turn_journal.js";
import { canonicalAssignmentOutcomeForBinding } from "../src/assignments/outcome_handoff.js";
import { configureGoalEvidenceAuthorityProvider, createGoal } from "../src/goals/service.js";
import { createLocalGoalEvidenceAuthority } from "../src/goals/authority.js";

function withWorkspace<T>(fn: () => T): T {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-outcome-handoff-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  configureGoalEvidenceAuthorityProvider(createLocalGoalEvidenceAuthority({
    secret: "assignment-outcome-handoff-test-secret-32-bytes"
  }));
  try {
    return fn();
  } finally {
    configureGoalEvidenceAuthorityProvider(null);
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function awaitingInputFixture() {
  const sessionId = "session-outcome-handoff";
  const goal = createGoal({
    title: "Update selected note",
    objective: "Replace the selected note after the user supplies the exact wording.",
    acceptance_criteria: ["The existing note is updated in place."],
    related_session_id: sessionId,
    status: "active",
    work_budget: { requested_effect: "apply" }
  });
  const run = ensureAssignmentRunForTurn(sessionId, "sidecar:outcome-handoff", "test", false);
  assert.ok(run);
  const requested = requestAssignmentClarification({
    schema: "revit-operator.assignment-clarification/v1",
    assignment_id: goal.id,
    run_id: run.runId,
    generation: run.generation,
    session_id: sessionId,
    missing_fields: ["replacement_text"],
    question: "What exact wording should replace the selected note?",
    reason: "required_input_missing",
    completed_work: ["Selected TextNote 1478627 was grounded."],
    criterion_states: [{
      criterion: "The existing note is updated in place.",
      state: "needs_input",
      reason: "The desired wording is missing."
    }]
  });
  return { sessionId, goal, run, clarification: requested.clarification };
}

test("authenticated chat outcome handoff projects a committed clarification with exact binding", () => {
  withWorkspace(() => {
    const fixture = awaitingInputFixture();
    const outcome = canonicalAssignmentOutcomeForBinding({
      session_id: fixture.sessionId,
      assignment_id: fixture.goal.id,
      assignment_run_id: fixture.run.runId,
      assignment_generation: fixture.run.generation
    });

    assert.equal(outcome?.schema, "revit-operator.canonical-assignment-outcome/v1");
    assert.equal(outcome?.assignment_id, fixture.goal.id);
    assert.equal(outcome?.run_id, fixture.run.runId);
    assert.equal(outcome?.generation, fixture.run.generation);
    assert.equal(outcome?.session_id, fixture.sessionId);
    assert.equal(outcome?.outcome_state, "awaiting_user_input");
    assert.equal(outcome?.terminal_state, "open");
    assert.equal(outcome?.quiescent, true);
    assert.deepEqual(outcome?.pending_clarification, {
      clarification_id: fixture.clarification.clarification_id,
      question: "What exact wording should replace the selected note?",
      missing_fields: ["replacement_text"]
    });
    assert.ok(Buffer.byteLength(JSON.stringify(outcome), "utf8") < 8_192);
  });
});

test("canonical outcome handoff rejects stale and foreign bindings", () => {
  withWorkspace(() => {
    const fixture = awaitingInputFixture();
    const binding = {
      session_id: fixture.sessionId,
      assignment_id: fixture.goal.id,
      assignment_run_id: fixture.run.runId,
      assignment_generation: fixture.run.generation
    };
    assert.equal(canonicalAssignmentOutcomeForBinding({ ...binding, assignment_generation: 2 }), null);
    assert.equal(canonicalAssignmentOutcomeForBinding({ ...binding, assignment_run_id: "sidecar:stale" }), null);
    assert.equal(canonicalAssignmentOutcomeForBinding({ ...binding, session_id: "session-foreign" }), null);
    assert.equal(canonicalAssignmentOutcomeForBinding({ ...binding, assignment_id: "goal-foreign" }), null);
  });
});
