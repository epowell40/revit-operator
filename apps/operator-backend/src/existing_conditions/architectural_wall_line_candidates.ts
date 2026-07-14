import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { ExistingConditionsPlanPoint } from "./registration.js";
import type { ArchitecturalSourceDeltaReceipt } from "./architectural_source_delta.js";
import type { ArchitecturalMeasurementOverlayReceipt } from "./architectural_pixel_measurement.js";

type Point2 = ExistingConditionsPlanPoint;

export type ArchitecturalWallLineCandidatePolicy = {
  sampling_stride_px: number;
  angle_step_degrees: number;
  rho_bin_px: number;
  support_distance_px: number;
  maximum_support_gap_px: number;
  maximum_wall_interruption_ft: number;
  maximum_source_endpoint_extension_ft: number;
  maximum_source_endpoint_gap_ft: number;
  minimum_length_ft: number;
  maximum_candidates: number;
  maximum_face_pair_inputs: number;
  hough_peak_duplicate_separation_ft: number;
  duplicate_angle_tolerance_degrees: number;
  duplicate_separation_ft: number;
  face_pair_angle_tolerance_degrees: number;
  minimum_face_pair_separation_ft: number;
  maximum_face_pair_separation_ft: number;
  minimum_face_pair_overlap_ratio: number;
  minimum_face_pair_candidate_coverage: number;
  minimum_junction_angle_degrees: number;
  maximum_junction_angle_degrees: number;
  maximum_junction_endpoint_gap_ft: number;
  maximum_junction_hypotheses: number;
  minimum_opening_gap_width_ft: number;
  maximum_opening_gap_width_ft: number;
  opening_gap_flank_ft: number;
  opening_gap_maximum_internal_ink_ft: number;
  opening_gap_maximum_ink_ratio: number;
  opening_gap_minimum_flank_coverage: number;
  opening_gap_minimum_profile_ink_coverage: number;
  minimum_opening_host_source_ink_coverage: number;
  opening_gap_axis_snap_tolerance_degrees: number;
  opening_gap_face_profile_band_ft: number;
  opening_gap_face_profile_sample_count: number;
  opening_gap_minimum_confirming_profiles: number;
  opening_gap_support_radius_px: number;
  opening_gap_group_center_tolerance_ft: number;
  opening_gap_group_width_tolerance_ft: number;
  maximum_opening_gap_hypotheses: number;
  minimum_opening_gap_evidence_score: number;
  opening_evidence_minimum_context_ft: number;
  opening_evidence_width_multiplier: number;
  parallel_angle_tolerance_degrees: number;
  minimum_parallel_separation_ft: number;
  maximum_parallel_separation_ft: number;
  minimum_parallel_overlap_ratio: number;
  ambiguity_score_gap: number;
};

export type ArchitecturalWallLineCandidate = {
  candidate_id: string;
  rank: number;
  derivation: "detected_line" | "parallel_face_midline";
  pixel_points: [Point2, Point2];
  model_points: [Point2, Point2];
  face_separation_ft: number | null;
  supporting_face_pixel_points: [[Point2, Point2], [Point2, Point2]] | null;
  supporting_face_model_points: [[Point2, Point2], [Point2, Point2]] | null;
  angle_degrees: number;
  length_ft: number;
  candidate_coverage: number;
  source_ink_coverage: number;
  rank_score: number;
};

export type ArchitecturalWallLineAmbiguity = {
  ambiguity_id: string;
  candidate_ids: [string, string];
  reason: "parallel_overlapping_wall_lines" | "near_equal_rank";
  angle_difference_degrees: number;
  perpendicular_separation_ft: number;
  overlap_ratio: number;
  score_gap: number;
};

export type ArchitecturalWallJunctionHypothesis = {
  junction_id: string;
  rank: number;
  candidate_ids: [string, string];
  pixel_point: Point2;
  model_point: Point2;
  angle_difference_degrees: number;
  endpoint_distances_ft: [number, number];
  topology_score: number;
};

export type ArchitecturalOpeningGapHypothesis = {
  opening_hypothesis_id: string;
  rank: number;
  kind: "unclassified_opening_gap";
  host_candidate_id: string;
  pixel_center: Point2;
  model_center: Point2;
  width_ft: number;
  host_chainage_ft: number;
  host_chainage_ratio: number;
  profile_axis_degrees: number;
  confirming_profile_count: number;
  profile_offset_range_ft: [number, number];
  flank_ink_coverage: number;
  gap_ink_coverage: number;
  profile_ink_coverage: number;
  evidence_score: number;
};

export type ArchitecturalImageReference = {
  path: string;
  sha256: string;
  width_px: number;
  height_px: number;
};

export type ArchitecturalOpeningEvidenceCrop = {
  opening_hypothesis_id: string;
  host_candidate_id: string;
  crop_bounds_px: {
    min_x: number;
    min_y: number;
    max_x: number;
    max_y: number;
  };
  source_crop: ArchitecturalImageReference;
  evidence_overlay: ArchitecturalImageReference;
};

export type ArchitecturalWallLineCandidateReceipt = {
  schema_version: 1;
  artifact_role: "architectural_wall_line_candidates";
  fixture_id: string;
  scope_id: string;
  architectural_delta_receipt_sha256: string;
  measurement_receipt_sha256: string;
  source_aligned_sha256: string;
  candidate_delta_mask_sha256: string;
  status: "candidates_ready" | "clarification_required" | "blocked";
  policy: ArchitecturalWallLineCandidatePolicy;
  candidates: ArchitecturalWallLineCandidate[];
  junction_hypotheses: ArchitecturalWallJunctionHypothesis[];
  opening_gap_hypotheses: ArchitecturalOpeningGapHypothesis[];
  opening_evidence_crops: ArchitecturalOpeningEvidenceCrop[];
  ambiguities: ArchitecturalWallLineAmbiguity[];
  clarification_question: string | null;
  overlay: ArchitecturalImageReference;
  usage_constraints: string[];
};

type HoughPoint = { x: number; y: number };
type RawLine = {
  derivation: "detected_line" | "parallel_face_midline";
  angle_degrees: number;
  rho: number;
  pixel_points: [Point2, Point2];
  length_px: number;
  candidate_coverage: number;
  source_ink_coverage: number;
  rank_score: number;
  face_separation_px: number | null;
  supporting_face_pixel_points: [[Point2, Point2], [Point2, Point2]] | null;
};

const DEFAULT_POLICY_BASE = {
  angle_step_degrees: 1.5,
  rho_bin_px: 4,
  support_distance_px: 5,
  maximum_support_gap_px: 54,
  maximum_wall_interruption_ft: 4,
  maximum_source_endpoint_extension_ft: 2.5,
  maximum_source_endpoint_gap_ft: 0.3,
  minimum_length_ft: 2,
  maximum_candidates: 8,
  maximum_face_pair_inputs: 80,
  hough_peak_duplicate_separation_ft: 0.1,
  duplicate_angle_tolerance_degrees: 8,
  duplicate_separation_ft: 0.65,
  face_pair_angle_tolerance_degrees: 3,
  minimum_face_pair_separation_ft: 0.2,
  maximum_face_pair_separation_ft: 2.5,
  minimum_face_pair_overlap_ratio: 0.7,
  minimum_face_pair_candidate_coverage: 0.45,
  minimum_junction_angle_degrees: 45,
  maximum_junction_angle_degrees: 135,
  maximum_junction_endpoint_gap_ft: 1.25,
  maximum_junction_hypotheses: 12,
  minimum_opening_gap_width_ft: 1.5,
  maximum_opening_gap_width_ft: 6,
  opening_gap_flank_ft: 0.25,
  opening_gap_maximum_internal_ink_ft: 0.15,
  opening_gap_maximum_ink_ratio: 0.15,
  opening_gap_minimum_flank_coverage: 0.55,
  opening_gap_minimum_profile_ink_coverage: 0.45,
  minimum_opening_host_source_ink_coverage: 0.7,
  opening_gap_axis_snap_tolerance_degrees: 8,
  opening_gap_face_profile_band_ft: 0.15,
  opening_gap_face_profile_sample_count: 7,
  opening_gap_minimum_confirming_profiles: 2,
  opening_gap_support_radius_px: 6,
  opening_gap_group_center_tolerance_ft: 0.8,
  opening_gap_group_width_tolerance_ft: 1,
  maximum_opening_gap_hypotheses: 12,
  minimum_opening_gap_evidence_score: 0.85,
  opening_evidence_minimum_context_ft: 3,
  opening_evidence_width_multiplier: 1.5,
  parallel_angle_tolerance_degrees: 3,
  minimum_parallel_separation_ft: 0.15,
  maximum_parallel_separation_ft: 4,
  minimum_parallel_overlap_ratio: 0.5,
  ambiguity_score_gap: 0.12
} as const;

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, label: string): string {
  const text = cleanText(value);
  if (!text) throw new Error(`${label}_is_required`);
  return text;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function positive(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) throw new Error(`${label}_must_be_positive`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = positive(value, label);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label}_must_be_a_positive_integer`);
  return parsed;
}

function sha256Text(value: unknown, label: string): string {
  const text = cleanText(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label}_must_be_sha256`);
  return text;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function angleDifference(a: number, b: number): number {
  const difference = Math.abs(a - b) % 180;
  return Math.min(difference, 180 - difference);
}

