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

test("snaps rectangular duct endpoints by both native dimensions", () => {
  const input = { ...candidate(), shape: "rectangular" as const, size: "12x8" };
  const readback = connectorReadback();
  for (const row of readback.results as any[]) {
    for (const connector of row.connectors) {
      connector.shape = "Rectangular";
      connector.size = { widthFt: 1, heightFt: 2 / 3 };
    }
  }
  const receipt = planRegisteredRouteConnectorSnapV1(input, { native_connector_readback: readback });
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.dry_run_action?.body.ductShape, "rectangular");
  assert.equal(receipt.dry_run_action?.body.ductSize, "12x8");
  assert.equal(receipt.dry_run_action?.body.diameter, undefined);
});

test("snaps oval duct endpoints by both native dimensions", () => {
  const input = { ...candidate(), shape: "oval" as const, size: "14\" x 8\"" };
  const readback = connectorReadback();
  for (const row of readback.results as any[]) {
    for (const connector of row.connectors) {
      connector.shape = "Oval";
      connector.size = { widthFt: 14 / 12, heightFt: 2 / 3 };
    }
  }
  const receipt = planRegisteredRouteConnectorSnapV1(input, { native_connector_readback: readback });
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.dry_run_action?.body.ductShape, "oval");
});

test("defers a rectangular duct when either native profile dimension differs", () => {
  const input = { ...candidate(), shape: "rectangular" as const, size: "12x8" };
  const readback = connectorReadback();
  for (const row of readback.results as any[]) {
    for (const connector of row.connectors) {
      connector.shape = "Rectangular";
      connector.size = { widthFt: 1, heightFt: 10 / 12 };
    }
  }
  const receipt = planRegisteredRouteConnectorSnapV1(input, { native_connector_readback: readback });
  assert.equal(receipt.status, "deferred");
  assert.ok(receipt.blockers.includes("start_endpoint_has_no_compatible_open_connector"));
});

test("rejects non-round pipe and conduit profiles as unsupported native domains", () => {
  assert.throws(
    () => planRegisteredRouteConnectorSnapV1({ ...candidate(), kind: "pipe" as const, shape: "rectangular" as const, size: "12x8" }, { native_connector_readback: connectorReadback() }),
    /profile_not_supported_for_kind/
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
  assert.equal(receipt.action_mode, "pipe_between_existing_connectors");
  assert.equal(receipt.dry_run_action?.path, "/revit/create-pipe-between-connectors");
  assert.equal(receipt.dry_run_action?.body.sourceElementId, 101);
  assert.equal(receipt.dry_run_action?.body.targetElementId, 202);
  assert.equal(receipt.dry_run_action?.body.service, "sanitary");
  assert.equal(receipt.dry_run_action?.body.pipeType, "PVC - DWV");
  assert.equal(receipt.dry_run_action?.body.pipeSize, '2"');
  assert.equal(receipt.dry_run_action?.body.verify, true);
  assert.equal(receipt.dry_run_action?.body.dryRun, true);
});

test("keeps unsupported-service and multi-segment pipes on the general route creator", () => {
  const hydronic = {
    ...candidate(),
    kind: "pipe" as const,
    system_type: "Hydronic Supply",
    route_type_name: "Steel",
    size: '2"'
  };
  const hydronicReadback = connectorReadback();
  for (const row of hydronicReadback.results as any[]) {
    row.category = "OST_PipeFitting";
    row.systemName = "Hydronic Supply Loop";
    for (const connector of row.connectors) {
      connector.domain = "DomainPiping";
      connector.size.diameterFt = 1 / 6;
    }
  }
  const hydronicReceipt = planRegisteredRouteConnectorSnapV1(hydronic, { native_connector_readback: hydronicReadback });
  assert.equal(hydronicReceipt.status, "ready");
  assert.equal(hydronicReceipt.action_mode, "create_mep_route");
  assert.equal(hydronicReceipt.dry_run_action?.path, "/revit/create-mep-route");

  const multiSegment = {
    ...hydronic,
    system_type: "Sanitary",
    route_type_name: "PVC - DWV",
    points: [{ x: 10.1, y: 20.1 }, { x: 12.5, y: 20.1 }, { x: 15.15, y: 20.1 }]
  };
  for (const row of hydronicReadback.results as any[]) row.systemName = "Building Sanitary";
  const multiReceipt = planRegisteredRouteConnectorSnapV1(multiSegment, { native_connector_readback: hydronicReadback });
  assert.equal(multiReceipt.status, "ready");
  assert.equal(multiReceipt.action_mode, "create_mep_route");
  assert.equal(multiReceipt.dry_run_action?.path, "/revit/create-mep-route");
});

test("keeps pipe spans beyond the exact bridge handler limit on the general route creator", () => {
  const input = {
    ...candidate(),
    kind: "pipe" as const,
    system_type: "Sanitary",
    route_type_name: "PVC - DWV",
    size: '2"',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }]
  };
  const readback = {
    status: "Ok",
    results: [
      {
        id: 101,
        category: "OST_PipeFitting",
        systemName: "Building Sanitary",
        connectors: [{
          index: 0,
          connectorId: 1,
          connectorIdBasis: "revit_native_connector_id",
          origin: [0, 0, 30],
          domain: "DomainPiping",
          shape: "Round",
          size: { diameterFt: 1 / 6 },
          coordinateSystem: { basisZ: [1, 0, 0] },
          physicalConnectionCount: 0
        }]
      },
      {
        id: 202,
        category: "OST_PipeFitting",
        systemName: "Building Sanitary",
        connectors: [{
          index: 0,
          connectorId: 1,
          connectorIdBasis: "revit_native_connector_id",
          origin: [100, 0, 30],
          domain: "DomainPiping",
          shape: "Round",
          size: { diameterFt: 1 / 6 },
          coordinateSystem: { basisZ: [-1, 0, 0] },
          physicalConnectionCount: 0
        }]
      }
    ]
  };
  const receipt = planRegisteredRouteConnectorSnapV1(input, { native_connector_readback: readback });
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.action_mode, "create_mep_route");
  assert.equal(receipt.dry_run_action?.path, "/revit/create-mep-route");
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

test("converts an exact sanitary single span into one staged pipe-between-connectors workflow", () => {
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
  const workflow = buildRegisteredRouteSnapStagedWorkflowV1(input, receipt);
  assert.equal(workflow.operations.length, 1);
  assert.equal(workflow.operations[0]?.path, "/revit/create-pipe-between-connectors");
  assert.equal(workflow.operations[0]?.apply_body?.sourceElementId, 101);
  assert.equal(workflow.operations[0]?.apply_body?.targetElementId, 202);
  assert.equal(workflow.operations[0]?.apply_body?.dryRun, undefined);
  assert.equal(workflow.maximumCreatedElements, 1);
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
