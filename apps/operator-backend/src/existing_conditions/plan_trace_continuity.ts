import crypto from "node:crypto";
import type { PlanTraceExtractionReceipt, PlanTracePoint, PlanTracePolyline } from "./plan_trace_extraction.js";
import type { PlanTracePathReferenceV1 } from "./plan_trace_source_accounting.js";

export type DashedTraceContinuityInputV1 = {
  schema_version: 1;
  source_image_sha256: string;
  evidence_set_id: string;
  extraction_policy_sha256: string;
  source_paths: PlanTracePathReferenceV1[];
  maximum_gap_px: number;
  maximum_lateral_deviation_px: number;
  maximum_direction_deviation_degrees: number;
};

export type DashedTraceContinuityReceiptV1 = {
  schema_version: 1;
  source_image_sha256: string;
  evidence_set_id: string;
  continuity_contract_sha256: string;
  ordered_source_paths: PlanTracePathReferenceV1[];
  start_point: PlanTracePoint;
  end_point: PlanTracePoint;
  visible_length_px: number;
  span_length_px: number;
  visible_fraction: number;
  gap_lengths_px: number[];
  status: "continuity_hypothesis_ready";
  native_write_allowed: false;
  usage_constraints: string[];
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function positive(value: unknown, label: string): number {
  const result = finite(value, label);
  if (result <= 0) throw new Error(`${label}_must_be_positive`);
  return result;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function pathKey(reference: PlanTracePathReferenceV1): string {
  return `${reference.evidence_set_id}:${reference.component_id}:${reference.polyline_index}`;
}

function polylineMap(receipt: PlanTraceExtractionReceipt, evidenceSetId: string): Map<string, PlanTracePolyline> {
  const result = new Map<string, PlanTracePolyline>();
  for (const component of receipt.components) {
    for (const [polylineIndex, polyline] of component.polylines.entries()) {
      result.set(pathKey({ evidence_set_id: evidenceSetId, component_id: component.component_id, polyline_index: polylineIndex }), polyline);
    }
  }
  return result;
}

export function validateDashedTraceContinuityV1(
  input: DashedTraceContinuityInputV1,
  receipt: PlanTraceExtractionReceipt
): DashedTraceContinuityReceiptV1 {
  if (!input || input.schema_version !== 1) throw new Error("dashed_trace_continuity_requires_schema_v1");
  if (!receipt || receipt.schema_version !== 1) throw new Error("dashed_trace_continuity_receipt_is_required");
  const sourceHash = sha256(input.source_image_sha256, "dashed_trace_continuity_source_image_sha256");
  if (sha256(receipt.source_image_sha256, "dashed_trace_continuity_receipt_source_image_sha256") !== sourceHash) {
    throw new Error("dashed_trace_continuity_source_hash_mismatch");
  }
  const evidenceSetId = requiredText(input.evidence_set_id, "dashed_trace_continuity_evidence_set_id");
  if (sha256(input.extraction_policy_sha256, "dashed_trace_continuity_extraction_policy_sha256")
    !== sha256(receipt.extraction_policy_sha256, "dashed_trace_continuity_receipt_policy_sha256")) {
    throw new Error("dashed_trace_continuity_extraction_policy_hash_mismatch");
  }
  const maximumGap = positive(input.maximum_gap_px, "dashed_trace_continuity_maximum_gap_px");
  const maximumLateralDeviation = positive(
    input.maximum_lateral_deviation_px,
    "dashed_trace_continuity_maximum_lateral_deviation_px"
  );
  const maximumDirectionDeviation = positive(
    input.maximum_direction_deviation_degrees,
    "dashed_trace_continuity_maximum_direction_deviation_degrees"
  );
  if (maximumDirectionDeviation >= 45) throw new Error("dashed_trace_continuity_direction_deviation_must_be_below_45_degrees");
  if (!Array.isArray(input.source_paths) || input.source_paths.length < 3) {
    throw new Error("dashed_trace_continuity_requires_at_least_three_segments");
  }
  const paths = polylineMap(receipt, evidenceSetId);
  const seen = new Set<string>();
  const selected = input.source_paths.map((reference, index) => {
    if (reference.evidence_set_id !== evidenceSetId) {
      throw new Error(`dashed_trace_continuity_evidence_set_mismatch:${index}`);
    }
    const key = pathKey(reference);
    if (seen.has(key)) throw new Error(`dashed_trace_continuity_duplicate_path:${key}`);
    seen.add(key);
    const polyline = paths.get(key);
    if (!polyline) throw new Error(`dashed_trace_continuity_unknown_path:${key}`);
    if (polyline.closed || polyline.points.length < 2) throw new Error(`dashed_trace_continuity_path_must_be_open:${key}`);
    const first = polyline.points[0]!;
    const last = polyline.points[polyline.points.length - 1]!;
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const chord = Math.hypot(dx, dy);
    if (chord <= 0) throw new Error(`dashed_trace_continuity_path_is_degenerate:${key}`);
    return { reference, polyline, first, last, dx, dy, chord };
  });
  const principal = [...selected].sort((a, b) => b.chord - a.chord)[0]!;
  const axis = { x: principal.dx / principal.chord, y: principal.dy / principal.chord };
  const normal = { x: -axis.y, y: axis.x };
  const origin = principal.first;
  const project = (point: PlanTracePoint) => ({
    along: (point.x - origin.x) * axis.x + (point.y - origin.y) * axis.y,
    lateral: (point.x - origin.x) * normal.x + (point.y - origin.y) * normal.y
  });
  const maximumDirectionRadians = maximumDirectionDeviation * Math.PI / 180;
  const ordered = selected.map((entry) => {
    const directionCos = Math.abs((entry.dx * axis.x + entry.dy * axis.y) / entry.chord);
    const directionDeviation = Math.acos(Math.min(1, Math.max(-1, directionCos)));
    if (directionDeviation > maximumDirectionRadians) {
      throw new Error(`dashed_trace_continuity_direction_mismatch:${pathKey(entry.reference)}`);
    }
    const projected = [project(entry.first), project(entry.last)];
    if (projected.some((point) => Math.abs(point.lateral) > maximumLateralDeviation)) {
      throw new Error(`dashed_trace_continuity_lateral_deviation_exceeded:${pathKey(entry.reference)}`);
    }
    const start = projected[0]!.along <= projected[1]!.along ? entry.first : entry.last;
    const end = start === entry.first ? entry.last : entry.first;
    return {
      ...entry,
      start,
      end,
      startAlong: Math.min(projected[0]!.along, projected[1]!.along),
      endAlong: Math.max(projected[0]!.along, projected[1]!.along)
    };
  }).sort((a, b) => a.startAlong - b.startAlong);
  const gaps: number[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const gap = ordered[index + 1]!.startAlong - ordered[index]!.endAlong;
    if (gap <= 0) throw new Error(`dashed_trace_continuity_segments_overlap_or_touch:${index}`);
    if (gap > maximumGap) throw new Error(`dashed_trace_continuity_gap_exceeded:${index}:${gap}`);
    gaps.push(gap);
  }
  const visibleLength = ordered.reduce((sum, entry) => sum + entry.polyline.length_px, 0);
  const spanLength = ordered[ordered.length - 1]!.endAlong - ordered[0]!.startAlong;
  return {
    schema_version: 1,
    source_image_sha256: sourceHash,
    evidence_set_id: evidenceSetId,
    continuity_contract_sha256: digest(input),
    ordered_source_paths: ordered.map((entry) => entry.reference),
    start_point: ordered[0]!.start,
    end_point: ordered[ordered.length - 1]!.end,
    visible_length_px: visibleLength,
    span_length_px: spanLength,
    visible_fraction: visibleLength / spanLength,
    gap_lengths_px: gaps,
    status: "continuity_hypothesis_ready",
    native_write_allowed: false,
    usage_constraints: [
      "This receipt proves only a collinear ordered dashed-run hypothesis and never authorizes a native write.",
      "A separate hash-bound project line-style mapping must establish that the gaps represent one continuous modeled route.",
      "System, size, elevation, type, endpoints, and native connectivity remain separate evidence requirements."
    ]
  };
}
