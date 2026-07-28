import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJsonFile } from "./files.js";
import type { BridgeTransport, RevitWorkflowResult, RevitWorkflowVerification } from "./revit_workflows.js";
import {
  validateExistingConditionsEvaluatorVisualReceipt,
  type ExistingConditionsEvaluatorVisualReceipt
} from "../existing_conditions/evaluator_visual.js";
import type { BoundedMepRegionCoverageReceiptV1 } from "../existing_conditions/mep_region_coverage.js";

export type ExistingConditionsPoint3 = { x: number; y: number; z: number };

export type ExistingConditionsElementKind = "mep_curve" | "linear_element" | "fitting" | "family_instance" | "other";
export type ExistingConditionsDiscipline = "mechanical" | "plumbing" | "electrical" | "architectural" | "mixed" | "other";
export type ExistingConditionsRelationshipKind = "physical" | "wall_junction" | "host" | "electrical_circuit" | "system";

export type ExistingConditionsElement = {
  key: string;
  kind: ExistingConditionsElementKind;
  discipline?: ExistingConditionsDiscipline;
  role?: string | null;
  category: string;
  family?: string | null;
  type?: string | null;
  system_classification?: string | null;
  system_type?: string | null;
  location?: ExistingConditionsPoint3 | null;
  endpoints?: [ExistingConditionsPoint3, ExistingConditionsPoint3] | null;
  rotation_degrees?: number | null;
  level_name?: string | null;
  room_number?: string | null;
  space_number?: string | null;
  host_key?: string | null;
  electrical?: {
    panel?: string | null;
    circuit_number?: string | null;
    primary_label?: string | null;
    system_ids?: string[];
    power_system_ids?: string[];
    exact_power_system_count?: number;
  } | null;
  size?: {
    shape?: string | null;
    width_ft?: number | null;
    height_ft?: number | null;
    diameter_ft?: number | null;
  } | null;
  parameters?: Record<string, string | number | boolean | null>;
};

export type ExistingConditionsConnection = {
  a: string;
  b: string;
  kind?: ExistingConditionsRelationshipKind;
};

export type ExistingConditionsSnapshot = {
  native_readback: boolean;
  elements: ExistingConditionsElement[];
  connections: ExistingConditionsConnection[];
  open_connector_count: number;
};

export type ExistingConditionsEvidenceReceipt = {
  role: string;
  sha256: string;
};

export type ExistingConditionsDisciplineCoverageRequirement = {
  discipline: Exclude<ExistingConditionsDiscipline, "mixed" | "other">;
  minimum_precision: number;
  minimum_recall: number;
};

export type ExistingConditionsGroundTruth = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  discipline?: ExistingConditionsDiscipline;
  visible_evidence: ExistingConditionsEvidenceReceipt[];
  ground_truth_model?: { path: string; sha256: string };
  deletion_manifest?: {
    requested_element_ids: number[];
    deleted_element_ids: number[];
    dependent_element_ids: number[];
    dry_run_receipt_sha256: string;
  };
  evaluation_policy?: {
    require_evaluator_change_receipt?: boolean;
    /** Controls how much withheld Z may affect a plan-based reconstruction score. */
    elevation_evidence?: "plan_visible" | "project_context" | "not_visible";
    /** Prevents a dominant discipline from hiding an omitted or invented smaller discipline in a mixed fixture. */
    required_discipline_coverage?: ExistingConditionsDisciplineCoverageRequirement[];
    bounded_mep_region_coverage?: {
      required_coverage_status: "complete";
      source_evidence_sha256: string;
      registered_render_sha256: string;
      coverage_contract_sha256: string;
      region_sha256: string;
      clear_plan_visible_family_instance_keys: string[];
      /** Native MEP-curve truth keys whose visible plan trace is complete inside the bounded region. */
      clear_plan_visible_mep_curve_keys?: string[];
      /** Plan-distance tolerance used for length-weighted trace coverage. */
      route_trace_tolerance_ft?: number;
      minimum_route_trace_precision?: number;
      minimum_route_trace_recall?: number;
    };
  };
  snapshot: ExistingConditionsSnapshot;
};

export type ExistingConditionsCandidate = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  discipline?: ExistingConditionsDiscipline;
  visible_evidence: ExistingConditionsEvidenceReceipt[];
  accessed_artifact_roles: string[];
  out_of_scope_changed_element_keys: string[];
  evaluator_change_receipt?: {
    native_diff_readback: boolean;
    changed_element_keys: string[];
    out_of_scope_changed_element_keys: string[];
    receipt_sha256: string;
  } | null;
  source_coverage_receipt?: BoundedMepRegionCoverageReceiptV1 | null;
  snapshot: ExistingConditionsSnapshot;
  visual_receipt?: ExistingConditionsEvaluatorVisualReceipt | null;
};

export type ExistingConditionsScoringPolicy = {
  location_tolerance_ft: number;
  endpoint_tolerance_ft: number;
  rotation_tolerance_degrees: number;
  size_tolerance_ft: number;
  elevation_tolerance_ft: number;
  project_context_elevation_geometry_weight: number;
  unobserved_elevation_geometry_weight: number;
  minimum_pair_score: number;
  passing_score: number;
  minimum_precision: number;
  minimum_recall: number;
  minimum_connectivity_score: number;
  minimum_architectural_topology_score: number;
  minimum_system_score: number;
  minimum_spatial_score: number;
  minimum_hosting_score: number;
  minimum_electrical_circuit_score: number;
};

export type ExistingConditionsMatchedPair = {
  truth_key: string;
  candidate_key: string;
  pair_score: number;
  geometry_score: number;
  attribute_score: number;
  system_score: number;
  spatial_score: number;
  distance_ft: number | null;
  plan_distance_ft: number | null;
  elevation_difference_ft: number | null;
  elevation_score: number;
};

export type ExistingConditionsScore = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  valid_run: boolean;
  passed: boolean;
  score: number;
  elevation_evidence: "plan_visible" | "project_context" | "not_visible";
  failure_classifications: string[];
  invalid_reasons: string[];
  counts: {
    truth: number;
    candidate: number;
    matched: number;
    missed: number;
    false_positive: number;
  };
  discipline_coverage: Array<{
    discipline: Exclude<ExistingConditionsDiscipline, "mixed" | "other">;
    truth_count: number;
    candidate_count: number;
    matched_count: number;
    precision: number;
    recall: number;
    minimum_precision: number;
    minimum_recall: number;
    route_trace_precision?: number;
    route_trace_recall?: number;
    route_truth_length_ft?: number;
    route_candidate_length_ft?: number;
    passed: boolean;
  }>;
  metrics: {
    precision: number;
    recall: number;
    element_f1: number;
    geometry: number;
    elevation: number;
    attributes: number;
    connectivity: number;
    architectural_topology: number;
    systems: number;
    spatial: number;
    hosting: number;
    electrical_circuits: number;
    drawing_evidence: number;
    mep_region_precision?: number;
    mep_region_recall?: number;
    /** Plan-trace recovery without requiring a supported system/type claim. */
    mep_route_geometry_precision?: number;
    mep_route_geometry_recall?: number;
    mep_route_geometry_f1?: number;
    /** Strict plan-trace recovery with system classification and type agreement. */
    mep_route_trace_precision?: number;
    mep_route_trace_recall?: number;
    mep_route_trace_f1?: number;
    truth_route_length_ft?: number;
    candidate_route_length_ft?: number;
  };
  applicability: {
    physical_connectivity: boolean;
    architectural_topology: boolean;
    systems: boolean;
    spatial: boolean;
    hosting: boolean;
    electrical_circuits: boolean;
    discipline_coverage: boolean;
    bounded_mep_region?: boolean;
    bounded_mep_route_trace?: boolean;
  };
  matched_pairs: ExistingConditionsMatchedPair[];
  missed_truth_keys: string[];
  false_positive_candidate_keys: string[];
};

export type ExistingConditionsSnapshotNormalizationOptions = {
  selected_element_ids: number[];
  require_connector_readback?: boolean;
};

export const DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY: ExistingConditionsScoringPolicy = {
  location_tolerance_ft: 1,
  endpoint_tolerance_ft: 1,
  rotation_tolerance_degrees: 10,
  size_tolerance_ft: 1 / 48,
  elevation_tolerance_ft: 3,
  project_context_elevation_geometry_weight: 0.2,
  unobserved_elevation_geometry_weight: 0.05,
  minimum_pair_score: 0.45,
  passing_score: 85,
  minimum_precision: 0.8,
  minimum_recall: 0.8,
  minimum_connectivity_score: 0.75,
  minimum_architectural_topology_score: 0.8,
  minimum_system_score: 0.8,
  minimum_spatial_score: 0.8,
  minimum_hosting_score: 0.75,
  minimum_electrical_circuit_score: 1
};

const FORBIDDEN_AGENT_ARTIFACT_ROLES = new Set([
  "ground_truth",
  "ground_truth_model",
  "ground_truth_snapshot",
  "truth_manifest",
  "deletion_manifest",
  "withheld_evaluator_package",
  "evaluator_native_evidence",
  "evaluator_provenance",
  "evaluator_signing_key",
  "evaluator_native_adapter_config"
]);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of ["internalValue", "internal_value", "valueInternal", "value_internal", "value", "rawValue", "raw_value"]) {
      const parsed = finiteNumber(obj[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function point3(value: unknown): ExistingConditionsPoint3 | null {
  if (Array.isArray(value)) {
    const x = finiteNumber(value[0]);
    const y = finiteNumber(value[1]);
    const z = finiteNumber(value[2] ?? 0);
    return x === null || y === null || z === null ? null : { x, y, z };
  }
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const x = finiteNumber(obj.x ?? obj.X);
  const y = finiteNumber(obj.y ?? obj.Y);
  const z = finiteNumber(obj.z ?? obj.Z ?? 0);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function objectRows(value: unknown): JsonMap[] {
  return Array.isArray(value) ? value.map(asObject).filter((row) => Object.keys(row).length > 0) : [];
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return null;
}

function primitiveParameters(value: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(asObject(value))) {
    if (raw === null || typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[key] = raw;
      continue;
    }
    const obj = asObject(raw);
    const scalar = obj.internalValue ?? obj.internal_value ?? obj.valueInternal ?? obj.value_internal ?? obj.value ?? obj.displayValue ?? obj.display_value;
    if (scalar === null || typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean") {
      out[key] = scalar as string | number | boolean | null;
    }
  }
  return out;
}

function connectorSize(raw: JsonMap): JsonMap {
  const summary = asObject(raw.connectorsSummary ?? raw.connectors_summary);
  const rows = objectRows(summary.sampleConnectors ?? summary.sample_connectors ?? summary.connectors ?? summary.items ?? summary.results);
  for (const row of rows) {
    const size = asObject(row.size);
    if (Object.keys(size).length > 0) return size;
  }
  return {};
}

function inferDiscipline(
  category: string,
  evidence: { explicit?: unknown; systemClassification?: unknown; systemType?: unknown } = {}
): ExistingConditionsDiscipline {
  const key = normalized(category);
  const explicit = normalized(evidence.explicit);
  if (["architectural", "mechanical", "plumbing", "electrical"].includes(explicit)) {
    return explicit as ExistingConditionsDiscipline;
  }
  if (/wall|door|window|room|floor|ceiling|roof|column/.test(key)) return "architectural";
  if (/electrical|lighting|fire alarm|data device|communication device/.test(key)) return "electrical";
  if (/plumbing fixture|sanitary|domestic|sprinkler/.test(key)) return "plumbing";
  if (/duct|mechanical equipment|air terminal/.test(key)) return "mechanical";
  if (/pipe/.test(key)) {
    const systemEvidence = normalized(`${String(evidence.systemClassification ?? "")} ${String(evidence.systemType ?? "")}`);
    const plumbing = /\b(sanitary|domestic|waste|vent|storm|sewer|plumbing|fire protection|sprinkler)\b/.test(systemEvidence);
    const mechanical = /\b(hydronic|chilled water|heating hot water|steam|condensate|condenser water|refrigerant)\b/.test(systemEvidence);
    return plumbing === mechanical ? "other" : plumbing ? "plumbing" : "mechanical";
  }
  return "other";
}

function inferRole(category: string): string {
  const key = normalized(category);
  if (/wall/.test(key)) return "wall";
  if (/door/.test(key)) return "door";
  if (/window/.test(key)) return "window";
  if (/room/.test(key)) return "room";
  if (/duct terminal|air terminal/.test(key)) return "air_terminal";
  if (/duct fitting/.test(key)) return "duct_fitting";
  if (/duct/.test(key)) return "duct";
  if (/pipe fitting/.test(key)) return "pipe_fitting";
  if (/pipe accessory/.test(key)) return "pipe_accessory";
  if (/pipe/.test(key)) return "pipe";
  if (/plumbing fixture/.test(key)) return "plumbing_fixture";
  if (/electrical fixture/.test(key)) return "electrical_device";
  if (/electrical equipment/.test(key)) return "electrical_equipment";
  if (/lighting fixture/.test(key)) return "light_fixture";
  if (/lighting device/.test(key)) return "lighting_device";
  if (/fire alarm/.test(key)) return "fire_alarm_device";
  if (/data device/.test(key)) return "data_device";
  if (/communication device/.test(key)) return "communication_device";
  if (/mechanical equipment/.test(key)) return "mechanical_equipment";
  return "other";
}

function spatialNumber(value: unknown): string | null {
  const obj = asObject(value);
  return firstText(obj.number, obj.Number, obj.name, obj.Name);
}

function idKeys(value: unknown, prefix: string): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(finiteNumber).filter((id): id is number => id !== null && id > 0).map((id) => `${prefix}:${Math.trunc(id)}`))]
    : [];
}

