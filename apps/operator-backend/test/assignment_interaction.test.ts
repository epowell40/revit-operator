import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentControlPlaneProjection
} from "../src/assignments/control_plane.js";
import { appendAssignmentEvent } from "../src/assignments/control_plane_store.js";
import {
  ASSIGNMENT_CLARIFICATION_RESPONSE_SCHEMA,
  ASSIGNMENT_CLARIFICATION_SCHEMA,
  requestAssignmentClarification,
  resolveAssignmentClarification
} from "../src/assignments/interaction.js";
import { ensureAssignmentRunForTurn, journalAssignmentActions, journalAssignmentToolResults } from "../src/assignments/turn_journal.js";
import { settleAssignmentTurn } from "../src/assignments/turn_settlement.js";
import { createGoal, getGoal } from "../src/goals/service.js";
import { runWithRequestContext, type RequestPrincipal } from "../src/request_context.js";
import { listWorkReturns } from "../src/work_returns/store.js";
import { verifyWorkReturnHash } from "../src/work_returns/generator.js";

const principal: RequestPrincipal = {
  sub: "user-interaction",
  user_id: "user-interaction",
  tenant_id: "tenant-interaction",
  license_id: "tenant-interaction",
  roles: ["user"],
  tier: null,
  claims: {}
};

function workspace(fn: () => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-interaction-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); }
  finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assignment(sessionId = "interaction-session", createdBy: string | null = null) {
  const goal = createGoal({
    title: "Update selected note",
    objective: "Replace the selected note wording without creating a duplicate.",
    acceptance_criteria: [
      "The selected TextNote contains the requested replacement wording.",
      "No duplicate TextNote is created."
    ],
    status: "active",
    created_by: createdBy,
    related_session_id: sessionId,
    work_budget: { mode: "auto_goal", requested_effect: "apply", document_fingerprint: "doc-interaction" }
  });
  const run = ensureAssignmentRunForTurn(sessionId, `run:${sessionId}`, "test", true)!;
  return { goal, run };
}

function requestInput(goalId: string, runId: string, generation: number, sessionId = "interaction-session") {
  const goal = getGoal(goalId)!;
  return requestAssignmentClarification({
    schema: ASSIGNMENT_CLARIFICATION_SCHEMA,
    assignment_id: goalId,
    run_id: runId,
    generation,
    session_id: sessionId,
    missing_fields: ["replacement_text"],
    question: "What exact replacement wording should I use?",
    reason: "desired_postcondition_missing",
    completed_work: ["Grounded selected TextNote 1478627."],
    affected_subtasks: ["Replace the existing TextNote in place."],
    criterion_states: [{
      criterion: goal.acceptance_criteria[0],
      state: "needs_input",
      reason: "The desired wording was not supplied."
    }]
  });
}

function rawEvent(
  projection: AssignmentControlPlaneProjection,
  kind: AssignmentAttemptEvent["kind"],
  data: Record<string, unknown>,
  attemptId: string | null = null
): AssignmentAttemptEvent {
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: `${kind}:${Math.random()}`,
    assignment_id: projection.assignment_id,
    run_id: projection.run_id!,
    generation: projection.generation,
    attempt_id: attemptId,
    kind,
    occurred_at: new Date().toISOString(),
    actor: "test",
    data
  };
}

test("missing mutation input creates a durable nonterminal clarification and never a no-op", () => workspace(() => {
  const { goal, run } = assignment();
  journalAssignmentActions("interaction-session", [{
    action_id: "read-note", method: "POST", path: "/revit/find-text-notes", request_effect: "read", body: { selected_only: true }
  }], "test");
  journalAssignmentToolResults("interaction-session", [{
    action_id: "read-note", method: "POST", path: "/revit/find-text-notes", request_effect: "read", status: "done", request_dispatched: true,
    result_json: { canonical_attempt_settlement: {
      schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "read-note", requested_effect: "read",
      method: "POST", path: "/revit/find-text-notes", request_dispatched: true, effect_state: "none",
      effect_reason: "read_has_no_persistent_effect", effect_authority: "native_host",
      affected_target_identities: [], receipt_refs: ["native:read-note"]
    } }
  }], "test");
  const requested = requestInput(goal.id, run.runId, run.generation);
  assert.equal(requested.projection.outcome_state, "awaiting_user_input");
  assert.equal(requested.projection.terminal_state, "open");
  assert.equal(requested.projection.noop_completion.status, "none");
  assert.equal(getGoal(goal.id)?.status, "paused");
  assert.equal(getGoal(goal.id)?.current_phase, "awaiting_user_input");
  const workReturn = listWorkReturns(goal.id).at(-1)!;
  assert.equal(verifyWorkReturnHash(workReturn), true);
  assert.equal(workReturn.status, "awaiting_user_input");
  assert.equal(workReturn.question, "What exact replacement wording should I use?");
  assert.deepEqual(workReturn.completed, ["Grounded selected TextNote 1478627."]);
  const settled = settleAssignmentTurn("interaction-session", "apply");
  assert.equal(settled.completed, false);
  assert.equal(settled.verified_noop, false);
  assert.equal(settled.reason, "required_input_missing");
}));

