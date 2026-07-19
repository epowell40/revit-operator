import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AtomicMepDraftWorkflowRequest } from "../src/existing_conditions/mep_draft_plan.js";
import {
  buildNextExistingConditionsStagePlan,
  existingConditionsRepairLedgerPath,
  readExistingConditionsRepairLedger,
  recordExistingConditionsStageResult,
  registerExistingConditionsRepairAction,
  registerExistingConditionsStagedWorkflow
} from "../src/existing_conditions/staged_repair_ledger.js";

function workflow(): AtomicMepDraftWorkflowRequest {
  return {
    inputFingerprintSha256: "a".repeat(64),
    provisionalObservationIds: ["route-1", "connection-1"],
    operations: [
      {
        action_key: "route:route-1",
        observation_ids: ["route-1"],
        path: "/revit/mep-route-workflow",
        depends_on: [],
        expected_created_min: 1,
        expected_created_max: 3,
        apply_body: { kind: "pipe", apply: true }
      },
      {
        action_key: "connect:route-fixture",
        observation_ids: ["connection-1"],
        path: "/revit/connect-mep-elements",
        depends_on: ["route:route-1"],
        expected_created_min: 0,
        expected_created_max: 1,
        deferred_body: {
          source_element: {
            created_by_action: "route:route-1",
            output: "route_end"
          },
          target_elements: [{
            created_by_action: "route:route-1",
            output: "route_start"
          }]
        }
      }
    ],
    dryRun: true,
    verify: true,
    maximumCreatedElements: 10,
    benchmarkCredit: false,
    authorizationBasis: "explicit_unscored_user_direction"
  };
}