function normalizedElementFromVisible(raw: JsonMap): { id: number; element: ExistingConditionsElement } | null {
  const id = finiteNumber(raw.elementId ?? raw.element_id ?? raw.id);
  if (id === null || id <= 0) return null;
  const category = firstText(raw.category, raw.categoryToken, raw.category_token, raw.builtInCategory, raw.built_in_category) ?? "Unknown";
  const geometry = asObject(raw.geometry);
  const start = point3(asObject(geometry.start).model ?? geometry.start);
  const end = point3(asObject(geometry.end).model ?? geometry.end);
  const location = point3(raw.point) ?? point3(asObject(raw.anchor).model) ?? point3(raw.center) ?? point3(raw.bboxCenter ?? raw.bbox_center);
  const categoryKey = normalized(category);
  const kind: ExistingConditionsElementKind = /fitting|accessor/.test(categoryKey)
    ? "fitting"
    : (start && end && /wall/.test(categoryKey))
      ? "linear_element"
    : (start && end && /duct|pipe|conduit|tray/.test(categoryKey))
      ? "mep_curve"
      : (raw.familyName || raw.family_name || raw.typeName || raw.type_name)
        ? "family_instance"
        : "other";
  const orientation = asObject(raw.orientation);
  const radians = finiteNumber(orientation.planAzimuthRadians ?? orientation.plan_azimuth_radians ?? orientation.rotationRadians ?? orientation.rotation_radians);
  const parameters = primitiveParameters(raw.parameters);
  const sizeFromConnector = connectorSize(raw);
  const system = asObject(raw.system);
  const systemClassification = firstText(raw.systemClassification, raw.system_classification, system.systemClassification, system.system_classification);
  const systemType = firstText(system.systemType, system.system_type, parameters.systemType);
  const electricalCircuit = asObject(raw.electricalCircuit ?? raw.electrical_circuit);
  const systemIds = idKeys(electricalCircuit.systemIds ?? electricalCircuit.system_ids, "electrical-system");
  const powerSystemIds = idKeys(electricalCircuit.powerSystemIds ?? electricalCircuit.power_system_ids, "electrical-system");
  const host = asObject(raw.host);
  const hostingSurface = asObject(raw.hostingSurface ?? raw.hosting_surface);
  return {
    id,
    element: {
      key: firstText(raw.sourceScopedId, raw.source_scoped_id, `host:${Math.trunc(id)}`)!,
      kind,
      discipline: inferDiscipline(category, {
        explicit: raw.discipline,
        systemClassification,
        systemType
      }),
      role: inferRole(category),
      category,
      family: firstText(raw.familyName, raw.family_name),
      type: firstText(raw.typeName, raw.type_name, raw.name),
      system_classification: systemClassification,
      system_type: systemType,
      location,
      endpoints: start && end ? [start, end] : null,
      rotation_degrees: radians === null ? null : radians * 180 / Math.PI,
      level_name: firstText(raw.levelName, raw.level_name),
      room_number: spatialNumber(raw.room),
      space_number: spatialNumber(raw.space ?? raw.associatedSpatial ?? raw.associated_spatial),
      host_key: firstText(
        raw.hostResolvedScopedId,
        raw.host_resolved_scoped_id,
        raw.hostLinkedElementScopedId,
        raw.host_linked_element_scoped_id,
        raw.hostScopedId,
        raw.host_scoped_id,
        host.resolvedScopedId,
        host.resolved_scoped_id,
        host.scopedId,
        host.scoped_id,
        hostingSurface.linkedElementScopedId,
        hostingSurface.linked_element_scoped_id,
        hostingSurface.hostElementScopedId,
        hostingSurface.host_element_scoped_id
      ),
      electrical: systemIds.length > 0 || powerSystemIds.length > 0 || firstText(electricalCircuit.panel, parameters.panel, electricalCircuit.circuitNumber, parameters.circuitNumber)
        ? {
            panel: firstText(electricalCircuit.panel, parameters.panel),
            circuit_number: firstText(electricalCircuit.circuitNumber, electricalCircuit.circuit_number, parameters.circuitNumber),
            primary_label: firstText(electricalCircuit.primaryLabel, electricalCircuit.primary_label),
            system_ids: systemIds,
            power_system_ids: powerSystemIds,
            exact_power_system_count: finiteNumber(electricalCircuit.exactPowerSystemCount ?? electricalCircuit.exact_power_system_count) ?? powerSystemIds.length
          }
        : null,
      size: {
        shape: firstText(sizeFromConnector.kind, sizeFromConnector.shape),
        width_ft: finiteNumber(sizeFromConnector.widthFt ?? sizeFromConnector.width_ft ?? parameters.width),
        height_ft: finiteNumber(sizeFromConnector.heightFt ?? sizeFromConnector.height_ft ?? parameters.height),
        diameter_ft: finiteNumber(sizeFromConnector.diameterFt ?? sizeFromConnector.diameter_ft ?? parameters.diameter)
      },
      parameters
    }
  };
}

export function normalizeExistingConditionsSnapshot(
  visibleElementsPayload: unknown,
  connectorsPayload: unknown,
  options: ExistingConditionsSnapshotNormalizationOptions
): ExistingConditionsSnapshot {
  const selectedIds = new Set(options.selected_element_ids.filter((id) => Number.isInteger(id) && id > 0));
  const visible = asObject(visibleElementsPayload);
  const normalizedRows = objectRows(visible.items ?? visible.elements)
    .map(normalizedElementFromVisible)
    .filter((entry): entry is { id: number; element: ExistingConditionsElement } => entry !== null && selectedIds.has(Math.trunc(entry.id)));
  const idToKey = new Map(normalizedRows.map((entry) => [Math.trunc(entry.id), entry.element.key]));
  const connectorRoot = asObject(connectorsPayload);
  const connectorRows = objectRows(connectorRoot.results ?? connectorRoot.items);
  const seenConnectorIds = new Set<number>();
  const relations = new Set<string>();
  let openConnectorCount = 0;
  for (const row of connectorRows) {
    const id = finiteNumber(row.id ?? row.elementId ?? row.element_id);
    if (id === null || !selectedIds.has(Math.trunc(id)) || row.ok === false) continue;
    const ownerKey = idToKey.get(Math.trunc(id));
    if (!ownerKey) continue;
    seenConnectorIds.add(Math.trunc(id));
    for (const connector of objectRows(row.connectors)) {
      const explicitPhysical = connector.physicalConnectedTo ?? connector.physical_connected_to;
      const refs = explicitPhysical !== undefined
        ? objectRows(explicitPhysical)
        : objectRows(connector.connectedTo ?? connector.connected_to).filter((ref) => {
          if (ref.isPhysicalElement === false || ref.is_physical_element === false || ref.isMepSystem === true || ref.is_mep_system === true) return false;
          return !/system$/i.test(String(ref.ownerCategory ?? ref.owner_category ?? ""));
        });
      if (refs.length === 0) openConnectorCount += 1;
      for (const ref of refs) {
        const refId = finiteNumber(ref.ownerId ?? ref.owner_id ?? ref.id);
        if (refId === null || Math.trunc(refId) === Math.trunc(id)) continue;
        const refKey = idToKey.get(Math.trunc(refId)) ?? `host:${Math.trunc(refId)}`;
        relations.add(canonicalRelation("physical", ownerKey, refKey));
      }
    }
  }
  for (const entry of normalizedRows) {
    if (entry.element.host_key) relations.add(canonicalRelation("host", entry.element.key, entry.element.host_key));
    for (const systemKey of entry.element.electrical?.power_system_ids ?? []) {
      relations.add(canonicalRelation("electrical_circuit", entry.element.key, systemKey));
    }
  }
  const walls = normalizedRows
    .map((entry) => entry.element)
    .filter((element) => element.discipline === "architectural" && element.role === "wall" && element.endpoints);
  for (let i = 0; i < walls.length; i += 1) {
    for (let j = i + 1; j < walls.length; j += 1) {
      const a = walls[i]!;
      const b = walls[j]!;
      if (segmentsMeet2d(a.endpoints!, b.endpoints!, 0.25)) {
        relations.add(canonicalRelation("wall_junction", a.key, b.key));
      }
    }
  }
  const nativeReadback = selectedIds.size > 0 &&
    normalizedRows.length === selectedIds.size &&
    (options.require_connector_readback === false || seenConnectorIds.size === selectedIds.size);
  return {
    native_readback: nativeReadback,
    elements: normalizedRows.map((entry) => entry.element),
    connections: [...relations].map((encoded) => {
      const [kind, a, b] = JSON.parse(encoded) as [ExistingConditionsRelationshipKind, string, string];
      return { a, b, kind };
    }),
    open_connector_count: openConnectorCount
  };
}

/**
 * Combines host-model visible-element exports from multiple discipline views.
 * Existing-condition captures deliberately request includeLinked=false, so a
 * host ElementId is a stable deduplication key across the supplied views.
 */
export function mergeExistingConditionsVisibleElementPayloads(
  payloads: unknown[],
  viewIds: number[] = []
): Record<string, unknown> {
  if (payloads.length === 0) throw new Error("visible_element_payloads_required");
  const itemsById = new Map<number, Record<string, unknown>>();
  const warnings: string[] = [];
  let scanned = 0;
  let truncated = false;
  for (const payload of payloads) {
    const root = asObject(payload);
    scanned += finiteNumber(root.scanned) ?? 0;
    truncated = truncated || root.truncated === true;
    for (const warning of Array.isArray(root.warnings) ? root.warnings : []) {
      const text = String(warning ?? "").trim();
      if (text) warnings.push(text);
    }
    for (const row of objectRows(root.items ?? root.elements)) {
      const id = finiteNumber(row.id ?? row.elementId ?? row.element_id);
      if (id === null || Math.trunc(id) <= 0) continue;
      if (!itemsById.has(Math.trunc(id))) itemsById.set(Math.trunc(id), row);
    }
  }
  const items = [...itemsById.values()];
  return {
    schema_version: 1,
    viewIds: [...new Set(viewIds.filter((id) => Number.isInteger(id) && id > 0))],
    count: items.length,
    scanned,
    truncated,
    items,
    warnings: [...new Set(warnings)]
  };
}

/**
 * Merges category-batched exports from one unchanged view while retaining the
 * first export's raster frame. Linked rows require sourceScopedId so identical
 * native ElementIds from different documents cannot collide.
 */