function pointToModel(
  point: Point2,
  bounds: ArchitecturalSourceDeltaReceipt["scope_model_bounds"],
  width: number,
  height: number
): Point2 {
  return {
    x: bounds.min.x + point.x / width * (bounds.max.x - bounds.min.x),
    y: bounds.max.y - point.y / height * (bounds.max.y - bounds.min.y)
  };
}

function imageReference(reference: ArchitecturalImageReference, label: string, width: number, height: number): string {
  const filePath = path.resolve(requiredText(reference.path, `${label}_path`));
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`${label}_file_not_found:${filePath}`);
  if (sha256File(filePath) !== sha256Text(reference.sha256, `${label}_sha256`)) throw new Error(`${label}_sha256_mismatch`);
  if (reference.width_px !== width || reference.height_px !== height) throw new Error(`${label}_dimensions_mismatch`);
  return filePath;
}

function policyFor(width: number, height: number, override: Partial<ArchitecturalWallLineCandidatePolicy>): ArchitecturalWallLineCandidatePolicy {
  const policy: ArchitecturalWallLineCandidatePolicy = {
    sampling_stride_px: Math.max(1, Math.round(Math.max(width, height) / 1200)),
    ...DEFAULT_POLICY_BASE,
    ...override
  };
  positiveInteger(policy.sampling_stride_px, "sampling_stride_px");
  positive(policy.angle_step_degrees, "angle_step_degrees");
  positive(policy.rho_bin_px, "rho_bin_px");
  positive(policy.support_distance_px, "support_distance_px");
  positive(policy.maximum_support_gap_px, "maximum_support_gap_px");
  positive(policy.maximum_wall_interruption_ft, "maximum_wall_interruption_ft");
  positive(policy.maximum_source_endpoint_extension_ft, "maximum_source_endpoint_extension_ft");
  positive(policy.maximum_source_endpoint_gap_ft, "maximum_source_endpoint_gap_ft");
  positive(policy.minimum_length_ft, "minimum_length_ft");
  positiveInteger(policy.maximum_candidates, "maximum_candidates");
  positiveInteger(policy.maximum_face_pair_inputs, "maximum_face_pair_inputs");
  positive(policy.hough_peak_duplicate_separation_ft, "hough_peak_duplicate_separation_ft");
  positive(policy.duplicate_angle_tolerance_degrees, "duplicate_angle_tolerance_degrees");
  positive(policy.duplicate_separation_ft, "duplicate_separation_ft");
  positive(policy.face_pair_angle_tolerance_degrees, "face_pair_angle_tolerance_degrees");
  positive(policy.minimum_face_pair_separation_ft, "minimum_face_pair_separation_ft");
  positive(policy.maximum_face_pair_separation_ft, "maximum_face_pair_separation_ft");
  if (policy.maximum_face_pair_separation_ft <= policy.minimum_face_pair_separation_ft) {
    throw new Error("maximum_face_pair_separation_ft_must_exceed_minimum");
  }
  positive(policy.minimum_junction_angle_degrees, "minimum_junction_angle_degrees");
  positive(policy.maximum_junction_angle_degrees, "maximum_junction_angle_degrees");
  if (policy.maximum_junction_angle_degrees <= policy.minimum_junction_angle_degrees
    || policy.maximum_junction_angle_degrees >= 180) {
    throw new Error("maximum_junction_angle_degrees_must_exceed_minimum_and_be_below_180");
  }
  positive(policy.maximum_junction_endpoint_gap_ft, "maximum_junction_endpoint_gap_ft");
  positiveInteger(policy.maximum_junction_hypotheses, "maximum_junction_hypotheses");
  positive(policy.minimum_opening_gap_width_ft, "minimum_opening_gap_width_ft");
  positive(policy.maximum_opening_gap_width_ft, "maximum_opening_gap_width_ft");
  if (policy.maximum_opening_gap_width_ft <= policy.minimum_opening_gap_width_ft) {
    throw new Error("maximum_opening_gap_width_ft_must_exceed_minimum");
  }
  positive(policy.opening_gap_flank_ft, "opening_gap_flank_ft");
  positive(policy.opening_gap_maximum_internal_ink_ft, "opening_gap_maximum_internal_ink_ft");
  positive(policy.opening_gap_face_profile_band_ft, "opening_gap_face_profile_band_ft");
  positive(policy.opening_gap_axis_snap_tolerance_degrees, "opening_gap_axis_snap_tolerance_degrees");
  if (policy.opening_gap_axis_snap_tolerance_degrees >= 45) {
    throw new Error("opening_gap_axis_snap_tolerance_degrees_must_be_below_45");
  }
  positiveInteger(policy.opening_gap_face_profile_sample_count, "opening_gap_face_profile_sample_count");
  if (policy.opening_gap_face_profile_sample_count < 3 || policy.opening_gap_face_profile_sample_count % 2 === 0) {
    throw new Error("opening_gap_face_profile_sample_count_must_be_an_odd_integer_at_least_3");
  }
  positiveInteger(policy.opening_gap_minimum_confirming_profiles, "opening_gap_minimum_confirming_profiles");
  if (policy.opening_gap_minimum_confirming_profiles > policy.opening_gap_face_profile_sample_count) {
    throw new Error("opening_gap_minimum_confirming_profiles_exceeds_samples");
  }
  positiveInteger(policy.opening_gap_support_radius_px, "opening_gap_support_radius_px");
  positive(policy.opening_gap_group_center_tolerance_ft, "opening_gap_group_center_tolerance_ft");
  positive(policy.opening_gap_group_width_tolerance_ft, "opening_gap_group_width_tolerance_ft");
  positiveInteger(policy.maximum_opening_gap_hypotheses, "maximum_opening_gap_hypotheses");
  positive(policy.opening_evidence_minimum_context_ft, "opening_evidence_minimum_context_ft");
  positive(policy.opening_evidence_width_multiplier, "opening_evidence_width_multiplier");
  positive(policy.parallel_angle_tolerance_degrees, "parallel_angle_tolerance_degrees");
  positive(policy.minimum_parallel_separation_ft, "minimum_parallel_separation_ft");
  positive(policy.maximum_parallel_separation_ft, "maximum_parallel_separation_ft");
  if (policy.maximum_parallel_separation_ft <= policy.minimum_parallel_separation_ft) {
    throw new Error("maximum_parallel_separation_ft_must_exceed_minimum");
  }
  for (const [label, value] of [
    ["minimum_parallel_overlap_ratio", policy.minimum_parallel_overlap_ratio],
    ["minimum_face_pair_overlap_ratio", policy.minimum_face_pair_overlap_ratio],
    ["minimum_face_pair_candidate_coverage", policy.minimum_face_pair_candidate_coverage],
    ["opening_gap_maximum_ink_ratio", policy.opening_gap_maximum_ink_ratio],
    ["opening_gap_minimum_flank_coverage", policy.opening_gap_minimum_flank_coverage],
    ["opening_gap_minimum_profile_ink_coverage", policy.opening_gap_minimum_profile_ink_coverage],
    ["minimum_opening_host_source_ink_coverage", policy.minimum_opening_host_source_ink_coverage],
    ["minimum_opening_gap_evidence_score", policy.minimum_opening_gap_evidence_score],
    ["ambiguity_score_gap", policy.ambiguity_score_gap]
  ] as const) {
    finite(value, label);
    if (value < 0 || value > 1) throw new Error(`${label}_must_be_between_zero_and_one`);
  }
  return policy;
}

