import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadImage } from "@napi-rs/canvas";
import {
  compileMepDraftPlan,
  type CompiledMepDraftPlan,
  type ElectricalCircuitObservation,
  type ElectricalDeviceObservation,
  type MepDraftPackage,
  type PlumbingFixtureObservation,
  type PlumbingPipeRouteObservation
} from "./mep_draft_plan.js";
import {
  solveExistingConditionsRegistration,
  type ExistingConditionsPlanPoint,
  type ExistingConditionsRegistrationReceipt
} from "./registration.js";

type Bounds2d = {
  min: ExistingConditionsPlanPoint;
  max: ExistingConditionsPlanPoint;
};

type RegisteredRender = {
  path: string;
  sha256: string;
  width_px: number;
  height_px: number;
  evidence_role: string;
  access_scope: "agent_visible";
};

export type RegisteredMepAttributeEvidence = {
  attribute: string;
  basis: "legible_source_evidence" | "native_model_precedent" | "user_direction";
  evidence_role: string;
  reference: string;
};

type WithAttributeEvidence = {
  attribute_evidence: RegisteredMepAttributeEvidence[];
};

export type RegisteredPlumbingPipeRouteObservation = Omit<PlumbingPipeRouteObservation, "points"> & WithAttributeEvidence & {
  pixel_points: ExistingConditionsPlanPoint[];
};

export type RegisteredPlumbingFixtureObservation = Omit<PlumbingFixtureObservation, "point"> & WithAttributeEvidence & {
  pixel_point: ExistingConditionsPlanPoint;
};

export type RegisteredElectricalDeviceObservation = Omit<ElectricalDeviceObservation, "point"> & WithAttributeEvidence & {
  pixel_point: ExistingConditionsPlanPoint;
};

export type RegisteredMepPixelObservation =
  | RegisteredPlumbingPipeRouteObservation
  | RegisteredPlumbingFixtureObservation
  | RegisteredElectricalDeviceObservation
  | ElectricalCircuitObservation;

export type RegisteredMepObservationPackage = Omit<MepDraftPackage, "observations"> & {
  discipline: "plumbing" | "electrical" | "mixed";
  coordinate_space: "registered_render_pixels_top_left";
  registered_render: RegisteredRender;
  frame: {
    model_bounds: Bounds2d;
  };
  maximum_observations: number;
  observations: RegisteredMepPixelObservation[];
};

