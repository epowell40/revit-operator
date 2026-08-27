import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  PAYLOAD_CANONICALIZATION_VERSION_V2,
  canonicalPayloadBytesV2,
  canonicalPayloadJsonV2,
  payloadDigestV2,
  payloadRepresentationDigestV2
} from "@revitoperator/payload-digest-v2";
import {
  ObservationDecoderRegistryV2,
  canonicalPayloadHashV2,
  observationFromOperationResultV2,
  unwrapOperationResultV2,
  type OperationResultTransportV2
} from "../src/execution_truth/assignment_kernel_v2_result_adapter.js";

function sharedPackageFile(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), "..", "..", "packages", "payload-digest-v2", name),
    path.resolve(process.cwd(), "..", "public", "packages", "payload-digest-v2", name)
  ];
  const selected = candidates.find(candidate => existsSync(candidate));
  assert.ok(selected, `Missing shared payload digest package file ${name}`);
  return selected;
}

test("backend process matches every shared payload digest golden vector", () => {
  const golden = JSON.parse(readFileSync(sharedPackageFile("golden-vectors.json"), "utf8"));
  assert.equal(golden.canonicalization_version, PAYLOAD_CANONICALIZATION_VERSION_V2);
  for (const vector of golden.vectors) {
    const digest = payloadDigestV2(vector.value);
    assert.equal(canonicalPayloadJsonV2(vector.value), vector.canonical_json, vector.id);
    assert.equal(Buffer.from(canonicalPayloadBytesV2(vector.value)).toString("utf8"), vector.canonical_json, vector.id);
    assert.equal(canonicalPayloadHashV2(vector.value), vector.digest, vector.id);
    assert.equal(digest.byte_count, vector.byte_count, vector.id);
    assert.deepEqual(payloadDigestV2(JSON.parse(JSON.stringify(vector.value))), digest, `${vector.id}:json-round-trip`);
  }
});

test("direct, MCP, courier, and Dynamic Runtime adapters retain one normalized payload identity", () => {
  const payload = {
    total: 509,
    groups: [{ family: "Supply Grille", type: "Double Deflection", count: 266 }]
  };
  const normalized = payloadDigestV2(payload);
  const source = payloadRepresentationDigestV2(Buffer.from(JSON.stringify(payload), "utf8"), "utf8_json_bytes");
  const binding = {
    assignment_id: "assignment-digest",
    run_id: "run-digest",
    generation: 1,
    session_id: "session-digest",
    principal_id: "principal-digest",
    document_fingerprint: "document-digest"
  };
  const result = {
    schema: "revit-operator.operation-result/v2" as const,
    result_id: "result-digest",
    operation_id: "operation-digest",
    binding,
    status: "succeeded" as const,
    dispatch_state: "dispatched" as const,
    persistent_effect: "none" as const,
    native_transaction_state: "not_applicable" as const,
    authority: "native-host",
    result_schema_id: "operator-native/POST:/revit/find-elements/v2",
    observation_required: true,
    raw_payload_hash: normalized.digest,
    payload_provenance: {
      schema: "revit-operator.payload-provenance/v2" as const,
      source,
      normalized,
      transformation_id: "revit-operator.parsed-json-to-canonical-payload",
      transformation_version: "1"
    },
    completed_at: "2026-08-27T18:00:00.000Z"
  };
  const transports: OperationResultTransportV2[] = [
    { transport: "direct_native", operation_result_v2: result },
    { transport: "typed_mcp", structured_content: { operation_result_v2: result } },
    { transport: "generic_mcp", structured_content: { operation_result_v2: result } },
    { transport: "courier", completion: { operation_result_v2: result } },
    { transport: "dynamic_runtime", settlement: { operation_result_v2: result } }
  ];
  const registry = new ObservationDecoderRegistryV2();
  registry.register(result.result_schema_id, () => [{ fact_id: "result.available", value: true }]);
  for (const transport of transports) {
    const decoded = unwrapOperationResultV2(transport);
    const observation = observationFromOperationResultV2({
      result: decoded,
      expected_binding: binding,
      observation_id: `observation-${transport.transport}`,
      raw_payload_ref: "evidence:payload-digest",
      raw_payload: payload,
      registry
    });
    assert.equal(observation.raw_payload_hash, normalized.digest, transport.transport);
    assert.deepEqual(observation.payload_provenance?.normalized, normalized, transport.transport);
  }
});