async function loadMasks(
  sourcePath: string,
  candidatePath: string,
  width: number,
  height: number,
  inkThreshold: number
): Promise<{ source: Uint8Array; candidate: Uint8Array }> {
  const [sourceImage, candidateImage] = await Promise.all([loadImage(sourcePath), loadImage(candidatePath)]);
  if (sourceImage.width !== width || sourceImage.height !== height || candidateImage.width !== width || candidateImage.height !== height) {
    throw new Error("architectural_wall_line_candidate_image_dimensions_mismatch");
  }
  const sourceCanvas = createCanvas(width, height);
  const sourceContext = sourceCanvas.getContext("2d");
  sourceContext.drawImage(sourceImage, 0, 0);
  const sourcePixels = sourceContext.getImageData(0, 0, width, height).data;
  const candidateCanvas = createCanvas(width, height);
  const candidateContext = candidateCanvas.getContext("2d");
  candidateContext.drawImage(candidateImage, 0, 0);
  const candidatePixels = candidateContext.getImageData(0, 0, width, height).data;
  const source = new Uint8Array(width * height);
  const candidate = new Uint8Array(width * height);
  for (let index = 0; index < source.length; index += 1) {
    const offset = index * 4;
    const luminance = 0.2126 * sourcePixels[offset]! + 0.7152 * sourcePixels[offset + 1]! + 0.0722 * sourcePixels[offset + 2]!;
    source[index] = sourcePixels[offset + 3]! > 25 && luminance < inkThreshold ? 1 : 0;
    candidate[index] = candidatePixels[offset + 3]! > 25 ? 1 : 0;
  }
  return { source, candidate };
}

function boundaryPoints(mask: Uint8Array, width: number, height: number, stride: number): HoughPoint[] {
  const points: HoughPoint[] = [];
  const present = (x: number, y: number): boolean => x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] === 1;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (!present(x, y)) continue;
      if (present(x - stride, y) && present(x + stride, y) && present(x, y - stride) && present(x, y + stride)) continue;
      points.push({ x, y });
    }
  }
  if (points.length <= 60_000) return points;
  const step = Math.ceil(points.length / 60_000);
  return points.filter((_, index) => index % step === 0);
}

function maskNear(mask: Uint8Array, width: number, height: number, x: number, y: number, radius: number): boolean {
  const centerX = Math.round(x);
  const centerY = Math.round(y);
  const minX = Math.max(0, centerX - radius);
  const maxX = Math.min(width - 1, centerX + radius);
  const minY = Math.max(0, centerY - radius);
  const maxY = Math.min(height - 1, centerY + radius);
  for (let yy = minY; yy <= maxY; yy += 1) {
    for (let xx = minX; xx <= maxX; xx += 1) {
      if (mask[yy * width + xx]) return true;
    }
  }
  return false;
}

function evaluateLine(
  points: HoughPoint[],
  sourceMask: Uint8Array,
  candidateMask: Uint8Array,
  width: number,
  height: number,
  angleDegrees: number,
  rho: number,
  pixelsPerFoot: number,
  diagonalFt: number,
  policy: ArchitecturalWallLineCandidatePolicy
): RawLine | null {
  const radians = angleDegrees * Math.PI / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const nx = -dy;
  const ny = dx;
  const projections: number[] = [];
  for (const entry of points) {
    if (Math.abs(entry.x * nx + entry.y * ny - rho) <= policy.support_distance_px) {
      projections.push(entry.x * dx + entry.y * dy);
    }
  }
  if (projections.length < 8) return null;
  projections.sort((a, b) => a - b);
  let bestStart = projections[0]!;
  let bestEnd = projections[0]!;
  let segmentStart = projections[0]!;
  let previous = projections[0]!;
  const maximumGap = Math.max(policy.maximum_support_gap_px, policy.maximum_wall_interruption_ft * pixelsPerFoot);
  for (let index = 1; index < projections.length; index += 1) {
    const current = projections[index]!;
    if (current - previous > maximumGap) {
      if (previous - segmentStart > bestEnd - bestStart) {
        bestStart = segmentStart;
        bestEnd = previous;
      }
      segmentStart = current;
    }
    previous = current;
  }
  if (previous - segmentStart > bestEnd - bestStart) {
    bestStart = segmentStart;
    bestEnd = previous;
  }
  const baseX = nx * rho;
  const baseY = ny * rho;
  const extensionStep = Math.max(2, policy.sampling_stride_px);
  const maximumExtension = policy.maximum_source_endpoint_extension_ft * pixelsPerFoot;
  const maximumEndpointGap = policy.maximum_source_endpoint_gap_ft * pixelsPerFoot;
  const extend = (initial: number, direction: -1 | 1): number => {
    let lastSupported = initial;
    let unsupportedDistance = 0;
    for (let distance = extensionStep; distance <= maximumExtension; distance += extensionStep) {
      const projection = initial + direction * distance;
      const x = baseX + dx * projection;
      const y = baseY + dy * projection;
      if (x < 0 || x > width || y < 0 || y > height) break;
      if (maskNear(sourceMask, width, height, x, y, Math.max(1, Math.ceil(policy.support_distance_px)))) {
        lastSupported = projection;
        unsupportedDistance = 0;
      } else {
        unsupportedDistance += extensionStep;
        if (unsupportedDistance > maximumEndpointGap) break;
      }
    }
    return lastSupported;
  };
  bestStart = extend(bestStart, -1);
  bestEnd = extend(bestEnd, 1);
  const lengthPx = bestEnd - bestStart;
  if (lengthPx < policy.minimum_length_ft * pixelsPerFoot) return null;
  const start = { x: baseX + dx * bestStart, y: baseY + dy * bestStart };
  const end = { x: baseX + dx * bestEnd, y: baseY + dy * bestEnd };
  if ([start.x, start.y, end.x, end.y].some((value) => value < -policy.support_distance_px || value > Math.max(width, height) + policy.support_distance_px)) {
    return null;
  }
  const sampleSpacing = Math.max(3, policy.sampling_stride_px * 2);
  const sampleCount = Math.max(2, Math.ceil(lengthPx / sampleSpacing) + 1);
  let candidateSupported = 0;
  let sourceSupported = 0;
  const radius = Math.max(1, Math.ceil(policy.support_distance_px));
  for (let index = 0; index < sampleCount; index += 1) {
    const t = sampleCount === 1 ? 0 : index / (sampleCount - 1);
    const x = start.x + (end.x - start.x) * t;
    const y = start.y + (end.y - start.y) * t;
    if (maskNear(candidateMask, width, height, x, y, radius)) candidateSupported += 1;
    if (maskNear(sourceMask, width, height, x, y, radius)) sourceSupported += 1;
  }
  const candidateCoverage = candidateSupported / sampleCount;
  const sourceCoverage = sourceSupported / sampleCount;
  const lengthFt = lengthPx / pixelsPerFoot;
  const normalizedLength = Math.min(1, lengthFt / Math.max(1, Math.min(20, diagonalFt)));
  const score = 0.55 * normalizedLength + 0.3 * candidateCoverage + 0.15 * sourceCoverage;
  return {
    derivation: "detected_line",
    angle_degrees: round((angleDegrees + 180) % 180),
    rho,
    pixel_points: [start, end],
    length_px: lengthPx,
    candidate_coverage: candidateCoverage,
    source_ink_coverage: sourceCoverage,
    rank_score: score,
    face_separation_px: null,
    supporting_face_pixel_points: null
  };
}

function lineOverlap(a: RawLine, b: RawLine): number {
  const radians = a.angle_degrees * Math.PI / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const project = (point: Point2): number => point.x * dx + point.y * dy;
  const aValues = a.pixel_points.map(project).sort((x, y) => x - y);
  const bValues = b.pixel_points.map(project).sort((x, y) => x - y);
  const overlap = Math.max(0, Math.min(aValues[1]!, bValues[1]!) - Math.max(aValues[0]!, bValues[0]!));
  return overlap / Math.max(1, Math.min(aValues[1]! - aValues[0]!, bValues[1]! - bValues[0]!));
}

function perpendicularDistance(a: RawLine, b: RawLine): number {
  const radians = a.angle_degrees * Math.PI / 180;
  const nx = -Math.sin(radians);
  const ny = Math.cos(radians);
  const midpoint = {
    x: (b.pixel_points[0].x + b.pixel_points[1].x) / 2,
    y: (b.pixel_points[0].y + b.pixel_points[1].y) / 2
  };
  return Math.abs(midpoint.x * nx + midpoint.y * ny - a.rho);
}

function sameLine(
  a: RawLine,
  b: RawLine,
  pixelsPerFoot: number,
  policy: ArchitecturalWallLineCandidatePolicy
): boolean {
  return angleDifference(a.angle_degrees, b.angle_degrees) <= policy.duplicate_angle_tolerance_degrees
    && perpendicularDistance(a, b) <= policy.duplicate_separation_ft * pixelsPerFoot
    && lineOverlap(a, b) >= 0.6;
}

