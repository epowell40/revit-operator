import crypto from "node:crypto";
import { normalizeRouteProfileShapeV1, type RouteProfileShapeV1 } from "./route_profile.js";

export type RouteProfileEvidenceKindV1 =
  | "route_annotation"
  | "linked_schedule"
  | "linked_detail"
  | "plan_dimension"
  | "legend_definition"
  | "visual_outline";

export type RouteProfileEvidenceAssociationV1 = "direct" | "continuation_linked" | "unassociated";

export type RouteProfileSourceEvidenceV1 = {
  evidence_id: string;
  source_view_key: string;
  source_sha256: string;
  kind: RouteProfileEvidenceKindV1;
  association: RouteProfileEvidenceAssociationV1;
  text: string;
  confidence: number;
};

export type RouteProfileSourceEvidenceGateInputV1 = {
  schema_version: 1;
  package_id: string;
  primitive_id: string;
  candidate_interpretation_sha256: string;
  requested_shape: RouteProfileShapeV1;
  requested_size: string;
  evidence: RouteProfileSourceEvidenceV1[];
  minimum_dispositive_confidence?: number;
};

export type RouteProfileSourceEvidenceGateReceiptV1 = {
  schema_version: 1;
  artifact_role: "route_profile_source_evidence_gate";
  package_id: string;
  primitive_id: string;
  input_fingerprint_sha256: string;
  status: "accepted" | "deferred" | "rejected";
  requested_shape: RouteProfileShapeV1;
  requested_size: string;
  inferred_shapes: RouteProfileShapeV1[];
  dispositive_evidence_ids: string[];
  dimension_evidence_ids: string[];
  non_dispositive_evidence: Array<{ evidence_id: string; reason: string }>;
  blockers: string[];
  native_write_allowed: boolean;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function confidence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label}_must_be_between_zero_and_one`);
  }
  return value;
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

function explicitShapes(text: string): RouteProfileShapeV1[] {
  const shapes = new Set<RouteProfileShapeV1>();
  if (/\b(?:flat\s+oval|oval)\b/i.test(text)) shapes.add("oval");
  if (/\b(?:rectangular|rectangle|rect)\b/i.test(text)) shapes.add("rectangular");
  if (/\bround\b|\b(?:dia|diameter)\b|[Øø⌀]/i.test(text)) shapes.add("round");
  return [...shapes];
}

function hasDimension(text: string): boolean {
  return /\b\d+(?:\.\d+)?\s*(?:"|in(?:ch(?:es)?)?)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:"|in(?:ch(?:es)?)?)?\b/i.test(text) ||
    /\b\d+(?:\.\d+)?\s*(?:"|in(?:ch(?:es)?)?)?\s*(?:Ø|ø|⌀|dia\b|diameter\b)/i.test(text) ||
    /(?:Ø|ø|⌀)\s*\d+(?:\.\d+)?\s*(?:"|in(?:ch(?:es)?)?)?/i.test(text);
}

function isDispositiveKind(kind: RouteProfileEvidenceKindV1): boolean {
  return kind === "route_annotation" || kind === "linked_schedule" || kind === "linked_detail";
}

export function evaluateRouteProfileSourceEvidenceV1(
  input: RouteProfileSourceEvidenceGateInputV1
): RouteProfileSourceEvidenceGateReceiptV1 {
  if (input.schema_version !== 1) throw new Error("schema_version_must_be_1");
  const packageId = clean(input.package_id);
  const primitiveId = clean(input.primitive_id);
  if (!packageId) throw new Error("package_id_required");
  if (!primitiveId) throw new Error("primitive_id_required");
  sha256(input.candidate_interpretation_sha256, "candidate_interpretation_sha256");
  const requestedShape = normalizeRouteProfileShapeV1(input.requested_shape);
  if (!requestedShape) throw new Error("requested_shape_invalid");
  const requestedSize = clean(input.requested_size);
  if (!requestedSize) throw new Error("requested_size_required");
  const minimumConfidence = input.minimum_dispositive_confidence === undefined
    ? 0.85
    : confidence(input.minimum_dispositive_confidence, "minimum_dispositive_confidence");

  const seenIds = new Set<string>();
  const inferredShapes = new Set<RouteProfileShapeV1>();
  const dispositiveEvidenceIds: string[] = [];
  const dimensionEvidenceIds: string[] = [];
  const nonDispositiveEvidence: Array<{ evidence_id: string; reason: string }> = [];

  for (const [index, item] of input.evidence.entries()) {
    const evidenceId = clean(item.evidence_id);
    if (!evidenceId) throw new Error(`evidence_${index}_id_required`);
    if (seenIds.has(evidenceId)) throw new Error(`duplicate_evidence_id_${evidenceId}`);
    seenIds.add(evidenceId);
    if (!clean(item.source_view_key)) throw new Error(`evidence_${evidenceId}_source_view_key_required`);
    sha256(item.source_sha256, `evidence_${evidenceId}_source_sha256`);
    const itemConfidence = confidence(item.confidence, `evidence_${evidenceId}_confidence`);
    const text = clean(item.text);
    if (hasDimension(text)) dimensionEvidenceIds.push(evidenceId);
    const shapes = explicitShapes(text);

    if (!isDispositiveKind(item.kind)) {
      nonDispositiveEvidence.push({ evidence_id: evidenceId, reason: `${item.kind}_cannot_identify_route_profile` });
      continue;
    }
    if (item.association === "unassociated") {
      nonDispositiveEvidence.push({ evidence_id: evidenceId, reason: "evidence_not_associated_with_route" });
      continue;
    }
    if (itemConfidence < minimumConfidence) {
      nonDispositiveEvidence.push({ evidence_id: evidenceId, reason: "evidence_below_dispositive_confidence" });
      continue;
    }
    if (shapes.length === 0) {
      nonDispositiveEvidence.push({ evidence_id: evidenceId, reason: "no_explicit_profile_claim" });
      continue;
    }
    dispositiveEvidenceIds.push(evidenceId);
    for (const shape of shapes) inferredShapes.add(shape);
  }

  const blockers: string[] = [];
  let status: RouteProfileSourceEvidenceGateReceiptV1["status"] = "deferred";
  if (inferredShapes.size > 1) {
    status = "rejected";
    blockers.push("conflicting_explicit_route_profile_claims");
  } else if (inferredShapes.size === 1 && !inferredShapes.has(requestedShape)) {
    status = "rejected";
    blockers.push("requested_profile_conflicts_with_source_evidence");
  } else if (inferredShapes.size === 0) {
    blockers.push(requestedShape === "round"
      ? "round_profile_requires_direct_diameter_or_round_evidence"
      : "rectangular_and_oval_are_ambiguous_from_width_height_alone");
  } else if (dimensionEvidenceIds.length === 0) {
    blockers.push("requested_profile_size_lacks_source_dimension_evidence");
  } else {
    status = "accepted";
  }

  return {
    schema_version: 1,
    artifact_role: "route_profile_source_evidence_gate",
    package_id: packageId,
    primitive_id: primitiveId,
    input_fingerprint_sha256: digest(input),
    status,
    requested_shape: requestedShape,
    requested_size: requestedSize,
    inferred_shapes: [...inferredShapes].sort(),
    dispositive_evidence_ids: dispositiveEvidenceIds,
    dimension_evidence_ids: dimensionEvidenceIds,
    non_dispositive_evidence: nonDispositiveEvidence,
    blockers,
    native_write_allowed: status === "accepted"
  };
}
