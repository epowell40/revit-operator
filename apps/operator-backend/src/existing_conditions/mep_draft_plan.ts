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

export type MepDraftVisibility = "clear" | "partial" | "occluded";

type MepDraftObservationBase = {
  observation_id: string;
  evidence_role?: string;
  visibility: MepDraftVisibility;
  confidence: number;
  supported_attributes: string[];
};

export type MepDraftPlacement =
  | {
      mode: "unhosted_family";
      family_name: string;
      type_name: string;
      rotation_degrees?: number;
    }
  | {
      mode: "hosted_exemplar";
      source_reference_key: string;
      host_reference_key: string;
      host_category: string;
      /** Optional wall-chainage override. Omit when the registered world point is the placement authority. */
      target_chainage_ft?: number;
      room_side?: string;
      match_orientation_from_source?: boolean;
    };

export type PlumbingPipeRouteObservation = MepDraftObservationBase & {
  kind: "pipe_route";
  discipline: "plumbing";
  service: "domestic_cold_water" | "domestic_hot_water" | "sanitary" | "vent";
  points: ExistingConditionsPlanPoint[];
  pipe_size: string;
  pipe_type: string;
  system_type: string;
  elevation_ft: number;
  connect_to_existing?: boolean;
  require_existing_endpoint_connections?: boolean;
  external_connection_tolerance_ft?: number;
};

export type PlumbingFixtureObservation = MepDraftObservationBase & {
  kind: "plumbing_fixture";
  discipline: "plumbing";
  role: string;
  point: ExistingConditionsPlanPoint;
  elevation_ft: number;
  placement: MepDraftPlacement;
  service_route_connections: Array<{
    route_observation_id: string;
    route_endpoint: "start" | "end";
  }>;
  service_boundary: {
    basis: "source_observation" | "native_model_precedent";
    evidence_role: string;
    required_services: PlumbingPipeRouteObservation["service"][];
    prohibited_services: PlumbingPipeRouteObservation["service"][];
  };
};

export type ElectricalDeviceObservation = MepDraftObservationBase & {
  kind: "electrical_device";
  discipline: "electrical";
  role: string;
  point: ExistingConditionsPlanPoint;
  elevation_ft: number;
  placement: MepDraftPlacement;
};

export type ElectricalCircuitObservation = MepDraftObservationBase & {
  kind: "electrical_circuit";
  discipline: "electrical";
  member_observation_ids: string[];
  source_reference_key: string;
  expected_power_system_id: string;
  membership_basis: "native_source_power_system";
  panel_circuit_label?: string;
};

export type MepDraftObservation =
  | PlumbingPipeRouteObservation
  | PlumbingFixtureObservation
  | ElectricalDeviceObservation
  | ElectricalCircuitObservation;

export type MepDraftPackage = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  source_evidence_sha256: string;
  visible_evidence: Array<{ role: string; sha256: string }>;
  native_element_references: Array<{
    reference_key: string;
    element_id: number;
    category: string;
    role: string;
    evidence_role: string;
    evidence_sha256: string;
    power_system_ids?: string[];
  }>;
  registration: ExistingConditionsRegistrationInput;
  level_name: string;
  /** Absolute model elevation of level_name. Observation elevation_ft values are offsets above this level. */
  level_elevation_ft: number;
  room_number?: string;
  material_confidence_threshold?: number;
  observations: MepDraftObservation[];
};

export type MepDraftElementReference = {
  created_by_action: string;
  output?: "created" | "route_start" | "route_end";
};

export type MepDraftAction = {
  action_key: string;
  observation_ids: string[];
  method: "POST";
  path:
    | "/revit/mep-route-workflow"
    | "/revit/place-families"
    | "/revit/place-family-instance-on-host"
    | "/revit/connect-mep-elements"
    | "/revit/assign-electrical-circuit";
  depends_on: string[];
  dry_run_body?: JsonMap;
  apply_body?: JsonMap;
  deferred_body?: {
    source_element?: MepDraftElementReference;
    target_elements?: MepDraftElementReference[];
    element_ids?: MepDraftElementReference[];
    source_element_id?: number;
    required_connection_count?: number;
  };
  expected_model_point?: ExistingConditionsPlanPoint & { z: number };
  expected_created_min: number;
  expected_created_max: number;
};

