import crypto from "node:crypto";
import type { SheetTopologyPoint } from "./sheet_topology_compiler.js";
import type {
  RegisteredRouteEndpointSnapV1,
  RegisteredRouteSnapCandidateV1,
  RegisteredRouteSnapPolicyV1
} from "./registered_route_connector_snap.js";
import {
  formatRouteProfileSizeV1,
  normalizeRouteProfileShapeV1,
  parseRouteProfileSizeV1,
  routeProfileDimensionsCompatibleV1,
  type RouteProfileDimensionsV1,
  type RouteProfileShapeV1
} from "./route_profile.js";

export type RegisteredRouteSourceClaimV1 = {
  attribute: "shape" | "size" | "system_type" | "elevation_z_ft";
  value: string | number;
  association: "exact" | "contextual" | "unresolved";
  confidence: number;
  evidence_reference: string;
};

export type RegisteredRouteFrontierCandidateV1 = {
  schema_version: 1;
  package_id: string;
  primitive_id: string;
  source_interpretation_sha256: string;
  registration_receipt_sha256: string;
  raster_evidence_receipt_sha256: string;
  kind: "duct" | "pipe" | "conduit";
  points: SheetTopologyPoint[];
  view_id: number;
  level_name: string;
  source_frame_id?: string;
  registration_context_id?: string;
  source_claims?: RegisteredRouteSourceClaimV1[];
};

export type RegisteredRouteFrontierPolicyV1 = Pick<
  RegisteredRouteSnapPolicyV1,
  "maximum_endpoint_snap_ft" | "minimum_ambiguity_margin_ft" | "minimum_direction_dot" |
  "maximum_size_delta_ft" | "maximum_connector_z_delta_ft" | "final_connection_tolerance_ft"
> & {
  minimum_exact_source_claim_confidence: number;
};

export const DEFAULT_REGISTERED_ROUTE_FRONTIER_POLICY_V1: RegisteredRouteFrontierPolicyV1 = {
  maximum_endpoint_snap_ft: 0.6,
  minimum_ambiguity_margin_ft: 0.05,
  minimum_direction_dot: 0.8,
  maximum_size_delta_ft: 1 / 64,
  maximum_connector_z_delta_ft: 0.1,
  final_connection_tolerance_ft: 0.01,
  minimum_exact_source_claim_confidence: 0.8
};

export type RegisteredRouteSourceClaimAssessmentV1 = RegisteredRouteSourceClaimV1 & {
  native_value: string | number;
  status: "agrees" | "native_override_recorded" | "exact_conflict_blocks";
};

export type RegisteredRouteFrontierReceiptV1 = {
  schema_version: 1;
  artifact_role: "registered_route_frontier_discovery";
  package_id: string;
  primitive_id: string;
  input_fingerprint_sha256: string;
  native_connector_readback_sha256: string;
  status: "ready" | "deferred";
  blockers: string[];
  endpoint_matches: RegisteredRouteEndpointSnapV1[];
  native_consensus: null | {
    domain: string;
    shape: RouteProfileShapeV1;
    size: string;
    diameter_ft: number | null;
    width_ft: number | null;
    height_ft: number | null;
    elevation_z_ft: number;
    system_type: string;
    route_type_id: number;
    route_type_name: string;
    created_phase_id: number | null;
    adjacent_route_element_ids: number[];
  };
  source_claim_assessments: RegisteredRouteSourceClaimAssessmentV1[];
  resolved_candidate: RegisteredRouteSnapCandidateV1 | null;
};

type NativeReference = { owner_id: number; owner_category: string; is_physical: boolean };
type NativeConnector = {
  owner_element_id: number;
  owner_category: string;
  owner_system_name: string;
  connector_id: number | null;
  connector_index: number;
  connector_id_basis: string;
  origin: [number, number, number];
  direction: [number, number, number];
  domain: string;
  shape: string;
  system_classification: string;
  diameter_ft: number | null;
  width_ft: number | null;
  height_ft: number | null;
  physical_connection_count: number;
  physical_connected_to: NativeReference[];
};
type NativeResult = {
  id: number;
  category: string;
  name: string;
  type_id: number | null;
  type_name: string;
  created_phase_id: number | null;
  system_name: string;
  connectors: NativeConnector[];
};

