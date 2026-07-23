import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRegisteredRouteSnapStagedWorkflowV1,
  planRegisteredRouteConnectorSnapV1
} from "../src/existing_conditions/registered_route_connector_snap.js";

const HASH = "a".repeat(64);

function candidate() {
  return {
    schema_version: 1 as const,
    package_id: "fixture-sheet-1",
    primitive_id: "route-1",
    source_interpretation_sha256: HASH,
    registration_receipt_sha256: "b".repeat(64),
    raster_evidence_receipt_sha256: "c".repeat(64),
    kind: "duct" as const,
    points: [{ x: 10.1, y: 20.1 }, { x: 15.15, y: 20.1 }],
    view_id: 303,
    level_name: "Level 1",
    elevation_z_ft: 30,
    system_type: "Supply Air",
    route_type_name: "Tees",
    route_type_id: 404,
    shape: "round" as const,
    size: "8\""
  };
}

function connectorReadback(extra: unknown[] = []) {
  return {
    status: "Ok",
    results: [
      {
        id: 101,
        category: "OST_DuctFitting",
        systemName: "Mechanical Supply Air 7",
        connectors: [{
          index: 0,
          connectorId: 1,
          connectorIdBasis: "revit_native_connector_id",
          origin: [10.2, 20, 30],
          domain: "DomainHvac",
          shape: "Round",
          size: { diameterFt: 2 / 3 },
          coordinateSystem: { basisZ: [1, 0, 0] },
          physicalConnectionCount: 0
        }]
      },
      {
        id: 202,
        category: "OST_DuctFitting",
        systemName: "Mechanical Supply Air 7",
        connectors: [{
          index: 0,
          connectorId: 1,
          connectorIdBasis: "revit_native_connector_id",
          origin: [15, 20, 30],
          domain: "DomainHvac",
          shape: "Round",
          size: { diameterFt: 2 / 3 },
          coordinateSystem: { basisZ: [-1, 0, 0] },
          physicalConnectionCount: 0
        }]
      },
      ...extra
    ]
  };
}

test("snaps registered duct endpoints to unique compatible open connectors and emits staged actions", () => {
  const receipt = planRegisteredRouteConnectorSnapV1(candidate(), { native_connector_readback: connectorReadback() });
  assert.equal(receipt.status, "ready");
  assert.deepEqual(receipt.blockers, []);
  assert.equal(receipt.endpoint_snaps.length, 2);
  assert.ok(receipt.endpoint_snaps[0]!.displacement_ft < 0.15);
  assert.ok(receipt.endpoint_snaps[1]!.displacement_ft < 0.19);
  assert.deepEqual(receipt.snapped_points[0], { x: 10.2, y: 20, z: 30 });
  assert.deepEqual(receipt.snapped_points[1], { x: 15, y: 20, z: 30 });
  assert.equal(receipt.dry_run_action?.body.dryRun, true);
  assert.equal(receipt.apply_action?.body.dryRun, false);
  assert.equal(receipt.dry_run_action?.body.requireExistingEndpointConnections, true);
  assert.equal(receipt.dry_run_action?.body.ductTypeId, 404);
  assert.equal(receipt.dry_run_action?.body.diameter, "8\"");
});

test("defers when two compatible connectors are too close to distinguish", () => {
  const duplicate = {
    id: 999,
    category: "OST_DuctFitting",
    systemName: "Mechanical Supply Air 7",
    connectors: [{
      index: 0,
      connectorId: 4,
      connectorIdBasis: "revit_native_connector_id",
      origin: [10.21, 20, 30],
      domain: "DomainHvac",
      shape: "Round",
      size: { diameterFt: 2 / 3 },
      coordinateSystem: { basisZ: [1, 0, 0] },
      physicalConnectionCount: 0
    }]
  };
  const receipt = planRegisteredRouteConnectorSnapV1(candidate(), { native_connector_readback: connectorReadback([duplicate]) });
  assert.equal(receipt.status, "deferred");
  assert.ok(receipt.blockers.includes("start_endpoint_connector_match_is_ambiguous"));
  assert.equal(receipt.dry_run_action, null);
});

