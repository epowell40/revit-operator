import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, repoRoot, writeJsonFile, writeTextFile } from "../benchmark/files.js";

type Box = { minX: number; minY: number; maxX: number; maxY: number };
type GroupRecord = {
  file: string;
  page: number;
  group_index: number;
  page_width?: number;
  page_height?: number;
  box?: Box;
  annotation_indices: number[];
  mark_count: number;
  text_mark_count: number;
  geometry_only_count: number;
  colors: string[];
  subtypes: string[];
  text_excerpt: string;
  operation_class: string;
  target_class: string;
  context_class: string;
  confidence: number;
  manual_review_reason?: string;
};

type MarkRecord = {
  file: string;
  page: number;
  index: number;
  page_width?: number;
  page_height?: number;
  box?: Box;
  subtype: string;
  color: string;
  color_family: string;
  text_excerpt: string;
  operation_class: string;
  target_class: string;
  context_class: string;
  confidence: number;
  bucket: string;
  priority_rank: number;
  bucket_reason: string;
  duplicate_count: number;
};

type InventoryReport = {
  source_dir: string;
  groups: GroupRecord[];
  mark_review_items?: MarkRecord[];
};

type ReviewItem = {
  item_kind: "group" | "mark";
  file: string;
  page: number;
  group_index?: number;
  index?: number;
  page_width?: number;
  page_height?: number;
  box?: Box;
  annotation_indices?: number[];
  mark_count: number;
  duplicate_count?: number;
  colors: string[];
  subtypes: string[];
  text_excerpt: string;
  operation_class: string;
  target_class: string;
  context_class: string;
  confidence: number;
  bucket: string;
  priority_rank: number;
  bucket_reason: string;
};

