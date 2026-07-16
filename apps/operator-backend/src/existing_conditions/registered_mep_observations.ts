import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadImage } from "@napi-rs/canvas";
import {
  compileMepDraftPlan,
  type AirTerminalObservation,
  type CompiledMepDraftPlan,
  type ElectricalCircuitObservation,
  type ElectricalConduitRouteObservation,
  type ElectricalDeviceObservation,
  type ElectricalEquipmentObservation,
  type MepDraftPlacement,
  type MepDraftPackage,
  type MechanicalDuctRouteObservation,
  type MechanicalEquipmentObservation,
  type PlumbingDownstreamVentTeeObservation,
  type PlumbingCreatedRouteConnectorBridgeObservation,
  type PlumbingNativeConnectorBridgeObservation,
  type PlumbingFixtureObservation,
  type PlumbingSourceBranchTeeObservation,
  type PlumbingSourcePointRouteObservation
} from "./mep_draft_plan.js";
import {
  solveExistingConditionsRegistration,
  type ExistingConditionsPlanPoint,
  type ExistingConditionsRegistrationReceipt
} from "./registration.js";
import {
  validateBoundedMepRegionCoverageV1,
  type BoundedMepRegionCoverageReceiptV1,
  type BoundedMepRegionCoverageV1
} from "./mep_region_coverage.js";

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
  basis: "legible_source_evidence" | "native_model_precedent" | "user_direction" | "declared_heuristic";
  evidence_role: string;
  reference: string;
};

type WithAttributeEvidence = {
  attribute_evidence: RegisteredMepAttributeEvidence[];
};

export type RegisteredPlumbingPipeRouteObservation = Omit<PlumbingSourcePointRouteObservation, "points"> & WithAttributeEvidence & {
  pixel_points: ExistingConditionsPlanPoint[];
};

export type RegisteredPlumbingSourceBranchTeeObservation = Omit<PlumbingSourceBranchTeeObservation, "points"> & WithAttributeEvidence & {
  pixel_points: ExistingConditionsPlanPoint[];
};

export type RegisteredPlumbingConnectorBridgeObservation = Omit<PlumbingNativeConnectorBridgeObservation, "attribute_provenance"> & WithAttributeEvidence;

export type RegisteredPlumbingCreatedRouteConnectorBridgeObservation = Omit<PlumbingCreatedRouteConnectorBridgeObservation, "attribute_provenance"> & WithAttributeEvidence;

type RegisteredDownstreamVentVariant<T> = T extends PlumbingDownstreamVentTeeObservation
  ? Omit<T, "points" | "attribute_provenance"> & WithAttributeEvidence & { pixel_points: ExistingConditionsPlanPoint[] }
  : never;

export type RegisteredPlumbingDownstreamVentTeeObservation = RegisteredDownstreamVentVariant<PlumbingDownstreamVentTeeObservation>;

export type RegisteredPlumbingFixtureObservation = Omit<PlumbingFixtureObservation, "point"> & WithAttributeEvidence & {
  pixel_point: ExistingConditionsPlanPoint;
};

export type RegisteredMechanicalDuctRouteObservation = Omit<MechanicalDuctRouteObservation, "points"> & WithAttributeEvidence & {
  pixel_points: ExistingConditionsPlanPoint[];
};

export type RegisteredMechanicalEquipmentObservation = Omit<MechanicalEquipmentObservation, "point"> & WithAttributeEvidence & {
  pixel_point: ExistingConditionsPlanPoint;
};

type CreatedRouteBranchPlacement = Extract<MepDraftPlacement, { mode: "created_route_branch" }>;
type RegisteredAirTerminalPlacement = Exclude<MepDraftPlacement, CreatedRouteBranchPlacement>
  | (Omit<CreatedRouteBranchPlacement, "branch_points"> & { pixel_branch_points: ExistingConditionsPlanPoint[] });

export type RegisteredAirTerminalObservation = Omit<AirTerminalObservation, "point" | "placement"> & WithAttributeEvidence & {
  pixel_point: ExistingConditionsPlanPoint;
  placement: RegisteredAirTerminalPlacement;
};

export type RegisteredElectricalDeviceObservation = Omit<ElectricalDeviceObservation, "point"> & WithAttributeEvidence & {
  pixel_point: ExistingConditionsPlanPoint;
};