export function mergeExistingConditionsSameViewVisibleElementPayloads(
  payloads: unknown[],
  viewId: number,
  includeLinked: boolean
): Record<string, unknown> {
  if (payloads.length === 0) throw new Error("visible_element_payloads_required");
  if (!Number.isSafeInteger(viewId) || viewId <= 0) throw new Error("visible_element_view_id_is_required");
  const first = asObject(payloads[0]);
  const firstWidth = finiteNumber(first.widthPx ?? first.width_px);
  const firstHeight = finiteNumber(first.heightPx ?? first.height_px);
  const firstMapping = JSON.stringify(asObject(first.mapping));
  if (firstWidth === null || firstHeight === null || firstWidth <= 0 || firstHeight <= 0 || !firstMapping || firstMapping === "{}") {
    throw new Error("visible_element_stable_raster_mapping_is_required");
  }
  const itemsByScope = new Map<string, JsonMap>();
  const warnings: string[] = [];
  let scanned = 0;
  for (const payload of payloads) {
    const root = asObject(payload);
    if (root.truncated === true) throw new Error("visible_element_inventory_is_truncated");
    if (finiteNumber(root.viewId ?? root.view_id) !== viewId ||
        finiteNumber(root.widthPx ?? root.width_px) !== firstWidth ||
        finiteNumber(root.heightPx ?? root.height_px) !== firstHeight ||
        JSON.stringify(asObject(root.mapping)) !== firstMapping) {
      throw new Error("visible_element_batch_raster_mismatch");
    }
    scanned += finiteNumber(root.scanned) ?? 0;
    for (const warning of Array.isArray(root.warnings) ? root.warnings : []) {
      const text = String(warning ?? "").trim();
      if (text) warnings.push(text);
    }
    for (const row of objectRows(root.items ?? root.elements)) {
      const id = finiteNumber(row.elementId ?? row.element_id ?? row.id);
      if (id === null || !Number.isSafeInteger(id) || id <= 0) continue;
      const scopedId = firstText(row.sourceScopedId, row.source_scoped_id);
      if (includeLinked && !scopedId) throw new Error("linked_visible_element_requires_source_scoped_id");
      const key = normalized(scopedId ?? `host:${Math.trunc(id)}`);
      if (!itemsByScope.has(key)) itemsByScope.set(key, row);
    }
  }
  const items = [...itemsByScope.values()];
  return {
    ...first,
    count: items.length,
    scanned,
    truncated: false,
    items,
    warnings: [...new Set(warnings)],
    categoryBatches: payloads.map((payload) => {
      const root = asObject(payload);
      return { frameId: root.frameId ?? root.frame_id ?? null, count: root.count ?? 0 };
    })
  };
}

export type ExistingConditionsImageRegion = {
  min_x_px: number;
  min_y_px: number;
  max_x_px: number;
  max_y_px: number;
};

export type ExistingConditionsImageScopeReceipt = {
  schema_version: 1;
  frame_id: string;
  view_id: number;
  raster_width_px: number;
  raster_height_px: number;
  raster_mapping: JsonMap;
  region: ExistingConditionsImageRegion;
  padding_px: number;
  /**
   * True for receipts that may be passed to the native connector-capture lane.
   * False marks an evaluator-only scope that may contain link-scoped elements.
   */
  host_scope_required: boolean;
  scope_mode?: "host_only" | "host_and_linked";
  level_names?: string[];
  selected_element_ids: number[];
  selected_scoped_ids?: string[];
  selected_count: number;
  selected_by_category: Record<string, number>;
  selected: Array<{
    element_id: number;
    source_scoped_id: string;
    source_scope?: "host" | "linked";
    category: string;
    selection_basis: "bbox_intersection" | "geometry_intersection" | "point_inside";
  }>;
};

function imagePoint(value: unknown): { x: number; y: number } | null {
  const obj = asObject(value);
  const x = finiteNumber(obj.x ?? obj.X);
  const y = finiteNumber(obj.y ?? obj.Y);
  return x === null || y === null ? null : { x, y };
}

function imageBounds(value: unknown): ExistingConditionsImageRegion | null {
  const image = asObject(value);
  const minX = finiteNumber(image.minX ?? image.min_x);
  const minY = finiteNumber(image.minY ?? image.min_y);
  const maxX = finiteNumber(image.maxX ?? image.max_x);
  const maxY = finiteNumber(image.maxY ?? image.max_y);
  if (minX === null || minY === null || maxX === null || maxY === null || maxX < minX || maxY < minY) return null;
  return { min_x_px: minX, min_y_px: minY, max_x_px: maxX, max_y_px: maxY };
}

function geometryImageBounds(row: JsonMap): ExistingConditionsImageRegion | null {
  const geometry = asObject(row.geometry);
  const points = [
    imagePoint(asObject(geometry.start).image),
    imagePoint(asObject(geometry.end).image),
    imagePoint(asObject(geometry.point).image),
    imagePoint(asObject(geometry.location).image)
  ].filter((entry): entry is { x: number; y: number } => entry !== null);
  if (points.length === 0) return null;
  return {
    min_x_px: Math.min(...points.map((entry) => entry.x)),
    min_y_px: Math.min(...points.map((entry) => entry.y)),
    max_x_px: Math.max(...points.map((entry) => entry.x)),
    max_y_px: Math.max(...points.map((entry) => entry.y))
  };
}

function regionsIntersect(a: ExistingConditionsImageRegion, b: ExistingConditionsImageRegion): boolean {
  return a.max_x_px >= b.min_x_px && a.min_x_px <= b.max_x_px &&
    a.max_y_px >= b.min_y_px && a.min_y_px <= b.max_y_px;
}

function pointInsideRegion(point: { x: number; y: number }, region: ExistingConditionsImageRegion): boolean {
  return point.x >= region.min_x_px && point.x <= region.max_x_px &&
    point.y >= region.min_y_px && point.y <= region.max_y_px;
}

/**
 * Selects native host elements that overlap a registered plan-image region.
 * The input is the unmodified result of /revit/export-visible-elements for one
 * view. A truncated inventory is rejected because it cannot be evaluator truth.
 */
