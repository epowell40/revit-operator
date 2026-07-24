import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSheetTopologyCalibrationProfileV1,
  type SheetTopologyBlindOutcomeV1
} from "../src/existing_conditions/sheet_topology_calibration.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function outcome(
  predictionId: string,
  fixtureId: string,
  rawConfidence: number,
  correct: boolean
): SheetTopologyBlindOutcomeV1 {
  return {
    prediction_id: predictionId,
    fixture_id: fixtureId,
    discipline: "mechanical",
    primitive_kind: "route_segment",
    raw_confidence: rawConfidence,
    correct,
    candidate_sha256: HASH_A,
    evaluator_receipt_sha256: HASH_B,
    candidate_sealed_at_utc: "2026-07-01T12:00:00.000Z",
    evaluated_at_utc: "2026-07-01T12:05:00.000Z",
    truth_revealed_after_candidate_seal: true
  };
}

test("calibration profile is derived deterministically from sealed blind outcomes", () => {
  const input = {
    schema_version: 1 as const,
    profile_id: "blind-mep-v1",
    confidence_bin_edges: [0, 0.8, 0.9, 1],
    outcomes: [
      outcome("p-3", "fixture-c", 0.95, true),
      outcome("p-1", "fixture-a", 0.92, true),
      outcome("p-2", "fixture-b", 0.91, false),
      outcome("p-4", "fixture-a", 0.85, true)
    ]
  };
  const first = buildSheetTopologyCalibrationProfileV1(input);
  const second = buildSheetTopologyCalibrationProfileV1({ ...input, outcomes: [...input.outcomes].reverse() });

  assert.deepEqual(first, second);
  assert.equal(first.provenance.prediction_count, 4);
  assert.equal(first.provenance.fixture_count, 3);
  assert.deepEqual(first.provenance.evaluator_receipt_sha256s, [HASH_B]);
  assert.deepEqual(first.bins, [
    {
      discipline: "mechanical",
      primitive_kind: "route_segment",
      raw_confidence_min: 0.8,
      raw_confidence_max: 0.9,
      trials: 1,
      successes: 1,
      fixture_count: 1
    },
    {
      discipline: "mechanical",
      primitive_kind: "route_segment",
      raw_confidence_min: 0.9,
      raw_confidence_max: 1,
      trials: 3,
      successes: 2,
      fixture_count: 3
    }
  ]);
});

test("truth exposure before candidate sealing is rejected", () => {
  const invalid = outcome("leaked", "fixture-a", 0.99, true);
  invalid.evaluated_at_utc = "2026-07-01T11:59:00.000Z";

  assert.throws(
    () => buildSheetTopologyCalibrationProfileV1({
      schema_version: 1,
      profile_id: "invalid",
      confidence_bin_edges: [0, 1],
      outcomes: [invalid]
    }),
    /sheet_topology_outcome_not_blind_and_sealed:leaked/
  );
});

test("duplicate prediction receipts cannot inflate calibration support", () => {
  const duplicate = outcome("same", "fixture-a", 0.99, true);
  assert.throws(
    () => buildSheetTopologyCalibrationProfileV1({
      schema_version: 1,
      profile_id: "invalid",
      confidence_bin_edges: [0, 1],
      outcomes: [duplicate, { ...duplicate }]
    }),
    /sheet_topology_calibration_duplicate_prediction:same/
  );
});
