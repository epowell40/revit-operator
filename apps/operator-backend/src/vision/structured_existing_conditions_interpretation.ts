import crypto from "node:crypto";
import type {
  SheetPixelInterpretationInputV1,
  SheetPixelPrimitiveV1
} from "../existing_conditions/sheet_pixel_interpretation.js";
import type {
  SheetTopologyClaimV1,
  SheetTopologySourceMarkV1
} from "../existing_conditions/sheet_topology_compiler.js";

export type ExistingConditionsInterpretationRegionV1 = {
  min_u: number;
  min_v: number;
  max_u: number;
  max_v: number;
};

export type ExistingConditionsInterpretationViewV1 = {
  view_key: string;
  analysis_role: "sheet_context" | "region_detail";
  source_artifact_sha256: string;
  source_page: number;
  image_sha256: string;
  page_region: ExistingConditionsInterpretationRegionV1;
  parent_context_view_key?: string;
  sheet_hint?: string;
  discipline_hint?: "architectural" | "mechanical" | "plumbing" | "electrical";
};

export type StructuredExistingConditionsInterpretationRequestV1 = {
  schema_version: 1;
  package_id: string;
  objective: string;
  views: ExistingConditionsInterpretationViewV1[];
  maximum_source_marks?: number;
  maximum_primitives?: number;
};

export type RawStructuredExistingConditionsInterpretationV1 = {
  schema_version: number;
  package_id: string;
  coordinate_space: string;
  view_keys: string[];
  source_marks: Array<{
    source_mark_id: string;
    source_view_key: string;
    disposition_status: "candidate" | "unresolved";
    primitive_ids: string[];
    reason: string;
  }>;
  primitives: Array<{
    primitive_id: string;
    source_view_key: string;
    source_mark_ids: string[];
    kind: SheetPixelPrimitiveV1["kind"];
    points: Array<{ u: number; v: number }>;
    endpoints: Array<{
      endpoint_key: string;
      point: { u: number; v: number };
      outward_direction_uv: [number, number];
      boundary: "internal" | "view_boundary" | "sheet_continuation";
      continuation_key: string;
      continuation_kind: "none" | "same_level_run" | "vertical_riser";
    }>;
    claims: Array<{
      attribute: "system" | "size" | "type" | "family" | "host" | "elevation" | "vertical_extent";
      value: string;
      confidence: number;
      basis: SheetTopologyClaimV1["basis"];
    }>;
    confidence: SheetPixelPrimitiveV1["confidence"];
  }>;
  open_questions: string[];
};

export type StructuredExistingConditionsInterpretationReceiptV1 = {
  schema_version: 1;
  package_id: string;
  source_binding_sha256: string;
  interpretation_sha256: string;
  native_write_allowed: false;
  views: Array<ExistingConditionsInterpretationViewV1 & {
    local_to_page_uv: { u_offset: number; v_offset: number; u_scale: number; v_scale: number };
  }>;
  page_primitives: Array<{
    primitive_id: string;
    source_view_key: string;
    source_artifact_sha256: string;
    source_page: number;
    points: Array<{ u: number; v: number }>;
    endpoints: Array<{ endpoint_key: string; point: { u: number; v: number } }>;
  }>;
};

