import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { MepCoverageBounds, MepCoveragePoint } from "./mep_region_coverage.js";
import type { SheetPixelInterpretationInputV1, SheetPixelPointV1 } from "./sheet_pixel_interpretation.js";

export type SheetRouteChromaticCoverageInputV1 = {
  schema_version: 1;
  source_image_path: string;
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  source_view_key: string;
  search_region?: MepCoverageBounds;
  expected_hue_degrees: number;
  hue_tolerance_degrees?: number;
  minimum_chroma?: number;
  maximum_luminance?: number;
  route_buffer_radius_px?: number;
  minimum_coverage_fraction?: number;
  uncovered_adjacency_radius_px?: number;
  minimum_uncovered_component_pixels?: number;
  maximum_reported_uncovered_components?: number;
  interpretation: SheetPixelInterpretationInputV1;
};

export type SheetRouteChromaticUncoveredComponentV1 = {
  component_id: string;
  pixel_bounds: MepCoverageBounds;
  center: MepCoveragePoint;
  chromatic_pixel_count: number;
  fraction_of_all_qualifying_pixels: number;
};

export type SheetRouteChromaticCoverageReceiptV1 = {
  schema: "operator.sheet_route_chromatic_coverage.v1";
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  source_view_key: string;
  interpretation_sha256: string;
  package_id: string;
  search_region: MepCoverageBounds;
  policy: {
    expected_hue_degrees: number;
    hue_tolerance_degrees: number;
    minimum_chroma: number;
    maximum_luminance: number;
    route_buffer_radius_px: number;
    minimum_coverage_fraction: number;
    uncovered_adjacency_radius_px: number;
    minimum_uncovered_component_pixels: number;
    maximum_reported_uncovered_components: number;
  };
  candidate_route_primitive_ids: string[];
  qualifying_chromatic_pixel_count: number;
  covered_chromatic_pixel_count: number;
  uncovered_chromatic_pixel_count: number;
  coverage_fraction: number;
  uncovered_component_count: number;
  uncovered_components: SheetRouteChromaticUncoveredComponentV1[];
  accepted: boolean;
  exact_next_repair: "none" | "reinterpret_uncovered_chromatic_regions_before_candidate_seal";
  native_write_allowed: false;
  capability_boundary: string;
};

type PixelBounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
type Pixel = { x: number; y: number };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
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

function pixelBounds(value: MepCoverageBounds | undefined, label: string, width: number, height: number): PixelBounds {
  if (value === undefined) return { minX: 0, minY: 0, maxX: width, maxY: height, width, height };
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

function normalizedPoint(point: SheetPixelPointV1, label: string): SheetPixelPointV1 {
  const u = Number(point?.u);
  const v = Number(point?.v);
  if (!Number.isFinite(u) || u < 0 || u > 1 || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`${label}_must_be_normalized_uv`);
  }
  return { u, v };
}

function componentId(bounds: PixelBounds, count: number): string {
  return crypto.createHash("sha256")
    .update(`${bounds.minX}|${bounds.minY}|${bounds.maxX}|${bounds.maxY}|${count}`)
    .digest("hex")
    .slice(0, 20);
}

