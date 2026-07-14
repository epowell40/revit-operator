import crypto from "node:crypto";
import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type {
  ExistingConditionsElement,
  ExistingConditionsGroundTruth
} from "../benchmark/existing_conditions_reconstruction.js";
import type { ArchitecturalSourceDeltaReceipt } from "./architectural_source_delta.js";

export type ArchitecturalRedactionVisibilityPolicy = {
  target_evidence_radius_ft: number;
  target_exclusion_radius_ft: number;
  minimum_wall_sample_coverage: number;
  minimum_opening_sample_coverage: number;
  minimum_common_background_pixels: number;
  minimum_common_background_ratio: number;
};

export const DEFAULT_ARCHITECTURAL_REDACTION_VISIBILITY_POLICY: ArchitecturalRedactionVisibilityPolicy = {
  target_evidence_radius_ft: 0.75,
  target_exclusion_radius_ft: 1.5,
  minimum_wall_sample_coverage: 0.3,
  minimum_opening_sample_coverage: 1,
  minimum_common_background_pixels: 100,
  minimum_common_background_ratio: 0.25
};

export type ArchitecturalRedactionTargetVisibility = {
  truth_key: string;
  role: "wall" | "door" | "window";
  sample_count: number;
  supported_sample_count: number;
  evidence_coverage: number;
  candidate_pixel_count: number;
  passed: boolean;
};

export type ArchitecturalRedactionVisibilityReceipt = {
  schema_version: 1;
  artifact_role: "architectural_redaction_visibility_gate";
  fixture_id: string;
  scope_id: string;
  passed: boolean;
  failure_classifications: string[];
  checked_artifact_sha256: {
    source_aligned: string;
    redacted_aligned: string;
    candidate_delta_mask: string;
  };
  policy: ArchitecturalRedactionVisibilityPolicy;
  targets: ArchitecturalRedactionTargetVisibility[];
  background: {
    source_ink_pixels_outside_targets: number;
    common_ink_pixels_outside_targets: number;
    common_background_ratio: number;
    passed: boolean;
  };
};

type Point2 = { x: number; y: number };
type PixelPoint = { x: number; y: number };

function round(value: number): number {
  return Number(value.toFixed(6));
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertArtifact(
  artifact: { path: string; sha256: string; width_px: number; height_px: number },
  label: string,
  width: number,
  height: number
): void {
  if (!fs.existsSync(artifact.path)) throw new Error(`${label}_file_not_found:${artifact.path}`);
  if (sha256File(artifact.path) !== artifact.sha256) throw new Error(`${label}_sha256_mismatch`);
  if (artifact.width_px !== width || artifact.height_px !== height) throw new Error(`${label}_receipt_dimensions_mismatch`);
}

function role(element: ExistingConditionsElement): "wall" | "door" | "window" | null {
  const value = String(element.role ?? "").trim().toLowerCase();
  return value === "wall" || value === "door" || value === "window" ? value : null;
}

function modelToPixel(
  point: Point2,
  bounds: ArchitecturalSourceDeltaReceipt["scope_model_bounds"],
  width: number,
  height: number
): PixelPoint {
  return {
    x: (point.x - bounds.min.x) * width / (bounds.max.x - bounds.min.x),
    y: (bounds.max.y - point.y) * height / (bounds.max.y - bounds.min.y)
  };
}

function samplesForElement(
  element: ExistingConditionsElement,
  elementRole: "wall" | "door" | "window",
  bounds: ArchitecturalSourceDeltaReceipt["scope_model_bounds"],
  width: number,
  height: number
): PixelPoint[] {
  if (elementRole === "wall") {
    if (!element.endpoints) throw new Error(`architectural_truth_wall_missing_endpoints:${element.key}`);
    const start = modelToPixel(element.endpoints[0], bounds, width, height);
    const end = modelToPixel(element.endpoints[1], bounds, width, height);
    const count = Math.max(9, Math.min(200, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 8) + 1));
    return Array.from({ length: count }, (_, index) => {
      const t = count === 1 ? 0 : index / (count - 1);
      return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
    });
  }
  if (!element.location) throw new Error(`architectural_truth_opening_missing_location:${element.key}`);
  return [modelToPixel(element.location, bounds, width, height)];
}

