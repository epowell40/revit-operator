import assert from "node:assert/strict";
import test from "node:test";

import { bindCanonicalAssignmentToolArguments } from "../src/assignments/tool_argument_binding.js";

const binding = {
  session_id: "ps1_authoritative-session",
  assignment_id: "assignment-current",
  run_id: "sidecar:run-current",
  generation: 3
};

test("clarification dispatch replaces model-supplied lifecycle bindings with canonical host truth", () => {
  const result = bindCanonicalAssignmentToolArguments("operator_request_clarification", {
    assignmentId: "assignment-current",
    runId: "sidecar:run-current",
    generation: 3,
    sessionId: "run-current",
    missingFields: ["replacementText"],
    question: "What exact wording should I use?",
    reason: "required_input_missing"
  }, binding);

  assert.deepEqual(result.arguments, {
    assignmentId: "assignment-current",
    runId: "sidecar:run-current",
    generation: 3,
    sessionId: "ps1_authoritative-session",
    missingFields: ["replacementText"],
    question: "What exact wording should I use?",
    reason: "required_input_missing"
  });
  assert.deepEqual(result.corrected_fields, ["sessionId"]);
});

test("all Assignment-scoped completion and evidence tools receive the same canonical binding", () => {
  for (const tool of [
    "operator_request_clarification",
    "operator_submit_noop_completion",
    "operator_submit_read_completion",
    "operator_retrieve_evidence"
  ]) {
    const result = bindCanonicalAssignmentToolArguments(tool, {}, binding);
    assert.equal(result.arguments.sessionId, binding.session_id);
    assert.equal(result.arguments.assignmentId, binding.assignment_id);
    assert.equal(result.arguments.runId, binding.run_id);
    assert.equal(result.arguments.generation, binding.generation);
  }
});

test("ordinary Revit tool arguments are not rewritten", () => {
  const args = { method: "POST", path: "/revit/find-text-notes", body: { selected_only: true } };
  const result = bindCanonicalAssignmentToolArguments("revit_call_tool", args, binding);
  assert.equal(result.arguments, args);
  assert.deepEqual(result.corrected_fields, []);
});

test("binding diagnostics identify every conflicting model-supplied lifecycle field without retaining credentials", () => {
  const result = bindCanonicalAssignmentToolArguments("operator_submit_read_completion", {
    assignmentId: "foreign-assignment",
    runId: "stale-run",
    generation: 2,
    sessionId: "foreign-session",
    resultDigest: "sha256:result"
  }, binding);
  assert.deepEqual(result.corrected_fields, ["assignmentId", "runId", "generation", "sessionId"]);
  assert.equal(JSON.stringify(result).includes("Authorization"), false);
  assert.equal(JSON.stringify(result).includes("Bearer"), false);
});
