import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  buildAtomicMepDraftWorkflowRequest,
  type AtomicMepDraftWorkflowRequest
} from "./mep_draft_plan.js";
import {
  compileRegisteredMepObservations,
  type RegisteredMepObservationCompilation,
  type RegisteredMepObservationPackage,
  type RegisteredMepPixelObservation
} from "./registered_mep_observations.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";
import type { ExistingConditionsPlanPoint } from "./registration.js";
import {
  extractPlanTracesFromPixels,
  sha256PlanTracePixelBuffer,
  type PlanTraceExtractionReceipt,
  type PlanTracePixelBuffer
} from "./plan_trace_extraction.js";

export const CANDIDATE_VISIBLE_LANDMARK_DISTANCE_THRESHOLD = 0.06;
const CANDIDATE_VISIBLE_LANDMARK_DISTANCE_PRECISION = 1_000;

export function candidateVisibleLandmarkDistanceWithinThreshold(
  distance: number
): boolean {
  if (!Number.isFinite(distance) || distance < 0) return false;
  // Structured visual controls are reported to three decimal places. Compare
  // native projections at that same precision so binary floating-point noise
  // cannot reject a control that is exactly on the documented boundary.
  const quantized = Math.round(
    (distance + Number.EPSILON) * CANDIDATE_VISIBLE_LANDMARK_DISTANCE_PRECISION
  ) / CANDIDATE_VISIBLE_LANDMARK_DISTANCE_PRECISION;
  return quantized <= CANDIDATE_VISIBLE_LANDMARK_DISTANCE_THRESHOLD;
}

export type CandidateVisibleFrameMapping = {
  frame_id: string;
  view_id: number;
  width_px: number;
  height_px: number;
  top_left_xyz: [number, number, number];
  top_right_xyz: [number, number, number];
  bottom_left_xyz: [number, number, number];
  target_level_elevation_ft: number;
};

export type CandidateVisibleAlignment = {
  matched: boolean;
  confidence: number;
  provider?: "gemini" | "openai" | null;
  model?: string | null;
  attempted_models?: string[];
  fallback_reason?: string | null;
  source_room_labels?: Array<{
    text: string;
    normalized_x: number;
    normalized_y: number;
    min_u: number;
    min_v: number;
    max_u: number;
    max_v: number;
    score: number;
  }>;
  crop: {
    min_u: number;
    min_v: number;
    max_u: number;
    max_v: number;
  } | null;
};

export type CandidateVisibleMepPlannerPayload = {
  schema_version: 1 | 2;
  fixture_id: string;
  scope_id: string;
  discipline: "mechanical" | "plumbing" | "electrical" | "mixed";
  coordinate_space?: "normalized_uv_top_left" | "registered_render_pixels_top_left";
  native_element_references?: RegisteredMepObservationPackage["native_element_references"];
  level_name: string;
  level_elevation_ft?: number;
  room_number?: string;
  spatial_scope?: {
    boundary_pixel_points: ExistingConditionsPlanPoint[];
    anchor_pixel_point: ExistingConditionsPlanPoint;
    anchor_label: string;
    evidence_reference: string;
  };
  material_confidence_threshold?: number;
  partial_promotion_policy?: "all_or_nothing" | "defer_ambiguous_observations";
  maximum_observations: number;
  observations: RegisteredMepPixelObservation[];
};

export type CandidateVisibleMepReconstructionInput = {
  source_pdf_path: string;
  registered_render_path: string;
  alignment: CandidateVisibleAlignment;
  frame: CandidateVisibleFrameMapping;
  planner_payload: CandidateVisibleMepPlannerPayload;
  verified_room_scope?: {
    room_number: string;
    room_name?: string;
    source_scoped_id: string;
    boundary_model_points: ExistingConditionsPlanPoint[];
    location_model_point?: ExistingConditionsPlanPoint;
    stable_boundary_segments?: Array<{
      stable_kind: "exterior_wall";
      source_scoped_id: string;
      category: string;
      name: string;
      start_model_point: ExistingConditionsPlanPoint;
      end_model_point: ExistingConditionsPlanPoint;
    }>;
    visible_room_label?: {
      text: string;
      source_scoped_id: string;
      built_in_category: "OST_RoomTags";
      frame_id: string;
      registration_frame_id: string;
      view_id: number;
      model_point: ExistingConditionsPlanPoint;
    };
  };
  verified_landmark_scope?: {
    source_scoped_id: string;
    basis: "durable_landmarks_in_aligned_crop";
    maximum_crop_residual: number;
    source_control_span: number;
    view_control_span: number;
    source_pdf_sha256: string;
    registered_render_sha256: string;
    alignment_receipt_sha256: string;
    inventory_receipt_sha256: string;
    registration_controls: Array<{
      kind: string;
      source_normalized_point: ExistingConditionsPlanPoint;
      view_normalized_point: ExistingConditionsPlanPoint;
      score: number;
      crop_residual: number;
      label?: string | null;
    }>;
    landmark_matches: Array<{
      control_index: number;
      native_source_scoped_id: string;
      native_built_in_category: string;
      native_model_point: ExistingConditionsPlanPoint;
      native_projected_view_normalized_point: ExistingConditionsPlanPoint;
      projected_distance_normalized: number;
      geometry_basis: "projected_geometry" | "projected_bbox";
    }>;
  };
  maximum_created_elements?: number;
};

export type CandidateVisibleRouteClippingReceipt = {
  observation_id: string;
  geometry_role: "route" | "placement_branch";
  clipping_basis?:
    | "source_observed_scope_before_local_room_registration"
    | "authoritative_scope_after_registration";
  source_point_count: number;
  retained_point_count: number;
  source_length_px: number;
  retained_length_px: number;
  retained_part_index: number;
  retained_part_count: number;
  dropped_part_count: number;
  source_start_pixel_point: ExistingConditionsPlanPoint;
  source_end_pixel_point: ExistingConditionsPlanPoint;
  retained_start_pixel_point: ExistingConditionsPlanPoint;
  retained_end_pixel_point: ExistingConditionsPlanPoint;
};

export type CandidateVisibleRouteRasterVerification = {
  observation_id: string;
  geometry_role: "route" | "placement_branch";
  accepted: boolean;
  support_modality: "chromatic_line" | "monochrome_line";
  sample_count: number;
  segment_support_ratios: number[];
  mean_support_ratio: number;
  minimum_segment_support_ratio: number;
  chromatic_segment_support_ratios: number[];
  chromatic_mean_support_ratio: number;
  monochrome_segment_support_ratios: number[];
  monochrome_mean_support_ratio: number;
  maximum_search_radius_px: number;
  minimum_mean_support_ratio: number;
  minimum_each_segment_support_ratio: number;
  coherent_hue_degrees?: number;
  retrace_proposal?: {
    basis: "hash_bound_chromatic_plan_trace";
    target_color: string;
    source_pixel_sha256: string;
    extraction_policy_sha256: string;
    reference_geometry_sha256: string;
    component_ids: string[];
    corridor_radius_px: number;
    maximum_reference_distance_px: number;
    runner_up_score_margin: number | null;
    pixel_points: ExistingConditionsPlanPoint[];
    normalized_uv_points: ExistingConditionsPlanPoint[];
  };
};

export type CandidateVisibleSourceRoomShapeVerification = {
  accepted: boolean;
  source_room_label_text: string;
  source_room_label_pixel_point: ExistingConditionsPlanPoint;
  source_room_label_pixel_bounds: {
    min: ExistingConditionsPlanPoint;
    max: ExistingConditionsPlanPoint;
  };
  source_render_mean_absolute_luminance_difference: number;
  maximum_source_render_mean_absolute_luminance_difference: number;
  submitted_anchor_distance_px: number;
  maximum_anchor_distance_px: number;
  normalized_symmetric_hausdorff: number;
  maximum_normalized_symmetric_hausdorff: number;
  normalized_area_difference: number;
  maximum_normalized_area_difference: number;
  matched_transform: "identity" | "flip_x" | "flip_y" | "flip_xy";
};

export type CandidateVisibleMepReconstruction = {
  registration_context_id: string;
  package: RegisteredMepObservationPackage;
  compilation: RegisteredMepObservationCompilation;
  workflow: AtomicMepDraftWorkflowRequest;
  planner_normalization_warnings: string[];
  spatial_scope_receipt?: {
    anchor_label: string;
    evidence_reference: string;
    boundary_pixel_points: ExistingConditionsPlanPoint[];
    anchor_pixel_point: ExistingConditionsPlanPoint;
    source_observed_boundary_pixel_points?: ExistingConditionsPlanPoint[];
    source_observed_anchor_pixel_point?: ExistingConditionsPlanPoint;
    model_boundary_points: ExistingConditionsPlanPoint[];
    native_room_source_scoped_id?: string;
    native_room_boundary_model_points?: ExistingConditionsPlanPoint[];
    native_area_source_scoped_id?: string;
    native_area_boundary_model_points?: ExistingConditionsPlanPoint[];
    durable_landmark_registration?: NonNullable<
      CandidateVisibleMepReconstructionInput["verified_landmark_scope"]
    >;
    checked_observation_ids: string[];
    route_clipping_receipts?: CandidateVisibleRouteClippingReceipt[];
    source_route_raster_verifications?: CandidateVisibleRouteRasterVerification[];
    local_room_registration_fallback?: {
      reason:
        | "source_scope_disjoint_from_projected_native_room"
        | "server_verified_source_room_shape_match"
        | "server_verified_room_enclosure_similarity"
        | "server_verified_room_label_translation"
        | "server_verified_room_tag_and_stable_boundary_similarity";
      source_room_label_evidence_basis?:
        | "vector_pdf_text"
        | "gemini_structured_source_label";
      source_scope_bounds: {
        min: ExistingConditionsPlanPoint;
        max: ExistingConditionsPlanPoint;
      };
      target_native_room_bounds: {
        min: ExistingConditionsPlanPoint;
        max: ExistingConditionsPlanPoint;
      };
      scale_x: number;
      scale_y: number;
      translation_x_px?: number;
      translation_y_px?: number;
      native_room_label_text?: string;
      native_room_label_source_scoped_id?: string;
      native_room_label_built_in_category?: "OST_RoomTags";
      native_room_label_frame_id?: string;
      native_room_label_registration_frame_id?: string;
      native_room_label_view_id?: number;
      native_room_label_model_point?: ExistingConditionsPlanPoint;
      native_room_label_projected_pixel_point?: ExistingConditionsPlanPoint;
      source_render_mean_absolute_luminance_difference?: number;
      source_render_max_tile_mean_absolute_luminance_difference?: number;
      source_render_changed_pixel_ratio?: number;
      source_render_foreground_centroid_delta_px?: number;
      source_enclosure_raster_verification?: CandidateVisibleSourceEnclosureRasterVerification;
      source_room_shape_verification?: CandidateVisibleSourceRoomShapeVerification;
      native_enclosure_basis?:
        | "full_native_room"
        | "primary_orthogonal_enclosure_containing_room_location";
      stable_landmark_similarity?: CandidateVisibleStableLandmarkSimilarity;
    };
    source_observations_sha256: string;
    source_observations: RegisteredMepPixelObservation[];
    boundary_basis?:
      | "source_observed"
      | "verified_native_room_projected_to_registered_render"
      | "verified_durable_landmark_area_projected_to_registered_render";
    normalization_warnings?: string[];
  };
};

