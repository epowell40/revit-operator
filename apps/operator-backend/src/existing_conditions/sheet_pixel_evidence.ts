import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { CandidateVisibleFrameMapping } from "./candidate_visible_registration.js";
import type { SheetPixelInterpretationInputV1, SheetPixelPrimitiveV1 } from "./sheet_pixel_interpretation.js";

export type SheetPixelEvidencePolicyV1 = {
  route_support_mode?: "ink_corridor" | "outlined_network_centerline";
  maximum_luminance: number;
  corridor_radius_px: number;
  outlined_network_min_half_span_px?: number;
  outlined_network_max_half_span_px?: number;
  outlined_network_edge_radius_px?: number;
  outlined_network_topology_interruption_mode?: "ignore" | "defer";
  outlined_network_center_ink_radius_px?: number;
  outlined_network_topology_endpoint_exclusion_fraction?: number;
  outlined_network_topology_min_run_samples?: number;
  sample_spacing_px: number;
  accepted_support_fraction: number;
  provisional_support_fraction: number;
  maximum_accepted_unsupported_run_fraction: number;
  minimum_chromatic_chroma?: number;
  minimum_chromatic_activation_fraction?: number;
  point_support_mode?: "auto" | "chromatic" | "monochrome";
  point_radius_px?: number;
  point_minimum_supported_pixel_count?: number;
  point_provisional_supported_pixel_count?: number;
  point_minimum_dominant_hue_fraction?: number;
  point_expected_hue_degrees?: number;
  point_hue_tolerance_degrees?: number;
};

export type SheetPixelRouteEvidenceV1 = {
  primitive_id: string;
  sample_count: number;
  supported_sample_count: number;
  support_fraction: number;
  longest_unsupported_run_fraction: number;
  status: "accepted_raster_support" | "provisional_raster_support" | "rejected_raster_extent";
  support_modality?: "chromatic_line" | "monochrome_line" | "chromatic_outline_centerline" | "monochrome_outline_centerline";
  chromatic_support_fraction?: number;
  monochrome_support_fraction?: number;
  coherent_hue_degrees?: number;
  topology_interruption_sample_fractions?: number[];
  topology_interruption_run_count?: number;
  requires_topology_split?: boolean;
};

export type SheetPixelPointEvidenceV1 = {
  primitive_id: string;
  sampled_pixel_count: number;
  supported_pixel_count: number;
  chromatic_pixel_count: number;
  monochrome_pixel_count: number;
  dominant_hue_fraction?: number;
  status: "accepted_raster_support" | "provisional_raster_support" | "rejected_raster_extent";
  support_modality: "chromatic_symbol" | "monochrome_symbol";
  coherent_hue_degrees?: number;
};

export type SheetPixelEvidenceReceiptV1 = {
  schema_version: 1;
  package_id: string;
  source_view_key: string;
  image: { path: string; sha256: string; width_px: number; height_px: number };
  policy: SheetPixelEvidencePolicyV1;
  route_evidence: SheetPixelRouteEvidenceV1[];
  point_evidence?: SheetPixelPointEvidenceV1[];
  accepted_primitive_ids: string[];
  provisional_primitive_ids: string[];
  rejected_primitive_ids: string[];
  overlay?: { path: string; sha256: string };
};

export type SheetCandidatePointPresenceEvidenceV1 = {
  primitive_id: string;
  source_status: SheetPixelPointEvidenceV1["status"];
  candidate_status: SheetPixelPointEvidenceV1["status"] | "outside_candidate_frame";
  mapped_candidate_uv: { u: number; v: number };
  status: "existing_candidate_visible" | "ambiguous_candidate_presence" | "not_present" | "source_not_accepted";
  supported_pixel_count: number;
  coherent_hue_degrees?: number;
};

export type SheetCandidatePresenceReceiptV1 = {
  schema_version: 1;
  package_id: string;
  source_view_key: string;
  source_image_sha256: string;
  candidate_image: {
    path: string;
    sha256: string;
    width_px: number;
    height_px: number;
    frame_id: string;
    view_id: number;
  };
  policy: SheetPixelEvidencePolicyV1;
  point_evidence: SheetCandidatePointPresenceEvidenceV1[];
  existing_candidate_visible_primitive_ids: string[];
  ambiguous_candidate_presence_primitive_ids: string[];
  not_present_primitive_ids: string[];
  source_not_accepted_primitive_ids: string[];
  overlay?: { path: string; sha256: string };
};