export const STRUCTURED_EXISTING_CONDITIONS_INTERPRETATION_SCHEMA_V1 = {
  type: "object",
  required: ["schema_version", "package_id", "coordinate_space", "view_keys", "source_marks", "primitives", "open_questions"],
  properties: {
    schema_version: { type: "integer", minimum: 1, maximum: 1 },
    package_id: { type: "string" },
    coordinate_space: { type: "string", enum: ["normalized_uv_top_left"] },
    view_keys: { type: "array", items: { type: "string" } },
    source_marks: {
      type: "array",
      items: {
        type: "object",
        required: ["source_mark_id", "source_view_key", "disposition_status", "primitive_ids", "reason"],
        properties: {
          source_mark_id: { type: "string" },
          source_view_key: { type: "string" },
          disposition_status: { type: "string", enum: ["candidate", "unresolved"] },
          primitive_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" }
        }
      }
    },
    primitives: {
      type: "array",
      items: {
        type: "object",
        required: ["primitive_id", "source_view_key", "source_mark_ids", "kind", "points", "endpoints", "claims", "confidence"],
        properties: {
          primitive_id: { type: "string" },
          source_view_key: { type: "string" },
          source_mark_ids: { type: "array", items: { type: "string" } },
          kind: { type: "string", enum: ["wall_segment", "route_segment", "opening", "point_symbol", "annotation"] },
          points: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["u", "v"],
              properties: { u: { type: "number", minimum: 0, maximum: 1 }, v: { type: "number", minimum: 0, maximum: 1 } }
            }
          },
          endpoints: {
            type: "array",
            items: {
              type: "object",
              required: ["endpoint_key", "point", "outward_direction_uv", "boundary", "continuation_key", "continuation_kind"],
              properties: {
                endpoint_key: { type: "string" },
                point: {
                  type: "object",
                  required: ["u", "v"],
                  properties: { u: { type: "number", minimum: 0, maximum: 1 }, v: { type: "number", minimum: 0, maximum: 1 } }
                },
                outward_direction_uv: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
                boundary: { type: "string", enum: ["internal", "view_boundary", "sheet_continuation"] },
                continuation_key: { type: "string" },
                continuation_kind: { type: "string", enum: ["none", "same_level_run", "vertical_riser"] }
              }
            }
          },
          claims: {
            type: "array",
            items: {
              type: "object",
              required: ["attribute", "value", "confidence", "basis"],
              properties: {
                attribute: { type: "string", enum: ["system", "size", "type", "family", "host", "elevation", "vertical_extent"] },
                value: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                basis: { type: "string", enum: ["legible_source_evidence", "approved_project_mapping", "provider_hypothesis", "unresolved"] }
              }
            }
          },
          confidence: {
            type: "object",
            required: ["geometry", "classification", "topology", "visibility"],
            properties: {
              geometry: { type: "number", minimum: 0, maximum: 1 },
              classification: { type: "number", minimum: 0, maximum: 1 },
              topology: { type: "number", minimum: 0, maximum: 1 },
              visibility: { type: "number", minimum: 0, maximum: 1 }
            }
          }
        }
      }
    },
    open_questions: { type: "array", items: { type: "string" } }
  }
} as const;

