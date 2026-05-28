import fs from "node:fs";
import path from "node:path";
import { analyzeRedlineFile } from "../redline/redline_analyzer.js";
import { resolveExistingFileUnderWorkspace } from "../workspace.js";

type GeminiApiPart = {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
  executableCode?: unknown;
  codeExecutionResult?: unknown;
};

type GeminiApiResponse = {
  candidates?: Array<{
    content?: {
      parts?: GeminiApiPart[];
    };
  }>;
};

export type GeminiFloorplanExtractRequest = {
  file_path: string;
  scale_ratio: number;
  detect_doors: boolean;
  crop_min_x?: number;
  crop_min_y?: number;
  crop_max_y?: number;
  timeout_ms?: number;
};

type FloorplanPixelLine = {
  id?: string;
  start_px?: [number, number];
  end_px?: [number, number];
  thickness_px?: number | null;
  height_ft?: number | null;
};

type FloorplanPixelDoor = {
  id?: string;
  position_px?: [number, number];
  width_px?: number | null;
  height_ft?: number | null;
};

type FloorplanPixelGeometry = {
  summary: string;
  warnings: string[];
  global_confidence: number;
  walls: FloorplanPixelLine[];
  raw_segments: FloorplanPixelLine[];
  doors: FloorplanPixelDoor[];
  notes?: string;
};

function parseBool(v: string | undefined, fallback: boolean): boolean {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return fallback;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function truncate(s: string, maxChars: number): string {
  if (!s) return "";
  return s.length <= maxChars ? s : s.slice(0, maxChars) + "…(truncated)";
}

function geminiApiKey(): string {
  return (process.env.OPERATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "").trim();
}

function geminiVisionEnabled(): boolean {
  return parseBool(process.env.OPERATOR_GEMINI_VISION_ENABLED, true);
}

function geminiCodeExecutionEnabledDefault(): boolean {
  return parseBool(process.env.OPERATOR_GEMINI_ENABLE_CODE_EXECUTION, true);
}

function geminiTimeoutMs(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_TIMEOUT_MS ?? "90000", 10);
  if (!Number.isFinite(n)) return 90_000;
  return clamp(n, 2_000, 180_000);
}

function geminiBaseUrl(): string {
  return (process.env.OPERATOR_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").trim().replace(/\/+$/, "");
}

function geminiModel(): string {
  return (process.env.OPERATOR_GEMINI_MODEL || "gemini-3-flash-preview").trim();
}

function geminiModelCandidates(preferred: string): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    const text = value.trim();
    if (!text || out.includes(text)) return;
    out.push(text);
  };
  const prefNorm = (preferred || "").trim().toLowerCase();
  if (prefNorm === "gemini-3-flash") {
    push("gemini-3-flash-preview");
    push("gemini-3-flash");
  } else if (prefNorm.startsWith("gemini-3")) {
    push(preferred);
    push("gemini-3-flash-preview");
    push("gemini-3-flash");
  } else {
    push(preferred);
    push("gemini-3-flash-preview");
    push("gemini-3-flash");
  }

  const envFallbacks = (process.env.OPERATOR_GEMINI_MODEL_FALLBACKS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const fallback of envFallbacks) push(fallback);
  if ((preferred || "").toLowerCase().startsWith("gemini-3")) push("gemini-2.5-flash");
  return out;
}

function responseLikelyModelMismatch(status: number, bodyText: string): boolean {
  if (status === 404 || status === 501) return true;
  if (status !== 400) return false;
  const body = (bodyText || "").toLowerCase();
  return body.includes("model") && (body.includes("not found") || body.includes("not supported") || body.includes("unsupported"));
}

