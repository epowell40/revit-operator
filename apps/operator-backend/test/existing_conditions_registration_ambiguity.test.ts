import assert from "node:assert/strict";
import test from "node:test";
import {
  assessExistingConditionsRegistrationAmbiguity,
  type ExistingConditionsRegistrationAmbiguityInputV1
} from "../src/existing_conditions/registration_ambiguity.js";
import { assertExistingConditionsContract } from "../src/existing_conditions/contract_validation.js";

const SOURCE_HASH = "a".repeat(64);
const EVIDENCE_HASH = "b".repeat(64);

function registration(tx: number, ty: number) {
  return {
    source_evidence_sha256: SOURCE_HASH,
    control_points: [
      { source: { x: 0, y: 0 }, model: { x: tx, y: ty } },
      { source: { x: 10, y: 0 }, model: { x: tx + 10, y: ty } },
      { source: { x: 0, y: 10 }, model: { x: tx, y: ty + 10 } }
    ],
    max_rms_error_ft: 0.01,
    max_point_error_ft: 0.01
  };
}

function input(): ExistingConditionsRegistrationAmbiguityInputV1 {
  return {
    schema_version: 1,
    source_evidence_sha256: SOURCE_HASH,
    selected_candidate_id: "correct-module",
    source_bounds: { min: { x: 0, y: 0 }, max: { x: 100, y: 80 } },
    candidate_search_complete: true,
    evaluated_candidate_count: 500,
    candidates: [
      {
        candidate_id: "correct-module",
        registration: registration(100, 200),
        independent_evidence_score: 0.72,
        independent_evidence_support_count: 12,
        evidence_kind: "retained_non_target_mask",
        evidence_role: "retained fixture mask",
        evidence_sha256: EVIDENCE_HASH,
        access_scope: "agent_visible",
        target_regions_excluded: true
      },
      {
        candidate_id: "repeated-module",
        registration: registration(140, 200),
        independent_evidence_score: 0.51,
        independent_evidence_support_count: 12,
        evidence_kind: "retained_non_target_mask",
        evidence_role: "retained fixture mask",
        evidence_sha256: EVIDENCE_HASH,
        access_scope: "agent_visible",
        target_regions_excluded: true
      }
    ]
  };
}

test("registration ambiguity accepts a decisive independent retained-evidence margin", () => {
  const receipt = assessExistingConditionsRegistrationAmbiguity(input());
  assert.equal(receipt.verified, true);
  assert.equal(receipt.accepted_basis, "independent_evidence_margin");
  assert.ok((receipt.independent_evidence_margin ?? 0) > 0.2);
  assert.equal(receipt.selected_registration.translation_ft.x, 100);
});

test("registration ambiguity rejects a plausible repeated-module tie", () => {
  const tied = input();
  tied.candidates[1]!.independent_evidence_score = 0.70;
  const receipt = assessExistingConditionsRegistrationAmbiguity(tied);
  assert.equal(receipt.verified, false);
  assert.equal(receipt.accepted_basis, null);
  assert.deepEqual(receipt.blockers, [
    "registration_selection_lacks_decisive_non_repeating_anchor_or_independent_margin"
  ]);
});

test("non-repeating semantic anchors can distinguish repeated modules", () => {
  const anchored = input();
  anchored.candidates[0]!.independent_evidence_score = 0.3;
  anchored.candidates[1]!.independent_evidence_score = 0.29;
  anchored.semantic_anchors = [
    { anchor_id: "corner-a", source: { x: 5, y: 5 }, model: { x: 105, y: 205 }, evidence_role: "unique room corner", evidence_sha256: "c".repeat(64), access_scope: "agent_visible", non_repeating_context: true, target_regions_excluded: true },
    { anchor_id: "shaft-b", source: { x: 80, y: 5 }, model: { x: 180, y: 205 }, evidence_role: "unique shaft outline", evidence_sha256: "d".repeat(64), access_scope: "agent_visible", non_repeating_context: true, target_regions_excluded: true },
    { anchor_id: "stair-c", source: { x: 5, y: 60 }, model: { x: 105, y: 260 }, evidence_role: "unique stair edge", evidence_sha256: "e".repeat(64), access_scope: "agent_visible", non_repeating_context: true, target_regions_excluded: true }
  ];
  const receipt = assessExistingConditionsRegistrationAmbiguity(anchored);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.accepted_basis, "semantic_anchors");
  assert.ok((receipt.semantic_anchor_rms_margin_ft ?? 0) > 30);
});

test("near-duplicate local peaks do not substitute for a distinct alternate module", () => {
  const localOnly = input();
  localOnly.candidates[1]!.registration = registration(100.2, 200.1);
  const receipt = assessExistingConditionsRegistrationAmbiguity(localOnly);
  assert.equal(receipt.verified, false);
  assert.equal(receipt.distinct_candidate_count, 1);
  assert.ok(receipt.blockers.includes("registration_requires_two_materially_distinct_candidate_transforms"));
});

