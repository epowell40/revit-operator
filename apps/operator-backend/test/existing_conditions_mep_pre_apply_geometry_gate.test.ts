import test from "node:test";
import assert from "node:assert/strict";
import type { ExistingConditionsGroundTruth } from "../src/benchmark/existing_conditions_reconstruction.js";
import {
  isIssuedMepPreApplyGeometryScore,
  promoteScoreGatedMepWorkflow,
  proposedMepSnapshotFromCompilation,
  scoreMepPreApplyGeometry
} from "../src/existing_conditions/mep_pre_apply_geometry_gate.js";
import type { RegisteredMepObservationCompilation } from "../src/existing_conditions/registered_mep_observations.js";

function compilation(observations: Array<Record<string, unknown>>): RegisteredMepObservationCompilation {
  return {
    schema_version: 1,
    fixture_id: "bounded-mep-pre-apply-v1",
    scope_id: "bounded-room-alpha",
    input_fingerprint_sha256: "a".repeat(64),
    registered_render_sha256: "b".repeat(64),
    registration: {
      schema_version: 1,
      source_evidence_sha256: "c".repeat(64),
      transform: { scale: 1, rotation_degrees: 0, translation: { x: 0, y: 0 } },
      rms_error_ft: 0,
      maximum_error_ft: 0,
      control_point_count: 3,
      verified: true
    },
    converted_package: {
      schema_version: 1,
      fixture_id: "bounded-mep-pre-apply-v1",
      scope_id: "bounded-room-alpha",
      source_evidence_sha256: "c".repeat(64),
      visible_evidence: [{ role: "source_pdf", sha256: "c".repeat(64) }],
      native_element_references: [],
      registration: {
        source_evidence_sha256: "c".repeat(64),
        control_points: [],
        max_rms_error_ft: 0.1,
        max_point_error_ft: 0.1
      },
      level_name: "L1",
      level_elevation_ft: 0,
      observations
    },
    compiled_plan: {
      schema_version: 1,
      fixture_id: "bounded-mep-pre-apply-v1",
      scope_id: "bounded-room-alpha",
      input_fingerprint_sha256: "d".repeat(64),
      status: "ready",
      ambiguities: [],
      assumptions: [],
      warnings: [],
      plan_elements: [{ plan_key: "fixture-1", action: "create", observation_ids: ["fixture-1"] }],
      actions: [{
        action_key: "place:fixture-1",
        path: "/revit/place-family-instance",
        depends_on: [],
        dry_run_body: {},
        apply_body: {},
        expected_created_min: 1,
        expected_created_max: 1
      }]
    },
    usage_constraints: []
  } as unknown as RegisteredMepObservationCompilation;
}

function pointCompilation(x: number, y: number): RegisteredMepObservationCompilation {
  return compilation([{
    kind: "light_fixture",
    discipline: "electrical",
    observation_id: "fixture-1",
    point: { x, y, z: 10 }
  }]);
}

function truth(elements: ExistingConditionsGroundTruth["snapshot"]["elements"]): ExistingConditionsGroundTruth {
  return {
    schema_version: 1,
    fixture_id: "bounded-mep-pre-apply-v1",
    scope_id: "bounded-room-alpha",
    discipline: "electrical",
    visible_evidence: [{ role: "source_pdf", sha256: "c".repeat(64) }],
    evaluation_policy: {
      elevation_evidence: "not_visible",
      bounded_mep_region_coverage: {
        required_coverage_status: "complete",
        source_evidence_sha256: "c".repeat(64),
        registered_render_sha256: "b".repeat(64),
        coverage_contract_sha256: "e".repeat(64),
        region_sha256: "f".repeat(64),
        clear_plan_visible_family_instance_keys: elements.filter((entry) => entry.kind === "family_instance").map((entry) => entry.key),
        clear_plan_visible_mep_curve_keys: elements.filter((entry) => entry.kind === "mep_curve").map((entry) => entry.key)
      }
    },
    snapshot: { native_readback: true, elements, connections: [], open_connector_count: 0 }
  };
}

