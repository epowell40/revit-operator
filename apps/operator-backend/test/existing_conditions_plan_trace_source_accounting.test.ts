import assert from "node:assert/strict";
import test from "node:test";
import type { PlanTraceExtractionReceipt } from "../src/existing_conditions/plan_trace_extraction.js";
import {
  validatePlanTraceSourceAccountingV1,
  type PlanTraceSourceAccountingInputV1
} from "../src/existing_conditions/plan_trace_source_accounting.js";

const SOURCE_HASH = "a".repeat(64);
const POLICY_HASH = "b".repeat(64);

function receipt(): PlanTraceExtractionReceipt {
  return {
    schema_version: 1,
    source_image_sha256: SOURCE_HASH,
    width_px: 200,
    height_px: 120,
    extraction_policy: {
      target_rgb: { r: 20, g: 180, b: 70 },
      maximum_color_distance: 20,
      minimum_chroma: 80,
      minimum_alpha: 240,
      scope_polygon: null,
      minimum_component_pixels: 8,
      simplify_tolerance_px: 1
    },
    extraction_policy_sha256: POLICY_HASH,
    matched_pixel_count: 50,
    retained_pixel_count: 50,
    components: [
      {
        component_id: "trace-component-001",
        pixel_count: 30,
        skeleton_pixel_count: 11,
        bounds_px: { min: { x: 10, y: 20 }, max: { x: 60, y: 20 } },
        polylines: [{ points: [{ x: 10, y: 20 }, { x: 60, y: 20 }], length_px: 50, closed: false }]
      },
      {
        component_id: "trace-component-002",
        pixel_count: 20,
        skeleton_pixel_count: 8,
        bounds_px: { min: { x: 80, y: 20 }, max: { x: 115, y: 20 } },
        polylines: [{ points: [{ x: 80, y: 20 }, { x: 115, y: 20 }], length_px: 35, closed: false }]
      }
    ],
    usage_constraints: []
  };
}

function input(): PlanTraceSourceAccountingInputV1 {
  return {
    schema_version: 1,
    scope_id: "synthetic-room-alpha",
    source_image_sha256: SOURCE_HASH,
    coordinate_space: "registered_render_pixels_top_left",
    evidence_sets: [{ evidence_set_id: "green-ink", extraction_policy_sha256: POLICY_HASH }],
    candidates: [
      {
        candidate_id: "dashed-route-alpha",
        discipline: "plumbing",
        source_paths: [
          { evidence_set_id: "green-ink", component_id: "trace-component-001", polyline_index: 0 },
          { evidence_set_id: "green-ink", component_id: "trace-component-002", polyline_index: 0 }
        ],
        geometry_role: "route_centerline",
        continuity: "disconnected_dashes",
        disposition: { status: "promoted", normalized_kind: "route_trace" }
      }
    ]
  };
}

function context(value = receipt()) {
  return { evidence_sets: [{ evidence_set_id: "green-ink", receipt: value }] };
}

test("normalizes fully accounted trace paths without inventing dashed continuity or write authority", () => {
  const first = validatePlanTraceSourceAccountingV1(input(), context());
  const second = validatePlanTraceSourceAccountingV1(input(), context());
  assert.equal(first.status, "normalized");
  assert.equal(first.native_write_allowed, false);
  assert.equal(first.accounted_path_count, 2);
  assert.deepEqual(first.disconnected_dash_candidate_ids, ["dashed-route-alpha"]);
  assert.equal(first.source_contract_sha256, second.source_contract_sha256);
  assert.equal(first.source_geometry_sha256, second.source_geometry_sha256);
  assert.equal(first.draft_candidate_fingerprint_sha256, second.draft_candidate_fingerprint_sha256);
  assert.equal(first.draft_candidates.length, 1);
  assert.deepEqual(first.draft_candidates[0]?.source_paths.map((path) => path.points), [
    [{ x: 10, y: 20 }, { x: 60, y: 20 }],
    [{ x: 80, y: 20 }, { x: 115, y: 20 }]
  ]);
  assert.equal(first.draft_candidates[0]?.continuity, "disconnected_dashes");
  assert.equal(first.draft_candidates[0]?.native_write_allowed, false);
  assert.equal(first.promotion_follow_up_items[0]?.blocks_provisional_plan_draft, false);
  assert.deepEqual(first.promotion_follow_up_items[0]?.unresolved_attributes, [
    "service classification",
    "size",
    "type",
    "elevation",
    "native connectivity",
    "continuity across source gaps"
  ]);
  assert.match(first.promotion_follow_up_items[0]?.question ?? "", /label, line pattern, legend, or focused clarification/i);
  assert.match(first.usage_constraints.join(" "), /continuity across gaps is not inferred/i);
});

