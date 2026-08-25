import assert from "node:assert/strict";
import test from "node:test";
import {
  bindComputerClarificationResponse,
  executeGeneralRevitComputerTurn,
  modelCallReceiptsFromComputerTurns,
  pendingComputerClarification
} from "../src/benchmark/general_revit_computer_turn.js";

test("single candidate-visible value binds to the one canonical missing field", () => {
  assert.deepEqual(bindComputerClarificationResponse(
    { clarification_id: "clarification-1", missing_fields: ["replacementText"] },
    { replacement_text: "Approved wording" }
  ), {
    clarification_id: "clarification-1",
    supplied_values: { replacementText: "Approved wording" }
  });
});

test("clarification binding preserves exact keys and fails closed on ambiguous shapes", () => {
  assert.deepEqual(bindComputerClarificationResponse(
    { clarification_id: "clarification-1", missing_fields: ["replacement_text"] },
    { replacement_text: "Approved wording" }
  ).supplied_values, { replacement_text: "Approved wording" });
  assert.throws(() => bindComputerClarificationResponse(
    { clarification_id: "clarification-1", missing_fields: ["first", "second"] },
    { value: "ambiguous" }
  ), /fields_mismatch/);
  assert.throws(() => bindComputerClarificationResponse(
    { clarification_id: "clarification-1", missing_fields: ["replacementText"] },
    { first: "one", second: "two" }
  ), /fields_mismatch/);
  assert.throws(() => bindComputerClarificationResponse(
    { clarification_id: "clarification-1", missing_fields: ["replacementText"] },
    {}
  ), /fields_mismatch/);
});

test("interactive receipt aggregation preserves failed-later-turn telemetry and deduplicates overlap", () => {
  const first = {
    state: { modelCallReceipts: [
      { provider: "openai", call_id: "call-1", model: "gpt-5.6-sol", tokens: { total_tokens: 11 } },
      { provider: "openai", call_id: "call-2", model: "gpt-5.6-sol", tokens: { total_tokens: 13 } }
    ] },
    runResponse: {},
    modelTelemetryRecovery: null
  };
  const failedSecond = {
    state: { error: "assignment_clarification_response_fields_mismatch", modelCallReceipts: [] },
    runResponse: { ok: false },
    modelTelemetryRecovery: null
  };
  assert.deepEqual(
    modelCallReceiptsFromComputerTurns([first, failedSecond]).map(receipt => receipt.call_id),
    ["call-1", "call-2"]
  );

  const successfulSecond = {
    state: { modelCallReceipts: [
      { provider: "openai", call_id: "call-2", response_id: "response-2" },
      { provider: "openai", call_id: "call-3", model: "gpt-5.6-sol", tokens: { total_tokens: 17 } }
    ] },
    runResponse: {},
    modelTelemetryRecovery: null
  };
  const aggregated = modelCallReceiptsFromComputerTurns([first, successfulSecond]);
  assert.deepEqual(aggregated.map(receipt => receipt.call_id), ["call-1", "call-2", "call-3"]);
  assert.equal(aggregated[1]?.response_id, "response-2");
});

test("computer continuation sends only the bound candidate-visible clarification response", async () => {
  const requests: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const result = await executeGeneralRevitComputerTurn({
    baseUrl: "http://127.0.0.1:3907",
    caseId: "generic-edit",
    prompt: "Use the approved wording.",
    messageId: "message-2",
    processGuard: null,
    speedSettings: { outer_model: "gpt-5.6-sol", outer_reasoning_effort: "medium" },
    timeoutMs: 1_000,
    clarificationResponse: { clarification_id: "clarification-1", supplied_values: { replacement_text: "Approved wording" } },
    requestJson: async (_baseUrl, pathname, options) => {
      if (pathname === "/api/computer/run") {
        requests.push({ pathname, body: JSON.parse(String(options?.body || "{}")) as Record<string, unknown> });
        return { ok: true };
      }
      return { running: false, backendSessionId: "session-1" };
    },
    recoverTimedOutModelTelemetry: async () => { throw new Error("recovery should not run"); }
  });
  assert.equal(result.transportError, "");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.body.clarification_response, {
    schema: "revit-operator.benchmark-authenticated-clarification-response/v1",
    clarification_id: "clarification-1",
    supplied_values: { replacement_text: "Approved wording" }
  });
  assert.doesNotMatch(JSON.stringify(requests[0]), /oracle|answer_assertion|credential/i);
});

test("pending clarification recognizes only a structured durable identity", () => {
  assert.equal(pendingComputerClarification({ pendingClarification: { clarification_id: "clarification-1" } }).clarification_id, "clarification-1");
  assert.equal(pendingComputerClarification({ assignmentClarification: { id: "clarification-2" } }).id, "clarification-2");
  assert.deepEqual(pendingComputerClarification({ pendingClarification: { question: "What value?" } }), {});
});