const DEFAULT_POLICY: SheetPixelEvidencePolicyV1 = {
  route_support_mode: "ink_corridor",
  maximum_luminance: 180,
  corridor_radius_px: 7,
  outlined_network_min_half_span_px: 2,
  outlined_network_max_half_span_px: 15,
  outlined_network_edge_radius_px: 1,
  outlined_network_topology_interruption_mode: "ignore",
  outlined_network_center_ink_radius_px: 1,
  outlined_network_topology_endpoint_exclusion_fraction: 0.05,
  outlined_network_topology_min_run_samples: 1,
  sample_spacing_px: 2,
  accepted_support_fraction: 0.82,
  provisional_support_fraction: 0.55,
  maximum_accepted_unsupported_run_fraction: 0.18,
  minimum_chromatic_chroma: 40,
  minimum_chromatic_activation_fraction: 0.1,
  point_support_mode: "auto",
  point_radius_px: 20,
  point_minimum_supported_pixel_count: 8,
  point_provisional_supported_pixel_count: 4,
  point_minimum_dominant_hue_fraction: 0.6,
  point_hue_tolerance_degrees: 30
};

type PixelBuffer = { width: number; height: number; data: Uint8ClampedArray };
type ResolvedSheetPixelEvidencePolicyV1 = Required<Omit<SheetPixelEvidencePolicyV1, "point_expected_hue_degrees">> & {
  point_expected_hue_degrees?: number;
};

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

function policy(input?: Partial<SheetPixelEvidencePolicyV1>): ResolvedSheetPixelEvidencePolicyV1 {
  const routeSupportMode = input?.route_support_mode ?? DEFAULT_POLICY.route_support_mode!;
  if (routeSupportMode !== "ink_corridor" && routeSupportMode !== "outlined_network_centerline") {
    throw new Error("sheet_pixel_evidence_route_support_mode_invalid");
  }
  const pointSupportMode = input?.point_support_mode ?? DEFAULT_POLICY.point_support_mode!;
  if (pointSupportMode !== "auto" && pointSupportMode !== "chromatic" && pointSupportMode !== "monochrome") {
    throw new Error("sheet_pixel_evidence_point_support_mode_invalid");
  }
  const topologyInterruptionMode = input?.outlined_network_topology_interruption_mode ?? DEFAULT_POLICY.outlined_network_topology_interruption_mode!;
  if (topologyInterruptionMode !== "ignore" && topologyInterruptionMode !== "defer") {
    throw new Error("sheet_pixel_evidence_outlined_network_topology_interruption_mode_invalid");
  }
  const result = {
    route_support_mode: routeSupportMode,
    maximum_luminance: bounded(input?.maximum_luminance, DEFAULT_POLICY.maximum_luminance, 0, 255, "sheet_pixel_evidence_maximum_luminance"),
    corridor_radius_px: bounded(input?.corridor_radius_px, DEFAULT_POLICY.corridor_radius_px, 0, 50, "sheet_pixel_evidence_corridor_radius_px"),
    outlined_network_min_half_span_px: bounded(input?.outlined_network_min_half_span_px, DEFAULT_POLICY.outlined_network_min_half_span_px!, 1, 50, "sheet_pixel_evidence_outlined_network_min_half_span_px"),
    outlined_network_max_half_span_px: bounded(input?.outlined_network_max_half_span_px, DEFAULT_POLICY.outlined_network_max_half_span_px!, 1, 100, "sheet_pixel_evidence_outlined_network_max_half_span_px"),
    outlined_network_edge_radius_px: bounded(input?.outlined_network_edge_radius_px, DEFAULT_POLICY.outlined_network_edge_radius_px!, 0, 10, "sheet_pixel_evidence_outlined_network_edge_radius_px"),
    outlined_network_topology_interruption_mode: topologyInterruptionMode,
    outlined_network_center_ink_radius_px: bounded(input?.outlined_network_center_ink_radius_px, DEFAULT_POLICY.outlined_network_center_ink_radius_px!, 0, 10, "sheet_pixel_evidence_outlined_network_center_ink_radius_px"),
    outlined_network_topology_endpoint_exclusion_fraction: unit(input?.outlined_network_topology_endpoint_exclusion_fraction ?? DEFAULT_POLICY.outlined_network_topology_endpoint_exclusion_fraction!, "sheet_pixel_evidence_outlined_network_topology_endpoint_exclusion_fraction"),
    outlined_network_topology_min_run_samples: bounded(input?.outlined_network_topology_min_run_samples, DEFAULT_POLICY.outlined_network_topology_min_run_samples!, 1, 100, "sheet_pixel_evidence_outlined_network_topology_min_run_samples"),
    sample_spacing_px: bounded(input?.sample_spacing_px, DEFAULT_POLICY.sample_spacing_px, 0.25, 50, "sheet_pixel_evidence_sample_spacing_px"),
    accepted_support_fraction: unit(input?.accepted_support_fraction ?? DEFAULT_POLICY.accepted_support_fraction, "sheet_pixel_evidence_accepted_support_fraction"),
    provisional_support_fraction: unit(input?.provisional_support_fraction ?? DEFAULT_POLICY.provisional_support_fraction, "sheet_pixel_evidence_provisional_support_fraction"),
    maximum_accepted_unsupported_run_fraction: unit(input?.maximum_accepted_unsupported_run_fraction ?? DEFAULT_POLICY.maximum_accepted_unsupported_run_fraction, "sheet_pixel_evidence_maximum_accepted_unsupported_run_fraction"),
    minimum_chromatic_chroma: bounded(input?.minimum_chromatic_chroma, DEFAULT_POLICY.minimum_chromatic_chroma!, 0, 255, "sheet_pixel_evidence_minimum_chromatic_chroma"),
    minimum_chromatic_activation_fraction: unit(input?.minimum_chromatic_activation_fraction ?? DEFAULT_POLICY.minimum_chromatic_activation_fraction!, "sheet_pixel_evidence_minimum_chromatic_activation_fraction"),
    point_support_mode: pointSupportMode,
    point_radius_px: bounded(input?.point_radius_px, DEFAULT_POLICY.point_radius_px!, 1, 100, "sheet_pixel_evidence_point_radius_px"),
    point_minimum_supported_pixel_count: bounded(input?.point_minimum_supported_pixel_count, DEFAULT_POLICY.point_minimum_supported_pixel_count!, 1, 10000, "sheet_pixel_evidence_point_minimum_supported_pixel_count"),
    point_provisional_supported_pixel_count: bounded(input?.point_provisional_supported_pixel_count, DEFAULT_POLICY.point_provisional_supported_pixel_count!, 1, 10000, "sheet_pixel_evidence_point_provisional_supported_pixel_count"),
    point_minimum_dominant_hue_fraction: unit(input?.point_minimum_dominant_hue_fraction ?? DEFAULT_POLICY.point_minimum_dominant_hue_fraction!, "sheet_pixel_evidence_point_minimum_dominant_hue_fraction"),
    ...(input?.point_expected_hue_degrees === undefined
      ? {}
      : { point_expected_hue_degrees: bounded(input.point_expected_hue_degrees, 0, 0, 360, "sheet_pixel_evidence_point_expected_hue_degrees") }),
    point_hue_tolerance_degrees: bounded(input?.point_hue_tolerance_degrees, DEFAULT_POLICY.point_hue_tolerance_degrees!, 0, 180, "sheet_pixel_evidence_point_hue_tolerance_degrees")
  };
  if (result.outlined_network_min_half_span_px > result.outlined_network_max_half_span_px) {
    throw new Error("sheet_pixel_evidence_outlined_network_span_invalid");
  }
  return result;
}