function stableCandidateId(line: RawLine): string {
  const payload = [
    line.derivation,
    ...line.pixel_points.flatMap((entry) => [round(entry.x), round(entry.y)]),
    line.face_separation_px === null ? "none" : round(line.face_separation_px)
  ].join("|");
  return `line-${crypto.createHash("sha256").update(payload).digest("hex").slice(0, 12)}`;
}

function buildFacePairMidlines(
  raw: RawLine[],
  pixelsPerFoot: number,
  policy: ArchitecturalWallLineCandidatePolicy
): RawLine[] {
  const inputs = raw
    .filter((entry) => entry.derivation === "detected_line")
    .slice(0, policy.maximum_face_pair_inputs);
  const midlines: RawLine[] = [];
  for (let aIndex = 0; aIndex < inputs.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < inputs.length; bIndex += 1) {
      const a = inputs[aIndex]!;
      const b = inputs[bIndex]!;
      if (angleDifference(a.angle_degrees, b.angle_degrees) > policy.face_pair_angle_tolerance_degrees) continue;
      const separationPx = perpendicularDistance(a, b);
      const separationFt = separationPx / pixelsPerFoot;
      if (separationFt < policy.minimum_face_pair_separation_ft
        || separationFt > policy.maximum_face_pair_separation_ft) continue;
      const overlap = lineOverlap(a, b);
      if (overlap < policy.minimum_face_pair_overlap_ratio) continue;
      const radians = a.angle_degrees * Math.PI / 180;
      const dx = Math.cos(radians);
      const dy = Math.sin(radians);
      const nx = -dy;
      const ny = dx;
      const project = (point: Point2): number => point.x * dx + point.y * dy;
      const aInterval = a.pixel_points.map(project).sort((x, y) => x - y);
      const bInterval = b.pixel_points.map(project).sort((x, y) => x - y);
      const startProjection = Math.max(aInterval[0]!, bInterval[0]!);
      const endProjection = Math.min(aInterval[1]!, bInterval[1]!);
      const lengthPx = endProjection - startProjection;
      if (lengthPx < policy.minimum_length_ft * pixelsPerFoot) continue;
      const aMidpoint = {
        x: (a.pixel_points[0].x + a.pixel_points[1].x) / 2,
        y: (a.pixel_points[0].y + a.pixel_points[1].y) / 2
      };
      const bMidpoint = {
        x: (b.pixel_points[0].x + b.pixel_points[1].x) / 2,
        y: (b.pixel_points[0].y + b.pixel_points[1].y) / 2
      };
      const centerRho = ((aMidpoint.x * nx + aMidpoint.y * ny) + (bMidpoint.x * nx + bMidpoint.y * ny)) / 2;
      const baseX = nx * centerRho;
      const baseY = ny * centerRho;
      const candidateCoverage = Math.min(a.candidate_coverage, b.candidate_coverage);
      const sourceCoverage = Math.min(a.source_ink_coverage, b.source_ink_coverage);
      if (candidateCoverage < policy.minimum_face_pair_candidate_coverage) continue;
      const score = Math.min(1, (a.rank_score + b.rank_score) / 2 + 0.08 + 0.08 * overlap);
      midlines.push({
        derivation: "parallel_face_midline",
        angle_degrees: a.angle_degrees,
        rho: centerRho,
        pixel_points: [
          { x: baseX + dx * startProjection, y: baseY + dy * startProjection },
          { x: baseX + dx * endProjection, y: baseY + dy * endProjection }
        ],
        length_px: lengthPx,
        candidate_coverage: candidateCoverage,
        source_ink_coverage: sourceCoverage,
        rank_score: score,
        face_separation_px: separationPx,
        supporting_face_pixel_points: [a.pixel_points, b.pixel_points]
      });
    }
  }
  return midlines;
}

function detectLines(
  points: HoughPoint[],
  sourceMask: Uint8Array,
  candidateMask: Uint8Array,
  width: number,
  height: number,
  pixelsPerFoot: number,
  diagonalFt: number,
  policy: ArchitecturalWallLineCandidatePolicy
): RawLine[] {
  if (points.length < 8) return [];
  const diagonalPx = Math.hypot(width, height);
  const rhoBins = Math.ceil(2 * diagonalPx / policy.rho_bin_px) + 1;
  const raw: RawLine[] = [];
  for (let angle = 0; angle < 180; angle += policy.angle_step_degrees) {
    const radians = angle * Math.PI / 180;
    const nx = -Math.sin(radians);
    const ny = Math.cos(radians);
    const accumulator = new Uint32Array(rhoBins);
    for (const entry of points) {
      const rho = entry.x * nx + entry.y * ny;
      const index = Math.round((rho + diagonalPx) / policy.rho_bin_px);
      if (index >= 0 && index < accumulator.length) accumulator[index] += 1;
    }
    const peaks: Array<{ index: number; votes: number }> = [];
    for (let index = 1; index < accumulator.length - 1; index += 1) {
      const votes = accumulator[index]!;
      if (votes < 8 || votes < accumulator[index - 1]! || votes < accumulator[index + 1]!) continue;
      peaks.push({ index, votes });
    }
    peaks.sort((a, b) => b.votes - a.votes || a.index - b.index);
    const selectedPeaks: Array<{ index: number; votes: number }> = [];
    const duplicateRhoDistance = policy.hough_peak_duplicate_separation_ft * pixelsPerFoot;
    for (const peak of peaks) {
      const rho = peak.index * policy.rho_bin_px - diagonalPx;
      if (selectedPeaks.some((selected) => {
        const selectedRho = selected.index * policy.rho_bin_px - diagonalPx;
        return Math.abs(selectedRho - rho) <= duplicateRhoDistance;
      })) continue;
      selectedPeaks.push(peak);
      if (selectedPeaks.length >= 18) break;
    }
    for (const peak of selectedPeaks) {
      const rho = peak.index * policy.rho_bin_px - diagonalPx;
      const evaluated = evaluateLine(
        points,
        sourceMask,
        candidateMask,
        width,
        height,
        angle,
        rho,
        pixelsPerFoot,
        diagonalFt,
        policy
      );
      if (evaluated) raw.push(evaluated);
    }
  }
  raw.sort((a, b) => b.rank_score - a.rank_score || b.length_px - a.length_px || a.angle_degrees - b.angle_degrees);
  const combined = [...buildFacePairMidlines(raw, pixelsPerFoot, policy), ...raw];
  combined.sort((a, b) => b.rank_score - a.rank_score
    || (a.derivation === b.derivation ? 0 : a.derivation === "parallel_face_midline" ? -1 : 1)
    || b.length_px - a.length_px
    || a.angle_degrees - b.angle_degrees);
  const accepted: RawLine[] = [];
  for (const entry of combined) {
    if (accepted.some((other) => sameLine(entry, other, pixelsPerFoot, policy))) continue;
    accepted.push(entry);
    if (accepted.length >= policy.maximum_candidates) break;
  }
  return accepted;
}

function buildAmbiguities(
  raw: RawLine[],
  candidates: ArchitecturalWallLineCandidate[],
  pixelsPerFoot: number,
  policy: ArchitecturalWallLineCandidatePolicy
): ArchitecturalWallLineAmbiguity[] {
  const ambiguities: ArchitecturalWallLineAmbiguity[] = [];
  for (let aIndex = 0; aIndex < raw.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < raw.length; bIndex += 1) {
      const a = raw[aIndex]!;
      const b = raw[bIndex]!;
      const angle = angleDifference(a.angle_degrees, b.angle_degrees);
      const separationFt = perpendicularDistance(a, b) / pixelsPerFoot;
      const overlap = lineOverlap(a, b);
      const scoreGap = Math.abs(a.rank_score - b.rank_score);
      const parallel = angle <= policy.parallel_angle_tolerance_degrees
        && separationFt >= policy.minimum_parallel_separation_ft
        && separationFt <= policy.maximum_parallel_separation_ft
        && overlap >= policy.minimum_parallel_overlap_ratio;
      const nearEqual = angle <= policy.parallel_angle_tolerance_degrees
        && separationFt <= policy.maximum_parallel_separation_ft
        && scoreGap <= policy.ambiguity_score_gap
        && overlap >= policy.minimum_parallel_overlap_ratio;
      if (!parallel && !nearEqual) continue;
      const candidateIds: [string, string] = [candidates[aIndex]!.candidate_id, candidates[bIndex]!.candidate_id];
      ambiguities.push({
        ambiguity_id: `ambiguity-${crypto.createHash("sha256").update(candidateIds.join("|")).digest("hex").slice(0, 12)}`,
        candidate_ids: candidateIds,
        reason: parallel ? "parallel_overlapping_wall_lines" : "near_equal_rank",
        angle_difference_degrees: round(angle),
        perpendicular_separation_ft: round(separationFt),
        overlap_ratio: round(overlap),
        score_gap: round(scoreGap)
      });
    }
  }
  return ambiguities;
}

