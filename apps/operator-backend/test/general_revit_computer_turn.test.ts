import assert from "node:assert/strict";
import test from "node:test";
import {
  executeGeneralRevitComputerTurn,
  pendingComputerClarification
} from "../src/benchmark/general_revit_computer_turn.js";

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