function clean(value: unknown): string { return String(value ?? "").trim(); }
function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}
function unit(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label}_must_be_between_zero_and_one`);
  return value;
}
function qualifiedEndpointKey(primitiveId: string, endpointKey: unknown, label: string): string {
  const local = requiredText(endpointKey, label);
  return local.startsWith(`${primitiveId}:`) ? local : `${primitiveId}:${local}`;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
function digest(value: unknown): string { return crypto.createHash("sha256").update(canonical(value)).digest("hex"); }

function validateRegion(region: ExistingConditionsInterpretationRegionV1, label: string): ExistingConditionsInterpretationRegionV1 {
  const result = {
    min_u: unit(region?.min_u, `${label}_min_u`), min_v: unit(region?.min_v, `${label}_min_v`),
    max_u: unit(region?.max_u, `${label}_max_u`), max_v: unit(region?.max_v, `${label}_max_v`)
  };
  if (result.min_u >= result.max_u || result.min_v >= result.max_v) throw new Error(`${label}_must_have_positive_area`);
  return result;
}

function claimMap(entries: RawStructuredExistingConditionsInterpretationV1["primitives"][number]["claims"], primitiveId: string): SheetPixelPrimitiveV1["claims"] {
  const result: NonNullable<SheetPixelPrimitiveV1["claims"]> = {};
  for (const [index, entry] of entries.entries()) {
    const attribute = entry.attribute;
    if (!["system", "size", "type", "family", "host", "elevation", "vertical_extent"].includes(attribute)) throw new Error(`structured_sheet_claim_attribute_invalid:${primitiveId}:${index}`);
    if (result[attribute]) throw new Error(`structured_sheet_claim_attribute_duplicate:${primitiveId}:${attribute}`);
    result[attribute] = {
      value: requiredText(entry.value, `structured_sheet_claim_${primitiveId}_${attribute}_value`),
      confidence: unit(entry.confidence, `structured_sheet_claim_${primitiveId}_${attribute}_confidence`),
      basis: entry.basis
    };
  }
  return result;
}

export function normalizeStructuredExistingConditionsInterpretationV1(args: {
  request: StructuredExistingConditionsInterpretationRequestV1;
  raw: unknown;
}): { interpretation: SheetPixelInterpretationInputV1; open_questions: string[]; receipt: StructuredExistingConditionsInterpretationReceiptV1 } {
  if (!args.raw || typeof args.raw !== "object" || Array.isArray(args.raw)) throw new Error("structured_sheet_response_must_be_object");
  if (!args.request || args.request.schema_version !== 1) throw new Error("structured_sheet_request_requires_schema_v1");
  const raw = args.raw as RawStructuredExistingConditionsInterpretationV1;
  if (raw.schema_version !== 1) throw new Error("structured_sheet_response_requires_schema_v1");
  if (clean(raw.package_id) !== clean(args.request.package_id)) throw new Error("structured_sheet_response_package_mismatch");
  if (raw.coordinate_space !== "normalized_uv_top_left") throw new Error("structured_sheet_response_coordinate_space_invalid");
  if (!Array.isArray(args.request.views) || args.request.views.length === 0) throw new Error("structured_sheet_request_views_required");
  const views = args.request.views.map((view, index) => ({
    ...view,
    view_key: requiredText(view.view_key, `structured_sheet_request_view_${index}_key`),
    source_artifact_sha256: requiredText(view.source_artifact_sha256, `structured_sheet_request_view_${index}_source_artifact_sha256`).toLowerCase(),
    image_sha256: requiredText(view.image_sha256, `structured_sheet_request_view_${index}_image_sha256`).toLowerCase(),
    page_region: validateRegion(view.page_region, `structured_sheet_request_view_${index}_region`)
  }));
  if (new Set(views.map(view => view.view_key)).size !== views.length) throw new Error("structured_sheet_request_duplicate_view_key");
  for (const view of views) {
    if (!/^[a-f0-9]{64}$/.test(view.source_artifact_sha256) || !/^[a-f0-9]{64}$/.test(view.image_sha256)) throw new Error(`structured_sheet_request_view_hash_invalid:${view.view_key}`);
    if (!Number.isSafeInteger(view.source_page) || view.source_page < 1) throw new Error(`structured_sheet_request_view_page_invalid:${view.view_key}`);
    if (view.analysis_role === "sheet_context") {
      if (view.parent_context_view_key) throw new Error(`structured_sheet_context_view_cannot_have_parent:${view.view_key}`);
      if (view.page_region.min_u !== 0 || view.page_region.min_v !== 0 || view.page_region.max_u !== 1 || view.page_region.max_v !== 1) throw new Error(`structured_sheet_context_view_must_cover_full_page:${view.view_key}`);
    } else if (view.analysis_role === "region_detail") {
      const parent = views.find(candidate => candidate.view_key === clean(view.parent_context_view_key));
      if (!parent || parent.analysis_role !== "sheet_context") throw new Error(`structured_sheet_detail_parent_context_invalid:${view.view_key}`);
      if (parent.source_artifact_sha256 !== view.source_artifact_sha256 || parent.source_page !== view.source_page) throw new Error(`structured_sheet_detail_parent_source_mismatch:${view.view_key}`);
    } else throw new Error(`structured_sheet_request_view_role_invalid:${view.view_key}`);
  }
  const detailViewKeys = views.filter(view => view.analysis_role === "region_detail").map(view => view.view_key);
  if (detailViewKeys.length === 0) throw new Error("structured_sheet_region_detail_view_required");
  const requestedViewKeys = views.map(view => view.view_key);
  if (!Array.isArray(raw.view_keys) || raw.view_keys.length !== requestedViewKeys.length || new Set(raw.view_keys.map(clean)).size !== requestedViewKeys.length || raw.view_keys.some(key => !requestedViewKeys.includes(clean(key)))) throw new Error("structured_sheet_response_view_keys_mismatch");
  const allowedDetailKeys = new Set(detailViewKeys);
  const maximumMarks = args.request.maximum_source_marks ?? 500;
  const maximumPrimitives = args.request.maximum_primitives ?? 500;
  if (!Array.isArray(raw.source_marks) || raw.source_marks.length === 0 || raw.source_marks.length > maximumMarks) throw new Error("structured_sheet_response_source_mark_count_invalid");
  if (!Array.isArray(raw.primitives) || raw.primitives.length > maximumPrimitives) throw new Error("structured_sheet_response_primitive_count_invalid");

  const sourceMarks: SheetTopologySourceMarkV1[] = raw.source_marks.map((mark, index) => {
    const markId = requiredText(mark.source_mark_id, `structured_sheet_mark_${index}_id`);
    const viewKey = requiredText(mark.source_view_key, `structured_sheet_mark_${markId}_view_key`);
    if (!allowedDetailKeys.has(viewKey)) throw new Error(`structured_sheet_mark_requires_region_detail:${markId}`);
    if (mark.disposition_status === "candidate") {
      if (!Array.isArray(mark.primitive_ids) || mark.primitive_ids.length === 0) throw new Error(`structured_sheet_candidate_mark_requires_primitive:${markId}`);
      return { source_mark_id: markId, source_view_key: viewKey, disposition: { status: "candidate", primitive_ids: mark.primitive_ids.map(value => requiredText(value, `structured_sheet_mark_${markId}_primitive_id`)) } };
    }
    if (mark.disposition_status !== "unresolved") throw new Error(`structured_sheet_mark_disposition_invalid:${markId}`);
    return { source_mark_id: markId, source_view_key: viewKey, disposition: { status: "unresolved", reason: requiredText(mark.reason, `structured_sheet_mark_${markId}_reason`) } };
  });

  const normalizationQuestions: string[] = [];
  const primitives: SheetPixelPrimitiveV1[] = raw.primitives.map((primitive, index) => {
    const primitiveId = requiredText(primitive.primitive_id, `structured_sheet_primitive_${index}_id`);
    const viewKey = requiredText(primitive.source_view_key, `structured_sheet_primitive_${primitiveId}_view_key`);
    if (!allowedDetailKeys.has(viewKey)) throw new Error(`structured_sheet_primitive_requires_region_detail:${primitiveId}`);
    if (!Array.isArray(primitive.points) || primitive.points.length === 0) throw new Error(`structured_sheet_primitive_points_required:${primitiveId}`);
    const points = primitive.points.map((point, pointIndex) => ({ u: unit(point.u, `structured_sheet_primitive_${primitiveId}_point_${pointIndex}_u`), v: unit(point.v, `structured_sheet_primitive_${primitiveId}_point_${pointIndex}_v`) }));
    const endpoints = (primitive.endpoints ?? []).map((endpoint, endpointIndex) => ({
      endpoint_key: qualifiedEndpointKey(primitiveId, endpoint.endpoint_key, `structured_sheet_primitive_${primitiveId}_endpoint_${endpointIndex}_key`),
      point: { u: unit(endpoint.point?.u, `structured_sheet_endpoint_${primitiveId}_${endpointIndex}_u`), v: unit(endpoint.point?.v, `structured_sheet_endpoint_${primitiveId}_${endpointIndex}_v`) },
      outward_direction_uv: endpoint.outward_direction_uv,
      boundary: endpoint.boundary,
      ...(clean(endpoint.continuation_key) ? { continuation_key: clean(endpoint.continuation_key) } : {}),
      ...(endpoint.continuation_kind !== "none" ? { continuation_kind: endpoint.continuation_kind } : {})
    }));
    if (new Set(endpoints.map(endpoint => endpoint.endpoint_key)).size !== endpoints.length) throw new Error(`structured_sheet_primitive_duplicate_endpoint_key:${primitiveId}`);
    if (endpoints.length > 0 && !["route_segment", "wall_segment"].includes(primitive.kind)) throw new Error(`structured_sheet_non_linear_primitive_cannot_have_endpoints:${primitiveId}`);
    const claims = claimMap(primitive.claims ?? [], primitiveId) ?? {};
    let classificationConfidence = unit(primitive.confidence?.classification, `structured_sheet_primitive_${primitiveId}_classification_confidence`);
    if (primitive.kind === "point_symbol") {
      for (const attribute of ["family", "type", "host"] as const) {
        const materialClaim = claims[attribute];
        if (!materialClaim || materialClaim.basis !== "legible_source_evidence") continue;
        claims[attribute] = { ...materialClaim, confidence: Math.min(materialClaim.confidence, 0.5), basis: "provider_hypothesis" };
        classificationConfidence = Math.min(classificationConfidence, 0.5);
        normalizationQuestions.push(`Point symbol ${primitiveId} ${attribute} is graphical-only and requires a legible annotation or approved project mapping.`);
      }
      const materialClaims = (["family", "type", "host"] as const).map(attribute => claims[attribute]);
      if (materialClaims.some(materialClaim => !materialClaim || materialClaim.basis === "provider_hypothesis" || materialClaim.basis === "unresolved")) {
        classificationConfidence = Math.min(classificationConfidence, 0.5);
        normalizationQuestions.push(`Point symbol ${primitiveId} classification remains provisional until family, type, and host are source-grounded or project-mapped.`);
      }
    }
    return {
      primitive_id: primitiveId, source_view_key: viewKey,
      source_mark_ids: primitive.source_mark_ids.map(value => requiredText(value, `structured_sheet_primitive_${primitiveId}_source_mark`)),
      kind: primitive.kind, points, endpoints, claims,
      confidence: {
        geometry: unit(primitive.confidence?.geometry, `structured_sheet_primitive_${primitiveId}_geometry_confidence`),
        classification: classificationConfidence,
        topology: unit(primitive.confidence?.topology, `structured_sheet_primitive_${primitiveId}_topology_confidence`),
        visibility: unit(primitive.confidence?.visibility, `structured_sheet_primitive_${primitiveId}_visibility_confidence`)
      }
    };
  });

  const marksById = new Map<string, SheetTopologySourceMarkV1>();
  for (const mark of sourceMarks) { if (marksById.has(mark.source_mark_id)) throw new Error(`structured_sheet_duplicate_source_mark:${mark.source_mark_id}`); marksById.set(mark.source_mark_id, mark); }
  const primitivesById = new Map<string, SheetPixelPrimitiveV1>();
  for (const primitive of primitives) { if (primitivesById.has(primitive.primitive_id)) throw new Error(`structured_sheet_duplicate_primitive:${primitive.primitive_id}`); primitivesById.set(primitive.primitive_id, primitive); }
  for (const mark of sourceMarks) {
    if (mark.disposition.status !== "candidate") continue;
    for (const primitiveId of mark.disposition.primitive_ids) {
      const primitive = primitivesById.get(primitiveId);
      if (!primitive) throw new Error(`structured_sheet_mark_unknown_primitive:${mark.source_mark_id}:${primitiveId}`);
      if (primitive.source_view_key !== mark.source_view_key) throw new Error(`structured_sheet_mark_primitive_view_mismatch:${mark.source_mark_id}:${primitiveId}`);
      if (!primitive.source_mark_ids.includes(mark.source_mark_id)) { primitive.source_mark_ids.push(mark.source_mark_id); normalizationQuestions.push(`Normalized reciprocal source-mark linkage ${mark.source_mark_id} -> ${primitiveId}.`); }
    }
  }
  for (const primitive of primitives) {
    for (const markId of primitive.source_mark_ids) {
      const mark = marksById.get(markId);
      if (!mark) throw new Error(`structured_sheet_primitive_unknown_source_mark:${primitive.primitive_id}:${markId}`);
      if (mark.source_view_key !== primitive.source_view_key) throw new Error(`structured_sheet_primitive_source_mark_view_mismatch:${primitive.primitive_id}:${markId}`);
      if (mark.disposition.status !== "candidate") throw new Error(`structured_sheet_primitive_cites_unresolved_source_mark:${primitive.primitive_id}:${markId}`);
      if (!mark.disposition.primitive_ids.includes(primitive.primitive_id)) { mark.disposition.primitive_ids.push(primitive.primitive_id); normalizationQuestions.push(`Normalized reciprocal primitive-mark linkage ${primitive.primitive_id} -> ${markId}.`); }
    }
  }
  for (const mark of sourceMarks) if (mark.disposition.status === "candidate") mark.disposition.primitive_ids = [...new Set(mark.disposition.primitive_ids)].sort();
  for (const primitive of primitives) primitive.source_mark_ids = [...new Set(primitive.source_mark_ids)].sort();
  const interpretation: SheetPixelInterpretationInputV1 = { schema_version: 1, package_id: args.request.package_id, coordinate_space: "normalized_uv_top_left", view_keys: detailViewKeys, source_marks: sourceMarks, primitives };
  const boundViews = views.map(view => ({ ...view, local_to_page_uv: { u_offset: view.page_region.min_u, v_offset: view.page_region.min_v, u_scale: view.page_region.max_u - view.page_region.min_u, v_scale: view.page_region.max_v - view.page_region.min_v } }));
  const viewByKey = new Map(boundViews.map(view => [view.view_key, view]));
  const mapPoint = (view: typeof boundViews[number], point: { u: number; v: number }) => ({ u: Number((view.local_to_page_uv.u_offset + point.u * view.local_to_page_uv.u_scale).toFixed(9)), v: Number((view.local_to_page_uv.v_offset + point.v * view.local_to_page_uv.v_scale).toFixed(9)) });
  const pagePrimitives = primitives.map(primitive => {
    const view = viewByKey.get(primitive.source_view_key)!;
    return { primitive_id: primitive.primitive_id, source_view_key: primitive.source_view_key, source_artifact_sha256: view.source_artifact_sha256, source_page: view.source_page, points: primitive.points.map(point => mapPoint(view, point)), endpoints: (primitive.endpoints ?? []).map(endpoint => ({ endpoint_key: endpoint.endpoint_key, point: mapPoint(view, endpoint.point) })) };
  });
  const receipt: StructuredExistingConditionsInterpretationReceiptV1 = {
    schema_version: 1, package_id: args.request.package_id,
    source_binding_sha256: digest(boundViews), interpretation_sha256: digest(interpretation),
    native_write_allowed: false, views: boundViews, page_primitives: pagePrimitives
  };
  return { interpretation, open_questions: [...new Set([...(Array.isArray(raw.open_questions) ? raw.open_questions.map(value => clean(value)).filter(Boolean) : []), ...normalizationQuestions])].slice(0, 200), receipt };
}