type RenderedItem = {
  id: string;
  bucket: string;
  file: string;
  page: number;
  group_index?: number;
  mark_index?: number;
  item_kind: "group" | "mark";
  operation_class: string;
  target_class: string;
  context_class: string;
  confidence: number;
  mark_count: number;
  duplicate_count?: number;
  colors: string[];
  subtypes: string[];
  text_excerpt: string;
  original_thumb: string;
  normalized_thumb: string;
  context_original_thumb: string;
  context_thumb: string;
  page_original_thumb: string;
  page_thumb: string;
};

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function numberFlag(argv: string[], name: string, fallback: number): number {
  const raw = flagValue(argv, name);
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function addCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function reviewBucket(group: GroupRecord): { bucket: string; priority_rank: number; bucket_reason: string } {
  const op = group.operation_class;
  const target = group.target_class;
  const haystack = `${group.text_excerpt} ${group.subtypes.join(" ")} ${op} ${target}`.toLowerCase();
  const mepTargets = new Set(["duct", "pipe", "mep_accessory", "receptacle", "light"]);
  const mepOperations = new Set(["route", "tap_branch", "reroute_offset", "size_transition", "type_change"]);
  const mepTerms = /\b(duct|pipe|piping|damper|diffuser|grille|register|vav|sprinkler|san|cw|hw|chws|chwr|vent|mep|receptacle|light|fixture)\b/i;
  const graphicsTargets = new Set(["cad_link", "view_filter", "view_template", "category_graphics", "schedule", "sheet"]);
  if (mepTargets.has(target)) return { bucket: "modeled_mep_candidate", priority_rank: 10 + (mepOperations.has(op) ? 1 : 4), bucket_reason: `MEP target ${target}` };
  if (mepOperations.has(op) && mepTerms.test(haystack)) return { bucket: "modeled_mep_candidate", priority_rank: 15, bucket_reason: `MEP operation ${op} with local MEP terms` };
  if (graphicsTargets.has(target) || op === "graphics_override") return { bucket: "graphics_documentation_candidate", priority_rank: 20, bucket_reason: graphicsTargets.has(target) ? `graphics/documentation target ${target}` : "graphics override operation" };
  if ((target === "text" || target === "tag") && op !== "unknown") return { bucket: "annotation_text_candidate", priority_rank: 30, bucket_reason: `known ${op} operation on ${target}` };
  if (op === "unknown" || target === "unknown" || group.geometry_only_count > group.text_mark_count) return { bucket: "unknown_geometry_candidate", priority_rank: 40 + Math.min(20, group.geometry_only_count), bucket_reason: "unknown or geometry-heavy composite group" };
  return { bucket: "low_priority_text_noise", priority_rank: 90, bucket_reason: "low-confidence text/status markup" };
}

function buildQueue(groups: GroupRecord[]): ReviewItem[] {
  return groups
    .filter((group) => group.box && group.page_width && group.page_height)
    .map((group) => ({ ...group, ...reviewBucket(group), item_kind: "group" as const }))
    .sort((a, b) =>
      a.priority_rank - b.priority_rank ||
      b.confidence - a.confidence ||
      b.mark_count - a.mark_count ||
      a.file.localeCompare(b.file) ||
      a.page - b.page ||
      (a.group_index ?? 0) - (b.group_index ?? 0)
    );
}

function buildMarkQueue(marks: MarkRecord[]): ReviewItem[] {
  return marks
    .filter((mark) => mark.box && mark.page_width && mark.page_height)
    .map((mark) => ({
      item_kind: "mark" as const,
      file: mark.file,
      page: mark.page,
      index: mark.index,
      page_width: mark.page_width,
      page_height: mark.page_height,
      box: mark.box,
      mark_count: 1,
      duplicate_count: mark.duplicate_count,
      colors: [mark.color_family],
      subtypes: [mark.subtype],
      text_excerpt: mark.text_excerpt,
      operation_class: mark.operation_class,
      target_class: mark.target_class,
      context_class: mark.context_class,
      confidence: mark.confidence,
      bucket: mark.bucket,
      priority_rank: mark.priority_rank,
      bucket_reason: mark.bucket_reason
    }))
    .sort((a, b) =>
      a.priority_rank - b.priority_rank ||
      b.confidence - a.confidence ||
      (b.duplicate_count ?? 1) - (a.duplicate_count ?? 1) ||
      a.file.localeCompare(b.file) ||
      a.page - b.page ||
      (a.index ?? 0) - (b.index ?? 0)
    );
}

function pythonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function runPython(script: string, timeoutMs: number): string {
  const python = process.env.OPERATOR_PYTHON || process.env.PYTHON || "python";
  const result = child_process.spawnSync(python, ["-"], {
    input: script,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 64
  });
  if (result.status !== 0) {
    const reason = result.error?.message || result.signal || `Python exited ${result.status}`;
    throw new Error((result.stderr || result.stdout || reason).slice(0, 2000));
  }
  return result.stdout;
}

function renderReviewItems(args: { sourceDir: string; outputDir: string; items: ReviewItem[]; dpi: number; margin: number; includePage: boolean; timeoutMs: number }): RenderedItem[] {
  const tmp = path.join(os.tmpdir(), `revitoperator-redline-review-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  ensureDir(tmp);
  const itemsPath = path.join(tmp, "items.json");
  const outputJsonPath = path.join(tmp, "rendered.json");
  fs.writeFileSync(itemsPath, JSON.stringify(args.items), "utf8");
  const py = `
import json, math, os, shutil, subprocess, sys
from PIL import Image, ImageDraw

source_dir = ${pythonLiteral(args.sourceDir)}
output_dir = ${pythonLiteral(args.outputDir)}
items_path = ${pythonLiteral(itemsPath)}
output_json_path = ${pythonLiteral(outputJsonPath)}
dpi = int(${pythonLiteral(args.dpi)})
margin_ratio = float(${pythonLiteral(args.margin)})
include_page = bool(${args.includePage ? "True" : "False"})
thumb_dir = os.path.join(output_dir, "thumbs")
page_dir = os.path.join(output_dir, "pages")
os.makedirs(thumb_dir, exist_ok=True)
os.makedirs(page_dir, exist_ok=True)

with open(items_path, "r", encoding="utf-8") as f:
    items = json.load(f)

pdftoppm = shutil.which("pdftoppm")
if not pdftoppm:
    raise SystemExit("pdftoppm not found on PATH")
if os.name == "nt" and pdftoppm.lower().endswith(".cmd"):
    wrapper_dir = os.path.dirname(pdftoppm)
    direct_candidates = [
        os.path.normpath(os.path.join(wrapper_dir, "..", "native", "poppler", "Library", "bin", "pdftoppm.exe")),
        os.path.normpath(os.path.join(wrapper_dir, "..", "Library", "bin", "pdftoppm.exe")),
    ]
    for candidate in direct_candidates:
        if os.path.isfile(candidate):
            pdftoppm = candidate
            break

page_cache = {}
def render_page(pdf_rel, page):
    key = (pdf_rel, int(page))
    if key in page_cache:
        return page_cache[key]
    stem = "".join(c if c.isalnum() else "_" for c in os.path.splitext(os.path.basename(pdf_rel))[0])[:80]
    prefix = os.path.join(page_dir, f"{stem}_p{int(page):04d}")
    expected = f"{prefix}-{int(page)}.png"
    if not os.path.isfile(expected):
        pdf_path = os.path.join(source_dir, pdf_rel)
        cmd = [pdftoppm, "-png", "-f", str(int(page)), "-l", str(int(page)), "-r", str(dpi), pdf_path, prefix]
        if os.name == "nt" and pdftoppm.lower().endswith(".cmd"):
            r = subprocess.run(subprocess.list2cmdline(cmd), capture_output=True, text=True, timeout=120, shell=True)
        else:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "pdftoppm failed")[:500])
    if not os.path.isfile(expected):
        matches = [os.path.join(page_dir, x) for x in os.listdir(page_dir) if x.startswith(os.path.basename(prefix)) and x.endswith(".png")]
        if not matches:
            raise RuntimeError(f"rendered page missing for {pdf_rel} page {page}")
        expected = sorted(matches)[0]
    page_cache[key] = expected
    return expected

def normalize_status_colors(img):
    out = img.convert("RGB")
    pix = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b = pix[x, y]
            red = r >= 120 and r > g + 30 and r > b + 30
            green = g >= 120 and g > r + 25 and g > b + 20
            yellow_or_orange = r >= 150 and g >= 80 and b <= 150 and r + g > 280
            blue = b >= 120 and b > r + 25 and b > g + 15
            if red or green or yellow_or_orange or blue:
                v = max(r, g, b)
                pix[x, y] = (max(180, v), 0, 0)
    return out

def fit_review_size(img, max_side):
    if img.width <= max_side and img.height <= max_side:
        return img
    scale = max_side / float(max(img.width, img.height))
    return img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.Resampling.LANCZOS)

