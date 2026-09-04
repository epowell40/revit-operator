import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requestAssignmentClarification } from "../src/assignments/interaction.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { advanceAssignmentKernelProgressV2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { ensureAssignmentRunForTurn } from "../src/assignments/turn_journal.js";
import { canonicalAssignmentOutcomeForBinding } from "../src/assignments/outcome_handoff.js";
import { configureGoalEvidenceAuthorityProvider, createGoal } from "../src/goals/service.js";
import { createLocalGoalEvidenceAuthority } from "../src/goals/authority.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { createPrincipalBoundSessionIdForRequest, runWithRequestContext, type RequestPrincipal } from "../src/request_context.js";

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

test("authenticated chat outcome handoff reads a V2 clarification from the exact bound V2 snapshot", () => {
  withWorkspace(() => {
    const principal: RequestPrincipal = {
      sub: "principal-outcome-handoff-v2",
      user_id: "principal-outcome-handoff-v2",
      license_id: "tenant-outcome-handoff-v2",
      roles: ["operator"],
      tier: "development",
      claims: {}
    };
    runWithRequestContext({ principal }, () => {
      const sessionId = createPrincipalBoundSessionIdForRequest(principal, "outcome-handoff-v2");
      const goal = createGoal({
        title: "Update selected note through V2",
        objective: "Replace the selected note after the user supplies the exact wording.",
        acceptance_criteria: ["The existing note is updated in place."],
        related_session_id: sessionId,
        created_by: principal.user_id,
        status: "active",
        work_budget: { requested_effect: "apply", required_user_inputs: ["replacement_text"] }
      });
      const run = ensureAssignmentRunForTurn(sessionId, "sidecar:outcome-handoff-v2", "test", false);
      assert.ok(run);
      const binding = createAssignmentKernelForGoalV2({ goal, run_id: run.runId });
      const advanced = advanceAssignmentKernelProgressV2({ binding, now: "2026-08-28T16:00:00.000Z" });
      const [clarification] = Object.values(advanced.snapshot.clarifications);
      assert.ok(clarification);

      const outcome = canonicalAssignmentOutcomeForBinding({
        session_id: sessionId,
        assignment_id: goal.id,
        assignment_run_id: run.runId,
        assignment_generation: run.generation
      });

      assert.equal(outcome?.outcome_state, "awaiting_user_input");
      assert.equal(outcome?.terminal_state, "open");
      assert.equal(outcome?.quiescent, true);
      assert.deepEqual(outcome?.pending_clarification, {
        clarification_id: clarification.clarification_id,
        question: clarification.question,
        missing_fields: ["replacement_text"]
      });
    });
  });
});

test("local shared-token outcome handoff reads the same exact V2 binding", () => {
  withWorkspace(() => {
    runWithRequestContext({
      operator_backend_auth: createOperatorBackendAuth("shared_token", "local-outcome-handoff-token")
    }, () => {
      const sessionId = "session-local-outcome-handoff-v2";
      const goal = createGoal({
        title: "Read local inventory through V2",
        objective: "Return the authoritative local inventory.",
        acceptance_criteria: ["The requested inventory is authoritatively returned."],
        related_session_id: sessionId,
        created_by: null,
        status: "active",
        work_budget: { requested_effect: "read" }
      });
      const binding = createAssignmentKernelForGoalV2({ goal, run_id: "local-outcome-run" });
      const outcome = canonicalAssignmentOutcomeForBinding({
        session_id: sessionId,
        assignment_id: goal.id,
        assignment_run_id: binding.run_id,
        assignment_generation: binding.generation
      });

      assert.equal(outcome?.assignment_id, goal.id);
      assert.equal(outcome?.run_id, binding.run_id);
      assert.equal(outcome?.outcome_state, "active");
      assert.equal(outcome?.terminal_state, "open");
    });
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
