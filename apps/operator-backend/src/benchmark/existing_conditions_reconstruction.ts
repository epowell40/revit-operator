import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJsonFile } from "./files.js";
import type { BridgeTransport, RevitWorkflowResult, RevitWorkflowVerification } from "./revit_workflows.js";

export type ExistingConditionsPoint3 = { x: number; y: number; z: number };

export type ExistingConditionsElementKind = "mep_curve" | "fitting" | "family_instance" | "other";

export type ExistingConditionsElement = {
  key: string;
  kind: ExistingConditionsElementKind;
  category: string;
  family?: string | null;
  type?: string | null;
  system_classification?: string | null;
  system_type?: string | null;
  location?: ExistingConditionsPoint3 | null;
  endpoints?: [ExistingConditionsPoint3, ExistingConditionsPoint3] | null;
  rotation_degrees?: number | null;
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
  visible_evidence: ExistingConditionsEvidenceReceipt[];
  snapshot: ExistingConditionsSnapshot;
};

export type ExistingConditionsCandidate = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  visible_evidence: ExistingConditionsEvidenceReceipt[];
  accessed_artifact_roles: string[];
  out_of_scope_changed_element_keys: string[];
  snapshot: ExistingConditionsSnapshot;
  visual_receipt?: {
    post_change_capture_sha256?: string | null;
    post_change_pdf_sha256?: string | null;
    review_status?: "pass" | "needs_review" | "fail" | null;
  } | null;
};

export type ExistingConditionsScoringPolicy = {
  location_tolerance_ft: number;
  endpoint_tolerance_ft: number;
  rotation_tolerance_degrees: number;
  size_tolerance_ft: number;
  minimum_pair_score: number;
  passing_score: number;
  minimum_precision: number;
  minimum_recall: number;
  minimum_connectivity_score: number;
};

export type ExistingConditionsMatchedPair = {
  truth_key: string;
  candidate_key: string;
  pair_score: number;
  geometry_score: number;
  attribute_score: number;
  system_score: number;
  distance_ft: number | null;
};

export type ExistingConditionsScore = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  valid_run: boolean;
  passed: boolean;
  score: number;
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
    attributes: number;
    connectivity: number;
    systems: number;
    drawing_evidence: number;
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
  minimum_pair_score: 0.45,
  passing_score: 85,
  minimum_precision: 0.8,
  minimum_recall: 0.8,
  minimum_connectivity_score: 0.75
};

const FORBIDDEN_AGENT_ARTIFACT_ROLES = new Set([
  "ground_truth",
  "ground_truth_model",
  "ground_truth_snapshot",
  "truth_manifest",
  "deletion_manifest",
  "withheld_evaluator_package"
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
  return {
    id,
    element: {
      key: firstText(raw.sourceScopedId, raw.source_scoped_id, `host:${Math.trunc(id)}`)!,
      kind,
      category,
      family: firstText(raw.familyName, raw.family_name),
      type: firstText(raw.typeName, raw.type_name, raw.name),
      system_classification: firstText(raw.systemClassification, raw.system_classification, system.systemClassification, system.system_classification),
      system_type: firstText(system.systemType, system.system_type, parameters.systemType),
      location,
      endpoints: start && end ? [start, end] : null,
      rotation_degrees: radians === null ? null : radians * 180 / Math.PI,
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
  const edges = new Set<string>();
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
        edges.add(canonicalEdge(ownerKey, refKey));
      }
    }
  }
  const nativeReadback = selectedIds.size > 0 &&
    normalizedRows.length === selectedIds.size &&
    (options.require_connector_readback === false || seenConnectorIds.size === selectedIds.size);
  return {
    native_readback: nativeReadback,
    elements: normalizedRows.map((entry) => entry.element),
    connections: [...edges].map((edge) => {
      const separator = edge.indexOf("::");
      return { a: edge.slice(0, separator), b: edge.slice(separator + 2) };
    }),
    open_connector_count: openConnectorCount
  };
}

