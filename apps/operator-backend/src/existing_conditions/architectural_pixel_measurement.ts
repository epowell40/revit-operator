import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  compileArchitecturalPlanGeometryPreview,
  type ArchitecturalPlanGeometryPreviewPackage,
  type CompiledArchitecturalPlanGeometryPreview
} from "./architectural_plan_geometry_preview.js";
import type { ArchitecturalSourceDeltaReceipt } from "./architectural_source_delta.js";
import {
  solveExistingConditionsRegistration,
  type ExistingConditionsPlanPoint,
  type ExistingConditionsRegistrationInput,
  type ExistingConditionsRegistrationReceipt
} from "./registration.js";

type Bounds2d = {
  min: ExistingConditionsPlanPoint;
  max: ExistingConditionsPlanPoint;
};

type ImageReference = {
  path: string;
  sha256: string;
  width_px: number;
  height_px: number;
};

export type ArchitecturalMeasurementOverlayReceipt = {
  schema_version: 1;
  artifact_role: "architectural_registered_measurement_overlay";
  fixture_id: string;
  scope_id: string;
  architectural_delta_receipt_sha256: string;
  registration_source_evidence_sha256: string;
  source_aligned_sha256: string;
  candidate_delta_mask_sha256: string;
  scope_model_bounds: Bounds2d;
  output_frame: {
    width_px: number;
    height_px: number;
    pixel_origin: "top_left";
    pixel_to_model_formula: { x: string; y: string };
  };
  grid_policy: {
    minor_spacing_ft: number;
    major_spacing_ft: number;
    model_coordinates_labeled: true;
  };
  overlay: ImageReference;
  usage_constraints: string[];
};

type PixelObservationBase = {
  kind: "wall" | "door" | "window";
  discipline: "architectural";
  observation_id: string;
  visibility: "clear" | "partial" | "occluded";
  confidence: number;
  supported_attributes: string[];
};

export type ArchitecturalPixelWallObservation = PixelObservationBase & {
  kind: "wall";
  pixel_points: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint];
};

export type ArchitecturalPixelOpeningObservation = PixelObservationBase & {
  kind: "door" | "window";
  pixel_point: ExistingConditionsPlanPoint;
  host_wall_observation_id: string;
};

export type ArchitecturalPixelMeasurementPackage = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  source_evidence_sha256: string;
  visible_evidence: Array<{ role: string; sha256: string }>;
  registration: ExistingConditionsRegistrationInput;
  measurement_receipt_sha256: string;
  coordinate_space: "measurement_overlay_pixels_top_left";
  level_name: string;
  level_elevation_ft: number;
  geometry_confidence_threshold?: number;
  material_confidence_threshold?: number;
  maximum_opening_host_distance_ft?: number;
  maximum_created_elements: number;
  observations: Array<ArchitecturalPixelWallObservation | ArchitecturalPixelOpeningObservation>;
};

export type ArchitecturalPixelMeasurementCompilation = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  measurement_receipt_sha256: string;
  converted_source_package: ArchitecturalPlanGeometryPreviewPackage;
  compiled_preview: CompiledArchitecturalPlanGeometryPreview;
};

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

function point(value: ExistingConditionsPlanPoint, label: string): ExistingConditionsPlanPoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  return { x: finite(value.x, `${label}_x`), y: finite(value.y, `${label}_y`) };
}

function bounds(value: Bounds2d, label: string): Bounds2d {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const min = point(value.min, `${label}_min`);
  const max = point(value.max, `${label}_max`);
  if (max.x <= min.x || max.y <= min.y) throw new Error(`${label}_must_have_positive_extent`);
  return { min, max };
}

function samePoint(a: ExistingConditionsPlanPoint, b: ExistingConditionsPlanPoint): boolean {
  return Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9;
}

function sameBounds(a: Bounds2d, b: Bounds2d): boolean {
  return samePoint(a.min, b.min) && samePoint(a.max, b.max);
}

