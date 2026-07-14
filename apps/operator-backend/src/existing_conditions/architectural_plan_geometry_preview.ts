import crypto from "node:crypto";
import {
  compileArchitecturalShellPlan,
  type ArchitecturalOpeningObservation,
  type ArchitecturalShellObservation,
  type ArchitecturalShellPackage,
  type ArchitecturalWallJunction,
  type ArchitecturalWallObservation,
  type CompiledArchitecturalShellPlan
} from "./architectural_shell_plan.js";
import {
  solveExistingConditionsRegistration,
  transformExistingConditionsPlanPoint,
  type ExistingConditionsPlanPoint,
  type ExistingConditionsRegistrationInput,
  type ExistingConditionsRegistrationReceipt
} from "./registration.js";
import type { ExistingConditionsAmbiguity, ExistingConditionsSourceObservation } from "./controller.js";

type PreviewValue = string | number;
type ArchitecturalMaterialAttribute = "family" | "type" | "thickness" | "width" | "height" | "sill height";
type ArchitecturalResolutionBasis = "user_direction" | "project_precedent" | "legible_source_evidence";

type ArchitecturalPreviewObservationBase = {
  observation_id: string;
  evidence_role?: string;
  visibility: "clear" | "partial" | "occluded";
  confidence: number;
  supported_attributes: string[];
};

export type ArchitecturalPlanGeometryWallObservation = ArchitecturalPreviewObservationBase & {
  kind: "wall";
  discipline: "architectural";
  points: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint];
  wall_type_name?: string;
  thickness_ft?: number;
  height_ft?: number;
};

export type ArchitecturalPlanGeometryOpeningObservation = ArchitecturalPreviewObservationBase & {
  kind: "door" | "window";
  discipline: "architectural";
  point: ExistingConditionsPlanPoint;
  host_wall_observation_id: string;
  family_name?: string;
  type_name?: string;
  width_ft?: number;
  height_ft?: number;
  sill_height_ft?: number;
};

export type ArchitecturalPlanGeometryObservation =
  | ArchitecturalPlanGeometryWallObservation
  | ArchitecturalPlanGeometryOpeningObservation;

export type ArchitecturalPlanGeometryPreviewPackage = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  source_evidence_sha256: string;
  visible_evidence: Array<{ role: string; sha256: string }>;
  registration: ExistingConditionsRegistrationInput;
  level_name: string;
  level_elevation_ft: number;
  geometry_confidence_threshold?: number;
  material_confidence_threshold?: number;
  maximum_opening_host_distance_ft?: number;
  maximum_created_elements: number;
  observations: ArchitecturalPlanGeometryObservation[];
};

export type ArchitecturalPlanGeometryPreviewElement = {
  plan_key: string;
  kind: "wall" | "door" | "window";
  category: "OST_Walls" | "OST_Doors" | "OST_Windows";
  source_observation_id: string;
  effective_confidence: number;
  geometry_grounded: boolean;
  geometry: {
    points?: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint];
    point?: ExistingConditionsPlanPoint;
    host_wall_observation_id?: string;
    chainage_ft?: number;
  };
  resolved_attributes: Partial<Record<ArchitecturalMaterialAttribute, PreviewValue>>;
  unresolved_attributes: ArchitecturalMaterialAttribute[];
  native_write_eligible: false;
};

export type CompiledArchitecturalPlanGeometryPreview = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  status: "preview_ready" | "clarification_required" | "blocked";
  registration: ExistingConditionsRegistrationReceipt;
  input_fingerprint_sha256: string;
  source_observations: ExistingConditionsSourceObservation[];
  preview_elements: ArchitecturalPlanGeometryPreviewElement[];
  wall_junctions: ArchitecturalWallJunction[];
  geometry_ambiguities: ExistingConditionsAmbiguity[];
  promotion_ambiguities: ExistingConditionsAmbiguity[];
  clarification_question: string | null;
  promotion_question: string | null;
  blockers: string[];
  warnings: string[];
  native_action: null;
};

export type ArchitecturalAttributeResolution = {
  attribute: ArchitecturalMaterialAttribute;
  value: PreviewValue;
  basis: ArchitecturalResolutionBasis;
  evidence_reference: string;
};

export type ArchitecturalPlanGeometryResolution = {
  observation_id: string;
  attributes: ArchitecturalAttributeResolution[];
};

