import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { MepCoverageBounds, MepCoveragePoint } from "./mep_region_coverage.js";

export type SheetChromaticComponentDetectionInputV1 = {
  schema_version: 1;
  source_image_path: string;
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  search_region: MepCoverageBounds;
  expected_hue_degrees: number;
  hue_tolerance_degrees?: number;
  minimum_chroma?: number;
  maximum_luminance?: number;
  adjacency_radius_px?: number;
  minimum_component_pixels?: number;
  maximum_component_pixels?: number;
  minimum_component_width_px?: number;
  maximum_component_width_px?: number;
  minimum_component_height_px?: number;
  maximum_component_height_px?: number;
  minimum_fill_fraction?: number;
  maximum_candidates?: number;
};

export type SheetChromaticComponentCandidateV1 = {
  candidate_id: string;
  pixel_bounds: MepCoverageBounds;
  center: MepCoveragePoint;
  anchor: MepCoveragePoint;
  chromatic_pixel_count: number;
  fill_fraction: number;
  coherent_hue_degrees: number;
  maximum_hue_deviation_degrees: number;
  native_write_allowed: false;
};

export type SheetChromaticComponentDetectionReceiptV1 = {
  schema: "operator.sheet_chromatic_component_detection.v1";
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  search_region: MepCoverageBounds;
  policy: {
    expected_hue_degrees: number;
    hue_tolerance_degrees: number;
    minimum_chroma: number;
    maximum_luminance: number;
    adjacency_radius_px: number;
    minimum_component_pixels: number;
    maximum_component_pixels: number;
    minimum_component_width_px: number;
    maximum_component_width_px: number;
    minimum_component_height_px: number;
    maximum_component_height_px: number;
    minimum_fill_fraction: number;
    maximum_candidates: number;
  };
  qualifying_pixel_count: number;
  rejected_component_counts: Record<"too_few_pixels" | "too_many_pixels" | "width_out_of_range" | "height_out_of_range" | "fill_fraction_below_minimum", number>;
  candidates: SheetChromaticComponentCandidateV1[];
  overlay?: { path: string; sha256: string };
  capability_boundary: string;
};

type PixelBounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
type ChromaticPixel = { x: number; y: number; hue: number };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function requiredSha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function integer(value: unknown, fallback: number, label: string, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label}_must_be_integer_${minimum}_through_${maximum}`);
  }
  return result;
}

function bounded(value: unknown, fallback: number, label: string, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${label}_out_of_range`);
  return result;
}

function normalizeHue(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 360) throw new Error(`${label}_must_be_between_zero_and_360`);
  return result === 360 ? 0 : result;
}