export function selectExistingConditionsImageScope(
  visibleElementsPayload: unknown,
  requestedRegion: ExistingConditionsImageRegion,
  options: { padding_px?: number; include_linked?: boolean; level_names?: string[] } = {}
): ExistingConditionsImageScopeReceipt {
  const root = asObject(visibleElementsPayload);
  if (root.truncated === true) throw new Error("visible_element_inventory_is_truncated");
  const width = finiteNumber(root.widthPx ?? root.width_px);
  const height = finiteNumber(root.heightPx ?? root.height_px);
  const viewId = finiteNumber(root.viewId ?? root.view_id);
  const frameId = firstText(root.frameId, root.frame_id);
  const rasterMapping = asObject(root.mapping);
  if (width === null || height === null || width <= 0 || height <= 0) throw new Error("visible_element_raster_dimensions_are_required");
  if (viewId === null || !Number.isSafeInteger(viewId) || viewId <= 0) throw new Error("visible_element_view_id_is_required");
  if (!frameId) throw new Error("visible_element_frame_id_is_required");
  if (Object.keys(rasterMapping).length === 0 || !["2d_affine", "2d affine"].includes(normalized(rasterMapping.mode))) {
    throw new Error("visible_element_2d_affine_mapping_is_required");
  }
  const regionValues = [requestedRegion.min_x_px, requestedRegion.min_y_px, requestedRegion.max_x_px, requestedRegion.max_y_px];
  if (regionValues.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("image_region_must_be_finite");
  if (requestedRegion.min_x_px < 0 || requestedRegion.min_y_px < 0 ||
      requestedRegion.max_x_px > width || requestedRegion.max_y_px > height ||
      requestedRegion.max_x_px <= requestedRegion.min_x_px || requestedRegion.max_y_px <= requestedRegion.min_y_px) {
    throw new Error("image_region_must_be_inside_raster");
  }
  const padding = options.padding_px ?? 0;
  if (!Number.isFinite(padding) || padding < 0) throw new Error("image_region_padding_must_be_nonnegative");
  const region: ExistingConditionsImageRegion = {
    min_x_px: Math.max(0, requestedRegion.min_x_px - padding),
    min_y_px: Math.max(0, requestedRegion.min_y_px - padding),
    max_x_px: Math.min(width, requestedRegion.max_x_px + padding),
    max_y_px: Math.min(height, requestedRegion.max_y_px + padding)
  };
  const selected: ExistingConditionsImageScopeReceipt["selected"] = [];
  const includeLinked = options.include_linked === true;
  const levelNames = [...new Set((options.level_names ?? []).map((entry) => String(entry).trim()).filter(Boolean))];
  const normalizedLevelNames = new Set(levelNames.map(normalized));
  for (const row of objectRows(root.items ?? root.elements)) {
    const id = finiteNumber(row.elementId ?? row.element_id ?? row.id);
    if (id === null || !Number.isSafeInteger(id) || id <= 0) continue;
    const sourceScopedId = firstText(row.sourceScopedId, row.source_scoped_id);
    const sourceScope = normalized(asObject(row.source).scope);
    const normalizedScopedId = normalized(sourceScopedId);
    const validHostIdentity = sourceScope === "host" && normalizedScopedId === `host:${Math.trunc(id)}`;
    const linkedIdentityMatch = /^link:(\d+):(\d+)$/.exec(normalizedScopedId);
    const validLinkedIdentity = sourceScope === "linked" && linkedIdentityMatch !== null &&
      Number(linkedIdentityMatch[1]) > 0 && Number(linkedIdentityMatch[2]) === Math.trunc(id);
    if (!validHostIdentity && !(includeLinked && validLinkedIdentity)) continue;
    if (normalizedLevelNames.size > 0 && !normalizedLevelNames.has(normalized(row.levelName ?? row.level_name))) continue;
    const bbox = imageBounds(asObject(row.bbox).image ?? row.bbox);
    const geometryBounds = geometryImageBounds(row);
    const anchor = imagePoint(asObject(row.anchor).image);
    const selectionBasis = bbox && regionsIntersect(bbox, region)
      ? "bbox_intersection"
      : geometryBounds && regionsIntersect(geometryBounds, region)
        ? "geometry_intersection"
        : anchor && pointInsideRegion(anchor, region)
          ? "point_inside"
          : null;
    if (!selectionBasis) continue;
    selected.push({
      element_id: Math.trunc(id),
      source_scoped_id: sourceScopedId!,
      source_scope: validHostIdentity ? "host" : "linked",
      category: firstText(row.category, row.categoryToken, row.category_token, row.builtInCategory, row.built_in_category) ?? "Unknown",
      selection_basis: selectionBasis
    });
  }
  selected.sort((a, b) => {
    if (a.source_scope !== b.source_scope) return a.source_scope === "host" ? -1 : 1;
    if (a.source_scope === "host") return a.element_id - b.element_id;
    const aLinkId = Number(/^link:(\d+):/.exec(a.source_scoped_id)?.[1] ?? 0);
    const bLinkId = Number(/^link:(\d+):/.exec(b.source_scoped_id)?.[1] ?? 0);
    return aLinkId - bLinkId || a.element_id - b.element_id;
  });
  const selectedByCategory: Record<string, number> = {};
  for (const row of selected) selectedByCategory[row.category] = (selectedByCategory[row.category] ?? 0) + 1;
  return {
    schema_version: 1,
    frame_id: frameId,
    view_id: Math.trunc(viewId),
    raster_width_px: width,
    raster_height_px: height,
    raster_mapping: rasterMapping,
    region,
    padding_px: padding,
    host_scope_required: !includeLinked,
    scope_mode: includeLinked ? "host_and_linked" : "host_only",
    ...(levelNames.length > 0 ? { level_names: levelNames } : {}),
    selected_element_ids: selected.filter((entry) => entry.source_scope === "host").map((entry) => entry.element_id).sort((a, b) => a - b),
    selected_scoped_ids: selected.map((entry) => entry.source_scoped_id),
    selected_count: selected.length,
    selected_by_category: selectedByCategory,
    selected
  };
}

/** Recomputes a stored scope against a fresh export before native capture. */
export function validateExistingConditionsImageScopeAgainstVisibleInventory(
  scope: ExistingConditionsImageScopeReceipt,
  visibleElementsPayload: unknown
): ExistingConditionsImageScopeReceipt {
  if (!scope || scope.schema_version !== 1 || typeof scope.host_scope_required !== "boolean") {
    throw new Error("image_scope_receipt_is_invalid");
  }
  const root = asObject(visibleElementsPayload);
  const currentViewId = finiteNumber(root.viewId ?? root.view_id);
  if (currentViewId !== scope.view_id) throw new Error("image_scope_view_mismatch");
  if (JSON.stringify(asObject(root.mapping)) !== JSON.stringify(asObject(scope.raster_mapping))) {
    throw new Error("image_scope_raster_mapping_mismatch");
  }
  const recomputed = selectExistingConditionsImageScope(visibleElementsPayload, scope.region, {
    include_linked: scope.host_scope_required === false,
    level_names: scope.level_names
  });
  if (recomputed.raster_width_px !== scope.raster_width_px || recomputed.raster_height_px !== scope.raster_height_px) {
    throw new Error("image_scope_raster_dimensions_mismatch");
  }
  const expectedScopeMode = scope.scope_mode ?? (scope.host_scope_required ? "host_only" : "host_and_linked");
  const expectedScopedIds = scope.selected_scoped_ids ?? scope.selected.map((entry) => entry.source_scoped_id);
  const legacySelectedRows = scope.selected.every((entry) => entry.source_scope === undefined);
  const comparableRecomputedSelected = legacySelectedRows
    ? recomputed.selected.map(({ source_scope: _sourceScope, ...entry }) => entry)
    : recomputed.selected;
  if (recomputed.scope_mode !== expectedScopeMode ||
      JSON.stringify(recomputed.level_names ?? []) !== JSON.stringify(scope.level_names ?? []) ||
      JSON.stringify(recomputed.selected_element_ids) !== JSON.stringify(scope.selected_element_ids) ||
      JSON.stringify(recomputed.selected_scoped_ids) !== JSON.stringify(expectedScopedIds) ||
      JSON.stringify(comparableRecomputedSelected) !== JSON.stringify(scope.selected)) {
    throw new Error("image_scope_selected_elements_mismatch");
  }
  return recomputed;
}

function pointDistance(a: ExistingConditionsPoint3, b: ExistingConditionsPoint3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function pointDistance2d(a: ExistingConditionsPoint3, b: ExistingConditionsPoint3): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointToSegmentDistance2d(
  point: ExistingConditionsPoint3,
  segment: [ExistingConditionsPoint3, ExistingConditionsPoint3]
): number {
  const [a, b] = segment;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  if (denominator <= Number.EPSILON) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp01(((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function segmentLength2d(segment: [ExistingConditionsPoint3, ExistingConditionsPoint3]): number {
  return pointDistance2d(segment[0], segment[1]);
}

function routeSystemCompatible(source: ExistingConditionsElement, target: ExistingConditionsElement): boolean {
  if (normalized(source.discipline) !== normalized(target.discipline)) return false;
  const sourceClassification = normalized(source.system_classification);
  const targetClassification = normalized(target.system_classification);
  if ((sourceClassification || targetClassification) && sourceClassification !== targetClassification) return false;
  const sourceSystemType = normalized(source.system_type);
  const targetSystemType = normalized(target.system_type);
  return !(sourceSystemType || targetSystemType) || sourceSystemType === targetSystemType;
}

function routeMedium(element: ExistingConditionsElement): string {
  const routeIdentity = `${normalized(element.role)} ${normalized(element.category)}`;
  if (routeIdentity.includes("cable tray")) return "cable_tray";
  if (routeIdentity.includes("conduit")) return "conduit";
  if (routeIdentity.includes("duct")) return "duct";
  if (routeIdentity.includes("pipe")) return "pipe";
  return "";
}

function routeGeometryCompatible(source: ExistingConditionsElement, target: ExistingConditionsElement): boolean {
  if (source.kind !== "mep_curve" || target.kind !== "mep_curve") return false;
  if (normalized(source.discipline) !== normalized(target.discipline)) return false;
  const sourceMedium = routeMedium(source);
  const targetMedium = routeMedium(target);
  return !(sourceMedium && targetMedium) || sourceMedium === targetMedium;
}

function routeTraceCompatible(source: ExistingConditionsElement, target: ExistingConditionsElement): boolean {
  if (!routeGeometryCompatible(source, target)) return false;
  const sourceMedium = routeMedium(source);
  const targetMedium = routeMedium(target);
  return Boolean(sourceMedium) && sourceMedium === targetMedium && routeSystemCompatible(source, target);
}

function isRouteSupportingFitting(
  element: ExistingConditionsElement,
  routes: ExistingConditionsElement[],
  snapshot: ExistingConditionsSnapshot,
  toleranceFt: number
): boolean {
  if (element.kind !== "fitting" || !["pipe_fitting", "duct_fitting", "conduit_fitting"].includes(normalized(element.role))) return false;
  const routeByKey = new Map(routes.map((route) => [route.key, route]));
  const physicallyConnectedRoute = snapshot.connections.some((edge) => {
    if (relationshipKind(edge) !== "physical") return false;
    const otherKey = edge.a === element.key ? edge.b : edge.b === element.key ? edge.a : null;
    return otherKey !== null && routeByKey.has(otherKey);
  });
  if (physicallyConnectedRoute && routes.some((route) => normalized(route.discipline) === normalized(element.discipline))) return true;
  if (!element.location) return false;
  return routes.some((route) => route.endpoints && routeSystemCompatible(route, element) &&
    Math.min(pointDistance2d(element.location!, route.endpoints[0]), pointDistance2d(element.location!, route.endpoints[1])) <= toleranceFt);
}

function sampledRouteCoverage(
  source: ExistingConditionsElement[],
  target: ExistingConditionsElement[],
  toleranceFt: number,
  compatible: (source: ExistingConditionsElement, target: ExistingConditionsElement) => boolean = routeTraceCompatible
): { covered_length_ft: number; total_length_ft: number; ratio: number } {
  let coveredLength = 0;
  let totalLength = 0;
  const sampleSpacingFt = Math.max(0.02, Math.min(0.25, toleranceFt / 2));
  for (const sourceElement of source) {
    if (!sourceElement.endpoints) continue;
    const length = segmentLength2d(sourceElement.endpoints);
    if (length <= Number.EPSILON) continue;
    const intervalCount = Math.max(1, Math.ceil(length / sampleSpacingFt));
    const intervalLength = length / intervalCount;
    const compatibleTargets = target.filter((targetElement) =>
      Boolean(targetElement.endpoints) && compatible(sourceElement, targetElement)
    );
    totalLength += length;
    for (let index = 0; index < intervalCount; index += 1) {
      const t = (index + 0.5) / intervalCount;
      const point = {
        x: sourceElement.endpoints[0].x + t * (sourceElement.endpoints[1].x - sourceElement.endpoints[0].x),
        y: sourceElement.endpoints[0].y + t * (sourceElement.endpoints[1].y - sourceElement.endpoints[0].y),
        z: sourceElement.endpoints[0].z + t * (sourceElement.endpoints[1].z - sourceElement.endpoints[0].z)
      };
      if (compatibleTargets.some((targetElement) => pointToSegmentDistance2d(point, targetElement.endpoints!) <= toleranceFt)) {
        coveredLength += intervalLength;
      }
    }
  }
  return {
    covered_length_ft: coveredLength,
    total_length_ft: totalLength,
    ratio: totalLength > Number.EPSILON ? clamp01(coveredLength / totalLength) : 0
  };
}

function segmentsMeet2d(
  a: [ExistingConditionsPoint3, ExistingConditionsPoint3],
  b: [ExistingConditionsPoint3, ExistingConditionsPoint3],
  toleranceFt: number
): boolean {
  const zGap = Math.min(
    Math.abs(a[0].z - b[0].z),
    Math.abs(a[0].z - b[1].z),
    Math.abs(a[1].z - b[0].z),
    Math.abs(a[1].z - b[1].z)
  );
  if (zGap > toleranceFt) return false;
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

function endpointDistance(
  truth: [ExistingConditionsPoint3, ExistingConditionsPoint3],
  candidate: [ExistingConditionsPoint3, ExistingConditionsPoint3]
): number {
  const forward = Math.max(pointDistance(truth[0], candidate[0]), pointDistance(truth[1], candidate[1]));
  const reverse = Math.max(pointDistance(truth[0], candidate[1]), pointDistance(truth[1], candidate[0]));
  return Math.min(forward, reverse);
}

function endpointPlanAndElevationDistance(
  truth: [ExistingConditionsPoint3, ExistingConditionsPoint3],
  candidate: [ExistingConditionsPoint3, ExistingConditionsPoint3]
): { plan_distance_ft: number; elevation_difference_ft: number } {
  const variants = [
    {
      plan_distance_ft: Math.max(pointDistance2d(truth[0], candidate[0]), pointDistance2d(truth[1], candidate[1])),
      elevation_difference_ft: Math.max(Math.abs(truth[0].z - candidate[0].z), Math.abs(truth[1].z - candidate[1].z))
    },
    {
      plan_distance_ft: Math.max(pointDistance2d(truth[0], candidate[1]), pointDistance2d(truth[1], candidate[0])),
      elevation_difference_ft: Math.max(Math.abs(truth[0].z - candidate[1].z), Math.abs(truth[1].z - candidate[0].z))
    }
  ];
  variants.sort((a, b) => a.plan_distance_ft - b.plan_distance_ft || a.elevation_difference_ft - b.elevation_difference_ft);
  return variants[0]!;
}

function circularDegreesDifference(a: number, b: number): number {
  const raw = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(raw, 360 - raw);
}

function comparableFieldScore(truth: unknown, candidate: unknown): number | null {
  const expected = normalized(truth);
  if (!expected) return null;
  return expected === normalized(candidate) ? 1 : 0;
}

function numericFieldScore(truth: unknown, candidate: unknown, tolerance: number): number | null {
  if (truth === null || truth === undefined || !Number.isFinite(Number(truth))) return null;
  if (candidate === null || candidate === undefined || !Number.isFinite(Number(candidate))) return 0;
  return clamp01(1 - Math.abs(Number(truth) - Number(candidate)) / Math.max(tolerance, Number.EPSILON));
}

function average(values: Array<number | null>, fallback: number): number {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) / present.length : fallback;
}

function geometryComparison(
  truth: ExistingConditionsElement,
  candidate: ExistingConditionsElement,
  policy: ExistingConditionsScoringPolicy,
  elevationEvidence: "plan_visible" | "project_context" | "not_visible"
): { score: number; distance_ft: number | null; plan_distance_ft: number | null; plan_score: number; elevation_difference_ft: number | null; elevation_score: number } {
  let distance: number | null = null;
  let planDistance: number | null = null;
  let elevationDifference: number | null = null;
  let tolerance = policy.location_tolerance_ft;
  if (truth.endpoints && candidate.endpoints) {
    distance = endpointDistance(truth.endpoints, candidate.endpoints);
    const separated = endpointPlanAndElevationDistance(truth.endpoints, candidate.endpoints);
    planDistance = separated.plan_distance_ft;
    elevationDifference = separated.elevation_difference_ft;
    tolerance = policy.endpoint_tolerance_ft;
  } else if (truth.location && candidate.location) {
    distance = pointDistance(truth.location, candidate.location);
    planDistance = pointDistance2d(truth.location, candidate.location);
    elevationDifference = Math.abs(truth.location.z - candidate.location.z);
  }
  const strictPosition = distance === null ? 0 : clamp01(1 - distance / Math.max(tolerance, Number.EPSILON));
  const planPosition = planDistance === null ? 0 : clamp01(1 - planDistance / Math.max(tolerance, Number.EPSILON));
  const elevationScore = elevationDifference === null
    ? 1
    : clamp01(1 - elevationDifference / Math.max(policy.elevation_tolerance_ft, Number.EPSILON));
  const elevationWeight = elevationEvidence === "plan_visible"
    ? 1
    : elevationEvidence === "project_context"
      ? policy.project_context_elevation_geometry_weight
      : policy.unobserved_elevation_geometry_weight;
  const position = elevationEvidence === "plan_visible"
    ? strictPosition
    : (1 - elevationWeight) * planPosition + elevationWeight * elevationScore;
  const rotation = numericFieldScore(
    truth.rotation_degrees,
    candidate.rotation_degrees,
    policy.rotation_tolerance_degrees
  );
  const rotationScore = rotation === null
    ? null
    : clamp01(1 - circularDegreesDifference(Number(truth.rotation_degrees), Number(candidate.rotation_degrees)) /
      Math.max(policy.rotation_tolerance_degrees, Number.EPSILON));
  return {
    score: average([position, rotationScore], position),
    distance_ft: elevationEvidence === "plan_visible" ? distance : planDistance,
    plan_distance_ft: planDistance,
    plan_score: planPosition,
    elevation_difference_ft: elevationDifference,
    elevation_score: elevationScore
  };
}

function attributeComparison(
  truth: ExistingConditionsElement,
  candidate: ExistingConditionsElement,
  policy: ExistingConditionsScoringPolicy
): number {
  const scores: Array<number | null> = [
    comparableFieldScore(truth.discipline, candidate.discipline),
    comparableFieldScore(truth.role, candidate.role),
    comparableFieldScore(truth.family, candidate.family),
    comparableFieldScore(truth.type, candidate.type),
    comparableFieldScore(truth.size?.shape, candidate.size?.shape),
    numericFieldScore(truth.size?.width_ft, candidate.size?.width_ft, policy.size_tolerance_ft),
    numericFieldScore(truth.size?.height_ft, candidate.size?.height_ft, policy.size_tolerance_ft),
    numericFieldScore(truth.size?.diameter_ft, candidate.size?.diameter_ft, policy.size_tolerance_ft)
  ];
  for (const [key, expected] of Object.entries(truth.parameters ?? {})) {
    const actual = candidate.parameters?.[key];
    scores.push(
      typeof expected === "number"
        ? numericFieldScore(expected, actual, policy.size_tolerance_ft)
        : comparableFieldScore(expected, actual)
    );
  }
  return average(scores, 1);
}

function systemComparison(truth: ExistingConditionsElement, candidate: ExistingConditionsElement): number {
  return average([
    comparableFieldScore(truth.system_classification, candidate.system_classification),
    comparableFieldScore(truth.system_type, candidate.system_type)
  ], 1);
}

function spatialComparison(truth: ExistingConditionsElement, candidate: ExistingConditionsElement): number {
  return average([
    comparableFieldScore(truth.level_name, candidate.level_name),
    comparableFieldScore(truth.room_number, candidate.room_number),
    comparableFieldScore(truth.space_number, candidate.space_number)
  ], 1);
}

function comparePair(
  truth: ExistingConditionsElement,
  candidate: ExistingConditionsElement,
  policy: ExistingConditionsScoringPolicy,
  elevationEvidence: "plan_visible" | "project_context" | "not_visible"
): ExistingConditionsMatchedPair | null {
  if (normalized(truth.category) !== normalized(candidate.category)) return null;
  if (truth.kind !== candidate.kind) return null;
  const geometry = geometryComparison(truth, candidate, policy, elevationEvidence);
  // Elevation policy may soften inaccessible Z, but can never rescue a route at
  // the wrong plan location through otherwise matching attributes or systems.
  if (geometry.plan_score <= 0) return null;
  if (geometry.score <= 0) return null;
  const attributes = attributeComparison(truth, candidate, policy);
  const systems = systemComparison(truth, candidate);
  const spatial = spatialComparison(truth, candidate);
  const pairScore = 0.55 * geometry.score + 0.25 * attributes + 0.1 * systems + 0.1 * spatial;
  if (pairScore < policy.minimum_pair_score) return null;
  return {
    truth_key: truth.key,
    candidate_key: candidate.key,
    pair_score: round(pairScore),
    geometry_score: round(geometry.score),
    attribute_score: round(attributes),
    system_score: round(systems),
    spatial_score: round(spatial),
    distance_ft: geometry.distance_ft === null ? null : round(geometry.distance_ft),
    plan_distance_ft: geometry.plan_distance_ft === null ? null : round(geometry.plan_distance_ft),
    elevation_difference_ft: geometry.elevation_difference_ft === null ? null : round(geometry.elevation_difference_ft),
    elevation_score: round(geometry.elevation_score)
  };
}

// Minimum-cost global assignment. Reconstructed Revit elements receive new IDs, so
// matching must use semantic/native geometry rather than truth element IDs.
function assignRowsToColumns(costs: number[][]): number[] {
  const rowCount = costs.length;
  const columnCount = costs[0]?.length ?? 0;
  if (rowCount === 0) return [];
  if (columnCount === 0) return Array(rowCount).fill(-1);
  if (rowCount > columnCount) throw new Error("assignment_requires_rows_not_greater_than_columns");
  const u = Array(rowCount + 1).fill(0);
  const v = Array(columnCount + 1).fill(0);
  const p = Array(columnCount + 1).fill(0);
  const way = Array(columnCount + 1).fill(0);
  for (let i = 1; i <= rowCount; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(columnCount + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array(columnCount + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= columnCount; j += 1) {
        if (used[j]) continue;
        const cur = costs[i0 - 1]![j - 1]! - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= columnCount; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const assignment = Array(rowCount).fill(-1);
  for (let j = 1; j <= columnCount; j += 1) {
    if (p[j] > 0) assignment[p[j] - 1] = j - 1;
  }
  return assignment;
}

function globallyMatch(
  truth: ExistingConditionsElement[],
  candidate: ExistingConditionsElement[],
  policy: ExistingConditionsScoringPolicy,
  elevationEvidence: "plan_visible" | "project_context" | "not_visible"
): ExistingConditionsMatchedPair[] {
  if (truth.length === 0 || candidate.length === 0) return [];
  const pairMatrix = truth.map((truthElement) =>
    candidate.map((candidateElement) => comparePair(truthElement, candidateElement, policy, elevationEvidence))
  );
  const impossibleCost = 1_000_000;
  if (truth.length <= candidate.length) {
    const assignment = assignRowsToColumns(pairMatrix.map((row) => row.map((pair) => pair ? 1 - pair.pair_score : impossibleCost)));
    return assignment.flatMap((candidateIndex, truthIndex) => {
      const pair = candidateIndex >= 0 ? pairMatrix[truthIndex]?.[candidateIndex] : null;
      return pair ? [pair] : [];
    });
  }
  const transposed = candidate.map((_, candidateIndex) =>
    truth.map((__, truthIndex) => {
      const pair = pairMatrix[truthIndex]?.[candidateIndex];
      return pair ? 1 - pair.pair_score : impossibleCost;
    })
  );
  const assignment = assignRowsToColumns(transposed);
  return assignment.flatMap((truthIndex, candidateIndex) => {
    const pair = truthIndex >= 0 ? pairMatrix[truthIndex]?.[candidateIndex] : null;
    return pair ? [pair] : [];
  });
}

function canonicalEdge(a: string, b: string): string {
  return normalized(a) < normalized(b) ? `${a}::${b}` : `${b}::${a}`;
}

function canonicalRelation(kind: ExistingConditionsRelationshipKind, a: string, b: string): string {
  const ordered = normalized(a) < normalized(b) ? [a, b] : [b, a];
  return JSON.stringify([kind, ordered[0], ordered[1]]);
}

function f1(precision: number, recall: number): number {
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

function relationshipKind(edge: ExistingConditionsConnection): ExistingConditionsRelationshipKind {
  return edge.kind ?? "physical";
}

function relationshipF1(
  truth: ExistingConditionsSnapshot,
  candidate: ExistingConditionsSnapshot,
  pairs: ExistingConditionsMatchedPair[],
  kind: ExistingConditionsRelationshipKind
): number {
  const truthToCandidate = new Map(pairs.map((pair) => [pair.truth_key, pair.candidate_key]));
  const candidateToTruth = new Map(pairs.map((pair) => [pair.candidate_key, pair.truth_key]));
  const truthElementKeys = new Set(truth.elements.map((element) => element.key));
  const candidateElementKeys = new Set(candidate.elements.map((element) => element.key));
  const truthConnections = truth.connections.filter((edge) => relationshipKind(edge) === kind);
  const candidateConnections = candidate.connections.filter((edge) => relationshipKind(edge) === kind);
  const truthEdges = new Set(truthConnections.map((edge) => canonicalEdge(edge.a, edge.b)));
  const candidateEdges = new Set(candidateConnections.map((edge) => canonicalEdge(edge.a, edge.b)));
  let preserved = 0;
  for (const edge of truthConnections) {
    const a = truthToCandidate.get(edge.a) ?? (!truthElementKeys.has(edge.a) ? edge.a : undefined);
    const b = truthToCandidate.get(edge.b) ?? (!truthElementKeys.has(edge.b) ? edge.b : undefined);
    if (a && b && candidateEdges.has(canonicalEdge(a, b))) preserved += 1;
  }
  let validCandidate = 0;
  for (const edge of candidateConnections) {
    const a = candidateToTruth.get(edge.a) ?? (!candidateElementKeys.has(edge.a) ? edge.a : undefined);
    const b = candidateToTruth.get(edge.b) ?? (!candidateElementKeys.has(edge.b) ? edge.b : undefined);
    if (a && b && truthEdges.has(canonicalEdge(a, b))) validCandidate += 1;
  }
  const edgeRecall = truthEdges.size === 0 ? (candidateEdges.size === 0 ? 1 : 0) : preserved / truthEdges.size;
  const edgePrecision = candidateEdges.size === 0 ? (truthEdges.size === 0 ? 1 : 0) : validCandidate / candidateEdges.size;
  return f1(edgePrecision, edgeRecall);
}

function connectivityScore(
  truth: ExistingConditionsSnapshot,
  candidate: ExistingConditionsSnapshot,
  pairs: ExistingConditionsMatchedPair[]
): number {
  const edgeF1 = relationshipF1(truth, candidate, pairs, "physical");
  const openDenominator = Math.max(1, truth.open_connector_count, candidate.open_connector_count);
  const openScore = clamp01(1 - Math.abs(truth.open_connector_count - candidate.open_connector_count) / openDenominator);
  return 0.8 * edgeF1 + 0.2 * openScore;
}

function hasTruthRelationship(truth: ExistingConditionsSnapshot, kind: ExistingConditionsRelationshipKind): boolean {
  return truth.connections.some((edge) => relationshipKind(edge) === kind);
}

function evidenceMap(receipts: ExistingConditionsEvidenceReceipt[]): Map<string, string> {
  return new Map(receipts.map((entry) => [normalized(entry.role), normalized(entry.sha256)]));
}

const CORE_RECONSTRUCTION_DISCIPLINES = ["architectural", "mechanical", "plumbing", "electrical"] as const;
type CoreReconstructionDiscipline = typeof CORE_RECONSTRUCTION_DISCIPLINES[number];

function parseDisciplineCoverageRequirements(truth: ExistingConditionsGroundTruth): {
  requirements: ExistingConditionsDisciplineCoverageRequirement[];
  invalid_reasons: string[];
} {
  const policy = truth.evaluation_policy as unknown as Record<string, unknown> | undefined;
  const raw = policy?.required_discipline_coverage;
  const mixed = normalized(truth.discipline) === "mixed";
  if (!Array.isArray(raw)) {
    return {
      requirements: [],
      invalid_reasons: mixed ? ["mixed_fixture_requires_discipline_coverage"] :
        raw === undefined ? [] : ["discipline_coverage_must_be_array"]
    };
  }
  const invalidReasons: string[] = [];
  if (raw.length < 2) invalidReasons.push("discipline_coverage_requires_multiple_disciplines");
  const requirements: ExistingConditionsDisciplineCoverageRequirement[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalidReasons.push(`invalid_discipline_coverage_requirement:${index}`);
      continue;
    }
    const requirement = entry as Record<string, unknown>;
    const discipline = normalized(requirement.discipline);
    const minimumPrecision = requirement.minimum_precision;
    const minimumRecall = requirement.minimum_recall;
    if (!CORE_RECONSTRUCTION_DISCIPLINES.includes(discipline as CoreReconstructionDiscipline)) {
      invalidReasons.push(`invalid_discipline_coverage_requirement:${discipline || index}`);
      continue;
    }
    if (seen.has(discipline)) invalidReasons.push(`duplicate_discipline_coverage_requirement:${discipline}`);
    seen.add(discipline);
    if (typeof minimumPrecision !== "number" || !Number.isFinite(minimumPrecision) || minimumPrecision < 0 || minimumPrecision > 1) {
      invalidReasons.push(`invalid_discipline_precision_threshold:${discipline}`);
      continue;
    }
    if (typeof minimumRecall !== "number" || !Number.isFinite(minimumRecall) || minimumRecall < 0 || minimumRecall > 1) {
      invalidReasons.push(`invalid_discipline_recall_threshold:${discipline}`);
      continue;
    }
    requirements.push({
      discipline: discipline as ExistingConditionsDisciplineCoverageRequirement["discipline"],
      minimum_precision: minimumPrecision,
      minimum_recall: minimumRecall
    });
  }
  return { requirements, invalid_reasons: [...new Set(invalidReasons)] };
}

function snapshotCoreDisciplines(snapshot: ExistingConditionsSnapshot): Set<CoreReconstructionDiscipline> {
  return new Set(snapshot.elements
    .map((element) => normalized(element.discipline))
    .filter((discipline): discipline is CoreReconstructionDiscipline =>
      CORE_RECONSTRUCTION_DISCIPLINES.includes(discipline as CoreReconstructionDiscipline)));
}

function validateRun(truth: ExistingConditionsGroundTruth, candidate: ExistingConditionsCandidate): string[] {
  const reasons: string[] = [];
  if (truth.schema_version !== 1 || candidate.schema_version !== 1) reasons.push("unsupported_schema_version");
  if (truth.fixture_id !== candidate.fixture_id) reasons.push("fixture_id_mismatch");
  if (truth.scope_id !== candidate.scope_id) reasons.push("scope_id_mismatch");
  if (truth.discipline && candidate.discipline && normalized(truth.discipline) !== normalized(candidate.discipline)) reasons.push("discipline_mismatch");
  const parsedDisciplineCoverage = parseDisciplineCoverageRequirements(truth);
  reasons.push(...parsedDisciplineCoverage.invalid_reasons);
  const disciplineCoverage = parsedDisciplineCoverage.requirements;
  if (disciplineCoverage.length > 0) {
    if (normalized(truth.discipline) !== "mixed" || normalized(candidate.discipline) !== "mixed") {
      reasons.push("discipline_coverage_requires_mixed_fixture");
    }
    const configured = new Set(disciplineCoverage.map((entry) => entry.discipline));
    const truthDisciplines = snapshotCoreDisciplines(truth.snapshot);
    const candidateDisciplines = snapshotCoreDisciplines(candidate.snapshot);
    for (const discipline of truthDisciplines) {
      if (!configured.has(discipline)) reasons.push(`truth_discipline_missing_coverage_requirement:${discipline}`);
    }
    for (const discipline of configured) {
      if (!truthDisciplines.has(discipline)) reasons.push(`coverage_requirement_has_no_truth_discipline:${discipline}`);
    }
    for (const discipline of candidateDisciplines) {
      if (!configured.has(discipline)) reasons.push(`candidate_discipline_outside_coverage_requirements:${discipline}`);
    }
  }
  if (!truth.snapshot.native_readback || !candidate.snapshot.native_readback) reasons.push("missing_native_readback");
  if (truth.snapshot.elements.length === 0) reasons.push("empty_ground_truth");
  if (candidate.out_of_scope_changed_element_keys.length > 0) reasons.push("out_of_scope_write");
  if (truth.evaluation_policy?.require_evaluator_change_receipt) {
    const receipt = candidate.evaluator_change_receipt;
    if (!receipt || !receipt.native_diff_readback || !/^[a-f0-9]{64}$/i.test(receipt.receipt_sha256 ?? "")) {
      reasons.push("missing_evaluator_change_receipt");
    } else if (receipt.out_of_scope_changed_element_keys.length > 0) {
      reasons.push("out_of_scope_write");
    }
  }
  const boundedCoverage = truth.evaluation_policy?.bounded_mep_region_coverage;
  if (boundedCoverage) {
    const truthByKey = new Map(truth.snapshot.elements.map((element) => [element.key, element]));
    const routeKeys = boundedCoverage.clear_plan_visible_mep_curve_keys ?? [];
    if (boundedCoverage.clear_plan_visible_family_instance_keys.length === 0 && routeKeys.length === 0) {
      reasons.push("bounded_mep_region_has_no_clear_truth_keys");
    }
    for (const key of boundedCoverage.clear_plan_visible_family_instance_keys) {
      const element = truthByKey.get(key);
      if (!element || element.kind !== "family_instance" || !["mechanical", "plumbing", "electrical"].includes(normalized(element.discipline))) {
        reasons.push(`bounded_mep_region_truth_key_invalid:${key}`);
      }
    }
    for (const key of routeKeys) {
      const element = truthByKey.get(key);
      if (!element || element.kind !== "mep_curve" || !element.endpoints ||
          !["plumbing", "mechanical", "electrical"].includes(normalized(element.discipline)) ||
          segmentLength2d(element.endpoints) <= Number.EPSILON) {
        reasons.push(`bounded_mep_route_truth_key_invalid:${key}`);
      }
    }
    const routeTolerance = boundedCoverage.route_trace_tolerance_ft ?? 0.25;
    if (!Number.isFinite(routeTolerance) || routeTolerance <= 0 || routeTolerance > 0.25) {
      reasons.push("bounded_mep_route_trace_tolerance_invalid");
    }
    for (const [name, threshold] of [
      ["precision", boundedCoverage.minimum_route_trace_precision ?? 1],
      ["recall", boundedCoverage.minimum_route_trace_recall ?? 1]
    ] as const) {
      if (!Number.isFinite(threshold) || threshold !== 1) {
        reasons.push(`bounded_mep_route_trace_${name}_threshold_invalid`);
      }
    }
    const receipt = candidate.source_coverage_receipt;
    if (!receipt) {
      reasons.push("missing_bounded_mep_region_coverage_receipt");
    } else {
      if (receipt.scope_id !== truth.scope_id) reasons.push("bounded_mep_region_scope_mismatch");
      if (receipt.coverage_status !== boundedCoverage.required_coverage_status) reasons.push("bounded_mep_region_coverage_partial");
      if (normalized(receipt.source_evidence_sha256) !== normalized(boundedCoverage.source_evidence_sha256)) reasons.push("bounded_mep_region_source_hash_mismatch");
      if (normalized(receipt.registered_render_sha256) !== normalized(boundedCoverage.registered_render_sha256)) reasons.push("bounded_mep_region_render_hash_mismatch");
      if (normalized(receipt.coverage_contract_sha256) !== normalized(boundedCoverage.coverage_contract_sha256)) reasons.push("bounded_mep_region_contract_hash_mismatch");
      if (normalized(receipt.region_sha256) !== normalized(boundedCoverage.region_sha256)) reasons.push("bounded_mep_region_bounds_hash_mismatch");
    }
  }
  if (!validateExistingConditionsEvaluatorVisualReceipt(candidate.visual_receipt)) {
    reasons.push("missing_or_invalid_evaluator_visual_receipt");
  }
  if (candidate.accessed_artifact_roles.some((role) => FORBIDDEN_AGENT_ARTIFACT_ROLES.has(normalized(role)))) {
    reasons.push("ground_truth_leakage_detected");
  }
  const expectedEvidence = evidenceMap(truth.visible_evidence);
  const actualEvidence = evidenceMap(candidate.visible_evidence);
  for (const [role, hash] of expectedEvidence) {
    if (!hash || actualEvidence.get(role) !== hash) reasons.push(`visible_evidence_changed:${role}`);
  }
  return [...new Set(reasons)];
}

export function scoreExistingConditionsReconstruction(
  truth: ExistingConditionsGroundTruth,
  candidate: ExistingConditionsCandidate,
  policyOverrides: Partial<ExistingConditionsScoringPolicy> = {}
): ExistingConditionsScore {
  const policy = { ...DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY, ...policyOverrides };
  const invalidReasons = validateRun(truth, candidate);
  const elevationEvidence = truth.evaluation_policy?.elevation_evidence ?? "plan_visible";
  const boundedCoverage = truth.evaluation_policy?.bounded_mep_region_coverage;
  const boundedRouteTruthKeys = new Set(boundedCoverage?.clear_plan_visible_mep_curve_keys ?? []);
  const truthRouteElements = truth.snapshot.elements.filter((element) => boundedRouteTruthKeys.has(element.key));
  const routeDisciplines = new Set(truthRouteElements.map((element) => normalized(element.discipline)));
  const routeToleranceFt = boundedCoverage?.route_trace_tolerance_ft ?? 0.25;
  const candidateRouteElements = truthRouteElements.length > 0
    ? candidate.snapshot.elements.filter((element) => element.kind === "mep_curve" && routeDisciplines.has(normalized(element.discipline)))
    : [];
  // Fittings are implementation details of native segmentation: the same visible
  // trace may be represented by one curve, two curves plus a union, or several
  // elbow-bounded curves. Visible accessories remain discrete scored elements.
  const truthRouteAbstractionKeys = new Set(truth.snapshot.elements
    .filter((element) => boundedRouteTruthKeys.has(element.key) ||
      isRouteSupportingFitting(element, truthRouteElements, truth.snapshot, routeToleranceFt))
    .map((element) => element.key));
  const candidateRouteAbstractionKeys = new Set(candidate.snapshot.elements
    .filter((element) => (element.kind === "mep_curve" && routeDisciplines.has(normalized(element.discipline))) ||
      isRouteSupportingFitting(element, candidateRouteElements, candidate.snapshot, routeToleranceFt))
    .map((element) => element.key));
  const matchingTruthElements = truth.snapshot.elements.filter((element) => !truthRouteAbstractionKeys.has(element.key));
  const matchingCandidateElements = candidate.snapshot.elements.filter((element) => !candidateRouteAbstractionKeys.has(element.key));
  const pairs = invalidReasons.length === 0
    ? globallyMatch(matchingTruthElements, matchingCandidateElements, policy, elevationEvidence)
    : [];
  const matchedTruth = new Set(pairs.map((pair) => pair.truth_key));
  const matchedCandidate = new Set(pairs.map((pair) => pair.candidate_key));
  const missedTruthKeys = matchingTruthElements.filter((element) => !matchedTruth.has(element.key)).map((element) => element.key);
  const falsePositiveKeys = matchingCandidateElements.filter((element) => !matchedCandidate.has(element.key)).map((element) => element.key);
  const architecturalOpeningRoles = new Set(["door", "window"]);
  const missedArchitecturalOpenings = truth.snapshot.elements.filter((element) =>
    !matchedTruth.has(element.key) && element.discipline === "architectural" && architecturalOpeningRoles.has(normalized(element.role))
  );
  const falsePositiveArchitecturalOpenings = candidate.snapshot.elements.filter((element) =>
    !matchedCandidate.has(element.key) && element.discipline === "architectural" && architecturalOpeningRoles.has(normalized(element.role))
  );
  const architecturalOpeningsExact = missedArchitecturalOpenings.length === 0 && falsePositiveArchitecturalOpenings.length === 0;
  const precision = matchingCandidateElements.length > 0
    ? pairs.length / matchingCandidateElements.length
    : matchingTruthElements.length === 0 ? 1 : 0;
  const recall = matchingTruthElements.length > 0
    ? pairs.length / matchingTruthElements.length
    : matchingCandidateElements.length === 0 ? 1 : 0;
  const disciplineCoverage = parseDisciplineCoverageRequirements(truth).requirements.map((requirement) => {
    const discipline = requirement.discipline;
    const truthElements = matchingTruthElements.filter((element) => normalized(element.discipline) === normalized(discipline));
    const candidateElements = matchingCandidateElements.filter((element) => normalized(element.discipline) === normalized(discipline));
    const disciplineTruthRoutes = truthRouteElements.filter((element) => normalized(element.discipline) === normalized(discipline));
    const disciplineCandidateRoutes = candidateRouteElements.filter((element) => normalized(element.discipline) === normalized(discipline));
    const truthKeys = new Set(truthElements.map((element) => element.key));
    const candidateKeys = new Set(candidateElements.map((element) => element.key));
    const matchedCount = pairs.filter((pair) => truthKeys.has(pair.truth_key) && candidateKeys.has(pair.candidate_key)).length;
    const discretePrecision = candidateElements.length > 0
      ? matchedCount / candidateElements.length
      : truthElements.length === 0 ? 1 : 0;
    const discreteRecall = truthElements.length > 0
      ? matchedCount / truthElements.length
      : candidateElements.length === 0 ? 1 : 0;
    const disciplineRouteRecallCoverage = disciplineTruthRoutes.length > 0
      ? sampledRouteCoverage(disciplineTruthRoutes, disciplineCandidateRoutes, routeToleranceFt)
      : null;
    const disciplineRoutePrecisionCoverage = disciplineTruthRoutes.length > 0
      ? sampledRouteCoverage(disciplineCandidateRoutes, disciplineTruthRoutes, routeToleranceFt)
      : null;
    const routeRecall = disciplineRouteRecallCoverage === null || disciplineRoutePrecisionCoverage === null
      ? null
      : Math.min(
          disciplineRouteRecallCoverage.ratio,
          clamp01(disciplineRoutePrecisionCoverage.total_length_ft / disciplineRouteRecallCoverage.total_length_ft)
        );
    const routePrecision = disciplineRouteRecallCoverage === null || disciplineRoutePrecisionCoverage === null
      ? null
      : Math.min(
          disciplineRoutePrecisionCoverage.ratio,
          clamp01(disciplineRouteRecallCoverage.total_length_ft /
            Math.max(disciplineRoutePrecisionCoverage.total_length_ft, Number.EPSILON))
        );
    const hasDiscreteTruth = truthElements.length > 0;
    const hasRouteTruth = disciplineTruthRoutes.length > 0;
    if (!hasDiscreteTruth && !hasRouteTruth) invalidReasons.push(`required_discipline_has_no_scoreable_truth:${discipline}`);
    const disciplinePrecision = hasDiscreteTruth && routePrecision !== null
      ? Math.min(discretePrecision, routePrecision)
      : routePrecision ?? discretePrecision;
    const disciplineRecall = hasDiscreteTruth && routeRecall !== null
      ? Math.min(discreteRecall, routeRecall)
      : routeRecall ?? discreteRecall;
    return {
      discipline,
      truth_count: truthElements.length,
      candidate_count: candidateElements.length,
      matched_count: matchedCount,
      precision: round(disciplinePrecision),
      recall: round(disciplineRecall),
      minimum_precision: requirement.minimum_precision,
      minimum_recall: requirement.minimum_recall,
      ...(routePrecision === null ? {} : { route_trace_precision: round(routePrecision) }),
      ...(routeRecall === null ? {} : { route_trace_recall: round(routeRecall) }),
      ...(disciplineRouteRecallCoverage === null ? {} : { route_truth_length_ft: round(disciplineRouteRecallCoverage.total_length_ft) }),
      ...(disciplineRoutePrecisionCoverage === null ? {} : { route_candidate_length_ft: round(disciplineRoutePrecisionCoverage.total_length_ft) }),
      passed: (hasDiscreteTruth || hasRouteTruth) &&
        disciplinePrecision >= requirement.minimum_precision &&
        disciplineRecall >= requirement.minimum_recall
    };
  });
  const boundedTruthKeys = new Set(boundedCoverage?.clear_plan_visible_family_instance_keys ?? []);
  const boundedPairs = pairs.filter((pair) => boundedTruthKeys.has(pair.truth_key));
  const boundedCandidateElements = boundedCoverage
    ? candidate.snapshot.elements.filter((element) =>
        element.kind === "family_instance" && ["mechanical", "plumbing", "electrical"].includes(normalized(element.discipline)))
    : [];
  const boundedMatchedCandidateKeys = new Set(boundedPairs.map((pair) => pair.candidate_key));
  const mepRegionPrecision = boundedCoverage && boundedTruthKeys.size > 0
    ? (boundedCandidateElements.length === 0 ? 0 : boundedCandidateElements.filter((element) => boundedMatchedCandidateKeys.has(element.key)).length / boundedCandidateElements.length)
    : null;
  const mepRegionRecall = boundedCoverage && boundedTruthKeys.size > 0
    ? boundedPairs.length / boundedTruthKeys.size
    : null;
  const routeRecallCoverage = truthRouteElements.length > 0
    ? sampledRouteCoverage(truthRouteElements, candidateRouteElements, routeToleranceFt)
    : null;
  const routePrecisionCoverage = truthRouteElements.length > 0
    ? sampledRouteCoverage(candidateRouteElements, truthRouteElements, routeToleranceFt)
    : null;
  const routeGeometryRecallCoverage = truthRouteElements.length > 0
    ? sampledRouteCoverage(truthRouteElements, candidateRouteElements, routeToleranceFt, routeGeometryCompatible)
    : null;
  const routeGeometryPrecisionCoverage = truthRouteElements.length > 0
    ? sampledRouteCoverage(candidateRouteElements, truthRouteElements, routeToleranceFt, routeGeometryCompatible)
    : null;
  // Directed proximity alone can be gamed by overlapping duplicates because
  // every duplicate sample is still near the same truth line. Total traced
  // length provides the missing one-to-one capacity bound while remaining
  // independent of where Revit chose to split the run.
  const mepRouteTraceRecall = routeRecallCoverage === null || routePrecisionCoverage === null
    ? null
    : Math.min(routeRecallCoverage.ratio, clamp01(routePrecisionCoverage.total_length_ft / routeRecallCoverage.total_length_ft));
  const mepRouteTracePrecision = routeRecallCoverage === null || routePrecisionCoverage === null
    ? null
    : Math.min(routePrecisionCoverage.ratio, clamp01(routeRecallCoverage.total_length_ft / Math.max(routePrecisionCoverage.total_length_ft, Number.EPSILON)));
  const mepRouteTraceF1 = mepRouteTracePrecision === null || mepRouteTraceRecall === null
    ? null
    : f1(mepRouteTracePrecision, mepRouteTraceRecall);
  const mepRouteGeometryRecall = routeGeometryRecallCoverage === null || routeGeometryPrecisionCoverage === null
    ? null
    : Math.min(
        routeGeometryRecallCoverage.ratio,
        clamp01(routeGeometryPrecisionCoverage.total_length_ft / routeGeometryRecallCoverage.total_length_ft)
      );
  const mepRouteGeometryPrecision = routeGeometryRecallCoverage === null || routeGeometryPrecisionCoverage === null
    ? null
    : Math.min(
        routeGeometryPrecisionCoverage.ratio,
        clamp01(routeGeometryRecallCoverage.total_length_ft /
          Math.max(routeGeometryPrecisionCoverage.total_length_ft, Number.EPSILON))
      );
  const mepRouteGeometryF1 = mepRouteGeometryPrecision === null || mepRouteGeometryRecall === null
    ? null
    : f1(mepRouteGeometryPrecision, mepRouteGeometryRecall);
  const elementF1 = f1(precision, recall);
  const routeGeometryMetric = mepRouteGeometryF1 === null ? [] : [mepRouteGeometryF1];
  const strictRouteMetric = mepRouteTraceF1 === null ? [] : [mepRouteTraceF1];
  const geometry = average([...pairs.map((pair) => pair.geometry_score), ...routeGeometryMetric], 0);
  const elevation = average(pairs.map((pair) => pair.elevation_score), 1);
  const attributes = average([...pairs.map((pair) => pair.attribute_score), ...strictRouteMetric], 0);
  const systems = average([...pairs.map((pair) => pair.system_score), ...strictRouteMetric], 0);
  const spatial = average(pairs.map((pair) => pair.spatial_score), 0);
  const relationshipTruthSnapshot = truthRouteElements.length > 0 ? {
    ...truth.snapshot,
    elements: matchingTruthElements,
    connections: truth.snapshot.connections.filter((edge) => !truthRouteAbstractionKeys.has(edge.a) && !truthRouteAbstractionKeys.has(edge.b)),
    open_connector_count: 0
  } : truth.snapshot;
  const relationshipCandidateSnapshot = truthRouteElements.length > 0 ? {
    ...candidate.snapshot,
    elements: matchingCandidateElements,
    connections: candidate.snapshot.connections.filter((edge) => !candidateRouteAbstractionKeys.has(edge.a) && !candidateRouteAbstractionKeys.has(edge.b)),
    open_connector_count: 0
  } : candidate.snapshot;
  const connectivity = pairs.length > 0 ? connectivityScore(relationshipTruthSnapshot, relationshipCandidateSnapshot, pairs) : 0;
  const architecturalTopology = pairs.length > 0 ? relationshipF1(relationshipTruthSnapshot, relationshipCandidateSnapshot, pairs, "wall_junction") : 0;
  const hosting = pairs.length > 0 ? relationshipF1(relationshipTruthSnapshot, relationshipCandidateSnapshot, pairs, "host") : 0;
  const electricalCircuits = pairs.length > 0 ? relationshipF1(relationshipTruthSnapshot, relationshipCandidateSnapshot, pairs, "electrical_circuit") : 0;
  const physicalConnectivityApplicable = hasTruthRelationship(relationshipTruthSnapshot, "physical") || hasTruthRelationship(relationshipCandidateSnapshot, "physical");
  const architecturalTopologyApplicable = hasTruthRelationship(relationshipTruthSnapshot, "wall_junction") || hasTruthRelationship(relationshipCandidateSnapshot, "wall_junction");
  const systemsApplicable = truth.snapshot.elements.some((element) => normalized(element.system_classification) || normalized(element.system_type));
  // Room/space membership is the spatial hard gate. Some linked-face-hosted Revit
  // families expose no writable/readable level after a safe copy even when their
  // world elevation and host are exact; level remains a reported pair metric but
  // cannot by itself make an otherwise grounded reconstruction invalid.
  const spatialApplicable = matchingTruthElements.some((element) => normalized(element.room_number) || normalized(element.space_number));
  const hostingApplicable = hasTruthRelationship(relationshipTruthSnapshot, "host") || hasTruthRelationship(relationshipCandidateSnapshot, "host");
  const electricalCircuitsApplicable = hasTruthRelationship(relationshipTruthSnapshot, "electrical_circuit") || hasTruthRelationship(relationshipCandidateSnapshot, "electrical_circuit");
  const drawingEvidence = validateExistingConditionsEvaluatorVisualReceipt(candidate.visual_receipt) &&
    candidate.visual_receipt?.evaluator_review.review_status === "pass" ? 1 : 0;
  const weightedComponents = [
    { weight: 0.15, value: elementF1, applicable: true },
    { weight: 0.2, value: geometry, applicable: true },
    { weight: 0.15, value: attributes, applicable: true },
    { weight: 0.15, value: connectivity, applicable: physicalConnectivityApplicable },
    { weight: 0.15, value: architecturalTopology, applicable: architecturalTopologyApplicable },
    { weight: 0.1, value: systems, applicable: systemsApplicable },
    { weight: 0.08, value: spatial, applicable: spatialApplicable },
    { weight: 0.07, value: hosting, applicable: hostingApplicable },
    { weight: 0.05, value: electricalCircuits, applicable: electricalCircuitsApplicable },
    { weight: 0.05, value: drawingEvidence, applicable: true }
  ];
  const activeWeight = weightedComponents.filter((entry) => entry.applicable).reduce((sum, entry) => sum + entry.weight, 0);
  const weightedScore = invalidReasons.length > 0 || activeWeight <= 0
    ? 0
    : 100 * weightedComponents.filter((entry) => entry.applicable).reduce((sum, entry) => sum + entry.weight * entry.value, 0) / activeWeight;
  const minimumRouteTracePrecision = boundedCoverage?.minimum_route_trace_precision ?? 1;
  const minimumRouteTraceRecall = boundedCoverage?.minimum_route_trace_recall ?? 1;
  const failures: string[] = [];
  for (const reason of invalidReasons) failures.push(reason.split(":", 1)[0]!);
  if (invalidReasons.length === 0) {
    if (candidate.snapshot.elements.length === 0) failures.push("no_reconstruction");
    if (recall < policy.minimum_recall) failures.push("incomplete_reconstruction");
    if (precision < policy.minimum_precision) failures.push("false_positive_elements");
    for (const coverage of disciplineCoverage) {
      if (coverage.precision < coverage.minimum_precision) failures.push(`discipline_${coverage.discipline}_precision_below_threshold`);
      if (coverage.recall < coverage.minimum_recall) failures.push(`discipline_${coverage.discipline}_recall_below_threshold`);
    }
    if (mepRegionRecall !== null && mepRegionRecall < 1) failures.push("bounded_mep_region_incomplete");
    if (mepRegionPrecision !== null && mepRegionPrecision < 1) failures.push("bounded_mep_region_false_positive");
    if (mepRouteTraceRecall !== null && mepRouteTraceRecall < minimumRouteTraceRecall) failures.push("bounded_mep_route_trace_incomplete");
    if (mepRouteTracePrecision !== null && mepRouteTracePrecision < minimumRouteTracePrecision) failures.push("bounded_mep_route_trace_false_positive");
    if (missedArchitecturalOpenings.length > 0) failures.push("missing_architectural_openings");
    if (falsePositiveArchitecturalOpenings.length > 0) failures.push("false_positive_architectural_openings");
    if (geometry < 0.8) failures.push("geometry_mismatch");
    if (attributes < 0.8) failures.push("attribute_mismatch");
    if (physicalConnectivityApplicable && connectivity < policy.minimum_connectivity_score) failures.push("connectivity_mismatch");
    if (architecturalTopologyApplicable && architecturalTopology < policy.minimum_architectural_topology_score) failures.push("architectural_topology_mismatch");
    if (systemsApplicable && systems < policy.minimum_system_score) failures.push("system_mismatch");
    if (spatialApplicable && spatial < policy.minimum_spatial_score) failures.push("spatial_mismatch");
    if (hostingApplicable && hosting < policy.minimum_hosting_score) failures.push("hosting_mismatch");
    if (electricalCircuitsApplicable && electricalCircuits < policy.minimum_electrical_circuit_score) failures.push("electrical_circuit_mismatch");
    if (drawingEvidence < 1) failures.push("drawing_verification_missing");
    if (weightedScore < policy.passing_score) failures.push("score_below_threshold");
  }
  const passed = invalidReasons.length === 0 &&
    weightedScore >= policy.passing_score &&
    precision >= policy.minimum_precision &&
    recall >= policy.minimum_recall &&
    disciplineCoverage.every((entry) => entry.passed) &&
    (mepRegionPrecision === null || mepRegionPrecision === 1) &&
    (mepRegionRecall === null || mepRegionRecall === 1) &&
    (mepRouteTracePrecision === null || mepRouteTracePrecision >= minimumRouteTracePrecision) &&
    (mepRouteTraceRecall === null || mepRouteTraceRecall >= minimumRouteTraceRecall) &&
    architecturalOpeningsExact &&
    (!physicalConnectivityApplicable || connectivity >= policy.minimum_connectivity_score) &&
    (!architecturalTopologyApplicable || architecturalTopology >= policy.minimum_architectural_topology_score) &&
    (!systemsApplicable || systems >= policy.minimum_system_score) &&
    (!spatialApplicable || spatial >= policy.minimum_spatial_score) &&
    (!hostingApplicable || hosting >= policy.minimum_hosting_score) &&
    (!electricalCircuitsApplicable || electricalCircuits >= policy.minimum_electrical_circuit_score) &&
    drawingEvidence === 1;
  return {
    schema_version: 1,
    fixture_id: truth.fixture_id,
    scope_id: truth.scope_id,
    valid_run: invalidReasons.length === 0,
    passed,
    score: round(weightedScore, 3),
    elevation_evidence: elevationEvidence,
    failure_classifications: [...new Set(failures)],
    invalid_reasons: invalidReasons,
    counts: {
      truth: truth.snapshot.elements.length,
      candidate: candidate.snapshot.elements.length,
      matched: pairs.length,
      missed: missedTruthKeys.length,
      false_positive: falsePositiveKeys.length
    },
    discipline_coverage: disciplineCoverage,
    metrics: {
      precision: round(precision),
      recall: round(recall),
      element_f1: round(elementF1),
      geometry: round(geometry),
      elevation: round(elevation),
      attributes: round(attributes),
      connectivity: round(connectivity),
      architectural_topology: round(architecturalTopology),
      systems: round(systems),
      spatial: round(spatial),
      hosting: round(hosting),
      electrical_circuits: round(electricalCircuits),
      drawing_evidence: drawingEvidence,
      ...(mepRegionPrecision === null ? {} : { mep_region_precision: round(mepRegionPrecision) }),
      ...(mepRegionRecall === null ? {} : { mep_region_recall: round(mepRegionRecall) }),
      ...(mepRouteGeometryPrecision === null ? {} : { mep_route_geometry_precision: round(mepRouteGeometryPrecision) }),
      ...(mepRouteGeometryRecall === null ? {} : { mep_route_geometry_recall: round(mepRouteGeometryRecall) }),
      ...(mepRouteGeometryF1 === null ? {} : { mep_route_geometry_f1: round(mepRouteGeometryF1) }),
      ...(mepRouteTracePrecision === null ? {} : { mep_route_trace_precision: round(mepRouteTracePrecision) }),
      ...(mepRouteTraceRecall === null ? {} : { mep_route_trace_recall: round(mepRouteTraceRecall) }),
      ...(mepRouteTraceF1 === null ? {} : { mep_route_trace_f1: round(mepRouteTraceF1) }),
      ...(routeRecallCoverage === null ? {} : { truth_route_length_ft: round(routeRecallCoverage.total_length_ft) }),
      ...(routePrecisionCoverage === null ? {} : { candidate_route_length_ft: round(routePrecisionCoverage.total_length_ft) })
    },
    applicability: {
      physical_connectivity: physicalConnectivityApplicable,
      architectural_topology: architecturalTopologyApplicable,
      systems: systemsApplicable,
      spatial: spatialApplicable,
      hosting: hostingApplicable,
      electrical_circuits: electricalCircuitsApplicable,
      discipline_coverage: disciplineCoverage.length > 0,
      ...(boundedCoverage ? { bounded_mep_region: true } : {}),
      ...(truthRouteElements.length > 0 ? { bounded_mep_route_trace: true } : {})
    },
    matched_pairs: pairs,
    missed_truth_keys: missedTruthKeys,
    false_positive_candidate_keys: falsePositiveKeys
  };
}

type JsonMap = Record<string, unknown>;
type ExistingConditionsWorkflowPartialResult = Omit<RevitWorkflowResult, "elapsed_seconds" | "execution_source">;

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function resolveInput<T>(inline: unknown, filePathValue: unknown, label: string): T {
  if (inline && typeof inline === "object" && !Array.isArray(inline)) return inline as T;
  const filePath = String(filePathValue ?? "").trim();
  if (!filePath) throw new Error(`${label}_is_required`);
  const resolved = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(resolved, "utf8")) as T;
}

function markdownScorecard(result: ExistingConditionsScore): string {
  const failures = result.failure_classifications.length > 0
    ? result.failure_classifications.map((entry) => `- ${entry}`).join("\n")
    : "- None";
  return [
    `# Existing conditions reconstruction - ${result.fixture_id}`,
    "",
    `- Scope: ${result.scope_id}`,
    `- Valid run: ${result.valid_run ? "yes" : "no"}`,
    `- Passed: ${result.passed ? "yes" : "no"}`,
    `- Score: ${result.score.toFixed(3)} / 100`,
    `- Matched: ${result.counts.matched} / ${result.counts.truth}`,
    `- False positives: ${result.counts.false_positive}`,
    "",
    "| Metric | Score |",
    "| --- | ---: |",
    `| Element F1 | ${result.metrics.element_f1.toFixed(3)} |`,
    `| Geometry | ${result.metrics.geometry.toFixed(3)} |`,
    `| Elevation | ${result.metrics.elevation.toFixed(3)} (${result.elevation_evidence}) |`,
    `| Attributes | ${result.metrics.attributes.toFixed(3)} |`,
    `| Connectivity | ${result.metrics.connectivity.toFixed(3)} |`,
    `| Architectural topology | ${result.metrics.architectural_topology.toFixed(3)} |`,
    `| Systems | ${result.metrics.systems.toFixed(3)} |`,
    `| Spatial context | ${result.metrics.spatial.toFixed(3)} |`,
    `| Hosting | ${result.metrics.hosting.toFixed(3)} |`,
    `| Electrical circuits | ${result.metrics.electrical_circuits.toFixed(3)} |`,
    ...(result.metrics.mep_region_precision === undefined ? [] : [`| Bounded MEP discrete precision | ${result.metrics.mep_region_precision.toFixed(3)} |`]),
    ...(result.metrics.mep_region_recall === undefined ? [] : [`| Bounded MEP discrete recall | ${result.metrics.mep_region_recall.toFixed(3)} |`]),
    ...(result.metrics.mep_route_geometry_precision === undefined ? [] : [`| Bounded MEP plan-geometry precision | ${result.metrics.mep_route_geometry_precision.toFixed(3)} |`]),
    ...(result.metrics.mep_route_geometry_recall === undefined ? [] : [`| Bounded MEP plan-geometry recall | ${result.metrics.mep_route_geometry_recall.toFixed(3)} |`]),
    ...(result.metrics.mep_route_trace_precision === undefined ? [] : [`| Bounded MEP route precision | ${result.metrics.mep_route_trace_precision.toFixed(3)} |`]),
    ...(result.metrics.mep_route_trace_recall === undefined ? [] : [`| Bounded MEP route recall | ${result.metrics.mep_route_trace_recall.toFixed(3)} |`]),
    `| Drawing evidence | ${result.metrics.drawing_evidence.toFixed(3)} |`,
    "",
    "## Failure classifications",
    "",
    failures,
    ""
  ].join("\n");
}

export async function runExistingConditionsReconstructionEvaluation(
  _transport: BridgeTransport,
  requestValue: JsonMap,
  runDir: string
): Promise<ExistingConditionsWorkflowPartialResult> {
  const request = asObject(requestValue);
  const groundTruth = resolveInput<ExistingConditionsGroundTruth>(
    request.groundTruth ?? request.ground_truth,
    request.groundTruthPath ?? request.ground_truth_path,
    "ground_truth"
  );
  const candidate = resolveInput<ExistingConditionsCandidate>(
    request.candidate,
    request.candidatePath ?? request.candidate_path,
    "candidate"
  );
  const policy = asObject(request.policy) as Partial<ExistingConditionsScoringPolicy>;
  const result = scoreExistingConditionsReconstruction(groundTruth, candidate, policy);
  ensureDir(runDir);
  const jsonPath = path.join(runDir, "existing_conditions_score.json");
  const markdownPath = path.join(runDir, "existing_conditions_score.md");
  writeJsonFile(jsonPath, result);
  fs.writeFileSync(markdownPath, markdownScorecard(result), "utf8");
  const checks: RevitWorkflowVerification[] = [
    { name: "run_is_leakage_and_scope_safe", ok: result.valid_run, expected: true, actual: result.invalid_reasons },
    { name: "element_precision_meets_threshold", ok: result.metrics.precision >= (policy.minimum_precision ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_precision), expected: policy.minimum_precision ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_precision, actual: result.metrics.precision },
    { name: "element_recall_meets_threshold", ok: result.metrics.recall >= (policy.minimum_recall ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_recall), expected: policy.minimum_recall ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_recall, actual: result.metrics.recall },
    { name: "connectivity_meets_threshold", ok: !result.applicability.physical_connectivity || result.metrics.connectivity >= (policy.minimum_connectivity_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_connectivity_score), expected: policy.minimum_connectivity_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_connectivity_score, actual: result.metrics.connectivity },
    { name: "architectural_topology_meets_threshold", ok: !result.applicability.architectural_topology || result.metrics.architectural_topology >= (policy.minimum_architectural_topology_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_architectural_topology_score), expected: policy.minimum_architectural_topology_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_architectural_topology_score, actual: result.metrics.architectural_topology },
    { name: "systems_meet_threshold", ok: !result.applicability.systems || result.metrics.systems >= (policy.minimum_system_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_system_score), expected: policy.minimum_system_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_system_score, actual: result.metrics.systems },
    { name: "spatial_context_meets_threshold", ok: !result.applicability.spatial || result.metrics.spatial >= (policy.minimum_spatial_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_spatial_score), expected: policy.minimum_spatial_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_spatial_score, actual: result.metrics.spatial },
    { name: "hosting_meets_threshold", ok: !result.applicability.hosting || result.metrics.hosting >= (policy.minimum_hosting_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_hosting_score), expected: policy.minimum_hosting_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_hosting_score, actual: result.metrics.hosting },
    { name: "electrical_circuits_meet_threshold", ok: !result.applicability.electrical_circuits || result.metrics.electrical_circuits >= (policy.minimum_electrical_circuit_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_electrical_circuit_score), expected: policy.minimum_electrical_circuit_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_electrical_circuit_score, actual: result.metrics.electrical_circuits },
    { name: "drawing_verification_present", ok: result.metrics.drawing_evidence === 1, expected: 1, actual: result.metrics.drawing_evidence },
    { name: "overall_reconstruction_passed", ok: result.passed, expected: true, actual: result.score }
  ];
  if (result.applicability.bounded_mep_route_trace) {
    const boundedCoverage = groundTruth.evaluation_policy?.bounded_mep_region_coverage;
    const minimumPrecision = boundedCoverage?.minimum_route_trace_precision ?? 1;
    const minimumRecall = boundedCoverage?.minimum_route_trace_recall ?? 1;
    checks.splice(checks.length - 1, 0,
      { name: "bounded_mep_route_precision_meets_threshold", ok: (result.metrics.mep_route_trace_precision ?? 0) >= minimumPrecision, expected: minimumPrecision, actual: result.metrics.mep_route_trace_precision ?? 0 },
      { name: "bounded_mep_route_recall_meets_threshold", ok: (result.metrics.mep_route_trace_recall ?? 0) >= minimumRecall, expected: minimumRecall, actual: result.metrics.mep_route_trace_recall ?? 0 }
    );
  }
  return {
    workflow: "existing_conditions_reconstruction",
    success: result.passed,
    failure_reason: result.passed ? null : `Existing conditions reconstruction failed: ${result.failure_classifications.join(", ") || "unknown"}.`,
    failure_classification: result.passed ? null : result.failure_classifications[0] ?? "existing_conditions_reconstruction_failed",
    tool_calls: 0,
    revit_transactions: 0,
    computer_use_actions: 0,
    output_artifacts: [jsonPath, markdownPath],
    verification_results: checks,
    user_message: result.passed
      ? `Existing conditions reconstruction passed with score ${result.score.toFixed(3)}.`
      : `Existing conditions reconstruction did not pass; inspect the scorecard and failure classifications.`,
    raw_results: [result]
  };
}
