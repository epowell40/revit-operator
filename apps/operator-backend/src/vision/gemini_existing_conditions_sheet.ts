import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SheetPixelInterpretationInputV1 } from "../existing_conditions/sheet_pixel_interpretation.js";
import {
  STRUCTURED_EXISTING_CONDITIONS_INTERPRETATION_SCHEMA_V1,
  normalizeStructuredExistingConditionsInterpretationV1,
  type StructuredExistingConditionsInterpretationRequestV1
} from "./structured_existing_conditions_interpretation.js";

export type GeminiExistingConditionsSheetRequestV1 = {
  schema_version: 1;
  package_id: string;
  objective: string;
  views: Array<{
    view_key: string;
    image_path: string;
    analysis_role?: "sheet_context" | "region_detail";
    page_region?: { min_u: number; min_v: number; max_u: number; max_v: number };
    parent_context_view_key?: string;
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

export const GEMINI_EXISTING_CONDITIONS_SHEET_RESPONSE_SCHEMA_V1 = STRUCTURED_EXISTING_CONDITIONS_INTERPRETATION_SCHEMA_V1;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
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
    "Images labeled sheet_context establish orientation, legends, symbols, and scope only. Do not emit source marks or primitives from a sheet_context image; emit geometry only from region_detail images.",
    "When a region_detail declares a page_region and parent_context_view_key, use the parent full sheet to understand the crop, but keep returned UV coordinates local to the regional image.",
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
    lines.push(JSON.stringify({
      view_key: view.view_key,
      analysis_role: view.analysis_role ?? "region_detail",
      page_region: view.page_region ?? { min_u: 0, min_v: 0, max_u: 1, max_v: 1 },
      parent_context_view_key: view.parent_context_view_key ?? "",
      sheet_hint: view.sheet_hint ?? "",
      discipline_hint: view.discipline_hint ?? ""
    }));
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

export function normalizeGeminiExistingConditionsSheetResponseV1(args: {
  request: GeminiExistingConditionsSheetRequestV1;
  raw: unknown;
}): { interpretation: SheetPixelInterpretationInputV1; open_questions: string[] } {
  const suppliedContext = args.request.views.some(view => view.analysis_role === "sheet_context");
  const syntheticContextKey = "__gemini_context__";
  const views: StructuredExistingConditionsInterpretationRequestV1["views"] = args.request.views.map(view => ({
    view_key: view.view_key, analysis_role: view.analysis_role ?? "region_detail",
    source_artifact_sha256: "0".repeat(64), source_page: 1, image_sha256: "0".repeat(64),
    page_region: view.analysis_role === "sheet_context" ? { min_u: 0, min_v: 0, max_u: 1, max_v: 1 } : view.page_region ?? { min_u: 0, min_v: 0, max_u: 1, max_v: 1 },
    ...((view.analysis_role ?? "region_detail") === "region_detail" ? { parent_context_view_key: view.parent_context_view_key ?? syntheticContextKey } : {}),
    ...(view.sheet_hint ? { sheet_hint: view.sheet_hint } : {}),
    ...(view.discipline_hint ? { discipline_hint: view.discipline_hint } : {})
  }));
  if (!suppliedContext) views.unshift({
    view_key: syntheticContextKey, analysis_role: "sheet_context", source_artifact_sha256: "0".repeat(64),
    source_page: 1, image_sha256: "0".repeat(64), page_region: { min_u: 0, min_v: 0, max_u: 1, max_v: 1 }
  });
  const source = args.raw && typeof args.raw === "object" && !Array.isArray(args.raw) ? args.raw as Record<string, unknown> : null;
  const raw = source ? { ...source, view_keys: [...(suppliedContext ? [] : [syntheticContextKey]), ...(Array.isArray(source.view_keys) ? source.view_keys : [])] } : args.raw;
  try {
    const normalized = normalizeStructuredExistingConditionsInterpretationV1({
      request: { schema_version: 1, package_id: args.request.package_id, objective: args.request.objective, views,
        ...(args.request.maximum_source_marks === undefined ? {} : { maximum_source_marks: args.request.maximum_source_marks }),
        ...(args.request.maximum_primitives === undefined ? {} : { maximum_primitives: args.request.maximum_primitives }) },
      raw
    });
    return {
      interpretation: { ...normalized.interpretation, view_keys: args.request.views.filter(view => view.analysis_role !== "sheet_context").map(view => view.view_key) },
      open_questions: normalized.open_questions
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll("structured_sheet", "gemini_sheet"));
  }
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