function clean(value: unknown): string { return String(value ?? "").trim(); }
function normalized(value: unknown): string { return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`); return value; }
function positive(value: unknown, label: string): number { const out = finite(value, label); if (out <= 0) throw new Error(`${label}_must_be_positive`); return out; }
function unit(value: unknown, label: string): number { const out = finite(value, label); if (out < 0 || out > 1) throw new Error(`${label}_must_be_between_zero_and_one`); return out; }
function optionalPositiveInteger(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null; }
function optionalFinite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function triple(value: unknown, label: string): [number, number, number] { if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label}_must_have_three_values`); return [finite(value[0], `${label}_x`), finite(value[1], `${label}_y`), finite(value[2], `${label}_z`)]; }
function sha256(value: unknown, label: string): string { const out = clean(value).toLowerCase(); if (!/^[a-f0-9]{64}$/.test(out)) throw new Error(`${label}_must_be_sha256`); return out; }
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const entry = value as Record<string, unknown>; return `{${Object.keys(entry).sort().map(key => `${JSON.stringify(key)}:${canonical(entry[key])}`).join(",")}}`; }
function digest(value: unknown): string { return crypto.createHash("sha256").update(canonical(value)).digest("hex"); }

function normalizeReadback(readback: unknown): NativeResult[] {
  const rows: NativeResult[] = [];
  for (const [rowIndex, rawRow] of array(object(readback).results).entries()) {
    const row = object(rawRow);
    if (row.ok === false) continue;
    const id = finite(row.id, `frontier_result_${rowIndex}_id`);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`frontier_result_${rowIndex}_id_invalid`);
    const category = clean(row.category);
    const systemName = clean(row.systemName);
    const connectors = array(row.connectors).map((rawConnector, connectorIndex): NativeConnector => {
      const connector = object(rawConnector);
      const size = object(connector.size);
      const coordinateSystem = object(connector.coordinateSystem);
      return {
        owner_element_id: id,
        owner_category: category,
        owner_system_name: systemName,
        connector_id: optionalFinite(connector.connectorId),
        connector_index: Number.isSafeInteger(connector.index) ? Number(connector.index) : connectorIndex,
        connector_id_basis: clean(connector.connectorIdBasis),
        origin: triple(connector.origin, `frontier_connector_${id}_${connectorIndex}_origin`),
        direction: triple(coordinateSystem.basisZ, `frontier_connector_${id}_${connectorIndex}_direction`),
        domain: normalized(connector.domain),
        shape: normalized(connector.shape),
        system_classification: clean(connector.systemClassification),
        diameter_ft: optionalFinite(size.diameterFt),
        width_ft: optionalFinite(size.widthFt),
        height_ft: optionalFinite(size.heightFt),
        physical_connection_count: finite(connector.physicalConnectionCount, `frontier_connector_${id}_${connectorIndex}_physical_connection_count`),
        physical_connected_to: array(connector.physicalConnectedTo).map((rawReference, referenceIndex) => {
          const reference = object(rawReference);
          const ownerId = finite(reference.ownerId, `frontier_connector_${id}_${connectorIndex}_reference_${referenceIndex}_owner_id`);
          if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error(`frontier_connector_${id}_${connectorIndex}_reference_${referenceIndex}_owner_id_invalid`);
          return { owner_id: ownerId, owner_category: clean(reference.ownerCategory), is_physical: reference.isPhysicalElement !== false };
        })
      };
    });
    rows.push({
      id,
      category,
      name: clean(row.name),
      type_id: optionalPositiveInteger(row.typeId),
      type_name: clean(row.typeName) || clean(row.name),
      created_phase_id: optionalPositiveInteger(row.createdPhaseId),
      system_name: systemName,
      connectors
    });
  }
  return rows;
}

