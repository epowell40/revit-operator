import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadImage } from "@napi-rs/canvas";
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
import type { ExistingConditionsPlanPoint } from "./registration.js";

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
    source_scoped_id: string;
    boundary_model_points: ExistingConditionsPlanPoint[];
    location_model_point?: ExistingConditionsPlanPoint;
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
    checked_observation_ids: string[];
    route_clipping_receipts?: CandidateVisibleRouteClippingReceipt[];
    local_room_registration_fallback?: {
      reason: "source_scope_disjoint_from_projected_native_room";
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
    };
    boundary_basis?: "source_observed" | "verified_native_room_projected_to_registered_render";
    normalization_warnings?: string[];
  };
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
  const polygon = value.map((entry, index) => {
    const point = normalizePoint(entry);
    if (!point) throw new Error(`candidate_visible_scope_polygon_point_${index}_invalid`);
    if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) {
      throw new Error(`candidate_visible_scope_polygon_point_${index}_outside_render`);
    }
    return point;
  });
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
}): CandidateVisibleMepReconstruction["spatial_scope_receipt"] {
  let scope = args.payload.spatial_scope;
  const roomNumber = String(args.payload.room_number ?? "").trim();
  const nativeRoomScope = args.verified_room_scope;
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
  const nativeRoomPolygon = nativeRoomScope
    ? normalizeModelPolygon(nativeRoomScope.boundary_model_points, "candidate_visible_native_room_boundary")
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
  const nativeRoomPixelPolygon = nativeRoomPolygon
    ? projectedNativeRoomPixelPolygon({
        native_room_polygon: nativeRoomPolygon,
        render_width_px: args.render_width_px,
        render_height_px: args.render_height_px,
        registration_geometry: args.registration_geometry
      })
    : null;
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
    roomNumber &&
    scope &&
    sourceObservedPolygon &&
    sourceObservedAnchor &&
    pointInsidePolygonOrBoundary(sourceObservedAnchor, sourceObservedPolygon) &&
    nativeRoomPixelPolygon
  ) {
    const sourceBounds = pointBounds(sourceObservedPolygon);
    const targetBounds = pointBounds(nativeRoomPixelPolygon);
    const minimumAreaOverlapRatio = boundsIntersectionRatio(sourceBounds, targetBounds);
    // A containment-only/low-IoU remap is unsafe: an overbroad source polygon can
    // include adjacent-room geometry and then squeeze it into the verified room.
    // Until the source enclosure has independent server-owned verification, local
    // room registration is allowed only when the two bounds do not overlap.
    if (minimumAreaOverlapRatio <= 1e-7) {
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
      const scales = remapCandidateVisiblePayloadFromRoomBounds({
        payload: args.payload,
        source_bounds: sourceBounds,
        target_bounds: targetBounds
      });
      scope = args.payload.spatial_scope;
      sourceObservedPolygon = scope
        ? validateScopePolygon(
            scope.boundary_pixel_points,
            args.render_width_px,
            args.render_height_px
          )
        : null;
      sourceObservedAnchor = scope ? normalizePoint(scope.anchor_pixel_point) : null;
      localRoomRegistrationFallback = {
        reason: "source_scope_disjoint_from_projected_native_room",
        source_scope_bounds: sourceBounds,
        target_native_room_bounds: targetBounds,
        scale_x: scales.scale_x,
        scale_y: scales.scale_y
      };
      normalizationWarnings.push(
        "The source-observed room trace was disjoint from the verified native room under the full-view alignment, so it was used only as a local room-coordinate basis and mapped onto the native-room bounds before strict native clipping."
      );
    }
  }
  const polygon = nativeRoomPixelPolygon ?? sourceObservedPolygon;
  if (!polygon) throw new Error("candidate_visible_scope_polygon_required");
  if (nativeRoomPixelPolygon) {
    normalizationWarnings.push(
      "Used the verified native linked-room boundary projected into registered source pixels as the authoritative spatial scope."
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
          throw new Error(`candidate_visible_route_outside_native_room_scope:${observationId}`);
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
          throw new Error(`candidate_visible_point_outside_native_room_scope:${observationId}`);
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
        throw new Error(`candidate_visible_branch_outside_native_room_scope:${observationId}`);
      }
    }
  }
  const modelBoundaryPoints = polygon.map((entry) => mapRegisteredRenderPointToModel(
    entry,
    args.render_width_px,
    args.render_height_px,
    args.registration_geometry
  ));
  if (nativeRoomPolygon) {
    for (const [index, point] of modelBoundaryPoints.entries()) {
      if (!pointInsidePolygonOrNearBoundary(point, nativeRoomPolygon, 0.75)) {
        throw new Error(`candidate_visible_projected_room_boundary_outside_native_room_scope:${index}`);
      }
    }
    const modelAnchor = mapRegisteredRenderPointToModel(
      anchor,
      args.render_width_px,
      args.render_height_px,
      args.registration_geometry
    );
    if (!pointInsidePolygonOrNearBoundary(modelAnchor, nativeRoomPolygon, 0.75)) {
      throw new Error("candidate_visible_source_room_anchor_outside_native_room_scope");
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
    checked_observation_ids: checkedObservationIds,
    ...(routeClippingReceipts.length > 0
      ? { route_clipping_receipts: routeClippingReceipts }
      : {}),
    ...(localRoomRegistrationFallback
      ? { local_room_registration_fallback: localRoomRegistrationFallback }
      : {}),
    boundary_basis: nativeRoomPixelPolygon
      ? "verified_native_room_projected_to_registered_render"
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

export async function compileCandidateVisibleMepReconstruction(
  input: CandidateVisibleMepReconstructionInput
): Promise<CandidateVisibleMepReconstruction> {
  const sourcePdfPath = requireFile(input.source_pdf_path, "candidate_visible_source_pdf");
  const renderPath = requireFile(input.registered_render_path, "candidate_visible_registered_render");
  const sourceHash = sha256File(sourcePdfPath);
  const renderHash = sha256File(renderPath);
  const render = await loadImage(renderPath);
  const width = positiveInteger(render.width, "registered_render_width_px");
  const height = positiveInteger(render.height, "registered_render_height_px");
  const geometry = deriveCandidateVisibleRegistrationGeometry({
    alignment: input.alignment,
    frame: input.frame,
    render_width_px: width,
    render_height_px: height
  });
  const registrationContextId = sha256Json({
    schema_version: 1,
    source_evidence_sha256: sourceHash,
    registered_render_sha256: renderHash,
    frame: input.frame,
    alignment: input.alignment,
    verified_room_scope: input.verified_room_scope ?? null
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
    throw new Error("candidate_visible_observations_are_required");
  }
  if (payload.observations.length > observationLimit) {
    throw new Error("candidate_visible_observation_limit_exceeded");
  }
  const spatialScopeReceipt = validateCandidateVisibleSpatialScope({
    payload,
    render_width_px: width,
    render_height_px: height,
    registration_geometry: geometry,
    ...(input.verified_room_scope ? { verified_room_scope: input.verified_room_scope } : {})
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
