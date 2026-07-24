import assert from "node:assert/strict";
import test from "node:test";
import type { PlanTraceExtractionReceipt } from "../src/existing_conditions/plan_trace_extraction.js";
import {
  resolvePlanTraceContinuationAnchorV1,
  type PlanTraceContinuationAnchorRepairInputV1
} from "../src/existing_conditions/plan_trace_continuation_anchor_repair.js";
import { sha256PlanTraceExtractionReceiptV1 } from "../src/existing_conditions/plan_trace_seed_spine.js";

const SOURCE_HASH = "a".repeat(64);
const EVIDENCE_HASH = "b".repeat(64);

function receipt(): PlanTraceExtractionReceipt {
  return {
    schema_version: 1,
    source_image_sha256: SOURCE_HASH,
    width_px: 200,
    height_px: 400,
    extraction_policy: {
      target_rgb: { r: 0, g: 255, b: 0 },
      maximum_color_distance: 80,
      minimum_chroma: 40,
      minimum_alpha: 1,
      scope_polygon: null,
      minimum_component_pixels: 3,
      simplify_tolerance_px: 1
    },
    extraction_policy_sha256: "c".repeat(64),
    matched_pixel_count: 50,
    retained_pixel_count: 50,
    components: [
      {
        component_id: "marker",
        pixel_count: 10,
        skeleton_pixel_count: 10,
        bounds_px: { min: { x: 96, y: 96 }, max: { x: 104, y: 104 } },
        polylines: [{ points: [{ x: 96, y: 100 }, { x: 100, y: 104 }, { x: 104, y: 100 }], length_px: 11.3, closed: false }]
      },
      {
        component_id: "route-near",
        pixel_count: 30,
        skeleton_pixel_count: 30,
        bounds_px: { min: { x: 105, y: 80 }, max: { x: 150, y: 80 } },
        polylines: [{ points: [{ x: 105, y: 80 }, { x: 150, y: 80 }], length_px: 45, closed: false }]
      },
      {
        component_id: "route-far",
        pixel_count: 30,
        skeleton_pixel_count: 30,
        bounds_px: { min: { x: 140, y: 130 }, max: { x: 180, y: 130 } },
        polylines: [{ points: [{ x: 140, y: 130 }, { x: 180, y: 130 }], length_px: 40, closed: false }]
      }
    ],
    usage_constraints: []
  };
}

function input(value: PlanTraceExtractionReceipt): PlanTraceContinuationAnchorRepairInputV1 {
  return {
    schema_version: 1,
    source_image_sha256: SOURCE_HASH,
    source_image_width_px: 200,
    source_image_height_px: 400,
    extraction_receipt_sha256: sha256PlanTraceExtractionReceiptV1(value),
    continuation_anchor: {
      anchor_id: "riser-6-l4",
      point_px: { x: 100, y: 100 },
      evidence_sha256: EVIDENCE_HASH
    },
    policy: {
      minimum_route_polyline_length_px: 10,
      maximum_attachment_distance_px: 30,
      minimum_ambiguity_gap_px: 3,
      marker_component_exclusion_radius_px: 8
    }
  };
}

test("resolves a trusted point continuation to the uniquely nearest non-marker source trace without authorizing writes", () => {
  const source = receipt();
  const result = resolvePlanTraceContinuationAnchorV1(input(source), source);
  assert.equal(result.status, "source_route_attachment_resolved");
  assert.equal(result.selected_candidate?.component_id, "route-near");
  assert.deepEqual(result.selected_candidate?.attachment_point_px, { x: 105, y: 80 });
  assert.equal(result.native_write_allowed, false);
  assert.equal(result.exact_next_action, "read_native_frontiers_at_source_route_attachment_point");
});

test("defers when two source traces are geometrically ambiguous", () => {
  const source = receipt();
  source.components[2]!.polylines[0] = { points: [{ x: 95, y: 120 }, { x: 140, y: 120 }], length_px: 45, closed: false };
  const result = resolvePlanTraceContinuationAnchorV1({
    ...input(source),
    policy: { ...input(source).policy, minimum_ambiguity_gap_px: 2 }
  }, source);
  assert.equal(result.status, "deferred");
  assert.equal(result.selected_candidate, null);
  assert.deepEqual(result.blockers, ["source_route_attachment_ambiguous"]);
});

test("rejects receipt drift before resolving an attachment", () => {
  const source = receipt();
  const bad = input(source);
  bad.extraction_receipt_sha256 = "d".repeat(64);
  assert.throws(() => resolvePlanTraceContinuationAnchorV1(bad, source), /extraction_receipt_hash_mismatch/);
});

test("defers a uniquely nearest trace outside the bounded attachment distance", () => {
  const source = receipt();
  const value = input(source);
  value.policy = { ...value.policy, maximum_attachment_distance_px: 10 };
  const result = resolvePlanTraceContinuationAnchorV1(value, source);
  assert.equal(result.status, "deferred");
  assert.deepEqual(result.blockers, ["source_route_attachment_too_far"]);
});
