import crypto from "node:crypto";
import type {
  PlanTraceExtractionReceipt,
  PlanTracePoint,
  PlanTracePolyline
} from "./plan_trace_extraction.js";

export type PlanTracePathReferenceV1 = {
  evidence_set_id: string;
  component_id: string;
  polyline_index: number;
};

export type PlanTraceSourceCandidateV1 = {
  candidate_id: string;
  discipline: "mechanical" | "plumbing" | "electrical";
  source_paths: PlanTracePathReferenceV1[];
  geometry_role:
    | "route_centerline"
    | "outlined_network_boundary"
    | "symbol_or_terminal_outline"
    | "callout_leader"
    | "unknown";
  continuity: "observed_contiguous" | "disconnected_dashes" | "not_applicable";
  disposition:
    | { status: "promoted"; normalized_kind: "route_trace" }
    | { status: "callout_only"; note: string }
    | {
        status: "unresolved";
        reason: "ambiguous_geometry" | "mixed_symbol_and_route" | "clipped_by_scope" | "unknown_role";
        note: string;
      };
};

export type PlanTraceJunctionCandidateV1 = {
  junction_id: string;
  point: PlanTracePoint;
  incident_candidate_ids: string[];
  connectivity: "candidate_only";
};

export type PlanTraceSourceAccountingInputV1 = {
  schema_version: 1;
  scope_id: string;
  source_image_sha256: string;
  coordinate_space: "registered_render_pixels_top_left";
  evidence_sets: Array<{
    evidence_set_id: string;
    extraction_policy_sha256: string;
  }>;
  candidates: PlanTraceSourceCandidateV1[];
  junction_candidates?: PlanTraceJunctionCandidateV1[];
};

export type PlanTraceSourceAccountingContext = {
  evidence_sets: Array<{
    evidence_set_id: string;
    receipt: PlanTraceExtractionReceipt;
  }>;
};

