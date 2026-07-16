import crypto from "node:crypto";
import fs from "node:fs";
import { loadImage, createCanvas } from "@napi-rs/canvas";
import type { MepCoverageBounds, MepCoverageModelRole, MepCoveragePoint } from "./mep_region_coverage.js";

export type MepSymbolVariant = "identity" | "flip_x" | "flip_y" | "rotate_180";

export type MepRepeatedSymbolTemplateV1 = {
  template_id: string;
  role_hint: MepCoverageModelRole | "unknown";
  /** Tight bounds around the model symbol represented by each detection. */
  pixel_bounds: MepCoverageBounds;
  /** Optional larger source-only matching window; may include non-model context used only for disambiguation. */
  context_bounds?: MepCoverageBounds;
  /** Model insertion/symbol center in source-image pixels; defaults to the template-bounds center. */
  anchor_point?: MepCoveragePoint;
  variants?: MepSymbolVariant[];
  minimum_score?: number;
  minimum_foreground_recall?: number;
  minimum_center_separation_px?: number;
};

export type MepRepeatedSymbolDetectionInputV1 = {
  schema_version: 1;
  source_image_path: string;
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  search_region: MepCoverageBounds;
  ink_grayscale_threshold?: number;
  scan_step_px?: number;
  maximum_candidates?: number;
  minimum_global_anchor_separation_px?: number;
  templates: MepRepeatedSymbolTemplateV1[];
};

export type MepRepeatedSymbolCandidateV1 = {
  candidate_id: string;
  template_id: string;
  role_hint: MepCoverageModelRole | "unknown";
  variant: MepSymbolVariant;
  score: number;
  foreground_recall: number;
  context_foreground_recall: number;
  background_specificity: number;
  pixel_bounds: MepCoverageBounds;
  center: MepCoveragePoint;
  anchor: MepCoveragePoint;
  native_write_allowed: false;
};

export type MepRepeatedSymbolDetectionReceiptV1 = {
  schema: "operator.mep_repeated_symbol_detection.v1";
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  search_region: MepCoverageBounds;
  ink_grayscale_threshold: number;
  scan_step_px: number;
  maximum_candidates: number;
  minimum_global_anchor_separation_px: number;
  templates: Array<{
    template_id: string;
    role_hint: MepCoverageModelRole | "unknown";
    pixel_bounds: MepCoverageBounds;
    context_bounds: MepCoverageBounds;
    anchor_point: MepCoveragePoint;
    anchor_basis: "explicit_template_anchor" | "template_bounds_center";
    variants: MepSymbolVariant[];
    ink_pixel_count: number;
    sampled_core_ink_pixel_count: number;
    sampled_context_ink_pixel_count: number;
    sampled_background_pixel_count: number;
    ink_fraction: number;
    context_ink_fraction: number;
    warnings: string[];
  }>;
  candidates: MepRepeatedSymbolCandidateV1[];
  capability_boundary: string;
};

type PixelBounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
type MaskPoint = { x: number; y: number };
type TemplateMask = {
  ink: MaskPoint[];
  background: MaskPoint[];
  width: number;
  height: number;
};

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

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label}_must_be_integer_${minimum}_through_${maximum}`);
  }
  return Number(value);
}

function unitInterval(value: unknown, label: string, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result <= 0 || result > 1) throw new Error(`${label}_must_be_above_zero_through_one`);
  return result;
}

function pixelBounds(value: MepCoverageBounds, label: string, width: number, height: number): PixelBounds {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const minX = integer(value.min?.x, `${label}_min_x`, 0, width - 1);
  const minY = integer(value.min?.y, `${label}_min_y`, 0, height - 1);
  const maxX = integer(value.max?.x, `${label}_max_x`, 1, width);
  const maxY = integer(value.max?.y, `${label}_max_y`, 1, height);
  if (maxX <= minX || maxY <= minY) throw new Error(`${label}_must_have_positive_extent`);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function outputBounds(bounds: PixelBounds): MepCoverageBounds {
  return { min: { x: bounds.minX, y: bounds.minY }, max: { x: bounds.maxX, y: bounds.maxY } };
}

function containsBounds(outer: PixelBounds, inner: PixelBounds): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX
    && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

function transformedSymbolBounds(symbol: PixelBounds, context: PixelBounds, x: number, y: number, variant: MepSymbolVariant): PixelBounds {
  const minX = symbol.minX - context.minX;
  const minY = symbol.minY - context.minY;
  const maxX = symbol.maxX - context.minX;
  const maxY = symbol.maxY - context.minY;
  let transformedMinX = minX;
  let transformedMinY = minY;
  let transformedMaxX = maxX;
  let transformedMaxY = maxY;
  if (variant === "flip_x" || variant === "rotate_180") {
    transformedMinX = context.width - maxX;
    transformedMaxX = context.width - minX;
  }
  if (variant === "flip_y" || variant === "rotate_180") {
    transformedMinY = context.height - maxY;
    transformedMaxY = context.height - minY;
  }
  return {
    minX: x + transformedMinX,
    minY: y + transformedMinY,
    maxX: x + transformedMaxX,
    maxY: y + transformedMaxY,
    width: symbol.width,
    height: symbol.height
  };
}

function isInk(data: Uint8ClampedArray, width: number, x: number, y: number, threshold: number): boolean {
  const offset = (y * width + x) * 4;
  const alpha = data[offset + 3] ?? 0;
  if (alpha < 128) return false;
  const red = data[offset] ?? 255;
  const green = data[offset + 1] ?? 255;
  const blue = data[offset + 2] ?? 255;
  return 0.299 * red + 0.587 * green + 0.114 * blue <= threshold;
}

function transformed(point: MaskPoint, width: number, height: number, variant: MepSymbolVariant): MaskPoint {
  if (variant === "flip_x") return { x: width - 1 - point.x, y: point.y };
  if (variant === "flip_y") return { x: point.x, y: height - 1 - point.y };
  if (variant === "rotate_180") return { x: width - 1 - point.x, y: height - 1 - point.y };
  return point;
}

function transformedAnchor(point: MepCoveragePoint, width: number, height: number, variant: MepSymbolVariant): MepCoveragePoint {
  if (variant === "flip_x") return { x: width - point.x, y: point.y };
  if (variant === "flip_y") return { x: point.x, y: height - point.y };
  if (variant === "rotate_180") return { x: width - point.x, y: height - point.y };
  return point;
}

function variantMask(mask: TemplateMask, variant: MepSymbolVariant): TemplateMask {
  return {
    width: mask.width,
    height: mask.height,
    ink: mask.ink.map((point) => transformed(point, mask.width, mask.height, variant)),
    background: mask.background.map((point) => transformed(point, mask.width, mask.height, variant))
  };
}

function deterministicBackgroundSample(points: MaskPoint[], maximum: number): MaskPoint[] {
  if (points.length <= maximum) return points;
  const step = points.length / maximum;
  return Array.from({ length: maximum }, (_, index) => points[Math.floor(index * step)]!);
}

function templateMask(
  data: Uint8ClampedArray,
  imageWidth: number,
  bounds: PixelBounds,
  threshold: number
): TemplateMask {
  const ink: MaskPoint[] = [];
  const background: MaskPoint[] = [];
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      (isInk(data, imageWidth, bounds.minX + x, bounds.minY + y, threshold) ? ink : background).push({ x, y });
    }
  }
  if (ink.length < 8) throw new Error("mep_symbol_template_has_too_few_ink_pixels");
  if (background.length < 8) throw new Error("mep_symbol_template_has_too_few_background_pixels");
  return {
    ink,
    background: deterministicBackgroundSample(background, Math.max(64, Math.min(ink.length, 512))),
    width: bounds.width,
    height: bounds.height
  };
}

function candidateId(templateId: string, variant: string, bounds: PixelBounds): string {
  return crypto.createHash("sha256")
    .update(`${templateId}|${variant}|${bounds.minX}|${bounds.minY}|${bounds.maxX}|${bounds.maxY}`)
    .digest("hex")
    .slice(0, 20);
}

function center(bounds: PixelBounds): MepCoveragePoint {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function templateAnchor(template: MepRepeatedSymbolTemplateV1, bounds: PixelBounds, templateId: string): {
  absolute: MepCoveragePoint;
  local: MepCoveragePoint;
  basis: "explicit_template_anchor" | "template_bounds_center";
} {
  const basis = template.anchor_point ? "explicit_template_anchor" as const : "template_bounds_center" as const;
  const absolute = template.anchor_point ?? center(bounds);
  if (!Number.isFinite(absolute.x) || !Number.isFinite(absolute.y)
    || absolute.x < bounds.minX || absolute.x >= bounds.maxX
    || absolute.y < bounds.minY || absolute.y >= bounds.maxY) {
    throw new Error(`mep_repeated_symbol_template_anchor_outside_bounds:${templateId}`);
  }
  return { absolute, local: { x: absolute.x - bounds.minX, y: absolute.y - bounds.minY }, basis };
}

function distance(first: MepCoveragePoint, second: MepCoveragePoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function retainSpatiallySeparated(
  candidates: MepRepeatedSymbolCandidateV1[],
  separation: number,
  maximum: number,
  pointOf: (candidate: MepRepeatedSymbolCandidateV1) => MepCoveragePoint,
  groupOf: (candidate: MepRepeatedSymbolCandidateV1) => string = () => "*"
): MepRepeatedSymbolCandidateV1[] {
  const retained: MepRepeatedSymbolCandidateV1[] = [];
  const buckets = new Map<string, MepRepeatedSymbolCandidateV1[]>();
  for (const candidate of candidates) {
    const point = pointOf(candidate);
    const group = groupOf(candidate);
    const cellX = Math.floor(point.x / separation);
    const cellY = Math.floor(point.y / separation);
    let conflicts = false;
    for (let offsetY = -1; offsetY <= 1 && !conflicts; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1 && !conflicts; offsetX += 1) {
        const neighbors = buckets.get(`${group}|${cellX + offsetX}|${cellY + offsetY}`) ?? [];
        conflicts = neighbors.some((existing) => distance(pointOf(existing), point) < separation);
      }
    }
    if (conflicts) continue;
    retained.push(candidate);
    const key = `${group}|${cellX}|${cellY}`;
    buckets.set(key, [...(buckets.get(key) ?? []), candidate]);
    if (retained.length >= maximum) break;
  }
  return retained;
}

export async function detectRepeatedMepSymbols(
  input: MepRepeatedSymbolDetectionInputV1
): Promise<MepRepeatedSymbolDetectionReceiptV1> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) {
    throw new Error("mep_repeated_symbol_detection_requires_schema_v1");
  }
  const sourcePath = clean(input.source_image_path);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`mep_repeated_symbol_source_image_not_found:${sourcePath}`);
  }
  const sourceStats = fs.statSync(sourcePath);
  if (!sourceStats.isFile()) throw new Error(`mep_repeated_symbol_source_image_not_found:${sourcePath}`);
  const sourceHash = requiredSha256(input.source_image_sha256, "mep_repeated_symbol_source_image_sha256");
  const width = integer(input.source_image_width_px, "mep_repeated_symbol_source_image_width_px", 1, 20000);
  const height = integer(input.source_image_height_px, "mep_repeated_symbol_source_image_height_px", 1, 20000);
  if (width * height > 50_000_000) throw new Error("mep_repeated_symbol_source_image_exceeds_50000000_pixels");
  if (sourceStats.size > 256 * 1024 * 1024) throw new Error("mep_repeated_symbol_source_image_exceeds_256_megabytes");
  const sourceBuffer = fs.readFileSync(sourcePath);
  if (sha256Buffer(sourceBuffer) !== sourceHash) throw new Error("mep_repeated_symbol_source_image_hash_mismatch");
  const image = await loadImage(sourceBuffer);
  if (image.width !== width || image.height !== height) throw new Error("mep_repeated_symbol_source_image_dimensions_mismatch");
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  const search = pixelBounds(input.search_region, "mep_repeated_symbol_search_region", width, height);
  if (search.width * search.height > 1_000_000) throw new Error("mep_repeated_symbol_search_region_exceeds_one_million_pixels");
  const threshold = integer(input.ink_grayscale_threshold ?? 96, "mep_repeated_symbol_ink_grayscale_threshold", 1, 254);
  const scanStep = integer(input.scan_step_px ?? 1, "mep_repeated_symbol_scan_step_px", 1, 8);
  const maximumCandidates = integer(input.maximum_candidates ?? 500, "mep_repeated_symbol_maximum_candidates", 1, 5000);
  const minimumGlobalSeparation = integer(
    input.minimum_global_anchor_separation_px ?? 3,
    "mep_repeated_symbol_minimum_global_anchor_separation_px",
    1,
    1000
  );
  if (!Array.isArray(input.templates) || input.templates.length === 0 || input.templates.length > 24) {
    throw new Error("mep_repeated_symbol_templates_must_have_1_through_24_entries");
  }

  const ids = new Set<string>();
  const receiptTemplates: MepRepeatedSymbolDetectionReceiptV1["templates"] = [];
  const rawCandidates: MepRepeatedSymbolCandidateV1[] = [];
  const maximumRequestComparisons = 250_000_000;
  let remainingRequestComparisons = maximumRequestComparisons;
  for (const [index, template] of input.templates.entries()) {
    if (!template || typeof template !== "object" || Array.isArray(template)) {
      throw new Error(`mep_repeated_symbol_template_${index}_must_be_object`);
    }
    const templateId = clean(template.template_id);
    if (!templateId) throw new Error(`mep_repeated_symbol_template_${index}_id_required`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(templateId)) {
      throw new Error(`mep_repeated_symbol_template_${index}_id_must_be_safe_identifier`);
    }
    if (ids.has(templateId)) throw new Error(`mep_repeated_symbol_duplicate_template_id:${templateId}`);
    ids.add(templateId);
    if (!["duct_route", "conduit_route", "air_terminal", "mechanical_equipment", "pipe_route", "plumbing_fixture", "electrical_device", "light_fixture", "lighting_device", "electrical_equipment", "unknown"].includes(template.role_hint)) {
      throw new Error(`mep_repeated_symbol_template_role_hint_invalid:${templateId}`);
    }
    const templateBounds = pixelBounds(template.pixel_bounds, `mep_repeated_symbol_template_${templateId}_bounds`, width, height);
    const contextBounds = template.context_bounds
      ? pixelBounds(template.context_bounds, `mep_repeated_symbol_template_${templateId}_context_bounds`, width, height)
      : templateBounds;
    if (!containsBounds(contextBounds, templateBounds)) {
      throw new Error(`mep_repeated_symbol_template_context_must_contain_symbol:${templateId}`);
    }
    if (contextBounds.width > search.width || contextBounds.height > search.height) {
      throw new Error(`mep_repeated_symbol_template_larger_than_search_region:${templateId}`);
    }
    if (contextBounds.width * contextBounds.height > 250_000) {
      throw new Error(`mep_repeated_symbol_template_context_exceeds_250000_pixels:${templateId}`);
    }
    if (template.variants !== undefined && (!Array.isArray(template.variants) || template.variants.length === 0 || template.variants.length > 4)) {
      throw new Error(`mep_repeated_symbol_template_variants_must_have_1_through_4_entries:${templateId}`);
    }
    const variants = [...new Set(template.variants ?? ["identity"])] as MepSymbolVariant[];
    if (variants.some((variant) => !["identity", "flip_x", "flip_y", "rotate_180"].includes(variant))) {
      throw new Error(`mep_repeated_symbol_template_variant_invalid:${templateId}`);
    }
    const minimumScore = unitInterval(template.minimum_score, `mep_repeated_symbol_template_${templateId}_minimum_score`, 0.92);
    const minimumRecall = unitInterval(template.minimum_foreground_recall, `mep_repeated_symbol_template_${templateId}_minimum_foreground_recall`, 0.9);
    const minimumSeparation = integer(
      template.minimum_center_separation_px ?? Math.max(3, Math.floor(Math.min(templateBounds.width, templateBounds.height) / 2)),
      `mep_repeated_symbol_template_${templateId}_minimum_center_separation_px`,
      1,
      10000
    );
    const anchor = templateAnchor(template, templateBounds, templateId);
    const contextAnchor = { x: anchor.absolute.x - contextBounds.minX, y: anchor.absolute.y - contextBounds.minY };
    const baseMask = templateMask(data, width, contextBounds, threshold);
    const coreMask = templateMask(data, width, templateBounds, threshold);
    const coreOffset = { x: templateBounds.minX - contextBounds.minX, y: templateBounds.minY - contextBounds.minY };
    const coreInkSample = deterministicBackgroundSample(coreMask.ink, Math.max(64, Math.min(coreMask.ink.length, 512)));
    const contextInkSample = deterministicBackgroundSample(baseMask.ink, Math.max(64, Math.min(baseMask.ink.length, 512)));
    const inkFraction = coreMask.ink.length / (coreMask.width * coreMask.height);
    const contextInkFraction = baseMask.ink.length / (baseMask.width * baseMask.height);
    const warnings: string[] = [];
    if (inkFraction > 0.75) warnings.push("Template is unusually ink-dense; verify that the crop excludes attached text or leaders.");
    if (inkFraction < 0.02) warnings.push("Template is ink-sparse; verify that the crop contains the intended symbol geometry.");
    if (anchor.basis === "template_bounds_center") warnings.push("No explicit symbol anchor was supplied; candidate anchors use the template-bounds center.");
    receiptTemplates.push({
      template_id: templateId,
      role_hint: template.role_hint,
      pixel_bounds: outputBounds(templateBounds),
      context_bounds: outputBounds(contextBounds),
      anchor_point: anchor.absolute,
      anchor_basis: anchor.basis,
      variants,
      ink_pixel_count: coreMask.ink.length,
      sampled_core_ink_pixel_count: coreInkSample.length,
      sampled_context_ink_pixel_count: contextInkSample.length,
      sampled_background_pixel_count: baseMask.background.length,
      ink_fraction: inkFraction,
      context_ink_fraction: contextInkFraction,
      warnings
    });

    const matches: MepRepeatedSymbolCandidateV1[] = [];
    for (const variant of variants) {
      const mask = variantMask(baseMask, variant);
      const coreInk = coreInkSample.map((point) => transformed(
        { x: coreOffset.x + point.x, y: coreOffset.y + point.y },
        mask.width,
        mask.height,
        variant
      ));
      const contextInk = contextInkSample.map((point) => transformed(point, mask.width, mask.height, variant));
      const scanColumns = Math.floor((search.width - mask.width) / scanStep) + 1;
      const scanRows = Math.floor((search.height - mask.height) / scanStep) + 1;
      const estimatedComparisons = scanColumns * scanRows * (coreInk.length + contextInk.length + mask.background.length);
      if (!Number.isSafeInteger(estimatedComparisons) || estimatedComparisons > remainingRequestComparisons) {
        throw new Error(`mep_repeated_symbol_request_work_budget_exceeded:${templateId}:${variant}`);
      }
      remainingRequestComparisons -= estimatedComparisons;
      for (let y = search.minY; y <= search.maxY - mask.height; y += scanStep) {
        for (let x = search.minX; x <= search.maxX - mask.width; x += scanStep) {
          let foregroundMatches = 0;
          for (const point of coreInk) if (isInk(data, width, x + point.x, y + point.y, threshold)) foregroundMatches += 1;
          const foregroundRecall = foregroundMatches / coreInk.length;
          if (foregroundRecall < minimumRecall) continue;
          let contextForegroundMatches = 0;
          for (const point of contextInk) if (isInk(data, width, x + point.x, y + point.y, threshold)) contextForegroundMatches += 1;
          const contextForegroundRecall = contextForegroundMatches / contextInk.length;
          let backgroundMatches = 0;
          for (const point of mask.background) if (!isInk(data, width, x + point.x, y + point.y, threshold)) backgroundMatches += 1;
          const backgroundSpecificity = backgroundMatches / mask.background.length;
          const score = foregroundRecall * 0.7 + contextForegroundRecall * 0.1 + backgroundSpecificity * 0.2;
          if (score < minimumScore) continue;
          const bounds = transformedSymbolBounds(templateBounds, contextBounds, x, y, variant);
          const candidateAnchor = transformedAnchor(contextAnchor, mask.width, mask.height, variant);
          matches.push({
            candidate_id: candidateId(templateId, variant, bounds),
            template_id: templateId,
            role_hint: template.role_hint,
            variant,
            score,
            foreground_recall: foregroundRecall,
            context_foreground_recall: contextForegroundRecall,
            background_specificity: backgroundSpecificity,
            pixel_bounds: outputBounds(bounds),
            center: center(bounds),
            anchor: { x: x + candidateAnchor.x, y: y + candidateAnchor.y },
            native_write_allowed: false
          });
          if (matches.length > 200_000) {
            throw new Error(`mep_repeated_symbol_match_overflow_narrow_search_or_raise_threshold:${templateId}`);
          }
        }
      }
    }
    matches.sort((first, second) => second.score - first.score || first.center.y - second.center.y || first.center.x - second.center.x || first.variant.localeCompare(second.variant));
    const retained = retainSpatiallySeparated(matches, minimumSeparation, maximumCandidates, (candidate) => candidate.center);
    rawCandidates.push(...retained);
  }

  rawCandidates.sort((first, second) => second.score - first.score || first.anchor.y - second.anchor.y || first.anchor.x - second.anchor.x || first.template_id.localeCompare(second.template_id));
  const globallyRetained = retainSpatiallySeparated(
    rawCandidates,
    minimumGlobalSeparation,
    maximumCandidates,
    (candidate) => candidate.anchor,
    (candidate) => candidate.role_hint
  );
  globallyRetained.sort((first, second) => first.anchor.y - second.anchor.y || first.anchor.x - second.anchor.x || second.score - first.score || first.template_id.localeCompare(second.template_id));
  return {
    schema: "operator.mep_repeated_symbol_detection.v1",
    source_image_sha256: sourceHash,
    source_image_width_px: width,
    source_image_height_px: height,
    search_region: outputBounds(search),
    ink_grayscale_threshold: threshold,
    scan_step_px: scanStep,
    maximum_candidates: maximumCandidates,
    minimum_global_anchor_separation_px: minimumGlobalSeparation,
    templates: receiptTemplates,
    candidates: globallyRetained.slice(0, maximumCandidates),
    capability_boundary: "Template matches are source-only repeated-shape candidates. Role hints are not native family/type, circuit, host, or connectivity authority; every candidate remains native_write_allowed=false until representation-aware coverage and source-grounded compilation pass."
  };
}
