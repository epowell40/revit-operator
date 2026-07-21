import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureWorkspaceLayout, resolveExistingFileUnderWorkspace } from "../workspace.js";
import { analyzeRedlineFile } from "../redline/redline_analyzer.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";

type RegionBox = {
  index?: number | null;
  x: number;
  y: number;
  w: number;
  h: number;
};

type AnnotationHint = {
  subtype: string;
  color?: string;
  contents?: string;
};

type RelatedRegionGroup = {
  group_index: number;
  region_indices: number[];
  reason: string;
};

export type GeminiRedlineAnalyzeRequest = {
  file_path: string;
  image_paths?: string[];
  expected_sheet?: string;
  analysis_mode?: "redline" | "existing_conditions";
  objective?: string;
  baseline_file_path?: string;
  max_pages?: number;
  page_start?: number;
  region_boxes?: Array<Partial<RegionBox> & Record<string, unknown>>;
  max_regions?: number;
  min_confidence?: number;
  include_code_execution?: boolean;
  timeout_ms?: number;
};

export type GeminiRegionIntent = {
  page_number?: number | null;
  region_index: number | null;
  target_type: "viewport" | "titleblock" | "sheet" | "model_element" | "annotation" | "unknown";
  intent: string;
  rationale: string;
  proposed_action: string;
  size_or_value: string | null;
  confidence: number;
};

export type GeminiRedlineAnalyzeResponse = {
  ok: boolean;
  model: string;
  provider: "gemini";
  used_code_execution: boolean;
  request: {
    file_path: string;
    image_paths: string[];
    image_count: number;
    max_regions: number;
    min_confidence: number;
    page_start: number;
    page_end: number;
  };
  summary: string;
  regions: GeminiRegionIntent[];
  open_questions: string[];
  global_confidence: number;
  preprocess?: {
    converted_pdf_pages?: string[];
    focused_image_paths?: string[];
    context_image_paths?: string[];
    source_region_box_count?: number;
    related_region_groups?: RelatedRegionGroup[];
    warnings?: string[];
  };
  generated_images?: string[];
  raw_text_excerpt?: string;
  warning?: string;
};

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
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

function extractTextFromGeminiPart(part: GeminiApiPart): string[] {
  const out: string[] = [];
  if (typeof part.text === "string" && part.text.trim()) out.push(part.text.trim());

  const codeResult = part.codeExecutionResult as Record<string, unknown> | undefined;
  if (codeResult && typeof codeResult === "object") {
    const preferred = [
      codeResult.output,
      codeResult.stdout,
      codeResult.result,
      codeResult.text
    ];
    for (const v of preferred) {
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }

  const execCode = part.executableCode as Record<string, unknown> | undefined;
  if (execCode && typeof execCode === "object") {
    const code = execCode.code;
    if (typeof code === "string" && code.trim()) out.push(code.trim());
  }
  return out;
}

const MODEL_UNAVAILABLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const modelUnavailableUntilMs = new Map<string, number>();

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
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "…(truncated)";
}

function isImageRelativePath(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp";
}

function isPdfRelativePath(p: string): boolean {
  return path.extname(p).toLowerCase() === ".pdf";
}

function isSupportedInputRelativePath(p: string): boolean {
  return isImageRelativePath(p) || isPdfRelativePath(p);
}

function mimeFromInputPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function extFromMime(mime: string): string {
  const m = (mime ?? "").toLowerCase().trim();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  return ".bin";
}

function normalizeTargetType(v: unknown): GeminiRegionIntent["target_type"] {
  const s = (typeof v === "string" ? v : "").trim().toLowerCase();
  if (s === "viewport" || s === "titleblock" || s === "sheet" || s === "model_element" || s === "annotation") return s;
  return "unknown";
}

function coerceConfidence(v: unknown): number {
  const n = toFiniteNumber(v);
  if (n === null) return 0.5;
  if (n > 1 && n <= 100) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch {
    // ignore
  }
  return null;
}

function extractJsonCodeBlocks(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const rx = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const block = (m[1] ?? "").trim();
    if (block) out.push(block);
    if (out.length >= 20) break;
  }
  return out;
}

function extractBalancedJsonObjects(text: string, maxObjects = 64): string[] {
  if (!text) return [];
  const out: string[] = [];
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

function scoreVisionPayload(obj: Record<string, unknown>): number {
  let score = 0;
  if (typeof obj.summary === "string" && obj.summary.trim()) score += 1.3;
  if (Array.isArray(obj.regions)) score += 2.4 + Math.min(1.6, (obj.regions as unknown[]).length * 0.18);
  if (Array.isArray(obj.open_questions)) score += 0.4;
  if (typeof obj.global_confidence === "number") score += 0.5;
  if ("region_intents" in obj && Array.isArray(obj.region_intents)) score += 1.2;
  return score;
}

function extractBestVisionPayload(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const candidates: Record<string, unknown>[] = [];
  const whole = tryParseObject(text.trim());
  if (whole) candidates.push(whole);
  for (const block of extractJsonCodeBlocks(text)) {
    const parsed = tryParseObject(block);
    if (parsed) candidates.push(parsed);
  }
  for (const rawObj of extractBalancedJsonObjects(text, 80)) {
    const parsed = tryParseObject(rawObj);
    if (parsed) candidates.push(parsed);
  }
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestScore = scoreVisionPayload(best);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const s = scoreVisionPayload(c);
    if (s >= bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

function normalizeRegionIntent(v: unknown): GeminiRegionIntent | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const regionIdx = toFiniteNumber(o.region_index ?? o.regionIndex ?? o.index);
  const pageNumber = toFiniteNumber(o.page_number ?? o.pageNumber ?? o.page);
  const intent = typeof o.intent === "string" ? o.intent.trim() : "";
  const rationale = typeof o.rationale === "string" ? o.rationale.trim() : "";
  const proposed = typeof o.proposed_action === "string" ? o.proposed_action.trim() : typeof o.proposedAction === "string" ? String(o.proposedAction).trim() : "";
  const sizeValue = typeof o.size_or_value === "string" ? o.size_or_value.trim() : typeof o.sizeOrValue === "string" ? String(o.sizeOrValue).trim() : "";
  if (!intent) return null;

  return {
    ...(pageNumber !== null ? { page_number: Math.max(1, Math.floor(pageNumber)) } : {}),
    region_index: regionIdx === null ? null : Math.max(0, Math.floor(regionIdx)),
    target_type: normalizeTargetType(o.target_type ?? o.targetType),
    intent,
    rationale: rationale || "No rationale provided.",
    proposed_action: proposed || "Review and map to nearest supported /revit action.",
    size_or_value: sizeValue || null,
    confidence: coerceConfidence(o.confidence)
  };
}

export function normalizeGeminiVisionOutput(raw: unknown, fallbackText: string): {
  summary: string;
  regions: GeminiRegionIntent[];
  open_questions: string[];
  global_confidence: number;
} {
  let parsed: Record<string, unknown> | null = null;

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    parsed = raw as Record<string, unknown>;
  } else if (typeof raw === "string") {
    parsed = extractBestVisionPayload(raw);
  }

  const summary =
    (parsed && typeof parsed.summary === "string" && parsed.summary.trim()) ||
    (parsed && typeof parsed.overall_summary === "string" && (parsed.overall_summary as string).trim()) ||
    (fallbackText.trim() ? truncate(fallbackText.trim(), 800) : "Gemini returned no textual summary.");

  const rawRegions = parsed && Array.isArray(parsed.regions) ? parsed.regions : [];
  const regions = rawRegions.map(normalizeRegionIntent).filter((x): x is GeminiRegionIntent => !!x);

  const openQuestions = parsed && Array.isArray(parsed.open_questions)
    ? parsed.open_questions.filter(x => typeof x === "string").map(x => x.trim()).filter(Boolean).slice(0, 20)
    : [];

  const gc = parsed ? coerceConfidence(parsed.global_confidence) : 0.5;
  return {
    summary: String(summary),
    regions,
    open_questions: openQuestions,
    global_confidence: gc
  };
}

function normalizeRegionBoxes(raw: unknown): RegionBox[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: RegionBox[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const x = toFiniteNumber(o.x);
    const y = toFiniteNumber(o.y);
    const w = toFiniteNumber(o.w);
    const h = toFiniteNumber(o.h);
    if (x === null || y === null || w === null || h === null) continue;
    if (w <= 0 || h <= 0) continue;
    const idx = toFiniteNumber(o.index ?? o.region_index ?? o.regionIndex);
    out.push({
      ...(idx !== null ? { index: Math.max(0, Math.floor(idx)) } : {}),
      x, y, w, h
    });
  }
  return out;
}

function geminiMaxImages(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_MAX_IMAGES ?? "10", 10);
  if (!Number.isFinite(n)) return 10;
  return clamp(n, 1, 16);
}

