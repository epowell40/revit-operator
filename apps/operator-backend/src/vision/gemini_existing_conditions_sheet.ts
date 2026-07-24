import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  SheetPixelInterpretationInputV1,
  SheetPixelPrimitiveV1
} from "../existing_conditions/sheet_pixel_interpretation.js";
import type { SheetTopologyClaimV1, SheetTopologySourceMarkV1 } from "../existing_conditions/sheet_topology_compiler.js";

export type GeminiExistingConditionsSheetRequestV1 = {
  schema_version: 1;
  package_id: string;
  objective: string;
  views: Array<{
    view_key: string;
    image_path: string;
    sheet_hint?: string;
    discipline_hint?: "architectural" | "mechanical" | "plumbing" | "electrical";
  }>;
  maximum_source_marks?: number;
  maximum_primitives?: number;
  maximum_output_tokens?: number;
  thinking_level?: "minimal" | "low" | "medium" | "high";
  timeout_ms?: number;
};

export type GeminiExistingConditionsSheetResponseV1 = {
  schema_version: 1;
  provider: "gemini";
  model: string;
  package_id: string;
  source_image_sha256_by_view: Record<string, string>;
  raw_response_sha256: string;
  attempt_count: number;
  thinking_level?: "minimal" | "low" | "medium" | "high";
  repair?: {
    trigger_error: string;
    first_raw_response_sha256: string;
    first_raw_response: GeminiExistingConditionsRawResponseCaptureV1;
  };
  interpretation: SheetPixelInterpretationInputV1;
  open_questions: string[];
};

export type GeminiExistingConditionsRawResponseCaptureV1 = {
  schema_version: 1;
  provider: "gemini";
  model: string;
  package_id: string;
  raw_response_sha256: string;
  attempt: number;
  repair_of_raw_response_sha256?: string;
  thinking_level?: "minimal" | "low" | "medium" | "high";
  normalization_error?: string;
  raw_text: string;
  parsed: unknown | null;
  parse_error?: string;
  provider_finish_reasons: string[];
  provider_usage_metadata?: unknown;
};