function pointDistance(a: ExistingConditionsPoint3, b: ExistingConditionsPoint3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function endpointDistance(
  truth: [ExistingConditionsPoint3, ExistingConditionsPoint3],
  candidate: [ExistingConditionsPoint3, ExistingConditionsPoint3]
): number {
  const forward = Math.max(pointDistance(truth[0], candidate[0]), pointDistance(truth[1], candidate[1]));
  const reverse = Math.max(pointDistance(truth[0], candidate[1]), pointDistance(truth[1], candidate[0]));
  return Math.min(forward, reverse);
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
  policy: ExistingConditionsScoringPolicy
): { score: number; distance_ft: number | null } {
  let distance: number | null = null;
  let tolerance = policy.location_tolerance_ft;
  if (truth.endpoints && candidate.endpoints) {
    distance = endpointDistance(truth.endpoints, candidate.endpoints);
    tolerance = policy.endpoint_tolerance_ft;
  } else if (truth.location && candidate.location) {
    distance = pointDistance(truth.location, candidate.location);
  }
  const position = distance === null ? 0 : clamp01(1 - distance / Math.max(tolerance, Number.EPSILON));
  const rotation = numericFieldScore(
    truth.rotation_degrees,
    candidate.rotation_degrees,
    policy.rotation_tolerance_degrees
  );
  const rotationScore = rotation === null
    ? null
    : clamp01(1 - circularDegreesDifference(Number(truth.rotation_degrees), Number(candidate.rotation_degrees)) /
      Math.max(policy.rotation_tolerance_degrees, Number.EPSILON));
  return { score: average([position, rotationScore], position), distance_ft: distance };
}

function attributeComparison(
  truth: ExistingConditionsElement,
  candidate: ExistingConditionsElement,
  policy: ExistingConditionsScoringPolicy
): number {
  const scores: Array<number | null> = [
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

function comparePair(
  truth: ExistingConditionsElement,
  candidate: ExistingConditionsElement,
  policy: ExistingConditionsScoringPolicy
): ExistingConditionsMatchedPair | null {
  if (normalized(truth.category) !== normalized(candidate.category)) return null;
  if (truth.kind !== candidate.kind) return null;
  const geometry = geometryComparison(truth, candidate, policy);
  if (geometry.score <= 0) return null;
  const attributes = attributeComparison(truth, candidate, policy);
  const systems = systemComparison(truth, candidate);
  const pairScore = 0.6 * geometry.score + 0.3 * attributes + 0.1 * systems;
  if (pairScore < policy.minimum_pair_score) return null;
  return {
    truth_key: truth.key,
    candidate_key: candidate.key,
    pair_score: round(pairScore),
    geometry_score: round(geometry.score),
    attribute_score: round(attributes),
    system_score: round(systems),
    distance_ft: geometry.distance_ft === null ? null : round(geometry.distance_ft)
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
  policy: ExistingConditionsScoringPolicy
): ExistingConditionsMatchedPair[] {
  if (truth.length === 0 || candidate.length === 0) return [];
  const pairMatrix = truth.map((truthElement) =>
    candidate.map((candidateElement) => comparePair(truthElement, candidateElement, policy))
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

function f1(precision: number, recall: number): number {
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

function connectivityScore(
  truth: ExistingConditionsSnapshot,
  candidate: ExistingConditionsSnapshot,
  pairs: ExistingConditionsMatchedPair[]
): number {
  const truthToCandidate = new Map(pairs.map((pair) => [pair.truth_key, pair.candidate_key]));
  const candidateToTruth = new Map(pairs.map((pair) => [pair.candidate_key, pair.truth_key]));
  const truthElementKeys = new Set(truth.elements.map((element) => element.key));
  const candidateElementKeys = new Set(candidate.elements.map((element) => element.key));
  const truthEdges = new Set(truth.connections.map((edge) => canonicalEdge(edge.a, edge.b)));
  const candidateEdges = new Set(candidate.connections.map((edge) => canonicalEdge(edge.a, edge.b)));
  let preserved = 0;
  for (const edge of truth.connections) {
    const a = truthToCandidate.get(edge.a) ?? (!truthElementKeys.has(edge.a) ? edge.a : undefined);
    const b = truthToCandidate.get(edge.b) ?? (!truthElementKeys.has(edge.b) ? edge.b : undefined);
    if (a && b && candidateEdges.has(canonicalEdge(a, b))) preserved += 1;
  }
  let validCandidate = 0;
  for (const edge of candidate.connections) {
    const a = candidateToTruth.get(edge.a) ?? (!candidateElementKeys.has(edge.a) ? edge.a : undefined);
    const b = candidateToTruth.get(edge.b) ?? (!candidateElementKeys.has(edge.b) ? edge.b : undefined);
    if (a && b && truthEdges.has(canonicalEdge(a, b))) validCandidate += 1;
  }
  const edgeRecall = truthEdges.size === 0 ? (candidateEdges.size === 0 ? 1 : 0) : preserved / truthEdges.size;
  const edgePrecision = candidateEdges.size === 0 ? (truthEdges.size === 0 ? 1 : 0) : validCandidate / candidateEdges.size;
  const edgeF1 = f1(edgePrecision, edgeRecall);
  const openDenominator = Math.max(1, truth.open_connector_count, candidate.open_connector_count);
  const openScore = clamp01(1 - Math.abs(truth.open_connector_count - candidate.open_connector_count) / openDenominator);
  return 0.8 * edgeF1 + 0.2 * openScore;
}

function evidenceMap(receipts: ExistingConditionsEvidenceReceipt[]): Map<string, string> {
  return new Map(receipts.map((entry) => [normalized(entry.role), normalized(entry.sha256)]));
}

function validateRun(truth: ExistingConditionsGroundTruth, candidate: ExistingConditionsCandidate): string[] {
  const reasons: string[] = [];
  if (truth.schema_version !== 1 || candidate.schema_version !== 1) reasons.push("unsupported_schema_version");
  if (truth.fixture_id !== candidate.fixture_id) reasons.push("fixture_id_mismatch");
  if (truth.scope_id !== candidate.scope_id) reasons.push("scope_id_mismatch");
  if (!truth.snapshot.native_readback || !candidate.snapshot.native_readback) reasons.push("missing_native_readback");
  if (truth.snapshot.elements.length === 0) reasons.push("empty_ground_truth");
  if (candidate.out_of_scope_changed_element_keys.length > 0) reasons.push("out_of_scope_write");
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
  const pairs = invalidReasons.length === 0
    ? globallyMatch(truth.snapshot.elements, candidate.snapshot.elements, policy)
    : [];
  const matchedTruth = new Set(pairs.map((pair) => pair.truth_key));
  const matchedCandidate = new Set(pairs.map((pair) => pair.candidate_key));
  const missedTruthKeys = truth.snapshot.elements.filter((element) => !matchedTruth.has(element.key)).map((element) => element.key);
  const falsePositiveKeys = candidate.snapshot.elements.filter((element) => !matchedCandidate.has(element.key)).map((element) => element.key);
  const precision = candidate.snapshot.elements.length > 0 ? pairs.length / candidate.snapshot.elements.length : 0;
  const recall = truth.snapshot.elements.length > 0 ? pairs.length / truth.snapshot.elements.length : 0;
  const elementF1 = f1(precision, recall);
  const geometry = average(pairs.map((pair) => pair.geometry_score), 0);
  const attributes = average(pairs.map((pair) => pair.attribute_score), 0);
  const systems = average(pairs.map((pair) => pair.system_score), 0);
  const connectivity = pairs.length > 0 ? connectivityScore(truth.snapshot, candidate.snapshot, pairs) : 0;
  const drawingEvidence = candidate.visual_receipt?.post_change_capture_sha256 &&
    candidate.visual_receipt?.post_change_pdf_sha256 &&
    candidate.visual_receipt?.review_status === "pass" ? 1 : 0;
  const weightedScore = invalidReasons.length > 0 ? 0 : 100 * (
    0.2 * elementF1 +
    0.25 * geometry +
    0.2 * attributes +
    0.2 * connectivity +
    0.1 * systems +
    0.05 * drawingEvidence
  );
  const failures: string[] = [];
  for (const reason of invalidReasons) failures.push(reason.split(":", 1)[0]!);
  if (invalidReasons.length === 0) {
    if (candidate.snapshot.elements.length === 0) failures.push("no_reconstruction");
    if (recall < policy.minimum_recall) failures.push("incomplete_reconstruction");
    if (precision < policy.minimum_precision) failures.push("false_positive_elements");
    if (geometry < 0.8) failures.push("geometry_mismatch");
    if (attributes < 0.8) failures.push("attribute_mismatch");
    if (connectivity < policy.minimum_connectivity_score) failures.push("connectivity_mismatch");
    if (drawingEvidence < 1) failures.push("drawing_verification_missing");
    if (weightedScore < policy.passing_score) failures.push("score_below_threshold");
  }
  const passed = invalidReasons.length === 0 &&
    weightedScore >= policy.passing_score &&
    precision >= policy.minimum_precision &&
    recall >= policy.minimum_recall &&
    connectivity >= policy.minimum_connectivity_score &&
    drawingEvidence === 1;
  return {
    schema_version: 1,
    fixture_id: truth.fixture_id,
    scope_id: truth.scope_id,
    valid_run: invalidReasons.length === 0,
    passed,
    score: round(weightedScore, 3),
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
      attributes: round(attributes),
      connectivity: round(connectivity),
      systems: round(systems),
      drawing_evidence: drawingEvidence
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
    `| Attributes | ${result.metrics.attributes.toFixed(3)} |`,
    `| Connectivity | ${result.metrics.connectivity.toFixed(3)} |`,
    `| Systems | ${result.metrics.systems.toFixed(3)} |`,
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
    { name: "connectivity_meets_threshold", ok: result.metrics.connectivity >= (policy.minimum_connectivity_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_connectivity_score), expected: policy.minimum_connectivity_score ?? DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY.minimum_connectivity_score, actual: result.metrics.connectivity },
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