export type CandidateVisibleStableLandmarkSimilarity = {
  basis: "exact_room_tag_plus_stable_native_boundary";
  stable_kind: "exterior_wall";
  axis: "horizontal" | "vertical";
  source_pixel_sha256: string;
  source_boundary_edge_index: number;
  source_boundary_start_pixel_point: ExistingConditionsPlanPoint;
  source_boundary_end_pixel_point: ExistingConditionsPlanPoint;
  native_segment_source_scoped_id: string;
  native_segment_name: string;
  source_landmark_coordinate_px: number;
  source_landmark_support_ratio: number;
  native_landmark_projected_coordinate_before_px: number;
  source_room_tag_coordinate_px: number;
  native_room_tag_projected_coordinate_px: number;
  similarity_scale: number;
  residual_px: number;
  post_transform_endpoint_rms_residual_px: number;
  source_native_span_ratio: number;
  candidate_score: number;
  runner_up_score_margin: number | null;
};

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}_must_be_a_positive_integer`);
  return parsed;
}

function point3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) throw new Error(`${label}_must_be_xyz`);
  return [
    finite(value[0], `${label}_x`),
    finite(value[1], `${label}_y`),
    finite(value[2], `${label}_z`)
  ];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Json(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rounded(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

type CandidateVisibleSourceRoomLabelAnchor = {
  evidence_basis: "vector_pdf_text" | "gemini_structured_source_label";
  text: string;
  page: number;
  pixel_point: ExistingConditionsPlanPoint;
  pixel_bounds: {
    min: ExistingConditionsPlanPoint;
    max: ExistingConditionsPlanPoint;
  };
  source_render_mean_absolute_luminance_difference: number;
  source_render_max_tile_mean_absolute_luminance_difference: number;
  source_render_changed_pixel_ratio: number;
  source_render_foreground_centroid_delta_px: number;
};

type CandidateVisibleSourceEnclosureRasterVerification = {
  accepted: boolean;
  polygon_area_ratio: number;
  edge_support_ratios: number[];
  mean_edge_support_ratio: number;
  minimum_edge_support_ratio: number;
  maximum_polygon_area_ratio: number;
  minimum_mean_edge_support_ratio: number;
  minimum_each_edge_support_ratio: number;
};

function normalizedRoomLabelToken(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function roomLabelMatchesExactIdentity(
  labelToken: string,
  roomToken: string,
  roomNameToken: string
): boolean {
  if (!labelToken || !roomToken) return false;
  if (!roomNameToken) return labelToken === roomToken;
  return (
    labelToken === `${roomToken}${roomNameToken}` ||
    labelToken === `${roomNameToken}${roomToken}`
  );
}

function roomLabelTokenContainsExactRoom(labelToken: string, roomToken: string): boolean {
  if (!labelToken || !roomToken) return false;
  if (labelToken === roomToken) return true;
  if (/^\d+$/.test(roomToken)) {
    const startsWithRoom =
      labelToken.startsWith(roomToken) &&
      !/^\d$/.test(labelToken.charAt(roomToken.length));
    const roomStart = labelToken.length - roomToken.length;
    const endsWithRoom =
      roomStart > 0 &&
      labelToken.endsWith(roomToken) &&
      !/^\d$/.test(labelToken.charAt(roomStart - 1));
    return startsWithRoom || endsWithRoom;
  }
  return labelToken.startsWith(roomToken) || labelToken.endsWith(roomToken);
}

async function locateUniqueSourceRoomLabelAnchor(args: {
  source_pdf_path: string;
  registered_render_path: string;
  room_number: string;
  render_width_px: number;
  render_height_px: number;
}): Promise<CandidateVisibleSourceRoomLabelAnchor | null> {
  const expected = normalizedRoomLabelToken(args.room_number);
  if (!expected) return null;
  let document: any = null;
  try {
    const pdfjs: any = await loadPdfJsForNode();
    document = await pdfjs.getDocument(
      buildPdfJsDocumentOptions(new Uint8Array(fs.readFileSync(args.source_pdf_path)))
    ).promise;
    if (Number(document?.numPages) !== 1) return null;
    const page = await document.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = args.render_width_px / Number(baseViewport.width);
    const viewport = page.getViewport({ scale });
    const renderedAspect = args.render_width_px / args.render_height_px;
    const pageAspect = Number(viewport.width) / Number(viewport.height);
    if (
      !Number.isFinite(scale) ||
      scale <= 0 ||
      !Number.isFinite(pageAspect) ||
      Math.abs(pageAspect - renderedAspect) / Math.max(pageAspect, renderedAspect) > 0.02
    ) {
      return null;
    }
    const pdfCanvas = createCanvas(args.render_width_px, args.render_height_px);
    const pdfContext = pdfCanvas.getContext("2d");
    pdfContext.fillStyle = "#fff";
    pdfContext.fillRect(0, 0, args.render_width_px, args.render_height_px);
    await page.render({ canvasContext: pdfContext as any, viewport }).promise;
    const registeredImage = await loadImage(args.registered_render_path);
    if (
      registeredImage.width !== args.render_width_px ||
      registeredImage.height !== args.render_height_px
    ) {
      return null;
    }
    const registeredCanvas = createCanvas(
      args.render_width_px,
      args.render_height_px
    );
    const registeredContext = registeredCanvas.getContext("2d");
    registeredContext.fillStyle = "#fff";
    registeredContext.fillRect(
      0,
      0,
      args.render_width_px,
      args.render_height_px
    );
    registeredContext.drawImage(registeredImage, 0, 0);
    const pdfPixels = pdfContext.getImageData(
      0,
      0,
      args.render_width_px,
      args.render_height_px
    ).data;
    const registeredPixels = registeredContext.getImageData(
      0,
      0,
      args.render_width_px,
      args.render_height_px
    ).data;
    let luminanceDifference = 0;
    let changedPixelCount = 0;
    let pdfDarkness = 0;
    let registeredDarkness = 0;
    let pdfDarknessX = 0;
    let pdfDarknessY = 0;
    let registeredDarknessX = 0;
    let registeredDarknessY = 0;
    const tileGridSize = 8;
    const tileDifferences = new Array<number>(tileGridSize * tileGridSize).fill(0);
    const tilePixelCounts = new Array<number>(tileGridSize * tileGridSize).fill(0);
    for (let index = 0; index < pdfPixels.length; index += 4) {
      const pdfLuminance =
        0.2126 * pdfPixels[index]! +
        0.7152 * pdfPixels[index + 1]! +
        0.0722 * pdfPixels[index + 2]!;
      const registeredLuminance =
        0.2126 * registeredPixels[index]! +
        0.7152 * registeredPixels[index + 1]! +
        0.0722 * registeredPixels[index + 2]!;
      const difference = Math.abs(pdfLuminance - registeredLuminance) / 255;
      luminanceDifference += difference;
      if (difference > 0.1) changedPixelCount += 1;
      const pixelIndex = index / 4;
      const x = pixelIndex % args.render_width_px;
      const y = Math.floor(pixelIndex / args.render_width_px);
      const pdfPixelDarkness = 1 - pdfLuminance / 255;
      const registeredPixelDarkness = 1 - registeredLuminance / 255;
      pdfDarkness += pdfPixelDarkness;
      registeredDarkness += registeredPixelDarkness;
      pdfDarknessX += x * pdfPixelDarkness;
      pdfDarknessY += y * pdfPixelDarkness;
      registeredDarknessX += x * registeredPixelDarkness;
      registeredDarknessY += y * registeredPixelDarkness;
      const tileX = Math.min(
        tileGridSize - 1,
        Math.floor(x * tileGridSize / args.render_width_px)
      );
      const tileY = Math.min(
        tileGridSize - 1,
        Math.floor(y * tileGridSize / args.render_height_px)
      );
      const tileIndex = tileY * tileGridSize + tileX;
      tileDifferences[tileIndex] += difference;
      tilePixelCounts[tileIndex] += 1;
    }
    const pixelCount = args.render_width_px * args.render_height_px;
    const meanAbsoluteLuminanceDifference =
      luminanceDifference / pixelCount;
    const maxTileMeanAbsoluteLuminanceDifference = Math.max(
      ...tileDifferences.map((value, index) =>
        value / Math.max(1, tilePixelCounts[index]!)
      )
    );
    const changedPixelRatio = changedPixelCount / pixelCount;
    if (pdfDarkness < 1 || registeredDarkness < 1) {
      return null;
    }
    const foregroundCentroidDeltaPx = Math.hypot(
      registeredDarknessX / registeredDarkness - pdfDarknessX / pdfDarkness,
      registeredDarknessY / registeredDarkness - pdfDarknessY / pdfDarkness
    );
    if (
      meanAbsoluteLuminanceDifference > 0.025 ||
      maxTileMeanAbsoluteLuminanceDifference > 0.08 ||
      changedPixelRatio > 0.08 ||
      foregroundCentroidDeltaPx > 2.5
    ) {
      return null;
    }
    const textContent = await page.getTextContent();
    const textEntries: CandidateVisibleSourceRoomLabelAnchor[] = (
      Array.isArray(textContent?.items) ? textContent.items : []
    )
      .map((item: any) => {
        const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
        if (
          Math.abs(Number(matrix[1])) > 1e-4 ||
          Math.abs(Number(matrix[2])) > 1e-4
        ) {
          return null;
        }
        const width = Number(item.width) * scale;
        const height = Math.max(Number(item.height) * scale, Math.hypot(matrix[2], matrix[3]));
        const min = { x: Number(matrix[4]), y: Number(matrix[5]) - height };
        const max = { x: Number(matrix[4]) + width, y: Number(matrix[5]) };
        return {
          evidence_basis: "vector_pdf_text",
          text: String(item.str ?? "").trim(),
          page: 1,
          pixel_point: {
            x: (min.x + max.x) / 2,
            y: (min.y + max.y) / 2
          },
          pixel_bounds: { min, max },
          source_render_mean_absolute_luminance_difference:
            meanAbsoluteLuminanceDifference,
          source_render_max_tile_mean_absolute_luminance_difference:
            maxTileMeanAbsoluteLuminanceDifference,
          source_render_changed_pixel_ratio: changedPixelRatio,
          source_render_foreground_centroid_delta_px:
            foregroundCentroidDeltaPx
        } satisfies CandidateVisibleSourceRoomLabelAnchor;
      })
      .filter((entry: CandidateVisibleSourceRoomLabelAnchor | null): entry is CandidateVisibleSourceRoomLabelAnchor =>
        entry !== null &&
        Number.isFinite(entry.pixel_point.x) &&
        Number.isFinite(entry.pixel_point.y) &&
        entry.pixel_point.x >= 0 &&
        entry.pixel_point.y >= 0 &&
        entry.pixel_point.x <= args.render_width_px &&
        entry.pixel_point.y <= args.render_height_px
      );
    const matches = textEntries.filter((entry) =>
      normalizedRoomLabelToken(entry.text) === expected
    );
    if (matches.length !== 1) return null;
    const roomNumberEntry = matches[0]!;
    const numberHeight =
      roomNumberEntry.pixel_bounds.max.y - roomNumberEntry.pixel_bounds.min.y;
    const numberWidth =
      roomNumberEntry.pixel_bounds.max.x - roomNumberEntry.pixel_bounds.min.x;
    const cluster = textEntries.filter((entry) => {
      const horizontalGap = Math.max(
        0,
        roomNumberEntry.pixel_bounds.min.x - entry.pixel_bounds.max.x,
        entry.pixel_bounds.min.x - roomNumberEntry.pixel_bounds.max.x
      );
      return (
        horizontalGap <= Math.max(8, numberWidth) &&
        entry.pixel_bounds.max.y >=
          roomNumberEntry.pixel_bounds.min.y - Math.max(24, numberHeight * 4) &&
        entry.pixel_bounds.min.y <=
          roomNumberEntry.pixel_bounds.max.y + Math.max(4, numberHeight * 0.5)
      );
    });
    const clusterBounds = {
      min: {
        x: Math.min(...cluster.map((entry) => entry.pixel_bounds.min.x)),
        y: Math.min(...cluster.map((entry) => entry.pixel_bounds.min.y))
      },
      max: {
        x: Math.max(...cluster.map((entry) => entry.pixel_bounds.max.x)),
        y: Math.max(...cluster.map((entry) => entry.pixel_bounds.max.y))
      }
    };
    return {
      ...roomNumberEntry,
      text: cluster.map((entry) => entry.text).filter(Boolean).join(" "),
      pixel_bounds: clusterBounds,
      pixel_point: {
        x: (clusterBounds.min.x + clusterBounds.max.x) / 2,
        y: (clusterBounds.min.y + clusterBounds.max.y) / 2
      }
    };
  } catch {
    return null;
  } finally {
    try {
      await document?.destroy?.();
    } catch {
      // Best-effort cleanup for malformed or partially loaded source PDFs.
    }
  }
}

async function locateUniqueStructuredSourceRoomLabelAnchor(args: {
  source_path: string;
  registered_render_path: string;
  room_number: string;
  render_width_px: number;
  render_height_px: number;
  alignment: CandidateVisibleAlignment;
}): Promise<CandidateVisibleSourceRoomLabelAnchor | null> {
  if (
    args.alignment.provider !== "gemini" ||
    sha256File(args.source_path) !== sha256File(args.registered_render_path)
  ) {
    return null;
  }
  const expected = normalizedRoomLabelToken(args.room_number);
  if (!expected) return null;
  const labels = (args.alignment.source_room_labels ?? []).filter((entry) => {
    if (!entry || entry.score < 0.85) return false;
    const values = [
      entry.normalized_x,
      entry.normalized_y,
      entry.min_u,
      entry.min_v,
      entry.max_u,
      entry.max_v
    ];
    return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
      entry.max_u > entry.min_u &&
      entry.max_v > entry.min_v &&
      entry.normalized_x >= entry.min_u &&
      entry.normalized_x <= entry.max_u &&
      entry.normalized_y >= entry.min_v &&
      entry.normalized_y <= entry.max_v;
  });
  const matches = labels.filter((entry) =>
    roomLabelTokenContainsExactRoom(
      normalizedRoomLabelToken(entry.text),
      expected
    )
  );
  if (matches.length !== 1) return null;
  const roomNumberMatch = matches[0]!;
  const numberWidth = roomNumberMatch.max_u - roomNumberMatch.min_u;
  const numberHeight = roomNumberMatch.max_v - roomNumberMatch.min_v;
  const cluster = normalizedRoomLabelToken(roomNumberMatch.text) === expected
    ? labels.filter((entry) => {
    const horizontalGap = Math.max(
      0,
      roomNumberMatch.min_u - entry.max_u,
      entry.min_u - roomNumberMatch.max_u
    );
    return horizontalGap <= Math.max(0.01, numberWidth) &&
      entry.max_v >= roomNumberMatch.min_v - Math.max(0.04, numberHeight * 4) &&
      entry.min_v <= roomNumberMatch.max_v + Math.max(0.01, numberHeight * 0.5);
    })
    : [roomNumberMatch];
  const match = {
    ...roomNumberMatch,
    text: cluster.map((entry) => entry.text.trim()).filter(Boolean).join(" "),
    min_u: Math.min(...cluster.map((entry) => entry.min_u)),
    min_v: Math.min(...cluster.map((entry) => entry.min_v)),
    max_u: Math.max(...cluster.map((entry) => entry.max_u)),
    max_v: Math.max(...cluster.map((entry) => entry.max_v))
  };
  match.normalized_x = (match.min_u + match.max_u) / 2;
  match.normalized_y = (match.min_v + match.max_v) / 2;
  // Multi-line room labels commonly include the room name, number, and a
  // surrounding title box. Keep this bounded, but do not reject a unique,
  // high-confidence, raster-occupied label merely because its box is larger
  // than a single OCR token.
  const areaRatio = (match.max_u - match.min_u) * (match.max_v - match.min_v);
  if (areaRatio <= 1e-7 || areaRatio > 0.04) return null;

  const image = await loadImage(args.registered_render_path);
  if (
    image.width !== args.render_width_px ||
    image.height !== args.render_height_px
  ) {
    return null;
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  const minX = Math.max(0, Math.floor(match.min_u * image.width));
  const minY = Math.max(0, Math.floor(match.min_v * image.height));
  const maxX = Math.min(image.width, Math.ceil(match.max_u * image.width));
  const maxY = Math.min(image.height, Math.ceil(match.max_v * image.height));
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 2 || height < 2) return null;
  const pixels = context.getImageData(minX, minY, width, height).data;
  let foregroundPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance =
      0.2126 * pixels[index]! +
      0.7152 * pixels[index + 1]! +
      0.0722 * pixels[index + 2]!;
    if (luminance < 245) foregroundPixels += 1;
  }
  const foregroundRatio = foregroundPixels / Math.max(1, width * height);
  if (foregroundRatio < 0.005 || foregroundRatio > 0.8) return null;

  return {
    evidence_basis: "gemini_structured_source_label",
    text: match.text.trim(),
    page: 1,
    pixel_point: {
      x: match.normalized_x * args.render_width_px,
      y: match.normalized_y * args.render_height_px
    },
    pixel_bounds: {
      min: {
        x: match.min_u * args.render_width_px,
        y: match.min_v * args.render_height_px
      },
      max: {
        x: match.max_u * args.render_width_px,
        y: match.max_v * args.render_height_px
      }
    },
    source_render_mean_absolute_luminance_difference: 0,
    source_render_max_tile_mean_absolute_luminance_difference: 0,
    source_render_changed_pixel_ratio: 0,
    source_render_foreground_centroid_delta_px: 0
  };
}

async function verifySourceEnclosureRaster(args: {
  registered_render_path: string;
  boundary_pixel_points: ExistingConditionsPlanPoint[];
  render_width_px: number;
  render_height_px: number;
}): Promise<CandidateVisibleSourceEnclosureRasterVerification> {
  const maximumPolygonAreaRatio = 0.75;
  const minimumMeanEdgeSupportRatio = 0.3;
  // A room edge may contain a door opening or mask, so permit a narrowly
  // bounded partial edge when the unique room label and mean enclosure support
  // independently remain strong.
  const minimumEachEdgeSupportRatio = 0.075;
  let polygon = args.boundary_pixel_points
    .map(normalizePoint)
    .filter((point): point is ExistingConditionsPlanPoint => point !== null);
  if (
    polygon.length > 3 &&
    Math.hypot(
      polygon[0]!.x - polygon[polygon.length - 1]!.x,
      polygon[0]!.y - polygon[polygon.length - 1]!.y
    ) <= 1e-7
  ) {
    polygon = polygon.slice(0, -1);
  }
  const rejected = (
    polygonAreaRatio = 0,
    edgeSupportRatios: number[] = []
  ): CandidateVisibleSourceEnclosureRasterVerification => ({
    accepted: false,
    polygon_area_ratio: rounded(polygonAreaRatio),
    edge_support_ratios: edgeSupportRatios.map((value) => rounded(value)),
    mean_edge_support_ratio: rounded(
      edgeSupportRatios.length > 0
        ? edgeSupportRatios.reduce((sum, value) => sum + value, 0) /
            edgeSupportRatios.length
        : 0
    ),
    minimum_edge_support_ratio: rounded(
      edgeSupportRatios.length > 0 ? Math.min(...edgeSupportRatios) : 0
    ),
    maximum_polygon_area_ratio: maximumPolygonAreaRatio,
    minimum_mean_edge_support_ratio: minimumMeanEdgeSupportRatio,
    minimum_each_edge_support_ratio: minimumEachEdgeSupportRatio
  });
  if (polygon.length < 3) return rejected();
  const image = await loadImage(args.registered_render_path);
  if (
    image.width !== args.render_width_px ||
    image.height !== args.render_height_px
  ) {
    return rejected();
  }
  const polygonAreaRatio =
    Math.abs(polygonTwiceArea(polygon)) /
    2 /
    (args.render_width_px * args.render_height_px);
  if (!Number.isFinite(polygonAreaRatio) || polygonAreaRatio <= 0) {
    return rejected();
  }
  const canvas = createCanvas(args.render_width_px, args.render_height_px);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, args.render_width_px, args.render_height_px);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(
    0,
    0,
    args.render_width_px,
    args.render_height_px
  ).data;
  const hasDarkPixelNear = (x: number, y: number): boolean => {
    // Structured vision returns normalized vertices rounded to a few decimal
    // places. Use a small resolution-relative corridor so sub-percent rounding,
    // antialiasing, and wall lineweight do not turn a supported edge into a
    // false negative.
    const radius = Math.max(
      2,
      Math.min(6, Math.round(Math.min(args.render_width_px, args.render_height_px) * 0.006))
    );
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const px = Math.max(
          0,
          Math.min(args.render_width_px - 1, Math.round(x + dx))
        );
        const py = Math.max(
          0,
          Math.min(args.render_height_px - 1, Math.round(y + dy))
        );
        const index = (py * args.render_width_px + px) * 4;
        const luminance =
          (0.2126 * pixels[index]! +
            0.7152 * pixels[index + 1]! +
            0.0722 * pixels[index + 2]!) /
          255;
        if (luminance < 0.75) return true;
      }
    }
    return false;
  };
  const edgeSupportRatios = polygon.map((start, index) => {
    const end = polygon[(index + 1) % polygon.length]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(2, Math.ceil(length / 2));
    let supported = 0;
    for (let step = 0; step <= steps; step++) {
      const ratio = step / steps;
      if (
        hasDarkPixelNear(
          start.x + ratio * (end.x - start.x),
          start.y + ratio * (end.y - start.y)
        )
      ) {
        supported++;
      }
    }
    return supported / (steps + 1);
  });
  const meanEdgeSupportRatio =
    edgeSupportRatios.reduce((sum, value) => sum + value, 0) /
    edgeSupportRatios.length;
  const minimumEdgeSupportRatio = Math.min(...edgeSupportRatios);
  return {
    accepted:
      polygonAreaRatio <= maximumPolygonAreaRatio &&
      meanEdgeSupportRatio >= minimumMeanEdgeSupportRatio &&
      minimumEdgeSupportRatio >= minimumEachEdgeSupportRatio,
    polygon_area_ratio: rounded(polygonAreaRatio),
    edge_support_ratios: edgeSupportRatios.map((value) => rounded(value)),
    mean_edge_support_ratio: rounded(meanEdgeSupportRatio),
    minimum_edge_support_ratio: rounded(minimumEdgeSupportRatio),
    maximum_polygon_area_ratio: maximumPolygonAreaRatio,
    minimum_mean_edge_support_ratio: minimumMeanEdgeSupportRatio,
    minimum_each_edge_support_ratio: minimumEachEdgeSupportRatio
  };
}

type CandidateVisibleChromaticRouteHint = {
  name: string;
  rgb: { r: number; g: number; b: number };
};

type CandidateVisibleAxisTrace = {
  component_id: string;
  axis: "horizontal" | "vertical";
  start: ExistingConditionsPlanPoint;
  end: ExistingConditionsPlanPoint;
  length_px: number;
};

function candidateVisibleChromaticRouteHint(
  observation: RegisteredMepPixelObservation
): CandidateVisibleChromaticRouteHint | null {
  const semanticText = JSON.stringify(observation).toLowerCase();
  const colors: CandidateVisibleChromaticRouteHint[] = [
    { name: "blue", rgb: { r: 0, g: 0, b: 128 } },
    { name: "orange", rgb: { r: 255, g: 128, b: 0 } },
    { name: "green", rgb: { r: 0, g: 160, b: 0 } },
    { name: "red", rgb: { r: 200, g: 0, b: 0 } },
    { name: "cyan", rgb: { r: 0, g: 170, b: 200 } },
    { name: "purple", rgb: { r: 128, g: 0, b: 160 } },
    { name: "magenta", rgb: { r: 200, g: 0, b: 160 } },
    { name: "yellow", rgb: { r: 220, g: 200, b: 0 } }
  ];
  return colors.find((entry) =>
    new RegExp(`\\b${entry.name}\\b`, "i").test(semanticText)
  ) ?? null;
}

function candidateVisibleHueDegrees(rgb: { r: number; g: number; b: number }): number {
  const maximum = Math.max(rgb.r, rgb.g, rgb.b);
  const minimum = Math.min(rgb.r, rgb.g, rgb.b);
  const chroma = maximum - minimum;
  if (chroma <= 0) return 0;
  let hue = 0;
  if (maximum === rgb.r) {
    hue = 60 * (((rgb.g - rgb.b) / chroma) % 6);
  } else if (maximum === rgb.g) {
    hue = 60 * ((rgb.b - rgb.r) / chroma + 2);
  } else {
    hue = 60 * ((rgb.r - rgb.g) / chroma + 4);
  }
  return hue < 0 ? hue + 360 : hue;
}

function candidateVisibleAxisTraces(
  receipt: PlanTraceExtractionReceipt
): CandidateVisibleAxisTrace[] {
  return receipt.components.flatMap((component) =>
    component.polylines.flatMap((polyline) => {
      if (polyline.closed || polyline.points.length < 2 || polyline.length_px < 4) {
        return [];
      }
      const start = polyline.points[0]!;
      const end = polyline.points[polyline.points.length - 1]!;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const directLength = Math.hypot(dx, dy);
      if (directLength <= 0 || polyline.length_px / directLength > 1.2) return [];
      const horizontal = Math.abs(dx) >= Math.abs(dy) * 4;
      const vertical = Math.abs(dy) >= Math.abs(dx) * 4;
      if (!horizontal && !vertical) return [];
      return [{
        component_id: component.component_id,
        axis: horizontal ? "horizontal" as const : "vertical" as const,
        start,
        end,
        length_px: polyline.length_px
      }];
    })
  );
}

function candidateVisibleChromaticRetraceProposal(args: {
  receipt: PlanTraceExtractionReceipt;
  target_color: string;
  width: number;
  height: number;
  reference_points: ExistingConditionsPlanPoint[];
}): CandidateVisibleRouteRasterVerification["retrace_proposal"] | undefined {
  if (args.reference_points.length < 2) return undefined;
  const corridorRadiusPx = Math.max(
    12,
    Math.min(50, Math.hypot(args.width, args.height) * 0.06)
  );
  const traceReferenceMetrics = (
    trace: CandidateVisibleAxisTrace
  ): {
    maximum_distance_px: number;
    longitudinal_overlap_ratio: number;
  } => {
    const distanceToReference = (
      point: ExistingConditionsPlanPoint
    ): number => {
      let distance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < args.reference_points.length - 1; index++) {
        distance = Math.min(
          distance,
          pointDistanceToSegment(
            point,
            args.reference_points[index]!,
            args.reference_points[index + 1]!
          )
        );
      }
      return distance;
    };
    const traceSamples = Array.from({ length: 9 }, (_, index) => {
      const ratio = index / 8;
      return {
        x: trace.start.x + ratio * (trace.end.x - trace.start.x),
        y: trace.start.y + ratio * (trace.end.y - trace.start.y)
      };
    });
    const maximumDistancePx = Math.max(
      ...traceSamples.map(distanceToReference)
    );
    const axisCoordinate = (point: ExistingConditionsPlanPoint): number =>
      trace.axis === "horizontal" ? point.x : point.y;
    const traceCoordinates = [
      axisCoordinate(trace.start),
      axisCoordinate(trace.end)
    ];
    const referenceCoordinates =
      args.reference_points.map(axisCoordinate);
    const traceMin = Math.min(...traceCoordinates);
    const traceMax = Math.max(...traceCoordinates);
    const referenceMin = Math.min(...referenceCoordinates);
    const referenceMax = Math.max(...referenceCoordinates);
    const overlap = Math.max(
      0,
      Math.min(traceMax, referenceMax) - Math.max(traceMin, referenceMin)
    );
    const denominator = Math.max(
      1,
      Math.min(traceMax - traceMin, referenceMax - referenceMin)
    );
    return {
      maximum_distance_px: maximumDistancePx,
      longitudinal_overlap_ratio: overlap / denominator
    };
  };
  const localTraces = candidateVisibleAxisTraces(args.receipt)
    .map((trace) => ({ ...trace, ...traceReferenceMetrics(trace) }))
    .filter((trace) =>
      trace.maximum_distance_px <= corridorRadiusPx &&
      trace.longitudinal_overlap_ratio >= 0.35
    );
  if (localTraces.length === 0) return undefined;
  const referenceGeometrySha256 = sha256Json(
    args.reference_points.map((point) => ({
      x: rounded(point.x),
      y: rounded(point.y)
    }))
  );
  const traces = localTraces;
  const horizontals = traces.filter((entry) => entry.axis === "horizontal");
  const verticals = traces.filter((entry) =>
    entry.axis === "vertical" && entry.length_px >= 20
  );
  const maximumJoinGapPx = Math.max(
    12,
    Math.min(36, Math.hypot(args.width, args.height) * 0.035)
  );
  const patternCandidates: Array<{
    vertical: (typeof verticals)[number];
    upper: Array<(typeof horizontals)[number]>;
    lower: Array<(typeof horizontals)[number]>;
    score: number;
    maximum_distance_px: number;
  }> = [];
  for (const vertical of verticals) {
    const verticalX = (vertical.start.x + vertical.end.x) / 2;
    const topY = Math.min(vertical.start.y, vertical.end.y);
    const bottomY = Math.max(vertical.start.y, vertical.end.y);
    const joins = (targetY: number) => horizontals.filter((horizontal) => {
      if (horizontal.component_id !== vertical.component_id) return false;
      const horizontalY = (horizontal.start.y + horizontal.end.y) / 2;
      const minX = Math.min(horizontal.start.x, horizontal.end.x);
      const maxX = Math.max(horizontal.start.x, horizontal.end.x);
      return (
        Math.abs(horizontalY - targetY) <= maximumJoinGapPx &&
        verticalX >= minX - maximumJoinGapPx &&
        verticalX <= maxX + maximumJoinGapPx
      );
    });
    const upper = joins(topY);
    const lower = joins(bottomY);
    if (upper.length === 0 || lower.length === 0) continue;
    const maximumDistance = Math.max(
      vertical.maximum_distance_px,
      ...upper.map((entry) => entry.maximum_distance_px),
      ...lower.map((entry) => entry.maximum_distance_px)
    );
    const score =
      vertical.length_px +
      Math.max(...upper.map((entry) => entry.length_px)) +
      Math.max(...lower.map((entry) => entry.length_px)) -
      maximumDistance * 2;
    patternCandidates.push({
      vertical,
      upper,
      lower,
      score,
      maximum_distance_px: maximumDistance
    });
  }
  patternCandidates.sort((left, right) =>
    right.score - left.score ||
    left.maximum_distance_px - right.maximum_distance_px ||
    left.vertical.component_id.localeCompare(right.vertical.component_id)
  );
  const best = patternCandidates[0];
  const patternRunnerUp = patternCandidates.find(
    (entry) =>
      entry.vertical.component_id !== best?.vertical.component_id
  );
  if (
    best &&
    patternRunnerUp &&
    best.score - patternRunnerUp.score <
      Math.max(10, Math.abs(best.score) * 0.12)
  ) {
    return undefined;
  }

  let pixelPoints: ExistingConditionsPlanPoint[] | null = null;
  let componentIds: string[] = [];
  let maximumReferenceDistancePx = Number.POSITIVE_INFINITY;
  let runnerUpScoreMargin: number | null = null;
  if (best) {
    const verticalX = rounded((best.vertical.start.x + best.vertical.end.x) / 2);
    const upperY = rounded(
      best.upper.reduce(
        (sum, entry) => sum + (entry.start.y + entry.end.y) / 2,
        0
      ) / best.upper.length
    );
    const lowerY = rounded(
      best.lower.reduce(
        (sum, entry) => sum + (entry.start.y + entry.end.y) / 2,
        0
      ) / best.lower.length
    );
    const upperMinX = Math.min(
      ...best.upper.flatMap((entry) => [entry.start.x, entry.end.x])
    );
    const lowerMaxX = Math.max(
      ...best.lower.flatMap((entry) => [entry.start.x, entry.end.x])
    );
    const localBranchSpanPx = Math.max(
      30,
      Math.min(120, Math.hypot(args.width, args.height) * 0.06)
    );
    const upperStartX = rounded(Math.max(upperMinX, verticalX - localBranchSpanPx));
    const lowerEndX = rounded(Math.min(lowerMaxX, verticalX + localBranchSpanPx));
    if (upperStartX < verticalX - 2 && lowerEndX > verticalX + 2) {
      pixelPoints = [
        { x: upperStartX, y: upperY },
        { x: verticalX, y: upperY },
        { x: verticalX, y: lowerY },
        { x: lowerEndX, y: lowerY }
      ];
      componentIds = [
        ...new Set([
          best.vertical.component_id,
          ...best.upper.map((entry) => entry.component_id),
          ...best.lower.map((entry) => entry.component_id)
        ])
      ];
      maximumReferenceDistancePx = Math.max(
        best.vertical.maximum_distance_px,
        ...best.upper.map((entry) => entry.maximum_distance_px),
        ...best.lower.map((entry) => entry.maximum_distance_px)
      );
      runnerUpScoreMargin = patternRunnerUp
        ? rounded(best.score - patternRunnerUp.score)
        : null;
    }
  }

  if (!pixelPoints) {
    const components = new Map<
      string,
      { traces: typeof traces; score: number; maximum_distance_px: number }
    >();
    for (const trace of traces) {
      const current = components.get(trace.component_id) ?? {
        traces: [],
        score: 0,
        maximum_distance_px: 0
      };
      current.traces.push(trace);
      current.score += trace.length_px - trace.maximum_distance_px;
      current.maximum_distance_px = Math.max(
        current.maximum_distance_px,
        trace.maximum_distance_px
      );
      components.set(trace.component_id, current);
    }
    const rankedComponents = [...components.entries()]
      .map(([component_id, value]) => ({ component_id, ...value }))
      .sort((left, right) =>
        right.score - left.score ||
        left.maximum_distance_px - right.maximum_distance_px ||
        left.component_id.localeCompare(right.component_id)
      );
    const winningComponent = rankedComponents[0];
    const runnerUp = rankedComponents[1];
    if (
      !winningComponent ||
      (
        runnerUp &&
        winningComponent.score - runnerUp.score <
          Math.max(8, Math.abs(winningComponent.score) * 0.15)
      )
    ) {
      return undefined;
    }
    const longest = winningComponent.traces
      .slice()
      .sort((left, right) =>
        right.length_px - left.length_px ||
        left.maximum_distance_px - right.maximum_distance_px
      )[0];
    if (!longest || longest.length_px < 8) return undefined;
    pixelPoints = [longest.start, longest.end];
    componentIds = [longest.component_id];
    maximumReferenceDistancePx = longest.maximum_distance_px;
    runnerUpScoreMargin = runnerUp
      ? rounded(winningComponent.score - runnerUp.score)
      : null;
  }
  return {
    basis: "hash_bound_chromatic_plan_trace",
    target_color: args.target_color,
    source_pixel_sha256: String(args.receipt.source_pixel_sha256 ?? ""),
    extraction_policy_sha256: args.receipt.extraction_policy_sha256,
    reference_geometry_sha256: referenceGeometrySha256,
    component_ids: componentIds,
    corridor_radius_px: rounded(corridorRadiusPx),
    maximum_reference_distance_px: rounded(maximumReferenceDistancePx),
    runner_up_score_margin: runnerUpScoreMargin,
    pixel_points: pixelPoints,
    normalized_uv_points: pixelPoints.map((point) => ({
      x: rounded(point.x / args.width),
      y: rounded(point.y / args.height)
    }))
  };
}

async function verifySourceRouteRaster(args: {
  registered_render_path: string;
  observations: RegisteredMepPixelObservation[];
  render_width_px: number;
  render_height_px: number;
}): Promise<CandidateVisibleRouteRasterVerification[]> {
  const image = await loadImage(args.registered_render_path);
  if (
    image.width !== args.render_width_px ||
    image.height !== args.render_height_px
  ) {
    return [];
  }
  const canvas = createCanvas(args.render_width_px, args.render_height_px);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, args.render_width_px, args.render_height_px);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(
    0,
    0,
    args.render_width_px,
    args.render_height_px
  ).data;
  const pixelBuffer: PlanTracePixelBuffer = {
    width: args.render_width_px,
    height: args.render_height_px,
    data: pixels
  };
  const sourcePixelSha256 = sha256PlanTracePixelBuffer(pixelBuffer);
  const sourceImageSha256 = sha256File(args.registered_render_path);
  const proposalByColor = new Map<
    string,
    CandidateVisibleRouteRasterVerification["retrace_proposal"]
  >();
  const proposalForObservation = (
    observation: RegisteredMepPixelObservation,
    referencePoints: ExistingConditionsPlanPoint[]
  ): CandidateVisibleRouteRasterVerification["retrace_proposal"] | undefined => {
    const hint = candidateVisibleChromaticRouteHint(observation);
    if (!hint) return undefined;
    const proposalKey = `${hint.name}:${sha256Json(referencePoints)}`;
    if (proposalByColor.has(proposalKey)) return proposalByColor.get(proposalKey);
    const receipt = extractPlanTracesFromPixels(pixelBuffer, {
      schema_version: 1,
      source_image_sha256: sourceImageSha256,
      source_pixel_sha256: sourcePixelSha256,
      target_rgb: hint.rgb,
      maximum_color_distance: 180,
      minimum_chroma: 40,
      minimum_alpha: 1,
      minimum_component_pixels: 5,
      simplify_tolerance_px: 2,
      interpretation_mode: "ink_centerline"
    });
    const proposal = candidateVisibleChromaticRetraceProposal({
      receipt,
      target_color: hint.name,
      width: args.render_width_px,
      height: args.render_height_px,
      reference_points: referencePoints
    });
    proposalByColor.set(proposalKey, proposal);
    return proposal;
  };
  const maximumSearchRadiusPx = 4;
  const hueBinCount = 24;
  const hueBinWidth = 360 / hueBinCount;
  const circularHueDistance = (left: number, right: number): number => {
    const distance = Math.abs(left - right);
    return Math.min(distance, hueBinCount - distance);
  };
  const nearbyEvidence = (x: number, y: number): {
    monochrome: boolean;
    hue_bins: Set<number>;
  } => {
    let monochrome = false;
    const hueBins = new Set<number>();
    for (let dx = -maximumSearchRadiusPx; dx <= maximumSearchRadiusPx; dx++) {
      for (let dy = -maximumSearchRadiusPx; dy <= maximumSearchRadiusPx; dy++) {
        if (dx * dx + dy * dy > maximumSearchRadiusPx * maximumSearchRadiusPx) {
          continue;
        }
        const px = Math.max(
          0,
          Math.min(args.render_width_px - 1, Math.round(x + dx))
        );
        const py = Math.max(
          0,
          Math.min(args.render_height_px - 1, Math.round(y + dy))
        );
        const index = (py * args.render_width_px + px) * 4;
        const red = pixels[index]!;
        const green = pixels[index + 1]!;
        const blue = pixels[index + 2]!;
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const chroma = maximum - minimum;
        const luminance =
          0.2126 * red +
          0.7152 * green +
          0.0722 * blue;
        if (luminance <= 0.82 * 255) monochrome = true;
        if (chroma < 40 || maximum < 45 || luminance > 0.97 * 255) continue;
        let hue = 0;
        if (maximum === red) {
          hue = 60 * (((green - blue) / chroma) % 6);
        } else if (maximum === green) {
          hue = 60 * ((blue - red) / chroma + 2);
        } else {
          hue = 60 * ((red - green) / chroma + 4);
        }
        if (hue < 0) hue += 360;
        hueBins.add(Math.floor(hue / hueBinWidth) % hueBinCount);
      }
    }
    return { monochrome, hue_bins: hueBins };
  };
  const geometryEntries = args.observations.flatMap((observation, index) => {
    const raw = observation as unknown as Record<string, unknown>;
    const observationId = String(
      raw.observation_id ?? `candidate_visible_${index + 1}`
    ).trim();
    const placement = raw.placement && typeof raw.placement === "object"
      ? raw.placement as Record<string, unknown>
      : null;
    const routePoints = (Array.isArray(raw.pixel_points) ? raw.pixel_points : [])
      .map(normalizePoint)
      .filter((point): point is ExistingConditionsPlanPoint => point !== null);
    const branchPoints = (
      Array.isArray(placement?.pixel_branch_points)
        ? placement.pixel_branch_points
        : []
    )
      .map(normalizePoint)
      .filter((point): point is ExistingConditionsPlanPoint => point !== null);
    return [
      ...(routePoints.length >= 2
        ? [{
            observation_id: observationId,
            geometry_role: "route" as const,
            points: routePoints,
            observation
          }]
        : []),
      ...(branchPoints.length >= 2
        ? [{
            observation_id: observationId,
            geometry_role: "placement_branch" as const,
            points: branchPoints,
            observation
          }]
        : [])
    ];
  });
  return geometryEntries.map((entry) => {
    const explicitColorHint = candidateVisibleChromaticRouteHint(entry.observation);
    const segmentSamples = entry.points.slice(0, -1).map((start, index) => {
      const end = entry.points[index + 1]!;
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const steps = Math.max(2, Math.ceil(length / 2));
      return Array.from({ length: steps + 1 }, (_, step) => {
        const ratio = step / steps;
        return nearbyEvidence(
          start.x + ratio * (end.x - start.x),
          start.y + ratio * (end.y - start.y)
        );
      });
    });
    const allSamples = segmentSamples.flat();
    const hueSupportCounts = Array.from({ length: hueBinCount }, (_, hueBin) =>
      allSamples.filter((sample) =>
        [...sample.hue_bins].some((sampleBin) =>
          circularHueDistance(sampleBin, hueBin) <= 1
        )
      ).length
    );
    const coherentHueBin = explicitColorHint
      ? Math.floor(candidateVisibleHueDegrees(explicitColorHint.rgb) / hueBinWidth) %
        hueBinCount
      : hueSupportCounts.reduce(
          (best, count, hueBin) =>
            count > hueSupportCounts[best]! ? hueBin : best,
          0
        );
    const chromaticSegmentSupportRatios = segmentSamples.map((samples) =>
      samples.filter((sample) =>
        [...sample.hue_bins].some((sampleBin) =>
          circularHueDistance(sampleBin, coherentHueBin) <= 1
        )
      ).length / Math.max(1, samples.length)
    );
    const monochromeSegmentSupportRatios = segmentSamples.map((samples) =>
      samples.filter((sample) => sample.monochrome).length /
        Math.max(1, samples.length)
    );
    const mean = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) /
      Math.max(1, values.length);
    const chromaticMeanSupportRatio = mean(chromaticSegmentSupportRatios);
    const monochromeMeanSupportRatio = mean(monochromeSegmentSupportRatios);
    const supportModality =
      explicitColorHint || chromaticMeanSupportRatio >= 0.45
        ? "chromatic_line" as const
        : "monochrome_line" as const;
    const segmentSupportRatios =
      supportModality === "chromatic_line"
        ? chromaticSegmentSupportRatios
        : monochromeSegmentSupportRatios;
    const minimumMeanSupportRatio =
      supportModality === "chromatic_line" ? 0.8 : 0.55;
    const minimumEachSegmentSupportRatio =
      supportModality === "chromatic_line" ? 0.6 : 0.25;
    const meanSupportRatio = mean(segmentSupportRatios);
    const minimumSegmentSupportRatio = Math.min(...segmentSupportRatios);
    const accepted =
      meanSupportRatio >= minimumMeanSupportRatio &&
      minimumSegmentSupportRatio >= minimumEachSegmentSupportRatio;
    return {
      observation_id: entry.observation_id,
      geometry_role: entry.geometry_role,
      accepted,
      support_modality: supportModality,
      sample_count: allSamples.length,
      segment_support_ratios: segmentSupportRatios.map((value) => rounded(value)),
      mean_support_ratio: rounded(meanSupportRatio),
      minimum_segment_support_ratio: rounded(minimumSegmentSupportRatio),
      chromatic_segment_support_ratios:
        chromaticSegmentSupportRatios.map((value) => rounded(value)),
      chromatic_mean_support_ratio: rounded(chromaticMeanSupportRatio),
      monochrome_segment_support_ratios:
        monochromeSegmentSupportRatios.map((value) => rounded(value)),
      monochrome_mean_support_ratio: rounded(monochromeMeanSupportRatio),
      maximum_search_radius_px: maximumSearchRadiusPx,
      minimum_mean_support_ratio: minimumMeanSupportRatio,
      minimum_each_segment_support_ratio: minimumEachSegmentSupportRatio,
      ...(supportModality === "chromatic_line"
        ? { coherent_hue_degrees: rounded(coherentHueBin * hueBinWidth) }
        : {}),
      ...(!accepted
        ? {
            retrace_proposal: proposalForObservation(
              entry.observation,
              entry.points
            )
          }
        : {})
    };
  });
}

function requireFile(filePath: string, label: string): string {
  const resolved = path.resolve(String(filePath ?? "").trim());
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label}_not_found:${resolved}`);
  }
  return resolved;
}

