import assert from "node:assert/strict";
import test from "node:test";
import { assertExistingConditionsContract } from "../src/existing_conditions/contract_validation.js";
import {
  resolveArchitecturalOpeningHosts,
  type ArchitecturalOpeningHostResolutionReceipt
} from "../src/existing_conditions/architectural_opening_host_resolution.js";
import { scoreArchitecturalOpeningHostResolution } from "../src/existing_conditions/architectural_opening_host_resolution_score.js";
import type { ArchitecturalOpeningClassificationReceipt } from "../src/existing_conditions/architectural_opening_classification.js";
import type { ArchitecturalWallLineCandidateReceipt } from "../src/existing_conditions/architectural_wall_line_candidates.js";
import type { ExistingConditionsGroundTruth } from "../src/benchmark/existing_conditions_reconstruction.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function candidateReceipt(axis: 0 | 90 = 0): ArchitecturalWallLineCandidateReceipt {
  const horizontal = axis === 0;
  const hostPoints: [{ x: number; y: number }, { x: number; y: number }] = horizontal
    ? [{ x: 0, y: 0 }, { x: 10, y: 0 }]
    : [{ x: 0, y: 0 }, { x: 0, y: 10 }];
  const facePoints = horizontal
    ? [
        [{ x: 0, y: -0.3 }, { x: 10, y: -0.3 }],
        [{ x: 0, y: 0.3 }, { x: 10, y: 0.3 }]
      ]
    : [
        [{ x: -0.3, y: 0 }, { x: -0.3, y: 10 }],
        [{ x: 0.3, y: 0 }, { x: 0.3, y: 10 }]
      ];
  const openingCenter = horizontal ? { x: 5, y: 0 } : { x: 0, y: 5 };
  return {
    schema_version: 1,
    artifact_role: "architectural_wall_line_candidates",
    fixture_id: "fixture-host-resolution",
    scope_id: "scope-host-resolution",
    architectural_delta_receipt_sha256: HASH_A,
    measurement_receipt_sha256: HASH_B,
    source_aligned_sha256: HASH_C,
    candidate_delta_mask_sha256: HASH_D,
    status: "candidates_ready",
    policy: {
      sampling_stride_px: 1,
      angle_step_degrees: 1,
      rho_bin_px: 1,
      support_distance_px: 1,
      maximum_support_gap_px: 1,
      maximum_wall_interruption_ft: 1,
      maximum_source_endpoint_extension_ft: 1,
      maximum_source_endpoint_gap_ft: 1,
      minimum_length_ft: 1,
      maximum_candidates: 8,
      maximum_face_pair_inputs: 8,
      duplicate_angle_tolerance_degrees: 1,
      duplicate_separation_ft: 1,
      face_pair_angle_tolerance_degrees: 1,
      minimum_face_pair_separation_ft: 0.1,
      maximum_face_pair_separation_ft: 2,
      minimum_face_pair_overlap_ratio: 0.5,
      minimum_junction_angle_degrees: 45,
      maximum_junction_angle_degrees: 135,
      maximum_junction_endpoint_gap_ft: 1.25,
      maximum_junction_hypotheses: 8,
      minimum_opening_gap_width_ft: 1,
      maximum_opening_gap_width_ft: 6,
      opening_gap_flank_ft: 0.25,
      opening_gap_maximum_internal_ink_ft: 0.1,
      opening_gap_maximum_ink_ratio: 0.1,
      opening_gap_minimum_flank_coverage: 0.5,
      opening_gap_minimum_profile_ink_coverage: 0.5,
      minimum_opening_host_source_ink_coverage: 0.7,
      opening_gap_axis_snap_tolerance_degrees: 8,
      opening_gap_face_profile_band_ft: 0.1,
      opening_gap_face_profile_sample_count: 5,
      opening_gap_minimum_confirming_profiles: 2,
      opening_gap_support_radius_px: 2,
      opening_gap_group_center_tolerance_ft: 0.5,
      opening_gap_group_width_tolerance_ft: 0.5,
      maximum_opening_gap_hypotheses: 8,
      opening_evidence_minimum_context_ft: 3,
      opening_evidence_width_multiplier: 1.5,
      parallel_angle_tolerance_degrees: 3,
      minimum_parallel_separation_ft: 0.1,
      maximum_parallel_separation_ft: 2,
      minimum_parallel_overlap_ratio: 0.5,
      ambiguity_score_gap: 0.1
    },
    candidates: [
      {
        candidate_id: "host-candidate-randomized",
        rank: 2,
        derivation: "parallel_face_midline",
        pixel_points: hostPoints,
        model_points: hostPoints,
        face_separation_ft: 0.6,
        supporting_face_pixel_points: facePoints as any,
        supporting_face_model_points: facePoints as any,
        angle_degrees: axis,
        length_ft: 10,
        candidate_coverage: 0.9,
        source_ink_coverage: 0.95,
        rank_score: 0.9
      },
      {
        candidate_id: "cross-wall-randomized",
        rank: 4,
        derivation: "parallel_face_midline",
        pixel_points: horizontal ? [{ x: 0, y: 0 }, { x: 0, y: 5 }] : [{ x: 0, y: 0 }, { x: 5, y: 0 }],
        model_points: horizontal ? [{ x: 0, y: 0 }, { x: 0, y: 5 }] : [{ x: 0, y: 0 }, { x: 5, y: 0 }],
        face_separation_ft: 0.6,
        supporting_face_pixel_points: facePoints as any,
        supporting_face_model_points: facePoints as any,
        angle_degrees: horizontal ? 90 : 0,
        length_ft: 5,
        candidate_coverage: 0.8,
        source_ink_coverage: 0.9,
        rank_score: 0.8
      }
    ],
    junction_hypotheses: [{
      junction_id: "junction-randomized",
      rank: 1,
      candidate_ids: ["cross-wall-randomized", "host-candidate-randomized"],
      pixel_point: { x: 0, y: 0 },
      model_point: { x: 0, y: 0 },
      angle_difference_degrees: 90,
      endpoint_distances_ft: [0, 0],
      topology_score: 0.98
    }],
    opening_gap_hypotheses: [{
      opening_hypothesis_id: "opening-randomized",
      rank: 1,
      kind: "unclassified_opening_gap",
      host_candidate_id: "host-candidate-randomized",
      pixel_center: openingCenter,
      model_center: openingCenter,
      width_ft: 3,
      host_chainage_ft: 5,
      host_chainage_ratio: 0.5,
      profile_axis_degrees: axis,
      confirming_profile_count: 5,
      profile_offset_range_ft: [-0.3, 0.3],
      flank_ink_coverage: 1,
      gap_ink_coverage: 0,
      profile_ink_coverage: 0.95,
      evidence_score: 0.95
    }],
    opening_evidence_crops: [{
      opening_hypothesis_id: "opening-randomized",
      host_candidate_id: "host-candidate-randomized",
      crop_bounds_px: { min_x: 0, min_y: 0, max_x: 100, max_y: 100 },
      source_crop: { path: "source.png", sha256: HASH_A, width_px: 100, height_px: 100 },
      evidence_overlay: { path: "overlay.png", sha256: HASH_B, width_px: 100, height_px: 100 }
    }],
    ambiguities: [],
    clarification_question: null,
    overlay: { path: "candidate.png", sha256: HASH_C, width_px: 100, height_px: 100 },
    usage_constraints: []
  };
}

