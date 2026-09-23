import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { registerStructuredExistingConditionsInterpretationV1, summarizeRegisteredStructuredExistingConditionsInterpretationV1 } from "../src/existing_conditions/registered_structured_interpretation.js";
import { createGoal } from "../src/goals/service.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA, markAssignmentKernelOperationDispatchStartedV2, openAssignmentKernelOperationV2, settleAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { OPERATION_RESULT_V2_SCHEMA, canonicalJsonV2, type OperationResultV2 } from "../src/domain/assignment-kernel/index.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";

const binding = { session_id: "session-1", assignment_id: "assignment-1", run_id: "run-1", generation: 1 };
const input = {
  schema_version: 1 as const,
  ...binding,
  interpretation_evidence_id: `ev1_${"a".repeat(32)}`,
  frame_observation_id: "observation-frame-1",
  allow_reflection: true,
  max_rms_error_ft: 0.01,
  max_point_error_ft: 0.01,
  controls: [
    { control_id: "origin", source_page_uv: { u: 0, v: 0 }, candidate_view_uv: { u: 0, v: 0 } },
    { control_id: "east", source_page_uv: { u: 1, v: 0 }, candidate_view_uv: { u: 1, v: 0 } },
    { control_id: "south", source_page_uv: { u: 0, v: 1 }, candidate_view_uv: { u: 0, v: 1 } }
  ]
};

const interpretation = {
  ref: { evidence_id: input.interpretation_evidence_id, content_hash: `sha256:${"b".repeat(64)}` },
  payload: {
    open_questions: ["Duct size is not legible."],
    receipt: {
      schema_version: 1, package_id: "floor-4-east", source_binding_sha256: "c".repeat(64), interpretation_sha256: "d".repeat(64), native_write_allowed: false,
      views: [{ view_key: "detail", source_artifact_sha256: "e".repeat(64), source_page: 4,
        page_geometry: { width_points: 100, height_points: 100, rotation_degrees: 0 } }],
      page_primitives: [{
        primitive_id: "duct-1", source_view_key: "detail", source_artifact_sha256: "e".repeat(64), source_page: 4,
        points: [{ u: 0.2, v: 0.3 }, { u: 0.8, v: 0.3 }],
        endpoints: [{ endpoint_key: "duct-1:start", point: { u: 0.2, v: 0.3 } }, { endpoint_key: "duct-1:end", point: { u: 0.8, v: 0.3 } }]
      }]
    }
  }
} as any;

const frame = {
  frame: { frame_id: "frame-1", view_id: 44, width_px: 1000, height_px: 1000, top_left_xyz: [0, 0, 10] as [number, number, number], top_right_xyz: [100, 0, 10] as [number, number, number], bottom_left_xyz: [0, -100, 10] as [number, number, number], target_level_elevation_ft: 0 },
  operation_id: "operation-frame-1", evidence_id: `ev1_${"f".repeat(32)}`
};

test("source page geometry registers through an authoritative candidate frame with measured residuals", () => {
  const result = registerStructuredExistingConditionsInterpretationV1(input, {
    read_interpretation: actual => { assert.deepEqual(actual, binding); return interpretation; },
    read_frame: actual => { assert.deepEqual(actual, binding); return frame; }
  });

  assert.equal(result.registration.verified, true);
  assert.equal(result.registration.reflection_applied, true);
  assert.ok(result.registration.rms_error_ft < 1e-10);
  assert.equal(result.native_write_allowed, false);
  const points = result.registered_primitives[0]?.model_points ?? [];
  assert.equal(points.length, 2);
  assert.ok(Math.abs(points[0]!.x - 20) < 1e-10 && Math.abs(points[0]!.y + 30) < 1e-10);
  assert.ok(Math.abs(points[1]!.x - 80) < 1e-10 && Math.abs(points[1]!.y + 30) < 1e-10);
  assert.deepEqual(result.open_questions, ["Duct size is not legible."]);
  const summary = summarizeRegisteredStructuredExistingConditionsInterpretationV1(result, {
    evidence_id: `ev1_${"c".repeat(32)}`, content_hash: `sha256:${"d".repeat(64)}`,
    trust_level: "host_observed", verification_relevance: "supporting"
  });
  assert.equal(summary.registered_primitive_count, 1);
  assert.equal("registered_primitives" in summary, false, "the immediate tool reply must not duplicate retained model geometry");
});

test("registration fails closed when reflection is not explicitly allowed", () => {
  assert.throws(
    () => registerStructuredExistingConditionsInterpretationV1({ ...input, allow_reflection: false }, { read_interpretation: () => interpretation, read_frame: () => frame }),
    /existing_conditions_registration_residual_exceeds_limit/
  );
});