function mapFrameNormalizedPoint(
  frame: CandidateVisibleFrameMapping,
  normalizedX: number,
  normalizedY: number
): ExistingConditionsPlanPoint {
  const topLeft = point3(frame.top_left_xyz, "frame_top_left_xyz");
  const topRight = point3(frame.top_right_xyz, "frame_top_right_xyz");
  const bottomLeft = point3(frame.bottom_left_xyz, "frame_bottom_left_xyz");
  const x = clamp01(finite(normalizedX, "frame_normalized_x"));
  const y = clamp01(finite(normalizedY, "frame_normalized_y"));
  return {
    x: topLeft[0] + x * (topRight[0] - topLeft[0]) + y * (bottomLeft[0] - topLeft[0]),
    y: topLeft[1] + x * (topRight[1] - topLeft[1]) + y * (bottomLeft[1] - topLeft[1])
  };
}

function normalizedText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizePoint(value: unknown): ExistingConditionsPlanPoint | null {
  if (Array.isArray(value) && value.length >= 2) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function pointOnSegment(
  point: ExistingConditionsPlanPoint,
  start: ExistingConditionsPlanPoint,
  end: ExistingConditionsPlanPoint,
  tolerance = 1e-7
): boolean {
  const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x);
  if (Math.abs(cross) > tolerance) return false;
  const dot = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
  if (dot < -tolerance) return false;
  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  return dot <= lengthSquared + tolerance;
}

function pointInsidePolygonOrBoundary(
  point: ExistingConditionsPlanPoint,
  polygon: ExistingConditionsPlanPoint[]
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const start = polygon[previous]!;
    const end = polygon[index]!;
    if (pointOnSegment(point, start, end)) return true;
    if (
      (start.y > point.y) !== (end.y > point.y) &&
      point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonTwiceArea(polygon: ExistingConditionsPlanPoint[]): number {
  let area = 0;
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    area += current.x * next.y - next.x * current.y;
  }
  return area;
}

function orientation(
  first: ExistingConditionsPlanPoint,
  second: ExistingConditionsPlanPoint,
  third: ExistingConditionsPlanPoint
): number {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function segmentsIntersect(
  firstStart: ExistingConditionsPlanPoint,
  firstEnd: ExistingConditionsPlanPoint,
  secondStart: ExistingConditionsPlanPoint,
  secondEnd: ExistingConditionsPlanPoint
): boolean {
  const firstSecond = orientation(firstStart, firstEnd, secondStart);
  const firstThird = orientation(firstStart, firstEnd, secondEnd);
  const secondFirst = orientation(secondStart, secondEnd, firstStart);
  const secondThird = orientation(secondStart, secondEnd, firstEnd);
  if (
    ((firstSecond > 0 && firstThird < 0) || (firstSecond < 0 && firstThird > 0)) &&
    ((secondFirst > 0 && secondThird < 0) || (secondFirst < 0 && secondThird > 0))
  ) {
    return true;
  }
  return pointOnSegment(secondStart, firstStart, firstEnd) ||
    pointOnSegment(secondEnd, firstStart, firstEnd) ||
    pointOnSegment(firstStart, secondStart, secondEnd) ||
    pointOnSegment(firstEnd, secondStart, secondEnd);
}

function validateScopePolygon(
  value: unknown,
  width: number,
  height: number
): ExistingConditionsPlanPoint[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 128) {
    throw new Error("candidate_visible_scope_polygon_must_have_3_to_128_vertices");
  }
  let polygon = value.map((entry, index) => {
    const point = normalizePoint(entry);
    if (!point) throw new Error(`candidate_visible_scope_polygon_point_${index}_invalid`);
    if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) {
      throw new Error(`candidate_visible_scope_polygon_point_${index}_outside_render`);
    }
    return point;
  });
  // Accept the conventional explicitly closed polygon representation while
  // retaining the strict duplicate-vertex check for every interior edge.
  if (
    polygon.length > 3 &&
    Math.hypot(
      polygon[0]!.x - polygon[polygon.length - 1]!.x,
      polygon[0]!.y - polygon[polygon.length - 1]!.y
    ) <= 1e-7
  ) {
    polygon = polygon.slice(0, -1);
  }
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    if (Math.hypot(current.x - next.x, current.y - next.y) <= 1e-7) {
      throw new Error(`candidate_visible_scope_polygon_duplicate_consecutive_vertex:${index}`);
    }
    twiceArea += current.x * next.y - next.x * current.y;
  }
  if (Math.abs(twiceArea) <= 1e-7) throw new Error("candidate_visible_scope_polygon_has_zero_area");
  for (let first = 0; first < polygon.length; first += 1) {
    const firstNext = (first + 1) % polygon.length;
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondNext = (second + 1) % polygon.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (first === 0 && secondNext === 0) continue;
      if (segmentsIntersect(polygon[first]!, polygon[firstNext]!, polygon[second]!, polygon[secondNext]!)) {
        throw new Error(`candidate_visible_scope_polygon_self_intersects:${first}:${second}`);
      }
    }
  }
  return polygon;
}

function segmentBoundaryParameters(
  start: ExistingConditionsPlanPoint,
  end: ExistingConditionsPlanPoint,
  polygon: ExistingConditionsPlanPoint[]
): number[] {
  const routeX = end.x - start.x;
  const routeY = end.y - start.y;
  const routeLengthSquared = routeX * routeX + routeY * routeY;
  if (routeLengthSquared <= 1e-12) return [0, 1];
  const parameters = [0, 1];
  const addParameter = (value: number) => {
    const bounded = Math.max(0, Math.min(1, value));
    if (!parameters.some((entry) => Math.abs(entry - bounded) <= 1e-9)) {
      parameters.push(bounded);
    }
  };
  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index]!;
    const edgeEnd = polygon[(index + 1) % polygon.length]!;
    const edgeX = edgeEnd.x - edgeStart.x;
    const edgeY = edgeEnd.y - edgeStart.y;
    const offsetX = edgeStart.x - start.x;
    const offsetY = edgeStart.y - start.y;
    const cross = routeX * edgeY - routeY * edgeX;
    if (Math.abs(cross) <= 1e-9) {
      if (Math.abs(offsetX * routeY - offsetY * routeX) <= 1e-9) {
        addParameter((offsetX * routeX + offsetY * routeY) / routeLengthSquared);
        addParameter(((edgeEnd.x - start.x) * routeX + (edgeEnd.y - start.y) * routeY) / routeLengthSquared);
      }
      continue;
    }
    const routeParameter = (offsetX * edgeY - offsetY * edgeX) / cross;
    const edgeParameter = (offsetX * routeY - offsetY * routeX) / cross;
    if (
      routeParameter >= -1e-9 && routeParameter <= 1 + 1e-9 &&
      edgeParameter >= -1e-9 && edgeParameter <= 1 + 1e-9
    ) {
      addParameter(routeParameter);
    }
  }
  return parameters.sort((left, right) => left - right);
}

function routeContainedInScope(
  points: ExistingConditionsPlanPoint[],
  polygon: ExistingConditionsPlanPoint[],
  tolerance = 0
): boolean {
  const inside = (point: ExistingConditionsPlanPoint) =>
    tolerance > 0
      ? pointInsidePolygonOrNearBoundary(point, polygon, tolerance)
      : pointInsidePolygonOrBoundary(point, polygon);
  if (points.length === 0 || !points.every(inside)) return false;
  for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
    const start = points[pointIndex]!;
    const end = points[pointIndex + 1]!;
    const parameters = segmentBoundaryParameters(start, end, polygon);
    for (let index = 0; index < parameters.length - 1; index += 1) {
      const parameter = (parameters[index]! + parameters[index + 1]!) / 2;
      if (!inside({
        x: start.x + (end.x - start.x) * parameter,
        y: start.y + (end.y - start.y) * parameter
      })) return false;
    }
  }
  return true;
}

function pointAtSegmentParameter(
  start: ExistingConditionsPlanPoint,
  end: ExistingConditionsPlanPoint,
  parameter: number
): ExistingConditionsPlanPoint {
  return {
    x: start.x + (end.x - start.x) * parameter,
    y: start.y + (end.y - start.y) * parameter
  };
}

function samePoint(
  left: ExistingConditionsPlanPoint,
  right: ExistingConditionsPlanPoint,
  tolerance = 1e-7
): boolean {
  return Math.hypot(left.x - right.x, left.y - right.y) <= tolerance;
}

function polylineLength(points: ExistingConditionsPlanPoint[]): number {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    length += Math.hypot(
      points[index + 1]!.x - points[index]!.x,
      points[index + 1]!.y - points[index]!.y
    );
  }
  return length;
}

function clipPolylineToPolygon(
  points: ExistingConditionsPlanPoint[],
  polygon: ExistingConditionsPlanPoint[]
): ExistingConditionsPlanPoint[][] {
  const parts: ExistingConditionsPlanPoint[][] = [];
  let activePart: ExistingConditionsPlanPoint[] | null = null;
  for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
    const start = points[pointIndex]!;
    const end = points[pointIndex + 1]!;
    const parameters = segmentBoundaryParameters(start, end, polygon);
    for (let parameterIndex = 0; parameterIndex < parameters.length - 1; parameterIndex += 1) {
      const intervalStart = parameters[parameterIndex]!;
      const intervalEnd = parameters[parameterIndex + 1]!;
      if (intervalEnd - intervalStart <= 1e-9) continue;
      const midpoint = pointAtSegmentParameter(start, end, (intervalStart + intervalEnd) / 2);
      if (!pointInsidePolygonOrBoundary(midpoint, polygon)) {
        activePart = null;
        continue;
      }
      const clippedStart = pointAtSegmentParameter(start, end, intervalStart);
      const clippedEnd = pointAtSegmentParameter(start, end, intervalEnd);
      if (!activePart || !samePoint(activePart[activePart.length - 1]!, clippedStart)) {
        activePart = [clippedStart];
        parts.push(activePart);
      }
      if (!samePoint(activePart[activePart.length - 1]!, clippedEnd)) {
        activePart.push(clippedEnd);
      }
    }
  }
  return parts.filter((part) => part.length >= 2 && polylineLength(part) > 1e-7);
}

function clipCandidateVisibleRoutesToScope(
  payload: CandidateVisibleMepPlannerPayload,
  polygon: ExistingConditionsPlanPoint[],
  renderWidthPx: number,
  renderHeightPx: number,
  clippingBasis?: CandidateVisibleRouteClippingReceipt["clipping_basis"]
): CandidateVisibleRouteClippingReceipt[] {
  const receipts: CandidateVisibleRouteClippingReceipt[] = [];
  const scopeBounds = pointBounds(polygon);
  const normalizedBounds = (
    bounds: ReturnType<typeof pointBounds>
  ): string => [
    bounds.min.x / renderWidthPx,
    bounds.min.y / renderHeightPx,
    bounds.max.x / renderWidthPx,
    bounds.max.y / renderHeightPx
  ].map((value) => value.toFixed(4)).join(",");
  payload.observations = payload.observations.map((observation, index) => {
    const raw = observation as unknown as Record<string, unknown>;
    if (raw.kind === "electrical_circuit") return observation;
    const observationId = String(raw.observation_id ?? `candidate_visible_${index + 1}`).trim();
    let next = { ...raw };

    const clipGeometry = (
      geometryRole: CandidateVisibleRouteClippingReceipt["geometry_role"],
      value: unknown,
      outsideError: string
    ): ExistingConditionsPlanPoint[] | null => {
      if (!Array.isArray(value)) return null;
      const sourcePoints = value
        .map(normalizePoint)
        .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null);
      if (sourcePoints.length < 2 || routeContainedInScope(sourcePoints, polygon, 1e-7)) {
        return sourcePoints;
      }
      const parts = clipPolylineToPolygon(sourcePoints, polygon);
      if (parts.length === 0) {
        throw new Error(
          `${outsideError}:${observationId}` +
          `:zero_intersection` +
          `:source_uv_bounds=${normalizedBounds(pointBounds(sourcePoints))}` +
          `:authoritative_scope_uv_bounds=${normalizedBounds(scopeBounds)}` +
          ":reobserve_source_geometry_do_not_translate_to_fit"
        );
      }
      const rankedParts = parts
        .map((part, partIndex) => ({ part, partIndex, length: polylineLength(part) }))
        .sort((left, right) => right.length - left.length || left.partIndex - right.partIndex);
      const retained = rankedParts[0]!;
      receipts.push({
        observation_id: observationId,
        geometry_role: geometryRole,
        ...(clippingBasis ? { clipping_basis: clippingBasis } : {}),
        source_point_count: sourcePoints.length,
        retained_point_count: retained.part.length,
        source_length_px: polylineLength(sourcePoints),
        retained_length_px: retained.length,
        retained_part_index: retained.partIndex,
        retained_part_count: parts.length,
        dropped_part_count: Math.max(0, parts.length - 1),
        source_start_pixel_point: sourcePoints[0]!,
        source_end_pixel_point: sourcePoints[sourcePoints.length - 1]!,
        retained_start_pixel_point: retained.part[0]!,
        retained_end_pixel_point: retained.part[retained.part.length - 1]!
      });
      return retained.part;
    };

    const clippedRoute = clipGeometry(
      "route",
      raw.pixel_points,
      "candidate_visible_route_outside_spatial_scope"
    );
    if (clippedRoute && Array.isArray(raw.pixel_points)) {
      next = { ...next, pixel_points: clippedRoute };
    }
    const placement = raw.placement && typeof raw.placement === "object"
      ? raw.placement as Record<string, unknown>
      : null;
    const clippedBranch = clipGeometry(
      "placement_branch",
      placement?.pixel_branch_points,
      "candidate_visible_branch_outside_spatial_scope"
    );
    if (placement && clippedBranch && Array.isArray(placement.pixel_branch_points)) {
      next = {
        ...next,
        placement: {
          ...placement,
          pixel_branch_points: clippedBranch
        }
      };
    }
    return next as unknown as RegisteredMepPixelObservation;
  });
  return receipts;
}

function validateCandidateVisiblePointsToScope(
  payload: CandidateVisibleMepPlannerPayload,
  polygon: ExistingConditionsPlanPoint[],
  outsideError: string
): void {
  for (const [index, observation] of payload.observations.entries()) {
    const raw = observation as unknown as Record<string, unknown>;
    if (raw.kind === "electrical_circuit") continue;
    const point = normalizePoint(raw.pixel_point);
    if (!point) continue;
    const observationId = String(raw.observation_id ?? `candidate_visible_${index + 1}`).trim();
    if (!pointInsidePolygonOrBoundary(point, polygon)) {
      throw new Error(`${outsideError}:${observationId}`);
    }
  }
}