function geminiMinContextImages(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_MIN_CONTEXT_IMAGES ?? "2", 10);
  if (!Number.isFinite(n)) return 2;
  return clamp(n, 0, 4);
}

function geminiRelatedRegionGapPx(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_RELATED_REGION_GAP_PX ?? "220", 10);
  if (!Number.isFinite(n)) return 220;
  return clamp(n, 40, 1200);
}

function geminiRelatedRegionExpandRatio(): number {
  const n = toFiniteNumber(process.env.OPERATOR_GEMINI_RELATED_REGION_EXPAND_RATIO ?? "0.35");
  if (n === null) return 0.35;
  return clamp(n, 0.05, 1.2);
}

function geminiRelatedRegionExpandMinPx(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_RELATED_REGION_EXPAND_MIN_PX ?? "80", 10);
  if (!Number.isFinite(n)) return 80;
  return clamp(n, 8, 1200);
}

function boxEdgeGapPx(a: RegionBox, b: RegionBox): { dx: number; dy: number } {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(ax2, bx2));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(ay2, by2));
  return { dx, dy };
}

function unionFindGroups(size: number, links: Array<[number, number]>): number[][] {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (x: number): number => {
    let p = parent[x]!;
    while (p !== parent[p]!) p = parent[p]!;
    let cur = x;
    while (cur !== p) {
      const next = parent[cur]!;
      parent[cur] = p;
      cur = next;
    }
    return p;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (const [a, b] of links) unite(a, b);
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < size; i++) {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(i);
    byRoot.set(r, arr);
  }
  return [...byRoot.values()].map((g) => g.slice().sort((x, y) => x - y));
}

export function computeRelatedRegionGroups(boxes: RegionBox[], gapPx: number = geminiRelatedRegionGapPx()): RelatedRegionGroup[] {
  const safe = boxes
    .map((b, i) => ({
      index: Number.isFinite(b.index as number) ? Math.max(1, Math.floor(Number(b.index))) : i + 1,
      x: Number(b.x),
      y: Number(b.y),
      w: Number(b.w),
      h: Number(b.h)
    }))
    .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h) && b.w > 0 && b.h > 0);
  if (safe.length < 2) return [];

  const links: Array<[number, number]> = [];
  for (let i = 0; i < safe.length; i++) {
    for (let j = i + 1; j < safe.length; j++) {
      const g = boxEdgeGapPx(safe[i] as RegionBox, safe[j] as RegionBox);
      if (g.dx <= gapPx && g.dy <= gapPx) links.push([i, j]);
    }
  }
  if (links.length === 0) return [];

  const groups = unionFindGroups(safe.length, links)
    .filter((g) => g.length >= 2)
    .map((g, idx) => ({
      group_index: idx + 1,
      region_indices: g.map((i) => safe[i]!.index).sort((a, b) => a - b),
      reason: "nearby_marks_may_share_intent"
    }))
    .slice(0, 24);
  return groups;
}

function buildExpandedGroupContextBoxes(boxes: RegionBox[], groups: RelatedRegionGroup[]): RegionBox[] {
  if (boxes.length === 0 || groups.length === 0) return [];
  const byIndex = new Map<number, RegionBox>();
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    const idx = Number.isFinite(b.index as number) ? Math.max(1, Math.floor(Number(b.index))) : i + 1;
    byIndex.set(idx, b);
  }
  const ratio = geminiRelatedRegionExpandRatio();
  const minMargin = geminiRelatedRegionExpandMinPx();
  const out: RegionBox[] = [];
  for (const g of groups) {
    const members = g.region_indices.map((i) => byIndex.get(i)).filter((x): x is RegionBox => !!x);
    if (members.length === 0) continue;
    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.w));
    const maxY = Math.max(...members.map((m) => m.y + m.h));
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const margin = Math.max(minMargin, Math.round(Math.max(w, h) * ratio));
    out.push({
      index: g.group_index,
      x: Math.max(0, Math.round(minX - margin)),
      y: Math.max(0, Math.round(minY - margin)),
      w: Math.max(1, Math.round(w + margin * 2)),
      h: Math.max(1, Math.round(h + margin * 2))
    });
  }
  return out.slice(0, 8);
}

