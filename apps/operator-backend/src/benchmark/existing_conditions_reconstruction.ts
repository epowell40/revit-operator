import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJsonFile } from "./files.js";
import type { BridgeTransport, RevitWorkflowResult, RevitWorkflowVerification } from "./revit_workflows.js";
import {
  validateExistingConditionsEvaluatorVisualReceipt,
  type ExistingConditionsEvaluatorVisualReceipt
} from "../existing_conditions/evaluator_visual.js";

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
  };
  applicability: {
    physical_connectivity: boolean;
    architectural_topology: boolean;
    systems: boolean;
    spatial: boolean;
    hosting: boolean;
    electrical_circuits: boolean;
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

function inferDiscipline(category: string): ExistingConditionsDiscipline {
  const key = normalized(category);
  if (/wall|door|window|room|floor|ceiling|roof|column/.test(key)) return "architectural";
  if (/electrical|lighting|fire alarm|data device|communication device/.test(key)) return "electrical";
  if (/plumbing fixture|sanitary|domestic|sprinkler/.test(key)) return "plumbing";
  if (/duct|mechanical equipment|air terminal/.test(key)) return "mechanical";
  if (/pipe/.test(key)) return "mechanical";
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
      discipline: inferDiscipline(category),
      role: inferRole(category),
      category,
      family: firstText(raw.familyName, raw.family_name),
      type: firstText(raw.typeName, raw.type_name, raw.name),
      system_classification: firstText(raw.systemClassification, raw.system_classification, system.systemClassification, system.system_classification),
      system_type: firstText(system.systemType, system.system_type, parameters.systemType),
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

function validateRun(truth: ExistingConditionsGroundTruth, candidate: ExistingConditionsCandidate): string[] {
  const reasons: string[] = [];
  if (truth.schema_version !== 1 || candidate.schema_version !== 1) reasons.push("unsupported_schema_version");
  if (truth.fixture_id !== candidate.fixture_id) reasons.push("fixture_id_mismatch");
  if (truth.scope_id !== candidate.scope_id) reasons.push("scope_id_mismatch");
  if (truth.discipline && candidate.discipline && normalized(truth.discipline) !== normalized(candidate.discipline)) reasons.push("discipline_mismatch");
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
  const pairs = invalidReasons.length === 0
    ? globallyMatch(truth.snapshot.elements, candidate.snapshot.elements, policy, elevationEvidence)
    : [];
  const matchedTruth = new Set(pairs.map((pair) => pair.truth_key));
  const matchedCandidate = new Set(pairs.map((pair) => pair.candidate_key));
  const missedTruthKeys = truth.snapshot.elements.filter((element) => !matchedTruth.has(element.key)).map((element) => element.key);
  const falsePositiveKeys = candidate.snapshot.elements.filter((element) => !matchedCandidate.has(element.key)).map((element) => element.key);
  const architecturalOpeningRoles = new Set(["door", "window"]);
  const missedArchitecturalOpenings = truth.snapshot.elements.filter((element) =>
    !matchedTruth.has(element.key) && element.discipline === "architectural" && architecturalOpeningRoles.has(normalized(element.role))
  );
  const falsePositiveArchitecturalOpenings = candidate.snapshot.elements.filter((element) =>
    !matchedCandidate.has(element.key) && element.discipline === "architectural" && architecturalOpeningRoles.has(normalized(element.role))
  );
  const architecturalOpeningsExact = missedArchitecturalOpenings.length === 0 && falsePositiveArchitecturalOpenings.length === 0;
  const precision = candidate.snapshot.elements.length > 0 ? pairs.length / candidate.snapshot.elements.length : 0;
  const recall = truth.snapshot.elements.length > 0 ? pairs.length / truth.snapshot.elements.length : 0;
  const elementF1 = f1(precision, recall);
  const geometry = average(pairs.map((pair) => pair.geometry_score), 0);
  const elevation = average(pairs.map((pair) => pair.elevation_score), 1);
  const attributes = average(pairs.map((pair) => pair.attribute_score), 0);
  const systems = average(pairs.map((pair) => pair.system_score), 0);
  const spatial = average(pairs.map((pair) => pair.spatial_score), 0);
  const connectivity = pairs.length > 0 ? connectivityScore(truth.snapshot, candidate.snapshot, pairs) : 0;
  const architecturalTopology = pairs.length > 0 ? relationshipF1(truth.snapshot, candidate.snapshot, pairs, "wall_junction") : 0;
  const hosting = pairs.length > 0 ? relationshipF1(truth.snapshot, candidate.snapshot, pairs, "host") : 0;
  const electricalCircuits = pairs.length > 0 ? relationshipF1(truth.snapshot, candidate.snapshot, pairs, "electrical_circuit") : 0;
  const physicalConnectivityApplicable = hasTruthRelationship(truth.snapshot, "physical") || hasTruthRelationship(candidate.snapshot, "physical");
  const architecturalTopologyApplicable = hasTruthRelationship(truth.snapshot, "wall_junction") || hasTruthRelationship(candidate.snapshot, "wall_junction");
  const systemsApplicable = truth.snapshot.elements.some((element) => normalized(element.system_classification) || normalized(element.system_type));
  // Room/space membership is the spatial hard gate. Some linked-face-hosted Revit
  // families expose no writable/readable level after a safe copy even when their
  // world elevation and host are exact; level remains a reported pair metric but
  // cannot by itself make an otherwise grounded reconstruction invalid.
  const spatialApplicable = truth.snapshot.elements.some((element) => normalized(element.room_number) || normalized(element.space_number));
  const hostingApplicable = hasTruthRelationship(truth.snapshot, "host") || hasTruthRelationship(candidate.snapshot, "host");
  const electricalCircuitsApplicable = hasTruthRelationship(truth.snapshot, "electrical_circuit") || hasTruthRelationship(candidate.snapshot, "electrical_circuit");
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
  const failures: string[] = [];
  for (const reason of invalidReasons) failures.push(reason.split(":", 1)[0]!);
  if (invalidReasons.length === 0) {
    if (candidate.snapshot.elements.length === 0) failures.push("no_reconstruction");
    if (recall < policy.minimum_recall) failures.push("incomplete_reconstruction");
    if (precision < policy.minimum_precision) failures.push("false_positive_elements");
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
      drawing_evidence: drawingEvidence
    },
    applicability: {
      physical_connectivity: physicalConnectivityApplicable,
      architectural_topology: architecturalTopologyApplicable,
      systems: systemsApplicable,
      spatial: spatialApplicable,
      hosting: hostingApplicable,
      electrical_circuits: electricalCircuitsApplicable
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