function extractTextFromGeminiPart(part: GeminiApiPart): string[] {
  const out: string[] = [];
  if (typeof part.text === "string" && part.text.trim()) out.push(part.text.trim());

  const codeResult = part.codeExecutionResult as Record<string, unknown> | undefined;
  if (codeResult && typeof codeResult === "object") {
    for (const v of [codeResult.output, codeResult.stdout, codeResult.result, codeResult.text]) {
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }

  const execCode = part.executableCode as Record<string, unknown> | undefined;
  if (execCode && typeof execCode === "object" && typeof execCode.code === "string" && execCode.code.trim()) {
    out.push(execCode.code.trim());
  }

  return out;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // ignore
  }
  return null;
}

function extractJsonCodeBlocks(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  const rx = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(text)) !== null) {
    const block = (match[1] ?? "").trim();
    if (block) out.push(block);
    if (out.length >= 20) break;
  }
  return out;
}

function extractBalancedJsonObjects(text: string, maxObjects = 40): string[] {
  const out: string[] = [];
  if (!text) return out;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i] as string;
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          start = i;
          break;
        }
      }
    }
    if (out.length >= maxObjects) break;
  }
  return out;
}

function normalizePoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = toFiniteNumber(value[0]);
  const y = toFiniteNumber(value[1]);
  if (x === null || y === null) return null;
  return [x, y];
}

function normalizeLine(value: unknown): FloorplanPixelLine | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const start = normalizePoint(obj.start_px ?? obj.startPx ?? obj.start);
  const end = normalizePoint(obj.end_px ?? obj.endPx ?? obj.end);
  if (!start || !end) return null;
  return {
    ...(typeof obj.id === "string" && obj.id.trim() ? { id: obj.id.trim().slice(0, 80) } : {}),
    start_px: start,
    end_px: end,
    thickness_px: toFiniteNumber(obj.thickness_px ?? obj.thicknessPx ?? obj.thickness),
    height_ft: toFiniteNumber(obj.height_ft ?? obj.heightFt ?? obj.height)
  };
}

function normalizeDoor(value: unknown): FloorplanPixelDoor | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const position = normalizePoint(obj.position_px ?? obj.positionPx ?? obj.position);
  if (!position) return null;
  return {
    ...(typeof obj.id === "string" && obj.id.trim() ? { id: obj.id.trim().slice(0, 80) } : {}),
    position_px: position,
    width_px: toFiniteNumber(obj.width_px ?? obj.widthPx ?? obj.width),
    height_ft: toFiniteNumber(obj.height_ft ?? obj.heightFt ?? obj.height)
  };
}

function scoreGeometryPayload(obj: Record<string, unknown>): number {
  let score = 0;
  if (typeof obj.summary === "string" && obj.summary.trim()) score += 1.5;
  if (Array.isArray(obj.walls)) score += 3 + Math.min(3, obj.walls.length * 0.02);
  if (Array.isArray(obj.raw_segments)) score += 2 + Math.min(2, obj.raw_segments.length * 0.01);
  if (Array.isArray(obj.doors)) score += 1;
  if (typeof obj.global_confidence === "number") score += 0.5;
  return score;
}

function extractBestGeometryPayload(text: string): Record<string, unknown> | null {
  const candidates: Record<string, unknown>[] = [];
  const whole = tryParseObject(text.trim());
  if (whole) candidates.push(whole);
  for (const block of extractJsonCodeBlocks(text)) {
    const parsed = tryParseObject(block);
    if (parsed) candidates.push(parsed);
  }
  for (const raw of extractBalancedJsonObjects(text)) {
    const parsed = tryParseObject(raw);
    if (parsed) candidates.push(parsed);
  }
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestScore = scoreGeometryPayload(best);
  for (let i = 1; i < candidates.length; i++) {
    const score = scoreGeometryPayload(candidates[i]!);
    if (score >= bestScore) {
      best = candidates[i]!;
      bestScore = score;
    }
  }
  return best;
}

