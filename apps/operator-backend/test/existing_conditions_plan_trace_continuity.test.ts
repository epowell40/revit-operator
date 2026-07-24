import assert from "node:assert/strict";
import test from "node:test";
import type { PlanTraceExtractionReceipt } from "../src/existing_conditions/plan_trace_extraction.js";
import {
  validateDashedTraceContinuityV1,
  type DashedTraceContinuityInputV1
} from "../src/existing_conditions/plan_trace_continuity.js";

const SOURCE_HASH = "a".repeat(64);
const POLICY_HASH = "b".repeat(64);

function receipt(): PlanTraceExtractionReceipt {
  return {
    schema_version: 1,
    source_image_sha256: SOURCE_HASH,
    width_px: 160,
    height_px: 80,
    extraction_policy: {
      target_rgb: { r: 255, g: 0, b: 0 },
      maximum_color_distance: 20,
      minimum_chroma: 100,
      minimum_alpha: 240,
      scope_polygon: null,
      minimum_component_pixels: 5,
      simplify_tolerance_px: 1
    },
    extraction_policy_sha256: POLICY_HASH,
    matched_pixel_count: 90,
    retained_pixel_count: 90,
    components: [0, 1, 2, 3].map((index) => ({
      component_id: `trace-component-00${index + 1}`,
      pixel_count: 20,
      skeleton_pixel_count: 20,
      bounds_px: { min: { x: 10 + index * 35, y: 39 }, max: { x: 30 + index * 35, y: 41 } },
      polylines: [{
        points: [{ x: 10 + index * 35, y: 40 }, { x: 30 + index * 35, y: 40 }],
        length_px: 20,
        closed: false
      }]
    })),
    usage_constraints: []
  };
}

function input(): DashedTraceContinuityInputV1 {
  return {
    schema_version: 1,
    source_image_sha256: SOURCE_HASH,
    evidence_set_id: "red-ink",
    extraction_policy_sha256: POLICY_HASH,
    source_paths: [0, 1, 2, 3].map((index) => ({
      evidence_set_id: "red-ink",
      component_id: `trace-component-00${index + 1}`,
      polyline_index: 0
    })),
    maximum_gap_px: 16,
    maximum_lateral_deviation_px: 2,
    maximum_direction_deviation_degrees: 3
  };
}

test("orders a regular collinear dashed run without granting continuity or native-write authority", () => {
  const result = validateDashedTraceContinuityV1(input(), receipt());
  assert.equal(result.status, "continuity_hypothesis_ready");
  assert.equal(result.native_write_allowed, false);
  assert.deepEqual(result.start_point, { x: 10, y: 40 });
  assert.deepEqual(result.end_point, { x: 135, y: 40 });
  assert.deepEqual(result.gap_lengths_px, [15, 15, 15]);
  assert.equal(result.visible_fraction, 80 / 125);
  assert.match(result.usage_constraints.join(" "), /line-style mapping.*continuous modeled route/i);
});

test("fails closed for a missing dash, lateral drift, or wrong direction", () => {
  const gap = receipt();
  gap.components[2]!.polylines[0]!.points = [{ x: 100, y: 40 }, { x: 120, y: 40 }];
  assert.throws(() => validateDashedTraceContinuityV1(input(), gap), /gap_exceeded|overlap_or_touch/);

  const lateral = receipt();
  lateral.components[2]!.polylines[0]!.points = [{ x: 80, y: 48 }, { x: 100, y: 48 }];
  assert.throws(() => validateDashedTraceContinuityV1(input(), lateral), /lateral_deviation_exceeded/);

  const direction = receipt();
  direction.components[2]!.polylines[0]!.points = [{ x: 80, y: 40 }, { x: 80, y: 60 }];
  assert.throws(() => validateDashedTraceContinuityV1(input(), direction), /direction_mismatch/);
});

test("requires three unique source segments from one exact evidence set", () => {
  const tooFew = input();
  tooFew.source_paths = tooFew.source_paths.slice(0, 2);
  assert.throws(() => validateDashedTraceContinuityV1(tooFew, receipt()), /at_least_three_segments/);

  const duplicate = input();
  duplicate.source_paths[3] = duplicate.source_paths[0]!;
  assert.throws(() => validateDashedTraceContinuityV1(duplicate, receipt()), /duplicate_path/);

  const wrongEvidence = input();
  wrongEvidence.source_paths[0]!.evidence_set_id = "other-ink";
  assert.throws(() => validateDashedTraceContinuityV1(wrongEvidence, receipt()), /evidence_set_mismatch/);
});
