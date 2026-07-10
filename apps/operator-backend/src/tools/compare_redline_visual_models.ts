import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, repoRoot, writeJsonFile, writeTextFile } from "../benchmark/files.js";

type Box = { minX: number; minY: number; maxX: number; maxY: number };

type MarkReviewRecord = {
  file: string;
  page: number;
  index: number;
  page_width?: number;
  page_height?: number;
  box?: Box;
  subtype: string;
  color_family: string;
  text_excerpt: string;
  operation_class: string;
  target_class: string;
  bucket: string;
};

type TextOpinionRecord = {
  id: string;
  actionable: boolean | "unclear";
  operation: string;
  target: string;
  confidence: number;
  rationale: string;
  visual_context_needed?: "none" | "tight" | "context" | "page";
  local: {
    file: string;
    page: number;
    mark_index: number;
    bucket: string;
    operation: string;
    target: string;
    text_excerpt: string;
  };
};

type VisualAnalysis = {
  id: string;
  actionable: boolean | "unclear";
  actionability_reason: "directive" | "calculation_or_reference" | "highlight_or_status" | "completed_or_status_only" | "ambiguous_composite" | "not_enough_context" | "other";
  operation: string;
  target: string;
  confidence: number;
  visual_evidence: string;
  requested_human_review: boolean;
  crop_sufficiency: "enough" | "needs_more_context" | "needs_full_page" | "unreadable";
  requirements: string[];
};

type VisualCropRecord = {
  id: string;
  imagePath: string;
  cropLevel: string;
  colorStats?: Record<string, number | boolean | string>;
};

type VisualResultRecord = {
  id: string;
  file: string;
  page: number;
  mark_index: number;
  subtype: string;
  selected_crop_level: string;
  selected_crop_path: string;
  crop_color_stats?: VisualCropRecord["colorStats"];
  text_only: Pick<TextOpinionRecord, "actionable" | "operation" | "target" | "confidence" | "visual_context_needed" | "rationale">;
  openai?: VisualAnalysis & { model: string; error?: string };
  gemini?: VisualAnalysis & { model: string; error?: string };
  agreement: {
    actionability: boolean;
    operation: boolean;
    target: boolean;
    both_need_more_context: boolean;
  };
};

const ACTIONABILITY_REASONS = [
  "directive",
  "calculation_or_reference",
  "highlight_or_status",
  "completed_or_status_only",
  "ambiguous_composite",
  "not_enough_context",
  "other"
];

const OPERATIONS = [
  "add",
  "delete",
  "move",
  "reroute_offset",
  "tap_branch",
  "size_transition",
  "type_change",
  "graphics_override",
  "text_edit",
  "tag",
  "route",
  "rotate",
  "calculation_reference",
  "no_action_required",
  "unknown"
];

const TARGETS = [
  "duct",
  "pipe",
  "mep_accessory",
  "receptacle",
  "light",
  "tag",
  "text",
  "sheet",
  "schedule",
  "view_filter",
  "category_graphics",
  "cad_link",
  "viewport",
  "unknown"
];

const REQUIREMENTS = [
  "model_write",
  "visual_gate",
  "connector_or_readback_audit",
  "native_readback",
  "post_change_capture",
  "cleanup",
  "manual_visual_region_review"
];

const VISUAL_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    actionable: { enum: [true, false, "unclear"] },
    actionability_reason: { type: "string", enum: ACTIONABILITY_REASONS, description: "Why the mark is or is not actionable. Use ambiguous_composite or not_enough_context instead of forcing a directive when the visual evidence is incomplete." },
    operation: { type: "string", enum: OPERATIONS },
    target: { type: "string", enum: TARGETS },
    confidence: { type: "number" },
    visual_evidence: { type: "string" },
    requested_human_review: { type: "boolean" },
    crop_sufficiency: { type: "string", enum: ["enough", "needs_more_context", "needs_full_page", "unreadable"] },
    requirements: { type: "array", items: { type: "string", enum: REQUIREMENTS } }
  },
  required: ["id", "actionable", "actionability_reason", "operation", "target", "confidence", "visual_evidence", "requested_human_review", "crop_sufficiency", "requirements"]
} as const;

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

