import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { ExistingConditionsPlanPoint } from "./registration.js";
import type { ArchitecturalSourceDeltaReceipt } from "./architectural_source_delta.js";
import {
  validateArchitecturalOpeningClassification,
  type ArchitecturalOpeningClassificationReceipt
} from "./architectural_opening_classification.js";
import type {
  ArchitecturalOpeningGapHypothesis,
  ArchitecturalWallLineCandidate,
  ArchitecturalWallLineCandidateReceipt
} from "./architectural_wall_line_candidates.js";

type Point2 = ExistingConditionsPlanPoint;

export type ArchitecturalDoorSpanObservationPolicy = {
  minimum_classification_confidence: number;
  minimum_observation_confidence: number;
  maximum_axis_snap_degrees: number;
  minimum_width_ft: number;
  maximum_width_ft: number;
  maximum_endpoint_distance_from_host_ft: number;
  maximum_endpoint_anchor_adjustment_ft: number;
  endpoint_outside_window_ft: number;
  endpoint_inside_window_ft: number;
  endpoint_window_margin_ft: number;
  minimum_outside_bilateral_coverage: number;
  maximum_inside_bilateral_coverage: number;
  minimum_transition_contrast: number;
  maximum_continuous_one_sided_support_ft: number;
  maximum_endpoint_extension_beyond_gap_ft: number;
  maximum_center_shift_from_gap_ft: number;
};

export const DEFAULT_ARCHITECTURAL_DOOR_SPAN_OBSERVATION_POLICY: ArchitecturalDoorSpanObservationPolicy = {
  minimum_classification_confidence: 0.9,
  minimum_observation_confidence: 0.9,
  maximum_axis_snap_degrees: 8,
  minimum_width_ft: 1.5,
  maximum_width_ft: 6,
  maximum_endpoint_distance_from_host_ft: 0.15,
  maximum_endpoint_anchor_adjustment_ft: 0.15,
  endpoint_outside_window_ft: 0.75,
  endpoint_inside_window_ft: 0.75,
  endpoint_window_margin_ft: 0.08,
  minimum_outside_bilateral_coverage: 0.7,
  maximum_inside_bilateral_coverage: 0.6,
  minimum_transition_contrast: 0.25,
  maximum_continuous_one_sided_support_ft: 0.75,
  maximum_endpoint_extension_beyond_gap_ft: 2,
  maximum_center_shift_from_gap_ft: 1.25
};

export type ArchitecturalDoorSpanObservationInput = {
  opening_hypothesis_id: string;
  host_candidate_id: string;
  pixel_endpoints: [Point2, Point2];
  evidence_artifact_sha256s: string[];
  confidence: number;
  rationale: string;
  selected_host_candidate_id: null;
};

export type ArchitecturalDoorSpanObservationPackage = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  architectural_delta_receipt_sha256: string;
  candidate_receipt_sha256: string;
  classification_receipt_sha256: string;
  observations: ArchitecturalDoorSpanObservationInput[];
  native_write: false;
};

export type ArchitecturalDoorSpanEndpointTransition = {
  endpoint: "start" | "end";
  supplied_pixel_point: Point2;
  matched_pixel_point: Point2;
  adjustment_ft: number;
  outside_bilateral_coverage: number;
  inside_bilateral_coverage: number;
  transition_contrast: number;
  passed: boolean;
};

export type ArchitecturalDoorSpanObservation = {
  opening_hypothesis_id: string;
  host_candidate_id: string;
  pixel_endpoints: [Point2, Point2];
  model_endpoints: [Point2, Point2];
  width_ft: number;
  conservative_gap_width_ft: number;
  extension_before_gap_ft: number;
  extension_after_gap_ft: number;
  center_shift_from_gap_ft: number;
  longest_continuous_one_sided_support_ft: number;
  evidence_artifact_sha256s: string[];
  confidence: number;
  rationale: string;
  endpoint_transitions: [ArchitecturalDoorSpanEndpointTransition, ArchitecturalDoorSpanEndpointTransition] | [];
  host_ambiguity_ids: string[];
  selected_host_candidate_id: null;
  blockers: string[];
};

