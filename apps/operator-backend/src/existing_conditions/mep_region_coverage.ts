import crypto from "node:crypto";

export type MepCoveragePoint = { x: number; y: number };
export type MepCoverageBounds = { min: MepCoveragePoint; max: MepCoveragePoint };

export type BoundedMepRegionCoverageCandidateV1 = {
  candidate_id: string;
  primitive: "point_symbol" | "linear_trace" | "junction" | "circuit_annotation" | "unknown";
  pixel_bounds: MepCoverageBounds;
  visibility: "clear" | "partial" | "occluded";
  disposition:
    | { status: "resolved"; observation_ids: string[] }
    | {
        status: "unresolved";
        reason: "ambiguous_symbol" | "illegible_connectivity" | "occluded" | "clipped_by_region";
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
  disciplines: Array<"plumbing" | "electrical">;
  candidates: BoundedMepRegionCoverageCandidateV1[];
};

export type MepCoverageObservationDescriptor = {
  observation_id: string;
  kind: "pipe_route" | "plumbing_fixture" | "electrical_device" | "electrical_circuit";
  discipline: "plumbing" | "electrical";
};

export type BoundedMepRegionCoverageReceiptV1 = {
  schema_version: 1;
  scope_id: string;
  source_evidence_sha256: string;
  registered_render_sha256: string;
  coordinate_space: "registered_render_pixels_top_left";
  region: MepCoverageBounds;
  region_sha256: string;
  coverage_contract_sha256: string;
  coverage_status: "complete" | "partial";
  disciplines: Array<"plumbing" | "electrical">;
  candidate_count: number;
  resolved_candidate_ids: string[];
  unresolved_candidate_ids: string[];
  covered_observation_ids: string[];
};

export type BoundedMepRegionCoverageContext = {
  scope_id: string;
  source_evidence_sha256: string;
  registered_render_sha256: string;
  render_width_px: number;
  render_height_px: number;
  package_discipline: "plumbing" | "electrical" | "mixed";
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

function expectedPrimitive(kind: MepCoverageObservationDescriptor["kind"]): BoundedMepRegionCoverageCandidateV1["primitive"][] {
  if (kind === "pipe_route") return ["linear_trace", "junction"];
  if (kind === "electrical_circuit") return ["circuit_annotation"];
  return ["point_symbol"];
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

  if (!Array.isArray(input.disciplines) || input.disciplines.length === 0) {
    throw new Error("mep_region_coverage_disciplines_are_required");
  }
  const disciplines = [...new Set(input.disciplines)];
  if (disciplines.length !== input.disciplines.length || disciplines.some((entry) => !["plumbing", "electrical"].includes(entry))) {
    throw new Error("mep_region_coverage_disciplines_invalid");
  }
  if (context.package_discipline !== "mixed" && (disciplines.length !== 1 || disciplines[0] !== context.package_discipline)) {
    throw new Error("mep_region_coverage_package_discipline_mismatch");
  }

  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new Error("mep_region_coverage_candidates_are_required");
  }
  const observations = new Map<string, MepCoverageObservationDescriptor>();
  for (const observation of context.observations) {
    const id = requiredText(observation.observation_id, "mep_region_coverage_observation_id");
    if (observations.has(id)) throw new Error(`mep_region_coverage_duplicate_observation_id:${id}`);
    observations.set(id, observation);
  }
  const candidateIds = new Set<string>();
  const coveredObservations = new Set<string>();
  const resolvedCandidateIds: string[] = [];
  const unresolvedCandidateIds: string[] = [];

  for (const [index, candidate] of input.candidates.entries()) {
    const candidateId = requiredText(candidate.candidate_id, `mep_region_coverage_candidate_${index}_id`);
    if (candidateIds.has(candidateId)) throw new Error(`mep_region_coverage_duplicate_candidate_id:${candidateId}`);
    candidateIds.add(candidateId);
    const candidateBounds = bounds(candidate.pixel_bounds, `mep_region_coverage_candidate_${candidateId}_bounds`);
    if (!contains(region, candidateBounds)) throw new Error(`mep_region_coverage_candidate_outside_region:${candidateId}`);
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
      if (!["ambiguous_symbol", "illegible_connectivity", "occluded", "clipped_by_region"].includes(candidate.disposition.reason)) {
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
      if (coveredObservations.has(observationId)) {
        throw new Error(`mep_region_coverage_observation_linked_multiple_times:${observationId}`);
      }
      coveredObservations.add(observationId);
    }
    resolvedCandidateIds.push(candidateId);
  }

  const missingObservations = [...observations.keys()].filter((id) => !coveredObservations.has(id));
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
    region_sha256: digest(region),
    coverage_contract_sha256: digest(input),
    coverage_status: unresolvedCandidateIds.length > 0 ? "partial" as const : "complete" as const,
    disciplines,
    candidate_count: input.candidates.length,
    resolved_candidate_ids: resolvedCandidateIds.sort(),
    unresolved_candidate_ids: unresolvedCandidateIds.sort(),
    covered_observation_ids: [...coveredObservations].sort()
  };
  return payload;
}
