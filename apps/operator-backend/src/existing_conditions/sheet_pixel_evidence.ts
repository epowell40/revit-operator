import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { SheetPixelInterpretationInputV1, SheetPixelPrimitiveV1 } from "./sheet_pixel_interpretation.js";

export type SheetPixelEvidencePolicyV1 = {
  maximum_luminance: number;
  corridor_radius_px: number;
  sample_spacing_px: number;
  accepted_support_fraction: number;
  provisional_support_fraction: number;
  maximum_accepted_unsupported_run_fraction: number;
};

export type SheetPixelRouteEvidenceV1 = {
  primitive_id: string;
  sample_count: number;
  supported_sample_count: number;
  support_fraction: number;
  longest_unsupported_run_fraction: number;
  status: "accepted_raster_support" | "provisional_raster_support" | "rejected_raster_extent";
};

export type SheetPixelEvidenceReceiptV1 = {
  schema_version: 1;
  package_id: string;
  source_view_key: string;
  image: { path: string; sha256: string; width_px: number; height_px: number };
  policy: SheetPixelEvidencePolicyV1;
  route_evidence: SheetPixelRouteEvidenceV1[];
  accepted_primitive_ids: string[];
  provisional_primitive_ids: string[];
  rejected_primitive_ids: string[];
  overlay?: { path: string; sha256: string };
};

const DEFAULT_POLICY: SheetPixelEvidencePolicyV1 = {
  maximum_luminance: 180,
  corridor_radius_px: 7,
  sample_spacing_px: 2,
  accepted_support_fraction: 0.82,
  provisional_support_fraction: 0.55,
  maximum_accepted_unsupported_run_fraction: 0.18
};

type PixelBuffer = { width: number; height: number; data: Uint8ClampedArray };

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function unit(value: unknown, label: string): number {
  const result = finite(value, label);
  if (result < 0 || result > 1) throw new Error(`${label}_must_be_between_zero_and_one`);
  return result;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  const result = finite(value, label);
  if (result < minimum || result > maximum) throw new Error(`${label}_out_of_range`);
  return result;
}

function policy(input?: Partial<SheetPixelEvidencePolicyV1>): SheetPixelEvidencePolicyV1 {
  return {
    maximum_luminance: bounded(input?.maximum_luminance, DEFAULT_POLICY.maximum_luminance, 0, 255, "sheet_pixel_evidence_maximum_luminance"),
    corridor_radius_px: bounded(input?.corridor_radius_px, DEFAULT_POLICY.corridor_radius_px, 0, 50, "sheet_pixel_evidence_corridor_radius_px"),
    sample_spacing_px: bounded(input?.sample_spacing_px, DEFAULT_POLICY.sample_spacing_px, 0.25, 50, "sheet_pixel_evidence_sample_spacing_px"),
    accepted_support_fraction: unit(input?.accepted_support_fraction ?? DEFAULT_POLICY.accepted_support_fraction, "sheet_pixel_evidence_accepted_support_fraction"),
    provisional_support_fraction: unit(input?.provisional_support_fraction ?? DEFAULT_POLICY.provisional_support_fraction, "sheet_pixel_evidence_provisional_support_fraction"),
    maximum_accepted_unsupported_run_fraction: unit(input?.maximum_accepted_unsupported_run_fraction ?? DEFAULT_POLICY.maximum_accepted_unsupported_run_fraction, "sheet_pixel_evidence_maximum_accepted_unsupported_run_fraction")
  };
}

function darkNear(buffer: PixelBuffer, x: number, y: number, maximumLuminance: number, radius: number): boolean {
  const cx = Math.round(x);
  const cy = Math.round(y);
  const r = Math.ceil(radius);
  const radiusSquared = radius * radius;
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if ((dx * dx) + (dy * dy) > radiusSquared) continue;
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= buffer.width || py >= buffer.height) continue;
      const offset = ((py * buffer.width) + px) * 4;
      const alpha = buffer.data[offset + 3] ?? 0;
      if (alpha < 128) continue;
      const red = buffer.data[offset] ?? 255;
      const green = buffer.data[offset + 1] ?? 255;
      const blue = buffer.data[offset + 2] ?? 255;
      const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
      if (luminance <= maximumLuminance) return true;
    }
  }
  return false;
}

function routeSamples(primitive: SheetPixelPrimitiveV1, width: number, height: number, spacing: number): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = [];
  for (let index = 1; index < primitive.points.length; index += 1) {
    const start = primitive.points[index - 1]!;
    const end = primitive.points[index]!;
    const startX = unit(start.u, `sheet_pixel_evidence_${primitive.primitive_id}_${index - 1}_u`) * width;
    const startY = unit(start.v, `sheet_pixel_evidence_${primitive.primitive_id}_${index - 1}_v`) * height;
    const endX = unit(end.u, `sheet_pixel_evidence_${primitive.primitive_id}_${index}_u`) * width;
    const endY = unit(end.v, `sheet_pixel_evidence_${primitive.primitive_id}_${index}_v`) * height;
    const length = Math.hypot(endX - startX, endY - startY);
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let step = index === 1 ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps;
      result.push({ x: startX + ((endX - startX) * t), y: startY + ((endY - startY) * t) });
    }
  }
  return result;
}

