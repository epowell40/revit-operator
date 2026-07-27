import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { __testOnlyClearScheduleCellUpdateStates, maybeRunDeterministicScheduleCellUpdate } from "../src/deterministic/schedule_cell_update_runtime.js";
import { parseDirectScheduleCellUpdate } from "../src/schedule_cell_update_intent.js";

const userText = "change AHU-1 supply air from 10,000 to 20,000 on the schedule";

function request(session: string, tool_results?: ChatRequest["tool_results"]): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: session,
    message_id: `${session}-${tool_results?.length ?? 0}`,
    user_text: tool_results ? "" : userText,
    tool_results
  };
}

test("direct schedule update grammar preserves identifier, field, old value, and new value", () => {
  const parsed = parseDirectScheduleCellUpdate(userText);
  assert.equal(parsed?.row_key, "AHU-1");
  assert.equal(parsed?.target_field, "supply air");
  assert.equal(parsed?.expected_value, "10,000");
  assert.equal(parsed?.value, "20,000");
  assert.equal(parsed?.schedule_name, null);
});

test("teammate-style schedule label correction resolves without API-shaped wording", () => {
  const parsed = parseDirectScheduleCellUpdate('Space 101 is labeled “Cafe” in the Space Schedule, but it should read “Cafe - Verified.” Update it and make sure the model and schedule agree.');
  assert.equal(parsed?.row_key, "101");
  assert.equal(parsed?.row_field, null);
  assert.equal(parsed?.target_field, "Name");
  assert.equal(parsed?.expected_value, "Cafe");
  assert.equal(parsed?.value, "Cafe - Verified");
  assert.equal(parsed?.schedule_name, "Space Schedule");
  assert.equal(parsed?.confidence.ambiguity, "none");
});

test("authoritative teammate wording drives a bounded schedule action despite a delegated paraphrase", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  const req = request("schedule-authoritative");
  req.user_text = 'Find Space 101 and update its space name/label from "Cafe" to exactly "Cafe - Verified."';
  req.context = { ui: { authoritative_user_text: 'Space 101 is labeled “Cafe” in the Space Schedule, but it should read “Cafe - Verified.” Update it and make sure the model and schedule agree.' } };
  const first = await maybeRunDeterministicScheduleCellUpdate(req, { async interpret() { throw new Error("direct grammar should avoid model interpretation"); } });
  assert.deepEqual(first?.actions, [{
    action_id: "schedule-cell-update-preflight",
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { scheduleQuery: "Space Schedule", scheduleExact: true, rowKey: "101", targetField: "Name", expectedValue: "Cafe", value: "Cafe - Verified", apply: false, dryRun: true }
  }]);
});

test("schedule update runtime preflights, applies, and requires committed readback", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  const first = await maybeRunDeterministicScheduleCellUpdate(request("schedule-success"));
  assert.deepEqual(first?.actions, [{
    action_id: "schedule-cell-update-preflight",
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { rowKey: "AHU-1", targetField: "supply air", expectedValue: "10,000", value: "20,000", apply: false, dryRun: true }
  }]);

  const second = await maybeRunDeterministicScheduleCellUpdate(request("schedule-success", [{
    action_id: "schedule-cell-update-preflight",
    method: "POST",
    path: "/revit/update-schedule-cell",
    status: "done",
    result_json: { status: "Dry Run", applied: false, candidate: { schedule: { id: 100, name: "Mechanical Equipment" } }, before: { display: "10,000 CFM" }, proposed: { display: "20,000 CFM" } }
  }]));
  assert.deepEqual(second?.actions, [{
    action_id: "schedule-cell-update-apply",
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { rowKey: "AHU-1", targetField: "supply air", expectedValue: "10,000 CFM", value: "20,000", apply: true, dryRun: false }
  }]);

  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-success", [{
    action_id: "schedule-cell-update-apply",
    method: "POST",
    path: "/revit/update-schedule-cell",
    status: "done",
    result_json: { status: "Applied and Verified", applied: true, verified: true, verificationFailedCount: 0, after: { display: "20,000 CFM" } }
  }]));
  assert.equal(done?.actions.length, 0);
  assert.match(done?.assistant_message ?? "", /Updated AHU-1 — supply air to 20,000 CFM/);
  assert.deepEqual(done?.schedule_update_receipt, { schema: "revit-operator.schedule-update-receipt.v1", terminal: true, status: "complete", bounded: true, verified: true });
});