function classification(confidence = 0.95): ArchitecturalOpeningClassificationReceipt {
  return {
    schema_version: 1,
    artifact_role: "architectural_opening_classification",
    fixture_id: "fixture-host-resolution",
    scope_id: "scope-host-resolution",
    candidate_receipt_sha256: HASH_A,
    status: confidence >= 0.85 ? "classified" : "clarification_required",
    classifications: [{
      opening_hypothesis_id: "opening-randomized",
      host_candidate_id: "host-candidate-randomized",
      classification: "door",
      confidence,
      cues: ["swing_arc", "door_leaf"],
      evidence_artifact_sha256s: [HASH_A, HASH_B],
      rationale: "A swing arc and leaf are independently visible.",
      selected_host_candidate_id: null
    }],
    native_write: false
  };
}

function groundTruth(hostKey = "truth-host-wall-randomized"): ExistingConditionsGroundTruth {
  return {
    schema_version: 1,
    fixture_id: "fixture-host-resolution",
    scope_id: "scope-host-resolution",
    snapshot: {
      elements: [
        {
          key: "unrelated-wall-randomized",
          role: "wall",
          endpoints: [{ x: 40, y: 40 }, { x: 50, y: 40 }]
        },
        {
          key: "truth-host-wall-randomized",
          role: "wall",
          endpoints: [{ x: 0.1, y: 0.1 }, { x: 9.9, y: 0.1 }]
        },
        {
          key: "truth-door-randomized",
          role: "door",
          location: { x: 5.1, y: 0.1 },
          host_key: hostKey
        }
      ]
    }
  } as ExistingConditionsGroundTruth;
}

