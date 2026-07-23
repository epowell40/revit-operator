import crypto from "node:crypto";
import type { CandidateVisibleFrameMapping } from "./candidate_visible_registration.js";
import type {
  SheetCandidatePresenceReceiptV1,
  SheetPixelEvidencePolicyV1,
  SheetPixelEvidenceReceiptV1,
  SheetPixelPointEvidenceV1,
  SheetPixelRouteEvidenceV1
} from "./sheet_pixel_evidence.js";
import {
  compileSheetTopologyV1,
  type CompiledSheetTopologyV1,
  type SheetTopologyCalibrationProfileV1,
  type SheetTopologyClaimV1,
  type SheetTopologyCompilationPolicyV1,
  type SheetTopologyEndpointV1,
  type SheetTopologyPoint,
  type SheetTopologyPrimitiveKind,
  type SheetTopologySourceMarkV1,
  type SheetTopologySourceViewV1
} from "./sheet_topology_compiler.js";

export type SheetPixelPointV1 = { u: number; v: number };

export type SheetPixelEndpointV1 = {
  endpoint_key: string;
  point: SheetPixelPointV1;
  outward_direction_uv: [number, number];
  boundary: SheetTopologyEndpointV1["boundary"];
  continuation_key?: string;
};

export type SheetPixelPrimitiveV1 = {
  primitive_id: string;
  source_view_key: string;
  source_mark_ids: string[];
  kind: SheetTopologyPrimitiveKind;
  points: SheetPixelPointV1[];
  endpoints?: SheetPixelEndpointV1[];
  claims?: {
    system?: SheetTopologyClaimV1;
    size?: SheetTopologyClaimV1;
    type?: SheetTopologyClaimV1;
    family?: SheetTopologyClaimV1;
    host?: SheetTopologyClaimV1;
    elevation?: SheetTopologyClaimV1;
    vertical_extent?: SheetTopologyClaimV1;
  };
  confidence: {
    geometry: number;
    classification: number;
    topology: number;
    visibility: number;
  };
};

export type SheetPixelInterpretationInputV1 = {
  schema_version: 1;
  package_id: string;
  coordinate_space: "normalized_uv_top_left";
  view_keys: string[];
  source_marks: SheetTopologySourceMarkV1[];
  primitives: SheetPixelPrimitiveV1[];
};

export type SheetPixelInterpretationContextV1 = {
  trusted_views: Array<{
    source_view: SheetTopologySourceViewV1;
    frame: CandidateVisibleFrameMapping;
  }>;
  calibration_profile: SheetTopologyCalibrationProfileV1;
  raster_evidence_receipts?: SheetPixelEvidenceReceiptV1[];
  raster_evidence_policy_by_view?: Record<string, Partial<SheetPixelEvidencePolicyV1>>;
  candidate_raster_by_view?: Record<string, {
    image_path: string;
    image_sha256: string;
    frame: CandidateVisibleFrameMapping;
    policy?: Partial<SheetPixelEvidencePolicyV1>;
    point_identity_tolerance_px?: number;
    overlay_output_path?: string;
  }>;
  candidate_presence_receipts?: SheetCandidatePresenceReceiptV1[];
  evidence_receipt_file_paths?: string[];
  policy?: Partial<SheetTopologyCompilationPolicyV1>;
};

export type SheetCandidateIdentityGroupV1 = {
  identity_group_id: string;
  candidate_image_sha256: string;
  candidate_frame_id: string;
  candidate_view_id: number;
  scope: "cross_view" | "cross_sheet";
  representative_candidate_uv: { u: number; v: number };
  maximum_member_separation_px: number;
  members: Array<{
    primitive_id: string;
    source_view_key: string;
    source_sheet_key: string;
    mapped_candidate_uv: { u: number; v: number };
    coherent_hue_degrees?: number;
  }>;
  status: "shared_candidate_visible";
  native_write_allowed: false;
};

export type SheetSourceRouteJunctionRepairV1 = {
  repair_id: string;
  source_view_key: string;
  trunk_primitive_id: string;
  trunk_segment_index: number;
  branch_primitive_id: string;
  branch_endpoint_key: string;
  branch_endpoint_uv: SheetPixelPointV1;
  projected_junction_uv: SheetPixelPointV1;
  gap_px: number;
  maximum_gap_px: number;
  intersection_angle_degrees: number;
  status: "requires_source_junction_split";
  exact_next_repair: "split_trunk_and_snap_branch_endpoint_after_source_raster_reverification";
  native_write_allowed: false;
};

export type CompiledSheetPixelInterpretationV1 = {
  schema_version: 1;
  pixel_interpretation_sha256: string;
  trusted_context_sha256: string;
  compiled_topology: CompiledSheetTopologyV1;
  candidate_identity_groups: SheetCandidateIdentityGroupV1[];
  source_route_junction_repairs: SheetSourceRouteJunctionRepairV1[];
};

