import crypto from "node:crypto";
import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";

export type SheetVectorTextExtractionInputV1 = {
  schema_version: 1;
  source_pdf_path: string;
  source_pdf_sha256: string;
  registered_render_path: string;
  registered_render_sha256: string;
  render_width_px: number;
  render_height_px: number;
  page?: number;
  include_exact_text?: string[];
  maximum_entries?: number;
};

export type SheetVectorTextEntryV1 = {
  entry_id: string;
  text: string;
  normalized_text: string;
  page: number;
  pixel_point: { x: number; y: number };
  pixel_bounds: { min: { x: number; y: number }; max: { x: number; y: number } };
  rotation_degrees: number;
  evidence_basis: "vector_pdf_text";
};

export type SheetVectorTextExtractionReceiptV1 = {
  schema: "operator.sheet_vector_text.v1";
  source_pdf_sha256: string;
  registered_render_sha256: string;
  page: number;
  render_width_px: number;
  render_height_px: number;
  source_render_verification: {
    passed: true;
    mean_absolute_luminance_difference: number;
    maximum_tile_mean_absolute_luminance_difference: number;
    changed_pixel_ratio: number;
    foreground_centroid_delta_px: number;
    foreground_support_radius_px: number;
    foreground_sample_spacing_px: number;
    foreground_luminance_threshold: number;
    pdf_to_registered_foreground_support_fraction: number;
    registered_to_pdf_foreground_support_fraction: number;
  };
  include_exact_text: string[];
  entries: SheetVectorTextEntryV1[];
  native_write_allowed: false;
  capability_boundary: string;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value).normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function requiredSha(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label}_must_be_integer_${minimum}_through_${maximum}`);
  }
  return result;
}

function stableEntryId(text: string, page: number, bounds: SheetVectorTextEntryV1["pixel_bounds"]): string {
  return crypto.createHash("sha256").update(JSON.stringify({ text, page, bounds })).digest("hex").slice(0, 20);
}

function luminance(data: Uint8ClampedArray, index: number): number {
  return 0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!;
}

function foregroundSupport(args: {
  source: Uint8ClampedArray;
  target: Uint8ClampedArray;
  width: number;
  height: number;
  threshold: number;
  radius: number;
  spacing: number;
}): number {
  let sampled = 0;
  let supported = 0;
  for (let y = 0; y < args.height; y += args.spacing) {
    for (let x = 0; x < args.width; x += args.spacing) {
      const index = (y * args.width + x) * 4;
      if (luminance(args.source, index) > args.threshold) continue;
      sampled += 1;
      let hit = false;
      for (let candidateY = Math.max(0, y - args.radius); candidateY <= Math.min(args.height - 1, y + args.radius) && !hit; candidateY += 1) {
        for (let candidateX = Math.max(0, x - args.radius); candidateX <= Math.min(args.width - 1, x + args.radius); candidateX += 1) {
          if (luminance(args.target, (candidateY * args.width + candidateX) * 4) <= args.threshold) {
            hit = true;
            break;
          }
        }
      }
      if (hit) supported += 1;
    }
  }
  return supported / Math.max(1, sampled);
}

export async function extractSheetVectorTextV1(
  input: SheetVectorTextExtractionInputV1
): Promise<SheetVectorTextExtractionReceiptV1> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) {
    throw new Error("sheet_vector_text_requires_schema_v1");
  }
  const pdfPath = clean(input.source_pdf_path);
  const renderPath = clean(input.registered_render_path);
  if (!pdfPath || !fs.existsSync(pdfPath) || !fs.statSync(pdfPath).isFile()) throw new Error("sheet_vector_text_source_pdf_not_found");
  if (!renderPath || !fs.existsSync(renderPath) || !fs.statSync(renderPath).isFile()) throw new Error("sheet_vector_text_registered_render_not_found");
  const pdfBytes = fs.readFileSync(pdfPath);
  const renderBytes = fs.readFileSync(renderPath);
  const pdfHash = requiredSha(input.source_pdf_sha256, "sheet_vector_text_source_pdf_sha256");
  const renderHash = requiredSha(input.registered_render_sha256, "sheet_vector_text_registered_render_sha256");
  if (sha256(pdfBytes) !== pdfHash) throw new Error("sheet_vector_text_source_pdf_hash_mismatch");
  if (sha256(renderBytes) !== renderHash) throw new Error("sheet_vector_text_registered_render_hash_mismatch");
  const width = integer(input.render_width_px, "sheet_vector_text_render_width_px", 1, 20_000);
  const height = integer(input.render_height_px, "sheet_vector_text_render_height_px", 1, 20_000);
  if (width * height > 50_000_000) throw new Error("sheet_vector_text_render_exceeds_50000000_pixels");
  const pageNumber = integer(input.page ?? 1, "sheet_vector_text_page", 1, 10_000);
  const maximumEntries = integer(input.maximum_entries ?? 5_000, "sheet_vector_text_maximum_entries", 1, 20_000);
  const includeExact = [...new Set((input.include_exact_text ?? []).map(clean).filter(Boolean))];
  if (includeExact.length > 500) throw new Error("sheet_vector_text_include_exact_text_exceeds_500");
  const includeNormalized = new Set(includeExact.map(normalized));

  const pdfjs: any = await loadPdfJsForNode();
  let document: any = null;
  try {
    document = await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(pdfBytes))).promise;
    if (pageNumber > Number(document?.numPages ?? 0)) throw new Error("sheet_vector_text_page_out_of_range");
    const page = await document.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = width / Number(baseViewport.width);
    const viewport = page.getViewport({ scale });
    const pageAspect = Number(viewport.width) / Number(viewport.height);
    const renderAspect = width / height;
    if (!Number.isFinite(scale) || scale <= 0 || Math.abs(pageAspect - renderAspect) / Math.max(pageAspect, renderAspect) > 0.02) {
      throw new Error("sheet_vector_text_render_aspect_mismatch");
    }

    const pdfCanvas = createCanvas(width, height);
    const pdfContext = pdfCanvas.getContext("2d");
    pdfContext.fillStyle = "#fff";
    pdfContext.fillRect(0, 0, width, height);
    await page.render({ canvasContext: pdfContext as any, viewport }).promise;

    const registeredImage = await loadImage(renderBytes);
    if (registeredImage.width !== width || registeredImage.height !== height) throw new Error("sheet_vector_text_registered_render_dimensions_mismatch");
    const registeredCanvas = createCanvas(width, height);
    const registeredContext = registeredCanvas.getContext("2d");
    registeredContext.fillStyle = "#fff";
    registeredContext.fillRect(0, 0, width, height);
    registeredContext.drawImage(registeredImage, 0, 0);

    const pdfPixels = pdfContext.getImageData(0, 0, width, height).data;
    const registeredPixels = registeredContext.getImageData(0, 0, width, height).data;
    let totalDifference = 0;
    let changed = 0;
    let pdfDarkness = 0;
    let registeredDarkness = 0;
    let pdfDarknessX = 0;
    let pdfDarknessY = 0;
    let registeredDarknessX = 0;
    let registeredDarknessY = 0;
    const tileGrid = 8;
    const tileDifference = new Array<number>(tileGrid * tileGrid).fill(0);
    const tileCount = new Array<number>(tileGrid * tileGrid).fill(0);
    for (let index = 0; index < pdfPixels.length; index += 4) {
      const pdfLum = luminance(pdfPixels, index);
      const registeredLum = luminance(registeredPixels, index);
      const difference = Math.abs(pdfLum - registeredLum) / 255;
      totalDifference += difference;
      if (difference > 0.1) changed += 1;
      const pixel = index / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const firstDarkness = 1 - pdfLum / 255;
      const secondDarkness = 1 - registeredLum / 255;
      pdfDarkness += firstDarkness;
      registeredDarkness += secondDarkness;
      pdfDarknessX += x * firstDarkness;
      pdfDarknessY += y * firstDarkness;
      registeredDarknessX += x * secondDarkness;
      registeredDarknessY += y * secondDarkness;
      const tileX = Math.min(tileGrid - 1, Math.floor(x * tileGrid / width));
      const tileY = Math.min(tileGrid - 1, Math.floor(y * tileGrid / height));
      const tile = tileY * tileGrid + tileX;
      tileDifference[tile] += difference;
      tileCount[tile] += 1;
    }
    if (pdfDarkness < 1 || registeredDarkness < 1) throw new Error("sheet_vector_text_render_has_no_foreground");
    const pixelCount = width * height;
    const meanDifference = totalDifference / pixelCount;
    const maximumTileDifference = Math.max(...tileDifference.map((value, index) => value / Math.max(1, tileCount[index]!)));
    const changedRatio = changed / pixelCount;
    const centroidDelta = Math.hypot(
      registeredDarknessX / registeredDarkness - pdfDarknessX / pdfDarkness,
      registeredDarknessY / registeredDarkness - pdfDarknessY / pdfDarkness
    );
    const foregroundSupportRadius = 2;
    const foregroundSampleSpacing = 2;
    const foregroundLuminanceThreshold = 200;
    const pdfToRegisteredSupport = foregroundSupport({
      source: pdfPixels, target: registeredPixels, width, height,
      threshold: foregroundLuminanceThreshold, radius: foregroundSupportRadius, spacing: foregroundSampleSpacing
    });
    const registeredToPdfSupport = foregroundSupport({
      source: registeredPixels, target: pdfPixels, width, height,
      threshold: foregroundLuminanceThreshold, radius: foregroundSupportRadius, spacing: foregroundSampleSpacing
    });
    if (meanDifference > 0.025 || maximumTileDifference > 0.08 || changedRatio > 0.08 || pdfToRegisteredSupport < 0.98 || registeredToPdfSupport < 0.98) {
      throw new Error(`sheet_vector_text_source_render_mismatch:${meanDifference}:${maximumTileDifference}:${changedRatio}:${centroidDelta}:${pdfToRegisteredSupport}:${registeredToPdfSupport}`);
    }

    const textContent = await page.getTextContent();
    const entries: SheetVectorTextEntryV1[] = [];
    for (const item of Array.isArray(textContent?.items) ? textContent.items : []) {
      const text = clean(item?.str);
      if (!text || (includeNormalized.size > 0 && !includeNormalized.has(normalized(text)))) continue;
      const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
      const textWidth = Math.max(0, Number(item.width) * scale);
      const xLength = Math.hypot(Number(matrix[0]), Number(matrix[1]));
      const xUnit = xLength > 0 ? { x: Number(matrix[0]) / xLength, y: Number(matrix[1]) / xLength } : { x: 1, y: 0 };
      const yVector = { x: Number(matrix[2]), y: Number(matrix[3]) };
      const heightLength = Math.max(Number(item.height) * scale, Math.hypot(yVector.x, yVector.y));
      const yLength = Math.hypot(yVector.x, yVector.y);
      const yUnit = yLength > 0 ? { x: yVector.x / yLength, y: yVector.y / yLength } : { x: 0, y: -1 };
      const origin = { x: Number(matrix[4]), y: Number(matrix[5]) };
      const along = { x: xUnit.x * textWidth, y: xUnit.y * textWidth };
      const up = { x: yUnit.x * heightLength, y: yUnit.y * heightLength };
      const corners = [
        origin,
        { x: origin.x + along.x, y: origin.y + along.y },
        { x: origin.x + up.x, y: origin.y + up.y },
        { x: origin.x + along.x + up.x, y: origin.y + along.y + up.y }
      ];
      const bounds = {
        min: { x: Math.min(...corners.map(point => point.x)), y: Math.min(...corners.map(point => point.y)) },
        max: { x: Math.max(...corners.map(point => point.x)), y: Math.max(...corners.map(point => point.y)) }
      };
      const point = { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || bounds.max.x < 0 || bounds.max.y < 0 || bounds.min.x > width || bounds.min.y > height) continue;
      entries.push({
        entry_id: stableEntryId(text, pageNumber, bounds),
        text,
        normalized_text: normalized(text),
        page: pageNumber,
        pixel_point: point,
        pixel_bounds: bounds,
        rotation_degrees: Math.atan2(xUnit.y, xUnit.x) * 180 / Math.PI,
        evidence_basis: "vector_pdf_text"
      });
      if (entries.length > maximumEntries) throw new Error("sheet_vector_text_maximum_entries_exceeded");
    }

    return {
      schema: "operator.sheet_vector_text.v1",
      source_pdf_sha256: pdfHash,
      registered_render_sha256: renderHash,
      page: pageNumber,
      render_width_px: width,
      render_height_px: height,
      source_render_verification: {
        passed: true,
        mean_absolute_luminance_difference: meanDifference,
        maximum_tile_mean_absolute_luminance_difference: maximumTileDifference,
        changed_pixel_ratio: changedRatio,
        foreground_centroid_delta_px: centroidDelta,
        foreground_support_radius_px: foregroundSupportRadius,
        foreground_sample_spacing_px: foregroundSampleSpacing,
        foreground_luminance_threshold: foregroundLuminanceThreshold,
        pdf_to_registered_foreground_support_fraction: pdfToRegisteredSupport,
        registered_to_pdf_foreground_support_fraction: registeredToPdfSupport
      },
      include_exact_text: includeExact,
      entries,
      native_write_allowed: false,
      capability_boundary: "Vector PDF text is source evidence only. It can constrain symbol association and annotation claims but cannot establish native family, host, circuit, elevation, connectivity, or write authority."
    };
  } finally {
    try { await document?.destroy?.(); } catch { /* best effort */ }
  }
}