export type ArchitecturalPromotionReceipt = {
  observation_id: string;
  attribute: ArchitecturalMaterialAttribute;
  value: PreviewValue;
  basis: ArchitecturalResolutionBasis;
  evidence_reference: string;
};

export type PromotedArchitecturalPlanGeometry = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  preview_fingerprint_sha256: string;
  promotion_fingerprint_sha256: string;
  resolution_receipts: ArchitecturalPromotionReceipt[];
  exact_package: ArchitecturalShellPackage;
  compiled_plan: CompiledArchitecturalShellPlan;
};

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return cleanText(value).toLowerCase().replace(/[\s_-]+/g, " ");
}

function requiredText(value: unknown, label: string): string {
  const text = cleanText(value);
  if (!text) throw new Error(`${label}_is_required`);
  return text;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function positive(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) throw new Error(`${label}_must_be_positive`);
  return parsed;
}

function nonnegative(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed < 0) throw new Error(`${label}_must_be_nonnegative`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = positive(value, label);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label}_must_be_a_positive_integer`);
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const text = normalized(value).replace(/ /g, "");
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label}_must_be_sha256`);
  return text;
}

function threshold(value: unknown, fallback: number, label: string): number {
  const parsed = value == null ? fallback : finite(value, label);
  if (parsed < 0 || parsed > 1) throw new Error(`${label}_must_be_between_zero_and_one`);
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function point(value: ExistingConditionsPlanPoint, label: string): ExistingConditionsPlanPoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  return { x: finite(value.x, `${label}_x`), y: finite(value.y, `${label}_y`) };
}

function distance2d(a: ExistingConditionsPlanPoint, b: ExistingConditionsPlanPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function projectPointToSegment(
  target: ExistingConditionsPlanPoint,
  segment: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint]
): { point: ExistingConditionsPlanPoint; distance_ft: number; chainage_ft: number } {
  const [a, b] = segment;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) throw new Error("preview_wall_segment_is_degenerate");
  const length = Math.sqrt(lengthSquared);
  const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSquared));
  const projected = { x: a.x + t * dx, y: a.y + t * dy };
  return { point: projected, distance_ft: distance2d(target, projected), chainage_ft: t * length };
}

function segmentsMeet2d(
  a: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint],
  b: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint],
  toleranceFt: number
): boolean {
  const candidates = [
    projectPointToSegment(a[0], b).distance_ft,
    projectPointToSegment(a[1], b).distance_ft,
    projectPointToSegment(b[0], a).distance_ft,
    projectPointToSegment(b[1], a).distance_ft
  ];
  const ax = a[1].x - a[0].x;
  const ay = a[1].y - a[0].y;
  const bx = b[1].x - b[0].x;
  const by = b[1].y - b[0].y;
  const denominator = ax * by - ay * bx;
  if (Math.abs(denominator) > Number.EPSILON) {
    const dx = b[0].x - a[0].x;
    const dy = b[0].y - a[0].y;
    const t = (dx * by - dy * bx) / denominator;
    const u = (dx * ay - dy * ax) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
  }
  return Math.min(...candidates) <= toleranceFt;
}

function category(kind: ArchitecturalPlanGeometryObservation["kind"]): "OST_Walls" | "OST_Doors" | "OST_Windows" {
  return kind === "wall" ? "OST_Walls" : kind === "door" ? "OST_Doors" : "OST_Windows";
}

function geometryAttributes(observation: ArchitecturalPlanGeometryObservation): string[] {
  return observation.kind === "wall" ? ["location"] : ["location", "host"];
}

function materialAttributes(observation: ArchitecturalPlanGeometryObservation): ArchitecturalMaterialAttribute[] {
  if (observation.kind === "wall") return ["type", "thickness", "height"];
  if (observation.kind === "window") return ["family", "type", "width", "height", "sill height"];
  return ["family", "type", "width", "height"];
}

function materialValue(
  observation: ArchitecturalPlanGeometryObservation,
  attribute: ArchitecturalMaterialAttribute
): PreviewValue | undefined {
  if (observation.kind === "wall") {
    if (attribute === "type") return observation.wall_type_name;
    if (attribute === "thickness") return observation.thickness_ft;
    if (attribute === "height") return observation.height_ft;
    return undefined;
  }
  if (attribute === "family") return observation.family_name;
  if (attribute === "type") return observation.type_name;
  if (attribute === "width") return observation.width_ft;
  if (attribute === "height") return observation.height_ft;
  if (attribute === "sill height" && observation.kind === "window") return observation.sill_height_ft;
  return undefined;
}

