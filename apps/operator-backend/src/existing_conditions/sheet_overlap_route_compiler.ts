import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadImage } from "@napi-rs/canvas";
import type { MepCoverageBounds } from "./mep_region_coverage.js";
import type {
  SheetPixelInterpretationInputV1,
  SheetPixelPointV1,
  SheetPixelPrimitiveV1
} from "./sheet_pixel_interpretation.js";
import type { SheetTopologyClaimV1 } from "./sheet_topology_compiler.js";
import type { SheetRouteChromaticCoverageReceiptV1 } from "./sheet_route_chromatic_coverage.js";

export type SheetOverlapRouteTileV1 = {
  view_key: string;
  source_image_path: string;
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  parent_pixel_bounds: MepCoverageBounds;
  interpretation: SheetPixelInterpretationInputV1;
  route_coverage_receipt: SheetRouteChromaticCoverageReceiptV1;
};

export type SheetOverlapRouteCompilationInputV1 = {
  schema_version: 1;
  package_id: string;
  parent_view_key: string;
  parent_image_path: string;
  parent_image_sha256: string;
  parent_image_width_px: number;
  parent_image_height_px: number;
  tiles: SheetOverlapRouteTileV1[];
  policy?: Partial<SheetOverlapRouteCompilationPolicyV1>;
};

export type SheetOverlapRouteCompilationPolicyV1 = {
  orthogonal_angle_tolerance_degrees: number;
  collinear_snap_tolerance_px: number;
  interval_gap_tolerance_px: number;
  junction_endpoint_tolerance_px: number;
  minimum_canonical_segment_length_px: number;
};

export type SheetOverlapRouteSourceMemberV1 = {
  view_key: string;
  primitive_id: string;
};

export type SheetOverlapCanonicalRouteV1 = {
  canonical_route_id: string;
  orientation: "horizontal" | "vertical";
  parent_pixel_points: [{ x: number; y: number }, { x: number; y: number }];
  parent_uv_points: [SheetPixelPointV1, SheetPixelPointV1];
  length_px: number;
  source_members: SheetOverlapRouteSourceMemberV1[];
  claims?: SheetPixelPrimitiveV1["claims"];
  confidence: SheetPixelPrimitiveV1["confidence"];
};

export type SheetOverlapRouteJunctionV1 = {
  junction_id: string;
  parent_pixel_point: { x: number; y: number };
  parent_uv_point: SheetPixelPointV1;
  kind: "elbow_or_offset" | "tee_or_branch" | "crossing_requires_review";
  canonical_route_ids: string[];
  source_member_endpoint_count: number;
};

export type SheetOverlapRouteCompilationReceiptV1 = {
  schema: "operator.sheet_overlap_route_compilation.v1";
  package_id: string;
  parent_image_sha256: string;
  parent_image_width_px: number;
  parent_image_height_px: number;
  input_fingerprint_sha256: string;
  policy: SheetOverlapRouteCompilationPolicyV1;
  tile_count: number;
  source_route_member_count: number;
  source_route_accounting_closure: number;
  overlapping_source_member_count: number;
  canonical_route_count: number;
  canonical_routes: SheetOverlapCanonicalRouteV1[];
  junctions: SheetOverlapRouteJunctionV1[];
  conflicts: string[];
  warnings: string[];
  status: "source_graph_compiled" | "blocked";
  parent_interpretation: SheetPixelInterpretationInputV1;
  exact_next_repair: "validate_parent_route_raster_coverage" | "resolve_overlap_route_conflicts";
  native_write_allowed: false;
  capability_boundary: string;
};

type AxisRoute = {
  member: SheetOverlapRouteSourceMemberV1;
  orientation: "horizontal" | "vertical";
  fixed: number;
  start: number;
  end: number;
  endpoints: [{ x: number; y: number }, { x: number; y: number }];
  primitive: SheetPixelPrimitiveV1;
};

type AxisCluster = {
  cluster_id: string;
  orientation: "horizontal" | "vertical";
  fixed: number;
  routes: AxisRoute[];
  junction_breaks: number[];
};

