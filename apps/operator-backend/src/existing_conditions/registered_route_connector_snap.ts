import crypto from "node:crypto";
import type { AtomicMepDraftWorkflowRequest } from "./mep_draft_plan.js";
import {
  parseRouteProfileSizeV1,
  routeProfileDimensionsCompatibleV1,
  type RouteProfileDimensionsV1
} from "./route_profile.js";
import type { SheetTopologyPoint } from "./sheet_topology_compiler.js";
import type { RegisteredStructuredExistingConditionsInterpretationV1 } from "./registered_structured_interpretation.js";

export type RegisteredRouteSnapCandidateV1 = {
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
  elevation_z_ft: number;
  system_type: string;
  route_type_name?: string;
  route_type_id?: number;
  source_frame_id?: string;
  registration_context_id?: string;
  shape: "round" | "rectangular" | "oval";
  size: string;
  required_existing_endpoint?: "start" | "end";
  registration_evidence_id?: string;
  deferred_far_end_reason?: string;
};

export type RegisteredRouteSnapContextV1 = {
  native_connector_readback: unknown;
  registered_interpretation?: RegisteredStructuredExistingConditionsInterpretationV1;
  registered_interpretation_sha256?: string;
  policy?: Partial<RegisteredRouteSnapPolicyV1>;
};

export type RegisteredRouteSnapPolicyV1 = {
  maximum_endpoint_snap_ft: number;
  minimum_ambiguity_margin_ft: number;
  minimum_direction_dot: number;
  maximum_size_delta_ft: number;
  maximum_connector_z_delta_ft: number;
  final_connection_tolerance_ft: number;
};

export const DEFAULT_REGISTERED_ROUTE_SNAP_POLICY_V1: RegisteredRouteSnapPolicyV1 = {
  maximum_endpoint_snap_ft: 0.35,
  minimum_ambiguity_margin_ft: 0.05,
  minimum_direction_dot: 0.8,
  maximum_size_delta_ft: 1 / 64,
  maximum_connector_z_delta_ft: 0.1,
  final_connection_tolerance_ft: 0.01
};

type NativeConnector = {
  owner_element_id: number;
  owner_category: string;
  owner_system_name: string;
  system_classification: string;
  connector_id: number | null;
  connector_index: number;
  connector_id_basis: string;
  origin: [number, number, number];
  direction: [number, number, number];
  domain: string;
  shape: string;
  diameter_ft: number | null;
  width_ft: number | null;
  height_ft: number | null;
  physical_connection_count: number;
};

export type RegisteredRouteEndpointSnapV1 = {
  endpoint: "start" | "end";
  registered_point: { x: number; y: number; z: number };
  snapped_point: { x: number; y: number; z: number };
  displacement_ft: number;
  direction_dot: number;
  owner_element_id: number;
  owner_category: string;
  owner_system_name: string;
  connector_system_classification?: string;
  connector_id: number | null;
  connector_index: number;
  connector_id_basis: string;
};