function validateMaterialValue(attribute: ArchitecturalMaterialAttribute, value: PreviewValue, label: string): PreviewValue {
  if (attribute === "family" || attribute === "type") return requiredText(value, label);
  return attribute === "sill height" ? nonnegative(value, label) : positive(value, label);
}

function validateObservation(observation: ArchitecturalPlanGeometryObservation, index: number): void {
  const id = requiredText(observation.observation_id, `observation_${index}_id`);
  if (observation.discipline !== "architectural") throw new Error(`${id}_discipline_must_be_architectural`);
  if (!Array.isArray(observation.supported_attributes)) throw new Error(`${id}_supported_attributes_must_be_array`);
  if (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) {
    throw new Error(`${id}_confidence_must_be_between_zero_and_one`);
  }
  if (!["clear", "partial", "occluded"].includes(observation.visibility)) throw new Error(`${id}_visibility_is_invalid`);
  const supported = new Set(observation.supported_attributes.map(normalized).filter(Boolean));
  if (observation.kind === "wall") {
    if (!Array.isArray(observation.points) || observation.points.length !== 2) throw new Error(`${id}_requires_two_points`);
    const points = observation.points.map((entry, pointIndex) => point(entry, `${id}_point_${pointIndex}`));
    if (distance2d(points[0]!, points[1]!) <= 1e-6) throw new Error(`${id}_wall_is_degenerate`);
  } else {
    point(observation.point, `${id}_point`);
    requiredText(observation.host_wall_observation_id, `${id}_host_wall_observation_id`);
  }
  for (const attribute of materialAttributes(observation)) {
    const value = materialValue(observation, attribute);
    if (supported.has(attribute) && value === undefined) throw new Error(`${id}_${normalized(attribute).replace(/ /g, "_")}_supported_without_value`);
    if (!supported.has(attribute) && value !== undefined) throw new Error(`${id}_${normalized(attribute).replace(/ /g, "_")}_value_is_not_source_supported`);
    if (value !== undefined) validateMaterialValue(attribute, value, `${id}_${normalized(attribute).replace(/ /g, "_")}`);
  }
}

function ambiguity(
  id: string,
  topic: string,
  description: string,
  confidence: number,
  planKey: string,
  attributes: string[]
): ExistingConditionsAmbiguity {
  return {
    id,
    topic,
    description,
    material: true,
    confidence,
    choices: [],
    related_plan_keys: [planKey],
    material_attributes: attributes,
    resolution: null,
    resolution_basis: null,
    resolution_evidence_reference: null
  };
}

function question(prefix: string, entries: ExistingConditionsAmbiguity[]): string | null {
  if (entries.length === 0) return null;
  return `${prefix}: ${entries.map((entry) => entry.topic).join("; ")}.`;
}

