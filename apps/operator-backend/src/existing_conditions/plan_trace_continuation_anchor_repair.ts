import type {
  PlanTraceExtractionReceipt,
  PlanTracePoint,
  PlanTracePolyline
} from "./plan_trace_extraction.js";
import { sha256PlanTraceExtractionReceiptV1 } from "./plan_trace_seed_spine.js";

export type PlanTraceContinuationAnchorRepairPolicyV1 = {
  minimum_route_polyline_length_px: number;
  maximum_attachment_distance_px: number;
  minimum_ambiguity_gap_px: number;
  marker_component_exclusion_radius_px: number;
};

export type PlanTraceContinuationAnchorRepairInputV1 = {
  schema_version: 1;
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  extraction_receipt_sha256: string;
  continuation_anchor: {
    anchor_id: string;
    point_px: PlanTracePoint;
    evidence_sha256: string;
  };
  policy?: Partial<PlanTraceContinuationAnchorRepairPolicyV1>;
};

export type PlanTraceContinuationAnchorCandidateV1 = {
  component_id: string;
  polyline_index: number;
  polyline_length_px: number;
  attachment_point_px: PlanTracePoint;
  attachment_point_uv: { u: number; v: number };
  attachment_distance_px: number;
};

export type PlanTraceContinuationAnchorRepairReceiptV1 = {
  schema: "operator.plan_trace_continuation_anchor_repair.v1";
  source_image_sha256: string;
  extraction_receipt_sha256: string;
  anchor_id: string;
  anchor_evidence_sha256: string;
  anchor_point_px: PlanTracePoint;
  anchor_point_uv: { u: number; v: number };
  policy: PlanTraceContinuationAnchorRepairPolicyV1;
  eligible_candidate_count: number;
  selected_candidate: PlanTraceContinuationAnchorCandidateV1 | null;
  second_best_attachment_distance_px: number | null;
  ambiguity_gap_px: number | null;
  status: "source_route_attachment_resolved" | "deferred";
  blockers: string[];
  native_write_allowed: false;
  exact_next_action: "read_native_frontiers_at_source_route_attachment_point" | "repair_source_continuation_attachment_ambiguity";
  capability_boundary: string;
};

