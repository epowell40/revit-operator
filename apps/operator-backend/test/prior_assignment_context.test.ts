import assert from "node:assert/strict";
import test from "node:test";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { priorAssignmentReceiptContext } from "../src/assignments/prior_assignment_context.js";

test("follow-up preserves historical native fields without granting cross-session or current-model authority", () => {
  const binding = { assignment_id: "previous", run_id: "run", generation: 1, session_id: "session", principal_id: "principal" };
  const payload = { verification: [{ elementId: 42, parameterName: "Type Mark", status: "verified", actual: { value: "SG-1" } }] };
  const hash = payloadDigestV2(payload).digest;
  const previous: any = { assignment_id: "previous", current_binding: binding, operations: { op: {
    operation_id: "op", binding, requested_effect: "apply", request_identity: { path: "/revit/set-parameter" }, observation_ids: ["obs"],
    result: { binding, authority: "native-host", status: "succeeded", persistent_effect: "applied", native_transaction_state: "committed", raw_payload_hash: hash }
  } }, observations: { obs: { operation_id: "op", binding, authority: "native-host", raw_payload_hash: hash, raw_payload_ref: "evidence:retained" } } };
  const current: any = { current_binding: { ...binding, assignment_id: "current", document_fingerprint: "different-document" } };
  let reads = 0;
  const load = (operationId: string, evidenceId: string) => { reads++; assert.equal(operationId, "op"); assert.equal(evidenceId, "retained"); return payload; };
  const context = priorAssignmentReceiptContext(current, previous, load);
  assert.match(context, /SG-1/); assert.match(context, /historical/); assert.match(context, /Read the exact live document/);
  for (const change of [{ session_id: "foreign" }, { principal_id: "foreign" }]) {
    reads = 0;
    assert.equal(priorAssignmentReceiptContext({ ...current, current_binding: { ...current.current_binding, ...change } }, previous, load), "");
    assert.equal(reads, 0);
  }
  const corrupted = priorAssignmentReceiptContext(current, previous, () => ({ ...payload, extra: "modified" }));
  assert.doesNotMatch(corrupted, /SG-1/);
  previous.operations.op.result.persistent_effect = "unknown";
  assert.match(priorAssignmentReceiptContext(current, previous, load), /"persistent_effect":"unknown"/);
});