function normalizeGeometryPayload(raw: string): FloorplanPixelGeometry {
  const parsed = extractBestGeometryPayload(raw) ?? {};
  const walls = Array.isArray(parsed.walls) ? parsed.walls.map(normalizeLine).filter((x): x is FloorplanPixelLine => !!x) : [];
  const rawSegments = Array.isArray(parsed.raw_segments)
    ? parsed.raw_segments.map(normalizeLine).filter((x): x is FloorplanPixelLine => !!x)
    : Array.isArray(parsed.rawSegments)
      ? parsed.rawSegments.map(normalizeLine).filter((x): x is FloorplanPixelLine => !!x)
      : [];
  const doors = Array.isArray(parsed.doors) ? parsed.doors.map(normalizeDoor).filter((x): x is FloorplanPixelDoor => !!x) : [];
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((x) => typeof x === "string").map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
    : [];
  const summary = typeof parsed.summary === "string" && parsed.summary.trim()
    ? parsed.summary.trim()
    : walls.length > 0
      ? `Gemini extracted ${walls.length} wall centerlines.`
      : "Gemini returned no valid wall geometry.";
  const notes = typeof parsed.notes === "string" && parsed.notes.trim() ? truncate(parsed.notes.trim(), 1000) : undefined;
  return {
    summary,
    warnings,
    global_confidence: clamp(toFiniteNumber(parsed.global_confidence) ?? 0.35, 0, 1),
    walls,
    raw_segments: rawSegments.length > 0 ? rawSegments : walls,
    doors,
    ...(notes ? { notes } : {})
  };
}

