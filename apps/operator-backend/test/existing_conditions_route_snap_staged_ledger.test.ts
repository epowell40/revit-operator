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