function buildJunctionHypotheses(
  candidates: ArchitecturalWallLineCandidate[],
  pixelsPerFoot: number,
  scope: ArchitecturalSourceDeltaReceipt["scope_model_bounds"],
  width: number,
  height: number,
  policy: ArchitecturalWallLineCandidatePolicy
): ArchitecturalWallJunctionHypothesis[] {
  const hypotheses: Omit<ArchitecturalWallJunctionHypothesis, "rank">[] = [];
  const paired = candidates.filter((candidate) => candidate.derivation === "parallel_face_midline");
  const cross = (a: Point2, b: Point2): number => a.x * b.y - a.y * b.x;
  const distance = (a: Point2, b: Point2): number => Math.hypot(a.x - b.x, a.y - b.y);
  for (let aIndex = 0; aIndex < paired.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < paired.length; bIndex += 1) {
      const a = paired[aIndex]!;
      const b = paired[bIndex]!;
      const angle = angleDifference(a.angle_degrees, b.angle_degrees);
      if (angle < policy.minimum_junction_angle_degrees || angle > policy.maximum_junction_angle_degrees) continue;
      const p = a.pixel_points[0];
      const q = b.pixel_points[0];
      const r = { x: a.pixel_points[1].x - p.x, y: a.pixel_points[1].y - p.y };
      const s = { x: b.pixel_points[1].x - q.x, y: b.pixel_points[1].y - q.y };
      const denominator = cross(r, s);
      if (Math.abs(denominator) <= 1e-9) continue;
      const qp = { x: q.x - p.x, y: q.y - p.y };
      const t = cross(qp, s) / denominator;
      const u = cross(qp, r) / denominator;
      const intersection = { x: p.x + t * r.x, y: p.y + t * r.y };
      const endpointDistancesFt: [number, number] = [
        Math.min(distance(intersection, a.pixel_points[0]), distance(intersection, a.pixel_points[1])) / pixelsPerFoot,
        Math.min(distance(intersection, b.pixel_points[0]), distance(intersection, b.pixel_points[1])) / pixelsPerFoot
      ];
      if (endpointDistancesFt.some((entry) => entry > policy.maximum_junction_endpoint_gap_ft)) continue;
      const aTolerance = policy.maximum_junction_endpoint_gap_ft * pixelsPerFoot / Math.max(1, a.length_ft * pixelsPerFoot);
      const bTolerance = policy.maximum_junction_endpoint_gap_ft * pixelsPerFoot / Math.max(1, b.length_ft * pixelsPerFoot);
      if (t < -aTolerance || t > 1 + aTolerance || u < -bTolerance || u > 1 + bTolerance) continue;
      if (intersection.x < 0 || intersection.x > width || intersection.y < 0 || intersection.y > height) continue;
      const orthogonality = 1 - Math.min(1, Math.abs(90 - angle) / 45);
      const endpointSupport = 1 - Math.min(1, Math.max(...endpointDistancesFt) / policy.maximum_junction_endpoint_gap_ft);
      const topologyScore = Math.min(1, (a.rank_score + b.rank_score) / 2 + 0.08 * orthogonality + 0.08 * endpointSupport);
      const candidateIds: [string, string] = [a.candidate_id, b.candidate_id].sort() as [string, string];
      hypotheses.push({
        junction_id: `junction-${crypto.createHash("sha256").update(candidateIds.join("|")).digest("hex").slice(0, 12)}`,
        candidate_ids: candidateIds,
        pixel_point: { x: round(intersection.x), y: round(intersection.y) },
        model_point: (() => {
          const model = pointToModel(intersection, scope, width, height);
          return { x: round(model.x), y: round(model.y) };
        })(),
        angle_difference_degrees: round(angle),
        endpoint_distances_ft: endpointDistancesFt.map(round) as [number, number],
        topology_score: round(topologyScore)
      });
    }
  }
  return hypotheses
    .sort((a, b) => b.topology_score - a.topology_score || a.junction_id.localeCompare(b.junction_id))
    .slice(0, policy.maximum_junction_hypotheses)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

type OpeningProfileGap = {
  host: ArchitecturalWallLineCandidate;
  profile_index: number;
  center_distance_px: number;
  pixel_center: Point2;
  width_px: number;
  offset_px: number;
  flank_ink_coverage: number;
  gap_ink_coverage: number;
  profile_ink_coverage: number;
  profile_axis_degrees: number;
};

function maskHasInk(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number
): boolean {
  const centerX = Math.round(x);
  const centerY = Math.round(y);
  for (let row = Math.max(0, centerY - radius); row <= Math.min(height - 1, centerY + radius); row += 1) {
    for (let column = Math.max(0, centerX - radius); column <= Math.min(width - 1, centerX + radius); column += 1) {
      if (mask[row * width + column]) return true;
    }
  }
  return false;
}

