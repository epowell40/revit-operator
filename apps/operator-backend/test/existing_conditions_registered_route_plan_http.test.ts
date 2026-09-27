import assert from "node:assert/strict";
import test from "node:test";
import { compileRegisteredDuctContinuationPlanV1 } from "../src/existing_conditions/registered_route_plan_http.js";

const sourceHash = "a".repeat(64);
const registrationHash = "b".repeat(64);
const artifactHash = "c".repeat(64);
const evidenceId = `ev1_${"d".repeat(32)}`;
const points = [{ x: 10.1, y: 20.1 }, { x: 15.15, y: 20.1 }];
const registered = {
  schema_version: 1,
  native_write_allowed: false,
  package_id: "M104",
  frame_observation_id: `obsv2_${"f".repeat(64)}`,
  native_view_id: 303,
  registration: { verified: true, source_evidence_sha256: sourceHash },
  registered_primitives: [{
    primitive_id: "main-403-west", kind: "route_segment",
    source_mark_ids: ["mark-403-main"], source_artifact_sha256: artifactHash,
    model_points: points,
    model_endpoints: [
      { endpoint_key: "west", point: points[0], boundary: "internal", outward_direction_xy: [-1, 0] },
      { endpoint_key: "east", point: points[1], boundary: "sheet_continuation", outward_direction_xy: [1, 0] }
    ]
  }]
};
const input = { registration_evidence_id: evidenceId, primitive_id: "main-403-west",
  required_existing_endpoint: "start", deferred_far_end_reason: "Continue to next visible main",
  native_mapping: { level_name: "Level 4", elevation_z_ft: 30, system_type: "Supply Air",
    route_type_id: 404, shape: "round", size: '8"' } };
const connectors = { status: "Ok", results: [{ id: 101, category: "OST_DuctFitting",
  systemName: "Mechanical Supply Air", connectors: [{ index: 0, connectorId: 1,
    connectorIdBasis: "revit_native_connector_id", origin: [10.2, 20, 30],
    domain: "DomainHvac", shape: "Round", size: { diameterFt: 2 / 3 },
    coordinateSystem: { basisZ: [1, 0, 0] }, physicalConnectionCount: 0 }] }] };

test("canonical route compiler derives coordinates from the registered PDF and stages one exact owner", () => {
  const result = compileRegisteredDuctContinuationPlanV1(
    { ...input, points: [{ x: 900, y: 900 }], view_id: 900 },
    registered as any, registrationHash, connectors
  );
  assert.deepEqual(result.candidate.points, points);
  assert.equal(result.candidate.view_id, 303);
  assert.equal(result.candidate.source_interpretation_sha256, sourceHash);
  assert.equal(result.receipt.status, "ready");
  assert.equal(result.receipt.apply_action?.body.expectedExistingStartOwnerId, 101);
  assert.equal(result.workflow?.operations[0]?.continuation_endpoints?.[0]?.endpoint_key,
    "registered-route:main-403-west:east");
  assert.deepEqual(result.source_mark_ids, ["mark-403-main"]);
});

test("canonical route compiler defers when the live anchor is absent and rejects unknown source primitives", () => {
  const deferred = compileRegisteredDuctContinuationPlanV1(input, registered as any,
    registrationHash, { status: "Ok", results: [] });
  assert.equal(deferred.receipt.status, "deferred");
  assert.equal(deferred.workflow, null);
  assert.throws(() => compileRegisteredDuctContinuationPlanV1(
    { ...input, primitive_id: "invented" }, registered as any, registrationHash, connectors
  ), /source_primitive_missing_or_ambiguous/);
});

test("canonical route compiler stages C88 perpendicular exhaust continuation from the registered sheet", () => {
  const sourcePoints = [{ x: -32.61666628365218, y: -0.3942000617747965 },
    { x: -32.61666659114684, y: -12.70908375767317 },
    { x: -25.462490928194185, y: -12.709083936308275 },
    { x: -25.4624912606661, y: -26.02428378050155 }];
  const source = { ...registered, package_id: "unit403-m104-existing-conditions-v3", native_view_id: 1363433,
    registered_primitives: [{ ...registered.registered_primitives[0], primitive_id: "route-exhaust-4",
      model_points: sourcePoints,
      model_endpoints: [
        { endpoint_key: "near", point: sourcePoints[0], boundary: "internal", outward_direction_xy: [0, 1] },
        { endpoint_key: "far", point: sourcePoints[3], boundary: "view_boundary", outward_direction_xy: [0, -1] }
      ] }] };
  const readback = { status: "Ok", results: [{ id: 1542972, category: "Ducts",
    systemName: "Mechanical Exhaust Air 1", connectors: [{ index: 0, connectorId: 1,
      connectorIdBasis: "revit_native_connector_id",
      origin: [-32.61666666666666, -0.39419947506562, 40.16806102362584],
      domain: "DomainHvac", shape: "Round", size: { diameterFt: 1 / 3 },
      coordinateSystem: { basisZ: [1, 0, 0] }, physicalConnectionCount: 0 }] }] };
  const compiled = compileRegisteredDuctContinuationPlanV1({
    registration_evidence_id: evidenceId, primitive_id: "route-exhaust-4",
    required_existing_endpoint: "start", deferred_far_end_reason: "Visible continuation remains open",
    native_mapping: { level_name: "L4", elevation_z_ft: 40.16806102362584,
      system_type: "Exhaust Air", route_type_id: 139186, shape: "round", size: '4"' }
  }, source as any, registrationHash, readback);
  assert.equal(compiled.receipt.status, "ready");
  assert.equal(compiled.workflow?.operations[0]?.apply_body?.expectedExistingStartOwnerId, 1542972);
  assert.equal(compiled.workflow?.operations[0]?.apply_body?.requiredExistingEndpoint, "start");
  assert.deepEqual(compiled.candidate.points, sourcePoints);
});