rendered = []
for idx, item in enumerate(items, start=1):
    pdf_rel = item["file"]
    page = int(item["page"])
    page_path = render_page(pdf_rel, page)
    img = Image.open(page_path).convert("RGB")
    page_w = float(item.get("page_width") or 0)
    page_h = float(item.get("page_height") or 0)
    box = item.get("box") or {}
    if page_w <= 0 or page_h <= 0:
        continue
    sx = img.width / page_w
    sy = img.height / page_h
    min_x = float(box.get("minX", 0))
    max_x = float(box.get("maxX", 0))
    min_y = float(box.get("minY", 0))
    max_y = float(box.get("maxY", 0))
    left = min(min_x, max_x) * sx
    right = max(min_x, max_x) * sx
    top = (page_h - max(min_y, max_y)) * sy
    bottom = (page_h - min(min_y, max_y)) * sy
    suffix = f"g{int(item.get('group_index', 0)):03d}" if item.get("item_kind") == "group" else f"m{int(item.get('index', 0)):04d}"
    prefix_kind = "g" if item.get("item_kind") == "group" else "m"
    item_id = f"{prefix_kind}{idx:04d}_{''.join(c if c.isalnum() else '_' for c in pdf_rel)[:40]}_p{page:04d}_{suffix}"
    variants = {}
    variant_plan = [("tight", 1.0), ("context", 3.0)]
    if include_page:
        variant_plan.append(("page", 999.0))
    for variant_name, mult in variant_plan:
        if variant_name == "page":
            l, t, r, btm = 0, 0, img.width, img.height
        else:
            pad = max(24, int(max(right - left, bottom - top) * margin_ratio * mult))
            l = max(0, int(math.floor(left - pad)))
            t = max(0, int(math.floor(top - pad)))
            r = min(img.width, int(math.ceil(right + pad)))
            btm = min(img.height, int(math.ceil(bottom + pad)))
        if r <= l or btm <= t:
            continue
        crop = img.crop((l, t, r, btm))
        norm = normalize_status_colors(crop)
        draw = ImageDraw.Draw(norm)
        rx0 = max(0, min(norm.width - 1, int(min(left, right) - l)))
        ry0 = max(0, min(norm.height - 1, int(min(top, bottom) - t)))
        rx1 = max(0, min(norm.width - 1, int(max(left, right) - l)))
        ry1 = max(0, min(norm.height - 1, int(max(top, bottom) - t)))
        if rx1 >= rx0 and ry1 >= ry0:
            draw.rectangle([rx0, ry0, rx1, ry1], outline=(255, 0, 0), width=5)
        original = os.path.join(thumb_dir, item_id + f"_{variant_name}_original.png")
        normalized = os.path.join(thumb_dir, item_id + f"_{variant_name}_normalized.png")
        max_side = 2200 if variant_name == "page" else 1600
        crop = fit_review_size(crop, max_side)
        norm = fit_review_size(norm, max_side)
        crop.save(original)
        norm.save(normalized)
        variants[variant_name] = {
            "original": os.path.relpath(original, output_dir).replace("\\\\", "/"),
            "normalized": os.path.relpath(normalized, output_dir).replace("\\\\", "/")
        }
    if "tight" not in variants:
        continue
    rendered.append({
        "id": item_id,
        "item_kind": item.get("item_kind", "group"),
        "bucket": item["bucket"],
        "file": pdf_rel,
        "page": page,
        "group_index": int(item.get("group_index", 0)) if item.get("group_index") is not None else None,
        "mark_index": int(item.get("index", 0)) if item.get("index") is not None else None,
        "operation_class": item["operation_class"],
        "target_class": item["target_class"],
        "context_class": item["context_class"],
        "confidence": float(item["confidence"]),
        "mark_count": int(item["mark_count"]),
        "duplicate_count": int(item.get("duplicate_count", 1)),
        "colors": item.get("colors", []),
        "subtypes": item.get("subtypes", []),
        "text_excerpt": item.get("text_excerpt", ""),
        "original_thumb": variants["tight"]["original"],
        "normalized_thumb": variants["tight"]["normalized"],
        "context_original_thumb": variants.get("context", variants["tight"])["original"],
        "context_thumb": variants.get("context", variants["tight"])["normalized"],
        "page_original_thumb": variants.get("page", variants.get("context", variants["tight"]))["original"],
        "page_thumb": variants.get("page", variants.get("context", variants["tight"]))["normalized"]
    })

