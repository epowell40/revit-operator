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
  marks: ViewAlignmentMark[];
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
      marks
    };
  } catch (err) {
    return {
      ok: false,
      matched: false,
      confidence: 0,
      analysis: "",
      crop: null,
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

export async function alignRedlineToView(args: {
  redline_file_path: string;
  view_image_data_url?: string | null;
  view_image_relative_path?: string | null;
  objective?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  max_output_tokens?: number | null;
  max_image_bytes?: number | null;
}): Promise<ViewAlignmentResult> {
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) {
    return {
      ok: false,
      matched: false,
      confidence: 0,
      analysis: "",
      crop: null,
      marks: [],
      warning: "OpenAI API key is not configured for redline view alignment."
    };
  }

  const maxImageBytes = Math.max(
    64 * 1024,
    Number.parseInt(String(args.max_image_bytes ?? "1500000"), 10) || 1_500_000
  );
  const redlineDataUrl = readWorkspaceImageDataUrl(args.redline_file_path, maxImageBytes);
  const viewDataUrl =
    (typeof args.view_image_data_url === "string" && args.view_image_data_url.trim()) ||
    (typeof args.view_image_relative_path === "string" ? readWorkspaceImageDataUrl(args.view_image_relative_path, maxImageBytes) : null);

  if (!redlineDataUrl || !viewDataUrl) {
    return {
      ok: false,
      matched: false,
      confidence: 0,
      analysis: "",
      crop: null,
      marks: [],
      warning: "Redline view alignment requires both the uploaded redline image and a portable Revit view preview."
    };
  }

  const client = createOpenAiClient(apiKey);
  const model = (args.model ?? process.env.OPERATOR_OPENAI_MODEL ?? "gpt-5.6-sol").trim();
  const reasoningEffort = (args.reasoning_effort ?? process.env.OPERATOR_REDLINE_ALIGNMENT_REASONING_EFFORT ?? "none").trim().toLowerCase();
  const serviceTier = (process.env.OPERATOR_OPENAI_SERVICE_TIER ?? "priority").trim().toLowerCase();
  const maxOutputTokens = Math.max(3000, Number.parseInt(String(args.max_output_tokens ?? "5000"), 10) || 5000);

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["matched", "confidence", "analysis", "crop", "marks"],
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

  const prompt = [
    "Image 1 is a user-provided redline screenshot or crop. Image 2 is a full exported Revit view.",
    "Match the underlying drawing geometry, not the red markup.",
    "Return the rectangle in image 2 that corresponds to image 1 using normalized coordinates from 0 to 1.",
    "Then return the intended insertion point of each explicit red markup target from image 1 mapped into image 2, also normalized 0 to 1.",
    "For MEP route redlines, nearby text such as '12x10 supply duct' or '6-inch water pipe' is only a label. The target is the separate red route line/polyline near that text.",
    "When a label and a separate red line are both present, map the center of the red route line/polyline itself. Do not map the center, baseline, lower edge, or visual underline of the text unless the only markup is truly text formatting.",
    "If the red route line is spatially offset from the callout text, preserve that offset in image 2 even when the text is easier to read.",
    "For add/place device redlines, the target is the wall-adjacent position indicated by the red stroke itself. If the red markup is a tick, circle, or short hand-drawn stroke crossing a wall, use the stroke center projected to the nearest matching wall, preserving its along-wall position.",
    "Do not snap the target to a nearby existing receptacle, circuit label, room label, sink, stair, or other drawing symbol unless the red markup directly encloses that exact symbol. Existing devices are context for type/circuit only, not the insertion point.",
    "Keep the mark position consistent with the returned crop: if a red mark is at normalized image-1 point (x,y), its mapped image-2 point should be near crop.min + (x,y) * crop.size. A semantic adjustment larger than a small symbol width is a low-confidence result and should set matched=false.",
    "If the images are not the same drawing/view, set matched=false and return marks=[].",
    "Do not guess. Low confidence should produce matched=false.",
    args.objective && args.objective.trim() ? `Task context: ${args.objective.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n");

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

    return parseResult(extractResponseText(response));
  } catch (err) {
    return {
      ok: false,
      matched: false,
      confidence: 0,
      analysis: "",
      crop: null,
      marks: [],
      warning: err instanceof Error ? err.message : "OpenAI view alignment failed."
    };
  }
}
