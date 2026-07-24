import assert from "node:assert/strict";
import test from "node:test";
import type { PlanTraceSeedSpineReceiptV1 } from "../src/existing_conditions/plan_trace_seed_spine.js";
import {
  normalizePlanTraceSeedSpinesV1,
  sha256PlanTraceSeedSpineReceiptV1,
  type PlanTraceSpineNormalizationInputV1
} from "../src/existing_conditions/plan_trace_spine_normalization.js";

const sourceHash = "a".repeat(64);

function receipt(points: Array<{ x: number; y: number }>): PlanTraceSeedSpineReceiptV1 {
  const rawLength = points.slice(0, -1).reduce((sum, value, index) => (
    sum + Math.hypot(points[index + 1]!.x - value.x, points[index + 1]!.y - value.y)
  ), 0);
  return {
    schema_version: 1,
    source_image_sha256: sourceHash,
    extraction_policy_sha256: "b".repeat(64),
    extraction_receipt_sha256: "c".repeat(64),
    evidence_set_id: "test-network",
    seed_evidence_sha256: "d".repeat(64),
    spine_contract_sha256: "e".repeat(64),
    ready_spines: [{
      span_id: "test-span",
      status: "source_spine_ready",
      seed_start_point_px: { x: 0, y: 0 },
      seed_end_point_px: { x: 20, y: 0 },
      snapped_start_point_px: points[0]!,
      snapped_end_point_px: points[points.length - 1]!,
      start_snap_distance_px: 0,
      end_snap_distance_px: 0,
      points,
      length_px: rawLength,
      seed_chord_px: 20,
      path_length_ratio: rawLength / 20,
      maximum_path_deviation_px: Math.max(...points.map(value => Math.abs(value.y))),
      source_paths: [{ evidence_set_id: "test-network", component_id: "trace-component-001", polyline_index: 0 }]
    }],
    deferred_spines: [],
    used_source_paths: [{ evidence_set_id: "test-network", component_id: "trace-component-001", polyline_index: 0 }],
    unresolved_source_paths: [{ evidence_set_id: "test-network", component_id: "trace-component-001", polyline_index: 1 }],
    status: "spines_ready",
    native_write_allowed: false,
    usage_constraints: []
  };
}

function input(source: PlanTraceSeedSpineReceiptV1): PlanTraceSpineNormalizationInputV1 {
  return {
    schema_version: 1,
    source_image_sha256: sourceHash,
    evidence_set_id: "test-network",
    spine_receipt_sha256: sha256PlanTraceSeedSpineReceiptV1(source),
    straight_projection_maximum_deviation_px: 3,
    simplify_tolerance_px: 2,
    maximum_endpoint_shift_px: 3
  };
}

test("small raster zigzags collapse to the host-trusted straight seed axis", () => {
  const source = receipt([{ x: -2, y: 1 }, { x: 10, y: -1 }, { x: 22, y: 1 }]);
  const result = normalizePlanTraceSeedSpinesV1(input(source), source);
  assert.equal(result.status, "normalized_spines_ready");
  assert.equal(result.normalized_spines[0]!.strategy, "straight_seed_axis_projection");
  assert.deepEqual(result.normalized_spines[0]!.points, [{ x: 0, y: 0 }, { x: 20, y: 0 }]);
  assert.ok(result.normalized_spines[0]!.maximum_raw_to_normalized_deviation_px < 3);
  assert.equal(result.unresolved_source_paths.length, 1);
  assert.equal(result.native_write_allowed, false);
});

test("a source-visible bend survives bounded simplification", () => {
  const source = receipt([{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: 0 }]);
  const result = normalizePlanTraceSeedSpinesV1(input(source), source);
  assert.equal(result.normalized_spines[0]!.strategy, "bounded_polyline_simplification");
  assert.deepEqual(result.normalized_spines[0]!.points, [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: 0 }]);
});

test("normalization rejects stale spine receipts and permissive policy", () => {
  const source = receipt([{ x: 0, y: 0 }, { x: 20, y: 0 }]);
  assert.throws(
    () => normalizePlanTraceSeedSpinesV1({ ...input(source), spine_receipt_sha256: "f".repeat(64) }, source),
    /spine_receipt_hash_mismatch/
  );
  assert.throws(
    () => normalizePlanTraceSeedSpinesV1({ ...input(source), simplify_tolerance_px: 11 }, source),
    /policy_too_permissive/
  );
});
