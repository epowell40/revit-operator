import crypto from "node:crypto";
import type { PlanTracePoint } from "./plan_trace_extraction.js";
import type {
  PlanTraceSeedSpineReadyV1,
  PlanTraceSeedSpineReceiptV1
} from "./plan_trace_seed_spine.js";
import type { PlanTracePathReferenceV1 } from "./plan_trace_source_accounting.js";

export type PlanTraceSpineNormalizationInputV1 = {
  schema_version: 1;
  source_image_sha256: string;
  evidence_set_id: string;
  spine_receipt_sha256: string;
  straight_projection_maximum_deviation_px: number;
  simplify_tolerance_px: number;
  maximum_endpoint_shift_px: number;
};

export type PlanTraceNormalizedSpineV1 = {
  span_id: string;
  status: "normalized_source_spine_ready";
  strategy: "straight_seed_axis_projection" | "bounded_polyline_simplification";
  points: PlanTracePoint[];
  raw_point_count: number;
  normalized_point_count: number;
  raw_length_px: number;
  normalized_length_px: number;
  maximum_raw_to_normalized_deviation_px: number;
  start_shift_px: number;
  end_shift_px: number;
  source_paths: PlanTracePathReferenceV1[];
};

export type PlanTraceSpineNormalizationReceiptV1 = {
  schema_version: 1;
  source_image_sha256: string;
  evidence_set_id: string;
  spine_receipt_sha256: string;
  normalization_contract_sha256: string;
  normalized_spines: PlanTraceNormalizedSpineV1[];
  deferred_spines: PlanTraceSeedSpineReceiptV1["deferred_spines"];
  unresolved_source_paths: PlanTracePathReferenceV1[];
  status: "normalized_spines_ready" | "no_normalized_spines_ready";
  native_write_allowed: false;
  usage_constraints: string[];
};