test("MEP pre-apply score gates an exact bounded fixture proposal before workflow emission", () => {
  const compiled = pointCompilation(10.05, 20.05);
  const score = scoreMepPreApplyGeometry(truth([{
    key: "truth:fixture-1",
    kind: "family_instance",
    discipline: "electrical",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 10, y: 20, z: 14 }
  }]), compiled);
  assert.equal(score.passed, true);
  assert.equal(score.counts.matched, 1);
  assert.equal(score.metrics.precision, 1);
  assert.equal(score.metrics.recall, 1);
  assert.equal(isIssuedMepPreApplyGeometryScore(score), true);
  const promotion = promoteScoreGatedMepWorkflow(compiled, score, { maximum_created_elements: 1 });
  assert.equal(promotion.workflow.dryRun, true);
  assert.equal(promotion.workflow.operations.length, 1);
  assert.match(promotion.capability_boundary, /does not replace native dry-run/i);
});

test("tag-derived fixture points far from original-model fixtures fail before native workflow", () => {
  const compiled = pointCompilation(25, -372);
  const score = scoreMepPreApplyGeometry(truth([{
    key: "truth:u2-fixture",
    kind: "family_instance",
    discipline: "electrical",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 47.375, y: -367.917, z: 14 }
  }]), compiled);
  assert.equal(score.passed, false);
  assert.equal(score.counts.matched, 0);
  assert.deepEqual(score.false_positive_proposal_keys, ["proposal:fixture-1"]);
  assert.ok(score.failure_classifications.includes("mep_pre_apply_geometry_mismatch"));
  assert.throws(() => promoteScoreGatedMepWorkflow(compiled, score), /requires_passing_geometry_score/);
});

test("MEP pre-apply promotion rejects forged scores and compilation drift", () => {
  const compiled = pointCompilation(10, 20);
  const evaluationTruth = truth([{
    key: "truth:fixture-1",
    kind: "family_instance",
    discipline: "electrical",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 10, y: 20, z: 14 }
  }]);
  const issued = scoreMepPreApplyGeometry(evaluationTruth, compiled);
  const forged = structuredClone(issued);
  assert.equal(isIssuedMepPreApplyGeometryScore(forged), false);
  assert.throws(() => promoteScoreGatedMepWorkflow(compiled, forged), /requires_evaluator_issued_score/);
  (compiled.converted_package.observations[0] as unknown as { point: { x: number } }).point.x = 11;
  assert.throws(() => promoteScoreGatedMepWorkflow(compiled, issued), /compilation_fingerprint_mismatch/);
});

test("MEP pre-apply geometry scoring accepts reversed route endpoints", () => {
  const compiled = compilation([{
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "route-1",
    points: [{ x: 20, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }]
  }]);
  const score = scoreMepPreApplyGeometry(truth([{
    key: "truth:route-1",
    kind: "mep_curve",
    discipline: "plumbing",
    role: "pipe_route",
    category: "Pipes",
    endpoints: [{ x: 0, y: 0, z: 12 }, { x: 20, y: 0, z: 12 }]
  }]), compiled);
  assert.equal(score.passed, true);
  assert.equal(score.metrics.route_precision, 1);
  assert.equal(score.metrics.route_recall, 1);
  assert.deepEqual(score.false_positive_proposal_keys, []);
  assert.equal(proposedMepSnapshotFromCompilation(compiled).snapshot.elements[0]?.kind, "mep_curve");
});

test("MEP pre-apply route coverage is independent of harmless native segmentation", () => {
  const compiled = compilation([{
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "route-1",
    points: [{ x: 0, y: 0, z: 10 }, { x: 20, y: 0, z: 10 }]
  }]);
  const score = scoreMepPreApplyGeometry(truth([
    {
      key: "truth:route-a",
      kind: "mep_curve",
      discipline: "plumbing",
      role: "pipe_route",
      category: "Pipes",
      endpoints: [{ x: 0, y: 0, z: 12 }, { x: 10, y: 0, z: 12 }]
    },
    {
      key: "truth:route-b",
      kind: "mep_curve",
      discipline: "plumbing",
      role: "pipe_route",
      category: "Pipes",
      endpoints: [{ x: 10, y: 0, z: 12 }, { x: 20, y: 0, z: 12 }]
    }
  ]), compiled);
  assert.equal(score.passed, true);
  assert.equal(score.metrics.route_precision, 1);
  assert.equal(score.metrics.route_recall, 1);
  assert.deepEqual(score.false_positive_proposal_keys, []);
});

