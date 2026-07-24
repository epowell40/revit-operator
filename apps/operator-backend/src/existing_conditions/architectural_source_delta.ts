import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import type { ExistingConditionsPlanPoint, ExistingConditionsRegistrationReceipt } from "./registration.js";

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

export type ArchitecturalSourceDeltaInput = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  source_render: ImageReference & {
    source_sheet_bounds: Bounds2d;
  };
  registration: ExistingConditionsRegistrationReceipt;
  redacted_model_capture: ImageReference & {
    model_frame: {
      top_left: ExistingConditionsPlanPoint;
      top_right: ExistingConditionsPlanPoint;
      bottom_left: ExistingConditionsPlanPoint;
    };
  };
  scope_model_bounds: Bounds2d;
  output_width_px?: number;
  ink_luminance_threshold?: number;
  redacted_ink_dilation_px?: number;
};

export type ArchitecturalSourceDeltaReceipt = {
  schema_version: 1;
  artifact_role: "architectural_source_redacted_delta";
  fixture_id: string;
  scope_id: string;
  input_fingerprint_sha256: string;
  source_render_sha256: string;
  redacted_model_capture_sha256: string;
  registration_source_evidence_sha256: string;
  registration_verified: boolean;
  scope_model_bounds: Bounds2d;
  output_frame: {
    width_px: number;
    height_px: number;
    pixel_to_model_formula: {
      x: string;
      y: string;
    };
  };
  render_policy: {
    ink_luminance_threshold: number;
    redacted_ink_dilation_px: number;
  };
  artifacts: {
    source_aligned: ImageReference;
    redacted_aligned: ImageReference;
    candidate_delta_mask: ImageReference;
    comparison: ImageReference;
  };
  usage_constraints: string[];
};

type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };

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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
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

function imageReference(value: ImageReference, label: string): ImageReference {
  const filePath = path.resolve(requiredText(value.path, `${label}_path`));
  if (!fs.existsSync(filePath)) throw new Error(`${label}_file_not_found:${filePath}`);
  const expectedHash = sha256Text(value.sha256, `${label}_sha256`);
  const actualHash = sha256File(filePath);
  if (actualHash !== expectedHash) throw new Error(`${label}_sha256_mismatch`);
  return {
    path: filePath,
    sha256: actualHash,
    width_px: positiveInteger(value.width_px, `${label}_width_px`),
    height_px: positiveInteger(value.height_px, `${label}_height_px`)
  };
}

function sourcePixelToOutputAffine(
  input: ArchitecturalSourceDeltaInput,
  source: ImageReference,
  scope: Bounds2d,
  width: number,
  height: number
): Affine {
  const sheet = bounds(input.source_render.source_sheet_bounds, "source_sheet_bounds");
  const receipt = input.registration;
  const radians = receipt.rotation_degrees * Math.PI / 180;
  const registrationA = receipt.scale * Math.cos(radians);
  const registrationB = receipt.scale * Math.sin(radians);
  const sourceDxPerPixel = (sheet.max.x - sheet.min.x) / source.width_px;
  const sourceDyPerPixel = (sheet.max.y - sheet.min.y) / source.height_px;
  const modelXConstant = registrationA * sheet.min.x - registrationB * sheet.max.y + receipt.translation_ft.x;
  const modelYConstant = registrationB * sheet.min.x + registrationA * sheet.max.y + receipt.translation_ft.y;
  const modelXPerPixelX = registrationA * sourceDxPerPixel;
  const modelXPerPixelY = registrationB * sourceDyPerPixel;
  const modelYPerPixelX = registrationB * sourceDxPerPixel;
  const modelYPerPixelY = -registrationA * sourceDyPerPixel;
  const outputXPerModel = width / (scope.max.x - scope.min.x);
  const outputYPerModel = height / (scope.max.y - scope.min.y);
  return {
    a: outputXPerModel * modelXPerPixelX,
    b: -outputYPerModel * modelYPerPixelX,
    c: outputXPerModel * modelXPerPixelY,
    d: -outputYPerModel * modelYPerPixelY,
    e: outputXPerModel * (modelXConstant - scope.min.x),
    f: outputYPerModel * (scope.max.y - modelYConstant)
  };
}

