import type { ExistingConditionsPlanPoint } from "./registration.js";
import {
  validateArchitecturalOpeningClassification,
  type ArchitecturalOpeningClassificationReceipt
} from "./architectural_opening_classification.js";
import type {
  ArchitecturalOpeningGapHypothesis,
  ArchitecturalWallJunctionHypothesis,
  ArchitecturalWallLineAmbiguity,
  ArchitecturalWallLineCandidate,
  ArchitecturalWallLineCandidateReceipt
} from "./architectural_wall_line_candidates.js";

type Point2 = ExistingConditionsPlanPoint;

export type ArchitecturalOpeningHostResolutionPolicy = {
  minimum_classification_confidence: number;
  minimum_gap_evidence_score: number;
  minimum_host_source_ink_coverage: number;
  maximum_axis_snap_degrees: number;
  minimum_junction_topology_score: number;
  maximum_junction_endpoint_distance_ft: number;
  maximum_junction_projection_adjustment_ft: number;
  minimum_resolved_wall_length_ft: number;
  minimum_opening_end_clearance_ft: number;
  minimum_resolution_confidence: number;
};

export const DEFAULT_ARCHITECTURAL_OPENING_HOST_RESOLUTION_POLICY: ArchitecturalOpeningHostResolutionPolicy = {
  minimum_classification_confidence: 0.85,
  minimum_gap_evidence_score: 0.85,
  minimum_host_source_ink_coverage: 0.75,
  maximum_axis_snap_degrees: 8,
  minimum_junction_topology_score: 0.9,
  maximum_junction_endpoint_distance_ft: 1.25,
  maximum_junction_projection_adjustment_ft: 1.5,
  minimum_resolved_wall_length_ft: 2,
  minimum_opening_end_clearance_ft: 0.25,
  minimum_resolution_confidence: 0.85
};

export type ArchitecturalOpeningHostEndpointEvidence = {
  endpoint: "start" | "end";
  source: "junction" | "supporting_face_extents";
  junction_id: string | null;
  model_point: Point2;
  confidence: number;
};

export type ArchitecturalOpeningHostResolution = {
  opening_hypothesis_id: string;
  classification: "door" | "window" | "unknown";
  opening_model_center: Point2;
  selected_host_candidate_id: string | null;
  host_wall_observation_id: string | null;
  refined_host_model_points: [Point2, Point2] | null;
  axis_degrees: 0 | 90 | null;
  endpoint_evidence: [ArchitecturalOpeningHostEndpointEvidence, ArchitecturalOpeningHostEndpointEvidence] | [];
  confidence: number;
  blockers: string[];
};

export type ArchitecturalOpeningHostResolutionReceipt = {
  schema_version: 1;
  artifact_role: "architectural_opening_host_resolution";
  fixture_id: string;
  scope_id: string;
  candidate_receipt_sha256: string;
  classification_receipt_sha256: string;
  status: "resolved" | "clarification_required";
  policy: ArchitecturalOpeningHostResolutionPolicy;
  resolutions: ArchitecturalOpeningHostResolution[];
  clarification_question: string | null;
  native_write: false;
  promotion_allowed: false;
  promotion_blockers: string[];
};

