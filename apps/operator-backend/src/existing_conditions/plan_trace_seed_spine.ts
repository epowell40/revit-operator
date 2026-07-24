import crypto from "node:crypto";
import type {
  PlanTraceExtractionReceipt,
  PlanTracePoint
} from "./plan_trace_extraction.js";
import type { PlanTracePathReferenceV1 } from "./plan_trace_source_accounting.js";

export type PlanTraceSeedSpanV1 = {
  span_id: string;
  start_point_px: PlanTracePoint;
  end_point_px: PlanTracePoint;
};

export type PlanTraceSeedSpineInputV1 = {
  schema_version: 1;
  source_image_sha256: string;
  extraction_policy_sha256: string;
  extraction_receipt_sha256: string;
  evidence_set_id: string;
  seed_evidence_sha256: string;
  seed_basis: "host_trusted_route_seed";
  seed_spans: PlanTraceSeedSpanV1[];
  maximum_snap_distance_px: number;
  maximum_path_deviation_px: number;
  maximum_path_length_ratio: number;
};

export type PlanTraceSeedSpineReadyV1 = {
  span_id: string;
  status: "source_spine_ready";
  seed_start_point_px: PlanTracePoint;
  seed_end_point_px: PlanTracePoint;
  snapped_start_point_px: PlanTracePoint;
  snapped_end_point_px: PlanTracePoint;
  start_snap_distance_px: number;
  end_snap_distance_px: number;
  points: PlanTracePoint[];
  length_px: number;
  seed_chord_px: number;
  path_length_ratio: number;
  maximum_path_deviation_px: number;
  source_paths: PlanTracePathReferenceV1[];
};

export type PlanTraceSeedSpineDeferredV1 = {
  span_id: string;
  status: "deferred";
  reason:
    | "start_snap_out_of_range"
    | "end_snap_out_of_range"
    | "ambiguous_start_snap"
    | "ambiguous_end_snap"
    | "degenerate_snapped_span"
    | "no_connected_path"
    | "ambiguous_shortest_path"
    | "path_deviation_exceeded"
    | "path_length_ratio_exceeded";
  note: string;
};

export type PlanTraceSeedSpineReceiptV1 = {
  schema_version: 1;
  source_image_sha256: string;
  extraction_policy_sha256: string;
  extraction_receipt_sha256: string;
  evidence_set_id: string;
  seed_evidence_sha256: string;
  spine_contract_sha256: string;
  ready_spines: PlanTraceSeedSpineReadyV1[];
  deferred_spines: PlanTraceSeedSpineDeferredV1[];
  used_source_paths: PlanTracePathReferenceV1[];
  unresolved_source_paths: PlanTracePathReferenceV1[];
  status: "spines_ready" | "no_spines_ready";
  native_write_allowed: false;
  usage_constraints: string[];
};