test("ambiguous native resolution terminates without emitting an apply action", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  await maybeRunDeterministicScheduleCellUpdate(request("schedule-ambiguous"));
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-ambiguous", [{
    action_id: "schedule-cell-update-preflight",
    method: "POST",
    path: "/revit/update-schedule-cell",
    status: "done",
    result_json: { status: "Ambiguous", applied: false, blockedReason: "The identifier occurs in two schedules.", candidateCount: 2 }
  }]));
  assert.equal(done?.actions.length, 0);
  assert.match(done?.assistant_message ?? "", /occurs in two schedules/);
  assert.match(done?.assistant_message ?? "", /No model changes were made/);
  assert.equal(done?.schedule_update_receipt?.status, "blocked");
});

test("a stale expected value blocks before apply", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  await maybeRunDeterministicScheduleCellUpdate(request("schedule-stale"));
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-stale", [{
    action_id: "schedule-cell-update-preflight",
    method: "POST",
    path: "/revit/update-schedule-cell",
    status: "done",
    result_json: { status: "Blocked", applied: false, blockedReason: "The current scheduled value does not match the expected old value.", observedValue: "12,000 CFM" }
  }]));
  assert.equal(done?.actions.length, 0);
  assert.match(done?.assistant_message ?? "", /does not match the expected old value/);
});

test("verified flag and zero verification failures are both required for success", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  await maybeRunDeterministicScheduleCellUpdate(request("schedule-readback"));
  await maybeRunDeterministicScheduleCellUpdate(request("schedule-readback", [{
    action_id: "schedule-cell-update-preflight", method: "POST", path: "/revit/update-schedule-cell", status: "done",
    result_json: { status: "Dry Run", applied: false, candidate: { schedule: { id: 100 } }, before: { display: "10,000 CFM" } }
  }]));
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-readback", [{
    action_id: "schedule-cell-update-apply", method: "POST", path: "/revit/update-schedule-cell", status: "done",
    result_json: { status: "Applied With Verification Failure", applied: true, verified: false, verificationFailedCount: 1 }
  }]));
  assert.equal(done?.schedule_update_receipt?.status, "failed");
  assert.match(done?.assistant_message ?? "", /not claiming the schedule was updated/i);
});

test("orphaned schedule tool results stop instead of falling through", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-orphaned", [{
    action_id: "schedule-cell-update-preflight", method: "POST", path: "/revit/update-schedule-cell", status: "done",
    result_json: { status: "Dry Run", applied: false, candidate: { schedule: { id: 100 } } }
  }]));
  assert.equal(done?.actions.length, 0);
  assert.match(done?.assistant_message ?? "", /state expired or was lost/);
  assert.equal(done?.schedule_update_receipt?.status, "failed");
});

test("preflight readback is required and becomes the guarded expected value for apply", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  await maybeRunDeterministicScheduleCellUpdate(request("schedule-guard"));
  const missing = await maybeRunDeterministicScheduleCellUpdate(request("schedule-guard", [{
    action_id: "schedule-cell-update-preflight", method: "POST", path: "/revit/update-schedule-cell", status: "done",
    result_json: { status: "Dry Run", applied: false, candidate: { schedule: { id: 100 } } }
  }]));
  assert.equal(missing?.actions.length, 0);
  assert.match(missing?.assistant_message ?? "", /could not be guarded against a stale change/i);
  assert.equal(missing?.schedule_update_receipt?.status, "failed");
});

test("unexpected in-flight continuation fails closed instead of reaching generic routing", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  await maybeRunDeterministicScheduleCellUpdate(request("schedule-wrong-continuation"));
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-wrong-continuation", [{
    action_id: "some-other-action", method: "POST", path: "/revit/query", status: "done", result_json: { ok: true }
  }]));
  assert.equal(done?.actions.length, 0);
  assert.match(done?.assistant_message ?? "", /unexpected continuation/i);
  assert.equal(done?.schedule_update_receipt?.status, "failed");
});
