import crypto from "node:crypto";

export type MepCoveragePoint = { x: number; y: number };
export type MepCoverageBounds = { min: MepCoveragePoint; max: MepCoveragePoint };
export type MepCoverageDiscipline = "mechanical" | "plumbing" | "electrical";

export type BoundedMepRegionCoverageCandidateV1 = {
  candidate_id: string;
  primitive: "point_symbol" | "linear_trace" | "junction" | "circuit_annotation" | "unknown";
  pixel_bounds: MepCoverageBounds;
  /**
   * Optional explicit point used to decide whether a candidate belongs to an
   * irregular scope polygon. It must remain inside pixel_bounds. When omitted,
   * the pixel-bounds center is used.
   */
  scope_point?: MepCoveragePoint;
  /**
   * Circuit text may sit outside the room while its leader targets a device
   * inside it. This field scopes that annotation through the exact point-symbol
   * candidate it annotates instead of through a free-floating coordinate.
   */
  scope_anchor_candidate_id?: string;
  visibility: "clear" | "partial" | "occluded";
  disposition:
    | { status: "resolved"; observation_ids: string[] }
    | {
        status: "unresolved";
        reason: "ambiguous_symbol" | "illegible_connectivity" | "unresolved_member_classification" | "occluded" | "clipped_by_region";
        note: string;
      };
};

export type BoundedMepRegionCoverageV1 = {
  schema_version: 1;
  scope_id: string;
  source_evidence_sha256: string;
  registered_render_sha256: string;
  coordinate_space: "registered_render_pixels_top_left";
  region: MepCoverageBounds;
  /**
   * Optional unclosed simple polygon inside region. Candidate scope is decided
   * by scope_point (or the candidate-bounds center), including the boundary.
   */
  scope_polygon?: MepCoveragePoint[];
  disciplines: MepCoverageDiscipline[];
  candidates: BoundedMepRegionCoverageCandidateV1[];
};

export type MepCoverageObservationDescriptor = {
  observation_id: string;
  kind: "duct_route" | "conduit_route" | "air_terminal" | "mechanical_equipment" | "pipe_route" | "plumbing_fixture" | "electrical_device" | "light_fixture" | "lighting_device" | "electrical_equipment" | "electrical_circuit";
  discipline: MepCoverageDiscipline;
  member_observation_ids?: string[];
};

export type MepCoverageModelRole = Exclude<MepCoverageObservationDescriptor["kind"], "electrical_circuit">;
export type MepCoverageRepresentationV2 = {
  kind: "single_model_symbol" | "multi_symbol_cluster" | "annotation_cluster" | "linear_model_primitive" | "junction_model_primitive" | "unknown";
  role: MepCoverageModelRole | "electrical_circuit" | "device_tag" | "leader" | "unknown";
  evidence: "direct_symbol_geometry" | "leader_endpoint" | "text_only" | "mixed_or_overlapped";
  symbol_count: number;
  clipped_by_region: boolean;
};

export type BoundedMepRegionCoverageCandidateV2 = BoundedMepRegionCoverageCandidateV1 & {
  representation: MepCoverageRepresentationV2;
};

export type BoundedMepRegionCoverageV2 = Omit<BoundedMepRegionCoverageV1, "schema_version" | "candidates"> & {
  schema_version: 2;
  candidates: BoundedMepRegionCoverageCandidateV2[];
};

export type BoundedMepRegionCoverageReceiptV1 = {
  schema_version: 1;
  scope_id: string;
  source_evidence_sha256: string;
  registered_render_sha256: string;
  coordinate_space: "registered_render_pixels_top_left";
  region: MepCoverageBounds;
  scope_polygon?: MepCoveragePoint[];
  region_sha256: string;
  coverage_contract_sha256: string;
  coverage_status: "complete" | "partial";
  disciplines: MepCoverageDiscipline[];
  candidate_count: number;
  resolved_candidate_ids: string[];
  unresolved_candidate_ids: string[];
  covered_observation_ids: string[];
};

