import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { __testOnlyClearScheduleCellUpdateStates, maybeRunDeterministicScheduleCellUpdate, type ScheduleCellUpdateContinuationStore } from "../src/deterministic/schedule_cell_update_runtime.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistenceManager } from "../src/persistence/persistence_manager.js";

import { parseDirectScheduleCellUpdate, parseScheduleCellUpdateFromConversation } from "../src/schedule_cell_update_intent.js";

const userText = "change AHU-1 supply air from 10,000 to 20,000 on the schedule";
const previousWorkspaceRoot = process.env.OPERATOR_WORKSPACE_ROOT;
const runtimeTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-runtime-tests-"));
process.env.OPERATOR_WORKSPACE_ROOT = runtimeTestRoot;
test.after(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
  else process.env.OPERATOR_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(runtimeTestRoot, { recursive: true, force: true });
});

function request(session: string, tool_results?: ChatRequest["tool_results"]): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: session,
    message_id: `${session}-${tool_results?.length ?? 0}`,
    user_text: tool_results ? "" : userText,
    tool_results
  };
}
function responseActionId(value: { actions?: Array<{ action_id: string }> } | null | undefined, stage: "preflight" | "apply"): string {
  const actionId = value?.actions?.find(action => action.action_id.includes(`-${stage}-`))?.action_id;
  assert.ok(actionId, `missing ${stage} action id`);
  return actionId;
}

function scheduleToolResult(action_id: string, result_json: unknown): NonNullable<ChatRequest["tool_results"]>[number] {
  return {
    action_id,
    method: "POST",
    path: "/revit/update-schedule-cell",
    status: "done",
    result_json
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
    action_id: responseActionId(first, "preflight"),
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { scheduleQuery: "Space Schedule", scheduleExact: true, rowKey: "101", targetField: "Name", expectedValue: "Cafe", value: "Cafe - Verified", apply: false, dryRun: true }
  }]);
});

test("schedule update runtime preflights, applies, and requires committed readback", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  const first = await maybeRunDeterministicScheduleCellUpdate(request("schedule-success"));
  const preflightActionId = responseActionId(first, "preflight");
  assert.deepEqual(first?.actions, [{
    action_id: preflightActionId,
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { rowKey: "AHU-1", targetField: "supply air", expectedValue: "10,000", value: "20,000", apply: false, dryRun: true }
  }]);

  const second = await maybeRunDeterministicScheduleCellUpdate(request("schedule-success", [{
    action_id: preflightActionId,
    method: "POST",
    path: "/revit/update-schedule-cell",
    status: "done",
    result_json: { status: "Dry Run", applied: false, candidate: { schedule: { id: 100, name: "Mechanical Equipment" } }, before: { display: "10,000 CFM" }, proposed: { display: "20,000 CFM" } }
  }]));
  const applyActionId = responseActionId(second, "apply");
  assert.deepEqual(second?.actions, [{
    action_id: applyActionId,
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { rowKey: "AHU-1", targetField: "supply air", expectedValue: "10,000 CFM", value: "20,000", apply: true, dryRun: false }
  }]);

  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-success", [{
    action_id: applyActionId,
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
  const first = await maybeRunDeterministicScheduleCellUpdate(request("schedule-ambiguous"));
  const preflightActionId = responseActionId(first, "preflight");
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-ambiguous", [{
    action_id: preflightActionId,
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
  const first = await maybeRunDeterministicScheduleCellUpdate(request("schedule-provenance"));
  const preflightActionId = responseActionId(first, "preflight");
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-provenance", [{
    action_id: preflightActionId,
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
  const first = await maybeRunDeterministicScheduleCellUpdate(request("schedule-stale"));
  const preflightActionId = responseActionId(first, "preflight");
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-stale", [{
    action_id: preflightActionId,
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
  const first = await maybeRunDeterministicScheduleCellUpdate(request("schedule-readback"));
  const preflightActionId = responseActionId(first, "preflight");
  const second = await maybeRunDeterministicScheduleCellUpdate(request("schedule-readback", [{
    action_id: preflightActionId, method: "POST", path: "/revit/update-schedule-cell", status: "done",
    result_json: { status: "Dry Run", applied: false, candidate: { schedule: { id: 100 } }, before: { display: "10,000 CFM" } }
  }]));
  const applyActionId = responseActionId(second, "apply");
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-readback", [{
    action_id: applyActionId, method: "POST", path: "/revit/update-schedule-cell", status: "done",
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
  const first = await maybeRunDeterministicScheduleCellUpdate(request("schedule-guard"));
  const preflightActionId = responseActionId(first, "preflight");
  const missing = await maybeRunDeterministicScheduleCellUpdate(request("schedule-guard", [{
    action_id: preflightActionId, method: "POST", path: "/revit/update-schedule-cell", status: "done",
    result_json: { status: "Dry Run", applied: false, candidate: { schedule: { id: 100 } } }
  }]));
  assert.equal(missing?.actions.length, 0);
  assert.match(missing?.assistant_message ?? "", /could not be guarded against a stale change/i);
  assert.equal(missing?.schedule_update_receipt?.status, "failed");
});