with open(output_json_path, "w", encoding="utf-8") as f:
    json.dump({"items": rendered}, f, indent=2)
print(json.dumps({"ok": True, "count": len(rendered), "output": output_json_path}))
`;
  const stdout = runPython(py, args.timeoutMs);
  const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const parsed = lastLine ? JSON.parse(lastLine) as { ok: boolean; output?: string } : null;
  if (!parsed?.ok || !parsed.output) throw new Error(`review render failed: ${stdout.slice(0, 1000)}`);
  return JSON.parse(fs.readFileSync(parsed.output, "utf8")).items as RenderedItem[];
}

function reviewHtml(items: RenderedItem[]): string {
  const labelFor = (item: RenderedItem): string => item.item_kind === "mark" ? `mark ${item.mark_index ?? ""}` : `group ${item.group_index ?? ""}`;
  const cards = items.map((item, index) => `
    <article class="card" data-index="${index}" data-id="${htmlEscape(item.id)}">
      <div class="meta">
        <span class="pill">${htmlEscape(item.bucket)}</span>
        <span>${htmlEscape(item.operation_class)} / ${htmlEscape(item.target_class)}</span>
        <span>${htmlEscape(item.confidence.toFixed(2))}</span>
        <span>${htmlEscape(item.file)} p.${item.page} ${htmlEscape(labelFor(item))}</span>
        ${item.duplicate_count && item.duplicate_count > 1 ? `<span>dupes ${item.duplicate_count}</span>` : ""}
      </div>
      <div class="images">
        <figure><img data-kind="original" data-tight="${htmlEscape(item.original_thumb)}" data-context="${htmlEscape(item.context_original_thumb)}" data-page="${htmlEscape(item.page_original_thumb)}" src="${htmlEscape(item.original_thumb)}"><figcaption>original / current zoom</figcaption></figure>
        <figure><img data-kind="normalized" data-tight="${htmlEscape(item.normalized_thumb)}" data-context="${htmlEscape(item.context_thumb)}" data-page="${htmlEscape(item.page_thumb)}" src="${htmlEscape(item.normalized_thumb)}"><figcaption>normalized status colors</figcaption></figure>
      </div>
      <p class="excerpt">${htmlEscape(item.text_excerpt || "(no text)")}</p>
      <div class="zoom">
        <button type="button" data-zoom="tight">Tight</button>
        <button type="button" data-zoom="context">More Context</button>
        <button type="button" data-zoom="page">Full Page</button>
      </div>
      <div class="quick">
        <button type="button" data-status="correct">1 Correct</button>
        <button type="button" data-status="fix">2 Fix</button>
        <button type="button" data-status="not_actionable">3 Not Actionable</button>
        <button type="button" data-status="no_action_required">4 No Action</button>
        <button type="button" data-status="needs_gemini">5 Gemini</button>
      </div>
      <div class="labels">
        <label>Status <select data-field="status"><option></option><option>correct</option><option>fix</option><option>not_actionable</option><option>no_action_required</option><option>supplemental_reference</option><option>skip</option><option>needs_gemini</option></select></label>
        <label>Operation <input data-field="operation" value="${htmlEscape(item.operation_class)}"></label>
        <label>Target <input data-field="target" value="${htmlEscape(item.target_class)}"></label>
        <label>Requirements <input data-field="requirements" value="${htmlEscape(requirementsFor(item))}"></label>
        <label>Grouping <select data-field="grouping"><option></option><option>good</option><option>too_tight</option><option>too_broad</option><option>wrong_group</option></select></label>
        <label class="notes">Notes <textarea data-field="notes"></textarea></label>
      </div>
    </article>`).join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Redline Corpus Review Pack</title>
  <style>
    body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #f5f5f2; color: #1f2933; }
    header { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center; padding: 10px 14px; background: #17202a; color: white; }
    header button, header select { font: inherit; }
    main { padding: 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); gap: 14px; }
    .card { background: white; border: 1px solid #d5d8dc; border-radius: 6px; padding: 10px; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: #52616f; margin-bottom: 8px; }
    .pill { background: #e6eef5; color: #22384d; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
    .images { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    figure { margin: 0; border: 1px solid #d9dde3; background: #fafafa; }
    img { width: 100%; height: 280px; object-fit: contain; display: block; }
    figcaption { padding: 4px 6px; font-size: 11px; color: #64707d; border-top: 1px solid #e1e5ea; }
    .excerpt { font-size: 13px; line-height: 1.35; min-height: 36px; }
    .labels { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .zoom { display: flex; gap: 8px; margin: 8px 0; }
    .quick { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
    .zoom button, .quick button { padding: 5px 8px; border: 1px solid #aeb7c2; background: #f7f9fb; border-radius: 4px; cursor: pointer; }
    label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: #425466; }
    input, select, textarea { font: inherit; padding: 6px; border: 1px solid #b8c0c8; border-radius: 4px; }
    .notes { grid-column: 1 / -1; }
    textarea { min-height: 54px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <header>
    <strong>Redline Corpus Review</strong>
    <span id="count"></span>
    <select id="filter"><option value="">all</option><option>calculation_or_reference_mark</option><option>modeled_mep_mark</option><option>graphics_documentation_mark</option><option>annotation_text_mark</option><option>manual_review_mark</option><option>modeled_mep_candidate</option><option>graphics_documentation_candidate</option><option>annotation_text_candidate</option><option>unknown_geometry_candidate</option></select>
    <button id="downloadJson">Download JSON</button>
    <button id="downloadCsv">Download CSV</button>
  </header>
  <main>${cards}</main>
  <script>
    const key = "redline-review-pack:" + location.pathname;
    const cards = Array.from(document.querySelectorAll(".card"));
    const load = () => JSON.parse(localStorage.getItem(key) || "{}");
    const save = (data) => localStorage.setItem(key, JSON.stringify(data));
    function collect() {
      const data = load();
      for (const card of cards) {
        const id = card.dataset.id;
        data[id] ||= {};
        card.querySelectorAll("[data-field]").forEach(el => data[id][el.dataset.field] = el.value);
      }
      save(data);
      return data;
    }
    function restore() {
      const data = load();
      for (const card of cards) {
        const item = data[card.dataset.id] || {};
        card.querySelectorAll("[data-field]").forEach(el => { if (item[el.dataset.field] !== undefined) el.value = item[el.dataset.field]; });
      }
    }
    function applyFilter() {
      const value = document.getElementById("filter").value;
      let visible = 0;
      for (const card of cards) {
        const show = !value || card.textContent.includes(value);
        card.classList.toggle("hidden", !show);
        if (show) visible++;
      }
      document.getElementById("count").textContent = visible + " / " + cards.length;
    }
    function download(name, text, type) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type }));
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    document.addEventListener("input", collect);
    document.addEventListener("click", ev => {
      const btn = ev.target.closest("[data-zoom]");
      if (btn) {
        const card = btn.closest(".card");
        const zoom = btn.dataset.zoom;
        card.querySelectorAll("img[data-" + zoom + "]").forEach(img => img.src = img.dataset[zoom]);
        return;
      }
      const statusBtn = ev.target.closest("[data-status]");
      if (statusBtn) {
        const card = statusBtn.closest(".card");
        card.querySelector("[data-field=status]").value = statusBtn.dataset.status;
        collect();
        nextCard(card);
      }
    });
    function visibleCards() { return cards.filter(card => !card.classList.contains("hidden")); }
    function nextCard(card) {
      const list = visibleCards();
      const current = card || document.elementFromPoint(window.innerWidth / 2, 160)?.closest?.(".card") || list[0];
      const index = Math.max(0, list.indexOf(current));
      const next = list[Math.min(list.length - 1, index + 1)];
      if (next) next.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    function prevCard(card) {
      const list = visibleCards();
      const current = card || document.elementFromPoint(window.innerWidth / 2, 160)?.closest?.(".card") || list[0];
      const index = Math.max(0, list.indexOf(current));
      const prev = list[Math.max(0, index - 1)];
      if (prev) prev.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    document.addEventListener("keydown", ev => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "")) return;
      const card = document.elementFromPoint(window.innerWidth / 2, 160)?.closest?.(".card") || visibleCards()[0];
      const statusMap = { "1": "correct", "2": "fix", "3": "not_actionable", "4": "no_action_required", "5": "needs_gemini" };
      if (statusMap[ev.key] && card) {
        card.querySelector("[data-field=status]").value = statusMap[ev.key];
        collect();
        nextCard(card);
      } else if (ev.key.toLowerCase() === "n" && card) nextCard(card);
      else if (ev.key.toLowerCase() === "p" && card) prevCard(card);
      else if (["t", "c", "f"].includes(ev.key.toLowerCase()) && card) {
        const zoom = ev.key.toLowerCase() === "t" ? "tight" : ev.key.toLowerCase() === "c" ? "context" : "page";
        card.querySelectorAll("img[data-" + zoom + "]").forEach(img => img.src = img.dataset[zoom]);
      }
    });
    document.getElementById("filter").addEventListener("change", applyFilter);
    document.getElementById("downloadJson").onclick = () => download("redline_review_labels.json", JSON.stringify(collect(), null, 2), "application/json");
    document.getElementById("downloadCsv").onclick = () => {
      const data = collect();
      const lines = [["id","status","operation","target","requirements","grouping","notes"].join(",")];
      for (const id of Object.keys(data)) lines.push([id, data[id].status, data[id].operation, data[id].target, data[id].requirements, data[id].grouping, data[id].notes].map(v => '"' + String(v || "").replaceAll('"','""') + '"').join(","));
      download("redline_review_labels.csv", lines.join("\\n"), "text/csv");
    };
    restore();
    applyFilter();
  </script>
</body>
</html>`;
}

