import crypto from "node:crypto";
import type { CandidateVisibleFrameMapping } from "./candidate_visible_registration.js";
import type { SheetPixelEvidenceReceiptV1 } from "./sheet_pixel_evidence.js";
import {
  compileSheetTopologyV1,
  type CompiledSheetTopologyV1,
  type SheetTopologyCalibrationProfileV1,
  type SheetTopologyClaimV1,
  type SheetTopologyCompilationPolicyV1,
  type SheetTopologyEndpointV1,
  type SheetTopologyPoint,
  type SheetTopologyPrimitiveKind,
  type SheetTopologySourceMarkV1,
  type SheetTopologySourceViewV1
} from "./sheet_topology_compiler.js";

export type SheetPixelPointV1 = { u: number; v: number };

export type SheetPixelEndpointV1 = {
  endpoint_key: string;
  point: SheetPixelPointV1;
  outward_direction_uv: [number, number];
  boundary: SheetTopologyEndpointV1["boundary"];
  continuation_key?: string;
};

export type SheetPixelPrimitiveV1 = {
  primitive_id: string;
  source_view_key: string;
  source_mark_ids: string[];
  kind: SheetTopologyPrimitiveKind;
  points: SheetPixelPointV1[];
  endpoints?: SheetPixelEndpointV1[];
  claims?: {
    system?: SheetTopologyClaimV1;
    size?: SheetTopologyClaimV1;
    type?: SheetTopologyClaimV1;
    family?: SheetTopologyClaimV1;
    host?: SheetTopologyClaimV1;
    elevation?: SheetTopologyClaimV1;
    vertical_extent?: SheetTopologyClaimV1;
  };
  confidence: {
    geometry: number;
    classification: number;
    topology: number;
    visibility: number;
  };
};

export type SheetPixelInterpretationInputV1 = {
  schema_version: 1;
  package_id: string;
  coordinate_space: "normalized_uv_top_left";
  view_keys: string[];
  source_marks: SheetTopologySourceMarkV1[];
  primitives: SheetPixelPrimitiveV1[];
};

export type SheetPixelInterpretationContextV1 = {
  trusted_views: Array<{
    source_view: SheetTopologySourceViewV1;
    frame: CandidateVisibleFrameMapping;
  }>;
  calibration_profile: SheetTopologyCalibrationProfileV1;
  raster_evidence_receipts?: SheetPixelEvidenceReceiptV1[];
  policy?: Partial<SheetTopologyCompilationPolicyV1>;
};