function numberFlag(argv: string[], name: string, fallback: number): number {
  const raw = flagValue(argv, name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function boolFlag(argv: string[], name: string, fallback: boolean): boolean {
  const raw = flagValue(argv, name);
  if (!raw) return argv.includes(name) ? true : fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function pythonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function runPython(script: string, timeoutMs: number): string {
  const python = process.env.OPERATOR_PYTHON || process.env.PYTHON || "python";
  const r = child_process.spawnSync(python, ["-"], {
    input: script,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 64
  });
  if (r.status !== 0) {
    const reason = r.error?.message || r.signal || `Python exited ${r.status}`;
    throw new Error((r.stderr || r.stdout || reason).slice(0, 2000));
  }
  return r.stdout;
}

function normalizeActionable(value: unknown): boolean | "unclear" {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").toLowerCase().trim();
  if (s === "true" || s === "yes") return true;
  if (s === "false" || s === "no") return false;
  return "unclear";
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch {
    // fall through
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  throw new Error("No JSON object found in model response.");
}

function normalizeVisualAnalysis(raw: unknown, fallbackId: string): VisualAnalysis {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : parseJsonObject(String(raw ?? ""));
  const operation = OPERATIONS.includes(String(obj.operation)) ? String(obj.operation) : "unknown";
  const target = TARGETS.includes(String(obj.target)) ? String(obj.target) : "unknown";
  const reason = ACTIONABILITY_REASONS.includes(String(obj.actionability_reason)) ? String(obj.actionability_reason) as VisualAnalysis["actionability_reason"] : "other";
  const suff = ["enough", "needs_more_context", "needs_full_page", "unreadable"].includes(String(obj.crop_sufficiency))
    ? String(obj.crop_sufficiency) as VisualAnalysis["crop_sufficiency"]
    : "needs_more_context";
  const req = Array.isArray(obj.requirements) ? obj.requirements.map(String).filter((x) => REQUIREMENTS.includes(x)).slice(0, 8) : [];
  const n = Number(obj.confidence);
  return {
    id: String(obj.id || fallbackId),
    actionable: normalizeActionable(obj.actionable),
    actionability_reason: reason,
    operation,
    target,
    confidence: Number.isFinite(n) ? Math.max(0, Math.min(1, n > 1 && n <= 100 ? n / 100 : n)) : 0.5,
    visual_evidence: String(obj.visual_evidence ?? "").replace(/\s+/g, " ").trim().slice(0, 800),
    requested_human_review: Boolean(obj.requested_human_review),
    crop_sufficiency: suff,
    requirements: req
  };
}

function renderCrops(args: { sourceDir: string; outputDir: string; items: Array<{ id: string; mark: MarkReviewRecord; cropLevel: string }>; dpi: number; normalizeStatusColors: boolean; reuseCrops: boolean }): VisualCropRecord[] {
  const inputPath = path.join(args.outputDir, "visual_crop_items.json");
  const outputPath = path.join(args.outputDir, "visual_crop_manifest.json");
  if (args.reuseCrops && fs.existsSync(outputPath)) {
    return JSON.parse(fs.readFileSync(outputPath, "utf8")) as VisualCropRecord[];
  }
  fs.writeFileSync(inputPath, JSON.stringify(args.items.map(({ id, mark, cropLevel }) => ({ id, mark, cropLevel }))), "utf8");
  const py = `
import json, math, os, shutil, subprocess
from PIL import Image, ImageDraw

source_dir = ${pythonLiteral(args.sourceDir)}
output_dir = ${pythonLiteral(args.outputDir)}
input_path = ${pythonLiteral(inputPath)}
output_path = ${pythonLiteral(outputPath)}
dpi = int(${args.dpi})
normalize_status = bool(${args.normalizeStatusColors ? 1 : 0})
crop_dir = os.path.join(output_dir, "crops")
page_dir = os.path.join(output_dir, "pages")
os.makedirs(crop_dir, exist_ok=True)
os.makedirs(page_dir, exist_ok=True)
pdftoppm = shutil.which("pdftoppm")
if not pdftoppm:
    raise SystemExit("pdftoppm not found on PATH")
if os.name == "nt" and pdftoppm.lower().endswith(".cmd"):
    wrapper_dir = os.path.dirname(pdftoppm)
    for c in [
        os.path.normpath(os.path.join(wrapper_dir, "..", "native", "poppler", "Library", "bin", "pdftoppm.exe")),
        os.path.normpath(os.path.join(wrapper_dir, "..", "Library", "bin", "pdftoppm.exe")),
    ]:
        if os.path.isfile(c):
            pdftoppm = c
            break

with open(input_path, "r", encoding="utf-8") as f:
    items = json.load(f)

page_cache = {}
def render_page(pdf_rel, page):
    key = (pdf_rel, int(page))
    if key in page_cache:
        return page_cache[key]
    stem = "".join(ch if ch.isalnum() else "_" for ch in os.path.splitext(os.path.basename(pdf_rel))[0])[:80]
    prefix = os.path.join(page_dir, f"{stem}_p{int(page):04d}")
    expected = f"{prefix}-{int(page)}.png"
    if not os.path.isfile(expected):
        cmd = [pdftoppm, "-png", "-f", str(int(page)), "-l", str(int(page)), "-r", str(dpi), os.path.join(source_dir, pdf_rel), prefix]
        r = subprocess.run(subprocess.list2cmdline(cmd) if os.name == "nt" and pdftoppm.lower().endswith(".cmd") else cmd, capture_output=True, text=True, timeout=180, shell=(os.name == "nt" and pdftoppm.lower().endswith(".cmd")))
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "pdftoppm failed")[:800])
    if not os.path.isfile(expected):
        matches = [os.path.join(page_dir, x) for x in os.listdir(page_dir) if x.startswith(os.path.basename(prefix)) and x.endswith(".png")]
        if not matches:
            raise RuntimeError(f"missing rendered page {pdf_rel} {page}")
        expected = sorted(matches)[0]
    page_cache[key] = expected
    return expected

def normalize_status_colors(img):
    out = img.convert("RGB")
    pix = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r,g,b = pix[x,y]
            red = r >= 120 and r > g + 30 and r > b + 30
            green = g >= 120 and g > r + 25 and g > b + 20
            yellow_or_orange = r >= 150 and g >= 80 and b <= 150 and r + g > 280
            blue = b >= 120 and b > r + 25 and b > g + 15
            if red or green or yellow_or_orange or blue:
                v = max(r,g,b)
                pix[x,y] = (max(180,v),0,0)
    return out

def color_stats(img):
    pix = img.convert("RGB").load()
    total = img.width * img.height
    counts = {"red":0, "yellow":0, "green":0, "blue":0, "dark":0}
    for y in range(img.height):
        for x in range(img.width):
            r,g,b = pix[x,y]
            red = r >= 120 and r > g + 30 and r > b + 30
            yellow = r >= 150 and g >= 110 and b <= 130 and r + g > 300
            green = g >= 120 and g > r + 25 and g > b + 20
            blue = b >= 120 and b > r + 25 and b > g + 15
            if red: counts["red"] += 1
            if yellow: counts["yellow"] += 1
            if green: counts["green"] += 1
            if blue: counts["blue"] += 1
            if r < 80 and g < 80 and b < 80: counts["dark"] += 1
    yellow_ratio = counts["yellow"] / max(1, total)
    red_ratio = counts["red"] / max(1, total)
    yellow_status_likely = counts["yellow"] >= 300 and yellow_ratio >= 0.002 and counts["yellow"] > counts["red"] * 2
    return {
        "total_pixels": total,
        "red_pixels": counts["red"],
        "yellow_pixels": counts["yellow"],
        "green_pixels": counts["green"],
        "blue_pixels": counts["blue"],
        "dark_pixels": counts["dark"],
        "yellow_ratio": round(yellow_ratio, 6),
        "red_ratio": round(red_ratio, 6),
        "yellow_status_likely": yellow_status_likely
    }

def fit(img, max_side):
    if img.width <= max_side and img.height <= max_side:
        return img
    scale = max_side / max(img.width, img.height)
    return img.resize((max(1,int(img.width*scale)), max(1,int(img.height*scale))), Image.Resampling.LANCZOS)

out = []
for item in items:
    mark = item["mark"]
    box = mark.get("box") or {}
    page_w = float(mark.get("page_width") or 0)
    page_h = float(mark.get("page_height") or 0)
    if page_w <= 0 or page_h <= 0:
        continue
    page = int(mark["page"])
    img = Image.open(render_page(mark["file"], page)).convert("RGB")
    sx = img.width / page_w
    sy = img.height / page_h
    min_x = min(float(box.get("minX", 0)), float(box.get("maxX", 0)))
    max_x = max(float(box.get("minX", 0)), float(box.get("maxX", 0)))
    min_y = min(float(box.get("minY", 0)), float(box.get("maxY", 0)))
    max_y = max(float(box.get("minY", 0)), float(box.get("maxY", 0)))
    cx = (min_x + max_x) / 2
    cy = (min_y + max_y) / 2
    bw = max(1.0, max_x - min_x)
    bh = max(1.0, max_y - min_y)
    level = item.get("cropLevel") or "context"
    if level == "page":
        l_pt, r_pt, b_pt, t_pt = 0, page_w, 0, page_h
        max_side = 2200
    else:
        min_in = 2.0 if level == "tight" else 3.0
        min_pt = min_in * 72.0
        factor = 1.35 if level == "tight" else 3.0
        size_pt = max(min_pt, bw * factor, bh * factor)
        max_pt = 9.0 * 72.0 if level == "tight" else 14.0 * 72.0
        size_pt = min(size_pt, max_pt)
        l_pt = max(0, cx - size_pt / 2)
        r_pt = min(page_w, cx + size_pt / 2)
        b_pt = max(0, cy - size_pt / 2)
        t_pt = min(page_h, cy + size_pt / 2)
        if r_pt - l_pt < size_pt:
            if l_pt == 0: r_pt = min(page_w, size_pt)
            elif r_pt == page_w: l_pt = max(0, page_w - size_pt)
        if t_pt - b_pt < size_pt:
            if b_pt == 0: t_pt = min(page_h, size_pt)
            elif t_pt == page_h: b_pt = max(0, page_h - size_pt)
        max_side = 1800
    left = int(max(0, math.floor(l_pt * sx)))
    right = int(min(img.width, math.ceil(r_pt * sx)))
    top = int(max(0, math.floor((page_h - t_pt) * sy)))
    bottom = int(min(img.height, math.ceil((page_h - b_pt) * sy)))
    if right <= left or bottom <= top:
        continue
    crop = img.crop((left, top, right, bottom))
    stats = color_stats(crop)
    norm = normalize_status_colors(crop) if normalize_status else crop.copy()
    draw = ImageDraw.Draw(norm)
    rx0 = int(min_x * sx - left)
    rx1 = int(max_x * sx - left)
    ry0 = int((page_h - max_y) * sy - top)
    ry1 = int((page_h - min_y) * sy - top)
    x0 = max(0, min(norm.width - 1, min(rx0, rx1)))
    x1 = max(0, min(norm.width - 1, max(rx0, rx1)))
    y0 = max(0, min(norm.height - 1, min(ry0, ry1)))
    y1 = max(0, min(norm.height - 1, max(ry0, ry1)))
    draw.rectangle([x0, y0, x1, y1], outline=(0,128,255), width=5)
    norm = fit(norm, max_side)
    safe = "".join(ch if ch.isalnum() else "_" for ch in item["id"])[:150]
    out_path = os.path.join(crop_dir, safe + "_" + level + ".jpg")
    norm.save(out_path, quality=88)
    out.append({"id": item["id"], "imagePath": os.path.relpath(out_path, output_dir).replace("\\\\", "/"), "cropLevel": level, "colorStats": stats})

with open(output_path, "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2)
print(output_path)
`;
  runPython(py, Math.max(300_000, args.items.length * 10_000));
  return JSON.parse(fs.readFileSync(outputPath, "utf8")) as Array<{ id: string; imagePath: string; cropLevel: string }>;
}

function buildPrompt(args: { id: string; textOnly: TextOpinionRecord; mark: MarkReviewRecord; cropLevel: string; normalizeStatusColors: boolean }): string {
  return [
    "You are reviewing an engineering PDF redline crop. Determine whether this visible markup is an actionable directive for a Revit model/document update, or non-actionable/reference/status/calculation.",
    "",
    "Important: give yourself an out. The mark may be a directive, or it may be a calculation, status/highlight, completed-item indication, question, or ambiguous fragment needing more context.",
    "Be conservative: a cross-reference such as 'see sheet X' is unclear unless the visible crop also identifies what must change here. A single X, line, circle, or highlight is unclear unless the visual context makes the target and operation obvious.",
    args.normalizeStatusColors
      ? "The crop has status colors normalized to red where possible, and the target annotation bbox is outlined in blue. Do not assume red means open/actionable."
      : "The crop preserves original rendered colors, and the target annotation bbox is outlined in blue. Do not treat the blue rectangle as a redline.",
    "Yellow highlighter-like strokes are usually status/completion highlighting, even when the PDF annotation subtype is Line or Ink. Do not treat yellow highlighting alone as a delete or strikeout instruction.",
    "Pure Bluebeam Highlight annotations are usually non-actionable unless nearby text explicitly directs an update.",
    "If the crop is too tight to tell what object is being referenced, set actionable='unclear' and crop_sufficiency accordingly.",
    "",
    `ID: ${args.id}`,
    `PDF: ${args.mark.file}`,
    `Page: ${args.mark.page}`,
    `Mark index: ${args.mark.index}`,
    `PDF annotation subtype: ${args.mark.subtype}`,
    `Color family: ${args.mark.color_family}`,
    `Crop level: ${args.cropLevel}`,
    `Extracted annotation text: ${args.mark.text_excerpt}`,
    `Text-only model said: actionable=${args.textOnly.actionable}, operation=${args.textOnly.operation}, target=${args.textOnly.target}, confidence=${args.textOnly.confidence}, rationale=${args.textOnly.rationale}`,
    "",
    "Return only the structured JSON object."
  ].join("\n");
}

async function callOpenAiVisual(args: { id: string; imagePath: string; prompt: string; model: string }): Promise<VisualAnalysis & { model: string; error?: string }> {
  const key = (process.env.OPENAI_API_KEY || "").trim();
  if (!key) throw new Error("OPENAI_API_KEY is not configured.");
  const imageData = fs.readFileSync(args.imagePath).toString("base64");
  const body = {
    model: args.model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: args.prompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageData}` } }
      ]
    }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "redline_visual_classification",
        strict: true,
        schema: VISUAL_RESPONSE_SCHEMA
      }
    },
    max_completion_tokens: 900
  };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${text.slice(0, 800)}`);
  const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const content = parsed.choices?.[0]?.message?.content ?? "";
  return { ...normalizeVisualAnalysis(content, args.id), model: args.model };
}

function geminiApiKey(): string {
  return (process.env.OPERATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "").trim();
}

async function callGeminiVisual(args: { id: string; imagePath: string; prompt: string; model: string }): Promise<VisualAnalysis & { model: string; error?: string }> {
  const key = geminiApiKey();
  if (!key) throw new Error("Gemini API key is not configured.");
  const imageData = fs.readFileSync(args.imagePath).toString("base64");
  const endpoint = `${(process.env.OPERATOR_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "")}/models/${encodeURIComponent(args.model)}:generateContent?key=${encodeURIComponent(key)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: args.prompt }, { inlineData: { mimeType: "image/jpeg", data: imageData } }] }],
      generationConfig: {
        temperature: 0.1,
        responseFormat: {
          text: {
            mimeType: "APPLICATION_JSON",
            schema: VISUAL_RESPONSE_SCHEMA
          }
        }
      }
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${text.slice(0, 800)}`);
  const parsed = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = parsed.candidates?.flatMap((c) => c.content?.parts?.map((p) => p.text ?? "") ?? []).join("\n") ?? "";
  return { ...normalizeVisualAnalysis(content, args.id), model: args.model };
}

function selectSample(args: { textRows: TextOpinionRecord[]; marksById: Map<string, MarkReviewRecord>; limit: number; excludeHighlightSubtype: boolean; mode: string }): Array<{ id: string; textOnly: TextOpinionRecord; mark: MarkReviewRecord; cropLevel: string }> {
  const candidates = args.textRows
    .filter((r) => r.visual_context_needed && r.visual_context_needed !== "none")
    .map((r) => {
      const mark = args.marksById.get(r.id);
      return mark ? { id: r.id, textOnly: r, mark, cropLevel: r.visual_context_needed || "context" } : null;
    })
    .filter(Boolean) as Array<{ id: string; textOnly: TextOpinionRecord; mark: MarkReviewRecord; cropLevel: string }>;
  const filtered = candidates.filter((x) => !args.excludeHighlightSubtype || !/^highlight$/i.test(x.mark.subtype));
  const priority = (x: { textOnly: TextOpinionRecord; mark: MarkReviewRecord }) => {
    const a = x.textOnly.actionable;
    const bucket = x.mark.bucket;
    let s = 0;
    if (a === "unclear") s += 5000;
    if (a === true) s += 4000;
    if (bucket === "manual_review_mark") s += 900;
    if (bucket === "calculation_or_reference_mark") s += 800;
    if (x.textOnly.visual_context_needed === "page") s += 700;
    if (x.textOnly.visual_context_needed === "context") s += 500;
    if (x.textOnly.operation === "unknown" || x.textOnly.target === "unknown") s += 300;
    s += Math.round((1 - (Number(x.textOnly.confidence) || 0.5)) * 100);
    return s;
  };
  const sorted = filtered.sort((a, b) => priority(b) - priority(a) || a.id.localeCompare(b.id));
  if (args.mode !== "stratified") return sorted.slice(0, args.limit);

  const buckets = {
    true: sorted.filter((x) => x.textOnly.actionable === true),
    unclear: sorted.filter((x) => x.textOnly.actionable === "unclear"),
    false: sorted.filter((x) => x.textOnly.actionable === false)
  };
  const quotas = {
    true: Math.floor(args.limit * 0.5),
    unclear: Math.floor(args.limit * 0.35),
    false: Math.max(1, args.limit - Math.floor(args.limit * 0.5) - Math.floor(args.limit * 0.35))
  };
  const chosen: typeof sorted = [];
  const seen = new Set<string>();
  const take = (items: typeof sorted, n: number) => {
    for (const item of items) {
      if (chosen.length >= args.limit || n <= 0) break;
      if (seen.has(item.id)) continue;
      chosen.push(item);
      seen.add(item.id);
      n -= 1;
    }
  };
  take(buckets.true, quotas.true);
  take(buckets.unclear, quotas.unclear);
  take(buckets.false, quotas.false);
  take(sorted, args.limit - chosen.length);
  return chosen;
}

function agreement(openai?: VisualAnalysis, gemini?: VisualAnalysis): VisualResultRecord["agreement"] {
  return {
    actionability: Boolean(openai && gemini && openai.actionable === gemini.actionable),
    operation: Boolean(openai && gemini && openai.operation === gemini.operation),
    target: Boolean(openai && gemini && openai.target === gemini.target),
    both_need_more_context: Boolean(openai && gemini && ["needs_more_context", "needs_full_page", "unreadable"].includes(openai.crop_sufficiency) && ["needs_more_context", "needs_full_page", "unreadable"].includes(gemini.crop_sufficiency))
  };
}

function readExistingResults(outputDir: string): Map<string, VisualResultRecord> {
  const file = path.join(outputDir, "visual_model_compare.jsonl");
  const results = new Map<string, VisualResultRecord>();
  if (!fs.existsSync(file)) return results;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as VisualResultRecord;
      if (record?.id) results.set(record.id, record);
    } catch {
      // Ignore a partial trailing line from an interrupted long run.
    }
  }
  return results;
}