test("a host-detected opaque mutation input creates the clarification even when the model only returns", () => workspace(() => {
  const sessionId = "interaction-host-guard";
  const { goal } = assignment(sessionId);
  journalAssignmentActions(sessionId, [{
    action_id: "ground-note", method: "POST", path: "/revit/find-text-notes", request_effect: "read",
    body: { selected_only: true, elementIds: [1478627] }
  }], "test");
  journalAssignmentToolResults(sessionId, [{
    action_id: "ground-note", method: "POST", path: "/revit/find-text-notes", request_effect: "read",
    status: "done", request_dispatched: true,
    result_json: { canonical_attempt_settlement: {
      schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "ground-note", requested_effect: "read",
      method: "POST", path: "/revit/find-text-notes", request_dispatched: true, effect_state: "none",
      effect_reason: "read_has_no_persistent_effect", effect_authority: "native_host",
      affected_target_identities: ["element_id:1478627"], receipt_refs: ["native:ground-note"]
    } }
  }], "test");

  const settled = settleAssignmentTurn(sessionId, "apply", {
    schema: "revit-operator.teammate-loop-receipt.v1",
    turn_kind: "mutation", context_state: "live", stage: "clarify",
    preview_action_ids: [], preview_receipts: [], apply_action_id: null,
    verification_action_ids: [], apply_attempts: 0, verified: false,
    verification_mode: "none", verification_action_id: null,
    verification_evidence_sha256: null,
    blocked_reason: "desired_postcondition_missing_authenticated_user_input",
    missing_required_inputs: ["replacement_text"]
  });

  assert.equal(settled.completed, false);
  assert.equal(settled.verified_noop, false);
  assert.equal(settled.reason, "required_input_missing");
  assert.equal(settled.projection?.terminal_state, "open");
  assert.equal(settled.projection?.outcome_state, "awaiting_user_input");
  assert.equal(settled.projection?.clarifications.length, 1);
  assert.equal(settled.projection?.clarifications[0]?.question, "What exact replacement wording should I use?");
  assert.deepEqual(settled.projection?.clarifications[0]?.missing_fields, ["replacement_text"]);
  assert.equal(settled.projection?.attempts.some(attempt => attempt.requested_effect === "apply"), false);
  assert.equal(getGoal(goal.id)?.status, "paused");
  const workReturn = listWorkReturns(goal.id).at(-1)!;
  assert.equal(workReturn.status, "awaiting_user_input");
  assert.equal(workReturn.clarification_id, settled.projection?.pending_clarification_id);
  assert.equal(verifyWorkReturnHash(workReturn), true);
}));

test("authenticated response resumes the same Assignment, run, and generation after restart", () => workspace(() => {
  const { goal, run } = runWithRequestContext({ principal }, () => assignment("principal-session", principal.user_id));
  const requested = runWithRequestContext({ principal }, () => requestInput(goal.id, run.runId, run.generation, "principal-session"));
  const persisted = runWithRequestContext({ principal }, () => getGoal(goal.id))!;
  const reloaded = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(persisted.assignment_control_plane).events).projection;
  assert.equal(reloaded.pending_clarification_id, requested.clarification.clarification_id);
  const resolved = runWithRequestContext({ principal }, () => resolveAssignmentClarification({
    schema: ASSIGNMENT_CLARIFICATION_RESPONSE_SCHEMA,
    clarification_id: requested.clarification.clarification_id,
    assignment_id: goal.id,
    run_id: run.runId,
    generation: run.generation,
    session_id: "principal-session",
    response: "Use: Current issue wording",
    supplied_values: { replacement_text: "Current issue wording" }
  }));
  assert.equal(resolved.idempotent, false);
  assert.equal(resolved.projection.assignment_id, goal.id);
  assert.equal(resolved.projection.run_id, run.runId);
  assert.equal(resolved.projection.generation, run.generation);
  assert.equal(resolved.projection.outcome_state, "active");
  assert.equal(resolved.clarification.supplied_values.replacement_text, "Current issue wording");
  assert.equal(runWithRequestContext({ principal }, () => getGoal(goal.id))?.status, "active");
}));