function assertImageReference(reference: ImageReference, label: string, width: number, height: number): void {
  const filePath = path.resolve(requiredText(reference.path, `${label}_path`));
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`${label}_file_not_found:${filePath}`);
  const expected = sha256Text(reference.sha256, `${label}_sha256`);
  if (sha256File(filePath) !== expected) throw new Error(`${label}_sha256_mismatch`);
  if (reference.width_px !== width || reference.height_px !== height) throw new Error(`${label}_dimensions_mismatch`);
}

function formatCoordinate(value: number): string {
  const rounded = Math.abs(value) < 1e-9 ? 0 : Number(value.toFixed(2));
  return String(rounded);
}

function modelToPixel(
  model: ExistingConditionsPlanPoint,
  modelBounds: Bounds2d,
  width: number,
  height: number
): ExistingConditionsPlanPoint {
  return {
    x: (model.x - modelBounds.min.x) * width / (modelBounds.max.x - modelBounds.min.x),
    y: (modelBounds.max.y - model.y) * height / (modelBounds.max.y - modelBounds.min.y)
  };
}

function pixelToModel(
  pixel: ExistingConditionsPlanPoint,
  modelBounds: Bounds2d,
  width: number,
  height: number,
  label: string
): ExistingConditionsPlanPoint {
  const checked = point(pixel, label);
  if (checked.x < 0 || checked.x > width || checked.y < 0 || checked.y > height) {
    throw new Error(`${label}_outside_measurement_frame`);
  }
  return {
    x: modelBounds.min.x + checked.x / width * (modelBounds.max.x - modelBounds.min.x),
    y: modelBounds.max.y - checked.y / height * (modelBounds.max.y - modelBounds.min.y)
  };
}

function modelToSource(
  model: ExistingConditionsPlanPoint,
  registration: ExistingConditionsRegistrationReceipt
): ExistingConditionsPlanPoint {
  const radians = registration.rotation_degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = model.x - registration.translation_ft.x;
  const dy = model.y - registration.translation_ft.y;
  return {
    x: (cos * dx + sin * dy) / registration.scale,
    y: (-sin * dx + cos * dy) / registration.scale
  };
}

function projectPointToSegment(
  target: ExistingConditionsPlanPoint,
  segment: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint]
): { point: ExistingConditionsPlanPoint; distance_ft: number } {
  const [a, b] = segment;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) throw new Error("pixel_measurement_wall_segment_is_degenerate");
  const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSquared));
  const projected = { x: a.x + t * dx, y: a.y + t * dy };
  return { point: projected, distance_ft: Math.hypot(projected.x - target.x, projected.y - target.y) };
}

