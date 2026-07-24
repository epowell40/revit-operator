import assert from "node:assert/strict";
import test from "node:test";
import { compileSheetPixelInterpretationV1, type SheetPixelInterpretationContextV1, type SheetPixelInterpretationInputV1, type SheetSourceRouteJunctionRepairV1 } from "../src/existing_conditions/sheet_pixel_interpretation.js";
import { proposeSheetRouteJunctionRepairsV1 } from "../src/existing_conditions/sheet_route_junction_repair.js";

const SOURCE_HASH = "a".repeat(64);
const REGISTRATION_HASH = "b".repeat(64);

function fixture(): { input: SheetPixelInterpretationInputV1; repairs: SheetSourceRouteJunctionRepairV1[] } {
  const claims = {
    system: { value: "supply air", confidence: 0.99, basis: "legible_source_evidence" as const },
    size: { value: "8 inch", confidence: 0.99, basis: "legible_source_evidence" as const },
    type: { value: "round duct", confidence: 0.99, basis: "approved_project_mapping" as const },
    elevation: { value: "10 ft above level", confidence: 0.99, basis: "approved_project_mapping" as const }
  };
  const confidence = { geometry: 0.99, classification: 0.99, topology: 0.99, visibility: 0.99 };
  const route = (primitive_id: string, mark: string, points: Array<{ u: number; v: number }>, endpointKeys: [string, string]) => ({
    primitive_id, source_view_key: "main", source_mark_ids: [mark], kind: "route_segment" as const, points,
    endpoints: [
      { endpoint_key: endpointKeys[0], point: points[0]!, outward_direction_uv: [-1, 0] as [number, number], boundary: "internal" as const },
      { endpoint_key: endpointKeys[1], point: points[1]!, outward_direction_uv: [1, 0] as [number, number], boundary: "internal" as const }
    ],
    claims, confidence
  });
  const input: SheetPixelInterpretationInputV1 = {
    schema_version: 1,
    package_id: "two-near-t-routes",
    coordinate_space: "normalized_uv_top_left",
    view_keys: ["main"],
    source_marks: [
      { source_mark_id: "mark-left", source_view_key: "main", disposition: { status: "candidate", primitive_ids: ["left"] } },
      { source_mark_id: "mark-right", source_view_key: "main", disposition: { status: "candidate", primitive_ids: ["right"] } },
      { source_mark_id: "mark-branch", source_view_key: "main", disposition: { status: "candidate", primitive_ids: ["branch"] } }
    ],
    primitives: [
      route("left", "mark-left", [{ u: 0.2, v: 0.2 }, { u: 0.2, v: 0.8 }], ["ep_1", "ep_2"]),
      route("right", "mark-right", [{ u: 0.8, v: 0.2 }, { u: 0.8, v: 0.8 }], ["ep_1", "ep_2"]),
      route("branch", "mark-branch", [{ u: 0.23, v: 0.5 }, { u: 0.77, v: 0.5 }], ["ep_1", "ep_2"])
    ]
  };
  const repair = (id: string, trunk: string, endpoint: string, endpointU: number, junctionU: number): SheetSourceRouteJunctionRepairV1 => ({
    repair_id: id,
    source_view_key: "main",
    trunk_primitive_id: trunk,
    trunk_segment_index: 0,
    branch_primitive_id: "branch",
    branch_endpoint_key: endpoint,
    branch_endpoint_uv: { u: endpointU, v: 0.5 },
    projected_junction_uv: { u: junctionU, v: 0.5 },
    gap_px: 21,
    maximum_gap_px: 21,
    intersection_angle_degrees: 90,
    status: "requires_source_junction_split",
    exact_next_repair: "split_trunk_and_snap_branch_endpoint_after_source_raster_reverification",
    native_write_allowed: false
  });
  return { input, repairs: [repair("repair-left", "left", "branch:ep_1", 0.23, 0.2), repair("repair-right", "right", "branch:ep_2", 0.77, 0.8)] };
}

function context(): SheetPixelInterpretationContextV1 {
  return {
    trusted_views: [{
      source_view: {
        view_key: "main", sheet_key: "M-100", source_sha256: SOURCE_HASH, registration_sha256: REGISTRATION_HASH,
        discipline: "mechanical", level_key: "L1", phase_key: "EXISTING", role: "main_plan", resolution_rank: 1,
        registration: { verified: true, rms_residual_ft: 0, maximum_residual_ft: 0, confidence: 0.99 }
      },
      frame: { frame_id: "frame", view_id: 100, width_px: 700, height_px: 850, top_left_xyz: [0, 0, 0], top_right_xyz: [70, 0, 0], bottom_left_xyz: [0, -85, 0], target_level_elevation_ft: 0 }
    }],
    calibration_profile: {
      schema_version: 1,
      profile_id: "test",
      provenance: { outcomes_sha256: SOURCE_HASH, prediction_count: 100, fixture_count: 5, evaluator_receipt_sha256s: [REGISTRATION_HASH], truth_revealed_only_after_seal: true },
      bins: [{ discipline: "mechanical", primitive_kind: "route_segment", raw_confidence_min: 0.9, raw_confidence_max: 1, trials: 100, successes: 100, fixture_count: 5 }]
    }
  };
}

