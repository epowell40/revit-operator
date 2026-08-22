import crypto from "node:crypto";
import type {
  ExistingConditionsElement,
  ExistingConditionsGroundTruth,
  ExistingConditionsPoint3,
  ExistingConditionsSnapshot
} from "./model_contract.js";
import {
  buildAtomicMepDraftWorkflowRequest,
  type AtomicMepDraftWorkflowRequest
} from "./mep_draft_plan.js";
import type { RegisteredMepObservationCompilation } from "./registered_mep_observations.js";

export type MepPreApplyGeometryScoringPolicy = {
  point_location_tolerance_ft: number;
  route_endpoint_tolerance_ft: number;
  minimum_precision: number;
  minimum_recall: number;
  minimum_geometry_score: number;
  passing_score: number;
};

export const DEFAULT_MEP_PRE_APPLY_GEOMETRY_SCORING_POLICY: MepPreApplyGeometryScoringPolicy = {
  point_location_tolerance_ft: 0.5,
  route_endpoint_tolerance_ft: 0.5,
  minimum_precision: 1,
  minimum_recall: 1,
  minimum_geometry_score: 0.8,
  passing_score: 90
};

export type MepPreApplyGeometryMatchedPair = {
  proposal_key: string;
  discipline: string;
  role: string;
  plan_distance_ft: number;
  geometry_score: number;
};

export type MepPreApplyGeometryScore = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  compilation_fingerprint_sha256: string;
  truth_fingerprint_sha256: string;
  scoring_policy: MepPreApplyGeometryScoringPolicy;
  scoring_policy_fingerprint_sha256: string;
  valid_run: boolean;
  passed: boolean;
  score: number;
  invalid_reasons: string[];
  failure_classifications: string[];
  counts: {
    truth: number;
    proposal: number;
    matched: number;
    missed: number;
    false_positive: number;
  };
  metrics: {
    precision: number;
    recall: number;
    element_f1: number;
    geometry: number;
    route_precision: number | null;
    route_recall: number | null;
  };
  matched_pairs: MepPreApplyGeometryMatchedPair[];
  false_positive_proposal_keys: string[];
};

export type ScoreGatedMepWorkflowPromotion = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  compilation_fingerprint_sha256: string;
  score: MepPreApplyGeometryScore;
  workflow: AtomicMepDraftWorkflowRequest;
  capability_boundary: string;
};

const ISSUED_MEP_PRE_APPLY_GEOMETRY_SCORES = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
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

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function f1(precision: number, recall: number): number {
  return precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
}

function finitePoint(value: unknown): ExistingConditionsPoint3 | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Record<string, unknown>;
  if (typeof point.x !== "number" || typeof point.y !== "number"
    || (point.z !== undefined && typeof point.z !== "number")) return null;
  const x = point.x;
  const y = point.y;
  const z = point.z ?? 0;
  const maximumAbsoluteCoordinateFt = 10_000_000;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
    && Math.abs(x) <= maximumAbsoluteCoordinateFt
    && Math.abs(y) <= maximumAbsoluteCoordinateFt
    && Math.abs(z) <= maximumAbsoluteCoordinateFt
    ? { x, y, z }
    : null;
}

function planDistance(first: ExistingConditionsPoint3, second: ExistingConditionsPoint3): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

type RouteSegment = {
  key: string;
  discipline: string;
  role: string;
  start: ExistingConditionsPoint3;
  end: ExistingConditionsPoint3;
};

function routeSegment(element: ExistingConditionsElement): RouteSegment | null {
  if (element.kind !== "mep_curve" || !element.endpoints) return null;
  const start = finitePoint(element.endpoints[0]);
  const end = finitePoint(element.endpoints[1]);
  if (!start || !end || planDistance(start, end) <= Number.EPSILON) return null;
  return {
    key: element.key,
    discipline: normalized(element.discipline),
    role: normalized(element.role),
    start,
    end
  };
}