type CandidateIdentityObservation = {
  primitive_id: string;
  source_view_key: string;
  source_sheet_key: string;
  candidate_image_sha256: string;
  candidate_frame_id: string;
  candidate_view_id: number;
  candidate_width_px: number;
  candidate_height_px: number;
  mapped_candidate_uv: { u: number; v: number };
  coherent_hue_degrees?: number;
  hue_tolerance_degrees: number;
  tolerance_px: number;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function normalized(value: unknown, label: string): number {
  const result = finite(value, label);
  if (result < 0 || result > 1) throw new Error(`${label}_must_be_between_zero_and_one`);
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

type PixelRouteEndpoint = {
  endpoint_key: string;
  point: SheetPixelPointV1;
  inward_vector_px: [number, number];
};

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function qualifiedEndpointKey(primitiveId: string, endpointKey: string): string {
  const local = requiredText(endpointKey, `sheet_pixel_primitive_${primitiveId}_endpoint_key`);
  return local.startsWith(`${primitiveId}:`) ? local : `${primitiveId}:${local}`;
}

function pixelPoint(point: SheetPixelPointV1, widthPx: number, heightPx: number): [number, number] {
  return [point.u * widthPx, point.v * heightPx];
}

function routeEndpoints(
  primitive: SheetPixelPrimitiveV1,
  widthPx: number,
  heightPx: number
): PixelRouteEndpoint[] {
  if (primitive.points.length < 2) return [];
  const first = primitive.points[0]!;
  const second = primitive.points[1]!;
  const last = primitive.points[primitive.points.length - 1]!;
  const previous = primitive.points[primitive.points.length - 2]!;
  const candidates = primitive.endpoints && primitive.endpoints.length > 0
    ? primitive.endpoints.map(endpoint => ({ endpoint_key: qualifiedEndpointKey(primitive.primitive_id, endpoint.endpoint_key), point: endpoint.point }))
    : [
        { endpoint_key: `${primitive.primitive_id}:start`, point: first },
        { endpoint_key: `${primitive.primitive_id}:end`, point: last }
      ];
  return candidates.map(candidate => {
    const [candidateX, candidateY] = pixelPoint(candidate.point, widthPx, heightPx);
    const [firstX, firstY] = pixelPoint(first, widthPx, heightPx);
    const [lastX, lastY] = pixelPoint(last, widthPx, heightPx);
    const useFirst = Math.hypot(candidateX - firstX, candidateY - firstY) <= Math.hypot(candidateX - lastX, candidateY - lastY);
    const inner = useFirst ? second : previous;
    const [innerX, innerY] = pixelPoint(inner, widthPx, heightPx);
    return {
      endpoint_key: candidate.endpoint_key,
      point: candidate.point,
      inward_vector_px: [innerX - candidateX, innerY - candidateY]
    };
  });
}

function compileSourceRouteJunctionRepairs(
  input: SheetPixelInterpretationInputV1,
  receiptsByView: Map<string, SheetPixelEvidenceReceiptV1>
): SheetSourceRouteJunctionRepairV1[] {
  const result: SheetSourceRouteJunctionRepairV1[] = [];
  const routes = input.primitives
    .filter(primitive => primitive.kind === "route_segment" && primitive.points.length >= 2)
    .sort((left, right) => left.primitive_id.localeCompare(right.primitive_id));
  for (const branch of routes) {
    const receipt = receiptsByView.get(branch.source_view_key);
    if (!receipt) continue;
    const accepted = new Set(receipt.accepted_primitive_ids);
    if (!accepted.has(branch.primitive_id)) continue;
    const widthPx = receipt.image.width_px;
    const heightPx = receipt.image.height_px;
    const maximumGapPx = Math.min(32, Math.max(6, receipt.policy.corridor_radius_px * 3));
    const interiorMarginPx = Math.max(2, receipt.policy.corridor_radius_px);
    for (const endpoint of routeEndpoints(branch, widthPx, heightPx)) {
      const [pointX, pointY] = pixelPoint(endpoint.point, widthPx, heightPx);
      const branchLength = Math.hypot(endpoint.inward_vector_px[0], endpoint.inward_vector_px[1]);
      if (branchLength <= 1e-9) continue;
      for (const trunk of routes) {
        if (trunk.primitive_id === branch.primitive_id || trunk.source_view_key !== branch.source_view_key || !accepted.has(trunk.primitive_id)) continue;
        for (let segmentIndex = 0; segmentIndex < trunk.points.length - 1; segmentIndex += 1) {
          const startUv = trunk.points[segmentIndex]!;
          const endUv = trunk.points[segmentIndex + 1]!;
          const [startX, startY] = pixelPoint(startUv, widthPx, heightPx);
          const [endX, endY] = pixelPoint(endUv, widthPx, heightPx);
          const segmentX = endX - startX;
          const segmentY = endY - startY;
          const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
          if (segmentLengthSquared <= 1e-9) continue;
          const segmentLength = Math.sqrt(segmentLengthSquared);
          const projection = ((pointX - startX) * segmentX + (pointY - startY) * segmentY) / segmentLengthSquared;
          if (projection * segmentLength < interiorMarginPx || (1 - projection) * segmentLength < interiorMarginPx) continue;
          const projectedX = startX + projection * segmentX;
          const projectedY = startY + projection * segmentY;
          const gapPx = Math.hypot(pointX - projectedX, pointY - projectedY);
          if (gapPx > maximumGapPx + 1e-9) continue;
          const absoluteCosine = Math.min(1, Math.abs(
            (endpoint.inward_vector_px[0] * segmentX + endpoint.inward_vector_px[1] * segmentY)
            / (branchLength * segmentLength)
          ));
          const intersectionAngle = Math.acos(absoluteCosine) * 180 / Math.PI;
          if (intersectionAngle < 70) continue;
          const repairIdentity = {
            source_view_key: branch.source_view_key,
            trunk_primitive_id: trunk.primitive_id,
            trunk_segment_index: segmentIndex,
            branch_primitive_id: branch.primitive_id,
            branch_endpoint_key: endpoint.endpoint_key
          };
          result.push({
            repair_id: `source-route-junction:${digest(repairIdentity).slice(0, 20)}`,
            ...repairIdentity,
            branch_endpoint_uv: { u: rounded(endpoint.point.u), v: rounded(endpoint.point.v) },
            projected_junction_uv: { u: rounded(projectedX / widthPx), v: rounded(projectedY / heightPx) },
            gap_px: rounded(gapPx),
            maximum_gap_px: rounded(maximumGapPx),
            intersection_angle_degrees: rounded(intersectionAngle),
            status: "requires_source_junction_split",
            exact_next_repair: "split_trunk_and_snap_branch_endpoint_after_source_raster_reverification",
            native_write_allowed: false
          });
        }
      }
    }
  }
  return result.sort((left, right) => left.repair_id.localeCompare(right.repair_id));
}

function deferTopologyForSourceRouteJunctionRepairs(
  topology: CompiledSheetTopologyV1,
  repairs: SheetSourceRouteJunctionRepairV1[]
): void {
  if (repairs.length === 0) return;
  const affected = new Set(repairs.flatMap(repair => [repair.trunk_primitive_id, repair.branch_primitive_id]));
  for (const decision of topology.decisions) {
    if (!affected.has(decision.primitive_id) || decision.decision === "duplicate") continue;
    decision.decision = "deferred";
    decision.reasons = [...new Set([...decision.reasons, "source_route_near_t_junction_unresolved"])].sort();
  }
  topology.native_batch_groups = topology.native_batch_groups
    .map(group => ({ ...group, primitive_ids: group.primitive_ids.filter(primitiveId => !affected.has(primitiveId)) }))
    .filter(group => group.primitive_ids.length > 0);
  topology.single_action_primitive_ids = topology.single_action_primitive_ids.filter(primitiveId => !affected.has(primitiveId));
  topology.deferred_primitive_ids = [...new Set([
    ...topology.deferred_primitive_ids,
    ...topology.decisions.filter(decision => decision.decision === "deferred").map(decision => decision.primitive_id)
  ])].sort();
  for (const repair of repairs) {
    topology.conflicts.push(`source_route_requires_junction_split:${repair.trunk_primitive_id}:${repair.branch_primitive_id}:${repair.branch_endpoint_key}`);
  }
  topology.conflicts = [...new Set(topology.conflicts)].sort();
  const canonicalCount = topology.canonical_primitive_ids.length;
  topology.status = canonicalCount > 0 && topology.deferred_primitive_ids.length >= canonicalCount ? "blocked" : "partially_ready";
}

function candidatePixelDistance(left: CandidateIdentityObservation, right: CandidateIdentityObservation): number {
  return Math.hypot(
    (left.mapped_candidate_uv.u - right.mapped_candidate_uv.u) * left.candidate_width_px,
    (left.mapped_candidate_uv.v - right.mapped_candidate_uv.v) * left.candidate_height_px
  );
}

function candidateHueCompatible(left: CandidateIdentityObservation, right: CandidateIdentityObservation): boolean {
  if (left.coherent_hue_degrees === undefined || right.coherent_hue_degrees === undefined) return true;
  const rawDistance = Math.abs(left.coherent_hue_degrees - right.coherent_hue_degrees);
  const circularDistance = Math.min(rawDistance, 360 - rawDistance);
  return circularDistance <= Math.min(left.hue_tolerance_degrees, right.hue_tolerance_degrees);
}

function compileCandidateIdentityGroups(observations: CandidateIdentityObservation[]): SheetCandidateIdentityGroupV1[] {
  const byCandidateFrame = new Map<string, CandidateIdentityObservation[]>();
  for (const observation of observations) {
    const key = `${observation.candidate_image_sha256}|${observation.candidate_frame_id}|${observation.candidate_view_id}|${observation.candidate_width_px}|${observation.candidate_height_px}`;
    byCandidateFrame.set(key, [...(byCandidateFrame.get(key) ?? []), observation]);
  }
  const result: SheetCandidateIdentityGroupV1[] = [];
  for (const [frameKey, frameObservations] of byCandidateFrame) {
    frameObservations.sort((left, right) => left.source_view_key.localeCompare(right.source_view_key) || left.primitive_id.localeCompare(right.primitive_id));
    const clusters: CandidateIdentityObservation[][] = [];
    for (const observation of frameObservations) {
      const eligible = clusters
        .map((members, index) => ({
          index,
          members,
          maximum_distance: members.reduce((maximum, member) => Math.max(maximum, candidatePixelDistance(member, observation)), 0)
        }))
        .filter(candidate =>
          !candidate.members.some(member => member.source_view_key === observation.source_view_key) &&
          candidate.members.every(member =>
            candidatePixelDistance(member, observation) <= Math.min(member.tolerance_px, observation.tolerance_px) &&
            candidateHueCompatible(member, observation)
          )
        )
        .sort((left, right) => left.maximum_distance - right.maximum_distance || left.index - right.index);
      if (eligible.length === 0) clusters.push([observation]);
      else clusters[eligible[0]!.index]!.push(observation);
    }
    for (const members of clusters) {
      if (new Set(members.map(member => member.source_view_key)).size < 2) continue;
      const sheets = new Set(members.map(member => member.source_sheet_key));
      let maximumSeparation = 0;
      for (let left = 0; left < members.length; left += 1) {
        for (let right = left + 1; right < members.length; right += 1) {
          maximumSeparation = Math.max(maximumSeparation, candidatePixelDistance(members[left]!, members[right]!));
        }
      }
      const representative = {
        u: members.reduce((sum, member) => sum + member.mapped_candidate_uv.u, 0) / members.length,
        v: members.reduce((sum, member) => sum + member.mapped_candidate_uv.v, 0) / members.length
      };
      const sortedMembers = [...members].sort((left, right) => left.source_view_key.localeCompare(right.source_view_key) || left.primitive_id.localeCompare(right.primitive_id));
      result.push({
        identity_group_id: `candidate-identity:${digest({ frame_key: frameKey, members: sortedMembers.map(member => [member.source_view_key, member.primitive_id]) }).slice(0, 16)}`,
        candidate_image_sha256: sortedMembers[0]!.candidate_image_sha256,
        candidate_frame_id: sortedMembers[0]!.candidate_frame_id,
        candidate_view_id: sortedMembers[0]!.candidate_view_id,
        scope: sheets.size > 1 ? "cross_sheet" : "cross_view",
        representative_candidate_uv: representative,
        maximum_member_separation_px: maximumSeparation,
        members: sortedMembers.map(member => ({
          primitive_id: member.primitive_id,
          source_view_key: member.source_view_key,
          source_sheet_key: member.source_sheet_key,
          mapped_candidate_uv: member.mapped_candidate_uv,
          ...(member.coherent_hue_degrees === undefined ? {} : { coherent_hue_degrees: member.coherent_hue_degrees })
        })),
        status: "shared_candidate_visible",
        native_write_allowed: false
      });
    }
  }
  result.sort((left, right) => left.identity_group_id.localeCompare(right.identity_group_id));
  return result;
}

function framePoint(frame: CandidateVisibleFrameMapping, value: SheetPixelPointV1, label: string): SheetTopologyPoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const u = normalized(value.u, `${label}_u`);
  const v = normalized(value.v, `${label}_v`);
  const topLeft = frame.top_left_xyz;
  const topRight = frame.top_right_xyz;
  const bottomLeft = frame.bottom_left_xyz;
  if (![topLeft, topRight, bottomLeft].every(entry => Array.isArray(entry) && entry.length === 3 && entry.every(Number.isFinite))) {
    throw new Error(`${label}_trusted_frame_invalid`);
  }
  return {
    x: topLeft[0] + u * (topRight[0] - topLeft[0]) + v * (bottomLeft[0] - topLeft[0]),
    y: topLeft[1] + u * (topRight[1] - topLeft[1]) + v * (bottomLeft[1] - topLeft[1])
  };
}

function frameDirection(
  frame: CandidateVisibleFrameMapping,
  value: [number, number],
  label: string
): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label}_must_have_two_values`);
  const du = finite(value[0], `${label}_u`);
  const dv = finite(value[1], `${label}_v`);
  const topLeft = frame.top_left_xyz;
  const topRight = frame.top_right_xyz;
  const bottomLeft = frame.bottom_left_xyz;
  const x = du * (topRight[0] - topLeft[0]) + dv * (bottomLeft[0] - topLeft[0]);
  const y = du * (topRight[1] - topLeft[1]) + dv * (bottomLeft[1] - topLeft[1]);
  const length = Math.hypot(x, y);
  if (length <= 1e-9) throw new Error(`${label}_maps_to_zero_vector`);
  return [x / length, y / length];
}

export function compileSheetPixelInterpretationV1(
  input: SheetPixelInterpretationInputV1,
  context: SheetPixelInterpretationContextV1
): CompiledSheetPixelInterpretationV1 {
  if (!input || input.schema_version !== 1) throw new Error("sheet_pixel_interpretation_requires_schema_v1");
  if (input.coordinate_space !== "normalized_uv_top_left") throw new Error("sheet_pixel_interpretation_coordinate_space_invalid");
  requiredText(input.package_id, "sheet_pixel_interpretation_package_id");
  if (!context || !Array.isArray(context.trusted_views) || context.trusted_views.length === 0) throw new Error("sheet_pixel_interpretation_trusted_views_required");
  if (!Array.isArray(input.view_keys) || input.view_keys.length === 0) throw new Error("sheet_pixel_interpretation_view_keys_required");
  const requestedViewKeys = input.view_keys.map((value, index) => requiredText(value, `sheet_pixel_interpretation_view_key_${index}`));
  if (new Set(requestedViewKeys).size !== requestedViewKeys.length) throw new Error("sheet_pixel_interpretation_duplicate_view_key");

  const trustedByKey = new Map<string, SheetPixelInterpretationContextV1["trusted_views"][number]>();
  for (const [index, trusted] of context.trusted_views.entries()) {
    const key = requiredText(trusted.source_view?.view_key, `sheet_pixel_trusted_view_${index}_key`);
    if (trustedByKey.has(key)) throw new Error(`sheet_pixel_duplicate_trusted_view:${key}`);
    if (!trusted.frame || !Number.isSafeInteger(trusted.frame.view_id) || trusted.frame.view_id <= 0) throw new Error(`sheet_pixel_trusted_frame_invalid:${key}`);
    if (!Number.isSafeInteger(trusted.frame.width_px) || trusted.frame.width_px <= 0 || !Number.isSafeInteger(trusted.frame.height_px) || trusted.frame.height_px <= 0) {
      throw new Error(`sheet_pixel_trusted_frame_dimensions_invalid:${key}`);
    }
    trustedByKey.set(key, trusted);
  }
  const selected = requestedViewKeys.map(key => {
    const value = trustedByKey.get(key);
    if (!value) throw new Error(`sheet_pixel_interpretation_unknown_trusted_view:${key}`);
    return value;
  });
  const selectedKeys = new Set(requestedViewKeys);
  if (!Array.isArray(input.source_marks) || input.source_marks.length === 0) throw new Error("sheet_pixel_interpretation_source_marks_required");
  if (!Array.isArray(input.primitives)) throw new Error("sheet_pixel_interpretation_primitives_required");
  const sourceMarks: SheetTopologySourceMarkV1[] = input.source_marks.map(mark => ({
    ...mark,
    disposition: mark.disposition.status === "candidate"
      ? { ...mark.disposition, primitive_ids: [...mark.disposition.primitive_ids] }
      : { ...mark.disposition }
  }));
  const pixelPrimitives: SheetPixelPrimitiveV1[] = input.primitives.map(primitive => ({
    ...primitive,
    source_mark_ids: [...primitive.source_mark_ids],
    points: primitive.points.map(point => ({ ...point })),
    ...(primitive.endpoints ? { endpoints: primitive.endpoints.map(endpoint => ({ ...endpoint, point: { ...endpoint.point }, outward_direction_uv: [...endpoint.outward_direction_uv] as [number, number] })) } : {})
  }));
  const sourceAccountingWarnings: string[] = [];
  const marksById = new Map<string, SheetTopologySourceMarkV1>();
  for (const mark of sourceMarks) {
    if (!selectedKeys.has(clean(mark.source_view_key))) throw new Error(`sheet_pixel_source_mark_view_not_selected:${clean(mark.source_mark_id)}`);
    if (marksById.has(mark.source_mark_id)) throw new Error(`sheet_pixel_duplicate_source_mark:${mark.source_mark_id}`);
    marksById.set(mark.source_mark_id, mark);
  }
  const primitivesById = new Map<string, SheetPixelPrimitiveV1>();
  for (const primitive of pixelPrimitives) {
    if (primitivesById.has(primitive.primitive_id)) throw new Error(`sheet_pixel_duplicate_primitive:${primitive.primitive_id}`);
    primitivesById.set(primitive.primitive_id, primitive);
  }
  for (const mark of sourceMarks) {
    if (mark.disposition.status !== "candidate") continue;
    for (const primitiveId of mark.disposition.primitive_ids) {
      const primitive = primitivesById.get(primitiveId);
      if (!primitive) throw new Error(`sheet_pixel_source_mark_unknown_primitive:${mark.source_mark_id}:${primitiveId}`);
      if (primitive.source_view_key !== mark.source_view_key) throw new Error(`sheet_pixel_source_mark_primitive_view_mismatch:${mark.source_mark_id}:${primitiveId}`);
      if (!primitive.source_mark_ids.includes(mark.source_mark_id)) {
        primitive.source_mark_ids.push(mark.source_mark_id);
        sourceAccountingWarnings.push(`source_accounting_reciprocity_normalized:${mark.source_mark_id}:${primitiveId}`);
      }
    }
  }
  for (const primitive of pixelPrimitives) {
    for (const markId of primitive.source_mark_ids) {
      const mark = marksById.get(markId);
      if (!mark) throw new Error(`sheet_pixel_primitive_unknown_source_mark:${primitive.primitive_id}:${markId}`);
      if (mark.source_view_key !== primitive.source_view_key) throw new Error(`sheet_pixel_primitive_source_mark_view_mismatch:${primitive.primitive_id}:${markId}`);
      if (mark.disposition.status !== "candidate") throw new Error(`sheet_pixel_primitive_cites_unresolved_source_mark:${primitive.primitive_id}:${markId}`);
      if (!mark.disposition.primitive_ids.includes(primitive.primitive_id)) {
        mark.disposition.primitive_ids.push(primitive.primitive_id);
        sourceAccountingWarnings.push(`source_accounting_reciprocity_normalized:${markId}:${primitive.primitive_id}`);
      }
    }
  }
  for (const mark of sourceMarks) {
    if (mark.disposition.status === "candidate") mark.disposition.primitive_ids = [...new Set(mark.disposition.primitive_ids)].sort();
  }
  for (const primitive of pixelPrimitives) primitive.source_mark_ids = [...new Set(primitive.source_mark_ids)].sort();

  const rasterEvidenceByPrimitive = new Map<string, SheetPixelRouteEvidenceV1 | SheetPixelPointEvidenceV1>();
  const rasterEvidenceViews = new Set<string>();
  const rasterEvidenceReceiptByView = new Map<string, SheetPixelEvidenceReceiptV1>();
  for (const [receiptIndex, receipt] of (context.raster_evidence_receipts ?? []).entries()) {
    if (!receipt || receipt.schema_version !== 1) throw new Error(`sheet_pixel_raster_evidence_schema_invalid:${receiptIndex}`);
    const viewKey = requiredText(receipt.source_view_key, `sheet_pixel_raster_evidence_${receiptIndex}_view_key`);
    const trusted = trustedByKey.get(viewKey);
    if (!trusted || !selectedKeys.has(viewKey)) throw new Error(`sheet_pixel_raster_evidence_unknown_view:${viewKey}`);
    if (clean(receipt.image?.sha256).toLowerCase() !== clean(trusted.source_view.source_sha256).toLowerCase()) throw new Error(`sheet_pixel_raster_evidence_source_hash_mismatch:${viewKey}`);
    if (!Number.isSafeInteger(receipt.image?.width_px) || receipt.image.width_px <= 0 || !Number.isSafeInteger(receipt.image?.height_px) || receipt.image.height_px <= 0) {
      throw new Error(`sheet_pixel_raster_evidence_dimensions_invalid:${viewKey}`);
    }
    if (rasterEvidenceReceiptByView.has(viewKey)) throw new Error(`sheet_pixel_raster_evidence_duplicate_view:${viewKey}`);
    rasterEvidenceReceiptByView.set(viewKey, receipt);
    rasterEvidenceViews.add(viewKey);
    for (const evidence of receipt.route_evidence ?? []) {
      const primitiveId = requiredText(evidence.primitive_id, `sheet_pixel_raster_evidence_${viewKey}_primitive_id`);
      if (rasterEvidenceByPrimitive.has(primitiveId)) throw new Error(`sheet_pixel_raster_evidence_duplicate_primitive:${primitiveId}`);
      rasterEvidenceByPrimitive.set(primitiveId, evidence);
    }
    for (const evidence of receipt.point_evidence ?? []) {
      const primitiveId = requiredText(evidence.primitive_id, `sheet_pixel_point_evidence_${viewKey}_primitive_id`);
      if (rasterEvidenceByPrimitive.has(primitiveId)) throw new Error(`sheet_pixel_raster_evidence_duplicate_primitive:${primitiveId}`);
      rasterEvidenceByPrimitive.set(primitiveId, evidence);
    }
  }

  const candidatePresenceByPrimitive = new Map<string, SheetCandidatePresenceReceiptV1["point_evidence"][number]>();
  const candidateIdentityObservations: CandidateIdentityObservation[] = [];
  for (const [receiptIndex, receipt] of (context.candidate_presence_receipts ?? []).entries()) {
    if (!receipt || receipt.schema_version !== 1) throw new Error(`sheet_candidate_presence_schema_invalid:${receiptIndex}`);
    const viewKey = requiredText(receipt.source_view_key, `sheet_candidate_presence_${receiptIndex}_view_key`);
    const trusted = trustedByKey.get(viewKey);
    if (!trusted || !selectedKeys.has(viewKey)) throw new Error(`sheet_candidate_presence_unknown_view:${viewKey}`);
    const binding = context.candidate_raster_by_view?.[viewKey];
    if (!binding) throw new Error(`sheet_candidate_presence_unbound:${viewKey}`);
    if (clean(receipt.source_image_sha256).toLowerCase() !== clean(trusted.source_view.source_sha256).toLowerCase()) {
      throw new Error(`sheet_candidate_presence_source_hash_mismatch:${viewKey}`);
    }
    if (receipt.candidate_image?.view_id !== trusted.frame.view_id) throw new Error(`sheet_candidate_presence_view_mismatch:${viewKey}`);
    if (clean(receipt.candidate_image?.sha256).toLowerCase() !== clean(binding.image_sha256).toLowerCase()) {
      throw new Error(`sheet_candidate_presence_candidate_hash_mismatch:${viewKey}`);
    }
    if (
      receipt.candidate_image?.frame_id !== binding.frame.frame_id
      || receipt.candidate_image?.view_id !== binding.frame.view_id
      || receipt.candidate_image?.width_px !== binding.frame.width_px
      || receipt.candidate_image?.height_px !== binding.frame.height_px
    ) {
      throw new Error(`sheet_candidate_presence_candidate_frame_mismatch:${viewKey}`);
    }
    const identityTolerance = binding.point_identity_tolerance_px === undefined
      ? 3
      : finite(binding.point_identity_tolerance_px, `sheet_candidate_presence_identity_tolerance_${viewKey}`);
    if (identityTolerance <= 0 || identityTolerance > 50) throw new Error(`sheet_candidate_presence_identity_tolerance_out_of_range:${viewKey}`);
    const identityHueTolerance = binding.policy?.point_hue_tolerance_degrees === undefined
      ? 30
      : finite(binding.policy.point_hue_tolerance_degrees, `sheet_candidate_presence_identity_hue_tolerance_${viewKey}`);
    if (identityHueTolerance < 0 || identityHueTolerance > 180) throw new Error(`sheet_candidate_presence_identity_hue_tolerance_out_of_range:${viewKey}`);
    for (const evidence of receipt.point_evidence ?? []) {
      const primitiveId = requiredText(evidence.primitive_id, `sheet_candidate_presence_${viewKey}_primitive_id`);
      if (candidatePresenceByPrimitive.has(primitiveId)) throw new Error(`sheet_candidate_presence_duplicate_primitive:${primitiveId}`);
      candidatePresenceByPrimitive.set(primitiveId, evidence);
      if (evidence.status === "existing_candidate_visible") {
        const u = normalized(evidence.mapped_candidate_uv?.u, `sheet_candidate_presence_${primitiveId}_candidate_u`);
        const v = normalized(evidence.mapped_candidate_uv?.v, `sheet_candidate_presence_${primitiveId}_candidate_v`);
        candidateIdentityObservations.push({
          primitive_id: primitiveId,
          source_view_key: viewKey,
          source_sheet_key: trusted.source_view.sheet_key,
          candidate_image_sha256: receipt.candidate_image.sha256,
          candidate_frame_id: receipt.candidate_image.frame_id,
          candidate_view_id: receipt.candidate_image.view_id,
          candidate_width_px: receipt.candidate_image.width_px,
          candidate_height_px: receipt.candidate_image.height_px,
          mapped_candidate_uv: { u, v },
          ...(evidence.coherent_hue_degrees === undefined ? {} : { coherent_hue_degrees: evidence.coherent_hue_degrees }),
          hue_tolerance_degrees: identityHueTolerance,
          tolerance_px: identityTolerance
        });
      }
    }
  }

  const primitives = pixelPrimitives.map((primitive, index) => {
    const id = requiredText(primitive.primitive_id, `sheet_pixel_primitive_${index}_id`);
    const trusted = trustedByKey.get(requiredText(primitive.source_view_key, `sheet_pixel_primitive_${id}_view_key`));
    if (!trusted || !selectedKeys.has(primitive.source_view_key)) throw new Error(`sheet_pixel_primitive_view_not_selected:${id}`);
    if (!Array.isArray(primitive.points) || primitive.points.length === 0) throw new Error(`sheet_pixel_primitive_points_required:${id}`);
    const rasterEvidence = rasterEvidenceByPrimitive.get(id);
    if ((primitive.kind === "route_segment" || primitive.kind === "point_symbol") && rasterEvidenceViews.has(primitive.source_view_key) && !rasterEvidence) {
      throw new Error(`sheet_pixel_raster_evidence_missing_primitive:${id}`);
    }
    const rasterGeometryCap = !rasterEvidence || rasterEvidence.status === "accepted_raster_support" ? 1 : rasterEvidence.status === "provisional_raster_support" ? 0.5 : 0;
    const candidatePresence = candidatePresenceByPrimitive.get(id);
    const candidateGeometryCap = !candidatePresence || candidatePresence.status === "not_present"
      ? 1
      : candidatePresence.status === "ambiguous_candidate_presence"
        ? 0.5
        : 0;
    const points = primitive.points.map((value, pointIndex) => framePoint(trusted.frame, value, `sheet_pixel_primitive_${id}_point_${pointIndex}`));
    const endpoints = (primitive.endpoints ?? []).map((endpoint, endpointIndex): SheetTopologyEndpointV1 => ({
      endpoint_key: qualifiedEndpointKey(id, requiredText(endpoint.endpoint_key, `sheet_pixel_primitive_${id}_endpoint_${endpointIndex}_key`)),
      point: framePoint(trusted.frame, endpoint.point, `sheet_pixel_endpoint_${endpoint.endpoint_key}_point`),
      outward_direction_xy: frameDirection(trusted.frame, endpoint.outward_direction_uv, `sheet_pixel_endpoint_${endpoint.endpoint_key}_direction`),
      boundary: endpoint.boundary,
      ...(clean(endpoint.continuation_key) ? { continuation_key: clean(endpoint.continuation_key) } : {})
    }));
    return {
      primitive_id: id,
      source_view_key: primitive.source_view_key,
      source_mark_ids: primitive.source_mark_ids,
      kind: primitive.kind,
      points,
      endpoints,
      ...(primitive.claims ? { claims: primitive.claims } : {}),
      confidence: { ...primitive.confidence, geometry: Math.min(primitive.confidence.geometry, rasterGeometryCap, candidateGeometryCap) },
      independently_reversible: primitive.kind === "route_segment" || primitive.kind === "wall_segment"
    };
  });

  const compiledTopology = compileSheetTopologyV1(
    {
      schema_version: 1,
      package_id: input.package_id,
      coordinate_space: "model_xyz_feet",
      source_views: selected.map(value => value.source_view),
      source_marks: sourceMarks,
      primitives
    },
    {
      trusted_source_views: selected.map(value => value.source_view),
      calibration_profile: context.calibration_profile,
      ...(context.policy ? { policy: context.policy } : {})
    }
  );
  const sourceRouteJunctionRepairs = compileSourceRouteJunctionRepairs(input, rasterEvidenceReceiptByView);
  deferTopologyForSourceRouteJunctionRepairs(compiledTopology, sourceRouteJunctionRepairs);
  for (const [primitiveId, evidence] of rasterEvidenceByPrimitive) {
    if (evidence.status !== "accepted_raster_support") compiledTopology.warnings.push(`raster_evidence_${evidence.status}:${primitiveId}`);
  }
  compiledTopology.warnings.push(...sourceAccountingWarnings);
  compiledTopology.warnings = [...new Set(compiledTopology.warnings)].sort();
  for (const [primitiveId, evidence] of candidatePresenceByPrimitive) {
    if (evidence.status !== "not_present") compiledTopology.warnings.push(`candidate_presence_${evidence.status}:${primitiveId}`);
  }
  const candidateIdentityGroups = compileCandidateIdentityGroups(candidateIdentityObservations);
  for (const group of candidateIdentityGroups) {
    compiledTopology.warnings.push(`candidate_identity_${group.scope}:${group.identity_group_id}:${group.members.map(member => member.primitive_id).join(",")}`);
  }

  return {
    schema_version: 1,
    pixel_interpretation_sha256: digest(input),
    trusted_context_sha256: digest(context),
    compiled_topology: compiledTopology,
    candidate_identity_groups: candidateIdentityGroups,
    source_route_junction_repairs: sourceRouteJunctionRepairs
  };
}