export function scoreSheetPixelRouteEvidenceV1(args: {
  pixels: PixelBuffer;
  interpretation: SheetPixelInterpretationInputV1;
  policy?: Partial<SheetPixelEvidencePolicyV1>;
}): { policy: SheetPixelEvidencePolicyV1; route_evidence: SheetPixelRouteEvidenceV1[] } {
  if (args.interpretation.schema_version !== 1) throw new Error("sheet_pixel_evidence_requires_schema_v1");
  const resolvedPolicy = policy(args.policy);
  if (resolvedPolicy.provisional_support_fraction > resolvedPolicy.accepted_support_fraction) throw new Error("sheet_pixel_evidence_provisional_threshold_exceeds_accepted");
  const routeEvidence = args.interpretation.primitives
    .filter(primitive => primitive.kind === "route_segment")
    .map(primitive => {
      const samples = routeSamples(primitive, args.pixels.width, args.pixels.height, resolvedPolicy.sample_spacing_px);
      if (samples.length === 0) throw new Error(`sheet_pixel_evidence_route_has_no_samples:${primitive.primitive_id}`);
      const supported = samples.map(sample => darkNear(args.pixels, sample.x, sample.y, resolvedPolicy.maximum_luminance, resolvedPolicy.corridor_radius_px));
      const supportedCount = supported.filter(Boolean).length;
      let longestUnsupported = 0;
      let currentUnsupported = 0;
      for (const value of supported) {
        currentUnsupported = value ? 0 : currentUnsupported + 1;
        longestUnsupported = Math.max(longestUnsupported, currentUnsupported);
      }
      const supportFraction = supportedCount / supported.length;
      const longestUnsupportedFraction = longestUnsupported / supported.length;
      const status = supportFraction >= resolvedPolicy.accepted_support_fraction && longestUnsupportedFraction <= resolvedPolicy.maximum_accepted_unsupported_run_fraction
        ? "accepted_raster_support"
        : supportFraction >= resolvedPolicy.provisional_support_fraction
          ? "provisional_raster_support"
          : "rejected_raster_extent";
      return {
        primitive_id: primitive.primitive_id,
        sample_count: samples.length,
        supported_sample_count: supportedCount,
        support_fraction: supportFraction,
        longest_unsupported_run_fraction: longestUnsupportedFraction,
        status
      } satisfies SheetPixelRouteEvidenceV1;
    });
  return { policy: resolvedPolicy, route_evidence: routeEvidence };
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function validateSheetPixelEvidenceV1(args: {
  image_path: string;
  interpretation: SheetPixelInterpretationInputV1;
  source_view_key?: string;
  policy?: Partial<SheetPixelEvidencePolicyV1>;
  overlay_path?: string;
}): Promise<SheetPixelEvidenceReceiptV1> {
  const sourceViewKey = String(args.source_view_key ?? (args.interpretation.view_keys.length === 1 ? args.interpretation.view_keys[0] : "")).trim();
  if (!sourceViewKey || !args.interpretation.view_keys.includes(sourceViewKey)) throw new Error("sheet_pixel_evidence_source_view_key_required");
  if (args.interpretation.primitives.some(primitive => primitive.source_view_key !== sourceViewKey)) throw new Error("sheet_pixel_evidence_requires_one_source_view");
  const imagePath = path.resolve(args.image_path);
  if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) throw new Error("sheet_pixel_evidence_image_not_found");
  const imageBytes = fs.readFileSync(imagePath);
  const image = await loadImage(imageBytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height);
  const scored = scoreSheetPixelRouteEvidenceV1({ pixels: { width: image.width, height: image.height, data: pixels.data }, interpretation: args.interpretation, policy: args.policy });
  const evidenceById = new Map(scored.route_evidence.map(item => [item.primitive_id, item]));
  let overlay: SheetPixelEvidenceReceiptV1["overlay"];
  if (args.overlay_path) {
    context.lineWidth = 4;
    context.font = "12px sans-serif";
    for (const primitive of args.interpretation.primitives.filter(item => item.kind === "route_segment")) {
      const evidence = evidenceById.get(primitive.primitive_id)!;
      context.strokeStyle = evidence.status === "accepted_raster_support" ? "#00a651" : evidence.status === "provisional_raster_support" ? "#ff9800" : "#e51c23";
      context.fillStyle = context.strokeStyle;
      context.beginPath();
      primitive.points.forEach((point, index) => {
        const x = point.u * image.width;
        const y = point.v * image.height;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
      const first = primitive.points[0]!;
      context.fillText(primitive.primitive_id, (first.u * image.width) + 4, (first.v * image.height) - 4);
    }
    const overlayPath = path.resolve(args.overlay_path);
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    const overlayBytes = canvas.toBuffer("image/png");
    fs.writeFileSync(overlayPath, overlayBytes);
    overlay = { path: overlayPath, sha256: sha256(overlayBytes) };
  }
  const accepted = scored.route_evidence.filter(item => item.status === "accepted_raster_support").map(item => item.primitive_id);
  const provisional = scored.route_evidence.filter(item => item.status === "provisional_raster_support").map(item => item.primitive_id);
  const rejected = scored.route_evidence.filter(item => item.status === "rejected_raster_extent").map(item => item.primitive_id);
  return {
    schema_version: 1,
    package_id: args.interpretation.package_id,
    source_view_key: sourceViewKey,
    image: { path: imagePath, sha256: sha256(imageBytes), width_px: image.width, height_px: image.height },
    policy: scored.policy,
    route_evidence: scored.route_evidence,
    accepted_primitive_ids: accepted,
    provisional_primitive_ids: provisional,
    rejected_primitive_ids: rejected,
    ...(overlay ? { overlay } : {})
  };
}
