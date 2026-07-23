import crypto from "node:crypto";
import type {
  SheetPixelEndpointV1,
  SheetPixelInterpretationInputV1,
  SheetPixelPointV1,
  SheetPixelPrimitiveV1,
  SheetSourceRouteJunctionRepairV1
} from "./sheet_pixel_interpretation.js";

export type SheetRouteJunctionRepairProposalV1 = {
  schema_version: 1;
  proposal_id: string;
  proposal_sha256: string;
  source_package_id: string;
  source_interpretation_sha256: string;
  repair_ids: string[];
  proposal_interpretation: SheetPixelInterpretationInputV1;
  source_primitive_replacements: Record<string, string[]>;
  proposed_junctions: Array<{
    repair_id: string;
    source_view_key: string;
    point_uv: SheetPixelPointV1;
    endpoint_keys: string[];
    kind: "tee_or_branch";
  }>;
  raster_reverification_required: true;
  native_write_allowed: false;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function qualifiedEndpointKey(primitiveId: string, endpointKey: string): string {
  const local = requiredText(endpointKey, `sheet_route_junction_repair_${primitiveId}_endpoint_key`);
  return local.startsWith(`${primitiveId}:`) ? local : `${primitiveId}:${local}`;
}

function distance(left: SheetPixelPointV1, right: SheetPixelPointV1): number {
  return Math.hypot(left.u - right.u, left.v - right.v);
}

function samePoint(left: SheetPixelPointV1, right: SheetPixelPointV1): boolean {
  return distance(left, right) <= 1e-8;
}

function direction(start: SheetPixelPointV1, end: SheetPixelPointV1): [number, number] {
  const du = end.u - start.u;
  const dv = end.v - start.v;
  const length = Math.hypot(du, dv);
  if (length <= 1e-12) throw new Error("sheet_route_junction_repair_zero_length_span");
  return [du / length, dv / length];
}

function clonePrimitive(primitive: SheetPixelPrimitiveV1): SheetPixelPrimitiveV1 {
  return {
    ...primitive,
    source_mark_ids: [...primitive.source_mark_ids],
    points: primitive.points.map(point => ({ ...point })),
    ...(primitive.endpoints ? { endpoints: primitive.endpoints.map(endpoint => ({
      ...endpoint,
      point: { ...endpoint.point },
      outward_direction_uv: [...endpoint.outward_direction_uv] as [number, number]
    })) } : {}),
    ...(primitive.claims ? { claims: Object.fromEntries(Object.entries(primitive.claims).map(([key, claim]) => [key, claim ? { ...claim } : claim])) as SheetPixelPrimitiveV1["claims"] } : {}),
    confidence: { ...primitive.confidence },
    ...(primitive.source_repair ? { source_repair: { ...primitive.source_repair, repair_ids: [...primitive.source_repair.repair_ids] } } : {})
  };
}

function outerEndpoint(
  primitive: SheetPixelPrimitiveV1,
  side: "start" | "end"
): SheetPixelEndpointV1 | undefined {
  if (!primitive.endpoints || primitive.endpoints.length === 0) return undefined;
  const target = side === "start" ? primitive.points[0]! : primitive.points[primitive.points.length - 1]!;
  return [...primitive.endpoints].sort((left, right) => distance(left.point, target) - distance(right.point, target))[0];
}

export function proposeSheetRouteJunctionRepairsV1(args: {
  interpretation: SheetPixelInterpretationInputV1;
  repairs: SheetSourceRouteJunctionRepairV1[];
}): SheetRouteJunctionRepairProposalV1 {
  const input = args.interpretation;
  if (!input || input.schema_version !== 1) throw new Error("sheet_route_junction_repair_requires_schema_v1");
  if (!Array.isArray(args.repairs) || args.repairs.length === 0) throw new Error("sheet_route_junction_repair_requires_repairs");
  const sourcePackageId = requiredText(input.package_id, "sheet_route_junction_repair_source_package_id");
  const repairIds = args.repairs.map((repair, index) => requiredText(repair.repair_id, `sheet_route_junction_repair_${index}_id`));
  if (new Set(repairIds).size !== repairIds.length) throw new Error("sheet_route_junction_repair_duplicate_repair_id");
  const sourceInterpretationSha256 = digest(input);
  const proposalSeed = digest({ source_interpretation_sha256: sourceInterpretationSha256, repairs: args.repairs });
  const proposalId = `route-junction-repair:${proposalSeed.slice(0, 20)}`;
  const proposalPackageId = `${sourcePackageId}:junction-repair:${proposalSeed.slice(0, 12)}`;

  const sourceById = new Map<string, SheetPixelPrimitiveV1>();
  for (const primitive of input.primitives) {
    const primitiveId = requiredText(primitive.primitive_id, "sheet_route_junction_repair_primitive_id");
    if (sourceById.has(primitiveId)) throw new Error(`sheet_route_junction_repair_duplicate_primitive:${primitiveId}`);
    sourceById.set(primitiveId, primitive);
  }

  const repairsByPrimitive = new Map<string, SheetSourceRouteJunctionRepairV1[]>();
  const branchSnaps = new Map<string, Map<string, SheetPixelPointV1>>();
  const trunkSplits = new Map<string, SheetPixelPointV1[]>();
  for (const repair of args.repairs) {
    if (repair.status !== "requires_source_junction_split" || repair.native_write_allowed !== false) throw new Error(`sheet_route_junction_repair_status_invalid:${repair.repair_id}`);
    const trunk = sourceById.get(repair.trunk_primitive_id);
    const branch = sourceById.get(repair.branch_primitive_id);
    if (!trunk || trunk.kind !== "route_segment") throw new Error(`sheet_route_junction_repair_trunk_invalid:${repair.repair_id}`);
    if (!branch || branch.kind !== "route_segment") throw new Error(`sheet_route_junction_repair_branch_invalid:${repair.repair_id}`);
    if (trunk.source_view_key !== repair.source_view_key || branch.source_view_key !== repair.source_view_key) throw new Error(`sheet_route_junction_repair_view_mismatch:${repair.repair_id}`);
    for (const primitiveId of [repair.trunk_primitive_id, repair.branch_primitive_id]) {
      repairsByPrimitive.set(primitiveId, [...(repairsByPrimitive.get(primitiveId) ?? []), repair]);
    }
    const qualifiedBranchKey = qualifiedEndpointKey(branch.primitive_id, repair.branch_endpoint_key);
    const snaps = branchSnaps.get(branch.primitive_id) ?? new Map<string, SheetPixelPointV1>();
    const prior = snaps.get(qualifiedBranchKey);
    if (prior && !samePoint(prior, repair.projected_junction_uv)) throw new Error(`sheet_route_junction_repair_conflicting_branch_snap:${qualifiedBranchKey}`);
    snaps.set(qualifiedBranchKey, { ...repair.projected_junction_uv });
    branchSnaps.set(branch.primitive_id, snaps);
    trunkSplits.set(trunk.primitive_id, [...(trunkSplits.get(trunk.primitive_id) ?? []), { ...repair.projected_junction_uv }]);
  }

  const replacements = new Map<string, SheetPixelPrimitiveV1[]>();
  for (const [sourceId, relevantRepairs] of repairsByPrimitive) {
    const source = sourceById.get(sourceId)!;
    if (source.kind !== "route_segment" || source.points.length !== 2) throw new Error(`sheet_route_junction_repair_requires_straight_two_point_route:${sourceId}`);
    const originalStart = source.points[0]!;
    const originalEnd = source.points[1]!;
    let start = { ...originalStart };
    let end = { ...originalEnd };
    const sourceEndpoints = source.endpoints ?? [
      { endpoint_key: `${sourceId}:start`, point: { ...start }, outward_direction_uv: [-1, 0] as [number, number], boundary: "internal" as const },
      { endpoint_key: `${sourceId}:end`, point: { ...end }, outward_direction_uv: [1, 0] as [number, number], boundary: "internal" as const }
    ];
    for (const [endpointKey, snappedPoint] of (branchSnaps.get(sourceId) ?? new Map())) {
      const endpoint = sourceEndpoints.find(candidate => qualifiedEndpointKey(sourceId, candidate.endpoint_key) === endpointKey);
      if (!endpoint) throw new Error(`sheet_route_junction_repair_branch_endpoint_missing:${endpointKey}`);
      const startDistance = distance(endpoint.point, originalStart);
      const endDistance = distance(endpoint.point, originalEnd);
      if (Math.min(startDistance, endDistance) > 1e-6) throw new Error(`sheet_route_junction_repair_branch_endpoint_not_outer:${endpointKey}`);
      if (startDistance <= endDistance) start = { ...snappedPoint }; else end = { ...snappedPoint };
    }

    const spanVector = { u: end.u - start.u, v: end.v - start.v };
    const spanLengthSquared = spanVector.u * spanVector.u + spanVector.v * spanVector.v;
    if (spanLengthSquared <= 1e-12) throw new Error(`sheet_route_junction_repair_zero_length_source:${sourceId}`);
    const splitEntries = (trunkSplits.get(sourceId) ?? []).map(point => ({
      point,
      t: ((point.u - start.u) * spanVector.u + (point.v - start.v) * spanVector.v) / spanLengthSquared
    })).sort((left, right) => left.t - right.t);
    for (const split of splitEntries) {
      if (split.t <= 1e-8 || split.t >= 1 - 1e-8) throw new Error(`sheet_route_junction_repair_split_not_interior:${sourceId}`);
      const projected = { u: start.u + split.t * spanVector.u, v: start.v + split.t * spanVector.v };
      if (distance(projected, split.point) > 1e-6) throw new Error(`sheet_route_junction_repair_split_off_route:${sourceId}`);
    }
    const nodes = [start, ...splitEntries.map(entry => entry.point), end]
      .filter((point, index, all) => index === 0 || !samePoint(point, all[index - 1]!));
    const sourceRepairIds = [...new Set(relevantRepairs.map(repair => repair.repair_id))].sort();
    const firstOuter = outerEndpoint(source, "start");
    const lastOuter = outerEndpoint(source, "end");
    const children: SheetPixelPrimitiveV1[] = [];
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const childStart = nodes[index]!;
      const childEnd = nodes[index + 1]!;
      const forward = direction(childStart, childEnd);
      const childId = `repair-route:${digest({ proposal_id: proposalId, source_primitive_id: sourceId, index, start: childStart, end: childEnd }).slice(0, 20)}`;
      const startOuter = index === 0 ? firstOuter : undefined;
      const endOuter = index === nodes.length - 2 ? lastOuter : undefined;
      children.push({
        primitive_id: childId,
        source_view_key: source.source_view_key,
        source_mark_ids: [...source.source_mark_ids].sort(),
        kind: "route_segment",
        points: [{ ...childStart }, { ...childEnd }],
        endpoints: [
          {
            endpoint_key: `${childId}:start`,
            point: { ...childStart },
            outward_direction_uv: [-forward[0], -forward[1]],
            boundary: startOuter?.boundary ?? "internal",
            ...(startOuter?.continuation_key ? { continuation_key: startOuter.continuation_key } : {})
          },
          {
            endpoint_key: `${childId}:end`,
            point: { ...childEnd },
            outward_direction_uv: forward,
            boundary: endOuter?.boundary ?? "internal",
            ...(endOuter?.continuation_key ? { continuation_key: endOuter.continuation_key } : {})
          }
        ],
        ...(source.claims ? { claims: Object.fromEntries(Object.entries(source.claims).map(([key, claim]) => [key, claim ? { ...claim } : claim])) as SheetPixelPrimitiveV1["claims"] } : {}),
        confidence: { ...source.confidence },
        requires_raster_reverification: true,
        source_repair: { proposal_id: proposalId, source_primitive_id: sourceId, repair_ids: sourceRepairIds }
      });
    }
    replacements.set(sourceId, children);
  }

  const proposalPrimitives = input.primitives.flatMap(primitive => replacements.get(primitive.primitive_id) ?? [clonePrimitive(primitive)]);
  const sourcePrimitiveReplacements = Object.fromEntries([...replacements.entries()].map(([sourceId, children]) => [sourceId, children.map(child => child.primitive_id)]));
  const proposalSourceMarks = input.source_marks.map(mark => {
    if (mark.disposition.status !== "candidate") return { ...mark, disposition: { ...mark.disposition } };
    const ids = mark.disposition.primitive_ids.flatMap(primitiveId => sourcePrimitiveReplacements[primitiveId] ?? [primitiveId]);
    for (const [sourceId, children] of replacements) {
      if (sourceById.get(sourceId)!.source_mark_ids.includes(mark.source_mark_id)) ids.push(...children.map(child => child.primitive_id));
    }
    return { ...mark, disposition: { ...mark.disposition, primitive_ids: [...new Set(ids)].sort() } };
  });
  const proposedJunctions = args.repairs.map(repair => {
    const memberSourceIds = new Set([repair.trunk_primitive_id, repair.branch_primitive_id]);
    const endpointKeys = proposalPrimitives
      .filter(primitive => primitive.source_repair && memberSourceIds.has(primitive.source_repair.source_primitive_id))
      .flatMap(primitive => primitive.endpoints ?? [])
      .filter(endpoint => samePoint(endpoint.point, repair.projected_junction_uv))
      .map(endpoint => endpoint.endpoint_key)
      .sort();
    if (endpointKeys.length !== 3) throw new Error(`sheet_route_junction_repair_expected_three_way_junction:${repair.repair_id}:${endpointKeys.length}`);
    return {
      repair_id: repair.repair_id,
      source_view_key: repair.source_view_key,
      point_uv: { ...repair.projected_junction_uv },
      endpoint_keys: endpointKeys,
      kind: "tee_or_branch" as const
    };
  }).sort((left, right) => left.repair_id.localeCompare(right.repair_id));
  const proposalInterpretation: SheetPixelInterpretationInputV1 = {
    schema_version: 1,
    package_id: proposalPackageId,
    coordinate_space: "normalized_uv_top_left",
    view_keys: [...input.view_keys],
    source_marks: proposalSourceMarks,
    primitives: proposalPrimitives
  };
  const proposalCore = {
    source_package_id: sourcePackageId,
    source_interpretation_sha256: sourceInterpretationSha256,
    repair_ids: [...repairIds].sort(),
    proposal_interpretation: proposalInterpretation,
    source_primitive_replacements: sourcePrimitiveReplacements,
    proposed_junctions: proposedJunctions
  };
  return {
    schema_version: 1,
    proposal_id: proposalId,
    proposal_sha256: digest(proposalCore),
    ...proposalCore,
    raster_reverification_required: true,
    native_write_allowed: false
  };
}
