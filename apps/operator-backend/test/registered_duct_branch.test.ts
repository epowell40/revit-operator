import assert from "node:assert/strict";
import test from "node:test";
import { planRegisteredExistingDuctBranchV1 } from "../src/existing_conditions/registered_duct_branch.js";
import { loadRegisteredRouteConnectorObservationV1 } from "../src/existing_conditions/registered_route_connector_observation.js";

// C122's registered PDF upper Return Air branch and C127's native main geometry.
const start = { x: -38.28333348419366, y: -12.058863926207437 };
const registered: any = {
  schema_version: 1, package_id: "m104-u403-upper-ra", native_view_id: 1363433,
  frame_observation_id: `obsv2_${"a".repeat(64)}`,
  registration: { verified: true },
  registered_primitives: [{
    primitive_id: "upper-ra", kind: "route_segment", source_artifact_sha256: "3a1b26f65386c8c6a4c603028a64d7b92ebbdc472ba1ebaf4a92d126e037aebc",
    source_mark_ids: ["upper-west-eight-inch"],
    claims: { size: { value: '8"', basis: "legible_source_evidence" }, system: { value: "Return Air" } },
    confidence: { geometry: 0.93, topology: 0.9 },
    model_points: [start, { x: -42.192436541739525, y: start.y },
      { x: -44.01862521166463, y: -10.220166804376532 },
      { x: -44.01862521166463, y: -2.515150636704192 }],
    model_endpoints: [{ endpoint_key: "upper-ra:ra-main-junction", point: start },
      { endpoint_key: "upper-ra:north-open-stage", point: { x: -44.01862521166463, y: -2.515150636704192 } }]
  }]
};
const main: any = { results: [{ id: 1543280, ok: true, category: "OST_DuctCurves", typeId: 139186,
  connectors: [
    { origin: [-38.283333333333339, -8.0858005249343812, 40.168061023625839], domain: "DomainHvac", shape: "Round", systemClassification: "ReturnAir", size: { diameterFt: 2/3 }, physicalConnectionCount: 1 },
    { origin: [-38.283333333333317, -12.858816167999777, 40.168061023625832], domain: "DomainHvac", shape: "Round", systemClassification: "ReturnAir", size: { diameterFt: 2/3 }, physicalConnectionCount: 1 }
  ] }] };
const mapping = { main_element_id: 1543280, level_name: "L4", elevation_z_ft: 40.16806102362584,
  system_type: "Return Air", route_type_id: 139186, shape: "round" as const, size: '8"',
  deferred_far_end_reason: "North end is not shown connected in this source" };
const input = { registered, registration_sha256: "f".repeat(64), registration_evidence_id: `ev1_${"a".repeat(32)}`,
  primitive_id: "upper-ra", main_connector_readback: main, mapping };

test("C122 PDF branch stages an exact native split tee without moving source points", () => {
  const planned = planRegisteredExistingDuctBranchV1(input);
  assert.equal(planned.workflow.operations.length, 1);
  const action = planned.workflow.operations[0]!;
  assert.equal(action.path, "/revit/connect-mep-branch");
  assert.equal((action.apply_body as any).connectionMode, "tee");
  assert.equal((action.apply_body as any).mainElementId, 1543280);
  assert.deepEqual((action.apply_body as any).branchPoints[0], { ...start, z: mapping.elevation_z_ft });
  assert.equal(planned.workflow.benchmarkCredit, false);
  assert.equal(action.continuation_endpoints?.[0]?.output, "route_end");
});

test("interior tee blocks mismatched native main, service, size and source junction", () => {
  const changedMain = (change: object) => ({ ...main, results: [{ ...main.results[0], ...change }] });
  assert.throws(() => planRegisteredExistingDuctBranchV1({ ...input, main_connector_readback: changedMain({ typeId: 12 }) }), /main_type_mismatch/);
  assert.throws(() => planRegisteredExistingDuctBranchV1({ ...input, main_connector_readback: changedMain({ connectors: main.results[0].connectors.map((c: any) => ({ ...c, systemClassification: "SupplyAir" })) }) }), /main_service_size_or_topology_mismatch/);
  assert.throws(() => planRegisteredExistingDuctBranchV1({ ...input, mapping: { ...mapping, size: '10"' } }), /mapping_conflicts_with_source/);
  const moved = structuredClone(registered);
  moved.registered_primitives[0].model_points[0].x += 2;
  moved.registered_primitives[0].model_endpoints[0].point.x += 2;
  assert.throws(() => planRegisteredExistingDuctBranchV1({ ...input, registered: moved }), /junction_not_unique_interior_main_point/);
});