test("resolves a classified opening to a junction-anchored horizontal host without a native write", () => {
  const resolution = resolveArchitecturalOpeningHosts(candidateReceipt(), HASH_A, classification(), HASH_C);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.native_write, false);
  assert.equal(resolution.promotion_allowed, false);
  assert.deepEqual(resolution.resolutions[0]!.refined_host_model_points, [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  assert.equal(resolution.resolutions[0]!.endpoint_evidence[0]!.source, "junction");
  assert.equal(resolution.resolutions[0]!.endpoint_evidence[1]!.source, "supporting_face_extents");
  assertExistingConditionsContract("architectural_opening_host_resolution", resolution);
});

test("resolves a vertical host after axis rotation and does not depend on candidate rank", () => {
  const resolution = resolveArchitecturalOpeningHosts(candidateReceipt(90), HASH_A, classification(), HASH_C);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.resolutions[0]!.axis_degrees, 90);
  assert.deepEqual(resolution.resolutions[0]!.refined_host_model_points, [{ x: 0, y: 0 }, { x: 0, y: 10 }]);
});

test("fails closed when the host participates in an ambiguity or classification confidence is low", () => {
  const ambiguous = candidateReceipt();
  ambiguous.ambiguities.push({
    ambiguity_id: "ambiguity-randomized",
    candidate_ids: ["host-candidate-randomized", "cross-wall-randomized"],
    reason: "near_equal_rank",
    angle_difference_degrees: 0,
    perpendicular_separation_ft: 0.5,
    overlap_ratio: 1,
    score_gap: 0.01
  });
  const ambiguousResolution = resolveArchitecturalOpeningHosts(ambiguous, HASH_A, classification(), HASH_C);
  assert.equal(ambiguousResolution.status, "clarification_required");
  assert.ok(ambiguousResolution.resolutions[0]!.blockers.includes("opening_host_candidate_is_ambiguous"));
  const lowConfidenceResolution = resolveArchitecturalOpeningHosts(candidateReceipt(), HASH_A, classification(0.8), HASH_C);
  assert.equal(lowConfidenceResolution.status, "clarification_required");
  assert.ok(lowConfidenceResolution.resolutions[0]!.blockers.includes("opening_classification_confidence_below_threshold"));
});

test("scores identity-perturbed host geometry and relationship while ignoring unrelated walls", () => {
  const candidates = candidateReceipt();
  const classified = classification();
  const resolution = resolveArchitecturalOpeningHosts(candidates, HASH_A, classified, HASH_C);
  const score = scoreArchitecturalOpeningHostResolution(groundTruth(), candidates, HASH_A, classified, HASH_C, resolution);
  assert.equal(score.passed, true);
  assert.equal(score.counts.truth_host_walls, 1);
  assert.equal(score.counts.matched_host_walls, 1);
  assert.equal(score.counts.matched_openings, 1);
  assert.equal(score.metrics.hosting, 1);
  assert.equal(score.promotion_allowed, false);
});

test("rejects a wrong native host relationship independently of opening location", () => {
  const candidates = candidateReceipt();
  const classified = classification();
  const resolution = resolveArchitecturalOpeningHosts(candidates, HASH_A, classified, HASH_C);
  const score = scoreArchitecturalOpeningHostResolution(
    groundTruth("unrelated-wall-randomized"),
    candidates,
    HASH_A,
    classified,
    HASH_C,
    resolution
  );
  assert.equal(score.passed, false);
  assert.ok(score.failure_classifications.includes("opening_host_relationship_incorrect"));
});

test("rejects host endpoint drift outside tolerance and refuses a hand-edited resolution", () => {
  const candidates = candidateReceipt();
  candidates.candidates[0]!.supporting_face_model_points = [
    [{ x: 0, y: -0.3 }, { x: 8, y: -0.3 }],
    [{ x: 0, y: 0.3 }, { x: 8, y: 0.3 }]
  ];
  const classified = classification();
  const resolution = resolveArchitecturalOpeningHosts(candidates, HASH_A, classified, HASH_C);
  const score = scoreArchitecturalOpeningHostResolution(groundTruth(), candidates, HASH_A, classified, HASH_C, resolution);
  assert.equal(score.passed, false);
  assert.ok(score.failure_classifications.includes("opening_host_wall_missed"));
  const changed = structuredClone(resolution) as ArchitecturalOpeningHostResolutionReceipt;
  changed.resolutions[0]!.refined_host_model_points = [{ x: 2, y: 0 }, { x: 8, y: 0 }];
  assert.throws(
    () => scoreArchitecturalOpeningHostResolution(groundTruth(), candidates, HASH_A, classified, HASH_C, changed),
    /does_not_match_deterministic_evidence/
  );
});