function topologyInterruptionFractions(flags: boolean[], endpointExclusionFraction: number, minimumRunSamples: number): number[] {
  const result: number[] = [];
  const denominator = Math.max(1, flags.length - 1);
  let runStart = -1;
  const closeRun = (runEnd: number) => {
    if (runStart < 0 || (runEnd - runStart + 1) < minimumRunSamples) {
      runStart = -1;
      return;
    }
    const center = (runStart + runEnd) / 2;
    const fraction = center / denominator;
    if (fraction > endpointExclusionFraction && fraction < 1 - endpointExclusionFraction) result.push(fraction);
    runStart = -1;
  };
  flags.forEach((value, index) => {
    if (value && runStart < 0) runStart = index;
    if (!value && runStart >= 0) closeRun(index - 1);
  });
  if (runStart >= 0) closeRun(flags.length - 1);
  return result;
}

const HUE_BIN_COUNT = 24;
const HUE_BIN_WIDTH_DEGREES = 360 / HUE_BIN_COUNT;

function circularHueBinDistance(left: number, right: number): number {
  const distance = Math.abs(left - right);
  return Math.min(distance, HUE_BIN_COUNT - distance);
}

function nearbyEvidence(
  buffer: PixelBuffer,
  x: number,
  y: number,
  maximumLuminance: number,
  minimumChromaticChroma: number,
  radius: number
): { monochrome: boolean; hue_bins: Set<number> } {
  const cx = Math.round(x);
  const cy = Math.round(y);
  const r = Math.ceil(radius);
  const radiusSquared = radius * radius;
  let monochrome = false;
  const hueBins = new Set<number>();
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
      if (luminance <= maximumLuminance) monochrome = true;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const chroma = maximum - minimum;
      if (chroma < minimumChromaticChroma || maximum < 45 || luminance > 0.97 * 255) continue;
      let hue = 0;
      if (maximum === red) {
        hue = 60 * (((green - blue) / chroma) % 6);
      } else if (maximum === green) {
        hue = 60 * ((blue - red) / chroma + 2);
      } else {
        hue = 60 * ((red - green) / chroma + 4);
      }
      if (hue < 0) hue += 360;
      hueBins.add(Math.floor(hue / HUE_BIN_WIDTH_DEGREES) % HUE_BIN_COUNT);
    }
  }
  return { monochrome, hue_bins: hueBins };
}