const DEFAULT_POLICY: PlanTraceContinuationAnchorRepairPolicyV1 = {
  minimum_route_polyline_length_px: 10,
  maximum_attachment_distance_px: 30,
  minimum_ambiguity_gap_px: 3,
  marker_component_exclusion_radius_px: 8
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function finite(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label}_must_be_finite`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const result = finite(value, label);
  if (!Number.isSafeInteger(result) || result <= 0 || result > 20_000) throw new Error(`${label}_must_be_positive_integer`);
  return result;
}

function bounded(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  const result = value === undefined ? fallback : finite(value, label);
  if (result < minimum || result > maximum) throw new Error(`${label}_out_of_range`);
  return result;
}

function point(value: PlanTracePoint, label: string, width: number, height: number): PlanTracePoint {
  const x = finite(value?.x, `${label}_x`);
  const y = finite(value?.y, `${label}_y`);
  if (x < 0 || x > width - 1 || y < 0 || y > height - 1) throw new Error(`${label}_outside_source_image`);
  return { x, y };
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function uv(value: PlanTracePoint, width: number, height: number): { u: number; v: number } {
  return {
    u: rounded(value.x / Math.max(1, width - 1)),
    v: rounded(value.y / Math.max(1, height - 1))
  };
}

function nearestPointOnSegment(anchor: PlanTracePoint, start: PlanTracePoint, end: PlanTracePoint): PlanTracePoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (denominator <= 0) return start;
  const t = Math.max(0, Math.min(1, ((anchor.x - start.x) * dx + (anchor.y - start.y) * dy) / denominator));
  return { x: rounded(start.x + t * dx), y: rounded(start.y + t * dy) };
}

function nearestPointOnPolyline(anchor: PlanTracePoint, polyline: PlanTracePolyline): { point: PlanTracePoint; distance: number } {
  let nearest: PlanTracePoint | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < polyline.points.length; index += 1) {
    const candidate = nearestPointOnSegment(anchor, polyline.points[index - 1]!, polyline.points[index]!);
    const candidateDistance = Math.hypot(candidate.x - anchor.x, candidate.y - anchor.y);
    if (candidateDistance < distance) {
      nearest = candidate;
      distance = candidateDistance;
    }
  }
  return { point: nearest ?? polyline.points[0]!, distance };
}

function whollyInsideMarkerRadius(anchor: PlanTracePoint, polyline: PlanTracePolyline, radius: number): boolean {
  return polyline.points.every(candidate => Math.hypot(candidate.x - anchor.x, candidate.y - anchor.y) <= radius);
}

export function resolvePlanTraceContinuationAnchorV1(
  input: PlanTraceContinuationAnchorRepairInputV1,
  receipt: PlanTraceExtractionReceipt
): PlanTraceContinuationAnchorRepairReceiptV1 {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) {
    throw new Error("plan_trace_continuation_anchor_repair_requires_schema_v1");
  }
  const sourceHash = sha256(input.source_image_sha256, "plan_trace_continuation_anchor_source_image_sha256");
  const receiptHash = sha256(input.extraction_receipt_sha256, "plan_trace_continuation_anchor_extraction_receipt_sha256");
  if (sha256PlanTraceExtractionReceiptV1(receipt) !== receiptHash) {
    throw new Error("plan_trace_continuation_anchor_extraction_receipt_hash_mismatch");
  }
  if (clean(receipt.source_image_sha256).toLowerCase() !== sourceHash) {
    throw new Error("plan_trace_continuation_anchor_source_image_hash_mismatch");
  }
  const width = positiveInteger(input.source_image_width_px, "plan_trace_continuation_anchor_source_image_width_px");
  const height = positiveInteger(input.source_image_height_px, "plan_trace_continuation_anchor_source_image_height_px");
  if (receipt.width_px !== width || receipt.height_px !== height) {
    throw new Error("plan_trace_continuation_anchor_source_dimensions_mismatch");
  }
  const anchorId = requiredText(input.continuation_anchor?.anchor_id, "plan_trace_continuation_anchor_id");
  const anchorEvidenceHash = sha256(input.continuation_anchor?.evidence_sha256, "plan_trace_continuation_anchor_evidence_sha256");
  const anchor = point(input.continuation_anchor?.point_px, "plan_trace_continuation_anchor_point", width, height);
  const policy: PlanTraceContinuationAnchorRepairPolicyV1 = {
    minimum_route_polyline_length_px: bounded(input.policy?.minimum_route_polyline_length_px, DEFAULT_POLICY.minimum_route_polyline_length_px, "plan_trace_continuation_anchor_minimum_route_polyline_length_px", 1, 5_000),
    maximum_attachment_distance_px: bounded(input.policy?.maximum_attachment_distance_px, DEFAULT_POLICY.maximum_attachment_distance_px, "plan_trace_continuation_anchor_maximum_attachment_distance_px", 0, 2_000),
    minimum_ambiguity_gap_px: bounded(input.policy?.minimum_ambiguity_gap_px, DEFAULT_POLICY.minimum_ambiguity_gap_px, "plan_trace_continuation_anchor_minimum_ambiguity_gap_px", 0, 1_000),
    marker_component_exclusion_radius_px: bounded(input.policy?.marker_component_exclusion_radius_px, DEFAULT_POLICY.marker_component_exclusion_radius_px, "plan_trace_continuation_anchor_marker_component_exclusion_radius_px", 0, 500)
  };

  const candidates: PlanTraceContinuationAnchorCandidateV1[] = [];
  for (const component of receipt.components ?? []) {
    for (const [polylineIndex, polyline] of (component.polylines ?? []).entries()) {
      if (polyline.closed || polyline.points.length < 2 || polyline.length_px < policy.minimum_route_polyline_length_px) continue;
      if (whollyInsideMarkerRadius(anchor, polyline, policy.marker_component_exclusion_radius_px)) continue;
      const nearest = nearestPointOnPolyline(anchor, polyline);
      candidates.push({
        component_id: component.component_id,
        polyline_index: polylineIndex,
        polyline_length_px: rounded(polyline.length_px),
        attachment_point_px: nearest.point,
        attachment_point_uv: uv(nearest.point, width, height),
        attachment_distance_px: rounded(nearest.distance)
      });
    }
  }
  candidates.sort((left, right) => left.attachment_distance_px - right.attachment_distance_px
    || right.polyline_length_px - left.polyline_length_px
    || left.component_id.localeCompare(right.component_id)
    || left.polyline_index - right.polyline_index);
  const first = candidates[0] ?? null;
  const second = candidates[1] ?? null;
  const ambiguityGap = first && second ? rounded(second.attachment_distance_px - first.attachment_distance_px) : null;
  const blockers: string[] = [];
  if (!first) blockers.push("no_eligible_source_route_polyline");
  if (first && first.attachment_distance_px > policy.maximum_attachment_distance_px) blockers.push("source_route_attachment_too_far");
  if (ambiguityGap !== null && ambiguityGap < policy.minimum_ambiguity_gap_px) blockers.push("source_route_attachment_ambiguous");
  const resolved = blockers.length === 0 && first !== null;

  return {
    schema: "operator.plan_trace_continuation_anchor_repair.v1",
    source_image_sha256: sourceHash,
    extraction_receipt_sha256: receiptHash,
    anchor_id: anchorId,
    anchor_evidence_sha256: anchorEvidenceHash,
    anchor_point_px: anchor,
    anchor_point_uv: uv(anchor, width, height),
    policy,
    eligible_candidate_count: candidates.length,
    selected_candidate: resolved ? first : null,
    second_best_attachment_distance_px: second?.attachment_distance_px ?? null,
    ambiguity_gap_px: ambiguityGap,
    status: resolved ? "source_route_attachment_resolved" : "deferred",
    blockers,
    native_write_allowed: false,
    exact_next_action: resolved
      ? "read_native_frontiers_at_source_route_attachment_point"
      : "repair_source_continuation_attachment_ambiguity",
    capability_boundary: "This receipt repairs only a source-image search anchor from a trusted continuation mark to one uniquely nearest non-symbol trace. It does not invent route geometry, prove native identity or connectivity, or authorize a write."
  };
}
