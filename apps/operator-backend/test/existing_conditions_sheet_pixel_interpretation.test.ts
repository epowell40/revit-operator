import assert from "node:assert/strict";
import test from "node:test";
import {
  compileSheetPixelInterpretationV1,
  type SheetPixelInterpretationContextV1,
  type SheetPixelInterpretationInputV1
} from "../src/existing_conditions/sheet_pixel_interpretation.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function context(): SheetPixelInterpretationContextV1 {
  const sourceView = (viewKey: string, sheetKey: string) => ({
    view_key: viewKey,
    sheet_key: sheetKey,
    source_sha256: HASH_A,
    registration_sha256: HASH_B,
    discipline: "mechanical" as const,
    level_key: "L1",
    phase_key: "EXISTING",
    role: "main_plan" as const,
    resolution_rank: 1,
    registration: { verified: true, rms_residual_ft: 0, maximum_residual_ft: 0, confidence: 0.99 }
  });
  return {
    trusted_views: [
      {
        source_view: sourceView("left", "M-100"),
        frame: { frame_id: "left-frame", view_id: 101, width_px: 1000, height_px: 500, top_left_xyz: [0, 0, 0], top_right_xyz: [100, 0, 0], bottom_left_xyz: [0, -50, 0], target_level_elevation_ft: 0 }
      },
      {
        source_view: sourceView("right", "M-101"),
        frame: { frame_id: "right-frame", view_id: 102, width_px: 1000, height_px: 500, top_left_xyz: [100, 0, 0], top_right_xyz: [200, 0, 0], bottom_left_xyz: [100, -50, 0], target_level_elevation_ft: 0 }
      }
    ],
    calibration_profile: {
      schema_version: 1,
      profile_id: "sealed-blind-v1",
      provenance: { outcomes_sha256: HASH_A, prediction_count: 100, fixture_count: 5, evaluator_receipt_sha256s: [HASH_B], truth_revealed_only_after_seal: true },
      bins: [{ discipline: "mechanical", primitive_kind: "route_segment", raw_confidence_min: 0.9, raw_confidence_max: 1, trials: 100, successes: 100, fixture_count: 5 }]
    }
  };
}

function input(): SheetPixelInterpretationInputV1 {
  const claims = {
    system: { value: "supply air", confidence: 0.99, basis: "legible_source_evidence" as const },
    size: { value: "12 x 8 in", confidence: 0.99, basis: "legible_source_evidence" as const },
    type: { value: "rectangular duct", confidence: 0.99, basis: "approved_project_mapping" as const },
    elevation: { value: "10 ft above level", confidence: 0.99, basis: "approved_project_mapping" as const }
  };
  const confidence = { geometry: 0.99, classification: 0.99, topology: 0.99, visibility: 0.99 };
  return {
    schema_version: 1,
    package_id: "unseen-two-sheet-mechanical",
    coordinate_space: "normalized_uv_top_left",
    view_keys: ["left", "right"],
    source_marks: [
      { source_mark_id: "mark-left", source_view_key: "left", disposition: { status: "candidate", primitive_ids: ["run-left"] } },
      { source_mark_id: "mark-right", source_view_key: "right", disposition: { status: "candidate", primitive_ids: ["run-right"] } }
    ],
    primitives: [
      {
        primitive_id: "run-left",
        source_view_key: "left",
        source_mark_ids: ["mark-left"],
        kind: "route_segment",
        points: [{ u: 0.2, v: 0.5 }, { u: 1, v: 0.5 }],
        endpoints: [
          { endpoint_key: "left:start", point: { u: 0.2, v: 0.5 }, outward_direction_uv: [-1, 0], boundary: "internal" },
          { endpoint_key: "left:end", point: { u: 1, v: 0.5 }, outward_direction_uv: [1, 0], boundary: "sheet_continuation", continuation_key: "RUN-1" }
        ],
        claims,
        confidence
      },
      {
        primitive_id: "run-right",
        source_view_key: "right",
        source_mark_ids: ["mark-right"],
        kind: "route_segment",
        points: [{ u: 0, v: 0.5 }, { u: 0.8, v: 0.5 }],
        endpoints: [
          { endpoint_key: "right:start", point: { u: 0, v: 0.5 }, outward_direction_uv: [-1, 0], boundary: "sheet_continuation", continuation_key: "RUN-1" },
          { endpoint_key: "right:end", point: { u: 0.8, v: 0.5 }, outward_direction_uv: [1, 0], boundary: "internal" }
        ],
        claims,
        confidence
      }
    ]
  };
}