function componentBounds(pixels: Pixel[]): PixelBounds {
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

function candidateRouteMask(args: {
  width: number;
  height: number;
  routeBufferRadiusPx: number;
  sourceViewKey: string;
  interpretation: SheetPixelInterpretationInputV1;
}): { mask: Uint8Array; routeIds: string[] } {
  if (args.interpretation.coordinate_space !== "normalized_uv_top_left") {
    throw new Error("sheet_route_chromatic_coverage_requires_normalized_uv_top_left");
  }
  if (!args.interpretation.view_keys.includes(args.sourceViewKey)) {
    throw new Error(`sheet_route_chromatic_coverage_view_not_selected:${args.sourceViewKey}`);
  }
  const canvas = createCanvas(args.width, args.height);
  const context = canvas.getContext("2d");
  context.strokeStyle = "#ffffff";
  context.fillStyle = "#ffffff";
  context.lineWidth = Math.max(1, args.routeBufferRadiusPx * 2);
  context.lineCap = "round";
  context.lineJoin = "round";
  const routes = args.interpretation.primitives.filter(primitive => primitive.kind === "route_segment" && primitive.source_view_key === args.sourceViewKey);
  for (const route of routes) {
    if (route.points.length < 2) throw new Error(`sheet_route_chromatic_coverage_route_requires_two_points:${route.primitive_id}`);
    const points = route.points.map((point, index) => normalizedPoint(point, `sheet_route_chromatic_coverage_route_${route.primitive_id}_point_${index}`));
    context.beginPath();
    context.moveTo(points[0]!.u * args.width, points[0]!.v * args.height);
    for (const point of points.slice(1)) context.lineTo(point.u * args.width, point.v * args.height);
    context.stroke();
  }
  const pixels = context.getImageData(0, 0, args.width, args.height).data;
  const mask = new Uint8Array(args.width * args.height);
  for (let index = 0; index < mask.length; index += 1) mask[index] = (pixels[(index * 4) + 3] ?? 0) > 0 ? 1 : 0;
  return { mask, routeIds: routes.map(route => route.primitive_id).sort() };
}

export async function validateSheetRouteChromaticCoverageV1(
  input: SheetRouteChromaticCoverageInputV1
): Promise<SheetRouteChromaticCoverageReceiptV1> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) {
    throw new Error("sheet_route_chromatic_coverage_requires_schema_v1");
  }
  const sourcePath = clean(input.source_image_path);
  if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`sheet_route_chromatic_coverage_source_image_not_found:${sourcePath}`);
  }
  const sourceHash = requiredSha256(input.source_image_sha256, "sheet_route_chromatic_coverage_source_image_sha256");
  const width = integer(input.source_image_width_px, Number.NaN, "sheet_route_chromatic_coverage_source_image_width_px", 1, 20000);
  const height = integer(input.source_image_height_px, Number.NaN, "sheet_route_chromatic_coverage_source_image_height_px", 1, 20000);
  if (width * height > 50_000_000) throw new Error("sheet_route_chromatic_coverage_source_image_exceeds_50000000_pixels");
  const sourceBuffer = fs.readFileSync(sourcePath);
  if (sourceBuffer.byteLength > 256 * 1024 * 1024) throw new Error("sheet_route_chromatic_coverage_source_image_exceeds_256_megabytes");
  if (sha256Buffer(sourceBuffer) !== sourceHash) throw new Error("sheet_route_chromatic_coverage_source_image_hash_mismatch");
  const image = await loadImage(sourceBuffer);
  if (image.width !== width || image.height !== height) throw new Error("sheet_route_chromatic_coverage_source_image_dimensions_mismatch");
  const sourceViewKey = clean(input.source_view_key);
  if (!sourceViewKey) throw new Error("sheet_route_chromatic_coverage_source_view_key_is_required");
  const search = pixelBounds(input.search_region, "sheet_route_chromatic_coverage_search_region", width, height);
  if (search.width * search.height > 2_000_000) throw new Error("sheet_route_chromatic_coverage_search_region_exceeds_two_million_pixels");
  const policy = {
    expected_hue_degrees: normalizeHue(input.expected_hue_degrees, "sheet_route_chromatic_coverage_expected_hue_degrees"),
    hue_tolerance_degrees: bounded(input.hue_tolerance_degrees, 30, "sheet_route_chromatic_coverage_hue_tolerance_degrees", 0, 180),
    minimum_chroma: bounded(input.minimum_chroma, 40, "sheet_route_chromatic_coverage_minimum_chroma", 1, 255),
    maximum_luminance: bounded(input.maximum_luminance, 245, "sheet_route_chromatic_coverage_maximum_luminance", 0, 255),
    route_buffer_radius_px: bounded(input.route_buffer_radius_px, 7, "sheet_route_chromatic_coverage_route_buffer_radius_px", 0.5, 100),
    minimum_coverage_fraction: bounded(input.minimum_coverage_fraction, 0.7, "sheet_route_chromatic_coverage_minimum_coverage_fraction", 0, 1),
    uncovered_adjacency_radius_px: integer(input.uncovered_adjacency_radius_px, 1, "sheet_route_chromatic_coverage_uncovered_adjacency_radius_px", 1, 4),
    minimum_uncovered_component_pixels: integer(input.minimum_uncovered_component_pixels, 8, "sheet_route_chromatic_coverage_minimum_uncovered_component_pixels", 1, 1_000_000),
    maximum_reported_uncovered_components: integer(input.maximum_reported_uncovered_components, 100, "sheet_route_chromatic_coverage_maximum_reported_uncovered_components", 1, 5000)
  };

  const sourceCanvas = createCanvas(width, height);
  const sourceContext = sourceCanvas.getContext("2d");
  sourceContext.drawImage(image, 0, 0);
  const data = sourceContext.getImageData(0, 0, width, height).data;
  const { mask: coveredMask, routeIds } = candidateRouteMask({
    width,
    height,
    routeBufferRadiusPx: policy.route_buffer_radius_px,
    sourceViewKey,
    interpretation: input.interpretation
  });
  const localWidth = search.width;
  const localHeight = search.height;
  const uncovered = new Uint8Array(localWidth * localHeight);
  let qualifyingCount = 0;
  let coveredCount = 0;
  for (let y = search.minY; y < search.maxY; y += 1) {
    for (let x = search.minX; x < search.maxX; x += 1) {
      const pixelOffset = ((y * width) + x) * 4;
      if ((data[pixelOffset + 3] ?? 0) < 128) continue;
      const color = rgbHue(data[pixelOffset] ?? 255, data[pixelOffset + 1] ?? 255, data[pixelOffset + 2] ?? 255);
      if (color.chroma < policy.minimum_chroma || color.luminance > policy.maximum_luminance) continue;
      if (circularHueDistance(color.hue, policy.expected_hue_degrees) > policy.hue_tolerance_degrees) continue;
      qualifyingCount += 1;
      if (coveredMask[(y * width) + x]) {
        coveredCount += 1;
      } else {
        uncovered[((y - search.minY) * localWidth) + (x - search.minX)] = 1;
      }
    }
  }

  const visited = new Uint8Array(uncovered.length);
  const neighborOffsets: Pixel[] = [];
  for (let dy = -policy.uncovered_adjacency_radius_px; dy <= policy.uncovered_adjacency_radius_px; dy += 1) {
    for (let dx = -policy.uncovered_adjacency_radius_px; dx <= policy.uncovered_adjacency_radius_px; dx += 1) {
      if (dx !== 0 || dy !== 0) neighborOffsets.push({ x: dx, y: dy });
    }
  }
  const components: SheetRouteChromaticUncoveredComponentV1[] = [];
  for (let localY = 0; localY < localHeight; localY += 1) {
    for (let localX = 0; localX < localWidth; localX += 1) {
      const start = (localY * localWidth) + localX;
      if (!uncovered[start] || visited[start]) continue;
      const queue = [start];
      const pixels: Pixel[] = [];
      visited[start] = 1;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor]!;
        const y = Math.floor(index / localWidth);
        const x = index - (y * localWidth);
        pixels.push({ x: search.minX + x, y: search.minY + y });
        for (const offset of neighborOffsets) {
          const nx = x + offset.x;
          const ny = y + offset.y;
          if (nx < 0 || ny < 0 || nx >= localWidth || ny >= localHeight) continue;
          const next = (ny * localWidth) + nx;
          if (!uncovered[next] || visited[next]) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
      if (pixels.length < policy.minimum_uncovered_component_pixels) continue;
      const bounds = componentBounds(pixels);
      components.push({
        component_id: componentId(bounds, pixels.length),
        pixel_bounds: outputBounds(bounds),
        center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
        chromatic_pixel_count: pixels.length,
        fraction_of_all_qualifying_pixels: qualifyingCount > 0 ? pixels.length / qualifyingCount : 0
      });
    }
  }
  components.sort((left, right) => right.chromatic_pixel_count - left.chromatic_pixel_count || left.center.y - right.center.y || left.center.x - right.center.x);
  const coverageFraction = qualifyingCount > 0 ? coveredCount / qualifyingCount : 0;
  const accepted = qualifyingCount > 0 && routeIds.length > 0 && coverageFraction >= policy.minimum_coverage_fraction;
  return {
    schema: "operator.sheet_route_chromatic_coverage.v1",
    source_image_sha256: sourceHash,
    source_image_width_px: width,
    source_image_height_px: height,
    source_view_key: sourceViewKey,
    interpretation_sha256: digest(input.interpretation),
    package_id: clean(input.interpretation.package_id),
    search_region: outputBounds(search),
    policy,
    candidate_route_primitive_ids: routeIds,
    qualifying_chromatic_pixel_count: qualifyingCount,
    covered_chromatic_pixel_count: coveredCount,
    uncovered_chromatic_pixel_count: Math.max(0, qualifyingCount - coveredCount),
    coverage_fraction: coverageFraction,
    uncovered_component_count: components.length,
    uncovered_components: components.slice(0, policy.maximum_reported_uncovered_components),
    accepted,
    exact_next_repair: accepted ? "none" : "reinterpret_uncovered_chromatic_regions_before_candidate_seal",
    native_write_allowed: false,
    capability_boundary: "This source-only reverse-coverage gate can veto an under-covered route interpretation and locate missed same-hue regions. Color and pixel coverage do not establish discipline, system, size, type, elevation, topology, connectivity, or native write authority; text and symbols sharing the hue may conservatively remain uncovered."
  };
}

