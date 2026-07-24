import assert from "node:assert/strict";
import test from "node:test";
import type { ExistingConditionsGroundTruth } from "../src/benchmark/existing_conditions_reconstruction.js";
import type { ArchitecturalOpeningClassificationReceipt } from "../src/existing_conditions/architectural_opening_classification.js";
import { scoreArchitecturalOpeningClassification } from "../src/existing_conditions/architectural_opening_classification_score.js";
import type { ArchitecturalWallLineCandidateReceipt } from "../src/existing_conditions/architectural_wall_line_candidates.js";

const CANDIDATE_HASH = "8".repeat(64);

function truth(roles: Array<{ key: string; role: "door" | "window"; x: number; y: number }>): ExistingConditionsGroundTruth {
  return {
    schema_version: 1,
    fixture_id: "opening-score-v1",
    scope_id: "opening-score-scope",
    discipline: "architectural",
    visible_evidence: [],
    snapshot: {
      native_readback: true,
      elements: roles.map((entry) => ({
        key: entry.key,
        kind: "family_instance",
        discipline: "architectural",
        role: entry.role,
        category: entry.role === "door" ? "Doors" : "Windows",
        location: { x: entry.x, y: entry.y, z: 12 }
      })),
      connections: [],
      open_connector_count: 0
    }
  };
}

function candidates(): ArchitecturalWallLineCandidateReceipt {
  const crops = [
    { id: "opening-alpha", host: "line-random-a", source: "1".repeat(64), overlay: "2".repeat(64) },
    { id: "opening-beta", host: "line-random-b", source: "3".repeat(64), overlay: "4".repeat(64) }
  ];
  return {
    schema_version: 1,
    artifact_role: "architectural_wall_line_candidates",
    fixture_id: "opening-score-v1",
    scope_id: "opening-score-scope",
    opening_gap_hypotheses: [
      {
        opening_hypothesis_id: "opening-alpha",
        host_candidate_id: "line-random-a",
        model_center: { x: 10.1, y: 19.95 }
      },
      {
        opening_hypothesis_id: "opening-beta",
        host_candidate_id: "line-random-b",
        model_center: { x: -4.1, y: 7.1 }
      }
    ],
    opening_evidence_crops: crops.map((entry) => ({
      opening_hypothesis_id: entry.id,
      host_candidate_id: entry.host,
      crop_bounds_px: { min_x: 0, min_y: 0, max_x: 100, max_y: 100 },
      source_crop: { path: `${entry.id}-source.png`, sha256: entry.source, width_px: 100, height_px: 100 },
      evidence_overlay: { path: `${entry.id}-overlay.png`, sha256: entry.overlay, width_px: 100, height_px: 100 }
    }))
  } as unknown as ArchitecturalWallLineCandidateReceipt;
}

function classification(
  first: "door" | "window" | "unknown" = "door",
  second: "door" | "window" | "unknown" = "window"
): ArchitecturalOpeningClassificationReceipt {
  const cue = (value: "door" | "window" | "unknown") => value === "door"
    ? ["swing_arc" as const]
    : value === "window"
      ? ["parallel_glazing_lines" as const]
      : ["insufficient_symbol" as const];
  return {
    schema_version: 1,
    artifact_role: "architectural_opening_classification",
    fixture_id: "opening-score-v1",
    scope_id: "opening-score-scope",
    candidate_receipt_sha256: CANDIDATE_HASH,
    status: first === "unknown" || second === "unknown" ? "clarification_required" : "classified",
    classifications: [
      {
        opening_hypothesis_id: "opening-alpha",
        host_candidate_id: "line-random-a",
        classification: first,
        confidence: first === "unknown" ? 0.4 : 0.9,
        cues: cue(first),
        evidence_artifact_sha256s: ["1".repeat(64), "2".repeat(64)],
        rationale: "Identity-independent source symbol evidence.",
        selected_host_candidate_id: null
      },
      {
        opening_hypothesis_id: "opening-beta",
        host_candidate_id: "line-random-b",
        classification: second,
        confidence: second === "unknown" ? 0.4 : 0.9,
        cues: cue(second),
        evidence_artifact_sha256s: ["3".repeat(64), "4".repeat(64)],
        rationale: "Identity-independent source symbol evidence.",
        selected_host_candidate_id: null
      }
    ],
    native_write: false
  };
}

test("opening classification scorer accepts identity-perturbed door and window centers", () => {
  const score = scoreArchitecturalOpeningClassification(
    truth([
      { key: "truth-unrelated-91", role: "door", x: 10, y: 20 },
      { key: "truth-unrelated-37", role: "window", x: -4, y: 7 }
    ]),
    candidates(),
    CANDIDATE_HASH,
    classification()
  );
  assert.equal(score.passed, true);
  assert.equal(score.counts.matched, 2);
  assert.equal(score.metrics.precision, 1);
  assert.equal(score.metrics.recall, 1);
  assert.equal(score.promotion_allowed, false);
  assert.ok(score.promotion_blockers.includes("opening_host_selection_not_proven"));
});

test("opening classification scorer rejects a plausible location with the wrong role", () => {
  const score = scoreArchitecturalOpeningClassification(
    truth([
      { key: "truth-door", role: "door", x: 10, y: 20 },
      { key: "truth-window", role: "window", x: -4, y: 7 }
    ]),
    candidates(),
    CANDIDATE_HASH,
    classification("window", "window")
  );
  assert.equal(score.passed, false);
  assert.equal(score.counts.matched, 1);
  assert.equal(score.counts.missed, 1);
  assert.equal(score.counts.false_positive, 1);
  assert.ok(score.failure_classifications.includes("opening_false_positive"));
});

test("opening classification scorer preserves an occluded unknown as unresolved rather than a false positive", () => {
  const score = scoreArchitecturalOpeningClassification(
    truth([
      { key: "truth-door", role: "door", x: 10, y: 20 },
      { key: "truth-window", role: "window", x: -4, y: 7 }
    ]),
    candidates(),
    CANDIDATE_HASH,
    classification("unknown", "window")
  );
  assert.equal(score.passed, false);
  assert.equal(score.counts.unresolved_predictions, 1);
  assert.equal(score.counts.false_positive, 0);
  assert.equal(score.counts.missed, 1);
  assert.ok(score.failure_classifications.includes("opening_classification_unresolved"));
});
