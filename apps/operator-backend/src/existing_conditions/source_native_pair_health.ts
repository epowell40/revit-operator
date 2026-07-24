import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadImage } from "@napi-rs/canvas";

export type SourceNativePairPointV1 = { x: number; y: number };

export type SourceNativePairRouteV1 = {
  route_id: string;
  points: SourceNativePairPointV1[];
};

export type SourceNativePairEvidenceV1 = {
  artifact_path: string;
  artifact_sha256: string;
  coordinate_space: "source_pixel_top_left";
  routes: SourceNativePairRouteV1[];
};

export type SourceNativePairHealthPolicyV1 = {
  sample_spacing_px: number;
  distance_tolerance_px: number;
  minimum_bidirectional_coverage_fraction: number;
  maximum_p95_nearest_distance_px: number;
  minimum_route_length_ratio: number;
  diagnostic_translation_maximum_px: number;
  diagnostic_translation_coarse_step_px: number;
  diagnostic_translation_fine_step_px: number;
};

export type SourceNativePairHealthInputV1 = {
  schema_version: 1;
  fixture_id: string;
  source_image_path: string;
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  evaluator_source_routes: SourceNativePairEvidenceV1;
  registered_native_routes: SourceNativePairEvidenceV1;
  policy?: Partial<SourceNativePairHealthPolicyV1>;
};

export type SourceNativePairDirectedCoverageV1 = {
  sample_count: number;
  covered_sample_count: number;
  coverage_fraction: number;
  p50_nearest_distance_px: number;
  p95_nearest_distance_px: number;
  maximum_nearest_distance_px: number;
};

export type SourceNativePairHealthReceiptV1 = {
  schema: "operator.source_native_pair_health.v1";
  fixture_id: string;
  source_image_sha256: string;
  source_route_artifact_sha256: string;
  native_route_artifact_sha256: string;
  source_route_payload_sha256: string;
  native_route_payload_sha256: string;
  policy: SourceNativePairHealthPolicyV1;
  source_route_count: number;
  registered_native_route_count: number;
  source_route_length_px: number;
  registered_native_route_length_px: number;
  route_length_ratio: number;
  source_to_native: SourceNativePairDirectedCoverageV1;
  native_to_source: SourceNativePairDirectedCoverageV1;
  best_translation_diagnostic: {
    applied_to: "registered_native_routes";
    dx_px: number;
    dy_px: number;
    mean_bidirectional_coverage_fraction: number;
    source_to_translated_native: SourceNativePairDirectedCoverageV1;
    translated_native_to_source: SourceNativePairDirectedCoverageV1;
    acceptance_use: "diagnostic_only_never_candidate_repair_or_credit";
  } | null;
  failed_gates: string[];
  status: "pair_healthy" | "pair_rejected";
  candidate_release_allowed: boolean;
  exact_next_action: "seal_evaluator_receipt_and_release_source_only_candidate_package" | "reject_pair_and_select_or_repair_source_native_registration_without_releasing_truth";
  evaluator_only: true;
  native_write_allowed: false;
  capability_boundary: string;
};

type Segment = { start: SourceNativePairPointV1; end: SourceNativePairPointV1 };

const DEFAULT_POLICY: SourceNativePairHealthPolicyV1 = {
  sample_spacing_px: 2,
  distance_tolerance_px: 8,
  minimum_bidirectional_coverage_fraction: 0.95,
  maximum_p95_nearest_distance_px: 8,
  minimum_route_length_ratio: 0.9,
  diagnostic_translation_maximum_px: 300,
  diagnostic_translation_coarse_step_px: 10,
  diagnostic_translation_fine_step_px: 1
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${label}_must_be_integer_${minimum}_through_${maximum}`);
  return result;
}

function bounded(value: unknown, fallback: number, label: string, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${label}_out_of_range`);
  return result;
}