function pointDistanceToSegment(
  point: ExistingConditionsPlanPoint,
  start: ExistingConditionsPlanPoint,
  end: ExistingConditionsPlanPoint
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function pointInsidePolygonOrNearBoundary(
  point: ExistingConditionsPlanPoint,
  polygon: ExistingConditionsPlanPoint[],
  toleranceFt: number
): boolean {
  if (pointInsidePolygonOrBoundary(point, polygon)) return true;
  for (let index = 0; index < polygon.length; index++) {
    if (pointDistanceToSegment(point, polygon[index]!, polygon[(index + 1) % polygon.length]!) <= toleranceFt) {
      return true;
    }
  }
  return false;
}

function normalizeModelPolygon(
  value: unknown,
  label: string
): ExistingConditionsPlanPoint[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 256) {
    throw new Error(`${label}_must_have_3_to_256_vertices`);
  }
  const polygon = value.map((entry, index) => {
    const point = normalizePoint(entry);
    if (!point) throw new Error(`${label}_point_${index}_invalid`);
    return point;
  });
  if (Math.abs(polygonTwiceArea(polygon)) <= 1e-7) throw new Error(`${label}_has_zero_area`);
  return polygon;
}

function mapRegisteredRenderPointToModel(
  point: ExistingConditionsPlanPoint,
  renderWidthPx: number,
  renderHeightPx: number,
  registrationGeometry: ReturnType<typeof deriveCandidateVisibleRegistrationGeometry>
): ExistingConditionsPlanPoint {
  const [origin, xControl, yControl] = registrationGeometry.control_points;
  if (!origin || !xControl || !yControl) throw new Error("candidate_visible_registration_controls_missing");
  const u = point.x / renderWidthPx;
  const v = point.y / renderHeightPx;
  return {
    x: origin.model.x + u * (xControl.model.x - origin.model.x) + v * (yControl.model.x - origin.model.x),
    y: origin.model.y + u * (xControl.model.y - origin.model.y) + v * (yControl.model.y - origin.model.y)
  };
}

function mapModelPointToRegisteredRender(
  point: ExistingConditionsPlanPoint,
  renderWidthPx: number,
  renderHeightPx: number,
  registrationGeometry: ReturnType<typeof deriveCandidateVisibleRegistrationGeometry>
): ExistingConditionsPlanPoint {
  const [origin, xControl, yControl] = registrationGeometry.control_points;
  if (!origin || !xControl || !yControl) throw new Error("candidate_visible_registration_controls_missing");
  const xBasis = {
    x: xControl.model.x - origin.model.x,
    y: xControl.model.y - origin.model.y
  };
  const yBasis = {
    x: yControl.model.x - origin.model.x,
    y: yControl.model.y - origin.model.y
  };
  const determinant = xBasis.x * yBasis.y - xBasis.y * yBasis.x;
  if (Math.abs(determinant) <= 1e-12) throw new Error("candidate_visible_registration_controls_degenerate");
  const delta = {
    x: point.x - origin.model.x,
    y: point.y - origin.model.y
  };
  const u = (delta.x * yBasis.y - delta.y * yBasis.x) / determinant;
  const v = (xBasis.x * delta.y - xBasis.y * delta.x) / determinant;
  return {
    x: u * renderWidthPx,
    y: v * renderHeightPx
  };
}

function clipPolygonToRegisteredRender(
  polygon: ExistingConditionsPlanPoint[],
  width: number,
  height: number
): ExistingConditionsPlanPoint[] {
  type Boundary = {
    inside: (point: ExistingConditionsPlanPoint) => boolean;
    intersect: (
      start: ExistingConditionsPlanPoint,
      end: ExistingConditionsPlanPoint
    ) => ExistingConditionsPlanPoint;
  };
  const boundaries: Boundary[] = [
    {
      inside: (point) => point.x >= 0,
      intersect: (start, end) => {
        const ratio = (0 - start.x) / (end.x - start.x);
        return { x: 0, y: start.y + ratio * (end.y - start.y) };
      }
    },
    {
      inside: (point) => point.x <= width,
      intersect: (start, end) => {
        const ratio = (width - start.x) / (end.x - start.x);
        return { x: width, y: start.y + ratio * (end.y - start.y) };
      }
    },
    {
      inside: (point) => point.y >= 0,
      intersect: (start, end) => {
        const ratio = (0 - start.y) / (end.y - start.y);
        return { x: start.x + ratio * (end.x - start.x), y: 0 };
      }
    },
    {
      inside: (point) => point.y <= height,
      intersect: (start, end) => {
        const ratio = (height - start.y) / (end.y - start.y);
        return { x: start.x + ratio * (end.x - start.x), y: height };
      }
    }
  ];
  let clipped = polygon.slice();
  for (const boundary of boundaries) {
    if (clipped.length === 0) break;
    const output: ExistingConditionsPlanPoint[] = [];
    let previous = clipped[clipped.length - 1]!;
    let previousInside = boundary.inside(previous);
    for (const current of clipped) {
      const currentInside = boundary.inside(current);
      if (currentInside !== previousInside) {
        output.push(boundary.intersect(previous, current));
      }
      if (currentInside) output.push(current);
      previous = current;
      previousInside = currentInside;
    }
    clipped = output;
  }
  const deduplicated = clipped.filter((point, index, entries) => {
    const previous = entries[(index + entries.length - 1) % entries.length];
    return !previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 1e-7;
  });
  if (deduplicated.length < 3 || Math.abs(polygonTwiceArea(deduplicated)) <= 1e-7) {
    throw new Error("candidate_visible_verified_room_scope_not_visible_in_registered_render");
  }
  return deduplicated;
}

function projectedNativeRoomPixelPolygon(args: {
  native_room_polygon: ExistingConditionsPlanPoint[];
  render_width_px: number;
  render_height_px: number;
  registration_geometry: ReturnType<typeof deriveCandidateVisibleRegistrationGeometry>;
}): ExistingConditionsPlanPoint[] {
  return clipPolygonToRegisteredRender(
    args.native_room_polygon.map((point) => mapModelPointToRegisteredRender(
      point,
      args.render_width_px,
      args.render_height_px,
      args.registration_geometry
    )),
    args.render_width_px,
    args.render_height_px
  );
}

function polygonAnchor(
  polygon: ExistingConditionsPlanPoint[]
): ExistingConditionsPlanPoint {
  const twiceArea = polygonTwiceArea(polygon);
  if (Math.abs(twiceArea) > 1e-7) {
    let x = 0;
    let y = 0;
    for (let index = 0; index < polygon.length; index++) {
      const current = polygon[index]!;
      const next = polygon[(index + 1) % polygon.length]!;
      const cross = current.x * next.y - next.x * current.y;
      x += (current.x + next.x) * cross;
      y += (current.y + next.y) * cross;
    }
    const candidate = {
      x: x / (3 * twiceArea),
      y: y / (3 * twiceArea)
    };
    if (pointInsidePolygonOrBoundary(candidate, polygon)) return candidate;
  }
  const first = polygon[0]!;
  const second = polygon[1]!;
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2
  };
}

function pointBounds(points: ExistingConditionsPlanPoint[]): {
  min: ExistingConditionsPlanPoint;
  max: ExistingConditionsPlanPoint;
} {
  return {
    min: {
      x: Math.min(...points.map((point) => point.x)),
      y: Math.min(...points.map((point) => point.y))
    },
    max: {
      x: Math.max(...points.map((point) => point.x)),
      y: Math.max(...points.map((point) => point.y))
    }
  };
}

function normalizedPolygon(
  polygon: ExistingConditionsPlanPoint[],
  flipX: boolean,
  flipY: boolean
): ExistingConditionsPlanPoint[] {
  const bounds = pointBounds(polygon);
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  if (width <= 1e-7 || height <= 1e-7) throw new Error("candidate_visible_room_shape_bounds_degenerate");
  return polygon.map((point) => {
    let x = (point.x - bounds.min.x) / width;
    let y = (point.y - bounds.min.y) / height;
    if (flipX) x = 1 - x;
    if (flipY) y = 1 - y;
    return { x, y };
  });
}

function polygonArea(points: ExistingConditionsPlanPoint[]): number {
  return Math.abs(polygonTwiceArea(points)) / 2;
}

function primaryOrthogonalEnclosureContainingPoint(
  polygon: ExistingConditionsPlanPoint[],
  anchor: ExistingConditionsPlanPoint,
  targetAspectRatio: number
): ExistingConditionsPlanPoint[] | null {
  if (!Number.isFinite(targetAspectRatio) || targetAspectRatio <= 0) return null;
  const uniqueCoordinates = (values: number[]): number[] => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted.filter(
      (value, index) => index === 0 || Math.abs(value - sorted[index - 1]!) > 1e-5
    );
  };
  const xs = uniqueCoordinates(polygon.map((point) => point.x));
  const ys = uniqueCoordinates(polygon.map((point) => point.y));
  let best: {
    polygon: ExistingConditionsPlanPoint[];
    area: number;
    anchor_center_distance: number;
  } | null = null;
  for (let xIndex = 0; xIndex < xs.length - 1; xIndex++) {
    const minX = xs[xIndex]!;
    for (let xEndIndex = xIndex + 1; xEndIndex < xs.length; xEndIndex++) {
      const maxX = xs[xEndIndex]!;
      if (anchor.x < minX - 1e-5 || anchor.x > maxX + 1e-5) continue;
      for (let yIndex = 0; yIndex < ys.length - 1; yIndex++) {
        const minY = ys[yIndex]!;
        for (let yEndIndex = yIndex + 1; yEndIndex < ys.length; yEndIndex++) {
          const maxY = ys[yEndIndex]!;
          if (anchor.y < minY - 1e-5 || anchor.y > maxY + 1e-5) continue;
          const area = (maxX - minX) * (maxY - minY);
          if (area <= 1e-7 || (best && area < best.area - 1e-7)) continue;
          const aspectRatio = (maxX - minX) / (maxY - minY);
          if (Math.abs(Math.log(aspectRatio / targetAspectRatio)) > 0.18) continue;
          const samples: ExistingConditionsPlanPoint[] = [];
          for (let xStep = 0; xStep <= 4; xStep++) {
            for (let yStep = 0; yStep <= 4; yStep++) {
              samples.push({
                x: minX + (maxX - minX) * xStep / 4,
                y: minY + (maxY - minY) * yStep / 4
              });
            }
          }
          if (!samples.every((point) =>
            pointInsidePolygonOrNearBoundary(point, polygon, 1e-4)
          )) continue;
          const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
          const anchorCenterDistance = Math.hypot(
            anchor.x - center.x,
            anchor.y - center.y
          );
          if (
            best &&
            Math.abs(area - best.area) <= 1e-7 &&
            anchorCenterDistance >= best.anchor_center_distance - 1e-7
          ) continue;
          best = {
            polygon: [
              { x: minX, y: minY },
              { x: maxX, y: minY },
              { x: maxX, y: maxY },
              { x: minX, y: maxY }
            ],
            area,
            anchor_center_distance: anchorCenterDistance
          };
        }
      }
    }
  }
  return best?.polygon ?? null;
}

function pointToPolygonBoundaryDistance(
  point: ExistingConditionsPlanPoint,
  polygon: ExistingConditionsPlanPoint[]
): number {
  return Math.min(...polygon.map((start, index) =>
    pointDistanceToSegment(point, start, polygon[(index + 1) % polygon.length]!)
  ));
}

function sampledPolygonBoundary(
  polygon: ExistingConditionsPlanPoint[],
  maximumStep = 0.04
): ExistingConditionsPlanPoint[] {
  const samples: ExistingConditionsPlanPoint[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const start = polygon[index]!;
    const end = polygon[(index + 1) % polygon.length]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(length / maximumStep));
    for (let step = 0; step < steps; step++) {
      const ratio = step / steps;
      samples.push({
        x: start.x + ratio * (end.x - start.x),
        y: start.y + ratio * (end.y - start.y)
      });
    }
  }
  return samples;
}

function symmetricPolygonBoundaryHausdorff(
  left: ExistingConditionsPlanPoint[],
  right: ExistingConditionsPlanPoint[]
): number {
  const directed = (
    source: ExistingConditionsPlanPoint[],
    target: ExistingConditionsPlanPoint[]
  ): number => Math.max(...sampledPolygonBoundary(source).map((point) =>
    pointToPolygonBoundaryDistance(point, target)
  ));
  return Math.max(directed(left, right), directed(right, left));
}

function verifySourceRoomShape(args: {
  source_polygon: ExistingConditionsPlanPoint[];
  native_room_polygon: ExistingConditionsPlanPoint[];
  submitted_anchor: ExistingConditionsPlanPoint;
  source_room_label_anchor: CandidateVisibleSourceRoomLabelAnchor;
  render_width_px: number;
  render_height_px: number;
}): CandidateVisibleSourceRoomShapeVerification {
  const maximumAnchorDistance = Math.max(
    6,
    Math.min(12, Math.hypot(args.render_width_px, args.render_height_px) * 0.01)
  );
  const anchorDistance = Math.hypot(
    args.submitted_anchor.x - args.source_room_label_anchor.pixel_point.x,
    args.submitted_anchor.y - args.source_room_label_anchor.pixel_point.y
  );
  const source = normalizedPolygon(args.source_polygon, false, false);
  const sourceArea = polygonArea(source);
  const candidates = [
    { transform: "identity" as const, polygon: normalizedPolygon(args.native_room_polygon, false, false) },
    { transform: "flip_x" as const, polygon: normalizedPolygon(args.native_room_polygon, true, false) },
    { transform: "flip_y" as const, polygon: normalizedPolygon(args.native_room_polygon, false, true) },
    { transform: "flip_xy" as const, polygon: normalizedPolygon(args.native_room_polygon, true, true) }
  ].map((entry) => ({
    ...entry,
    hausdorff: symmetricPolygonBoundaryHausdorff(source, entry.polygon),
    areaDifference: Math.abs(sourceArea - polygonArea(entry.polygon))
  })).sort((left, right) =>
    left.hausdorff - right.hausdorff ||
    left.areaDifference - right.areaDifference ||
    left.transform.localeCompare(right.transform)
  );
  const best = candidates[0]!;
  const identity = candidates.find((entry) => entry.transform === "identity")!;
  const maximumHausdorff = 0.15;
  const maximumAreaDifference = 0.12;
  const identityIsNotWorseThanReflection =
    identity.hausdorff <= best.hausdorff + 1e-6 &&
    identity.areaDifference <= best.areaDifference + 1e-6;
  const reported = identityIsNotWorseThanReflection ? identity : best;
  const labelBoundsPadding = 6;
  const anchorInsidePaddedLabelBounds =
    args.submitted_anchor.x >=
      args.source_room_label_anchor.pixel_bounds.min.x - labelBoundsPadding &&
    args.submitted_anchor.x <=
      args.source_room_label_anchor.pixel_bounds.max.x + labelBoundsPadding &&
    args.submitted_anchor.y >=
      args.source_room_label_anchor.pixel_bounds.min.y - labelBoundsPadding &&
    args.submitted_anchor.y <=
      args.source_room_label_anchor.pixel_bounds.max.y + labelBoundsPadding;
  return {
    accepted:
      anchorInsidePaddedLabelBounds &&
      pointInsidePolygonOrBoundary(args.source_room_label_anchor.pixel_point, args.source_polygon) &&
      identityIsNotWorseThanReflection &&
      identity.hausdorff <= maximumHausdorff &&
      identity.areaDifference <= maximumAreaDifference,
    source_room_label_text: args.source_room_label_anchor.text,
    source_room_label_pixel_point: args.source_room_label_anchor.pixel_point,
    source_room_label_pixel_bounds: args.source_room_label_anchor.pixel_bounds,
    source_render_mean_absolute_luminance_difference: rounded(
      args.source_room_label_anchor.source_render_mean_absolute_luminance_difference
    ),
    maximum_source_render_mean_absolute_luminance_difference: 0.08,
    submitted_anchor_distance_px: rounded(anchorDistance),
    maximum_anchor_distance_px: rounded(maximumAnchorDistance),
    normalized_symmetric_hausdorff: rounded(reported.hausdorff),
    maximum_normalized_symmetric_hausdorff: maximumHausdorff,
    normalized_area_difference: rounded(reported.areaDifference),
    maximum_normalized_area_difference: maximumAreaDifference,
    matched_transform: reported.transform
  };
}

function sourceRoomAnchorMatchesLocatedLabel(args: {
  source_polygon: ExistingConditionsPlanPoint[];
  submitted_anchor: ExistingConditionsPlanPoint;
  source_room_label_anchor: CandidateVisibleSourceRoomLabelAnchor;
  render_width_px: number;
  render_height_px: number;
}): boolean {
  const maximumAnchorDistance = Math.max(
    6,
    Math.min(12, Math.hypot(args.render_width_px, args.render_height_px) * 0.01)
  );
  const labelBoundsPadding = 6;
  const anchorDistance = Math.hypot(
    args.submitted_anchor.x - args.source_room_label_anchor.pixel_point.x,
    args.submitted_anchor.y - args.source_room_label_anchor.pixel_point.y
  );
  return (
    anchorDistance <= maximumAnchorDistance &&
    args.submitted_anchor.x >=
      args.source_room_label_anchor.pixel_bounds.min.x - labelBoundsPadding &&
    args.submitted_anchor.x <=
      args.source_room_label_anchor.pixel_bounds.max.x + labelBoundsPadding &&
    args.submitted_anchor.y >=
      args.source_room_label_anchor.pixel_bounds.min.y - labelBoundsPadding &&
    args.submitted_anchor.y <=
      args.source_room_label_anchor.pixel_bounds.max.y + labelBoundsPadding &&
    pointInsidePolygonOrBoundary(
      args.source_room_label_anchor.pixel_point,
      args.source_polygon
    )
  );
}

function boundsIntersectionRatio(
  left: ReturnType<typeof pointBounds>,
  right: ReturnType<typeof pointBounds>
): number {
  const overlapWidth = Math.max(0, Math.min(left.max.x, right.max.x) - Math.max(left.min.x, right.min.x));
  const overlapHeight = Math.max(0, Math.min(left.max.y, right.max.y) - Math.max(left.min.y, right.min.y));
  const overlapArea = overlapWidth * overlapHeight;
  const leftArea = Math.max(0, left.max.x - left.min.x) * Math.max(0, left.max.y - left.min.y);
  const rightArea = Math.max(0, right.max.x - right.min.x) * Math.max(0, right.max.y - right.min.y);
  const referenceArea = Math.min(leftArea, rightArea);
  return referenceArea > 1e-7 ? overlapArea / referenceArea : 0;
}

function remapCandidateVisiblePayloadFromRoomBounds(args: {
  payload: CandidateVisibleMepPlannerPayload;
  source_bounds: ReturnType<typeof pointBounds>;
  target_bounds: ReturnType<typeof pointBounds>;
}): { scale_x: number; scale_y: number } {
  const sourceWidth = args.source_bounds.max.x - args.source_bounds.min.x;
  const sourceHeight = args.source_bounds.max.y - args.source_bounds.min.y;
  const targetWidth = args.target_bounds.max.x - args.target_bounds.min.x;
  const targetHeight = args.target_bounds.max.y - args.target_bounds.min.y;
  if (
    sourceWidth <= 1e-7 ||
    sourceHeight <= 1e-7 ||
    targetWidth <= 1e-7 ||
    targetHeight <= 1e-7
  ) {
    throw new Error("candidate_visible_local_room_registration_bounds_degenerate");
  }
  const scaleX = targetWidth / sourceWidth;
  const scaleY = targetHeight / sourceHeight;
  const remapPoint = (value: unknown): ExistingConditionsPlanPoint | null => {
    const point = normalizePoint(value);
    if (!point) return null;
    return {
      x: args.target_bounds.min.x + (point.x - args.source_bounds.min.x) * scaleX,
      y: args.target_bounds.min.y + (point.y - args.source_bounds.min.y) * scaleY
    };
  };
  if (args.payload.spatial_scope) {
    args.payload.spatial_scope = {
      ...args.payload.spatial_scope,
      boundary_pixel_points: args.payload.spatial_scope.boundary_pixel_points
        .map(remapPoint)
        .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null),
      anchor_pixel_point:
        remapPoint(args.payload.spatial_scope.anchor_pixel_point) ??
        args.payload.spatial_scope.anchor_pixel_point
    };
  }
  args.payload.observations = args.payload.observations.map((observation) => {
    const raw = observation as unknown as Record<string, unknown>;
    const placement = raw.placement && typeof raw.placement === "object" && !Array.isArray(raw.placement)
      ? raw.placement as Record<string, unknown>
      : null;
    return {
      ...raw,
      ...(raw.pixel_point == null
        ? {}
        : { pixel_point: remapPoint(raw.pixel_point) ?? raw.pixel_point }),
      ...(Array.isArray(raw.pixel_points)
        ? {
            pixel_points: raw.pixel_points
              .map(remapPoint)
              .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null)
          }
        : {}),
      ...(placement
        ? {
            placement: {
              ...placement,
              ...(Array.isArray(placement.pixel_branch_points)
                ? {
                    pixel_branch_points: placement.pixel_branch_points
                      .map(remapPoint)
                      .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null)
                  }
                : {})
            }
          }
        : {})
    } as unknown as RegisteredMepPixelObservation;
  });
  return { scale_x: scaleX, scale_y: scaleY };
}

function translateCandidateVisiblePayload(args: {
  payload: CandidateVisibleMepPlannerPayload;
  delta_x_px: number;
  delta_y_px: number;
}): void {
  const translatePoint = (value: unknown): ExistingConditionsPlanPoint | null => {
    const point = normalizePoint(value);
    return point
      ? {
          x: point.x + args.delta_x_px,
          y: point.y + args.delta_y_px
        }
      : null;
  };
  if (args.payload.spatial_scope) {
    args.payload.spatial_scope = {
      ...args.payload.spatial_scope,
      boundary_pixel_points: args.payload.spatial_scope.boundary_pixel_points
        .map(translatePoint)
        .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null),
      anchor_pixel_point:
        translatePoint(args.payload.spatial_scope.anchor_pixel_point) ??
        args.payload.spatial_scope.anchor_pixel_point
    };
  }
  args.payload.observations = args.payload.observations.map((observation) => {
    const raw = observation as unknown as Record<string, unknown>;
    const placement = raw.placement && typeof raw.placement === "object" && !Array.isArray(raw.placement)
      ? raw.placement as Record<string, unknown>
      : null;
    return {
      ...raw,
      ...(raw.pixel_point == null
        ? {}
        : { pixel_point: translatePoint(raw.pixel_point) ?? raw.pixel_point }),
      ...(Array.isArray(raw.pixel_points)
        ? {
            pixel_points: raw.pixel_points
              .map(translatePoint)
              .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null)
          }
        : {}),
      ...(placement
        ? {
            placement: {
              ...placement,
              ...(Array.isArray(placement.pixel_branch_points)
                ? {
                    pixel_branch_points: placement.pixel_branch_points
                      .map(translatePoint)
                      .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null)
                  }
                : {})
            }
          }
        : {})
    } as unknown as RegisteredMepPixelObservation;
  });
}