export type CompiledSheetPixelInterpretationV1 = {
  schema_version: 1;
  pixel_interpretation_sha256: string;
  trusted_context_sha256: string;
  compiled_topology: CompiledSheetTopologyV1;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function normalized(value: unknown, label: string): number {
  const result = finite(value, label);
  if (result < 0 || result > 1) throw new Error(`${label}_must_be_between_zero_and_one`);
  return result;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function framePoint(frame: CandidateVisibleFrameMapping, value: SheetPixelPointV1, label: string): SheetTopologyPoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const u = normalized(value.u, `${label}_u`);
  const v = normalized(value.v, `${label}_v`);
  const topLeft = frame.top_left_xyz;
  const topRight = frame.top_right_xyz;
  const bottomLeft = frame.bottom_left_xyz;
  if (![topLeft, topRight, bottomLeft].every(entry => Array.isArray(entry) && entry.length === 3 && entry.every(Number.isFinite))) {
    throw new Error(`${label}_trusted_frame_invalid`);
  }
  return {
    x: topLeft[0] + u * (topRight[0] - topLeft[0]) + v * (bottomLeft[0] - topLeft[0]),
    y: topLeft[1] + u * (topRight[1] - topLeft[1]) + v * (bottomLeft[1] - topLeft[1])
  };
}

function frameDirection(
  frame: CandidateVisibleFrameMapping,
  value: [number, number],
  label: string
): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label}_must_have_two_values`);
  const du = finite(value[0], `${label}_u`);
  const dv = finite(value[1], `${label}_v`);
  const topLeft = frame.top_left_xyz;
  const topRight = frame.top_right_xyz;
  const bottomLeft = frame.bottom_left_xyz;
  const x = du * (topRight[0] - topLeft[0]) + dv * (bottomLeft[0] - topLeft[0]);
  const y = du * (topRight[1] - topLeft[1]) + dv * (bottomLeft[1] - topLeft[1]);
  const length = Math.hypot(x, y);
  if (length <= 1e-9) throw new Error(`${label}_maps_to_zero_vector`);
  return [x / length, y / length];
}

export function compileSheetPixelInterpretationV1(
  input: SheetPixelInterpretationInputV1,
  context: SheetPixelInterpretationContextV1
): CompiledSheetPixelInterpretationV1 {
  if (!input || input.schema_version !== 1) throw new Error("sheet_pixel_interpretation_requires_schema_v1");
  if (input.coordinate_space !== "normalized_uv_top_left") throw new Error("sheet_pixel_interpretation_coordinate_space_invalid");
  requiredText(input.package_id, "sheet_pixel_interpretation_package_id");
  if (!context || !Array.isArray(context.trusted_views) || context.trusted_views.length === 0) throw new Error("sheet_pixel_interpretation_trusted_views_required");
  if (!Array.isArray(input.view_keys) || input.view_keys.length === 0) throw new Error("sheet_pixel_interpretation_view_keys_required");
  const requestedViewKeys = input.view_keys.map((value, index) => requiredText(value, `sheet_pixel_interpretation_view_key_${index}`));
  if (new Set(requestedViewKeys).size !== requestedViewKeys.length) throw new Error("sheet_pixel_interpretation_duplicate_view_key");

  const trustedByKey = new Map<string, SheetPixelInterpretationContextV1["trusted_views"][number]>();
  for (const [index, trusted] of context.trusted_views.entries()) {
    const key = requiredText(trusted.source_view?.view_key, `sheet_pixel_trusted_view_${index}_key`);
    if (trustedByKey.has(key)) throw new Error(`sheet_pixel_duplicate_trusted_view:${key}`);
    if (!trusted.frame || !Number.isSafeInteger(trusted.frame.view_id) || trusted.frame.view_id <= 0) throw new Error(`sheet_pixel_trusted_frame_invalid:${key}`);
    if (!Number.isSafeInteger(trusted.frame.width_px) || trusted.frame.width_px <= 0 || !Number.isSafeInteger(trusted.frame.height_px) || trusted.frame.height_px <= 0) {
      throw new Error(`sheet_pixel_trusted_frame_dimensions_invalid:${key}`);
    }
    trustedByKey.set(key, trusted);
  }
  const selected = requestedViewKeys.map(key => {
    const value = trustedByKey.get(key);
    if (!value) throw new Error(`sheet_pixel_interpretation_unknown_trusted_view:${key}`);
    return value;
  });
  const selectedKeys = new Set(requestedViewKeys);
  if (!Array.isArray(input.source_marks) || input.source_marks.length === 0) throw new Error("sheet_pixel_interpretation_source_marks_required");
  if (!Array.isArray(input.primitives)) throw new Error("sheet_pixel_interpretation_primitives_required");
  for (const mark of input.source_marks) {
    if (!selectedKeys.has(clean(mark.source_view_key))) throw new Error(`sheet_pixel_source_mark_view_not_selected:${clean(mark.source_mark_id)}`);
  }

  const rasterEvidenceByPrimitive = new Map<string, SheetPixelEvidenceReceiptV1["route_evidence"][number]>();
  const rasterEvidenceViews = new Set<string>();
  for (const [receiptIndex, receipt] of (context.raster_evidence_receipts ?? []).entries()) {
    if (!receipt || receipt.schema_version !== 1) throw new Error(`sheet_pixel_raster_evidence_schema_invalid:${receiptIndex}`);
    const viewKey = requiredText(receipt.source_view_key, `sheet_pixel_raster_evidence_${receiptIndex}_view_key`);
    const trusted = trustedByKey.get(viewKey);
    if (!trusted || !selectedKeys.has(viewKey)) throw new Error(`sheet_pixel_raster_evidence_unknown_view:${viewKey}`);
    if (clean(receipt.image?.sha256).toLowerCase() !== clean(trusted.source_view.source_sha256).toLowerCase()) throw new Error(`sheet_pixel_raster_evidence_source_hash_mismatch:${viewKey}`);
    rasterEvidenceViews.add(viewKey);
    for (const evidence of receipt.route_evidence ?? []) {
      const primitiveId = requiredText(evidence.primitive_id, `sheet_pixel_raster_evidence_${viewKey}_primitive_id`);
      if (rasterEvidenceByPrimitive.has(primitiveId)) throw new Error(`sheet_pixel_raster_evidence_duplicate_primitive:${primitiveId}`);
      rasterEvidenceByPrimitive.set(primitiveId, evidence);
    }
  }

  const primitives = input.primitives.map((primitive, index) => {
    const id = requiredText(primitive.primitive_id, `sheet_pixel_primitive_${index}_id`);
    const trusted = trustedByKey.get(requiredText(primitive.source_view_key, `sheet_pixel_primitive_${id}_view_key`));
    if (!trusted || !selectedKeys.has(primitive.source_view_key)) throw new Error(`sheet_pixel_primitive_view_not_selected:${id}`);
    if (!Array.isArray(primitive.points) || primitive.points.length === 0) throw new Error(`sheet_pixel_primitive_points_required:${id}`);
    const rasterEvidence = rasterEvidenceByPrimitive.get(id);
    if (primitive.kind === "route_segment" && rasterEvidenceViews.has(primitive.source_view_key) && !rasterEvidence) throw new Error(`sheet_pixel_raster_evidence_missing_primitive:${id}`);
    const rasterGeometryCap = !rasterEvidence || rasterEvidence.status === "accepted_raster_support" ? 1 : rasterEvidence.status === "provisional_raster_support" ? 0.5 : 0;
    const points = primitive.points.map((value, pointIndex) => framePoint(trusted.frame, value, `sheet_pixel_primitive_${id}_point_${pointIndex}`));
    const endpoints = (primitive.endpoints ?? []).map((endpoint, endpointIndex): SheetTopologyEndpointV1 => ({
      endpoint_key: requiredText(endpoint.endpoint_key, `sheet_pixel_primitive_${id}_endpoint_${endpointIndex}_key`),
      point: framePoint(trusted.frame, endpoint.point, `sheet_pixel_endpoint_${endpoint.endpoint_key}_point`),
      outward_direction_xy: frameDirection(trusted.frame, endpoint.outward_direction_uv, `sheet_pixel_endpoint_${endpoint.endpoint_key}_direction`),
      boundary: endpoint.boundary,
      ...(clean(endpoint.continuation_key) ? { continuation_key: clean(endpoint.continuation_key) } : {})
    }));
    return {
      primitive_id: id,
      source_view_key: primitive.source_view_key,
      source_mark_ids: primitive.source_mark_ids,
      kind: primitive.kind,
      points,
      endpoints,
      ...(primitive.claims ? { claims: primitive.claims } : {}),
      confidence: { ...primitive.confidence, geometry: Math.min(primitive.confidence.geometry, rasterGeometryCap) },
      independently_reversible: primitive.kind === "route_segment" || primitive.kind === "wall_segment"
    };
  });

  const compiledTopology = compileSheetTopologyV1(
    {
      schema_version: 1,
      package_id: input.package_id,
      coordinate_space: "model_xyz_feet",
      source_views: selected.map(value => value.source_view),
      source_marks: input.source_marks,
      primitives
    },
    {
      trusted_source_views: selected.map(value => value.source_view),
      calibration_profile: context.calibration_profile,
      ...(context.policy ? { policy: context.policy } : {})
    }
  );
  for (const [primitiveId, evidence] of rasterEvidenceByPrimitive) {
    if (evidence.status !== "accepted_raster_support") compiledTopology.warnings.push(`raster_evidence_${evidence.status}:${primitiveId}`);
  }

  return {
    schema_version: 1,
    pixel_interpretation_sha256: digest(input),
    trusted_context_sha256: digest(context),
    compiled_topology: compiledTopology
  };
}