function requireArtifact(artifactPath: unknown, artifactSha256: unknown, label: string): string {
  const resolved = path.resolve(clean(artifactPath));
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${label}_not_found`);
  const expected = sha256(artifactSha256, `${label}_sha256`);
  if (sha256Buffer(fs.readFileSync(resolved)) !== expected) throw new Error(`${label}_hash_mismatch`);
  return expected;
}

function normalizeRoutes(
  evidence: SourceNativePairEvidenceV1,
  label: string,
  width: number,
  height: number
): SourceNativePairRouteV1[] {
  if (!evidence || typeof evidence !== "object" || evidence.coordinate_space !== "source_pixel_top_left") {
    throw new Error(`${label}_must_use_source_pixel_top_left`);
  }
  if (!Array.isArray(evidence.routes) || evidence.routes.length === 0 || evidence.routes.length > 10000) {
    throw new Error(`${label}_routes_required`);
  }
  const ids = new Set<string>();
  return evidence.routes.map((route, routeIndex) => {
    const routeId = clean(route?.route_id);
    if (!routeId || ids.has(routeId)) throw new Error(`${label}_route_id_invalid:${routeId}`);
    ids.add(routeId);
    if (!Array.isArray(route.points) || route.points.length < 2 || route.points.length > 10000) {
      throw new Error(`${label}_route_points_invalid:${routeIndex}`);
    }
    const points = route.points.map((point, pointIndex) => {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > width || y < 0 || y > height) {
        throw new Error(`${label}_route_point_out_of_source_bounds:${routeIndex}:${pointIndex}`);
      }
      return { x, y };
    });
    return { route_id: routeId, points };
  });
}

function segments(routes: SourceNativePairRouteV1[]): Segment[] {
  return routes.flatMap(route => route.points.slice(0, -1).map((start, index) => ({ start, end: route.points[index + 1]! })))
    .filter(segment => Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y) > 1e-6);
}

function segmentLength(segment: Segment): number {
  return Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
}

function pointSegmentDistance(point: SourceNativePairPointV1, segment: Segment): number {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (segment.start.x + t * dx), point.y - (segment.start.y + t * dy));
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

function directedCoverage(source: Segment[], target: Segment[], tolerance: number, spacing: number): SourceNativePairDirectedCoverageV1 {
  if (source.length === 0 || target.length === 0) throw new Error("source_native_pair_health_requires_nonzero_segments");
  const distances: number[] = [];
  let covered = 0;
  for (const segment of source) {
    const count = Math.max(1, Math.ceil(segmentLength(segment) / spacing));
    for (let index = 0; index <= count; index += 1) {
      const t = index / count;
      const point = {
        x: segment.start.x + t * (segment.end.x - segment.start.x),
        y: segment.start.y + t * (segment.end.y - segment.start.y)
      };
      const distance = Math.min(...target.map(candidate => pointSegmentDistance(point, candidate)));
      distances.push(distance);
      if (distance <= tolerance) covered += 1;
    }
  }
  distances.sort((left, right) => left - right);
  return {
    sample_count: distances.length,
    covered_sample_count: covered,
    coverage_fraction: covered / distances.length,
    p50_nearest_distance_px: percentile(distances, 0.5),
    p95_nearest_distance_px: percentile(distances, 0.95),
    maximum_nearest_distance_px: distances[distances.length - 1]!
  };
}

function translate(value: Segment[], dx: number, dy: number): Segment[] {
  return value.map(segment => ({
    start: { x: segment.start.x + dx, y: segment.start.y + dy },
    end: { x: segment.end.x + dx, y: segment.end.y + dy }
  }));
}

function translationDiagnostic(
  source: Segment[],
  native: Segment[],
  policy: SourceNativePairHealthPolicyV1
): NonNullable<SourceNativePairHealthReceiptV1["best_translation_diagnostic"]> | null {
  const maximum = policy.diagnostic_translation_maximum_px;
  if (maximum <= 0) return null;
  const diagnosticSpacing = Math.max(policy.sample_spacing_px, 10);
  const score = (dx: number, dy: number): number => {
    const shifted = translate(native, dx, dy);
    const forward = directedCoverage(source, shifted, policy.distance_tolerance_px, diagnosticSpacing).coverage_fraction;
    const reverse = directedCoverage(shifted, source, policy.distance_tolerance_px, diagnosticSpacing).coverage_fraction;
    return (forward + reverse) / 2;
  };
  let best = { dx: 0, dy: 0, score: score(0, 0) };
  for (let dx = -maximum; dx <= maximum; dx += policy.diagnostic_translation_coarse_step_px) {
    for (let dy = -maximum; dy <= maximum; dy += policy.diagnostic_translation_coarse_step_px) {
      const candidate = score(dx, dy);
      if (candidate > best.score) best = { dx, dy, score: candidate };
    }
  }
  const coarse = { ...best };
  for (let dx = coarse.dx - policy.diagnostic_translation_coarse_step_px; dx <= coarse.dx + policy.diagnostic_translation_coarse_step_px; dx += policy.diagnostic_translation_fine_step_px) {
    for (let dy = coarse.dy - policy.diagnostic_translation_coarse_step_px; dy <= coarse.dy + policy.diagnostic_translation_coarse_step_px; dy += policy.diagnostic_translation_fine_step_px) {
      if (Math.abs(dx) > maximum || Math.abs(dy) > maximum) continue;
      const candidate = score(dx, dy);
      if (candidate > best.score) best = { dx, dy, score: candidate };
    }
  }
  const shifted = translate(native, best.dx, best.dy);
  return {
    applied_to: "registered_native_routes",
    dx_px: best.dx,
    dy_px: best.dy,
    mean_bidirectional_coverage_fraction: best.score,
    source_to_translated_native: directedCoverage(source, shifted, policy.distance_tolerance_px, policy.sample_spacing_px),
    translated_native_to_source: directedCoverage(shifted, source, policy.distance_tolerance_px, policy.sample_spacing_px),
    acceptance_use: "diagnostic_only_never_candidate_repair_or_credit"
  };
}

export async function evaluateSourceNativePairHealthV1(input: SourceNativePairHealthInputV1): Promise<SourceNativePairHealthReceiptV1> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) throw new Error("source_native_pair_health_requires_schema_v1");
  const fixtureId = clean(input.fixture_id);
  if (!fixtureId) throw new Error("source_native_pair_health_fixture_id_required");
  const width = integer(input.source_image_width_px, "source_native_pair_health_source_width", 1, 50000);
  const height = integer(input.source_image_height_px, "source_native_pair_health_source_height", 1, 50000);
  const sourceImageHash = requireArtifact(input.source_image_path, input.source_image_sha256, "source_native_pair_health_source_image");
  const sourceImage = await loadImage(fs.readFileSync(path.resolve(input.source_image_path)));
  if (sourceImage.width !== width || sourceImage.height !== height) throw new Error("source_native_pair_health_source_image_dimensions_mismatch");
  const sourceArtifactHash = requireArtifact(input.evaluator_source_routes?.artifact_path, input.evaluator_source_routes?.artifact_sha256, "source_native_pair_health_source_route_artifact");
  const nativeArtifactHash = requireArtifact(input.registered_native_routes?.artifact_path, input.registered_native_routes?.artifact_sha256, "source_native_pair_health_native_route_artifact");
  const sourceRoutes = normalizeRoutes(input.evaluator_source_routes, "source_native_pair_health_source", width, height);
  const nativeRoutes = normalizeRoutes(input.registered_native_routes, "source_native_pair_health_native", width, height);
  const sourceSegments = segments(sourceRoutes);
  const nativeSegments = segments(nativeRoutes);
  if (sourceSegments.length === 0 || nativeSegments.length === 0) throw new Error("source_native_pair_health_requires_nonzero_segments");
  const policy: SourceNativePairHealthPolicyV1 = {
    sample_spacing_px: bounded(input.policy?.sample_spacing_px, DEFAULT_POLICY.sample_spacing_px, "source_native_pair_health_sample_spacing_px", 0.25, 100),
    distance_tolerance_px: bounded(input.policy?.distance_tolerance_px, DEFAULT_POLICY.distance_tolerance_px, "source_native_pair_health_distance_tolerance_px", 0.1, 500),
    minimum_bidirectional_coverage_fraction: bounded(input.policy?.minimum_bidirectional_coverage_fraction, DEFAULT_POLICY.minimum_bidirectional_coverage_fraction, "source_native_pair_health_minimum_coverage", 0, 1),
    maximum_p95_nearest_distance_px: bounded(input.policy?.maximum_p95_nearest_distance_px, DEFAULT_POLICY.maximum_p95_nearest_distance_px, "source_native_pair_health_maximum_p95", 0.1, 500),
    minimum_route_length_ratio: bounded(input.policy?.minimum_route_length_ratio, DEFAULT_POLICY.minimum_route_length_ratio, "source_native_pair_health_minimum_length_ratio", 0, 1),
    diagnostic_translation_maximum_px: bounded(input.policy?.diagnostic_translation_maximum_px, DEFAULT_POLICY.diagnostic_translation_maximum_px, "source_native_pair_health_translation_maximum", 0, 2000),
    diagnostic_translation_coarse_step_px: bounded(input.policy?.diagnostic_translation_coarse_step_px, DEFAULT_POLICY.diagnostic_translation_coarse_step_px, "source_native_pair_health_translation_coarse_step", 1, 500),
    diagnostic_translation_fine_step_px: bounded(input.policy?.diagnostic_translation_fine_step_px, DEFAULT_POLICY.diagnostic_translation_fine_step_px, "source_native_pair_health_translation_fine_step", 0.25, 100)
  };
  if (policy.diagnostic_translation_fine_step_px > policy.diagnostic_translation_coarse_step_px) throw new Error("source_native_pair_health_translation_fine_step_must_not_exceed_coarse_step");
  const sourceLength = sourceSegments.reduce((sum, segment) => sum + segmentLength(segment), 0);
  const nativeLength = nativeSegments.reduce((sum, segment) => sum + segmentLength(segment), 0);
  const lengthRatio = Math.min(sourceLength, nativeLength) / Math.max(sourceLength, nativeLength);
  const sourceToNative = directedCoverage(sourceSegments, nativeSegments, policy.distance_tolerance_px, policy.sample_spacing_px);
  const nativeToSource = directedCoverage(nativeSegments, sourceSegments, policy.distance_tolerance_px, policy.sample_spacing_px);
  const failedGates: string[] = [];
  if (sourceToNative.coverage_fraction < policy.minimum_bidirectional_coverage_fraction) failedGates.push("source_to_native_coverage_below_minimum");
  if (nativeToSource.coverage_fraction < policy.minimum_bidirectional_coverage_fraction) failedGates.push("native_to_source_coverage_below_minimum");
  if (sourceToNative.p95_nearest_distance_px > policy.maximum_p95_nearest_distance_px) failedGates.push("source_to_native_p95_distance_above_maximum");
  if (nativeToSource.p95_nearest_distance_px > policy.maximum_p95_nearest_distance_px) failedGates.push("native_to_source_p95_distance_above_maximum");
  if (lengthRatio < policy.minimum_route_length_ratio) failedGates.push("route_length_ratio_below_minimum");
  const healthy = failedGates.length === 0;
  return {
    schema: "operator.source_native_pair_health.v1",
    fixture_id: fixtureId,
    source_image_sha256: sourceImageHash,
    source_route_artifact_sha256: sourceArtifactHash,
    native_route_artifact_sha256: nativeArtifactHash,
    source_route_payload_sha256: digest(sourceRoutes),
    native_route_payload_sha256: digest(nativeRoutes),
    policy,
    source_route_count: sourceRoutes.length,
    registered_native_route_count: nativeRoutes.length,
    source_route_length_px: sourceLength,
    registered_native_route_length_px: nativeLength,
    route_length_ratio: lengthRatio,
    source_to_native: sourceToNative,
    native_to_source: nativeToSource,
    best_translation_diagnostic: healthy ? null : translationDiagnostic(sourceSegments, nativeSegments, policy),
    failed_gates: failedGates,
    status: healthy ? "pair_healthy" : "pair_rejected",
    candidate_release_allowed: healthy,
    exact_next_action: healthy ? "seal_evaluator_receipt_and_release_source_only_candidate_package" : "reject_pair_and_select_or_repair_source_native_registration_without_releasing_truth",
    evaluator_only: true,
    native_write_allowed: false,
    capability_boundary: "This evaluator-only gate decides whether source truth and registered native truth are geometrically compatible before a blind fixture is released. It never exposes truth to the candidate, never repairs or translates candidate output, and never authorizes a Revit write. Translation search is diagnostic only."
  };
}
