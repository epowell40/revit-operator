import crypto from "node:crypto";
import type {
  SheetPixelEndpointV1,
  SheetPixelInterpretationInputV1,
  SheetPixelPointV1,
  SheetPixelPrimitiveV1
} from "./sheet_pixel_interpretation.js";
import type { SheetTopologyTrustedContinuationV1 } from "./sheet_topology_compiler.js";

export type SheetContinuationAttachmentSourceViewV1 = {
  view_key: string;
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
};

export type SheetContinuationAttachmentPolicyV1 = {
  endpoint_vertex_tolerance_px: number;
  marker_coincidence_tolerance_px: number;
  leader_endpoint_tolerance_px: number;
  minimum_attachment_path_length_px: number;
  maximum_attachment_path_length_px: number;
};

export type SheetContinuationAttachmentInputV1 = {
  schema_version: 1;
  package_id: string;
  interpretation: SheetPixelInterpretationInputV1;
  source_views: SheetContinuationAttachmentSourceViewV1[];
  trusted_continuations: SheetTopologyTrustedContinuationV1[];
  trusted_marker_primitive_id_by_endpoint_key?: Record<string, string>;
  policy?: Partial<SheetContinuationAttachmentPolicyV1>;
};

export type SheetContinuationAttachmentBindingV1 = {
  continuation_key: string;
  endpoint_key: string;
  primitive_id: string;
  source_view_key: string;
  source_image_sha256: string;
  continuation_evidence_sha256: string;
  symbol_point_uv: SheetPixelPointV1;
  route_attachment_point_uv: SheetPixelPointV1 | null;
  attachment_path_uv: SheetPixelPointV1[];
  attachment_path_length_px: number | null;
  shared_marker_primitive_id: string | null;
  marker_binding_basis: "host_trusted_exact_marker" | "shared_source_mark" | null;
  supporting_leader_primitive_ids: string[];
  status: "source_route_attachment_resolved" | "deferred";
  blockers: string[];
  native_write_allowed: false;
};

export type SheetContinuationAttachmentReceiptV1 = {
  schema: "operator.sheet_continuation_attachment.v1";
  package_id: string;
  interpretation_sha256: string;
  trusted_continuation_evidence_sha256s: string[];
  policy: SheetContinuationAttachmentPolicyV1;
  bindings: SheetContinuationAttachmentBindingV1[];
  status: "resolved_for_native_frontier_search" | "clarification_required";
  exact_next_repair: "read_native_frontiers_at_source_route_attachment_points" | "repair_source_continuation_attachment_ambiguity";
  native_write_allowed: false;
  capability_boundary: string;
};

const DEFAULT_POLICY: SheetContinuationAttachmentPolicyV1 = {
  endpoint_vertex_tolerance_px: 3,
  marker_coincidence_tolerance_px: 12,
  leader_endpoint_tolerance_px: 40,
  minimum_attachment_path_length_px: 3,
  maximum_attachment_path_length_px: 160
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

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0 || result > 20_000) throw new Error(`${label}_must_be_positive_integer`);
  return result;
}

