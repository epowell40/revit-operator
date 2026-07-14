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
  duplicate_angle_tolerance_degrees: number;
  duplicate_separation_ft: number;
  parallel_angle_tolerance_degrees: number;
  minimum_parallel_separation_ft: number;
  maximum_parallel_separation_ft: number;
  minimum_parallel_overlap_ratio: number;
  ambiguity_score_gap: number;
};

export type ArchitecturalWallLineCandidate = {
  candidate_id: string;
  rank: number;
  pixel_points: [Point2, Point2];
  model_points: [Point2, Point2];
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

type ImageReference = {
  path: string;
  sha256: string;
  width_px: number;
  height_px: number;
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
  ambiguities: ArchitecturalWallLineAmbiguity[];
  clarification_question: string | null;
  overlay: ImageReference;
  usage_constraints: string[];
};

type HoughPoint = { x: number; y: number };
type RawLine = {
  angle_degrees: number;
  rho: number;
  pixel_points: [Point2, Point2];
  length_px: number;
  candidate_coverage: number;
  source_ink_coverage: number;
  rank_score: number;
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
  duplicate_angle_tolerance_degrees: 8,
  duplicate_separation_ft: 0.65,
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

function imageReference(reference: ImageReference, label: string, width: number, height: number): string {
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
  positive(policy.duplicate_angle_tolerance_degrees, "duplicate_angle_tolerance_degrees");
  positive(policy.duplicate_separation_ft, "duplicate_separation_ft");
  positive(policy.parallel_angle_tolerance_degrees, "parallel_angle_tolerance_degrees");
  positive(policy.minimum_parallel_separation_ft, "minimum_parallel_separation_ft");
  positive(policy.maximum_parallel_separation_ft, "maximum_parallel_separation_ft");
  if (policy.maximum_parallel_separation_ft <= policy.minimum_parallel_separation_ft) {
    throw new Error("maximum_parallel_separation_ft_must_exceed_minimum");
  }
  for (const [label, value] of [
    ["minimum_parallel_overlap_ratio", policy.minimum_parallel_overlap_ratio],
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
    angle_degrees: round((angleDegrees + 180) % 180),
    rho,
    pixel_points: [start, end],
    length_px: lengthPx,
    candidate_coverage: candidateCoverage,
    source_ink_coverage: sourceCoverage,
    rank_score: score
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
  const payload = line.pixel_points.flatMap((entry) => [round(entry.x), round(entry.y)]).join("|");
  return `line-${crypto.createHash("sha256").update(payload).digest("hex").slice(0, 12)}`;
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
    const duplicateRhoDistance = policy.duplicate_separation_ft * pixelsPerFoot;
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
  const accepted: RawLine[] = [];
  for (const entry of raw) {
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

async function writeOverlay(
  sourcePath: string,
  width: number,
  height: number,
  candidates: ArchitecturalWallLineCandidate[],
  outDir: string
): Promise<ImageReference> {
  const source = await loadImage(sourcePath);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0);
  const colors = ["#e60049", "#0bb4ff", "#50e991", "#e6d800", "#9b19f5", "#ffa300"];
  for (const candidate of candidates) {
    const color = colors[(candidate.rank - 1) % colors.length]!;
    context.strokeStyle = color;
    context.lineWidth = candidate.rank <= 2 ? 5 : 3;
    context.setLineDash(candidate.rank <= 2 ? [] : [14, 8]);
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
    context.fillText(`L${candidate.rank} ${candidate.rank_score.toFixed(2)}`, labelX, labelY);
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
    angle_degrees: line.angle_degrees,
    length_ft: round(line.length_px / pixelsPerFoot),
    candidate_coverage: round(line.candidate_coverage),
    source_ink_coverage: round(line.source_ink_coverage),
    rank_score: round(line.rank_score)
  }));
  const ambiguities = buildAmbiguities(raw, candidates, pixelsPerFoot, policy);
  const status = candidates.length === 0 ? "blocked" : ambiguities.length > 0 ? "clarification_required" : "candidates_ready";
  const overlay = await writeOverlay(sourcePath, width, height, candidates, resolvedOutDir);
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
    ambiguities,
    clarification_question: status === "clarification_required"
      ? "Multiple source-supported wall-line candidates overlap or have near-equal rank. Confirm the intended wall centerline/host candidate before compiling openings or any native action."
      : status === "blocked"
        ? "No source-supported wall-line candidate met the declared deterministic extraction policy."
        : null,
    overlay,
    usage_constraints: [
      "Candidates are deterministic image measurements, not selected truth and not native Revit actions.",
      "Parallel or near-equal candidates remain explicit ambiguities; rank alone must not authorize a wall or opening host.",
      "Candidate geometry is derived only from hash-bound source-aligned and source-only delta images in the registered frame.",
      "Opening recognition, wall type/thickness, vertical extents, and family/type promotion remain separate evidence-gated steps."
    ]
  };
}