test("requires every extracted path to be explicitly accounted and forbids duplicate accounting", () => {
  const missing = input();
  missing.candidates[0]!.source_paths.pop();
  assert.throws(() => validatePlanTraceSourceAccountingV1(missing, context()), /paths_unaccounted/);

  const repeated = input();
  repeated.candidates.push({
    ...repeated.candidates[0]!,
    candidate_id: "duplicate-route-beta",
    source_paths: [repeated.candidates[0]!.source_paths[0]!]
  });
  assert.throws(() => validatePlanTraceSourceAccountingV1(repeated, context()), /path_accounted_multiple_times/);
});

test("rejects paired duct outlines as native centerlines", () => {
  const outlined = input();
  outlined.candidates[0]!.geometry_role = "outlined_network_boundary";
  outlined.candidates[0]!.continuity = "not_applicable";
  assert.throws(() => validatePlanTraceSourceAccountingV1(outlined, context()), /only_centerlines_may_be_promoted/);
});

test("preserves callout-only and unresolved source paths without an ignored bucket", () => {
  const value = input();
  value.candidates = [
    {
      candidate_id: "callout-alpha",
      discipline: "plumbing",
      source_paths: [{ evidence_set_id: "green-ink", component_id: "trace-component-001", polyline_index: 0 }],
      geometry_role: "callout_leader",
      continuity: "not_applicable",
      disposition: { status: "callout_only", note: "Leader geometry annotates a nearby route but is not the route." }
    },
    {
      candidate_id: "mixed-alpha",
      discipline: "plumbing",
      source_paths: [{ evidence_set_id: "green-ink", component_id: "trace-component-002", polyline_index: 0 }],
      geometry_role: "unknown",
      continuity: "not_applicable",
      disposition: { status: "unresolved", reason: "mixed_symbol_and_route", note: "The source mark cannot yet be split safely." }
    }
  ];
  const result = validatePlanTraceSourceAccountingV1(value, context());
  assert.equal(result.status, "clarification_required");
  assert.deepEqual(result.callout_only_candidate_ids, ["callout-alpha"]);
  assert.deepEqual(result.unresolved_candidate_ids, ["mixed-alpha"]);
  assert.equal(result.draft_candidates.length, 0);
  assert.equal(result.preserved_unresolved_candidates[0]?.candidate_id, "mixed-alpha");
  assert.deepEqual(result.preserved_unresolved_candidates[0]?.source_paths[0]?.points, [
    { x: 80, y: 20 },
    { x: 115, y: 20 }
  ]);
  assert.equal(result.preserved_unresolved_candidates[0]?.native_write_allowed, false);
  assert.equal(result.preserved_unresolved_candidates[0]?.reason, "mixed_symbol_and_route");
  assert.equal(result.promotion_follow_up_items[0]?.candidate_id, "mixed-alpha");
  assert.equal(result.promotion_follow_up_items[0]?.blocks_provisional_plan_draft, true);
  assert.equal(result.promotion_follow_up_items[0]?.source_geometry_status, "preserved_unresolved");
});

test("junction candidates remain non-writing and may reference only promoted route candidates", () => {
  const value = input();
  value.candidates = [
    {
      ...value.candidates[0]!,
      candidate_id: "route-alpha",
      source_paths: [value.candidates[0]!.source_paths[0]!],
      continuity: "observed_contiguous"
    },
    {
      ...value.candidates[0]!,
      candidate_id: "route-beta",
      source_paths: [value.candidates[0]!.source_paths[1]!],
      continuity: "observed_contiguous"
    }
  ];
  value.junction_candidates = [{
    junction_id: "junction-alpha",
    point: { x: 70, y: 20 },
    incident_candidate_ids: ["route-alpha", "route-beta"],
    connectivity: "candidate_only"
  }];
  const result = validatePlanTraceSourceAccountingV1(value, context());
  assert.deepEqual(result.junction_candidate_ids, ["junction-alpha"]);
  assert.match(result.usage_constraints.join(" "), /do not authorize snapping/i);

  value.junction_candidates[0]!.connectivity = "native_connected" as "candidate_only";
  assert.throws(() => validatePlanTraceSourceAccountingV1(value, context()), /connectivity_must_be_candidate_only/);
});