function buildPrompt(args: {
  analysisMode: "redline" | "existing_conditions";
  objective: string;
  expectedSheet: string;
  regionBoxes: RegionBox[];
  annotationHints: AnnotationHint[];
  relatedGroups: RelatedRegionGroup[];
  maxRegions: number;
  minConfidence: number;
  pageStart: number;
  pageCount: number;
}): string {
  const lines: string[] = [];
  if (args.analysisMode === "existing_conditions") {
    lines.push("You are analyzing an unmarked engineering record drawing for existing-conditions reconstruction in CAD/Revit.");
    lines.push("Treat visible colored, dashed, solid, and black lines, symbols, tags, dimensions, and text as source drawing content—not as redlines, revisions, or requested style changes.");
    lines.push("Inventory only source-supported mechanical, electrical, plumbing, fixture/device, fitting, connector, and annotation observations. Preserve visible sizes, endpoints, branches, relative locations, and ambiguity.");
    lines.push("Use intent to describe the observed existing condition and proposed_action to describe the smallest faithful modeling or verification action; never invent demolition, additions, or line-style changes.");
  } else {
    lines.push("You are analyzing engineering redlines on drawings for downstream CAD/Revit execution.");
  }
  lines.push("Use code execution when helpful to inspect/crop/compare marked regions.");
  lines.push("After analysis, end your response with a single ```json fenced block that matches the schema.");
  lines.push("Do not include additional prose after the final JSON block.");
  lines.push("");
  lines.push(`Objective: ${args.objective}`);
  if (args.expectedSheet) lines.push(`Expected sheet hint: ${args.expectedSheet}`);
  lines.push(
    args.pageCount === 1
      ? `PDF page represented by this request: ${args.pageStart}.`
      : `PDF page range represented by this request: ${args.pageStart}-${args.pageStart + args.pageCount - 1}. Report page_number for every region.`
  );
  lines.push(`Max regions to report: ${args.maxRegions}`);
  lines.push(`Minimum confidence to include in regions: ${args.minConfidence.toFixed(2)}`);
  lines.push("");
  if (args.regionBoxes.length > 0) {
    lines.push("Known region boxes (pixel space):");
    lines.push(JSON.stringify(args.regionBoxes.slice(0, 120)));
    lines.push("");
    lines.push("If boxes are provided, align each extracted intent to the nearest box and set region_index.");
    if (args.relatedGroups.length > 0) {
      lines.push("Nearby region groups (likely related intent; evaluate as one semantic cluster before deciding final actions):");
      lines.push(JSON.stringify(args.relatedGroups.slice(0, 24)));
      lines.push("When any region in a group has an explicit directive, consider adjacent grouped regions as supporting context.");
    }
  } else {
    lines.push("No region boxes provided. Infer regions visually.");
  }
  if (args.annotationHints.length > 0) {
    lines.push("");
    lines.push("PDF annotation metadata hints (high-priority markup evidence):");
    lines.push(JSON.stringify(args.annotationHints.slice(0, 16)));
    lines.push(
      args.analysisMode === "existing_conditions"
        ? "Treat these hints as source-document annotation metadata, not as edit instructions unless the document explicitly proves otherwise."
        : "Treat these hints as intentional engineer markups, even when markup color is not red."
    );
  }
  lines.push("");
  lines.push("Return schema:");
  lines.push("{");
  lines.push('  "summary": "short overall summary",');
  lines.push('  "global_confidence": 0.0,');
  lines.push('  "regions": [');
  lines.push("    {");
  lines.push('      "page_number": 1,');
  lines.push('      "region_index": 1,');
  lines.push('      "target_type": "viewport|titleblock|sheet|model_element|annotation|unknown",');
  lines.push('      "intent": "what change is requested",');
  lines.push('      "rationale": "visual evidence",');
  lines.push('      "proposed_action": "actionable instruction for downstream tool-calling model",');
  lines.push('      "size_or_value": "dimension/value if visible, else null",');
  lines.push('      "confidence": 0.0');
  lines.push("    }");
  lines.push("  ],");
  lines.push('  "open_questions": ["ambiguities requiring user clarification"]');
  lines.push("}");
  lines.push("");
  lines.push("Do not hallucinate exact dimensions. If uncertain, state uncertainty and add an open question.");
  return lines.join("\n");
}

function geminiApiKey(): string {
  return (process.env.OPERATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "").trim();
}

function geminiModel(): string {
  return (process.env.OPERATOR_GEMINI_MODEL || "gemini-3-flash-preview").trim();
}

function geminiModelCandidates(preferred: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (m: string | null | undefined) => {
    const s = (m ?? "").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const prefNorm = (preferred || "").trim().toLowerCase();
  if (prefNorm === "gemini-3-flash") {
    // gemini-3-flash often aliases to preview in deployed runtimes; prefer preview first.
    push("gemini-3-flash-preview");
    push("gemini-3-flash");
  } else {
    push(preferred);
  }
  if (prefNorm.startsWith("gemini-3")) {
    push("gemini-3-flash-preview");
    push("gemini-3-flash");
  } else {
    push("gemini-3-flash");
    push("gemini-3-flash-preview");
  }

  const envFallbacks = (process.env.OPERATOR_GEMINI_MODEL_FALLBACKS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const f of envFallbacks) push(f);

  if ((preferred || "").toLowerCase().startsWith("gemini-3")) {
    push("gemini-2.5-flash");
  }
  const now = Date.now();
  const filtered = out.filter((m) => {
    const until = modelUnavailableUntilMs.get(m) ?? 0;
    return until <= now;
  });
  return filtered.length > 0 ? filtered : out;
}

function responseLikelyModelMismatch(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 404) return false;
  const t = (bodyText ?? "").toLowerCase();
  return (
    t.includes("not found") ||
    t.includes("model") && t.includes("supported") ||
    t.includes("unknown model") ||
    t.includes("invalid model")
  );
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

function geminiMaxImageBytes(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_MAX_IMAGE_BYTES ?? `${6 * 1024 * 1024}`, 10);
  if (!Number.isFinite(n)) return 6 * 1024 * 1024;
  return clamp(n, 128 * 1024, 20 * 1024 * 1024);
}

function geminiInlinePartHardLimitBytes(): number {
  // Keep below provider inline_data hard limit (10 MB) with a safety margin.
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_INLINE_PART_HARD_LIMIT_BYTES ?? `${9 * 1024 * 1024}`, 10);
  if (!Number.isFinite(n)) return 9 * 1024 * 1024;
  return clamp(n, 256 * 1024, 9_900_000);
}

function geminiMaxRequestInlineBytes(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_MAX_REQUEST_INLINE_BYTES ?? `${26 * 1024 * 1024}`, 10);
  if (!Number.isFinite(n)) return 26 * 1024 * 1024;
  return clamp(n, 1 * 1024 * 1024, 80 * 1024 * 1024);
}

function geminiMaxInputFileBytes(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_MAX_INPUT_FILE_BYTES ?? `${20 * 1024 * 1024}`, 10);
  if (!Number.isFinite(n)) return 20 * 1024 * 1024;
  return clamp(n, 256 * 1024, 50 * 1024 * 1024);
}

function geminiMaxPdfInputFileBytes(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_MAX_PDF_INPUT_FILE_BYTES ?? `${200 * 1024 * 1024}`, 10);
  if (!Number.isFinite(n)) return 200 * 1024 * 1024;
  return clamp(n, 1 * 1024 * 1024, 500 * 1024 * 1024);
}

function geminiPdfDpi(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_PDF_DPI ?? "150", 10);
  if (!Number.isFinite(n)) return 150;
  return clamp(n, 72, 300);
}

