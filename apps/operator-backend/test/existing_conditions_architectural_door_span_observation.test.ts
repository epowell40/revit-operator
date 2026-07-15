import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  buildArchitecturalDoorSpanObservationReceipt,
  type ArchitecturalDoorSpanObservationPackage
} from "../src/existing_conditions/architectural_door_span_observation.js";
import type { ArchitecturalOpeningClassificationReceipt } from "../src/existing_conditions/architectural_opening_classification.js";
import type { ArchitecturalSourceDeltaReceipt } from "../src/existing_conditions/architectural_source_delta.js";
import type { ArchitecturalWallLineCandidateReceipt } from "../src/existing_conditions/architectural_wall_line_candidates.js";
import { assertExistingConditionsContract } from "../src/existing_conditions/contract_validation.js";

const DELTA_HASH = "a".repeat(64);
const CANDIDATE_HASH = "b".repeat(64);
const CLASSIFICATION_HASH = "c".repeat(64);

function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

type FixtureOptions = {
  one_sided_recovery_y?: number;
  missing_start_face?: boolean;
  missing_end_face?: boolean;
};

function writeMask(filePath: string, options: FixtureOptions = {}): void {
  const canvas = createCanvas(200, 200);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 200, 200);
  context.fillStyle = "rgba(230,30,30,0.86)";
  const line = (x: number, y1: number, y2: number) => context.fillRect(x, y1, 1, y2 - y1 + 1);
  if (options.one_sided_recovery_y !== undefined) {
    line(98, 10, 80);
    line(102, 10, 80);
    line(102, 101, 190);
    line(98, options.one_sided_recovery_y, 190);
  } else {
    if (!options.missing_start_face) line(98, 10, 65);
    line(102, 10, 65);
    line(98, 115, 190);
    if (!options.missing_end_face) line(102, 115, 190);
  }
  fs.writeFileSync(filePath, canvas.toBuffer("image/png"));
}