function hasCompletedProviders(record: VisualResultRecord | undefined, args: { skipOpenai: boolean; skipGemini: boolean }): boolean {
  if (!record) return false;
  const openaiDone = args.skipOpenai || Boolean(record.openai && !record.openai.error);
  const geminiDone = args.skipGemini || Boolean(record.gemini && !record.gemini.error);
  return openaiDone && geminiDone;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransientRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const transient = /\b(408|409|429|500|502|503|504)\b|rate|timeout|temporar/i.test(message);
      if (!transient || attempt === 4) break;
      await sleep(1500 * attempt * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed: ${String(lastError)}`);
}

async function analyzeItem(args: {
  item: { id: string; textOnly: TextOpinionRecord; mark: MarkReviewRecord; cropLevel: string };
  crop: VisualCropRecord;
  outputDir: string;
  openaiModel: string;
  geminiModel: string;
  skipOpenai: boolean;
  skipGemini: boolean;
  normalizeStatusColors: boolean;
}): Promise<VisualResultRecord> {
  const imagePath = path.join(args.outputDir, args.crop.imagePath);
  const prompt = buildPrompt({ id: args.item.id, textOnly: args.item.textOnly, mark: args.item.mark, cropLevel: args.crop.cropLevel, normalizeStatusColors: args.normalizeStatusColors });
  let openai: (VisualAnalysis & { model: string; error?: string }) | undefined;
  let gemini: (VisualAnalysis & { model: string; error?: string }) | undefined;
  if (!args.skipOpenai) {
    try {
      openai = await withTransientRetries("OpenAI visual analysis", () => callOpenAiVisual({ id: args.item.id, imagePath, prompt, model: args.openaiModel }));
    } catch (error) {
      openai = { ...normalizeVisualAnalysis({ id: args.item.id, actionable: "unclear", operation: "unknown", target: "unknown", actionability_reason: "not_enough_context", confidence: 0, visual_evidence: "", requested_human_review: true, crop_sufficiency: "unreadable", requirements: ["manual_visual_region_review"] }, args.item.id), model: args.openaiModel, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!args.skipGemini) {
    try {
      gemini = await withTransientRetries("Gemini visual analysis", () => callGeminiVisual({ id: args.item.id, imagePath, prompt, model: args.geminiModel }));
    } catch (error) {
      gemini = { ...normalizeVisualAnalysis({ id: args.item.id, actionable: "unclear", operation: "unknown", target: "unknown", actionability_reason: "not_enough_context", confidence: 0, visual_evidence: "", requested_human_review: true, crop_sufficiency: "unreadable", requirements: ["manual_visual_region_review"] }, args.item.id), model: args.geminiModel, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    id: args.item.id,
    file: args.item.mark.file,
    page: args.item.mark.page,
    mark_index: args.item.mark.index,
    subtype: args.item.mark.subtype,
    selected_crop_level: args.crop.cropLevel,
    selected_crop_path: args.crop.imagePath,
    crop_color_stats: args.crop.colorStats,
    text_only: {
      actionable: args.item.textOnly.actionable,
      operation: args.item.textOnly.operation,
      target: args.item.textOnly.target,
      confidence: args.item.textOnly.confidence,
      visual_context_needed: args.item.textOnly.visual_context_needed,
      rationale: args.item.textOnly.rationale
    },
    openai,
    gemini,
    agreement: agreement(openai, gemini)
  };
}

async function main(): Promise<void> {
  const inventoryPath = path.resolve(flagValue(process.argv, "--inventory") ?? path.join(repoRoot(), "local-work", "redline-corpus", "inventory", "2026-07-03-desktop-pdfs", "redline_corpus_inventory.json"));
  const textOpinionPath = path.resolve(flagValue(process.argv, "--text-opinion") ?? path.join(repoRoot(), "local-work", "redline-corpus", "gemini-second-opinion", "structured-gemini35-full", "gemini_redline_second_opinion.jsonl"));
  const outputDir = path.resolve(flagValue(process.argv, "--output") ?? path.join(repoRoot(), "local-work", "redline-corpus", "visual-model-compare", "sample-200"));
  const limit = numberFlag(process.argv, "--limit", 200);
  const dpi = numberFlag(process.argv, "--dpi", 150);
  const openaiModel = flagValue(process.argv, "--openai-model") || process.env.OPERATOR_OPENAI_VISUAL_MODEL || "gpt-5.4-mini";
  const geminiModel = flagValue(process.argv, "--gemini-model") || process.env.OPERATOR_GEMINI_VISUAL_MODEL || "gemini-3.5-flash";
  const sampleMode = flagValue(process.argv, "--sample-mode") || "priority";
  const concurrency = numberFlag(process.argv, "--concurrency", 1);
  const resume = !process.argv.includes("--no-resume");
  const onlyUnresolved = process.argv.includes("--only-unresolved");
  const normalizeStatusColors = boolFlag(process.argv, "--normalize-status-colors", false);
  const reuseCrops = process.argv.includes("--reuse-crops");
  const excludeHighlightSubtype = boolFlag(process.argv, "--exclude-highlight-subtype", true);
  const excludeYellowStatus = boolFlag(process.argv, "--exclude-yellow-status", true);
  const skipOpenai = process.argv.includes("--skip-openai");
  const skipGemini = process.argv.includes("--skip-gemini");
  ensureDir(outputDir);

  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8")) as { source_dir: string; mark_review_items: MarkReviewRecord[] };
  const marksById = new Map<string, MarkReviewRecord>();
  for (const m of inventory.mark_review_items ?? []) marksById.set(`mark:${m.file}:p${m.page}:a${m.index}`, m);
  const textRows = fs.readFileSync(textOpinionPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as TextOpinionRecord);
  const highlightSubtypeCount = (inventory.mark_review_items ?? []).filter((m) => /^highlight$/i.test(m.subtype)).length;
  const sourceRows = onlyUnresolved ? textRows.filter((row) => row.actionable !== true) : textRows;
  const sample = selectSample({ textRows: sourceRows, marksById, limit, excludeHighlightSubtype, mode: sampleMode });
  const crops = renderCrops({ sourceDir: inventory.source_dir, outputDir, items: sample.map((x) => ({ id: x.id, mark: x.mark, cropLevel: x.cropLevel })), dpi, normalizeStatusColors, reuseCrops });
  const cropsById = new Map(crops.map((c) => [c.id, c]));
  const yellowStatusIds = new Set(crops.filter((c) => Boolean(c.colorStats?.yellow_status_likely)).map((c) => c.id));

  const outputJsonl = path.join(outputDir, "visual_model_compare.jsonl");
  if (!resume) writeTextFile(outputJsonl, "");
  const resultsById = resume ? readExistingResults(outputDir) : new Map<string, VisualResultRecord>();
  const work = sample.filter((item) => cropsById.has(item.id) && (!excludeYellowStatus || !yellowStatusIds.has(item.id)) && !hasCompletedProviders(resultsById.get(item.id), { skipOpenai, skipGemini }));
  let completedThisRun = 0;
  let next = 0;
  const worker = async () => {
    while (next < work.length) {
      const item = work[next++] as { id: string; textOnly: TextOpinionRecord; mark: MarkReviewRecord; cropLevel: string };
      const crop = cropsById.get(item.id);
      if (!crop) continue;
      const record = await analyzeItem({ item, crop, outputDir, openaiModel, geminiModel, skipOpenai, skipGemini, normalizeStatusColors });
      resultsById.set(record.id, record);
      completedThisRun += 1;
      fs.appendFileSync(outputJsonl, JSON.stringify(record) + "\n", "utf8");
      console.log(`Visual compare: ${resultsById.size}/${sample.length} (+${completedThisRun}) ${item.id}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  const results = sample.map((item) => resultsById.get(item.id)).filter(Boolean) as VisualResultRecord[];

  const countBy = (fn: (r: VisualResultRecord) => string) => {
    const m: Record<string, number> = {};
    for (const r of results) m[fn(r)] = (m[fn(r)] ?? 0) + 1;
    return m;
  };
  const summary = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    inventory: inventoryPath,
    text_opinion: textOpinionPath,
    output_dir: outputDir,
    requested_limit: limit,
    sample_mode: sampleMode,
    concurrency,
    resumed: resume,
    only_unresolved: onlyUnresolved,
    normalized_status_colors: normalizeStatusColors,
    reused_crops: reuseCrops,
    excluded_yellow_status: excludeYellowStatus,
    skipped_existing_count: sample.length - work.length,
    skipped_yellow_status_count: sample.filter((item) => yellowStatusIds.has(item.id)).length,
    rendered_count: crops.length,
    analyzed_count: results.length,
    openai_model: skipOpenai ? null : openaiModel,
    gemini_model: skipGemini ? null : geminiModel,
    excluded_highlight_subtype: excludeHighlightSubtype,
    highlight_subtype_count: highlightSubtypeCount,
    by_crop_level: countBy((r) => r.selected_crop_level),
    openai_by_actionable: countBy((r) => String(r.openai?.actionable ?? "missing")),
    gemini_by_actionable: countBy((r) => String(r.gemini?.actionable ?? "missing")),
    agreement: {
      actionability: results.filter((r) => r.agreement.actionability).length,
      operation: results.filter((r) => r.agreement.operation).length,
      target: results.filter((r) => r.agreement.target).length,
      both_need_more_context: results.filter((r) => r.agreement.both_need_more_context).length
    },
    openai_errors: results.filter((r) => r.openai?.error).length,
    gemini_errors: results.filter((r) => r.gemini?.error).length
  };
  writeJsonFile(path.join(outputDir, "visual_model_compare_summary.json"), summary);
  writeTextFile(path.join(outputDir, "visual_model_compare.csv"), [
    ["id", "file", "page", "mark_index", "subtype", "crop_level", "crop_path", "text_actionable", "text_operation", "text_target", "openai_actionable", "openai_reason", "openai_operation", "openai_target", "openai_confidence", "openai_crop_sufficiency", "openai_error", "gemini_actionable", "gemini_reason", "gemini_operation", "gemini_target", "gemini_confidence", "gemini_crop_sufficiency", "gemini_error", "agree_actionability", "agree_operation", "agree_target", "text_excerpt", "openai_evidence", "gemini_evidence"].join(","),
    ...results.map((r) => [
      r.id, r.file, r.page, r.mark_index, r.subtype, r.selected_crop_level, r.selected_crop_path,
      r.text_only.actionable, r.text_only.operation, r.text_only.target,
      r.openai?.actionable, r.openai?.actionability_reason, r.openai?.operation, r.openai?.target, r.openai?.confidence, r.openai?.crop_sufficiency, r.openai?.error ?? "",
      r.gemini?.actionable, r.gemini?.actionability_reason, r.gemini?.operation, r.gemini?.target, r.gemini?.confidence, r.gemini?.crop_sufficiency, r.gemini?.error ?? "",
      r.agreement.actionability, r.agreement.operation, r.agreement.target,
      marksById.get(r.id)?.text_excerpt ?? "", r.openai?.visual_evidence ?? "", r.gemini?.visual_evidence ?? ""
    ].map(csvCell).join(","))
  ].join("\n"));
  console.log(`Summary: ${path.join(outputDir, "visual_model_compare_summary.json")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