test("unexpected in-flight continuation fails closed instead of reaching generic routing", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  const first = await maybeRunDeterministicScheduleCellUpdate(request("schedule-wrong-continuation"));
  const preflightActionId = responseActionId(first, "preflight");
  const done = await maybeRunDeterministicScheduleCellUpdate(request("schedule-wrong-continuation", [{
    action_id: "some-other-action", method: "POST", path: "/revit/query", status: "done", result_json: { ok: true }
  }]));
  assert.equal(done?.actions.length, 0);
  assert.match(done?.assistant_message ?? "", /unexpected continuation/i);
  assert.equal(done?.schedule_update_receipt, undefined);
  assert.match(done?.assistant_message ?? "", /non-terminal/i);
  const valid = await maybeRunDeterministicScheduleCellUpdate(request("schedule-wrong-continuation", [scheduleToolResult(preflightActionId, { status: "Dry Run", applied: false, candidate: { schedule: { id: 100 } }, before: { display: "10,000 CFM" } })]));
  assert.match(responseActionId(valid, "apply"), /^schedule-cell-update-apply-/);
});

test("schedule continuation rehydrates after a persistence-manager replacement", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-continuation-restart-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const session = "schedule-restart";
  try {
    const first = await maybeRunDeterministicScheduleCellUpdate(request(session), undefined, new PersistenceManager());
    const preflightActionId = responseActionId(first, "preflight");
    assert.match(preflightActionId, /^schedule-cell-update-preflight-/);

    const second = await maybeRunDeterministicScheduleCellUpdate(request(session, [{
      action_id: preflightActionId,
      method: "POST",
      path: "/revit/update-schedule-cell",
      status: "done",
      result_json: { status: "Dry Run", applied: false, candidate: { schedule: { id: 100 } }, before: { display: "10,000 CFM" } }
    }]), undefined, new PersistenceManager());
    const applyActionId = responseActionId(second, "apply");
    assert.match(applyActionId, /^schedule-cell-update-apply-/);
    assert.equal((second?.actions[0]?.body as Record<string, unknown>)?.expectedValue, "10,000 CFM");

    const done = await maybeRunDeterministicScheduleCellUpdate(request(session, [{
      action_id: applyActionId,
      method: "POST",
      path: "/revit/update-schedule-cell",
      status: "done",
      result_json: { status: "Applied and Verified", applied: true, verified: true, verificationFailedCount: 0, after: { display: "20,000 CFM" } }
    }]), undefined, new PersistenceManager());
    assert.equal(done?.schedule_update_receipt?.status, "complete");
    assert.equal(fs.existsSync(path.join(root, "runs", "sessions", session, "mutation_continuations", "schedule-cell-update.json")), false);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("expired and malformed persisted continuations fail closed", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-continuation-invalid-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const store = new PersistenceManager();
    store.writeMutationContinuation({
      sessionId: "schedule-malformed",
      operationId: "schedule-cell-update",
      kind: "revit.schedule-cell-update",
      expiresAt: Date.now() + 60_000,
      state: {}
    });
    const malformed = await maybeRunDeterministicScheduleCellUpdate(request("schedule-malformed", [{
      action_id: "schedule-cell-update-preflight", method: "POST", path: "/revit/update-schedule-cell", status: "done", result_json: {}
    }]), undefined, new PersistenceManager());
    assert.equal(malformed?.schedule_update_receipt?.status, "failed");
    assert.match(malformed?.assistant_message ?? "", /quarantined/i);
    const malformedRecord = store.readMutationContinuation<{ stage?: string }>({ sessionId: "schedule-malformed", operationId: "schedule-cell-update" });
    assert.equal(malformedRecord?.state.stage, "quarantined");


    const malformedPath = path.join(root, "runs", "sessions", "schedule-unreadable", "mutation_continuations", "schedule-cell-update.json");
    fs.mkdirSync(path.dirname(malformedPath), { recursive: true });
    fs.writeFileSync(malformedPath, "{", "utf8");
    const unreadable = await maybeRunDeterministicScheduleCellUpdate(request("schedule-unreadable", [{
      action_id: "schedule-cell-update-preflight", method: "POST", path: "/revit/update-schedule-cell", status: "done", result_json: {}
    }]), undefined, new PersistenceManager());
    assert.equal(unreadable?.schedule_update_receipt?.status, "failed");
    assert.match(unreadable?.assistant_message ?? "", /quarantined/i);
    const unreadableRecord = store.readMutationContinuation<{ stage?: string }>({ sessionId: "schedule-unreadable", operationId: "schedule-cell-update" });
    assert.equal(unreadableRecord?.state.stage, "quarantined");

    const seed = await maybeRunDeterministicScheduleCellUpdate(request("schedule-expired"), undefined, store);
    assert.match(responseActionId(seed, "preflight"), /^schedule-cell-update-preflight-/);
    const seeded = store.readMutationContinuation<Record<string, unknown>>({ sessionId: "schedule-expired", operationId: "schedule-cell-update" });
    assert.ok(seeded);
    store.writeMutationContinuation({
      sessionId: "schedule-expired",
      operationId: "schedule-cell-update",
      kind: "revit.schedule-cell-update",
      expiresAt: Date.now() - 1,
      state: { ...seeded.state, expires_at: Date.now() - 1 }
    });
    const expired = await maybeRunDeterministicScheduleCellUpdate(request("schedule-expired", [{
      action_id: "schedule-cell-update-preflight", method: "POST", path: "/revit/update-schedule-cell", status: "done", result_json: {}
    }]), undefined, new PersistenceManager());
    assert.equal(expired?.schedule_update_receipt?.status, "failed");
    assert.match(expired?.assistant_message ?? "", /expired or was lost/i);
    assert.equal(store.readMutationContinuation({ sessionId: "schedule-expired", operationId: "schedule-cell-update" }), null);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("expected-revision deletion does not claim an already-retired continuation", { concurrency: false }, () => {
  const store = new PersistenceManager();
  const session = "schedule-delete-cas";
  store.writeMutationContinuation({
    sessionId: session,
    operationId: "schedule-cell-update",
    kind: "revit.schedule-cell-update",
    expiresAt: Date.now() + 60_000,
    state: {}
  });
  const record = store.readMutationContinuation({ sessionId: session, operationId: "schedule-cell-update" });
  assert.ok(record);
  assert.equal(store.deleteMutationContinuation({ sessionId: session, operationId: "schedule-cell-update", expectedRevision: record.revision + 1 }), false);
  assert.equal(store.deleteMutationContinuation({ sessionId: session, operationId: "schedule-cell-update", expectedRevision: record.revision }), true);
  assert.equal(store.deleteMutationContinuation({ sessionId: session, operationId: "schedule-cell-update", expectedRevision: record.revision }), false);
});

test("schedule continuation action ids reject overlap and delayed prior results", async () => {
  __testOnlyClearScheduleCellUpdateStates();
  const session = "schedule-correlation";
  const first = await maybeRunDeterministicScheduleCellUpdate(request(session));
  const firstPreflight = responseActionId(first, "preflight");
  const overlap = await maybeRunDeterministicScheduleCellUpdate(request(session));
  assert.equal(overlap?.schedule_update_receipt?.status, "blocked");
  const firstPreflightStep = await maybeRunDeterministicScheduleCellUpdate(request(session, [scheduleToolResult(firstPreflight, { status: "Dry Run", applied: false, candidate: { schedule: { id: 100 } }, before: { display: "10,000 CFM" } })]));
  const firstApply = responseActionId(firstPreflightStep, "apply");
  const firstDone = await maybeRunDeterministicScheduleCellUpdate(request(session, [scheduleToolResult(firstApply, { status: "Applied and Verified", applied: true, verified: true, verificationFailedCount: 0, after: { display: "20,000 CFM" } })]));
  assert.equal(firstDone?.schedule_update_receipt?.status, "complete");
  const second = await maybeRunDeterministicScheduleCellUpdate(request(session));
  const secondPreflight = responseActionId(second, "preflight");
  assert.notEqual(secondPreflight, firstPreflight);
  const stale = await maybeRunDeterministicScheduleCellUpdate(request(session, [scheduleToolResult(firstPreflight, { status: "Dry Run", applied: false, candidate: { schedule: { id: 999 } }, before: { display: "stale" } })]));
  assert.equal(stale?.schedule_update_receipt, undefined);
  assert.match(stale?.assistant_message ?? "", /non-terminal/i);
  assert.match(stale?.assistant_message ?? "", /unexpected continuation/i);
  const valid = await maybeRunDeterministicScheduleCellUpdate(request(session, [scheduleToolResult(secondPreflight, { status: "Dry Run", applied: false, candidate: { schedule: { id: 100 } }, before: { display: "10,000 CFM" } })]));
  const secondApply = responseActionId(valid, "apply");
  const secondDone = await maybeRunDeterministicScheduleCellUpdate(request(session, [scheduleToolResult(secondApply, { status: "Applied and Verified", applied: true, verified: true, verificationFailedCount: 0, after: { display: "20,000 CFM" } })]));
  assert.equal(secondDone?.schedule_update_receipt?.status, "complete");

});
test("concurrent schedule requests have one continuation owner and one CAS terminal", { concurrency: false }, async () => {
  __testOnlyClearScheduleCellUpdateStates();
  const session = "schedule-concurrent-owner";
  const [first, second] = await Promise.all([
    maybeRunDeterministicScheduleCellUpdate(request(session)),
    maybeRunDeterministicScheduleCellUpdate(request(session))
  ]);
  const actionOwners = [first, second].filter(item => (item?.actions.length ?? 0) > 0);
  assert.equal(actionOwners.length, 1);
  assert.equal([first, second].filter(item => item?.schedule_update_receipt?.status === "blocked").length, 1);
  const preflight = responseActionId(actionOwners[0], "preflight");
  const applyStep = await maybeRunDeterministicScheduleCellUpdate(request(session, [scheduleToolResult(preflight, { status: "Dry Run", applied: false, candidate: { schedule: { id: 100 } }, before: { display: "10,000 CFM" } })]));
  const applyActionId = responseActionId(applyStep, "apply");
  const [done, duplicate] = await Promise.all([
    maybeRunDeterministicScheduleCellUpdate(request(session, [scheduleToolResult(applyActionId, { status: "Applied and Verified", applied: true, verified: true, verificationFailedCount: 0, after: { display: "20,000 CFM" } })])),
    maybeRunDeterministicScheduleCellUpdate(request(session, [scheduleToolResult(applyActionId, { status: "Applied and Verified", applied: true, verified: true, verificationFailedCount: 0, after: { display: "20,000 CFM" } })]))
  ]);
  const terminals = [done, duplicate];
  assert.equal(terminals.filter(item => item?.schedule_update_receipt?.status === "complete").length, 1);
  assert.equal(terminals.filter(item => item?.schedule_update_receipt?.status === "failed").length, 1);
});
test("failed continuation cleanup quarantines instead of allowing replay", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-continuation-quarantine-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const inner = new PersistenceManager();
  const store: ScheduleCellUpdateContinuationStore = {
    writeMutationContinuation: inner.writeMutationContinuation.bind(inner),
    createMutationContinuation: inner.createMutationContinuation.bind(inner),
    replaceMutationContinuation: inner.replaceMutationContinuation.bind(inner),
    readMutationContinuation: inner.readMutationContinuation.bind(inner),
    deleteMutationContinuation: () => { throw new Error("delete denied"); },
    quarantineMalformedMutationContinuation: inner.quarantineMalformedMutationContinuation.bind(inner)
  };
  const session = "schedule-quarantine";
  try {
    const first = await maybeRunDeterministicScheduleCellUpdate(request(session), undefined, store);
    const preflight = responseActionId(first, "preflight");
    const failed = await maybeRunDeterministicScheduleCellUpdate(request(session, [scheduleToolResult(preflight, { status: "Ambiguous", applied: false, blockedReason: "ambiguous" })]), undefined, store);
    assert.equal(failed?.schedule_update_receipt?.status, "failed");
    const replay = await maybeRunDeterministicScheduleCellUpdate(request(session, [scheduleToolResult(preflight, { status: "Ambiguous", applied: false, blockedReason: "ambiguous" })]), undefined, store);
    assert.equal(replay?.schedule_update_receipt?.status, "failed");
    assert.match(replay?.assistant_message ?? "", /quarantined/i);
    const record = inner.readMutationContinuation<{ stage?: string }>({ sessionId: session, operationId: "schedule-cell-update" });
    assert.equal(record?.state.stage, "quarantined");
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