// Native GetConnectors can return an otherwise successful owner with size:null
// when reading Connector.Radius fails. Missing dimension evidence is not a match.
const invalidNativeSizes: ReadonlyArray<[string, unknown]> = [
  ["missing size", undefined], ["null size", null], ["empty size", {}],
  ["missing diameter", { diameterFt: undefined }], ["null diameter", { diameterFt: null }],
  ["NaN diameter", { diameterFt: NaN }], ["positive infinity", { diameterFt: Infinity }],
  ["negative infinity", { diameterFt: -Infinity }], ["zero diameter", { diameterFt: 0 }],
  ["negative diameter", { diameterFt: -2 / 3 }],
  ["numeric text", { diameterFt: String(2 / 3) }], ["invalid text", { diameterFt: "unavailable" }],
  ["boolean diameter", { diameterFt: true }], ["array diameter", { diameterFt: [2 / 3] }],
  ["object diameter", { diameterFt: {} }]
];

function mainWithConnectorSize(connectorIndex: number, size: unknown): any {
  const changed = structuredClone(main);
  if (size === undefined) delete changed.results[0].connectors[connectorIndex].size;
  else changed.results[0].connectors[connectorIndex].size = size;
  return changed;
}

test("interior tee rejects missing and invalid native diameters on either main end before returning a plan", () => {
  for (const [label, size] of invalidNativeSizes) {
    for (const connectorIndex of [0, 1]) {
      assert.throws(() => planRegisteredExistingDuctBranchV1({
        ...input, main_connector_readback: mainWithConnectorSize(connectorIndex, size)
      }), /main_service_size_or_topology_mismatch/, `${label}, connector ${connectorIndex}`);
    }
  }
});

test("interior tee retains numeric native diameter tolerance and rejects real size mismatches", () => {
  const baseline = planRegisteredExistingDuctBranchV1(input);
  for (const diameterFt of [2 / 3, 2 / 3 + 1 / 384, 2 / 3 - 1 / 384]) {
    for (const connectorIndex of [0, 1]) {
      const planned = planRegisteredExistingDuctBranchV1({
        ...input, main_connector_readback: mainWithConnectorSize(connectorIndex, { diameterFt })
      });
      assert.deepEqual(planned.workflow.operations, baseline.workflow.operations);
      assert.equal(planned.workflow.dryRun, true);
      assert.equal(planned.workflow.benchmarkCredit, false);
    }
  }
  for (const diameterFt of [2 / 3 + 1 / 96, 2 / 3 - 1 / 96]) {
    assert.throws(() => planRegisteredExistingDuctBranchV1({
      ...input, main_connector_readback: mainWithConnectorSize(0, { diameterFt })
    }), /main_service_size_or_topology_mismatch/);
  }
});

test("authoritative connector reader preserves missing native size and planning rejects it without a staged request", () => {
  const binding = { session_id: "diameter-review-session", assignment_id: "diameter-review-assignment",
    run_id: "diameter-review-run", generation: 1 };
  const observationId = `obsv2_${"d".repeat(64)}`;
  const evidenceId = `ev1_${"s".repeat(32)}`;
  const operationId = "opv2-native-main-read";
  const snapshot = { current_binding: binding,
    observations: { [observationId]: { raw_payload_ref: `evidence:${evidenceId}` } },
    operations: { [operationId]: { operation_id: operationId, observation_ids: [observationId],
      result: { status: "succeeded", persistent_effect: "none",
        request_identity: { method: "POST", path: "/revit/get-connectors" } } } } };
  const ref = { evidence_id: evidenceId, trust_level: "authoritative_native", ...binding };
  // Nonfinite values are not JSON; direct planner coverage above tests those.
  // This path uses the real reader over producer-shaped retained JSON bytes.
  for (const [label, size] of invalidNativeSizes.filter(([label]) => !/NaN|infinity/.test(label))) {
    const native = { status: "Ok", ...mainWithConnectorSize(0, size) };
    const serialized = JSON.stringify(native);
    let readCount = 0;
    const loaded = loadRegisteredRouteConnectorObservationV1(binding, observationId, {
      snapshot: () => snapshot as any, read_ref: () => ref as any,
      read_payload: (actualRef, scope) => {
        assert.equal(actualRef.evidence_id, evidenceId);
        assert.deepEqual(scope, { ...binding, attempt_id: operationId });
        readCount++;
        return Buffer.from(JSON.stringify({ raw_payload: JSON.parse(serialized) }));
      }
    });
    assert.equal(readCount, 1);
    assert.deepEqual(loaded, JSON.parse(serialized), label);
    assert.throws(() => planRegisteredExistingDuctBranchV1({
      ...input, main_connector_readback: loaded as any
    }), /main_service_size_or_topology_mismatch/, label);
  }
  const loaded = loadRegisteredRouteConnectorObservationV1(binding, observationId, {
    snapshot: () => snapshot as any, read_ref: () => ref as any,
    read_payload: () => Buffer.from(JSON.stringify({ raw_payload: { status: "Ok", ...main } }))
  });
  assert.deepEqual(planRegisteredExistingDuctBranchV1({ ...input, main_connector_readback: loaded as any })
    .workflow.operations, planRegisteredExistingDuctBranchV1(input).workflow.operations);
});