function profileOpeningGaps(
  host: ArchitecturalWallLineCandidate,
  sourceMask: Uint8Array,
  width: number,
  height: number,
  pixelsPerFoot: number,
  policy: ArchitecturalWallLineCandidatePolicy
): OpeningProfileGap[] {
  if (host.derivation !== "parallel_face_midline"
    || host.face_separation_ft === null
    || host.supporting_face_pixel_points === null
    || host.source_ink_coverage < policy.minimum_opening_host_source_ink_coverage) return [];
  const originalStart = host.pixel_points[0];
  const originalEnd = host.pixel_points[1];
  const lengthPx = Math.hypot(originalEnd.x - originalStart.x, originalEnd.y - originalStart.y);
  if (lengthPx <= 0) return [];
  const originalDirection = {
    x: (originalEnd.x - originalStart.x) / lengthPx,
    y: (originalEnd.y - originalStart.y) / lengthPx
  };
  const normalizedAngle = (Math.atan2(originalDirection.y, originalDirection.x) * 180 / Math.PI + 180) % 180;
  const nearestAxis = Math.abs(normalizedAngle - 90) < Math.min(normalizedAngle, 180 - normalizedAngle) ? 90 : 0;
  const axisDifference = nearestAxis === 90 ? Math.abs(normalizedAngle - 90) : Math.min(normalizedAngle, 180 - normalizedAngle);
  let direction = originalDirection;
  let profileAxisDegrees = normalizedAngle;
  if (axisDifference <= policy.opening_gap_axis_snap_tolerance_degrees) {
    const radians = nearestAxis * Math.PI / 180;
    const axis = { x: Math.cos(radians), y: Math.sin(radians) };
    const sign = axis.x * originalDirection.x + axis.y * originalDirection.y < 0 ? -1 : 1;
    direction = { x: axis.x * sign, y: axis.y * sign };
    profileAxisDegrees = nearestAxis;
  }
  const midpoint = {
    x: (originalStart.x + originalEnd.x) / 2,
    y: (originalStart.y + originalEnd.y) / 2
  };
  const start = { x: midpoint.x - direction.x * lengthPx / 2, y: midpoint.y - direction.y * lengthPx / 2 };
  const end = { x: midpoint.x + direction.x * lengthPx / 2, y: midpoint.y + direction.y * lengthPx / 2 };
  const normal = { x: -direction.y, y: direction.x };
  const minimumGapPx = Math.ceil(policy.minimum_opening_gap_width_ft * pixelsPerFoot);
  const maximumGapPx = Math.floor(policy.maximum_opening_gap_width_ft * pixelsPerFoot);
  const flankPx = Math.max(1, Math.round(policy.opening_gap_flank_ft * pixelsPerFoot));
  const maximumInternalInkPx = Math.max(0, Math.round(policy.opening_gap_maximum_internal_ink_ft * pixelsPerFoot));
  const hostMidpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const faceOffsets = host.supporting_face_pixel_points.map((face) => {
    const midpoint = { x: (face[0].x + face[1].x) / 2, y: (face[0].y + face[1].y) / 2 };
    return (midpoint.x - hostMidpoint.x) * normal.x + (midpoint.y - hostMidpoint.y) * normal.y;
  });
  const faceProfileBandPx = policy.opening_gap_face_profile_band_ft * pixelsPerFoot;
  const profileOffsets = faceOffsets.flatMap((faceOffset) => Array.from(
    { length: policy.opening_gap_face_profile_sample_count },
    (_, sampleIndex) => faceOffset + faceProfileBandPx
      * (sampleIndex / (policy.opening_gap_face_profile_sample_count - 1) * 2 - 1)
  ));
  const sampleLength = Math.max(1, Math.round(lengthPx));
  const gaps: OpeningProfileGap[] = [];
  for (let profileIndex = 0; profileIndex < profileOffsets.length; profileIndex += 1) {
    const offsetPx = profileOffsets[profileIndex]!;
    const supported = new Uint8Array(sampleLength + 1);
    for (let index = 0; index <= sampleLength; index += 1) {
      const distancePx = index / sampleLength * lengthPx;
      const x = start.x + direction.x * distancePx + normal.x * offsetPx;
      const y = start.y + direction.y * distancePx + normal.y * offsetPx;
      supported[index] = maskHasInk(
        sourceMask,
        width,
        height,
        x,
        y,
        policy.opening_gap_support_radius_px
      ) ? 1 : 0;
    }
    const blankRuns: Array<{ start: number; end: number }> = [];
    const totalProfileInk = supported.reduce((sum, value) => sum + value, 0);
    let blankStart: number | null = null;
    for (let index = 0; index <= sampleLength; index += 1) {
      if (!supported[index] && blankStart === null) blankStart = index;
      if (supported[index] && blankStart !== null) {
        blankRuns.push({ start: blankStart, end: index - 1 });
        blankStart = null;
      }
    }
    if (blankStart !== null) blankRuns.push({ start: blankStart, end: sampleLength });
    const merged: Array<{ start: number; end: number }> = [];
    for (const run of blankRuns) {
      const previous = merged.at(-1);
      if (previous && run.start - previous.end - 1 <= maximumInternalInkPx) previous.end = run.end;
      else merged.push({ ...run });
    }
    for (const run of merged) {
      const widthPx = run.end - run.start + 1;
      if (widthPx < minimumGapPx || widthPx > maximumGapPx) continue;
      if (run.start < flankPx || run.end + flankPx > sampleLength) continue;
      let gapInk = 0;
      for (let index = run.start; index <= run.end; index += 1) gapInk += supported[index]!;
      const gapInkCoverage = gapInk / widthPx;
      if (gapInkCoverage > policy.opening_gap_maximum_ink_ratio) continue;
      const outsideGapLength = supported.length - widthPx;
      const profileInkCoverage = outsideGapLength <= 0 ? 0 : (totalProfileInk - gapInk) / outsideGapLength;
      if (profileInkCoverage < policy.opening_gap_minimum_profile_ink_coverage) continue;
      let flankInk = 0;
      for (let index = run.start - flankPx; index < run.start; index += 1) flankInk += supported[index]!;
      for (let index = run.end + 1; index <= run.end + flankPx; index += 1) flankInk += supported[index]!;
      const flankCoverage = flankInk / (flankPx * 2);
      if (flankCoverage < policy.opening_gap_minimum_flank_coverage) continue;
      gaps.push({
        host,
        profile_index: profileIndex,
        center_distance_px: (run.start + run.end) / 2 / sampleLength * lengthPx,
        pixel_center: {
          x: start.x + direction.x * ((run.start + run.end) / 2 / sampleLength * lengthPx),
          y: start.y + direction.y * ((run.start + run.end) / 2 / sampleLength * lengthPx)
        },
        width_px: widthPx / sampleLength * lengthPx,
        offset_px: offsetPx,
        flank_ink_coverage: flankCoverage,
        gap_ink_coverage: gapInkCoverage,
        profile_ink_coverage: profileInkCoverage,
        profile_axis_degrees: profileAxisDegrees
      });
    }
  }
  return gaps;
}