test("normalized sheet observations compile into one cross-sheet model-space run", () => {
  const result = compileSheetPixelInterpretationV1(input(), context());

  assert.equal(result.compiled_topology.status, "ready");
  assert.equal(result.compiled_topology.connections.length, 1);
  assert.equal(result.compiled_topology.connections[0]?.scope, "cross_sheet");
  assert.equal(result.compiled_topology.connections[0]?.status, "accepted");
  assert.equal(result.compiled_topology.native_batch_groups.length, 1);
  assert.deepEqual(result.compiled_topology.native_batch_groups[0]?.primitive_ids, ["run-left", "run-right"]);
});

test("pixel interpretation cannot escape the normalized source frame", () => {
  const invalid = input();
  invalid.primitives[0]!.points[0]!.u = 1.01;
  assert.throws(
    () => compileSheetPixelInterpretationV1(invalid, context()),
    /sheet_pixel_primitive_run-left_point_0_u_must_be_between_zero_and_one/
  );
});

test("only host-registered view keys may enter topology compilation", () => {
  const invalid = input();
  invalid.view_keys = ["left", "provider-invented-view"];
  assert.throws(
    () => compileSheetPixelInterpretationV1(invalid, context()),
    /sheet_pixel_interpretation_unknown_trusted_view:provider-invented-view/
  );
});

test("host-owned raster evidence blocks an overconfident unsupported route", () => {
  const trusted = context();
  trusted.raster_evidence_receipts = [{
    schema_version: 1,
    package_id: "unseen-two-sheet-mechanical",
    source_view_key: "left",
    image: { path: "left.png", sha256: HASH_A, width_px: 1000, height_px: 500 },
    policy: {
      maximum_luminance: 180,
      corridor_radius_px: 7,
      sample_spacing_px: 2,
      accepted_support_fraction: 0.82,
      provisional_support_fraction: 0.55,
      maximum_accepted_unsupported_run_fraction: 0.18
    },
    route_evidence: [{
      primitive_id: "run-left",
      sample_count: 100,
      supported_sample_count: 5,
      support_fraction: 0.05,
      longest_unsupported_run_fraction: 0.95,
      status: "rejected_raster_extent"
    }],
    accepted_primitive_ids: [],
    provisional_primitive_ids: [],
    rejected_primitive_ids: ["run-left"]
  }];

  const result = compileSheetPixelInterpretationV1(input(), trusted);
  const decision = result.compiled_topology.decisions.find(item => item.primitive_id === "run-left");
  assert.equal(decision?.decision, "deferred");
  assert.ok(decision?.reasons.includes("geometry_confidence_below_threshold"));
  assert.ok(result.compiled_topology.warnings.includes("raster_evidence_rejected_raster_extent:run-left"));
});