export type RegisteredElectricalConduitRouteObservation = Omit<ElectricalConduitRouteObservation, "points"> & WithAttributeEvidence & {
  pixel_points: ExistingConditionsPlanPoint[];
};

export type RegisteredElectricalEquipmentObservation = Omit<ElectricalEquipmentObservation, "point"> & WithAttributeEvidence & {
  pixel_point: ExistingConditionsPlanPoint;
};

export type RegisteredMepPixelObservation =
  | RegisteredMechanicalDuctRouteObservation
  | RegisteredMechanicalEquipmentObservation
  | RegisteredAirTerminalObservation
  | RegisteredPlumbingPipeRouteObservation
  | RegisteredPlumbingSourceBranchTeeObservation
  | RegisteredPlumbingConnectorBridgeObservation
  | RegisteredPlumbingCreatedRouteConnectorBridgeObservation
  | RegisteredPlumbingDownstreamVentTeeObservation
  | RegisteredPlumbingFixtureObservation
  | RegisteredElectricalConduitRouteObservation
  | RegisteredElectricalDeviceObservation
  | RegisteredElectricalEquipmentObservation
  | ElectricalCircuitObservation;

export type RegisteredMepObservationPackage = Omit<MepDraftPackage, "observations"> & {
  discipline: "mechanical" | "plumbing" | "electrical" | "mixed";
  coordinate_space: "registered_render_pixels_top_left";
  registered_render: RegisteredRender;
  frame: {
    model_bounds: Bounds2d;
  };
  maximum_observations: number;
  source_coverage?: BoundedMepRegionCoverageV1;
  observations: RegisteredMepPixelObservation[];
};

export type RegisteredMepObservationCompilation = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  input_fingerprint_sha256: string;
  registered_render_sha256: string;
  registration: ExistingConditionsRegistrationReceipt;
  source_coverage_receipt?: BoundedMepRegionCoverageReceiptV1;
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

function registeredPipeSizePolicy(
  observation: RegisteredPlumbingPipeRouteObservation
    | RegisteredPlumbingSourceBranchTeeObservation
    | RegisteredPlumbingConnectorBridgeObservation
    | RegisteredPlumbingCreatedRouteConnectorBridgeObservation
    | RegisteredPlumbingDownstreamVentTeeObservation
): "explicit_required" | "unresolved_placeholder" {
  return observation.pipe_size_policy ?? "explicit_required";
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
  const expected = observation.kind === "duct_route" || observation.kind === "mechanical_equipment" || observation.kind === "air_terminal"
    ? "mechanical"
    : observation.kind === "pipe_route" || observation.kind === "plumbing_fixture"
      ? "plumbing"
      : "electrical";
  if (observation.discipline !== expected) throw new Error(`observation_${index}_discipline_kind_mismatch`);
  if (packageDiscipline !== "mixed" && packageDiscipline !== expected) {
    throw new Error(`observation_${index}_outside_package_discipline`);
  }
}

