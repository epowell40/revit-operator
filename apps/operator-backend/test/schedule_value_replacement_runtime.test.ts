import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { __testOnlyClearScheduleValueReplacementStates, maybeRunDeterministicScheduleValueReplacement } from "../src/deterministic/schedule_value_replacement_runtime.js";
import { parseDirectScheduleValueReplacement } from "../src/schedule_value_replacement_intent.js";

const bulkText = `please rename any equipment that includes "-G-" in it's designation so that it instead reads "-0-", so, for example, "B3-G-IA-01" needs to be renamed "B3-0-IA-01". please review all the plumbing schedules on P6.01, P6.02, P6.03, thanks.`;
const singleText = `Attempt a single safe test edit using the active Revit model: On sheet P6.03, identify one equipment/schedule source item whose displayed designation contains '-G-' (prefer the Pump Schedule row MWV-G-RP-1 if editable), change only that designation token to '-0-' (MWV-0-RP-1), then read back the value.`;

function request(session: string, userText: string, tool_results?: ChatRequest["tool_results"]): ChatRequest {
  return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: session, message_id: `${session}-${tool_results?.length ?? 0}`, user_text: tool_results ? "" : userText, tool_results };
}

test("issues 391 and 392 parse into bounded bulk and one-item schedule replacement intents", () => {
  const bulk = parseDirectScheduleValueReplacement(bulkText);
  assert.deepEqual(bulk?.sheet_numbers, ["P6.01", "P6.02", "P6.03"]);
  assert.deepEqual(bulk?.field_names, ["DESIG", "Designation"]);
  assert.equal(bulk?.find, "-G-");
  assert.equal(bulk?.replace, "-0-");
  assert.equal(bulk?.expected_value, null);
  assert.equal(bulk?.max_changes, null);

  const single = parseDirectScheduleValueReplacement(singleText);
  assert.deepEqual(single?.sheet_numbers, ["P6.03"]);
  assert.equal(single?.expected_value, "MWV-G-RP-1");
  assert.equal(single?.max_changes, 1);
});

test("sheet-scoped replacement preflights, hash-binds apply, and reports exact verified changes", async () => {
  __testOnlyClearScheduleValueReplacementStates();
  const first = await maybeRunDeterministicScheduleValueReplacement(request("replace-success", bulkText));
  assert.deepEqual(first?.actions, [{
    action_id: "schedule-value-replacement-preflight",
    method: "POST",
    path: "/revit/replace-schedule-values",
    body: {
      sheetNumbers: ["P6.01", "P6.02", "P6.03"], fieldNames: ["DESIG", "Designation"], valueContains: "-G-", replaceFrom: "-G-", replaceTo: "-0-",
      apply: false, dryRun: true, maxSchedules: 200, maxCandidates: 5000
    }
  }]);
  const hash = "a".repeat(64);
  const second = await maybeRunDeterministicScheduleValueReplacement(request("replace-success", bulkText, [{
    action_id: "schedule-value-replacement-preflight", method: "POST", path: "/revit/replace-schedule-values", status: "done",
    result_json: { status: "Dry Run", applied: false, planHash: hash, candidateCount: 2, writableCandidateCount: 2, blockedCandidateCount: 0 }
  }]));
  assert.deepEqual(second?.actions, [{
    action_id: "schedule-value-replacement-apply", method: "POST", path: "/revit/replace-schedule-values",
    body: {
      sheetNumbers: ["P6.01", "P6.02", "P6.03"], fieldNames: ["DESIG", "Designation"], valueContains: "-G-", replaceFrom: "-G-", replaceTo: "-0-",
      expectedPlanHash: hash, apply: true, dryRun: false, maxSchedules: 200, maxCandidates: 5000
    }
  }]);
  const done = await maybeRunDeterministicScheduleValueReplacement(request("replace-success", bulkText, [{
    action_id: "schedule-value-replacement-apply", method: "POST", path: "/revit/replace-schedule-values", status: "done",
    result_json: {
      status: "Applied and Verified", applied: true, verified: true, complete: true, planHash: hash,
      changedCount: 2, remainingMatchCount: 0, verificationFailedCount: 0,
      changed: [
        { elementId: 101, parameterName: "Designation", before: "A-G-1", after: "A-0-1" },
        { elementId: 202, parameterName: "DESIG", before: "B-G-2", after: "B-0-2" }
      ]
    }
  }]));
  assert.equal(done?.schedule_update_receipt?.status, "complete");
  assert.match(done?.assistant_message ?? "", /101 Designation: A-G-1 -> A-0-1/);
  assert.match(done?.assistant_message ?? "", /Remaining '-G-' matches: 0/);
  assert.match(done?.assistant_message ?? "", /did not save or synchronize/);
});