type CanonicalDraft = {
  cluster: AxisCluster;
  start: number;
  end: number;
  members: AxisRoute[];
};

const DEFAULT_POLICY: SheetOverlapRouteCompilationPolicyV1 = {
  orthogonal_angle_tolerance_degrees: 5,
  collinear_snap_tolerance_px: 5,
  interval_gap_tolerance_px: 6,
  junction_endpoint_tolerance_px: 8,
  minimum_canonical_segment_length_px: 2
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

function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function requiredSha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function finite(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label}_must_be_finite`);
  return result;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label}_must_be_integer_${minimum}_through_${maximum}`);
  }
  return result;
}

function bounded(value: unknown, fallback: number, label: string, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${label}_out_of_range`);
  return result;
}

function normalizeClaimValue(value: unknown): string {
  return clean(value).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function claimBasisRank(value: SheetTopologyClaimV1["basis"]): number {
  return value === "legible_source_evidence" ? 3 : value === "approved_project_mapping" ? 2 : value === "provider_hypothesis" ? 1 : 0;
}

function weakestBasis(values: SheetTopologyClaimV1[]): SheetTopologyClaimV1["basis"] {
  return [...values].sort((left, right) => claimBasisRank(left.basis) - claimBasisRank(right.basis))[0]!.basis;
}

function pixelBounds(value: MepCoverageBounds, label: string, width: number, height: number): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const minX = integer(value.min?.x, `${label}_min_x`, 0, width - 1);
  const minY = integer(value.min?.y, `${label}_min_y`, 0, height - 1);
  const maxX = integer(value.max?.x, `${label}_max_x`, 1, width);
  const maxY = integer(value.max?.y, `${label}_max_y`, 1, height);
  if (maxX <= minX || maxY <= minY) throw new Error(`${label}_must_have_positive_extent`);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function pointDistance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function sourcePointToParent(point: SheetPixelPointV1, bounds: { minX: number; minY: number; width: number; height: number }): { x: number; y: number } {
  const u = finite(point?.u, "sheet_overlap_route_point_u");
  const v = finite(point?.v, "sheet_overlap_route_point_v");
  if (u < 0 || u > 1 || v < 0 || v > 1) throw new Error("sheet_overlap_route_point_must_be_normalized_uv");
  return { x: bounds.minX + (u * bounds.width), y: bounds.minY + (v * bounds.height) };
}

function interpretationDigest(value: SheetPixelInterpretationInputV1): string {
  return digest(value);
}

async function validateImage(args: { path: string; sha256: string; width: number; height: number; label: string }): Promise<void> {
  const resolved = path.resolve(clean(args.path));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${args.label}_image_not_found`);
  const buffer = fs.readFileSync(resolved);
  if (sha256Buffer(buffer) !== args.sha256) throw new Error(`${args.label}_image_hash_mismatch`);
  const image = await loadImage(buffer);
  if (image.width !== args.width || image.height !== args.height) throw new Error(`${args.label}_image_dimensions_mismatch`);
}

function axisRoute(args: {
  tile: SheetOverlapRouteTileV1;
  bounds: { minX: number; minY: number; width: number; height: number };
  primitive: SheetPixelPrimitiveV1;
  angleToleranceDegrees: number;
}): AxisRoute {
  if (args.primitive.points.length < 2) throw new Error(`sheet_overlap_route_requires_two_points:${args.primitive.primitive_id}`);
  const points = args.primitive.points.map(point => sourcePointToParent(point, args.bounds));
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
  const horizontalDeviation = Math.min(angle, Math.abs(180 - angle));
  const verticalDeviation = Math.abs(90 - angle);
  const orientation = horizontalDeviation <= args.angleToleranceDegrees
    ? "horizontal" as const
    : verticalDeviation <= args.angleToleranceDegrees
      ? "vertical" as const
      : null;
  if (!orientation) throw new Error(`sheet_overlap_route_not_orthogonal:${args.tile.view_key}:${args.primitive.primitive_id}:${angle.toFixed(3)}`);
  const fixedValues = points.map(point => orientation === "horizontal" ? point.y : point.x);
  const axisValues = points.map(point => orientation === "horizontal" ? point.x : point.y);
  const fixed = fixedValues.reduce((sum, value) => sum + value, 0) / fixedValues.length;
  const start = Math.min(...axisValues);
  const end = Math.max(...axisValues);
  const endpointA = orientation === "horizontal" ? { x: start, y: fixed } : { x: fixed, y: start };
  const endpointB = orientation === "horizontal" ? { x: end, y: fixed } : { x: fixed, y: end };
  return {
    member: { view_key: args.tile.view_key, primitive_id: args.primitive.primitive_id },
    orientation,
    fixed,
    start,
    end,
    endpoints: [endpointA, endpointB],
    primitive: args.primitive
  };
}

