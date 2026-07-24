import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";

export type ComparisonPixelPoint = {
  x: number;
  y: number;
};

export type ComparisonModelPoint = ComparisonPixelPoint & {
  z: number;
};

type ImageReference = {
  path: string;
  sha256: string;
  width_px: number;
  height_px: number;
};

export type CalibratedComparisonControl = {
  control_id: string;
  kind: string;
  label?: string;
  source_pixel: ComparisonPixelPoint;
  candidate_pixel: ComparisonPixelPoint;
  confidence: number;
  accepted: true;
  target_excluded: true;
  source_reference: string;
  candidate_reference: string;
};

export type CalibratedComparisonFeature = {
  feature_id: string;
  role: string;
  source_points: ComparisonPixelPoint[];
  candidate_points: ComparisonPixelPoint[];
  candidate_element_ids?: number[];
};

export type CalibratedCropComparisonInput = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  source_image: ImageReference;
  candidate_image: ImageReference & {
    frame_id: string;
    view_id: number;
    model_frame: {
      top_left: ComparisonModelPoint;
      top_right: ComparisonModelPoint;
      bottom_left: ComparisonModelPoint;
    };
  };
  controls: CalibratedComparisonControl[];
  features?: CalibratedComparisonFeature[];
  allow_reflection?: boolean;
  thresholds?: {
    maximum_rms_residual_px?: number;
    maximum_point_residual_px?: number;
    maximum_normalized_point_residual?: number;
    maximum_rigid_delta_spread_ft?: number;
    minimum_control_spread_fraction?: number;
  };
  overlay_alpha?: number;
};

export type CalibratedFeatureRepairProposal = {
  feature_id: string;
  role: string;
  candidate_element_ids: number[];
  target_model_points: ComparisonModelPoint[];
  current_model_points: ComparisonModelPoint[];
  point_deltas_ft: ComparisonModelPoint[];
  mean_delta_ft: ComparisonModelPoint;
  maximum_delta_spread_ft: number;
  disposition: "dry_run_ready" | "reshape_required" | "evidence_only";
  exact_next_repair: string;
  dry_run_action?: {
    path: "/revit/move-elements";
    body: {
      elementIds: number[];
      mode: "vector";
      vectorX: number;
      vectorY: number;
      vectorZ: number;
      allOrNothing: true;
      dryRun: true;
    };
  };
};

export type CalibratedCropComparisonReceipt = {
  schema_version: 1;
  artifact_role: "existing_conditions_calibrated_crop_comparison";
  fixture_id: string;
  scope_id: string;
  input_fingerprint_sha256: string;
  source_image_sha256: string;
  candidate_image_sha256: string;
  candidate_frame_id: string;
  candidate_view_id: number;
  accepted: boolean;
  blockers: string[];
  transform: {
    source_pixels_to_candidate_pixels: {
      scale: number;
      rotation_degrees: number;
      reflection_applied: boolean;
      translation_px: ComparisonPixelPoint;
      canvas_affine: { a: number; b: number; c: number; d: number; e: number; f: number };
    };
    candidate_pixels_to_model: {
      origin: "top_left";
      x_formula: string;
      y_formula: string;
      z_formula: string;
    };
  };
  residuals: {
    control_count: number;
    source_control_spread_fraction: number;
    candidate_control_spread_fraction: number;
    minimum_control_spread_fraction: number;
    rms_px: number;
    maximum_px: number;
    maximum_normalized: number;
    maximum_rms_residual_px: number;
    maximum_point_residual_px: number;
    maximum_normalized_point_residual: number;
    controls: Array<{
      control_id: string;
      predicted_candidate_pixel: ComparisonPixelPoint;
      observed_candidate_pixel: ComparisonPixelPoint;
      residual_px: number;
      normalized_residual: number;
    }>;
  };
  accepted_controls: CalibratedComparisonControl[];
  feature_repairs: CalibratedFeatureRepairProposal[];
  proposed_dry_run_actions: NonNullable<CalibratedFeatureRepairProposal["dry_run_action"]>[];
  artifacts: {
    source_aligned: ImageReference;
    calibrated_overlay: ImageReference;
    comparison: ImageReference;
  };
  usage_constraints: string[];
};

