import crypto from "node:crypto";
import type { SheetTopologyPoint } from "./sheet_topology_compiler.js";

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
  shape: "round" | "rectangular" | "oval";
  size: string;
};

export type RegisteredRouteSnapContextV1 = {
  native_connector_readback: unknown;
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
  endpoint_snaps: RegisteredRouteEndpointSnapV1[];
  snapped_points: Array<{ x: number; y: number; z: number }>;
  dry_run_action: null | { method: "POST"; path: "/revit/create-mep-route"; body: Record<string, unknown> };
  apply_action: null | { method: "POST"; path: "/revit/create-mep-route"; body: Record<string, unknown> };
  acceptance_requirements: string[];
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function parseInches(value: string): number | null {
  const match = clean(value).match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:\"|in|inch|inches)?$/i);
  return match ? Number(match[1]) / 12 : null;
}

function sizeCompatible(connector: NativeConnector, candidate: RegisteredRouteSnapCandidateV1, tolerance: number): boolean {
  const expected = parseInches(candidate.size);
  return expected !== null && connector.diameter_ft !== null && Math.abs(connector.diameter_ft - expected) <= tolerance;
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
  if (candidate.shape !== "round") throw new Error("registered_route_snap_v1_only_supports_round_profiles");
  if (candidate.kind === "pipe" && candidate.route_type_id !== undefined) throw new Error("registered_route_snap_pipe_route_type_id_unsupported");
  const elevation = finite(candidate.elevation_z_ft, "registered_route_snap_elevation_z_ft");
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
  const systemToken = normalized(candidate.system_type);
  const expectedDomain = candidate.kind === "duct" ? "domainhvac" : candidate.kind === "pipe" ? "domainpiping" : "domainelectrical";
  const blockers: string[] = [];
  const selected: RegisteredRouteEndpointSnapV1[] = [];
  const selectedKeys = new Set<string>();

  for (const endpoint of ["start", "end"] as const) {
    const registered = endpoint === "start" ? registeredPoints[0]! : registeredPoints[registeredPoints.length - 1]!;
    const expectedDirection = routeDirection(registeredPoints, endpoint);
    const ranked = connectors.flatMap(connector => {
      if (connector.physical_connection_count !== 0) return [];
      if (connector.domain !== expectedDomain) return [];
      if (connector.shape !== normalized(candidate.shape)) return [];
      if (!sizeCompatible(connector, candidate, policy.maximum_size_delta_ft)) return [];
      if (systemToken && !normalized(connector.owner_system_name).includes(systemToken)) return [];
      const distance = Math.hypot(
        connector.origin[0] - registered.x,
        connector.origin[1] - registered.y,
        connector.origin[2] - registered.z
      );
      const dot = directionDot(connector.direction, expectedDirection);
      if (distance > policy.maximum_endpoint_snap_ft || Math.abs(connector.origin[2] - registered.z) > policy.maximum_connector_z_delta_ft || dot < policy.minimum_direction_dot) return [];
      return [{ connector, distance, dot }];
    }).sort((a, b) => a.distance - b.distance || b.dot - a.dot || connectorKey(a.connector).localeCompare(connectorKey(b.connector)));
    if (ranked.length === 0) {
      blockers.push(`${endpoint}_endpoint_has_no_compatible_open_connector`);
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
    selected.push({
      endpoint,
      registered_point: registered,
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

  const snappedPoints = registeredPoints.map(value => ({ ...value }));
  for (const snap of selected) {
    snappedPoints[snap.endpoint === "start" ? 0 : snappedPoints.length - 1] = snap.snapped_point;
  }
  const ready = blockers.length === 0 && selected.length === 2;
  const baseBody: Record<string, unknown> = {
    kind: candidate.kind,
    points: snappedPoints,
    viewId: candidate.view_id,
    levelName: candidate.level_name,
    systemType: candidate.system_type,
    ductShape: candidate.shape,
    sizePolicy: "explicit_required",
    elevationPolicy: "explicit_required",
    routingMode: "polyline",
    connectSegments: true,
    connectToExisting: true,
    requireExistingEndpointConnections: true,
    externalConnectionToleranceFt: policy.final_connection_tolerance_ft,
    verify: true,
    ...(candidate.kind === "duct" ? { ductSize: candidate.size, diameter: candidate.size } : {}),
    ...(candidate.kind === "pipe" ? { pipeSize: candidate.size, diameter: candidate.size } : {}),
    ...(candidate.kind === "conduit" ? { diameter: candidate.size } : {}),
    ...(candidate.route_type_name ? { [candidate.kind === "duct" ? "ductType" : candidate.kind === "pipe" ? "pipeType" : "conduitType"]: candidate.route_type_name } : {}),
    ...(candidate.route_type_id && candidate.kind === "duct" ? { ductTypeId: candidate.route_type_id } : {}),
    ...(candidate.route_type_id && candidate.kind === "conduit" ? { conduitTypeId: candidate.route_type_id } : {})
  };
  const action = (dryRun: boolean) => ({ method: "POST" as const, path: "/revit/create-mep-route" as const, body: { ...baseBody, dryRun } });
  return {
    schema_version: 1,
    artifact_role: "registered_route_connector_snap",
    package_id: packageId,
    primitive_id: primitiveId,
    input_fingerprint_sha256: digest(candidate),
    native_connector_readback_sha256: digest(context.native_connector_readback),
    status: ready ? "ready" : "deferred",
    blockers,
    endpoint_snaps: selected,
    snapped_points: snappedPoints,
    dry_run_action: ready ? action(true) : null,
    apply_action: ready ? action(false) : null,
    acceptance_requirements: [
      "dry_run_status_created_and_connected_or_dry_run",
      "dry_run_open_connector_count_zero",
      "apply_created_element_ids_nonempty",
      "native_size_shape_system_and_geometry_readback_match",
      "each_created_endpoint_has_one_physical_external_connection",
      "focused_visual_overlay_matches_registered_source"
    ]
  };
}
