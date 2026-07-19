import fs from "node:fs";
import path from "node:path";
import { createOpenAiClient, resolveOpenAiApiKey } from "../openai_client.js";
import { ensureWorkspaceLayout, resolveExistingFileUnderWorkspace } from "../workspace.js";

export type ViewAlignmentMark = {
  normalized_x: number;
  normalized_y: number;
  score: number;
  label: string | null;
};

export type ViewAlignmentRegistrationControl = {
  kind:
    | "exterior_corner"
    | "exterior_wall"
    | "stair"
    | "elevator_core"
    | "shaft"
    | "grid"
    | "column"
    | "persistent_interior";
  source_normalized_x: number;
  source_normalized_y: number;
  view_normalized_x: number;
  view_normalized_y: number;
  score: number;
  label: string | null;
};

export type ViewAlignmentSourceRoomLabel = {
  text: string;
  normalized_x: number;
  normalized_y: number;
  min_u: number;
  min_v: number;
  max_u: number;
  max_v: number;
  score: number;
};

export type ViewAlignmentResult = {
  ok: boolean;
  matched: boolean;
  confidence: number;
  analysis: string;
  crop:
    | {
        min_u: number;
        min_v: number;
        max_u: number;
        max_v: number;
      }
    | null;
  registration_controls: ViewAlignmentRegistrationControl[];
  source_room_labels: ViewAlignmentSourceRoomLabel[];
  marks: ViewAlignmentMark[];
  provider?: "gemini" | "openai";
  model?: string;
  attempted_models?: string[];
  fallback_reason?: string;
  warning?: string;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isSupportedImageExt(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg";
}

function readWorkspaceImageDataUrl(relativePath: string, maxBytes: number): string | null {
  try {
    const rel = (relativePath ?? "").trim();
    if (!rel || !isSupportedImageExt(rel)) return null;
    const ws = ensureWorkspaceLayout();
    const full = path.isAbsolute(rel)
      ? path.resolve(rel)
      : resolveExistingFileUnderWorkspace(rel);
    const root = path.resolve(ws.root);
    if (!full.toLowerCase().startsWith(root.toLowerCase() + path.sep) && path.resolve(full).toLowerCase() !== root.toLowerCase()) return null;
    const st = fs.statSync(full);
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null;
    const ext = path.extname(full).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${fs.readFileSync(full).toString("base64")}`;
  } catch {
    return null;
  }
}

function coerceNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseResult(raw: string): ViewAlignmentResult {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const matched = parsed.matched === true;
    const confidenceRaw = coerceNumber(parsed.confidence);
    const confidence = confidenceRaw === null ? 0 : clamp01(confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw);
    const analysis = typeof parsed.analysis === "string" ? parsed.analysis.trim() : "";
    const cropRaw = parsed.crop && typeof parsed.crop === "object" ? (parsed.crop as Record<string, unknown>) : null;
    const crop =
      cropRaw &&
      coerceNumber(cropRaw.min_u) !== null &&
      coerceNumber(cropRaw.min_v) !== null &&
      coerceNumber(cropRaw.max_u) !== null &&
      coerceNumber(cropRaw.max_v) !== null
        ? {
            min_u: clamp01(coerceNumber(cropRaw.min_u)!),
            min_v: clamp01(coerceNumber(cropRaw.min_v)!),
            max_u: clamp01(coerceNumber(cropRaw.max_u)!),
            max_v: clamp01(coerceNumber(cropRaw.max_v)!)
          }
        : null;
    const supportedControlKinds = new Set<ViewAlignmentRegistrationControl["kind"]>([
      "exterior_corner",
      "exterior_wall",
      "stair",
      "elevator_core",
      "shaft",
      "grid",
      "column",
      "persistent_interior"
    ]);
    const registrationControls = Array.isArray(parsed.registration_controls)
      ? parsed.registration_controls
          .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : null))
          .filter((row): row is Record<string, unknown> => !!row)
          .map((row) => {
            const kind = typeof row.kind === "string"
              ? row.kind.trim().toLowerCase() as ViewAlignmentRegistrationControl["kind"]
              : "persistent_interior";
            const sourceX = coerceNumber(row.source_normalized_x);
            const sourceY = coerceNumber(row.source_normalized_y);
            const viewX = coerceNumber(row.view_normalized_x);
            const viewY = coerceNumber(row.view_normalized_y);
            const score = coerceNumber(row.score);
            if (
              !supportedControlKinds.has(kind) ||
              sourceX === null ||
              sourceY === null ||
              viewX === null ||
              viewY === null
            ) {
              return null;
            }
            return {
              kind,
              source_normalized_x: clamp01(sourceX),
              source_normalized_y: clamp01(sourceY),
              view_normalized_x: clamp01(viewX),
              view_normalized_y: clamp01(viewY),
              score: clamp01(score === null ? confidence : score > 1 ? score / 100 : score),
              label: typeof row.label === "string" && row.label.trim() ? row.label.trim() : null
            } satisfies ViewAlignmentRegistrationControl;
          })
          .filter((row): row is ViewAlignmentRegistrationControl => !!row)
      : [];
    const sourceRoomLabels = Array.isArray(parsed.source_room_labels)
      ? parsed.source_room_labels
          .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : null))
          .filter((row): row is Record<string, unknown> => !!row)
          .map((row) => {
            const text = typeof row.text === "string" ? row.text.trim() : "";
            const x = coerceNumber(row.normalized_x);
            const y = coerceNumber(row.normalized_y);
            const minU = coerceNumber(row.min_u);
            const minV = coerceNumber(row.min_v);
            const maxU = coerceNumber(row.max_u);
            const maxV = coerceNumber(row.max_v);
            const score = coerceNumber(row.score);
            if (
              !text ||
              x === null ||
              y === null ||
              minU === null ||
              minV === null ||
              maxU === null ||
              maxV === null
            ) {
              return null;
            }
            const bounds = {
              min_u: clamp01(minU),
              min_v: clamp01(minV),
              max_u: clamp01(maxU),
              max_v: clamp01(maxV)
            };
            const center = {
              normalized_x: clamp01(x),
              normalized_y: clamp01(y)
            };
            if (
              bounds.max_u <= bounds.min_u ||
              bounds.max_v <= bounds.min_v ||
              center.normalized_x < bounds.min_u ||
              center.normalized_x > bounds.max_u ||
              center.normalized_y < bounds.min_v ||
              center.normalized_y > bounds.max_v
            ) {
              return null;
            }
            return {
              text,
              ...center,
              ...bounds,
              score: clamp01(score === null ? confidence : score > 1 ? score / 100 : score)
            } satisfies ViewAlignmentSourceRoomLabel;
          })
          .filter((row): row is ViewAlignmentSourceRoomLabel => !!row)
      : [];
    const marks = Array.isArray(parsed.marks)
      ? parsed.marks
          .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : null))
          .filter((row): row is Record<string, unknown> => !!row)
          .map((row) => {
            const x = coerceNumber(row.normalized_x);
            const y = coerceNumber(row.normalized_y);
            const score = coerceNumber(row.score);
            if (x === null || y === null) return null;
            return {
              normalized_x: clamp01(x),
              normalized_y: clamp01(y),
              score: clamp01(score === null ? confidence : score > 1 ? score / 100 : score),
              label: typeof row.label === "string" && row.label.trim() ? row.label.trim() : null
            } satisfies ViewAlignmentMark;
          })
          .filter((row): row is ViewAlignmentMark => !!row)
      : [];

    return {
      ok: true,
      matched,
      confidence,
      analysis,
      crop:
        crop && crop.max_u > crop.min_u && crop.max_v > crop.min_v
          ? crop
          : null,
      registration_controls: registrationControls,
      source_room_labels: sourceRoomLabels,
      marks
    };
  } catch (err) {
    return {
      ok: false,
      matched: false,
      confidence: 0,
      analysis: "",
      crop: null,
      registration_controls: [],
      source_room_labels: [],
      marks: [],
      warning: err instanceof Error ? err.message : "Failed to parse view alignment result."
    };
  }
}

function extractResponseText(response: any): string {
  const direct = typeof response?.output_text === "string" ? response.output_text : "";
  if (direct.trim()) return direct;

  const parts: string[] = [];
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  for (const item of outputItems) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const contentItem of item.content) {
      if (!contentItem || contentItem.type !== "output_text" || typeof contentItem.text !== "string") continue;
      if (contentItem.text) parts.push(contentItem.text);
    }
  }
  if (parts.length > 0) return parts.join("");

  if (response?.output_parsed != null) {
    try {
      return JSON.stringify(response.output_parsed);
    } catch {
      // ignore
    }
  }

  return "";
}

export function __testOnlyExtractViewAlignmentResponseText(response: unknown): string {
  return extractResponseText(response);
}

function dataUrlInlinePart(
  dataUrl: string
): { inlineData: { mimeType: string; data: string } } | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  return {
    inlineData: {
      mimeType: match[1]!,
      data: match[2]!
    }
  };
}

function geminiAlignmentModelCandidates(): string[] {
  const preferred = (
    process.env.OPERATOR_GEMINI_ALIGNMENT_MODEL ||
    process.env.OPERATOR_GEMINI_MODEL ||
    "gemini-3-flash-preview"
  ).trim();
  const candidates = [
    preferred,
    ...(process.env.OPERATOR_GEMINI_ALIGNMENT_MODEL_FALLBACKS || "")
      .split(",")
      .map((value) => value.trim()),
    preferred.toLowerCase().startsWith("gemini-3")
      ? "gemini-3-flash-preview"
      : "",
    preferred.toLowerCase().startsWith("gemini-3")
      ? "gemini-3-flash"
      : "",
    "gemini-2.5-flash"
  ];
  return candidates.filter(
    (value, index, all) =>
      !!value && all.findIndex((candidate) => candidate === value) === index
  );
}

function extractGeminiAlignmentText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const root = payload as Record<string, unknown>;
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const texts: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const content = (candidate as Record<string, unknown>).content;
    if (!content || typeof content !== "object" || Array.isArray(content)) continue;
    const parts = Array.isArray((content as Record<string, unknown>).parts)
      ? (content as Record<string, unknown>).parts as unknown[]
      : [];
    for (const part of parts) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) texts.push(text);
    }
  }
  return texts.join("\n").trim();
}

function buildViewAlignmentPrompt(objective?: string | null): string {
  return [
    "Image 1 is a user-provided redline, record drawing, as-built drawing, or existing-conditions source crop. Image 2 is a full exported Revit view.",
    "Match the underlying drawing geometry, not red markup, color, room tags, room names, or space names.",
    "For existing-conditions work, the source may be black-and-white, contain no markup, omit room names, or show interior partitions that changed after the record drawing was issued.",
    "When the task context is existing-conditions reconstruction, Image 1 is source-of-truth record geometry rather than a redline: do not classify colored lines, symbols, or fixtures as markups, removals, or targets merely because they are colored. Return marks=[] unless the task explicitly asks to interpret change annotations.",
    "Use multiple spatially separated durable landmarks when available, in this order: exterior envelope and corners; stairs and elevator cores; shafts; grids and columns; then persistent interior geometry. Do not use one changed interior partition or one matching label as the sole registration control.",
    "Return the rectangle in image 2 that corresponds to image 1 using normalized coordinates from 0 to 1.",
    "Also return registration_controls for every durable common landmark actually used. Each control must identify its kind, point in image 1, corresponding point in image 2, confidence score, and a concise visual label. Prefer at least two spatially separated controls, and do not claim controls that are not visibly recognizable in both images.",
    "Also return source_room_labels for clearly readable room labels in Image 1 only. Each entry must preserve the exact visible text, center point, tight text bounds, and confidence in normalized Image-1 coordinates. This is semantic source evidence, not a registration control. When the task names a room, prioritize that exact label and only its nearby context; otherwise return at most the 12 strongest labels. Return [] for unreadable or ambiguous labels and never infer a label from Image 2.",
    "A clean record drawing can be a valid match with marks=[]. Do not set matched=false merely because Image 1 has no red markup or because room/space data is absent.",
    "Then return the intended insertion point of each explicit red markup target from image 1 mapped into image 2, also normalized 0 to 1. If there is no explicit markup, return marks=[].",
    "For MEP route redlines, nearby text such as '12x10 supply duct' or '6-inch water pipe' is only a label. The target is the separate red route line/polyline near that text.",
    "When a label and a separate red line are both present, map the center of the red route line/polyline itself. Do not map the center, baseline, lower edge, or visual underline of the text unless the only markup is truly text formatting.",
    "If the red route line is spatially offset from the callout text, preserve that offset in image 2 even when the text is easier to read.",
    "For add/place device redlines, the target is the wall-adjacent position indicated by the red stroke itself. If the red markup is a tick, circle, or short hand-drawn stroke crossing a wall, use the stroke center projected to the nearest matching wall, preserving its along-wall position.",
    "Do not snap the target to a nearby existing receptacle, circuit label, room label, sink, stair, or other drawing symbol unless the red markup directly encloses that exact symbol. Existing devices are context for type/circuit only, not the insertion point.",
    "Keep the mark position consistent with the returned crop: if a red mark is at normalized image-1 point (x,y), its mapped image-2 point should be near crop.min + (x,y) * crop.size. A semantic adjustment larger than a small symbol width is a low-confidence result and should set matched=false.",
    "Describe the common landmarks used and the important mismatches in analysis so the registration remains auditable.",
    "If the images are not the same drawing/view, or durable common landmarks do not establish a defensible transform, set matched=false and return marks=[].",
    "Do not guess. Low confidence should produce matched=false.",
    objective && objective.trim() ? `Task context: ${objective.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function __testOnlyBuildViewAlignmentPrompt(objective?: string | null): string {
  return buildViewAlignmentPrompt(objective);
}

function buildViewAlignmentSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["matched", "confidence", "analysis", "crop", "registration_controls", "source_room_labels", "marks"],
    properties: {
      matched: { type: "boolean" },
      confidence: { type: "number" },
      analysis: { type: "string" },
      crop: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["min_u", "min_v", "max_u", "max_v"],
        properties: {
          min_u: { type: "number" },
          min_v: { type: "number" },
          max_u: { type: "number" },
          max_v: { type: "number" }
        }
      },
      registration_controls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "kind",
            "source_normalized_x",
            "source_normalized_y",
            "view_normalized_x",
            "view_normalized_y",
            "score",
            "label"
          ],
          properties: {
            kind: {
              type: "string",
              enum: [
                "exterior_corner",
                "exterior_wall",
                "stair",
                "elevator_core",
                "shaft",
                "grid",
                "column",
                "persistent_interior"
              ]
            },
            source_normalized_x: { type: "number" },
            source_normalized_y: { type: "number" },
            view_normalized_x: { type: "number" },
            view_normalized_y: { type: "number" },
            score: { type: "number" },
            label: { type: ["string", "null"] }
          }
        }
      },
      source_room_labels: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "text",
            "normalized_x",
            "normalized_y",
            "min_u",
            "min_v",
            "max_u",
            "max_v",
            "score"
          ],
          properties: {
            text: { type: "string" },
            normalized_x: { type: "number" },
            normalized_y: { type: "number" },
            min_u: { type: "number" },
            min_v: { type: "number" },
            max_u: { type: "number" },
            max_v: { type: "number" },
            score: { type: "number" }
          }
        }
      },
      marks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["normalized_x", "normalized_y", "score", "label"],
          properties: {
            normalized_x: { type: "number" },
            normalized_y: { type: "number" },
            score: { type: "number" },
            label: { type: ["string", "null"] }
          }
        }
      }
    }
  };
}

