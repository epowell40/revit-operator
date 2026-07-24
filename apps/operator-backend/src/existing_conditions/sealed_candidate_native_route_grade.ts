import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  evaluateSourceNativePairHealthV1,
  type SourceNativePairHealthPolicyV1,
  type SourceNativePairHealthReceiptV1,
  type SourceNativePairRouteV1
} from "./source_native_pair_health.js";

type RequiredClaim = "profile" | "size" | "system";

export type SealedCandidateNativeRouteGradeInputV1 = {
  schema_version: 1;
  fixture_id: string;
  source_image_path: string;
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  candidate_artifact_path: string;
  candidate_artifact_sha256: string;
  candidate_seal_path: string;
  candidate_seal_sha256: string;
  registered_native_route_artifact_path: string;
  registered_native_route_artifact_sha256: string;
  evaluated_at_utc: string;
  required_claims?: RequiredClaim[];
  policy?: Partial<SourceNativePairHealthPolicyV1>;
};

export type SealedCandidateNativeRouteGradeReceiptV1 = {
  schema: "operator.sealed_candidate_native_route_grade.v1";
  fixture_id: string;
  source_image_sha256: string;
  candidate_artifact_sha256: string;
  candidate_seal_sha256: string;
  registered_native_route_artifact_sha256: string;
  candidate_sealed_at_utc: string;
  evaluated_at_utc: string;
  truth_revealed_after_candidate_seal: true;
  geometry: SourceNativePairHealthReceiptV1;
  claim_grade: {
    required_claims: RequiredClaim[];
    candidate_values: Record<RequiredClaim, string[]>;
    native_values: Record<RequiredClaim, string[]>;
    failed_gates: string[];
  };
  failed_gates: string[];
  status: "accepted_post_seal_native_grade" | "candidate_repair_required";
  exact_next_action: "stage_smallest_reversible_native_action" | "repair_source_interpretation_and_create_a_new_candidate_version";
  evaluator_only: true;
  native_write_allowed: false;
  capability_boundary: string;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function expectedSha(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function readBoundJson(filePath: unknown, expected: unknown, label: string): { hash: string; value: any } {
  const resolved = path.resolve(clean(filePath));
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${label}_not_found`);
  const bytes = fs.readFileSync(resolved);
  const hash = expectedSha(expected, `${label}_sha256`);
  if (sha256Buffer(bytes) !== hash) throw new Error(`${label}_hash_mismatch`);
  return { hash, value: JSON.parse(bytes.toString("utf8")) };
}

function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 50000) throw new Error(`${label}_invalid`);
  return result;
}

function timestamp(value: unknown, label: string): { milliseconds: number; iso: string } {
  const milliseconds = Date.parse(clean(value));
  if (!Number.isFinite(milliseconds)) throw new Error(`${label}_invalid`);
  return { milliseconds, iso: new Date(milliseconds).toISOString() };
}

function normalizedClaim(value: unknown, claim: RequiredClaim): string {
  let result = clean(value).toLowerCase().replace(/ø/g, "").replace(/diameter/g, "").replace(/\s+/g, " ");
  if (claim === "size") result = result.replace(/inches?|inch|\"/g, "in").replace(/\s*in\b/g, " in").trim();
  if (claim === "profile" && result.includes("round")) return "round";
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function candidateRoutes(candidate: any, width: number, height: number): { routes: SourceNativePairRouteV1[]; claims: Record<RequiredClaim, string[]> } {
  const interpretation = candidate?.interpretation ?? candidate;
  if (interpretation?.coordinate_space !== "normalized_uv_top_left") throw new Error("sealed_candidate_native_grade_requires_normalized_uv_top_left");
  const primitives = Array.isArray(interpretation?.primitives) ? interpretation.primitives : [];
  const routePrimitives = primitives.filter((primitive: any) => primitive?.kind === "route_segment");
  if (routePrimitives.length === 0) throw new Error("sealed_candidate_native_grade_candidate_routes_required");
  const routes = routePrimitives.map((primitive: any, routeIndex: number) => {
    const routeId = clean(primitive?.primitive_id);
    if (!routeId) throw new Error(`sealed_candidate_native_grade_route_id_required:${routeIndex}`);
    if (!Array.isArray(primitive.points) || primitive.points.length < 2) throw new Error(`sealed_candidate_native_grade_route_points_required:${routeId}`);
    return {
      route_id: routeId,
      points: primitive.points.map((point: any, pointIndex: number) => {
        const u = Number(point?.u);
        const v = Number(point?.v);
        if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) {
          throw new Error(`sealed_candidate_native_grade_route_point_invalid:${routeId}:${pointIndex}`);
        }
        return { x: u * width, y: v * height };
      })
    };
  });
  return {
    routes,
    claims: {
      profile: unique(routePrimitives.map((primitive: any) => normalizedClaim(primitive?.claims?.type?.value, "profile"))),
      size: unique(routePrimitives.map((primitive: any) => normalizedClaim(primitive?.claims?.size?.value, "size"))),
      system: unique(routePrimitives.map((primitive: any) => normalizedClaim(primitive?.claims?.system?.value, "system")))
    }
  };
}

function nativeEvidence(native: any): { routes: SourceNativePairRouteV1[]; claims: Record<RequiredClaim, string[]> } {
  if (native?.coordinate_space !== "source_pixel_top_left" || !Array.isArray(native.routes) || native.routes.length === 0) {
    throw new Error("sealed_candidate_native_grade_registered_native_routes_required");
  }
  return {
    routes: native.routes.map((route: any, index: number) => ({ route_id: clean(route.route_id) || `native-${index}`, points: route.points })),
    claims: {
      profile: unique(native.routes.flatMap((route: any) => Array.isArray(route.connector_shapes) ? route.connector_shapes : []).map((value: unknown) => normalizedClaim(value, "profile"))),
      size: unique(native.routes.map((route: any) => normalizedClaim(route?.parameters?.diameter ?? route?.parameters?.size, "size"))),
      system: unique(native.routes.map((route: any) => normalizedClaim(route?.system_classification ?? route?.parameters?.systemClassification, "system")))
    }
  };
}

export async function evaluateSealedCandidateNativeRouteGradeV1(input: SealedCandidateNativeRouteGradeInputV1): Promise<SealedCandidateNativeRouteGradeReceiptV1> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) throw new Error("sealed_candidate_native_grade_requires_schema_v1");
  const fixtureId = clean(input.fixture_id);
  if (!fixtureId) throw new Error("sealed_candidate_native_grade_fixture_id_required");
  const width = positiveInteger(input.source_image_width_px, "sealed_candidate_native_grade_source_width");
  const height = positiveInteger(input.source_image_height_px, "sealed_candidate_native_grade_source_height");
  const candidate = readBoundJson(input.candidate_artifact_path, input.candidate_artifact_sha256, "sealed_candidate_native_grade_candidate_artifact");
  const seal = readBoundJson(input.candidate_seal_path, input.candidate_seal_sha256, "sealed_candidate_native_grade_candidate_seal");
  const native = readBoundJson(input.registered_native_route_artifact_path, input.registered_native_route_artifact_sha256, "sealed_candidate_native_grade_native_artifact");
  const sourceImageHash = expectedSha(input.source_image_sha256, "sealed_candidate_native_grade_source_image_sha256");
  if (clean(seal.value?.candidate_sha256).toLowerCase() !== candidate.hash) throw new Error("sealed_candidate_native_grade_seal_candidate_hash_mismatch");
  if (clean(seal.value?.source_image_sha256).toLowerCase() !== sourceImageHash) throw new Error("sealed_candidate_native_grade_seal_source_hash_mismatch");
  const sealedAt = timestamp(seal.value?.sealed_at_utc, "sealed_candidate_native_grade_sealed_at");
  const evaluatedAt = timestamp(input.evaluated_at_utc, "sealed_candidate_native_grade_evaluated_at");
  if (evaluatedAt.milliseconds < sealedAt.milliseconds) throw new Error("sealed_candidate_native_grade_truth_must_follow_candidate_seal");
  const candidateEvidence = candidateRoutes(candidate.value, width, height);
  const registeredEvidence = nativeEvidence(native.value);
  const geometry = await evaluateSourceNativePairHealthV1({
    schema_version: 1,
    fixture_id: fixtureId,
    source_image_path: input.source_image_path,
    source_image_sha256: sourceImageHash,
    source_image_width_px: width,
    source_image_height_px: height,
    evaluator_source_routes: { artifact_path: input.candidate_artifact_path, artifact_sha256: candidate.hash, coordinate_space: "source_pixel_top_left", routes: candidateEvidence.routes },
    registered_native_routes: { artifact_path: input.registered_native_route_artifact_path, artifact_sha256: native.hash, coordinate_space: "source_pixel_top_left", routes: registeredEvidence.routes },
    policy: input.policy
  });
  const requiredClaims = unique((input.required_claims ?? []).map(value => clean(value))) as RequiredClaim[];
  if (requiredClaims.some(value => !["profile", "size", "system"].includes(value))) throw new Error("sealed_candidate_native_grade_required_claim_invalid");
  const claimFailures = requiredClaims.filter(claim => JSON.stringify(candidateEvidence.claims[claim]) !== JSON.stringify(registeredEvidence.claims[claim]))
    .map(claim => `${claim}_claim_mismatch`);
  const failedGates = [...geometry.failed_gates.map(gate => `geometry:${gate}`), ...claimFailures.map(gate => `claim:${gate}`)];
  const accepted = failedGates.length === 0;
  return {
    schema: "operator.sealed_candidate_native_route_grade.v1",
    fixture_id: fixtureId,
    source_image_sha256: sourceImageHash,
    candidate_artifact_sha256: candidate.hash,
    candidate_seal_sha256: seal.hash,
    registered_native_route_artifact_sha256: native.hash,
    candidate_sealed_at_utc: sealedAt.iso,
    evaluated_at_utc: evaluatedAt.iso,
    truth_revealed_after_candidate_seal: true,
    geometry,
    claim_grade: { required_claims: requiredClaims, candidate_values: candidateEvidence.claims, native_values: registeredEvidence.claims, failed_gates: claimFailures },
    failed_gates: failedGates,
    status: accepted ? "accepted_post_seal_native_grade" : "candidate_repair_required",
    exact_next_action: accepted ? "stage_smallest_reversible_native_action" : "repair_source_interpretation_and_create_a_new_candidate_version",
    evaluator_only: true,
    native_write_allowed: false,
    capability_boundary: "This evaluator-only post-seal gate grades an immutable source candidate against hash-bound registered native routes. It never exposes native truth to the candidate, never converts diagnostic translation into credit, never mutates the sealed candidate, and never authorizes a Revit write."
  };
}