export type RegisteredMepObservationCompilation = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  input_fingerprint_sha256: string;
  registered_render_sha256: string;
  registration: ExistingConditionsRegistrationReceipt;
  converted_package: MepDraftPackage;
  compiled_plan: CompiledMepDraftPlan;
  usage_constraints: string[];
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

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}_must_be_positive_integer`);
  return parsed;
}

function sha256Text(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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

function bounds(value: Bounds2d, label: string): Bounds2d {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const min = point(value.min, `${label}_min`);
  const max = point(value.max, `${label}_max`);
  if (max.x <= min.x || max.y <= min.y) throw new Error(`${label}_must_have_positive_extent`);
  return { min, max };
}

function pixelToModel(
  pixel: ExistingConditionsPlanPoint,
  modelBounds: Bounds2d,
  width: number,
  height: number,
  label: string
): ExistingConditionsPlanPoint {
  const checked = point(pixel, label);
  if (checked.x < 0 || checked.x > width || checked.y < 0 || checked.y > height) {
    throw new Error(`${label}_outside_registered_render`);
  }
  return {
    x: modelBounds.min.x + checked.x / width * (modelBounds.max.x - modelBounds.min.x),
    y: modelBounds.max.y - checked.y / height * (modelBounds.max.y - modelBounds.min.y)
  };
}

function modelToSource(
  model: ExistingConditionsPlanPoint,
  registration: ExistingConditionsRegistrationReceipt
): ExistingConditionsPlanPoint {
  const radians = registration.rotation_degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = model.x - registration.translation_ft.x;
  const dy = model.y - registration.translation_ft.y;
  return {
    x: (cos * dx + sin * dy) / registration.scale,
    y: (-sin * dx + cos * dy) / registration.scale
  };
}

function allowedDiscipline(
  packageDiscipline: RegisteredMepObservationPackage["discipline"],
  observation: RegisteredMepPixelObservation,
  index: number
): void {
  const expected = observation.kind === "pipe_route" || observation.kind === "plumbing_fixture" ? "plumbing" : "electrical";
  if (observation.discipline !== expected) throw new Error(`observation_${index}_discipline_kind_mismatch`);
  if (packageDiscipline !== "mixed" && packageDiscipline !== expected) {
    throw new Error(`observation_${index}_outside_package_discipline`);
  }
}

function materialAttributes(observation: Exclude<RegisteredMepPixelObservation, ElectricalCircuitObservation>): string[] {
  if (observation.kind === "pipe_route") return ["size", "elevation", "system", "type"];
  if (observation.kind === "plumbing_fixture") {
    return observation.placement.mode === "hosted_exemplar" ? ["type", "host", "service topology"] : ["type", "service topology"];
  }
  return observation.placement.mode === "hosted_exemplar" ? ["type", "host"] : ["type"];
}

function validateAttributeEvidence(
  observation: Exclude<RegisteredMepPixelObservation, ElectricalCircuitObservation>,
  evidenceByRole: Map<string, string>,
  renderRole: string
): void {
  if (!Array.isArray(observation.attribute_evidence)) {
    throw new Error(`${observation.observation_id}_attribute_evidence_is_required`);
  }
  const supported = new Set(observation.supported_attributes.map(normalized));
  const claims = new Map<string, RegisteredMepAttributeEvidence>();
  for (const [index, claim] of observation.attribute_evidence.entries()) {
    const attribute = normalized(requiredText(claim.attribute, `${observation.observation_id}_attribute_evidence_${index}_attribute`));
    if (!supported.has(attribute)) throw new Error(`${observation.observation_id}_attribute_evidence_not_supported:${attribute}`);
    if (claims.has(attribute)) throw new Error(`${observation.observation_id}_attribute_evidence_duplicate:${attribute}`);
    if (!["legible_source_evidence", "native_model_precedent", "user_direction"].includes(claim.basis)) {
      throw new Error(`${observation.observation_id}_attribute_evidence_basis_invalid:${attribute}`);
    }
    const evidenceRole = requiredText(claim.evidence_role, `${observation.observation_id}_${attribute}_evidence_role`);
    if (!evidenceByRole.has(normalized(evidenceRole))) {
      throw new Error(`${observation.observation_id}_${attribute}_evidence_role_unknown:${evidenceRole}`);
    }
    if (claim.basis === "legible_source_evidence"
      && !["source pdf", normalized(renderRole)].includes(normalized(evidenceRole))) {
      throw new Error(`${observation.observation_id}_${attribute}_legible_evidence_role_invalid`);
    }
    if (claim.basis === "native_model_precedent"
      && ["source pdf", normalized(renderRole)].includes(normalized(evidenceRole))) {
      throw new Error(`${observation.observation_id}_${attribute}_native_precedent_requires_native_evidence`);
    }
    requiredText(claim.reference, `${observation.observation_id}_${attribute}_evidence_reference`);
    claims.set(attribute, claim);
  }
  for (const attribute of materialAttributes(observation).map(normalized)) {
    if (supported.has(attribute) && !claims.has(attribute)) {
      throw new Error(`${observation.observation_id}_supported_attribute_lacks_evidence:${attribute}`);
    }
  }
}

export async function compileRegisteredMepObservations(
  input: RegisteredMepObservationPackage
): Promise<RegisteredMepObservationCompilation> {
  if (input.schema_version !== 1) throw new Error("registered_mep_observations_require_schema_v1");
  if (input.coordinate_space !== "registered_render_pixels_top_left") {
    throw new Error("registered_mep_observation_coordinate_space_invalid");
  }
  if (!["plumbing", "electrical", "mixed"].includes(input.discipline)) {
    throw new Error("registered_mep_observation_discipline_invalid");
  }
  const fixtureId = requiredText(input.fixture_id, "fixture_id");
  const scopeId = requiredText(input.scope_id, "scope_id");
  const sourceHash = sha256Text(input.source_evidence_sha256, "source_evidence_sha256");
  if (!Array.isArray(input.visible_evidence) || input.visible_evidence.length < 2) {
    throw new Error("registered_mep_visible_evidence_requires_source_and_render");
  }
  const visibleEvidence = input.visible_evidence.map((entry, index) => ({
    role: requiredText(entry.role, `visible_evidence_${index}_role`),
    sha256: sha256Text(entry.sha256, `visible_evidence_${index}_sha256`)
  }));
  if (new Set(visibleEvidence.map((entry) => normalized(entry.role))).size !== visibleEvidence.length) {
    throw new Error("registered_mep_visible_evidence_roles_must_be_unique");
  }
  const evidenceByRole = new Map(visibleEvidence.map((entry) => [normalized(entry.role), entry.sha256]));
  if (evidenceByRole.get("source pdf") !== sourceHash) throw new Error("registered_mep_source_pdf_hash_mismatch");
  const render = input.registered_render;
  if (!render || render.access_scope !== "agent_visible") throw new Error("registered_mep_render_must_be_agent_visible");
  const renderRole = requiredText(render.evidence_role, "registered_render_evidence_role");
  if (/ground\s*truth|evaluator|withheld/i.test(renderRole)) throw new Error("registered_mep_render_evidence_role_forbidden");
  const renderHash = sha256Text(render.sha256, "registered_render_sha256");
  if (evidenceByRole.get(normalized(renderRole)) !== renderHash) throw new Error("registered_mep_render_visible_evidence_hash_mismatch");
  const renderPath = path.resolve(requiredText(render.path, "registered_render_path"));
  if (!fs.existsSync(renderPath) || !fs.statSync(renderPath).isFile()) throw new Error(`registered_mep_render_not_found:${renderPath}`);
  if (sha256File(renderPath) !== renderHash) throw new Error("registered_mep_render_file_hash_mismatch");
  const width = positiveInteger(render.width_px, "registered_render_width_px");
  const height = positiveInteger(render.height_px, "registered_render_height_px");
  const image = await loadImage(renderPath);
  if (image.width !== width || image.height !== height) throw new Error("registered_mep_render_dimensions_mismatch");
  const modelBounds = bounds(input.frame?.model_bounds, "registered_mep_model_bounds");
  const registration = solveExistingConditionsRegistration(input.registration);
  if (!registration.verified) throw new Error("registered_mep_registration_not_verified");
  if (registration.source_evidence_sha256 !== sourceHash) throw new Error("registered_mep_registration_source_hash_mismatch");
  const maximumObservations = positiveInteger(input.maximum_observations, "maximum_observations");
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new Error("registered_mep_observations_are_required");
  }
  if (input.observations.length > maximumObservations) throw new Error("registered_mep_observation_limit_exceeded");
  const ids = input.observations.map((entry, index) => requiredText(entry.observation_id, `observation_${index}_id`));
  if (new Set(ids).size !== ids.length) throw new Error("registered_mep_observation_ids_must_be_unique");
  const convertedObservations: MepDraftPackage["observations"] = input.observations.map((observation, index) => {
    allowedDiscipline(input.discipline, observation, index);
    if (observation.kind === "electrical_circuit") {
      if (normalized(observation.evidence_role) === normalized(renderRole)) {
        throw new Error(`${observation.observation_id}_circuit_membership_cannot_use_render_evidence`);
      }
      return { ...observation };
    }
    validateAttributeEvidence(observation, evidenceByRole, renderRole);
    if (observation.kind === "pipe_route") {
      if (!Array.isArray(observation.pixel_points) || observation.pixel_points.length < 2) {
        throw new Error(`${observation.observation_id}_requires_at_least_two_pixel_points`);
      }
      const modelPoints = observation.pixel_points.map((entry, pointIndex) => pixelToModel(
        entry,
        modelBounds,
        width,
        height,
        `${observation.observation_id}_pixel_point_${pointIndex}`
      ));
      if (modelPoints.every((entry) => Math.hypot(entry.x - modelPoints[0]!.x, entry.y - modelPoints[0]!.y) <= Number.EPSILON)) {
        throw new Error(`${observation.observation_id}_route_is_degenerate`);
      }
      const { pixel_points: _pixelPoints, attribute_evidence: _attributeEvidence, ...rest } = observation;
      return { ...rest, evidence_role: renderRole, points: modelPoints.map((entry) => modelToSource(entry, registration)) };
    }
    const modelPoint = pixelToModel(
      observation.pixel_point,
      modelBounds,
      width,
      height,
      `${observation.observation_id}_pixel_point`
    );
    const { pixel_point: _pixelPoint, attribute_evidence: _attributeEvidence, ...rest } = observation;
    return { ...rest, evidence_role: renderRole, point: modelToSource(modelPoint, registration) };
  });
  const convertedPackage: MepDraftPackage = {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    source_evidence_sha256: sourceHash,
    visible_evidence: visibleEvidence,
    native_element_references: input.native_element_references,
    registration: input.registration,
    level_name: requiredText(input.level_name, "level_name"),
    level_elevation_ft: finite(input.level_elevation_ft, "level_elevation_ft"),
    ...(input.room_number == null ? {} : { room_number: requiredText(input.room_number, "room_number") }),
    ...(input.material_confidence_threshold == null ? {} : { material_confidence_threshold: input.material_confidence_threshold }),
    observations: convertedObservations
  };
  return {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    input_fingerprint_sha256: fingerprint(input),
    registered_render_sha256: renderHash,
    registration,
    converted_package: convertedPackage,
    compiled_plan: compileMepDraftPlan(convertedPackage),
    usage_constraints: [
      "Registered pixels establish bounded plan geometry only; material, system, size, elevation, family, type, host, and service-topology claims remain subject to the existing MEP compiler evidence gates.",
      "Electrical circuit membership cannot be inferred from plotted labels or this registered render and must remain grounded in exact native source power-system evidence.",
      "The registered render must be agent-visible, hash-bound, dimension-verified, and aligned to the declared model frame.",
      "No evaluator, withheld truth, native target identity, or scorer output is used to convert pixel observations."
    ]
  };
}