function clusterRoutes(routes: AxisRoute[], tolerance: number): AxisCluster[] {
  const clusters: AxisCluster[] = [];
  for (const orientation of ["horizontal", "vertical"] as const) {
    const sorted = routes.filter(route => route.orientation === orientation).sort((left, right) => left.fixed - right.fixed || left.start - right.start);
    for (const route of sorted) {
      const candidate = clusters
        .filter(cluster => cluster.orientation === orientation && Math.abs(cluster.fixed - route.fixed) <= tolerance)
        .sort((left, right) => Math.abs(left.fixed - route.fixed) - Math.abs(right.fixed - route.fixed))[0];
      if (candidate) {
        candidate.routes.push(route);
        candidate.fixed = candidate.routes.reduce((sum, value) => sum + value.fixed, 0) / candidate.routes.length;
      } else {
        clusters.push({ cluster_id: "", orientation, fixed: route.fixed, routes: [route], junction_breaks: [] });
      }
    }
  }
  for (const cluster of clusters) {
    const members = cluster.routes.map(route => route.member).sort((left, right) =>
      `${left.view_key}:${left.primitive_id}`.localeCompare(`${right.view_key}:${right.primitive_id}`)
    );
    cluster.cluster_id = `axis:${cluster.orientation}:${digest(members).slice(0, 16)}`;
  }
  return clusters;
}

function intervalContains(route: AxisRoute, value: number, tolerance = 0): boolean {
  return value >= route.start - tolerance && value <= route.end + tolerance;
}

function clusterContains(cluster: AxisCluster, value: number, tolerance: number): boolean {
  return cluster.routes.some(route => intervalContains(route, value, tolerance));
}

function nearestEndpointDistance(cluster: AxisCluster, point: { x: number; y: number }): number {
  return Math.min(...cluster.routes.flatMap(route => route.endpoints.map(endpoint => pointDistance(endpoint, point))));
}

function addJunctionBreak(cluster: AxisCluster, value: number, tolerance: number): void {
  if (!cluster.junction_breaks.some(existing => Math.abs(existing - value) <= tolerance)) cluster.junction_breaks.push(value);
}

function detectJunctionPoints(clusters: AxisCluster[], policy: SheetOverlapRouteCompilationPolicyV1): Array<{
  point: { x: number; y: number };
  horizontal: AxisCluster;
  vertical: AxisCluster;
  sourceEndpointCount: number;
  kind: SheetOverlapRouteJunctionV1["kind"];
}> {
  const result: Array<{
    point: { x: number; y: number };
    horizontal: AxisCluster;
    vertical: AxisCluster;
    sourceEndpointCount: number;
    kind: SheetOverlapRouteJunctionV1["kind"];
  }> = [];
  const horizontal = clusters.filter(cluster => cluster.orientation === "horizontal");
  const vertical = clusters.filter(cluster => cluster.orientation === "vertical");
  for (const h of horizontal) {
    for (const v of vertical) {
      const point = { x: v.fixed, y: h.fixed };
      if (!clusterContains(h, point.x, policy.interval_gap_tolerance_px) || !clusterContains(v, point.y, policy.interval_gap_tolerance_px)) continue;
      const hDistance = nearestEndpointDistance(h, point);
      const vDistance = nearestEndpointDistance(v, point);
      const hAtEndpoint = hDistance <= policy.junction_endpoint_tolerance_px;
      const vAtEndpoint = vDistance <= policy.junction_endpoint_tolerance_px;
      if (!hAtEndpoint && !vAtEndpoint) continue;
      addJunctionBreak(h, point.x, policy.collinear_snap_tolerance_px);
      addJunctionBreak(v, point.y, policy.collinear_snap_tolerance_px);
      result.push({
        point,
        horizontal: h,
        vertical: v,
        sourceEndpointCount: Number(hAtEndpoint) + Number(vAtEndpoint),
        kind: hAtEndpoint && vAtEndpoint ? "elbow_or_offset" : "tee_or_branch"
      });
    }
  }
  return result;
}

