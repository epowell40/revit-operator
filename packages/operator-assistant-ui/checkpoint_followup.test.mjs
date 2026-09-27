import assert from "node:assert/strict";
import test from "node:test";
import { checkpointDirectionContext, checkpointResumeReady } from "./checkpoint_followup.mjs";

function fixture() {
  const binding = { assignment_id: "task", session_id: "conversation", run_id: "run", generation: 1, document_fingerprint: "document" };
  const publication = { schema: "revit-operator.assignment-kernel-publication/v2", assignment_id: "task", assignment_version: 7,
    snapshot: { assignment_version: 7, current_binding: binding,
      spec: { binding, execution_policy: { mode: "local_advisory_v1" } },
      terminal: false, outcome: "awaiting_user_review", quiescent: true,
      pending_review_ids: ["review"], pending_input_variable_ids: [], unresolved_unknown_operation_ids: [],
      completion_proposal: { review_id: "review", verified: false } } };
  const goal = { _bindingV2: binding, _assignmentVersion: 7, _projection: { target: { document_fingerprint: "document" } } };
  return { publication, goal };
}

test("advisory follow-up uses exact canonical review, document and execution control fences", () => {
  const { publication, goal } = fixture();
  assert.deepEqual(checkpointDirectionContext(publication, goal), { paused: false, checkpoint: {
    review_id: "review", expected_control_command_id: null, document_fingerprint: "document" } });
  publication.snapshot.execution_control = goal._executionControl = { state: "paused", command_id: "explicit-pause" };
  const context = checkpointDirectionContext(publication, goal);
  assert.equal(context.paused, true); assert.equal(context.checkpoint.expected_control_command_id, "explicit-pause");
});

test("stale publication, binding, document and control views cannot prepare a checkpoint direction", () => {
  for (const mutate of [
    p => { p.assignment_version = p.snapshot.assignment_version = 6; },
    p => { p.snapshot.assignment_version = 8; },
    p => { p.snapshot.current_binding = { ...p.snapshot.current_binding, generation: 2 }; },
    p => { p.snapshot.spec.binding = { ...p.snapshot.spec.binding, document_fingerprint: "other" }; },
    p => { p.snapshot.current_binding = { ...p.snapshot.current_binding, document_fingerprint: "other" }; },
    p => { p.snapshot.execution_control = { state: "paused", command_id: "new-pause" }; },
    p => { p.snapshot.spec.execution_policy.mode = "verified"; },
    p => { p.snapshot.pending_review_ids.push("another-review"); },
    p => { p.snapshot.completion_proposal.verified = true; }
  ]) {
    const { publication, goal } = fixture(); mutate(publication);
    assert.throws(() => checkpointDirectionContext(publication, goal), /draft is retained/);
  }
});

test("only a fresh active release can proceed to Resume, with Pause, newer reviews and blockers retained", () => {
  const { publication, goal } = fixture();
  const command = { ...goal._bindingV2, checkpoint: checkpointDirectionContext(publication, goal).checkpoint };
  assert.equal(checkpointResumeReady(publication, goal, command), false);
  delete publication.snapshot.completion_proposal; publication.snapshot.pending_review_ids = []; publication.snapshot.outcome = "active";
  assert.equal(checkpointResumeReady(publication, goal, command), true);
  for (const mutate of [
    p => { p.snapshot.quiescent = false; }, p => { p.snapshot.terminal = true; },
    p => { p.snapshot.pending_input_variable_ids = ["answer"]; },
    p => { p.snapshot.unresolved_unknown_operation_ids = ["unsettled"]; },
    p => { p.snapshot.pending_review_ids = ["later"]; }
  ]) { const blocked = structuredClone(publication); mutate(blocked); assert.equal(checkpointResumeReady(blocked, goal, command), false); }
  publication.snapshot.execution_control = goal._executionControl = { state: "paused", command_id: "pause" };
  assert.equal(checkpointResumeReady(publication, goal, command), false);
});