function pointToSegmentDistance(point: ExistingConditionsPoint3, segment: RouteSegment): number {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) return planDistance(point, segment.start);
  const t = clamp01(((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lengthSquared);
  return Math.hypot(point.x - (segment.start.x + t * dx), point.y - (segment.start.y + t * dy));
}

const MAX_ROUTE_SAMPLES_PER_SEGMENT = 10_000;
const MAX_ROUTE_SAMPLES_PER_COVERAGE_PASS = 200_000;

function sampleSegment(segment: RouteSegment, spacing: number): ExistingConditionsPoint3[] | null {
  const length = planDistance(segment.start, segment.end);
  const intervals = Math.max(1, Math.ceil(length / spacing));
  if (!Number.isSafeInteger(intervals) || intervals > MAX_ROUTE_SAMPLES_PER_SEGMENT) return null;
  return Array.from({ length: intervals + 1 }, (_, index) => {
    const t = index / intervals;
    return {
      x: segment.start.x + t * (segment.end.x - segment.start.x),
      y: segment.start.y + t * (segment.end.y - segment.start.y),
      z: segment.start.z + t * (segment.end.z - segment.start.z)
    };
  });
}

function routeCoverage(
  source: RouteSegment[],
  target: RouteSegment[],
  tolerance: number
): { ratio: number; geometry: number; fully_covered_keys: Set<string>; uncovered_keys: string[]; budget_exceeded: boolean } {
  if (source.length === 0) {
    return {
      ratio: target.length === 0 ? 1 : 0,
      geometry: target.length === 0 ? 1 : 0,
      fully_covered_keys: new Set(),
      uncovered_keys: [],
      budget_exceeded: false
    };
  }
  const fullyCovered = new Set<string>();
  const uncoveredKeys: string[] = [];
  let sampleCount = 0;
  let coveredCount = 0;
  let geometryTotal = 0;
  for (const segment of source) {
    const compatibleTargets = target.filter((entry) =>
      entry.discipline === segment.discipline && entry.role === segment.role
    );
    const samples = sampleSegment(segment, Math.max(0.05, tolerance / 2));
    if (!samples || sampleCount + samples.length > MAX_ROUTE_SAMPLES_PER_COVERAGE_PASS) {
      return {
        ratio: 0,
        geometry: 0,
        fully_covered_keys: new Set(),
        uncovered_keys: source.map((entry) => entry.key).sort(),
        budget_exceeded: true
      };
    }
    let segmentCovered = true;
    for (const sample of samples) {
      sampleCount += 1;
      const distance = compatibleTargets.length > 0
        ? Math.min(...compatibleTargets.map((entry) => pointToSegmentDistance(sample, entry)))
        : Number.POSITIVE_INFINITY;
      const covered = distance <= tolerance;
      if (covered) coveredCount += 1;
      else segmentCovered = false;
      geometryTotal += clamp01(1 - distance / Math.max(tolerance, Number.EPSILON));
    }
    if (segmentCovered) fullyCovered.add(segment.key);
    else uncoveredKeys.push(segment.key);
  }
  return {
    ratio: sampleCount > 0 ? coveredCount / sampleCount : 0,
    geometry: sampleCount > 0 ? geometryTotal / sampleCount : 0,
    fully_covered_keys: fullyCovered,
    uncovered_keys: uncoveredKeys.sort(),
    budget_exceeded: false
  };
}

function policyIsValid(policy: MepPreApplyGeometryScoringPolicy): boolean {
  return Number.isFinite(policy.point_location_tolerance_ft) && policy.point_location_tolerance_ft > 0
    && Number.isFinite(policy.route_endpoint_tolerance_ft) && policy.route_endpoint_tolerance_ft > 0
    && Number.isFinite(policy.minimum_precision) && policy.minimum_precision >= 0 && policy.minimum_precision <= 1
    && Number.isFinite(policy.minimum_recall) && policy.minimum_recall >= 0 && policy.minimum_recall <= 1
    && Number.isFinite(policy.minimum_geometry_score) && policy.minimum_geometry_score >= 0 && policy.minimum_geometry_score <= 1
    && Number.isFinite(policy.passing_score) && policy.passing_score >= 0 && policy.passing_score <= 100;
}

function observationDiscipline(observation: Record<string, unknown>): string {
  const explicit = normalized(observation.discipline);
  if (explicit && explicit !== "mixed") return explicit;
  const kind = normalized(observation.kind);
  if (kind.includes("electrical") || kind.includes("conduit") || kind.includes("light fixture")) return "electrical";
  if (kind.includes("duct") || kind.includes("air terminal") || kind.includes("mechanical")) return "mechanical";
  return "plumbing";
}

function observationKindSupportsDiscipline(kind: string, discipline: string): boolean {
  if (kind === "plumbing fixture") return discipline === "plumbing";
  if (kind === "mechanical equipment" || kind === "air terminal" || kind === "duct route") return discipline === "mechanical";
  if (kind === "electrical device" || kind === "light fixture" || kind === "electrical equipment"
    || kind === "conduit route" || kind === "electrical circuit") return discipline === "electrical";
  if (kind === "pipe route") return discipline === "plumbing" || discipline === "mechanical";
  return false;
}

function routeHasMaterialSelfOverlap(routes: RouteSegment[], tolerance: number): boolean {
  for (let firstIndex = 0; firstIndex < routes.length; firstIndex += 1) {
    const first = routes[firstIndex]!;
    const firstDx = first.end.x - first.start.x;
    const firstDy = first.end.y - first.start.y;
    const firstLength = Math.hypot(firstDx, firstDy);
    const ux = firstDx / firstLength;
    const uy = firstDy / firstLength;
    for (let secondIndex = firstIndex + 1; secondIndex < routes.length; secondIndex += 1) {
      const second = routes[secondIndex]!;
      if (second.discipline !== first.discipline || second.role !== first.role) continue;
      const secondDx = second.end.x - second.start.x;
      const secondDy = second.end.y - second.start.y;
      const secondLength = Math.hypot(secondDx, secondDy);
      const parallelError = Math.abs(ux * (secondDy / secondLength) - uy * (secondDx / secondLength));
      if (parallelError > 1e-6) continue;
      const normalDistance = (point: ExistingConditionsPoint3) =>
        Math.abs((point.x - first.start.x) * -uy + (point.y - first.start.y) * ux);
      const collinearityTolerance = Math.min(tolerance, 1e-4);
      if (normalDistance(second.start) > collinearityTolerance || normalDistance(second.end) > collinearityTolerance) continue;
      const project = (point: ExistingConditionsPoint3) =>
        (point.x - first.start.x) * ux + (point.y - first.start.y) * uy;
      const secondStart = project(second.start);
      const secondEnd = project(second.end);
      const overlap = Math.min(firstLength, Math.max(secondStart, secondEnd))
        - Math.max(0, Math.min(secondStart, secondEnd));
      if (overlap > tolerance) return true;
    }
  }
  return false;
}

export function proposedMepSnapshotFromCompilation(
  compilation: RegisteredMepObservationCompilation
): { snapshot: ExistingConditionsSnapshot; unsupported_observation_ids: string[] } {
  const elements: ExistingConditionsElement[] = [];
  const unsupported: string[] = [];
  const pointKinds = new Set([
    "plumbing fixture",
    "mechanical equipment",
    "air terminal",
    "electrical device",
    "light fixture",
    "electrical equipment"
  ]);
  const routeKinds = new Set(["pipe route", "duct route", "conduit route"]);
  const observations = compilation.converted_package?.observations;
  if (!Array.isArray(observations) || observations.length > 1_000) {
    return {
      snapshot: { native_readback: false, elements: [], connections: [], open_connector_count: 0 },
      unsupported_observation_ids: ["<invalid-or-oversized-observation-list>"]
    };
  }
  for (const rawObservation of observations) {
    const observation = rawObservation as unknown as Record<string, unknown>;
    const observationId = typeof observation.observation_id === "string" ? observation.observation_id.trim() : "";
    const kind = normalized(observation.kind);
    if (!observationId) {
      unsupported.push("<missing-observation-id>");
      continue;
    }
    const explicitDiscipline = normalized(observation.discipline);
    const discipline = observationDiscipline(observation);
    if (!explicitDiscipline || explicitDiscipline !== discipline) {
      unsupported.push(observationId);
      continue;
    }
    if (!observationKindSupportsDiscipline(kind, discipline)) {
      unsupported.push(observationId);
      continue;
    }
    if (kind === "electrical circuit") continue;
    if (pointKinds.has(kind)) {
      const point = finitePoint(observation.point);
      if (!point) {
        unsupported.push(observationId || "<missing-observation-id>");
        continue;
      }
      elements.push({
        key: `proposal:${observationId}`,
        kind: "family_instance",
        discipline: discipline as ExistingConditionsElement["discipline"],
        role: kind,
        category: kind,
        location: point,
        endpoints: null
      });
      continue;
    }
    if (routeKinds.has(kind)) {
      const rawPoints = Array.isArray(observation.points) ? observation.points : [];
      if (rawPoints.length > 2_000) {
        unsupported.push(observationId);
        continue;
      }
      const parsedPoints = rawPoints.map(finitePoint);
      if (parsedPoints.length < 2 || parsedPoints.some((entry) => entry === null)) {
        unsupported.push(observationId || "<missing-observation-id>");
        continue;
      }
      const points = parsedPoints as ExistingConditionsPoint3[];
      let segmentCount = 0;
      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index]!;
        const end = points[index + 1]!;
        if (planDistance(start, end) <= Number.EPSILON) continue;
        elements.push({
          key: `proposal:${observationId}:segment:${index + 1}`,
          kind: "mep_curve",
          discipline: discipline as ExistingConditionsElement["discipline"],
          role: kind,
          category: kind,
          location: null,
          endpoints: [start, end]
        });
        segmentCount += 1;
      }
      if (segmentCount > 0) continue;
    }
    unsupported.push(observationId || "<missing-observation-id>");
  }
  return {
    snapshot: { native_readback: false, elements, connections: [], open_connector_count: 0 },
    unsupported_observation_ids: unsupported
  };
}