function fixture(t: test.TestContext, options: FixtureOptions = {}): {
  delta: ArchitecturalSourceDeltaReceipt;
  candidates: ArchitecturalWallLineCandidateReceipt;
  classification: ArchitecturalOpeningClassificationReceipt;
  input: ArchitecturalDoorSpanObservationPackage;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-door-span-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const maskPath = path.join(directory, "candidate-mask.png");
  const cropPath = path.join(directory, "source-crop.bin");
  const overlayPath = path.join(directory, "evidence-overlay.bin");
  writeMask(maskPath, options);
  fs.writeFileSync(cropPath, "source-crop-evidence");
  fs.writeFileSync(overlayPath, "overlay-evidence");
  const maskHash = hashFile(maskPath);
  const cropHash = hashFile(cropPath);
  const overlayHash = hashFile(overlayPath);
  const delta = {
    schema_version: 1,
    artifact_role: "architectural_source_redacted_delta",
    fixture_id: "fixture-door-span",
    scope_id: "scope-door-span",
    input_fingerprint_sha256: "d".repeat(64),
    source_render_sha256: "e".repeat(64),
    redacted_model_capture_sha256: "f".repeat(64),
    registration_source_evidence_sha256: "1".repeat(64),
    registration_verified: true,
    scope_model_bounds: { min: { x: 0, y: 0 }, max: { x: 20, y: 20 } },
    output_frame: {
      width_px: 200,
      height_px: 200,
      pixel_to_model_formula: {
        x: "scope.min.x + pixel_x / 200 * (scope.max.x - scope.min.x)",
        y: "scope.max.y - pixel_y / 200 * (scope.max.y - scope.min.y)"
      }
    },
    render_policy: { ink_luminance_threshold: 220, redacted_ink_dilation_px: 3 },
    artifacts: {
      source_aligned: { path: maskPath, sha256: maskHash, width_px: 200, height_px: 200 },
      redacted_aligned: { path: maskPath, sha256: maskHash, width_px: 200, height_px: 200 },
      candidate_delta_mask: { path: maskPath, sha256: maskHash, width_px: 200, height_px: 200 },
      comparison: { path: maskPath, sha256: maskHash, width_px: 200, height_px: 200 }
    },
    usage_constraints: []
  } satisfies ArchitecturalSourceDeltaReceipt;
  const candidates = {
    schema_version: 1,
    artifact_role: "architectural_wall_line_candidates",
    fixture_id: "fixture-door-span",
    scope_id: "scope-door-span",
    architectural_delta_receipt_sha256: DELTA_HASH,
    measurement_receipt_sha256: "2".repeat(64),
    source_aligned_sha256: maskHash,
    candidate_delta_mask_sha256: maskHash,
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
      hough_peak_duplicate_separation_ft: 0.1,
      duplicate_angle_tolerance_degrees: 1,
      duplicate_separation_ft: 1,
      face_pair_angle_tolerance_degrees: 1,
      minimum_face_pair_separation_ft: 0.1,
      maximum_face_pair_separation_ft: 2,
      minimum_face_pair_overlap_ratio: 0.5,
      minimum_face_pair_candidate_coverage: 0.45,
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
      opening_gap_support_radius_px: 1,
      opening_gap_group_center_tolerance_ft: 0.5,
      opening_gap_group_width_tolerance_ft: 0.5,
      maximum_opening_gap_hypotheses: 8,
      minimum_opening_gap_evidence_score: 0.85,
      opening_evidence_minimum_context_ft: 3,
      opening_evidence_width_multiplier: 1.5,
      parallel_angle_tolerance_degrees: 3,
      minimum_parallel_separation_ft: 0.1,
      maximum_parallel_separation_ft: 2,
      minimum_parallel_overlap_ratio: 0.5,
      ambiguity_score_gap: 0.1
    },
    candidates: [{
      candidate_id: "paired-host",
      rank: 1,
      derivation: "parallel_face_midline",
      pixel_points: [{ x: 100, y: 10 }, { x: 100, y: 190 }],
      model_points: [{ x: 10, y: 19 }, { x: 10, y: 1 }],
      face_separation_ft: 0.4,
      supporting_face_pixel_points: [
        [{ x: 98, y: 10 }, { x: 98, y: 190 }],
        [{ x: 102, y: 10 }, { x: 102, y: 190 }]
      ],
      supporting_face_model_points: [
        [{ x: 9.8, y: 19 }, { x: 9.8, y: 1 }],
        [{ x: 10.2, y: 19 }, { x: 10.2, y: 1 }]
      ],
      angle_degrees: 90,
      length_ft: 18,
      candidate_coverage: 0.8,
      source_ink_coverage: 0.9,
      rank_score: 0.9
    }],
    junction_hypotheses: [],
    opening_gap_hypotheses: [{
      opening_hypothesis_id: "partial-gap",
      rank: 1,
      kind: "unclassified_opening_gap",
      host_candidate_id: "paired-host",
      pixel_center: { x: 100, y: 90 },
      model_center: { x: 10, y: 11 },
      width_ft: 2,
      host_chainage_ft: 8,
      host_chainage_ratio: 0.44,
      profile_axis_degrees: 90,
      confirming_profile_count: 5,
      profile_offset_range_ft: [-0.2, 0.2],
      flank_ink_coverage: 1,
      gap_ink_coverage: 0,
      profile_ink_coverage: 0.9,
      evidence_score: 0.95
    }],
    opening_evidence_crops: [{
      opening_hypothesis_id: "partial-gap",
      host_candidate_id: "paired-host",
      crop_bounds_px: { min_x: 40, min_y: 30, max_x: 160, max_y: 150 },
      source_crop: { path: cropPath, sha256: cropHash, width_px: 120, height_px: 120 },
      evidence_overlay: { path: overlayPath, sha256: overlayHash, width_px: 120, height_px: 120 }
    }],
    ambiguities: [],
    clarification_question: null,
    overlay: { path: overlayPath, sha256: overlayHash, width_px: 120, height_px: 120 },
    usage_constraints: []
  } satisfies ArchitecturalWallLineCandidateReceipt;
  const classification = {
    schema_version: 1,
    artifact_role: "architectural_opening_classification",
    fixture_id: "fixture-door-span",
    scope_id: "scope-door-span",
    candidate_receipt_sha256: CANDIDATE_HASH,
    status: "classified",
    classifications: [{
      opening_hypothesis_id: "partial-gap",
      host_candidate_id: "paired-host",
      classification: "door",
      confidence: 0.96,
      cues: ["swing_arc", "door_leaf", "paired_jambs"],
      evidence_artifact_sha256s: [cropHash, overlayHash],
      rationale: "The crop visibly contains a swing arc, leaf, and both jamb transitions.",
      selected_host_candidate_id: null
    }],
    native_write: false
  } satisfies ArchitecturalOpeningClassificationReceipt;
  const pixelEndpoints: [{ x: number; y: number }, { x: number; y: number }] = options.one_sided_recovery_y !== undefined
    ? [{ x: 100, y: 80 }, { x: 100, y: options.one_sided_recovery_y }]
    : [{ x: 100, y: 115 }, { x: 100, y: 65 }];
  const input = {
    schema_version: 1,
    fixture_id: "fixture-door-span",
    scope_id: "scope-door-span",
    architectural_delta_receipt_sha256: DELTA_HASH,
    candidate_receipt_sha256: CANDIDATE_HASH,
    classification_receipt_sha256: CLASSIFICATION_HASH,
    observations: [{
      opening_hypothesis_id: "partial-gap",
      host_candidate_id: "paired-host",
      pixel_endpoints: pixelEndpoints,
      evidence_artifact_sha256s: [cropHash, overlayHash],
      confidence: 0.95,
      rationale: "Both jamb endpoints are visible despite symbol ink through the opening.",
      selected_host_candidate_id: null
    }],
    native_write: false
  } satisfies ArchitecturalDoorSpanObservationPackage;
  return { delta, candidates, classification, input };
}