export type PlanTraceSourceAccountingReceiptV1 = {
  schema_version: 1;
  scope_id: string;
  source_image_sha256: string;
  coordinate_space: "registered_render_pixels_top_left";
  source_contract_sha256: string;
  status: "normalized" | "clarification_required";
  native_write_allowed: false;
  candidate_count: number;
  promoted_candidate_ids: string[];
  callout_only_candidate_ids: string[];
  unresolved_candidate_ids: string[];
  disconnected_dash_candidate_ids: string[];
  junction_candidate_ids: string[];
  accounted_path_count: number;
  available_path_count: number;
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

function normalizedPolylineKey(polyline: PlanTracePolyline): string {
  const encode = (points: PlanTracePoint[]) => points
    .map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`)
    .join(";");
  const forward = encode(polyline.points);
  const reverse = encode([...polyline.points].reverse());
  return forward < reverse ? forward : reverse;
}

function checkedPathReference(value: PlanTracePathReferenceV1, label: string): PlanTracePathReferenceV1 {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const evidenceSetId = requiredText(value.evidence_set_id, `${label}_evidence_set_id`);
  const componentId = requiredText(value.component_id, `${label}_component_id`);
  if (!Number.isSafeInteger(value.polyline_index) || value.polyline_index < 0) {
    throw new Error(`${label}_polyline_index_must_be_nonnegative_integer`);
  }
  return { evidence_set_id: evidenceSetId, component_id: componentId, polyline_index: value.polyline_index };
}

export function validatePlanTraceSourceAccountingV1(
  input: PlanTraceSourceAccountingInputV1,
  context: PlanTraceSourceAccountingContext
): PlanTraceSourceAccountingReceiptV1 {
  if (!input || input.schema_version !== 1) throw new Error("plan_trace_source_accounting_requires_schema_v1");
  const scopeId = requiredText(input.scope_id, "plan_trace_source_accounting_scope_id");
  const sourceImageHash = sha256(input.source_image_sha256, "plan_trace_source_accounting_source_image_sha256");
  if (input.coordinate_space !== "registered_render_pixels_top_left") {
    throw new Error("plan_trace_source_accounting_coordinate_space_invalid");
  }
  if (!Array.isArray(input.evidence_sets) || input.evidence_sets.length === 0) {
    throw new Error("plan_trace_source_accounting_evidence_sets_are_required");
  }
  if (!context || !Array.isArray(context.evidence_sets)) {
    throw new Error("plan_trace_source_accounting_context_evidence_sets_are_required");
  }

  const contextById = new Map<string, PlanTraceExtractionReceipt>();
  for (const [index, evidence] of context.evidence_sets.entries()) {
    const evidenceSetId = requiredText(evidence.evidence_set_id, `plan_trace_source_context_evidence_set_${index}_id`);
    if (contextById.has(evidenceSetId)) throw new Error(`plan_trace_source_context_duplicate_evidence_set:${evidenceSetId}`);
    if (!evidence.receipt || evidence.receipt.schema_version !== 1) {
      throw new Error(`plan_trace_source_context_receipt_invalid:${evidenceSetId}`);
    }
    contextById.set(evidenceSetId, evidence.receipt);
  }

  const declaredEvidenceIds = new Set<string>();
  const availablePaths = new Map<string, PlanTracePolyline>();
  const geometryOwners = new Map<string, string>();
  for (const [index, evidence] of input.evidence_sets.entries()) {
    const evidenceSetId = requiredText(evidence.evidence_set_id, `plan_trace_source_evidence_set_${index}_id`);
    if (declaredEvidenceIds.has(evidenceSetId)) throw new Error(`plan_trace_source_duplicate_evidence_set:${evidenceSetId}`);
    declaredEvidenceIds.add(evidenceSetId);
    const receipt = contextById.get(evidenceSetId);
    if (!receipt) throw new Error(`plan_trace_source_missing_context_receipt:${evidenceSetId}`);
    if (sha256(receipt.source_image_sha256, `plan_trace_source_receipt_${evidenceSetId}_source_image_sha256`) !== sourceImageHash) {
      throw new Error(`plan_trace_source_receipt_source_hash_mismatch:${evidenceSetId}`);
    }
    const expectedPolicyHash = sha256(evidence.extraction_policy_sha256, `plan_trace_source_evidence_set_${evidenceSetId}_policy_sha256`);
    if (sha256(receipt.extraction_policy_sha256, `plan_trace_source_receipt_${evidenceSetId}_policy_sha256`) !== expectedPolicyHash) {
      throw new Error(`plan_trace_source_extraction_policy_hash_mismatch:${evidenceSetId}`);
    }
    for (const component of receipt.components) {
      for (const [polylineIndex, polyline] of component.polylines.entries()) {
        const key = pathKey({ evidence_set_id: evidenceSetId, component_id: component.component_id, polyline_index: polylineIndex });
        availablePaths.set(key, polyline);
        const geometryKey = normalizedPolylineKey(polyline);
        const owner = geometryOwners.get(geometryKey);
        if (owner) throw new Error(`plan_trace_source_duplicate_geometry:${owner}:${key}`);
        geometryOwners.set(geometryKey, key);
      }
    }
  }
  const undeclaredContextIds = [...contextById.keys()].filter((id) => !declaredEvidenceIds.has(id));
  if (undeclaredContextIds.length > 0) {
    throw new Error(`plan_trace_source_undeclared_context_evidence_sets:${undeclaredContextIds.sort().join(",")}`);
  }

  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new Error("plan_trace_source_candidates_are_required");
  }
  const candidateIds = new Set<string>();
  const candidateById = new Map<string, PlanTraceSourceCandidateV1>();
  const accountedPaths = new Map<string, string>();
  const promotedCandidateIds: string[] = [];
  const calloutOnlyCandidateIds: string[] = [];
  const unresolvedCandidateIds: string[] = [];
  const disconnectedDashCandidateIds: string[] = [];
  const geometryRoles = ["route_centerline", "outlined_network_boundary", "symbol_or_terminal_outline", "callout_leader", "unknown"];
  const continuityValues = ["observed_contiguous", "disconnected_dashes", "not_applicable"];

  for (const [index, candidate] of input.candidates.entries()) {
    const candidateId = requiredText(candidate.candidate_id, `plan_trace_source_candidate_${index}_id`);
    if (candidateIds.has(candidateId)) throw new Error(`plan_trace_source_duplicate_candidate_id:${candidateId}`);
    candidateIds.add(candidateId);
    candidateById.set(candidateId, candidate);
    if (!["mechanical", "plumbing", "electrical"].includes(candidate.discipline)) {
      throw new Error(`plan_trace_source_candidate_discipline_invalid:${candidateId}`);
    }
    if (!geometryRoles.includes(candidate.geometry_role)) {
      throw new Error(`plan_trace_source_candidate_geometry_role_invalid:${candidateId}`);
    }
    if (!continuityValues.includes(candidate.continuity)) {
      throw new Error(`plan_trace_source_candidate_continuity_invalid:${candidateId}`);
    }
    if (candidate.geometry_role === "route_centerline" && candidate.continuity === "not_applicable") {
      throw new Error(`plan_trace_source_route_continuity_is_required:${candidateId}`);
    }
    if (candidate.geometry_role !== "route_centerline" && candidate.continuity !== "not_applicable") {
      throw new Error(`plan_trace_source_nonroute_continuity_must_be_not_applicable:${candidateId}`);
    }
    if (!Array.isArray(candidate.source_paths) || candidate.source_paths.length === 0) {
      throw new Error(`plan_trace_source_candidate_paths_are_required:${candidateId}`);
    }
    const localPaths = new Set<string>();
    for (const [pathIndex, rawReference] of candidate.source_paths.entries()) {
      const reference = checkedPathReference(rawReference, `plan_trace_source_candidate_${candidateId}_path_${pathIndex}`);
      const key = pathKey(reference);
      if (!availablePaths.has(key)) throw new Error(`plan_trace_source_candidate_path_unknown:${candidateId}:${key}`);
      if (localPaths.has(key)) throw new Error(`plan_trace_source_candidate_path_repeated:${candidateId}:${key}`);
      localPaths.add(key);
      const prior = accountedPaths.get(key);
      if (prior) throw new Error(`plan_trace_source_path_accounted_multiple_times:${key}:${prior}:${candidateId}`);
      accountedPaths.set(key, candidateId);
    }
    if (!candidate.disposition || !["promoted", "callout_only", "unresolved"].includes(candidate.disposition.status)) {
      throw new Error(`plan_trace_source_candidate_disposition_invalid:${candidateId}`);
    }
    if (candidate.disposition.status === "promoted") {
      if (candidate.geometry_role !== "route_centerline" || candidate.disposition.normalized_kind !== "route_trace") {
        throw new Error(`plan_trace_source_only_centerlines_may_be_promoted:${candidateId}`);
      }
      promotedCandidateIds.push(candidateId);
      if (candidate.continuity === "disconnected_dashes") disconnectedDashCandidateIds.push(candidateId);
    } else if (candidate.disposition.status === "callout_only") {
      if (candidate.geometry_role !== "callout_leader") {
        throw new Error(`plan_trace_source_callout_disposition_requires_callout_geometry:${candidateId}`);
      }
      requiredText(candidate.disposition.note, `plan_trace_source_candidate_${candidateId}_note`);
      calloutOnlyCandidateIds.push(candidateId);
    } else {
      if (!["ambiguous_geometry", "mixed_symbol_and_route", "clipped_by_scope", "unknown_role"].includes(candidate.disposition.reason)) {
        throw new Error(`plan_trace_source_candidate_unresolved_reason_invalid:${candidateId}`);
      }
      requiredText(candidate.disposition.note, `plan_trace_source_candidate_${candidateId}_note`);
      unresolvedCandidateIds.push(candidateId);
    }
  }

  const missingPaths = [...availablePaths.keys()].filter((key) => !accountedPaths.has(key));
  if (missingPaths.length > 0) {
    throw new Error(`plan_trace_source_paths_unaccounted:${missingPaths.sort().join(",")}`);
  }

  const junctionIds = new Set<string>();
  for (const [index, junction] of (input.junction_candidates ?? []).entries()) {
    const junctionId = requiredText(junction.junction_id, `plan_trace_source_junction_${index}_id`);
    if (junctionIds.has(junctionId)) throw new Error(`plan_trace_source_duplicate_junction_id:${junctionId}`);
    junctionIds.add(junctionId);
    finite(junction.point?.x, `plan_trace_source_junction_${junctionId}_x`);
    finite(junction.point?.y, `plan_trace_source_junction_${junctionId}_y`);
    if (junction.connectivity !== "candidate_only") {
      throw new Error(`plan_trace_source_junction_connectivity_must_be_candidate_only:${junctionId}`);
    }
    if (!Array.isArray(junction.incident_candidate_ids) || junction.incident_candidate_ids.length < 2) {
      throw new Error(`plan_trace_source_junction_requires_two_incident_candidates:${junctionId}`);
    }
    if (new Set(junction.incident_candidate_ids).size !== junction.incident_candidate_ids.length) {
      throw new Error(`plan_trace_source_junction_incident_candidates_must_be_unique:${junctionId}`);
    }
    for (const incidentId of junction.incident_candidate_ids) {
      const incident = candidateById.get(incidentId);
      if (!incident) throw new Error(`plan_trace_source_junction_unknown_incident_candidate:${junctionId}:${incidentId}`);
      if (incident.disposition.status !== "promoted") {
        throw new Error(`plan_trace_source_junction_incident_candidate_not_promoted:${junctionId}:${incidentId}`);
      }
    }
  }

  return {
    schema_version: 1,
    scope_id: scopeId,
    source_image_sha256: sourceImageHash,
    coordinate_space: "registered_render_pixels_top_left",
    source_contract_sha256: digest(input),
    status: unresolvedCandidateIds.length > 0 ? "clarification_required" : "normalized",
    native_write_allowed: false,
    candidate_count: input.candidates.length,
    promoted_candidate_ids: promotedCandidateIds.sort(),
    callout_only_candidate_ids: calloutOnlyCandidateIds.sort(),
    unresolved_candidate_ids: unresolvedCandidateIds.sort(),
    disconnected_dash_candidate_ids: disconnectedDashCandidateIds.sort(),
    junction_candidate_ids: [...junctionIds].sort(),
    accounted_path_count: accountedPaths.size,
    available_path_count: availablePaths.size,
    usage_constraints: [
      "This receipt normalizes plan-visible raster traces only and never authorizes a native Revit write.",
      "Outlined network boundaries are not route centerlines and cannot be promoted without a separate centerline-derivation receipt.",
      "Disconnected dashed segments remain disconnected; continuity across gaps is not inferred.",
      "Junctions are candidates only and do not authorize snapping or native connectivity.",
      "Discipline, system, size, elevation, family, type, host, and circuit meaning require a separate hash-bound project mapping."
    ]
  };
}