test("a pair of near-T repairs becomes five raster-gated spans and two explicit three-way junctions", () => {
  const { input, repairs } = fixture();
  const proposal = proposeSheetRouteJunctionRepairsV1({ interpretation: input, repairs });

  assert.equal(proposal.native_write_allowed, false);
  assert.equal(proposal.raster_reverification_required, true);
  assert.equal(proposal.proposed_junctions.length, 2);
  assert.ok(proposal.proposed_junctions.every(junction => junction.endpoint_keys.length === 3));
  assert.deepEqual(Object.fromEntries(Object.entries(proposal.source_primitive_replacements).map(([key, ids]) => [key, ids.length])), { left: 2, right: 2, branch: 1 });
  const replacements = proposal.proposal_interpretation.primitives.filter(primitive => primitive.source_repair);
  assert.equal(replacements.length, 5);
  assert.ok(replacements.every(primitive => primitive.requires_raster_reverification === true));
  const repairedBranch = replacements.find(primitive => primitive.source_repair?.source_primitive_id === "branch")!;
  assert.deepEqual(repairedBranch.points, [{ u: 0.2, v: 0.5 }, { u: 0.8, v: 0.5 }]);

  const withoutReverification = compileSheetPixelInterpretationV1(proposal.proposal_interpretation, context());
  assert.ok(withoutReverification.compiled_topology.decisions.every(decision => decision.decision === "deferred"));
  assert.ok(withoutReverification.compiled_topology.decisions.every(decision => decision.reasons.includes("geometry_confidence_below_threshold")));
});

test("only a package-bound accepted raster receipt unlocks repaired source topology", () => {
  const { input, repairs } = fixture();
  const proposal = proposeSheetRouteJunctionRepairsV1({ interpretation: input, repairs });
  const repairedIds = proposal.proposal_interpretation.primitives.map(primitive => primitive.primitive_id);
  const receipt = {
    schema_version: 1 as const,
    package_id: proposal.proposal_interpretation.package_id,
    source_view_key: "main",
    image: { path: "main.png", sha256: SOURCE_HASH, width_px: 700, height_px: 850 },
    policy: { maximum_luminance: 180, corridor_radius_px: 7, sample_spacing_px: 2, accepted_support_fraction: 0.82, provisional_support_fraction: 0.55, maximum_accepted_unsupported_run_fraction: 0.18 },
    route_evidence: repairedIds.map(primitive_id => ({ primitive_id, sample_count: 100, supported_sample_count: 100, support_fraction: 1, longest_unsupported_run_fraction: 0, status: "accepted_raster_support" as const })),
    accepted_primitive_ids: repairedIds,
    provisional_primitive_ids: [],
    rejected_primitive_ids: []
  };
  const stale = structuredClone(receipt);
  stale.package_id = input.package_id;
  const staleContext = context();
  staleContext.raster_evidence_receipts = [stale];
  assert.throws(
    () => compileSheetPixelInterpretationV1(proposal.proposal_interpretation, staleContext),
    /sheet_pixel_raster_evidence_package_mismatch:0/
  );

  const trusted = context();
  trusted.raster_evidence_receipts = [receipt];
  const compiled = compileSheetPixelInterpretationV1(proposal.proposal_interpretation, trusted);
  assert.equal(compiled.source_route_junction_repairs.length, 0);
  assert.equal(compiled.compiled_topology.junctions.length, 2);
  assert.ok(compiled.compiled_topology.junctions.every(junction => junction.kind === "tee_or_branch" && junction.endpoint_keys.length === 3));
  assert.ok(compiled.compiled_topology.decisions.every(decision => decision.decision === "native_batch"));

  const unresolvedId = proposal.source_primitive_replacements.branch![0]!;
  const unresolvedPrimitive = proposal.proposal_interpretation.primitives.find(primitive => primitive.primitive_id === unresolvedId)!;
  unresolvedPrimitive.claims!.system = { value: "unknown", confidence: 0, basis: "unresolved" };
  const unresolved = compileSheetPixelInterpretationV1(proposal.proposal_interpretation, trusted);
  const unresolvedDecision = unresolved.compiled_topology.decisions.find(decision => decision.primitive_id === unresolvedId)!;
  assert.equal(unresolvedDecision.decision, "deferred");
  assert.ok(unresolvedDecision.reasons.includes("source_repair_material_claims_must_be_resolved_before_execution"));
});