test("C59 rejected fit identifies each measured control so a mismatched landmark can be corrected", () => {
  const controls = input.controls.map(control => control.control_id === "south"
    ? { ...control, candidate_view_uv: { u: 0.1, v: 0.9 } } : control);
  assert.throws(
    () => registerStructuredExistingConditionsInterpretationV1({ ...input, controls }, { read_interpretation: () => interpretation, read_frame: () => frame }),
    /existing_conditions_registration_residual_exceeds_limit:rms=[0-9.]+:max=[0-9.]+:controls=origin:[0-9.]+,east:[0-9.]+,south:[0-9.]+/
  );
});

test("C59 four-landmark rejection identifies a verifiable leave-one-out candidate without accepting it", () => {
  const controls = [
    { control_id: "origin", source_page_uv: { u: 0, v: 0 }, candidate_view_uv: { u: 0.1, v: 0.1 } },
    { control_id: "east", source_page_uv: { u: 1, v: 0 }, candidate_view_uv: { u: 1, v: 0 } },
    { control_id: "south", source_page_uv: { u: 0, v: 1 }, candidate_view_uv: { u: 0, v: 1 } },
    { control_id: "southeast", source_page_uv: { u: 1, v: 1 }, candidate_view_uv: { u: 1, v: 1 } }
  ];
  assert.throws(
    () => registerStructuredExistingConditionsInterpretationV1({ ...input, controls }, { read_interpretation: () => interpretation, read_frame: () => frame }),
    /best_leave_one_out=origin:rms=0:max=0/
  );
});

test("C59 installed M104 four-control fit uses the trusted PDF page aspect", () => {
  const liveFrame = { ...frame, frame: { ...frame.frame,
    top_left_xyz: [-123.30115740624503, 71.48585540021631, 32.16666666666667] as [number, number, number],
    top_right_xyz: [89.81093477418699, 71.48585540021631, 32.16666666666667] as [number, number, number],
    bottom_left_xyz: [-123.30115740624503, -47.01832591228737, 32.16666666666667] as [number, number, number]
  } };
  const controls = [
    { control_id: "grid_4_E", source_page_uv: { u: 0.30060945725206994, v: 0.47512243055555553 }, candidate_view_uv: { u: 0.34747515567323783, v: 0.74661213018553 } },
    { control_id: "grid_6_D", source_page_uv: { u: 0.45783904716556884, v: 0.567830763888889 }, candidate_view_uv: { u: 0.5953885086546447, v: 0.5588550421775954 } },
    { control_id: "grid_8_B", source_page_uv: { u: 0.5699333253974552, v: 0.700816875 }, candidate_view_uv: { u: 0.7721343060483283, v: 0.2895255863459825 } },
    { control_id: "grid_7_C", source_page_uv: { u: 0.5183501177155252, v: 0.6374488194444445 }, candidate_view_uv: { u: 0.6907999568052172, v: 0.4178614236547769 } }
  ];
  const source = structuredClone(interpretation);
  source.payload.receipt.views[0].page_geometry = { width_points: 3024.24, height_points: 2160, rotation_degrees: 0 };
  const result = registerStructuredExistingConditionsInterpretationV1({ ...input, controls, max_rms_error_ft: 0.5, max_point_error_ft: 1 },
    { read_interpretation: () => source, read_frame: () => liveFrame });
  assert.equal(result.registration.verified, true);
  assert.ok(result.registration.rms_error_ft < 0.001);
  assert.equal(result.registration.source_coordinate_scale_x, 3024.24 / 2160);
  assert.equal(result.native_write_allowed, false);
});

test("C59 registration rejects absent and inconsistent trusted page geometry", () => {
  const absent = structuredClone(interpretation);
  absent.payload.receipt.views = [];
  assert.throws(() => registerStructuredExistingConditionsInterpretationV1(input,
    { read_interpretation: () => absent, read_frame: () => frame }), /existing_conditions_registration_page_geometry_missing/);
  const inconsistent = structuredClone(interpretation);
  inconsistent.payload.receipt.views.push({ ...inconsistent.payload.receipt.views[0], view_key: "sheet",
    page_geometry: { width_points: 200, height_points: 100, rotation_degrees: 0 } });
  assert.throws(() => registerStructuredExistingConditionsInterpretationV1(input,
    { read_interpretation: () => inconsistent, read_frame: () => frame }), /existing_conditions_registration_page_aspects_inconsistent/);
});