test("one-item request carries exact old-value and max-change guards", async () => {
  __testOnlyClearScheduleValueReplacementStates();
  const first = await maybeRunDeterministicScheduleValueReplacement(request("replace-one", singleText));
  assert.deepEqual(first?.actions[0]?.body, {
    sheetNumbers: ["P6.03"], fieldNames: ["DESIG", "Designation"], valueContains: "-G-", expectedValue: "MWV-G-RP-1",
    replaceFrom: "-G-", replaceTo: "-0-", maxChanges: 1, apply: false, dryRun: true, maxSchedules: 200, maxCandidates: 5000
  });
  const blocked = await maybeRunDeterministicScheduleValueReplacement(request("replace-one", singleText, [{
    action_id: "schedule-value-replacement-preflight", method: "POST", path: "/revit/replace-schedule-values", status: "done",
    result_json: { status: "Dry Run", applied: false, planHash: "b".repeat(64), writableCandidateCount: 2 }
  }]));
  assert.equal(blocked?.actions.length, 0);
  assert.match(blocked?.assistant_message ?? "", /permits 1 change, but 2 writable matches/);
});

test("no matches is a verified no-op while unresolved matches prevent a completion claim", async () => {
  __testOnlyClearScheduleValueReplacementStates();
  await maybeRunDeterministicScheduleValueReplacement(request("replace-none", bulkText));
  const none = await maybeRunDeterministicScheduleValueReplacement(request("replace-none", bulkText, [{
    action_id: "schedule-value-replacement-preflight", method: "POST", path: "/revit/replace-schedule-values", status: "done",
    result_json: { status: "No Matches", verified: true, remainingMatchCount: 0 }
  }]));
  assert.equal(none?.schedule_update_receipt?.status, "complete");
  assert.match(none?.assistant_message ?? "", /found no exact '-G-' matches/);

  __testOnlyClearScheduleValueReplacementStates();
  await maybeRunDeterministicScheduleValueReplacement(request("replace-partial", bulkText));
  await maybeRunDeterministicScheduleValueReplacement(request("replace-partial", bulkText, [{
    action_id: "schedule-value-replacement-preflight", method: "POST", path: "/revit/replace-schedule-values", status: "done",
    result_json: { status: "Dry Run", applied: false, planHash: "c".repeat(64), writableCandidateCount: 1 }
  }]));
  const partial = await maybeRunDeterministicScheduleValueReplacement(request("replace-partial", bulkText, [{
    action_id: "schedule-value-replacement-apply", method: "POST", path: "/revit/replace-schedule-values", status: "done",
    result_json: { status: "Applied and Verified With Unresolved Matches", applied: true, verified: true, complete: false, changedCount: 1, remainingMatchCount: 3, verificationFailedCount: 0 }
  }]));
  assert.equal(partial?.schedule_update_receipt?.status, "failed");
  assert.match(partial?.assistant_message ?? "", /3 matching schedule-backed values remain unresolved/);
});

test("ordinary sheet detail results cannot revive an unrelated MEP redline attachment", async () => {
  const { __testOnlyIsMepRouteContinuationToolResult } = await import("../src/deterministic/mep_route_redline.js");
  assert.equal(__testOnlyIsMepRouteContinuationToolResult({ action_id: "sheet_p601", method: "POST", path: "/revit/sheets", status: "done", result_json: { action: "detail", sheetNumber: "P6.01" } }), false);
  assert.equal(__testOnlyIsMepRouteContinuationToolResult({ action_id: "mep-route-sheet-123", method: "POST", path: "/revit/sheets", status: "done", result_json: { action: "detail", sheetNumber: "M104" } }), true);
});