function anyMaskPixel(mask: Uint8Array, width: number, height: number, point: PixelPoint, radius: number): boolean {
  const minX = Math.max(0, Math.floor(point.x - radius));
  const maxX = Math.min(width - 1, Math.ceil(point.x + radius));
  const minY = Math.max(0, Math.floor(point.y - radius));
  const maxY = Math.min(height - 1, Math.ceil(point.y + radius));
  const radiusSquared = radius * radius;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if ((x - point.x) ** 2 + (y - point.y) ** 2 <= radiusSquared && mask[y * width + x]) return true;
    }
  }
  return false;
}

function countMaskPixels(mask: Uint8Array, width: number, height: number, samples: PixelPoint[], radius: number): number {
  const visited = new Uint8Array(mask.length);
  const radiusSquared = radius * radius;
  let count = 0;
  for (const point of samples) {
    const minX = Math.max(0, Math.floor(point.x - radius));
    const maxX = Math.min(width - 1, Math.ceil(point.x + radius));
    const minY = Math.max(0, Math.floor(point.y - radius));
    const maxY = Math.min(height - 1, Math.ceil(point.y + radius));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const index = y * width + x;
        if (!visited[index] && mask[index] && (x - point.x) ** 2 + (y - point.y) ** 2 <= radiusSquared) {
          visited[index] = 1;
          count += 1;
        }
      }
    }
  }
  return count;
}

function markExclusion(mask: Uint8Array, width: number, height: number, samples: PixelPoint[], radius: number): void {
  const radiusSquared = radius * radius;
  for (const point of samples) {
    const minX = Math.max(0, Math.floor(point.x - radius));
    const maxX = Math.min(width - 1, Math.ceil(point.x + radius));
    const minY = Math.max(0, Math.floor(point.y - radius));
    const maxY = Math.min(height - 1, Math.ceil(point.y + radius));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if ((x - point.x) ** 2 + (y - point.y) ** 2 <= radiusSquared) mask[y * width + x] = 1;
      }
    }
  }
}

async function imageMasks(
  receipt: ArchitecturalSourceDeltaReceipt
): Promise<{ source: Uint8Array; redacted: Uint8Array; candidate: Uint8Array }> {
  const width = receipt.output_frame.width_px;
  const height = receipt.output_frame.height_px;
  const read = async (filePath: string): Promise<Uint8ClampedArray> => {
    const image = await loadImage(filePath);
    if (image.width !== width || image.height !== height) throw new Error(`architectural_gate_image_dimensions_mismatch:${filePath}`);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  };
  const [sourcePixels, redactedPixels, candidatePixels] = await Promise.all([
    read(receipt.artifacts.source_aligned.path),
    read(receipt.artifacts.redacted_aligned.path),
    read(receipt.artifacts.candidate_delta_mask.path)
  ]);
  const ink = (pixels: Uint8ClampedArray): Uint8Array => {
    const output = new Uint8Array(width * height);
    for (let index = 0; index < output.length; index += 1) {
      const offset = index * 4;
      const luminance = 0.2126 * pixels[offset]! + 0.7152 * pixels[offset + 1]! + 0.0722 * pixels[offset + 2]!;
      output[index] = pixels[offset + 3]! > 25 && luminance < receipt.render_policy.ink_luminance_threshold ? 1 : 0;
    }
    return output;
  };
  const candidate = new Uint8Array(width * height);
  for (let index = 0; index < candidate.length; index += 1) candidate[index] = candidatePixels[index * 4 + 3]! > 0 ? 1 : 0;
  return { source: ink(sourcePixels), redacted: ink(redactedPixels), candidate };
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      const minY = Math.max(0, y - radius);
      const maxY = Math.min(height - 1, y + radius);
      const minX = Math.max(0, x - radius);
      const maxX = Math.min(width - 1, x + radius);
      for (let targetY = minY; targetY <= maxY; targetY += 1) {
        output.fill(1, targetY * width + minX, targetY * width + maxX + 1);
      }
    }
  }
  return output;
}