test("MEP pre-apply route scoring preserves intermediate bends instead of collapsing to endpoints", () => {
  const compiled = compilation([{
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "route-1",
    points: [{ x: 0, y: 0, z: 10 }, { x: 10, y: 10, z: 10 }, { x: 20, y: 0, z: 10 }]
  }]);
  const score = scoreMepPreApplyGeometry(truth([{
    key: "truth:route-1",
    kind: "mep_curve",
    discipline: "plumbing",
    role: "pipe_route",
    category: "Pipes",
    endpoints: [{ x: 0, y: 0, z: 12 }, { x: 20, y: 0, z: 12 }]
  }]), compiled);
  assert.equal(proposedMepSnapshotFromCompilation(compiled).snapshot.elements.length, 2);
  assert.equal(score.passed, false);
  assert.ok(score.failure_classifications.includes("mep_pre_apply_geometry_mismatch"));
});

test("MEP pre-apply route scoring rejects duplicate and backtracking proposal geometry", () => {
  const compiled = compilation([{
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "route-1",
    points: [
      { x: 0, y: 0, z: 10 },
      { x: 20, y: 0, z: 10 },
      { x: 0, y: 0, z: 10 },
      { x: 20, y: 0, z: 10 }
    ]
  }]);
  const score = scoreMepPreApplyGeometry(truth([{
    key: "truth:route-1",
    kind: "mep_curve",
    discipline: "plumbing",
    role: "pipe_route",
    category: "Pipes",
    endpoints: [{ x: 0, y: 0, z: 12 }, { x: 20, y: 0, z: 12 }]
  }]), compiled);
  assert.equal(score.valid_run, false);
  assert.equal(score.passed, false);
  assert.ok(score.invalid_reasons.includes("mep_pre_apply_proposal_routes_overlap_or_backtrack"));
});

test("MEP pre-apply policy rejects non-finite values instead of bypassing thresholds", () => {
  const compiled = pointCompilation(10, 20);
  const score = scoreMepPreApplyGeometry(truth([{
    key: "truth:fixture-1",
    kind: "family_instance",
    discipline: "electrical",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 10, y: 20, z: 14 }
  }]), compiled, { point_location_tolerance_ft: Number.NaN });
  assert.equal(score.valid_run, false);
  assert.ok(score.invalid_reasons.includes("mep_pre_apply_scoring_policy_invalid"));
  assert.throws(() => promoteScoreGatedMepWorkflow(compiled, score), /score_policy_invalid/);
});