async function build(data: ReturnType<typeof fixture>) {
  return buildArchitecturalDoorSpanObservationReceipt(
    data.input,
    data.delta,
    DELTA_HASH,
    data.candidates,
    CANDIDATE_HASH,
    data.classification,
    CLASSIFICATION_HASH
  );
}

test("measures a hash-bound full jamb span without selecting a native host or writing", async (t) => {
  const receipt = await build(fixture(t));
  assert.equal(receipt.status, "measured");
  assert.equal(receipt.native_write, false);
  assert.equal(receipt.promotion_allowed, false);
  assert.equal(receipt.observations[0]!.selected_host_candidate_id, null);
  assert.deepEqual(receipt.observations[0]!.pixel_endpoints, [{ x: 100, y: 65 }, { x: 100, y: 115 }]);
  assert.deepEqual(receipt.observations[0]!.model_endpoints, [{ x: 10, y: 13.5 }, { x: 10, y: 8.5 }]);
  assert.equal(receipt.observations[0]!.width_ft, 5);
  assert.equal(receipt.observations[0]!.extension_before_gap_ft, 1.5);
  assert.equal(receipt.observations[0]!.extension_after_gap_ft, 1.5);
  assert.ok(receipt.observations[0]!.endpoint_transitions.every((entry) => entry.passed));
  assertExistingConditionsContract("architectural_door_span_observation", receipt);
});

test("rejects continuous one-sided wall loss at and below the endpoint-extension limit", async (t) => {
  for (const recoveryY of [120, 119]) {
    const receipt = await build(fixture(t, { one_sided_recovery_y: recoveryY }));
    assert.equal(receipt.status, "clarification_required");
    assert.ok(receipt.observations[0]!.endpoint_transitions.every((entry) => entry.passed));
    assert.ok(receipt.observations[0]!.longest_continuous_one_sided_support_ft > 0.75);
    assert.ok(receipt.observations[0]!.blockers.includes("door_span_continuous_one_sided_wall_face_exceeds_policy"));
    assert.equal(receipt.observations[0]!.selected_host_candidate_id, null);
  }
});

test("canonicalizes emitted geometry to the matched jamb transitions", async (t) => {
  const data = fixture(t);
  data.input.observations[0]!.pixel_endpoints = [{ x: 100, y: 64 }, { x: 100, y: 116 }];
  const receipt = await build(data);
  assert.equal(receipt.status, "measured");
  assert.deepEqual(receipt.observations[0]!.pixel_endpoints, [{ x: 100, y: 65 }, { x: 100, y: 115 }]);
  assert.deepEqual(receipt.observations[0]!.model_endpoints, [{ x: 10, y: 13.5 }, { x: 10, y: 8.5 }]);
  assert.equal(receipt.observations[0]!.width_ft, 5);
  assert.deepEqual(receipt.observations[0]!.endpoint_transitions.map((entry) => entry.adjustment_ft), [0.1, 0.1]);
});

test("reports independent start-only and end-only transition failures", async (t) => {
  const missingStart = await build(fixture(t, { missing_start_face: true }));
  assert.ok(missingStart.observations[0]!.blockers.includes("door_span_start_jamb_transition_not_supported"));
  assert.ok(!missingStart.observations[0]!.blockers.includes("door_span_end_jamb_transition_not_supported"));
  const missingEnd = await build(fixture(t, { missing_end_face: true }));
  assert.ok(!missingEnd.observations[0]!.blockers.includes("door_span_start_jamb_transition_not_supported"));
  assert.ok(missingEnd.observations[0]!.blockers.includes("door_span_end_jamb_transition_not_supported"));
});