export async function auditArchitecturalRedactionVisibility(
  truth: ExistingConditionsGroundTruth,
  delta: ArchitecturalSourceDeltaReceipt,
  policy: ArchitecturalRedactionVisibilityPolicy = DEFAULT_ARCHITECTURAL_REDACTION_VISIBILITY_POLICY
): Promise<ArchitecturalRedactionVisibilityReceipt> {
  if (truth.fixture_id !== delta.fixture_id) throw new Error("architectural_gate_fixture_id_mismatch");
  if (truth.scope_id !== delta.scope_id) throw new Error("architectural_gate_scope_id_mismatch");
  if (!delta.registration_verified) throw new Error("architectural_gate_requires_verified_registration");
  const width = delta.output_frame.width_px;
  const height = delta.output_frame.height_px;
  assertArtifact(delta.artifacts.source_aligned, "source_aligned", width, height);
  assertArtifact(delta.artifacts.redacted_aligned, "redacted_aligned", width, height);
  assertArtifact(delta.artifacts.candidate_delta_mask, "candidate_delta_mask", width, height);
  const masks = await imageMasks(delta);
  const pixelsPerFoot = Math.max(
    width / (delta.scope_model_bounds.max.x - delta.scope_model_bounds.min.x),
    height / (delta.scope_model_bounds.max.y - delta.scope_model_bounds.min.y)
  );
  const evidenceRadius = Math.max(1, policy.target_evidence_radius_ft * pixelsPerFoot);
  const exclusionRadius = Math.max(evidenceRadius, policy.target_exclusion_radius_ft * pixelsPerFoot);
  const exclusion = new Uint8Array(width * height);
  const targets: ArchitecturalRedactionTargetVisibility[] = [];
  for (const element of truth.snapshot.elements) {
    const elementRole = role(element);
    if (!elementRole) continue;
    const samples = samplesForElement(element, elementRole, delta.scope_model_bounds, width, height);
    markExclusion(exclusion, width, height, samples, exclusionRadius);
    const supported = samples.filter((sample) => anyMaskPixel(masks.candidate, width, height, sample, evidenceRadius)).length;
    const coverage = samples.length > 0 ? supported / samples.length : 0;
    const minimum = elementRole === "wall"
      ? policy.minimum_wall_sample_coverage
      : policy.minimum_opening_sample_coverage;
    const candidatePixels = countMaskPixels(masks.candidate, width, height, samples, evidenceRadius);
    targets.push({
      truth_key: element.key,
      role: elementRole,
      sample_count: samples.length,
      supported_sample_count: supported,
      evidence_coverage: round(coverage),
      candidate_pixel_count: candidatePixels,
      passed: coverage >= minimum && candidatePixels > 0
    });
  }
  const expandedRedacted = dilate(masks.redacted, width, height, delta.render_policy.redacted_ink_dilation_px);
  let sourceBackground = 0;
  let commonBackground = 0;
  for (let index = 0; index < masks.source.length; index += 1) {
    if (exclusion[index] || !masks.source[index]) continue;
    sourceBackground += 1;
    if (expandedRedacted[index]) commonBackground += 1;
  }
  const commonRatio = sourceBackground > 0 ? commonBackground / sourceBackground : 0;
  const backgroundPassed = commonBackground >= policy.minimum_common_background_pixels &&
    commonRatio >= policy.minimum_common_background_ratio;
  const failures: string[] = [];
  if (targets.length === 0) failures.push("no_supported_architectural_truth_targets");
  if (targets.some((target) => !target.passed)) failures.push("withheld_target_not_visibly_redacted");
  if (!backgroundPassed) failures.push("architectural_background_not_retained");
  return {
    schema_version: 1,
    artifact_role: "architectural_redaction_visibility_gate",
    fixture_id: truth.fixture_id,
    scope_id: truth.scope_id,
    passed: failures.length === 0,
    failure_classifications: failures,
    checked_artifact_sha256: {
      source_aligned: delta.artifacts.source_aligned.sha256,
      redacted_aligned: delta.artifacts.redacted_aligned.sha256,
      candidate_delta_mask: delta.artifacts.candidate_delta_mask.sha256
    },
    policy: { ...policy },
    targets,
    background: {
      source_ink_pixels_outside_targets: sourceBackground,
      common_ink_pixels_outside_targets: commonBackground,
      common_background_ratio: round(commonRatio),
      passed: backgroundPassed
    }
  };
}