test("MEP pre-apply scoring rejects invented kinds and malformed route vertices", () => {
  const invented = compilation([{
    kind: "invented_observation",
    discipline: "electrical",
    observation_id: "invented-1",
    point: { x: 10, y: 20, z: 10 }
  }]);
  const inventedScore = scoreMepPreApplyGeometry(truth([{
    key: "truth:invented-1",
    kind: "family_instance",
    discipline: "electrical",
    role: "invented_observation",
    category: "Invented",
    location: { x: 10, y: 20, z: 14 }
  }]), invented);
  assert.equal(inventedScore.valid_run, false);
  assert.ok(inventedScore.invalid_reasons.some((reason) => reason.includes("invented-1")));

  const malformed = compilation([{
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "route-1",
    points: [{ x: 0, y: 0, z: 10 }, { x: "not-a-number", y: 0, z: 10 }, { x: 20, y: 0, z: 10 }]
  }]);
  const malformedScore = scoreMepPreApplyGeometry(truth([{
    key: "truth:route-1",
    kind: "mep_curve",
    discipline: "plumbing",
    role: "pipe_route",
    category: "Pipes",
    endpoints: [{ x: 0, y: 0, z: 12 }, { x: 20, y: 0, z: 12 }]
  }]), malformed);
  assert.equal(malformedScore.valid_run, false);
  assert.ok(malformedScore.invalid_reasons.some((reason) => reason.includes("route-1")));

  const missingId = compilation([{
    kind: "light_fixture",
    discipline: "electrical",
    point: { x: 10, y: 20, z: 10 }
  }]);
  const missingIdScore = scoreMepPreApplyGeometry(truth([{
    key: "truth:fixture-1",
    kind: "family_instance",
    discipline: "electrical",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 10, y: 20, z: 14 }
  }]), missingId);
  assert.equal(missingIdScore.valid_run, false);
  assert.ok(missingIdScore.invalid_reasons.some((reason) => reason.includes("missing-observation-id")));

  const laundered = compilation([{
    kind: "light_fixture",
    discipline: "plumbing",
    observation_id: "fixture-1",
    point: { x: 10, y: 20, z: 10 }
  }]);
  const launderedScore = scoreMepPreApplyGeometry(truth([{
    key: "truth:fixture-1",
    kind: "family_instance",
    discipline: "plumbing",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 10, y: 20, z: 14 }
  }]), laundered);
  assert.equal(launderedScore.valid_run, false);
  assert.ok(launderedScore.invalid_reasons.some((reason) => reason.includes("fixture-1")));
});

test("MEP pre-apply points reject numeric-string coercion and oversized routes fail without allocation", () => {
  const stringPoint = compilation([{
    kind: "light_fixture",
    discipline: "electrical",
    observation_id: "fixture-1",
    point: { x: "10", y: 20, z: 10 }
  }]);
  const pointTruth = truth([{
    key: "truth:fixture-1",
    kind: "family_instance",
    discipline: "electrical",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 10, y: 20, z: 14 }
  }]);
  assert.equal(scoreMepPreApplyGeometry(pointTruth, stringPoint).valid_run, false);

  const hugeRoute = compilation([{
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "route-1",
    points: [{ x: 0, y: 0, z: 10 }, { x: 1_000_000, y: 0, z: 10 }]
  }]);
  const hugeTruth = truth([{
    key: "truth:route-1",
    kind: "mep_curve",
    discipline: "plumbing",
    role: "pipe_route",
    category: "Pipes",
    endpoints: [{ x: 0, y: 0, z: 12 }, { x: 1_000_000, y: 0, z: 12 }]
  }]);
  const hugeScore = scoreMepPreApplyGeometry(hugeTruth, hugeRoute);
  assert.equal(hugeScore.valid_run, false);
  assert.equal(hugeScore.passed, false);
  assert.ok(hugeScore.invalid_reasons.includes("mep_pre_apply_route_scoring_budget_exceeded"));
  assert.equal(hugeScore.metrics.route_precision, 0);
  assert.equal(hugeScore.metrics.route_recall, 0);
});

test("MEP pre-apply score receipts do not serialize evaluator truth keys or key fingerprints", () => {
  const secretTruthKey = "private-project-element-id-12345";
  const score = scoreMepPreApplyGeometry(truth([{
    key: secretTruthKey,
    kind: "family_instance",
    discipline: "electrical",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 10, y: 20, z: 14 }
  }]), pointCompilation(10, 20));
  assert.equal(score.passed, true);
  assert.equal(JSON.stringify(score).includes(secretTruthKey), false);
  assert.equal(Object.keys(score.matched_pairs[0] ?? {}).some((key) => key.includes("truth_key")), false);
});

test("MEP pre-apply route coverage cannot launder a different route role", () => {
  const compiled = compilation([{
    kind: "supply_duct_route",
    discipline: "mechanical",
    observation_id: "route-1",
    points: [{ x: 0, y: 0, z: 10 }, { x: 20, y: 0, z: 10 }]
  }]);
  const score = scoreMepPreApplyGeometry(truth([{
    key: "truth:route-1",
    kind: "mep_curve",
    discipline: "mechanical",
    role: "return_duct_route",
    category: "Ducts",
    endpoints: [{ x: 0, y: 0, z: 12 }, { x: 20, y: 0, z: 12 }]
  }]), compiled);
  assert.equal(score.passed, false);
  assert.equal(score.metrics.route_precision, 0);
  assert.equal(score.metrics.route_recall, 0);
});