type GeminiAlignmentAttempt = {
  result: ViewAlignmentResult | null;
  attempted_models: string[];
  failure_reason: string | null;
};

async function alignRedlineToViewWithGemini(args: {
  prompt: string;
  redlineDataUrl: string;
  viewDataUrl: string;
  schema: Record<string, unknown>;
}): Promise<GeminiAlignmentAttempt> {
  const enabled = !/^(0|false|no|off)$/i.test(
    (process.env.OPERATOR_GEMINI_ALIGNMENT_ENABLED ?? "1").trim()
  );
  const key = (
    process.env.OPERATOR_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    ""
  ).trim();
  if (!enabled) {
    return {
      result: null,
      attempted_models: [],
      failure_reason: "Gemini alignment is disabled."
    };
  }
  if (!key) {
    return {
      result: null,
      attempted_models: [],
      failure_reason: "Gemini API key is not configured."
    };
  }
  const redlinePart = dataUrlInlinePart(args.redlineDataUrl);
  const viewPart = dataUrlInlinePart(args.viewDataUrl);
  if (!redlinePart || !viewPart) {
    return {
      result: null,
      attempted_models: [],
      failure_reason: "Gemini alignment could not encode both image inputs."
    };
  }
  const baseUrl = (
    process.env.OPERATOR_GEMINI_BASE_URL ||
    "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");
  const timeoutMs = Math.max(
    10_000,
    Number.parseInt(
      process.env.OPERATOR_GEMINI_ALIGNMENT_TIMEOUT_MS ||
        process.env.OPERATOR_GEMINI_TIMEOUT_MS ||
        "90000",
      10
    ) || 90_000
  );
  const models = geminiAlignmentModelCandidates();
  const attempted: string[] = [];
  let fallbackReason = "";
  for (const model of models) {
    attempted.push(model);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                {
                  text:
                    `${args.prompt}\n` +
                    "Return JSON only with matched, confidence, analysis, crop, registration_controls, source_room_labels, and marks. " +
                    "Image 1 follows this instruction; Image 2 follows Image 1."
                },
                redlinePart,
                viewPart
              ]
            }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json",
              responseJsonSchema: args.schema
            }
          })
        }
      );
      const raw = await response.text();
      if (!response.ok) {
        fallbackReason = `Gemini ${model} returned HTTP ${response.status}.`;
        if (
          response.status === 404 ||
          response.status === 400 ||
          /model.*(?:not found|unsupported|unavailable)/i.test(raw)
        ) {
          continue;
        }
        break;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        fallbackReason = `Gemini ${model} returned non-JSON API output.`;
        continue;
      }
      const text = extractGeminiAlignmentText(payload);
      const parsed = parseResult(text);
      if (!parsed.ok) {
        fallbackReason =
          parsed.warning || `Gemini ${model} alignment JSON was invalid.`;
        continue;
      }
      return {
        result: {
          ...parsed,
          provider: "gemini",
          model,
          attempted_models: attempted,
          ...(fallbackReason ? { fallback_reason: fallbackReason } : {})
        },
        attempted_models: attempted,
        failure_reason: fallbackReason || null
      };
    } catch (error) {
      fallbackReason =
        error instanceof Error
          ? `Gemini ${model} failed: ${error.message}`
          : `Gemini ${model} failed.`;
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    result: null,
    attempted_models: attempted,
    failure_reason:
      fallbackReason ||
      (attempted.length > 0
        ? "Gemini alignment failed without a provider error."
        : "No Gemini alignment model was configured.")
  };
}