test("hash-bound candidate receipts compile near-coincident points into an explicit cross-sheet identity", () => {
  const candidateHash = "c".repeat(64);
  const pointInput: SheetPixelInterpretationInputV1 = {
    schema_version: 1,
    package_id: "two-sheet-shared-candidate",
    coordinate_space: "normalized_uv_top_left",
    view_keys: ["sheet-a", "sheet-b"],
    source_marks: [
      { source_mark_id: "mark-a", source_view_key: "sheet-a", disposition: { status: "candidate", primitive_ids: ["point-a"] } },
      { source_mark_id: "mark-b", source_view_key: "sheet-b", disposition: { status: "candidate", primitive_ids: ["point-b"] } }
    ],
    primitives: [
      { primitive_id: "point-a", source_view_key: "sheet-a", source_mark_ids: ["mark-a"], kind: "point_symbol", points: [{ u: 0.2, v: 0.2 }], confidence: { geometry: 0.9, classification: 0.5, topology: 0.5, visibility: 1 } },
      { primitive_id: "point-b", source_view_key: "sheet-b", source_mark_ids: ["mark-b"], kind: "point_symbol", points: [{ u: 0.8, v: 0.2 }], confidence: { geometry: 0.9, classification: 0.5, topology: 0.5, visibility: 1 } }
    ]
  };
  const sourceView = (viewKey: string, sheetKey: string, sourceHash: string) => ({
    view_key: viewKey,
    sheet_key: sheetKey,
    source_sha256: sourceHash,
    registration_sha256: HASH_B,
    discipline: "electrical" as const,
    level_key: "L1",
    phase_key: "EXISTING",
    role: "main_plan" as const,
    resolution_rank: 1,
    registration: { verified: true, rms_residual_ft: 0, maximum_residual_ft: 0, confidence: 0.99 }
  });
  const candidateFrame = { frame_id: "candidate-frame", view_id: 501, width_px: 1000, height_px: 800, top_left_xyz: [0, 0, 0] as [number, number, number], top_right_xyz: [100, 0, 0] as [number, number, number], bottom_left_xyz: [0, -80, 0] as [number, number, number], target_level_elevation_ft: 0 };
  const trusted: SheetPixelInterpretationContextV1 = {
    trusted_views: [
      { source_view: sourceView("sheet-a", "E-100", HASH_A), frame: { ...candidateFrame, frame_id: "source-a", width_px: 400, height_px: 400 } },
      { source_view: sourceView("sheet-b", "E-101", HASH_B), frame: { ...candidateFrame, frame_id: "source-b", width_px: 400, height_px: 400 } }
    ],
    calibration_profile: {
      schema_version: 1,
      profile_id: "point-identity-calibration",
      provenance: { outcomes_sha256: HASH_A, prediction_count: 1, fixture_count: 1, evaluator_receipt_sha256s: [HASH_B], truth_revealed_only_after_seal: true },
      bins: [{ discipline: "electrical", primitive_kind: "point_symbol", raw_confidence_min: 0.4, raw_confidence_max: 0.6, trials: 1, successes: 1, fixture_count: 1 }]
    },
    raster_evidence_receipts: [
      {
        schema_version: 1, package_id: pointInput.package_id, source_view_key: "sheet-a", image: { path: "a.png", sha256: HASH_A, width_px: 400, height_px: 400 }, policy: { maximum_luminance: 180, corridor_radius_px: 7, sample_spacing_px: 2, accepted_support_fraction: 0.82, provisional_support_fraction: 0.55, maximum_accepted_unsupported_run_fraction: 0.18 }, route_evidence: [], point_evidence: [{ primitive_id: "point-a", sampled_pixel_count: 100, supported_pixel_count: 20, chromatic_pixel_count: 20, monochrome_pixel_count: 0, dominant_hue_fraction: 1, status: "accepted_raster_support", support_modality: "chromatic_symbol", coherent_hue_degrees: 225 }], accepted_primitive_ids: ["point-a"], provisional_primitive_ids: [], rejected_primitive_ids: []
      },
      {
        schema_version: 1, package_id: pointInput.package_id, source_view_key: "sheet-b", image: { path: "b.png", sha256: HASH_B, width_px: 400, height_px: 400 }, policy: { maximum_luminance: 180, corridor_radius_px: 7, sample_spacing_px: 2, accepted_support_fraction: 0.82, provisional_support_fraction: 0.55, maximum_accepted_unsupported_run_fraction: 0.18 }, route_evidence: [], point_evidence: [{ primitive_id: "point-b", sampled_pixel_count: 100, supported_pixel_count: 20, chromatic_pixel_count: 20, monochrome_pixel_count: 0, dominant_hue_fraction: 1, status: "accepted_raster_support", support_modality: "chromatic_symbol", coherent_hue_degrees: 225 }], accepted_primitive_ids: ["point-b"], provisional_primitive_ids: [], rejected_primitive_ids: []
      }
    ],
    candidate_raster_by_view: {
      "sheet-a": { image_path: "candidate.png", image_sha256: candidateHash, frame: candidateFrame, point_identity_tolerance_px: 8 },
      "sheet-b": { image_path: "candidate.png", image_sha256: candidateHash, frame: candidateFrame, point_identity_tolerance_px: 8 }
    },
    candidate_presence_receipts: [
      {
        schema_version: 1, package_id: pointInput.package_id, source_view_key: "sheet-a", source_image_sha256: HASH_A, candidate_image: { path: "candidate.png", sha256: candidateHash, width_px: 1000, height_px: 800, frame_id: candidateFrame.frame_id, view_id: candidateFrame.view_id }, policy: { maximum_luminance: 180, corridor_radius_px: 7, sample_spacing_px: 2, accepted_support_fraction: 0.82, provisional_support_fraction: 0.55, maximum_accepted_unsupported_run_fraction: 0.18 }, point_evidence: [{ primitive_id: "point-a", source_status: "accepted_raster_support", candidate_status: "accepted_raster_support", mapped_candidate_uv: { u: 0.4, v: 0.2 }, status: "existing_candidate_visible", supported_pixel_count: 20, coherent_hue_degrees: 225 }], existing_candidate_visible_primitive_ids: ["point-a"], ambiguous_candidate_presence_primitive_ids: [], not_present_primitive_ids: [], source_not_accepted_primitive_ids: []
      },
      {
        schema_version: 1, package_id: pointInput.package_id, source_view_key: "sheet-b", source_image_sha256: HASH_B, candidate_image: { path: "candidate.png", sha256: candidateHash, width_px: 1000, height_px: 800, frame_id: candidateFrame.frame_id, view_id: candidateFrame.view_id }, policy: { maximum_luminance: 180, corridor_radius_px: 7, sample_spacing_px: 2, accepted_support_fraction: 0.82, provisional_support_fraction: 0.55, maximum_accepted_unsupported_run_fraction: 0.18 }, point_evidence: [{ primitive_id: "point-b", source_status: "accepted_raster_support", candidate_status: "accepted_raster_support", mapped_candidate_uv: { u: 0.405, v: 0.202 }, status: "existing_candidate_visible", supported_pixel_count: 20, coherent_hue_degrees: 225 }], existing_candidate_visible_primitive_ids: ["point-b"], ambiguous_candidate_presence_primitive_ids: [], not_present_primitive_ids: [], source_not_accepted_primitive_ids: []
      }
    ]
  };

  const result = compileSheetPixelInterpretationV1(pointInput, trusted);
  assert.equal(result.candidate_identity_groups.length, 1);
  assert.equal(result.candidate_identity_groups[0]?.scope, "cross_sheet");
  assert.deepEqual(result.candidate_identity_groups[0]?.members.map(member => member.primitive_id), ["point-a", "point-b"]);
  assert.ok((result.candidate_identity_groups[0]?.maximum_member_separation_px ?? 99) < 6);
  assert.equal(result.candidate_identity_groups[0]?.native_write_allowed, false);
  assert.ok(result.compiled_topology.warnings.some(value => value.includes("candidate_identity_cross_sheet")));

  trusted.candidate_presence_receipts![1]!.point_evidence[0]!.coherent_hue_degrees = 90;
  const wrongHue = compileSheetPixelInterpretationV1(pointInput, trusted);
  assert.equal(wrongHue.candidate_identity_groups.length, 0, "different coherent hues must not share a candidate identity");
});