export function compileArchitecturalPlanGeometryPreview(
  input: ArchitecturalPlanGeometryPreviewPackage
): CompiledArchitecturalPlanGeometryPreview {
  if (input.schema_version !== 1) throw new Error("unsupported_architectural_plan_geometry_preview_schema_version");
  const fixtureId = requiredText(input.fixture_id, "fixture_id");
  const scopeId = requiredText(input.scope_id, "scope_id");
  requiredText(input.level_name, "level_name");
  finite(input.level_elevation_ft, "level_elevation_ft");
  const maximumCreatedElements = positiveInteger(input.maximum_created_elements, "maximum_created_elements");
  const maximumOpeningHostDistanceFt = positive(input.maximum_opening_host_distance_ft ?? 0.5, "maximum_opening_host_distance_ft");
  const geometryThreshold = threshold(input.geometry_confidence_threshold, 0.75, "geometry_confidence_threshold");
  const materialThreshold = threshold(input.material_confidence_threshold, 0.85, "material_confidence_threshold");
  const sourceHash = sha256(input.source_evidence_sha256, "source_evidence_sha256");
  if (!Array.isArray(input.visible_evidence) || input.visible_evidence.length === 0) throw new Error("visible_evidence_is_required");
  const visibleEvidence = input.visible_evidence.map((entry, index) => ({
    role: requiredText(entry.role, `visible_evidence_${index}_role`),
    sha256: sha256(entry.sha256, `visible_evidence_${index}_sha256`)
  }));
  if (!visibleEvidence.some((entry) => normalized(entry.role) === "source pdf" && entry.sha256 === sourceHash)) {
    throw new Error("source_evidence_hash_is_not_bound_to_visible_source_pdf");
  }
  if (!Array.isArray(input.observations) || input.observations.length === 0) throw new Error("architectural_preview_observations_are_required");
  if (input.observations.length > maximumCreatedElements) throw new Error("architectural_preview_observations_exceed_maximum_created_elements");
  input.observations.forEach(validateObservation);
  const observationIds = input.observations.map((entry) => entry.observation_id);
  if (new Set(observationIds).size !== observationIds.length) throw new Error("architectural_preview_observation_ids_must_be_unique");

  const registration = solveExistingConditionsRegistration(input.registration);
  if (registration.source_evidence_sha256 !== sourceHash) throw new Error("registration_source_hash_mismatch");
  const sourceObservations: ExistingConditionsSourceObservation[] = [];
  const previewElements: ArchitecturalPlanGeometryPreviewElement[] = [];
  const geometryAmbiguities: ExistingConditionsAmbiguity[] = [];
  const promotionAmbiguities: ExistingConditionsAmbiguity[] = [];
  const transformedWalls = new Map<string, [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint]>();

  for (const observation of input.observations) {
    if (observation.kind !== "wall") continue;
    transformedWalls.set(observation.observation_id, [
      transformExistingConditionsPlanPoint(registration, observation.points[0]),
      transformExistingConditionsPlanPoint(registration, observation.points[1])
    ]);
  }
  if (transformedWalls.size === 0) throw new Error("architectural_preview_requires_at_least_one_wall");

  for (const observation of input.observations) {
    const supported = [...new Set(observation.supported_attributes.map(normalized).filter(Boolean))];
    const visibilityFactor = observation.visibility === "clear" ? 1 : observation.visibility === "partial" ? 0.8 : 0.55;
    const effectiveConfidence = observation.confidence * visibilityFactor;
    const missingGeometry = geometryAttributes(observation).filter((attribute) => !supported.includes(attribute));
    if (effectiveConfidence < geometryThreshold || missingGeometry.length > 0) {
      geometryAmbiguities.push(ambiguity(
        `preview-geometry:${observation.observation_id}`,
        `${observation.kind} ${observation.observation_id} plan geometry`,
        [
          ...(effectiveConfidence < geometryThreshold ? [`effective confidence ${effectiveConfidence.toFixed(3)} is below ${geometryThreshold.toFixed(3)}`] : []),
          ...(missingGeometry.length > 0 ? [`source does not support ${missingGeometry.join(", ")}`] : [])
        ].join("; "),
        effectiveConfidence,
        observation.observation_id,
        missingGeometry
      ));
    }

    const resolvedAttributes: Partial<Record<ArchitecturalMaterialAttribute, PreviewValue>> = {};
    const unresolvedAttributes: ArchitecturalMaterialAttribute[] = [];
    for (const attribute of materialAttributes(observation)) {
      const value = materialValue(observation, attribute);
      if (supported.includes(attribute) && value !== undefined && effectiveConfidence >= materialThreshold) {
        resolvedAttributes[attribute] = validateMaterialValue(attribute, value, `${observation.observation_id}_${attribute}`);
      } else {
        unresolvedAttributes.push(attribute);
      }
    }
    if (unresolvedAttributes.length > 0) {
      promotionAmbiguities.push(ambiguity(
        `preview-promotion:${observation.observation_id}`,
        `${observation.kind} ${observation.observation_id} material completion`,
        `native promotion requires evidence for ${unresolvedAttributes.join(", ")}`,
        effectiveConfidence,
        observation.observation_id,
        unresolvedAttributes
      ));
    }

    let geometry: ArchitecturalPlanGeometryPreviewElement["geometry"];
    if (observation.kind === "wall") {
      geometry = { points: transformedWalls.get(observation.observation_id)! };
    } else {
      const host = transformedWalls.get(observation.host_wall_observation_id);
      if (!host) throw new Error(`${observation.observation_id}_references_unknown_host_wall:${observation.host_wall_observation_id}`);
      const transformedPoint = transformExistingConditionsPlanPoint(registration, observation.point);
      const projected = projectPointToSegment(transformedPoint, host);
      if (projected.distance_ft > maximumOpeningHostDistanceFt) {
        throw new Error(`${observation.observation_id}_opening_is_not_on_host_wall:${projected.distance_ft.toFixed(6)}`);
      }
      geometry = {
        point: projected.point,
        host_wall_observation_id: observation.host_wall_observation_id,
        chainage_ft: projected.chainage_ft
      };
    }

    sourceObservations.push({
      observation_id: observation.observation_id,
      evidence_role: observation.evidence_role ?? "source_pdf",
      discipline: "architectural",
      category: category(observation.kind),
      role: observation.kind,
      visibility: observation.visibility,
      confidence: observation.confidence,
      supported_attributes: supported
    });
    previewElements.push({
      plan_key: observation.observation_id,
      kind: observation.kind,
      category: category(observation.kind),
      source_observation_id: observation.observation_id,
      effective_confidence: effectiveConfidence,
      geometry_grounded: registration.verified && effectiveConfidence >= geometryThreshold && missingGeometry.length === 0,
      geometry,
      resolved_attributes: resolvedAttributes,
      unresolved_attributes: unresolvedAttributes,
      native_write_eligible: false
    });
  }

  const walls = [...transformedWalls.entries()];
  const wallJunctions: ArchitecturalWallJunction[] = [];
  for (let i = 0; i < walls.length; i += 1) {
    for (let j = i + 1; j < walls.length; j += 1) {
      if (segmentsMeet2d(walls[i]![1], walls[j]![1], 0.25)) {
        wallJunctions.push({ a_wall_observation_id: walls[i]![0], b_wall_observation_id: walls[j]![0] });
      }
    }
  }

  const blockers = registration.verified ? [] : [
    `registration_error_exceeds_limit:rms=${registration.rms_error_ft.toFixed(6)}:max=${registration.maximum_error_ft.toFixed(6)}`
  ];
  const warnings = [
    "Plan-geometry preview is non-writing; unresolved material and vertical attributes cannot be defaulted into Revit actions.",
    ...(promotionAmbiguities.length > 0 ? ["Evidence-backed promotion is required before native dry-run or apply."] : []),
    ...(blockers.length > 0 ? ["Preview coordinates are blocked because source-to-model registration is not verified."] : [])
  ];
  return {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    status: blockers.length > 0 ? "blocked" : geometryAmbiguities.length > 0 ? "clarification_required" : "preview_ready",
    registration,
    input_fingerprint_sha256: fingerprint(input),
    source_observations: sourceObservations,
    preview_elements: previewElements,
    wall_junctions: wallJunctions,
    geometry_ambiguities: geometryAmbiguities,
    promotion_ambiguities: promotionAmbiguities,
    clarification_question: question("Before showing a registered plan-geometry preview, confirm", geometryAmbiguities),
    promotion_question: question("Before native architectural drafting, provide evidence-backed values for", promotionAmbiguities),
    blockers,
    warnings,
    native_action: null
  };
}