function directionDot(a: [number, number, number], b: [number, number, number]): number {
  const al = Math.hypot(...a); const bl = Math.hypot(...b);
  return al <= 1e-9 || bl <= 1e-9 ? -1 : (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / al / bl;
}
function connectorKey(value: NativeConnector): string { return `${value.owner_element_id}:${value.connector_id ?? `index-${value.connector_index}`}`; }
function routeDirection(points: SheetTopologyPoint[], endpoint: "start" | "end"): [number, number, number] {
  const a = endpoint === "start" ? points[0]! : points[points.length - 1]!;
  const b = endpoint === "start" ? points[1]! : points[points.length - 2]!;
  return [finite(b.x, "frontier_direction_x") - finite(a.x, "frontier_direction_x"), finite(b.y, "frontier_direction_y") - finite(a.y, "frontier_direction_y"), 0];
}
function connectorProfile(connector: NativeConnector): RouteProfileDimensionsV1 | null {
  const shape = normalizeRouteProfileShapeV1(connector.shape);
  if (!shape) return null;
  const profile = {
    shape,
    diameter_ft: connector.diameter_ft,
    width_ft: connector.width_ft,
    height_ft: connector.height_ft
  };
  if (shape === "round") return profile.diameter_ft !== null ? profile : null;
  return profile.width_ft !== null && profile.height_ft !== null ? profile : null;
}
function meanProfile(left: RouteProfileDimensionsV1, right: RouteProfileDimensionsV1): RouteProfileDimensionsV1 {
  return {
    shape: left.shape,
    diameter_ft: left.diameter_ft === null || right.diameter_ft === null ? null : (left.diameter_ft + right.diameter_ft) / 2,
    width_ft: left.width_ft === null || right.width_ft === null ? null : (left.width_ft + right.width_ft) / 2,
    height_ft: left.height_ft === null || right.height_ft === null ? null : (left.height_ft + right.height_ft) / 2
  };
}
function humanizeSystem(value: string): string {
  const spaced = clean(value).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return spaced.replace(/\b\w/g, letter => letter.toUpperCase());
}
function systemToken(connector: NativeConnector): string {
  const classified = normalized(connector.system_classification);
  if (classified && !classified.includes("undefined")) return classified;
  return normalized(connector.owner_system_name).replace(/^mechanical\s+/, "").replace(/\s+\d+$/, "").trim();
}
function routeCategory(kind: RegisteredRouteFrontierCandidateV1["kind"], value: string): boolean {
  const token = normalized(value).replace(/\s+/g, "");
  return kind === "duct" ? token.includes("ductcurve") : kind === "pipe" ? token.includes("pipecurve") : token.includes("conduit");
}

export function discoverRegisteredRouteFrontierV1(
  candidate: RegisteredRouteFrontierCandidateV1,
  context: { native_connector_readback: unknown; policy?: Partial<RegisteredRouteFrontierPolicyV1> }
): RegisteredRouteFrontierReceiptV1 {
  if (!candidate || candidate.schema_version !== 1) throw new Error("registered_route_frontier_requires_schema_v1");
  const packageId = clean(candidate.package_id); const primitiveId = clean(candidate.primitive_id);
  if (!packageId || !primitiveId) throw new Error("registered_route_frontier_identity_required");
  sha256(candidate.source_interpretation_sha256, "registered_route_frontier_source_interpretation");
  sha256(candidate.registration_receipt_sha256, "registered_route_frontier_registration_receipt");
  sha256(candidate.raster_evidence_receipt_sha256, "registered_route_frontier_raster_evidence_receipt");
  if (!["duct", "pipe", "conduit"].includes(candidate.kind)) throw new Error("registered_route_frontier_kind_invalid");
  if (!Array.isArray(candidate.points) || candidate.points.length < 2) throw new Error("registered_route_frontier_requires_two_points");
  if (!Number.isSafeInteger(candidate.view_id) || candidate.view_id <= 0 || !clean(candidate.level_name)) throw new Error("registered_route_frontier_view_and_level_required");
  candidate.points.forEach((point, index) => { finite(point.x, `frontier_point_${index}_x`); finite(point.y, `frontier_point_${index}_y`); });
  const policy: RegisteredRouteFrontierPolicyV1 = {
    maximum_endpoint_snap_ft: positive(context.policy?.maximum_endpoint_snap_ft ?? DEFAULT_REGISTERED_ROUTE_FRONTIER_POLICY_V1.maximum_endpoint_snap_ft, "frontier_maximum_endpoint_snap_ft"),
    minimum_ambiguity_margin_ft: positive(context.policy?.minimum_ambiguity_margin_ft ?? DEFAULT_REGISTERED_ROUTE_FRONTIER_POLICY_V1.minimum_ambiguity_margin_ft, "frontier_minimum_ambiguity_margin_ft"),
    minimum_direction_dot: unit(context.policy?.minimum_direction_dot ?? DEFAULT_REGISTERED_ROUTE_FRONTIER_POLICY_V1.minimum_direction_dot, "frontier_minimum_direction_dot"),
    maximum_size_delta_ft: positive(context.policy?.maximum_size_delta_ft ?? DEFAULT_REGISTERED_ROUTE_FRONTIER_POLICY_V1.maximum_size_delta_ft, "frontier_maximum_size_delta_ft"),
    maximum_connector_z_delta_ft: positive(context.policy?.maximum_connector_z_delta_ft ?? DEFAULT_REGISTERED_ROUTE_FRONTIER_POLICY_V1.maximum_connector_z_delta_ft, "frontier_maximum_connector_z_delta_ft"),
    final_connection_tolerance_ft: positive(context.policy?.final_connection_tolerance_ft ?? DEFAULT_REGISTERED_ROUTE_FRONTIER_POLICY_V1.final_connection_tolerance_ft, "frontier_final_connection_tolerance_ft"),
    minimum_exact_source_claim_confidence: unit(context.policy?.minimum_exact_source_claim_confidence ?? DEFAULT_REGISTERED_ROUTE_FRONTIER_POLICY_V1.minimum_exact_source_claim_confidence, "frontier_minimum_exact_source_claim_confidence")
  };
  if (policy.maximum_endpoint_snap_ft > 1 || policy.final_connection_tolerance_ft > 0.1) throw new Error("registered_route_frontier_policy_too_permissive");
  const rows = normalizeReadback(context.native_connector_readback);
  const connectors = rows.flatMap(row => row.connectors);
  const expectedDomain = candidate.kind === "duct" ? "domainhvac" : candidate.kind === "pipe" ? "domainpiping" : "domainelectrical";
  const blockers: string[] = [];
  const endpointMatches: RegisteredRouteEndpointSnapV1[] = [];
  const chosen = new Map<"start" | "end", NativeConnector>();

  for (const endpoint of ["start", "end"] as const) {
    const point = endpoint === "start" ? candidate.points[0]! : candidate.points[candidate.points.length - 1]!;
    const direction = routeDirection(candidate.points, endpoint);
    const ranked = connectors.flatMap(connector => {
      const profile = connectorProfile(connector);
      if (connector.physical_connection_count !== 0 || connector.domain !== expectedDomain || !profile) return [];
      if (candidate.kind !== "duct" && profile.shape !== "round") return [];
      const distance = Math.hypot(connector.origin[0] - point.x, connector.origin[1] - point.y);
      const dot = directionDot(connector.direction, direction);
      return distance <= policy.maximum_endpoint_snap_ft && dot >= policy.minimum_direction_dot ? [{ connector, distance, dot }] : [];
    }).sort((a, b) => a.distance - b.distance || b.dot - a.dot || connectorKey(a.connector).localeCompare(connectorKey(b.connector)));
    if (ranked.length === 0) { blockers.push(`${endpoint}_frontier_has_no_compatible_open_connector`); continue; }
    if (ranked.length > 1 && ranked[1]!.distance - ranked[0]!.distance < policy.minimum_ambiguity_margin_ft) { blockers.push(`${endpoint}_frontier_connector_match_is_ambiguous`); continue; }
    const winner = ranked[0]!;
    chosen.set(endpoint, winner.connector);
    endpointMatches.push({
      endpoint,
      registered_point: { x: point.x, y: point.y, z: point.z ?? winner.connector.origin[2] },
      snapped_point: { x: winner.connector.origin[0], y: winner.connector.origin[1], z: winner.connector.origin[2] },
      displacement_ft: winner.distance,
      direction_dot: winner.dot,
      owner_element_id: winner.connector.owner_element_id,
      owner_category: winner.connector.owner_category,
      owner_system_name: winner.connector.owner_system_name,
      connector_id: winner.connector.connector_id,
      connector_index: winner.connector.connector_index,
      connector_id_basis: winner.connector.connector_id_basis
    });
  }
  const start = chosen.get("start"); const end = chosen.get("end");
  if (start && end && connectorKey(start) === connectorKey(end)) blockers.push("frontier_endpoints_resolve_to_same_connector");
  let consensus: RegisteredRouteFrontierReceiptV1["native_consensus"] = null;
  if (start && end) {
    const startProfile = connectorProfile(start);
    const endProfile = connectorProfile(end);
    if (start.domain !== end.domain) blockers.push("frontier_domain_consensus_failed");
    if (!startProfile || !endProfile || startProfile.shape !== endProfile.shape) blockers.push("frontier_shape_consensus_failed");
    else if (!routeProfileDimensionsCompatibleV1(startProfile, endProfile, policy.maximum_size_delta_ft)) blockers.push("frontier_size_consensus_failed");
    if (Math.abs(start.origin[2] - end.origin[2]) > policy.maximum_connector_z_delta_ft) blockers.push("frontier_elevation_consensus_failed");
    const startSystem = systemToken(start); const endSystem = systemToken(end);
    if (!startSystem || startSystem !== endSystem) blockers.push("frontier_system_consensus_failed");
    const rowById = new Map(rows.map(row => [row.id, row]));
    const adjacentIds = [...new Set([start, end].flatMap(connector => {
      const owner = rowById.get(connector.owner_element_id);
      return owner?.connectors.flatMap(entry => entry.physical_connected_to.map(reference => reference.owner_id)) ?? [];
    }).filter(id => id !== start.owner_element_id && id !== end.owner_element_id && routeCategory(candidate.kind, rowById.get(id)?.category ?? "")))].sort((a, b) => a - b);
    const adjacentRows = adjacentIds.map(id => rowById.get(id)).filter((row): row is NativeResult => Boolean(row));
    const typeIds = [...new Set(adjacentRows.map(row => row.type_id).filter((id): id is number => id !== null))];
    const typeNames = [...new Set(adjacentRows.map(row => row.type_name).filter(Boolean))];
    if (adjacentRows.length === 0) blockers.push("frontier_adjacent_native_route_missing");
    if (typeIds.length !== 1 || typeNames.length !== 1) blockers.push("frontier_route_type_consensus_failed");
    const phases = [...new Set(adjacentRows.map(row => row.created_phase_id).filter((id): id is number => id !== null))];
    if (phases.length > 1) blockers.push("frontier_created_phase_consensus_failed");
    if (blockers.length === 0 && startProfile && endProfile && typeIds[0] && typeNames[0]) {
      const profile = meanProfile(startProfile, endProfile);
      consensus = {
        domain: start.domain,
        shape: profile.shape,
        size: formatRouteProfileSizeV1(profile),
        diameter_ft: profile.diameter_ft,
        width_ft: profile.width_ft,
        height_ft: profile.height_ft,
        elevation_z_ft: (start.origin[2] + end.origin[2]) / 2,
        system_type: humanizeSystem(start.system_classification || startSystem),
        route_type_id: typeIds[0],
        route_type_name: typeNames[0],
        created_phase_id: phases[0] ?? null,
        adjacent_route_element_ids: adjacentIds
      };
    }
  }
  const assessments: RegisteredRouteSourceClaimAssessmentV1[] = [];
  if (consensus) {
    for (const [index, claim] of (candidate.source_claims ?? []).entries()) {
      const confidence = unit(claim.confidence, `frontier_source_claim_${index}_confidence`);
      if (!clean(claim.evidence_reference)) throw new Error(`frontier_source_claim_${index}_evidence_reference_required`);
      const nativeValue = claim.attribute === "shape" ? consensus.shape : claim.attribute === "size" ? consensus.size : claim.attribute === "system_type" ? consensus.system_type : consensus.elevation_z_ft;
      const agrees = claim.attribute === "size"
        ? (() => {
          const claimed = parseRouteProfileSizeV1(consensus.shape, claim.value);
          const native = parseRouteProfileSizeV1(consensus.shape, consensus.size);
          return claimed !== null && native !== null && routeProfileDimensionsCompatibleV1(claimed, native, policy.maximum_size_delta_ft);
        })()
        : claim.attribute === "elevation_z_ft"
          ? typeof claim.value === "number" && Math.abs(claim.value - consensus.elevation_z_ft) <= policy.maximum_connector_z_delta_ft
          : normalized(claim.value) === normalized(nativeValue);
      const blocks = !agrees && claim.association === "exact" && confidence >= policy.minimum_exact_source_claim_confidence;
      assessments.push({ ...claim, confidence, native_value: nativeValue, status: agrees ? "agrees" : blocks ? "exact_conflict_blocks" : "native_override_recorded" });
      if (blocks) blockers.push(`frontier_exact_source_claim_conflicts_with_native_consensus:${claim.attribute}`);
    }
  }
  const ready = blockers.length === 0 && consensus !== null && endpointMatches.length === 2;
  const resolved: RegisteredRouteSnapCandidateV1 | null = ready ? {
    schema_version: 1,
    package_id: packageId,
    primitive_id: primitiveId,
    source_interpretation_sha256: candidate.source_interpretation_sha256,
    registration_receipt_sha256: candidate.registration_receipt_sha256,
    raster_evidence_receipt_sha256: candidate.raster_evidence_receipt_sha256,
    kind: candidate.kind,
    points: candidate.points.map(point => ({ x: point.x, y: point.y })),
    view_id: candidate.view_id,
    level_name: candidate.level_name,
    elevation_z_ft: consensus!.elevation_z_ft,
    system_type: consensus!.system_type,
    route_type_name: consensus!.route_type_name,
    route_type_id: consensus!.route_type_id,
    source_frame_id: candidate.source_frame_id,
    registration_context_id: candidate.registration_context_id,
    shape: consensus!.shape,
    size: consensus!.size
  } : null;
  return {
    schema_version: 1,
    artifact_role: "registered_route_frontier_discovery",
    package_id: packageId,
    primitive_id: primitiveId,
    input_fingerprint_sha256: digest(candidate),
    native_connector_readback_sha256: digest(context.native_connector_readback),
    status: ready ? "ready" : "deferred",
    blockers,
    endpoint_matches: endpointMatches,
    native_consensus: consensus,
    source_claim_assessments: assessments,
    resolved_candidate: resolved
  };
}
