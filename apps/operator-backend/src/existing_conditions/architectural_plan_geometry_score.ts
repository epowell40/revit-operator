import crypto from "node:crypto";
import type {
  ExistingConditionsConnection,
  ExistingConditionsElement,
  ExistingConditionsGroundTruth,
  ExistingConditionsPoint3
} from "../benchmark/existing_conditions_reconstruction.js";
import type {
  ArchitecturalPlanGeometryPreviewElement,
  CompiledArchitecturalPlanGeometryPreview
} from "./architectural_plan_geometry_preview.js";

export type ArchitecturalPlanGeometryScoringPolicy = {
  wall_endpoint_tolerance_ft: number;
  opening_location_tolerance_ft: number;
  passing_score: number;
  minimum_precision: number;
  minimum_recall: number;
  minimum_geometry_score: number;
  minimum_wall_topology_score: number;
  minimum_hosting_score: number;
};

export const DEFAULT_ARCHITECTURAL_PLAN_GEOMETRY_SCORING_POLICY: ArchitecturalPlanGeometryScoringPolicy = {
  wall_endpoint_tolerance_ft: 1,
  opening_location_tolerance_ft: 1,
  passing_score: 85,
  minimum_precision: 0.8,
  minimum_recall: 0.8,
  minimum_geometry_score: 0.75,
  minimum_wall_topology_score: 0.8,
  minimum_hosting_score: 0.75
};

const ISSUED_ARCHITECTURAL_PLAN_GEOMETRY_SCORES = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function isIssuedArchitecturalPlanGeometryScore(value: unknown): value is ArchitecturalPlanGeometryScore {
  return !!value && typeof value === "object" && ISSUED_ARCHITECTURAL_PLAN_GEOMETRY_SCORES.has(value as object);
}

export type ArchitecturalPlanGeometryMatchedPair = {
  truth_key: string;
  preview_key: string;
  role: "wall" | "door" | "window";
  distance_ft: number;
  geometry_score: number;
};

export type ArchitecturalPlanGeometryScore = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  preview_fingerprint_sha256: string;
  scoring_policy: ArchitecturalPlanGeometryScoringPolicy;
  scoring_policy_fingerprint_sha256: string;
  valid_run: boolean;
  passed: boolean;
  score: number;
  invalid_reasons: string[];
  failure_classifications: string[];
  counts: {
    truth: number;
    preview: number;
    matched: number;
    missed: number;
    false_positive: number;
    ungrounded_preview: number;
  };
  metrics: {
    precision: number;
    recall: number;
    element_f1: number;
    geometry: number;
    wall_topology: number;
    hosting: number;
  };
  applicability: {
    wall_topology: boolean;
    hosting: boolean;
  };
  matched_pairs: ArchitecturalPlanGeometryMatchedPair[];
  missed_truth_keys: string[];
  false_positive_preview_keys: string[];
};

type CandidatePair = ArchitecturalPlanGeometryMatchedPair | null;

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

