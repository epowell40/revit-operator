import assert from "node:assert/strict";
import test from "node:test";
import {
  compileSheetTopologyV1,
  type SheetTopologyCompilationContextV1,
  type SheetTopologyCompilationInputV1,
  type SheetTopologyPrimitiveV1,
  type SheetTopologySourceViewV1
} from "../src/existing_conditions/sheet_topology_compiler.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function view(
  viewKey: string,
  sheetKey: string,
  resolutionRank: number,
  discipline: SheetTopologySourceViewV1["discipline"] = "plumbing"
): SheetTopologySourceViewV1 {
  return {
    view_key: viewKey,
    sheet_key: sheetKey,
    source_sha256: HASH_A,
    registration_sha256: HASH_B,
    discipline,
    level_key: "LEVEL-1",
    phase_key: "EXISTING",
    role: resolutionRank > 1 ? "enlarged_plan" : "main_plan",
    resolution_rank: resolutionRank,
    registration: {
      verified: true,
      rms_residual_ft: 0.001,
      maximum_residual_ft: 0.002,
      confidence: 0.99
    }
  };
}

function route(
  id: string,
  sourceViewKey: string,
  markId: string,
  start: [number, number],
  end: [number, number],
  options: {
    startContinuation?: string;
    endContinuation?: string;
    system?: string;
    confidence?: number;
  } = {}
): SheetTopologyPrimitiveV1 {
  const confidence = options.confidence ?? 0.99;
  return {
    primitive_id: id,
    source_view_key: sourceViewKey,
    source_mark_ids: [markId],
    kind: "route_segment",
    points: [{ x: start[0], y: start[1] }, { x: end[0], y: end[1] }],
    endpoints: [
      {
        endpoint_key: `${id}:start`,
        point: { x: start[0], y: start[1] },
        outward_direction_xy: [-1, 0],
        boundary: options.startContinuation ? "view_boundary" : "internal",
        ...(options.startContinuation ? { continuation_key: options.startContinuation } : {})
      },
      {
        endpoint_key: `${id}:end`,
        point: { x: end[0], y: end[1] },
        outward_direction_xy: [1, 0],
        boundary: options.endContinuation ? "view_boundary" : "internal",
        ...(options.endContinuation ? { continuation_key: options.endContinuation } : {})
      }
    ],
    claims: {
      system: { value: options.system ?? "domestic cold water", confidence: 0.99, basis: "legible_source_evidence" },
      size: { value: "2 in", confidence: 0.99, basis: "legible_source_evidence" },
      type: { value: "standard", confidence: 0.99, basis: "approved_project_mapping" },
      elevation: { value: "10 ft above level", confidence: 0.99, basis: "approved_project_mapping" }
    },
    confidence: { geometry: confidence, classification: confidence, topology: confidence, visibility: confidence },
    independently_reversible: true
  };
}

function fixture(
  sourceViews: SheetTopologySourceViewV1[],
  primitives: SheetTopologyPrimitiveV1[],
  calibration = { trials: 100, successes: 100 }
): { packageInput: SheetTopologyCompilationInputV1; context: SheetTopologyCompilationContextV1 } {
  const packageInput: SheetTopologyCompilationInputV1 = {
    schema_version: 1,
    package_id: "blind-sheet-package",
    coordinate_space: "model_xyz_feet",
    source_views: sourceViews,
    source_marks: primitives.map(primitive => ({
      source_mark_id: primitive.source_mark_ids[0]!,
      source_view_key: primitive.source_view_key,
      disposition: { status: "candidate" as const, primitive_ids: [primitive.primitive_id] }
    })),
    primitives
  };
  return {
    packageInput,
    context: {
      trusted_source_views: structuredClone(sourceViews),
      calibration_profile: {
        schema_version: 1,
        profile_id: "blind-validation-v1",
        provenance: {
          outcomes_sha256: HASH_A,
          prediction_count: calibration.trials,
          fixture_count: 4,
          evaluator_receipt_sha256s: [HASH_B],
          truth_revealed_only_after_seal: true
        },
        bins: [{
          discipline: "plumbing",
          primitive_kind: "route_segment",
          raw_confidence_min: 0.9,
          raw_confidence_max: 1,
          trials: calibration.trials,
          successes: calibration.successes,
          fixture_count: 4
        }]
      }
    }
  };
}

