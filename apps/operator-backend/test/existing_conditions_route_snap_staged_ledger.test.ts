import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRegisteredRouteSnapStagedWorkflowV1,
  planRegisteredRouteConnectorSnapV1,
  type RegisteredRouteSnapCandidateV1
} from "../src/existing_conditions/registered_route_connector_snap.js";
import {
  buildNextExistingConditionsStagePlan,
  readExistingConditionsRepairLedger,
  recordExistingConditionsStageResult,
  registerExistingConditionsStagedWorkflow
} from "../src/existing_conditions/staged_repair_ledger.js";

const candidate: RegisteredRouteSnapCandidateV1 = {
  schema_version: 1,
  package_id: "fixture-sheet-1",
  primitive_id: "route-1",
  source_interpretation_sha256: "a".repeat(64),
  registration_receipt_sha256: "b".repeat(64),
  raster_evidence_receipt_sha256: "c".repeat(64),
  kind: "duct",
  points: [{ x: 10.1, y: 20.1 }, { x: 15.15, y: 20.1 }],
  view_id: 303,
  level_name: "Level 1",
  elevation_z_ft: 30,
  system_type: "Supply Air",
  route_type_name: "Round Duct",
  route_type_id: 404,
  shape: "round",
  size: "8 inch"
};

const connectorReadback = {
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
        connectorId: 2,
        connectorIdBasis: "revit_native_connector_id",
        origin: [15, 20, 30],
        domain: "DomainHvac",
        shape: "Round",
        size: { diameterFt: 2 / 3 },
        coordinateSystem: { basisZ: [-1, 0, 0] },
        physicalConnectionCount: 0
      }]
    }
  ]
};

test("registered connector snap enters the ledger as one dry-run then one apply", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-route-snap-ledger-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const receipt = planRegisteredRouteConnectorSnapV1(candidate, {
      native_connector_readback: connectorReadback
    });
    const workflow = buildRegisteredRouteSnapStagedWorkflowV1(candidate, receipt);
    const sessionId = "registered-route-snap-session";
    registerExistingConditionsStagedWorkflow({
      sessionId,
      sourceFrameId: "frame-1",
      sourceViewId: 303,
      registrationContextId: "registration-1",
      workflow
    });
    const dryRun = buildNextExistingConditionsStagePlan({ sessionId, workflow });
    assert.equal(dryRun.state, "dry_run");
    if (dryRun.state !== "dry_run") return;
    assert.equal(dryRun.request.operations.length, 1);
    assert.equal(dryRun.request.operations[0]?.path, "/revit/create-mep-route");
    assert.equal(dryRun.request.dryRun, true);
    recordExistingConditionsStageResult({
      sessionId,
      workflow,
      result: {
        inputFingerprintSha256: workflow.inputFingerprintSha256,
        stageKey: dryRun.stage_key,
        status: "DryRunReady",
        dryRun: true,
        rollbackVerified: true,
        residualCreatedElementIds: [],
        transientCreatedElementIds: [501],
        operationOutputs: [{
          action_key: dryRun.action_key,
          created_element_ids: [501],
          route_segment_element_ids: [501],
          route_start_element_ids: [501],
          route_end_element_ids: [501]
        }]
      }
    });
    const apply = buildNextExistingConditionsStagePlan({ sessionId, workflow });
    assert.equal(apply.state, "apply");
    if (apply.state !== "apply") return;
    assert.equal(apply.request.dryRun, false);
    assert.equal(apply.stage_key, dryRun.stage_key);
    const ledger = readExistingConditionsRepairLedger(sessionId);
    assert.deepEqual(ledger.map(entry => entry.event), [
      "workflow_registered",
      "stage_registered",
      "dry_run_accepted"
    ]);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("C160 aligned two-point continuation retains the exact tangent in the staged native request", { concurrency: false }, () => {
  const priorRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-c160-snap-ledger-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const points = [{ x: -33.04930087045224, y: 18.839397083343584 },
      { x: -33.04930087045224, y: 38.917316367126475 }];
    const input: RegisteredRouteSnapCandidateV1 = { ...candidate, package_id: "unit404_supply", primitive_id: "sa404north",
      points, view_id: 1363433, level_name: "L4", elevation_z_ft: 40.168061023622045,
      system_type: "Supply Air", size: '8"', required_existing_endpoint: "start",
      registration_evidence_id: `ev1_${"d".repeat(32)}`, deferred_far_end_reason: "Open source-visible far end" };
    const registered = { schema_version: 1, native_write_allowed: false, package_id: input.package_id,
      native_view_id: input.view_id, registration: { verified: true, source_evidence_sha256: input.source_interpretation_sha256 },
      registered_primitives: [{ primitive_id: input.primitive_id, source_mark_ids: ["west8"],
        kind: "route_segment", model_points: points, model_endpoints: [
          { endpoint_key: "near", point: points[0], boundary: "internal", outward_direction_xy: [0, -1] },
          { endpoint_key: "far", point: points[1], boundary: "internal", outward_direction_xy: [0, 1] }
        ] }] };
    const readback = { results: [{ id: 1543517, category: "OST_DuctCurves",
      systemName: "Mechanical Supply Air 3", connectors: [{ index: 0, connectorId: 1,
        connectorIdBasis: "revit_native_connector_id", origin: [-33.04125698584549, 18.843627103430237, input.elevation_z_ft],
        domain: "DomainHvac", systemClassification: "SupplyAir", shape: "Round", size: { diameterFt: 2 / 3 },
        coordinateSystem: { basisZ: [0.005064325985840811, 0.9999871762189299, 0] }, physicalConnectionCount: 0 }] }] };
    const receipt = planRegisteredRouteConnectorSnapV1(input, { native_connector_readback: readback,
      registered_interpretation: registered as any, registered_interpretation_sha256: input.registration_receipt_sha256 });
    const workflow = buildRegisteredRouteSnapStagedWorkflowV1(input, receipt);
    const sessionId = "c160-stage";
    registerExistingConditionsStagedWorkflow({ sessionId, sourceFrameId: "M104", sourceViewId: input.view_id,
      registrationContextId: "c160-registration", workflow });
    const stage = buildNextExistingConditionsStagePlan({ sessionId, workflow });
    assert.equal(stage.state, "dry_run");
    if (stage.state !== "dry_run") return;
    const route = stage.request.operations[0]?.apply_body as { points: Array<{ x: number; y: number }>; expectedExistingStartOwnerId: number };
    assert.ok(route, JSON.stringify(stage.request.operations[0]));
    assert.equal(route.expectedExistingStartOwnerId, 1543517);
    assert.ok(Math.abs((route.points[1]!.x - route.points[0]!.x) / (route.points[1]!.y - route.points[0]!.y)
      - 0.005064325985840811 / 0.9999871762189299) < 1e-8);
    assert.equal(stage.request.dryRun, true);
  } finally {
    if (priorRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = priorRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