function pixelBounds(value: MepCoverageBounds, label: string, width: number, height: number): PixelBounds {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const minX = integer(value.min?.x, Number.NaN, `${label}_min_x`, 0, width - 1);
  const minY = integer(value.min?.y, Number.NaN, `${label}_min_y`, 0, height - 1);
  const maxX = integer(value.max?.x, Number.NaN, `${label}_max_x`, 1, width);
  const maxY = integer(value.max?.y, Number.NaN, `${label}_max_y`, 1, height);
  if (maxX <= minX || maxY <= minY) throw new Error(`${label}_must_have_positive_extent`);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function outputBounds(bounds: PixelBounds): MepCoverageBounds {
  return { min: { x: bounds.minX, y: bounds.minY }, max: { x: bounds.maxX, y: bounds.maxY } };
}

function circularHueDistance(left: number, right: number): number {
  const distance = Math.abs(left - right);
  return Math.min(distance, 360 - distance);
}

function rgbHue(red: number, green: number, blue: number): { hue: number; chroma: number; luminance: number } {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  if (chroma === 0) return { hue: 0, chroma, luminance };
  let hue = maximum === red
    ? 60 * (((green - blue) / chroma) % 6)
    : maximum === green
      ? 60 * (((blue - red) / chroma) + 2)
      : 60 * (((red - green) / chroma) + 4);
  if (hue < 0) hue += 360;
  return { hue, chroma, luminance };
}

function componentId(bounds: PixelBounds, pixelCount: number, center: MepCoveragePoint): string {
  return crypto.createHash("sha256")
    .update(`${bounds.minX}|${bounds.minY}|${bounds.maxX}|${bounds.maxY}|${pixelCount}|${center.x.toFixed(4)}|${center.y.toFixed(4)}`)
    .digest("hex")
    .slice(0, 20);
}

function componentBounds(pixels: ChromaticPixel[]): PixelBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const pixel of pixels) {
    minX = Math.min(minX, pixel.x);
    minY = Math.min(minY, pixel.y);
    maxX = Math.max(maxX, pixel.x + 1);
    maxY = Math.max(maxY, pixel.y + 1);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function circularMeanHue(pixels: ChromaticPixel[]): number {
  let sine = 0;
  let cosine = 0;
  for (const pixel of pixels) {
    const radians = pixel.hue * Math.PI / 180;
    sine += Math.sin(radians);
    cosine += Math.cos(radians);
  }
  const degrees = Math.atan2(sine, cosine) * 180 / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

function maximumHueDeviation(pixels: ChromaticPixel[], expectedHue: number): number {
  let maximum = 0;
  for (const pixel of pixels) maximum = Math.max(maximum, circularHueDistance(pixel.hue, expectedHue));
  return maximum;
}

export async function detectSheetChromaticComponentsV1(
  input: SheetChromaticComponentDetectionInputV1
): Promise<SheetChromaticComponentDetectionReceiptV1> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) {
    throw new Error("sheet_chromatic_component_detection_requires_schema_v1");
  }
  const sourcePath = clean(input.source_image_path);
  if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`sheet_chromatic_component_source_image_not_found:${sourcePath}`);
  }
  const sourceHash = requiredSha256(input.source_image_sha256, "sheet_chromatic_component_source_image_sha256");
  const width = integer(input.source_image_width_px, Number.NaN, "sheet_chromatic_component_source_image_width_px", 1, 20000);
  const height = integer(input.source_image_height_px, Number.NaN, "sheet_chromatic_component_source_image_height_px", 1, 20000);
  if (width * height > 50_000_000) throw new Error("sheet_chromatic_component_source_image_exceeds_50000000_pixels");
  const sourceBuffer = fs.readFileSync(sourcePath);
  if (sourceBuffer.byteLength > 256 * 1024 * 1024) throw new Error("sheet_chromatic_component_source_image_exceeds_256_megabytes");
  if (sha256Buffer(sourceBuffer) !== sourceHash) throw new Error("sheet_chromatic_component_source_image_hash_mismatch");
  const image = await loadImage(sourceBuffer);
  if (image.width !== width || image.height !== height) throw new Error("sheet_chromatic_component_source_image_dimensions_mismatch");
  const search = pixelBounds(input.search_region, "sheet_chromatic_component_search_region", width, height);
  if (search.width * search.height > 2_000_000) throw new Error("sheet_chromatic_component_search_region_exceeds_two_million_pixels");

  const policy = {
    expected_hue_degrees: normalizeHue(input.expected_hue_degrees, "sheet_chromatic_component_expected_hue_degrees"),
    hue_tolerance_degrees: bounded(input.hue_tolerance_degrees, 30, "sheet_chromatic_component_hue_tolerance_degrees", 0, 180),
    minimum_chroma: bounded(input.minimum_chroma, 40, "sheet_chromatic_component_minimum_chroma", 1, 255),
    maximum_luminance: bounded(input.maximum_luminance, 245, "sheet_chromatic_component_maximum_luminance", 0, 255),
    adjacency_radius_px: integer(input.adjacency_radius_px, 1, "sheet_chromatic_component_adjacency_radius_px", 1, 4),
    minimum_component_pixels: integer(input.minimum_component_pixels, 8, "sheet_chromatic_component_minimum_component_pixels", 1, 1_000_000),
    maximum_component_pixels: integer(input.maximum_component_pixels, 20_000, "sheet_chromatic_component_maximum_component_pixels", 1, 2_000_000),
    minimum_component_width_px: integer(input.minimum_component_width_px, 1, "sheet_chromatic_component_minimum_component_width_px", 1, 20_000),
    maximum_component_width_px: integer(input.maximum_component_width_px, search.width, "sheet_chromatic_component_maximum_component_width_px", 1, 20_000),
    minimum_component_height_px: integer(input.minimum_component_height_px, 1, "sheet_chromatic_component_minimum_component_height_px", 1, 20_000),
    maximum_component_height_px: integer(input.maximum_component_height_px, search.height, "sheet_chromatic_component_maximum_component_height_px", 1, 20_000),
    minimum_fill_fraction: bounded(input.minimum_fill_fraction, 0, "sheet_chromatic_component_minimum_fill_fraction", 0, 1),
    maximum_candidates: integer(input.maximum_candidates, 500, "sheet_chromatic_component_maximum_candidates", 1, 5000)
  };
  if (policy.maximum_component_pixels < policy.minimum_component_pixels) throw new Error("sheet_chromatic_component_pixel_range_invalid");
  if (policy.maximum_component_width_px < policy.minimum_component_width_px) throw new Error("sheet_chromatic_component_width_range_invalid");
  if (policy.maximum_component_height_px < policy.minimum_component_height_px) throw new Error("sheet_chromatic_component_height_range_invalid");

  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  const localWidth = search.width;
  const localHeight = search.height;
  const qualifying = new Uint8Array(localWidth * localHeight);
  const hues = new Float32Array(localWidth * localHeight);
  let qualifyingPixelCount = 0;
  for (let y = search.minY; y < search.maxY; y += 1) {
    for (let x = search.minX; x < search.maxX; x += 1) {
      const offset = ((y * width) + x) * 4;
      if ((data[offset + 3] ?? 0) < 128) continue;
      const color = rgbHue(data[offset] ?? 255, data[offset + 1] ?? 255, data[offset + 2] ?? 255);
      if (color.chroma < policy.minimum_chroma || color.luminance > policy.maximum_luminance) continue;
      if (circularHueDistance(color.hue, policy.expected_hue_degrees) > policy.hue_tolerance_degrees) continue;
      const localIndex = ((y - search.minY) * localWidth) + (x - search.minX);
      qualifying[localIndex] = 1;
      hues[localIndex] = color.hue;
      qualifyingPixelCount += 1;
    }
  }

  const visited = new Uint8Array(qualifying.length);
  const rawComponents: ChromaticPixel[][] = [];
  const neighborOffsets: Array<{ x: number; y: number }> = [];
  for (let dy = -policy.adjacency_radius_px; dy <= policy.adjacency_radius_px; dy += 1) {
    for (let dx = -policy.adjacency_radius_px; dx <= policy.adjacency_radius_px; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      neighborOffsets.push({ x: dx, y: dy });
    }
  }
  for (let localY = 0; localY < localHeight; localY += 1) {
    for (let localX = 0; localX < localWidth; localX += 1) {
      const startIndex = (localY * localWidth) + localX;
      if (!qualifying[startIndex] || visited[startIndex]) continue;
      const queue: number[] = [startIndex];
      visited[startIndex] = 1;
      const component: ChromaticPixel[] = [];
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor]!;
        const y = Math.floor(index / localWidth);
        const x = index - (y * localWidth);
        component.push({ x: search.minX + x, y: search.minY + y, hue: hues[index]! });
        for (const offset of neighborOffsets) {
          const nx = x + offset.x;
          const ny = y + offset.y;
          if (nx < 0 || ny < 0 || nx >= localWidth || ny >= localHeight) continue;
          const neighborIndex = (ny * localWidth) + nx;
          if (!qualifying[neighborIndex] || visited[neighborIndex]) continue;
          visited[neighborIndex] = 1;
          queue.push(neighborIndex);
        }
      }
      rawComponents.push(component);
    }
  }

  const rejected: SheetChromaticComponentDetectionReceiptV1["rejected_component_counts"] = {
    too_few_pixels: 0,
    too_many_pixels: 0,
    width_out_of_range: 0,
    height_out_of_range: 0,
    fill_fraction_below_minimum: 0
  };
  const candidates: SheetChromaticComponentCandidateV1[] = [];
  for (const component of rawComponents) {
    if (component.length < policy.minimum_component_pixels) { rejected.too_few_pixels += 1; continue; }
    if (component.length > policy.maximum_component_pixels) { rejected.too_many_pixels += 1; continue; }
    const bounds = componentBounds(component);
    if (bounds.width < policy.minimum_component_width_px || bounds.width > policy.maximum_component_width_px) { rejected.width_out_of_range += 1; continue; }
    if (bounds.height < policy.minimum_component_height_px || bounds.height > policy.maximum_component_height_px) { rejected.height_out_of_range += 1; continue; }
    const fillFraction = component.length / (bounds.width * bounds.height);
    if (fillFraction < policy.minimum_fill_fraction) { rejected.fill_fraction_below_minimum += 1; continue; }
    const anchor = {
      x: component.reduce((sum, pixel) => sum + pixel.x + 0.5, 0) / component.length,
      y: component.reduce((sum, pixel) => sum + pixel.y + 0.5, 0) / component.length
    };
    const coherentHue = circularMeanHue(component);
    candidates.push({
      candidate_id: componentId(bounds, component.length, anchor),
      pixel_bounds: outputBounds(bounds),
      center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
      anchor,
      chromatic_pixel_count: component.length,
      fill_fraction: fillFraction,
      coherent_hue_degrees: coherentHue,
      maximum_hue_deviation_degrees: maximumHueDeviation(component, policy.expected_hue_degrees),
      native_write_allowed: false
    });
  }
  candidates.sort((left, right) => left.anchor.y - right.anchor.y || left.anchor.x - right.anchor.x || right.chromatic_pixel_count - left.chromatic_pixel_count);
  return {
    schema: "operator.sheet_chromatic_component_detection.v1",
    source_image_sha256: sourceHash,
    source_image_width_px: width,
    source_image_height_px: height,
    search_region: outputBounds(search),
    policy,
    qualifying_pixel_count: qualifyingPixelCount,
    rejected_component_counts: rejected,
    candidates: candidates.slice(0, policy.maximum_candidates),
    capability_boundary: "Chromatic components are source-only point candidates. Hue and connected shape do not establish discipline, family, type, host, circuit, system, topology, or write authority; every candidate remains native_write_allowed=false until registered cross-sheet and candidate-model evidence is compiled."
  };
}