test("MEP pre-apply truth keys must be unique and declared under the correct element kind", () => {
  const compiled = pointCompilation(10, 20);
  const malformedTruth = truth([{
    key: "truth:fixture-1",
    kind: "family_instance",
    discipline: "electrical",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 10, y: 20, z: 14 }
  }]);
  const coverage = malformedTruth.evaluation_policy!.bounded_mep_region_coverage!;
  coverage.clear_plan_visible_family_instance_keys.push("truth:fixture-1");
  (coverage.clear_plan_visible_mep_curve_keys ??= []).push("truth:fixture-1");
  const score = scoreMepPreApplyGeometry(malformedTruth, compiled);
  assert.equal(score.valid_run, false);
  assert.ok(score.invalid_reasons.includes("mep_pre_apply_truth_keys_duplicated"));
  assert.ok(score.invalid_reasons.includes("mep_pre_apply_truth_route_keys_have_wrong_kind"));
});

test("MEP pre-apply truth fails closed when a bounded point or route has malformed geometry", () => {
  const compiled = pointCompilation(10, 20);
  const malformedTruth = truth([
    {
      key: "truth:fixture-1",
      kind: "family_instance",
      discipline: "electrical",
      role: "light_fixture",
      category: "Lighting Fixtures",
      location: { x: 10, y: 20, z: 14 }
    },
    {
      key: "truth:bad-route",
      kind: "mep_curve",
      discipline: "electrical",
      role: "conduit_route",
      category: "Conduits",
      endpoints: [{ x: 0, y: 0, z: 12 }, { x: Number.NaN, y: 20, z: 12 }]
    }
  ]);
  const score = scoreMepPreApplyGeometry(malformedTruth, compiled);
  assert.equal(score.valid_run, false);
  assert.equal(score.passed, false);
  assert.ok(score.invalid_reasons.includes("mep_pre_apply_truth_route_geometry_invalid"));
});

test("MEP pre-apply score fails closed without evaluator bounded-visible truth keys", () => {
  const compiled = pointCompilation(10, 20);
  const unboundedTruth = truth([{
    key: "truth:fixture-1",
    kind: "family_instance",
    discipline: "electrical",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 10, y: 20, z: 14 }
  }]);
  delete unboundedTruth.evaluation_policy?.bounded_mep_region_coverage;
  const score = scoreMepPreApplyGeometry(unboundedTruth, compiled);
  assert.equal(score.valid_run, false);
  assert.ok(score.invalid_reasons.includes("mep_pre_apply_truth_requires_bounded_visible_keys"));
});

test("MEP pre-apply truth coverage is bound to the exact source and registered render", () => {
  const compiled = pointCompilation(10, 20);
  const mismatchedTruth = truth([{
    key: "truth:fixture-1",
    kind: "family_instance",
    discipline: "electrical",
    role: "light_fixture",
    category: "Lighting Fixtures",
    location: { x: 10, y: 20, z: 14 }
  }]);
  const coverage = mismatchedTruth.evaluation_policy!.bounded_mep_region_coverage!;
  (coverage as unknown as { required_coverage_status: string }).required_coverage_status = "partial";
  coverage.source_evidence_sha256 = "9".repeat(64);
  coverage.registered_render_sha256 = "8".repeat(64);
  const score = scoreMepPreApplyGeometry(mismatchedTruth, compiled);
  assert.equal(score.valid_run, false);
  assert.ok(score.invalid_reasons.includes("mep_pre_apply_truth_coverage_must_be_complete"));
  assert.ok(score.invalid_reasons.includes("mep_pre_apply_truth_source_evidence_mismatch"));
  assert.ok(score.invalid_reasons.includes("mep_pre_apply_truth_registered_render_mismatch"));
});