function shiftCandidateVisibleRegistrationGeometrySourcePixels(args: {
  registration_geometry: ReturnType<typeof deriveCandidateVisibleRegistrationGeometry>;
  delta_x_px: number;
  delta_y_px: number;
}): void {
  const [origin, xControl, yControl] = args.registration_geometry.control_points;
  if (!origin || !xControl || !yControl) {
    throw new Error("candidate_visible_registration_control_points_required");
  }
  const sourceDx = xControl.source.x - origin.source.x;
  const sourceDy = yControl.source.y - origin.source.y;
  if (Math.abs(sourceDx) <= 1e-7 || Math.abs(sourceDy) <= 1e-7) {
    throw new Error("candidate_visible_registration_control_points_degenerate");
  }
  const modelDelta = {
    x:
      (xControl.model.x - origin.model.x) / sourceDx * args.delta_x_px +
      (yControl.model.x - origin.model.x) / sourceDy * args.delta_y_px,
    y:
      (xControl.model.y - origin.model.y) / sourceDx * args.delta_x_px +
      (yControl.model.y - origin.model.y) / sourceDy * args.delta_y_px
  };
  args.registration_geometry.control_points = args.registration_geometry.control_points.map(
    (entry) => ({
      source: entry.source,
      model: {
        x: entry.model.x + modelDelta.x,
        y: entry.model.y + modelDelta.y
      }
    })
  );
  args.registration_geometry.model_bounds = {
    min: {
      x: args.registration_geometry.model_bounds.min.x + modelDelta.x,
      y: args.registration_geometry.model_bounds.min.y + modelDelta.y
    },
    max: {
      x: args.registration_geometry.model_bounds.max.x + modelDelta.x,
      y: args.registration_geometry.model_bounds.max.y + modelDelta.y
    }
  };
}

function scaleCandidateVisibleRegistrationGeometryAroundSourcePoint(args: {
  registration_geometry: ReturnType<typeof deriveCandidateVisibleRegistrationGeometry>;
  source_anchor: ExistingConditionsPlanPoint;
  render_width_px: number;
  render_height_px: number;
  projected_distance_scale: number;
}): void {
  const scale = finite(
    args.projected_distance_scale,
    "candidate_visible_projected_distance_scale"
  );
  if (scale < 0.75 || scale > 1.6) {
    throw new Error("candidate_visible_projected_distance_scale_out_of_range");
  }
  const anchorModel = mapRegisteredRenderPointToModel(
    args.source_anchor,
    args.render_width_px,
    args.render_height_px,
    args.registration_geometry
  );
  args.registration_geometry.control_points =
    args.registration_geometry.control_points.map((entry) => ({
      source: entry.source,
      model: {
        x: anchorModel.x + (entry.model.x - anchorModel.x) / scale,
        y: anchorModel.y + (entry.model.y - anchorModel.y) / scale
      }
    }));
  const [origin, xControl, yControl] = args.registration_geometry.control_points;
  if (!origin || !xControl || !yControl) {
    throw new Error("candidate_visible_registration_control_points_required");
  }
  const fourth = {
    x: xControl.model.x + yControl.model.x - origin.model.x,
    y: xControl.model.y + yControl.model.y - origin.model.y
  };
  const corners = [origin.model, xControl.model, yControl.model, fourth];
  args.registration_geometry.model_bounds = {
    min: {
      x: Math.min(...corners.map((point) => point.x)),
      y: Math.min(...corners.map((point) => point.y))
    },
    max: {
      x: Math.max(...corners.map((point) => point.x)),
      y: Math.max(...corners.map((point) => point.y))
    }
  };
}

function fitCandidateVisibleRegistrationGeometryToVerifiedRoomEnclosure(args: {
  registration_geometry: ReturnType<typeof deriveCandidateVisibleRegistrationGeometry>;
  source_polygon: ExistingConditionsPlanPoint[];
  native_room_polygon: ExistingConditionsPlanPoint[];
  render_width_px: number;
  render_height_px: number;
}): {
  similarity_scale: number;
  translation_x_px: number;
  translation_y_px: number;
} {
  const sourceArea = polygonArea(args.source_polygon);
  const nativeArea = polygonArea(args.native_room_polygon);
  if (sourceArea <= 1e-7 || nativeArea <= 1e-7) {
    throw new Error("candidate_visible_room_enclosure_similarity_area_degenerate");
  }
  const [origin, xControl, yControl] = args.registration_geometry.control_points;
  if (!origin || !xControl || !yControl) {
    throw new Error("candidate_visible_registration_control_points_required");
  }
  const sourceDx = xControl.source.x - origin.source.x;
  const sourceDy = yControl.source.y - origin.source.y;
  if (Math.abs(sourceDx) <= 1e-7 || Math.abs(sourceDy) <= 1e-7) {
    throw new Error("candidate_visible_registration_control_points_degenerate");
  }
  const currentScaleX = Math.hypot(
    xControl.model.x - origin.model.x,
    xControl.model.y - origin.model.y
  ) / Math.abs(sourceDx);
  const currentScaleY = Math.hypot(
    yControl.model.x - origin.model.x,
    yControl.model.y - origin.model.y
  ) / Math.abs(sourceDy);
  const currentScale = Math.sqrt(currentScaleX * currentScaleY);
  const desiredScale = Math.sqrt(nativeArea / sourceArea);
  const similarityScale = currentScale / desiredScale;
  if (!Number.isFinite(similarityScale) || similarityScale < 0.2 || similarityScale > 5) {
    throw new Error("candidate_visible_room_enclosure_similarity_scale_out_of_range");
  }
  const sourceAnchor = polygonAnchor(args.source_polygon);
  const anchorModel = mapRegisteredRenderPointToModel(
    sourceAnchor,
    args.render_width_px,
    args.render_height_px,
    args.registration_geometry
  );
  args.registration_geometry.control_points =
    args.registration_geometry.control_points.map((entry) => ({
      source: entry.source,
      model: {
        x: anchorModel.x + (entry.model.x - anchorModel.x) / similarityScale,
        y: anchorModel.y + (entry.model.y - anchorModel.y) / similarityScale
      }
    }));
  const [scaledOrigin, scaledXControl, scaledYControl] =
    args.registration_geometry.control_points;
  if (!scaledOrigin || !scaledXControl || !scaledYControl) {
    throw new Error("candidate_visible_registration_control_points_required");
  }
  const scaledFourth = {
    x: scaledXControl.model.x + scaledYControl.model.x - scaledOrigin.model.x,
    y: scaledXControl.model.y + scaledYControl.model.y - scaledOrigin.model.y
  };
  const scaledCorners = [
    scaledOrigin.model,
    scaledXControl.model,
    scaledYControl.model,
    scaledFourth
  ];
  args.registration_geometry.model_bounds = {
    min: {
      x: Math.min(...scaledCorners.map((point) => point.x)),
      y: Math.min(...scaledCorners.map((point) => point.y))
    },
    max: {
      x: Math.max(...scaledCorners.map((point) => point.x)),
      y: Math.max(...scaledCorners.map((point) => point.y))
    }
  };
  const nativeAnchor = polygonAnchor(args.native_room_polygon);
  const projectedNativeAnchor = mapModelPointToRegisteredRender(
    nativeAnchor,
    args.render_width_px,
    args.render_height_px,
    args.registration_geometry
  );
  const translationX = projectedNativeAnchor.x - sourceAnchor.x;
  const translationY = projectedNativeAnchor.y - sourceAnchor.y;
  shiftCandidateVisibleRegistrationGeometrySourcePixels({
    registration_geometry: args.registration_geometry,
    delta_x_px: translationX,
    delta_y_px: translationY
  });
  return {
    similarity_scale: similarityScale,
    translation_x_px: translationX,
    translation_y_px: translationY
  };
}

async function deriveCandidateVisibleStableLandmarkSimilarity(args: {
  registered_render_path: string;
  render_width_px: number;
  render_height_px: number;
  registration_geometry: ReturnType<typeof deriveCandidateVisibleRegistrationGeometry>;
  source_room_label_anchor: CandidateVisibleSourceRoomLabelAnchor;
  source_boundary_pixel_points: ExistingConditionsPlanPoint[];
  source_boundary_edge_support_ratios: number[];
  native_room_label_model_point: ExistingConditionsPlanPoint;
  stable_boundary_segments: NonNullable<
    CandidateVisibleMepReconstructionInput["verified_room_scope"]
  >["stable_boundary_segments"];
}): Promise<CandidateVisibleStableLandmarkSimilarity | null> {
  if (
    !args.stable_boundary_segments?.length ||
    args.source_boundary_pixel_points.length < 3 ||
    args.source_boundary_edge_support_ratios.length !==
      args.source_boundary_pixel_points.length
  ) {
    return null;
  }
  const translatedGeometry = JSON.parse(
    JSON.stringify(args.registration_geometry)
  ) as ReturnType<typeof deriveCandidateVisibleRegistrationGeometry>;
  const nativeLabelBefore = mapModelPointToRegisteredRender(
    args.native_room_label_model_point,
    args.render_width_px,
    args.render_height_px,
    translatedGeometry
  );
  shiftCandidateVisibleRegistrationGeometrySourcePixels({
    registration_geometry: translatedGeometry,
    delta_x_px:
      nativeLabelBefore.x - args.source_room_label_anchor.pixel_point.x,
    delta_y_px:
      nativeLabelBefore.y - args.source_room_label_anchor.pixel_point.y
  });
  const nativeLabelProjected = mapModelPointToRegisteredRender(
    args.native_room_label_model_point,
    args.render_width_px,
    args.render_height_px,
    translatedGeometry
  );
  const image = await loadImage(args.registered_render_path);
  const canvas = createCanvas(args.render_width_px, args.render_height_px);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, args.render_width_px, args.render_height_px);
  context.drawImage(image, 0, 0);
  const pixels: PlanTracePixelBuffer = {
    width: args.render_width_px,
    height: args.render_height_px,
    data: context.getImageData(
      0,
      0,
      args.render_width_px,
      args.render_height_px
    ).data
  };
  const sourcePixelSha256 = sha256PlanTracePixelBuffer(pixels);
  const sourceEdges = args.source_boundary_pixel_points.flatMap(
    (start, edgeIndex) => {
      const end =
        args.source_boundary_pixel_points[
          (edgeIndex + 1) % args.source_boundary_pixel_points.length
        ]!;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const axis =
        Math.abs(dx) >= Math.abs(dy) * 4
          ? ("horizontal" as const)
          : Math.abs(dy) >= Math.abs(dx) * 4
            ? ("vertical" as const)
            : null;
      const length = Math.hypot(dx, dy);
      const supportRatio =
        args.source_boundary_edge_support_ratios[edgeIndex] ?? 0;
      if (!axis || length < 12 || supportRatio < 0.65) return [];
      return [{
        edge_index: edgeIndex,
        axis,
        start,
        end,
        length_px: length,
        support_ratio: supportRatio
      }];
    }
  );
  type StableProposal = CandidateVisibleStableLandmarkSimilarity & {
    ambiguity_key: string;
  };
  const proposals = args.stable_boundary_segments.flatMap((segment) => {
    const start = mapModelPointToRegisteredRender(
      segment.start_model_point,
      args.render_width_px,
      args.render_height_px,
      translatedGeometry
    );
    const end = mapModelPointToRegisteredRender(
      segment.end_model_point,
      args.render_width_px,
      args.render_height_px,
      translatedGeometry
    );
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const axis = Math.abs(dx) >= Math.abs(dy) * 4
      ? "horizontal" as const
      : Math.abs(dy) >= Math.abs(dx) * 4
        ? "vertical" as const
        : null;
    if (!axis) return [];
    const nativeCoordinate = axis === "horizontal"
      ? (start.y + end.y) / 2
      : (start.x + end.x) / 2;
    const sourceTagCoordinate = axis === "horizontal"
      ? args.source_room_label_anchor.pixel_point.y
      : args.source_room_label_anchor.pixel_point.x;
    const nativeTagCoordinate = axis === "horizontal"
      ? nativeLabelProjected.y
      : nativeLabelProjected.x;
    const nativeDistance = nativeCoordinate - nativeTagCoordinate;
    const minimumControlDistance = Math.max(
      10,
      (axis === "horizontal" ? args.render_height_px : args.render_width_px) *
        0.05
    );
    if (Math.abs(nativeDistance) < minimumControlDistance) return [];
    return sourceEdges.flatMap((sourceEdge) => {
      if (sourceEdge.axis !== axis) return [];
      const sourceCoordinate = axis === "horizontal"
        ? (sourceEdge.start.y + sourceEdge.end.y) / 2
        : (sourceEdge.start.x + sourceEdge.end.x) / 2;
      const sourceDistance = sourceCoordinate - sourceTagCoordinate;
      if (
        Math.sign(sourceDistance) !== Math.sign(nativeDistance) ||
        Math.abs(sourceDistance) < minimumControlDistance
      ) {
        return [];
      }
      const similarityScale = Math.abs(sourceDistance / nativeDistance);
      if (similarityScale < 0.75 || similarityScale > 1.6) return [];
      const projectAfterScale = (
        point: ExistingConditionsPlanPoint
      ): ExistingConditionsPlanPoint => ({
        x:
          args.source_room_label_anchor.pixel_point.x +
          (point.x - nativeLabelProjected.x) * similarityScale,
        y:
          args.source_room_label_anchor.pixel_point.y +
          (point.y - nativeLabelProjected.y) * similarityScale
      });
      const projectedStart = projectAfterScale(start);
      const projectedEnd = projectAfterScale(end);
      const directResidual = Math.sqrt(
        (
          Math.hypot(
            projectedStart.x - sourceEdge.start.x,
            projectedStart.y - sourceEdge.start.y
          ) ** 2 +
          Math.hypot(
            projectedEnd.x - sourceEdge.end.x,
            projectedEnd.y - sourceEdge.end.y
          ) ** 2
        ) / 2
      );
      const reversedResidual = Math.sqrt(
        (
          Math.hypot(
            projectedStart.x - sourceEdge.end.x,
            projectedStart.y - sourceEdge.end.y
          ) ** 2 +
          Math.hypot(
            projectedEnd.x - sourceEdge.start.x,
            projectedEnd.y - sourceEdge.start.y
          ) ** 2
        ) / 2
      );
      const endpointResidual = Math.min(directResidual, reversedResidual);
      const projectedLength = Math.hypot(
        projectedEnd.x - projectedStart.x,
        projectedEnd.y - projectedStart.y
      );
      const spanRatio =
        Math.min(projectedLength, sourceEdge.length_px) /
        Math.max(projectedLength, sourceEdge.length_px);
      const maximumEndpointResidual = Math.max(
        4,
        Math.min(12, sourceEdge.length_px * 0.12)
      );
      if (
        spanRatio < 0.55 ||
        endpointResidual > maximumEndpointResidual
      ) {
        return [];
      }
      const postTransformPerpendicularResidual =
        axis === "horizontal"
          ? Math.abs(
              (projectedStart.y + projectedEnd.y) / 2 - sourceCoordinate
            )
          : Math.abs(
              (projectedStart.x + projectedEnd.x) / 2 - sourceCoordinate
            );
      const candidateScore =
        sourceEdge.support_ratio * 0.45 +
        spanRatio * 0.25 +
        Math.max(0, 1 - endpointResidual / maximumEndpointResidual) * 0.2 +
        Math.max(0, 1 - Math.abs(similarityScale - 1) / 0.6) * 0.1;
      return [{
        basis: "exact_room_tag_plus_stable_native_boundary" as const,
        stable_kind: segment.stable_kind,
        axis,
        source_pixel_sha256: sourcePixelSha256,
        source_boundary_edge_index: sourceEdge.edge_index,
        source_boundary_start_pixel_point: sourceEdge.start,
        source_boundary_end_pixel_point: sourceEdge.end,
        native_segment_source_scoped_id: segment.source_scoped_id,
        native_segment_name: segment.name,
        source_landmark_coordinate_px: rounded(sourceCoordinate),
        source_landmark_support_ratio: rounded(sourceEdge.support_ratio),
        native_landmark_projected_coordinate_before_px: rounded(nativeCoordinate),
        source_room_tag_coordinate_px: rounded(sourceTagCoordinate),
        native_room_tag_projected_coordinate_px: rounded(nativeTagCoordinate),
        similarity_scale: rounded(similarityScale),
        residual_px: rounded(postTransformPerpendicularResidual),
        post_transform_endpoint_rms_residual_px: rounded(endpointResidual),
        source_native_span_ratio: rounded(spanRatio),
        candidate_score: rounded(candidateScore),
        runner_up_score_margin: null,
        ambiguity_key: [
          segment.source_scoped_id,
          sourceEdge.edge_index
        ].join(":")
      } satisfies StableProposal];
    });
  });
  const ranked = proposals.sort((left, right) =>
    right.candidate_score - left.candidate_score ||
    left.post_transform_endpoint_rms_residual_px -
      right.post_transform_endpoint_rms_residual_px ||
    left.ambiguity_key.localeCompare(right.ambiguity_key)
  );
  const winner = ranked[0];
  if (!winner) return null;
  const runnerUp = ranked.find(
    (candidate) => candidate.ambiguity_key !== winner.ambiguity_key
  );
  const scoreMargin = runnerUp
    ? winner.candidate_score - runnerUp.candidate_score
    : null;
  if (scoreMargin !== null && scoreMargin < 0.08) return null;
  const { ambiguity_key: _ambiguityKey, ...receipt } = winner;
  return {
    ...receipt,
    runner_up_score_margin:
      scoreMargin === null ? null : rounded(scoreMargin)
  };
}

function normalizeVisibility(value: unknown): "clear" | "partial" | "occluded" {
  const normalized = normalizedText(value);
  if (normalized === "occluded" || normalized === "hidden") return "occluded";
  if (normalized.includes("partial") || normalized.includes("clip")) return "partial";
  return "clear";
}

function normalizeAttributeName(value: unknown): string {
  const normalized = normalizedText(value).replaceAll("_", " ");
  if (normalized === "route geometry" || normalized === "pixel geometry") return "location";
  if (normalized === "pixel points" || normalized === "point" || normalized === "pixel point") return "location";
  if (normalized === "elevation ft") return "elevation";
  if (normalized === "pipe size" || normalized === "duct size" || normalized === "conduit size" || normalized === "diameter") return "size";
  if (normalized === "service" || normalized === "service classification" || normalized === "system classification") return "system";
  if (normalized === "fixture id" || normalized === "fixture label") return "provisional plan representation";
  return normalized;
}

function plannerCoordinateScale(args: {
  payload: CandidateVisibleMepPlannerPayload;
  render_width_px: number;
  render_height_px: number;
}): { scale_x: number; scale_y: number; warning?: string } {
  const renderWidth = positiveInteger(args.render_width_px, "registered_render_width_px");
  const renderHeight = positiveInteger(args.render_height_px, "registered_render_height_px");
  const raw = args.payload as CandidateVisibleMepPlannerPayload & {
    planner_raster_width_px?: unknown;
    planner_raster_height_px?: unknown;
  };
  if (raw.planner_raster_width_px != null || raw.planner_raster_height_px != null) {
    throw new Error("candidate_visible_planner_raster_dimensions_are_not_allowed");
  }
  if (args.payload.coordinate_space === "normalized_uv_top_left") {
    return {
      scale_x: renderWidth,
      scale_y: renderHeight,
      warning: `Mapped normalized planner UV coordinates into the server-verified registered render ${renderWidth}x${renderHeight}.`
    };
  }
  return { scale_x: 1, scale_y: 1 };
}

function normalizeEvidenceClaims(
  value: unknown,
  supportedAttributes: string[]
): Array<{ attribute: string; basis: "legible_source_evidence" | "native_model_precedent" | "user_direction" | "declared_heuristic"; evidence_role: string; reference: string }> {
  const supported = new Set(supportedAttributes.map((entry) => normalizedText(entry).replaceAll("_", " ")));
  const claims: Array<{ attribute: string; basis: "legible_source_evidence" | "native_model_precedent" | "user_direction" | "declared_heuristic"; evidence_role: string; reference: string }> = [];
  for (const rawValue of Array.isArray(value) ? value : []) {
    if (!rawValue || typeof rawValue !== "object") continue;
    const raw = rawValue as Record<string, unknown>;
    const attribute = normalizeAttributeName(raw.attribute);
    if (!attribute || !supported.has(attribute) || claims.some((entry) => entry.attribute === attribute)) continue;
    const declaredBasis = normalizedText(raw.basis);
    const basis = declaredBasis === "native_model_precedent" ||
        declaredBasis === "user_direction" ||
        declaredBasis === "declared_heuristic"
      ? declaredBasis
      : "legible_source_evidence";
    const reference = String(
      raw.reference ??
      raw.legible_source_evidence ??
      raw.native_model_precedent ??
      raw.user_direction ??
      ""
    ).trim();
    if (!reference) continue;
    claims.push({
      attribute,
      basis,
      evidence_role: String(raw.evidence_role ?? "registered_source_render").trim() || "registered_source_render",
      reference
    });
  }
  return claims;
}

function normalizePlumbingService(value: unknown): "domestic_cold_water" | "domestic_hot_water" | "domestic_hot_water_return" | "sanitary" | "vent" | "unclassified" {
  const normalized = normalizedText(value);
  if (["domestic_cold_water", "cold_water", "cold"].includes(normalized)) return "domestic_cold_water";
  if (["domestic_hot_water", "hot_water", "hot"].includes(normalized)) return "domestic_hot_water";
  if (["domestic_hot_water_return", "hot_water_return", "hwr"].includes(normalized)) return "domestic_hot_water_return";
  if (["sanitary", "sanitary_waste", "waste"].includes(normalized)) return "sanitary";
  if (normalized === "vent") return "vent";
  return "unclassified";
}