test("requires independent swing, leaf, and paired-jamb semantic cues", async (t) => {
  const data = fixture(t);
  data.classification.classifications[0]!.cues = ["swing_arc", "door_leaf"];
  const receipt = await build(data);
  assert.equal(receipt.status, "clarification_required");
  assert.ok(receipt.observations[0]!.blockers.includes("door_classification_paired_jambs_cue_required"));
});

test("allows plan-width measurement through host ambiguity without selecting by rank", async (t) => {
  const data = fixture(t);
  data.candidates.candidates.push({
    ...structuredClone(data.candidates.candidates[0]!),
    candidate_id: "alternate-host",
    pixel_points: [{ x: 104, y: 10 }, { x: 104, y: 190 }],
    model_points: [{ x: 10.4, y: 19 }, { x: 10.4, y: 1 }]
  });
  data.candidates.ambiguities.push({
    ambiguity_id: "competing-host",
    candidate_ids: ["paired-host", "alternate-host"],
    reason: "near_equal_rank",
    angle_difference_degrees: 0,
    perpendicular_separation_ft: 0.4,
    overlap_ratio: 1,
    score_gap: 0.01
  });
  const receipt = await build(data);
  assert.equal(receipt.status, "measured");
  assert.equal(receipt.observations[0]!.selected_host_candidate_id, null);
  assert.deepEqual(receipt.observations[0]!.host_ambiguity_ids, ["competing-host"]);
  assert.equal(receipt.promotion_allowed, false);
  assert.ok(receipt.promotion_blockers.includes("native_host_selection_not_authorized"));
});

test("rejects a hand-edited upstream receipt hash before reading geometry", async (t) => {
  const data = fixture(t);
  data.input.architectural_delta_receipt_sha256 = "9".repeat(64);
  await assert.rejects(() => build(data), /delta_receipt_hash_mismatch/);
});

test("rejects candidate, classification, evidence, and consumed-mask hash tampering", async (t) => {
  const candidate = fixture(t);
  candidate.input.candidate_receipt_sha256 = "9".repeat(64);
  await assert.rejects(() => build(candidate), /candidate_receipt_hash_mismatch/);

  const classification = fixture(t);
  classification.input.classification_receipt_sha256 = "9".repeat(64);
  await assert.rejects(() => build(classification), /classification_receipt_hash_mismatch/);

  const evidence = fixture(t);
  evidence.candidates.opening_evidence_crops[0]!.source_crop.sha256 = "9".repeat(64);
  evidence.classification.classifications[0]!.evidence_artifact_sha256s[0] = "9".repeat(64);
  evidence.input.observations[0]!.evidence_artifact_sha256s[0] = "9".repeat(64);
  const evidenceReceipt = await build(evidence);
  assert.ok(evidenceReceipt.observations[0]!.blockers.includes("door_span_observation_evidence_artifacts_invalid"));

  const mask = fixture(t);
  mask.delta.artifacts.candidate_delta_mask.sha256 = "9".repeat(64);
  mask.candidates.candidate_delta_mask_sha256 = "9".repeat(64);
  await assert.rejects(() => build(mask), /candidate_mask_hash_mismatch/);
});

test("rejects a host whose serialized angle contradicts its measured vector", async (t) => {
  const data = fixture(t);
  data.candidates.candidates[0]!.angle_degrees = 0;
  const receipt = await build(data);
  assert.equal(receipt.status, "clarification_required");
  assert.ok(receipt.observations[0]!.blockers.includes("door_span_host_vector_angle_mismatch"));
});

test("schema rejects impossible transition cardinality and status semantics", async (t) => {
  const receipt = await build(fixture(t));
  const oneTransition = structuredClone(receipt);
  oneTransition.observations[0]!.endpoint_transitions = [oneTransition.observations[0]!.endpoint_transitions[0]!] as any;
  assert.throws(() => assertExistingConditionsContract("architectural_door_span_observation", oneTransition));

  const measuredWithBlocker = structuredClone(receipt);
  measuredWithBlocker.observations[0]!.blockers = ["tampered_blocker"];
  assert.throws(() => assertExistingConditionsContract("architectural_door_span_observation", measuredWithBlocker));

  const measuredWithQuestion = structuredClone(receipt);
  measuredWithQuestion.clarification_question = "This cannot coexist with measured status.";
  assert.throws(() => assertExistingConditionsContract("architectural_door_span_observation", measuredWithQuestion));
});