function requirementsFor(item: RenderedItem): string {
  if (item.bucket === "calculation_or_reference_mark") return "review_context;not_actionable_unless_explicit_model_change";
  if (item.bucket === "modeled_mep_candidate" || item.bucket === "modeled_mep_mark") return "model_write;visual_gate;connector_or_readback_audit;cleanup";
  if (item.bucket === "graphics_documentation_candidate" || item.bucket === "graphics_documentation_mark") return "native_readback;post_change_capture;cleanup";
  if (item.target_class === "schedule") return "schedule_readback;post_change_capture;cleanup";
  if (item.target_class === "model_parameter") return "model_write;parameter_readback;post_change_capture;cleanup_or_revert";
  if (item.operation_class === "size_transition") return "model_write;visual_gate;projection_readback;fitting_readback;connector_network_audit;cleanup";
  if (item.target_class === "text" || item.target_class === "tag") return "created_or_changed_ids;post_change_capture;cleanup";
  return "manual_visual_region_review";
}

async function main(): Promise<void> {
  const inventoryArg = flagValue(process.argv, "--inventory");
  if (!inventoryArg) {
    console.error("Usage: npm run redline:review-pack -- --inventory <redline_corpus_inventory.json> [--output <folder>] [--mode marks|groups] [--bucket modeled_mep_mark] [--limit 400]");
    process.exit(2);
  }
  const inventoryPath = path.resolve(inventoryArg);
  const outputDir = path.resolve(flagValue(process.argv, "--output") ?? path.join(repoRoot(), "local-work", "redline-corpus", "review-pack"));
  const mode = (flagValue(process.argv, "--mode") ?? "marks").toLowerCase() === "groups" ? "groups" : "marks";
  const bucket = flagValue(process.argv, "--bucket");
  const limit = numberFlag(process.argv, "--limit", 400);
  const dpi = numberFlag(process.argv, "--dpi", 130);
  const includePage = process.argv.includes("--include-page");
  const report = JSON.parse(fs.readFileSync(inventoryPath, "utf8")) as InventoryReport;
  const queue = (mode === "groups" ? buildQueue(report.groups) : buildMarkQueue(report.mark_review_items ?? []))
    .filter((item) => !bucket || item.bucket === bucket)
    .slice(0, limit);

  ensureDir(outputDir);
  const rendered = renderReviewItems({
    sourceDir: report.source_dir,
    outputDir,
    items: queue,
    dpi,
    margin: 0.28,
    includePage,
    timeoutMs: Math.max(300_000, queue.length * 15_000)
  });
  const byBucket: Record<string, number> = {};
  for (const item of rendered) addCount(byBucket, item.bucket);
  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    inventory: inventoryPath,
    source_dir: report.source_dir,
    output_dir: outputDir,
    mode,
    requested_bucket: bucket ?? "",
    requested_limit: limit,
    include_page: includePage,
    rendered_count: rendered.length,
    by_bucket: byBucket,
    items: rendered
  };
  const manifestPath = path.join(outputDir, "redline_review_pack_manifest.json");
  const csvPath = path.join(outputDir, "redline_review_pack_items.csv");
  const htmlPath = path.join(outputDir, "redline_review_pack.html");
  writeJsonFile(manifestPath, manifest);
  writeTextFile(csvPath, [
    ["id", "item_kind", "bucket", "file", "page", "group_index", "mark_index", "operation_class", "target_class", "context_class", "confidence", "mark_count", "duplicate_count", "colors", "subtypes", "text_excerpt", "original_thumb", "normalized_thumb", "context_original_thumb", "context_thumb", "page_original_thumb", "page_thumb"].join(","),
    ...rendered.map((item) => [
      item.id,
      item.item_kind,
      item.bucket,
      item.file,
      item.page,
      item.group_index ?? "",
      item.mark_index ?? "",
      item.operation_class,
      item.target_class,
      item.context_class,
      item.confidence,
      item.mark_count,
      item.duplicate_count ?? "",
      item.colors.join("|"),
      item.subtypes.join("|"),
      item.text_excerpt,
      item.original_thumb,
      item.normalized_thumb,
      item.context_original_thumb,
      item.context_thumb,
      item.page_original_thumb,
      item.page_thumb
    ].map(csvCell).join(","))
  ].join("\n"));
  writeTextFile(htmlPath, reviewHtml(rendered));
  console.log(JSON.stringify({ ok: true, output_dir: outputDir, html: htmlPath, manifest: manifestPath, csv: csvPath, rendered_count: rendered.length, by_bucket: byBucket }, null, 2));
}

await main();