export type CompiledMepDraftPlan = {
  schema_version: 1;
  status: "ready" | "clarification_required" | "blocked";
  fixture_id: string;
  scope_id: string;
  input_fingerprint_sha256: string;
  registration: ExistingConditionsRegistrationReceipt;
  source_observations: ExistingConditionsSourceObservation[];
  plan_elements: ExistingConditionsPlanElement[];
  ambiguities: ExistingConditionsAmbiguity[];
  actions: MepDraftAction[];
  blockers: string[];
  warnings: string[];
};

export type AtomicMepDraftWorkflowRequest = {
  inputFingerprintSha256: string;
  operations: Array<Pick<MepDraftAction, "action_key" | "path" | "depends_on" | "apply_body" | "deferred_body" | "expected_created_min" | "expected_created_max">>;
  dryRun: boolean;
  verify: boolean;
  maximumCreatedElements: number;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase().replace(/[\s_-]+/g, " ");
}

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function requiredSha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${label}_must_be_positive_integer`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = clean(raw);
    const key = normalized(value);
    if (value && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function inputFingerprint(input: MepDraftPackage): string {
  return crypto.createHash("sha256").update(canonicalJson({
    source_evidence_sha256: input.source_evidence_sha256,
    visible_evidence: input.visible_evidence,
    native_element_references: input.native_element_references,
    registration: input.registration,
    level_name: input.level_name,
    level_elevation_ft: input.level_elevation_ft,
    room_number: input.room_number ?? null,
    observations: input.observations
  })).digest("hex");
}

function materialAttributes(observation: MepDraftObservation): string[] {
  if (observation.kind === "pipe_route") return ["location", "size", "elevation", "system", "type"];
  if (observation.kind === "plumbing_fixture") {
    return observation.placement.mode === "hosted_exemplar"
      ? ["location", "type", "host", "service topology"]
      : ["location", "type", "service topology"];
  }
  if (observation.kind === "electrical_device") {
    return observation.placement.mode === "hosted_exemplar"
      ? ["location", "type", "host"]
      : ["location", "type"];
  }
  return ["circuit"];
}

function category(observation: MepDraftObservation): string {
  if (observation.kind === "pipe_route") return "OST_PipeCurves";
  if (observation.kind === "plumbing_fixture") return "OST_PlumbingFixtures";
  return "OST_ElectricalFixtures";
}

function role(observation: MepDraftObservation): string {
  if (observation.kind === "pipe_route") return observation.service.replaceAll("_", " ");
  if (observation.kind === "electrical_circuit") return observation.panel_circuit_label
    ? `electrical circuit ${observation.panel_circuit_label}`
    : "electrical circuit";
  return observation.role;
}

function action(observation: MepDraftObservation): ExistingConditionsPlanElement["action"] {
  return observation.kind === "electrical_circuit" ? "assign_circuit" : "create";
}

function validatePlacement(placement: MepDraftPlacement, observationId: string): void {
  if (placement.mode === "unhosted_family") {
    requiredText(placement.family_name, `${observationId}_family_name`);
    requiredText(placement.type_name, `${observationId}_type_name`);
    if (placement.rotation_degrees != null) finite(placement.rotation_degrees, `${observationId}_rotation_degrees`);
    return;
  }
  requiredText(placement.source_reference_key, `${observationId}_source_reference_key`);
  requiredText(placement.host_reference_key, `${observationId}_host_reference_key`);
  requiredText(placement.host_category, `${observationId}_host_category`);
  if (placement.target_chainage_ft != null) {
    const chainage = finite(placement.target_chainage_ft, `${observationId}_target_chainage_ft`);
    if (chainage < 0) throw new Error(`${observationId}_target_chainage_ft_must_be_nonnegative`);
  }
}

function validateObservation(observation: MepDraftObservation, index: number): void {
  const id = requiredText(observation.observation_id, `observation_${index}_id`);
  if (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) {
    throw new Error(`${id}_confidence_must_be_between_zero_and_one`);
  }
  if (!["clear", "partial", "occluded"].includes(observation.visibility)) throw new Error(`${id}_visibility_is_invalid`);
  if (!Array.isArray(observation.supported_attributes)) throw new Error(`${id}_supported_attributes_must_be_array`);
  if (observation.kind === "pipe_route") {
    if (!Array.isArray(observation.points) || observation.points.length < 2) throw new Error(`${id}_requires_at_least_two_points`);
    observation.points.forEach((entry, pointIndex) => {
      finite(entry.x, `${id}_point_${pointIndex}_x`);
      finite(entry.y, `${id}_point_${pointIndex}_y`);
    });
    requiredText(observation.pipe_size, `${id}_pipe_size`);
    requiredText(observation.pipe_type, `${id}_pipe_type`);
    requiredText(observation.system_type, `${id}_system_type`);
    finite(observation.elevation_ft, `${id}_elevation_ft`);
    if (observation.require_existing_endpoint_connections && !observation.connect_to_existing) {
      throw new Error(`${id}_required_endpoint_connections_need_connect_to_existing`);
    }
    return;
  }
  if (observation.kind === "plumbing_fixture" || observation.kind === "electrical_device") {
    requiredText(observation.role, `${id}_role`);
    finite(observation.point.x, `${id}_point_x`);
    finite(observation.point.y, `${id}_point_y`);
    finite(observation.elevation_ft, `${id}_elevation_ft`);
    validatePlacement(observation.placement, id);
    if (observation.kind === "plumbing_fixture") {
      if (!Array.isArray(observation.service_route_connections)) {
        throw new Error(`${id}_service_route_connections_must_be_array`);
      }
      observation.service_route_connections.forEach((connection, connectionIndex) => {
        requiredText(connection.route_observation_id, `${id}_service_route_connection_${connectionIndex}_route_observation_id`);
        if (connection.route_endpoint !== "start" && connection.route_endpoint !== "end") {
          throw new Error(`${id}_service_route_connection_${connectionIndex}_route_endpoint_invalid`);
        }
      });
    }
    return;
  }
  if (!Array.isArray(observation.member_observation_ids) || observation.member_observation_ids.length === 0) {
    throw new Error(`${id}_member_observation_ids_are_required`);
  }
  requiredText(observation.source_reference_key, `${id}_source_reference_key`);
  requiredText(observation.expected_power_system_id, `${id}_expected_power_system_id`);
  if (observation.membership_basis !== "native_source_power_system") {
    throw new Error(`${id}_membership_basis_must_be_native_source_power_system`);
  }
}

function pointAction(
  observation: PlumbingFixtureObservation | ElectricalDeviceObservation,
  transformed: ExistingConditionsPlanPoint,
  levelName: string,
  levelElevationFt: number,
  roomNumber: string | undefined,
  nativeReferences: Map<string, MepDraftPackage["native_element_references"][number]>
): MepDraftAction {
  const actionKey = `place:${observation.observation_id}`;
  const expected = { ...transformed, z: levelElevationFt + observation.elevation_ft };
  if (observation.placement.mode === "unhosted_family") {
    const instance: JsonMap = {
      x: transformed.x,
      y: transformed.y,
      z: observation.elevation_ft
    };
    if (observation.placement.rotation_degrees != null) instance.rotationDegrees = observation.placement.rotation_degrees;
    const common: JsonMap = {
      levelName,
      familyName: observation.placement.family_name,
      symbolName: observation.placement.type_name,
      instances: [instance],
      idempotency: { enabled: true, toleranceFt: 0.05 },
      behavior: "allOrNothing"
    };
    return {
      action_key: actionKey,
      observation_ids: [observation.observation_id],
      method: "POST",
      path: "/revit/place-families",
      depends_on: [],
      dry_run_body: { ...common, dryRun: true },
      apply_body: { ...common, dryRun: false },
      expected_model_point: expected,
      expected_created_min: 1,
      expected_created_max: 1
    };
  }
  const sourceReference = nativeReferences.get(observation.placement.source_reference_key)!;
  const hostReference = nativeReferences.get(observation.placement.host_reference_key)!;
  const matchOrientationFromSource = observation.placement.match_orientation_from_source !== false;
  const common: JsonMap = {
    sourceElementId: sourceReference.element_id,
    hostElementId: hostReference.element_id,
    pointXyz: [expected.x, expected.y, expected.z],
    orientationSourceElementId: sourceReference.element_id,
    matchOrientationFromSource,
    copyRotation: matchOrientationFromSource,
    copyFacingHandState: matchOrientationFromSource,
    includePreviewImage: true
  };
  if (observation.placement.target_chainage_ft != null) {
    common.targetChainageFt = observation.placement.target_chainage_ft;
  }
  if (roomNumber) common.roomNumber = roomNumber;
  if (observation.placement.room_side) common.roomSide = observation.placement.room_side;
  return {
    action_key: actionKey,
    observation_ids: [observation.observation_id],
    method: "POST",
    path: "/revit/place-family-instance-on-host",
    depends_on: [],
    dry_run_body: { ...common, dryRun: true },
    apply_body: { ...common, dryRun: false, includePreviewImage: false },
    expected_model_point: expected,
    expected_created_min: 1,
    expected_created_max: 1
  };
}

export function compileMepDraftPlan(input: MepDraftPackage): CompiledMepDraftPlan {
  if (input.schema_version !== 1) throw new Error("unsupported_mep_draft_package_schema_version");
  const fixtureId = requiredText(input.fixture_id, "fixture_id");
  const scopeId = requiredText(input.scope_id, "scope_id");
  const levelName = requiredText(input.level_name, "level_name");
  const levelElevationFt = finite(input.level_elevation_ft, "level_elevation_ft");
  if (!Array.isArray(input.visible_evidence) || input.visible_evidence.length === 0) throw new Error("visible_evidence_is_required");
  const visibleEvidence = input.visible_evidence.map((entry, index) => ({
    role: requiredText(entry.role, `visible_evidence_${index}_role`),
    sha256: requiredSha256(entry.sha256, `visible_evidence_${index}_sha256`)
  }));
  if (new Set(visibleEvidence.map((entry) => normalized(entry.role))).size !== visibleEvidence.length) {
    throw new Error("visible_evidence_roles_must_be_unique");
  }
  const visibleEvidenceByRole = new Map(visibleEvidence.map((entry) => [normalized(entry.role), entry.sha256]));
  const sourceEvidenceSha256 = requiredSha256(input.source_evidence_sha256, "source_evidence_sha256");
  if (visibleEvidenceByRole.get("source pdf") !== sourceEvidenceSha256) throw new Error("source_pdf_visible_evidence_hash_mismatch");
  if (!Array.isArray(input.native_element_references)) throw new Error("native_element_references_must_be_array");
  const nativeReferences = new Map<string, MepDraftPackage["native_element_references"][number]>();
  for (const [index, reference] of input.native_element_references.entries()) {
    const key = requiredText(reference.reference_key, `native_reference_${index}_key`);
    if (nativeReferences.has(key)) throw new Error(`native_reference_key_duplicate:${key}`);
    positiveInteger(reference.element_id, `${key}_element_id`);
    requiredText(reference.category, `${key}_category`);
    requiredText(reference.role, `${key}_role`);
    const evidenceRole = requiredText(reference.evidence_role, `${key}_evidence_role`);
    const evidenceSha256 = requiredSha256(reference.evidence_sha256, `${key}_evidence_sha256`);
    if (visibleEvidenceByRole.get(normalized(evidenceRole)) !== evidenceSha256) throw new Error(`${key}_native_evidence_hash_mismatch`);
    nativeReferences.set(key, { ...reference, reference_key: key, evidence_role: evidenceRole, evidence_sha256: evidenceSha256 });
  }
  if (!Array.isArray(input.observations) || input.observations.length === 0) throw new Error("observations_are_required");
  const registration = solveExistingConditionsRegistration(input.registration);
  if (registration.source_evidence_sha256 !== sourceEvidenceSha256) {
    throw new Error("registration_source_evidence_hash_mismatch");
  }
  input.observations.forEach(validateObservation);
  const ids = input.observations.map((entry) => entry.observation_id);
  if (new Set(ids).size !== ids.length) throw new Error("observation_ids_must_be_unique");
  const byId = new Map(input.observations.map((entry) => [entry.observation_id, entry]));
  const claimedPipeEndpoints = new Map<string, string>();
  const assignedElectricalDevices = new Map<string, string>();
  for (const observation of input.observations) {
    const evidenceRole = clean(observation.evidence_role) || "source_pdf";
    if (!visibleEvidenceByRole.has(normalized(evidenceRole))) {
      throw new Error(`${observation.observation_id}_references_unknown_visible_evidence_role:${evidenceRole}`);
    }
    if (observation.kind === "plumbing_fixture") {
      if (!observation.service_boundary || !["source_observation", "native_model_precedent"].includes(observation.service_boundary.basis)) {
        throw new Error(`${observation.observation_id}_service_boundary_basis_invalid`);
      }
      const boundaryRole = requiredText(observation.service_boundary?.evidence_role, `${observation.observation_id}_service_boundary_evidence_role`);
      if (!visibleEvidenceByRole.has(normalized(boundaryRole))) throw new Error(`${observation.observation_id}_service_boundary_evidence_role_unknown`);
      const requiredServices = unique(observation.service_boundary?.required_services ?? []);
      const prohibitedServices = unique(observation.service_boundary?.prohibited_services ?? []);
      if (requiredServices.length === 0) throw new Error(`${observation.observation_id}_required_services_are_required`);
      if (requiredServices.some((service) => prohibitedServices.includes(service))) throw new Error(`${observation.observation_id}_service_boundary_conflicts`);
      const referencedServices: string[] = [];
      for (const connection of observation.service_route_connections) {
        const routeId = connection.route_observation_id;
        const route = byId.get(routeId);
        if (!route || route.kind !== "pipe_route") throw new Error(`${observation.observation_id}_references_unknown_pipe_route:${routeId}`);
        const endpointKey = `${routeId}:${connection.route_endpoint}`;
        const existingClaim = claimedPipeEndpoints.get(endpointKey);
        if (existingClaim) {
          throw new Error(`pipe_route_endpoint_claimed_multiple_times:${endpointKey}:${existingClaim}:${observation.observation_id}`);
        }
        claimedPipeEndpoints.set(endpointKey, observation.observation_id);
        referencedServices.push(route.service);
      }
      if (new Set(referencedServices).size !== referencedServices.length) throw new Error(`${observation.observation_id}_duplicates_service_routes`);
      const missingServices = requiredServices.filter((service) => !referencedServices.includes(service));
      const prohibitedPresent = referencedServices.filter((service) => prohibitedServices.includes(service));
      const undeclaredServices = referencedServices.filter((service) => !requiredServices.includes(service));
      if (missingServices.length > 0) throw new Error(`${observation.observation_id}_missing_required_services:${missingServices.join(",")}`);
      if (prohibitedPresent.length > 0) throw new Error(`${observation.observation_id}_prohibited_services_present:${prohibitedPresent.join(",")}`);
      if (undeclaredServices.length > 0) throw new Error(`${observation.observation_id}_undeclared_services_present:${undeclaredServices.join(",")}`);
    }
    if ((observation.kind === "plumbing_fixture" || observation.kind === "electrical_device")
      && observation.placement.mode === "hosted_exemplar") {
      const sourceReference = nativeReferences.get(observation.placement.source_reference_key);
      if (!sourceReference) throw new Error(`${observation.observation_id}_source_reference_unknown`);
      if (normalized(sourceReference.category) !== normalized(category(observation))) throw new Error(`${observation.observation_id}_source_reference_category_mismatch`);
      const hostReference = nativeReferences.get(observation.placement.host_reference_key);
      if (!hostReference) throw new Error(`${observation.observation_id}_host_reference_unknown`);
      if (normalized(hostReference.category) !== normalized(observation.placement.host_category)) {
        throw new Error(`${observation.observation_id}_host_reference_category_mismatch`);
      }
    }
    if (observation.kind === "electrical_circuit") {
      if (new Set(observation.member_observation_ids).size !== observation.member_observation_ids.length) {
        throw new Error(`${observation.observation_id}_member_observation_ids_must_be_unique`);
      }
      for (const memberId of observation.member_observation_ids) {
        const member = byId.get(memberId);
        if (!member || member.kind !== "electrical_device") throw new Error(`${observation.observation_id}_references_unknown_electrical_device:${memberId}`);
        const existingCircuit = assignedElectricalDevices.get(memberId);
        if (existingCircuit) {
          throw new Error(`electrical_device_assigned_to_multiple_circuits:${memberId}:${existingCircuit}:${observation.observation_id}`);
        }
        assignedElectricalDevices.set(memberId, observation.observation_id);
      }
      const sourceReference = nativeReferences.get(observation.source_reference_key);
      if (!sourceReference) throw new Error(`${observation.observation_id}_source_reference_unknown`);
      if (normalized(sourceReference.category) !== normalized("OST_ElectricalFixtures")) throw new Error(`${observation.observation_id}_source_reference_category_mismatch`);
      const powerSystemIds = unique(sourceReference.power_system_ids ?? []);
      if (powerSystemIds.length !== 1 || powerSystemIds[0] !== observation.expected_power_system_id) {
        throw new Error(`${observation.observation_id}_source_power_system_not_exactly_verified`);
      }
    }
  }

  const threshold = input.material_confidence_threshold == null
    ? 0.75
    : finite(input.material_confidence_threshold, "material_confidence_threshold");
  if (threshold < 0 || threshold > 1) throw new Error("material_confidence_threshold_must_be_between_zero_and_one");
  const ambiguities: ExistingConditionsAmbiguity[] = [];
  const warnings: string[] = [];
  const sourceObservations: ExistingConditionsSourceObservation[] = [];
  const planElements: ExistingConditionsPlanElement[] = [];

  for (const observation of input.observations) {
    const requiredAttributes = materialAttributes(observation);
    const supported = new Set(observation.supported_attributes.map(normalized));
    const missing = requiredAttributes.filter((attribute) => !supported.has(normalized(attribute)));
    const effectiveConfidence = observation.visibility === "clear"
      ? observation.confidence
      : observation.visibility === "partial"
        ? observation.confidence * 0.8
        : observation.confidence * 0.55;
    sourceObservations.push({
      observation_id: observation.observation_id,
      evidence_role: clean(observation.evidence_role) || "source_pdf",
      discipline: observation.discipline,
      category: category(observation),
      role: role(observation),
      visibility: observation.visibility,
      confidence: observation.confidence,
      supported_attributes: unique(observation.supported_attributes)
    });
    planElements.push({
      plan_key: observation.observation_id,
      discipline: observation.discipline,
      category: category(observation),
      role: role(observation),
      action: action(observation),
      confidence: effectiveConfidence,
      assumptions: [],
      source_observation_ids: [observation.observation_id],
      required_source_attributes: requiredAttributes
    });
    if (effectiveConfidence < threshold || missing.length > 0) {
      const reasons = [
        ...(effectiveConfidence < threshold ? [`effective confidence ${effectiveConfidence.toFixed(3)} is below ${threshold.toFixed(3)}`] : []),
        ...(missing.length > 0 ? [`source does not support ${missing.join(", ")}`] : [])
      ];
      ambiguities.push({
        id: `clarify:${observation.observation_id}`,
        topic: `${role(observation)} source evidence`,
        description: reasons.join("; "),
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

  const blockers = registration.verified ? [] : [
    `registration_error_exceeds_limit:rms=${registration.rms_error_ft.toFixed(6)}/${registration.max_rms_error_ft.toFixed(6)}:max=${registration.maximum_error_ft.toFixed(6)}/${registration.max_point_error_ft.toFixed(6)}`
  ];
  if (!registration.verified) warnings.push("No Revit write plan was emitted because source-to-model registration is not verified.");
  if (ambiguities.length > 0) warnings.push("Material source ambiguities must be resolved before dry-run or apply.");
  const actions: MepDraftAction[] = [];

  if (blockers.length === 0 && ambiguities.length === 0) {
    for (const observation of input.observations) {
      if (observation.kind === "pipe_route") {
        const points = observation.points.map((entry) => ({
          ...transformExistingConditionsPlanPoint(registration, entry),
          z: levelElevationFt + observation.elevation_ft
        }));
        const common: JsonMap = {
          kind: "pipe",
          levelName,
          systemType: observation.system_type,
          pipeType: observation.pipe_type,
          pipeSize: observation.pipe_size,
          sizePolicy: "explicit_required",
          elevationPolicy: "explicit_points",
          points,
          connectSegments: true,
          connectToExisting: observation.connect_to_existing === true,
          requireExistingEndpointConnections: observation.require_existing_endpoint_connections === true,
          externalConnectionToleranceFt: observation.external_connection_tolerance_ft ?? 0.1,
          verify: true,
          visualVerify: true
        };
        if (input.room_number) common.roomNumber = input.room_number;
        actions.push({
          action_key: `route:${observation.observation_id}`,
          observation_ids: [observation.observation_id],
          method: "POST",
          path: "/revit/mep-route-workflow",
          depends_on: [],
          dry_run_body: { ...common, apply: false },
          apply_body: { ...common, apply: true },
          expected_created_min: observation.points.length - 1,
          expected_created_max: (observation.points.length - 1) + Math.max(0, observation.points.length - 2)
        });
        continue;
      }
      if (observation.kind === "plumbing_fixture" || observation.kind === "electrical_device") {
        actions.push(pointAction(
          observation,
          transformExistingConditionsPlanPoint(registration, observation.point),
          levelName,
          levelElevationFt,
          input.room_number,
          nativeReferences
        ));
        continue;
      }
      const dependencies = observation.member_observation_ids.map((id) => `place:${id}`);
      const sourceReference = nativeReferences.get(observation.source_reference_key)!;
      actions.push({
        action_key: `circuit:${observation.observation_id}`,
        observation_ids: [observation.observation_id, ...observation.member_observation_ids],
        method: "POST",
        path: "/revit/assign-electrical-circuit",
        depends_on: dependencies,
        deferred_body: {
          element_ids: dependencies.map((createdByAction) => ({ created_by_action: createdByAction })),
          source_element_id: sourceReference.element_id
        },
        expected_created_min: 0,
        expected_created_max: 0
      });
    }
    for (const observation of input.observations) {
      if (observation.kind !== "plumbing_fixture" || observation.service_route_connections.length === 0) continue;
      const sourceAction = `place:${observation.observation_id}`;
      for (const connection of observation.service_route_connections) {
        const routeId = connection.route_observation_id;
        const targetAction = `route:${routeId}`;
        actions.push({
          action_key: `connect:${observation.observation_id}:${routeId}`,
          observation_ids: [observation.observation_id, routeId],
          method: "POST",
          path: "/revit/connect-mep-elements",
          depends_on: [sourceAction, targetAction],
          deferred_body: {
            source_element: { created_by_action: sourceAction, output: "created" },
            target_elements: [{
              created_by_action: targetAction,
              output: connection.route_endpoint === "start" ? "route_start" : "route_end"
            }],
            required_connection_count: 1
          },
          expected_created_min: 0,
          expected_created_max: 0
        });
      }
    }
  }

  return {
    schema_version: 1,
    status: blockers.length > 0 ? "blocked" : ambiguities.length > 0 ? "clarification_required" : "ready",
    fixture_id: fixtureId,
    scope_id: scopeId,
    input_fingerprint_sha256: inputFingerprint(input),
    registration,
    source_observations: sourceObservations,
    plan_elements: planElements,
    ambiguities,
    actions,
    blockers,
    warnings
  };
}

export function buildAtomicMepDraftWorkflowRequest(
  plan: CompiledMepDraftPlan,
  options: { dry_run?: boolean; maximum_created_elements?: number } = {}
): AtomicMepDraftWorkflowRequest {
  if (plan.status !== "ready") throw new Error(`mep_draft_plan_not_ready:${plan.status}`);
  const maximumCreatedElements = options.maximum_created_elements ?? Math.max(1, plan.plan_elements.filter((entry) => entry.action === "create").length * 4);
  if (!Number.isInteger(maximumCreatedElements) || maximumCreatedElements < 1 || maximumCreatedElements > 500) {
    throw new Error("maximum_created_elements_must_be_between_1_and_500");
  }
  return {
    inputFingerprintSha256: plan.input_fingerprint_sha256,
    operations: plan.actions.map((entry) => ({
      action_key: entry.action_key,
      path: entry.path,
      depends_on: entry.depends_on,
      expected_created_min: entry.expected_created_min,
      expected_created_max: entry.expected_created_max,
      ...(entry.apply_body ? { apply_body: entry.apply_body } : {}),
      ...(entry.deferred_body ? { deferred_body: entry.deferred_body } : {})
    })),
    dryRun: options.dry_run !== false,
    verify: true,
    maximumCreatedElements
  };
}