type RouteSample = { x: number; y: number; normal_x: number; normal_y: number };

function routeSamples(primitive: SheetPixelPrimitiveV1, width: number, height: number, spacing: number): RouteSample[] {
  const result: RouteSample[] = [];
  for (let index = 1; index < primitive.points.length; index += 1) {
    const start = primitive.points[index - 1]!;
    const end = primitive.points[index]!;
    const startX = unit(start.u, `sheet_pixel_evidence_${primitive.primitive_id}_${index - 1}_u`) * width;
    const startY = unit(start.v, `sheet_pixel_evidence_${primitive.primitive_id}_${index - 1}_v`) * height;
    const endX = unit(end.u, `sheet_pixel_evidence_${primitive.primitive_id}_${index}_u`) * width;
    const endY = unit(end.v, `sheet_pixel_evidence_${primitive.primitive_id}_${index}_v`) * height;
    const length = Math.hypot(endX - startX, endY - startY);
    const normalX = length > 1e-9 ? -(endY - startY) / length : 0;
    const normalY = length > 1e-9 ? (endX - startX) / length : 1;
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let step = index === 1 ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps;
      result.push({ x: startX + ((endX - startX) * t), y: startY + ((endY - startY) * t), normal_x: normalX, normal_y: normalY });
    }
  }
  return result;
}

function outlinedNetworkEvidence(
  buffer: PixelBuffer,
  sample: RouteSample,
  resolvedPolicy: ResolvedSheetPixelEvidencePolicyV1
): { monochrome: boolean; hue_bins: Set<number> } {
  const sideEvidence = [-1, 1].map(side => {
    let monochrome = false;
    const hueBins = new Set<number>();
    for (let offset = resolvedPolicy.outlined_network_min_half_span_px; offset <= resolvedPolicy.outlined_network_max_half_span_px; offset += 1) {
      const evidence = nearbyEvidence(
        buffer,
        sample.x + (side * sample.normal_x * offset),
        sample.y + (side * sample.normal_y * offset),
        resolvedPolicy.maximum_luminance,
        resolvedPolicy.minimum_chromatic_chroma,
        resolvedPolicy.outlined_network_edge_radius_px
      );
      monochrome ||= evidence.monochrome;
      for (const hueBin of evidence.hue_bins) hueBins.add(hueBin);
    }
    return { monochrome, hue_bins: hueBins };
  });
  const pairedHueBins = new Set<number>();
  for (const left of sideEvidence[0]!.hue_bins) {
    if ([...sideEvidence[1]!.hue_bins].some(right => circularHueBinDistance(left, right) <= 1)) pairedHueBins.add(left);
  }
  return {
    monochrome: sideEvidence[0]!.monochrome && sideEvidence[1]!.monochrome,
    hue_bins: pairedHueBins
  };
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
      const evidence = samples.map(sample => resolvedPolicy.route_support_mode === "outlined_network_centerline"
        ? outlinedNetworkEvidence(args.pixels, sample, resolvedPolicy)
        : nearbyEvidence(
            args.pixels,
            sample.x,
            sample.y,
            resolvedPolicy.maximum_luminance,
            resolvedPolicy.minimum_chromatic_chroma,
            resolvedPolicy.corridor_radius_px
          ));
      const topologyInterruptionSampleFractions = resolvedPolicy.route_support_mode === "outlined_network_centerline"
        ? topologyInterruptionFractions(
            samples.map(sample => {
              const center = nearbyEvidence(
                args.pixels,
                sample.x,
                sample.y,
                resolvedPolicy.maximum_luminance,
                resolvedPolicy.minimum_chromatic_chroma,
                resolvedPolicy.outlined_network_center_ink_radius_px
              );
              return center.monochrome || center.hue_bins.size > 0;
            }),
            resolvedPolicy.outlined_network_topology_endpoint_exclusion_fraction,
            resolvedPolicy.outlined_network_topology_min_run_samples
          )
        : [];
      const requiresTopologySplit = resolvedPolicy.outlined_network_topology_interruption_mode === "defer"
        && topologyInterruptionSampleFractions.length > 0;
      const hueSupportCounts = Array.from({ length: HUE_BIN_COUNT }, (_, hueBin) =>
        evidence.filter(sample => [...sample.hue_bins].some(sampleBin => circularHueBinDistance(sampleBin, hueBin) <= 1)).length
      );
      const coherentHueBin = hueSupportCounts.reduce(
        (best, count, hueBin) => count > hueSupportCounts[best]! ? hueBin : best,
        0
      );
      const chromaticSupported = evidence.map(sample =>
        [...sample.hue_bins].some(sampleBin => circularHueBinDistance(sampleBin, coherentHueBin) <= 1)
      );
      const monochromeSupported = evidence.map(sample => sample.monochrome);
      const chromaticSupportFraction = chromaticSupported.filter(Boolean).length / chromaticSupported.length;
      const monochromeSupportFraction = monochromeSupported.filter(Boolean).length / monochromeSupported.length;
      const usesChromaticSupport = chromaticSupportFraction >= resolvedPolicy.minimum_chromatic_activation_fraction;
      const supportModality = resolvedPolicy.route_support_mode === "outlined_network_centerline"
        ? (usesChromaticSupport ? "chromatic_outline_centerline" as const : "monochrome_outline_centerline" as const)
        : (usesChromaticSupport ? "chromatic_line" as const : "monochrome_line" as const);
      const supported = usesChromaticSupport ? chromaticSupported : monochromeSupported;
      const supportedCount = supported.filter(Boolean).length;
      let longestUnsupported = 0;
      let currentUnsupported = 0;
      for (const value of supported) {
        currentUnsupported = value ? 0 : currentUnsupported + 1;
        longestUnsupported = Math.max(longestUnsupported, currentUnsupported);
      }
      const supportFraction = supportedCount / supported.length;
      const longestUnsupportedFraction = longestUnsupported / supported.length;
      const geometryStatus = supportFraction >= resolvedPolicy.accepted_support_fraction && longestUnsupportedFraction <= resolvedPolicy.maximum_accepted_unsupported_run_fraction
        ? "accepted_raster_support"
        : supportFraction >= resolvedPolicy.provisional_support_fraction
          ? "provisional_raster_support"
          : "rejected_raster_extent";
      const status = geometryStatus === "accepted_raster_support" && requiresTopologySplit
        ? "provisional_raster_support"
        : geometryStatus;
      return {
        primitive_id: primitive.primitive_id,
        sample_count: samples.length,
        supported_sample_count: supportedCount,
        support_fraction: supportFraction,
        longest_unsupported_run_fraction: longestUnsupportedFraction,
        status,
        support_modality: supportModality,
        chromatic_support_fraction: chromaticSupportFraction,
        monochrome_support_fraction: monochromeSupportFraction,
        ...(topologyInterruptionSampleFractions.length > 0
          ? {
              topology_interruption_sample_fractions: topologyInterruptionSampleFractions,
              topology_interruption_run_count: topologyInterruptionSampleFractions.length
            }
          : {}),
        ...(requiresTopologySplit ? { requires_topology_split: true } : {}),
        ...(usesChromaticSupport
          ? { coherent_hue_degrees: coherentHueBin * HUE_BIN_WIDTH_DEGREES }
          : {})
      } satisfies SheetPixelRouteEvidenceV1;
    });
  return { policy: resolvedPolicy, route_evidence: routeEvidence };
}