function geminiBaseUrl(): string {
  return (process.env.OPERATOR_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").trim().replace(/\/+$/, "");
}

function isGeneratedRedlineArtifactPath(p: string): boolean {
  const s = (p ?? "").trim().replace(/\\/g, "/").toLowerCase();
  return s.startsWith("artifacts/redline/");
}

function candidateInputPaths(req: GeminiRedlineAnalyzeRequest): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const hasPrimaryFile = typeof req.file_path === "string" && !!req.file_path.trim();
  const push = (v: string | null | undefined) => {
    const s = (v ?? "").trim().replace(/\\/g, "/");
    if (!s || seen.has(s)) return;
    if (!isSupportedInputRelativePath(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(req.image_paths)) {
    for (const p of req.image_paths) {
      const s = (p ?? "").trim().replace(/\\/g, "/");
      // Avoid stale, duplicated generated crops from prior rounds when file_path is present.
      if (hasPrimaryFile && isGeneratedRedlineArtifactPath(s)) continue;
      push(s);
    }
  }
  push(req.file_path);
  return out;
}

function toWorkspaceRelativePath(absPath: string): string | null {
  try {
    const ws = ensureWorkspaceLayout();
    const rel = path.relative(ws.root, absPath);
    if (!rel || rel.startsWith("..")) return null;
    return rel.replace(/\\/g, "/");
  } catch {
    return null;
  }
}

function pythonExecEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const userBase = (env.OPERATOR_PYTHON_USER_BASE || "/var/lib/revitoperator/python-user").trim();
  if (!userBase) return env;
  env.OPERATOR_PYTHON_USER_BASE = userBase;
  env.PYTHONUSERBASE = userBase;

  const candidateSiteDirs = [
    path.join(userBase, "lib", "python3.13", "site-packages"),
    path.join(userBase, "lib", "python3.12", "site-packages"),
    path.join(userBase, "lib", "python3.11", "site-packages"),
    path.join(userBase, "lib", "python3.10", "site-packages"),
    path.join(userBase, "lib", "python3.9", "site-packages"),
    path.join(userBase, "lib", "python3.8", "site-packages"),
    path.join(userBase, "Lib", "site-packages")
  ].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  if (candidateSiteDirs.length > 0) {
    const existing = (env.PYTHONPATH || "").split(path.delimiter).filter(Boolean);
    const merged = [...candidateSiteDirs, ...existing];
    env.PYTHONPATH = [...new Set(merged)].join(path.delimiter);
  }
  return env;
}

function runPythonJson(code: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  const argvFor = (exe: string) => (exe === "py" ? ["-3", "-"] : ["-"]);

  return new Promise((resolve) => {
    let idx = 0;
    const next = () => {
      if (idx >= candidates.length) {
        resolve({ ok: false, stdout: "", stderr: "No Python runtime available." });
        return;
      }
      const exe = candidates[idx++]!;
      let done = false;
      let stdout = "";
      let stderr = "";
      let child;
      try {
        child = spawn(exe, argvFor(exe), { stdio: "pipe", env: pythonExecEnv() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/ENOENT|not found|cannot find/i.test(msg)) return next();
        resolve({ ok: false, stdout: "", stderr: msg });
        return;
      }

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve({ ok: false, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms.`.trim() });
      }, Math.max(1_000, timeoutMs));

      child.on("error", (err) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        const msg = err instanceof Error ? err.message : String(err);
        if (/ENOENT|not found|cannot find/i.test(msg)) return next();
        resolve({ ok: false, stdout, stderr: `${stderr}\n${msg}`.trim() });
      });
      child.stdout.on("data", d => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", d => {
        stderr += d.toString("utf8");
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        if (code === 0) resolve({ ok: true, stdout, stderr });
        else resolve({ ok: false, stdout, stderr: `${stderr}\nexit=${code}`.trim() });
      });

      try {
        child.stdin.write(code, "utf8");
      } catch {
        // ignore
      }
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
    };
    next();
  });
}

async function bestEffortConvertPdfToJpegPages(args: {
  pdfRelativePath: string;
  maxPages: number;
  pageStart: number;
  dpi: number;
  timeoutMs: number;
}): Promise<{ ok: boolean; page_paths: string[]; warning?: string }> {
  let fullPdf = "";
  try {
    fullPdf = resolveExistingFileUnderWorkspace(args.pdfRelativePath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, page_paths: [], warning: truncate(msg, 260) };
  }

  const ws = ensureWorkspaceLayout();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rid = Math.random().toString(36).slice(2, 8);
  const outDir = path.join(ws.root, "artifacts", "redline", "gemini", `${stamp}_${rid}_pdf`);
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const canvasMod = await (Function("specifier", "return import(specifier)")("@napi-rs/canvas") as Promise<any>);
    const createCanvas = canvasMod?.createCanvas;
    if (typeof createCanvas === "function") {
      const bytes = fs.readFileSync(fullPdf);
      const pdfjs = await loadPdfJsForNode();
      const doc = await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(bytes))).promise;
      const firstPage = Math.max(1, Math.min(Number(doc.numPages ?? 0) || 1, Math.floor(args.pageStart)));
      const count = Math.max(0, Math.min(8, args.maxPages, Number(doc.numPages ?? 0) - firstPage + 1));
      const scale = Math.max(72, Math.min(300, args.dpi)) / 72;
      const paths: string[] = [];
      for (let offset = 0; offset < count; offset++) {
        const pageNumber = firstPage + offset;
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const output = path.join(outDir, `page_${String(pageNumber).padStart(4, "0")}.png`);
        fs.writeFileSync(output, canvas.toBuffer("image/png"));
        paths.push(output);
      }
      const relativePaths = paths.map((entry) => toWorkspaceRelativePath(entry)).filter((entry): entry is string => !!entry);
      if (relativePaths.length > 0) return { ok: true, page_paths: relativePaths };
    }
  } catch {
    // Fall through to the Python/Poppler converters below.
  }

  const py = `
import json
import os
import glob
import shutil
import subprocess

pdf_path = ${JSON.stringify(fullPdf)}
out_dir = ${JSON.stringify(outDir)}
max_pages = int(${JSON.stringify(Math.max(1, Math.min(8, args.maxPages)))})
page_start = int(${JSON.stringify(Math.max(1, Math.floor(args.pageStart)))})
dpi = int(${JSON.stringify(Math.max(72, Math.min(300, args.dpi)))})

os.makedirs(out_dir, exist_ok=True)
paths = []
errors = []
method = ""

def rel_paths(xs):
    return [x for x in xs if os.path.isfile(x)]

try:
    import fitz  # PyMuPDF
    doc = fitz.open(pdf_path)
    first = min(max(0, page_start - 1), len(doc))
    count = min(max_pages, max(0, len(doc) - first))
    for offset in range(count):
        page_number = first + offset
        page = doc.load_page(page_number)
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        p = os.path.join(out_dir, f"page_{page_number+1:04d}.jpg")
        pix.save(p)
        paths.append(p)
    if paths:
        method = "fitz"
except Exception as e:
    errors.append(f"fitz:{e}")

if not paths:
    try:
        from pdf2image import convert_from_path
        last_page = page_start + max_pages - 1
        images = convert_from_path(pdf_path, dpi=dpi, first_page=page_start, last_page=last_page, fmt="jpeg")
        for offset, im in enumerate(images):
            page_number = page_start + offset
            p = os.path.join(out_dir, f"page_{page_number:04d}.jpg")
            im.save(p, "JPEG")
            paths.append(p)
        if paths:
            method = "pdf2image"
    except Exception as e:
        errors.append(f"pdf2image:{e}")

if not paths:
    try:
        exe = shutil.which("pdftoppm")
        if exe:
            prefix = os.path.join(out_dir, "page")
            r = subprocess.run([exe, "-jpeg", "-f", str(page_start), "-l", str(page_start + max_pages - 1), "-r", str(dpi), pdf_path, prefix], capture_output=True, text=True)
            if r.returncode == 0:
                paths = sorted(glob.glob(prefix + "-*.jpg"))
                if paths:
                    method = "pdftoppm"
            else:
                errors.append(f"pdftoppm:{r.stderr.strip()}")
        else:
            errors.append("pdftoppm:missing")
    except Exception as e:
        errors.append(f"pdftoppm:{e}")

paths = rel_paths(paths)
if paths:
    print(json.dumps({"ok": True, "method": method, "page_paths": paths}))
else:
    print(json.dumps({"ok": False, "error": "; ".join(errors) if errors else "No PDF converter available.", "page_paths": []}))
`;

  const r = await runPythonJson(py, Math.max(4_000, args.timeoutMs));
  if (!r.ok && !r.stdout.trim()) {
    return { ok: false, page_paths: [], warning: truncate(r.stderr || "PDF conversion failed.", 280) };
  }

  try {
    const parsed = JSON.parse((r.stdout || "").trim()) as any;
    const relPaths = Array.isArray(parsed?.page_paths)
      ? parsed.page_paths.map((p: any) => (typeof p === "string" ? toWorkspaceRelativePath(p) : null)).filter((p: string | null): p is string => !!p)
      : [];
    if (relPaths.length > 0) return { ok: true, page_paths: relPaths };
    return {
      ok: false,
      page_paths: [],
      warning: typeof parsed?.error === "string" && parsed.error.trim() ? truncate(parsed.error, 320) : "PDF conversion returned no images."
    };
  } catch {
    return { ok: false, page_paths: [], warning: truncate(r.stdout || r.stderr || "PDF conversion parse failed.", 320) };
  }
}

async function bestEffortShrinkImageForGemini(args: {
  imageRelativePath: string;
  maxBytes: number;
  timeoutMs: number;
}): Promise<{ ok: boolean; image_path?: string; warning?: string }> {
  let fullImage = "";
  try {
    fullImage = resolveExistingFileUnderWorkspace(args.imageRelativePath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, warning: truncate(msg, 240) };
  }

  const ws = ensureWorkspaceLayout();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rid = Math.random().toString(36).slice(2, 8);
  const outDir = path.join(ws.root, "artifacts", "redline", "gemini", `${stamp}_${rid}_shrink`);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(args.imageRelativePath, path.extname(args.imageRelativePath)).replace(/[^A-Za-z0-9._-]+/g, "_");
  const outPath = path.join(outDir, `${base || "input"}_gemini.jpg`);

  const py = `
import json
import os
from PIL import Image

src = ${JSON.stringify(fullImage)}
dst = ${JSON.stringify(outPath)}
max_bytes = int(${JSON.stringify(Math.max(64 * 1024, Math.min(20 * 1024 * 1024, Math.floor(args.maxBytes))))})

try:
    img = Image.open(src).convert("RGB")
except Exception as e:
    print(json.dumps({"ok": False, "error": f"open:{e}"}))
    raise SystemExit(0)

qualities = [88, 82, 76, 70, 64, 58]
scale = 1.0
best_ok = False
for _ in range(8):
    w = max(640, int(round(img.width * scale)))
    h = max(480, int(round(img.height * scale)))
    resized = img.resize((w, h), Image.LANCZOS) if (w != img.width or h != img.height) else img
    for q in qualities:
      try:
          resized.save(dst, format="JPEG", quality=q, optimize=True)
      except Exception:
          resized.save(dst, format="JPEG", quality=q)
      if os.path.isfile(dst) and os.path.getsize(dst) <= max_bytes:
          best_ok = True
          break
    if best_ok:
        break
    scale *= 0.85

if best_ok and os.path.isfile(dst):
    print(json.dumps({"ok": True, "path": dst, "bytes": os.path.getsize(dst)}))
else:
    err = "Could not shrink image under max byte cap."
    if os.path.isfile(dst):
        err += f" last_size={os.path.getsize(dst)}"
    print(json.dumps({"ok": False, "error": err}))
`;

  const r = await runPythonJson(py, Math.max(3_000, args.timeoutMs));
  if (!r.ok && !r.stdout.trim()) {
    return { ok: false, warning: truncate(r.stderr || "Image shrink failed.", 280) };
  }
  try {
    const parsed = JSON.parse((r.stdout || "").trim()) as any;
    if (!parsed || typeof parsed !== "object") return { ok: false, warning: "Invalid image-shrink JSON output." };
    if (parsed.ok && typeof parsed.path === "string" && parsed.path.trim()) {
      const rel = toWorkspaceRelativePath(parsed.path.trim());
      if (rel) return { ok: true, image_path: rel };
    }
    const err = typeof parsed.error === "string" ? parsed.error : "Image shrink returned no file.";
    return { ok: false, warning: truncate(err, 320) };
  } catch {
    return { ok: false, warning: truncate(r.stdout || r.stderr || "Image shrink parse failed.", 320) };
  }
}

async function bestEffortRenderContextCrops(args: {
  imageRelativePath: string;
  boxes: RegionBox[];
  timeoutMs: number;
}): Promise<{ ok: boolean; crop_paths: string[]; warning?: string }> {
  if (!args.imageRelativePath || !Array.isArray(args.boxes) || args.boxes.length === 0) {
    return { ok: false, crop_paths: [] };
  }
  let imageFull = "";
  try {
    imageFull = resolveExistingFileUnderWorkspace(args.imageRelativePath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, crop_paths: [], warning: truncate(msg, 220) };
  }

  const safe = args.boxes
    .map((b) => ({
      x: Math.round(Number(b.x)),
      y: Math.round(Number(b.y)),
      w: Math.round(Number(b.w)),
      h: Math.round(Number(b.h))
    }))
    .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h) && b.w > 0 && b.h > 0)
    .slice(0, 8);
  if (safe.length === 0) return { ok: false, crop_paths: [] };

  const ws = ensureWorkspaceLayout();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rid = Math.random().toString(36).slice(2, 8);
  const outDir = path.join(ws.root, "artifacts", "redline", "gemini", `${stamp}_${rid}_ctx`);
  fs.mkdirSync(outDir, { recursive: true });

  const py = `
import json
import os
from PIL import Image

src = ${JSON.stringify(imageFull)}
out_dir = ${JSON.stringify(outDir)}
boxes = ${JSON.stringify(safe)}
os.makedirs(out_dir, exist_ok=True)

try:
    img = Image.open(src).convert("RGB")
except Exception as e:
    print(json.dumps({"ok": False, "error": f"open:{e}", "crop_paths": []}))
    raise SystemExit(0)

crop_paths = []
for i, b in enumerate(boxes, start=1):
    x = int(b.get("x", 0))
    y = int(b.get("y", 0))
    w = int(b.get("w", 0))
    h = int(b.get("h", 0))
    if w <= 0 or h <= 0:
        continue
    l = max(0, x)
    t = max(0, y)
    r = min(img.width, x + w)
    btm = min(img.height, y + h)
    if r <= l or btm <= t:
        continue
    crop = img.crop((l, t, r, btm))
    crop_abs = os.path.join(out_dir, f"group_context_{i:02d}.png")
    crop.save(crop_abs)
    crop_paths.append(crop_abs)

print(json.dumps({"ok": True, "crop_paths": crop_paths}))
`;
  const r = await runPythonJson(py, Math.max(3_000, args.timeoutMs));
  if (!r.ok && !r.stdout.trim()) {
    return { ok: false, crop_paths: [], warning: truncate(r.stderr || "Context crop render failed.", 260) };
  }
  try {
    const parsed = JSON.parse((r.stdout || "").trim()) as any;
    const rel = Array.isArray(parsed?.crop_paths)
      ? parsed.crop_paths
          .map((p: any) => (typeof p === "string" ? toWorkspaceRelativePath(p) : null))
          .filter((p: string | null): p is string => !!p)
      : [];
    if (rel.length > 0) return { ok: true, crop_paths: rel };
    const err = typeof parsed?.error === "string" ? parsed.error : "No context crop images rendered.";
    return { ok: false, crop_paths: [], warning: truncate(err, 260) };
  } catch {
    return { ok: false, crop_paths: [], warning: truncate(r.stdout || r.stderr || "Context crop parse failed.", 260) };
  }
}

function saveGeneratedInlineImage(dataBase64: string, mime: string, index: number): string | null {
  try {
    if (!dataBase64 || !mime) return null;
    const ws = ensureWorkspaceLayout();
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const outDir = path.join(ws.root, "artifacts", "redline", "gemini", stamp);
    fs.mkdirSync(outDir, { recursive: true });
    const ext = extFromMime(mime);
    const outPath = path.join(outDir, `generated_${index}${ext}`);
    fs.writeFileSync(outPath, Buffer.from(dataBase64, "base64"));
    return path.relative(ws.root, outPath).replace(/\\/g, "/");
  } catch {
    return null;
  }
}

export async function analyzeRedlineWithGemini(req: GeminiRedlineAnalyzeRequest): Promise<GeminiRedlineAnalyzeResponse> {
  const preferredModel = geminiModel();
  const modelCandidates = geminiModelCandidates(preferredModel);
  const key = geminiApiKey();
  const includeCodeExecution = typeof req.include_code_execution === "boolean" ? req.include_code_execution : geminiCodeExecutionEnabledDefault();
  const maxRegions = Math.max(1, Math.min(200, Math.floor(req.max_regions ?? 80)));
  const minConfidence = clamp(toFiniteNumber(req.min_confidence) ?? 0.35, 0, 1);
  const timeoutMs = Math.max(2_000, Math.min(180_000, Math.floor(req.timeout_ms ?? geminiTimeoutMs())));
  const maxPages = Math.max(1, Math.min(8, Math.floor(req.max_pages ?? 2)));
  const pageStart = Math.max(1, Math.floor(req.page_start ?? 1));
  const maxInputs = geminiMaxImages();
  const maxImageBytes = geminiMaxImageBytes();
  const maxInlinePartBytes = Math.min(maxImageBytes, geminiInlinePartHardLimitBytes());
  const maxRequestInlineBytes = geminiMaxRequestInlineBytes();
  const maxInputFileBytes = geminiMaxInputFileBytes();
  const maxPdfInputFileBytes = geminiMaxPdfInputFileBytes();
  const warnings: string[] = [];
  let sourceRegionBoxes = normalizeRegionBoxes(req.region_boxes);
  const focusedPaths: string[] = [];
  const contextPaths: string[] = [];
  let relatedGroups: RelatedRegionGroup[] = [];
  const annotationHints: AnnotationHint[] = [];
  const seenFocused = new Set<string>();
  const seenContext = new Set<string>();
  const pushFocused = (p: string | null | undefined): void => {
    const s = (p ?? "").trim().replace(/\\/g, "/");
    if (!s || seenFocused.has(s) || !isImageRelativePath(s)) return;
    seenFocused.add(s);
    focusedPaths.push(s);
  };
  const pushContext = (p: string | null | undefined): void => {
    const s = (p ?? "").trim().replace(/\\/g, "/");
    if (!s || seenContext.has(s) || !isImageRelativePath(s)) return;
    seenContext.add(s);
    contextPaths.push(s);
  };
  const buildPreprocess = (): GeminiRedlineAnalyzeResponse["preprocess"] | undefined => {
    const pp: NonNullable<GeminiRedlineAnalyzeResponse["preprocess"]> = {
      ...(convertedPdfPages.length > 0 ? { converted_pdf_pages: convertedPdfPages } : {}),
      ...(focusedPaths.length > 0 ? { focused_image_paths: focusedPaths.slice(0, 20) } : {}),
      ...(contextPaths.length > 0 ? { context_image_paths: contextPaths.slice(0, 20) } : {}),
      ...(sourceRegionBoxes.length > 0 ? { source_region_box_count: sourceRegionBoxes.length } : {}),
      ...(relatedGroups.length > 0 ? { related_region_groups: relatedGroups.slice(0, 24) } : {}),
      ...(warnings.length > 0 ? { warnings: warnings.slice(0, 20) } : {})
    };
    return Object.keys(pp).length > 0 ? pp : undefined;
  };

  const requestedPaths = candidateInputPaths(req);
  const preprocessedPaths: string[] = [];
  const convertedPdfPages: string[] = [];
  const seenPre = new Set<string>();
  const pushPre = (p: string | null | undefined) => {
    const s = (p ?? "").trim().replace(/\\/g, "/");
    if (!s || seenPre.has(s)) return;
    seenPre.add(s);
    preprocessedPaths.push(s);
  };

  // Deterministic prepass: run the local analyzer first so Gemini gets focused boxes/crops
  // from baseline diff and/or PDF annotation metadata whenever available.
  if ((req.file_path ?? "").trim()) {
    try {
      const baselinePath =
        typeof req.baseline_file_path === "string" && req.baseline_file_path.trim() ? req.baseline_file_path.trim() : undefined;
      const analyzed = await analyzeRedlineFile({
        file_path: (req.file_path ?? "").trim(),
        ...(baselinePath ? { baseline_file_path: baselinePath } : {}),
        include_ocr_for_images: false,
        include_pdf_annotations: true,
        max_pages: maxPages,
        page_start: pageStart,
        timeout_ms: Math.min(timeoutMs, 60_000)
      });
      const derived = Array.isArray(analyzed.mark_regions)
        ? analyzed.mark_regions
            .map(r => ({
              index: toFiniteNumber((r as any).index),
              x: toFiniteNumber((r as any).x),
              y: toFiniteNumber((r as any).y),
              w: toFiniteNumber((r as any).w),
              h: toFiniteNumber((r as any).h)
            }))
            .filter(x => x.x !== null && x.y !== null && x.w !== null && x.h !== null && (x.w as number) > 0 && (x.h as number) > 0)
            .map(x => ({
              ...(x.index !== null ? { index: Math.max(0, Math.floor(x.index)) } : {}),
              x: x.x as number,
              y: x.y as number,
              w: x.w as number,
              h: x.h as number
            }))
        : [];
      if (sourceRegionBoxes.length === 0 && derived.length > 0) sourceRegionBoxes = derived;

      const preview = typeof analyzed.vision_artifacts?.preview_image_path === "string" ? analyzed.vision_artifacts.preview_image_path : "";
      const annotated = typeof analyzed.vision_artifacts?.annotated_image_path === "string" ? analyzed.vision_artifacts.annotated_image_path : "";
      const crops = Array.isArray(analyzed.vision_artifacts?.crop_image_paths) ? analyzed.vision_artifacts!.crop_image_paths! : [];
      pushContext(preview);
      pushContext(annotated);
      for (const c of crops) pushFocused(c);

      if (sourceRegionBoxes.length > 1) {
        relatedGroups = computeRelatedRegionGroups(sourceRegionBoxes, geminiRelatedRegionGapPx());
      }
      if (preview && relatedGroups.length > 0) {
        const groupContextBoxes = buildExpandedGroupContextBoxes(sourceRegionBoxes, relatedGroups);
        if (groupContextBoxes.length > 0) {
          const grouped = await bestEffortRenderContextCrops({
            imageRelativePath: preview,
            boxes: groupContextBoxes,
            timeoutMs: Math.min(timeoutMs, 25_000)
          });
          if (grouped.ok && grouped.crop_paths.length > 0) {
            for (const p of grouped.crop_paths) pushContext(p);
          } else if (grouped.warning) {
            warnings.push(`Grouped context crop warning: ${grouped.warning}`);
          }
        }
      }

      const pages = Array.isArray((analyzed as any)?.pages) ? ((analyzed as any).pages as Array<Record<string, unknown>>) : [];
      const annSummary =
        pages.length > 0 && pages[0] && typeof pages[0] === "object"
          ? ((pages[0] as Record<string, unknown>).annotation_summary as Record<string, unknown> | undefined)
          : undefined;
      const annSample = Array.isArray(annSummary?.sample) ? (annSummary!.sample as Array<Record<string, unknown>>) : [];
      for (const row of annSample.slice(0, 20)) {
        if (!row || typeof row !== "object") continue;
        const subtype = typeof row.subtype === "string" ? row.subtype.trim() : "";
        const color = typeof row.color === "string" ? row.color.trim() : "";
        const contents = typeof row.contents === "string" ? row.contents.trim() : "";
        if (!subtype && !contents) continue;
        annotationHints.push({
          subtype: subtype || "Unknown",
          ...(color ? { color } : {}),
          ...(contents ? { contents: truncate(contents, 220) } : {})
        });
      }
    } catch (e) {
      warnings.push(`Redline prepass failed: ${truncate(e instanceof Error ? e.message : String(e), 220)}`);
    }
  }

  for (const rp of requestedPaths) {
    let full = "";
    try {
      full = resolveExistingFileUnderWorkspace(rp);
    } catch {
      warnings.push(`Input path not found under Workspace: ${rp}`);
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      warnings.push(`Cannot stat input file: ${rp}`);
      continue;
    }
    if (!st.isFile() || st.size <= 0) {
      warnings.push(`Input is not a readable file: ${rp}`);
      continue;
    }
    const inputFileLimit = isPdfRelativePath(rp) ? maxPdfInputFileBytes : maxInputFileBytes;
    if (st.size > inputFileLimit) {
      warnings.push(`Input skipped (>${inputFileLimit} bytes): ${rp}`);
      continue;
    }

    if (isPdfRelativePath(rp)) {
      const converted = await bestEffortConvertPdfToJpegPages({
        pdfRelativePath: rp,
        maxPages,
        pageStart,
        dpi: geminiPdfDpi(),
        timeoutMs: Math.min(timeoutMs, 90_000)
      });
      if (converted.ok && converted.page_paths.length > 0) {
        for (const p of converted.page_paths) {
          convertedPdfPages.push(p);
          pushPre(p);
        }
      } else {
        if (converted.warning) warnings.push(`PDF convert warning for ${rp}: ${converted.warning}`);
        const hasImageEvidence =
          contextPaths.length > 0 ||
          focusedPaths.length > 0 ||
          preprocessedPaths.some((p) => isImageRelativePath(p)) ||
          convertedPdfPages.length > 0 ||
          requestedPaths.some((p) => isImageRelativePath(p));
        // Avoid heavy direct-PDF inline uploads when we already have image evidence.
        if (!hasImageEvidence) {
          pushPre(rp);
        } else {
          warnings.push(`PDF direct fallback skipped (image evidence already present): ${rp}`);
        }
      }
      continue;
    }

    pushPre(rp);
  }

  // Prefer broader context first, then focused crops.
  const orderedPaths: string[] = [];
  const seenOrdered = new Set<string>();
  const pushOrdered = (p: string) => {
    const s = p.trim().replace(/\\/g, "/");
    if (!s || seenOrdered.has(s)) return;
    seenOrdered.add(s);
    orderedPaths.push(s);
  };
  for (const p of contextPaths) pushOrdered(p);
  for (const p of focusedPaths) pushOrdered(p);
  for (const p of preprocessedPaths) pushOrdered(p);
  const chosenPaths: string[] = [];
  const seenChosen = new Set<string>();
  const minContext = Math.min(maxInputs, geminiMinContextImages());
  for (const p of contextPaths) {
    if (chosenPaths.length >= minContext) break;
    if (seenChosen.has(p)) continue;
    seenChosen.add(p);
    chosenPaths.push(p);
  }
  for (const p of orderedPaths) {
    if (chosenPaths.length >= maxInputs) break;
    if (seenChosen.has(p)) continue;
    seenChosen.add(p);
    chosenPaths.push(p);
  }

  const responseBase = (modelName: string) => ({
    model: modelName,
    provider: "gemini" as const,
    used_code_execution: includeCodeExecution,
    request: {
      file_path: (req.file_path ?? "").trim(),
      image_paths: chosenPaths,
      image_count: chosenPaths.length,
      max_regions: maxRegions,
      min_confidence: minConfidence,
      page_start: pageStart,
      page_end: pageStart + maxPages - 1
    }
  });

  if (!geminiVisionEnabled()) {
    const preprocess = buildPreprocess();
    return {
      ok: false,
      ...responseBase(preferredModel),
      summary: "Gemini vision integration is disabled.",
      regions: [],
      open_questions: [],
      global_confidence: 0,
      ...(preprocess ? { preprocess } : {}),
      warning: "Set OPERATOR_GEMINI_VISION_ENABLED=1 to enable."
    };
  }

  if (!key) {
    const preprocess = buildPreprocess();
    return {
      ok: false,
      ...responseBase(preferredModel),
      summary: "Gemini API key is missing.",
      regions: [],
      open_questions: [],
      global_confidence: 0,
      ...(preprocess ? { preprocess } : {}),
      warning: "Set OPERATOR_GEMINI_API_KEY (or GEMINI_API_KEY)."
    };
  }

  if (chosenPaths.length === 0) {
    const preprocess = buildPreprocess();
    return {
      ok: false,
      ...responseBase(preferredModel),
      summary: "No image inputs were provided for Gemini analysis.",
      regions: [],
      open_questions: [],
      global_confidence: 0,
      ...(preprocess ? { preprocess } : {}),
      warning: "Provide file_path/image_paths to supported files (.png/.jpg/.jpeg/.webp/.pdf)."
    };
  }

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  const analysisMode = req.analysis_mode === "existing_conditions" ? "existing_conditions" : "redline";
  const objective = (req.objective ?? "").trim() || (
    analysisMode === "existing_conditions"
      ? "Inventory source-supported existing conditions and convert them into provisional, verifiable modeling observations."
      : "Identify redline intent and convert it into actionable model-edit instructions."
  );
  const expectedSheet = (req.expected_sheet ?? "").trim();
  parts.push({
    text: buildPrompt({
      analysisMode,
      objective,
      expectedSheet,
      regionBoxes: sourceRegionBoxes,
      annotationHints,
      relatedGroups,
      maxRegions,
      minConfidence,
      pageStart,
      pageCount: maxPages
    })
  });

  let inlineBytesTotal = 0;
  for (const rp of chosenPaths) {
    try {
      let selectedPath = rp;
      let full = resolveExistingFileUnderWorkspace(selectedPath);
      let st = fs.statSync(full);
      if (!st.isFile() || st.size <= 0) continue;
      const isImage = isImageRelativePath(selectedPath);
      if (isImage && st.size > maxInlinePartBytes) {
        const shrunk = await bestEffortShrinkImageForGemini({
          imageRelativePath: selectedPath,
          maxBytes: maxInlinePartBytes,
          timeoutMs: Math.min(timeoutMs, 30_000)
        });
        if (shrunk.ok && shrunk.image_path) {
          selectedPath = shrunk.image_path;
          full = resolveExistingFileUnderWorkspace(selectedPath);
          st = fs.statSync(full);
        } else {
          warnings.push(
            shrunk.warning
              ? `Image shrink warning for ${selectedPath}: ${shrunk.warning}`
              : `Skipped image over inline part hard cap ${maxInlinePartBytes} bytes: ${selectedPath}`
          );
          continue;
        }
      }
      if (st.size > maxInlinePartBytes) {
        warnings.push(`Skipped input over inline part hard cap ${maxInlinePartBytes} bytes: ${selectedPath}`);
        continue;
      }
      if (inlineBytesTotal + st.size > maxRequestInlineBytes) {
        warnings.push(`Skipped additional input due to request inline budget ${maxRequestInlineBytes} bytes: ${selectedPath}`);
        continue;
      }
      parts.push({
        inlineData: {
          mimeType: mimeFromInputPath(selectedPath),
          data: fs.readFileSync(full).toString("base64")
        }
      });
      inlineBytesTotal += st.size;
    } catch {
      // ignore unreadable path
    }
  }

  if (parts.length <= 1) {
    const preprocess = buildPreprocess();
    return {
      ok: false,
      ...responseBase(preferredModel),
      summary: "No readable images were available for Gemini analysis.",
      regions: [],
      open_questions: [],
      global_confidence: 0,
      ...(preprocess ? { preprocess } : {}),
      warning:
        `Check file paths and size caps (` +
        `OPERATOR_GEMINI_MAX_IMAGE_BYTES=${maxImageBytes}, ` +
        `OPERATOR_GEMINI_INLINE_PART_HARD_LIMIT_BYTES=${maxInlinePartBytes}, ` +
        `OPERATOR_GEMINI_MAX_REQUEST_INLINE_BYTES=${maxRequestInlineBytes}, ` +
        `OPERATOR_GEMINI_MAX_INPUT_FILE_BYTES=${maxInputFileBytes}).`
    };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  let rawText = "";
  const generatedImages: string[] = [];

  try {
    for (let i = 0; i < modelCandidates.length; i++) {
      const candidateModel = modelCandidates[i]!;
      const endpoint = `${geminiBaseUrl()}/models/${encodeURIComponent(candidateModel)}:generateContent?key=${encodeURIComponent(key)}`;
      const generationConfig: Record<string, unknown> = { temperature: 0.2 };
      // Gemini rejects tool-use with forced JSON mime in some model/runtime combos.
      // Keep strict JSON mode when no tool-use is requested; otherwise rely on prompt + JSON extraction.
      if (!includeCodeExecution) generationConfig.responseMimeType = "application/json";

      const body: Record<string, unknown> = {
        contents: [{ role: "user", parts }],
        generationConfig
      };
      if (includeCodeExecution) body.tools = [{ codeExecution: {} }];

      const resp = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const text = await resp.text();
      if (!resp.ok) {
        if (i < modelCandidates.length - 1 && responseLikelyModelMismatch(resp.status, text)) {
          modelUnavailableUntilMs.set(candidateModel, Date.now() + MODEL_UNAVAILABLE_CACHE_TTL_MS);
          warnings.push(
            `Gemini model '${candidateModel}' rejected (HTTP ${resp.status}); retrying with '${modelCandidates[i + 1]}'.`
          );
          continue;
        }
        const preprocess = buildPreprocess();
        return {
          ok: false,
          ...responseBase(candidateModel),
          summary: "Gemini API request failed.",
          regions: [],
          open_questions: [],
          global_confidence: 0,
          ...(preprocess ? { preprocess } : {}),
          warning: `HTTP ${resp.status}: ${truncate(text.replace(/\s+/g, " ").trim(), 800)}`
        };
      }

      rawText = "";
      generatedImages.length = 0;
      let parsedApi: GeminiApiResponse = {};
      try {
        parsedApi = JSON.parse(text) as GeminiApiResponse;
      } catch {
        parsedApi = {};
      }

      for (const c of parsedApi.candidates ?? []) {
        for (const p of c.content?.parts ?? []) {
          const texts = extractTextFromGeminiPart(p);
          for (const t of texts) {
            if (!t) continue;
            rawText += (rawText ? "\n" : "") + t;
          }

          const inline: any = p.inlineData ?? p.inline_data;
          const mime = (inline?.mimeType ?? inline?.mime_type ?? "").toString().trim();
          const data = (inline?.data ?? "").toString().trim();
          if (mime.toLowerCase().startsWith("image/") && data) {
            const saved = saveGeneratedInlineImage(data, mime, generatedImages.length + 1);
            if (saved) generatedImages.push(saved);
          }
        }
      }

      const normalized = normalizeGeminiVisionOutput(rawText, rawText);
      const filteredRegions = normalized.regions
        .filter(r => r.confidence >= minConfidence)
        .slice(0, maxRegions);

      const preprocess = buildPreprocess();
      return {
        ok: true,
        ...responseBase(candidateModel),
        summary: normalized.summary,
        regions: filteredRegions,
        open_questions: normalized.open_questions,
        global_confidence: normalized.global_confidence,
        ...(preprocess ? { preprocess } : {}),
        ...(generatedImages.length > 0 ? { generated_images: generatedImages } : {}),
        ...(rawText ? { raw_text_excerpt: truncate(rawText, 1800) } : {})
      };
    }

    const preprocess = buildPreprocess();
    return {
      ok: false,
      ...responseBase(preferredModel),
      summary: "Gemini API request failed.",
      regions: [],
      open_questions: [],
      global_confidence: 0,
      ...(preprocess ? { preprocess } : {}),
      warning: `No usable Gemini model from candidates: ${modelCandidates.join(", ")}`
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const preprocess = buildPreprocess();
    return {
      ok: false,
      ...responseBase(preferredModel),
      summary: "Gemini call failed.",
      regions: [],
      open_questions: [],
      global_confidence: 0,
      ...(preprocess ? { preprocess } : {}),
      warning: truncate(msg, 800)
    };
  } finally {
    clearTimeout(t);
  }
}
