import assert from "node:assert/strict";
import test from "node:test";
import { evidenceIsKnownNoEffectFailure } from "../src/revit_host_model_inventory.js";

test("C110 exact pre-dispatch stage mismatch has no effect and permits corrected continuation", () => {
  const evidence = {
    isError: true,
    content: [{ type: "text", text: "Error: Registered existing-conditions stage authorization responded with status 400: {\"ok\":false,\"error\":\"registered_existing_conditions_stage_body_mismatch\"}" }],
    structuredContent: {
      schema: "revit-operator.assignment-kernel-mcp-result/v2",
      operation_result_v2: {
        schema: "revit-operator.operation-result/v2",
        status: "failed_before_dispatch", dispatch_state: "not_dispatched",
        persistent_effect: "none", native_transaction_state: "not_applicable",
        authority: "operator-mcp-transport", error_code: "mcp_tool_failed"
      }
    }
  };
  const options = { firstDocumentOpen: false, contextIsLive: true };
  assert.equal(evidenceIsKnownNoEffectFailure(evidence, options), true);
  assert.equal(evidenceIsKnownNoEffectFailure({ ...evidence, structuredContent: {
    ...evidence.structuredContent, operation_result_v2: {
      ...evidence.structuredContent.operation_result_v2, dispatch_state: "dispatched"
    }
  } }, options), false);
  assert.equal(evidenceIsKnownNoEffectFailure({ ...evidence, structuredContent: {
    ...evidence.structuredContent, operation_result_v2: {
      ...evidence.structuredContent.operation_result_v2, persistent_effect: "unknown"
    }
  } }, options), false);
});
