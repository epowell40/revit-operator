import type {
  ExistingConditionsElement,
  ExistingConditionsGroundTruth
} from "../benchmark/existing_conditions_reconstruction.js";
import {
  validateArchitecturalOpeningHostResolution,
  type ArchitecturalOpeningHostResolutionReceipt
} from "./architectural_opening_host_resolution.js";
import type { ArchitecturalOpeningClassificationReceipt } from "./architectural_opening_classification.js";
import type { ArchitecturalWallLineCandidateReceipt } from "./architectural_wall_line_candidates.js";

type Point2 = { x: number; y: number };

export type ArchitecturalOpeningHostResolutionScoringPolicy = {
  wall_endpoint_tolerance_ft: number;
  opening_location_tolerance_ft: number;
  minimum_wall_precision: number;
  minimum_wall_recall: number;
  minimum_opening_precision: number;
  minimum_opening_recall: number;
  minimum_hosting_score: number;
  passing_score: number;
};

export const DEFAULT_ARCHITECTURAL_OPENING_HOST_RESOLUTION_SCORING_POLICY: ArchitecturalOpeningHostResolutionScoringPolicy = {
  wall_endpoint_tolerance_ft: 0.5,
  opening_location_tolerance_ft: 1,
  minimum_wall_precision: 0.8,
  minimum_wall_recall: 0.8,
  minimum_opening_precision: 0.8,
  minimum_opening_recall: 0.8,
  minimum_hosting_score: 1,
  passing_score: 85
};

export type ArchitecturalOpeningHostResolutionScore = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  passed: boolean;
  score: number;
  failure_classifications: string[];
  policy: ArchitecturalOpeningHostResolutionScoringPolicy;
  counts: {
    truth_host_walls: number;
    predicted_host_walls: number;
    matched_host_walls: number;
    missed_host_walls: number;
    false_positive_host_walls: number;
    truth_openings: number;
    predicted_openings: number;
    matched_openings: number;
    missed_openings: number;
    false_positive_openings: number;
  };
  metrics: {
    wall_precision: number;
    wall_recall: number;
    wall_element_f1: number;
    wall_geometry: number;
    opening_precision: number;
    opening_recall: number;
    opening_element_f1: number;
    opening_geometry: number;
    hosting: number;
  };
  wall_matches: Array<{
    selected_host_candidate_id: string;
    truth_wall_key: string;
    maximum_endpoint_error_ft: number;
    geometry_score: number;
  }>;
  opening_matches: Array<{
    opening_hypothesis_id: string;
    truth_opening_key: string;
    role: "door" | "window";
    location_error_ft: number;
    geometry_score: number;
    expected_truth_host_key: string | null;
    matched_truth_host_key: string | null;
    hosting_ok: boolean;
  }>;
  promotion_allowed: false;
  promotion_blockers: string[];
};

function round(value: number): number {
  return Number(value.toFixed(6));
}