function snappedBreaks(cluster: AxisCluster, policy: SheetOverlapRouteCompilationPolicyV1): number[] {
  const raw = [...cluster.routes.flatMap(route => [route.start, route.end]), ...cluster.junction_breaks].sort((left, right) => left - right);
  const groups: number[][] = [];
  for (const value of raw) {
    const group = groups[groups.length - 1];
    if (group && Math.abs((group.reduce((sum, entry) => sum + entry, 0) / group.length) - value) <= policy.collinear_snap_tolerance_px) group.push(value);
    else groups.push([value]);
  }
  return groups.map(group => group.reduce((sum, value) => sum + value, 0) / group.length);
}

function canonicalDrafts(clusters: AxisCluster[], policy: SheetOverlapRouteCompilationPolicyV1): CanonicalDraft[] {
  const result: CanonicalDraft[] = [];
  for (const cluster of clusters) {
    const breaks = snappedBreaks(cluster, policy);
    for (let index = 0; index < breaks.length - 1; index += 1) {
      const start = breaks[index]!;
      const end = breaks[index + 1]!;
      if (end - start < policy.minimum_canonical_segment_length_px) continue;
      const midpoint = (start + end) / 2;
      const members = cluster.routes.filter(route => intervalContains(route, midpoint, policy.interval_gap_tolerance_px));
      if (members.length === 0) continue;
      result.push({ cluster, start, end, members });
    }
  }
  return result;
}