test("canonical route compiler carries C95 axis alignment into the native route action", () => {
  const sourcePoints = [
    { x: -46.62679403126029, y: -10.55 },
    { x: -46.62679403126029, y: -25.954684036939113 },
    { x: -41.90091509642558, y: -25.954684036939113 },
    { x: -41.90091509642558, y: -30.19788394251492 }
  ];
  const source = { ...registered, package_id: "M104-unit403", native_view_id: 1363433,
    registered_primitives: [{ ...registered.registered_primitives[0], primitive_id: "supply-continuation",
      model_points: sourcePoints, model_endpoints: [
        { endpoint_key: "near", point: sourcePoints[0], boundary: "internal", outward_direction_xy: [0, 1] },
        { endpoint_key: "far", point: sourcePoints[3], boundary: "internal", outward_direction_xy: [0, -1] }
      ] }] };
  const readback = { status: "Ok", results: [{ id: 1543123, category: "OST_DuctCurves",
    systemName: "Mechanical Supply Air 1", connectors: [{ index: 0, connectorId: 1,
      connectorIdBasis: "revit_native_connector_id",
      origin: [-46.62, -10.55, 40.16806102362584], domain: "DomainHvac",
      systemClassification: "SupplyAir", shape: "Round", size: { diameterFt: 1 / 3 },
      coordinateSystem: { basisZ: [0, -1, 0] }, physicalConnectionCount: 0 }] }] };
  const compiled = compileRegisteredDuctContinuationPlanV1({
    registration_evidence_id: evidenceId, primitive_id: "supply-continuation",
    required_existing_endpoint: "start", deferred_far_end_reason: "Visible terminal remains ambiguous",
    native_mapping: { level_name: "L4", elevation_z_ft: 40.16806102362584,
      system_type: "SupplyAir", route_type_id: 139186, shape: "round", size: '4 in' }
  }, source as any, registrationHash, readback);
  assert.equal(compiled.receipt.status, "ready");
  assert.deepEqual(compiled.candidate.points, sourcePoints);
  assert.equal(compiled.receipt.snapped_points[0]?.x, -46.62);
  assert.equal(compiled.receipt.snapped_points[1]?.x, -46.62);
  const nativePoints = compiled.workflow?.operations[0]?.apply_body?.points;
  assert.ok(Array.isArray(nativePoints));
  assert.equal((nativePoints[1] as { x: number }).x, -46.62);
  assert.equal(compiled.workflow?.operations[0]?.apply_body?.expectedExistingStartOwnerId, 1543123);
  assert.equal(compiled.workflow?.operations[0]?.apply_body?.requireExistingEndpointConnections, false);
});

test("canonical route compiler uses connector-level classification rather than the owner's aggregate system name", () => {
  const exhaust = { ...connectors, results: connectors.results.map(row => ({
    ...row, systemName: "Mechanical Exhaust Air 1",
    connectors: row.connectors.map(connector => ({ ...connector, systemClassification: "SupplyAir" }))
  })) };
  const compiled = compileRegisteredDuctContinuationPlanV1(input, registered as any,
    registrationHash, exhaust);
  assert.equal(compiled.receipt.status, "ready");
  assert.equal(compiled.receipt.endpoint_snaps[0]?.connector_system_classification, "SupplyAir");
  assert.ok(compiled.workflow);
  const wrong = compileRegisteredDuctContinuationPlanV1({ ...input,
    native_mapping: { ...input.native_mapping, system_type: "Exhaust Air" }
  }, registered as any, registrationHash, exhaust);
  assert.equal(wrong.receipt.status, "deferred");
  assert.deepEqual(wrong.receipt.blockers, ["start_endpoint_system_type_mismatch"]);
  assert.deepEqual(wrong.receipt.endpoint_diagnostics?.[0]?.nearby_open_connector_systems, ["SupplyAir"]);
  assert.equal(wrong.workflow, null);
});