function bounded(value: unknown, fallback: number, label: string, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${label}_out_of_range`);
  return result;
}

function point(value: SheetPixelPointV1, label: string): SheetPixelPointV1 {
  const u = Number(value?.u);
  const v = Number(value?.v);
  if (!Number.isFinite(u) || u < 0 || u > 1 || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`${label}_must_be_normalized_uv`);
  }
  return { u, v };
}

function pixelDistance(
  left: SheetPixelPointV1,
  right: SheetPixelPointV1,
  view: SheetContinuationAttachmentSourceViewV1
): number {
  return Math.hypot(
    (left.u - right.u) * view.source_image_width_px,
    (left.v - right.v) * view.source_image_height_px
  );
}

function endpointRecord(
  interpretation: SheetPixelInterpretationInputV1,
  endpointKey: string
): { primitive: SheetPixelPrimitiveV1; endpoint: SheetPixelEndpointV1 } | null {
  const matches = interpretation.primitives.flatMap(primitive =>
    (primitive.endpoints ?? [])
      .filter(endpoint => clean(endpoint.endpoint_key) === endpointKey)
      .map(endpoint => ({ primitive, endpoint }))
  );
  if (matches.length > 1) throw new Error(`sheet_continuation_attachment_duplicate_endpoint:${endpointKey}`);
  return matches[0] ?? null;
}

function adjacentRouteVertex(args: {
  primitive: SheetPixelPrimitiveV1;
  endpoint: SheetPixelEndpointV1;
  view: SheetContinuationAttachmentSourceViewV1;
  tolerancePx: number;
}): { point: SheetPixelPointV1; path: SheetPixelPointV1[] } | null {
  if (args.primitive.kind !== "route_segment" || args.primitive.points.length < 2) return null;
  const points = args.primitive.points.map((value, index) => point(value, `sheet_continuation_attachment_${args.primitive.primitive_id}_point_${index}`));
  const endpointPoint = point(args.endpoint.point, `sheet_continuation_attachment_${args.endpoint.endpoint_key}_point`);
  const atStart = pixelDistance(endpointPoint, points[0]!, args.view) <= args.tolerancePx;
  const atEnd = pixelDistance(endpointPoint, points[points.length - 1]!, args.view) <= args.tolerancePx;
  if (atStart === atEnd) return null;
  return atStart
    ? { point: points[1]!, path: [endpointPoint, points[1]!] }
    : { point: points[points.length - 2]!, path: [endpointPoint, points[points.length - 2]!] };
}

function sharesSourceMark(left: SheetPixelPrimitiveV1, right: SheetPixelPrimitiveV1): boolean {
  const marks = new Set(left.source_mark_ids.map(clean).filter(Boolean));
  return right.source_mark_ids.some(value => marks.has(clean(value)));
}

function leaderPrimitiveIds(args: {
  interpretation: SheetPixelInterpretationInputV1;
  primitive: SheetPixelPrimitiveV1;
  symbolPoint: SheetPixelPointV1;
  attachmentPoint: SheetPixelPointV1;
  view: SheetContinuationAttachmentSourceViewV1;
  tolerancePx: number;
}): string[] {
  return args.interpretation.primitives.filter(candidate => {
    if (candidate.source_view_key !== args.primitive.source_view_key || candidate.kind !== "annotation" || candidate.points.length < 2) return false;
    if (clean(candidate.claims?.type?.value).toLowerCase() !== "leader") return false;
    if (!sharesSourceMark(args.primitive, candidate)) return false;
    return candidate.points.some((value, index) => {
      const candidatePoint = point(value, `sheet_continuation_attachment_${candidate.primitive_id}_leader_point_${index}`);
      return Math.min(
        pixelDistance(candidatePoint, args.symbolPoint, args.view),
        pixelDistance(candidatePoint, args.attachmentPoint, args.view)
      ) <= args.tolerancePx;
    });
  }).map(value => value.primitive_id).sort();
}

export function resolveSheetContinuationAttachmentsV1(
  input: SheetContinuationAttachmentInputV1
): SheetContinuationAttachmentReceiptV1 {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) {
    throw new Error("sheet_continuation_attachment_requires_schema_v1");
  }
  const packageId = requiredText(input.package_id, "sheet_continuation_attachment_package_id");
  if (input.interpretation?.schema_version !== 1 || input.interpretation.coordinate_space !== "normalized_uv_top_left") {
    throw new Error("sheet_continuation_attachment_requires_normalized_interpretation_v1");
  }
  if (clean(input.interpretation.package_id) !== packageId) throw new Error("sheet_continuation_attachment_package_id_mismatch");
  const policy: SheetContinuationAttachmentPolicyV1 = {
    endpoint_vertex_tolerance_px: bounded(input.policy?.endpoint_vertex_tolerance_px, DEFAULT_POLICY.endpoint_vertex_tolerance_px, "sheet_continuation_attachment_endpoint_vertex_tolerance_px", 0, 100),
    marker_coincidence_tolerance_px: bounded(input.policy?.marker_coincidence_tolerance_px, DEFAULT_POLICY.marker_coincidence_tolerance_px, "sheet_continuation_attachment_marker_coincidence_tolerance_px", 0, 250),
    leader_endpoint_tolerance_px: bounded(input.policy?.leader_endpoint_tolerance_px, DEFAULT_POLICY.leader_endpoint_tolerance_px, "sheet_continuation_attachment_leader_endpoint_tolerance_px", 0, 500),
    minimum_attachment_path_length_px: bounded(input.policy?.minimum_attachment_path_length_px, DEFAULT_POLICY.minimum_attachment_path_length_px, "sheet_continuation_attachment_minimum_attachment_path_length_px", 0, 500),
    maximum_attachment_path_length_px: bounded(input.policy?.maximum_attachment_path_length_px, DEFAULT_POLICY.maximum_attachment_path_length_px, "sheet_continuation_attachment_maximum_attachment_path_length_px", 0, 2000)
  };
  if (policy.maximum_attachment_path_length_px < policy.minimum_attachment_path_length_px) {
    throw new Error("sheet_continuation_attachment_path_length_range_invalid");
  }

  const views = new Map<string, SheetContinuationAttachmentSourceViewV1>();
  for (const [index, raw] of (input.source_views ?? []).entries()) {
    const viewKey = requiredText(raw?.view_key, `sheet_continuation_attachment_source_view_${index}_key`);
    if (views.has(viewKey)) throw new Error(`sheet_continuation_attachment_duplicate_source_view:${viewKey}`);
    views.set(viewKey, {
      view_key: viewKey,
      source_image_sha256: sha256(raw.source_image_sha256, `sheet_continuation_attachment_source_view_${viewKey}_sha256`),
      source_image_width_px: positiveInteger(raw.source_image_width_px, `sheet_continuation_attachment_source_view_${viewKey}_width`),
      source_image_height_px: positiveInteger(raw.source_image_height_px, `sheet_continuation_attachment_source_view_${viewKey}_height`)
    });
  }

  const trustedKeys = new Set<string>();
  const bindings: SheetContinuationAttachmentBindingV1[] = [];
  const evidenceHashes = new Set<string>();
  for (const [trustedIndex, trusted] of (input.trusted_continuations ?? []).entries()) {
    const continuationKey = requiredText(trusted?.continuation_key, `sheet_continuation_attachment_trusted_${trustedIndex}_key`);
    if (trustedKeys.has(continuationKey)) throw new Error(`sheet_continuation_attachment_duplicate_trusted_continuation:${continuationKey}`);
    trustedKeys.add(continuationKey);
    if (trusted.continuation_kind !== "vertical_riser") continue;
    const evidenceSha = sha256(trusted.evidence_sha256, `sheet_continuation_attachment_trusted_${continuationKey}_evidence_sha256`);
    evidenceHashes.add(evidenceSha);
    if (!Array.isArray(trusted.endpoint_keys) || trusted.endpoint_keys.length !== 2) {
      throw new Error(`sheet_continuation_attachment_trusted_${continuationKey}_endpoint_pair_required`);
    }
    for (const rawEndpointKey of trusted.endpoint_keys) {
      const endpointKey = requiredText(rawEndpointKey, `sheet_continuation_attachment_trusted_${continuationKey}_endpoint_key`);
      const record = endpointRecord(input.interpretation, endpointKey);
      const blockers: string[] = [];
      if (!record) {
        bindings.push({
          continuation_key: continuationKey,
          endpoint_key: endpointKey,
          primitive_id: "",
          source_view_key: "",
          source_image_sha256: "",
          continuation_evidence_sha256: evidenceSha,
          symbol_point_uv: { u: 0, v: 0 },
          route_attachment_point_uv: null,
          attachment_path_uv: [],
          attachment_path_length_px: null,
          shared_marker_primitive_id: null,
          marker_binding_basis: null,
          supporting_leader_primitive_ids: [],
          status: "deferred",
          blockers: ["trusted_endpoint_not_found"],
          native_write_allowed: false
        });
        continue;
      }
      const { primitive, endpoint } = record;
      const view = views.get(primitive.source_view_key);
      const symbolPoint = point(endpoint.point, `sheet_continuation_attachment_${endpointKey}_point`);
      if (!view) blockers.push("source_view_dimensions_not_registered");
      if (clean(endpoint.continuation_key) !== continuationKey) blockers.push("continuation_key_mismatch");
      if (endpoint.continuation_kind !== "vertical_riser") blockers.push("endpoint_not_vertical_riser");
      if (endpoint.boundary !== "sheet_continuation") blockers.push("endpoint_not_sheet_continuation");
      if (primitive.kind !== "route_segment") blockers.push("continuation_endpoint_not_on_route_segment");

      const adjacent = view ? adjacentRouteVertex({
        primitive,
        endpoint,
        view,
        tolerancePx: policy.endpoint_vertex_tolerance_px
      }) : null;
      if (!adjacent) blockers.push("continuation_endpoint_not_at_unique_route_end");
      const attachmentLength = adjacent && view ? pixelDistance(symbolPoint, adjacent.point, view) : null;
      if (attachmentLength !== null && attachmentLength < policy.minimum_attachment_path_length_px) blockers.push("attachment_path_too_short");
      if (attachmentLength !== null && attachmentLength > policy.maximum_attachment_path_length_px) blockers.push("attachment_path_too_long");

      const trustedMarkerId = clean(input.trusted_marker_primitive_id_by_endpoint_key?.[endpointKey]);
      const markerCandidates = view ? input.interpretation.primitives.filter(candidate =>
        candidate.source_view_key === primitive.source_view_key
        && candidate.kind === "point_symbol"
        && candidate.points.length === 1
        && (trustedMarkerId ? candidate.primitive_id === trustedMarkerId : sharesSourceMark(primitive, candidate))
        && pixelDistance(
          symbolPoint,
          point(candidate.points[0]!, `sheet_continuation_attachment_${candidate.primitive_id}_marker_point`),
          view
        ) <= policy.marker_coincidence_tolerance_px
      ) : [];
      if (markerCandidates.length === 0) blockers.push(trustedMarkerId
        ? "host_trusted_continuation_marker_not_found_or_not_coincident"
        : "shared_source_continuation_marker_not_found");
      if (markerCandidates.length > 1) blockers.push(trustedMarkerId
        ? "host_trusted_continuation_marker_ambiguous"
        : "shared_source_continuation_marker_ambiguous");
      const marker = markerCandidates.length === 1 ? markerCandidates[0]! : null;
      const leaders = view && adjacent ? leaderPrimitiveIds({
        interpretation: input.interpretation,
        primitive,
        symbolPoint,
        attachmentPoint: adjacent.point,
        view,
        tolerancePx: policy.leader_endpoint_tolerance_px
      }) : [];
      bindings.push({
        continuation_key: continuationKey,
        endpoint_key: endpointKey,
        primitive_id: primitive.primitive_id,
        source_view_key: primitive.source_view_key,
        source_image_sha256: view?.source_image_sha256 ?? "",
        continuation_evidence_sha256: evidenceSha,
        symbol_point_uv: symbolPoint,
        route_attachment_point_uv: blockers.length === 0 && adjacent ? adjacent.point : null,
        attachment_path_uv: adjacent?.path ?? [],
        attachment_path_length_px: attachmentLength,
        shared_marker_primitive_id: marker?.primitive_id ?? null,
        marker_binding_basis: marker ? (trustedMarkerId ? "host_trusted_exact_marker" : "shared_source_mark") : null,
        supporting_leader_primitive_ids: leaders,
        status: blockers.length === 0 ? "source_route_attachment_resolved" : "deferred",
        blockers,
        native_write_allowed: false
      });
    }
  }
  bindings.sort((left, right) => left.endpoint_key.localeCompare(right.endpoint_key));
  const resolved = bindings.length > 0 && bindings.every(binding => binding.status === "source_route_attachment_resolved");
  return {
    schema: "operator.sheet_continuation_attachment.v1",
    package_id: packageId,
    interpretation_sha256: digest(input.interpretation),
    trusted_continuation_evidence_sha256s: [...evidenceHashes].sort(),
    policy,
    bindings,
    status: resolved ? "resolved_for_native_frontier_search" : "clarification_required",
    exact_next_repair: resolved
      ? "read_native_frontiers_at_source_route_attachment_points"
      : "repair_source_continuation_attachment_ambiguity",
    native_write_allowed: false,
    capability_boundary: "This receipt moves a native-search anchor only from a trusted continuation symbol to the adjacent source-interpreted route vertex. It does not prove system, size, elevation, native identity, connector availability, or permission to write."
  };
}