function buildOpeningGapHypotheses(
  candidates: ArchitecturalWallLineCandidate[],
  sourceMask: Uint8Array,
  width: number,
  height: number,
  pixelsPerFoot: number,
  scope: ArchitecturalSourceDeltaReceipt["scope_model_bounds"],
  policy: ArchitecturalWallLineCandidatePolicy
): ArchitecturalOpeningGapHypothesis[] {
  const allGaps = candidates.flatMap((candidate) => profileOpeningGaps(
    candidate,
    sourceMask,
    width,
    height,
    pixelsPerFoot,
    policy
  ));
  const groups: OpeningProfileGap[][] = [];
  for (const gap of allGaps.sort((a, b) => a.host.candidate_id.localeCompare(b.host.candidate_id)
    || a.center_distance_px - b.center_distance_px
    || a.profile_index - b.profile_index)) {
    const group = groups.find((entries) => entries[0]!.host.candidate_id === gap.host.candidate_id
      && Math.abs(entries.reduce((sum, entry) => sum + entry.center_distance_px, 0) / entries.length - gap.center_distance_px)
        <= policy.opening_gap_group_center_tolerance_ft * pixelsPerFoot
      && Math.abs(entries.reduce((sum, entry) => sum + entry.width_px, 0) / entries.length - gap.width_px)
        <= policy.opening_gap_group_width_tolerance_ft * pixelsPerFoot);
    if (group) group.push(gap);
    else groups.push([gap]);
  }
  const hypotheses: Omit<ArchitecturalOpeningGapHypothesis, "rank">[] = [];
  for (const group of groups) {
    const confirmingProfiles = new Set(group.map((entry) => entry.profile_index));
    if (confirmingProfiles.size < policy.opening_gap_minimum_confirming_profiles) continue;
    const host = group[0]!.host;
    const centerDistancePx = group.reduce((sum, entry) => sum + entry.center_distance_px, 0) / group.length;
    const widthPx = group.reduce((sum, entry) => sum + entry.width_px, 0) / group.length;
    const flankCoverage = group.reduce((sum, entry) => sum + entry.flank_ink_coverage, 0) / group.length;
    const gapInkCoverage = group.reduce((sum, entry) => sum + entry.gap_ink_coverage, 0) / group.length;
    const profileInkCoverage = group.reduce((sum, entry) => sum + entry.profile_ink_coverage, 0) / group.length;
    const lengthPx = Math.hypot(
      host.pixel_points[1].x - host.pixel_points[0].x,
      host.pixel_points[1].y - host.pixel_points[0].y
    );
    const pixelCenter = {
      x: group.reduce((sum, entry) => sum + entry.pixel_center.x, 0) / group.length,
      y: group.reduce((sum, entry) => sum + entry.pixel_center.y, 0) / group.length
    };
    const modelCenter = pointToModel(pixelCenter, scope, width, height);
    const offsetsFt = group.map((entry) => entry.offset_px / pixelsPerFoot).sort((a, b) => a - b);
    const profileConfirmation = Math.min(1, confirmingProfiles.size / policy.opening_gap_face_profile_sample_count);
    const evidenceScore = 0.35 * flankCoverage
      + 0.2 * (1 - gapInkCoverage)
      + 0.15 * profileInkCoverage
      + 0.15 * profileConfirmation
      + 0.15 * host.rank_score;
    const payload = [host.candidate_id, round(centerDistancePx), round(widthPx)].join("|");
    hypotheses.push({
      opening_hypothesis_id: `opening-${crypto.createHash("sha256").update(payload).digest("hex").slice(0, 12)}`,
      kind: "unclassified_opening_gap",
      host_candidate_id: host.candidate_id,
      pixel_center: { x: round(pixelCenter.x), y: round(pixelCenter.y) },
      model_center: { x: round(modelCenter.x), y: round(modelCenter.y) },
      width_ft: round(widthPx / pixelsPerFoot),
      host_chainage_ft: round(centerDistancePx / pixelsPerFoot),
      host_chainage_ratio: round(centerDistancePx / lengthPx),
      profile_axis_degrees: round(group[0]!.profile_axis_degrees),
      confirming_profile_count: confirmingProfiles.size,
      profile_offset_range_ft: [round(offsetsFt[0]!), round(offsetsFt.at(-1)!)],
      flank_ink_coverage: round(flankCoverage),
      gap_ink_coverage: round(gapInkCoverage),
      profile_ink_coverage: round(profileInkCoverage),
      evidence_score: round(Math.min(1, evidenceScore))
    });
  }
  return hypotheses
    .sort((a, b) => b.evidence_score - a.evidence_score || a.opening_hypothesis_id.localeCompare(b.opening_hypothesis_id))
    .filter((entry) => entry.evidence_score >= policy.minimum_opening_gap_evidence_score)
    .slice(0, policy.maximum_opening_gap_hypotheses)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

async function writeOverlay(
  sourcePath: string,
  width: number,
  height: number,
  candidates: ArchitecturalWallLineCandidate[],
  junctions: ArchitecturalWallJunctionHypothesis[],
  openingGaps: ArchitecturalOpeningGapHypothesis[],
  outDir: string
): Promise<ArchitecturalImageReference> {
  const source = await loadImage(sourcePath);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0);
  const colors = ["#e60049", "#0bb4ff", "#50e991", "#e6d800", "#9b19f5", "#ffa300"];
  for (const candidate of candidates) {
    const color = colors[(candidate.rank - 1) % colors.length]!;
    context.strokeStyle = color;
    context.lineWidth = candidate.derivation === "parallel_face_midline" ? 5 : 3;
    context.setLineDash(candidate.derivation === "parallel_face_midline" ? [] : [14, 8]);
    context.beginPath();
    context.moveTo(candidate.pixel_points[0].x, candidate.pixel_points[0].y);
    context.lineTo(candidate.pixel_points[1].x, candidate.pixel_points[1].y);
    context.stroke();
    context.setLineDash([]);
    const labelX = Math.max(4, Math.min(width - 96, candidate.pixel_points[0].x + 8));
    const labelY = Math.max(22, Math.min(height - 4, candidate.pixel_points[0].y - 8));
    context.fillStyle = "rgba(255,255,255,0.9)";
    context.fillRect(labelX - 3, labelY - 17, 92, 22);
    context.fillStyle = color;
    context.font = "bold 16px Arial";
    const prefix = candidate.derivation === "parallel_face_midline" ? "C" : "L";
    context.fillText(`${prefix}${candidate.rank} ${candidate.rank_score.toFixed(2)}`, labelX, labelY);
  }
  for (const junction of junctions) {
    context.strokeStyle = "#222222";
    context.fillStyle = "rgba(255,255,255,0.9)";
    context.lineWidth = 4;
    context.beginPath();
    context.arc(junction.pixel_point.x, junction.pixel_point.y, 12, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "#222222";
    context.font = "bold 15px Arial";
    context.fillText(`J${junction.rank}`, junction.pixel_point.x + 15, junction.pixel_point.y - 8);
  }
  for (const opening of openingGaps) {
    context.strokeStyle = "#00a6a6";
    context.fillStyle = "rgba(255,255,255,0.9)";
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(opening.pixel_center.x, opening.pixel_center.y - 14);
    context.lineTo(opening.pixel_center.x + 14, opening.pixel_center.y);
    context.lineTo(opening.pixel_center.x, opening.pixel_center.y + 14);
    context.lineTo(opening.pixel_center.x - 14, opening.pixel_center.y);
    context.closePath();
    context.fill();
    context.stroke();
    context.fillStyle = "#006d6d";
    context.font = "bold 15px Arial";
    context.fillText(`O${opening.rank}`, opening.pixel_center.x + 17, opening.pixel_center.y + 5);
  }
  const overlayPath = path.join(outDir, "wall_line_candidates.png");
  fs.writeFileSync(overlayPath, canvas.toBuffer("image/png"));
  return {
    path: overlayPath,
    sha256: sha256File(overlayPath),
    width_px: width,
    height_px: height
  };
}

async function writeOpeningEvidenceCrops(
  sourcePath: string,
  width: number,
  height: number,
  candidates: ArchitecturalWallLineCandidate[],
  openings: ArchitecturalOpeningGapHypothesis[],
  pixelsPerFoot: number,
  policy: ArchitecturalWallLineCandidatePolicy,
  outDir: string
): Promise<ArchitecturalOpeningEvidenceCrop[]> {
  if (openings.length === 0) return [];
  const source = await loadImage(sourcePath);
  const cropsDirectory = path.join(outDir, "opening_evidence");
  fs.mkdirSync(cropsDirectory);
  const result: ArchitecturalOpeningEvidenceCrop[] = [];
  for (const opening of openings) {
    const host = candidates.find((candidate) => candidate.candidate_id === opening.host_candidate_id);
    if (!host) throw new Error(`architectural_opening_crop_host_not_found:${opening.host_candidate_id}`);
    const start = host.pixel_points[0];
    const end = host.pixel_points[1];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length <= 0) throw new Error(`architectural_opening_crop_host_is_degenerate:${opening.host_candidate_id}`);
    const axis = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
    const normal = { x: -axis.y, y: axis.x };
    const halfAlong = Math.max(
      policy.opening_evidence_minimum_context_ft,
      opening.width_ft * policy.opening_evidence_width_multiplier
    ) * pixelsPerFoot;
    const halfNormal = Math.max(
      policy.opening_evidence_minimum_context_ft,
      opening.width_ft * policy.opening_evidence_width_multiplier
    ) * pixelsPerFoot;
    const corners = [-1, 1].flatMap((alongSign) => [-1, 1].map((normalSign) => ({
      x: opening.pixel_center.x + axis.x * halfAlong * alongSign + normal.x * halfNormal * normalSign,
      y: opening.pixel_center.y + axis.y * halfAlong * alongSign + normal.y * halfNormal * normalSign
    })));
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.x))));
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.y))));
    const maxX = Math.min(width, Math.ceil(Math.max(...corners.map((point) => point.x))));
    const maxY = Math.min(height, Math.ceil(Math.max(...corners.map((point) => point.y))));
    const cropWidth = maxX - minX;
    const cropHeight = maxY - minY;
    if (cropWidth <= 0 || cropHeight <= 0) throw new Error(`architectural_opening_crop_is_empty:${opening.opening_hypothesis_id}`);
    const rawCanvas = createCanvas(cropWidth, cropHeight);
    rawCanvas.getContext("2d").drawImage(source, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    const sourceCropPath = path.join(cropsDirectory, `${opening.opening_hypothesis_id}-source.png`);
    fs.writeFileSync(sourceCropPath, rawCanvas.toBuffer("image/png"));

    const overlayCanvas = createCanvas(cropWidth, cropHeight);
    const overlayContext = overlayCanvas.getContext("2d");
    overlayContext.drawImage(rawCanvas, 0, 0);
    const localCenter = { x: opening.pixel_center.x - minX, y: opening.pixel_center.y - minY };
    const halfGap = opening.width_ft * pixelsPerFoot / 2;
    overlayContext.strokeStyle = "#00a6a6";
    overlayContext.lineWidth = 3;
    overlayContext.setLineDash([10, 6]);
    overlayContext.beginPath();
    overlayContext.moveTo(localCenter.x - axis.x * halfAlong, localCenter.y - axis.y * halfAlong);
    overlayContext.lineTo(localCenter.x + axis.x * halfAlong, localCenter.y + axis.y * halfAlong);
    overlayContext.stroke();
    overlayContext.setLineDash([]);
    overlayContext.strokeStyle = "#ff006e";
    overlayContext.lineWidth = 4;
    for (const sign of [-1, 1]) {
      const point = {
        x: localCenter.x + axis.x * halfGap * sign,
        y: localCenter.y + axis.y * halfGap * sign
      };
      overlayContext.beginPath();
      overlayContext.moveTo(point.x - normal.x * 12, point.y - normal.y * 12);
      overlayContext.lineTo(point.x + normal.x * 12, point.y + normal.y * 12);
      overlayContext.stroke();
    }
    overlayContext.fillStyle = "#006d6d";
    overlayContext.font = "bold 15px Arial";
    overlayContext.fillText(opening.opening_hypothesis_id, 8, 20);
    const evidenceOverlayPath = path.join(cropsDirectory, `${opening.opening_hypothesis_id}-overlay.png`);
    fs.writeFileSync(evidenceOverlayPath, overlayCanvas.toBuffer("image/png"));
    result.push({
      opening_hypothesis_id: opening.opening_hypothesis_id,
      host_candidate_id: opening.host_candidate_id,
      crop_bounds_px: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY },
      source_crop: {
        path: sourceCropPath,
        sha256: sha256File(sourceCropPath),
        width_px: cropWidth,
        height_px: cropHeight
      },
      evidence_overlay: {
        path: evidenceOverlayPath,
        sha256: sha256File(evidenceOverlayPath),
        width_px: cropWidth,
        height_px: cropHeight
      }
    });
  }
  return result;
}

