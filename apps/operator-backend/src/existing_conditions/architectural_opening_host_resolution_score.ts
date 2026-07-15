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
  wall_axis_tolerance_degrees: number;
  minimum_wall_truth_coverage: number;
  minimum_wall_prediction_overlap: number;
  opening_location_tolerance_ft: number;
  opening_width_tolerance_ft: number;
  minimum_wall_precision: number;
  minimum_wall_recall: number;
  minimum_opening_precision: number;
  minimum_opening_recall: number;
  minimum_hosting_score: number;
  passing_score: number;
};

export const DEFAULT_ARCHITECTURAL_OPENING_HOST_RESOLUTION_SCORING_POLICY: ArchitecturalOpeningHostResolutionScoringPolicy = {
  wall_endpoint_tolerance_ft: 0.5,
  wall_axis_tolerance_degrees: 5,
  minimum_wall_truth_coverage: 0.9,
  minimum_wall_prediction_overlap: 0.6,
  opening_location_tolerance_ft: 1,
  opening_width_tolerance_ft: 0.5,
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
    matching_basis: "endpoint" | "collinear_overlap";
    maximum_endpoint_error_ft: number;
    axis_error_degrees: number;
    perpendicular_offset_ft: number;
    truth_coverage: number;
    prediction_overlap: number;
    geometry_score: number;
    truth_scope_clipped: boolean;
  }>;
  opening_matches: Array<{
    opening_hypothesis_id: string;
    truth_opening_key: string;
    role: "door" | "window";
    location_error_ft: number;
    predicted_width_ft: number;
    truth_width_ft: number | null;
    width_error_ft: number | null;
    width_score: number | null;
    width_scored: boolean;
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

function segmentLength(points: [Point2, Point2]): number {
  return distance(points[0], points[1]);
}

function clipSegmentToBounds(
  segment: [Point2, Point2],
  bounds: ArchitecturalWallLineCandidateReceipt["scope_model_bounds"]
): [Point2, Point2] | null {
  if (!bounds) return segment;
  const dx = segment[1].x - segment[0].x;
  const dy = segment[1].y - segment[0].y;
  const p = [-dx, dx, -dy, dy];
  const q = [
    segment[0].x - bounds.min.x,
    bounds.max.x - segment[0].x,
    segment[0].y - bounds.min.y,
    bounds.max.y - segment[0].y
  ];
  let minimum = 0;
  let maximum = 1;
  for (let index = 0; index < p.length; index += 1) {
    const denominator = p[index]!;
    const numerator = q[index]!;
    if (Math.abs(denominator) <= Number.EPSILON) {
      if (numerator < 0) return null;
      continue;
    }
    const ratio = numerator / denominator;
    if (denominator < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return null;
  }
  return [
    { x: segment[0].x + minimum * dx, y: segment[0].y + minimum * dy },
    { x: segment[0].x + maximum * dx, y: segment[0].y + maximum * dy }
  ];
}

function segmentMatch(
  predicted: [Point2, Point2],
  truth: [Point2, Point2],
  policy: ArchitecturalOpeningHostResolutionScoringPolicy
): {
  matching_basis: "endpoint" | "collinear_overlap";
  maximum_endpoint_error_ft: number;
  axis_error_degrees: number;
  perpendicular_offset_ft: number;
  truth_coverage: number;
  prediction_overlap: number;
  geometry_score: number;
} | null {
  const endpoint = endpointError(predicted, truth);
  const truthDx = truth[1].x - truth[0].x;
  const truthDy = truth[1].y - truth[0].y;
  const truthLength = segmentLength(truth);
  const predictedLength = segmentLength(predicted);
  if (truthLength <= Number.EPSILON || predictedLength <= Number.EPSILON) return null;
  const unit = { x: truthDx / truthLength, y: truthDy / truthLength };
  const predictedUnit = {
    x: (predicted[1].x - predicted[0].x) / predictedLength,
    y: (predicted[1].y - predicted[0].y) / predictedLength
  };
  const axisCosine = Math.min(1, Math.abs(unit.x * predictedUnit.x + unit.y * predictedUnit.y));
  const axisError = Math.acos(axisCosine) * 180 / Math.PI;
  const predictedMidpoint = {
    x: (predicted[0].x + predicted[1].x) / 2,
    y: (predicted[0].y + predicted[1].y) / 2
  };
  const perpendicularOffset = Math.abs(
    (predictedMidpoint.x - truth[0].x) * -unit.y
    + (predictedMidpoint.y - truth[0].y) * unit.x
  );
  const project = (point: Point2): number => (point.x - truth[0].x) * unit.x + (point.y - truth[0].y) * unit.y;
  const predictedProjections = predicted.map(project) as [number, number];
  const predictedMinimum = Math.min(...predictedProjections);
  const predictedMaximum = Math.max(...predictedProjections);
  const overlap = Math.max(0, Math.min(truthLength, predictedMaximum) - Math.max(0, predictedMinimum));
  const truthCoverage = overlap / truthLength;
  const predictionOverlap = overlap / predictedLength;
  if (endpoint <= policy.wall_endpoint_tolerance_ft) {
    return {
      matching_basis: "endpoint",
      maximum_endpoint_error_ft: round(endpoint),
      axis_error_degrees: round(axisError),
      perpendicular_offset_ft: round(perpendicularOffset),
      truth_coverage: round(truthCoverage),
      prediction_overlap: round(predictionOverlap),
      geometry_score: round(Math.max(0, 1 - endpoint / policy.wall_endpoint_tolerance_ft))
    };
  }
  if (axisError > policy.wall_axis_tolerance_degrees
    || perpendicularOffset > policy.wall_endpoint_tolerance_ft
    || truthCoverage < policy.minimum_wall_truth_coverage
    || predictionOverlap < policy.minimum_wall_prediction_overlap) return null;
  const overlapF1 = f1(predictionOverlap, truthCoverage);
  const offsetScore = Math.max(0, 1 - perpendicularOffset / policy.wall_endpoint_tolerance_ft);
  return {
    matching_basis: "collinear_overlap",
    maximum_endpoint_error_ft: round(endpoint),
    axis_error_degrees: round(axisError),
    perpendicular_offset_ft: round(perpendicularOffset),
    truth_coverage: round(truthCoverage),
    prediction_overlap: round(predictionOverlap),
    geometry_score: round(overlapF1 * offsetScore)
  };
}

function f1(precision: number, recall: number): number {
  return precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
}

function ratio(matches: number, total: number, emptyValue: number): number {
  return total === 0 ? emptyValue : matches / total;
}

function numericToken(value: string): number | null {
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(normalized);
  if (mixed) {
    const denominator = Number(mixed[3]);
    return denominator > 0 ? Number(mixed[1]) + Number(mixed[2]) / denominator : null;
  }
  const fraction = /^(\d+)\/(\d+)$/.exec(normalized);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator > 0 ? Number(fraction[1]) / denominator : null;
  }
  return null;
}

function architecturalOpeningWidthFt(element: ExistingConditionsElement): number | null {
  const nativeWidth = element.size?.width_ft;
  if (typeof nativeWidth === "number" && Number.isFinite(nativeWidth) && nativeWidth > 0) return nativeWidth;
  const parameterWidth = element.parameters?.width;
  if (typeof parameterWidth === "number") {
    return Number.isFinite(parameterWidth) && parameterWidth > 0 ? parameterWidth : null;
  }
  if (typeof parameterWidth !== "string") return null;
  const normalized = parameterWidth.trim()
    .replace(/[′’]/g, "'")
    .replace(/[″]/g, "\"")
    .replace(/\b(?:feet|foot|ft)\b/gi, "'")
    .replace(/\b(?:inches|inch|in)\b/gi, "\"");
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const value = Number(normalized);
    return value > 0 ? value : null;
  }
  const match = /^(?:(\d+(?:\.\d+)?)\s*')?\s*(?:-\s*)?(?:(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*\")?$/.exec(normalized);
  if (!match || (!match[1] && !match[2])) return null;
  const feet = match[1] ? Number(match[1]) : 0;
  const inches = match[2] ? numericToken(match[2]) : 0;
  if (!Number.isFinite(feet) || inches === null || inches < 0 || (match[1] !== undefined && inches >= 12)) return null;
  const value = feet + inches / 12;
  return value > 0 ? value : null;
}

function validatePolicy(policy: ArchitecturalOpeningHostResolutionScoringPolicy): void {
  if (!Number.isFinite(policy.wall_endpoint_tolerance_ft) || policy.wall_endpoint_tolerance_ft <= 0
    || !Number.isFinite(policy.wall_axis_tolerance_degrees) || policy.wall_axis_tolerance_degrees <= 0 || policy.wall_axis_tolerance_degrees > 45
    || !Number.isFinite(policy.opening_location_tolerance_ft) || policy.opening_location_tolerance_ft <= 0
    || !Number.isFinite(policy.opening_width_tolerance_ft) || policy.opening_width_tolerance_ft <= 0
    || !Number.isFinite(policy.passing_score) || policy.passing_score < 0 || policy.passing_score > 100) {
    throw new Error("architectural_opening_host_resolution_scoring_policy_invalid");
  }
  const fractions = [
    policy.minimum_wall_precision,
    policy.minimum_wall_recall,
    policy.minimum_wall_truth_coverage,
    policy.minimum_wall_prediction_overlap,
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
    const originalTruth: [Point2, Point2] = [truthPoints[0]!, truthPoints[1]!];
    const scopedTruth = clipSegmentToBounds(originalTruth, candidates.scope_model_bounds);
    if (!scopedTruth) return [];
    const match = segmentMatch(predictedWall.points, scopedTruth, policy);
    if (!match) return [];
    return [{
      selected_host_candidate_id: predictedWall.candidate_id,
      truth_wall_key: truthWall.key,
      truth_scope_clipped: segmentLength(scopedTruth) + 1e-6 < segmentLength(originalTruth),
      ...match
    }];
  })).sort((a, b) => b.geometry_score - a.geometry_score
    || a.maximum_endpoint_error_ft - b.maximum_endpoint_error_ft
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
  const predictedOpeningById = new Map(candidates.opening_gap_hypotheses.map((entry) => [entry.opening_hypothesis_id, entry]));
  const openingPossibilities = truthOpenings.flatMap((truthOpening) => resolvedEntries.flatMap((prediction) => {
    if (role(truthOpening) !== prediction.classification || !truthOpening.location) return [];
    const error = distance(prediction.opening_model_center, truthOpening.location);
    if (error > policy.opening_location_tolerance_ft) return [];
    const predictedOpening = predictedOpeningById.get(prediction.opening_hypothesis_id);
    if (!predictedOpening) return [];
    const truthWidth = architecturalOpeningWidthFt(truthOpening);
    const widthError = truthWidth === null ? null : Math.abs(predictedOpening.width_ft - truthWidth);
    if (widthError !== null && widthError > policy.opening_width_tolerance_ft) return [];
    const locationScore = Math.max(0, 1 - error / policy.opening_location_tolerance_ft);
    const widthScore = widthError === null ? null : Math.max(0, 1 - widthError / policy.opening_width_tolerance_ft);
    const matchedTruthHostKey = hostTruthByCandidate.get(prediction.selected_host_candidate_id!) ?? null;
    const expectedTruthHostKey = truthOpening.host_key ?? null;
    return [{
      opening_hypothesis_id: prediction.opening_hypothesis_id,
      truth_opening_key: truthOpening.key,
      role: prediction.classification as "door" | "window",
      location_error_ft: round(error),
      predicted_width_ft: predictedOpening.width_ft,
      truth_width_ft: truthWidth === null ? null : round(truthWidth),
      width_error_ft: widthError === null ? null : round(widthError),
      width_score: widthScore === null ? null : round(widthScore),
      width_scored: widthScore !== null,
      geometry_score: round(widthScore === null ? locationScore : 0.5 * locationScore + 0.5 * widthScore),
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
  const widthOutsideTolerance = truthOpenings.some((truthOpening) => {
    const truthWidth = architecturalOpeningWidthFt(truthOpening);
    if (truthWidth === null || !truthOpening.location) return false;
    const truthLocation = truthOpening.location;
    return resolvedEntries.some((prediction) => {
      if (role(truthOpening) !== prediction.classification) return false;
      if (distance(prediction.opening_model_center, truthLocation) > policy.opening_location_tolerance_ft) return false;
      const predictedWidth = predictedOpeningById.get(prediction.opening_hypothesis_id)?.width_ft;
      return predictedWidth === undefined || Math.abs(predictedWidth - truthWidth) > policy.opening_width_tolerance_ft;
    });
  });
  if (widthOutsideTolerance) failures.push("opening_width_outside_tolerance");
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