export async function renderSheetRouteChromaticCoverageOverlayV1(args: {
  source_image_path: string;
  interpretation: SheetPixelInterpretationInputV1;
  receipt: SheetRouteChromaticCoverageReceiptV1;
  output_path: string;
}): Promise<{ path: string; sha256: string }> {
  const sourceBuffer = fs.readFileSync(path.resolve(args.source_image_path));
  if (sha256Buffer(sourceBuffer) !== args.receipt.source_image_sha256) throw new Error("sheet_route_chromatic_coverage_overlay_source_hash_mismatch");
  if (digest(args.interpretation) !== args.receipt.interpretation_sha256) throw new Error("sheet_route_chromatic_coverage_overlay_interpretation_hash_mismatch");
  const image = await loadImage(sourceBuffer);
  if (image.width !== args.receipt.source_image_width_px || image.height !== args.receipt.source_image_height_px) {
    throw new Error("sheet_route_chromatic_coverage_overlay_source_dimensions_mismatch");
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const routes = args.interpretation.primitives.filter(primitive => primitive.kind === "route_segment" && primitive.source_view_key === args.receipt.source_view_key);
  context.strokeStyle = "#00ff66";
  context.lineWidth = 3;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const route of routes) {
    if (route.points.length < 2) continue;
    context.beginPath();
    context.moveTo(route.points[0]!.u * image.width, route.points[0]!.v * image.height);
    for (const point of route.points.slice(1)) context.lineTo(point.u * image.width, point.v * image.height);
    context.stroke();
  }
  context.strokeStyle = "#ff00ff";
  context.fillStyle = "#ff00ff";
  context.lineWidth = 2;
  context.font = "12px sans-serif";
  for (const [index, component] of args.receipt.uncovered_components.entries()) {
    const bounds = component.pixel_bounds;
    context.strokeRect(bounds.min.x - 1, bounds.min.y - 1, bounds.max.x - bounds.min.x + 2, bounds.max.y - bounds.min.y + 2);
    context.fillText(`${index + 1}:${component.chromatic_pixel_count}`, bounds.min.x, Math.max(12, bounds.min.y - 4));
  }
  const outputPath = path.resolve(args.output_path);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const output = canvas.toBuffer("image/png");
  fs.writeFileSync(outputPath, output);
  return { path: outputPath, sha256: sha256Buffer(output) };
}