type Similarity = {
  a: number;
  b: number;
  reflected: boolean;
  translation: ComparisonPixelPoint;
  squared_error: number;
  maximum_error: number;
};

function text(value: unknown, label: string): string {
  const parsed = String(value ?? "").trim();
  if (!parsed) throw new Error(`${label}_is_required`);
  return parsed;
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

function point(value: ComparisonPixelPoint, label: string): ComparisonPixelPoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  return { x: finite(value.x, `${label}_x`), y: finite(value.y, `${label}_y`) };
}

function modelPoint(value: ComparisonModelPoint, label: string): ComparisonModelPoint {
  return { ...point(value, label), z: finite(value?.z, `${label}_z`) };
}

function boundedPixelPoint(
  value: ComparisonPixelPoint,
  width: number,
  height: number,
  label: string
): ComparisonPixelPoint {
  const parsed = point(value, label);
  if (parsed.x < 0 || parsed.x > width - 1 || parsed.y < 0 || parsed.y > height - 1) {
    throw new Error(`${label}_outside_raster_bounds`);
  }
  return parsed;
}

function controlSpreadFraction(points: ComparisonPixelPoint[], width: number, height: number): number {
  let maximumDistance = 0;
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      maximumDistance = Math.max(
        maximumDistance,
        Math.hypot(points[first]!.x - points[second]!.x, points[first]!.y - points[second]!.y)
      );
    }
  }
  return maximumDistance / Math.hypot(Math.max(1, width - 1), Math.max(1, height - 1));
}

function sha256Text(value: unknown, label: string): string {
  const parsed = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new Error(`${label}_must_be_sha256`);
  return parsed;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function checkedImage(reference: ImageReference, label: string): ImageReference {
  const filePath = path.resolve(text(reference?.path, `${label}_path`));
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`${label}_file_not_found:${filePath}`);
  const expectedHash = sha256Text(reference.sha256, `${label}_sha256`);
  const actualHash = sha256File(filePath);
  if (actualHash !== expectedHash) throw new Error(`${label}_sha256_mismatch`);
  return {
    path: filePath,
    sha256: actualHash,
    width_px: positiveInteger(reference.width_px, `${label}_width_px`),
    height_px: positiveInteger(reference.height_px, `${label}_height_px`)
  };
}

function transform(similarity: Similarity, source: ComparisonPixelPoint): ComparisonPixelPoint {
  return similarity.reflected
    ? {
        x: similarity.a * source.x + similarity.b * source.y + similarity.translation.x,
        y: similarity.b * source.x - similarity.a * source.y + similarity.translation.y
      }
    : {
        x: similarity.a * source.x - similarity.b * source.y + similarity.translation.x,
        y: similarity.b * source.x + similarity.a * source.y + similarity.translation.y
      };
}

function nonCollinear(points: ComparisonPixelPoint[]): boolean {
  const origin = points[0]!;
  return points.slice(1).some((first, firstIndex) => points.slice(firstIndex + 2).some((second) => {
    const ax = first.x - origin.x;
    const ay = first.y - origin.y;
    const bx = second.x - origin.x;
    const by = second.y - origin.y;
    return Math.abs(ax * by - ay * bx) > 1e-9;
  }));
}