function aggregateClaims(members: AxisRoute[], conflicts: string[], canonicalRouteId: string): SheetPixelPrimitiveV1["claims"] | undefined {
  const result: NonNullable<SheetPixelPrimitiveV1["claims"]> = {};
  for (const attribute of ["system", "size", "type", "family", "host", "elevation", "vertical_extent"] as const) {
    const claims = members.map(member => member.primitive.claims?.[attribute]).filter((claim): claim is SheetTopologyClaimV1 => Boolean(claim));
    if (claims.length === 0) continue;
    const values = new Set(claims.map(claim => normalizeClaimValue(claim.value)));
    if (values.size > 1) {
      conflicts.push(`overlap_claim_conflict:${canonicalRouteId}:${attribute}:${[...values].sort().join("|")}`);
      continue;
    }
    if (claims.length !== members.length) continue;
    const normalizedValue = [...values][0]!;
    result[attribute] = {
      value: normalizedValue,
      confidence: Math.min(...claims.map(claim => claim.confidence)),
      basis: weakestBasis(claims)
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function canonicalConfidence(members: AxisRoute[]): SheetPixelPrimitiveV1["confidence"] {
  return {
    geometry: Math.min(...members.map(member => member.primitive.confidence.geometry)),
    classification: Math.min(...members.map(member => member.primitive.confidence.classification)),
    topology: Math.min(...members.map(member => member.primitive.confidence.topology)),
    visibility: Math.min(...members.map(member => member.primitive.confidence.visibility))
  };
}

function routePoints(draft: CanonicalDraft): [{ x: number; y: number }, { x: number; y: number }] {
  return draft.cluster.orientation === "horizontal"
    ? [{ x: draft.start, y: draft.cluster.fixed }, { x: draft.end, y: draft.cluster.fixed }]
    : [{ x: draft.cluster.fixed, y: draft.start }, { x: draft.cluster.fixed, y: draft.end }];
}

function toUv(point: { x: number; y: number }, width: number, height: number): SheetPixelPointV1 {
  return { u: Math.max(0, Math.min(1, point.x / width)), v: Math.max(0, Math.min(1, point.y / height)) };
}

function atParentBoundary(point: { x: number; y: number }, width: number, height: number, tolerance: number): boolean {
  return point.x <= tolerance || point.y <= tolerance || point.x >= width - tolerance || point.y >= height - tolerance;
}

export async function compileSheetOverlapRoutesV1(
  input: SheetOverlapRouteCompilationInputV1
): Promise<SheetOverlapRouteCompilationReceiptV1> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) {
    throw new Error("sheet_overlap_route_compilation_requires_schema_v1");
  }
  const parentHash = requiredSha256(input.parent_image_sha256, "sheet_overlap_route_parent_image_sha256");
  const parentWidth = integer(input.parent_image_width_px, "sheet_overlap_route_parent_image_width_px", 1, 20000);
  const parentHeight = integer(input.parent_image_height_px, "sheet_overlap_route_parent_image_height_px", 1, 20000);
  await validateImage({ path: input.parent_image_path, sha256: parentHash, width: parentWidth, height: parentHeight, label: "sheet_overlap_route_parent" });
  const parentViewKey = clean(input.parent_view_key);
  if (!parentViewKey) throw new Error("sheet_overlap_route_parent_view_key_required");
  if (!Array.isArray(input.tiles) || input.tiles.length < 2 || input.tiles.length > 24) throw new Error("sheet_overlap_route_tiles_must_have_two_to_twenty_four_items");
  const policy: SheetOverlapRouteCompilationPolicyV1 = {
    orthogonal_angle_tolerance_degrees: bounded(input.policy?.orthogonal_angle_tolerance_degrees, DEFAULT_POLICY.orthogonal_angle_tolerance_degrees, "sheet_overlap_route_orthogonal_angle_tolerance_degrees", 0, 20),
    collinear_snap_tolerance_px: bounded(input.policy?.collinear_snap_tolerance_px, DEFAULT_POLICY.collinear_snap_tolerance_px, "sheet_overlap_route_collinear_snap_tolerance_px", 0.1, 100),
    interval_gap_tolerance_px: bounded(input.policy?.interval_gap_tolerance_px, DEFAULT_POLICY.interval_gap_tolerance_px, "sheet_overlap_route_interval_gap_tolerance_px", 0, 100),
    junction_endpoint_tolerance_px: bounded(input.policy?.junction_endpoint_tolerance_px, DEFAULT_POLICY.junction_endpoint_tolerance_px, "sheet_overlap_route_junction_endpoint_tolerance_px", 0.1, 100),
    minimum_canonical_segment_length_px: bounded(input.policy?.minimum_canonical_segment_length_px, DEFAULT_POLICY.minimum_canonical_segment_length_px, "sheet_overlap_route_minimum_canonical_segment_length_px", 0.1, 1000)
  };
  const viewKeys = new Set<string>();
  const routes: AxisRoute[] = [];
  for (const [tileIndex, tile] of input.tiles.entries()) {
    const viewKey = clean(tile.view_key);
    if (!viewKey || viewKeys.has(viewKey)) throw new Error(`sheet_overlap_route_tile_view_key_invalid:${viewKey}`);
    viewKeys.add(viewKey);
    const sourceHash = requiredSha256(tile.source_image_sha256, `sheet_overlap_route_tile_${tileIndex}_source_sha256`);
    const width = integer(tile.source_image_width_px, `sheet_overlap_route_tile_${tileIndex}_width`, 1, 20000);
    const height = integer(tile.source_image_height_px, `sheet_overlap_route_tile_${tileIndex}_height`, 1, 20000);
    await validateImage({ path: tile.source_image_path, sha256: sourceHash, width, height, label: `sheet_overlap_route_tile_${tileIndex}` });
    const bounds = pixelBounds(tile.parent_pixel_bounds, `sheet_overlap_route_tile_${tileIndex}_parent_bounds`, parentWidth, parentHeight);
    const sourceAspect = width / height;
    const parentAspect = bounds.width / bounds.height;
    if (Math.abs(sourceAspect - parentAspect) / parentAspect > 0.01) throw new Error(`sheet_overlap_route_tile_${tileIndex}_aspect_mismatch`);
    if (tile.interpretation.coordinate_space !== "normalized_uv_top_left" || !tile.interpretation.view_keys.includes(viewKey)) {
      throw new Error(`sheet_overlap_route_tile_${tileIndex}_interpretation_view_mismatch`);
    }
    const coverage = tile.route_coverage_receipt;
    if (coverage.schema !== "operator.sheet_route_chromatic_coverage.v1"
      || coverage.accepted !== true
      || coverage.native_write_allowed !== false
      || coverage.source_view_key !== viewKey
      || coverage.source_image_sha256 !== sourceHash
      || coverage.interpretation_sha256 !== interpretationDigest(tile.interpretation)) {
      throw new Error(`sheet_overlap_route_tile_${tileIndex}_coverage_receipt_mismatch_or_not_accepted`);
    }
    for (const primitive of tile.interpretation.primitives.filter(value => value.kind === "route_segment" && value.source_view_key === viewKey)) {
      routes.push(axisRoute({ tile, bounds, primitive, angleToleranceDegrees: policy.orthogonal_angle_tolerance_degrees }));
    }
  }
  if (routes.length === 0) throw new Error("sheet_overlap_route_no_route_primitives");
  const clusters = clusterRoutes(routes, policy.collinear_snap_tolerance_px);
  const rawJunctions = detectJunctionPoints(clusters, policy);
  const drafts = canonicalDrafts(clusters, policy);
  const conflicts: string[] = [];
  const canonicalRoutes: SheetOverlapCanonicalRouteV1[] = drafts.map((draft, index) => {
    const points = routePoints(draft);
    const sourceMembers = draft.members.map(member => member.member).sort((left, right) => `${left.view_key}:${left.primitive_id}`.localeCompare(`${right.view_key}:${right.primitive_id}`));
    const canonicalRouteId = `overlap-route:${digest({ orientation: draft.cluster.orientation, points, sourceMembers }).slice(0, 20)}`;
    return {
      canonical_route_id: canonicalRouteId,
      orientation: draft.cluster.orientation,
      parent_pixel_points: points,
      parent_uv_points: [toUv(points[0], parentWidth, parentHeight), toUv(points[1], parentWidth, parentHeight)],
      length_px: draft.end - draft.start,
      source_members: sourceMembers,
      ...(aggregateClaims(draft.members, conflicts, canonicalRouteId) ? { claims: aggregateClaims(draft.members, [], canonicalRouteId) } : {}),
      confidence: canonicalConfidence(draft.members)
    };
  });
  canonicalRoutes.sort((left, right) => left.parent_pixel_points[0].y - right.parent_pixel_points[0].y || left.parent_pixel_points[0].x - right.parent_pixel_points[0].x || left.canonical_route_id.localeCompare(right.canonical_route_id));
  const routeIdsByRawJunction = rawJunctions.map(raw => canonicalRoutes.filter(route => route.parent_pixel_points.some(point => pointDistance(point, raw.point) <= policy.junction_endpoint_tolerance_px)).map(route => route.canonical_route_id));
  const junctions: SheetOverlapRouteJunctionV1[] = rawJunctions.map((raw, index) => {
    const routeIds = [...new Set(routeIdsByRawJunction[index])].sort();
    const kind = routeIds.length >= 4
      ? "crossing_requires_review" as const
      : routeIds.length === 3
        ? "tee_or_branch" as const
        : raw.kind;
    return {
      junction_id: `overlap-junction:${digest({ point: raw.point, route_ids: routeIds }).slice(0, 20)}`,
      parent_pixel_point: raw.point,
      parent_uv_point: toUv(raw.point, parentWidth, parentHeight),
      kind,
      canonical_route_ids: routeIds,
      source_member_endpoint_count: raw.sourceEndpointCount
    };
  }).filter(junction => junction.canonical_route_ids.length >= 2);
  const accountedMembers = new Set(canonicalRoutes.flatMap(route => route.source_members.map(member => `${member.view_key}:${member.primitive_id}`)));
  const sourceMemberCount = routes.length;
  const sourceClosure = sourceMemberCount > 0 ? accountedMembers.size / sourceMemberCount : 0;
  if (sourceClosure < 1) conflicts.push(`source_route_accounting_incomplete:${accountedMembers.size}:${sourceMemberCount}`);
  const overlappingMemberKeys = new Set(canonicalRoutes.filter(route => route.source_members.length > 1).flatMap(route => route.source_members.map(member => `${member.view_key}:${member.primitive_id}`)));
  const warnings: string[] = [];
  if (junctions.some(junction => junction.kind === "crossing_requires_review")) warnings.push("crossing_junctions_require_review");
  const primitives: SheetPixelPrimitiveV1[] = canonicalRoutes.map(route => {
    const first = route.parent_pixel_points[0];
    const last = route.parent_pixel_points[1];
    const firstBoundary = atParentBoundary(first, parentWidth, parentHeight, policy.junction_endpoint_tolerance_px);
    const lastBoundary = atParentBoundary(last, parentWidth, parentHeight, policy.junction_endpoint_tolerance_px);
    return {
      primitive_id: route.canonical_route_id,
      source_view_key: parentViewKey,
      source_mark_ids: [`overlap-mark:${route.canonical_route_id}`],
      kind: "route_segment",
      points: route.parent_uv_points,
      endpoints: [
        {
          endpoint_key: `${route.canonical_route_id}:start`,
          point: route.parent_uv_points[0],
          outward_direction_uv: route.orientation === "horizontal" ? [-1, 0] : [0, -1],
          boundary: firstBoundary ? "view_boundary" : "internal"
        },
        {
          endpoint_key: `${route.canonical_route_id}:end`,
          point: route.parent_uv_points[1],
          outward_direction_uv: route.orientation === "horizontal" ? [1, 0] : [0, 1],
          boundary: lastBoundary ? "view_boundary" : "internal"
        }
      ],
      ...(route.claims ? { claims: route.claims } : {}),
      confidence: route.confidence
    };
  });
  const parentInterpretation: SheetPixelInterpretationInputV1 = {
    schema_version: 1,
    package_id: `${clean(input.package_id)}:parent-route-graph`,
    coordinate_space: "normalized_uv_top_left",
    view_keys: [parentViewKey],
    source_marks: primitives.map(primitive => ({
      source_mark_id: primitive.source_mark_ids[0]!,
      source_view_key: parentViewKey,
      disposition: { status: "candidate", primitive_ids: [primitive.primitive_id] }
    })),
    primitives
  };
  const status = conflicts.length === 0 && sourceClosure === 1 ? "source_graph_compiled" as const : "blocked" as const;
  return {
    schema: "operator.sheet_overlap_route_compilation.v1",
    package_id: clean(input.package_id),
    parent_image_sha256: parentHash,
    parent_image_width_px: parentWidth,
    parent_image_height_px: parentHeight,
    input_fingerprint_sha256: digest(input),
    policy,
    tile_count: input.tiles.length,
    source_route_member_count: sourceMemberCount,
    source_route_accounting_closure: sourceClosure,
    overlapping_source_member_count: overlappingMemberKeys.size,
    canonical_route_count: canonicalRoutes.length,
    canonical_routes: canonicalRoutes,
    junctions,
    conflicts: [...new Set(conflicts)].sort(),
    warnings,
    status,
    parent_interpretation: parentInterpretation,
    exact_next_repair: status === "source_graph_compiled" ? "validate_parent_route_raster_coverage" : "resolve_overlap_route_conflicts",
    native_write_allowed: false,
    capability_boundary: "This source-only compiler registers overlapping tile routes into one parent pixel frame, removes partial duplicates, and splits orthogonal runs at endpoint-supported junctions. It does not establish native size, system, elevation, connectivity, phase, room placement, or write authority; the compiled parent graph must pass whole-parent raster coverage and later sealed native grading."
  };
}