export function architecturalPlanGeometryScoringPolicyFingerprint(policy: ArchitecturalPlanGeometryScoringPolicy): string {
  const ordered = Object.fromEntries(Object.keys(policy).sort().map((key) => [
    key,
    policy[key as keyof ArchitecturalPlanGeometryScoringPolicy]
  ]));
  return crypto.createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function average(values: number[], fallback = 0): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

function f1(precision: number, recall: number): number {
  return precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
}

function distance(a: ExistingConditionsPoint3, b: ExistingConditionsPoint3): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function endpointDistance(
  truth: [ExistingConditionsPoint3, ExistingConditionsPoint3],
  preview: [{ x: number; y: number }, { x: number; y: number }]
): number {
  const candidate: [ExistingConditionsPoint3, ExistingConditionsPoint3] = [
    { ...preview[0], z: truth[0].z },
    { ...preview[1], z: truth[1].z }
  ];
  const forward = Math.max(distance(truth[0], candidate[0]), distance(truth[1], candidate[1]));
  const reverse = Math.max(distance(truth[0], candidate[1]), distance(truth[1], candidate[0]));
  return Math.min(forward, reverse);
}

function role(value: unknown): "wall" | "door" | "window" | null {
  const text = normalized(value);
  return text === "wall" || text === "door" || text === "window" ? text : null;
}

function comparePair(
  truth: ExistingConditionsElement,
  preview: ArchitecturalPlanGeometryPreviewElement,
  policy: ArchitecturalPlanGeometryScoringPolicy
): CandidatePair {
  const truthRole = role(truth.role);
  if (!truthRole || truthRole !== preview.kind) return null;
  let geometryDistance: number | null = null;
  let tolerance = policy.opening_location_tolerance_ft;
  if (truthRole === "wall" && truth.endpoints && preview.geometry.points) {
    geometryDistance = endpointDistance(truth.endpoints, preview.geometry.points);
    tolerance = policy.wall_endpoint_tolerance_ft;
  } else if (truthRole !== "wall" && truth.location && preview.geometry.point) {
    geometryDistance = distance(truth.location, { ...preview.geometry.point, z: truth.location.z });
  }
  if (geometryDistance === null || geometryDistance > tolerance) return null;
  return {
    truth_key: truth.key,
    preview_key: preview.plan_key,
    role: truthRole,
    distance_ft: round(geometryDistance),
    geometry_score: round(clamp01(1 - geometryDistance / Math.max(tolerance, Number.EPSILON)))
  };
}

function assignRowsToColumns(costs: number[][]): number[] {
  const rowCount = costs.length;
  const columnCount = costs[0]?.length ?? 0;
  if (rowCount === 0) return [];
  if (columnCount === 0) return Array(rowCount).fill(-1);
  if (rowCount > columnCount) throw new Error("architectural_preview_assignment_requires_rows_not_greater_than_columns");
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
        const current = costs[i0 - 1]![j - 1]! - u[i0] - v[j];
        if (current < minv[j]) {
          minv[j] = current;
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
  preview: ArchitecturalPlanGeometryPreviewElement[],
  policy: ArchitecturalPlanGeometryScoringPolicy
): ArchitecturalPlanGeometryMatchedPair[] {
  if (truth.length === 0 || preview.length === 0) return [];
  const matrix = truth.map((truthElement) => preview.map((previewElement) => comparePair(truthElement, previewElement, policy)));
  const impossible = 1_000_000;
  if (truth.length <= preview.length) {
    const assignment = assignRowsToColumns(matrix.map((row) => row.map((pair) => pair ? pair.distance_ft : impossible)));
    return assignment.flatMap((previewIndex, truthIndex) => {
      const pair = previewIndex >= 0 ? matrix[truthIndex]?.[previewIndex] : null;
      return pair ? [pair] : [];
    });
  }
  const transposed = preview.map((_, previewIndex) => truth.map((__, truthIndex) => {
    const pair = matrix[truthIndex]?.[previewIndex];
    return pair ? pair.distance_ft : impossible;
  }));
  const assignment = assignRowsToColumns(transposed);
  return assignment.flatMap((truthIndex, previewIndex) => {
    const pair = truthIndex >= 0 ? matrix[truthIndex]?.[previewIndex] : null;
    return pair ? [pair] : [];
  });
}

function canonicalEdge(a: string, b: string): string {
  return normalized(a) < normalized(b) ? `${a}::${b}` : `${b}::${a}`;
}

function relationshipScore(
  truthConnections: ExistingConditionsConnection[],
  previewConnections: ExistingConditionsConnection[],
  pairs: ArchitecturalPlanGeometryMatchedPair[],
  kind: "wall_junction" | "host"
): number {
  const truthToPreview = new Map(pairs.map((pair) => [pair.truth_key, pair.preview_key]));
  const previewToTruth = new Map(pairs.map((pair) => [pair.preview_key, pair.truth_key]));
  const truthEdges = truthConnections.filter((entry) => entry.kind === kind);
  const previewEdges = previewConnections.filter((entry) => entry.kind === kind);
  const previewSet = new Set(previewEdges.map((entry) => canonicalEdge(entry.a, entry.b)));
  const truthSet = new Set(truthEdges.map((entry) => canonicalEdge(entry.a, entry.b)));
  const preservedTruth = truthEdges.filter((entry) => {
    const a = truthToPreview.get(entry.a);
    const b = truthToPreview.get(entry.b);
    return !!a && !!b && previewSet.has(canonicalEdge(a, b));
  }).length;
  const validPreview = previewEdges.filter((entry) => {
    const a = previewToTruth.get(entry.a);
    const b = previewToTruth.get(entry.b);
    return !!a && !!b && truthSet.has(canonicalEdge(a, b));
  }).length;
  const recall = truthEdges.length === 0 ? (previewEdges.length === 0 ? 1 : 0) : preservedTruth / truthEdges.length;
  const precision = previewEdges.length === 0 ? (truthEdges.length === 0 ? 1 : 0) : validPreview / previewEdges.length;
  return f1(precision, recall);
}

function previewConnections(preview: CompiledArchitecturalPlanGeometryPreview): ExistingConditionsConnection[] {
  const wallJunctions = preview.wall_junctions.map((entry) => ({
    a: entry.a_wall_observation_id,
    b: entry.b_wall_observation_id,
    kind: "wall_junction" as const
  }));
  const hosts = preview.preview_elements.flatMap((entry) => {
    const host = entry.geometry.host_wall_observation_id;
    return host ? [{ a: entry.plan_key, b: host, kind: "host" as const }] : [];
  });
  return [...wallJunctions, ...hosts];
}

export function scoreArchitecturalPlanGeometryPreview(
  truth: ExistingConditionsGroundTruth,
  preview: CompiledArchitecturalPlanGeometryPreview,
  overrides: Partial<ArchitecturalPlanGeometryScoringPolicy> = {}
): ArchitecturalPlanGeometryScore {
  const policy = { ...DEFAULT_ARCHITECTURAL_PLAN_GEOMETRY_SCORING_POLICY, ...overrides };
  const invalidReasons: string[] = [];
  if (truth.schema_version !== 1 || preview.schema_version !== 1) invalidReasons.push("unsupported_schema_version");
  if (truth.fixture_id !== preview.fixture_id) invalidReasons.push("fixture_id_mismatch");
  if (truth.scope_id !== preview.scope_id) invalidReasons.push("scope_id_mismatch");
  if (!truth.snapshot.native_readback) invalidReasons.push("ground_truth_missing_native_readback");
  if (!preview.registration.verified) invalidReasons.push("registration_not_verified");
  if (preview.status !== "preview_ready") invalidReasons.push(`preview_not_ready:${preview.status}`);
  if (preview.native_action !== null) invalidReasons.push("preview_must_not_emit_native_action");
  const ungrounded = preview.preview_elements.filter((entry) => !entry.geometry_grounded);
  if (ungrounded.length > 0) invalidReasons.push("ungrounded_preview_geometry");
  const expectedSourceHash = truth.visible_evidence.find((entry) => normalized(entry.role) === "source pdf")?.sha256;
  if (expectedSourceHash && normalized(expectedSourceHash) !== normalized(preview.registration.source_evidence_sha256)) {
    invalidReasons.push("source_evidence_changed");
  }

  const truthElements = truth.snapshot.elements.filter((entry) =>
    normalized(entry.discipline) === "architectural" && role(entry.role) !== null
  );
  const pairs = invalidReasons.length === 0 ? globallyMatch(truthElements, preview.preview_elements, policy) : [];
  const matchedTruth = new Set(pairs.map((entry) => entry.truth_key));
  const matchedPreview = new Set(pairs.map((entry) => entry.preview_key));
  const missedTruthKeys = truthElements.filter((entry) => !matchedTruth.has(entry.key)).map((entry) => entry.key);
  const falsePositivePreviewKeys = preview.preview_elements.filter((entry) => !matchedPreview.has(entry.plan_key)).map((entry) => entry.plan_key);
  const precision = preview.preview_elements.length > 0 ? pairs.length / preview.preview_elements.length : 0;
  const recall = truthElements.length > 0 ? pairs.length / truthElements.length : 0;
  const elementF1 = f1(precision, recall);
  const geometry = average(pairs.map((entry) => entry.geometry_score));
  const candidateConnections = previewConnections(preview);
  const wallTopologyApplicable = truth.snapshot.connections.some((entry) => entry.kind === "wall_junction") ||
    candidateConnections.some((entry) => entry.kind === "wall_junction");
  const hostingApplicable = truth.snapshot.connections.some((entry) => entry.kind === "host") ||
    candidateConnections.some((entry) => entry.kind === "host");
  const wallTopology = pairs.length > 0 ? relationshipScore(truth.snapshot.connections, candidateConnections, pairs, "wall_junction") : 0;
  const hosting = pairs.length > 0 ? relationshipScore(truth.snapshot.connections, candidateConnections, pairs, "host") : 0;
  const weighted = [
    { value: elementF1, weight: 0.55, applicable: true },
    { value: geometry, weight: 0.25, applicable: true },
    { value: wallTopology, weight: 0.12, applicable: wallTopologyApplicable },
    { value: hosting, weight: 0.08, applicable: hostingApplicable }
  ].filter((entry) => entry.applicable);
  const score = weighted.length > 0
    ? 100 * weighted.reduce((sum, entry) => sum + entry.value * entry.weight, 0) /
      weighted.reduce((sum, entry) => sum + entry.weight, 0)
    : 0;
  const failures: string[] = [];
  if (precision < policy.minimum_precision) failures.push("plan_geometry_precision_below_threshold");
  if (recall < policy.minimum_recall) failures.push("plan_geometry_recall_below_threshold");
  if (geometry < policy.minimum_geometry_score) failures.push("plan_geometry_mismatch");
  if (wallTopologyApplicable && wallTopology < policy.minimum_wall_topology_score) failures.push("plan_wall_topology_mismatch");
  if (hostingApplicable && hosting < policy.minimum_hosting_score) failures.push("plan_opening_hosting_mismatch");
  if (score < policy.passing_score) failures.push("plan_geometry_score_below_threshold");
  const validRun = invalidReasons.length === 0;
  const receipt: ArchitecturalPlanGeometryScore = {
    schema_version: 1,
    fixture_id: preview.fixture_id,
    scope_id: preview.scope_id,
    preview_fingerprint_sha256: preview.input_fingerprint_sha256,
    scoring_policy: policy,
    scoring_policy_fingerprint_sha256: architecturalPlanGeometryScoringPolicyFingerprint(policy),
    valid_run: validRun,
    passed: validRun && failures.length === 0,
    score: round(score),
    invalid_reasons: [...new Set(invalidReasons)],
    failure_classifications: validRun ? [...new Set(failures)] : [],
    counts: {
      truth: truthElements.length,
      preview: preview.preview_elements.length,
      matched: pairs.length,
      missed: missedTruthKeys.length,
      false_positive: falsePositivePreviewKeys.length,
      ungrounded_preview: ungrounded.length
    },
    metrics: {
      precision: round(precision),
      recall: round(recall),
      element_f1: round(elementF1),
      geometry: round(geometry),
      wall_topology: round(wallTopology),
      hosting: round(hosting)
    },
    applicability: { wall_topology: wallTopologyApplicable, hosting: hostingApplicable },
    matched_pairs: pairs,
    missed_truth_keys: missedTruthKeys,
    false_positive_preview_keys: falsePositivePreviewKeys
  };
  deepFreeze(receipt);
  ISSUED_ARCHITECTURAL_PLAN_GEOMETRY_SCORES.add(receipt);
  return receipt;
}
