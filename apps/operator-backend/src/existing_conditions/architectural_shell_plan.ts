import crypto from "node:crypto";
import {
  solveExistingConditionsRegistration,
  transformExistingConditionsPlanPoint,
  type ExistingConditionsPlanPoint,
  type ExistingConditionsRegistrationInput,
  type ExistingConditionsRegistrationReceipt
} from "./registration.js";
import type {
  ExistingConditionsAmbiguity,
  ExistingConditionsPlanElement,
  ExistingConditionsSourceObservation
} from "./controller.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonMap = { [key: string]: JsonValue };

type ArchitecturalObservationBase = {
  observation_id: string;
  evidence_role?: string;
  visibility: "clear" | "partial" | "occluded";
  confidence: number;
  supported_attributes: string[];
};

export type ArchitecturalWallObservation = ArchitecturalObservationBase & {
  kind: "wall";
  discipline: "architectural";
  points: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint];
  wall_type_name: string;
  thickness_ft: number;
  height_ft: number;
};

export type ArchitecturalOpeningObservation = ArchitecturalObservationBase & {
  kind: "door" | "window";
  discipline: "architectural";
  point: ExistingConditionsPlanPoint;
  host_wall_observation_id: string;
  family_name: string;
  type_name: string;
  width_ft: number;
  height_ft: number;
  sill_height_ft?: number;
};

export type ArchitecturalShellObservation = ArchitecturalWallObservation | ArchitecturalOpeningObservation;

export type ArchitecturalShellPackage = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  source_evidence_sha256: string;
  visible_evidence: Array<{ role: string; sha256: string }>;
  registration: ExistingConditionsRegistrationInput;
  level_name: string;
  level_elevation_ft: number;
  material_confidence_threshold?: number;
  maximum_opening_host_distance_ft?: number;
  maximum_created_elements: number;
  observations: ArchitecturalShellObservation[];
};

export type ArchitecturalWallJunction = {
  a_wall_observation_id: string;
  b_wall_observation_id: string;
};

export type CompiledArchitecturalShellPlan = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  status: "ready" | "clarification_required" | "blocked";
  registration: ExistingConditionsRegistrationReceipt;
  input_fingerprint_sha256: string;
  source_observations: ExistingConditionsSourceObservation[];
  plan_elements: ExistingConditionsPlanElement[];
  wall_junctions: ArchitecturalWallJunction[];
  ambiguities: ExistingConditionsAmbiguity[];
  clarification_question: string | null;
  blockers: string[];
  warnings: string[];
  action: {
    method: "POST";
    path: "/revit/import-zippybim-geometry";
    dry_run_body: JsonMap;
    apply_body: JsonMap;
  } | null;
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
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label}_must_be_finite`);
  return parsed;
}

function positive(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) throw new Error(`${label}_must_be_positive`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = positive(value, label);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label}_must_be_a_positive_integer`);
  return parsed;
}