function resolutionMap(
  input: ArchitecturalPlanGeometryPreviewPackage,
  resolutions: ArchitecturalPlanGeometryResolution[]
): Map<string, Map<ArchitecturalMaterialAttribute, ArchitecturalAttributeResolution>> {
  if (!Array.isArray(resolutions)) throw new Error("architectural_promotion_resolutions_must_be_array");
  const observationById = new Map(input.observations.map((entry) => [entry.observation_id, entry]));
  const result = new Map<string, Map<ArchitecturalMaterialAttribute, ArchitecturalAttributeResolution>>();
  for (const entry of resolutions) {
    const observationId = requiredText(entry.observation_id, "promotion_resolution_observation_id");
    const observation = observationById.get(observationId);
    if (!observation) throw new Error(`promotion_resolution_references_unknown_observation:${observationId}`);
    if (result.has(observationId)) throw new Error(`duplicate_promotion_resolution_observation:${observationId}`);
    if (!Array.isArray(entry.attributes)) throw new Error(`${observationId}_promotion_attributes_must_be_array`);
    const applicable = new Set(materialAttributes(observation));
    const attributes = new Map<ArchitecturalMaterialAttribute, ArchitecturalAttributeResolution>();
    for (const resolution of entry.attributes) {
      const attribute = normalized(resolution.attribute) as ArchitecturalMaterialAttribute;
      if (!applicable.has(attribute)) throw new Error(`${observationId}_promotion_attribute_is_not_applicable:${attribute}`);
      if (attributes.has(attribute)) throw new Error(`${observationId}_duplicate_promotion_attribute:${attribute}`);
      if (!["user_direction", "project_precedent", "legible_source_evidence"].includes(resolution.basis)) {
        throw new Error(`${observationId}_${attribute}_promotion_basis_is_invalid`);
      }
      const evidenceReference = requiredText(resolution.evidence_reference, `${observationId}_${attribute}_evidence_reference`);
      attributes.set(attribute, {
        attribute,
        value: validateMaterialValue(attribute, resolution.value, `${observationId}_${attribute}_resolution`),
        basis: resolution.basis,
        evidence_reference: evidenceReference
      });
    }
    result.set(observationId, attributes);
  }
  return result;
}