test("rejects identical geometry extracted into overlapping evidence sets", () => {
  const secondReceipt = structuredClone(receipt());
  secondReceipt.extraction_policy_sha256 = "c".repeat(64);
  const value = input();
  value.evidence_sets.push({ evidence_set_id: "overlapping-ink", extraction_policy_sha256: secondReceipt.extraction_policy_sha256 });
  assert.throws(
    () => validatePlanTraceSourceAccountingV1(value, {
      evidence_sets: [
        { evidence_set_id: "green-ink", receipt: receipt() },
        { evidence_set_id: "overlapping-ink", receipt: secondReceipt }
      ]
    }),
    /duplicate_geometry/
  );
});

test("draft candidate fingerprints bind exact source geometry without relying on color", () => {
  const monochromeReceipt = structuredClone(receipt());
  monochromeReceipt.extraction_policy = {
    monochrome_ink: { maximum_luminance: 110, maximum_chroma: 10 },
    minimum_chroma: 0,
    minimum_alpha: 240,
    scope_polygon: null,
    minimum_component_pixels: 8,
    simplify_tolerance_px: 1
  };
  monochromeReceipt.extraction_policy_sha256 = "c".repeat(64);
  const monochromeInput = input();
  monochromeInput.evidence_sets[0]!.extraction_policy_sha256 = monochromeReceipt.extraction_policy_sha256;
  const monochrome = validatePlanTraceSourceAccountingV1(monochromeInput, context(monochromeReceipt));
  assert.deepEqual(monochrome.draft_candidates[0]?.source_paths.map((path) => path.points), [
    [{ x: 10, y: 20 }, { x: 60, y: 20 }],
    [{ x: 80, y: 20 }, { x: 115, y: 20 }]
  ]);

  const shiftedReceipt = structuredClone(monochromeReceipt);
  shiftedReceipt.components[0]!.polylines[0]!.points[1]!.x = 61;
  shiftedReceipt.components[0]!.polylines[0]!.length_px = 51;
  const shifted = validatePlanTraceSourceAccountingV1(monochromeInput, context(shiftedReceipt));
  assert.notEqual(monochrome.source_geometry_sha256, shifted.source_geometry_sha256);
  assert.notEqual(monochrome.draft_candidate_fingerprint_sha256, shifted.draft_candidate_fingerprint_sha256);

  const widerReceipt = structuredClone(monochromeReceipt);
  widerReceipt.width_px += 1;
  const wider = validatePlanTraceSourceAccountingV1(monochromeInput, context(widerReceipt));
  assert.notEqual(monochrome.source_geometry_sha256, wider.source_geometry_sha256);
  assert.notEqual(monochrome.draft_candidate_fingerprint_sha256, wider.draft_candidate_fingerprint_sha256);
});

test("draft candidates reject malformed or colliding extraction geometry before fingerprinting", () => {
  const nonfinite = receipt();
  nonfinite.components[0]!.polylines[0]!.points[1]!.x = Number.NaN;
  assert.throws(
    () => validatePlanTraceSourceAccountingV1(input(), context(nonfinite)),
    /point_1_x_must_be_finite/
  );

  const outOfBounds = receipt();
  outOfBounds.components[0]!.polylines[0]!.points[1]!.x = outOfBounds.width_px;
  assert.throws(
    () => validatePlanTraceSourceAccountingV1(input(), context(outOfBounds)),
    /polyline_point_out_of_bounds/
  );

  const duplicateComponent = receipt();
  duplicateComponent.components.push(structuredClone(duplicateComponent.components[0]!));
  assert.throws(
    () => validatePlanTraceSourceAccountingV1(input(), context(duplicateComponent)),
    /duplicate_path_key/
  );

  const missingPolylines = receipt();
  missingPolylines.components[0]!.polylines = [];
  assert.throws(
    () => validatePlanTraceSourceAccountingV1(input(), context(missingPolylines)),
    /component_polylines_invalid/
  );

  const infiniteDimensions = receipt();
  infiniteDimensions.width_px = Number.POSITIVE_INFINITY;
  assert.throws(
    () => validatePlanTraceSourceAccountingV1(input(), context(infiniteDimensions)),
    /receipt_dimensions_invalid/
  );
});