test("duplicate response is idempotent and a conflicting duplicate is rejected", () => workspace(() => {
  const { goal, run } = assignment();
  const clarification = requestInput(goal.id, run.runId, run.generation).clarification;
  const input = {
    schema: ASSIGNMENT_CLARIFICATION_RESPONSE_SCHEMA,
    clarification_id: clarification.clarification_id,
    assignment_id: goal.id,
    run_id: run.runId,
    generation: run.generation,
    session_id: "interaction-session",
    response: "Use Current issue wording.",
    supplied_values: { replacement_text: "Current issue wording" }
  } as const;
  assert.equal(resolveAssignmentClarification(input).idempotent, false);
  assert.equal(resolveAssignmentClarification(input).idempotent, true);
  assert.throws(() => resolveAssignmentClarification({
    ...input,
    response: "Use another value.",
    supplied_values: { replacement_text: "Another value" }
  }), /conflicting_duplicate_response/);
}));

test("stale, foreign session, and foreign principal clarification responses are rejected", () => workspace(() => {
  const { goal, run } = runWithRequestContext({ principal }, () => assignment("principal-session", principal.user_id));
  const clarification = runWithRequestContext({ principal }, () => requestInput(goal.id, run.runId, run.generation, "principal-session")).clarification;
  const base = {
    schema: ASSIGNMENT_CLARIFICATION_RESPONSE_SCHEMA,
    clarification_id: clarification.clarification_id,
    assignment_id: goal.id,
    run_id: run.runId,
    generation: run.generation,
    session_id: "principal-session",
    response: "Use Current issue wording.",
    supplied_values: { replacement_text: "Current issue wording" }
  } as const;
  assert.throws(() => runWithRequestContext({ principal }, () => resolveAssignmentClarification({ ...base, generation: run.generation + 1 })), /stale_generation/);
  assert.throws(() => runWithRequestContext({ principal }, () => resolveAssignmentClarification({ ...base, session_id: "foreign-session" })), /foreign_session/);
  const foreign = { ...principal, sub: "other-user", user_id: "other-user" };
  assert.throws(() => runWithRequestContext({ principal: foreign }, () => resolveAssignmentClarification(base)), /foreign_principal|not_found/);
}));

test("pending clarification rejects provider/action work and terminal settlement", () => workspace(() => {
  const { goal, run } = assignment();
  requestInput(goal.id, run.runId, run.generation);
  let projection = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(getGoal(goal.id)?.assignment_control_plane).events).projection;
  const provider = appendAssignmentEvent(goal.id, rawEvent(projection, "provider_call_recorded", { call_id: "provider-after-question" }));
  assert.equal(provider.accepted, false);
  assert.match(provider.quarantined_reason ?? "", /awaiting user input/i);
  projection = provider.projection;
  const attempt = appendAssignmentEvent(goal.id, rawEvent(projection, "attempt_opened", {
    purpose: "action", requested_effect: "apply", action_path: "/revit/native-api-mutation-ops",
    action_signature: "sig", target_fingerprint: "element:1478627"
  }, "apply-after-question"));
  assert.equal(attempt.accepted, false);
  const terminal = appendAssignmentEvent(goal.id, rawEvent(attempt.projection, "assignment_terminal", {
    terminal_state: "complete", reason: "reported_complete"
  }));
  assert.equal(terminal.accepted, false);
  assert.equal(terminal.quarantined_reason, "assignment_settlement_deferred_awaiting_user_input");
}));

test("clarification validation is atomic when a criterion is unknown", () => workspace(() => {
  const { goal, run } = assignment();
  assert.throws(() => requestAssignmentClarification({
    schema: ASSIGNMENT_CLARIFICATION_SCHEMA,
    assignment_id: goal.id,
    run_id: run.runId,
    generation: run.generation,
    session_id: "interaction-session",
    missing_fields: ["replacement_text"],
    question: "What exact wording should I use?",
    reason: "required_input_missing",
    criterion_states: [{ criterion: "An invented criterion.", state: "needs_input" }]
  }), /unknown_criterion/);
  const projection = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(getGoal(goal.id)?.assignment_control_plane).events).projection;
  assert.equal(projection.clarifications.length, 0);
  assert.equal(projection.criteria.length, 0);
}));

test("clarification payloads reject nested credential fields without retaining them", () => workspace(() => {
  const { goal, run } = assignment();
  assert.throws(() => requestAssignmentClarification({
    schema: ASSIGNMENT_CLARIFICATION_SCHEMA,
    assignment_id: goal.id,
    run_id: run.runId,
    generation: run.generation,
    session_id: "interaction-session",
    missing_fields: ["replacement_text"],
    question: "What exact wording should I use?",
    reason: "required_input_missing",
    options: [{ id: "current", label: "Current issue wording" }],
    criterion_states: [{
      criterion: "Replace the selected note in place.",
      state: "needs_input",
      reason: "replacement wording is missing",
      evidence_refs: [],
      work_unit_ids: []
    }],
    primary_artifact_refs: [{ nested: { authorization: "Bearer not-retained" } }] as unknown as string[]
  }), /sensitive_field_forbidden/);
  const projection = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(getGoal(goal.id)?.assignment_control_plane).events).projection;
  assert.equal(projection.clarifications.length, 0);
}));
