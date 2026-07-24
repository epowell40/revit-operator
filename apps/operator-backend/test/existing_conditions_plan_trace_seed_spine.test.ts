import assert from "node:assert/strict";
import test from "node:test";
import type { PlanTraceExtractionReceipt } from "../src/existing_conditions/plan_trace_extraction.js";
import {
  compilePlanTraceSeedSpinesV1,
  sha256PlanTraceExtractionReceiptV1,
  type PlanTraceSeedSpineInputV1
} from "../src/existing_conditions/plan_trace_seed_spine.js";

const sourceHash = "a".repeat(64);
const policyHash = "b".repeat(64);
const evidenceHash = "c".repeat(64);

function receipt(polylines: PlanTraceExtractionReceipt["components"][number]["polylines"]): PlanTraceExtractionReceipt {
  return {
    schema_version: 1,
    source_image_sha256: sourceHash,
    width_px: 100,
    height_px: 100,
    extraction_policy: {
      monochrome_ink: { maximum_luminance: 180, maximum_chroma: 20 },
      minimum_chroma: 40,
      minimum_alpha: 1,
      scope_polygon: null,
      network_scope: {
        mode: "seeded_connected_components",
        seed_points_px: [{ x: 25, y: 0 }],
        seed_basis: "host_trusted_route_seed",
        seed_evidence_sha256: evidenceHash,
        seed_radius_px: 8
      },
      minimum_component_pixels: 10,
      simplify_tolerance_px: 1
    },
    extraction_policy_sha256: policyHash,
    matched_pixel_count: 100,
    retained_pixel_count: 100,
    all_retained_component_count: 2,
    network_scope: {
      mode: "seeded_connected_components",
      seed_points_px: [{ x: 25, y: 0 }],
      seed_basis: "host_trusted_route_seed",
      seed_evidence_sha256: evidenceHash,
      seed_radius_px: 8,
      selected_component_count: 1,
      excluded_component_count: 1
    },
    components: [{
      component_id: "trace-component-001",
      pixel_count: 100,
      skeleton_pixel_count: 10,
      bounds_px: { min: { x: 0, y: 0 }, max: { x: 50, y: 20 } },
      polylines
    }],
    usage_constraints: []
  };
}

function input(source: PlanTraceExtractionReceipt): PlanTraceSeedSpineInputV1 {
  return {
    schema_version: 1,
    source_image_sha256: sourceHash,
    extraction_policy_sha256: policyHash,
    extraction_receipt_sha256: sha256PlanTraceExtractionReceiptV1(source),
    evidence_set_id: "test-network",
    seed_evidence_sha256: evidenceHash,
    seed_basis: "host_trusted_route_seed",
    seed_spans: [{
      span_id: "main",
      start_point_px: { x: 0, y: 0 },
      end_point_px: { x: 50, y: 0 }
    }],
    maximum_snap_distance_px: 4,
    maximum_path_deviation_px: 4,
    maximum_path_length_ratio: 1.25
  };
}

test("unique seed-to-seed shortest path becomes one spine and preserves the branch", () => {
  const source = receipt([
    { points: [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 50, y: 0 }], length_px: 50, closed: false },
    { points: [{ x: 25, y: 0 }, { x: 25, y: 20 }], length_px: 20, closed: false }
  ]);
  const result = compilePlanTraceSeedSpinesV1(input(source), source);
  assert.equal(result.status, "spines_ready");
  assert.equal(result.ready_spines.length, 1);
  assert.deepEqual(result.ready_spines[0]!.points, [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 50, y: 0 }]);
  assert.equal(result.ready_spines[0]!.path_length_ratio, 1);
  assert.deepEqual(result.ready_spines[0]!.source_paths.map(value => value.polyline_index), [0]);
  assert.deepEqual(result.unresolved_source_paths.map(value => value.polyline_index), [1]);
  assert.equal(result.native_write_allowed, false);
  assert.match(result.usage_constraints.join(" "), /unselected source polyline remains explicitly unresolved/i);
});

test("equal shortest paths are deferred instead of choosing one branch", () => {
  const source = receipt([
    { points: [{ x: 0, y: 0 }, { x: 25, y: -10 }, { x: 50, y: 0 }], length_px: 54, closed: false },
    { points: [{ x: 0, y: 0 }, { x: 25, y: 10 }, { x: 50, y: 0 }], length_px: 54, closed: false }
  ]);
  const result = compilePlanTraceSeedSpinesV1(input(source), source);
  assert.equal(result.status, "no_spines_ready");
  assert.equal(result.ready_spines.length, 0);
  assert.equal(result.deferred_spines[0]!.reason, "ambiguous_shortest_path");
  assert.equal(result.unresolved_source_paths.length, 2);
});

test("seed spine compilation rejects stale scope evidence and permissive policy", () => {
  const source = receipt([
    { points: [{ x: 0, y: 0 }, { x: 50, y: 0 }], length_px: 50, closed: false }
  ]);
  assert.throws(
    () => compilePlanTraceSeedSpinesV1({ ...input(source), seed_evidence_sha256: "d".repeat(64) }, source),
    /network_scope_evidence_mismatch/
  );
  assert.throws(
    () => compilePlanTraceSeedSpinesV1({ ...input(source), maximum_path_length_ratio: 5 }, source),
    /policy_too_permissive/
  );
  assert.throws(
    () => compilePlanTraceSeedSpinesV1({ ...input(source), extraction_receipt_sha256: "e".repeat(64) }, source),
    /extraction_receipt_hash_mismatch/
  );
});
