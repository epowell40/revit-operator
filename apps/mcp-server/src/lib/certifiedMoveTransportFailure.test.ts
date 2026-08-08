import assert from "node:assert/strict";
import test from "node:test";
import { RevitBridgeCallError } from "./revitClient.js";
import { RevitCourierError } from "./revitCourier.js";
import { certifiedMoveTransportFailurePayload } from "./certifiedMoveTransportFailure.js";

const binding = { requestInstanceHash: `sha256:${"a".repeat(64)}`, phase: "apply" as const };

test("certified move transport failure preserves direct unknown-outcome truth", () => {
  const error = new RevitBridgeCallError({
    code: "revit_bridge_invalid_response",
    message: "response lost after dispatch",
    retryable: true,
    outcomeUnknown: true,
    method: "POST",
    path: "/revit/move-elements"
  });
  assert.deepEqual(certifiedMoveTransportFailurePayload(error, binding), {
    code: "revit_bridge_invalid_response",
    error: error.message,
    phase: "transport_post_dispatch",
    request_instance_hash: binding.requestInstanceHash,
    request_phase: "apply",
    outcome_unknown: true,
    retryable: false,
    reconciliation_required: true
  });
});

test("certified move transport failure preserves courier classification and rejects ordinary errors", () => {
  const error = new RevitCourierError({
    code: "courier_execution_failed",
    message: "known pre-dispatch refusal",
    retryable: true,
    outcomeUnknown: false,
    jobId: "b".repeat(64)
  });
  assert.equal(certifiedMoveTransportFailurePayload(error, binding)?.retryable, true);
  assert.equal(certifiedMoveTransportFailurePayload(error, binding)?.outcome_unknown, false);
  assert.equal(certifiedMoveTransportFailurePayload(new Error("ordinary"), binding), null);
});