test("staged repair ledger preserves accepted progress and resumes through a smaller repair", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-staged-repair-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "staged-repair-session";
    const registered = workflow();
    registerExistingConditionsStagedWorkflow({
      sessionId,
      sourceFrameId: "frame-1",
      sourceViewId: 3960410,
      registrationContextId: "registration-1",
      workflow: registered
    });

    const routeDryRun = buildNextExistingConditionsStagePlan({
      sessionId,
      workflow: registered
    });
    assert.equal(routeDryRun.state, "dry_run");
    if (routeDryRun.state !== "dry_run") return;
    assert.equal(routeDryRun.request.operations.length, 1);
    assert.equal(routeDryRun.action_key, "route:route-1");
    assert.deepEqual(routeDryRun.request.priorActionOutputs, []);

    recordExistingConditionsStageResult({
      sessionId,
      workflow: registered,
      result: {
        inputFingerprintSha256: registered.inputFingerprintSha256,
        stageKey: routeDryRun.stage_key,
        status: "DryRunReady",
        dryRun: true,
        rollbackVerified: true,
        residualCreatedElementIds: [],
        transientCreatedElementIds: [101, 102],
        operationOutputs: [{
          action_key: "route:route-1",
          created_element_ids: [101, 102],
          route_start_element_ids: [101],
          route_end_element_ids: [102]
        }]
      }
    });

    const routeApply = buildNextExistingConditionsStagePlan({
      sessionId,
      workflow: registered
    });
    assert.equal(routeApply.state, "apply");
    if (routeApply.state !== "apply") return;
    assert.equal(routeApply.stage_key, routeDryRun.stage_key);
    assert.equal(routeApply.request.dryRun, false);

    recordExistingConditionsStageResult({
      sessionId,
      workflow: registered,
      result: {
        inputFingerprintSha256: registered.inputFingerprintSha256,
        stageKey: routeApply.stage_key,
        status: "Applied",
        dryRun: false,
        atomic: true,
        createdElementIds: [201, 202],
        operationOutputs: [{
          action_key: "route:route-1",
          created_element_ids: [201, 202],
          route_start_element_ids: [201],
          route_end_element_ids: [202]
        }]
      }
    });

    const connectDryRun = buildNextExistingConditionsStagePlan({
      sessionId,
      workflow: registered
    });
    assert.equal(connectDryRun.state, "dry_run");
    if (connectDryRun.state !== "dry_run") return;
    assert.equal(connectDryRun.action_key, "connect:route-fixture");
    assert.deepEqual(connectDryRun.request.priorActionOutputs, [{
      action_key: "route:route-1",
      created_element_ids: [201, 202],
      route_segment_element_ids: [],
      route_start_element_ids: [201],
      route_end_element_ids: [202],
      split_main_start_element_ids: [],
      split_main_end_element_ids: []
    }]);

    recordExistingConditionsStageResult({
      sessionId,
      workflow: registered,
      result: {
        inputFingerprintSha256: registered.inputFingerprintSha256,
        stageKey: connectDryRun.stage_key,
        status: "Blocked",
        dryRun: true,
        rollbackVerified: true,
        residualCreatedElementIds: [],
        error: "connector_tolerance_mismatch",
        failedOperation: {
          actionKey: "connect:route-fixture"
        }
      }
    });
    const blocked = buildNextExistingConditionsStagePlan({
      sessionId,
      workflow: registered
    });
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.accepted_action_outputs.length, 1);

    assert.throws(() => registerExistingConditionsRepairAction({
      sessionId,
      workflow: registered,
      supersedesStageKey: connectDryRun.stage_key,
      repairStageKey: "repair:wrong-action:v1",
      operation: {
        ...registered.operations[0]!,
        action_key: "route:route-1"
      },
      reason: "This repair must be rejected because it changes the action identity."
    }), /action_key_mismatch/);

    registerExistingConditionsRepairAction({
      sessionId,
      workflow: registered,
      supersedesStageKey: connectDryRun.stage_key,
      repairStageKey: "repair:connect-route-fixture:v1",
      operation: {
        ...registered.operations[1]!,
        action_key: "connect:route-fixture",
        apply_body: { toleranceFt: 1.0 }
      },
      reason: "Use a source-grounded connector tolerance repair."
    });
    const repairDryRun = buildNextExistingConditionsStagePlan({
      sessionId,
      workflow: registered
    });
    assert.equal(repairDryRun.state, "dry_run");
    if (repairDryRun.state !== "dry_run") return;
    assert.equal(repairDryRun.stage_key, "repair:connect-route-fixture:v1");

    recordExistingConditionsStageResult({
      sessionId,
      workflow: registered,
      result: {
        inputFingerprintSha256: registered.inputFingerprintSha256,
        stageKey: repairDryRun.stage_key,
        status: "DryRunReady",
        dryRun: true,
        rollbackVerified: true,
        residualCreatedElementIds: [],
        operationOutputs: [{
          action_key: "connect:route-fixture",
          created_element_ids: []
        }]
      }
    });
    const repairApply = buildNextExistingConditionsStagePlan({
      sessionId,
      workflow: registered
    });
    assert.equal(repairApply.state, "apply");
    if (repairApply.state !== "apply") return;
    recordExistingConditionsStageResult({
      sessionId,
      workflow: registered,
      result: {
        inputFingerprintSha256: registered.inputFingerprintSha256,
        stageKey: repairApply.stage_key,
        status: "Applied",
        dryRun: false,
        atomic: true,
        createdElementIds: [],
        operationOutputs: [{
          action_key: "connect:route-fixture",
          created_element_ids: []
        }]
      }
    });

    const done = buildNextExistingConditionsStagePlan({
      sessionId,
      workflow: registered
    });
    assert.equal(done.state, "awaiting_readback");
    assert.deepEqual(
      done.accepted_action_outputs.map(value => value.action_key).sort(),
      ["connect:route-fixture", "route:route-1"]
    );

    const entries = readExistingConditionsRepairLedger(sessionId);
    assert.ok(entries.length >= 10);
    assert.deepEqual(
      entries.map(entry => entry.sequence),
      entries.map((_, index) => index + 1)
    );

    fs.appendFileSync(
      existingConditionsRepairLedgerPath(sessionId),
      `${JSON.stringify({ schema_version: 1, sequence: 999 })}\n`,
      "utf8"
    );
    assert.throws(
      () => readExistingConditionsRepairLedger(sessionId),
      /invalid_chain_line/
    );
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});