test("filters connected, wrong-size, and wrong-direction connectors", () => {
  const readback = connectorReadback();
  const first = (readback.results[0] as any).connectors[0];
  first.physicalConnectionCount = 1;
  const second = (readback.results[1] as any).connectors[0];
  second.size.diameterFt = 0.5;
  second.coordinateSystem.basisZ = [1, 0, 0];
  const receipt = planRegisteredRouteConnectorSnapV1(candidate(), { native_connector_readback: readback });
  assert.equal(receipt.status, "deferred");
  assert.ok(receipt.blockers.includes("start_endpoint_has_no_compatible_open_connector"));
  assert.ok(receipt.blockers.includes("end_endpoint_has_no_compatible_open_connector"));
});

test("requires native physical connection counts instead of assuming connectors are open", () => {
  const readback = connectorReadback();
  delete (readback.results[0] as any).connectors[0].physicalConnectionCount;
  assert.throws(
    () => planRegisteredRouteConnectorSnapV1(candidate(), { native_connector_readback: readback }),
    /physical_connection_count_must_be_finite/
  );
});

test("blocks unsupported non-round profiles until dimension matching is implemented", () => {
  assert.throws(
    () => planRegisteredRouteConnectorSnapV1({ ...candidate(), shape: "rectangular" as const, size: "12x8" }, { native_connector_readback: connectorReadback() }),
    /v1_only_supports_round_profiles/
  );
});

test("filters connectors from the wrong native domain", () => {
  const readback = connectorReadback();
  (readback.results[0] as any).connectors[0].domain = "DomainPiping";
  const receipt = planRegisteredRouteConnectorSnapV1(candidate(), { native_connector_readback: readback });
  assert.equal(receipt.status, "deferred");
  assert.ok(receipt.blockers.includes("start_endpoint_has_no_compatible_open_connector"));
});

test("passes a stable pipe type id through the native route action", () => {
  const input = {
    ...candidate(),
    kind: "pipe" as const,
    system_type: "Sanitary",
    route_type_name: "PVC - DWV",
    route_type_id: 246810,
    size: '2"'
  };
  const readback = connectorReadback();
  for (const row of readback.results as any[]) {
    row.category = "OST_PipeFitting";
    row.systemName = "Building Sanitary";
    for (const connector of row.connectors) {
      connector.domain = "DomainPiping";
      connector.size.diameterFt = 1 / 6;
    }
  }
  const receipt = planRegisteredRouteConnectorSnapV1(input, { native_connector_readback: readback });
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.dry_run_action?.body.pipeTypeId, 246810);
  assert.equal(receipt.dry_run_action?.body.pipeType, "PVC - DWV");
  assert.equal(receipt.dry_run_action?.body.ductTypeId, undefined);
});

test("converts a ready snap receipt into one staged route workflow", () => {
  const input = candidate();
  const receipt = planRegisteredRouteConnectorSnapV1(input, { native_connector_readback: connectorReadback() });
  const workflow = buildRegisteredRouteSnapStagedWorkflowV1(input, receipt);
  assert.equal(workflow.operations.length, 1);
  assert.equal(workflow.operations[0]?.path, "/revit/create-mep-route");
  assert.equal(workflow.operations[0]?.execution_mode, "single_action");
  assert.equal(workflow.operations[0]?.apply_body?.dryRun, undefined);
  assert.equal(workflow.maximumCreatedElements, 1);
  assert.equal(workflow.targetViewId, 303);
  assert.equal(workflow.inputFingerprintSha256, receipt.input_fingerprint_sha256);
});

test("rejects staged snap actions that differ beyond dryRun", () => {
  const input = candidate();
  const receipt = planRegisteredRouteConnectorSnapV1(input, { native_connector_readback: connectorReadback() });
  assert.ok(receipt.apply_action);
  receipt.apply_action!.body.ductSize = "10 inch";
  assert.throws(
    () => buildRegisteredRouteSnapStagedWorkflowV1(input, receipt),
    /staged_actions_diverge/
  );
});
