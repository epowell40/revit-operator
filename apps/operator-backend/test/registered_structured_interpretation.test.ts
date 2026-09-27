import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { registerStructuredExistingConditionsInterpretationV1 as registerNative, summarizeRegisteredStructuredExistingConditionsInterpretationV1 } from "../src/existing_conditions/registered_structured_interpretation.js";
import { createGoal } from "../src/goals/service.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA, markAssignmentKernelOperationDispatchStartedV2, openAssignmentKernelOperationV2, settleAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { OPERATION_RESULT_V2_SCHEMA, canonicalJsonV2, type OperationResultV2 } from "../src/domain/assignment-kernel/index.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { nativeGridAxes } from "../src/existing_conditions/native_grid_landmarks.js";

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
    interpretation: {
      schema_version: 1, package_id: "floor-4-east", coordinate_space: "normalized_uv_top_left", view_keys: ["detail"],
      source_marks: [{ source_mark_id: "mark-1", source_view_key: "detail", disposition: { status: "candidate", primitive_ids: ["duct-1"] } },
        { source_mark_id: "mark-2", source_view_key: "detail", disposition: { status: "unresolved", reason: "Symbol is illegible." } }],
      primitives: [{ primitive_id: "duct-1", source_view_key: "detail", source_mark_ids: ["mark-1"], kind: "route_segment",
        points: [{ u: 0.2, v: 0.3 }, { u: 0.8, v: 0.3 }],
        endpoints: [
          { endpoint_key: "duct-1:start", point: { u: 0.2, v: 0.3 }, outward_direction_uv: [-1, 0], boundary: "sheet_continuation", continuation_key: "west-run", continuation_kind: "same_level_run" },
          { endpoint_key: "duct-1:end", point: { u: 0.8, v: 0.3 }, outward_direction_uv: [1, 0], boundary: "internal" }
        ],
        claims: { system: { value: "Supply Air", confidence: 0.6, basis: "provider_hypothesis" }, size: { value: "unknown", confidence: 0, basis: "unresolved" } },
        confidence: { geometry: 0.95, classification: 0.8, topology: 0.7, visibility: 0.9 }
      }]
    },
    receipt: {
      schema_version: 1, package_id: "floor-4-east", source_binding_sha256: "c".repeat(64), interpretation_sha256: "d".repeat(64), native_write_allowed: false,
      views: [{ view_key: "detail", source_artifact_sha256: "e".repeat(64), source_page: 4,
        local_to_page_uv: { u_offset: 0, v_offset: 0, u_scale: 1, v_scale: 1 },
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

// Synthetic landmarks keep the older geometry tests focused on their own boundary.
// The C60 cases below use fixed native axes so a flipped candidate cannot rewrite truth.
function registerStructuredExistingConditionsInterpretationV1(value: any, dependencies: any = {}) {
  const selectedFrame = (dependencies.read_frame?.(binding, value.frame_observation_id) ?? frame).frame;
  const axes = value.controls.flatMap((control: any, index: number) => {
    const p = control.candidate_view_uv;
    const x = selectedFrame.top_left_xyz[0] + p.u * (selectedFrame.top_right_xyz[0] - selectedFrame.top_left_xyz[0]) + p.v * (selectedFrame.bottom_left_xyz[0] - selectedFrame.top_left_xyz[0]);
    const y = selectedFrame.top_left_xyz[1] + p.u * (selectedFrame.top_right_xyz[1] - selectedFrame.top_left_xyz[1]) + p.v * (selectedFrame.bottom_left_xyz[1] - selectedFrame.top_left_xyz[1]);
    return [{ element_id: 1000 + index * 2, name: `X${index}`, start: { x, y: y - 100 }, end: { x, y: y + 100 } },
      { element_id: 1001 + index * 2, name: `Y${index}`, start: { x: x - 100, y }, end: { x: x + 100, y } }];
  });
  return registerNative({ ...value, landmark_observation_id: "observation-landmark-1",
    controls: value.controls.map((control: any, index: number) => ({ ...control, native_grid_element_ids: [1000 + index * 2, 1001 + index * 2] })) },
  { ...dependencies, read_landmarks: () => ({ frame: selectedFrame, axes, operation_id: "operation-landmark-1", evidence_id: `ev1_${"1".repeat(32)}` }) });
}

test("C60 exact failed r3 inverted PDF fit is rejected against native grid axes; true reflection fits", () => {
  const liveFrame = { ...frame, frame: { ...frame.frame,
    view_id: 1363433,
    top_left_xyz: [-123.3697818177457, 71.48585540021631, 32.16666666666667] as [number, number, number],
    top_right_xyz: [89.87955918568767, 71.48585540021631, 32.16666666666667] as [number, number, number],
    bottom_left_xyz: [-123.3697818177457, -47.01832591228737, 32.16666666666667] as [number, number, number]
  } };
  const horizontal = (elementId: number, name: string, y: number) => ({ elementId, name, sourceScopedId: `host:${elementId}`, categoryToken: "OST_Grids", geometry: { kind: "curve", isStraight: true,
    start: { model: { x: -115, y, z: 32 } }, end: { model: { x: 78, y, z: 32 } } } });
  const vertical = (elementId: number, name: string, x: number) => ({ elementId, name, sourceScopedId: `host:${elementId}`, categoryToken: "OST_Grids", geometry: { kind: "curve", isStraight: true,
    start: { model: { x, y: -31, z: 32 } }, end: { model: { x, y: 49, z: 32 } } } });
  const axes = nativeGridAxes({ items: [horizontal(1363058, "E", 41.45833333333327), horizontal(1363059, "D", 19.208333333333286),
    horizontal(1363060, "C", 2.4999999999992135), horizontal(1363061, "A", -27.541666666667446), horizontal(1363062, "B", -12.70833333333412),
    vertical(1363063, "4", -49.24999999999976), vertical(1363064, "5", -20.24999999999977),
    vertical(1363065, "6", 3.5833333333335653), vertical(1363066, "8", 41.25000000000024)] });
  const landmarks = { frame: liveFrame.frame, axes, operation_id: "native-visible-r3", evidence_id: `ev1_${"2".repeat(32)}` };
  const controls = [
    ["grid_4_E", 0.30060945725206994, 0.47512243055555553, 0.34757332176962086, 0.25338786981447003, 1363063, 1363058],
    ["grid_5_D", 0.38691213660291507, 0.567830763888889, 0.4835643633528775, 0.4411449578224046, 1363064, 1363059],
    ["grid_6_C", 0.45783904716556884, 0.6374488194444445, 0.5953271159184276, 0.5821385763452231, 1363065, 1363060],
    ["grid_8_B", 0.5699333253974552, 0.700816875, 0.7719591584346117, 0.7104744136540175, 1363066, 1363062],
    ["grid_4_A", 0.30060945725206994, 0.7626224236111111, 0.34757332176962086, 0.8356458056593072, 1363063, 1363061]
  ] as const;
  const nativeControls = controls.map(([control_id, su, sv, u, v, xId, yId]) => ({ control_id, source_page_uv: { u: su, v: sv },
    candidate_view_uv: { u, v }, native_grid_element_ids: [xId, yId] as [number, number] }));
  const source = structuredClone(interpretation);
  source.payload.receipt.views[0].page_geometry = { width_points: 3024.24, height_points: 2160, rotation_degrees: 0 };
  const deps = { read_interpretation: () => source, read_frame: () => liveFrame, read_landmarks: () => landmarks };
  const liveInput = { ...input, landmark_observation_id: "native-visible-r3", controls: nativeControls,
    allow_reflection: true, max_rms_error_ft: 0.5, max_point_error_ft: 1 };
  const accepted = registerNative(liveInput, deps);
  assert.equal(accepted.registration.verified, true);
  assert.equal(accepted.registration.reflection_applied, true);
  assert.ok(accepted.registration.rms_error_ft < 0.001);
  assert.throws(() => registerNative({ ...liveInput, allow_reflection: false, controls: nativeControls.map(control => ({ ...control,
    candidate_view_uv: { u: control.candidate_view_uv.u, v: 1 - control.candidate_view_uv.v } })) }, deps),
    /candidate_disagrees_with_native_grids/);
  assert.throws(() => registerNative({ ...liveInput, controls: nativeControls.map(control => ({ ...control,
    native_grid_element_ids: [999999, control.native_grid_element_ids[1]] as [number, number] })) }, deps),
    /native_grid_missing_or_ambiguous/);
  assert.throws(() => registerNative(liveInput, { ...deps, read_landmarks: () => ({ ...landmarks, frame: { ...landmarks.frame, view_id: 99 } }) }),
    /landmark_frame_mismatch/);
});

test("source page geometry registers through an authoritative candidate frame with measured residuals", () => {
  const result = registerStructuredExistingConditionsInterpretationV1(input, {
    read_interpretation: (actual: unknown) => { assert.deepEqual(actual, binding); return interpretation; },
    read_frame: (actual: unknown) => { assert.deepEqual(actual, binding); return frame; }
  });

  assert.equal(result.registration.verified, true);
  assert.equal(result.registration.reflection_applied, true);
  assert.ok(result.registration.rms_error_ft < 1e-10);
  assert.equal(result.native_write_allowed, false);
  const points = result.registered_primitives[0]?.model_points ?? [];
  assert.equal(points.length, 2);
  assert.ok(Math.abs(points[0]!.x - 20) < 1e-10 && Math.abs(points[0]!.y + 30) < 1e-10);
  assert.ok(Math.abs(points[1]!.x - 80) < 1e-10 && Math.abs(points[1]!.y + 30) < 1e-10);
  assert.equal(result.package_id, "floor-4-east");
  assert.equal(result.native_view_id, 44);
  assert.deepEqual(result.source_marks.map(mark => [mark.source_mark_id, mark.disposition.status]), [["mark-1", "candidate"], ["mark-2", "unresolved"]]);
  assert.equal(result.registered_primitives[0]?.kind, "route_segment");
  assert.deepEqual(result.registered_primitives[0]?.source_mark_ids, ["mark-1"]);
  assert.equal(result.registered_primitives[0]?.claims?.size?.basis, "unresolved");
  assert.equal(result.registered_primitives[0]?.claims?.system?.basis, "provider_hypothesis");
  assert.equal(result.registered_primitives[0]?.model_endpoints[0]?.boundary, "sheet_continuation");
  assert.equal(result.registered_primitives[0]?.model_endpoints[0]?.continuation_key, "west-run");
  assert.ok(Math.abs(result.registered_primitives[0]!.model_endpoints[0]!.outward_direction_xy[0] + 1) < 1e-10);
  assert.deepEqual(result.open_questions, ["Duct size is not legible."]);
  const summary = summarizeRegisteredStructuredExistingConditionsInterpretationV1(result, {
    evidence_id: `ev1_${"c".repeat(32)}`, content_hash: `sha256:${"d".repeat(64)}`,
    trust_level: "host_observed", verification_relevance: "supporting"
  });
  assert.equal(summary.registered_primitive_count, 1);
  assert.equal("registered_primitives" in summary, false, "the immediate tool reply must not duplicate retained model geometry");
});

test("registration rejects missing source meaning instead of publishing geometry-only drafting input", () => {
  const missing = structuredClone(interpretation);
  delete missing.payload.interpretation;
  assert.throws(() => registerStructuredExistingConditionsInterpretationV1(input,
    { read_interpretation: () => missing, read_frame: () => frame }), /existing_conditions_registration_source_semantics_missing/);
  const mismatched = structuredClone(interpretation);
  mismatched.payload.interpretation.primitives[0].primitive_id = "different-duct";
  assert.throws(() => registerStructuredExistingConditionsInterpretationV1(input,
    { read_interpretation: () => mismatched, read_frame: () => frame }), /existing_conditions_registration_primitive_semantics_mismatch/);
});

test("registration fails closed when reflection is not explicitly allowed", () => {
  assert.throws(
    () => registerStructuredExistingConditionsInterpretationV1({ ...input, allow_reflection: false }, { read_interpretation: () => interpretation, read_frame: () => frame }),
    /existing_conditions_registration_residual_exceeds_limit:.*reflection_fit_available:retry_with_allowReflection_true_after_visual_orientation_check/
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
    const gridLease = openAssignmentKernelOperationV2({
      snapshot: getAssignmentKernelSnapshotV2(goal.id)!, controller_request_id: "export-registration-grids",
      provider_turn_id: "registration-test-turn", capability_id: "revit_call_tool", classified_effect: "read",
      arguments: { method: "POST", path: "/revit/export-visible-elements", body: { viewId: 44, categories: ["OST_Grids"], includeGeometry: true } }
    });
    markAssignmentKernelOperationDispatchStartedV2(gridLease);
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
    const gridItem = (elementId: number, name: string, ax: number, ay: number, bx: number, by: number) => ({
      elementId, name, sourceScopedId: `host:${elementId}`, categoryToken: "OST_Grids",
      geometry: { kind: "curve", isStraight: true, start: { model: { x: ax, y: ay, z: 10 } }, end: { model: { x: bx, y: by, z: 10 } } }
    });
    const nativeLandmarks = { ...nativeFrame, frameId: "frame-retained-2", items: [
      gridItem(101, "west", 0, -100, 0, 0), gridItem(102, "east", 100, -100, 100, 0),
      gridItem(201, "north", 0, 0, 100, 0), gridItem(202, "south", 0, -100, 100, -100)
    ] };
    const gridResult: OperationResultV2 = {
      ...operationResult, result_id: `result-${gridLease.operation_id}`, operation_id: gridLease.operation_id, binding: gridLease.binding,
      result_schema_id: "operator-native/POST:/revit/export-visible-elements/v2",
      raw_payload_hash: createHash("sha256").update(canonicalJsonV2(nativeLandmarks), "utf8").digest("hex"),
      receipt_id: `receipt-${gridLease.operation_id}`, native_correlation_id: `native-${gridLease.operation_id}`,
      request_identity: gridLease.request_identity
    };
    const gridSettled = settleAssignmentKernelOperationV2(gridLease, {
      content: [{ type: "text", text: "retained native grids" }],
      structuredContent: { schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA, operation_result_v2: gridResult,
        observation: { raw_payload: nativeLandmarks, semantic_facts: [{ fact_id: "task.result_available", fact_class: "domain", value: true }], verification_relevance: ["task_result"] } }
    });
    const snapshot = getAssignmentKernelSnapshotV2(goal.id)!;
    const operation = Object.values(snapshot.operations).find(candidate => candidate.request_identity?.path === "/revit/export-view-frame")!;
    const observationId = operation.observation_ids[0]!;
    const gridOperation = Object.values(snapshot.operations).find(candidate => candidate.request_identity?.path === "/revit/export-visible-elements")!;
    const gridObservationId = gridOperation.observation_ids[0]!;
    const result = registerNative({
      ...input,
      ...currentBinding,
      interpretation_evidence_id: interpretationStored.ref.evidence_id,
      frame_observation_id: observationId,
      landmark_observation_id: gridObservationId,
      controls: [
        { ...input.controls[0]!, native_grid_element_ids: [101, 201] },
        { ...input.controls[1]!, native_grid_element_ids: [102, 201] },
        { ...input.controls[2]!, native_grid_element_ids: [101, 202] }
      ]
    });
    assert.equal(result.frame_operation_id, lease.operation_id);
    assert.equal(result.frame_evidence_id, frameStored.evidence_id);
    assert.equal(result.landmark_evidence_id, gridSettled.evidence_refs[0]!.evidence_id);
    assert.equal(result.registration.verified, true);
    assert.equal(result.native_write_allowed, false);
    assert.throws(() => registerNative({ ...input, ...currentBinding,
      interpretation_evidence_id: interpretationStored.ref.evidence_id, frame_observation_id: observationId,
      landmark_observation_id: observationId, controls: result.registration ? [
        { ...input.controls[0]!, native_grid_element_ids: [101, 201] },
        { ...input.controls[1]!, native_grid_element_ids: [102, 201] },
        { ...input.controls[2]!, native_grid_element_ids: [101, 202] }
      ] : [] }), /landmark_operation_invalid/);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