export function promoteArchitecturalPlanGeometryPreview(
  input: ArchitecturalPlanGeometryPreviewPackage,
  resolutions: ArchitecturalPlanGeometryResolution[]
): PromotedArchitecturalPlanGeometry {
  const preview = compileArchitecturalPlanGeometryPreview(input);
  if (preview.status !== "preview_ready") throw new Error(`architectural_preview_is_not_promotable:${preview.status}`);
  const byObservation = resolutionMap(input, resolutions);
  const receipts: ArchitecturalPromotionReceipt[] = [];
  const observations: ArchitecturalShellObservation[] = input.observations.map((observation, index) => {
    const previewElement = preview.preview_elements[index]!;
    const supplemental = byObservation.get(observation.observation_id) ?? new Map();
    const values = new Map<ArchitecturalMaterialAttribute, PreviewValue>();
    for (const attribute of materialAttributes(observation)) {
      const sourceValue = previewElement.resolved_attributes[attribute];
      const resolution = supplemental.get(attribute);
      if (sourceValue !== undefined && resolution) {
        throw new Error(`${observation.observation_id}_${attribute}_cannot_override_source_supported_value`);
      }
      if (sourceValue !== undefined) {
        values.set(attribute, sourceValue);
        receipts.push({
          observation_id: observation.observation_id,
          attribute,
          value: sourceValue,
          basis: "legible_source_evidence",
          evidence_reference: observation.evidence_role ?? "source_pdf"
        });
      } else if (resolution) {
        values.set(attribute, resolution.value);
        receipts.push({
          observation_id: observation.observation_id,
          attribute,
          value: resolution.value,
          basis: resolution.basis,
          evidence_reference: resolution.evidence_reference
        });
      } else {
        throw new Error(`${observation.observation_id}_promotion_missing_attribute:${attribute}`);
      }
    }
    for (const attribute of supplemental.keys()) {
      if (!values.has(attribute)) throw new Error(`${observation.observation_id}_unused_promotion_attribute:${attribute}`);
    }
    const supportedAttributes = [...new Set([...geometryAttributes(observation), ...materialAttributes(observation)])];
    if (observation.kind === "wall") {
      return {
        ...observation,
        supported_attributes: supportedAttributes,
        wall_type_name: String(values.get("type")),
        thickness_ft: Number(values.get("thickness")),
        height_ft: Number(values.get("height"))
      } satisfies ArchitecturalWallObservation;
    }
    const opening = {
      ...observation,
      supported_attributes: supportedAttributes,
      family_name: String(values.get("family")),
      type_name: String(values.get("type")),
      width_ft: Number(values.get("width")),
      height_ft: Number(values.get("height"))
    };
    if (observation.kind === "window") {
      return { ...opening, kind: "window", sill_height_ft: Number(values.get("sill height")) } satisfies ArchitecturalOpeningObservation;
    }
    return { ...opening, kind: "door" } satisfies ArchitecturalOpeningObservation;
  });

  const exactPackage: ArchitecturalShellPackage = {
    schema_version: 1,
    fixture_id: input.fixture_id,
    scope_id: input.scope_id,
    source_evidence_sha256: input.source_evidence_sha256,
    visible_evidence: input.visible_evidence,
    registration: input.registration,
    level_name: input.level_name,
    level_elevation_ft: input.level_elevation_ft,
    material_confidence_threshold: input.material_confidence_threshold,
    maximum_opening_host_distance_ft: input.maximum_opening_host_distance_ft,
    maximum_created_elements: input.maximum_created_elements,
    observations
  };
  const compiledPlan = compileArchitecturalShellPlan(exactPackage);
  const promotionFingerprint = fingerprint({
    preview_fingerprint_sha256: preview.input_fingerprint_sha256,
    resolution_receipts: receipts
  });
  return {
    schema_version: 1,
    fixture_id: input.fixture_id,
    scope_id: input.scope_id,
    preview_fingerprint_sha256: preview.input_fingerprint_sha256,
    promotion_fingerprint_sha256: promotionFingerprint,
    resolution_receipts: receipts,
    exact_package: exactPackage,
    compiled_plan: compiledPlan
  };
}