function scorePointEvidence(
  buffer: PixelBuffer,
  primitive: SheetPixelPrimitiveV1,
  resolvedPolicy: ResolvedSheetPixelEvidencePolicyV1
): SheetPixelPointEvidenceV1 {
  if (primitive.points.length !== 1) throw new Error(`sheet_pixel_evidence_point_symbol_requires_one_point:${primitive.primitive_id}`);
  const point = primitive.points[0]!;
  const centerX = Math.round(unit(point.u, `sheet_pixel_evidence_${primitive.primitive_id}_u`) * (buffer.width - 1));
  const centerY = Math.round(unit(point.v, `sheet_pixel_evidence_${primitive.primitive_id}_v`) * (buffer.height - 1));
  const radius = Math.ceil(resolvedPolicy.point_radius_px);
  const radiusSquared = resolvedPolicy.point_radius_px * resolvedPolicy.point_radius_px;
  let sampledPixelCount = 0;
  let monochromePixelCount = 0;
  let chromaticPixelCount = 0;
  const hueCounts = Array.from({ length: HUE_BIN_COUNT }, () => 0);
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if ((dx * dx) + (dy * dy) > radiusSquared) continue;
      const x = centerX + dx;
      const y = centerY + dy;
      if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) continue;
      const offset = ((y * buffer.width) + x) * 4;
      if ((buffer.data[offset + 3] ?? 0) < 128) continue;
      sampledPixelCount += 1;
      const red = buffer.data[offset] ?? 255;
      const green = buffer.data[offset + 1] ?? 255;
      const blue = buffer.data[offset + 2] ?? 255;
      const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
      if (luminance <= resolvedPolicy.maximum_luminance) monochromePixelCount += 1;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const chroma = maximum - minimum;
      if (chroma < resolvedPolicy.minimum_chromatic_chroma || maximum < 45 || luminance > 0.97 * 255) continue;
      chromaticPixelCount += 1;
      let hue = 0;
      if (maximum === red) hue = 60 * (((green - blue) / chroma) % 6);
      else if (maximum === green) hue = 60 * ((blue - red) / chroma + 2);
      else hue = 60 * ((red - green) / chroma + 4);
      if (hue < 0) hue += 360;
      hueCounts[Math.floor(hue / HUE_BIN_WIDTH_DEGREES) % HUE_BIN_COUNT] += 1;
    }
  }
  const coherentCounts = hueCounts.map((_, hueBin) => hueCounts.reduce(
    (total, count, sampleBin) => total + (circularHueBinDistance(sampleBin, hueBin) <= 1 ? count : 0),
    0
  ));
  const coherentHueBin = coherentCounts.reduce((best, count, hueBin) => count > coherentCounts[best]! ? hueBin : best, 0);
  const coherentChromaticPixelCount = coherentCounts[coherentHueBin] ?? 0;
  const dominantHueFraction = chromaticPixelCount > 0 ? coherentChromaticPixelCount / chromaticPixelCount : 0;
  const supportModality = resolvedPolicy.point_support_mode === "chromatic"
    || (resolvedPolicy.point_support_mode === "auto" && coherentChromaticPixelCount >= resolvedPolicy.point_provisional_supported_pixel_count)
    ? "chromatic_symbol" as const
    : "monochrome_symbol" as const;
  const supportedPixelCount = supportModality === "chromatic_symbol" ? coherentChromaticPixelCount : monochromePixelCount;
  const coherentHueDegrees = coherentHueBin * HUE_BIN_WIDTH_DEGREES;
  const expectedHueDistance = resolvedPolicy.point_expected_hue_degrees === undefined
    ? 0
    : Math.min(
      Math.abs(coherentHueDegrees - resolvedPolicy.point_expected_hue_degrees),
      360 - Math.abs(coherentHueDegrees - resolvedPolicy.point_expected_hue_degrees)
    );
  const hueCoherent = supportModality === "monochrome_symbol" || (
    dominantHueFraction >= resolvedPolicy.point_minimum_dominant_hue_fraction
    && expectedHueDistance <= resolvedPolicy.point_hue_tolerance_degrees
  );
  const status = supportedPixelCount >= resolvedPolicy.point_minimum_supported_pixel_count && hueCoherent
    ? "accepted_raster_support" as const
    : supportedPixelCount >= resolvedPolicy.point_provisional_supported_pixel_count && hueCoherent
      ? "provisional_raster_support" as const
      : "rejected_raster_extent" as const;
  return {
    primitive_id: primitive.primitive_id,
    sampled_pixel_count: sampledPixelCount,
    supported_pixel_count: supportedPixelCount,
    chromatic_pixel_count: chromaticPixelCount,
    monochrome_pixel_count: monochromePixelCount,
    ...(chromaticPixelCount > 0 ? { dominant_hue_fraction: dominantHueFraction } : {}),
    status,
    support_modality: supportModality,
    ...(supportModality === "chromatic_symbol" && coherentChromaticPixelCount > 0
      ? { coherent_hue_degrees: coherentHueDegrees }
      : {})
  };
}