export async function alignRedlineToView(args: {
  redline_file_path: string;
  view_image_data_url?: string | null;
  view_image_relative_path?: string | null;
  objective?: string | null;
  provider_preference?: "gemini_first" | "openai_only";
  prior_attempted_models?: string[];
  openai_fallback_reason?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  max_output_tokens?: number | null;
  max_image_bytes?: number | null;
}): Promise<ViewAlignmentResult> {
  const maxImageBytes = Math.max(
    64 * 1024,
    Number.parseInt(String(args.max_image_bytes ?? "1500000"), 10) || 1_500_000
  );
  const redlineDataUrl = readWorkspaceImageDataUrl(args.redline_file_path, maxImageBytes);
  const viewDataUrl =
    (typeof args.view_image_data_url === "string" && args.view_image_data_url.trim()) ||
    (typeof args.view_image_relative_path === "string" ? readWorkspaceImageDataUrl(args.view_image_relative_path, maxImageBytes) : null);

  if (!redlineDataUrl || !viewDataUrl) {
    const unavailableInputs = [
      !redlineDataUrl ? "source image" : "",
      !viewDataUrl ? "Revit view preview" : ""
    ].filter(Boolean);
    const fallbackReason =
      `Alignment input unavailable before provider invocation: ${unavailableInputs.join(
        " and "
      )}.`;
    return {
      ok: false,
      matched: false,
      confidence: 0,
      analysis: "",
      crop: null,
      registration_controls: [],
      source_room_labels: [],
      marks: [],
      attempted_models: [],
      fallback_reason: fallbackReason,
      warning: "Redline view alignment requires both the uploaded redline image and a portable Revit view preview."
    };
  }

  const prompt = buildViewAlignmentPrompt(args.objective);
  const schema = buildViewAlignmentSchema();
  const providerPreference = args.provider_preference ?? "gemini_first";
  let geminiAttempt: GeminiAlignmentAttempt = {
    result: null,
    attempted_models: [],
    failure_reason: null
  };
  if (providerPreference === "gemini_first") {
    geminiAttempt = await alignRedlineToViewWithGemini({
      prompt,
      redlineDataUrl,
      viewDataUrl,
      schema
    });
    if (geminiAttempt.result) return geminiAttempt.result;
  }

  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) {
    const attemptedModels = Array.from(new Set([
      ...(args.prior_attempted_models ?? []),
      ...geminiAttempt.attempted_models
    ]));
    const fallbackReason =
      (typeof args.openai_fallback_reason === "string" &&
      args.openai_fallback_reason.trim()
        ? args.openai_fallback_reason.trim()
        : geminiAttempt.failure_reason) ?? undefined;
    return {
      ok: false,
      matched: false,
      confidence: 0,
      analysis: "",
      crop: null,
      registration_controls: [],
      source_room_labels: [],
      marks: [],
      attempted_models: attemptedModels,
      ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      warning:
        providerPreference === "openai_only"
          ? "OpenAI API key is not configured for the requested geometry fallback."
          : "Gemini alignment was unavailable and OpenAI API key is not configured for fallback."
    };
  }
  const client = createOpenAiClient(apiKey);
  const model = (args.model ?? process.env.OPERATOR_OPENAI_MODEL ?? "gpt-5.6-sol").trim();
  const attemptedModels = Array.from(new Set([
    ...(args.prior_attempted_models ?? [])
      .map((candidate) => String(candidate ?? "").trim())
      .filter(Boolean),
    ...geminiAttempt.attempted_models,
    model
  ]));
  const fallbackReason =
    typeof args.openai_fallback_reason === "string" &&
    args.openai_fallback_reason.trim()
      ? args.openai_fallback_reason.trim()
      : geminiAttempt.failure_reason ||
        "Gemini alignment was unavailable or failed.";
  const reasoningEffort = (args.reasoning_effort ?? process.env.OPERATOR_REDLINE_ALIGNMENT_REASONING_EFFORT ?? "none").trim().toLowerCase();
  const serviceTier = (process.env.OPERATOR_OPENAI_SERVICE_TIER ?? "priority").trim().toLowerCase();
  const maxOutputTokens = Math.max(3000, Number.parseInt(String(args.max_output_tokens ?? "5000"), 10) || 5000);

  const input = [
    {
      role: "developer",
      content: [{ type: "input_text", text: prompt }]
    },
    {
      role: "user",
      content: [
        { type: "input_text", text: "Image 1: redline upload. Image 2: full Revit view export." },
        { type: "input_image", image_url: redlineDataUrl, detail: "high" },
        { type: "input_image", image_url: viewDataUrl, detail: "high" }
      ]
    }
  ];

  try {
    const response = await client.responses.create({
      model,
      reasoning: {
        effort: (
          reasoningEffort === "none" ||
          reasoningEffort === "low" ||
          reasoningEffort === "high" ||
          reasoningEffort === "xhigh"
            ? reasoningEffort
            : "medium"
        ) as any
      },
      ...(serviceTier === "priority" || serviceTier === "flex" ? { service_tier: serviceTier } : {}),
      max_output_tokens: maxOutputTokens,
      input: input as any,
      text: {
        format: {
          type: "json_schema",
          name: "redline_view_alignment",
          strict: true,
          schema
        }
      }
    });

    return {
      ...parseResult(extractResponseText(response)),
      provider: "openai",
      model,
      attempted_models: attemptedModels,
      fallback_reason: fallbackReason
    };
  } catch (err) {
    return {
      ok: false,
      matched: false,
      confidence: 0,
      analysis: "",
      crop: null,
      registration_controls: [],
      source_room_labels: [],
      marks: [],
      provider: "openai",
      model,
      attempted_models: attemptedModels,
      fallback_reason: fallbackReason,
      warning: err instanceof Error ? err.message : "OpenAI view alignment failed."
    };
  }
}