export type RegisteredRouteSnapReceiptV1 = {
  schema_version: 1;
  artifact_role: "registered_route_connector_snap";
  package_id: string;
  primitive_id: string;
  input_fingerprint_sha256: string;
  native_connector_readback_sha256: string;
  status: "ready" | "deferred";
  blockers: string[];
  endpoint_diagnostics?: Array<{
    endpoint: "start" | "end";
    requested_system_type: string;
    nearby_open_connector_systems: string[];
  }>;
  endpoint_snaps: RegisteredRouteEndpointSnapV1[];
  far_end_obligation?: {
    source_endpoint_key: string;
    boundary: "internal" | "view_boundary" | "sheet_continuation";
    continuation_key?: string;
    outward_direction_xy: [number, number];
    reason: string;
  };
  snapped_points: Array<{ x: number; y: number; z: number }>;
  action_mode: "create_mep_route" | "pipe_between_existing_connectors";
  dry_run_action: null | { method: "POST"; path: "/revit/create-mep-route" | "/revit/create-pipe-between-connectors"; body: Record<string, unknown> };
  apply_action: null | { method: "POST"; path: "/revit/create-mep-route" | "/revit/create-pipe-between-connectors"; body: Record<string, unknown> };
  acceptance_requirements: string[];
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function serviceToken(value: unknown): string {
  return normalized(value).replace(/\s+/g, "");
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function positive(value: unknown, label: string): number {
  const result = finite(value, label);
  if (result <= 0) throw new Error(`${label}_must_be_positive`);
  return result;
}

function unit(value: unknown, label: string): number {
  const result = finite(value, label);
  if (result < 0 || result > 1) throw new Error(`${label}_must_be_between_zero_and_one`);
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
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

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function triple(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label}_must_have_three_values`);
  return [finite(value[0], `${label}_x`), finite(value[1], `${label}_y`), finite(value[2], `${label}_z`)];
}

function optionalFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeConnectors(readback: unknown): NativeConnector[] {
  const root = object(readback);
  const connectors: NativeConnector[] = [];
  for (const [resultIndex, rawResult] of array(root.results).entries()) {
    const result = object(rawResult);
    const ownerId = finite(result.id, `native_connector_result_${resultIndex}_id`);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error(`native_connector_result_${resultIndex}_id_invalid`);
    for (const [connectorIndex, rawConnector] of array(result.connectors).entries()) {
      const connector = object(rawConnector);
      const size = object(connector.size);
      const coordinateSystem = object(connector.coordinateSystem);
      const physicalConnectionCount = finite(
        connector.physicalConnectionCount,
        `native_connector_${ownerId}_${connectorIndex}_physical_connection_count`
      );
      connectors.push({
        owner_element_id: ownerId,
        owner_category: clean(result.category),
        owner_system_name: clean(result.systemName),
        system_classification: clean(connector.systemClassification),
        connector_id: optionalFinite(connector.connectorId),
        connector_index: Number.isSafeInteger(connector.index) ? Number(connector.index) : connectorIndex,
        connector_id_basis: clean(connector.connectorIdBasis),
        origin: triple(connector.origin, `native_connector_${ownerId}_${connectorIndex}_origin`),
        direction: triple(coordinateSystem.basisZ, `native_connector_${ownerId}_${connectorIndex}_direction`),
        domain: normalized(connector.domain),
        shape: normalized(connector.shape),
        diameter_ft: optionalFinite(size.diameterFt),
        width_ft: optionalFinite(size.widthFt),
        height_ft: optionalFinite(size.heightFt),
        physical_connection_count: physicalConnectionCount
      });
    }
  }
  return connectors;
}

function sizeCompatible(connector: NativeConnector, candidate: RegisteredRouteSnapCandidateV1, tolerance: number): boolean {
  const expected = parseRouteProfileSizeV1(candidate.shape, candidate.size);
  const actual: RouteProfileDimensionsV1 = {
    shape: candidate.shape,
    diameter_ft: connector.diameter_ft,
    width_ft: connector.width_ft,
    height_ft: connector.height_ft
  };
  return expected !== null && routeProfileDimensionsCompatibleV1(actual, expected, tolerance);
}

function directionDot(a: [number, number, number], b: [number, number, number]): number {
  const al = Math.hypot(...a);
  const bl = Math.hypot(...b);
  if (al <= 1e-9 || bl <= 1e-9) return -1;
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / al / bl;
}

function point3(value: SheetTopologyPoint, z: number, label: string): { x: number; y: number; z: number } {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  return { x: finite(value.x, `${label}_x`), y: finite(value.y, `${label}_y`), z: value.z === undefined ? z : finite(value.z, `${label}_z`) };
}

function routeDirection(points: Array<{ x: number; y: number; z: number }>, endpoint: "start" | "end"): [number, number, number] {
  const a = endpoint === "start" ? points[0]! : points[points.length - 1]!;
  const b = endpoint === "start" ? points[1]! : points[points.length - 2]!;
  return [b.x - a.x, b.y - a.y, b.z - a.z];
}

function connectorKey(value: NativeConnector): string {
  return `${value.owner_element_id}:${value.connector_id ?? `index-${value.connector_index}`}`;
}

function sourceBoundFarEnd(
  candidate: RegisteredRouteSnapCandidateV1,
  context: RegisteredRouteSnapContextV1
): RegisteredRouteSnapReceiptV1["far_end_obligation"] {
  const required = candidate.required_existing_endpoint;
  if (required === undefined) return undefined;
  if (candidate.kind !== "duct" || (required !== "start" && required !== "end")) {
    throw new Error("registered_route_snap_one_sided_duct_endpoint_invalid");
  }
  if (!/^ev1_[A-Za-z0-9_-]{32}$/.test(clean(candidate.registration_evidence_id))) {
    throw new Error("registered_route_snap_registration_evidence_id_required");
  }
  const registered = context.registered_interpretation;
  if (!registered || !context.registered_interpretation_sha256) {
    throw new Error("registered_route_snap_authoritative_registration_required");
  }
  if (sha256(context.registered_interpretation_sha256, "registered_route_snap_authoritative_registration_hash")
      !== sha256(candidate.registration_receipt_sha256, "registered_route_snap_registration_receipt")) {
    throw new Error("registered_route_snap_registration_hash_mismatch");
  }
  if (registered.schema_version !== 1 || registered.native_write_allowed !== false
      || registered.registration?.verified !== true
      || registered.package_id !== candidate.package_id || registered.native_view_id !== candidate.view_id
      || registered.registration.source_evidence_sha256 !== candidate.source_interpretation_sha256) {
    throw new Error("registered_route_snap_registration_identity_mismatch");
  }
  const matches = registered.registered_primitives.filter(value => value.primitive_id === candidate.primitive_id);
  if (matches.length !== 1 || matches[0]!.kind !== "route_segment" || matches[0]!.source_mark_ids.length === 0) {
    throw new Error("registered_route_snap_source_primitive_missing_or_ambiguous");
  }
  const source = matches[0]!;
  if (source.model_points.length !== candidate.points.length || source.model_endpoints.length !== 2
      || source.model_points.some((point, index) => {
        const proposed = candidate.points[index];
        return !proposed || Math.hypot(point.x - proposed.x, point.y - proposed.y) > 1e-6;
      })) {
    throw new Error("registered_route_snap_source_geometry_mismatch");
  }
  for (const endpointIndex of [0, source.model_points.length - 1]) {
    const point = source.model_points[endpointIndex]!;
    const matches = source.model_endpoints.filter(endpoint =>
      Math.hypot(endpoint.point.x - point.x, endpoint.point.y - point.y) <= 1e-6
    );
    if (matches.length !== 1 || !clean(matches[0]!.endpoint_key)) {
      throw new Error("registered_route_snap_source_endpoints_missing_or_ambiguous");
    }
  }
  const farIndex = required === "start" ? source.model_points.length - 1 : 0;
  const farPoint = source.model_points[farIndex]!;
  const far = source.model_endpoints.filter(endpoint =>
    Math.hypot(endpoint.point.x - farPoint.x, endpoint.point.y - farPoint.y) <= 1e-6
  );
  if (far.length !== 1 || !clean(far[0]!.endpoint_key)) {
    throw new Error("registered_route_snap_far_source_endpoint_missing_or_ambiguous");
  }
  const reason = clean(candidate.deferred_far_end_reason);
  if (!reason || reason.length > 240) throw new Error("registered_route_snap_far_end_obligation_required");
  const direction = far[0]!.outward_direction_xy;
  if (!Array.isArray(direction) || direction.length !== 2
      || !direction.every(value => typeof value === "number" && Number.isFinite(value))
      || Math.abs(Math.hypot(...direction) - 1) > 0.01) {
    throw new Error("registered_route_snap_far_source_direction_invalid");
  }
  return {
    source_endpoint_key: far[0]!.endpoint_key,
    boundary: far[0]!.boundary,
    ...(far[0]!.continuation_key ? { continuation_key: far[0]!.continuation_key } : {}),
    outward_direction_xy: far[0]!.outward_direction_xy,
    reason
  };
}

function exactPipeBridgeService(systemType: string): "domestic_cold_water" | "domestic_hot_water" | "sanitary" | "vent" | null {
  const value = normalized(systemType);
  if (value.includes("domestic cold water")) return "domestic_cold_water";
  if (value.includes("domestic hot water")) return "domestic_hot_water";
  if (value.includes("sanitary")) return "sanitary";
  if (value.includes("vent")) return "vent";
  return null;
}

export function planRegisteredRouteConnectorSnapV1(
  candidate: RegisteredRouteSnapCandidateV1,
  context: RegisteredRouteSnapContextV1
): RegisteredRouteSnapReceiptV1 {
  if (!candidate || candidate.schema_version !== 1) throw new Error("registered_route_snap_requires_schema_v1");
  const packageId = clean(candidate.package_id);
  const primitiveId = clean(candidate.primitive_id);
  if (!packageId) throw new Error("registered_route_snap_package_id_required");
  if (!primitiveId) throw new Error("registered_route_snap_primitive_id_required");
  sha256(candidate.source_interpretation_sha256, "registered_route_snap_source_interpretation");
  sha256(candidate.registration_receipt_sha256, "registered_route_snap_registration_receipt");
  sha256(candidate.raster_evidence_receipt_sha256, "registered_route_snap_raster_evidence_receipt");
  if (!["duct", "pipe", "conduit"].includes(candidate.kind)) throw new Error("registered_route_snap_kind_invalid");
  if (!Array.isArray(candidate.points) || candidate.points.length < 2) throw new Error("registered_route_snap_requires_two_points");
  if (!Number.isSafeInteger(candidate.view_id) || candidate.view_id <= 0) throw new Error("registered_route_snap_view_id_invalid");
  if (!clean(candidate.level_name) || !clean(candidate.size) || (candidate.kind !== "conduit" && !clean(candidate.system_type))) throw new Error("registered_route_snap_native_mapping_required");
  if (candidate.kind !== "duct" && candidate.shape !== "round") throw new Error("registered_route_snap_profile_not_supported_for_kind");
  if (!parseRouteProfileSizeV1(candidate.shape, candidate.size)) throw new Error("registered_route_snap_size_does_not_match_profile");
  const elevation = finite(candidate.elevation_z_ft, "registered_route_snap_elevation_z_ft");
  const farEndObligation = sourceBoundFarEnd(candidate, context);
  const policy: RegisteredRouteSnapPolicyV1 = {
    maximum_endpoint_snap_ft: positive(context.policy?.maximum_endpoint_snap_ft ?? DEFAULT_REGISTERED_ROUTE_SNAP_POLICY_V1.maximum_endpoint_snap_ft, "maximum_endpoint_snap_ft"),
    minimum_ambiguity_margin_ft: positive(context.policy?.minimum_ambiguity_margin_ft ?? DEFAULT_REGISTERED_ROUTE_SNAP_POLICY_V1.minimum_ambiguity_margin_ft, "minimum_ambiguity_margin_ft"),
    minimum_direction_dot: unit(context.policy?.minimum_direction_dot ?? DEFAULT_REGISTERED_ROUTE_SNAP_POLICY_V1.minimum_direction_dot, "minimum_direction_dot"),
    maximum_size_delta_ft: positive(context.policy?.maximum_size_delta_ft ?? DEFAULT_REGISTERED_ROUTE_SNAP_POLICY_V1.maximum_size_delta_ft, "maximum_size_delta_ft"),
    maximum_connector_z_delta_ft: positive(context.policy?.maximum_connector_z_delta_ft ?? DEFAULT_REGISTERED_ROUTE_SNAP_POLICY_V1.maximum_connector_z_delta_ft, "maximum_connector_z_delta_ft"),
    final_connection_tolerance_ft: positive(context.policy?.final_connection_tolerance_ft ?? DEFAULT_REGISTERED_ROUTE_SNAP_POLICY_V1.final_connection_tolerance_ft, "final_connection_tolerance_ft")
  };
  if (policy.maximum_endpoint_snap_ft > 1 || policy.final_connection_tolerance_ft > 0.1) throw new Error("registered_route_snap_policy_too_permissive");
  const registeredPoints = candidate.points.map((value, index) => point3(value, elevation, `registered_route_snap_point_${index}`));
  const connectors = normalizeConnectors(context.native_connector_readback);
  const systemToken = serviceToken(candidate.system_type);
  const expectedDomain = candidate.kind === "duct" ? "domainhvac" : candidate.kind === "pipe" ? "domainpiping" : "domainelectrical";
  const blockers: string[] = [];
  const endpointDiagnostics: NonNullable<RegisteredRouteSnapReceiptV1["endpoint_diagnostics"]> = [];
  const selected: RegisteredRouteEndpointSnapV1[] = [];
  const selectedDirections = new Map<"start" | "end", [number, number, number]>();
  const selectedKeys = new Set<string>();

  const requiredEndpoints = candidate.required_existing_endpoint
    ? [candidate.required_existing_endpoint]
    : ["start", "end"] as const;
  for (const endpoint of requiredEndpoints) {
    const registered = endpoint === "start" ? registeredPoints[0]! : registeredPoints[registeredPoints.length - 1]!;
    const expectedDirection = routeDirection(registeredPoints, endpoint);
    const geometricallyCompatible = connectors.flatMap(connector => {
      if (connector.physical_connection_count !== 0) return [];
      if (connector.domain !== expectedDomain) return [];
      if (connector.shape !== normalized(candidate.shape)) return [];
      if (!sizeCompatible(connector, candidate, policy.maximum_size_delta_ft)) return [];
      const distance = Math.hypot(
        connector.origin[0] - registered.x,
        connector.origin[1] - registered.y,
        connector.origin[2] - registered.z
      );
      const dot = directionDot(connector.direction, expectedDirection);
      // Revit can form an elbow where a new duct leaves an open connector at a right angle.
      // Preserve the exact source point and let the native dry run prove the fitting and connection.
      const minimumDot = candidate.kind === "duct" ? -1e-6 : policy.minimum_direction_dot;
      if (distance > policy.maximum_endpoint_snap_ft || Math.abs(connector.origin[2] - registered.z) > policy.maximum_connector_z_delta_ft || dot < minimumDot) return [];
      return [{ connector, distance, dot }];
    });
    const ranked = geometricallyCompatible
      .filter(value => !systemToken || serviceToken(value.connector.system_classification || value.connector.owner_system_name).includes(systemToken))
      .sort((a, b) => a.distance - b.distance || b.dot - a.dot || connectorKey(a.connector).localeCompare(connectorKey(b.connector)));
    if (ranked.length === 0) {
      const conflictingSystems = [...new Set(geometricallyCompatible
        .map(value => value.connector.system_classification || value.connector.owner_system_name)
        .filter(value => value && !serviceToken(value).includes(systemToken)))].sort().slice(0, 5);
      if (systemToken && conflictingSystems.length > 0) {
        blockers.push(`${endpoint}_endpoint_system_type_mismatch`);
        endpointDiagnostics.push({
          endpoint,
          requested_system_type: candidate.system_type,
          nearby_open_connector_systems: conflictingSystems
        });
      } else {
        blockers.push(`${endpoint}_endpoint_has_no_compatible_open_connector`);
      }
      continue;
    }
    if (ranked.length > 1 && ranked[1]!.distance - ranked[0]!.distance < policy.minimum_ambiguity_margin_ft) {
      blockers.push(`${endpoint}_endpoint_connector_match_is_ambiguous`);
      continue;
    }
    const winner = ranked[0]!;
    const key = connectorKey(winner.connector);
    if (selectedKeys.has(key)) {
      blockers.push("route_endpoints_resolve_to_same_connector");
      continue;
    }
    selectedKeys.add(key);
    selectedDirections.set(endpoint, winner.connector.direction);
    selected.push({
      endpoint,
      registered_point: registered,
      snapped_point: { x: winner.connector.origin[0], y: winner.connector.origin[1], z: winner.connector.origin[2] },
      displacement_ft: winner.distance,
      direction_dot: winner.dot,
      owner_element_id: winner.connector.owner_element_id,
      owner_category: winner.connector.owner_category,
      owner_system_name: winner.connector.owner_system_name,
      connector_system_classification: winner.connector.system_classification,
      connector_id: winner.connector.connector_id,
      connector_index: winner.connector.connector_index,
      connector_id_basis: winner.connector.connector_id_basis
    });
  }

  const snappedPoints = registeredPoints.map(value => ({ ...value }));
  for (const snap of selected) {
    snappedPoints[snap.endpoint === "start" ? 0 : snappedPoints.length - 1] = snap.snapped_point;
  }
  // Moving only the endpoint off a registered straight leg creates a tiny
  // skew. Revit may refuse the physical join even when that point coincides
  // with the open connector. Align the adjacent point (including a two-point
  // route's far end) to the observed axis only for a near-collinear source leg.
  if (candidate.kind === "duct" && candidate.required_existing_endpoint) {
    const snap = selected.find(value => value.endpoint === candidate.required_existing_endpoint);
    const axis = selectedDirections.get(candidate.required_existing_endpoint);
    if (snap && axis && snap.direction_dot >= 0.995) {
      const endpointIndex = snap.endpoint === "start" ? 0 : snappedPoints.length - 1;
      const neighborIndex = snap.endpoint === "start" ? 1 : snappedPoints.length - 2;
      const endpointPoint = snappedPoints[endpointIndex]!;
      const neighbor = snappedPoints[neighborIndex]!;
      const axisLength = Math.hypot(...axis);
      if (axisLength > 1e-9) {
        const unitAxis = axis.map(value => value / axisLength) as [number, number, number];
        const along = (neighbor.x - endpointPoint.x) * unitAxis[0]
          + (neighbor.y - endpointPoint.y) * unitAxis[1]
          + (neighbor.z - endpointPoint.z) * unitAxis[2];
        const aligned = {
          x: endpointPoint.x + along * unitAxis[0],
          y: endpointPoint.y + along * unitAxis[1],
          z: endpointPoint.z + along * unitAxis[2]
        };
        const displacement = Math.hypot(aligned.x - neighbor.x, aligned.y - neighbor.y, aligned.z - neighbor.z);
        // The far end of a two-point source primitive has no downstream
        // fitting that can absorb a larger translation. Keep it inside a
        // deliberately smaller drawing tolerance or defer for review.
        const maximumAlignment = snappedPoints.length === 2
          ? Math.min(policy.maximum_endpoint_snap_ft, 0.15)
          : policy.maximum_endpoint_snap_ft;
        if (along > 0.1 && displacement <= maximumAlignment) {
          snappedPoints[neighborIndex] = aligned;
        } else if (snappedPoints.length === 2 && displacement > maximumAlignment) {
          blockers.push(`${snap.endpoint}_endpoint_tangent_alignment_exceeds_source_tolerance`);
        }
      }
    }
  }
  const ready = blockers.length === 0 && selected.length === requiredEndpoints.length;
  const baseBody: Record<string, unknown> = {
    kind: candidate.kind,
    points: snappedPoints,
    viewId: candidate.view_id,
    levelName: candidate.level_name,
    systemType: candidate.system_type,
    sizePolicy: "explicit_required",
    elevationPolicy: "explicit_required",
    routingMode: "polyline",
    connectSegments: true,
    connectToExisting: true,
    requireExistingEndpointConnections: !candidate.required_existing_endpoint,
    ...(candidate.required_existing_endpoint ? {
      requiredExistingEndpoint: candidate.required_existing_endpoint,
      [candidate.required_existing_endpoint === "start" ? "expectedExistingStartOwnerId" : "expectedExistingEndOwnerId"]: selected[0]?.owner_element_id
    } : {}),
    externalConnectionToleranceFt: policy.final_connection_tolerance_ft,
    verify: true,
    ...(candidate.kind === "duct" ? {
      ductShape: candidate.shape,
      ductSize: candidate.size,
      ...(candidate.shape === "round" ? { diameter: candidate.size } : {})
    } : {}),
    ...(candidate.kind === "pipe" ? { pipeSize: candidate.size, diameter: candidate.size } : {}),
    ...(candidate.kind === "conduit" ? { diameter: candidate.size } : {}),
    ...(candidate.route_type_name ? { [candidate.kind === "duct" ? "ductType" : candidate.kind === "pipe" ? "pipeType" : "conduitType"]: candidate.route_type_name } : {}),
    ...(candidate.route_type_id && candidate.kind === "duct" ? { ductTypeId: candidate.route_type_id } : {}),
    ...(candidate.route_type_id && candidate.kind === "pipe" ? { pipeTypeId: candidate.route_type_id } : {}),
    ...(candidate.route_type_id && candidate.kind === "conduit" ? { conduitTypeId: candidate.route_type_id } : {})
  };
  const exactService = exactPipeBridgeService(candidate.system_type);
  const bridgeLengthFt = selected.length === 2
    ? Math.hypot(
      selected[1]!.snapped_point.x - selected[0]!.snapped_point.x,
      selected[1]!.snapped_point.y - selected[0]!.snapped_point.y,
      selected[1]!.snapped_point.z - selected[0]!.snapped_point.z
    )
    : 0;
  const exactPipeBridge = ready
    && candidate.kind === "pipe"
    && candidate.shape === "round"
    && candidate.points.length === 2
    && clean(candidate.route_type_name).length > 0
    && exactService !== null
    && selected.length === 2
    && selected[0]!.owner_element_id !== selected[1]!.owner_element_id
    && bridgeLengthFt + policy.final_connection_tolerance_ft <= 100;
  const actionMode: RegisteredRouteSnapReceiptV1["action_mode"] = exactPipeBridge
    ? "pipe_between_existing_connectors"
    : "create_mep_route";
  const action = (dryRun: boolean): NonNullable<RegisteredRouteSnapReceiptV1["dry_run_action"]> => exactPipeBridge
    ? {
      method: "POST",
      path: "/revit/create-pipe-between-connectors",
      body: {
        sourceElementId: selected[0]!.owner_element_id,
        targetElementId: selected[1]!.owner_element_id,
        service: exactService,
        systemType: candidate.system_type,
        pipeType: candidate.route_type_name,
        pipeSize: candidate.size,
        levelName: candidate.level_name,
        maximumLengthFt: bridgeLengthFt + policy.final_connection_tolerance_ft,
        sizeToleranceFt: Math.min(policy.maximum_size_delta_ft, 1 / 192),
        verify: true,
        dryRun
      }
    }
    : { method: "POST", path: "/revit/create-mep-route", body: { ...baseBody, dryRun } };
  return {
    schema_version: 1,
    artifact_role: "registered_route_connector_snap",
    package_id: packageId,
    primitive_id: primitiveId,
    input_fingerprint_sha256: digest(candidate),
    native_connector_readback_sha256: digest(context.native_connector_readback),
    status: ready ? "ready" : "deferred",
    blockers,
    ...(endpointDiagnostics.length > 0 ? { endpoint_diagnostics: endpointDiagnostics } : {}),
    endpoint_snaps: selected,
    ...(farEndObligation ? { far_end_obligation: farEndObligation } : {}),
    snapped_points: snappedPoints,
    action_mode: actionMode,
    dry_run_action: ready ? action(true) : null,
    apply_action: ready ? action(false) : null,
    acceptance_requirements: [
      "dry_run_status_created_and_connected_or_dry_run",
      candidate.required_existing_endpoint ? "dry_run_opposite_route_end_remains_open" : "dry_run_open_connector_count_zero",
      "apply_created_element_ids_nonempty",
      "native_size_shape_system_and_geometry_readback_match",
      candidate.required_existing_endpoint ? "declared_endpoint_connects_to_exact_existing_owner" : "each_created_endpoint_has_one_physical_external_connection",
      "focused_visual_overlay_matches_registered_source"
    ]
  };
}

export function buildRegisteredRouteSnapStagedWorkflowV1(
  candidate: RegisteredRouteSnapCandidateV1,
  receipt: RegisteredRouteSnapReceiptV1
): AtomicMepDraftWorkflowRequest {
  if (receipt.status !== "ready" || receipt.blockers.length > 0) {
    throw new Error(`registered_route_snap_not_ready:${receipt.blockers.join(",") || receipt.status}`);
  }
  if (
    receipt.package_id !== clean(candidate.package_id) ||
    receipt.primitive_id !== clean(candidate.primitive_id) ||
    receipt.input_fingerprint_sha256 !== digest(candidate)
  ) {
    throw new Error("registered_route_snap_candidate_receipt_mismatch");
  }
  const dryRunAction = receipt.dry_run_action;
  const applyAction = receipt.apply_action;
  if (
    !dryRunAction || !applyAction ||
    dryRunAction.method !== "POST" || applyAction.method !== "POST" ||
    dryRunAction.path !== applyAction.path ||
    !["/revit/create-mep-route", "/revit/create-pipe-between-connectors"].includes(dryRunAction.path) ||
    dryRunAction.body.dryRun !== true || applyAction.body.dryRun !== false
  ) {
    throw new Error("registered_route_snap_staged_actions_invalid");
  }
  const dryRunBody = { ...dryRunAction.body };
  const applyBody = { ...applyAction.body };
  delete dryRunBody.dryRun;
  delete applyBody.dryRun;
  if (canonical(dryRunBody) !== canonical(applyBody)) {
    throw new Error("registered_route_snap_staged_actions_diverge");
  }
  const pointCount = candidate.points.length;
  const expectedCreatedMaximum = receipt.action_mode === "pipe_between_existing_connectors"
    ? 1
    : Math.max(1, (pointCount - 1) + Math.max(0, pointCount - 2));
  const actionKey = `registered-route:${clean(candidate.primitive_id).replace(/[^a-zA-Z0-9._:-]+/g, "-")}`;
  const far = receipt.far_end_obligation;
  const farPoint = far
    ? receipt.snapped_points[candidate.required_existing_endpoint === "start" ? pointCount - 1 : 0]
    : undefined;
  const continuationEndpoints = far && farPoint ? [{
    endpoint_key: `${actionKey}:${far.source_endpoint_key}`,
    output: candidate.required_existing_endpoint === "start" ? "route_end" as const : "route_start" as const,
    model_point: farPoint,
    direction_xyz: [far.outward_direction_xy[0], far.outward_direction_xy[1], 0] as [number, number, number],
    source_observation_ids: [candidate.primitive_id],
    system_classification: candidate.system_type,
    size: candidate.size,
    state: "unresolved_continuation" as const
  }] : undefined;
  return {
    inputFingerprintSha256: receipt.input_fingerprint_sha256,
    provisionalObservationIds: [clean(candidate.primitive_id)],
    operations: [{
      action_key: actionKey,
      observation_ids: [clean(candidate.primitive_id)],
      path: applyAction.path,
      depends_on: [],
      apply_body: JSON.parse(JSON.stringify(applyBody)) as NonNullable<
        AtomicMepDraftWorkflowRequest["operations"][number]["apply_body"]
      >,
      expected_created_min: 1,
      expected_created_max: expectedCreatedMaximum,
      execution_mode: "single_action",
      ...(continuationEndpoints ? { continuation_endpoints: continuationEndpoints } : {})
    }],
    dryRun: true,
    verify: true,
    maximumCreatedElements: expectedCreatedMaximum,
    targetViewId: candidate.view_id,
    applyTargetViewPhase: true,
    requireAllCreatedElementsVisibleInTargetView: true,
    benchmarkCredit: false,
    authorizationBasis: "explicit_unscored_user_direction"
  };
}