export function scoreSheetPixelEvidenceV1(args: {
  pixels: PixelBuffer;
  interpretation: SheetPixelInterpretationInputV1;
  policy?: Partial<SheetPixelEvidencePolicyV1>;
}): { policy: SheetPixelEvidencePolicyV1; route_evidence: SheetPixelRouteEvidenceV1[]; point_evidence: SheetPixelPointEvidenceV1[] } {
  const routes = scoreSheetPixelRouteEvidenceV1(args);
  const resolvedPolicy = policy(args.policy);
  if (resolvedPolicy.point_provisional_supported_pixel_count > resolvedPolicy.point_minimum_supported_pixel_count) {
    throw new Error("sheet_pixel_evidence_point_provisional_threshold_exceeds_accepted");
  }
  return {
    policy: routes.policy,
    route_evidence: routes.route_evidence,
    point_evidence: args.interpretation.primitives
      .filter(primitive => primitive.kind === "point_symbol")
      .map(primitive => scorePointEvidence(args.pixels, primitive, resolvedPolicy))
  };
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function framePoint(
  frame: CandidateVisibleFrameMapping,
  point: { u: number; v: number }
): [number, number, number] {
  const u = unit(point.u, "sheet_candidate_presence_source_u");
  const v = unit(point.v, "sheet_candidate_presence_source_v");
  return [0, 1, 2].map(index =>
    frame.top_left_xyz[index]!
    + u * (frame.top_right_xyz[index]! - frame.top_left_xyz[index]!)
    + v * (frame.bottom_left_xyz[index]! - frame.top_left_xyz[index]!)
  ) as [number, number, number];
}

function candidateUv(
  frame: CandidateVisibleFrameMapping,
  point: [number, number, number]
): { u: number; v: number } {
  const ux = frame.top_right_xyz[0] - frame.top_left_xyz[0];
  const uy = frame.top_right_xyz[1] - frame.top_left_xyz[1];
  const vx = frame.bottom_left_xyz[0] - frame.top_left_xyz[0];
  const vy = frame.bottom_left_xyz[1] - frame.top_left_xyz[1];
  const dx = point[0] - frame.top_left_xyz[0];
  const dy = point[1] - frame.top_left_xyz[1];
  const determinant = (ux * vy) - (uy * vx);
  if (Math.abs(determinant) < 1e-9) throw new Error("sheet_candidate_presence_frame_is_degenerate");
  return {
    u: ((dx * vy) - (dy * vx)) / determinant,
    v: ((ux * dy) - (uy * dx)) / determinant
  };
}

export async function validateSheetCandidatePresenceV1(args: {
  image_path: string;
  expected_image_sha256: string;
  candidate_frame: CandidateVisibleFrameMapping;
  source_frame: CandidateVisibleFrameMapping;
  interpretation: SheetPixelInterpretationInputV1;
  source_evidence: SheetPixelEvidenceReceiptV1;
  policy?: Partial<SheetPixelEvidencePolicyV1>;
  overlay_path?: string;
}): Promise<SheetCandidatePresenceReceiptV1> {
  const imagePath = path.resolve(args.image_path);
  if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) throw new Error("sheet_candidate_presence_image_not_found");
  const imageBytes = fs.readFileSync(imagePath);
  const imageSha256 = sha256(imageBytes);
  if (imageSha256 !== String(args.expected_image_sha256 ?? "").trim().toLowerCase()) {
    throw new Error("sheet_candidate_presence_image_hash_mismatch");
  }
  const image = await loadImage(imageBytes);
  if (image.width !== args.candidate_frame.width_px || image.height !== args.candidate_frame.height_px) {
    throw new Error("sheet_candidate_presence_frame_dimensions_mismatch");
  }
  if (args.source_frame.view_id !== args.candidate_frame.view_id) throw new Error("sheet_candidate_presence_view_mismatch");
  if (args.source_evidence.source_view_key !== (args.interpretation.view_keys.length === 1 ? args.interpretation.view_keys[0] : args.source_evidence.source_view_key)) {
    throw new Error("sheet_candidate_presence_source_view_mismatch");
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height);
  const resolvedPolicy = policy(args.policy ?? args.source_evidence.policy);
  const sourceEvidenceById = new Map((args.source_evidence.point_evidence ?? []).map(value => [value.primitive_id, value]));
  const pointEvidence = args.interpretation.primitives
    .filter(primitive => primitive.kind === "point_symbol")
    .map((primitive): SheetCandidatePointPresenceEvidenceV1 => {
      const sourceEvidence = sourceEvidenceById.get(primitive.primitive_id);
      if (!sourceEvidence) throw new Error(`sheet_candidate_presence_source_evidence_missing:${primitive.primitive_id}`);
      if (primitive.points.length !== 1) throw new Error(`sheet_candidate_presence_point_symbol_requires_one_point:${primitive.primitive_id}`);
      const mapped = candidateUv(args.candidate_frame, framePoint(args.source_frame, primitive.points[0]!));
      if (mapped.u < 0 || mapped.u > 1 || mapped.v < 0 || mapped.v > 1) {
        return {
          primitive_id: primitive.primitive_id,
          source_status: sourceEvidence.status,
          candidate_status: "outside_candidate_frame",
          mapped_candidate_uv: mapped,
          status: sourceEvidence.status === "accepted_raster_support" ? "not_present" : "source_not_accepted",
          supported_pixel_count: 0
        };
      }
      const candidateEvidence = scorePointEvidence(
        { width: image.width, height: image.height, data: pixels.data },
        { ...primitive, points: [mapped] },
        resolvedPolicy
      );
      const status = sourceEvidence.status !== "accepted_raster_support"
        ? "source_not_accepted" as const
        : candidateEvidence.status === "accepted_raster_support"
          ? "existing_candidate_visible" as const
          : candidateEvidence.status === "provisional_raster_support"
            ? "ambiguous_candidate_presence" as const
            : "not_present" as const;
      return {
        primitive_id: primitive.primitive_id,
        source_status: sourceEvidence.status,
        candidate_status: candidateEvidence.status,
        mapped_candidate_uv: mapped,
        status,
        supported_pixel_count: candidateEvidence.supported_pixel_count,
        ...(candidateEvidence.coherent_hue_degrees === undefined ? {} : { coherent_hue_degrees: candidateEvidence.coherent_hue_degrees })
      };
    });
  let overlay: SheetCandidatePresenceReceiptV1["overlay"];
  if (args.overlay_path) {
    context.lineWidth = 4;
    context.font = "12px sans-serif";
    for (const evidence of pointEvidence) {
      const x = evidence.mapped_candidate_uv.u * (image.width - 1);
      const y = evidence.mapped_candidate_uv.v * (image.height - 1);
      context.strokeStyle = evidence.status === "existing_candidate_visible"
        ? "#9c27b0"
        : evidence.status === "ambiguous_candidate_presence"
          ? "#ff9800"
          : evidence.status === "not_present"
            ? "#00a651"
            : "#777777";
      context.fillStyle = context.strokeStyle;
      context.beginPath();
      context.arc(x, y, resolvedPolicy.point_radius_px, 0, Math.PI * 2);
      context.stroke();
      context.fillText(evidence.primitive_id, x + 4, y - 4);
    }
    const overlayPath = path.resolve(args.overlay_path);
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    const overlayBytes = canvas.toBuffer("image/png");
    fs.writeFileSync(overlayPath, overlayBytes);
    overlay = { path: overlayPath, sha256: sha256(overlayBytes) };
  }
  const ids = (status: SheetCandidatePointPresenceEvidenceV1["status"]) => pointEvidence.filter(value => value.status === status).map(value => value.primitive_id);
  return {
    schema_version: 1,
    package_id: args.interpretation.package_id,
    source_view_key: args.source_evidence.source_view_key,
    source_image_sha256: args.source_evidence.image.sha256,
    candidate_image: {
      path: imagePath,
      sha256: imageSha256,
      width_px: image.width,
      height_px: image.height,
      frame_id: args.candidate_frame.frame_id,
      view_id: args.candidate_frame.view_id
    },
    policy: resolvedPolicy,
    point_evidence: pointEvidence,
    existing_candidate_visible_primitive_ids: ids("existing_candidate_visible"),
    ambiguous_candidate_presence_primitive_ids: ids("ambiguous_candidate_presence"),
    not_present_primitive_ids: ids("not_present"),
    source_not_accepted_primitive_ids: ids("source_not_accepted"),
    ...(overlay ? { overlay } : {})
  };
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
  const scored = scoreSheetPixelEvidenceV1({ pixels: { width: image.width, height: image.height, data: pixels.data }, interpretation: args.interpretation, policy: args.policy });
  const evidenceById = new Map([...scored.route_evidence, ...scored.point_evidence].map(item => [item.primitive_id, item]));
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
    for (const primitive of args.interpretation.primitives.filter(item => item.kind === "point_symbol")) {
      const evidence = evidenceById.get(primitive.primitive_id)!;
      const point = primitive.points[0]!;
      const x = point.u * (image.width - 1);
      const y = point.v * (image.height - 1);
      context.strokeStyle = evidence.status === "accepted_raster_support" ? "#00a651" : evidence.status === "provisional_raster_support" ? "#ff9800" : "#e51c23";
      context.fillStyle = context.strokeStyle;
      context.beginPath();
      context.arc(x, y, scored.policy.point_radius_px ?? DEFAULT_POLICY.point_radius_px!, 0, Math.PI * 2);
      context.stroke();
      context.fillText(primitive.primitive_id, x + 4, y - 4);
    }
    const overlayPath = path.resolve(args.overlay_path);
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    const overlayBytes = canvas.toBuffer("image/png");
    fs.writeFileSync(overlayPath, overlayBytes);
    overlay = { path: overlayPath, sha256: sha256(overlayBytes) };
  }
  const allEvidence = [...scored.route_evidence, ...scored.point_evidence];
  const accepted = allEvidence.filter(item => item.status === "accepted_raster_support").map(item => item.primitive_id);
  const provisional = allEvidence.filter(item => item.status === "provisional_raster_support").map(item => item.primitive_id);
  const rejected = allEvidence.filter(item => item.status === "rejected_raster_extent").map(item => item.primitive_id);
  return {
    schema_version: 1,
    package_id: args.interpretation.package_id,
    source_view_key: sourceViewKey,
    image: { path: imagePath, sha256: sha256(imageBytes), width_px: image.width, height_px: image.height },
    policy: scored.policy,
    route_evidence: scored.route_evidence,
    point_evidence: scored.point_evidence,
    accepted_primitive_ids: accepted,
    provisional_primitive_ids: provisional,
    rejected_primitive_ids: rejected,
    ...(overlay ? { overlay } : {})
  };
}