export type BoundedMepRegionCoverageReceiptV2 = Omit<BoundedMepRegionCoverageReceiptV1, "schema_version"> & {
  schema_version: 2;
  representation_counts: Record<MepCoverageRepresentationV2["kind"], number>;
};

export type BoundedMepRegionCoverageContext = {
  scope_id: string;
  source_evidence_sha256: string;
  registered_render_sha256: string;
  render_width_px: number;
  render_height_px: number;
  package_discipline: MepCoverageDiscipline | "mixed";
  observations: MepCoverageObservationDescriptor[];
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

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function point(value: MepCoveragePoint, label: string): MepCoveragePoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  return { x: finite(value.x, `${label}_x`), y: finite(value.y, `${label}_y`) };
}

function bounds(value: MepCoverageBounds, label: string): MepCoverageBounds {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const min = point(value.min, `${label}_min`);
  const max = point(value.max, `${label}_max`);
  if (max.x <= min.x || max.y <= min.y) throw new Error(`${label}_must_have_positive_extent`);
  return { min, max };
}

function contains(outer: MepCoverageBounds, inner: MepCoverageBounds): boolean {
  return inner.min.x >= outer.min.x && inner.max.x <= outer.max.x
    && inner.min.y >= outer.min.y && inner.max.y <= outer.max.y;
}

function containsPoint(outer: MepCoverageBounds, inner: MepCoveragePoint): boolean {
  return inner.x >= outer.min.x && inner.x <= outer.max.x
    && inner.y >= outer.min.y && inner.y <= outer.max.y;
}

function cross(a: MepCoveragePoint, b: MepCoveragePoint, c: MepCoveragePoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(pointValue: MepCoveragePoint, a: MepCoveragePoint, b: MepCoveragePoint): boolean {
  const epsilon = 1e-7;
  if (Math.abs(cross(a, b, pointValue)) > epsilon) return false;
  return pointValue.x >= Math.min(a.x, b.x) - epsilon
    && pointValue.x <= Math.max(a.x, b.x) + epsilon
    && pointValue.y >= Math.min(a.y, b.y) - epsilon
    && pointValue.y <= Math.max(a.y, b.y) + epsilon;
}

function segmentsIntersect(a: MepCoveragePoint, b: MepCoveragePoint, c: MepCoveragePoint, d: MepCoveragePoint): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
    && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  return pointOnSegment(c, a, b) || pointOnSegment(d, a, b)
    || pointOnSegment(a, c, d) || pointOnSegment(b, c, d);
}

function polygon(value: MepCoveragePoint[] | undefined, region: MepCoverageBounds): MepCoveragePoint[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 3 || value.length > 128) {
    throw new Error("mep_region_coverage_scope_polygon_must_have_3_to_128_vertices");
  }
  const result = value.map((entry, index) => point(entry, `mep_region_coverage_scope_polygon_${index}`));
  for (const [index, vertex] of result.entries()) {
    if (!containsPoint(region, vertex)) throw new Error(`mep_region_coverage_scope_polygon_vertex_outside_region:${index}`);
    const next = result[(index + 1) % result.length]!;
    if (vertex.x === next.x && vertex.y === next.y) {
      throw new Error(`mep_region_coverage_scope_polygon_duplicate_consecutive_vertex:${index}`);
    }
  }
  let twiceArea = 0;
  for (let index = 0; index < result.length; index += 1) {
    const current = result[index]!;
    const next = result[(index + 1) % result.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  if (Math.abs(twiceArea) <= 1e-7) throw new Error("mep_region_coverage_scope_polygon_has_zero_area");
  for (let first = 0; first < result.length; first += 1) {
    const firstNext = (first + 1) % result.length;
    for (let second = first + 1; second < result.length; second += 1) {
      const secondNext = (second + 1) % result.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(result[first]!, result[firstNext]!, result[second]!, result[secondNext]!)) {
        throw new Error(`mep_region_coverage_scope_polygon_self_intersects:${first}:${second}`);
      }
    }
  }
  return result;
}