export async function buildArchitecturalWallLineCandidates(
  delta: ArchitecturalSourceDeltaReceipt,
  deltaReceiptSha256: string,
  measurement: ArchitecturalMeasurementOverlayReceipt,
  measurementReceiptSha256: string,
  outDir: string,
  policyOverride: Partial<ArchitecturalWallLineCandidatePolicy> = {}
): Promise<ArchitecturalWallLineCandidateReceipt> {
  if (delta.schema_version !== 1 || delta.artifact_role !== "architectural_source_redacted_delta") {
    throw new Error("architectural_wall_line_candidates_require_v1_delta");
  }
  if (measurement.schema_version !== 1 || measurement.artifact_role !== "architectural_registered_measurement_overlay") {
    throw new Error("architectural_wall_line_candidates_require_v1_measurement");
  }
  const deltaHash = sha256Text(deltaReceiptSha256, "architectural_delta_receipt_sha256");
  const measurementHash = sha256Text(measurementReceiptSha256, "measurement_receipt_sha256");
  if (measurement.architectural_delta_receipt_sha256 !== deltaHash) throw new Error("architectural_wall_line_delta_receipt_mismatch");
  if (measurement.fixture_id !== delta.fixture_id || measurement.scope_id !== delta.scope_id) {
    throw new Error("architectural_wall_line_fixture_or_scope_mismatch");
  }
  if (measurement.source_aligned_sha256 !== delta.artifacts.source_aligned.sha256
    || measurement.candidate_delta_mask_sha256 !== delta.artifacts.candidate_delta_mask.sha256) {
    throw new Error("architectural_wall_line_measurement_image_hash_mismatch");
  }
  const width = positiveInteger(delta.output_frame.width_px, "output_width_px");
  const height = positiveInteger(delta.output_frame.height_px, "output_height_px");
  if (measurement.output_frame.width_px !== width || measurement.output_frame.height_px !== height) {
    throw new Error("architectural_wall_line_measurement_dimensions_mismatch");
  }
  const sourcePath = imageReference(delta.artifacts.source_aligned, "source_aligned", width, height);
  const candidatePath = imageReference(delta.artifacts.candidate_delta_mask, "candidate_delta_mask", width, height);
  const resolvedOutDir = path.resolve(outDir);
  if (fs.existsSync(resolvedOutDir) && fs.readdirSync(resolvedOutDir).length > 0) {
    throw new Error(`refusing_to_overwrite_architectural_wall_line_candidates:${resolvedOutDir}`);
  }
  fs.mkdirSync(resolvedOutDir, { recursive: true });
  const policy = policyFor(width, height, policyOverride);
  const masks = await loadMasks(
    sourcePath,
    candidatePath,
    width,
    height,
    delta.render_policy.ink_luminance_threshold
  );
  const points = boundaryPoints(masks.candidate, width, height, policy.sampling_stride_px);
  const pixelsPerFootX = width / (delta.scope_model_bounds.max.x - delta.scope_model_bounds.min.x);
  const pixelsPerFootY = height / (delta.scope_model_bounds.max.y - delta.scope_model_bounds.min.y);
  if (Math.abs(pixelsPerFootX - pixelsPerFootY) > 1e-6) throw new Error("architectural_wall_line_requires_isotropic_registered_pixels");
  const pixelsPerFoot = (pixelsPerFootX + pixelsPerFootY) / 2;
  const diagonalFt = Math.hypot(
    delta.scope_model_bounds.max.x - delta.scope_model_bounds.min.x,
    delta.scope_model_bounds.max.y - delta.scope_model_bounds.min.y
  );
  const raw = detectLines(points, masks.source, masks.candidate, width, height, pixelsPerFoot, diagonalFt, policy);
  const candidates: ArchitecturalWallLineCandidate[] = raw.map((line, index) => ({
    candidate_id: stableCandidateId(line),
    rank: index + 1,
    derivation: line.derivation,
    pixel_points: line.pixel_points.map((entry) => ({
      x: round(Math.max(0, Math.min(width, entry.x))),
      y: round(Math.max(0, Math.min(height, entry.y)))
    })) as [Point2, Point2],
    model_points: line.pixel_points.map((entry) => {
      const model = pointToModel({
        x: Math.max(0, Math.min(width, entry.x)),
        y: Math.max(0, Math.min(height, entry.y))
      }, delta.scope_model_bounds, width, height);
      return { x: round(model.x), y: round(model.y) };
    }) as [Point2, Point2],
    face_separation_ft: line.face_separation_px === null ? null : round(line.face_separation_px / pixelsPerFoot),
    supporting_face_pixel_points: line.supporting_face_pixel_points === null ? null : line.supporting_face_pixel_points.map(
      (face) => face.map((entry) => ({
        x: round(Math.max(0, Math.min(width, entry.x))),
        y: round(Math.max(0, Math.min(height, entry.y)))
      })) as [Point2, Point2]
    ) as [[Point2, Point2], [Point2, Point2]],
    supporting_face_model_points: line.supporting_face_pixel_points === null ? null : line.supporting_face_pixel_points.map(
      (face) => face.map((entry) => {
        const model = pointToModel({
          x: Math.max(0, Math.min(width, entry.x)),
          y: Math.max(0, Math.min(height, entry.y))
        }, delta.scope_model_bounds, width, height);
        return { x: round(model.x), y: round(model.y) };
      }) as [Point2, Point2]
    ) as [[Point2, Point2], [Point2, Point2]],
    angle_degrees: line.angle_degrees,
    length_ft: round(line.length_px / pixelsPerFoot),
    candidate_coverage: round(line.candidate_coverage),
    source_ink_coverage: round(line.source_ink_coverage),
    rank_score: round(line.rank_score)
  }));
  const junctionHypotheses = buildJunctionHypotheses(
    candidates,
    pixelsPerFoot,
    delta.scope_model_bounds,
    width,
    height,
    policy
  );
  const openingGapHypotheses = buildOpeningGapHypotheses(
    candidates,
    masks.candidate,
    width,
    height,
    pixelsPerFoot,
    delta.scope_model_bounds,
    policy
  );
  const ambiguities = buildAmbiguities(raw, candidates, pixelsPerFoot, policy);
  const status = candidates.length === 0 ? "blocked" : ambiguities.length > 0 ? "clarification_required" : "candidates_ready";
  const overlay = await writeOverlay(
    sourcePath,
    width,
    height,
    candidates,
    junctionHypotheses,
    openingGapHypotheses,
    resolvedOutDir
  );
  const openingEvidenceCrops = await writeOpeningEvidenceCrops(
    sourcePath,
    width,
    height,
    candidates,
    openingGapHypotheses,
    pixelsPerFoot,
    policy,
    resolvedOutDir
  );
  return {
    schema_version: 1,
    artifact_role: "architectural_wall_line_candidates",
    fixture_id: delta.fixture_id,
    scope_id: delta.scope_id,
    architectural_delta_receipt_sha256: deltaHash,
    measurement_receipt_sha256: measurementHash,
    source_aligned_sha256: delta.artifacts.source_aligned.sha256,
    candidate_delta_mask_sha256: delta.artifacts.candidate_delta_mask.sha256,
    status,
    policy,
    candidates,
    junction_hypotheses: junctionHypotheses,
    opening_gap_hypotheses: openingGapHypotheses,
    opening_evidence_crops: openingEvidenceCrops,
    ambiguities,
    clarification_question: status === "clarification_required"
      ? "Multiple source-supported wall-line candidates overlap or have near-equal rank. Confirm the intended wall centerline/host candidate before compiling openings or any native action."
      : status === "blocked"
        ? "No source-supported wall-line candidate met the declared deterministic extraction policy."
        : null,
    overlay,
    usage_constraints: [
      "Candidates are deterministic image measurements, not selected truth and not native Revit actions.",
      "Parallel-face midlines are explicit centerline hypotheses derived from two supported face lines; their measured face separation and supporting faces must be reconciled semantically before selection.",
      "Junction hypotheses identify near-endpoint intersections between paired-face centerlines and provide topology evidence only; they do not select either wall or authorize an opening host.",
      "Opening-gap hypotheses require a bounded low-ink interval across multiple normal wall-band profiles with supported ink on both flanks; they remain unclassified and bind only to a wall candidate, not a selected native host or family type.",
      "Parallel or near-equal candidates remain explicit ambiguities; rank alone must not authorize a wall or opening host.",
      "Candidate geometry is derived only from hash-bound source-aligned and source-only delta images in the registered frame.",
      "Opening recognition, wall type/thickness, vertical extents, and family/type promotion remain separate evidence-gated steps."
    ]
  };
}