function normalizeCandidateVisiblePlannerPayload(
  payload: CandidateVisibleMepPlannerPayload,
  frame: CandidateVisibleFrameMapping,
  renderWidthPx: number,
  renderHeightPx: number
): { payload: CandidateVisibleMepPlannerPayload; warnings: string[]; frameEvidenceHash: string } {
  const warnings: string[] = [];
  const rawObservations = Array.isArray(payload.observations)
    ? payload.observations as unknown as Array<Record<string, unknown>>
    : [];
  const plannerScale = plannerCoordinateScale({
    payload,
    render_width_px: renderWidthPx,
    render_height_px: renderHeightPx
  });
  if (plannerScale.warning) warnings.push(plannerScale.warning);
  const normalizePlannerPoint = (value: unknown): ExistingConditionsPlanPoint | null => {
    const point = normalizePoint(value);
    return point
      ? { x: point.x * plannerScale.scale_x, y: point.y * plannerScale.scale_y }
      : null;
  };
  const normalizedSpatialScope = payload.spatial_scope == null
    ? undefined
    : {
        boundary_pixel_points: (Array.isArray(payload.spatial_scope.boundary_pixel_points)
          ? payload.spatial_scope.boundary_pixel_points
          : [])
          .map(normalizePlannerPoint)
          .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null),
        anchor_pixel_point: normalizePlannerPoint(payload.spatial_scope.anchor_pixel_point) ?? { x: Number.NaN, y: Number.NaN },
        anchor_label: String(payload.spatial_scope.anchor_label ?? "").trim(),
        evidence_reference: String(payload.spatial_scope.evidence_reference ?? "").trim()
      };
  const viewReferenceKey = "candidate_visible_aligned_view";
  const normalizedObservations = rawObservations.map((raw, index) => {
    const kind = String(raw.kind ?? "").trim();
    const observationId = String(raw.observation_id ?? `candidate_visible_${index + 1}`).trim();
    const supportedRaw = Array.isArray(raw.supported_attributes)
      ? raw.supported_attributes
      : raw.supported_attributes && typeof raw.supported_attributes === "object"
        ? Object.keys(raw.supported_attributes as Record<string, unknown>)
        : [];
    const supported = Array.from(new Set(supportedRaw.map(normalizeAttributeName).filter(Boolean)));
    const common = {
      ...raw,
      observation_id: observationId,
      visibility: normalizeVisibility(raw.visibility),
      confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.5
    };

    if (kind === "pipe_route" && String(raw.discipline ?? "").trim() === "plumbing") {
      const points = (Array.isArray(raw.pixel_points) ? raw.pixel_points : [])
        .map(normalizePlannerPoint)
        .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null);
      const elevationObject = raw.elevation_ft && typeof raw.elevation_ft === "object"
        ? raw.elevation_ft as Record<string, unknown>
        : null;
      const explicitElevation = Number(elevationObject?.value ?? raw.elevation_ft);
      const elevationFt = Number.isFinite(explicitElevation) ? explicitElevation : 10;
      if (!Number.isFinite(explicitElevation)) {
        warnings.push(`${observationId}: normalized missing plan-unseen elevation to a disclosed 10 ft level offset.`);
      }
      const requestedService = normalizePlumbingService(raw.service);
      const systemPolicy = normalizedText(raw.system_classification_policy);
      const service = systemPolicy === "unresolved_placeholder" ? "unclassified" : requestedService;
      if (service !== requestedService) {
        warnings.push(`${observationId}: withheld source-system classification while using an unresolved native container.`);
      }
      const sizeValue = String(raw.pipe_size ?? "").trim();
      const hasSizeEvidence = (Array.isArray(raw.attribute_evidence) ? raw.attribute_evidence : []).some((entry) =>
        entry && typeof entry === "object" && normalizeAttributeName((entry as Record<string, unknown>).attribute) === "size"
      );
      const sizePolicy = sizeValue && hasSizeEvidence ? "explicit_required" : "unresolved_placeholder";
      const typePolicy = normalizedText(raw.type_policy) === "explicit_required" ? "explicit_required" : "unresolved_placeholder";
      const resolvedSystemPolicy = service === "unclassified"
        ? "unresolved_placeholder"
        : "explicit_required";
      const normalizedSupported = Array.from(new Set([
        "location",
        "elevation",
        ...(sizePolicy === "explicit_required" ? ["size"] : []),
        ...(resolvedSystemPolicy === "explicit_required" ? ["system"] : []),
        ...(typePolicy === "explicit_required" ? ["type"] : [])
      ]));
      let evidence = normalizeEvidenceClaims(raw.attribute_evidence, normalizedSupported);
      if (!evidence.some((entry) => entry.attribute === "elevation")) {
        evidence.push({
          attribute: "elevation",
          basis: "declared_heuristic",
          evidence_role: "registered_source_render",
          reference: String(elevationObject?.reference ?? "Plan evidence does not show elevation; use a disclosed 10 ft level offset.").trim()
        });
      }
      return {
        ...common,
        kind: "pipe_route",
        discipline: "plumbing",
        service,
        pixel_points: points,
        elevation_ft: elevationFt,
        pipe_size_policy: sizePolicy,
        ...(sizePolicy === "explicit_required" ? { pipe_size: sizeValue } : { pipe_size: undefined }),
        type_policy: typePolicy,
        pipe_type: String(raw.pipe_type ?? "Standard").trim() || "Standard",
        system_classification_policy: resolvedSystemPolicy,
        system_type: String(raw.system_type ?? "Domestic Cold Water").trim() || "Domestic Cold Water",
        supported_attributes: normalizedSupported,
        attribute_evidence: evidence
      };
    }

    if (kind === "plumbing_fixture" && normalizedText((raw.placement as Record<string, unknown> | undefined)?.mode) === "provisional_plan_symbol") {
      const sourceGraphic = normalizedText(
        (raw.representation_classification as Record<string, unknown> | undefined)?.source_graphic
      );
      if (sourceGraphic !== "mep_connection_symbol") {
        warnings.push(
          `${observationId}: deferred provisional plumbing marker because the source was not explicitly classified as an MEP connection symbol.`
        );
        return null;
      }
      const point = normalizePlannerPoint(raw.pixel_point);
      const normalizedSupported = ["location", "provisional plan representation", "symbol form"];
      const reference = String(
        (raw.representation_classification as Record<string, unknown> | undefined)?.reference ??
        "Source-visible fixture symbol location; native family, type, host, and connector meaning remain unresolved."
      ).trim();
      return {
        ...common,
        kind: "plumbing_fixture",
        discipline: "plumbing",
        pixel_point: point ?? { x: 0, y: 0 },
        role: String(raw.role ?? "unresolved plumbing fixture").trim(),
        placement: {
          mode: "provisional_plan_symbol",
          view_reference_key: viewReferenceKey,
          view_type: "FloorPlan",
          symbol_form: "unclassified_circle",
          host_direction: "unresolved",
          radius_ft: 0.25,
          stem_length_ft: 0
        },
        representation_classification: {
          source_graphic: "mep_connection_symbol",
          native_target: "plan_only_marker",
          basis: "source_observation",
          evidence_role: "registered_source_render",
          reference
        },
        service_route_connections: [],
        supported_attributes: normalizedSupported,
        attribute_evidence: [
          {
            attribute: "provisional plan representation",
            basis: "legible_source_evidence",
            evidence_role: "registered_source_render",
            reference
          },
          {
            attribute: "symbol form",
            basis: "legible_source_evidence",
            evidence_role: "registered_source_render",
            reference
          }
        ]
      };
    }

    const placement = raw.placement && typeof raw.placement === "object" && !Array.isArray(raw.placement)
      ? raw.placement as Record<string, unknown>
      : null;
    const normalizedPlacement = placement && Array.isArray(placement.pixel_branch_points)
      ? {
          ...placement,
          pixel_branch_points: placement.pixel_branch_points
            .map(normalizePlannerPoint)
            .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null)
        }
      : placement;
    const normalizedPixelPoint = normalizePlannerPoint(raw.pixel_point);
    const normalizedPixelPoints = Array.isArray(raw.pixel_points)
      ? raw.pixel_points
          .map(normalizePlannerPoint)
          .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null)
      : null;
    return {
      ...common,
      ...(raw.pixel_point == null ? {} : { pixel_point: normalizedPixelPoint ?? { x: Number.NaN, y: Number.NaN } }),
      ...(normalizedPixelPoints ? { pixel_points: normalizedPixelPoints } : {}),
      ...(normalizedPlacement ? { placement: normalizedPlacement } : {}),
      supported_attributes: supported,
      attribute_evidence: normalizeEvidenceClaims(raw.attribute_evidence, supported)
    };
  }).filter((entry): entry is Exclude<typeof entry, null> => entry !== null) as CandidateVisibleMepPlannerPayload["observations"];
  const frameEvidenceHash = sha256Json(frame);
  const nativeReferences = Array.isArray(payload.native_element_references)
    ? payload.native_element_references.slice()
    : [];
  if (!nativeReferences.some((entry) => entry.reference_key === viewReferenceKey)) {
    nativeReferences.push({
      reference_key: viewReferenceKey,
      element_id: frame.view_id,
      category: "View",
      role: "verified candidate-visible aligned drafting view",
      evidence_role: "candidate_visible_frame_mapping",
      evidence_sha256: frameEvidenceHash
    });
  }
  const targetLevelElevationFt = finite(
    frame.target_level_elevation_ft,
    "frame_target_level_elevation_ft"
  );
  return {
    payload: {
      ...payload,
      material_confidence_threshold:
        typeof payload.material_confidence_threshold === "number"
          ? payload.material_confidence_threshold
          : 0.55,
      native_element_references: nativeReferences,
      level_elevation_ft: targetLevelElevationFt,
      ...(normalizedSpatialScope ? { spatial_scope: normalizedSpatialScope } : {}),
      observations: normalizedObservations
    },
    warnings: [
      ...(typeof payload.level_elevation_ft === "number" && Number.isFinite(payload.level_elevation_ft)
        ? Math.abs(payload.level_elevation_ft - targetLevelElevationFt) > 0.01
          ? [`Planner level elevation ${payload.level_elevation_ft} ft was replaced by verified target-level elevation ${targetLevelElevationFt} ft.`]
          : []
        : [`Injected verified target-level elevation ${targetLevelElevationFt} ft; planner level elevation was omitted or invalid.`]),
      ...(typeof payload.material_confidence_threshold === "number"
        ? []
        : ["Applied the candidate-visible iterative drafting confidence threshold of 0.55; provisional outputs remain unscored."]),
      ...warnings
    ],
    frameEvidenceHash
  };
}