function insidePolygonOrBoundary(pointValue: MepCoveragePoint, polygonValue: MepCoveragePoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygonValue.length - 1; index < polygonValue.length; previous = index, index += 1) {
    const a = polygonValue[previous]!;
    const b = polygonValue[index]!;
    if (pointOnSegment(pointValue, a, b)) return true;
    const crosses = (a.y > pointValue.y) !== (b.y > pointValue.y)
      && pointValue.x < ((b.x - a.x) * (pointValue.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function expectedPrimitive(kind: MepCoverageObservationDescriptor["kind"]): BoundedMepRegionCoverageCandidateV1["primitive"][] {
  if (kind === "pipe_route" || kind === "duct_route" || kind === "conduit_route") return ["linear_trace", "junction"];
  if (kind === "electrical_circuit") return ["circuit_annotation"];
  return ["point_symbol"];
}

function validateRepresentationV2(
  candidate: BoundedMepRegionCoverageCandidateV2,
  observations: Map<string, MepCoverageObservationDescriptor>
): void {
  const candidateId = requiredText(candidate.candidate_id, "mep_region_coverage_v2_candidate_id");
  const representation = candidate.representation;
  if (!representation || typeof representation !== "object") {
    throw new Error(`mep_region_coverage_v2_representation_required:${candidateId}`);
  }
  if (!["single_model_symbol", "multi_symbol_cluster", "annotation_cluster", "linear_model_primitive", "junction_model_primitive", "unknown"].includes(representation.kind)) {
    throw new Error(`mep_region_coverage_v2_representation_kind_invalid:${candidateId}`);
  }
  if (!["direct_symbol_geometry", "leader_endpoint", "text_only", "mixed_or_overlapped"].includes(representation.evidence)) {
    throw new Error(`mep_region_coverage_v2_representation_evidence_invalid:${candidateId}`);
  }
  if (!["duct_route", "conduit_route", "air_terminal", "mechanical_equipment", "pipe_route", "plumbing_fixture", "electrical_device", "light_fixture", "lighting_device", "electrical_equipment", "electrical_circuit", "device_tag", "leader", "unknown"].includes(representation.role)) {
    throw new Error(`mep_region_coverage_v2_representation_role_invalid:${candidateId}`);
  }
  if (!Number.isSafeInteger(representation.symbol_count) || representation.symbol_count < 0 || representation.symbol_count > 1000) {
    throw new Error(`mep_region_coverage_v2_symbol_count_invalid:${candidateId}`);
  }
  if (typeof representation.clipped_by_region !== "boolean") {
    throw new Error(`mep_region_coverage_v2_clipped_by_region_invalid:${candidateId}`);
  }
  if (!candidate.disposition || !["resolved", "unresolved"].includes(candidate.disposition.status)) {
    throw new Error(`mep_region_coverage_candidate_disposition_invalid:${candidateId}`);
  }

  const unresolved = candidate.disposition.status === "unresolved";
  if (representation.kind === "single_model_symbol") {
    if (representation.symbol_count !== 1 || representation.evidence !== "direct_symbol_geometry") {
      throw new Error(`mep_region_coverage_v2_single_symbol_requires_direct_geometry:${candidateId}`);
    }
    if (candidate.primitive !== "point_symbol") {
      throw new Error(`mep_region_coverage_v2_single_symbol_requires_point_primitive:${candidateId}`);
    }
    if (!unresolved && (candidate.visibility !== "clear" || representation.clipped_by_region)) {
      throw new Error(`mep_region_coverage_v2_resolved_symbol_must_be_complete_and_clear:${candidateId}`);
    }
  } else if (representation.kind === "multi_symbol_cluster") {
    if (representation.symbol_count < 2 || candidate.primitive !== "point_symbol") {
      throw new Error(`mep_region_coverage_v2_multi_symbol_cluster_invalid:${candidateId}`);
    }
    const expectedReason = representation.clipped_by_region ? "clipped_by_region" : "unresolved_member_classification";
    if (candidate.disposition.status !== "unresolved" || candidate.disposition.reason !== expectedReason) {
      throw new Error(`mep_region_coverage_v2_multi_symbol_cluster_must_be_unresolved:${candidateId}`);
    }
  } else if (representation.kind === "annotation_cluster") {
    if (representation.symbol_count !== 0 || !["circuit_annotation", "unknown"].includes(candidate.primitive)) {
      throw new Error(`mep_region_coverage_v2_annotation_cluster_invalid:${candidateId}`);
    }
    if (!unresolved && representation.role !== "electrical_circuit") {
      throw new Error(`mep_region_coverage_v2_annotation_cannot_resolve_model_element:${candidateId}`);
    }
    if (!unresolved && !clean(candidate.scope_anchor_candidate_id)) {
      throw new Error(`mep_region_coverage_v2_circuit_annotation_requires_symbol_anchor:${candidateId}`);
    }
  } else if (representation.kind === "linear_model_primitive") {
    if (representation.symbol_count !== 0 || representation.evidence !== "direct_symbol_geometry" || candidate.primitive !== "linear_trace") {
      throw new Error(`mep_region_coverage_v2_linear_representation_invalid:${candidateId}`);
    }
  } else if (representation.kind === "junction_model_primitive") {
    if (representation.symbol_count !== 0 || representation.evidence !== "direct_symbol_geometry" || candidate.primitive !== "junction") {
      throw new Error(`mep_region_coverage_v2_junction_representation_invalid:${candidateId}`);
    }
  } else if (!unresolved || candidate.primitive !== "unknown" || representation.role !== "unknown" || representation.symbol_count !== 0) {
    throw new Error(`mep_region_coverage_v2_unknown_representation_must_be_unresolved:${candidateId}`);
  }

  if (candidate.disposition.status === "unresolved") {
    if (representation.clipped_by_region && candidate.disposition.reason !== "clipped_by_region") {
      throw new Error(`mep_region_coverage_v2_clipped_candidate_reason_mismatch:${candidateId}`);
    }
    return;
  }

  if (!Array.isArray(candidate.disposition.observation_ids) || candidate.disposition.observation_ids.length !== 1) {
    throw new Error(`mep_region_coverage_v2_resolved_candidate_requires_exactly_one_observation:${candidateId}`);
  }

  for (const observationId of candidate.disposition.observation_ids) {
    const observation = observations.get(observationId);
    if (!observation) continue;
    if (representation.role !== observation.kind) {
      throw new Error(`mep_region_coverage_v2_representation_role_mismatch:${candidateId}:${observationId}`);
    }
    if (candidate.primitive === "point_symbol" && representation.kind !== "single_model_symbol") {
      throw new Error(`mep_region_coverage_v2_resolved_point_requires_single_symbol:${candidateId}`);
    }
    if (candidate.primitive === "linear_trace" && representation.kind !== "linear_model_primitive") {
      throw new Error(`mep_region_coverage_v2_resolved_trace_requires_linear_representation:${candidateId}`);
    }
    if (candidate.primitive === "junction" && representation.kind !== "junction_model_primitive") {
      throw new Error(`mep_region_coverage_v2_resolved_junction_requires_junction_representation:${candidateId}`);
    }
  }
}

export function validateBoundedMepRegionCoverageV1(
  input: BoundedMepRegionCoverageV1,
  context: BoundedMepRegionCoverageContext
): BoundedMepRegionCoverageReceiptV1 {
  if (!input || input.schema_version !== 1) throw new Error("mep_region_coverage_requires_schema_v1");
  const scopeId = requiredText(input.scope_id, "mep_region_coverage_scope_id");
  if (scopeId !== requiredText(context.scope_id, "mep_region_coverage_context_scope_id")) {
    throw new Error("mep_region_coverage_scope_mismatch");
  }
  const sourceHash = sha256(input.source_evidence_sha256, "mep_region_coverage_source_evidence_sha256");
  if (sourceHash !== sha256(context.source_evidence_sha256, "mep_region_coverage_context_source_evidence_sha256")) {
    throw new Error("mep_region_coverage_source_hash_mismatch");
  }
  const renderHash = sha256(input.registered_render_sha256, "mep_region_coverage_registered_render_sha256");
  if (renderHash !== sha256(context.registered_render_sha256, "mep_region_coverage_context_registered_render_sha256")) {
    throw new Error("mep_region_coverage_render_hash_mismatch");
  }
  if (input.coordinate_space !== "registered_render_pixels_top_left") {
    throw new Error("mep_region_coverage_coordinate_space_invalid");
  }
  const renderBounds: MepCoverageBounds = {
    min: { x: 0, y: 0 },
    max: {
      x: finite(context.render_width_px, "mep_region_coverage_render_width_px"),
      y: finite(context.render_height_px, "mep_region_coverage_render_height_px")
    }
  };
  const region = bounds(input.region, "mep_region_coverage_region");
  if (!contains(renderBounds, region)) throw new Error("mep_region_coverage_region_outside_registered_render");
  const scopePolygon = polygon(input.scope_polygon, region);

  if (!Array.isArray(input.disciplines) || input.disciplines.length === 0) {
    throw new Error("mep_region_coverage_disciplines_are_required");
  }
  const disciplines = [...new Set(input.disciplines)];
  if (disciplines.length !== input.disciplines.length || disciplines.some((entry) => !["mechanical", "plumbing", "electrical"].includes(entry))) {
    throw new Error("mep_region_coverage_disciplines_invalid");
  }
  if (context.package_discipline !== "mixed" && (disciplines.length !== 1 || disciplines[0] !== context.package_discipline)) {
    throw new Error("mep_region_coverage_package_discipline_mismatch");
  }

  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new Error("mep_region_coverage_candidates_are_required");
  }
  if (!context || !Array.isArray(context.observations)) {
    throw new Error("mep_region_coverage_context_observations_are_required");
  }
  const observations = new Map<string, MepCoverageObservationDescriptor>();
  for (const observation of context.observations) {
    if (!observation || typeof observation !== "object") throw new Error("mep_region_coverage_context_observation_must_be_object");
    const id = requiredText(observation.observation_id, "mep_region_coverage_observation_id");
    if (observations.has(id)) throw new Error(`mep_region_coverage_duplicate_observation_id:${id}`);
    observations.set(id, observation);
  }
  const candidateIds = new Set<string>();
  const candidatesById = new Map<string, { candidate: BoundedMepRegionCoverageCandidateV1; index: number }>();
  for (const [index, candidate] of input.candidates.entries()) {
    const candidateId = requiredText(candidate.candidate_id, `mep_region_coverage_candidate_${index}_id`);
    if (candidateIds.has(candidateId)) throw new Error(`mep_region_coverage_duplicate_candidate_id:${candidateId}`);
    candidateIds.add(candidateId);
    candidatesById.set(candidateId, { candidate, index });
  }
  const observationCandidateIds = new Map<string, string[]>();
  const resolvedCandidateIds: string[] = [];
  const unresolvedCandidateIds: string[] = [];

  for (const [index, candidate] of input.candidates.entries()) {
    const candidateId = requiredText(candidate.candidate_id, `mep_region_coverage_candidate_${index}_id`);
    const candidateBounds = bounds(candidate.pixel_bounds, `mep_region_coverage_candidate_${candidateId}_bounds`);
    if (!contains(region, candidateBounds)) throw new Error(`mep_region_coverage_candidate_outside_region:${candidateId}`);
    if (candidate.scope_point !== undefined && clean(candidate.scope_anchor_candidate_id)) {
      throw new Error(`mep_region_coverage_candidate_scope_point_and_anchor_are_mutually_exclusive:${candidateId}`);
    }
    let scopePoint: MepCoveragePoint;
    const anchorCandidateId = clean(candidate.scope_anchor_candidate_id);
    if (anchorCandidateId) {
      if (candidate.primitive !== "circuit_annotation") {
        throw new Error(`mep_region_coverage_scope_anchor_requires_circuit_annotation:${candidateId}`);
      }
      if (anchorCandidateId === candidateId) throw new Error(`mep_region_coverage_scope_anchor_cannot_self_reference:${candidateId}`);
      const anchored = candidatesById.get(anchorCandidateId);
      if (!anchored) throw new Error(`mep_region_coverage_scope_anchor_unknown_candidate:${candidateId}:${anchorCandidateId}`);
      if (anchored.candidate.primitive !== "point_symbol") {
        throw new Error(`mep_region_coverage_scope_anchor_requires_point_symbol:${candidateId}:${anchorCandidateId}`);
      }
      if (clean(anchored.candidate.scope_anchor_candidate_id)) {
        throw new Error(`mep_region_coverage_scope_anchor_cannot_chain:${candidateId}:${anchorCandidateId}`);
      }
      const anchoredBounds = bounds(
        anchored.candidate.pixel_bounds,
        `mep_region_coverage_candidate_${anchorCandidateId}_bounds`
      );
      scopePoint = anchored.candidate.scope_point === undefined
        ? { x: (anchoredBounds.min.x + anchoredBounds.max.x) / 2, y: (anchoredBounds.min.y + anchoredBounds.max.y) / 2 }
        : point(anchored.candidate.scope_point, `mep_region_coverage_candidate_${anchorCandidateId}_scope_point`);
      if (!containsPoint(anchoredBounds, scopePoint)) {
        throw new Error(`mep_region_coverage_candidate_scope_point_outside_bounds:${anchorCandidateId}`);
      }
    } else {
      scopePoint = candidate.scope_point === undefined
        ? { x: (candidateBounds.min.x + candidateBounds.max.x) / 2, y: (candidateBounds.min.y + candidateBounds.max.y) / 2 }
        : point(candidate.scope_point, `mep_region_coverage_candidate_${candidateId}_scope_point`);
      if (!containsPoint(candidateBounds, scopePoint)) {
        throw new Error(`mep_region_coverage_candidate_scope_point_outside_bounds:${candidateId}`);
      }
    }
    if (scopePolygon && !insidePolygonOrBoundary(scopePoint, scopePolygon)) {
      throw new Error(`mep_region_coverage_candidate_outside_scope_polygon:${candidateId}`);
    }
    if (!["point_symbol", "linear_trace", "junction", "circuit_annotation", "unknown"].includes(candidate.primitive)) {
      throw new Error(`mep_region_coverage_candidate_primitive_invalid:${candidateId}`);
    }
    if (!["clear", "partial", "occluded"].includes(candidate.visibility)) {
      throw new Error(`mep_region_coverage_candidate_visibility_invalid:${candidateId}`);
    }
    if (!candidate.disposition || !["resolved", "unresolved"].includes(candidate.disposition.status)) {
      throw new Error(`mep_region_coverage_candidate_disposition_invalid:${candidateId}`);
    }
    if (candidate.disposition.status === "unresolved") {
      if (!["ambiguous_symbol", "illegible_connectivity", "unresolved_member_classification", "occluded", "clipped_by_region"].includes(candidate.disposition.reason)) {
        throw new Error(`mep_region_coverage_candidate_unresolved_reason_invalid:${candidateId}`);
      }
      if (candidate.visibility === "clear" && candidate.disposition.reason === "occluded") {
        throw new Error(`mep_region_coverage_clear_candidate_cannot_be_occluded:${candidateId}`);
      }
      requiredText(candidate.disposition.note, `mep_region_coverage_candidate_${candidateId}_note`);
      unresolvedCandidateIds.push(candidateId);
      continue;
    }
    if (candidate.primitive === "unknown") throw new Error(`mep_region_coverage_unknown_candidate_cannot_be_resolved:${candidateId}`);
    if (!Array.isArray(candidate.disposition.observation_ids) || candidate.disposition.observation_ids.length === 0) {
      throw new Error(`mep_region_coverage_resolved_candidate_requires_observations:${candidateId}`);
    }
    if (new Set(candidate.disposition.observation_ids).size !== candidate.disposition.observation_ids.length) {
      throw new Error(`mep_region_coverage_candidate_observation_ids_must_be_unique:${candidateId}`);
    }
    for (const observationId of candidate.disposition.observation_ids) {
      const observation = observations.get(observationId);
      if (!observation) throw new Error(`mep_region_coverage_unknown_observation:${candidateId}:${observationId}`);
      if (!disciplines.includes(observation.discipline)) {
        throw new Error(`mep_region_coverage_observation_outside_discipline:${candidateId}:${observationId}`);
      }
      if (!expectedPrimitive(observation.kind).includes(candidate.primitive)) {
        throw new Error(`mep_region_coverage_candidate_primitive_mismatch:${candidateId}:${observationId}`);
      }
      const existingCandidateIds = observationCandidateIds.get(observationId) ?? [];
      if (existingCandidateIds.length > 0 && observation.kind !== "electrical_circuit") {
        throw new Error(`mep_region_coverage_observation_linked_multiple_times:${observationId}`);
      }
      // A single native circuit may have the same circuit annotation printed beside
      // several member devices. Preserve every spatial annotation candidate while
      // keeping one typed circuit observation for the actual membership graph.
      observationCandidateIds.set(observationId, [...existingCandidateIds, candidateId]);
    }
    resolvedCandidateIds.push(candidateId);
  }

  const missingObservations = [...observations.keys()].filter((id) => !observationCandidateIds.has(id));
  if (missingObservations.length > 0) {
    throw new Error(`mep_region_coverage_observations_without_candidates:${missingObservations.sort().join(",")}`);
  }
  const payload = {
    schema_version: 1 as const,
    scope_id: scopeId,
    source_evidence_sha256: sourceHash,
    registered_render_sha256: renderHash,
    coordinate_space: "registered_render_pixels_top_left" as const,
    region,
    ...(scopePolygon ? { scope_polygon: scopePolygon } : {}),
    region_sha256: digest(scopePolygon ? { region, scope_polygon: scopePolygon } : region),
    coverage_contract_sha256: digest(input),
    coverage_status: unresolvedCandidateIds.length > 0 ? "partial" as const : "complete" as const,
    disciplines,
    candidate_count: input.candidates.length,
    resolved_candidate_ids: resolvedCandidateIds.sort(),
    unresolved_candidate_ids: unresolvedCandidateIds.sort(),
    covered_observation_ids: [...observationCandidateIds.keys()].sort()
  };
  return payload;
}

export function validateBoundedMepRegionCoverageV2(
  input: BoundedMepRegionCoverageV2,
  context: BoundedMepRegionCoverageContext
): BoundedMepRegionCoverageReceiptV2 {
  if (!input || input.schema_version !== 2) throw new Error("mep_region_coverage_requires_schema_v2");
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new Error("mep_region_coverage_candidates_are_required");
  }
  if (!context || !Array.isArray(context.observations)) {
    throw new Error("mep_region_coverage_context_observations_are_required");
  }
  const observations = new Map<string, MepCoverageObservationDescriptor>();
  for (const observation of context.observations) {
    if (!observation || typeof observation !== "object") throw new Error("mep_region_coverage_context_observation_must_be_object");
    const observationId = requiredText(observation.observation_id, "mep_region_coverage_observation_id");
    if (observations.has(observationId)) throw new Error(`mep_region_coverage_duplicate_observation_id:${observationId}`);
    observations.set(observationId, observation);
  }
  const circuitByMember = new Map<string, string>();
  for (const observation of observations.values()) {
    if (observation.kind !== "electrical_circuit") continue;
    if (!Array.isArray(observation.member_observation_ids) || observation.member_observation_ids.length === 0) {
      throw new Error(`mep_region_coverage_v2_circuit_membership_context_required:${observation.observation_id}`);
    }
    if (new Set(observation.member_observation_ids).size !== observation.member_observation_ids.length) {
      throw new Error(`mep_region_coverage_v2_circuit_member_ids_must_be_unique:${observation.observation_id}`);
    }
    for (const memberId of observation.member_observation_ids) {
      const member = observations.get(memberId);
      if (!member || !["electrical_device", "electrical_equipment", "light_fixture"].includes(member.kind)) {
        throw new Error(`mep_region_coverage_v2_circuit_member_unknown_or_unsupported:${observation.observation_id}:${memberId}`);
      }
      const existingCircuitId = circuitByMember.get(memberId);
      if (existingCircuitId) {
        throw new Error(`mep_region_coverage_v2_member_assigned_to_multiple_circuits:${memberId}:${existingCircuitId}:${observation.observation_id}`);
      }
      circuitByMember.set(memberId, observation.observation_id);
    }
  }
  for (const [index, candidate] of input.candidates.entries()) {
    if (!candidate || typeof candidate !== "object") throw new Error(`mep_region_coverage_candidate_${index}_must_be_object`);
  }
  const candidates = new Map(input.candidates.map((candidate) => [candidate.candidate_id, candidate]));
  for (const candidate of input.candidates) {
    validateRepresentationV2(candidate, observations);
    if (candidate.disposition.status === "resolved" && candidate.representation.role === "lighting_device") {
      throw new Error(`mep_region_coverage_v2_lighting_device_native_observation_not_supported:${candidate.candidate_id}`);
    }
  }
  for (const candidate of input.candidates) {
    if (candidate.primitive !== "circuit_annotation" || candidate.disposition.status !== "resolved") continue;
    const anchorId = clean(candidate.scope_anchor_candidate_id);
    const anchor = candidates.get(anchorId);
    if (!anchor
      || anchor.representation.kind !== "single_model_symbol"
      || anchor.disposition.status !== "resolved"
      || !["electrical_device", "electrical_equipment", "light_fixture"].includes(anchor.representation.role)) {
      throw new Error(`mep_region_coverage_v2_circuit_anchor_must_be_resolved_individual_device:${candidate.candidate_id}:${anchorId}`);
    }
    for (const circuitObservationId of candidate.disposition.observation_ids) {
      const circuit = observations.get(circuitObservationId);
      if (!circuit || circuit.kind !== "electrical_circuit") continue;
      if (!Array.isArray(circuit.member_observation_ids) || circuit.member_observation_ids.length === 0) {
        throw new Error(`mep_region_coverage_v2_circuit_membership_context_required:${candidate.candidate_id}:${circuitObservationId}`);
      }
      if (!anchor.disposition.observation_ids.some((observationId) => circuit.member_observation_ids!.includes(observationId))) {
        throw new Error(`mep_region_coverage_v2_circuit_anchor_member_mismatch:${candidate.candidate_id}:${circuitObservationId}:${anchorId}`);
      }
    }
  }

  const v1Input: BoundedMepRegionCoverageV1 = {
    ...input,
    schema_version: 1,
    candidates: input.candidates.map(({ representation: _representation, ...candidate }) => candidate)
  };
  const v1Receipt = validateBoundedMepRegionCoverageV1(v1Input, context);
  const representationCounts: BoundedMepRegionCoverageReceiptV2["representation_counts"] = {
    single_model_symbol: 0,
    multi_symbol_cluster: 0,
    annotation_cluster: 0,
    linear_model_primitive: 0,
    junction_model_primitive: 0,
    unknown: 0
  };
  for (const candidate of input.candidates) representationCounts[candidate.representation.kind] += 1;
  return {
    ...v1Receipt,
    schema_version: 2,
    coverage_contract_sha256: digest(input),
    representation_counts: representationCounts
  };
}

export function validateBoundedMepRegionCoverage(
  input: BoundedMepRegionCoverageV1 | BoundedMepRegionCoverageV2,
  context: BoundedMepRegionCoverageContext
): BoundedMepRegionCoverageReceiptV1 | BoundedMepRegionCoverageReceiptV2 {
  return input?.schema_version === 2
    ? validateBoundedMepRegionCoverageV2(input, context)
    : validateBoundedMepRegionCoverageV1(input as BoundedMepRegionCoverageV1, context);
}