function role(element: ExistingConditionsElement): "wall" | "door" | "window" | null {
  const value = String(element.role ?? "").trim().toLowerCase();
  return value === "wall" || value === "door" || value === "window" ? value : null;
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function endpointError(predicted: [Point2, Point2], truth: [Point2, Point2]): number {
  const direct = Math.max(distance(predicted[0], truth[0]), distance(predicted[1], truth[1]));
  const reverse = Math.max(distance(predicted[0], truth[1]), distance(predicted[1], truth[0]));
  return Math.min(direct, reverse);
}

function f1(precision: number, recall: number): number {
  return precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
}

function ratio(matches: number, total: number, emptyValue: number): number {
  return total === 0 ? emptyValue : matches / total;
}

function validatePolicy(policy: ArchitecturalOpeningHostResolutionScoringPolicy): void {
  if (!Number.isFinite(policy.wall_endpoint_tolerance_ft) || policy.wall_endpoint_tolerance_ft <= 0
    || !Number.isFinite(policy.opening_location_tolerance_ft) || policy.opening_location_tolerance_ft <= 0
    || !Number.isFinite(policy.passing_score) || policy.passing_score < 0 || policy.passing_score > 100) {
    throw new Error("architectural_opening_host_resolution_scoring_policy_invalid");
  }
  const fractions = [
    policy.minimum_wall_precision,
    policy.minimum_wall_recall,
    policy.minimum_opening_precision,
    policy.minimum_opening_recall,
    policy.minimum_hosting_score
  ];
  if (fractions.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("architectural_opening_host_resolution_scoring_fraction_invalid");
  }
}

export function scoreArchitecturalOpeningHostResolution(
  truth: ExistingConditionsGroundTruth,
  candidates: ArchitecturalWallLineCandidateReceipt,
  candidateReceiptSha256: string,
  classifications: ArchitecturalOpeningClassificationReceipt,
  classificationReceiptSha256: string,
  resolution: ArchitecturalOpeningHostResolutionReceipt,
  policy: ArchitecturalOpeningHostResolutionScoringPolicy = DEFAULT_ARCHITECTURAL_OPENING_HOST_RESOLUTION_SCORING_POLICY
): ArchitecturalOpeningHostResolutionScore {
  validatePolicy(policy);
  validateArchitecturalOpeningHostResolution(
    resolution,
    candidates,
    candidateReceiptSha256,
    classifications,
    classificationReceiptSha256
  );
  if (truth.fixture_id !== resolution.fixture_id || truth.scope_id !== resolution.scope_id) {
    throw new Error("architectural_opening_host_resolution_score_fixture_or_scope_mismatch");
  }
  const truthOpenings = truth.snapshot.elements.filter((element) => {
    const elementRole = role(element);
    return (elementRole === "door" || elementRole === "window") && element.location;
  });
  const truthHostKeys = new Set(truthOpenings.map((element) => element.host_key).filter((value): value is string => Boolean(value)));
  const truthHostWalls = truth.snapshot.elements.filter((element) => role(element) === "wall"
    && truthHostKeys.has(element.key)
    && Array.isArray(element.endpoints)
    && element.endpoints.length === 2);
  const resolvedEntries = resolution.resolutions.filter((entry) => entry.selected_host_candidate_id
    && entry.refined_host_model_points
    && entry.classification !== "unknown");
  const predictedHostWalls = [...new Map(resolvedEntries.map((entry) => [entry.selected_host_candidate_id!, {
    candidate_id: entry.selected_host_candidate_id!,
    points: entry.refined_host_model_points!
  }])).values()];
  const wallPossibilities = truthHostWalls.flatMap((truthWall) => predictedHostWalls.flatMap((predictedWall) => {
    const truthPoints = truthWall.endpoints as Array<{ x: number; y: number }>;
    const error = endpointError(predictedWall.points, [truthPoints[0]!, truthPoints[1]!]);
    if (error > policy.wall_endpoint_tolerance_ft) return [];
    return [{
      selected_host_candidate_id: predictedWall.candidate_id,
      truth_wall_key: truthWall.key,
      maximum_endpoint_error_ft: round(error),
      geometry_score: round(Math.max(0, 1 - error / policy.wall_endpoint_tolerance_ft))
    }];
  })).sort((a, b) => a.maximum_endpoint_error_ft - b.maximum_endpoint_error_ft
    || a.truth_wall_key.localeCompare(b.truth_wall_key)
    || a.selected_host_candidate_id.localeCompare(b.selected_host_candidate_id));
  const usedTruthWalls = new Set<string>();
  const usedPredictedWalls = new Set<string>();
  const wallMatches = wallPossibilities.filter((pair) => {
    if (usedTruthWalls.has(pair.truth_wall_key) || usedPredictedWalls.has(pair.selected_host_candidate_id)) return false;
    usedTruthWalls.add(pair.truth_wall_key);
    usedPredictedWalls.add(pair.selected_host_candidate_id);
    return true;
  });
  const hostTruthByCandidate = new Map(wallMatches.map((entry) => [entry.selected_host_candidate_id, entry.truth_wall_key]));
  const openingPossibilities = truthOpenings.flatMap((truthOpening) => resolvedEntries.flatMap((prediction) => {
    if (role(truthOpening) !== prediction.classification || !truthOpening.location) return [];
    const error = distance(prediction.opening_model_center, truthOpening.location);
    if (error > policy.opening_location_tolerance_ft) return [];
    const matchedTruthHostKey = hostTruthByCandidate.get(prediction.selected_host_candidate_id!) ?? null;
    const expectedTruthHostKey = truthOpening.host_key ?? null;
    return [{
      opening_hypothesis_id: prediction.opening_hypothesis_id,
      truth_opening_key: truthOpening.key,
      role: prediction.classification as "door" | "window",
      location_error_ft: round(error),
      geometry_score: round(Math.max(0, 1 - error / policy.opening_location_tolerance_ft)),
      expected_truth_host_key: expectedTruthHostKey,
      matched_truth_host_key: matchedTruthHostKey,
      hosting_ok: expectedTruthHostKey !== null && matchedTruthHostKey === expectedTruthHostKey
    }];
  })).sort((a, b) => a.location_error_ft - b.location_error_ft
    || a.truth_opening_key.localeCompare(b.truth_opening_key)
    || a.opening_hypothesis_id.localeCompare(b.opening_hypothesis_id));
  const usedTruthOpenings = new Set<string>();
  const usedPredictedOpenings = new Set<string>();
  const openingMatches = openingPossibilities.filter((pair) => {
    if (usedTruthOpenings.has(pair.truth_opening_key) || usedPredictedOpenings.has(pair.opening_hypothesis_id)) return false;
    usedTruthOpenings.add(pair.truth_opening_key);
    usedPredictedOpenings.add(pair.opening_hypothesis_id);
    return true;
  });
  const wallPrecision = ratio(wallMatches.length, predictedHostWalls.length, truthHostWalls.length === 0 ? 1 : 0);
  const wallRecall = ratio(wallMatches.length, truthHostWalls.length, predictedHostWalls.length === 0 ? 1 : 0);
  const openingPrecision = ratio(openingMatches.length, resolvedEntries.length, truthOpenings.length === 0 ? 1 : 0);
  const openingRecall = ratio(openingMatches.length, truthOpenings.length, resolvedEntries.length === 0 ? 1 : 0);
  const wallGeometry = wallMatches.length > 0
    ? wallMatches.reduce((sum, entry) => sum + entry.geometry_score, 0) / wallMatches.length
    : 0;
  const openingGeometry = openingMatches.length > 0
    ? openingMatches.reduce((sum, entry) => sum + entry.geometry_score, 0) / openingMatches.length
    : 0;
  const hosting = openingMatches.length > 0
    ? openingMatches.filter((entry) => entry.hosting_ok).length / openingMatches.length
    : 0;
  const wallElementF1 = f1(wallPrecision, wallRecall);
  const openingElementF1 = f1(openingPrecision, openingRecall);
  const score = 100 * (0.3 * wallElementF1
    + 0.2 * wallGeometry
    + 0.25 * openingElementF1
    + 0.15 * openingGeometry
    + 0.1 * hosting);
  const failures: string[] = [];
  if (resolution.status !== "resolved") failures.push("opening_host_resolution_incomplete");
  if (resolution.resolutions.some((entry) => entry.blockers.length > 0)) failures.push("opening_host_resolution_has_blockers");
  if (wallMatches.length < truthHostWalls.length) failures.push("opening_host_wall_missed");
  if (wallMatches.length < predictedHostWalls.length) failures.push("opening_host_wall_false_positive");
  if (openingMatches.length < truthOpenings.length) failures.push("opening_truth_missed");
  if (openingMatches.length < resolvedEntries.length) failures.push("opening_false_positive");
  if (wallPrecision < policy.minimum_wall_precision) failures.push("opening_host_wall_precision_below_threshold");
  if (wallRecall < policy.minimum_wall_recall) failures.push("opening_host_wall_recall_below_threshold");
  if (openingPrecision < policy.minimum_opening_precision) failures.push("opening_precision_below_threshold");
  if (openingRecall < policy.minimum_opening_recall) failures.push("opening_recall_below_threshold");
  if (hosting < policy.minimum_hosting_score) failures.push("opening_host_relationship_incorrect");
  if (score < policy.passing_score) failures.push("opening_host_resolution_score_below_threshold");
  return {
    schema_version: 1,
    fixture_id: truth.fixture_id,
    scope_id: truth.scope_id,
    passed: failures.length === 0,
    score: round(score),
    failure_classifications: failures,
    policy: { ...policy },
    counts: {
      truth_host_walls: truthHostWalls.length,
      predicted_host_walls: predictedHostWalls.length,
      matched_host_walls: wallMatches.length,
      missed_host_walls: truthHostWalls.length - wallMatches.length,
      false_positive_host_walls: predictedHostWalls.length - wallMatches.length,
      truth_openings: truthOpenings.length,
      predicted_openings: resolvedEntries.length,
      matched_openings: openingMatches.length,
      missed_openings: truthOpenings.length - openingMatches.length,
      false_positive_openings: resolvedEntries.length - openingMatches.length
    },
    metrics: {
      wall_precision: round(wallPrecision),
      wall_recall: round(wallRecall),
      wall_element_f1: round(wallElementF1),
      wall_geometry: round(wallGeometry),
      opening_precision: round(openingPrecision),
      opening_recall: round(openingRecall),
      opening_element_f1: round(openingElementF1),
      opening_geometry: round(openingGeometry),
      hosting: round(hosting)
    },
    wall_matches: wallMatches,
    opening_matches: openingMatches,
    promotion_allowed: false,
    promotion_blockers: [
      "independent_holdout_host_resolution_not_proven",
      "family_type_and_vertical_parameters_not_proven"
    ]
  };
}