function solveSimilarity(
  controls: Array<{ source: ComparisonPixelPoint; candidate: ComparisonPixelPoint }>,
  allowReflection: boolean
): Similarity {
  if (!nonCollinear(controls.map((entry) => entry.source))) {
    throw new Error("calibrated_comparison_source_controls_must_be_non_collinear");
  }
  if (!nonCollinear(controls.map((entry) => entry.candidate))) {
    throw new Error("calibrated_comparison_candidate_controls_must_be_non_collinear");
  }
  const sourceCentroid = controls.reduce(
    (sum, entry) => ({ x: sum.x + entry.source.x, y: sum.y + entry.source.y }),
    { x: 0, y: 0 }
  );
  const candidateCentroid = controls.reduce(
    (sum, entry) => ({ x: sum.x + entry.candidate.x, y: sum.y + entry.candidate.y }),
    { x: 0, y: 0 }
  );
  sourceCentroid.x /= controls.length;
  sourceCentroid.y /= controls.length;
  candidateCentroid.x /= controls.length;
  candidateCentroid.y /= controls.length;
  let denominator = 0;
  let properA = 0;
  let properB = 0;
  let reflectedA = 0;
  let reflectedB = 0;
  for (const entry of controls) {
    const sx = entry.source.x - sourceCentroid.x;
    const sy = entry.source.y - sourceCentroid.y;
    const cx = entry.candidate.x - candidateCentroid.x;
    const cy = entry.candidate.y - candidateCentroid.y;
    denominator += sx * sx + sy * sy;
    properA += sx * cx + sy * cy;
    properB += sx * cy - sy * cx;
    reflectedA += sx * cx - sy * cy;
    reflectedB += sy * cx + sx * cy;
  }
  if (denominator <= 1e-12) throw new Error("calibrated_comparison_source_controls_are_degenerate");
  const build = (a: number, b: number, reflected: boolean): Similarity => {
    const translation = reflected
      ? {
          x: candidateCentroid.x - (a * sourceCentroid.x + b * sourceCentroid.y),
          y: candidateCentroid.y - (b * sourceCentroid.x - a * sourceCentroid.y)
        }
      : {
          x: candidateCentroid.x - (a * sourceCentroid.x - b * sourceCentroid.y),
          y: candidateCentroid.y - (b * sourceCentroid.x + a * sourceCentroid.y)
        };
    const candidate: Similarity = { a, b, reflected, translation, squared_error: 0, maximum_error: 0 };
    for (const control of controls) {
      const predicted = transform(candidate, control.source);
      const residual = Math.hypot(predicted.x - control.candidate.x, predicted.y - control.candidate.y);
      candidate.squared_error += residual * residual;
      candidate.maximum_error = Math.max(candidate.maximum_error, residual);
    }
    return candidate;
  };
  const candidates = [build(properA / denominator, properB / denominator, false)];
  if (allowReflection) candidates.push(build(reflectedA / denominator, reflectedB / denominator, true));
  return candidates.reduce((best, candidate) =>
    candidate.squared_error < best.squared_error ? candidate : best
  );
}

function pixelToModel(
  pixelValue: ComparisonPixelPoint,
  width: number,
  height: number,
  frame: CalibratedCropComparisonInput["candidate_image"]["model_frame"]
): ComparisonModelPoint {
  const pixel = point(pixelValue, "candidate_pixel");
  const topLeft = modelPoint(frame.top_left, "candidate_model_frame_top_left");
  const topRight = modelPoint(frame.top_right, "candidate_model_frame_top_right");
  const bottomLeft = modelPoint(frame.bottom_left, "candidate_model_frame_bottom_left");
  const u = pixel.x / Math.max(1, width - 1);
  const v = pixel.y / Math.max(1, height - 1);
  return {
    x: topLeft.x + u * (topRight.x - topLeft.x) + v * (bottomLeft.x - topLeft.x),
    y: topLeft.y + u * (topRight.y - topLeft.y) + v * (bottomLeft.y - topLeft.y),
    z: topLeft.z + u * (topRight.z - topLeft.z) + v * (bottomLeft.z - topLeft.z)
  };
}

function writeCanvas(filePath: string, canvas: Canvas): ImageReference {
  fs.writeFileSync(filePath, canvas.toBuffer("image/png"));
  return {
    path: filePath,
    sha256: sha256File(filePath),
    width_px: canvas.width,
    height_px: canvas.height
  };
}