function capturePixelToOutputAffine(
  input: ArchitecturalSourceDeltaInput,
  capture: ImageReference,
  scope: Bounds2d,
  width: number,
  height: number
): Affine {
  const frame = input.redacted_model_capture.model_frame;
  const topLeft = point(frame.top_left, "redacted_model_capture_top_left");
  const topRight = point(frame.top_right, "redacted_model_capture_top_right");
  const bottomLeft = point(frame.bottom_left, "redacted_model_capture_bottom_left");
  const modelXPerPixelX = (topRight.x - topLeft.x) / capture.width_px;
  const modelYPerPixelX = (topRight.y - topLeft.y) / capture.width_px;
  const modelXPerPixelY = (bottomLeft.x - topLeft.x) / capture.height_px;
  const modelYPerPixelY = (bottomLeft.y - topLeft.y) / capture.height_px;
  const determinant = modelXPerPixelX * modelYPerPixelY - modelXPerPixelY * modelYPerPixelX;
  if (Math.abs(determinant) <= 1e-12) throw new Error("redacted_model_capture_frame_is_degenerate");
  const outputXPerModel = width / (scope.max.x - scope.min.x);
  const outputYPerModel = height / (scope.max.y - scope.min.y);
  return {
    a: outputXPerModel * modelXPerPixelX,
    b: -outputYPerModel * modelYPerPixelX,
    c: outputXPerModel * modelXPerPixelY,
    d: -outputYPerModel * modelYPerPixelY,
    e: outputXPerModel * (topLeft.x - scope.min.x),
    f: outputYPerModel * (scope.max.y - topLeft.y)
  };
}

function drawAligned(
  sourceImage: Awaited<ReturnType<typeof loadImage>>,
  width: number,
  height: number,
  affine: Affine
): Canvas {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.setTransform(affine.a, affine.b, affine.c, affine.d, affine.e, affine.f);
  context.drawImage(sourceImage, 0, 0);
  context.resetTransform();
  return canvas;
}

function inkMask(data: Uint8ClampedArray, threshold: number): Uint8Array {
  const mask = new Uint8Array(data.length / 4);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    const alpha = data[offset + 3]! / 255;
    const luminance = 0.2126 * data[offset]! + 0.7152 * data[offset + 1]! + 0.0722 * data[offset + 2]!;
    mask[index] = alpha > 0.1 && luminance < threshold ? 1 : 0;
  }
  return mask;
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

function buildDeltaCanvas(
  sourceCanvas: Canvas,
  redactedCanvas: Canvas,
  threshold: number,
  dilationRadius: number
): { canvas: Canvas; candidatePixelCount: number } {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const sourceData = sourceCanvas.getContext("2d").getImageData(0, 0, width, height);
  const redactedData = redactedCanvas.getContext("2d").getImageData(0, 0, width, height);
  const sourceInk = inkMask(sourceData.data, threshold);
  const redactedInk = dilate(inkMask(redactedData.data, threshold), width, height, dilationRadius);
  const delta = createCanvas(width, height);
  const context = delta.getContext("2d");
  const output = context.createImageData(width, height);
  let candidatePixelCount = 0;
  for (let index = 0; index < sourceInk.length; index += 1) {
    if (!sourceInk[index] || redactedInk[index]) continue;
    const offset = index * 4;
    output.data[offset] = 230;
    output.data[offset + 1] = 30;
    output.data[offset + 2] = 30;
    output.data[offset + 3] = 220;
    candidatePixelCount += 1;
  }
  context.putImageData(output, 0, 0);
  return { canvas: delta, candidatePixelCount };
}

function comparisonCanvas(
  sourceCanvas: Canvas,
  redactedCanvas: Canvas,
  deltaCanvas: Canvas
): Canvas {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const header = 42;
  const comparison = createCanvas(width * 3, height + header);
  const context = comparison.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, comparison.width, comparison.height);
  context.fillStyle = "#111111";
  context.font = "bold 18px sans-serif";
  context.fillText("SOURCE PDF - ALIGNED", 14, 27);
  context.fillText("REDACTED MODEL - ALIGNED", width + 14, 27);
  context.fillText("CANDIDATE SOURCE-ONLY INK", width * 2 + 14, 27);
  context.drawImage(sourceCanvas, 0, header);
  context.drawImage(redactedCanvas, width, header);
  context.drawImage(redactedCanvas, width * 2, header);
  context.drawImage(deltaCanvas, width * 2, header);
  context.strokeStyle = "#888888";
  context.lineWidth = 1;
  context.strokeRect(0.5, header + 0.5, width - 1, height - 1);
  context.strokeRect(width + 0.5, header + 0.5, width - 1, height - 1);
  context.strokeRect(width * 2 + 0.5, header + 0.5, width - 1, height - 1);
  return comparison;
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

