import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeExactRegisteredStageRequest, expandExactRegisteredStageToolArguments, resolveExactRegisteredStageReference } from "../src/existing_conditions/registered_stage_handoff_http.js";
import {
  buildNextExistingConditionsStagePlan,
  recordExistingConditionsStageResult,
  registerExistingConditionsStagedWorkflow
} from "../src/existing_conditions/staged_repair_ledger.js";
import type { AtomicMepDraftWorkflowRequest } from "../src/existing_conditions/mep_draft_plan.js";

test("registered PDF stage admits only the exact dependency-ready rollback and then exact apply", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registered-stage-handoff-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "registered-stage-handoff-case";
    const workflow: AtomicMepDraftWorkflowRequest = {
      inputFingerprintSha256: "a".repeat(64),
      provisionalObservationIds: ["pdf-main-1"],
      operations: [{
        action_key: "registered-route:pdf-main-1", observation_ids: ["pdf-main-1"],
        path: "/revit/create-mep-route", depends_on: [],
        expected_created_min: 1, expected_created_max: 3,
        apply_body: { kind: "duct", points: [{ x: 1, y: 2, z: 3 }, { x: 9, y: 2, z: 3 }],
          expectedExistingStartOwnerId: 123, requiredExistingEndpoint: "start" }
      }],
      dryRun: true, verify: true, maximumCreatedElements: 3,
      authorizationBasis: "explicit_unscored_user_direction", benchmarkCredit: false
    };
    registerExistingConditionsStagedWorkflow({ sessionId, sourceFrameId: "frame-1",
      sourceViewId: 456, registrationContextId: `ev1_${"x".repeat(32)}`, workflow });
    const first = buildNextExistingConditionsStagePlan({ sessionId, workflow });
    assert.equal(first.state, "dry_run");
    if (first.state !== "dry_run") return;
    assert.equal(authorizeExactRegisteredStageRequest(sessionId, workflow, first.request).state, "dry_run");
    assert.deepEqual(resolveExactRegisteredStageReference(sessionId, workflow, first.stage_key, "dry_run").request, first.request);
    assert.throws(() => resolveExactRegisteredStageReference(sessionId, workflow, first.stage_key, "apply"), /stage_reference_mismatch/);
    assert.throws(() => resolveExactRegisteredStageReference(sessionId, workflow, "other", "dry_run"), /stage_reference_mismatch/);
    assert.throws(() => authorizeExactRegisteredStageRequest(sessionId, workflow,
      { ...first.request, dryRun: false }), /stage_body_mismatch/);
    assert.throws(() => authorizeExactRegisteredStageRequest(sessionId, workflow,
      { ...first.request, operations: [{ ...first.request.operations[0],
        apply_body: { ...first.request.operations[0]!.apply_body, expectedExistingStartOwnerId: 999 } }] }),
      /stage_body_mismatch/);
    const recorded = recordExistingConditionsStageResult({ sessionId, workflow, result: {
      status: "DryRunReady", dryRun: true, rollbackVerified: true,
      residualCreatedElementIds: [], inputFingerprintSha256: workflow.inputFingerprintSha256,
      stageKey: first.stage_key,
      operationOutputs: [{ action_key: "registered-route:pdf-main-1", created_element_ids: [789] }]
    } });
    assert.equal(recorded?.event, "dry_run_accepted");
    const second = buildNextExistingConditionsStagePlan({ sessionId, workflow });
    assert.equal(second.state, "apply");
    if (second.state !== "apply") return;
    assert.equal(authorizeExactRegisteredStageRequest(sessionId, workflow, second.request).state, "apply");
    assert.deepEqual(resolveExactRegisteredStageReference(sessionId, workflow, second.stage_key, "apply").request, second.request);
    assert.throws(() => resolveExactRegisteredStageReference(sessionId, workflow, second.stage_key, "dry_run"), /stage_reference_mismatch/);
    assert.throws(() => authorizeExactRegisteredStageRequest(sessionId, workflow, first.request),
      /stage_body_mismatch/);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("C112 corrected registered route expands to a distinct operation body before admission", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registered-stage-c112-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "c112-corrected-route";
    const binding = { session_id: sessionId, assignment_id: "assignment", run_id: "run", generation: 1 };
    const workflow = (systemType: string): AtomicMepDraftWorkflowRequest => ({
      inputFingerprintSha256: systemType === "ReturnAir" ? "f".repeat(64) : "b".repeat(64),
      provisionalObservationIds: ["m104-return"],
      operations: [{ action_key: "registered-route:return8west", observation_ids: ["m104-return"],
        path: "/revit/create-mep-route", depends_on: [], expected_created_min: 1,
        expected_created_max: 3, apply_body: { kind: "duct", systemType,
          points: [{ x: 1, y: 2, z: 3 }, { x: 9, y: 2, z: 3 }] } }],
      dryRun: true, verify: true, maximumCreatedElements: 3,
      authorizationBasis: "explicit_unscored_user_direction", benchmarkCredit: false
    });
    const oldPlan = workflow("ReturnAir");
    const corrected = workflow("Return Air");
    const sentinel = { registered_stage_key: "operation:registered-route:return8west",
      stage_phase: "dry_run", dryRun: true };
    const args = { method: "POST", path: "/revit/existing-conditions-mep-draft-workflow", body: sentinel };
    const registered = (candidate: AtomicMepDraftWorkflowRequest) => (() => ({
      execution_boundary: "staged_execution", workflow: candidate
    } as any));
    const first = expandExactRegisteredStageToolArguments(args, binding, registered(oldPlan));
    const second = expandExactRegisteredStageToolArguments(args, binding, registered(corrected));
    assert.notDeepEqual(first.body, second.body);
    assert.equal((first.body as any).inputFingerprintSha256, "f".repeat(64));
    assert.equal((second.body as any).inputFingerprintSha256, "b".repeat(64));
    assert.deepEqual(args.body, sentinel);
    assert.throws(() => expandExactRegisteredStageToolArguments({ ...args,
      body: { ...sentinel, dryRun: false } }, binding, registered(corrected)), /reference_invalid/);
    assert.throws(() => expandExactRegisteredStageToolArguments({ ...args,
      body: { ...sentinel, registered_stage_key: "other" } }, binding, registered(corrected)), /reference_mismatch/);
    assert.deepEqual(expandExactRegisteredStageToolArguments({ ...args, body: { dryRun: true } },
      binding, registered(corrected)).body, { dryRun: true });
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