test("registration rejects degenerate source controls before producing model geometry", () => {
  const controls = input.controls.map((control, index) => ({ ...control, source_page_uv: { u: index / 2, v: index / 2 } }));
  assert.throws(
    () => registerStructuredExistingConditionsInterpretationV1({ ...input, controls }, { read_interpretation: () => interpretation, read_frame: () => frame }),
    /registration_source_control_points_must_be_non_collinear/
  );
});

test("default registration reads the exact native frame observation and source-bound interpretation evidence", () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registered-existing-conditions-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "registered-existing-conditions-live-boundary";
    const goal = createGoal({
      title: "Register existing conditions",
      objective: "Register source geometry against the current Revit view without changing the model.",
      acceptance_criteria: ["Registration uses exact retained source and native frame evidence."],
      status: "active",
      related_session_id: sessionId,
      created_by: "registration-test-principal",
      work_budget: { mode: "auto_goal", requested_effect: "read", document_fingerprint: "registration-fixture" }
    });
    createAssignmentKernelForGoalV2({ goal, run_id: `run:${sessionId}` });
    const initialSnapshot = getAssignmentKernelSnapshotV2(goal.id)!;
    const currentBinding = {
      session_id: sessionId,
      assignment_id: initialSnapshot.current_binding.assignment_id,
      run_id: initialSnapshot.current_binding.run_id,
      generation: initialSnapshot.current_binding.generation
    };
    const interpretationStored = storeEvidence({
      scope: { ...currentBinding, attempt_id: "interpretation" },
      source: "existing_conditions_structured_interpretation",
      trust_level: "host_observed",
      verification_relevance: "supporting",
      raw: interpretation.payload
    });
    const nativeFrame = {
      frameId: "frame-retained-1", viewId: 44, widthPx: 1000, heightPx: 1000,
      targetLevel: { id: 99, name: "L4", elevationFt: 10 },
      mapping: {
        mode: "2d_affine", topLeftXyz: [0, 0, 10], topRightXyz: [100, 0, 10], bottomLeftXyz: [0, -100, 10],
        rasterWidthPx: 1000, rasterHeightPx: 1000, modelUnits: "feet"
      }
    };
    const lease = openAssignmentKernelOperationV2({
      snapshot: initialSnapshot,
      controller_request_id: "export-registration-frame",
      provider_turn_id: "registration-test-turn",
      capability_id: "revit_call_tool",
      classified_effect: "read",
      arguments: { method: "POST", path: "/revit/export-view-frame", body: { viewId: 44, imageSize: 1000, includeMapping: true } }
    });
    markAssignmentKernelOperationDispatchStartedV2(lease);
    const rawHash = createHash("sha256").update(canonicalJsonV2(nativeFrame), "utf8").digest("hex");
    const operationResult: OperationResultV2 = {
      schema: OPERATION_RESULT_V2_SCHEMA,
      result_id: `result-${lease.operation_id}`,
      operation_id: lease.operation_id,
      binding: lease.binding,
      status: "succeeded",
      dispatch_state: "dispatched",
      persistent_effect: "none",
      native_transaction_state: "not_applicable",
      authority: "native-host",
      result_schema_id: "operator-native/POST:/revit/export-view-frame/v2",
      observation_required: true,
      raw_payload_hash: rawHash,
      receipt_id: `receipt-${lease.operation_id}`,
      native_correlation_id: `native-${lease.operation_id}`,
      request_identity: lease.request_identity,
      completed_at: "2026-09-19T14:00:00.000Z"
    };
    const settled = settleAssignmentKernelOperationV2(lease, {
      content: [{ type: "text", text: "retained native frame" }],
      structuredContent: {
        schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
        operation_result_v2: operationResult,
        observation: {
          raw_payload: nativeFrame,
          semantic_facts: [{ fact_id: "task.result_available", fact_class: "domain", value: true }],
          verification_relevance: ["task_result"]
        }
      }
    });
    const frameStored = settled.evidence_refs[0]!;
    const snapshot = getAssignmentKernelSnapshotV2(goal.id)!;
    const operation = Object.values(snapshot.operations).find(candidate => candidate.request_identity?.path === "/revit/export-view-frame")!;
    const observationId = operation.observation_ids[0]!;
    const result = registerStructuredExistingConditionsInterpretationV1({
      ...input,
      ...currentBinding,
      interpretation_evidence_id: interpretationStored.ref.evidence_id,
      frame_observation_id: observationId
    });
    assert.equal(result.frame_operation_id, lease.operation_id);
    assert.equal(result.frame_evidence_id, frameStored.evidence_id);
    assert.equal(result.registration.verified, true);
    assert.equal(result.native_write_allowed, false);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