function compileFixture(value: ReturnType<typeof fixture>) {
  return compileSheetTopologyV1(value.packageInput, value.context);
}

test("whole-sheet compiler deduplicates overlap and stitches a continuation across views", () => {
  const main = route("main-run", "main", "mark-main", [0, 0], [10, 0], { endContinuation: "RUN-A" });
  const enlargedDuplicate = route("enlarged-duplicate", "enlarged", "mark-duplicate", [0, 0], [10, 0], { endContinuation: "RUN-A" });
  const enlargedContinuation = route("enlarged-continuation", "enlarged", "mark-continuation", [10, 0], [20, 0], { startContinuation: "RUN-A" });
  const result = compileFixture(fixture(
    [view("main", "P-100", 1), view("enlarged", "P-100", 3)],
    [main, enlargedDuplicate, enlargedContinuation]
  ));

  assert.equal(result.status, "ready");
  assert.deepEqual(result.canonical_primitive_ids, ["enlarged-continuation", "enlarged-duplicate"]);
  assert.deepEqual(result.duplicate_primitive_ids, ["main-run"]);
  assert.equal(result.connections.length, 1);
  assert.equal(result.connections[0]?.basis, "explicit_continuation");
  assert.equal(result.connections[0]?.scope, "within_view");
  assert.equal(result.connections[0]?.status, "accepted");
  assert.equal(result.native_batch_groups.length, 1);
  assert.deepEqual(result.native_batch_groups[0]?.primitive_ids, ["enlarged-continuation", "enlarged-duplicate"]);
  assert.equal(result.source_accounting_closure, 1);
});

test("continuation identities preserve long runs across different sheets", () => {
  const left = route("left", "sheet-a", "mark-left", [0, 0], [10, 0], { endContinuation: "RISER-7" });
  const right = route("right", "sheet-b", "mark-right", [10, 0], [30, 0], { startContinuation: "RISER-7" });
  const result = compileFixture(fixture(
    [view("sheet-a", "P-100", 1), view("sheet-b", "P-101", 1)],
    [left, right]
  ));

  assert.equal(result.connections.length, 1);
  assert.equal(result.connections[0]?.scope, "cross_sheet");
  assert.equal(result.component_by_primitive_id.left, result.component_by_primitive_id.right);
  assert.equal(result.frontier_endpoint_keys.length, 0);
});

test("incompatible systems never stitch merely because endpoints overlap", () => {
  const cold = route("cold", "main", "mark-cold", [0, 0], [10, 0], { endContinuation: "SAME", system: "domestic cold water" });
  const hot = route("hot", "enlarged", "mark-hot", [10, 0], [20, 0], { startContinuation: "SAME", system: "domestic hot water" });
  const result = compileFixture(fixture(
    [view("main", "P-100", 1), view("enlarged", "P-100", 2)],
    [cold, hot]
  ));

  assert.equal(result.connections.length, 0);
  assert.ok(result.conflicts.some(value => value.includes("claim_mismatch")));
  assert.deepEqual(result.native_batch_groups, []);
  assert.deepEqual(result.single_action_primitive_ids, ["cold", "hot"]);
});

test("raw model confidence cannot authorize batching without empirical calibration support", () => {
  const candidate = route("uncalibrated", "main", "mark", [0, 0], [20, 0]);
  const result = compileFixture(fixture([view("main", "P-100", 1)], [candidate], { trials: 20, successes: 16 }));

  assert.equal(result.status, "partially_ready");
  assert.deepEqual(result.native_batch_groups, []);
  assert.deepEqual(result.deferred_primitive_ids, ["uncalibrated"]);
  assert.ok(result.decisions[0]?.reasons.includes("calibrated_precision_below_batch_threshold") === false);
});

