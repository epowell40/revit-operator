import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { __testOnlyClearScheduleCellUpdateStates, maybeRunDeterministicScheduleCellUpdate } from "../src/deterministic/schedule_cell_update_runtime.js";
import { parseDirectScheduleCellUpdate, parseScheduleCellUpdateFromConversation } from "../src/schedule_cell_update_intent.js";

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

test("direct schedule update grammar preserves an explicitly named schedule", () => {
  const prompt = "Set AHU-1 MAX CFM to 0 in the AHU AIR BALANCE SCHEDULE.";
  const parsed = parseDirectScheduleCellUpdate(prompt);
  assert.equal(parsed?.row_key, "AHU-1");
  assert.equal(parsed?.target_field, "MAX CFM");
  assert.equal(parsed?.value, "0");
  assert.equal(parsed?.schedule_name, "AHU AIR BALANCE SCHEDULE");
  assert.equal(parsed?.evidence.user_text, prompt);
});

test("teammate correction grammar preserves a schedule name suffix and old-value guard", () => {
  const prompt = "The manufacturer is wrong for shock arrestor B2-G-SA-1 in the SHOCK ARRESTOR SCHEDULE - BUILDING 200. Change it from JOSAM to WATTS and keep the model and schedule consistent.";
  const parsed = parseDirectScheduleCellUpdate(prompt);
  assert.equal(parsed?.row_key, "B2-G-SA-1");
  assert.equal(parsed?.target_field, "manufacturer");
  assert.equal(parsed?.expected_value, "JOSAM");
  assert.equal(parsed?.value, "WATTS");
  assert.equal(parsed?.schedule_name, "SHOCK ARRESTOR SCHEDULE - BUILDING 200");
  assert.equal(parsed?.confidence.ambiguity, "none");
  assert.equal(parsed?.evidence.user_text, prompt);
});

test("possessive schedule correction accepts a numeric room row and calculated field", () => {
  const prompt = "Space 104's actual supply airflow is wrong in the Space Schedule. Set it to 500 CFM and keep the model and schedule consistent.";
  const parsed = parseDirectScheduleCellUpdate(prompt);
  assert.equal(parsed?.row_key, "104");
  assert.equal(parsed?.target_field, "actual supply airflow");
  assert.equal(parsed?.expected_value, null);
  assert.equal(parsed?.value, "500 CFM");
  assert.equal(parsed?.schedule_name, "Space Schedule");
  assert.equal(parsed?.confidence.ambiguity, "none");
  assert.equal(parsed?.evidence.user_text, prompt);
});

test("grouped schedule bulk wording asks for backing-element scope without launching tools", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  const req = request("schedule-grouped");
  req.user_text = "The receptacle schedule is showing mixed ampacities. Make them 20 amps and keep the model and schedule consistent.";
  const done = await maybeRunDeterministicScheduleCellUpdate(req, { async interpret() { throw new Error("grouped ambiguity should avoid model interpretation"); } });
  assert.equal(done?.actions.length, 0);
  assert.equal(done?.schedule_update_receipt?.status, "blocked");
  assert.match(done?.assistant_message ?? "", /receptacle schedule/i);
  assert.match(done?.assistant_message ?? "", /mixed ampacities to 20 amps/i);
  assert.match(done?.assistant_message ?? "", /one exact device or room, a selected set, or every device/i);
  assert.match(done?.assistant_message ?? "", /No model changes were made/i);
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

test("problem-then-action schedule wording resolves the teammate's row, field, and value", () => {
  const prompt = "AHU-1 looks undersized in the air-handler schedule. Make its supply airflow 20,000 CFM and make sure the model and schedule agree.";
  const parsed = parseDirectScheduleCellUpdate(prompt);
  assert.equal(parsed?.row_key, "AHU-1");
  assert.equal(parsed?.row_field, null);
  assert.equal(parsed?.target_field, "supply airflow");
  assert.equal(parsed?.value, "20,000 CFM");
  assert.equal(parsed?.expected_value, null);
  assert.equal(parsed?.schedule_name, null);
  assert.equal(parsed?.confidence.ambiguity, "none");
  assert.equal(parsed?.evidence.user_text, prompt);
});

test("schedule clarification follow-up carries forward only the prior row and value while accepting an offered field", () => {
  const original = "AHU-1 looks undersized in the air-handler schedule. Make its supply airflow 20,000 CFM and make sure the model and schedule agree.";
  const clarification = "The schedule visibly contains row 'AHU-1', but I could not find a column named 'supply airflow'. Did you mean TOTAL AIRFLOW (CFM), SUPPLY FAN AIRFLOW, or MAX CFM? No model changes were made.";
  const followUp = "Use TOTAL AIRFLOW (CFM) in the AHU AIR BALANCE SCHEDULE.";
  const parsed = parseScheduleCellUpdateFromConversation(followUp, [
    { role: "user", text: original },
    { role: "assistant", text: clarification },
    { role: "user", text: followUp }
  ]);
  assert.equal(parsed?.row_key, "AHU-1");
  assert.equal(parsed?.target_field, "TOTAL AIRFLOW (CFM)");
  assert.equal(parsed?.schedule_name, "AHU AIR BALANCE SCHEDULE");
  assert.equal(parsed?.value, "20,000 CFM");
  assert.equal(parsed?.evidence.user_text, followUp);

  assert.equal(parseScheduleCellUpdateFromConversation("Use COOLING CAPACITY.", [
    { role: "user", text: original },
    { role: "assistant", text: clarification },
    { role: "user", text: "Use COOLING CAPACITY." }
  ]), null);
  assert.equal(parseScheduleCellUpdateFromConversation("Use AIR.", [
    { role: "user", text: original },
    { role: "assistant", text: clarification },
    { role: "user", text: "Use AIR." }
  ]), null);
  assert.equal(parseScheduleCellUpdateFromConversation(followUp, [
    { role: "user", text: "Tell me about AHU-1." },
    { role: "assistant", text: clarification },
    { role: "user", text: followUp }
  ]), null);
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

test("native provenance blockers relay a targeted clarification question", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  await maybeRunDeterministicScheduleCellUpdate(request("schedule-provenance"));
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-provenance", [{
    action_id: "schedule-cell-update-preflight",
    method: "POST",
    path: "/revit/update-schedule-cell",
    status: "done",
    result_json: {
      status: "Blocked",
      applied: false,
      blockedReason: "The visible row is not bound to one editable parameter.",
      clarificationQuestion: "Which backing model element should I update?"
    }
  }]));
  assert.equal(done?.actions.length, 0);
  assert.match(done?.assistant_message ?? "", /visible row is not bound/i);
  assert.match(done?.assistant_message ?? "", /Which backing model element should I update\?/);
  assert.match(done?.assistant_message ?? "", /No model changes were made/);
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