type RawGeminiSheetResponse = {
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

export const GEMINI_EXISTING_CONDITIONS_SHEET_RESPONSE_SCHEMA_V1 = {
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

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

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

function sha256Buffer(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function mimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".pdf") return "application/pdf";
  throw new Error(`gemini_sheet_interpreter_file_type_unsupported:${extension}`);
}

function prompt(request: GeminiExistingConditionsSheetRequestV1): string {
  const lines = [
    "Analyze these registered architectural/MEP source views for existing-conditions reconstruction.",
    "Return every in-scope visible source mark exactly once as candidate or unresolved. Never silently omit a mark.",
    "Before finalizing, scan each supplied view systematically from top-left to bottom-right and account for every in-scope line, symbol, fitting glyph, label, leader, and boundary continuation that can affect the objective.",
    "Use normalized top-left UV coordinates within each supplied view. Do not emit model coordinates or Revit IDs.",
    "Preserve long-run continuity: give matching continuation_key values only when two crop/sheet boundary endpoints visibly represent the same run.",
    "Set continuation_kind to same_level_run for an ordinary continuation. Use vertical_riser only when reciprocal, directly legible above/below/next-level source evidence is visibly bound to the exact endpoint pair; the deterministic host will still require its own hash-bound evidence receipt.",
    "Do not infer system, size, type, family, host, elevation, or wall height from graphical proximity. Use legible_source_evidence only for visible text/geometry and provider_hypothesis or unresolved otherwise.",
    "A route_segment or wall_segment is one straight source-supported span. Break bends and branches into separate primitives with explicit endpoints.",
    "Only route_segment and wall_segment primitives may carry topology endpoints. Point symbols, equipment symbols, openings, and annotations must emit an empty endpoints array even when graphically coincident with a route endpoint.",
    "Treat a repeated dashed or broken line pattern as one continuous straight span when the collinear marks visibly form one drafting line; do not emit one primitive per dash. Split at visible bends, branches, system or size changes, and view boundaries.",
    "Text, tags, leaders, and dimensions are annotation primitives, not modeled devices or routes.",
    "A graphical point-symbol glyph alone never proves native family, type, or host. Unless directly legible text in the supplied crop proves the attribute, report those claims as provider_hypothesis or unresolved; an approved project mapping can be applied only by the deterministic host later.",
    "For internal endpoints continuation_key must be an empty string and continuation_kind must be none. For sheet_continuation endpoints continuation_key must be non-empty and continuation_kind must be same_level_run or vertical_riser.",
    `Objective: ${requiredText(request.objective, "gemini_sheet_interpreter_objective")}`,
    `Package: ${requiredText(request.package_id, "gemini_sheet_interpreter_package_id")}`,
    `Maximum source marks: ${request.maximum_source_marks ?? 500}`,
    `Maximum primitives: ${request.maximum_primitives ?? 500}`,
    "Supplied views:"
  ];
  for (const view of request.views) {
    lines.push(JSON.stringify({ view_key: view.view_key, sheet_hint: view.sheet_hint ?? "", discipline_hint: view.discipline_hint ?? "" }));
  }
  return lines.join("\n");
}

function repairPrompt(error: string): string {
  return [
    "The prior structured response failed strict host parsing or normalization.",
    `Exact validation error: ${error}`,
    "Return the complete corrected response, not a patch.",
    "The response must be one complete, valid JSON object and must not be truncated.",
    "Preserve source-grounded geometry and claims, but repair every invalid reference or field.",
    "Every candidate source mark primitive_ids entry must name an emitted primitive, and every primitive source_mark_ids entry must name an emitted candidate source mark in the same view.",
    "Before returning, verify reciprocal referential integrity across the entire response."
  ].join("\n");
}

function claimMap(entries: RawGeminiSheetResponse["primitives"][number]["claims"], primitiveId: string): SheetPixelPrimitiveV1["claims"] {
  const result: NonNullable<SheetPixelPrimitiveV1["claims"]> = {};
  for (const [index, entry] of entries.entries()) {
    const attribute = entry.attribute;
    if (!["system", "size", "type", "family", "host", "elevation", "vertical_extent"].includes(attribute)) throw new Error(`gemini_sheet_claim_attribute_invalid:${primitiveId}:${index}`);
    if (result[attribute]) throw new Error(`gemini_sheet_claim_attribute_duplicate:${primitiveId}:${attribute}`);
    result[attribute] = {
      value: requiredText(entry.value, `gemini_sheet_claim_${primitiveId}_${attribute}_value`),
      confidence: unit(entry.confidence, `gemini_sheet_claim_${primitiveId}_${attribute}_confidence`),
      basis: entry.basis
    };
  }
  return result;
}

export function normalizeGeminiExistingConditionsSheetResponseV1(args: {
  request: GeminiExistingConditionsSheetRequestV1;
  raw: unknown;
}): { interpretation: SheetPixelInterpretationInputV1; open_questions: string[] } {
  if (!args.raw || typeof args.raw !== "object" || Array.isArray(args.raw)) throw new Error("gemini_sheet_response_must_be_object");
  const raw = args.raw as RawGeminiSheetResponse;
  if (raw.schema_version !== 1) throw new Error("gemini_sheet_response_requires_schema_v1");
  if (clean(raw.package_id) !== clean(args.request.package_id)) throw new Error("gemini_sheet_response_package_mismatch");
  if (raw.coordinate_space !== "normalized_uv_top_left") throw new Error("gemini_sheet_response_coordinate_space_invalid");
  const requestedViewKeys = args.request.views.map(view => clean(view.view_key));
  if (!Array.isArray(raw.view_keys) || raw.view_keys.length !== requestedViewKeys.length || raw.view_keys.some(key => !requestedViewKeys.includes(clean(key)))) {
    throw new Error("gemini_sheet_response_view_keys_mismatch");
  }
  const allowedViewKeys = new Set(requestedViewKeys);
  const maximumMarks = args.request.maximum_source_marks ?? 500;
  const maximumPrimitives = args.request.maximum_primitives ?? 500;
  if (!Array.isArray(raw.source_marks) || raw.source_marks.length === 0 || raw.source_marks.length > maximumMarks) throw new Error("gemini_sheet_response_source_mark_count_invalid");
  if (!Array.isArray(raw.primitives) || raw.primitives.length > maximumPrimitives) throw new Error("gemini_sheet_response_primitive_count_invalid");

  const sourceMarks: SheetTopologySourceMarkV1[] = raw.source_marks.map((mark, index) => {
    const markId = requiredText(mark.source_mark_id, `gemini_sheet_mark_${index}_id`);
    const viewKey = requiredText(mark.source_view_key, `gemini_sheet_mark_${markId}_view_key`);
    if (!allowedViewKeys.has(viewKey)) throw new Error(`gemini_sheet_mark_unknown_view:${markId}`);
    if (mark.disposition_status === "candidate") {
      if (!Array.isArray(mark.primitive_ids) || mark.primitive_ids.length === 0) throw new Error(`gemini_sheet_candidate_mark_requires_primitive:${markId}`);
      return { source_mark_id: markId, source_view_key: viewKey, disposition: { status: "candidate", primitive_ids: mark.primitive_ids.map(value => requiredText(value, `gemini_sheet_mark_${markId}_primitive_id`)) } };
    }
    if (mark.disposition_status !== "unresolved") throw new Error(`gemini_sheet_mark_disposition_invalid:${markId}`);
    return { source_mark_id: markId, source_view_key: viewKey, disposition: { status: "unresolved", reason: requiredText(mark.reason, `gemini_sheet_mark_${markId}_reason`) } };
  });

  const normalizationQuestions: string[] = [];
  const primitives: SheetPixelPrimitiveV1[] = raw.primitives.map((primitive, index) => {
    const primitiveId = requiredText(primitive.primitive_id, `gemini_sheet_primitive_${index}_id`);
    const viewKey = requiredText(primitive.source_view_key, `gemini_sheet_primitive_${primitiveId}_view_key`);
    if (!allowedViewKeys.has(viewKey)) throw new Error(`gemini_sheet_primitive_unknown_view:${primitiveId}`);
    if (!Array.isArray(primitive.points) || primitive.points.length === 0) throw new Error(`gemini_sheet_primitive_points_required:${primitiveId}`);
    const points = primitive.points.map((point, pointIndex) => ({
      u: unit(point.u, `gemini_sheet_primitive_${primitiveId}_point_${pointIndex}_u`),
      v: unit(point.v, `gemini_sheet_primitive_${primitiveId}_point_${pointIndex}_v`)
    }));
    const endpoints = (primitive.endpoints ?? []).map((endpoint, endpointIndex) => ({
      endpoint_key: qualifiedEndpointKey(primitiveId, endpoint.endpoint_key, `gemini_sheet_primitive_${primitiveId}_endpoint_${endpointIndex}_key`),
      point: {
        u: unit(endpoint.point?.u, `gemini_sheet_endpoint_${primitiveId}_${endpointIndex}_u`),
        v: unit(endpoint.point?.v, `gemini_sheet_endpoint_${primitiveId}_${endpointIndex}_v`)
      },
      outward_direction_uv: endpoint.outward_direction_uv,
      boundary: endpoint.boundary,
      ...(clean(endpoint.continuation_key) ? { continuation_key: clean(endpoint.continuation_key) } : {}),
      ...(endpoint.continuation_kind !== "none" ? { continuation_kind: endpoint.continuation_kind } : {})
    }));
    if (new Set(endpoints.map(endpoint => endpoint.endpoint_key)).size !== endpoints.length) {
      throw new Error(`gemini_sheet_primitive_duplicate_endpoint_key:${primitiveId}`);
    }
    if (endpoints.length > 0 && !["route_segment", "wall_segment"].includes(primitive.kind)) {
      throw new Error(`gemini_sheet_non_linear_primitive_cannot_have_endpoints:${primitiveId}`);
    }
    const claims = claimMap(primitive.claims ?? [], primitiveId) ?? {};
    let classificationConfidence = unit(primitive.confidence?.classification, `gemini_sheet_primitive_${primitiveId}_classification_confidence`);
    if (primitive.kind === "point_symbol") {
      for (const attribute of ["family", "type", "host"] as const) {
        const materialClaim = claims[attribute];
        if (!materialClaim || materialClaim.basis !== "legible_source_evidence") continue;
        claims[attribute] = {
          ...materialClaim,
          confidence: Math.min(materialClaim.confidence, 0.5),
          basis: "provider_hypothesis"
        };
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
      primitive_id: primitiveId,
      source_view_key: viewKey,
      source_mark_ids: primitive.source_mark_ids.map(value => requiredText(value, `gemini_sheet_primitive_${primitiveId}_source_mark`)),
      kind: primitive.kind,
      points,
      endpoints,
      claims,
      confidence: {
        geometry: unit(primitive.confidence?.geometry, `gemini_sheet_primitive_${primitiveId}_geometry_confidence`),
        classification: classificationConfidence,
        topology: unit(primitive.confidence?.topology, `gemini_sheet_primitive_${primitiveId}_topology_confidence`),
        visibility: unit(primitive.confidence?.visibility, `gemini_sheet_primitive_${primitiveId}_visibility_confidence`)
      }
    };
  });

  const marksById = new Map<string, SheetTopologySourceMarkV1>();
  for (const mark of sourceMarks) {
    if (marksById.has(mark.source_mark_id)) throw new Error(`gemini_sheet_duplicate_source_mark:${mark.source_mark_id}`);
    marksById.set(mark.source_mark_id, mark);
  }
  const primitivesById = new Map<string, SheetPixelPrimitiveV1>();
  for (const primitive of primitives) {
    if (primitivesById.has(primitive.primitive_id)) throw new Error(`gemini_sheet_duplicate_primitive:${primitive.primitive_id}`);
    primitivesById.set(primitive.primitive_id, primitive);
  }
  for (const mark of sourceMarks) {
    if (mark.disposition.status !== "candidate") continue;
    for (const primitiveId of mark.disposition.primitive_ids) {
      const primitive = primitivesById.get(primitiveId);
      if (!primitive) throw new Error(`gemini_sheet_mark_unknown_primitive:${mark.source_mark_id}:${primitiveId}`);
      if (primitive.source_view_key !== mark.source_view_key) throw new Error(`gemini_sheet_mark_primitive_view_mismatch:${mark.source_mark_id}:${primitiveId}`);
      if (!primitive.source_mark_ids.includes(mark.source_mark_id)) {
        primitive.source_mark_ids.push(mark.source_mark_id);
        normalizationQuestions.push(`Normalized reciprocal source-mark linkage ${mark.source_mark_id} -> ${primitiveId}.`);
      }
    }
  }
  for (const primitive of primitives) {
    for (const markId of primitive.source_mark_ids) {
      const mark = marksById.get(markId);
      if (!mark) throw new Error(`gemini_sheet_primitive_unknown_source_mark:${primitive.primitive_id}:${markId}`);
      if (mark.source_view_key !== primitive.source_view_key) throw new Error(`gemini_sheet_primitive_source_mark_view_mismatch:${primitive.primitive_id}:${markId}`);
      if (mark.disposition.status !== "candidate") throw new Error(`gemini_sheet_primitive_cites_unresolved_source_mark:${primitive.primitive_id}:${markId}`);
      if (!mark.disposition.primitive_ids.includes(primitive.primitive_id)) {
        mark.disposition.primitive_ids.push(primitive.primitive_id);
        normalizationQuestions.push(`Normalized reciprocal primitive-mark linkage ${primitive.primitive_id} -> ${markId}.`);
      }
    }
  }
  for (const mark of sourceMarks) {
    if (mark.disposition.status === "candidate") mark.disposition.primitive_ids = [...new Set(mark.disposition.primitive_ids)].sort();
  }
  for (const primitive of primitives) primitive.source_mark_ids = [...new Set(primitive.source_mark_ids)].sort();

  return {
    interpretation: {
      schema_version: 1,
      package_id: args.request.package_id,
      coordinate_space: "normalized_uv_top_left",
      view_keys: requestedViewKeys,
      source_marks: sourceMarks,
      primitives
    },
    open_questions: [...new Set([
      ...(Array.isArray(raw.open_questions) ? raw.open_questions.map(value => clean(value)).filter(Boolean) : []),
      ...normalizationQuestions
    ])].slice(0, 200)
  };
}

function apiKey(): string {
  return clean(process.env.OPERATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY);
}

function modelName(): string {
  return clean(process.env.OPERATOR_GEMINI_SHEET_MODEL || process.env.OPERATOR_GEMINI_MODEL || "gemini-3-flash-preview");
}

function baseUrl(): string {
  return clean(process.env.OPERATOR_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
}

function maximumOutputTokens(request: GeminiExistingConditionsSheetRequestV1): number {
  const value = request.maximum_output_tokens ?? 32_768;
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_536) {
    throw new Error("gemini_sheet_interpreter_maximum_output_tokens_must_be_1024_through_65536");
  }
  return value;
}

function thinkingLevel(
  request: GeminiExistingConditionsSheetRequestV1,
  model: string
): GeminiExistingConditionsSheetRequestV1["thinking_level"] | undefined {
  const configured = clean(request.thinking_level);
  if (configured && !["minimal", "low", "medium", "high"].includes(configured)) {
    throw new Error("gemini_sheet_interpreter_thinking_level_invalid");
  }
  if (!model.toLowerCase().startsWith("gemini-3")) {
    if (configured) throw new Error("gemini_sheet_interpreter_thinking_level_requires_gemini_3");
    return undefined;
  }
  return (configured || "low") as GeminiExistingConditionsSheetRequestV1["thinking_level"];
}

export async function analyzeExistingConditionsSheetWithGeminiV1(
  request: GeminiExistingConditionsSheetRequestV1,
  options: {
    fetch_impl?: typeof fetch;
    on_raw_response?: (capture: GeminiExistingConditionsRawResponseCaptureV1) => void | Promise<void>;
  } = {}
): Promise<GeminiExistingConditionsSheetResponseV1> {
  if (!request || request.schema_version !== 1) throw new Error("gemini_sheet_interpreter_requires_schema_v1");
  if (!Array.isArray(request.views) || request.views.length === 0 || request.views.length > 12) throw new Error("gemini_sheet_interpreter_views_must_have_one_to_twelve_items");
  const key = apiKey();
  if (!key) throw new Error("gemini_sheet_interpreter_api_key_missing");
  const viewKeys = new Set<string>();
  const sourceHashes: Record<string, string> = {};
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: prompt(request) }];
  for (const [index, view] of request.views.entries()) {
    const viewKey = requiredText(view.view_key, `gemini_sheet_interpreter_view_${index}_key`);
    if (viewKeys.has(viewKey)) throw new Error(`gemini_sheet_interpreter_duplicate_view:${viewKey}`);
    viewKeys.add(viewKey);
    const resolved = path.resolve(requiredText(view.image_path, `gemini_sheet_interpreter_view_${viewKey}_image_path`));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`gemini_sheet_interpreter_image_not_found:${viewKey}`);
    const bytes = fs.readFileSync(resolved);
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) throw new Error(`gemini_sheet_interpreter_image_size_invalid:${viewKey}`);
    sourceHashes[viewKey] = sha256Buffer(bytes);
    parts.push({ text: `VIEW_KEY=${viewKey}` });
    parts.push({ inlineData: { mimeType: mimeType(resolved), data: bytes.toString("base64") } });
  }

  const model = modelName();
  const requestedThinkingLevel = thinkingLevel(request, model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(10_000, Math.min(request.timeout_ms ?? 120_000, 300_000)));
  try {
    let firstRawResponseSha256 = "";
    let firstRawResponse: GeminiExistingConditionsRawResponseCaptureV1 | undefined;
    let repairTriggerError = "";
    let previousRawText = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const contents = attempt === 1
        ? [{ role: "user", parts }]
        : [
            { role: "user", parts },
            { role: "model", parts: [{ text: previousRawText }] },
            { role: "user", parts: [{ text: repairPrompt(repairTriggerError) }] }
          ];
      const response = await (options.fetch_impl ?? fetch)(`${baseUrl()}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: attempt === 1 ? 0.2 : 0,
            maxOutputTokens: maximumOutputTokens(request),
            ...(requestedThinkingLevel ? { thinkingConfig: { thinkingLevel: requestedThinkingLevel } } : {}),
            responseMimeType: "application/json",
            responseSchema: GEMINI_EXISTING_CONDITIONS_SHEET_RESPONSE_SCHEMA_V1
          }
        })
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`gemini_sheet_interpreter_http_${response.status}:${responseText.slice(0, 800)}`);
      const envelope = JSON.parse(responseText) as {
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: unknown;
      };
      const rawText = (envelope.candidates ?? []).flatMap(candidate => candidate.content?.parts ?? []).map(part => clean(part.text)).filter(Boolean).join("\n");
      if (!rawText) throw new Error("gemini_sheet_interpreter_empty_response");
      const rawResponseSha256 = sha256Text(rawText);
      const captureBase = {
        schema_version: 1 as const,
        provider: "gemini" as const,
        model,
        package_id: request.package_id,
        raw_response_sha256: rawResponseSha256,
        attempt,
        ...(attempt === 1 ? {} : { repair_of_raw_response_sha256: firstRawResponseSha256 }),
        ...(requestedThinkingLevel ? { thinking_level: requestedThinkingLevel } : {}),
        raw_text: rawText,
        provider_finish_reasons: (envelope.candidates ?? []).map(candidate => clean(candidate.finishReason)).filter(Boolean),
        ...(envelope.usageMetadata === undefined ? {} : { provider_usage_metadata: envelope.usageMetadata })
      };
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch (error) {
        const parseError = error instanceof Error ? error.message : clean(error);
        const failedCapture = { ...captureBase, parsed: null, parse_error: parseError };
        await options.on_raw_response?.(failedCapture);
        const finishReasons = captureBase.provider_finish_reasons.join(",") || "unreported";
        const invalidJsonError = `gemini_sheet_interpreter_invalid_json:${parseError}:provider_finish_reasons=${finishReasons}`;
        if (attempt === 2) throw new Error(invalidJsonError);
        firstRawResponseSha256 = rawResponseSha256;
        firstRawResponse = failedCapture;
        previousRawText = rawText;
        repairTriggerError = invalidJsonError;
        continue;
      }
      try {
        const normalized = normalizeGeminiExistingConditionsSheetResponseV1({ request, raw: parsed });
        await options.on_raw_response?.({ ...captureBase, parsed });
        return {
          schema_version: 1,
          provider: "gemini",
          model,
          package_id: request.package_id,
          source_image_sha256_by_view: sourceHashes,
          raw_response_sha256: rawResponseSha256,
          attempt_count: attempt,
          ...(requestedThinkingLevel ? { thinking_level: requestedThinkingLevel } : {}),
          ...(attempt === 1 ? {} : { repair: { trigger_error: repairTriggerError, first_raw_response_sha256: firstRawResponseSha256, first_raw_response: firstRawResponse! } }),
          interpretation: normalized.interpretation,
          open_questions: normalized.open_questions
        };
      } catch (error) {
        const normalizationError = error instanceof Error ? error.message : clean(error);
        const failedCapture = { ...captureBase, parsed, normalization_error: normalizationError };
        await options.on_raw_response?.(failedCapture);
        if (attempt === 2) throw error;
        firstRawResponseSha256 = rawResponseSha256;
        firstRawResponse = failedCapture;
        previousRawText = rawText;
        repairTriggerError = normalizationError;
      }
    }
    throw new Error("gemini_sheet_interpreter_repair_loop_exhausted");
  } finally {
    clearTimeout(timeout);
  }
}