export async function buildArchitecturalMeasurementOverlay(
  delta: ArchitecturalSourceDeltaReceipt,
  deltaReceiptSha256: string,
  outDir: string
): Promise<ArchitecturalMeasurementOverlayReceipt> {
  if (delta.schema_version !== 1 || delta.artifact_role !== "architectural_source_redacted_delta") {
    throw new Error("architectural_measurement_requires_v1_delta_receipt");
  }
  if (!delta.registration_verified) throw new Error("architectural_measurement_requires_verified_registration");
  const deltaHash = sha256Text(deltaReceiptSha256, "architectural_delta_receipt_sha256");
  const fixtureId = requiredText(delta.fixture_id, "fixture_id");
  const scopeId = requiredText(delta.scope_id, "scope_id");
  const width = positiveInteger(delta.output_frame.width_px, "output_width_px");
  const height = positiveInteger(delta.output_frame.height_px, "output_height_px");
  const modelBounds = bounds(delta.scope_model_bounds, "scope_model_bounds");
  assertImageReference(delta.artifacts.source_aligned, "source_aligned", width, height);
  assertImageReference(delta.artifacts.candidate_delta_mask, "candidate_delta_mask", width, height);
  const resolvedOutDir = path.resolve(outDir);
  if (fs.existsSync(resolvedOutDir) && fs.readdirSync(resolvedOutDir).length > 0) {
    throw new Error(`refusing_to_overwrite_architectural_measurement_overlay:${resolvedOutDir}`);
  }
  fs.mkdirSync(resolvedOutDir, { recursive: true });
  const [source, candidate] = await Promise.all([
    loadImage(path.resolve(delta.artifacts.source_aligned.path)),
    loadImage(path.resolve(delta.artifacts.candidate_delta_mask.path))
  ]);
  if (source.width !== width || source.height !== height || candidate.width !== width || candidate.height !== height) {
    throw new Error("architectural_measurement_image_dimensions_mismatch");
  }
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0);
  context.globalAlpha = 0.58;
  context.drawImage(candidate, 0, 0);
  context.globalAlpha = 1;
  const minorSpacingFt = 0.25;
  const majorSpacingFt = 1;
  const xStart = Math.ceil(modelBounds.min.x / minorSpacingFt) * minorSpacingFt;
  const yStart = Math.ceil(modelBounds.min.y / minorSpacingFt) * minorSpacingFt;
  for (let x = xStart; x <= modelBounds.max.x + 1e-9; x += minorSpacingFt) {
    const pixel = modelToPixel({ x, y: modelBounds.min.y }, modelBounds, width, height).x;
    const major = Math.abs(x / majorSpacingFt - Math.round(x / majorSpacingFt)) <= 1e-7;
    context.strokeStyle = major ? "rgba(0, 90, 220, 0.62)" : "rgba(0, 120, 255, 0.2)";
    context.lineWidth = major ? 1.5 : 1;
    context.beginPath();
    context.moveTo(pixel, 0);
    context.lineTo(pixel, height);
    context.stroke();
    if (major && pixel >= 2 && pixel <= width - 40) {
      context.fillStyle = "rgba(255,255,255,0.86)";
      context.fillRect(pixel + 2, 2, 62, 18);
      context.fillStyle = "#005ac8";
      context.font = "13px Arial";
      context.fillText(`X ${formatCoordinate(x)}`, pixel + 4, 15);
    }
  }
  for (let y = yStart; y <= modelBounds.max.y + 1e-9; y += minorSpacingFt) {
    const pixel = modelToPixel({ x: modelBounds.min.x, y }, modelBounds, width, height).y;
    const major = Math.abs(y / majorSpacingFt - Math.round(y / majorSpacingFt)) <= 1e-7;
    context.strokeStyle = major ? "rgba(0, 90, 220, 0.62)" : "rgba(0, 120, 255, 0.2)";
    context.lineWidth = major ? 1.5 : 1;
    context.beginPath();
    context.moveTo(0, pixel);
    context.lineTo(width, pixel);
    context.stroke();
    if (major && pixel >= 20 && pixel <= height - 2) {
      context.fillStyle = "rgba(255,255,255,0.86)";
      context.fillRect(2, pixel - 18, 62, 18);
      context.fillStyle = "#005ac8";
      context.font = "13px Arial";
      context.fillText(`Y ${formatCoordinate(y)}`, 4, pixel - 5);
    }
  }
  const overlayPath = path.join(resolvedOutDir, "registered_measurement_overlay.png");
  fs.writeFileSync(overlayPath, canvas.toBuffer("image/png"));
  const overlayHash = sha256File(overlayPath);
  return {
    schema_version: 1,
    artifact_role: "architectural_registered_measurement_overlay",
    fixture_id: fixtureId,
    scope_id: scopeId,
    architectural_delta_receipt_sha256: deltaHash,
    registration_source_evidence_sha256: sha256Text(
      delta.registration_source_evidence_sha256,
      "registration_source_evidence_sha256"
    ),
    source_aligned_sha256: delta.artifacts.source_aligned.sha256.toLowerCase(),
    candidate_delta_mask_sha256: delta.artifacts.candidate_delta_mask.sha256.toLowerCase(),
    scope_model_bounds: modelBounds,
    output_frame: {
      width_px: width,
      height_px: height,
      pixel_origin: "top_left",
      pixel_to_model_formula: {
        x: `scope.min.x + pixel_x / ${width} * (scope.max.x - scope.min.x)`,
        y: `scope.max.y - pixel_y / ${height} * (scope.max.y - scope.min.y)`
      }
    },
    grid_policy: {
      minor_spacing_ft: minorSpacingFt,
      major_spacing_ft: majorSpacingFt,
      model_coordinates_labeled: true
    },
    overlay: {
      path: overlayPath,
      sha256: overlayHash,
      width_px: width,
      height_px: height
    },
    usage_constraints: [
      "The overlay is derived only from the registered source-aligned image, candidate source-only mask, and declared model-space frame.",
      "Blue grid labels are registered model XY coordinates; observation input remains top-left-origin image pixels so conversion is deterministic.",
      "Red pixels are candidate source-only ink and may include annotations or line-style noise; the overlay is measurement evidence, not evaluator truth.",
      "Wall endpoints require semantic visual selection. Opening points are projected only onto an independently selected observed host wall and must remain within the declared host-distance limit.",
      "No material, vertical, family, type, thickness, width, height, or sill value may be inferred from this overlay alone."
    ]
  };
}