export async function buildArchitecturalSourceDelta(
  input: ArchitecturalSourceDeltaInput,
  outputDirectory: string
): Promise<ArchitecturalSourceDeltaReceipt> {
  if (input.schema_version !== 1) throw new Error("unsupported_architectural_source_delta_schema_version");
  const fixtureId = requiredText(input.fixture_id, "fixture_id");
  const scopeId = requiredText(input.scope_id, "scope_id");
  const source = imageReference(input.source_render, "source_render");
  const redacted = imageReference(input.redacted_model_capture, "redacted_model_capture");
  const scope = bounds(input.scope_model_bounds, "scope_model_bounds");
  if (!input.registration.verified) throw new Error("architectural_source_delta_requires_verified_registration");
  sha256Text(input.registration.source_evidence_sha256, "registration_source_evidence_sha256");
  const outputWidth = positiveInteger(input.output_width_px ?? 1600, "output_width_px");
  if (outputWidth > 4096) throw new Error("output_width_px_exceeds_4096");
  const outputHeight = Math.max(1, Math.round(outputWidth * (scope.max.y - scope.min.y) / (scope.max.x - scope.min.x)));
  if (outputHeight > 4096) throw new Error("output_height_px_exceeds_4096");
  const threshold = positiveInteger(input.ink_luminance_threshold ?? 220, "ink_luminance_threshold");
  if (threshold > 254) throw new Error("ink_luminance_threshold_must_be_at_most_254");
  const dilationRadius = input.redacted_ink_dilation_px ?? 3;
  if (!Number.isSafeInteger(dilationRadius) || dilationRadius < 0 || dilationRadius > 20) {
    throw new Error("redacted_ink_dilation_px_must_be_an_integer_between_0_and_20");
  }
  const sourceImage = await loadImage(source.path);
  const redactedImage = await loadImage(redacted.path);
  if (sourceImage.width !== source.width_px || sourceImage.height !== source.height_px) throw new Error("source_render_dimensions_mismatch");
  if (redactedImage.width !== redacted.width_px || redactedImage.height !== redacted.height_px) throw new Error("redacted_model_capture_dimensions_mismatch");
  const sourceCanvas = drawAligned(
    sourceImage,
    outputWidth,
    outputHeight,
    sourcePixelToOutputAffine(input, source, scope, outputWidth, outputHeight)
  );
  const redactedCanvas = drawAligned(
    redactedImage,
    outputWidth,
    outputHeight,
    capturePixelToOutputAffine(input, redacted, scope, outputWidth, outputHeight)
  );
  const delta = buildDeltaCanvas(sourceCanvas, redactedCanvas, threshold, dilationRadius);
  const comparison = comparisonCanvas(sourceCanvas, redactedCanvas, delta.canvas);
  const outDir = path.resolve(outputDirectory);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`refusing_to_overwrite_architectural_source_delta:${outDir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const sourceAligned = writeCanvas(path.join(outDir, "source_aligned.png"), sourceCanvas);
  const redactedAligned = writeCanvas(path.join(outDir, "redacted_aligned.png"), redactedCanvas);
  const candidateDeltaMask = writeCanvas(path.join(outDir, "candidate_delta_mask.png"), delta.canvas);
  const comparisonArtifact = writeCanvas(path.join(outDir, "source_redacted_comparison.png"), comparison);
  return {
    schema_version: 1,
    artifact_role: "architectural_source_redacted_delta",
    fixture_id: fixtureId,
    scope_id: scopeId,
    input_fingerprint_sha256: fingerprint(input),
    source_render_sha256: source.sha256,
    redacted_model_capture_sha256: redacted.sha256,
    registration_source_evidence_sha256: input.registration.source_evidence_sha256.toLowerCase(),
    registration_verified: true,
    scope_model_bounds: scope,
    output_frame: {
      width_px: outputWidth,
      height_px: outputHeight,
      pixel_to_model_formula: {
        x: `scope.min.x + pixel_x / ${outputWidth} * (scope.max.x - scope.min.x)`,
        y: `scope.max.y - pixel_y / ${outputHeight} * (scope.max.y - scope.min.y)`
      }
    },
    render_policy: {
      ink_luminance_threshold: threshold,
      redacted_ink_dilation_px: dilationRadius
    },
    artifacts: {
      source_aligned: sourceAligned,
      redacted_aligned: redactedAligned,
      candidate_delta_mask: candidateDeltaMask,
      comparison: comparisonArtifact
    },
    usage_constraints: [
      "Every output pixel is derived only from the approved source render, redacted-model capture, verified registration, and declared crop bounds.",
      "Red pixels are candidate source-only ink after tolerant image differencing; they are not evaluator truth and may include annotation or line-style noise.",
      "Scope/model bounds define only the comparison crop and must never be interpreted as target walls or opening geometry.",
      `Candidate delta mask contains ${delta.candidatePixelCount} source-only pixels before semantic interpretation.`,
      "Only semantically recognized, source-grounded walls and openings may enter the non-writing preview contract; native promotion remains separately gated."
    ]
  };
}