function round(value: number): number {
  return Number(value.toFixed(6));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function normalizedHash(value: string, label: string): string {
  const hash = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label}_must_be_sha256`);
  return hash;
}

function validatePolicy(policy: ArchitecturalOpeningHostResolutionPolicy): void {
  const fractions = [
    policy.minimum_classification_confidence,
    policy.minimum_gap_evidence_score,
    policy.minimum_host_source_ink_coverage,
    policy.minimum_junction_topology_score,
    policy.minimum_resolution_confidence
  ];
  if (fractions.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("architectural_opening_host_resolution_fraction_policy_invalid");
  }
  const positives = [
    policy.maximum_axis_snap_degrees,
    policy.maximum_junction_endpoint_distance_ft,
    policy.maximum_junction_projection_adjustment_ft,
    policy.minimum_resolved_wall_length_ft,
    policy.minimum_opening_end_clearance_ft
  ];
  if (positives.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("architectural_opening_host_resolution_positive_policy_invalid");
  }
  if (policy.maximum_axis_snap_degrees > 45) {
    throw new Error("architectural_opening_host_resolution_axis_snap_policy_too_broad");
  }
}

function lineAngleDifference(a: number, b: number): number {
  const difference = Math.abs(((a - b) % 180 + 180) % 180);
  return Math.min(difference, 180 - difference);
}

function snappedAxis(angleDegrees: number, maximumDifference: number): 0 | 90 | null {
  const options: Array<0 | 90> = [0, 90];
  const ranked = options.map((axis) => ({ axis, difference: lineAngleDifference(angleDegrees, axis) }))
    .sort((a, b) => a.difference - b.difference || a.axis - b.axis);
  return ranked[0]!.difference <= maximumDifference ? ranked[0]!.axis : null;
}

function direction(axis: 0 | 90): Point2 {
  return axis === 0 ? { x: 1, y: 0 } : { x: 0, y: 1 };
}

function projection(point: Point2, unit: Point2): number {
  return point.x * unit.x + point.y * unit.y;
}

function pointAtProjection(center: Point2, unit: Point2, targetProjection: number): Point2 {
  const centerProjection = projection(center, unit);
  const delta = targetProjection - centerProjection;
  return { x: round(center.x + unit.x * delta), y: round(center.y + unit.y * delta) };
}

function supportingExtentProjections(candidate: ArchitecturalWallLineCandidate, unit: Point2): [number, number] | null {
  if (!candidate.supporting_face_model_points) return null;
  const extents = candidate.supporting_face_model_points.map((face) => {
    const values = face.map((point) => projection(point, unit));
    return { minimum: Math.min(...values), maximum: Math.max(...values) };
  });
  return [
    extents.reduce((sum, extent) => sum + extent.minimum, 0) / extents.length,
    extents.reduce((sum, extent) => sum + extent.maximum, 0) / extents.length
  ];
}

function distanceToSegment(point: Point2, segment: [Point2, Point2]): number {
  const [start, end] = segment;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const parameter = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
  ));
  return Math.hypot(
    point.x - (start.x + parameter * dx),
    point.y - (start.y + parameter * dy)
  );
}

function ambiguityCompetesForOpening(
  ambiguity: ArchitecturalWallLineAmbiguity,
  opening: ArchitecturalOpeningGapHypothesis,
  host: ArchitecturalWallLineCandidate,
  wallCandidates: Map<string, ArchitecturalWallLineCandidate>,
  policy: ArchitecturalOpeningHostResolutionPolicy
): boolean {
  if (!ambiguity.candidate_ids.includes(host.candidate_id)) return false;
  const alternateId = ambiguity.candidate_ids.find((candidateId) => candidateId !== host.candidate_id);
  const alternate = alternateId ? wallCandidates.get(alternateId) : null;
  if (!alternate) return true;
  const maximumWallThickness = Math.max(host.face_separation_ft ?? 0, alternate.face_separation_ft ?? 0);
  const plausibleCenterlineOffset = Math.max(
    0.75,
    maximumWallThickness / 2 + policy.minimum_opening_end_clearance_ft
  );
  return distanceToSegment(opening.model_center, alternate.model_points) <= plausibleCenterlineOffset;
}

function junctionForEndpoint(
  candidates: ArchitecturalWallLineCandidateReceipt,
  hostCandidateId: string,
  endpointProjection: number,
  unit: Point2,
  policy: ArchitecturalOpeningHostResolutionPolicy
): ArchitecturalWallJunctionHypothesis | null {
  return candidates.junction_hypotheses.flatMap((junction) => {
    const hostIndex = junction.candidate_ids.indexOf(hostCandidateId);
    if (hostIndex < 0
      || junction.topology_score < policy.minimum_junction_topology_score
      || junction.endpoint_distances_ft[hostIndex]! > policy.maximum_junction_endpoint_distance_ft) return [];
    const adjustment = Math.abs(projection(junction.model_point, unit) - endpointProjection);
    if (adjustment > policy.maximum_junction_projection_adjustment_ft) return [];
    return [{ junction, adjustment }];
  }).sort((a, b) => b.junction.topology_score - a.junction.topology_score
    || a.adjustment - b.adjustment
    || a.junction.junction_id.localeCompare(b.junction.junction_id))[0]?.junction ?? null;
}

function unresolved(
  openingHypothesisId: string,
  classification: "door" | "window" | "unknown",
  openingModelCenter: Point2,
  confidence: number,
  blockers: string[]
): ArchitecturalOpeningHostResolution {
  return {
    opening_hypothesis_id: openingHypothesisId,
    classification,
    opening_model_center: openingModelCenter,
    selected_host_candidate_id: null,
    host_wall_observation_id: null,
    refined_host_model_points: null,
    axis_degrees: null,
    endpoint_evidence: [],
    confidence: round(confidence),
    blockers
  };
}

export function resolveArchitecturalOpeningHosts(
  candidates: ArchitecturalWallLineCandidateReceipt,
  candidateReceiptSha256: string,
  classifications: ArchitecturalOpeningClassificationReceipt,
  classificationReceiptSha256: string,
  policy: ArchitecturalOpeningHostResolutionPolicy = DEFAULT_ARCHITECTURAL_OPENING_HOST_RESOLUTION_POLICY
): ArchitecturalOpeningHostResolutionReceipt {
  validatePolicy(policy);
  const candidateHash = normalizedHash(candidateReceiptSha256, "candidate_receipt_sha256");
  const classificationHash = normalizedHash(classificationReceiptSha256, "classification_receipt_sha256");
  validateArchitecturalOpeningClassification(
    classifications,
    candidates,
    candidateHash,
    policy.minimum_classification_confidence
  );
  const openings = new Map(candidates.opening_gap_hypotheses.map((entry) => [entry.opening_hypothesis_id, entry]));
  const wallCandidates = new Map(candidates.candidates.map((entry) => [entry.candidate_id, entry]));
  const resolutions = classifications.classifications.map((classification): ArchitecturalOpeningHostResolution => {
    const opening = openings.get(classification.opening_hypothesis_id)!;
    const host = wallCandidates.get(opening.host_candidate_id);
    const blockers: string[] = [];
    if (classification.classification === "unknown") blockers.push("opening_classification_unknown");
    if (classification.confidence < policy.minimum_classification_confidence) blockers.push("opening_classification_confidence_below_threshold");
    if (opening.evidence_score < policy.minimum_gap_evidence_score) blockers.push("opening_gap_evidence_below_threshold");
    if (!host) blockers.push("opening_host_candidate_missing");
    if (host && host.derivation !== "parallel_face_midline") blockers.push("opening_host_is_not_paired_face_midline");
    if (host && host.source_ink_coverage < policy.minimum_host_source_ink_coverage) blockers.push("opening_host_source_ink_below_threshold");
    if (host && candidates.ambiguities.some((entry) => ambiguityCompetesForOpening(entry, opening, host, wallCandidates, policy))) {
      blockers.push("opening_host_candidate_is_ambiguous");
    }
    const axis = snappedAxis(opening.profile_axis_degrees, policy.maximum_axis_snap_degrees);
    if (axis === null) blockers.push("opening_host_axis_not_cardinal_within_tolerance");
    if (!host?.supporting_face_model_points) blockers.push("opening_host_supporting_face_model_extents_missing");
    if (!host || axis === null || !host.supporting_face_model_points) {
      return unresolved(
        opening.opening_hypothesis_id,
        classification.classification,
        opening.model_center,
        classification.confidence,
        blockers
      );
    }
    const unit = direction(axis);
    const extents = supportingExtentProjections(host, unit)!;
    const startJunction = junctionForEndpoint(candidates, host.candidate_id, extents[0], unit, policy);
    const endJunction = junctionForEndpoint(candidates, host.candidate_id, extents[1], unit, policy);
    const startProjection = startJunction ? projection(startJunction.model_point, unit) : extents[0];
    const endProjection = endJunction ? projection(endJunction.model_point, unit) : extents[1];
    if (endProjection - startProjection < policy.minimum_resolved_wall_length_ft) blockers.push("resolved_host_wall_is_too_short");
    const openingProjection = projection(opening.model_center, unit);
    const requiredClearance = opening.width_ft / 2 + policy.minimum_opening_end_clearance_ft;
    if (openingProjection - startProjection < requiredClearance || endProjection - openingProjection < requiredClearance) {
      blockers.push("opening_does_not_fit_resolved_host_wall");
    }
    const faceEndpointConfidence = (host.candidate_coverage + host.source_ink_coverage) / 2;
    const startConfidence = startJunction?.topology_score ?? faceEndpointConfidence;
    const endConfidence = endJunction?.topology_score ?? faceEndpointConfidence;
    const confidence = 0.35 * classification.confidence
      + 0.25 * opening.evidence_score
      + 0.2 * host.source_ink_coverage
      + 0.2 * ((startConfidence + endConfidence) / 2);
    if (confidence < policy.minimum_resolution_confidence) blockers.push("opening_host_resolution_confidence_below_threshold");
    if (blockers.length > 0) {
      return unresolved(
        opening.opening_hypothesis_id,
        classification.classification,
        opening.model_center,
        confidence,
        blockers
      );
    }
    const refinedPoints: [Point2, Point2] = [
      pointAtProjection(opening.model_center, unit, startProjection),
      pointAtProjection(opening.model_center, unit, endProjection)
    ];
    const endpointEvidence: [ArchitecturalOpeningHostEndpointEvidence, ArchitecturalOpeningHostEndpointEvidence] = [
      {
        endpoint: "start",
        source: startJunction ? "junction" : "supporting_face_extents",
        junction_id: startJunction?.junction_id ?? null,
        model_point: refinedPoints[0],
        confidence: round(startConfidence)
      },
      {
        endpoint: "end",
        source: endJunction ? "junction" : "supporting_face_extents",
        junction_id: endJunction?.junction_id ?? null,
        model_point: refinedPoints[1],
        confidence: round(endConfidence)
      }
    ];
    return {
      opening_hypothesis_id: opening.opening_hypothesis_id,
      classification: classification.classification,
      opening_model_center: opening.model_center,
      selected_host_candidate_id: host.candidate_id,
      host_wall_observation_id: `wall-${host.candidate_id}`,
      refined_host_model_points: refinedPoints,
      axis_degrees: axis,
      endpoint_evidence: endpointEvidence,
      confidence: round(confidence),
      blockers: []
    };
  });
  const resolved = resolutions.every((entry) => entry.selected_host_candidate_id !== null && entry.blockers.length === 0);
  return {
    schema_version: 1,
    artifact_role: "architectural_opening_host_resolution",
    fixture_id: candidates.fixture_id,
    scope_id: candidates.scope_id,
    candidate_receipt_sha256: candidateHash,
    classification_receipt_sha256: classificationHash,
    status: resolved ? "resolved" : "clarification_required",
    policy: { ...policy },
    resolutions,
    clarification_question: resolved
      ? null
      : "Confirm unresolved wall centerline, endpoint, or opening-host evidence before compiling any native architectural action.",
    native_write: false,
    promotion_allowed: false,
    promotion_blockers: [
      "withheld_wall_geometry_and_host_score_not_proven",
      "independent_holdout_host_resolution_not_proven",
      "family_type_and_vertical_parameters_not_proven"
    ]
  };
}

export function validateArchitecturalOpeningHostResolution(
  receipt: ArchitecturalOpeningHostResolutionReceipt,
  candidates: ArchitecturalWallLineCandidateReceipt,
  candidateReceiptSha256: string,
  classifications: ArchitecturalOpeningClassificationReceipt,
  classificationReceiptSha256: string
): void {
  const expected = resolveArchitecturalOpeningHosts(
    candidates,
    candidateReceiptSha256,
    classifications,
    classificationReceiptSha256,
    receipt.policy
  );
  if (canonicalJson(receipt) !== canonicalJson(expected)) {
    throw new Error("architectural_opening_host_resolution_does_not_match_deterministic_evidence");
  }
}