export function compileArchitecturalPixelMeasurementPreview(
  input: ArchitecturalPixelMeasurementPackage,
  measurement: ArchitecturalMeasurementOverlayReceipt,
  measurementReceiptSha256: string
): ArchitecturalPixelMeasurementCompilation {
  if (input.schema_version !== 1 || measurement.schema_version !== 1) throw new Error("architectural_pixel_measurement_requires_schema_v1");
  if (input.coordinate_space !== "measurement_overlay_pixels_top_left") {
    throw new Error("architectural_pixel_measurement_coordinate_space_is_invalid");
  }
  const fixtureId = requiredText(input.fixture_id, "fixture_id");
  const scopeId = requiredText(input.scope_id, "scope_id");
  if (measurement.fixture_id !== fixtureId) throw new Error("architectural_pixel_measurement_fixture_id_mismatch");
  if (measurement.scope_id !== scopeId) throw new Error("architectural_pixel_measurement_scope_id_mismatch");
  const actualMeasurementHash = sha256Text(measurementReceiptSha256, "measurement_receipt_sha256");
  if (sha256Text(input.measurement_receipt_sha256, "input_measurement_receipt_sha256") !== actualMeasurementHash) {
    throw new Error("architectural_pixel_measurement_receipt_sha256_mismatch");
  }
  const sourceHash = sha256Text(input.source_evidence_sha256, "source_evidence_sha256");
  if (measurement.registration_source_evidence_sha256 !== sourceHash) {
    throw new Error("architectural_pixel_measurement_source_evidence_mismatch");
  }
  const registration = solveExistingConditionsRegistration(input.registration);
  if (!registration.verified) throw new Error("architectural_pixel_measurement_registration_not_verified");
  if (registration.source_evidence_sha256 !== sourceHash) throw new Error("architectural_pixel_measurement_registration_hash_mismatch");
  const overlayEvidence = input.visible_evidence.find((entry) => entry.role === "architectural_registered_measurement_overlay");
  if (!overlayEvidence || sha256Text(overlayEvidence.sha256, "measurement_overlay_evidence_sha256") !== measurement.overlay.sha256) {
    throw new Error("architectural_pixel_measurement_overlay_evidence_mismatch");
  }
  if (!input.visible_evidence.some((entry) => entry.role === "source_pdf" && sha256Text(entry.sha256, "source_pdf_evidence_sha256") === sourceHash)) {
    throw new Error("architectural_pixel_measurement_source_pdf_evidence_is_required");
  }
  const width = positiveInteger(measurement.output_frame.width_px, "measurement_width_px");
  const height = positiveInteger(measurement.output_frame.height_px, "measurement_height_px");
  if (measurement.overlay.width_px !== width || measurement.overlay.height_px !== height) {
    throw new Error("architectural_pixel_measurement_overlay_dimensions_mismatch");
  }
  const modelBounds = bounds(measurement.scope_model_bounds, "measurement_scope_model_bounds");
  const maximumCreated = positiveInteger(input.maximum_created_elements, "maximum_created_elements");
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new Error("architectural_pixel_measurement_observations_are_required");
  }
  if (input.observations.length > maximumCreated) {
    throw new Error("architectural_pixel_measurement_observations_exceed_maximum_created_elements");
  }
  const observationIds = input.observations.map((entry, index) => requiredText(entry.observation_id, `observation_${index}_id`));
  if (new Set(observationIds).size !== observationIds.length) throw new Error("architectural_pixel_measurement_observation_ids_must_be_unique");
  const maximumHostDistance = input.maximum_opening_host_distance_ft == null
    ? 0.75
    : positive(input.maximum_opening_host_distance_ft, "maximum_opening_host_distance_ft");
  const walls = new Map<string, [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint]>();
  for (const [index, observation] of input.observations.entries()) {
    if (observation.discipline !== "architectural") throw new Error(`observation_${index}_discipline_must_be_architectural`);
    if (observation.kind !== "wall") continue;
    if (!Array.isArray(observation.pixel_points) || observation.pixel_points.length !== 2) {
      throw new Error(`${observation.observation_id}_requires_two_pixel_points`);
    }
    const endpoints = observation.pixel_points.map((entry, pointIndex) => pixelToModel(
      entry,
      modelBounds,
      width,
      height,
      `${observation.observation_id}_pixel_point_${pointIndex}`
    )) as [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint];
    if (Math.hypot(endpoints[1].x - endpoints[0].x, endpoints[1].y - endpoints[0].y) <= Number.EPSILON) {
      throw new Error(`${observation.observation_id}_wall_segment_is_degenerate`);
    }
    walls.set(observation.observation_id, endpoints);
  }
  const convertedObservations: ArchitecturalPlanGeometryPreviewPackage["observations"] = input.observations.map((observation) => {
    const common = {
      kind: observation.kind,
      discipline: "architectural" as const,
      observation_id: observation.observation_id,
      evidence_role: "architectural_registered_measurement_overlay",
      visibility: observation.visibility,
      confidence: observation.confidence,
      supported_attributes: [...observation.supported_attributes]
    };
    if (observation.kind === "wall") {
      const endpoints = walls.get(observation.observation_id)!;
      return {
        ...common,
        kind: "wall" as const,
        points: [modelToSource(endpoints[0], registration), modelToSource(endpoints[1], registration)]
      };
    }
    const hostId = requiredText(observation.host_wall_observation_id, `${observation.observation_id}_host_wall_observation_id`);
    const host = walls.get(hostId);
    if (!host) throw new Error(`${observation.observation_id}_references_unknown_measured_host_wall:${hostId}`);
    const measuredModelPoint = pixelToModel(
      observation.pixel_point,
      modelBounds,
      width,
      height,
      `${observation.observation_id}_pixel_point`
    );
    const projected = projectPointToSegment(measuredModelPoint, host);
    if (projected.distance_ft > maximumHostDistance) {
      throw new Error(`${observation.observation_id}_opening_exceeds_host_projection_limit:${projected.distance_ft.toFixed(6)}`);
    }
    return {
      ...common,
      kind: observation.kind,
      point: modelToSource(projected.point, registration),
      host_wall_observation_id: hostId
    };
  });
  const sourcePackage: ArchitecturalPlanGeometryPreviewPackage = {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    source_evidence_sha256: sourceHash,
    visible_evidence: input.visible_evidence.map((entry) => ({
      role: requiredText(entry.role, "visible_evidence_role"),
      sha256: sha256Text(entry.sha256, "visible_evidence_sha256")
    })),
    registration: input.registration,
    level_name: requiredText(input.level_name, "level_name"),
    level_elevation_ft: finite(input.level_elevation_ft, "level_elevation_ft"),
    geometry_confidence_threshold: input.geometry_confidence_threshold,
    material_confidence_threshold: input.material_confidence_threshold,
    maximum_opening_host_distance_ft: maximumHostDistance,
    maximum_created_elements: maximumCreated,
    observations: convertedObservations
  };
  return {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    measurement_receipt_sha256: actualMeasurementHash,
    converted_source_package: sourcePackage,
    compiled_preview: compileArchitecturalPlanGeometryPreview(sourcePackage)
  };
}