export type ArchitecturalDoorSpanObservationReceipt = {
  schema_version: 1;
  artifact_role: "architectural_door_span_observation";
  fixture_id: string;
  scope_id: string;
  architectural_delta_receipt_sha256: string;
  candidate_receipt_sha256: string;
  classification_receipt_sha256: string;
  status: "measured" | "clarification_required";
  policy: ArchitecturalDoorSpanObservationPolicy;
  observations: ArchitecturalDoorSpanObservation[];
  clarification_question: string | null;
  native_write: false;
  promotion_allowed: false;
  promotion_blockers: string[];
  usage_constraints: string[];
};

type Mask = { pixels: Uint8Array; width: number; height: number };

function round(value: number): number {
  return Number(value.toFixed(6));
}

function normalizedHash(value: unknown, label: string): string {
  const hash = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label}_must_be_sha256`);
  return hash;
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function finitePoint(value: Point2, label: string): Point2 {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error(`${label}_must_be_a_finite_point`);
  }
  return { x: value.x, y: value.y };
}

function validatePolicy(policy: ArchitecturalDoorSpanObservationPolicy): void {
  const fractions = [
    policy.minimum_classification_confidence,
    policy.minimum_observation_confidence,
    policy.minimum_outside_bilateral_coverage,
    policy.maximum_inside_bilateral_coverage,
    policy.minimum_transition_contrast
  ];
  if (fractions.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("architectural_door_span_observation_fraction_policy_invalid");
  }
  const positives = [
    policy.maximum_axis_snap_degrees,
    policy.minimum_width_ft,
    policy.maximum_width_ft,
    policy.maximum_endpoint_distance_from_host_ft,
    policy.maximum_endpoint_anchor_adjustment_ft,
    policy.endpoint_outside_window_ft,
    policy.endpoint_inside_window_ft,
    policy.endpoint_window_margin_ft,
    policy.maximum_continuous_one_sided_support_ft,
    policy.maximum_endpoint_extension_beyond_gap_ft,
    policy.maximum_center_shift_from_gap_ft
  ];
  if (positives.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("architectural_door_span_observation_positive_policy_invalid");
  }
  if (policy.maximum_axis_snap_degrees > 45 || policy.maximum_width_ft <= policy.minimum_width_ft) {
    throw new Error("architectural_door_span_observation_policy_bounds_invalid");
  }
  if (policy.endpoint_window_margin_ft >= policy.endpoint_inside_window_ft
    || policy.endpoint_window_margin_ft >= policy.endpoint_outside_window_ft) {
    throw new Error("architectural_door_span_observation_window_margin_invalid");
  }
}

function angleDifference(a: number, b: number): number {
  const difference = Math.abs(((a - b) % 180 + 180) % 180);
  return Math.min(difference, 180 - difference);
}

function snappedAxis(angleDegrees: number, tolerance: number): 0 | 90 | null {
  const ranked = ([0, 90] as const).map((axis) => ({ axis, difference: angleDifference(angleDegrees, axis) }))
    .sort((a, b) => a.difference - b.difference || a.axis - b.axis);
  return ranked[0]!.difference <= tolerance ? ranked[0]!.axis : null;
}

function subtract(a: Point2, b: Point2): Point2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Point2, b: Point2): number {
  return a.x * b.x + a.y * b.y;
}

function length(vector: Point2): number {
  return Math.hypot(vector.x, vector.y);
}

function normalized(vector: Point2): Point2 {
  const magnitude = length(vector);
  if (magnitude <= Number.EPSILON) throw new Error("architectural_door_span_observation_host_is_degenerate");
  return { x: vector.x / magnitude, y: vector.y / magnitude };
}

function pointAt(start: Point2, direction: Point2, distance: number, normalOffset = 0): Point2 {
  const normal = { x: -direction.y, y: direction.x };
  return {
    x: start.x + direction.x * distance + normal.x * normalOffset,
    y: start.y + direction.y * distance + normal.y * normalOffset
  };
}

function pixelToModel(point: Point2, delta: ArchitecturalSourceDeltaReceipt): Point2 {
  const bounds = delta.scope_model_bounds;
  return {
    x: round(bounds.min.x + point.x / delta.output_frame.width_px * (bounds.max.x - bounds.min.x)),
    y: round(bounds.max.y - point.y / delta.output_frame.height_px * (bounds.max.y - bounds.min.y))
  };
}

async function loadCandidateMask(delta: ArchitecturalSourceDeltaReceipt): Promise<Mask> {
  const reference = delta.artifacts.candidate_delta_mask;
  const filePath = path.resolve(String(reference.path ?? "").trim());
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`architectural_door_span_observation_candidate_mask_not_found:${filePath}`);
  }
  const expectedHash = normalizedHash(reference.sha256, "candidate_delta_mask_sha256");
  const bytes = fs.readFileSync(filePath);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
    throw new Error("architectural_door_span_observation_candidate_mask_hash_mismatch");
  }
  const image = await loadImage(bytes);
  if (image.width !== reference.width_px || image.height !== reference.height_px
    || image.width !== delta.output_frame.width_px || image.height !== delta.output_frame.height_px) {
    throw new Error("architectural_door_span_observation_candidate_mask_dimensions_mismatch");
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  const pixels = new Uint8Array(image.width * image.height);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = data[index * 4 + 3]! > 25 ? 1 : 0;
  return { pixels, width: image.width, height: image.height };
}

function verifyEvidenceArtifacts(
  hashes: string[],
  classificationHashes: string[],
  candidate: ArchitecturalWallLineCandidateReceipt,
  openingHypothesisId: string
): boolean {
  const crop = candidate.opening_evidence_crops.find((entry) => entry.opening_hypothesis_id === openingHypothesisId);
  if (!crop) return false;
  const expected = [crop.source_crop, crop.evidence_overlay];
  for (const reference of expected) {
    const filePath = path.resolve(String(reference.path ?? "").trim());
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    if (hashFile(filePath) !== normalizedHash(reference.sha256, "opening_evidence_sha256")) return false;
  }
  const expectedHashes = expected.map((entry) => entry.sha256.toLowerCase()).sort();
  const suppliedHashes = hashes.map((entry) => normalizedHash(entry, "evidence_artifact_sha256")).sort();
  const boundClassificationHashes = classificationHashes.map((entry) => normalizedHash(entry, "classification_evidence_sha256")).sort();
  return suppliedHashes.length === 2
    && new Set(suppliedHashes).size === 2
    && suppliedHashes.every((entry, index) => entry === expectedHashes[index])
    && boundClassificationHashes.every((entry, index) => entry === expectedHashes[index]);
}

function maskHasDirectionalInk(
  mask: Mask,
  point: Point2,
  direction: Point2,
  halfLengthPx: number,
  crossRadiusPx: number
): boolean {
  const normal = { x: -direction.y, y: direction.x };
  const half = Math.max(1, Math.round(halfLengthPx));
  let sampled = 0;
  let supported = 0;
  for (let along = -half; along <= half; along += 1) {
    let present = false;
    for (let cross = -crossRadiusPx; cross <= crossRadiusPx; cross += 1) {
      const x = Math.round(point.x + direction.x * along + normal.x * cross);
      const y = Math.round(point.y + direction.y * along + normal.y * cross);
      if (x < 0 || x >= mask.width || y < 0 || y >= mask.height) continue;
      if (mask.pixels[y * mask.width + x]) {
        present = true;
        break;
      }
    }
    sampled += 1;
    if (present) supported += 1;
  }
  return sampled > 0 && supported / sampled >= 0.55;
}

function faceOffsets(host: ArchitecturalWallLineCandidate, start: Point2, normal: Point2): [number, number] | null {
  if (!host.supporting_face_pixel_points) return null;
  return host.supporting_face_pixel_points.map((face) => {
    const midpoint = { x: (face[0].x + face[1].x) / 2, y: (face[0].y + face[1].y) / 2 };
    return dot(subtract(midpoint, start), normal);
  }) as [number, number];
}

function faceSupport(
  mask: Mask,
  hostStart: Point2,
  direction: Point2,
  offsets: [number, number],
  chainagePx: number,
  pixelsPerFoot: number,
  supportRadiusPx: number
): [boolean, boolean] {
  return offsets.map((offset) => maskHasDirectionalInk(
    mask,
    pointAt(hostStart, direction, chainagePx, offset),
    direction,
    0.12 * pixelsPerFoot,
    supportRadiusPx
  )) as [boolean, boolean];
}

function bilateralSupport(
  mask: Mask,
  hostStart: Point2,
  direction: Point2,
  offsets: [number, number],
  chainagePx: number,
  pixelsPerFoot: number,
  supportRadiusPx: number
): boolean {
  return faceSupport(mask, hostStart, direction, offsets, chainagePx, pixelsPerFoot, supportRadiusPx).every(Boolean);
}

function bilateralCoverage(
  mask: Mask,
  hostStart: Point2,
  direction: Point2,
  offsets: [number, number],
  fromPx: number,
  toPx: number,
  pixelsPerFoot: number,
  supportRadiusPx: number
): number {
  const start = Math.ceil(Math.min(fromPx, toPx));
  const end = Math.floor(Math.max(fromPx, toPx));
  if (end < start) return 0;
  let supported = 0;
  let sampled = 0;
  for (let chainage = start; chainage <= end; chainage += 1) {
    sampled += 1;
    if (bilateralSupport(mask, hostStart, direction, offsets, chainage, pixelsPerFoot, supportRadiusPx)) supported += 1;
  }
  return sampled > 0 ? supported / sampled : 0;
}

function longestContinuousOneSidedSupportFt(
  mask: Mask,
  hostStart: Point2,
  direction: Point2,
  offsets: [number, number],
  fromPx: number,
  toPx: number,
  pixelsPerFoot: number,
  supportRadiusPx: number
): number {
  const start = Math.ceil(Math.min(fromPx, toPx));
  const end = Math.floor(Math.max(fromPx, toPx));
  let current = 0;
  let longest = 0;
  for (let chainage = start; chainage <= end; chainage += 1) {
    const support = faceSupport(mask, hostStart, direction, offsets, chainage, pixelsPerFoot, supportRadiusPx);
    if (Number(support[0]) + Number(support[1]) === 1) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest / pixelsPerFoot;
}

function endpointTransition(
  endpoint: "start" | "end",
  suppliedPoint: Point2,
  suppliedChainagePx: number,
  mask: Mask,
  hostStart: Point2,
  direction: Point2,
  offsets: [number, number],
  pixelsPerFoot: number,
  supportRadiusPx: number,
  policy: ArchitecturalDoorSpanObservationPolicy
): ArchitecturalDoorSpanEndpointTransition {
  const adjustmentPx = policy.maximum_endpoint_anchor_adjustment_ft * pixelsPerFoot;
  const outsidePx = policy.endpoint_outside_window_ft * pixelsPerFoot;
  const insidePx = policy.endpoint_inside_window_ft * pixelsPerFoot;
  const marginPx = policy.endpoint_window_margin_ft * pixelsPerFoot;
  const candidates: Array<{ chainage: number; outside: number; inside: number; contrast: number; adjustment: number }> = [];
  for (let chainage = Math.ceil(suppliedChainagePx - adjustmentPx); chainage <= Math.floor(suppliedChainagePx + adjustmentPx); chainage += 1) {
    const outside = endpoint === "start"
      ? bilateralCoverage(mask, hostStart, direction, offsets, chainage - outsidePx, chainage - marginPx, pixelsPerFoot, supportRadiusPx)
      : bilateralCoverage(mask, hostStart, direction, offsets, chainage + marginPx, chainage + outsidePx, pixelsPerFoot, supportRadiusPx);
    const inside = endpoint === "start"
      ? bilateralCoverage(mask, hostStart, direction, offsets, chainage + marginPx, chainage + insidePx, pixelsPerFoot, supportRadiusPx)
      : bilateralCoverage(mask, hostStart, direction, offsets, chainage - insidePx, chainage - marginPx, pixelsPerFoot, supportRadiusPx);
    candidates.push({
      chainage,
      outside,
      inside,
      contrast: outside - inside,
      adjustment: Math.abs(chainage - suppliedChainagePx)
    });
  }
  const best = candidates.sort((a, b) => b.contrast - a.contrast
    || b.outside - a.outside
    || a.inside - b.inside
    || a.adjustment - b.adjustment
    || a.chainage - b.chainage)[0]!;
  const passed = best.outside >= policy.minimum_outside_bilateral_coverage
    && best.inside <= policy.maximum_inside_bilateral_coverage
    && best.contrast >= policy.minimum_transition_contrast;
  return {
    endpoint,
    supplied_pixel_point: { x: round(suppliedPoint.x), y: round(suppliedPoint.y) },
    matched_pixel_point: Object.fromEntries(Object.entries(pointAt(hostStart, direction, best.chainage)).map(([key, value]) => [key, round(value)])) as Point2,
    adjustment_ft: round(best.adjustment / pixelsPerFoot),
    outside_bilateral_coverage: round(best.outside),
    inside_bilateral_coverage: round(best.inside),
    transition_contrast: round(best.contrast),
    passed
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export async function buildArchitecturalDoorSpanObservationReceipt(
  input: ArchitecturalDoorSpanObservationPackage,
  delta: ArchitecturalSourceDeltaReceipt,
  deltaReceiptSha256: string,
  candidates: ArchitecturalWallLineCandidateReceipt,
  candidateReceiptSha256: string,
  classifications: ArchitecturalOpeningClassificationReceipt,
  classificationReceiptSha256: string,
  policy: ArchitecturalDoorSpanObservationPolicy = DEFAULT_ARCHITECTURAL_DOOR_SPAN_OBSERVATION_POLICY
): Promise<ArchitecturalDoorSpanObservationReceipt> {
  validatePolicy(policy);
  if (input.schema_version !== 1 || input.native_write !== false) throw new Error("architectural_door_span_observation_input_contract_invalid");
  if (input.fixture_id !== delta.fixture_id || input.fixture_id !== candidates.fixture_id || input.fixture_id !== classifications.fixture_id
    || input.scope_id !== delta.scope_id || input.scope_id !== candidates.scope_id || input.scope_id !== classifications.scope_id) {
    throw new Error("architectural_door_span_observation_fixture_or_scope_mismatch");
  }
  const deltaHash = normalizedHash(deltaReceiptSha256, "architectural_delta_receipt_sha256");
  const candidateHash = normalizedHash(candidateReceiptSha256, "candidate_receipt_sha256");
  const classificationHash = normalizedHash(classificationReceiptSha256, "classification_receipt_sha256");
  if (normalizedHash(input.architectural_delta_receipt_sha256, "input_architectural_delta_receipt_sha256") !== deltaHash
    || normalizedHash(candidates.architectural_delta_receipt_sha256, "candidate_architectural_delta_receipt_sha256") !== deltaHash) {
    throw new Error("architectural_door_span_observation_delta_receipt_hash_mismatch");
  }
  if (normalizedHash(input.candidate_receipt_sha256, "input_candidate_receipt_sha256") !== candidateHash) {
    throw new Error("architectural_door_span_observation_candidate_receipt_hash_mismatch");
  }
  if (normalizedHash(input.classification_receipt_sha256, "input_classification_receipt_sha256") !== classificationHash) {
    throw new Error("architectural_door_span_observation_classification_receipt_hash_mismatch");
  }
  if (normalizedHash(candidates.candidate_delta_mask_sha256, "candidate_delta_mask_sha256")
    !== normalizedHash(delta.artifacts.candidate_delta_mask.sha256, "delta_candidate_mask_sha256")) {
    throw new Error("architectural_door_span_observation_candidate_mask_receipt_mismatch");
  }
  validateArchitecturalOpeningClassification(
    classifications,
    candidates,
    candidateHash,
    policy.minimum_classification_confidence
  );
  if (input.observations.length === 0) throw new Error("architectural_door_span_observation_requires_observations");
  const mask = await loadCandidateMask(delta);
  const pixelsPerFootX = mask.width / (delta.scope_model_bounds.max.x - delta.scope_model_bounds.min.x);
  const pixelsPerFootY = mask.height / (delta.scope_model_bounds.max.y - delta.scope_model_bounds.min.y);
  if (!Number.isFinite(pixelsPerFootX) || !Number.isFinite(pixelsPerFootY)
    || pixelsPerFootX <= 0 || Math.abs(pixelsPerFootX - pixelsPerFootY) > 1e-6) {
    throw new Error("architectural_door_span_observation_requires_isotropic_registered_pixels");
  }
  const pixelsPerFoot = (pixelsPerFootX + pixelsPerFootY) / 2;
  const openings = new Map(candidates.opening_gap_hypotheses.map((entry) => [entry.opening_hypothesis_id, entry]));
  const hosts = new Map(candidates.candidates.map((entry) => [entry.candidate_id, entry]));
  const classified = new Map(classifications.classifications.map((entry) => [entry.opening_hypothesis_id, entry]));
  const seen = new Set<string>();
  const observations = input.observations.map((entry): ArchitecturalDoorSpanObservation => {
    if (seen.has(entry.opening_hypothesis_id)) throw new Error("architectural_door_span_observation_duplicate_hypothesis");
    seen.add(entry.opening_hypothesis_id);
    if (entry.selected_host_candidate_id !== null) throw new Error("architectural_door_span_observation_must_not_select_native_host");
    const opening = openings.get(entry.opening_hypothesis_id);
    const host = hosts.get(entry.host_candidate_id);
    const classification = classified.get(entry.opening_hypothesis_id);
    if (!opening || !host || !classification) throw new Error(`architectural_door_span_observation_unknown_evidence:${entry.opening_hypothesis_id}`);
    if (opening.host_candidate_id !== host.candidate_id || classification.host_candidate_id !== host.candidate_id) {
      throw new Error(`architectural_door_span_observation_host_mismatch:${entry.opening_hypothesis_id}`);
    }
    const blockers: string[] = [];
    if (classification.classification !== "door") blockers.push("opening_is_not_classified_as_door");
    if (classification.confidence < policy.minimum_classification_confidence) blockers.push("door_classification_confidence_below_threshold");
    for (const cue of ["swing_arc", "door_leaf", "paired_jambs"] as const) {
      if (!classification.cues.includes(cue)) blockers.push(`door_classification_${cue}_cue_required`);
    }
    if (!Number.isFinite(entry.confidence) || entry.confidence < policy.minimum_observation_confidence || entry.confidence > 1) {
      blockers.push("door_span_observation_confidence_below_threshold");
    }
    if (!String(entry.rationale ?? "").trim()) blockers.push("door_span_observation_rationale_required");
    if (!verifyEvidenceArtifacts(
      entry.evidence_artifact_sha256s,
      classification.evidence_artifact_sha256s,
      candidates,
      entry.opening_hypothesis_id
    )) blockers.push("door_span_observation_evidence_artifacts_invalid");
    if (host.derivation !== "parallel_face_midline" || !host.supporting_face_pixel_points) {
      blockers.push("door_span_host_requires_paired_wall_faces");
    }
    const hostStart = finitePoint(host.pixel_points[0], "host_pixel_start");
    const hostEnd = finitePoint(host.pixel_points[1], "host_pixel_end");
    const direction = normalized(subtract(hostEnd, hostStart));
    const normal = { x: -direction.y, y: direction.x };
    const hostLengthPx = length(subtract(hostEnd, hostStart));
    const actualAngle = ((Math.atan2(direction.y, direction.x) * 180 / Math.PI) % 180 + 180) % 180;
    const axis = snappedAxis(actualAngle, policy.maximum_axis_snap_degrees);
    if (axis === null) blockers.push("door_span_host_axis_not_cardinal_within_tolerance");
    if (angleDifference(actualAngle, host.angle_degrees) > policy.maximum_axis_snap_degrees) {
      blockers.push("door_span_host_vector_angle_mismatch");
    }
    const supplied = entry.pixel_endpoints.map((point, index) => finitePoint(point, `pixel_endpoint_${index}`));
    for (const point of supplied) {
      if (point.x < 0 || point.x > mask.width || point.y < 0 || point.y > mask.height) blockers.push("door_span_endpoint_outside_registered_frame");
      if (Math.abs(dot(subtract(point, hostStart), normal)) / pixelsPerFoot > policy.maximum_endpoint_distance_from_host_ft) {
        blockers.push("door_span_endpoint_too_far_from_host");
      }
    }
    const rankedEndpoints = supplied.map((point) => ({ point, chainage: dot(subtract(point, hostStart), direction) }))
      .sort((a, b) => a.chainage - b.chainage);
    const start = rankedEndpoints[0]!;
    const end = rankedEndpoints[1]!;
    if (start.chainage < 0 || end.chainage > hostLengthPx) blockers.push("door_span_endpoint_outside_host_extent");
    const offsets = faceOffsets(host, hostStart, normal);
    let transitions: [ArchitecturalDoorSpanEndpointTransition, ArchitecturalDoorSpanEndpointTransition] | [] = [];
    if (offsets && axis !== null) {
      const startTransition = endpointTransition(
        "start", start.point, start.chainage, mask, hostStart, direction, offsets, pixelsPerFoot,
        candidates.policy.opening_gap_support_radius_px, policy
      );
      const endTransition = endpointTransition(
        "end", end.point, end.chainage, mask, hostStart, direction, offsets, pixelsPerFoot,
        candidates.policy.opening_gap_support_radius_px, policy
      );
      transitions = [startTransition, endTransition];
      if (!startTransition.passed) blockers.push("door_span_start_jamb_transition_not_supported");
      if (!endTransition.passed) blockers.push("door_span_end_jamb_transition_not_supported");
    }
    const canonicalStartChainage = transitions.length === 2
      ? dot(subtract(transitions[0].matched_pixel_point, hostStart), direction)
      : start.chainage;
    const canonicalEndChainage = transitions.length === 2
      ? dot(subtract(transitions[1].matched_pixel_point, hostStart), direction)
      : end.chainage;
    const projectedStart = pointAt(hostStart, direction, canonicalStartChainage);
    const projectedEnd = pointAt(hostStart, direction, canonicalEndChainage);
    if (canonicalStartChainage < 0 || canonicalEndChainage > hostLengthPx) blockers.push("door_span_matched_endpoint_outside_host_extent");
    const widthFt = (canonicalEndChainage - canonicalStartChainage) / pixelsPerFoot;
    if (widthFt < policy.minimum_width_ft || widthFt > policy.maximum_width_ft) blockers.push("door_span_width_outside_policy");
    const openingCenterChainage = dot(subtract(opening.pixel_center, hostStart), direction);
    const conservativeHalfWidthPx = opening.width_ft * pixelsPerFoot / 2;
    const conservativeStart = openingCenterChainage - conservativeHalfWidthPx;
    const conservativeEnd = openingCenterChainage + conservativeHalfWidthPx;
    const containmentTolerancePx = policy.maximum_endpoint_distance_from_host_ft * pixelsPerFoot;
    if (canonicalStartChainage > conservativeStart + containmentTolerancePx
      || canonicalEndChainage < conservativeEnd - containmentTolerancePx) {
      blockers.push("door_span_does_not_contain_conservative_gap");
    }
    const extensionBeforeFt = Math.max(0, conservativeStart - canonicalStartChainage) / pixelsPerFoot;
    const extensionAfterFt = Math.max(0, canonicalEndChainage - conservativeEnd) / pixelsPerFoot;
    if (extensionBeforeFt > policy.maximum_endpoint_extension_beyond_gap_ft
      || extensionAfterFt > policy.maximum_endpoint_extension_beyond_gap_ft) {
      blockers.push("door_span_extension_beyond_gap_exceeds_policy");
    }
    const centerShiftFt = Math.abs(
      (canonicalStartChainage + canonicalEndChainage) / 2 - openingCenterChainage
    ) / pixelsPerFoot;
    if (centerShiftFt > policy.maximum_center_shift_from_gap_ft) blockers.push("door_span_center_shift_exceeds_policy");
    let longestOneSidedSupportFt = 0;
    if (offsets) {
      longestOneSidedSupportFt = longestContinuousOneSidedSupportFt(
        mask,
        hostStart,
        direction,
        offsets,
        canonicalStartChainage,
        canonicalEndChainage,
        pixelsPerFoot,
        candidates.policy.opening_gap_support_radius_px
      );
      if (longestOneSidedSupportFt > policy.maximum_continuous_one_sided_support_ft) {
        blockers.push("door_span_continuous_one_sided_wall_face_exceeds_policy");
      }
    }
    return {
      opening_hypothesis_id: entry.opening_hypothesis_id,
      host_candidate_id: entry.host_candidate_id,
      pixel_endpoints: [
        { x: round(projectedStart.x), y: round(projectedStart.y) },
        { x: round(projectedEnd.x), y: round(projectedEnd.y) }
      ],
      model_endpoints: [pixelToModel(projectedStart, delta), pixelToModel(projectedEnd, delta)],
      width_ft: round(widthFt),
      conservative_gap_width_ft: round(opening.width_ft),
      extension_before_gap_ft: round(extensionBeforeFt),
      extension_after_gap_ft: round(extensionAfterFt),
      center_shift_from_gap_ft: round(centerShiftFt),
      longest_continuous_one_sided_support_ft: round(longestOneSidedSupportFt),
      evidence_artifact_sha256s: entry.evidence_artifact_sha256s.map((hash) => normalizedHash(hash, "evidence_artifact_sha256")),
      confidence: round(entry.confidence),
      rationale: String(entry.rationale ?? "").trim(),
      endpoint_transitions: transitions,
      host_ambiguity_ids: candidates.ambiguities
        .filter((ambiguity) => ambiguity.candidate_ids.includes(host.candidate_id))
        .map((ambiguity) => ambiguity.ambiguity_id)
        .sort(),
      selected_host_candidate_id: null,
      blockers: unique(blockers)
    };
  });
  const status = observations.every((entry) => entry.blockers.length === 0) ? "measured" : "clarification_required";
  return {
    schema_version: 1,
    artifact_role: "architectural_door_span_observation",
    fixture_id: input.fixture_id,
    scope_id: input.scope_id,
    architectural_delta_receipt_sha256: deltaHash,
    candidate_receipt_sha256: candidateHash,
    classification_receipt_sha256: classificationHash,
    status,
    policy,
    observations,
    clarification_question: status === "clarification_required"
      ? "Confirm both visible door jamb endpoints on an unambiguous paired-face wall host; do not infer a wider span from one-sided wall loss."
      : null,
    native_write: false,
    promotion_allowed: false,
    promotion_blockers: [
      "architectural_door_span_observation_is_measurement_only",
      "independent_holdout_validation_required",
      "native_host_selection_not_authorized"
    ],
    usage_constraints: [
      "A door span is accepted only from hash-bound crop evidence classified with swing-arc, door-leaf, and paired-jamb cues.",
      "The supplied endpoints must contain the conservative low-level gap and coincide with bounded bilateral wall-face transitions; the detector never widens a gap automatically.",
      "One-sided wall loss and annotation clutter remain blockers. Parallel host ambiguity may coexist with a plan-width measurement, but this receipt never resolves that ambiguity or selects a host.",
      "The observation records plan-visible width only. It does not select a native Revit host, authorize family placement, or authorize a native write."
    ]
  };
}