export function mepPreApplyGeometryScoringPolicyFingerprint(policy: MepPreApplyGeometryScoringPolicy): string {
  return fingerprint(policy);
}

export function isIssuedMepPreApplyGeometryScore(value: unknown): value is MepPreApplyGeometryScore {
  return !!value && typeof value === "object" && ISSUED_MEP_PRE_APPLY_GEOMETRY_SCORES.has(value as object);
}

export function scoreMepPreApplyGeometry(
  truth: ExistingConditionsGroundTruth,
  compilation: RegisteredMepObservationCompilation,
  policyOverrides: Partial<MepPreApplyGeometryScoringPolicy> = {}
): MepPreApplyGeometryScore {
  const policy = { ...DEFAULT_MEP_PRE_APPLY_GEOMETRY_SCORING_POLICY, ...policyOverrides };
  const evaluationPolicy = policyIsValid(policy) ? policy : DEFAULT_MEP_PRE_APPLY_GEOMETRY_SCORING_POLICY;
  const invalidReasons: string[] = [];
  if (!policyIsValid(policy)) invalidReasons.push("mep_pre_apply_scoring_policy_invalid");
  if (truth.schema_version !== 1) invalidReasons.push("mep_pre_apply_truth_schema_invalid");
  if (truth.fixture_id !== compilation.fixture_id) invalidReasons.push("mep_pre_apply_fixture_mismatch");
  if (truth.scope_id !== compilation.scope_id) invalidReasons.push("mep_pre_apply_scope_mismatch");
  if (truth.snapshot?.native_readback !== true) invalidReasons.push("mep_pre_apply_truth_requires_native_readback");
  if (compilation.compiled_plan.status !== "ready") invalidReasons.push("mep_pre_apply_compilation_not_ready");
  const bounded = truth.evaluation_policy?.bounded_mep_region_coverage;
  if (!bounded) invalidReasons.push("mep_pre_apply_truth_requires_bounded_visible_keys");
  if (bounded?.required_coverage_status !== "complete") {
    invalidReasons.push("mep_pre_apply_truth_coverage_must_be_complete");
  }
  if (bounded?.source_evidence_sha256 !== compilation.converted_package.source_evidence_sha256) {
    invalidReasons.push("mep_pre_apply_truth_source_evidence_mismatch");
  }
  if (bounded?.registered_render_sha256 !== compilation.registered_render_sha256) {
    invalidReasons.push("mep_pre_apply_truth_registered_render_mismatch");
  }
  const proposed = proposedMepSnapshotFromCompilation(compilation);
  if (proposed.unsupported_observation_ids.length > 0) {
    invalidReasons.push(`mep_pre_apply_unsupported_observations:${proposed.unsupported_observation_ids.sort().join(",")}`);
  }
  const truthByKey = new Map((truth.snapshot?.elements ?? []).map((element) => [element.key, element]));
  const snapshotTruthKeys = (truth.snapshot?.elements ?? []).map((element) => element.key);
  const duplicateSnapshotTruthKeys = snapshotTruthKeys.filter((key, index) => snapshotTruthKeys.indexOf(key) !== index);
  if (duplicateSnapshotTruthKeys.length > 0) {
    invalidReasons.push("mep_pre_apply_truth_snapshot_keys_duplicated");
  }
  const requestedTruthKeys = [
    ...(bounded?.clear_plan_visible_family_instance_keys ?? []),
    ...(bounded?.clear_plan_visible_mep_curve_keys ?? [])
  ];
  const duplicateTruthKeys = requestedTruthKeys.filter((key, index) => requestedTruthKeys.indexOf(key) !== index);
  if (duplicateTruthKeys.length > 0) {
    invalidReasons.push("mep_pre_apply_truth_keys_duplicated");
  }
  if (requestedTruthKeys.length === 0) invalidReasons.push("mep_pre_apply_truth_has_no_scoreable_elements");
  const missingTruthKeys = requestedTruthKeys.filter((key) => !truthByKey.has(key));
  if (missingTruthKeys.length > 0) invalidReasons.push("mep_pre_apply_truth_keys_missing");
  const wrongFamilyKinds = (bounded?.clear_plan_visible_family_instance_keys ?? [])
    .filter((key) => truthByKey.get(key)?.kind !== "family_instance");
  if (wrongFamilyKinds.length > 0) {
    invalidReasons.push("mep_pre_apply_truth_family_keys_have_wrong_kind");
  }
  const wrongRouteKinds = (bounded?.clear_plan_visible_mep_curve_keys ?? [])
    .filter((key) => truthByKey.get(key)?.kind !== "mep_curve");
  if (wrongRouteKinds.length > 0) {
    invalidReasons.push("mep_pre_apply_truth_route_keys_have_wrong_kind");
  }
  const malformedFamilyKeys = (bounded?.clear_plan_visible_family_instance_keys ?? [])
    .filter((key) => {
      const element = truthByKey.get(key);
      return element?.kind === "family_instance" && finitePoint(element.location) === null;
    });
  if (malformedFamilyKeys.length > 0) {
    invalidReasons.push("mep_pre_apply_truth_family_geometry_invalid");
  }
  const malformedRouteKeys = (bounded?.clear_plan_visible_mep_curve_keys ?? [])
    .filter((key) => {
      const element = truthByKey.get(key);
      return element?.kind === "mep_curve" && routeSegment(element) === null;
    });
  if (malformedRouteKeys.length > 0) {
    invalidReasons.push("mep_pre_apply_truth_route_geometry_invalid");
  }
  const truthElements = requestedTruthKeys.map((key) => truthByKey.get(key)).filter((entry): entry is ExistingConditionsElement => !!entry);
  const proposalElements = proposed.snapshot.elements;
  const pointTruthElements = truthElements.filter((entry) => entry.kind === "family_instance");
  const pointProposalElements = proposalElements.filter((entry) => entry.kind === "family_instance");
  const truthRoutes = truthElements.map(routeSegment).filter((entry): entry is RouteSegment => entry !== null);
  const proposalRoutes = proposalElements.map(routeSegment).filter((entry): entry is RouteSegment => entry !== null);
  if (routeHasMaterialSelfOverlap(proposalRoutes, evaluationPolicy.route_endpoint_tolerance_ft)) {
    invalidReasons.push("mep_pre_apply_proposal_routes_overlap_or_backtrack");
  }
  const pairCandidates: Array<MepPreApplyGeometryMatchedPair & { truth_key: string }> = [];
  for (const truthElement of pointTruthElements) {
    for (const proposal of pointProposalElements) {
      if (truthElement.kind !== proposal.kind) continue;
      if (normalized(truthElement.discipline) !== normalized(proposal.discipline)) continue;
      if (truthElement.kind === "family_instance" && normalized(truthElement.role) !== normalized(proposal.role)) continue;
      let distance: number | null = null;
      const tolerance = evaluationPolicy.point_location_tolerance_ft;
      if (truthElement.kind === "family_instance") {
        const truthPoint = finitePoint(truthElement.location);
        const proposalPoint = finitePoint(proposal.location);
        if (truthPoint && proposalPoint) distance = planDistance(truthPoint, proposalPoint);
      }
      if (distance === null || distance > tolerance) continue;
      pairCandidates.push({
        truth_key: truthElement.key,
        proposal_key: proposal.key,
        discipline: normalized(proposal.discipline),
        role: normalized(proposal.role),
        plan_distance_ft: round(distance),
        geometry_score: round(clamp01(1 - distance / Math.max(tolerance, Number.EPSILON)))
      });
    }
  }
  pairCandidates.sort((first, second) =>
    first.plan_distance_ft - second.plan_distance_ft ||
    first.truth_key.localeCompare(second.truth_key) ||
    first.proposal_key.localeCompare(second.proposal_key)
  );
  const matchedTruth = new Set<string>();
  const matchedProposals = new Set<string>();
  const pairs: MepPreApplyGeometryMatchedPair[] = [];
  for (const pair of pairCandidates) {
    if (matchedTruth.has(pair.truth_key) || matchedProposals.has(pair.proposal_key)) continue;
    matchedTruth.add(pair.truth_key);
    matchedProposals.add(pair.proposal_key);
    const { truth_key: _truthKey, ...serializedPair } = pair;
    pairs.push(serializedPair);
  }
  const routeRecallCoverage = routeCoverage(truthRoutes, proposalRoutes, evaluationPolicy.route_endpoint_tolerance_ft);
  const routePrecisionCoverage = routeCoverage(proposalRoutes, truthRoutes, evaluationPolicy.route_endpoint_tolerance_ft);
  if (routeRecallCoverage.budget_exceeded || routePrecisionCoverage.budget_exceeded) {
    invalidReasons.push("mep_pre_apply_route_scoring_budget_exceeded");
  }
  const missedTruthKeys = [
    ...pointTruthElements.filter((entry) => !matchedTruth.has(entry.key)).map((entry) => entry.key),
    ...routeRecallCoverage.uncovered_keys
  ].sort();
  const falsePositiveProposalKeys = [
    ...pointProposalElements.filter((entry) => !matchedProposals.has(entry.key)).map((entry) => entry.key),
    ...routePrecisionCoverage.uncovered_keys
  ].sort();
  const pointApplicable = pointTruthElements.length > 0 || pointProposalElements.length > 0;
  const routeApplicable = truthRoutes.length > 0 || proposalRoutes.length > 0;
  const pointPrecision = pointProposalElements.length > 0 ? pairs.length / pointProposalElements.length : pointTruthElements.length === 0 ? 1 : 0;
  const pointRecall = pointTruthElements.length > 0 ? pairs.length / pointTruthElements.length : pointProposalElements.length === 0 ? 1 : 0;
  const precisionParts = [
    ...(pointApplicable ? [pointPrecision] : []),
    ...(routeApplicable ? [routePrecisionCoverage.ratio] : [])
  ];
  const recallParts = [
    ...(pointApplicable ? [pointRecall] : []),
    ...(routeApplicable ? [routeRecallCoverage.ratio] : [])
  ];
  const precision = precisionParts.length > 0 ? Math.min(...precisionParts) : 0;
  const recall = recallParts.length > 0 ? Math.min(...recallParts) : 0;
  const elementF1 = f1(precision, recall);
  const pointGeometry = pairs.length > 0 ? pairs.reduce((sum, pair) => sum + pair.geometry_score, 0) / pairs.length : 0;
  const geometryParts = [
    ...(pointApplicable ? [pointGeometry] : []),
    ...(routeApplicable ? [(routeRecallCoverage.geometry + routePrecisionCoverage.geometry) / 2] : [])
  ];
  const geometry = geometryParts.length > 0 ? geometryParts.reduce((sum, entry) => sum + entry, 0) / geometryParts.length : 0;
  const score = 100 * (0.6 * elementF1 + 0.4 * geometry);
  const failures: string[] = [];
  if (precision < evaluationPolicy.minimum_precision) failures.push("mep_pre_apply_precision_below_threshold");
  if (recall < evaluationPolicy.minimum_recall) failures.push("mep_pre_apply_recall_below_threshold");
  if (geometry < evaluationPolicy.minimum_geometry_score) failures.push("mep_pre_apply_geometry_mismatch");
  if (score < evaluationPolicy.passing_score) failures.push("mep_pre_apply_score_below_threshold");
  const validRun = invalidReasons.length === 0;
  const receipt: MepPreApplyGeometryScore = {
    schema_version: 1,
    fixture_id: compilation.fixture_id,
    scope_id: compilation.scope_id,
    compilation_fingerprint_sha256: fingerprint(compilation),
    truth_fingerprint_sha256: fingerprint({
      fixture_id: truth.fixture_id,
      scope_id: truth.scope_id,
      evaluation_policy: truth.evaluation_policy,
      snapshot: truth.snapshot
    }),
    scoring_policy: policy,
    scoring_policy_fingerprint_sha256: mepPreApplyGeometryScoringPolicyFingerprint(policy),
    valid_run: validRun,
    passed: validRun && failures.length === 0,
    score: round(score),
    invalid_reasons: [...new Set(invalidReasons)],
    failure_classifications: validRun ? [...new Set(failures)] : [],
    counts: {
      truth: truthElements.length,
      proposal: proposalElements.length,
      matched: pairs.length + Math.min(routeRecallCoverage.fully_covered_keys.size, routePrecisionCoverage.fully_covered_keys.size),
      missed: missedTruthKeys.length,
      false_positive: falsePositiveProposalKeys.length
    },
    metrics: {
      precision: round(precision),
      recall: round(recall),
      element_f1: round(elementF1),
      geometry: round(geometry),
      route_precision: routeApplicable ? round(routePrecisionCoverage.ratio) : null,
      route_recall: routeApplicable ? round(routeRecallCoverage.ratio) : null
    },
    matched_pairs: pairs,
    false_positive_proposal_keys: falsePositiveProposalKeys
  };
  deepFreeze(receipt);
  ISSUED_MEP_PRE_APPLY_GEOMETRY_SCORES.add(receipt);
  return receipt;
}