function validateCandidateVisibleSpatialScope(args: {
  payload: CandidateVisibleMepPlannerPayload;
  render_width_px: number;
  render_height_px: number;
  registration_geometry: ReturnType<typeof deriveCandidateVisibleRegistrationGeometry>;
  verified_room_scope?: CandidateVisibleMepReconstructionInput["verified_room_scope"];
  verified_landmark_scope?: NonNullable<
    CandidateVisibleMepReconstructionInput["verified_landmark_scope"]
  > & {
    boundary_model_points: ExistingConditionsPlanPoint[];
  };
  source_room_label_anchor?: CandidateVisibleSourceRoomLabelAnchor | null;
  source_enclosure_raster_verification?: CandidateVisibleSourceEnclosureRasterVerification | null;
  source_route_raster_verifications?: CandidateVisibleRouteRasterVerification[];
  stable_landmark_similarity?: CandidateVisibleStableLandmarkSimilarity | null;
  registered_frame_id: string;
  registered_view_id: number;
}): CandidateVisibleMepReconstruction["spatial_scope_receipt"] {
  const originalSourceObservations = JSON.parse(
    JSON.stringify(args.payload.observations)
  ) as RegisteredMepPixelObservation[];
  const originalSourceObservationsSha256 = sha256Json(originalSourceObservations);
  let scope = args.payload.spatial_scope;
  const roomNumber = String(args.payload.room_number ?? "").trim();
  const nativeRoomScope = args.verified_room_scope;
  const nativeLandmarkScope = args.verified_landmark_scope;
  if (nativeRoomScope && nativeLandmarkScope) {
    throw new Error("candidate_visible_authoritative_scope_is_ambiguous");
  }
  if (roomNumber && !nativeRoomScope) {
    throw new Error(`candidate_visible_room_scope_requires_native_room_boundary:${roomNumber}`);
  }
  if (
    roomNumber &&
    nativeRoomScope &&
    nativeRoomScope.room_number.trim().toLowerCase() !== roomNumber.toLowerCase()
  ) {
    throw new Error(`candidate_visible_native_room_number_mismatch:${roomNumber}`);
  }
  const nativeRoomPolygon = nativeRoomScope || nativeLandmarkScope
    ? normalizeModelPolygon(
        nativeRoomScope?.boundary_model_points ?? nativeLandmarkScope!.boundary_model_points,
        nativeRoomScope
          ? "candidate_visible_native_room_boundary"
          : "candidate_visible_native_landmark_area_boundary"
      )
    : null;
  if (!scope && !nativeRoomPolygon) return undefined;
  const normalizationWarnings: string[] = [];
  let sourceObservedPolygon: ExistingConditionsPlanPoint[] | null = null;
  if (scope) {
    try {
      sourceObservedPolygon = validateScopePolygon(
        scope.boundary_pixel_points,
        args.render_width_px,
        args.render_height_px
      );
    } catch (error) {
      if (!nativeRoomPolygon) throw error;
      normalizationWarnings.push(
        `Ignored malformed non-authoritative planner room trace: ${error instanceof Error ? error.message : String(error)}.`
      );
    }
  }
  let nativeRoomProjectionVisible = true;
  let nativeRoomPixelPolygon: ExistingConditionsPlanPoint[] | null = null;
  if (nativeRoomPolygon) {
    try {
      nativeRoomPixelPolygon = projectedNativeRoomPixelPolygon({
        native_room_polygon: nativeRoomPolygon,
        render_width_px: args.render_width_px,
        render_height_px: args.render_height_px,
        registration_geometry: args.registration_geometry
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "candidate_visible_verified_room_scope_not_visible_in_registered_render"
      ) {
        throw error;
      }
      nativeRoomProjectionVisible = false;
      nativeRoomPixelPolygon = nativeRoomPolygon.map((point) =>
        mapModelPointToRegisteredRender(
          point,
          args.render_width_px,
          args.render_height_px,
          args.registration_geometry
        )
      );
    }
  }
  const exactTagNativeVisibleRoomLabel = nativeRoomScope?.visible_room_label;
  const exactTagNativeLabelProjectedPoint = exactTagNativeVisibleRoomLabel
    ? mapModelPointToRegisteredRender(
        exactTagNativeVisibleRoomLabel.model_point,
        args.render_width_px,
        args.render_height_px,
        args.registration_geometry
      )
    : null;
  const exactTagRoomToken = normalizedRoomLabelToken(roomNumber);
  const exactTagRoomNameToken = normalizedRoomLabelToken(
    String(nativeRoomScope?.room_name ?? "").replace(roomNumber, "")
  );
  const exactTagIdentityVerified =
    !!roomNumber &&
    !!args.source_room_label_anchor &&
    !!exactTagNativeVisibleRoomLabel &&
    exactTagNativeVisibleRoomLabel.registration_frame_id === args.registered_frame_id &&
    exactTagNativeVisibleRoomLabel.view_id === args.registered_view_id &&
    !!exactTagNativeLabelProjectedPoint &&
    roomLabelMatchesExactIdentity(
      normalizedRoomLabelToken(args.source_room_label_anchor.text),
      exactTagRoomToken,
      exactTagRoomNameToken
    ) &&
    roomLabelMatchesExactIdentity(
      normalizedRoomLabelToken(exactTagNativeVisibleRoomLabel.text),
      exactTagRoomToken,
      exactTagRoomNameToken
    );
  let exactTagTranslationApplied = false;
  let exactTagStableLandmarkApplied = false;
  let exactTagTranslationX = 0;
  let exactTagTranslationY = 0;
  if (
    exactTagIdentityVerified &&
    exactTagNativeLabelProjectedPoint &&
    args.source_room_label_anchor &&
    nativeRoomPolygon
  ) {
    exactTagTranslationX =
      exactTagNativeLabelProjectedPoint.x -
      args.source_room_label_anchor.pixel_point.x;
    exactTagTranslationY =
      exactTagNativeLabelProjectedPoint.y -
      args.source_room_label_anchor.pixel_point.y;
    shiftCandidateVisibleRegistrationGeometrySourcePixels({
      registration_geometry: args.registration_geometry,
      delta_x_px: exactTagTranslationX,
      delta_y_px: exactTagTranslationY
    });
    nativeRoomPixelPolygon = projectedNativeRoomPixelPolygon({
      native_room_polygon: nativeRoomPolygon,
      render_width_px: args.render_width_px,
      render_height_px: args.render_height_px,
      registration_geometry: args.registration_geometry
    });
    nativeRoomProjectionVisible = true;
    const tagOnlyGeometryIsDisjoint = args.payload.observations.some((observation) => {
      const raw = observation as unknown as Record<string, unknown>;
      const routePoints = (Array.isArray(raw.pixel_points) ? raw.pixel_points : [])
        .map(normalizePoint)
        .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null);
      const point = normalizePoint(raw.pixel_point);
      const placement = raw.placement && typeof raw.placement === "object"
        ? raw.placement as Record<string, unknown>
        : null;
      const branchPoints = (
        Array.isArray(placement?.pixel_branch_points)
          ? placement.pixel_branch_points
          : []
      )
        .map(normalizePoint)
        .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null);
      return (
        (routePoints.length >= 2 &&
          clipPolylineToPolygon(routePoints, nativeRoomPixelPolygon!).length === 0) ||
        (branchPoints.length >= 2 &&
          clipPolylineToPolygon(branchPoints, nativeRoomPixelPolygon!).length === 0) ||
        (!!point && !pointInsidePolygonOrBoundary(point, nativeRoomPixelPolygon!))
      );
    });
    if (tagOnlyGeometryIsDisjoint && args.stable_landmark_similarity) {
      scaleCandidateVisibleRegistrationGeometryAroundSourcePoint({
        registration_geometry: args.registration_geometry,
        source_anchor: args.source_room_label_anchor.pixel_point,
        render_width_px: args.render_width_px,
        render_height_px: args.render_height_px,
        projected_distance_scale:
          args.stable_landmark_similarity.similarity_scale
      });
      nativeRoomPixelPolygon = projectedNativeRoomPixelPolygon({
        native_room_polygon: nativeRoomPolygon,
        render_width_px: args.render_width_px,
        render_height_px: args.render_height_px,
        registration_geometry: args.registration_geometry
      });
      exactTagStableLandmarkApplied = true;
    }
    exactTagTranslationApplied = true;
    if (scope || sourceObservedPolygon) {
      normalizationWarnings.push(
        "Ignored the planner-authored source room trace because the source PDF and focused Revit inventory independently established the same unique room tag."
      );
    }
    scope = undefined;
    sourceObservedPolygon = null;
  }
  let roomEnclosureRegistration: {
    similarity_scale: number;
    translation_x_px: number;
    translation_y_px: number;
  } | null = null;
  let roomEnclosureShapeVerification: CandidateVisibleSourceRoomShapeVerification | null = null;
  let roomEnclosureNativeBasis:
    | "full_native_room"
    | "primary_orthogonal_enclosure_containing_room_location" =
      "full_native_room";
  if (
    !nativeRoomProjectionVisible &&
    !exactTagTranslationApplied &&
    !exactTagNativeVisibleRoomLabel &&
    roomNumber &&
    scope &&
    sourceObservedPolygon &&
    nativeRoomPolygon &&
    nativeRoomScope?.location_model_point &&
    pointInsidePolygonOrNearBoundary(
      nativeRoomScope.location_model_point,
      nativeRoomPolygon,
      0.01
    ) &&
    args.source_room_label_anchor &&
    args.source_enclosure_raster_verification?.accepted === true &&
    roomLabelMatchesExactIdentity(
      normalizedRoomLabelToken(args.source_room_label_anchor.text),
      exactTagRoomToken,
      exactTagRoomNameToken
    )
  ) {
    const submittedAnchor = normalizePoint(scope.anchor_pixel_point);
    if (
      submittedAnchor &&
      sourceRoomAnchorMatchesLocatedLabel({
        source_polygon: sourceObservedPolygon,
        submitted_anchor: submittedAnchor,
        source_room_label_anchor: args.source_room_label_anchor,
        render_width_px: args.render_width_px,
        render_height_px: args.render_height_px
      })
    ) {
      roomEnclosureShapeVerification = verifySourceRoomShape({
        source_polygon: sourceObservedPolygon,
        native_room_polygon: nativeRoomPolygon,
        submitted_anchor: submittedAnchor,
        source_room_label_anchor: args.source_room_label_anchor,
        render_width_px: args.render_width_px,
        render_height_px: args.render_height_px
      });
      let verifiedNativeEnclosure = nativeRoomPolygon;
      if (!roomEnclosureShapeVerification.accepted) {
        const primaryOrthogonalEnclosure =
          primaryOrthogonalEnclosureContainingPoint(
            nativeRoomPolygon,
            nativeRoomScope.location_model_point,
            (() => {
              const sourceBounds = pointBounds(sourceObservedPolygon);
              return (sourceBounds.max.x - sourceBounds.min.x) /
                (sourceBounds.max.y - sourceBounds.min.y);
            })()
          );
        if (primaryOrthogonalEnclosure) {
          const primaryVerification = verifySourceRoomShape({
            source_polygon: sourceObservedPolygon,
            native_room_polygon: primaryOrthogonalEnclosure,
            submitted_anchor: submittedAnchor,
            source_room_label_anchor: args.source_room_label_anchor,
            render_width_px: args.render_width_px,
            render_height_px: args.render_height_px
          });
          roomEnclosureShapeVerification = primaryVerification;
          if (primaryVerification.accepted) {
            verifiedNativeEnclosure = primaryOrthogonalEnclosure;
            roomEnclosureNativeBasis =
              "primary_orthogonal_enclosure_containing_room_location";
          }
        }
      }
      if (roomEnclosureShapeVerification.accepted) {
        roomEnclosureRegistration =
          fitCandidateVisibleRegistrationGeometryToVerifiedRoomEnclosure({
            registration_geometry: args.registration_geometry,
            source_polygon: sourceObservedPolygon,
            native_room_polygon: verifiedNativeEnclosure,
            render_width_px: args.render_width_px,
            render_height_px: args.render_height_px
          });
        nativeRoomPixelPolygon = projectedNativeRoomPixelPolygon({
          native_room_polygon: nativeRoomPolygon,
          render_width_px: args.render_width_px,
          render_height_px: args.render_height_px,
          registration_geometry: args.registration_geometry
        });
        nativeRoomProjectionVisible = true;
      }
    }
  }
  if (!nativeRoomProjectionVisible) {
    const shapeDetail = roomEnclosureShapeVerification
      ? `:source_shape_accepted=${roomEnclosureShapeVerification.accepted}` +
        `:normalized_symmetric_hausdorff=${roomEnclosureShapeVerification.normalized_symmetric_hausdorff.toFixed(4)}` +
        `:normalized_area_difference=${roomEnclosureShapeVerification.normalized_area_difference.toFixed(4)}`
      : "";
    const enclosurePreconditionDetail = roomEnclosureShapeVerification
      ? ""
      : `:room_enclosure_preconditions=` + [
          `exact_tag_absent=${!exactTagNativeVisibleRoomLabel}`,
          `room_number=${!!roomNumber}`,
          `source_scope=${!!scope}`,
          `source_polygon=${!!sourceObservedPolygon}`,
          `native_polygon=${!!nativeRoomPolygon}`,
          `native_location=${!!nativeRoomScope?.location_model_point}`,
          `native_location_inside=${!!(
            nativeRoomScope?.location_model_point &&
            nativeRoomPolygon &&
            pointInsidePolygonOrNearBoundary(
              nativeRoomScope.location_model_point,
              nativeRoomPolygon,
              0.01
            )
          )}`,
          `source_label=${!!args.source_room_label_anchor}`,
          `source_enclosure_raster=${args.source_enclosure_raster_verification?.accepted === true}`,
          `source_enclosure_area=${args.source_enclosure_raster_verification?.polygon_area_ratio ?? "unavailable"}`,
          `source_enclosure_mean_edge=${args.source_enclosure_raster_verification?.mean_edge_support_ratio ?? "unavailable"}`,
          `source_enclosure_min_edge=${args.source_enclosure_raster_verification?.minimum_edge_support_ratio ?? "unavailable"}`,
          `source_label_identity=${!!(
            args.source_room_label_anchor &&
            roomLabelMatchesExactIdentity(
              normalizedRoomLabelToken(args.source_room_label_anchor.text),
              exactTagRoomToken,
              exactTagRoomNameToken
            )
          )}`
        ].join(",");
    throw new Error(
      "candidate_visible_verified_room_scope_not_visible_in_registered_render" +
      shapeDetail +
      enclosurePreconditionDetail
    );
  }
  if (!scope && roomNumber && nativeRoomPixelPolygon) {
    const normalizedBounds = (points: ExistingConditionsPlanPoint[]): string => {
      const bounds = pointBounds(points);
      return [
        bounds.min.x / args.render_width_px,
        bounds.min.y / args.render_height_px,
        bounds.max.x / args.render_width_px,
        bounds.max.y / args.render_height_px
      ].map((value) => value.toFixed(4)).join(",");
    };
    for (const [index, observation] of args.payload.observations.entries()) {
      const raw = observation as unknown as Record<string, unknown>;
      if (raw.kind === "electrical_circuit") continue;
      const routePoints = (Array.isArray(raw.pixel_points) ? raw.pixel_points : [])
        .map(normalizePoint)
        .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null);
      const point = normalizePoint(raw.pixel_point);
      const placement = raw.placement && typeof raw.placement === "object"
        ? raw.placement as Record<string, unknown>
        : null;
      const branchPoints = (
        Array.isArray(placement?.pixel_branch_points)
          ? placement.pixel_branch_points
          : []
      )
        .map(normalizePoint)
        .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null);
      const disjointGeometry =
        routePoints.length >= 2 &&
        !routeContainedInScope(routePoints, nativeRoomPixelPolygon, 1e-7) &&
        clipPolylineToPolygon(routePoints, nativeRoomPixelPolygon).length === 0
          ? routePoints
          : branchPoints.length >= 2 &&
              !routeContainedInScope(branchPoints, nativeRoomPixelPolygon, 1e-7) &&
              clipPolylineToPolygon(branchPoints, nativeRoomPixelPolygon).length === 0
            ? branchPoints
            : point && !pointInsidePolygonOrBoundary(point, nativeRoomPixelPolygon)
              ? [point]
              : null;
      if (!disjointGeometry) continue;
      const observationId = String(
        raw.observation_id ?? `candidate_visible_${index + 1}`
      ).trim();
      const sourceLabelUv = args.source_room_label_anchor
        ? [
            args.source_room_label_anchor.pixel_point.x / args.render_width_px,
            args.source_room_label_anchor.pixel_point.y / args.render_height_px
          ].map((value) => value.toFixed(4)).join(",")
        : "unavailable";
      throw new Error(
        `candidate_visible_source_room_enclosure_required:${roomNumber}:${observationId}` +
        `:source_uv_bounds=${normalizedBounds(disjointGeometry)}` +
        `:projected_native_scope_uv_bounds=${normalizedBounds(nativeRoomPixelPolygon)}` +
        `:source_room_label_uv=${sourceLabelUv}` +
        ":preserve_source_geometry_add_spatial_scope_or_defer"
      );
    }
  }
  const originalSourceObservedPolygon = sourceObservedPolygon
    ? sourceObservedPolygon.map((point) => ({ ...point }))
    : null;
  const originalSourceObservedAnchor = scope ? normalizePoint(scope.anchor_pixel_point) : null;
  let sourceObservedAnchor = originalSourceObservedAnchor;
  let sourceObservedClippingReceipts: CandidateVisibleRouteClippingReceipt[] = [];
  let localRoomRegistrationFallback:
    NonNullable<CandidateVisibleMepReconstruction["spatial_scope_receipt"]>["local_room_registration_fallback"] |
    undefined;
  if (
    exactTagTranslationApplied &&
    nativeRoomPixelPolygon &&
    exactTagNativeVisibleRoomLabel &&
    exactTagNativeLabelProjectedPoint &&
    args.source_room_label_anchor
  ) {
    const unsupportedSourceRoute =
      args.source_route_raster_verifications?.find((entry) => !entry.accepted);
    if (unsupportedSourceRoute) {
      throw new Error(
        `candidate_visible_route_raster_verification_required:` +
        `${unsupportedSourceRoute.observation_id}:` +
        `${unsupportedSourceRoute.geometry_role}` +
        `:support_modality=${unsupportedSourceRoute.support_modality}` +
        `:mean_support_ratio=${unsupportedSourceRoute.mean_support_ratio.toFixed(4)}` +
        `:minimum_segment_support_ratio=${unsupportedSourceRoute.minimum_segment_support_ratio.toFixed(4)}` +
        `:segment_support_ratios=${unsupportedSourceRoute.segment_support_ratios
          .map((value) => value.toFixed(4))
          .join(",")}` +
        `:required_minimum_mean_support_ratio=${unsupportedSourceRoute.minimum_mean_support_ratio.toFixed(4)}` +
        `:required_minimum_each_segment_support_ratio=${unsupportedSourceRoute.minimum_each_segment_support_ratio.toFixed(4)}` +
        (unsupportedSourceRoute.retrace_proposal
          ? `:candidate_retrace_uv=${unsupportedSourceRoute.retrace_proposal.normalized_uv_points
              .map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`)
              .join(";")}` +
            `:candidate_retrace_color=${unsupportedSourceRoute.retrace_proposal.target_color}` +
            `:candidate_retrace_policy_sha256=${unsupportedSourceRoute.retrace_proposal.extraction_policy_sha256}` +
            `:candidate_retrace_source_pixel_sha256=${unsupportedSourceRoute.retrace_proposal.source_pixel_sha256}` +
            `:candidate_retrace_reference_geometry_sha256=${unsupportedSourceRoute.retrace_proposal.reference_geometry_sha256}` +
            `:candidate_retrace_components=${unsupportedSourceRoute.retrace_proposal.component_ids.join(",")}` +
            `:candidate_retrace_corridor_radius_px=${unsupportedSourceRoute.retrace_proposal.corridor_radius_px.toFixed(4)}` +
            `:candidate_retrace_maximum_reference_distance_px=${unsupportedSourceRoute.retrace_proposal.maximum_reference_distance_px.toFixed(4)}` +
            `:candidate_retrace_runner_up_score_margin=${
              unsupportedSourceRoute.retrace_proposal.runner_up_score_margin == null
                ? "none"
                : unsupportedSourceRoute.retrace_proposal.runner_up_score_margin.toFixed(4)
            }`
          : "") +
        ":preserve_source_geometry_retrace_to_visible_centerline"
      );
    }
    const observationPoints = args.payload.observations.flatMap((observation) => {
      const raw = observation as unknown as Record<string, unknown>;
      const placement = raw.placement && typeof raw.placement === "object"
        ? raw.placement as Record<string, unknown>
        : null;
      return [
        ...(Array.isArray(raw.pixel_points) ? raw.pixel_points : []),
        ...(Array.isArray(placement?.pixel_branch_points)
          ? placement.pixel_branch_points
          : []),
        ...(raw.pixel_point ? [raw.pixel_point] : [])
      ]
        .map(normalizePoint)
        .filter((point): point is ExistingConditionsPlanPoint => point !== null);
    });
    const sourceEvidenceBounds = pointBounds(
      observationPoints.length > 0
        ? observationPoints
        : [args.source_room_label_anchor.pixel_point]
    );
    localRoomRegistrationFallback = {
      reason: exactTagStableLandmarkApplied
        ? "server_verified_room_tag_and_stable_boundary_similarity"
        : "server_verified_room_label_translation",
      source_room_label_evidence_basis:
        args.source_room_label_anchor.evidence_basis,
      source_scope_bounds: sourceEvidenceBounds,
      target_native_room_bounds: pointBounds(nativeRoomPixelPolygon),
      scale_x: exactTagStableLandmarkApplied
        ? args.stable_landmark_similarity!.similarity_scale
        : 1,
      scale_y: exactTagStableLandmarkApplied
        ? args.stable_landmark_similarity!.similarity_scale
        : 1,
      translation_x_px: rounded(exactTagTranslationX),
      translation_y_px: rounded(exactTagTranslationY),
      native_room_label_text: exactTagNativeVisibleRoomLabel.text,
      native_room_label_source_scoped_id:
        exactTagNativeVisibleRoomLabel.source_scoped_id,
      native_room_label_built_in_category:
        exactTagNativeVisibleRoomLabel.built_in_category,
      native_room_label_frame_id: exactTagNativeVisibleRoomLabel.frame_id,
      native_room_label_registration_frame_id:
        exactTagNativeVisibleRoomLabel.registration_frame_id,
      native_room_label_view_id: exactTagNativeVisibleRoomLabel.view_id,
      native_room_label_model_point: exactTagNativeVisibleRoomLabel.model_point,
      native_room_label_projected_pixel_point:
        exactTagNativeLabelProjectedPoint,
      source_render_mean_absolute_luminance_difference: rounded(
        args.source_room_label_anchor.source_render_mean_absolute_luminance_difference
      ),
      source_render_max_tile_mean_absolute_luminance_difference: rounded(
        args.source_room_label_anchor.source_render_max_tile_mean_absolute_luminance_difference
      ),
      source_render_changed_pixel_ratio: rounded(
        args.source_room_label_anchor.source_render_changed_pixel_ratio
      ),
      source_render_foreground_centroid_delta_px: rounded(
        args.source_room_label_anchor.source_render_foreground_centroid_delta_px
      ),
      ...(exactTagStableLandmarkApplied && args.stable_landmark_similarity
        ? { stable_landmark_similarity: args.stable_landmark_similarity }
        : {})
    };
    normalizationWarnings.push(
      exactTagStableLandmarkApplied
        ? "The exact room tag alone conflicted with the current room geometry, so registration used the tag plus a hash-bound stable exterior-wall control to fit one similarity scale before strict native-room clipping."
        : "The source PDF and focused Revit room-tag inventory uniquely identified the same room label, so registration was translated without planner-authored room geometry and without changing scale, rotation, or source observations before strict native-room clipping."
    );
  }
  if (
    !exactTagTranslationApplied &&
    roomNumber &&
    scope &&
    sourceObservedPolygon &&
    nativeRoomPixelPolygon &&
    args.source_enclosure_raster_verification &&
    args.source_enclosure_raster_verification.accepted !== true
  ) {
    const verification = args.source_enclosure_raster_verification;
    const sourceRoomLabelUv = args.source_room_label_anchor
      ? [
          args.source_room_label_anchor.pixel_point.x / args.render_width_px,
          args.source_room_label_anchor.pixel_point.y / args.render_height_px
        ].map((value) => value.toFixed(4)).join(",")
      : "unavailable";
    throw new Error(
      `candidate_visible_source_room_enclosure_raster_verification_required:${roomNumber}` +
      `:polygon_area_ratio=${verification.polygon_area_ratio.toFixed(4)}` +
      `:mean_edge_support_ratio=${verification.mean_edge_support_ratio.toFixed(4)}` +
      `:minimum_edge_support_ratio=${verification.minimum_edge_support_ratio.toFixed(4)}` +
      `:edge_support_ratios=${verification.edge_support_ratios
        .map((value) => value.toFixed(4))
        .join(",")}` +
      `:required_maximum_polygon_area_ratio=${verification.maximum_polygon_area_ratio.toFixed(4)}` +
      `:required_minimum_mean_edge_support_ratio=${verification.minimum_mean_edge_support_ratio.toFixed(4)}` +
      `:required_minimum_each_edge_support_ratio=${verification.minimum_each_edge_support_ratio.toFixed(4)}` +
      `:source_room_label_uv=${sourceRoomLabelUv}` +
      ":preserve_source_geometry_retrace_only_unsupported_enclosure_edges"
    );
  }
  if (
    !exactTagTranslationApplied &&
    roomNumber &&
    scope &&
    sourceObservedPolygon &&
    sourceObservedAnchor &&
    pointInsidePolygonOrBoundary(sourceObservedAnchor, sourceObservedPolygon) &&
    nativeRoomPixelPolygon
  ) {
    const nativeVisibleRoomLabel = nativeRoomScope?.visible_room_label;
    const originalNativeRoomLabelProjectedPoint = nativeVisibleRoomLabel
      ? mapModelPointToRegisteredRender(
          nativeVisibleRoomLabel.model_point,
          args.render_width_px,
          args.render_height_px,
          args.registration_geometry
        )
      : null;
    const sourceRoomLabelToken = normalizedRoomLabelToken(
      args.source_room_label_anchor?.text
    );
    const nativeRoomLabelToken = normalizedRoomLabelToken(
      nativeVisibleRoomLabel?.text
    );
    const roomToken = normalizedRoomLabelToken(roomNumber);
    const roomNameToken = normalizedRoomLabelToken(
      String(nativeRoomScope?.room_name ?? "").replace(roomNumber, "")
    );
    const roomLabelIdentityVerified =
      !!args.source_room_label_anchor &&
      args.source_enclosure_raster_verification?.accepted === true &&
      !!nativeVisibleRoomLabel &&
      nativeVisibleRoomLabel.registration_frame_id === args.registered_frame_id &&
      nativeVisibleRoomLabel.view_id === args.registered_view_id &&
      !!originalNativeRoomLabelProjectedPoint &&
      roomLabelMatchesExactIdentity(sourceRoomLabelToken, roomToken, roomNameToken) &&
      roomLabelMatchesExactIdentity(nativeRoomLabelToken, roomToken, roomNameToken) &&
      sourceRoomAnchorMatchesLocatedLabel({
        source_polygon: sourceObservedPolygon,
        submitted_anchor: sourceObservedAnchor,
        source_room_label_anchor: args.source_room_label_anchor,
        render_width_px: args.render_width_px,
        render_height_px: args.render_height_px
      });
    let translationX = 0;
    let translationY = 0;
    if (
      roomLabelIdentityVerified &&
      originalNativeRoomLabelProjectedPoint &&
      args.source_room_label_anchor
    ) {
      translationX =
        originalNativeRoomLabelProjectedPoint.x -
        args.source_room_label_anchor.pixel_point.x;
      translationY =
        originalNativeRoomLabelProjectedPoint.y -
        args.source_room_label_anchor.pixel_point.y;
      shiftCandidateVisibleRegistrationGeometrySourcePixels({
        registration_geometry: args.registration_geometry,
        delta_x_px: translationX,
        delta_y_px: translationY
      });
      nativeRoomPixelPolygon = nativeRoomPolygon
        ? projectedNativeRoomPixelPolygon({
            native_room_polygon: nativeRoomPolygon,
            render_width_px: args.render_width_px,
            render_height_px: args.render_height_px,
            registration_geometry: args.registration_geometry
          })
        : null;
      if (!nativeRoomPixelPolygon) {
        throw new Error("candidate_visible_native_room_projection_required_after_label_registration");
      }
    }
    const sourceBounds = pointBounds(sourceObservedPolygon);
    const targetBounds = pointBounds(nativeRoomPixelPolygon);
    const minimumAreaOverlapRatio = boundsIntersectionRatio(sourceBounds, targetBounds);
    if (minimumAreaOverlapRatio < 0.75) {
      const sourceRoomLabelUv = args.source_room_label_anchor
        ? [
            args.source_room_label_anchor.pixel_point.x / args.render_width_px,
            args.source_room_label_anchor.pixel_point.y / args.render_height_px
          ].map((value) => value.toFixed(4)).join(",")
        : "unavailable";
      throw new Error(
        `candidate_visible_source_room_label_registration_required:${roomNumber}` +
        `:source_native_bounds_overlap=${minimumAreaOverlapRatio.toFixed(6)}` +
        `:source_room_label_uv=${sourceRoomLabelUv}` +
        ":preserve_source_geometry_do_not_scale_or_translate_without_exact_room_tag"
      );
    }
    // Local room crops may recover translation only from the exact room label
    // pair. Scale and orientation remain those of the server-owned sheet
    // registration; no source room bounds are stretched onto native bounds.
    const registrationReason = roomLabelIdentityVerified
      ? "server_verified_room_label_translation" as const
      : roomEnclosureRegistration
        ? "server_verified_room_enclosure_similarity" as const
        : null;
    if (registrationReason) {
      validateCandidateVisiblePointsToScope(
        args.payload,
        sourceObservedPolygon,
        "candidate_visible_point_outside_source_observed_scope"
      );
      sourceObservedClippingReceipts = clipCandidateVisibleRoutesToScope(
        args.payload,
        sourceObservedPolygon,
        args.render_width_px,
        args.render_height_px,
        "source_observed_scope_before_local_room_registration"
      );
      localRoomRegistrationFallback = {
        reason: registrationReason,
        ...(args.source_room_label_anchor
          ? {
              source_room_label_evidence_basis:
                args.source_room_label_anchor.evidence_basis
            }
          : {}),
        source_scope_bounds: sourceBounds,
        target_native_room_bounds: targetBounds,
        scale_x: roomEnclosureRegistration?.similarity_scale ?? 1,
        scale_y: roomEnclosureRegistration?.similarity_scale ?? 1,
        ...(roomEnclosureRegistration
          ? {
              translation_x_px: rounded(
                roomEnclosureRegistration.translation_x_px
              ),
              translation_y_px: rounded(
                roomEnclosureRegistration.translation_y_px
              ),
              source_room_shape_verification:
                roomEnclosureShapeVerification ?? undefined,
              native_enclosure_basis: roomEnclosureNativeBasis
            }
          : {}),
        ...(nativeVisibleRoomLabel &&
        originalNativeRoomLabelProjectedPoint
          ? {
              translation_x_px: rounded(translationX),
              translation_y_px: rounded(translationY),
              native_room_label_text: nativeVisibleRoomLabel.text,
              native_room_label_source_scoped_id:
                nativeVisibleRoomLabel.source_scoped_id,
              native_room_label_built_in_category:
                nativeVisibleRoomLabel.built_in_category,
              native_room_label_frame_id: nativeVisibleRoomLabel.frame_id,
              native_room_label_registration_frame_id:
                nativeVisibleRoomLabel.registration_frame_id,
              native_room_label_view_id: nativeVisibleRoomLabel.view_id,
              native_room_label_model_point: nativeVisibleRoomLabel.model_point,
              native_room_label_projected_pixel_point:
                originalNativeRoomLabelProjectedPoint,
              source_render_mean_absolute_luminance_difference: rounded(
                args.source_room_label_anchor?.source_render_mean_absolute_luminance_difference ?? 0
              ),
              source_render_max_tile_mean_absolute_luminance_difference: rounded(
                args.source_room_label_anchor?.source_render_max_tile_mean_absolute_luminance_difference ?? 0
              ),
              source_render_changed_pixel_ratio: rounded(
                args.source_room_label_anchor?.source_render_changed_pixel_ratio ?? 0
              ),
              source_render_foreground_centroid_delta_px: rounded(
                args.source_room_label_anchor?.source_render_foreground_centroid_delta_px ?? 0
              ),
              ...(args.source_enclosure_raster_verification
                ? {
                    source_enclosure_raster_verification:
                      args.source_enclosure_raster_verification
                  }
                : {})
            }
          : {})
      };
      normalizationWarnings.push(
        roomEnclosureRegistration
          ? "The exact source room label, raster-verified source enclosure, verified linked-room identity, and matching room shape repaired a false-positive sheet crop with one similarity fit; source observations were unchanged before strict native-room clipping."
          : "The source PDF and focused Revit room-tag inventory uniquely identified the same room label, so the source-local registration geometry was translated without changing scale, rotation, or source observations before strict native-room clipping."
      );
    }
  }
  // A verified room-enclosure similarity is intentionally uniform: it does not
  // stretch a source trace to force an exact native outline. Use the
  // raster-verified source enclosure for source-pixel clipping, then retain the
  // independent native-room containment check below (with its bounded model
  // tolerance) for every mapped route and point.
  const polygon = roomEnclosureRegistration && sourceObservedPolygon
    ? sourceObservedPolygon
    : nativeRoomPixelPolygon ?? sourceObservedPolygon;
  if (!polygon) throw new Error("candidate_visible_scope_polygon_required");
  if (roomEnclosureRegistration && sourceObservedPolygon) {
    normalizationWarnings.push(
      "Used the raster-verified source enclosure for source-pixel clipping after the room similarity fit; mapped geometry remains independently constrained to the verified native linked-room boundary."
    );
  } else if (nativeRoomPixelPolygon) {
    normalizationWarnings.push(
      nativeRoomScope
        ? "Used the verified native linked-room boundary projected into registered source pixels as the authoritative spatial scope."
        : "Used the server-derived aligned-crop boundary, backed by durable source/native landmark receipts, as the authoritative spatial scope."
    );
  }
  if (
    scope &&
    (!sourceObservedAnchor ||
      !Number.isFinite(sourceObservedAnchor.x) ||
      !Number.isFinite(sourceObservedAnchor.y))
  ) {
    normalizationWarnings.push("Ignored an invalid planner room anchor and used the verified projected room scope.");
  }
  if (
    sourceObservedAnchor &&
    sourceObservedPolygon &&
    !pointInsidePolygonOrBoundary(sourceObservedAnchor, sourceObservedPolygon)
  ) {
    normalizationWarnings.push("Planner room anchor was outside its observed boundary and was not used as the verified scope anchor.");
  }
  let projectedLocation = nativeRoomScope?.location_model_point
    ? mapModelPointToRegisteredRender(
        nativeRoomScope.location_model_point,
        args.render_width_px,
        args.render_height_px,
        args.registration_geometry
      )
    : null;
  if (projectedLocation && !pointInsidePolygonOrBoundary(projectedLocation, polygon)) {
    projectedLocation = null;
  }
  const anchor =
    sourceObservedAnchor && pointInsidePolygonOrBoundary(sourceObservedAnchor, polygon)
      ? sourceObservedAnchor
      : projectedLocation ?? polygonAnchor(polygon);
  if (sourceObservedAnchor && anchor !== sourceObservedAnchor) {
    normalizationWarnings.push(
      "Planner room anchor did not agree with the verified projected room boundary and was replaced."
    );
  }
  const anchorLabel = String(scope?.anchor_label ?? "").trim() || `ROOM ${roomNumber || "UNSPECIFIED"}`;
  const evidenceReference = String(scope?.evidence_reference ?? "").trim() ||
    "Verified linked-room boundary projected into the registered source render.";
  if (roomNumber && !anchorLabel.toLowerCase().includes(roomNumber.toLowerCase())) {
    throw new Error(`candidate_visible_scope_anchor_must_include_room_number:${roomNumber}`);
  }

  const routeClippingReceipts = [
    ...sourceObservedClippingReceipts,
    ...clipCandidateVisibleRoutesToScope(
      args.payload,
      polygon,
      args.render_width_px,
      args.render_height_px,
      localRoomRegistrationFallback
        ? "authoritative_scope_after_registration"
        : undefined
    )
  ];
  if (routeClippingReceipts.length > 0) {
    normalizationWarnings.push(
      `Clipped ${routeClippingReceipts.length} source route or branch geometries to the authoritative spatial scope; disjoint out-of-scope portions were not reconnected.`
    );
  }
  const checkedObservationIds: string[] = [];
  for (const [index, observation] of args.payload.observations.entries()) {
    const raw = observation as unknown as Record<string, unknown>;
    const observationId = String(raw.observation_id ?? `candidate_visible_${index + 1}`).trim();
    if (raw.kind === "electrical_circuit") continue;
    const routePoints = (Array.isArray(raw.pixel_points) ? raw.pixel_points : [])
      .map(normalizePoint)
      .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null);
    if (routePoints.length > 0) {
      if (!routeContainedInScope(routePoints, polygon, 1e-7)) {
        throw new Error(`candidate_visible_route_outside_spatial_scope:${observationId}`);
      }
      if (nativeRoomPolygon) {
        const modelRoute = routePoints.map((entry) => mapRegisteredRenderPointToModel(
          entry,
          args.render_width_px,
          args.render_height_px,
          args.registration_geometry
        ));
        if (
          !routeContainedInScope(modelRoute, nativeRoomPolygon, 0.75)
        ) {
          throw new Error(
            `${nativeRoomScope
              ? "candidate_visible_route_outside_native_room_scope"
              : "candidate_visible_route_outside_native_landmark_scope"}:${observationId}`
          );
        }
      }
      checkedObservationIds.push(observationId);
      continue;
    }
    const point = normalizePoint(raw.pixel_point);
    if (point) {
      if (!pointInsidePolygonOrBoundary(point, polygon)) {
        throw new Error(`candidate_visible_point_outside_spatial_scope:${observationId}`);
      }
      if (nativeRoomPolygon) {
        const modelPoint = mapRegisteredRenderPointToModel(
          point,
          args.render_width_px,
          args.render_height_px,
          args.registration_geometry
        );
        if (!pointInsidePolygonOrNearBoundary(modelPoint, nativeRoomPolygon, 0.75)) {
          throw new Error(
            `${nativeRoomScope
              ? "candidate_visible_point_outside_native_room_scope"
              : "candidate_visible_point_outside_native_landmark_scope"}:${observationId}`
          );
        }
      }
      checkedObservationIds.push(observationId);
    }
    const placement = raw.placement && typeof raw.placement === "object"
      ? raw.placement as Record<string, unknown>
      : null;
    const branchPoints = (Array.isArray(placement?.pixel_branch_points) ? placement.pixel_branch_points : [])
      .map(normalizePoint)
      .filter((entry): entry is ExistingConditionsPlanPoint => entry !== null);
    if (branchPoints.length > 0 && !routeContainedInScope(branchPoints, polygon, 1e-7)) {
      throw new Error(`candidate_visible_branch_outside_spatial_scope:${observationId}`);
    }
    if (branchPoints.length > 0 && nativeRoomPolygon) {
      const modelBranch = branchPoints.map((entry) => mapRegisteredRenderPointToModel(
        entry,
        args.render_width_px,
        args.render_height_px,
        args.registration_geometry
      ));
      if (
        !routeContainedInScope(modelBranch, nativeRoomPolygon, 0.75)
      ) {
        throw new Error(
          `${nativeRoomScope
            ? "candidate_visible_branch_outside_native_room_scope"
            : "candidate_visible_branch_outside_native_landmark_scope"}:${observationId}`
        );
      }
    }
  }
  const modelBoundaryPoints = polygon.map((entry) => mapRegisteredRenderPointToModel(
    entry,
    args.render_width_px,
    args.render_height_px,
    args.registration_geometry
  ));
  if (nativeRoomPolygon && !roomEnclosureRegistration) {
    for (const [index, point] of modelBoundaryPoints.entries()) {
      if (!pointInsidePolygonOrNearBoundary(point, nativeRoomPolygon, 0.75)) {
        throw new Error(
          `${nativeRoomScope
            ? "candidate_visible_projected_room_boundary_outside_native_room_scope"
            : "candidate_visible_projected_area_boundary_outside_native_landmark_scope"}:${index}` +
          `:point=${point.x.toFixed(4)},${point.y.toFixed(4)}` +
          `:native_bounds=${JSON.stringify(pointBounds(nativeRoomPolygon))}`
        );
      }
    }
  }
  if (nativeRoomPolygon) {
    const modelAnchor = mapRegisteredRenderPointToModel(
      anchor,
      args.render_width_px,
      args.render_height_px,
      args.registration_geometry
    );
    if (!pointInsidePolygonOrNearBoundary(modelAnchor, nativeRoomPolygon, 0.75)) {
      throw new Error(
        nativeRoomScope
          ? "candidate_visible_source_room_anchor_outside_native_room_scope"
          : "candidate_visible_source_anchor_outside_native_landmark_scope"
      );
    }
  }
  return {
    anchor_label: anchorLabel,
    evidence_reference: evidenceReference,
    boundary_pixel_points: polygon,
    anchor_pixel_point: anchor,
    ...(originalSourceObservedPolygon
      ? { source_observed_boundary_pixel_points: originalSourceObservedPolygon }
      : {}),
    ...(originalSourceObservedAnchor
      ? { source_observed_anchor_pixel_point: originalSourceObservedAnchor }
      : {}),
    model_boundary_points: modelBoundaryPoints,
    ...(nativeRoomScope
      ? {
          native_room_source_scoped_id: nativeRoomScope.source_scoped_id,
          native_room_boundary_model_points: nativeRoomPolygon ?? []
        }
      : {}),
    ...(nativeLandmarkScope
      ? {
          native_area_source_scoped_id: nativeLandmarkScope.source_scoped_id,
          native_area_boundary_model_points: nativeRoomPolygon ?? [],
          durable_landmark_registration: nativeLandmarkScope
        }
      : {}),
    checked_observation_ids: checkedObservationIds,
    source_observations_sha256: originalSourceObservationsSha256,
    source_observations: originalSourceObservations,
    ...(routeClippingReceipts.length > 0
      ? { route_clipping_receipts: routeClippingReceipts }
      : {}),
    ...(args.source_route_raster_verifications &&
    args.source_route_raster_verifications.length > 0
      ? {
          source_route_raster_verifications:
            args.source_route_raster_verifications
        }
      : {}),
    ...(localRoomRegistrationFallback
      ? { local_room_registration_fallback: localRoomRegistrationFallback }
      : {}),
    boundary_basis: nativeRoomPixelPolygon
      ? nativeRoomScope
        ? "verified_native_room_projected_to_registered_render"
        : "verified_durable_landmark_area_projected_to_registered_render"
      : "source_observed",
    ...(normalizationWarnings.length > 0
      ? { normalization_warnings: normalizationWarnings }
      : {})
  };
}

export function deriveCandidateVisibleRegistrationGeometry(args: {
  alignment: CandidateVisibleAlignment;
  frame: CandidateVisibleFrameMapping;
  render_width_px: number;
  render_height_px: number;
}): {
  control_points: Array<{ source: ExistingConditionsPlanPoint; model: ExistingConditionsPlanPoint }>;
  model_bounds: { min: ExistingConditionsPlanPoint; max: ExistingConditionsPlanPoint };
} {
  if (!args.alignment.matched || args.alignment.confidence < 0.35 || !args.alignment.crop) {
    throw new Error("candidate_visible_alignment_not_verified");
  }
  const crop = args.alignment.crop;
  for (const [key, value] of Object.entries(crop)) finite(value, `alignment_crop_${key}`);
  if (
    crop.min_u < 0 || crop.min_v < 0 || crop.max_u > 1 || crop.max_v > 1 ||
    crop.max_u <= crop.min_u || crop.max_v <= crop.min_v
  ) {
    throw new Error("candidate_visible_alignment_crop_invalid");
  }
  positiveInteger(args.frame.view_id, "frame_view_id");
  positiveInteger(args.frame.width_px, "frame_width_px");
  positiveInteger(args.frame.height_px, "frame_height_px");
  const width = positiveInteger(args.render_width_px, "render_width_px");
  const height = positiveInteger(args.render_height_px, "render_height_px");

  const sourceCorners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height }
  ];
  const centerU = (crop.min_u + crop.max_u) / 2;
  const centerV = (crop.min_v + crop.max_v) / 2;
  const center = mapFrameNormalizedPoint(args.frame, centerU, centerV);
  const horizontalStart = mapFrameNormalizedPoint(args.frame, crop.min_u, centerV);
  const horizontalEnd = mapFrameNormalizedPoint(args.frame, crop.max_u, centerV);
  const verticalStart = mapFrameNormalizedPoint(args.frame, centerU, crop.min_v);
  const verticalEnd = mapFrameNormalizedPoint(args.frame, centerU, crop.max_v);
  const horizontalVector = {
    x: horizontalEnd.x - horizontalStart.x,
    y: horizontalEnd.y - horizontalStart.y
  };
  const verticalVector = {
    x: verticalEnd.x - verticalStart.x,
    y: verticalEnd.y - verticalStart.y
  };
  const horizontalLength = Math.hypot(horizontalVector.x, horizontalVector.y);
  const verticalLength = Math.hypot(verticalVector.x, verticalVector.y);
  if (horizontalLength <= 1e-9 || verticalLength <= 1e-9) {
    throw new Error("candidate_visible_alignment_crop_is_degenerate");
  }
  const xAxis = {
    x: horizontalVector.x / horizontalLength,
    y: horizontalVector.y / horizontalLength
  };
  const verticalUnit = {
    x: verticalVector.x / verticalLength,
    y: verticalVector.y / verticalLength
  };
  const leftNormal = { x: -xAxis.y, y: xAxis.x };
  const rightNormal = { x: xAxis.y, y: -xAxis.x };
  const yAxis = leftNormal.x * verticalUnit.x + leftNormal.y * verticalUnit.y >=
      rightNormal.x * verticalUnit.x + rightNormal.y * verticalUnit.y
    ? leftNormal
    : rightNormal;
  // Visual alignment rectangles are approximate and may not preserve the
  // source raster aspect exactly. Fit one similarity scale around the matched
  // center instead of treating both independently estimated crop spans as
  // exact controls.
  const scale = Math.sqrt((horizontalLength / width) * (verticalLength / height));
  const mappedCorners = sourceCorners.map((source) => {
    const dx = source.x - width / 2;
    const dy = source.y - height / 2;
    return {
      x: center.x + scale * (xAxis.x * dx + yAxis.x * dy),
      y: center.y + scale * (xAxis.y * dx + yAxis.y * dy)
    };
  });
  return {
    control_points: sourceCorners.slice(0, 3).map((source, index) => ({
      source,
      model: mappedCorners[index]!
    })),
    model_bounds: {
      min: {
        x: Math.min(...mappedCorners.map((entry) => entry.x)),
        y: Math.min(...mappedCorners.map((entry) => entry.y))
      },
      max: {
        x: Math.max(...mappedCorners.map((entry) => entry.x)),
        y: Math.max(...mappedCorners.map((entry) => entry.y))
      }
    }
  };
}

function validateCandidateVisibleLandmarkScopeReceipt(
  scope: NonNullable<CandidateVisibleMepReconstructionInput["verified_landmark_scope"]>,
  frame: CandidateVisibleFrameMapping,
  alignment: CandidateVisibleAlignment,
  sourceHash: string,
  renderHash: string
): void {
  if (
    scope.basis !== "durable_landmarks_in_aligned_crop" ||
    !Array.isArray(scope.registration_controls) ||
    scope.registration_controls.length < 2 ||
    !Array.isArray(scope.landmark_matches) ||
    scope.landmark_matches.length !== scope.registration_controls.length ||
    scope.source_pdf_sha256 !== sourceHash ||
    scope.registered_render_sha256 !== renderHash ||
    !/^[a-f0-9]{64}$/i.test(scope.alignment_receipt_sha256) ||
    !/^[a-f0-9]{64}$/i.test(scope.inventory_receipt_sha256) ||
    !Number.isFinite(scope.maximum_crop_residual) ||
    scope.maximum_crop_residual < 0 ||
    scope.maximum_crop_residual > 0.08 ||
    !Number.isFinite(scope.source_control_span) ||
    scope.source_control_span < 0.2 ||
    !Number.isFinite(scope.view_control_span) ||
    scope.view_control_span < 0.1
  ) {
    throw new Error("candidate_visible_durable_landmark_receipt_invalid");
  }
  const controlsValid = scope.registration_controls.every((control) =>
    !!String(control.kind ?? "").trim() &&
    control.score >= 0.55 &&
    Number.isFinite(control.score) &&
    Number.isFinite(control.crop_residual) &&
    control.crop_residual >= 0 &&
    control.crop_residual <= 0.08 &&
    Number.isFinite(control.source_normalized_point?.x) &&
    Number.isFinite(control.source_normalized_point?.y) &&
    Number.isFinite(control.view_normalized_point?.x) &&
    Number.isFinite(control.view_normalized_point?.y)
  );
  const nativeLandmarksValid = scope.landmark_matches.every((landmark, index) =>
    landmark.control_index === index &&
    !!String(landmark.native_source_scoped_id ?? "").trim() &&
    !!String(landmark.native_built_in_category ?? "").trim() &&
    Number.isFinite(landmark.native_model_point?.x) &&
    Number.isFinite(landmark.native_model_point?.y) &&
    Number.isFinite(landmark.native_projected_view_normalized_point?.x) &&
    Number.isFinite(landmark.native_projected_view_normalized_point?.y) &&
    Number.isFinite(landmark.projected_distance_normalized) &&
    landmark.projected_distance_normalized >= 0 &&
    candidateVisibleLandmarkDistanceWithinThreshold(
      landmark.projected_distance_normalized
    ) &&
    (
      landmark.geometry_basis === "projected_geometry" ||
      landmark.geometry_basis === "projected_bbox"
    )
  );
  const uniqueNativeIds = new Set(
    scope.landmark_matches.map((landmark) =>
      String(landmark.native_source_scoped_id ?? "").trim()
    )
  );
  const expectedAlignmentReceiptSha256 = sha256Json({
    frame_id: frame.frame_id,
    view_id: frame.view_id,
    matched: alignment.matched,
    confidence: alignment.confidence,
    crop: alignment.crop,
    provider: alignment.provider,
    model: alignment.model,
    attempted_models: alignment.attempted_models,
    fallback_reason: alignment.fallback_reason,
    registration_controls: scope.registration_controls
  });
  if (
    !controlsValid ||
    scope.registration_controls.every((control) =>
      String(control.kind ?? "").trim().toLowerCase() === "persistent_interior"
    ) ||
    !nativeLandmarksValid ||
    uniqueNativeIds.size !== scope.landmark_matches.length ||
    scope.alignment_receipt_sha256 !== expectedAlignmentReceiptSha256
  ) {
    throw new Error("candidate_visible_durable_landmark_receipt_invalid");
  }
  const receiptContent = {
    frame_id: frame.frame_id,
    view_id: frame.view_id,
    source_pdf_sha256: scope.source_pdf_sha256,
    registered_render_sha256: scope.registered_render_sha256,
    alignment_receipt_sha256: scope.alignment_receipt_sha256,
    inventory_receipt_sha256: scope.inventory_receipt_sha256,
    controls: scope.registration_controls,
    landmark_matches: scope.landmark_matches
  };
  const expectedSourceScopedId =
    `aligned-crop-landmarks:${sha256Json(receiptContent)}`;
  if (scope.source_scoped_id !== expectedSourceScopedId) {
    throw new Error("candidate_visible_durable_landmark_receipt_hash_mismatch");
  }
}

export async function compileCandidateVisibleMepReconstruction(
  input: CandidateVisibleMepReconstructionInput
): Promise<CandidateVisibleMepReconstruction> {
  if (!input.verified_room_scope && !input.verified_landmark_scope) {
    throw new Error("candidate_visible_authoritative_native_scope_required");
  }
  if (input.verified_room_scope && input.verified_landmark_scope) {
    throw new Error("candidate_visible_authoritative_scope_is_ambiguous");
  }
  const sourcePdfPath = requireFile(input.source_pdf_path, "candidate_visible_source_pdf");
  const renderPath = requireFile(input.registered_render_path, "candidate_visible_registered_render");
  const sourceHash = sha256File(sourcePdfPath);
  const renderHash = sha256File(renderPath);
  if (input.verified_landmark_scope) {
    validateCandidateVisibleLandmarkScopeReceipt(
      input.verified_landmark_scope,
      input.frame,
      input.alignment,
      sourceHash,
      renderHash
    );
  }
  const render = await loadImage(renderPath);
  const width = positiveInteger(render.width, "registered_render_width_px");
  const height = positiveInteger(render.height, "registered_render_height_px");
  const geometry = deriveCandidateVisibleRegistrationGeometry({
    alignment: input.alignment,
    frame: input.frame,
    render_width_px: width,
    render_height_px: height
  });
  const verifiedLandmarkScope = input.verified_landmark_scope
    ? {
        ...input.verified_landmark_scope,
        boundary_model_points: [
          geometry.control_points[0]!.model,
          geometry.control_points[1]!.model,
          {
            x:
              geometry.control_points[1]!.model.x +
              geometry.control_points[2]!.model.x -
              geometry.control_points[0]!.model.x,
            y:
              geometry.control_points[1]!.model.y +
              geometry.control_points[2]!.model.y -
              geometry.control_points[0]!.model.y
          },
          geometry.control_points[2]!.model
        ]
      }
    : null;
  const registrationContextId = sha256Json({
    schema_version: 1,
    source_evidence_sha256: sourceHash,
    registered_render_sha256: renderHash,
    frame: input.frame,
    alignment: input.alignment,
    verified_room_scope: input.verified_room_scope ?? null,
    verified_landmark_scope: verifiedLandmarkScope ?? null
  });
  const normalizedPlanner = normalizeCandidateVisiblePlannerPayload(
    input.planner_payload,
    input.frame,
    width,
    height
  );
  const payload = normalizedPlanner.payload;
  const observationLimit = positiveInteger(payload.maximum_observations, "maximum_observations");
  if (!Array.isArray(payload.observations) || payload.observations.length === 0) {
    const deferredProvisionalSymbol = (
      Array.isArray(input.planner_payload.observations)
        ? input.planner_payload.observations as unknown as Array<Record<string, unknown>>
        : []
    ).find((observation) =>
      String(observation.kind ?? "").trim() === "plumbing_fixture" &&
      normalizedText(
        (observation.placement as Record<string, unknown> | undefined)?.mode
      ) === "provisional_plan_symbol" &&
      normalizedText(
        (
          observation.representation_classification as
            Record<string, unknown> | undefined
        )?.source_graphic
      ) !== "mep_connection_symbol"
    );
    if (deferredProvisionalSymbol) {
      const observationId = String(
        deferredProvisionalSymbol.observation_id ?? "unidentified_observation"
      ).trim().replace(/:/g, "_");
      throw new Error(
        "candidate_visible_provisional_plan_symbol_source_graphic_required:" +
        `${observationId}:` +
        "set_representation_classification_source_graphic_to_mep_connection_symbol_only_if_source_visible"
      );
    }
    throw new Error("candidate_visible_observations_are_required");
  }
  if (payload.observations.length > observationLimit) {
    throw new Error("candidate_visible_observation_limit_exceeded");
  }
  const roomNumber = String(payload.room_number ?? "").trim();
  const sourceRoomLabelAnchor = roomNumber
      ? await locateUniqueSourceRoomLabelAnchor({
        source_pdf_path: sourcePdfPath,
        registered_render_path: renderPath,
        room_number: roomNumber,
        render_width_px: width,
        render_height_px: height
      }) ?? await locateUniqueStructuredSourceRoomLabelAnchor({
        source_path: sourcePdfPath,
        registered_render_path: renderPath,
        room_number: roomNumber,
        render_width_px: width,
        render_height_px: height,
        alignment: input.alignment
      })
    : null;
  const sourceEnclosureRasterVerification =
    sourceRoomLabelAnchor && payload.spatial_scope
      ? await verifySourceEnclosureRaster({
          registered_render_path: renderPath,
          boundary_pixel_points:
            payload.spatial_scope.boundary_pixel_points,
          render_width_px: width,
          render_height_px: height
        })
      : null;
  const stableLandmarkSimilarity =
    sourceRoomLabelAnchor &&
    payload.spatial_scope &&
    sourceEnclosureRasterVerification &&
    input.verified_room_scope?.visible_room_label &&
    input.verified_room_scope.stable_boundary_segments?.length
      ? await deriveCandidateVisibleStableLandmarkSimilarity({
          registered_render_path: renderPath,
          render_width_px: width,
          render_height_px: height,
          registration_geometry: geometry,
          source_room_label_anchor: sourceRoomLabelAnchor,
          source_boundary_pixel_points:
            payload.spatial_scope.boundary_pixel_points,
          source_boundary_edge_support_ratios:
            sourceEnclosureRasterVerification.edge_support_ratios,
          native_room_label_model_point:
            input.verified_room_scope.visible_room_label.model_point,
          stable_boundary_segments:
            input.verified_room_scope.stable_boundary_segments
        })
      : null;
  const sourceRouteRasterVerifications = await verifySourceRouteRaster({
    registered_render_path: renderPath,
    observations: payload.observations,
    render_width_px: width,
    render_height_px: height
  });
  if (verifiedLandmarkScope) {
    const routeGeometryCount = payload.observations.reduce((count, observation) => {
      const raw = observation as unknown as Record<string, unknown>;
      const placement =
        raw.placement && typeof raw.placement === "object" && !Array.isArray(raw.placement)
          ? raw.placement as Record<string, unknown>
          : null;
      return count +
        (Array.isArray(raw.pixel_points) && raw.pixel_points.length >= 2 ? 1 : 0) +
        (Array.isArray(placement?.pixel_branch_points) &&
        placement.pixel_branch_points.length >= 2
          ? 1
          : 0);
    }, 0);
    if (
      routeGeometryCount <= 0 ||
      sourceRouteRasterVerifications.length !== routeGeometryCount
    ) {
      throw new Error(
        "candidate_visible_landmark_scope_requires_complete_source_route_raster_receipts"
      );
    }
    const unsupportedSourceRoute =
      sourceRouteRasterVerifications.find((entry) => !entry.accepted);
    if (unsupportedSourceRoute) {
      throw new Error(
        `candidate_visible_route_raster_verification_required:` +
        `${unsupportedSourceRoute.observation_id}:` +
        `${unsupportedSourceRoute.geometry_role}` +
        `:support_modality=${unsupportedSourceRoute.support_modality}` +
        `:mean_support_ratio=${unsupportedSourceRoute.mean_support_ratio.toFixed(4)}` +
        `:minimum_segment_support_ratio=${unsupportedSourceRoute.minimum_segment_support_ratio.toFixed(4)}` +
        ":preserve_landmark_registration_retrace_only_unsupported_route"
      );
    }
  }
  const spatialScopeReceipt = validateCandidateVisibleSpatialScope({
    payload,
    render_width_px: width,
    render_height_px: height,
    registration_geometry: geometry,
    registered_frame_id: input.frame.frame_id,
    registered_view_id: input.frame.view_id,
    ...(input.verified_room_scope ? { verified_room_scope: input.verified_room_scope } : {}),
    ...(verifiedLandmarkScope
      ? { verified_landmark_scope: verifiedLandmarkScope }
      : {}),
    ...(sourceRoomLabelAnchor ? { source_room_label_anchor: sourceRoomLabelAnchor } : {}),
    ...(sourceEnclosureRasterVerification
      ? { source_enclosure_raster_verification: sourceEnclosureRasterVerification }
      : {}),
    ...(sourceRouteRasterVerifications.length > 0
      ? { source_route_raster_verifications: sourceRouteRasterVerifications }
      : {}),
    ...(stableLandmarkSimilarity
      ? { stable_landmark_similarity: stableLandmarkSimilarity }
      : {})
  });

  const registeredPackage: RegisteredMepObservationPackage = {
    schema_version: payload.schema_version,
    fixture_id: String(payload.fixture_id ?? "").trim(),
    scope_id: String(payload.scope_id ?? "").trim(),
    discipline: payload.discipline,
    source_evidence_sha256: sourceHash,
    visible_evidence: [
      { role: "source_pdf", sha256: sourceHash },
      { role: "registered_source_render", sha256: renderHash },
      ...(payload.native_element_references?.some((entry) => entry.evidence_role === "candidate_visible_frame_mapping")
        ? [{ role: "candidate_visible_frame_mapping", sha256: normalizedPlanner.frameEvidenceHash }]
        : [])
    ],
    native_element_references: Array.isArray(payload.native_element_references)
      ? payload.native_element_references
      : [],
    registration: {
      source_evidence_sha256: sourceHash,
      control_points: geometry.control_points,
      allow_reflection: true,
      max_rms_error_ft: 0.01,
      max_point_error_ft: 0.02
    },
    coordinate_space: "registered_render_pixels_top_left",
    registered_render: {
      path: renderPath,
      sha256: renderHash,
      width_px: width,
      height_px: height,
      evidence_role: "registered_source_render",
      access_scope: "agent_visible"
    },
    frame: { model_bounds: geometry.model_bounds },
    level_name: String(payload.level_name ?? "").trim(),
    level_elevation_ft: input.frame.target_level_elevation_ft,
    target_view_reference_key: "candidate_visible_aligned_view",
    ...(typeof payload.room_number === "string" && payload.room_number.trim()
      ? { room_number: payload.room_number.trim() }
      : {}),
    ...(typeof payload.material_confidence_threshold === "number"
      ? { material_confidence_threshold: payload.material_confidence_threshold }
      : {}),
    ...(payload.partial_promotion_policy
      ? { partial_promotion_policy: payload.partial_promotion_policy }
      : {}),
    maximum_observations: observationLimit,
    observations: payload.observations
  };
  const compilation = await compileRegisteredMepObservations(registeredPackage);
  const workflow = buildAtomicMepDraftWorkflowRequest(compilation.compiled_plan, {
    dry_run: true,
    ...(input.maximum_created_elements == null
      ? {}
      : { maximum_created_elements: positiveInteger(input.maximum_created_elements, "maximum_created_elements") })
  });
  return {
    registration_context_id: registrationContextId,
    package: registeredPackage,
    compilation,
    workflow,
    planner_normalization_warnings: normalizedPlanner.warnings,
    ...(spatialScopeReceipt ? { spatial_scope_receipt: spatialScopeReceipt } : {})
  };
}
