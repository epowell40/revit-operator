import type {
  ExistingConditionsElement,
  ExistingConditionsGroundTruth
} from "../benchmark/existing_conditions_reconstruction.js";
import {
  validateArchitecturalOpeningClassification,
  type ArchitecturalOpeningClassificationReceipt
} from "./architectural_opening_classification.js";
import type { ArchitecturalWallLineCandidateReceipt } from "./architectural_wall_line_candidates.js";

export type ArchitecturalOpeningClassificationScoringPolicy = {
  opening_location_tolerance_ft: number;
  minimum_classification_confidence: number;
  minimum_precision: number;
  minimum_recall: number;
  passing_score: number;
};

export const DEFAULT_ARCHITECTURAL_OPENING_CLASSIFICATION_SCORING_POLICY: ArchitecturalOpeningClassificationScoringPolicy = {
  opening_location_tolerance_ft: 1,
  minimum_classification_confidence: 0.75,
  minimum_precision: 0.8,
  minimum_recall: 0.8,
  passing_score: 85
};

export type ArchitecturalOpeningClassificationScore = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  passed: boolean;
  score: number;
  failure_classifications: string[];
  policy: ArchitecturalOpeningClassificationScoringPolicy;
  counts: {
    truth_openings: number;
    classified_predictions: number;
    unresolved_predictions: number;
    matched: number;
    missed: number;
    false_positive: number;
  };
  metrics: {
    precision: number;
    recall: number;
    element_f1: number;
    geometry: number;
  };
  matched_pairs: Array<{
    truth_key: string;
    opening_hypothesis_id: string;
    role: "door" | "window";
    distance_ft: number;
    geometry_score: number;
  }>;
  missed_truth_keys: string[];
  false_positive_opening_hypothesis_ids: string[];
  unresolved_opening_hypothesis_ids: string[];
  promotion_allowed: false;
  promotion_blockers: string[];
};

function normalizedRole(element: ExistingConditionsElement): "door" | "window" | null {
  const role = String(element.role ?? "").trim().toLowerCase();
  return role === "door" || role === "window" ? role : null;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function f1(precision: number, recall: number): number {
  return precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
}

export function scoreArchitecturalOpeningClassification(
  truth: ExistingConditionsGroundTruth,
  candidates: ArchitecturalWallLineCandidateReceipt,
  candidateReceiptSha256: string,
  classification: ArchitecturalOpeningClassificationReceipt,
  policy: ArchitecturalOpeningClassificationScoringPolicy = DEFAULT_ARCHITECTURAL_OPENING_CLASSIFICATION_SCORING_POLICY
): ArchitecturalOpeningClassificationScore {
  if (truth.fixture_id !== candidates.fixture_id || truth.scope_id !== candidates.scope_id) {
    throw new Error("architectural_opening_score_fixture_or_scope_mismatch");
  }
  validateArchitecturalOpeningClassification(
    classification,
    candidates,
    candidateReceiptSha256,
    policy.minimum_classification_confidence
  );
  const truthOpenings = truth.snapshot.elements.filter((element) => normalizedRole(element) !== null && element.location);
  const openingById = new Map(candidates.opening_gap_hypotheses.map((opening) => [opening.opening_hypothesis_id, opening]));
  const unresolved = classification.classifications.filter((entry) => entry.classification === "unknown");
  const predicted = classification.classifications.flatMap((entry) => {
    if (entry.classification === "unknown" || entry.confidence < policy.minimum_classification_confidence) return [];
    const opening = openingById.get(entry.opening_hypothesis_id);
    if (!opening) return [];
    return [{ entry, opening }];
  });
  const possible = truthOpenings.flatMap((truthElement) => predicted.flatMap((prediction) => {
    const truthRole = normalizedRole(truthElement);
    if (!truthRole || truthRole !== prediction.entry.classification || !truthElement.location) return [];
    const distance = Math.hypot(
      truthElement.location.x - prediction.opening.model_center.x,
      truthElement.location.y - prediction.opening.model_center.y
    );
    if (distance > policy.opening_location_tolerance_ft) return [];
    return [{
      truth_key: truthElement.key,
      opening_hypothesis_id: prediction.entry.opening_hypothesis_id,
      role: truthRole,
      distance_ft: round(distance),
      geometry_score: round(Math.max(0, 1 - distance / policy.opening_location_tolerance_ft))
    }];
  })).sort((a, b) => a.distance_ft - b.distance_ft
    || a.truth_key.localeCompare(b.truth_key)
    || a.opening_hypothesis_id.localeCompare(b.opening_hypothesis_id));
  const usedTruth = new Set<string>();
  const usedPredictions = new Set<string>();
  const matchedPairs = possible.filter((pair) => {
    if (usedTruth.has(pair.truth_key) || usedPredictions.has(pair.opening_hypothesis_id)) return false;
    usedTruth.add(pair.truth_key);
    usedPredictions.add(pair.opening_hypothesis_id);
    return true;
  });
  const missedTruthKeys = truthOpenings.map((entry) => entry.key).filter((key) => !usedTruth.has(key));
  const falsePositiveIds = predicted.map((entry) => entry.entry.opening_hypothesis_id)
    .filter((id) => !usedPredictions.has(id));
  const precision = predicted.length === 0 ? (truthOpenings.length === 0 ? 1 : 0) : matchedPairs.length / predicted.length;
  const recall = truthOpenings.length === 0 ? (predicted.length === 0 ? 1 : 0) : matchedPairs.length / truthOpenings.length;
  const elementF1 = f1(precision, recall);
  const geometry = matchedPairs.length > 0
    ? matchedPairs.reduce((sum, pair) => sum + pair.geometry_score, 0) / matchedPairs.length
    : 0;
  const score = 100 * (0.7 * elementF1 + 0.3 * geometry);
  const failures: string[] = [];
  if (classification.status !== "classified") failures.push("opening_classification_incomplete");
  if (unresolved.length > 0) failures.push("opening_classification_unresolved");
  if (missedTruthKeys.length > 0) failures.push("opening_truth_missed");
  if (falsePositiveIds.length > 0) failures.push("opening_false_positive");
  if (precision < policy.minimum_precision) failures.push("opening_classification_precision_below_threshold");
  if (recall < policy.minimum_recall) failures.push("opening_classification_recall_below_threshold");
  if (score < policy.passing_score) failures.push("opening_classification_score_below_threshold");
  return {
    schema_version: 1,
    fixture_id: truth.fixture_id,
    scope_id: truth.scope_id,
    passed: failures.length === 0,
    score: round(score),
    failure_classifications: failures,
    policy: { ...policy },
    counts: {
      truth_openings: truthOpenings.length,
      classified_predictions: predicted.length,
      unresolved_predictions: unresolved.length,
      matched: matchedPairs.length,
      missed: missedTruthKeys.length,
      false_positive: falsePositiveIds.length
    },
    metrics: {
      precision: round(precision),
      recall: round(recall),
      element_f1: round(elementF1),
      geometry: round(geometry)
    },
    matched_pairs: matchedPairs,
    missed_truth_keys: missedTruthKeys,
    false_positive_opening_hypothesis_ids: falsePositiveIds,
    unresolved_opening_hypothesis_ids: unresolved.map((entry) => entry.opening_hypothesis_id),
    promotion_allowed: false,
    promotion_blockers: [
      "wall_candidate_selection_not_proven",
      "opening_host_selection_not_proven",
      "family_type_and_vertical_parameters_not_proven"
    ]
  };
}