export function promoteScoreGatedMepWorkflow(
  compilation: RegisteredMepObservationCompilation,
  score: MepPreApplyGeometryScore,
  options: { dry_run?: boolean; maximum_created_elements?: number } = {}
): ScoreGatedMepWorkflowPromotion {
  if (!isIssuedMepPreApplyGeometryScore(score)) throw new Error("mep_pre_apply_requires_evaluator_issued_score");
  const compilationFingerprint = fingerprint(compilation);
  if (score.compilation_fingerprint_sha256 !== compilationFingerprint) {
    throw new Error("mep_pre_apply_score_compilation_fingerprint_mismatch");
  }
  const policy = score.scoring_policy;
  const defaults = DEFAULT_MEP_PRE_APPLY_GEOMETRY_SCORING_POLICY;
  if (!policyIsValid(policy)) throw new Error("mep_pre_apply_score_policy_invalid");
  if (policy.point_location_tolerance_ft > defaults.point_location_tolerance_ft
    || policy.route_endpoint_tolerance_ft > defaults.route_endpoint_tolerance_ft
    || policy.minimum_precision < defaults.minimum_precision
    || policy.minimum_recall < defaults.minimum_recall
    || policy.minimum_geometry_score < defaults.minimum_geometry_score
    || policy.passing_score < defaults.passing_score) {
    throw new Error("mep_pre_apply_score_policy_is_too_permissive");
  }
  if (score.scoring_policy_fingerprint_sha256 !== mepPreApplyGeometryScoringPolicyFingerprint(policy)) {
    throw new Error("mep_pre_apply_score_policy_fingerprint_mismatch");
  }
  if (!score.valid_run || !score.passed || score.failure_classifications.length > 0 || score.invalid_reasons.length > 0) {
    throw new Error("mep_pre_apply_requires_passing_geometry_score");
  }
  if (score.counts.missed !== 0 || score.counts.false_positive !== 0
    || score.metrics.precision < policy.minimum_precision
    || score.metrics.recall < policy.minimum_recall
    || score.metrics.geometry < policy.minimum_geometry_score
    || score.score < policy.passing_score) {
    throw new Error("mep_pre_apply_score_receipt_is_internally_inconsistent");
  }
  return {
    schema_version: 1,
    fixture_id: compilation.fixture_id,
    scope_id: compilation.scope_id,
    compilation_fingerprint_sha256: compilationFingerprint,
    score,
    workflow: buildAtomicMepDraftWorkflowRequest(compilation.compiled_plan, options),
    capability_boundary: "This evaluator-issued score gates benchmark workflow emission against bounded original-model plan geometry. It does not make hidden truth agent-visible and does not replace native dry-run, readback, rendered-plan review, or cleanup."
  };
}
