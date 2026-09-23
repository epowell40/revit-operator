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