export async function renderSheetChromaticComponentOverlayV1(args: {
  source_image_path: string;
  receipt: SheetChromaticComponentDetectionReceiptV1;
  output_path: string;
}): Promise<{ path: string; sha256: string }> {
  const sourceBuffer = fs.readFileSync(path.resolve(args.source_image_path));
  if (sha256Buffer(sourceBuffer) !== args.receipt.source_image_sha256) throw new Error("sheet_chromatic_component_overlay_source_hash_mismatch");
  const image = await loadImage(sourceBuffer);
  if (image.width !== args.receipt.source_image_width_px || image.height !== args.receipt.source_image_height_px) {
    throw new Error("sheet_chromatic_component_overlay_source_dimensions_mismatch");
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  context.strokeStyle = "#ff00ff";
  context.fillStyle = "#ff00ff";
  context.lineWidth = 2;
  context.font = "12px sans-serif";
  for (const [index, candidate] of args.receipt.candidates.entries()) {
    const bounds = candidate.pixel_bounds;
    context.strokeRect(bounds.min.x - 1, bounds.min.y - 1, bounds.max.x - bounds.min.x + 2, bounds.max.y - bounds.min.y + 2);
    context.beginPath();
    context.arc(candidate.anchor.x, candidate.anchor.y, 3, 0, Math.PI * 2);
    context.fill();
    context.fillText(String(index + 1), bounds.min.x, Math.max(12, bounds.min.y - 4));
  }
  const outputPath = path.resolve(args.output_path);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const output = canvas.toBuffer("image/png");
  fs.writeFileSync(outputPath, output);
  return { path: outputPath, sha256: sha256Buffer(output) };
}