function requiredText(value: unknown, label: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}_must_be_positive`);
  }
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

export function sha256PlanTraceSeedSpineReceiptV1(receipt: PlanTraceSeedSpineReceiptV1): string {
  return digest(receipt);
}

function distance(a: PlanTracePoint, b: PlanTracePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function polylineLength(points: PlanTracePoint[]): number {
  let result = 0;
  for (let index = 0; index < points.length - 1; index += 1) result += distance(points[index]!, points[index + 1]!);
  return result;
}

function projectToLine(
  value: PlanTracePoint,
  start: PlanTracePoint,
  end: PlanTracePoint,
  clampToSeedSpan = false
): PlanTracePoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (denominator === 0) throw new Error("plan_trace_spine_normalization_seed_axis_is_degenerate");
  const rawT = ((value.x - start.x) * dx + (value.y - start.y) * dy) / denominator;
  const t = clampToSeedSpan ? Math.max(0, Math.min(1, rawT)) : rawT;
  return { x: start.x + t * dx, y: start.y + t * dy };
}

function distanceToSegment(value: PlanTracePoint, start: PlanTracePoint, end: PlanTracePoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (denominator === 0) return distance(value, start);
  const t = Math.max(0, Math.min(1, ((value.x - start.x) * dx + (value.y - start.y) * dy) / denominator));
  return distance(value, { x: start.x + t * dx, y: start.y + t * dy });
}

function distanceToPolyline(value: PlanTracePoint, points: PlanTracePoint[]): number {
  let result = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length - 1; index += 1) {
    result = Math.min(result, distanceToSegment(value, points[index]!, points[index + 1]!));
  }
  return result;
}

function simplifyRdp(points: PlanTracePoint[], tolerance: number): PlanTracePoint[] {
  if (points.length <= 2) return points.map(value => ({ ...value }));
  let maximumDistance = -1;
  let maximumIndex = -1;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  for (let index = 1; index < points.length - 1; index += 1) {
    const value = distanceToSegment(points[index]!, start, end);
    if (value > maximumDistance) { maximumDistance = value; maximumIndex = index; }
  }
  if (maximumDistance <= tolerance) return [{ ...start }, { ...end }];
  const left = simplifyRdp(points.slice(0, maximumIndex + 1), tolerance);
  const right = simplifyRdp(points.slice(maximumIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function normalizeSpine(
  spine: PlanTraceSeedSpineReadyV1,
  straightMaximum: number,
  simplifyTolerance: number,
  maximumEndpointShift: number
): PlanTraceNormalizedSpineV1 {
  if (!Array.isArray(spine.points) || spine.points.length < 2) {
    throw new Error(`plan_trace_spine_normalization_spine_requires_two_points:${spine.span_id}`);
  }
  const projected = spine.points.map(value => projectToLine(value, spine.seed_start_point_px, spine.seed_end_point_px));
  const lineDeviation = Math.max(...spine.points.map((value, index) => distance(value, projected[index]!)));
  const projectedStart = projectToLine(spine.points[0]!, spine.seed_start_point_px, spine.seed_end_point_px, true);
  const projectedEnd = projectToLine(spine.points[spine.points.length - 1]!, spine.seed_start_point_px, spine.seed_end_point_px, true);
  const projectedStartShift = distance(spine.points[0]!, projectedStart);
  const projectedEndShift = distance(spine.points[spine.points.length - 1]!, projectedEnd);
  let strategy: PlanTraceNormalizedSpineV1["strategy"];
  let normalized: PlanTracePoint[];
  if (lineDeviation <= straightMaximum
    && projectedStartShift <= maximumEndpointShift
    && projectedEndShift <= maximumEndpointShift) {
    strategy = "straight_seed_axis_projection";
    normalized = [projectedStart, projectedEnd];
  } else {
    strategy = "bounded_polyline_simplification";
    normalized = simplifyRdp(spine.points, simplifyTolerance);
  }
  const startShift = distance(spine.points[0]!, normalized[0]!);
  const endShift = distance(spine.points[spine.points.length - 1]!, normalized[normalized.length - 1]!);
  if (startShift > maximumEndpointShift || endShift > maximumEndpointShift) {
    throw new Error(`plan_trace_spine_normalization_endpoint_shift_exceeded:${spine.span_id}`);
  }
  const maximumDeviation = Math.max(...spine.points.map(value => distanceToPolyline(value, normalized)));
  const allowedDeviation = strategy === "straight_seed_axis_projection" ? straightMaximum : simplifyTolerance;
  if (maximumDeviation > allowedDeviation + 1e-6) {
    throw new Error(`plan_trace_spine_normalization_deviation_exceeded:${spine.span_id}`);
  }
  return {
    span_id: spine.span_id,
    status: "normalized_source_spine_ready",
    strategy,
    points: normalized,
    raw_point_count: spine.points.length,
    normalized_point_count: normalized.length,
    raw_length_px: polylineLength(spine.points),
    normalized_length_px: polylineLength(normalized),
    maximum_raw_to_normalized_deviation_px: maximumDeviation,
    start_shift_px: startShift,
    end_shift_px: endShift,
    source_paths: spine.source_paths
  };
}

export function normalizePlanTraceSeedSpinesV1(
  input: PlanTraceSpineNormalizationInputV1,
  receipt: PlanTraceSeedSpineReceiptV1
): PlanTraceSpineNormalizationReceiptV1 {
  if (!input || input.schema_version !== 1) throw new Error("plan_trace_spine_normalization_requires_schema_v1");
  if (!receipt || receipt.schema_version !== 1) throw new Error("plan_trace_spine_normalization_receipt_is_required");
  const sourceHash = sha256(input.source_image_sha256, "plan_trace_spine_normalization_source_image_sha256");
  if (sha256(receipt.source_image_sha256, "plan_trace_spine_normalization_receipt_source_image_sha256") !== sourceHash) {
    throw new Error("plan_trace_spine_normalization_source_hash_mismatch");
  }
  const evidenceSetId = requiredText(input.evidence_set_id, "plan_trace_spine_normalization_evidence_set_id");
  if (receipt.evidence_set_id !== evidenceSetId) throw new Error("plan_trace_spine_normalization_evidence_set_mismatch");
  const receiptHash = sha256(input.spine_receipt_sha256, "plan_trace_spine_normalization_spine_receipt_sha256");
  if (sha256PlanTraceSeedSpineReceiptV1(receipt) !== receiptHash) {
    throw new Error("plan_trace_spine_normalization_spine_receipt_hash_mismatch");
  }
  const straightMaximum = positive(
    input.straight_projection_maximum_deviation_px,
    "plan_trace_spine_normalization_straight_projection_maximum_deviation_px"
  );
  const simplifyTolerance = positive(input.simplify_tolerance_px, "plan_trace_spine_normalization_simplify_tolerance_px");
  const maximumEndpointShift = positive(input.maximum_endpoint_shift_px, "plan_trace_spine_normalization_maximum_endpoint_shift_px");
  if (straightMaximum > 25 || simplifyTolerance > 10 || maximumEndpointShift > 25) {
    throw new Error("plan_trace_spine_normalization_policy_too_permissive");
  }
  const normalized = receipt.ready_spines.map(spine => normalizeSpine(
    spine,
    straightMaximum,
    simplifyTolerance,
    maximumEndpointShift
  ));
  return {
    schema_version: 1,
    source_image_sha256: sourceHash,
    evidence_set_id: evidenceSetId,
    spine_receipt_sha256: receiptHash,
    normalization_contract_sha256: digest(input),
    normalized_spines: normalized,
    deferred_spines: receipt.deferred_spines,
    unresolved_source_paths: receipt.unresolved_source_paths,
    status: normalized.length > 0 ? "normalized_spines_ready" : "no_normalized_spines_ready",
    native_write_allowed: false,
    usage_constraints: [
      "Straight projection is allowed only when every extracted path point stays inside the declared source-axis corridor and endpoint shifts remain bounded.",
      "Bent paths retain bounded source geometry through RDP simplification; normalization cannot bridge a disconnected or deferred spine.",
      "Normalization preserves unresolved source paths and does not establish native size, profile, system, elevation, type, connectors, or write authority."
    ]
  };
}