function redlinePdfDpi(): number {
  const n = Number.parseInt(process.env.OPERATOR_REDLINE_PDF_DPI ?? "150", 10);
  if (!Number.isFinite(n)) return 150;
  return clamp(n, 72, 300);
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function encodeImagePart(relativePath: string): { mimeType: string; data: string } {
  const full = resolveExistingFileUnderWorkspace(relativePath);
  return {
    mimeType: mimeFromPath(relativePath),
    data: fs.readFileSync(full).toString("base64")
  };
}

function buildPrompt(args: {
  width: number;
  height: number;
  detectDoors: boolean;
  cropMinX: number;
  cropMinY: number;
  cropMaxY: number;
}): string {
  return [
    "You are extracting architectural floor-plan geometry from a single rendered floor-plan image.",
    "Return JSON only. Do not include markdown fences or commentary.",
    "Use image pixel coordinates from the provided full-page image.",
    "Coordinate system rules:",
    `- origin is top-left`,
    `- x increases to the right from 0 to ${Math.round(args.width)}`,
    `- y increases downward from 0 to ${Math.round(args.height)}`,
    `- only extract geometry where x >= ${args.cropMinX}% of image width and y is between ${args.cropMinY}% and ${args.cropMaxY}% of image height`,
    "- walls must be centerlines, not wall faces",
    "- merge obvious collinear fragments when they are clearly the same wall run",
    "- preserve tee and corner continuity where visible",
    `- ${args.detectDoors ? "include door center positions and approximate opening widths when clearly visible" : "do not emit any doors"}`,
    "- raw_segments should be visible wall/vector segments useful as a drawn underlay; if uncertain, reuse wall centerlines there too",
    "Schema:",
    "{",
    '  "summary": "short summary",',
    '  "global_confidence": 0.0,',
    '  "warnings": ["optional warning"],',
    '  "notes": "optional notes",',
    '  "walls": [{"id":"w1","start_px":[100,200],"end_px":[300,200],"thickness_px":8,"height_ft":10}],',
    `  "doors": ${args.detectDoors ? '[{"id":"d1","position_px":[220,200],"width_px":36,"height_ft":7}]' : "[]"},`,
    '  "raw_segments": [{"id":"s1","start_px":[100,200],"end_px":[300,200]}]',
    "}",
    "Requirements:",
    "- keep numeric values finite",
    "- omit elements you cannot see with moderate confidence",
    "- prefer fewer, cleaner walls over many fragmented walls",
    "- do not invent rooms, text, furniture, or dimensions as geometry"
  ].join("\n");
}

function pxToFeet(valuePx: number, feetPerPixel: number): number {
  return Math.round(valuePx * feetPerPixel * 1_000_000) / 1_000_000;
}

function convertPixelGeometryToFeet(args: {
  geometry: FloorplanPixelGeometry;
  imageHeightPx: number;
  feetPerPixel: number;
}) {
  const walls = args.geometry.walls.map((wall, index) => ({
    id: wall.id || `gemini_wall_${index + 1}`,
    element: "wall" as const,
    path: [
      [pxToFeet(wall.start_px![0], args.feetPerPixel), pxToFeet(args.imageHeightPx - wall.start_px![1], args.feetPerPixel)],
      [pxToFeet(wall.end_px![0], args.feetPerPixel), pxToFeet(args.imageHeightPx - wall.end_px![1], args.feetPerPixel)]
    ],
    ...(typeof wall.thickness_px === "number" && Number.isFinite(wall.thickness_px)
      ? { thickness: pxToFeet(Math.max(0, wall.thickness_px), args.feetPerPixel) }
      : {}),
    ...(typeof wall.height_ft === "number" && Number.isFinite(wall.height_ft) && wall.height_ft > 0
      ? { height: wall.height_ft }
      : {})
  }));

  const rawSegments = args.geometry.raw_segments.map((segment, index) => ({
    id: segment.id || `gemini_segment_${index + 1}`,
    element: "raw_segment" as const,
    path: [
      [pxToFeet(segment.start_px![0], args.feetPerPixel), pxToFeet(args.imageHeightPx - segment.start_px![1], args.feetPerPixel)],
      [pxToFeet(segment.end_px![0], args.feetPerPixel), pxToFeet(args.imageHeightPx - segment.end_px![1], args.feetPerPixel)]
    ]
  }));

  const doors = args.geometry.doors.map((door, index) => ({
    id: door.id || `gemini_door_${index + 1}`,
    element: "door" as const,
    position: [
      pxToFeet(door.position_px![0], args.feetPerPixel),
      pxToFeet(args.imageHeightPx - door.position_px![1], args.feetPerPixel)
    ],
    ...(typeof door.width_px === "number" && Number.isFinite(door.width_px) ? { width: pxToFeet(Math.max(0, door.width_px), args.feetPerPixel) } : {}),
    ...(typeof door.height_ft === "number" && Number.isFinite(door.height_ft) && door.height_ft > 0 ? { height: door.height_ft } : {})
  }));

  return { walls, rawSegments, doors };
}

export async function extractFloorPlanWithGemini(req: GeminiFloorplanExtractRequest): Promise<Record<string, unknown>> {
  if (!geminiVisionEnabled()) throw new Error("Gemini vision integration is disabled.");
  const key = geminiApiKey();
  if (!key) throw new Error("Gemini API key is missing.");

  const relativePath = (req.file_path ?? "").trim();
  if (!relativePath) throw new Error("file_path is required.");
  const fullPath = resolveExistingFileUnderWorkspace(relativePath);
  if (path.extname(fullPath).toLowerCase() !== ".pdf") throw new Error("Gemini floor plan extraction currently supports PDF inputs only.");

  const timeoutMs = Math.max(2_000, Math.min(180_000, Math.floor(req.timeout_ms ?? geminiTimeoutMs())));
  const prepass = await analyzeRedlineFile({
    file_path: relativePath,
    include_pdf_annotations: false,
    include_ocr_for_images: false,
    max_pages: 1,
    timeout_ms: Math.min(timeoutMs, 60_000)
  });
  if (!prepass.ok) throw new Error(prepass.warning || "Floor plan prepass failed.");

  const previewPath = (prepass.vision_artifacts?.preview_image_path ?? "").trim();
  if (!previewPath) throw new Error("Floor plan preview image could not be generated.");
  const imageMeta = prepass.image_meta;
  if (!imageMeta || !Number.isFinite(imageMeta.width) || !Number.isFinite(imageMeta.height) || imageMeta.width <= 0 || imageMeta.height <= 0) {
    throw new Error("Floor plan preview image metadata is unavailable.");
  }

  const preferredModel = geminiModel();
  const modelCandidates = geminiModelCandidates(preferredModel);
  const includeCodeExecution = geminiCodeExecutionEnabledDefault();
  const prompt = buildPrompt({
    width: imageMeta.width,
    height: imageMeta.height,
    detectDoors: !!req.detect_doors,
    cropMinX: clamp(toFiniteNumber(req.crop_min_x) ?? 0, 0, 100),
    cropMinY: clamp(toFiniteNumber(req.crop_min_y) ?? 0, 0, 100),
    cropMaxY: clamp(toFiniteNumber(req.crop_max_y) ?? 100, 0, 100)
  });

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    { text: prompt },
    { inlineData: encodeImagePart(previewPath) }
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let rawText = "";
    let usedModel = preferredModel;
    for (let i = 0; i < modelCandidates.length; i++) {
      const candidateModel = modelCandidates[i]!;
      usedModel = candidateModel;
      const endpoint = `${geminiBaseUrl()}/models/${encodeURIComponent(candidateModel)}:generateContent?key=${encodeURIComponent(key)}`;
      const generationConfig: Record<string, unknown> = { temperature: 0.1 };
      if (!includeCodeExecution) generationConfig.responseMimeType = "application/json";
      const body: Record<string, unknown> = {
        contents: [{ role: "user", parts }],
        generationConfig
      };
      if (includeCodeExecution) body.tools = [{ codeExecution: {} }];

      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const responseText = await response.text();
      if (!response.ok) {
        if (i < modelCandidates.length - 1 && responseLikelyModelMismatch(response.status, responseText)) {
          continue;
        }
        throw new Error(`Gemini floor plan request failed (HTTP ${response.status}): ${truncate(responseText.replace(/\s+/g, " ").trim(), 800)}`);
      }

      rawText = "";
      let parsedApi: GeminiApiResponse = {};
      try {
        parsedApi = JSON.parse(responseText) as GeminiApiResponse;
      } catch {
        parsedApi = {};
      }
      for (const candidate of parsedApi.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          const texts = extractTextFromGeminiPart(part);
          for (const text of texts) {
            rawText += (rawText ? "\n" : "") + text;
          }
        }
      }

      const geometryPx = normalizeGeometryPayload(rawText);
      const dpi = redlinePdfDpi();
      const feetPerPixel = 1 / (dpi * Math.max(0.000001, req.scale_ratio) * 12);
      const converted = convertPixelGeometryToFeet({
        geometry: geometryPx,
        imageHeightPx: imageMeta.height,
        feetPerPixel
      });
      const previewBase64 = fs.readFileSync(resolveExistingFileUnderWorkspace(previewPath)).toString("base64");
      const warnings = [
        ...(geometryPx.warnings || []),
        ...(prepass.vision_artifacts?.warning ? [prepass.vision_artifacts.warning] : []),
        ...(prepass.warning ? [prepass.warning] : [])
      ].filter(Boolean);

      return {
        metadata: {
          source: "Gemini Floor Plan Vision",
          units: "feet",
          scale: req.scale_ratio,
          notes: geometryPx.notes || geometryPx.summary,
          raster_image: previewBase64,
          raster_dpi: dpi,
          raster_pixel_width: imageMeta.width,
          raster_pixel_height: imageMeta.height,
          policy_tag: "gemini_floorplan_v1",
          extractor: "gemini",
          preview_relative_path: previewPath
        },
        elements: [
          ...converted.walls,
          ...(req.detect_doors ? converted.doors : []),
          ...converted.rawSegments
        ],
        debug: {
          provider: "gemini",
          model: usedModel,
          summary: geometryPx.summary,
          global_confidence: geometryPx.global_confidence,
          raw_text_excerpt: truncate(rawText, 1800),
          prepass: {
            preview_image_path: previewPath,
            image_meta: imageMeta
          }
        },
        log: {
          notes: warnings
        }
      };
    }

    throw new Error("No usable Gemini model was available for floor plan extraction.");
  } finally {
    clearTimeout(timer);
  }
}