function requiredSha256(value: unknown, label: string): string {
  const text = cleanText(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label}_must_be_sha256`);
  return text;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function fingerprint(input: ArchitecturalShellPackage): string {
  return crypto.createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalized).filter(Boolean))];
}

function pointDistance2d(a: ExistingConditionsPlanPoint, b: ExistingConditionsPlanPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function projectPointToSegment(
  point: ExistingConditionsPlanPoint,
  segment: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint]
): { point: ExistingConditionsPlanPoint; distance_ft: number; chainage_ft: number; length_ft: number } {
  const [a, b] = segment;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) throw new Error("wall_segment_is_degenerate");
  const length = Math.sqrt(lengthSquared);
  const unclamped = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, unclamped));
  const projected = { x: a.x + t * dx, y: a.y + t * dy };
  return {
    point: projected,
    distance_ft: pointDistance2d(point, projected),
    chainage_ft: t * length,
    length_ft: length
  };
}

function pointToSegmentDistance2d(
  point: ExistingConditionsPlanPoint,
  segment: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint]
): number {
  return projectPointToSegment(point, segment).distance_ft;
}

function segmentsMeet2d(
  a: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint],
  b: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint],
  toleranceFt: number
): boolean {
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
  return Math.min(
    pointToSegmentDistance2d(a[0], b),
    pointToSegmentDistance2d(a[1], b),
    pointToSegmentDistance2d(b[0], a),
    pointToSegmentDistance2d(b[1], a)
  ) <= toleranceFt;
}

function materialAttributes(observation: ArchitecturalShellObservation): string[] {
  if (observation.kind === "wall") return ["location", "type", "thickness", "height"];
  if (observation.kind === "window") return ["location", "type", "host", "width", "height", "sill height"];
  return ["location", "type", "host", "width", "height"];
}

function clarificationQuestion(ambiguities: ExistingConditionsAmbiguity[]): string | null {
  if (ambiguities.length === 0) return null;
  const topics = ambiguities.map((entry) => entry.topic).join("; ");
  return `Before drafting the architectural shell, confirm the unresolved material evidence for: ${topics}.`;
}

function validateObservation(observation: ArchitecturalShellObservation, index: number): void {
  const id = requiredText(observation.observation_id, `observation_${index}_id`);
  if (observation.discipline !== "architectural") throw new Error(`${id}_discipline_must_be_architectural`);
  if (!Array.isArray(observation.supported_attributes)) throw new Error(`${id}_supported_attributes_must_be_array`);
  if (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) {
    throw new Error(`${id}_confidence_must_be_between_zero_and_one`);
  }
  if (!["clear", "partial", "occluded"].includes(observation.visibility)) throw new Error(`${id}_visibility_is_invalid`);
  if (observation.kind === "wall") {
    if (!Array.isArray(observation.points) || observation.points.length !== 2) throw new Error(`${id}_requires_two_points`);
    observation.points.forEach((point, pointIndex) => {
      finite(point.x, `${id}_point_${pointIndex}_x`);
      finite(point.y, `${id}_point_${pointIndex}_y`);
    });
    if (pointDistance2d(observation.points[0], observation.points[1]) <= 1e-6) throw new Error(`${id}_wall_is_degenerate`);
    requiredText(observation.wall_type_name, `${id}_wall_type_name`);
    positive(observation.thickness_ft, `${id}_thickness_ft`);
    positive(observation.height_ft, `${id}_height_ft`);
    return;
  }
  finite(observation.point.x, `${id}_point_x`);
  finite(observation.point.y, `${id}_point_y`);
  requiredText(observation.host_wall_observation_id, `${id}_host_wall_observation_id`);
  requiredText(observation.family_name, `${id}_family_name`);
  requiredText(observation.type_name, `${id}_type_name`);
  positive(observation.width_ft, `${id}_width_ft`);
  positive(observation.height_ft, `${id}_height_ft`);
  if (observation.kind === "window") finite(observation.sill_height_ft, `${id}_sill_height_ft`);
}

export function compileArchitecturalShellPlan(input: ArchitecturalShellPackage): CompiledArchitecturalShellPlan {
  if (input.schema_version !== 1) throw new Error("unsupported_architectural_shell_package_schema_version");
  const fixtureId = requiredText(input.fixture_id, "fixture_id");
  const scopeId = requiredText(input.scope_id, "scope_id");
  const levelName = requiredText(input.level_name, "level_name");
  const levelElevationFt = finite(input.level_elevation_ft, "level_elevation_ft");
  const maximumCreatedElements = positiveInteger(input.maximum_created_elements, "maximum_created_elements");
  const maximumOpeningHostDistanceFt = positive(input.maximum_opening_host_distance_ft ?? 0.5, "maximum_opening_host_distance_ft");
  const sourceEvidenceSha256 = requiredSha256(input.source_evidence_sha256, "source_evidence_sha256");
  if (!Array.isArray(input.visible_evidence) || input.visible_evidence.length === 0) throw new Error("visible_evidence_is_required");
  const visibleEvidence = input.visible_evidence.map((entry, index) => ({
    role: requiredText(entry.role, `visible_evidence_${index}_role`),
    sha256: requiredSha256(entry.sha256, `visible_evidence_${index}_sha256`)
  }));
  if (!visibleEvidence.some((entry) => normalized(entry.role) === "source pdf" && entry.sha256 === sourceEvidenceSha256)) {
    throw new Error("source_evidence_hash_is_not_bound_to_visible_source_pdf");
  }
  if (!Array.isArray(input.observations) || input.observations.length === 0) throw new Error("architectural_observations_are_required");
  input.observations.forEach(validateObservation);
  const ids = input.observations.map((entry) => entry.observation_id);
  if (new Set(ids).size !== ids.length) throw new Error("architectural_observation_ids_must_be_unique");
  if (input.observations.length > maximumCreatedElements) throw new Error("architectural_observations_exceed_maximum_created_elements");

  const registration = solveExistingConditionsRegistration(input.registration);
  if (registration.source_evidence_sha256 !== sourceEvidenceSha256) throw new Error("registration_source_hash_mismatch");
  const threshold = input.material_confidence_threshold ?? 0.85;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("material_confidence_threshold_must_be_between_zero_and_one");

  const walls = new Map<string, { observation: ArchitecturalWallObservation; transformed: [ExistingConditionsPlanPoint, ExistingConditionsPlanPoint] }>();
  for (const observation of input.observations) {
    if (observation.kind !== "wall") continue;
    walls.set(observation.observation_id, {
      observation,
      transformed: [
        transformExistingConditionsPlanPoint(registration, observation.points[0]),
        transformExistingConditionsPlanPoint(registration, observation.points[1])
      ]
    });
  }
  if (walls.size === 0) throw new Error("architectural_shell_requires_at_least_one_wall");

  const openingPlacements = new Map<string, { point: ExistingConditionsPlanPoint; chainage_ft: number; host: string }>();
  const occupiedIntervals = new Map<string, Array<{ id: string; min: number; max: number }>>();
  for (const observation of input.observations) {
    if (observation.kind === "wall") continue;
    const host = walls.get(observation.host_wall_observation_id);
    if (!host) throw new Error(`${observation.observation_id}_references_unknown_host_wall:${observation.host_wall_observation_id}`);
    const transformedPoint = transformExistingConditionsPlanPoint(registration, observation.point);
    const projected = projectPointToSegment(transformedPoint, host.transformed);
    if (projected.distance_ft > maximumOpeningHostDistanceFt) {
      throw new Error(`${observation.observation_id}_opening_is_not_on_host_wall:${projected.distance_ft.toFixed(6)}`);
    }
    const halfWidth = observation.width_ft / 2;
    if (projected.chainage_ft < halfWidth || projected.chainage_ft > projected.length_ft - halfWidth) {
      throw new Error(`${observation.observation_id}_opening_does_not_fit_inside_host_wall`);
    }
    const interval = { id: observation.observation_id, min: projected.chainage_ft - halfWidth, max: projected.chainage_ft + halfWidth };
    const occupied = occupiedIntervals.get(observation.host_wall_observation_id) ?? [];
    const overlap = occupied.find((entry) => Math.min(entry.max, interval.max) - Math.max(entry.min, interval.min) > 1e-6);
    if (overlap) throw new Error(`architectural_openings_overlap:${overlap.id}:${observation.observation_id}`);
    occupied.push(interval);
    occupiedIntervals.set(observation.host_wall_observation_id, occupied);
    openingPlacements.set(observation.observation_id, {
      point: projected.point,
      chainage_ft: projected.chainage_ft,
      host: observation.host_wall_observation_id
    });
  }

  const sourceObservations: ExistingConditionsSourceObservation[] = [];
  const planElements: ExistingConditionsPlanElement[] = [];
  const ambiguities: ExistingConditionsAmbiguity[] = [];
  for (const observation of input.observations) {
    const requiredAttributes = materialAttributes(observation);
    const supported = unique(observation.supported_attributes);
    const missing = requiredAttributes.filter((attribute) => !supported.includes(normalized(attribute)));
    const visibilityFactor = observation.visibility === "clear" ? 1 : observation.visibility === "partial" ? 0.8 : 0.55;
    const effectiveConfidence = observation.confidence * visibilityFactor;
    sourceObservations.push({
      observation_id: observation.observation_id,
      evidence_role: observation.evidence_role ?? "source_pdf",
      discipline: "architectural",
      category: observation.kind === "wall" ? "OST_Walls" : observation.kind === "door" ? "OST_Doors" : "OST_Windows",
      role: observation.kind,
      visibility: observation.visibility,
      confidence: observation.confidence,
      supported_attributes: supported
    });
    planElements.push({
      plan_key: observation.observation_id,
      discipline: "architectural",
      category: observation.kind === "wall" ? "OST_Walls" : observation.kind === "door" ? "OST_Doors" : "OST_Windows",
      role: observation.kind,
      action: "create",
      confidence: effectiveConfidence,
      assumptions: [],
      source_observation_ids: [observation.observation_id],
      required_source_attributes: requiredAttributes
    });
    if (effectiveConfidence < threshold || missing.length > 0) {
      ambiguities.push({
        id: `clarify:${observation.observation_id}`,
        topic: `${observation.kind} ${observation.observation_id}`,
        description: [
          ...(effectiveConfidence < threshold ? [`effective confidence ${effectiveConfidence.toFixed(3)} is below ${threshold.toFixed(3)}`] : []),
          ...(missing.length > 0 ? [`source does not support ${missing.join(", ")}`] : [])
        ].join("; "),
        material: true,
        confidence: effectiveConfidence,
        choices: [],
        related_plan_keys: [observation.observation_id],
        material_attributes: missing,
        resolution: null,
        resolution_basis: null,
        resolution_evidence_reference: null
      });
    }
  }

  const transformedWalls = [...walls.values()];
  const wallJunctions: ArchitecturalWallJunction[] = [];
  for (let i = 0; i < transformedWalls.length; i += 1) {
    for (let j = i + 1; j < transformedWalls.length; j += 1) {
      const a = transformedWalls[i]!;
      const b = transformedWalls[j]!;
      if (segmentsMeet2d(a.transformed, b.transformed, 0.25)) {
        wallJunctions.push({
          a_wall_observation_id: a.observation.observation_id,
          b_wall_observation_id: b.observation.observation_id
        });
      }
    }
  }

  const blockers = registration.verified ? [] : [
    `registration_error_exceeds_limit:rms=${registration.rms_error_ft.toFixed(6)}:max=${registration.maximum_error_ft.toFixed(6)}`
  ];
  const warnings: string[] = [];
  if (!registration.verified) warnings.push("No architectural write plan was emitted because source-to-model registration is not verified.");
  if (ambiguities.length > 0) warnings.push("Material architectural ambiguities must be resolved before dry-run or apply.");

  let action: CompiledArchitecturalShellPlan["action"] = null;
  if (blockers.length === 0 && ambiguities.length === 0) {
    const elements: JsonMap[] = input.observations.map((observation) => {
      if (observation.kind === "wall") {
        const transformed = walls.get(observation.observation_id)!.transformed;
        return {
          id: observation.observation_id,
          element: "wall",
          path: transformed.map((point) => [point.x, point.y]),
          thickness: observation.thickness_ft,
          height: observation.height_ft,
          typeName: observation.wall_type_name
        } satisfies JsonMap;
      }
      const placement = openingPlacements.get(observation.observation_id)!;
      const opening: JsonMap = {
        id: observation.observation_id,
        element: observation.kind,
        position: [placement.point.x, placement.point.y],
        width: observation.width_ft,
        height: observation.height_ft,
        familyName: observation.family_name,
        typeName: observation.type_name,
        hostWallId: observation.host_wall_observation_id,
        chainageFt: placement.chainage_ft
      };
      if (observation.kind === "window") opening.sillHeight = observation.sill_height_ft ?? 0;
      return opening;
    });
    const common: JsonMap = {
      geometry: {
        metadata: {
          source: "existing_conditions_architectural_shell_compiler",
          units: "feet",
          inputFingerprintSha256: fingerprint(input)
        },
        elements
      },
      levelName,
      levelElevationFt,
      importWalls: true,
      importDoors: input.observations.some((entry) => entry.kind === "door"),
      importWindows: input.observations.some((entry) => entry.kind === "window"),
      normalizeWallGeometry: false,
      requireExactWallTypes: true,
      requireExactOpeningTypes: true,
      requireSourceWallHosts: true,
      requireAllElements: true,
      maximumCreatedElements,
      maximumOpeningHostDistanceFeet: maximumOpeningHostDistanceFt,
      disableWallJoins: false
    };
    action = {
      method: "POST",
      path: "/revit/import-zippybim-geometry",
      dry_run_body: { ...common, dryRun: true },
      apply_body: { ...common, dryRun: false }
    };
  }

  return {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    status: blockers.length > 0 ? "blocked" : ambiguities.length > 0 ? "clarification_required" : "ready",
    registration,
    input_fingerprint_sha256: fingerprint(input),
    source_observations: sourceObservations,
    plan_elements: planElements,
    wall_junctions: wallJunctions,
    ambiguities,
    clarification_question: clarificationQuestion(ambiguities),
    blockers,
    warnings,
    action
  };
}