test("candidate evidence must be common, target-excluded, and agent-visible", () => {
  const mixedEvidence = input();
  mixedEvidence.candidates[1]!.evidence_sha256 = "f".repeat(64);
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(mixedEvidence),
    /must_share_one_independent_evidence_set/
  );

  const targetLeaked = input();
  (targetLeaked.candidates[0] as { target_regions_excluded: boolean }).target_regions_excluded = false;
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(targetLeaked),
    /target_regions_excluded|target_regions_must_be_excluded/
  );

  const evaluatorRole = input();
  evaluatorRole.candidates[0]!.evidence_role = "withheld evaluator truth";
  evaluatorRole.candidates[1]!.evidence_role = "withheld evaluator truth";
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(evaluatorRole),
    /must_be_agent_visible_non_target_evidence/
  );

  const separatorBypass = input();
  separatorBypass.candidates[0]!.evidence_role = "ground_truth";
  separatorBypass.candidates[1]!.evidence_role = "ground_truth";
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(separatorBypass),
    /must_be_agent_visible_non_target_evidence/
  );

  const oracleBypass = input();
  oracleBypass.candidates[0]!.evidence_role = "gold oracle";
  oracleBypass.candidates[1]!.evidence_role = "gold oracle";
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(oracleBypass),
    /must_be_agent_visible_non_target_evidence/
  );

  const hiddenScope = input();
  (hiddenScope.candidates[0] as unknown as { access_scope: string }).access_scope = "evaluator_only";
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(hiddenScope),
    /access_scope|must_be_agent_visible/
  );
});

test("selected candidate must be the decisive winner and use a verified source-bound transform", () => {
  const wrongSelection = input();
  wrongSelection.selected_candidate_id = "repeated-module";
  const receipt = assessExistingConditionsRegistrationAmbiguity(wrongSelection);
  assert.equal(receipt.verified, false);

  const wrongSource = input();
  wrongSource.candidates[1]!.registration.source_evidence_sha256 = "c".repeat(64);
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(wrongSource),
    /source_hash_mismatch/
  );

  const permissive = input();
  permissive.candidates[0]!.registration.max_rms_error_ft = 100;
  permissive.candidates[0]!.registration.max_point_error_ft = 100;
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(permissive),
    /tolerance_too_permissive/
  );

  const weakPolicy = input();
  weakPolicy.policy = { minimum_independent_evidence_margin: 0 };
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(weakPolicy),
    /policy_cannot_be_more_permissive/
  );

  const oversized = input();
  oversized.source_bounds.max.x = 10_000_001;
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(oversized),
    /coordinate_out_of_bounds/
  );

  const oversizedControl = input();
  oversizedControl.candidates[0]!.registration.control_points[0]!.model.x = 10_000_001;
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(oversizedControl),
    /coordinate_out_of_bounds/
  );

  const illConditioned = input();
  illConditioned.candidates[0]!.registration.control_points = [
    { source: { x: 0, y: 0 }, model: { x: 100, y: 200 } },
    { source: { x: 0.001, y: 0 }, model: { x: 100.001, y: 200 } },
    { source: { x: 0, y: 0.001 }, model: { x: 100, y: 200.001 } }
  ];
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(illConditioned),
    /control_span_is_ill_conditioned/
  );

  const overflowingTransform = input();
  overflowingTransform.candidates[0]!.registration.control_points = [
    { source: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
    { source: { x: 10, y: 0 }, model: { x: 10_000_000, y: 0 } },
    { source: { x: 0, y: 10 }, model: { x: 0, y: 10_000_000 } }
  ];
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(overflowingTransform),
    /transformed_bounds_invalid/
  );
});

test("semantic anchors require separate evidence and spatially independent coordinates", () => {
  const anchored = input();
  anchored.semantic_anchors = [
    { anchor_id: "a", source: { x: 5, y: 5 }, model: { x: 105, y: 205 }, evidence_role: "unique crop a", evidence_sha256: "c".repeat(64), access_scope: "agent_visible", non_repeating_context: true, target_regions_excluded: true },
    { anchor_id: "b", source: { x: 5.1, y: 5.1 }, model: { x: 105.1, y: 205.1 }, evidence_role: "unique crop b", evidence_sha256: "d".repeat(64), access_scope: "agent_visible", non_repeating_context: true, target_regions_excluded: true },
    { anchor_id: "c", source: { x: 80, y: 60 }, model: { x: 180, y: 260 }, evidence_role: "unique crop c", evidence_sha256: "e".repeat(64), access_scope: "agent_visible", non_repeating_context: true, target_regions_excluded: true }
  ];
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(anchored),
    /semantic_anchor_source_points_are_not_independent/
  );

  anchored.semantic_anchors[1] = {
    ...anchored.semantic_anchors[1]!,
    source: { x: 50, y: 5 },
    model: { x: 150, y: 205 },
    evidence_sha256: anchored.semantic_anchors[0]!.evidence_sha256
  };
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(anchored),
    /semantic_anchors_require_unique_hash_bound_context_evidence/
  );

  anchored.semantic_anchors[0]!.evidence_sha256 = EVIDENCE_HASH;
  anchored.semantic_anchors[1]!.evidence_sha256 = "d".repeat(64);
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(anchored),
    /semantic_anchor_context_must_be_independent_of_candidate_score_evidence/
  );

  anchored.semantic_anchors[0]!.evidence_sha256 = "c".repeat(64);
  anchored.semantic_anchors[0]!.model = { x: 105, y: 205 };
  anchored.semantic_anchors[1]!.model = { x: 150, y: 205.1 };
  anchored.semantic_anchors[2]!.model = { x: 180, y: 205.2 };
  assert.throws(
    () => assessExistingConditionsRegistrationAmbiguity(anchored),
    /semantic_anchor_model_points_must_be_non_collinear/
  );
});

test("registration ambiguity contract rejects properties the runtime command does not own", () => {
  const extra = { ...input(), unexpected_authority: true };
  assert.throws(
    () => assertExistingConditionsContract("registration_ambiguity", extra),
    /must NOT have additional properties/
  );
  assert.throws(
    () => assertExistingConditionsContract("registration_ambiguity", { ...input(), policy: null }),
    /must be object/
  );
});
