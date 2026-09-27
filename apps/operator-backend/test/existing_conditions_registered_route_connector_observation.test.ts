import assert from "node:assert/strict";
import test from "node:test";
import { loadRegisteredRouteConnectorObservationV1 } from "../src/existing_conditions/registered_route_connector_observation.js";

const observationId = `obsv2_${"a".repeat(64)}`;
const evidenceId = `ev1_${"b".repeat(32)}`;
const binding = { session_id: "session-1", assignment_id: "assignment-1", run_id: "run-1", generation: 2 };
const native = { status: "Ok", results: [{ id: 101, connectors: [] }] };
const snapshot = {
  current_binding: binding,
  observations: { [observationId]: { raw_payload_ref: `evidence:${evidenceId}` } },
  operations: { op1: { operation_id: "opv2-anchor-read", observation_ids: [observationId],
    result: { status: "succeeded", persistent_effect: "none",
      request_identity: { method: "POST", path: "/revit/get-connectors" } } } }
};
const ref = { evidence_id: evidenceId, trust_level: "authoritative_native", ...binding };

test("loads one exact native connector observation and retains its operation scope", () => {
  let payloadScope: unknown;
  const result = loadRegisteredRouteConnectorObservationV1(binding, observationId, {
    snapshot: () => snapshot as any,
    read_ref: () => ref as any,
    read_payload: (_ref, scope) => {
      payloadScope = scope;
      return Buffer.from(JSON.stringify({ raw_payload: native }));
    }
  });
  assert.deepEqual(result, native);
  assert.deepEqual(payloadScope, { ...binding, attempt_id: "opv2-anchor-read" });
});

test("rejects a stale, write-effect, wrong-tool, or untrusted connector observation", () => {
  const cases = [
    { ...snapshot, current_binding: { ...binding, run_id: "old-run" } },
    { ...snapshot, operations: { op1: { ...snapshot.operations.op1,
      result: { ...snapshot.operations.op1.result, persistent_effect: "applied" } } } },
    { ...snapshot, operations: { op1: { ...snapshot.operations.op1,
      result: { ...snapshot.operations.op1.result,
        request_identity: { method: "POST", path: "/revit/get-parameters" } } } } }
  ];
  for (const candidate of cases) {
    assert.throws(() => loadRegisteredRouteConnectorObservationV1(binding, observationId, {
      snapshot: () => candidate as any,
      read_ref: () => ref as any,
      read_payload: () => Buffer.from(JSON.stringify(native))
    }), /binding_invalid|operation_invalid/);
  }
  assert.throws(() => loadRegisteredRouteConnectorObservationV1(binding, observationId, {
    snapshot: () => snapshot as any,
    read_ref: () => ({ ...ref, trust_level: "agent_claimed" }) as any,
    read_payload: () => Buffer.from(JSON.stringify(native))
  }), /evidence_scope_invalid/);
});

test("rejects connector payloads with no unique native result", () => {
  assert.throws(() => loadRegisteredRouteConnectorObservationV1(binding, observationId, {
    snapshot: () => snapshot as any,
    read_ref: () => ref as any,
    read_payload: () => Buffer.from(JSON.stringify({ note: "seems open" }))
  }), /native_connector_readback_missing_or_ambiguous/);
});
