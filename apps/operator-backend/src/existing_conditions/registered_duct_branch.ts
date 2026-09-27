import { createHash } from "node:crypto";
import type { AtomicMepDraftWorkflowRequest } from "./mep_draft_plan.js";
import type { RegisteredStructuredExistingConditionsInterpretationV1 } from "./registered_structured_interpretation.js";

type Point = { x: number; y: number; z: number };
type Mapping = {
  main_element_id: number;
  level_name: string;
  elevation_z_ft: number;
  system_type: string;
  route_type_id: number;
  shape: "round";
  size: string;
  deferred_far_end_reason: string;
};
type MainReadback = {
  results?: Array<{
    id?: number; ok?: boolean; category?: string; typeId?: number;
    connectors?: Array<{
      origin?: number[]; domain?: string; shape?: string;
      systemClassification?: string; size?: { diameterFt?: number };
      physicalConnectionCount?: number;
    }>;
  }>;
};

function clean(value: unknown): string { return String(value ?? "").trim(); }
function token(value: unknown): string { return clean(value).toLowerCase().replace(/[^a-z0-9]/g, ""); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function positiveInteger(value: unknown, error: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(error);
  return Number(value);
}
function point(value: { x: number; y: number }, z: number): Point {
  if (![value.x, value.y, z].every(Number.isFinite)) throw new Error("registered_branch_point_invalid");
  return { x: value.x, y: value.y, z };
}
function diameterFt(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:\"|in)\s*$/i.exec(value);
  if (!match) throw new Error("registered_branch_explicit_round_size_required");
  const diameter = Number(match[1]) / 12;
  if (!Number.isFinite(diameter) || diameter <= 0) throw new Error("registered_branch_explicit_round_size_required");
  return diameter;
}

/** A source-bound interior tee. The fresh native connector readback is a guard,
 * not a source of new geometry: every branch point remains from the PDF registration. */
export function planRegisteredExistingDuctBranchV1(args: {
  registered: RegisteredStructuredExistingConditionsInterpretationV1;
  registration_sha256: string;
  registration_evidence_id: string;
  primitive_id: string;
  main_connector_readback: MainReadback;
  mapping: Mapping;
}): { workflow: AtomicMepDraftWorkflowRequest; main_readback_sha256: string; source_mark_ids: string[] } {
  const { registered, mapping } = args;
  if (registered.schema_version !== 1 || !registered.registration.verified) throw new Error("registered_branch_source_registration_unverified");
  if (!/^[a-f0-9]{64}$/.test(args.registration_sha256) || !/^ev1_[A-Za-z0-9_-]{32}$/.test(args.registration_evidence_id)) {
    throw new Error("registered_branch_source_receipt_invalid");
  }
  const primitive = registered.registered_primitives.filter(value => value.primitive_id === args.primitive_id);
  if (primitive.length !== 1 || primitive[0]!.kind !== "route_segment") throw new Error("registered_branch_source_primitive_missing_or_ambiguous");
  const source = primitive[0]!;
  if (!/^[a-f0-9]{64}$/.test(source.source_artifact_sha256) || source.model_points.length < 2) throw new Error("registered_branch_source_geometry_invalid");
  if (source.model_endpoints.filter(value => Math.hypot(value.point.x - source.model_points[0]!.x, value.point.y - source.model_points[0]!.y) < 1e-6).length !== 1) {
    throw new Error("registered_branch_source_junction_endpoint_missing_or_ambiguous");
  }
  if (source.confidence.geometry < 0.8 || source.confidence.topology < 0.8 || source.claims?.size?.basis !== "legible_source_evidence") {
    throw new Error("registered_branch_source_claims_insufficient");
  }
  const mainId = positiveInteger(mapping.main_element_id, "registered_branch_main_id_invalid");
  positiveInteger(mapping.route_type_id, "registered_branch_type_id_invalid");
  if (mapping.shape !== "round" || !clean(mapping.level_name) || !clean(mapping.system_type) || !clean(mapping.deferred_far_end_reason)) {
    throw new Error("registered_branch_native_mapping_incomplete");
  }
  if (clean(mapping.deferred_far_end_reason).length > 240) throw new Error("registered_branch_far_end_reason_too_long");
  if (token(source.claims?.system?.value) !== token(mapping.system_type) || clean(source.claims?.size?.value) !== clean(mapping.size)) {
    throw new Error("registered_branch_native_mapping_conflicts_with_source");
  }
  const diameter = diameterFt(mapping.size);
  const results = args.main_connector_readback.results;
  if (!Array.isArray(results) || results.length !== 1 || results[0]?.id !== mainId || results[0]?.ok !== true) {
    throw new Error("registered_branch_main_readback_missing_or_ambiguous");
  }
  const main = results[0]!;
  if (main.category !== "OST_DuctCurves" || main.typeId !== mapping.route_type_id) throw new Error("registered_branch_main_type_mismatch");
  if (!Array.isArray(main.connectors) || main.connectors.length !== 2) throw new Error("registered_branch_main_not_straight_two_connector_duct");
  const connectors = main.connectors;
  if (connectors.some(value => value.domain !== "DomainHvac" || value.shape !== "Round"
      || token(value.systemClassification) !== token(mapping.system_type)
      || typeof value.size?.diameterFt !== "number" || !Number.isFinite(value.size.diameterFt)
      || value.size.diameterFt <= 0 || Math.abs(value.size.diameterFt - diameter) > 1 / 192
      || value.physicalConnectionCount !== 1
      || !Array.isArray(value.origin) || value.origin.length !== 3 || !value.origin.every(Number.isFinite))) {
    throw new Error("registered_branch_main_service_size_or_topology_mismatch");
  }
  const a = connectors[0]!.origin!;
  const b = connectors[1]!.origin!;
  const start = point(source.model_points[0]!, mapping.elevation_z_ft);
  const lengthSq = a.reduce((sum, value, index) => sum + (b[index]! - value) ** 2, 0);
  if (lengthSq < 1e-6) throw new Error("registered_branch_main_degenerate");
  const fraction = a.reduce((sum, value, index) => sum + (start[(["x","y","z"] as const)[index]!] - value) * (b[index]! - value), 0) / lengthSq;
  const projected = a.map((value, index) => value + fraction * (b[index]! - value));
  const distance = Math.hypot(start.x - projected[0]!, start.y - projected[1]!, start.z - projected[2]!);
  if (distance > 0.1 || fraction <= 0.1 || fraction >= 0.9) throw new Error("registered_branch_source_junction_not_unique_interior_main_point");
  const points = source.model_points.map(value => point(value, mapping.elevation_z_ft));
  if (points.slice(1).some((value, index) => Math.hypot(value.x - points[index]!.x, value.y - points[index]!.y, value.z - points[index]!.z) < 0.1)) {
    throw new Error("registered_branch_source_has_short_segment");
  }
  const fingerprint = digest({ registration_sha256: args.registration_sha256, registration_evidence_id: args.registration_evidence_id,
    primitive_id: source.primitive_id, source_artifact_sha256: source.source_artifact_sha256, main_readback: args.main_connector_readback, mapping });
  const body = { kind: "duct", mainElementId: mainId, connectionMode: "tee", branchPoints: points,
    branchSize: mapping.size, viewId: registered.native_view_id, levelName: mapping.level_name,
    verify: true, visualVerify: true, visualViewId: registered.native_view_id };
  const expectedMaximum = Math.max(6, points.length * 3 + 2);
  const far = source.model_endpoints.filter(value =>
    Math.hypot(value.point.x - points[points.length - 1]!.x, value.point.y - points[points.length - 1]!.y) < 1e-6);
  if (far.length !== 1 || !clean(far[0]!.endpoint_key)) throw new Error("registered_branch_far_source_endpoint_missing_or_ambiguous");
  const last = points[points.length - 1]!;
  const beforeLast = points[points.length - 2]!;
  const dx = last.x - beforeLast.x;
  const dy = last.y - beforeLast.y;
  const length = Math.hypot(dx, dy);
  const direction: [number, number, number] = [dx / length, dy / length, 0];
  const workflow: AtomicMepDraftWorkflowRequest = {
    inputFingerprintSha256: fingerprint,
    provisionalObservationIds: [source.primitive_id],
    operations: [{ action_key: `registered-branch:${source.primitive_id}`, observation_ids: [source.primitive_id],
      path: "/revit/connect-mep-branch", depends_on: [], apply_body: body,
      expected_created_min: 2, expected_created_max: expectedMaximum, execution_mode: "single_action",
      continuation_endpoints: [{ endpoint_key: `registered-branch:${source.primitive_id}:${far[0]!.endpoint_key}`,
        output: "route_end", model_point: last, direction_xyz: direction,
        source_observation_ids: [source.primitive_id], system_classification: mapping.system_type,
        size: mapping.size, state: "unresolved_continuation" }] }],
    dryRun: true, verify: true, maximumCreatedElements: expectedMaximum,
    targetViewId: registered.native_view_id, applyTargetViewPhase: true,
    requireAllCreatedElementsVisibleInTargetView: true, benchmarkCredit: false,
    authorizationBasis: "explicit_unscored_user_direction"
  };
  return { workflow, main_readback_sha256: digest(args.main_connector_readback), source_mark_ids: source.source_mark_ids };
}