function sourceCanvas(
  image: Awaited<ReturnType<typeof loadImage>>,
  width: number,
  height: number,
  similarity: Similarity
): Canvas {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  const affine = similarity.reflected
    ? [similarity.a, similarity.b, similarity.b, -similarity.a, similarity.translation.x, similarity.translation.y] as const
    : [similarity.a, similarity.b, -similarity.b, similarity.a, similarity.translation.x, similarity.translation.y] as const;
  context.setTransform(...affine);
  context.drawImage(image, 0, 0);
  context.resetTransform();
  return canvas;
}

function drawEvidence(
  sourceAligned: Canvas,
  candidateImage: Awaited<ReturnType<typeof loadImage>>,
  controls: CalibratedComparisonControl[],
  similarity: Similarity,
  features: CalibratedComparisonFeature[],
  alpha: number
): { overlay: Canvas; comparison: Canvas } {
  const width = sourceAligned.width;
  const height = sourceAligned.height;
  const overlay = createCanvas(width, height);
  const context = overlay.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(candidateImage, 0, 0);
  context.globalAlpha = alpha;
  context.drawImage(sourceAligned, 0, 0);
  context.globalAlpha = 1;
  context.font = "bold 12px sans-serif";
  for (const control of controls) {
    const predicted = transform(similarity, control.source_pixel);
    context.strokeStyle = "#00a63d";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(control.candidate_pixel.x, control.candidate_pixel.y, 5, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = "#8b00ff";
    context.beginPath();
    context.moveTo(predicted.x - 4, predicted.y);
    context.lineTo(predicted.x + 4, predicted.y);
    context.moveTo(predicted.x, predicted.y - 4);
    context.lineTo(predicted.x, predicted.y + 4);
    context.stroke();
    context.fillStyle = "#111111";
    context.fillText(control.control_id, control.candidate_pixel.x + 7, control.candidate_pixel.y - 7);
  }
  for (const feature of features) {
    const count = Math.min(feature.source_points.length, feature.candidate_points.length);
    for (let index = 0; index < count; index += 1) {
      const target = transform(similarity, feature.source_points[index]!);
      const current = feature.candidate_points[index]!;
      context.strokeStyle = "#ff2d00";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(current.x, current.y);
      context.lineTo(target.x, target.y);
      context.stroke();
    }
  }
  const header = 40;
  const comparison = createCanvas(width * 3, height + header);
  const comparisonContext = comparison.getContext("2d");
  comparisonContext.fillStyle = "#ffffff";
  comparisonContext.fillRect(0, 0, comparison.width, comparison.height);
  comparisonContext.fillStyle = "#111111";
  comparisonContext.font = "bold 16px sans-serif";
  comparisonContext.fillText("SOURCE - CALIBRATED", 12, 26);
  comparisonContext.fillText("CANDIDATE", width + 12, 26);
  comparisonContext.fillText("OVERLAY + MODEL DELTAS", width * 2 + 12, 26);
  comparisonContext.drawImage(sourceAligned, 0, header);
  comparisonContext.drawImage(candidateImage, width, header);
  comparisonContext.drawImage(overlay, width * 2, header);
  return { overlay, comparison };
}

function featureProposal(
  feature: CalibratedComparisonFeature,
  similarity: Similarity,
  candidate: CalibratedCropComparisonInput["candidate_image"],
  rigidTolerance: number,
  accepted: boolean,
  targetWithinCandidateFrame: boolean
): CalibratedFeatureRepairProposal {
  const featureId = text(feature.feature_id, "feature_id");
  const role = text(feature.role, `${featureId}_role`);
  if (!Array.isArray(feature.source_points) || feature.source_points.length === 0) {
    throw new Error(`calibrated_comparison_feature_source_points_required:${featureId}`);
  }
  if (!Array.isArray(feature.candidate_points) || feature.candidate_points.length !== feature.source_points.length) {
    throw new Error(`calibrated_comparison_feature_point_count_mismatch:${featureId}`);
  }
  const elementIds = [...new Set((feature.candidate_element_ids ?? []).map((value) =>
    positiveInteger(value, `${featureId}_candidate_element_id`)
  ))];
  const targetModel = feature.source_points.map((value, index) =>
    pixelToModel(
      transform(similarity, point(value, `${featureId}_source_point_${index}`)),
      candidate.width_px,
      candidate.height_px,
      candidate.model_frame
    )
  );
  const currentModel = feature.candidate_points.map((value, index) =>
    pixelToModel(
      point(value, `${featureId}_candidate_point_${index}`),
      candidate.width_px,
      candidate.height_px,
      candidate.model_frame
    )
  );
  const deltas = targetModel.map((target, index) => ({
    x: target.x - currentModel[index]!.x,
    y: target.y - currentModel[index]!.y,
    z: target.z - currentModel[index]!.z
  }));
  const mean = deltas.reduce(
    (sum, delta) => ({ x: sum.x + delta.x, y: sum.y + delta.y, z: sum.z + delta.z }),
    { x: 0, y: 0, z: 0 }
  );
  mean.x /= deltas.length;
  mean.y /= deltas.length;
  mean.z /= deltas.length;
  const spread = Math.max(...deltas.map((delta) =>
    Math.hypot(delta.x - mean.x, delta.y - mean.y, delta.z - mean.z)
  ));
  const rigid = spread <= rigidTolerance;
  const disposition = !accepted || !targetWithinCandidateFrame || elementIds.length === 0
    ? "evidence_only"
    : rigid
      ? "dry_run_ready"
      : "reshape_required";
  const proposal: CalibratedFeatureRepairProposal = {
    feature_id: featureId,
    role,
    candidate_element_ids: elementIds,
    target_model_points: targetModel,
    current_model_points: currentModel,
    point_deltas_ft: deltas,
    mean_delta_ft: mean,
    maximum_delta_spread_ft: spread,
    disposition,
    exact_next_repair: !accepted
      ? "Repair or replace the rejected controls; no model action is permitted."
      : !targetWithinCandidateFrame
        ? "Expand and re-freeze the candidate raster frame so every transformed target point is contained before any model action."
      : elementIds.length === 0
        ? "Bind the candidate feature to exact retained element IDs before any model action."
        : rigid
          ? "Dry-run the emitted exact vector move, then read back geometry and connector topology before apply."
          : "Use the listed point deltas to disconnect, reshape or extend, reconnect, and audit the retained elements; do not duplicate them."
  };
  if (disposition === "dry_run_ready") {
    proposal.dry_run_action = {
      path: "/revit/move-elements",
      body: {
        elementIds,
        mode: "vector",
        vectorX: mean.x,
        vectorY: mean.y,
        vectorZ: mean.z,
        allOrNothing: true,
        dryRun: true
      }
    };
  }
  return proposal;
}

export async function compareCalibratedExistingConditionsCrops(
  input: CalibratedCropComparisonInput,
  outputDirectory: string
): Promise<CalibratedCropComparisonReceipt> {
  if (input.schema_version !== 1) throw new Error("unsupported_calibrated_crop_comparison_schema_version");
  const fixtureId = text(input.fixture_id, "fixture_id");
  const scopeId = text(input.scope_id, "scope_id");
  const source = checkedImage(input.source_image, "source_image");
  const candidateReference = checkedImage(input.candidate_image, "candidate_image");
  const candidate = {
    ...input.candidate_image,
    ...candidateReference,
    frame_id: text(input.candidate_image.frame_id, "candidate_frame_id"),
    view_id: positiveInteger(input.candidate_image.view_id, "candidate_view_id"),
    model_frame: {
      top_left: modelPoint(input.candidate_image.model_frame?.top_left, "candidate_model_frame_top_left"),
      top_right: modelPoint(input.candidate_image.model_frame?.top_right, "candidate_model_frame_top_right"),
      bottom_left: modelPoint(input.candidate_image.model_frame?.bottom_left, "candidate_model_frame_bottom_left")
    }
  };
  const frameXAxis = {
    x: candidate.model_frame.top_right.x - candidate.model_frame.top_left.x,
    y: candidate.model_frame.top_right.y - candidate.model_frame.top_left.y,
    z: candidate.model_frame.top_right.z - candidate.model_frame.top_left.z
  };
  const frameYAxis = {
    x: candidate.model_frame.bottom_left.x - candidate.model_frame.top_left.x,
    y: candidate.model_frame.bottom_left.y - candidate.model_frame.top_left.y,
    z: candidate.model_frame.bottom_left.z - candidate.model_frame.top_left.z
  };
  const frameXAxisLength = Math.hypot(frameXAxis.x, frameXAxis.y, frameXAxis.z);
  const frameYAxisLength = Math.hypot(frameYAxis.x, frameYAxis.y, frameYAxis.z);
  const frameCrossLength = Math.hypot(
    frameXAxis.y * frameYAxis.z - frameXAxis.z * frameYAxis.y,
    frameXAxis.z * frameYAxis.x - frameXAxis.x * frameYAxis.z,
    frameXAxis.x * frameYAxis.y - frameXAxis.y * frameYAxis.x
  );
  if (frameXAxisLength <= 1e-9 || frameYAxisLength <= 1e-9 || frameCrossLength <= 1e-9) {
    throw new Error("candidate_model_frame_is_degenerate");
  }
  const sourceImage = await loadImage(source.path);
  const candidateImage = await loadImage(candidate.path);
  if (sourceImage.width !== source.width_px || sourceImage.height !== source.height_px) {
    throw new Error("source_image_dimensions_mismatch");
  }
  if (candidateImage.width !== candidate.width_px || candidateImage.height !== candidate.height_px) {
    throw new Error("candidate_image_dimensions_mismatch");
  }
  if (!Array.isArray(input.controls) || input.controls.length < 3) {
    throw new Error("calibrated_comparison_requires_at_least_three_controls");
  }
  const controls = input.controls.map((entry, index) => {
    const controlId = text(entry.control_id, `control_${index}_id`);
    if (entry.accepted !== true || entry.target_excluded !== true) {
      throw new Error(`calibrated_comparison_control_must_be_accepted_and_target_excluded:${controlId}`);
    }
    const confidence = finite(entry.confidence, `${controlId}_confidence`);
    if (confidence < 0.55 || confidence > 1) {
      throw new Error(`calibrated_comparison_control_confidence_out_of_range:${controlId}`);
    }
    return {
      ...entry,
      control_id: controlId,
      kind: text(entry.kind, `${controlId}_kind`),
      source_pixel: boundedPixelPoint(
        entry.source_pixel,
        source.width_px,
        source.height_px,
        `${controlId}_source_pixel`
      ),
      candidate_pixel: boundedPixelPoint(
        entry.candidate_pixel,
        candidate.width_px,
        candidate.height_px,
        `${controlId}_candidate_pixel`
      ),
      confidence,
      source_reference: text(entry.source_reference, `${controlId}_source_reference`),
      candidate_reference: text(entry.candidate_reference, `${controlId}_candidate_reference`)
    };
  });
  if (new Set(controls.map((entry) => entry.control_id)).size !== controls.length) {
    throw new Error("calibrated_comparison_control_ids_must_be_unique");
  }
  if (controls.every((entry) => entry.kind.toLowerCase() === "persistent_interior")) {
    throw new Error("calibrated_comparison_requires_a_stable_non_interior_control");
  }
  const similarity = solveSimilarity(
    controls.map((entry) => ({ source: entry.source_pixel, candidate: entry.candidate_pixel })),
    input.allow_reflection === true
  );
  const maximumRms = positive(input.thresholds?.maximum_rms_residual_px ?? 2, "maximum_rms_residual_px");
  const maximumPoint = positive(input.thresholds?.maximum_point_residual_px ?? 3, "maximum_point_residual_px");
  const maximumNormalized = positive(
    input.thresholds?.maximum_normalized_point_residual ?? 0.005,
    "maximum_normalized_point_residual"
  );
  if (maximumRms > 3 || maximumPoint > 5 || maximumNormalized > 0.008) {
    throw new Error("calibrated_comparison_threshold_is_too_permissive");
  }
  const minimumControlSpread = positive(
    input.thresholds?.minimum_control_spread_fraction ?? 0.1,
    "minimum_control_spread_fraction"
  );
  if (minimumControlSpread < 0.05 || minimumControlSpread > 1) {
    throw new Error("minimum_control_spread_fraction_is_too_permissive_or_invalid");
  }
  const rigidTolerance = positive(
    input.thresholds?.maximum_rigid_delta_spread_ft ?? 0.02,
    "maximum_rigid_delta_spread_ft"
  );
  if (rigidTolerance > 0.05) throw new Error("maximum_rigid_delta_spread_ft_is_too_permissive");
  const candidateDiagonal = Math.hypot(candidate.width_px, candidate.height_px);
  const controlResiduals = controls.map((control) => {
    const predicted = transform(similarity, control.source_pixel);
    const residual = Math.hypot(
      predicted.x - control.candidate_pixel.x,
      predicted.y - control.candidate_pixel.y
    );
    return {
      control_id: control.control_id,
      predicted_candidate_pixel: predicted,
      observed_candidate_pixel: control.candidate_pixel,
      residual_px: residual,
      normalized_residual: residual / candidateDiagonal
    };
  });
  const rms = Math.sqrt(similarity.squared_error / controls.length);
  const maximumNormalizedResidual = Math.max(...controlResiduals.map((entry) => entry.normalized_residual));
  const sourceControlSpread = controlSpreadFraction(
    controls.map((entry) => entry.source_pixel),
    source.width_px,
    source.height_px
  );
  const candidateControlSpread = controlSpreadFraction(
    controls.map((entry) => entry.candidate_pixel),
    candidate.width_px,
    candidate.height_px
  );
  const blockers = [
    ...(sourceControlSpread < minimumControlSpread
      ? [`source_control_spread_below_threshold:${sourceControlSpread}`]
      : []),
    ...(candidateControlSpread < minimumControlSpread
      ? [`candidate_control_spread_below_threshold:${candidateControlSpread}`]
      : []),
    ...(rms > maximumRms ? [`control_rms_residual_exceeds_threshold:${rms}`] : []),
    ...(similarity.maximum_error > maximumPoint
      ? [`control_maximum_residual_exceeds_threshold:${similarity.maximum_error}`]
      : []),
    ...(maximumNormalizedResidual > maximumNormalized
      ? [`control_normalized_residual_exceeds_threshold:${maximumNormalizedResidual}`]
      : [])
  ];
  const accepted = blockers.length === 0;
  const features = (input.features ?? []).map((feature) => ({
    ...feature,
    source_points: feature.source_points.map((value, index) =>
      boundedPixelPoint(
        value,
        source.width_px,
        source.height_px,
        `${feature.feature_id}_source_point_${index}`
      )
    ),
    candidate_points: feature.candidate_points.map((value, index) =>
      boundedPixelPoint(
        value,
        candidate.width_px,
        candidate.height_px,
        `${feature.feature_id}_candidate_point_${index}`
      )
    )
  }));
  const allElementIds = features.flatMap((entry) => entry.candidate_element_ids ?? []);
  if (new Set(allElementIds).size !== allElementIds.length) {
    throw new Error("calibrated_comparison_candidate_element_ids_must_not_span_multiple_features");
  }
  const repairs = features.map((feature) => {
    const targetWithinCandidateFrame = feature.source_points.every((sourcePoint) => {
      const target = transform(similarity, sourcePoint);
      return target.x >= 0 && target.x <= candidate.width_px - 1
        && target.y >= 0 && target.y <= candidate.height_px - 1;
    });
    return featureProposal(
      feature,
      similarity,
      candidate,
      rigidTolerance,
      accepted,
      targetWithinCandidateFrame
    );
  });
  const outDir = path.resolve(outputDirectory);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`refusing_to_overwrite_calibrated_crop_comparison:${outDir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const aligned = sourceCanvas(sourceImage, candidate.width_px, candidate.height_px, similarity);
  const alpha = finite(input.overlay_alpha ?? 0.48, "overlay_alpha");
  if (alpha < 0.1 || alpha > 0.9) throw new Error("overlay_alpha_must_be_between_0_1_and_0_9");
  const evidence = drawEvidence(aligned, candidateImage, controls, similarity, features, alpha);
  const sourceAligned = writeCanvas(path.join(outDir, "source_aligned_to_candidate.png"), aligned);
  const overlay = writeCanvas(path.join(outDir, "calibrated_overlay.png"), evidence.overlay);
  const comparison = writeCanvas(path.join(outDir, "calibrated_comparison.png"), evidence.comparison);
  const radians = Math.atan2(similarity.b, similarity.a);
  const canvasAffine = similarity.reflected
    ? {
        a: similarity.a,
        b: similarity.b,
        c: similarity.b,
        d: -similarity.a,
        e: similarity.translation.x,
        f: similarity.translation.y
      }
    : {
        a: similarity.a,
        b: similarity.b,
        c: -similarity.b,
        d: similarity.a,
        e: similarity.translation.x,
        f: similarity.translation.y
      };
  return {
    schema_version: 1,
    artifact_role: "existing_conditions_calibrated_crop_comparison",
    fixture_id: fixtureId,
    scope_id: scopeId,
    input_fingerprint_sha256: fingerprint(input),
    source_image_sha256: source.sha256,
    candidate_image_sha256: candidate.sha256,
    candidate_frame_id: candidate.frame_id,
    candidate_view_id: candidate.view_id,
    accepted,
    blockers,
    transform: {
      source_pixels_to_candidate_pixels: {
        scale: Math.hypot(similarity.a, similarity.b),
        rotation_degrees: radians * 180 / Math.PI,
        reflection_applied: similarity.reflected,
        translation_px: similarity.translation,
        canvas_affine: canvasAffine
      },
      candidate_pixels_to_model: {
        origin: "top_left",
        x_formula: "top_left.x + pixel_x / (width - 1) * (top_right.x - top_left.x) + pixel_y / (height - 1) * (bottom_left.x - top_left.x)",
        y_formula: "top_left.y + pixel_x / (width - 1) * (top_right.y - top_left.y) + pixel_y / (height - 1) * (bottom_left.y - top_left.y)",
        z_formula: "top_left.z + pixel_x / (width - 1) * (top_right.z - top_left.z) + pixel_y / (height - 1) * (bottom_left.z - top_left.z)"
      }
    },
    residuals: {
      control_count: controls.length,
      source_control_spread_fraction: sourceControlSpread,
      candidate_control_spread_fraction: candidateControlSpread,
      minimum_control_spread_fraction: minimumControlSpread,
      rms_px: rms,
      maximum_px: similarity.maximum_error,
      maximum_normalized: maximumNormalizedResidual,
      maximum_rms_residual_px: maximumRms,
      maximum_point_residual_px: maximumPoint,
      maximum_normalized_point_residual: maximumNormalized,
      controls: controlResiduals
    },
    accepted_controls: controls,
    feature_repairs: repairs,
    proposed_dry_run_actions: accepted
      ? repairs.flatMap((repair) => repair.dry_run_action ? [repair.dry_run_action] : [])
      : [],
    artifacts: {
      source_aligned: sourceAligned,
      calibrated_overlay: overlay,
      comparison
    },
    usage_constraints: [
      "The source and candidate images, candidate frame, accepted target-excluded controls, and thresholds are hash-bound by the input fingerprint.",
      "Rejected calibration produces no proposed dry-run actions.",
      "Only features whose point deltas agree within the strict rigid-delta tolerance receive a move-elements dry-run proposal.",
      "Non-rigid deltas require connector-aware reshape or extension and reconnect auditing; replacement geometry is not implied.",
      "Every emitted action is dry-run only. Apply, save, readback, connectivity audit, and focused visual verification remain separate stages."
    ]
  };
}
