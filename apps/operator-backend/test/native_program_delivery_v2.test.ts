import assert from "node:assert/strict";
import test from "node:test";
import { validateResultDeliveryV2, renderResultDeliveryV2 } from "../src/domain/assignment-kernel/result_delivery.js";

test("native C# read output uses existing current-result delivery without promoting a write or incomplete execution", () => {
  const binding = { session_id: "session", assignment_id: "assignment", run_id: "run", generation: 1, principal_id: "principal", document_fingerprint: "model" };
  const snapshot: any = { spec: { result_delivery_required: true, requested_effect: "read" }, current_binding: binding,
    observations: { native: { binding, operation_id: "native-program", authority: "dynamic-runtime", evidence_class: "task_result",
      raw_payload_ref: "evidence:native", raw_payload_hash: "native-hash" } },
    operations: { "native-program": { requested_effect: "read", settlement_state: "settled", result: { status: "succeeded", persistent_effect: "none", native_transaction_state: "not_started" } } } };
  const delivery: any = { items: [{ label: "Native room query", observation_id: "native", path: ["native_outcome", "program_result"],
    value: '{"matchingRooms":3}', evidence_ref: "evidence:native", payload_hash: "native-hash" }] };
  validateResultDeliveryV2(snapshot, delivery);
  assert.match(renderResultDeliveryV2(delivery), /matchingRooms/);
  for (const change of ["failed", "unsettled", "write", "foreign", "control", "wrong-hash"]) {
    const s = structuredClone(snapshot), d = structuredClone(delivery);
    if (change === "failed") s.operations["native-program"].result.status = "failed_after_dispatch";
    if (change === "unsettled") s.operations["native-program"].settlement_state = "retaining_observation";
    if (change === "write") { s.operations["native-program"].requested_effect = "apply"; s.operations["native-program"].result.persistent_effect = "applied"; }
    if (change === "foreign") s.observations.native.binding = { ...binding, session_id: "other" };
    if (change === "control") s.observations.native.evidence_class = "control";
    if (change === "wrong-hash") d.items[0].payload_hash = "other";
    assert.throws(() => validateResultDeliveryV2(s, d), /ineligible|invalid/, change);
  }
  assert.equal(snapshot.operations["native-program"].result.native_transaction_state, "not_started");
});