type GraphEdge = { to: string; weight: number; edge_key: string };
type Graph = {
  points: Map<string, PlanTracePoint>;
  adjacency: Map<string, GraphEdge[]>;
  edge_paths: Map<string, PlanTracePathReferenceV1[]>;
  all_paths: PlanTracePathReferenceV1[];
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

function point(value: unknown, label: string): PlanTracePoint {
  const candidate = value as PlanTracePoint;
  if (!candidate || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) {
    throw new Error(`${label}_must_be_finite_point`);
  }
  return { x: candidate.x, y: candidate.y };
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

export function sha256PlanTraceExtractionReceiptV1(receipt: PlanTraceExtractionReceipt): string {
  return digest(receipt);
}

function pointKey(value: PlanTracePoint): string {
  return `${value.x},${value.y}`;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pathKey(value: PlanTracePathReferenceV1): string {
  return `${value.evidence_set_id}:${value.component_id}:${value.polyline_index}`;
}

function comparePaths(a: PlanTracePathReferenceV1, b: PlanTracePathReferenceV1): number {
  return pathKey(a).localeCompare(pathKey(b));
}

function buildGraph(receipt: PlanTraceExtractionReceipt, evidenceSetId: string): Graph {
  const points = new Map<string, PlanTracePoint>();
  const adjacencyByKey = new Map<string, Map<string, GraphEdge>>();
  const edgePathKeys = new Map<string, Map<string, PlanTracePathReferenceV1>>();
  const allPaths: PlanTracePathReferenceV1[] = [];
  for (const component of receipt.components) {
    for (const [polylineIndex, polyline] of component.polylines.entries()) {
      const reference = { evidence_set_id: evidenceSetId, component_id: component.component_id, polyline_index: polylineIndex };
      allPaths.push(reference);
      for (let index = 0; index < polyline.points.length - 1; index += 1) {
        const from = point(polyline.points[index], `plan_trace_seed_spine_path_${pathKey(reference)}_point_${index}`);
        const to = point(polyline.points[index + 1], `plan_trace_seed_spine_path_${pathKey(reference)}_point_${index + 1}`);
        const fromKey = pointKey(from);
        const toKey = pointKey(to);
        const weight = Math.hypot(to.x - from.x, to.y - from.y);
        if (weight <= 0) continue;
        points.set(fromKey, from);
        points.set(toKey, to);
        const key = edgeKey(fromKey, toKey);
        for (const [a, b] of [[fromKey, toKey], [toKey, fromKey]] as const) {
          const neighbors = adjacencyByKey.get(a) ?? new Map<string, GraphEdge>();
          const prior = neighbors.get(b);
          if (!prior || weight < prior.weight) neighbors.set(b, { to: b, weight, edge_key: key });
          adjacencyByKey.set(a, neighbors);
        }
        const refs = edgePathKeys.get(key) ?? new Map<string, PlanTracePathReferenceV1>();
        refs.set(pathKey(reference), reference);
        edgePathKeys.set(key, refs);
      }
    }
  }
  return {
    points,
    adjacency: new Map([...adjacencyByKey].map(([key, value]) => [key, [...value.values()]])),
    edge_paths: new Map([...edgePathKeys].map(([key, value]) => [key, [...value.values()].sort(comparePaths)])),
    all_paths: allPaths.sort(comparePaths)
  };
}

function nearestNode(graph: Graph, target: PlanTracePoint, maximum: number):
  | { status: "ready"; key: string; point: PlanTracePoint; distance: number }
  | { status: "out_of_range"; distance: number }
  | { status: "ambiguous"; distance: number } {
  const ranked = [...graph.points].map(([key, value]) => ({
    key,
    point: value,
    distance: Math.hypot(value.x - target.x, value.y - target.y)
  })).sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
  const first = ranked[0];
  if (!first || first.distance > maximum) return { status: "out_of_range", distance: first?.distance ?? Number.POSITIVE_INFINITY };
  if (ranked[1] && Math.abs(ranked[1].distance - first.distance) <= 1e-6) {
    return { status: "ambiguous", distance: first.distance };
  }
  return { status: "ready", ...first };
}

function shortestPath(graph: Graph, start: string, end: string):
  | { status: "none" }
  | { status: "ambiguous" }
  | { status: "ready"; node_keys: string[]; edge_keys: string[]; length: number } {
  const distance = new Map<string, number>([[start, 0]]);
  const pathCount = new Map<string, number>([[start, 1]]);
  const previous = new Map<string, { node: string; edge: string }>();
  const pending = new Set(graph.points.keys());
  while (pending.size > 0) {
    let current: string | undefined;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const key of pending) {
      const value = distance.get(key) ?? Number.POSITIVE_INFINITY;
      if (value < currentDistance) { current = key; currentDistance = value; }
    }
    if (!current || !Number.isFinite(currentDistance)) break;
    pending.delete(current);
    for (const edge of graph.adjacency.get(current) ?? []) {
      if (!pending.has(edge.to)) continue;
      const alternative = currentDistance + edge.weight;
      const prior = distance.get(edge.to) ?? Number.POSITIVE_INFINITY;
      if (alternative < prior - 1e-6) {
        distance.set(edge.to, alternative);
        pathCount.set(edge.to, pathCount.get(current) ?? 1);
        previous.set(edge.to, { node: current, edge: edge.edge_key });
      } else if (Math.abs(alternative - prior) <= 1e-6) {
        pathCount.set(edge.to, Math.min(2, (pathCount.get(edge.to) ?? 1) + (pathCount.get(current) ?? 1)));
      }
    }
  }
  const length = distance.get(end);
  if (!Number.isFinite(length)) return { status: "none" };
  if ((pathCount.get(end) ?? 0) !== 1) return { status: "ambiguous" };
  const nodes = [end];
  const edges: string[] = [];
  let current = end;
  while (current !== start) {
    const prior = previous.get(current);
    if (!prior) return { status: "none" };
    nodes.push(prior.node);
    edges.push(prior.edge);
    current = prior.node;
  }
  return { status: "ready", node_keys: nodes.reverse(), edge_keys: edges.reverse(), length: length! };
}

function distanceToSegment(value: PlanTracePoint, start: PlanTracePoint, end: PlanTracePoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(value.x - start.x, value.y - start.y);
  const t = Math.max(0, Math.min(1, ((value.x - start.x) * dx + (value.y - start.y) * dy) / lengthSquared));
  return Math.hypot(value.x - (start.x + t * dx), value.y - (start.y + t * dy));
}

export function compilePlanTraceSeedSpinesV1(
  input: PlanTraceSeedSpineInputV1,
  receipt: PlanTraceExtractionReceipt
): PlanTraceSeedSpineReceiptV1 {
  if (!input || input.schema_version !== 1) throw new Error("plan_trace_seed_spine_requires_schema_v1");
  if (!receipt || receipt.schema_version !== 1) throw new Error("plan_trace_seed_spine_receipt_is_required");
  const sourceHash = sha256(input.source_image_sha256, "plan_trace_seed_spine_source_image_sha256");
  if (sha256(receipt.source_image_sha256, "plan_trace_seed_spine_receipt_source_image_sha256") !== sourceHash) {
    throw new Error("plan_trace_seed_spine_source_hash_mismatch");
  }
  const policyHash = sha256(input.extraction_policy_sha256, "plan_trace_seed_spine_extraction_policy_sha256");
  if (sha256(receipt.extraction_policy_sha256, "plan_trace_seed_spine_receipt_policy_sha256") !== policyHash) {
    throw new Error("plan_trace_seed_spine_extraction_policy_hash_mismatch");
  }
  const receiptHash = sha256(input.extraction_receipt_sha256, "plan_trace_seed_spine_extraction_receipt_sha256");
  if (sha256PlanTraceExtractionReceiptV1(receipt) !== receiptHash) {
    throw new Error("plan_trace_seed_spine_extraction_receipt_hash_mismatch");
  }
  const evidenceSetId = requiredText(input.evidence_set_id, "plan_trace_seed_spine_evidence_set_id");
  const seedEvidenceHash = sha256(input.seed_evidence_sha256, "plan_trace_seed_spine_seed_evidence_sha256");
  if (input.seed_basis !== "host_trusted_route_seed") throw new Error("plan_trace_seed_spine_seed_basis_invalid");
  if (!receipt.network_scope || receipt.network_scope.seed_basis !== input.seed_basis
    || receipt.network_scope.seed_evidence_sha256 !== seedEvidenceHash) {
    throw new Error("plan_trace_seed_spine_network_scope_evidence_mismatch");
  }
  if (!Array.isArray(input.seed_spans) || input.seed_spans.length === 0 || input.seed_spans.length > 50) {
    throw new Error("plan_trace_seed_spine_requires_one_to_fifty_spans");
  }
  const maximumSnap = positive(input.maximum_snap_distance_px, "plan_trace_seed_spine_maximum_snap_distance_px");
  const maximumDeviation = positive(input.maximum_path_deviation_px, "plan_trace_seed_spine_maximum_path_deviation_px");
  const maximumRatio = positive(input.maximum_path_length_ratio, "plan_trace_seed_spine_maximum_path_length_ratio");
  if (maximumSnap > 100 || maximumDeviation > 100 || maximumRatio > 4) throw new Error("plan_trace_seed_spine_policy_too_permissive");
  const ids = new Set<string>();
  const spans = input.seed_spans.map((raw, index) => {
    const spanId = requiredText(raw?.span_id, `plan_trace_seed_spine_span_${index}_id`);
    if (ids.has(spanId)) throw new Error(`plan_trace_seed_spine_duplicate_span_id:${spanId}`);
    ids.add(spanId);
    const start = point(raw.start_point_px, `plan_trace_seed_spine_span_${spanId}_start`);
    const end = point(raw.end_point_px, `plan_trace_seed_spine_span_${spanId}_end`);
    if (Math.hypot(end.x - start.x, end.y - start.y) <= 0) throw new Error(`plan_trace_seed_spine_span_is_degenerate:${spanId}`);
    return { spanId, start, end };
  });
  const graph = buildGraph(receipt, evidenceSetId);
  const ready: PlanTraceSeedSpineReadyV1[] = [];
  const deferred: PlanTraceSeedSpineDeferredV1[] = [];
  const used = new Map<string, PlanTracePathReferenceV1>();
  const defer = (spanId: string, reason: PlanTraceSeedSpineDeferredV1["reason"], note: string) => {
    deferred.push({ span_id: spanId, status: "deferred", reason, note });
  };
  for (const span of spans) {
    const start = nearestNode(graph, span.start, maximumSnap);
    const end = nearestNode(graph, span.end, maximumSnap);
    if (start.status !== "ready") { defer(span.spanId, start.status === "ambiguous" ? "ambiguous_start_snap" : "start_snap_out_of_range", `nearest start distance ${start.distance}`); continue; }
    if (end.status !== "ready") { defer(span.spanId, end.status === "ambiguous" ? "ambiguous_end_snap" : "end_snap_out_of_range", `nearest end distance ${end.distance}`); continue; }
    if (start.key === end.key) { defer(span.spanId, "degenerate_snapped_span", "both seed endpoints snapped to one skeleton node"); continue; }
    const path = shortestPath(graph, start.key, end.key);
    if (path.status === "none") { defer(span.spanId, "no_connected_path", "snapped endpoints do not share a skeleton path"); continue; }
    if (path.status === "ambiguous") { defer(span.spanId, "ambiguous_shortest_path", "more than one equal shortest skeleton path exists"); continue; }
    const points = path.node_keys.map(key => graph.points.get(key)!);
    const pathDeviation = Math.max(...points.map(value => distanceToSegment(value, span.start, span.end)));
    if (pathDeviation > maximumDeviation) { defer(span.spanId, "path_deviation_exceeded", `maximum deviation ${pathDeviation}`); continue; }
    const seedChord = Math.hypot(span.end.x - span.start.x, span.end.y - span.start.y);
    const ratio = path.length / seedChord;
    if (ratio > maximumRatio) { defer(span.spanId, "path_length_ratio_exceeded", `path length ratio ${ratio}`); continue; }
    const sourcePaths = new Map<string, PlanTracePathReferenceV1>();
    for (const key of path.edge_keys) for (const reference of graph.edge_paths.get(key) ?? []) {
      sourcePaths.set(pathKey(reference), reference);
      used.set(pathKey(reference), reference);
    }
    ready.push({
      span_id: span.spanId,
      status: "source_spine_ready",
      seed_start_point_px: span.start,
      seed_end_point_px: span.end,
      snapped_start_point_px: start.point,
      snapped_end_point_px: end.point,
      start_snap_distance_px: start.distance,
      end_snap_distance_px: end.distance,
      points,
      length_px: path.length,
      seed_chord_px: seedChord,
      path_length_ratio: ratio,
      maximum_path_deviation_px: pathDeviation,
      source_paths: [...sourcePaths.values()].sort(comparePaths)
    });
  }
  const usedPaths = [...used.values()].sort(comparePaths);
  const unresolved = graph.all_paths.filter(reference => !used.has(pathKey(reference)));
  return {
    schema_version: 1,
    source_image_sha256: sourceHash,
    extraction_policy_sha256: policyHash,
    extraction_receipt_sha256: receiptHash,
    evidence_set_id: evidenceSetId,
    seed_evidence_sha256: seedEvidenceHash,
    spine_contract_sha256: digest(input),
    ready_spines: ready,
    deferred_spines: deferred,
    used_source_paths: usedPaths,
    unresolved_source_paths: unresolved,
    status: ready.length > 0 ? "spines_ready" : "no_spines_ready",
    native_write_allowed: false,
    usage_constraints: [
      "Each ready spine is only the unique shortest extracted-skeleton path between two host-trusted, SHA-256-bound source endpoints.",
      "Every unselected source polyline remains explicitly unresolved; a ready spine does not establish whole-network completeness.",
      "Source spines do not establish discipline, system, size, profile, elevation, type, native segmentation, connectors, or write authority."
    ]
  };
}