function materialAttributes(observation: Exclude<RegisteredMepPixelObservation, ElectricalCircuitObservation>): string[] {
  if (observation.kind === "duct_route") return ["size", "elevation", "system", "type"];
  if (observation.kind === "conduit_route") return ["size", "elevation", "type"];
  if (observation.kind === "pipe_route") {
    const size = registeredPipeSizePolicy(observation) === "explicit_required" ? ["size"] : [];
    if (observation.geometry_mode === "native_connector_bridge"
      || observation.geometry_mode === "created_route_connector_bridge") {
      return ["location", ...size, "elevation", "system", "type"];
    }
    if (observation.geometry_mode === "downstream_vent_tee") {
      return [...size, ...(clean(observation.main_reference_key) ? ["main elevation"] : []), "elevation", "system", "type"];
    }
    return [...size, "elevation", "system", "type"];
  }
  if (observation.kind === "plumbing_fixture") {
    return observation.placement.mode === "hosted_exemplar" || observation.placement.mode === "hosted_family_symbol"
      ? ["type", "host", "service topology"]
      : ["type", "service topology"];
  }
  return observation.placement.mode === "hosted_exemplar"
    || observation.placement.mode === "hosted_family_symbol"
    || observation.placement.mode === "created_route_host"
    || observation.placement.mode === "created_route_branch"
    ? ["type", "host"]
    : ["type"];
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
    if (!["legible_source_evidence", "native_model_precedent", "user_direction", "declared_heuristic"].includes(claim.basis)) {
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
    if (claim.basis === "declared_heuristic") {
      if ((observation.kind !== "pipe_route" && observation.kind !== "duct_route" && observation.kind !== "conduit_route") || attribute !== "elevation") {
        throw new Error(`${observation.observation_id}_declared_heuristic_only_allowed_for_route_elevation`);
      }
      if (!["source pdf", normalized(renderRole)].includes(normalized(evidenceRole))) {
        throw new Error(`${observation.observation_id}_elevation_heuristic_requires_plan_context`);
      }
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
  if (!["mechanical", "plumbing", "electrical", "mixed"].includes(input.discipline)) {
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
  const sourceCoverageReceipt = input.source_coverage
    ? validateBoundedMepRegionCoverageV1(input.source_coverage, {
        scope_id: scopeId,
        source_evidence_sha256: sourceHash,
        registered_render_sha256: renderHash,
        render_width_px: width,
        render_height_px: height,
        package_discipline: input.discipline,
        observations: input.observations.map((observation) => ({
          observation_id: observation.observation_id,
          kind: observation.kind,
          discipline: observation.discipline
        }))
      })
    : undefined;
  const convertedObservations: MepDraftPackage["observations"] = input.observations.map((observation, index): MepDraftPackage["observations"][number] => {
    allowedDiscipline(input.discipline, observation, index);
    if (observation.kind === "electrical_circuit") {
      const usesRenderEvidence = normalized(observation.evidence_role) === normalized(renderRole);
      if (observation.circuit_mode === "create_new_power_system"
        && observation.membership_basis === "legible_source_circuit_label") {
        if (!usesRenderEvidence) {
          throw new Error(`${observation.observation_id}_legible_circuit_label_must_use_registered_render`);
        }
        for (const evidence of observation.member_label_evidence ?? []) {
          if (normalized(evidence.evidence_role) !== normalized(renderRole)) {
            throw new Error(`${observation.observation_id}_member_label_evidence_must_use_registered_render:${evidence.member_observation_id}`);
          }
        }
        for (const evidence of observation.native_member_label_evidence ?? []) {
          if (normalized(evidence.evidence_role) !== normalized(renderRole)) {
            throw new Error(`${observation.observation_id}_native_member_label_evidence_must_use_registered_render:${evidence.native_member_reference_key}`);
          }
        }
      } else if (usesRenderEvidence) {
        throw new Error(`${observation.observation_id}_circuit_membership_cannot_use_render_evidence`);
      }
      return { ...observation };
    }
    validateAttributeEvidence(observation, evidenceByRole, renderRole);
    const attributeProvenance = observation.attribute_evidence.map((claim) => ({
      attribute: claim.attribute,
      basis: claim.basis === "legible_source_evidence"
        ? "source_observation" as const
        : claim.basis,
      reference: claim.reference
    }));
    if (observation.kind === "duct_route" || observation.kind === "conduit_route") {
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
      return {
        ...rest,
        evidence_role: renderRole,
        attribute_provenance: attributeProvenance,
        points: modelPoints.map((entry) => modelToSource(entry, registration))
      };
    }
    if (observation.kind === "pipe_route") {
      if (observation.geometry_mode === "native_connector_bridge"
        || observation.geometry_mode === "created_route_connector_bridge") {
        const { attribute_evidence: _attributeEvidence, ...rest } = observation;
        return {
          ...rest,
          attribute_provenance: attributeProvenance
        };
      }
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
      return {
        ...rest,
        evidence_role: renderRole,
        attribute_provenance: attributeProvenance,
        points: modelPoints.map((entry) => modelToSource(entry, registration))
      };
    }
    const modelPoint = pixelToModel(
      observation.pixel_point,
      modelBounds,
      width,
      height,
      `${observation.observation_id}_pixel_point`
    );
    if (observation.kind === "air_terminal" && observation.placement.mode === "created_route_branch") {
      const { pixel_point: _pixelPoint, attribute_evidence: _attributeEvidence, ...rest } = observation;
      const pixelBranchPoints = observation.placement.pixel_branch_points;
      if (!Array.isArray(pixelBranchPoints) || pixelBranchPoints.length < 2) {
        throw new Error(`${observation.observation_id}_requires_at_least_two_pixel_branch_points`);
      }
      const branchPoints = pixelBranchPoints.map((entry, pointIndex) => modelToSource(pixelToModel(
        entry,
        modelBounds,
        width,
        height,
        `${observation.observation_id}_pixel_branch_point_${pointIndex}`
      ), registration));
      const { pixel_branch_points: _pixelBranchPoints, ...placement } = observation.placement;
      return {
        ...rest,
        evidence_role: renderRole,
        attribute_provenance: attributeProvenance,
        point: modelToSource(modelPoint, registration),
        placement: { ...placement, branch_points: branchPoints }
      };
    }
    if (observation.kind === "air_terminal") {
      const { pixel_point: _pixelPoint, attribute_evidence: _attributeEvidence, ...rest } = observation;
      return {
        ...rest,
        evidence_role: renderRole,
        attribute_provenance: attributeProvenance,
        point: modelToSource(modelPoint, registration),
        placement: observation.placement as MepDraftPlacement
      };
    }
    const { pixel_point: _pixelPoint, attribute_evidence: _attributeEvidence, ...rest } = observation;
    return { ...rest, evidence_role: renderRole, attribute_provenance: attributeProvenance, point: modelToSource(modelPoint, registration) };
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
  const compiledPlan = compileMepDraftPlan(convertedPackage);
  if (sourceCoverageReceipt?.coverage_status === "partial") {
    compiledPlan.status = "clarification_required";
    compiledPlan.ambiguities.push({
      id: "bounded-mep-region-coverage",
      topic: "bounded MEP region coverage",
      description: `The registered region still contains unresolved source candidates: ${sourceCoverageReceipt.unresolved_candidate_ids.join(", ")}.`,
      material: true,
      confidence: 0,
      choices: [],
      material_attributes: ["complete source accounting"],
      resolution: null,
      resolution_basis: null,
      resolution_evidence_reference: null
    });
    compiledPlan.warnings.push("Resolved observations remain compiled for review, but no complete-scope workflow may run while bounded MEP region coverage is partial.");
  }
  return {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    input_fingerprint_sha256: fingerprint(input),
    registered_render_sha256: renderHash,
    registration,
    ...(sourceCoverageReceipt ? { source_coverage_receipt: sourceCoverageReceipt } : {}),
    converted_package: convertedPackage,
    compiled_plan: compiledPlan,
    usage_constraints: [
      "Registered pixels establish bounded plan geometry only; material, system, size, elevation, family, type, host, and service-topology claims remain subject to the existing MEP compiler evidence gates.",
      "A pipe or duct elevation may use declared_heuristic provenance when the plan does not show elevation; it remains an explicit inference in the compiled assumptions and is never represented as source-observed truth.",
      "A pipe route may use pipe_size_policy=unresolved_placeholder only when size is unreadable, omitted from supported source attributes, and omitted from the observation value; Revit's one-inch drafting placeholder is then explicit, non-scored, and not accepted as an engineered size.",
      "A native_connector_bridge may resolve a short concealed service stub only between an agent-visible fixture observation and an explicit hash-bound native anchor; its endpoints and elevation are runtime native inferences, not registered-pixel observations.",
      "A created_route_connector_bridge may resolve a short concealed service stub only between an agent-visible fixture observation and an explicit endpoint of source-grounded pipe geometry created earlier in the same atomic workflow; its final connector offsets and elevation are runtime native inferences.",
      "A fixture with service_connection_mode=plan_proximity records source-visible adjacency to the nearest registered route segment and emits no native connection action; it is a drafting fallback for connectorless graphics, not proof of a physically connected Revit network.",
      "A downstream_vent_tee uses registered pixels for plan geometry and either an exact hash-bound retained sanitary main or a source-grounded sanitary route created earlier in the same atomic workflow. It never represents the vent as a direct fixture connector. Native fixture reachability remains the acceptance path; plan_topology_only verifies the created sanitary-to-vent tee while explicitly withholding native fixture-reachability credit.",
      "Electrical circuit membership may use the registered render only when every newly created member has explicit legible evidence for the same printed circuit label; otherwise it must remain grounded in exact native source power-system evidence or explicit user direction.",
      "The registered render must be agent-visible, hash-bound, dimension-verified, and aligned to the declared model frame.",
      "No evaluator, withheld truth, native target identity, or scorer output is used to convert pixel observations.",
      "A bounded-region completeness claim requires a hash-bound source-coverage receipt in which every MEP-like candidate is resolved to typed observations or remains explicitly unresolved; partial coverage cannot be reported as complete."
    ]
  };
}