test("many correlated successes from one drawing cannot authorize batching", () => {
  const candidate = route("single-fixture", "main", "mark", [0, 0], [20, 0]);
  const compiledFixture = fixture([view("main", "P-100", 1)], [candidate]);
  compiledFixture.context.calibration_profile.bins[0]!.fixture_count = 1;
  compiledFixture.context.calibration_profile.provenance.fixture_count = 1;
  const result = compileSheetTopologyV1(compiledFixture.packageInput, compiledFixture.context);

  assert.deepEqual(result.native_batch_groups, []);
  assert.deepEqual(result.deferred_primitive_ids, ["single-fixture"]);
  assert.ok(result.decisions[0]?.reasons.includes("calibration_fixture_diversity_insufficient"));
});

test("high-confidence geometry with unresolved material claims is isolated as a single repair", () => {
  const candidate = route("unresolved-type", "main", "mark", [0, 0], [20, 0]);
  candidate.claims!.type = { value: "unknown", confidence: 0.99, basis: "unresolved" };
  const result = compileFixture(fixture([view("main", "P-100", 1)], [candidate]));

  assert.deepEqual(result.native_batch_groups, []);
  assert.deepEqual(result.single_action_primitive_ids, ["unresolved-type"]);
  assert.ok(result.decisions[0]?.reasons.includes("material_claims_unresolved:type"));
});

test("source accounting rejects a primitive that cites an unregistered source mark", () => {
  const candidate = route("orphan", "main", "missing-mark", [0, 0], [20, 0]);
  const compiledFixture = fixture([view("main", "P-100", 1)], [candidate]);
  compiledFixture.packageInput.source_marks = [{
    source_mark_id: "different-mark",
    source_view_key: "main",
    disposition: { status: "unresolved", reason: "ambiguous symbol" }
  }];

  assert.throws(
    () => compileSheetTopologyV1(compiledFixture.packageInput, compiledFixture.context),
    /sheet_topology_primitive_unknown_source_mark:orphan:missing-mark/
  );
});

test("candidate-supplied registration confidence cannot replace the trusted host receipt", () => {
  const candidate = route("tampered", "main", "mark", [0, 0], [20, 0]);
  const compiledFixture = fixture([view("main", "P-100", 1)], [candidate]);
  compiledFixture.packageInput.source_views[0]!.registration.confidence = 1;

  assert.throws(
    () => compileSheetTopologyV1(compiledFixture.packageInput, compiledFixture.context),
    /sheet_topology_source_view_not_trusted:main/
  );
});

test("architectural straight walls use the same calibrated batch contract", () => {
  const architecturalView = view("a-main", "A-100", 1, "architectural");
  architecturalView.role = "architectural_plan";
  const wall: SheetTopologyPrimitiveV1 = {
    primitive_id: "wall-1",
    source_view_key: "a-main",
    source_mark_ids: ["wall-mark"],
    kind: "wall_segment",
    points: [{ x: 0, y: 0 }, { x: 30, y: 0 }],
    claims: {
      type: { value: "generic wall", confidence: 0.99, basis: "approved_project_mapping" },
      vertical_extent: { value: "10 ft", confidence: 0.99, basis: "approved_project_mapping" }
    },
    confidence: { geometry: 0.99, classification: 0.99, topology: 0.99, visibility: 0.99 },
    independently_reversible: true
  };
  const compiledFixture = fixture([architecturalView], [wall]);
  compiledFixture.context.calibration_profile.bins = [{
    discipline: "architectural",
    primitive_kind: "wall_segment",
    raw_confidence_min: 0.9,
    raw_confidence_max: 1,
    trials: 100,
    successes: 100,
    fixture_count: 4
  }];
  const result = compileSheetTopologyV1(compiledFixture.packageInput, compiledFixture.context);

  assert.equal(result.status, "ready");
  assert.deepEqual(result.native_batch_groups[0]?.primitive_ids, ["wall-1"]);
  assert.deepEqual(result.single_action_primitive_ids, []);
});
