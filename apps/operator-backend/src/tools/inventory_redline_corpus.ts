import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, repoRoot, writeJsonFile, writeTextFile } from "../benchmark/files.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";
import { classifyRedlineCorpusText } from "../redline/corpus_classifier.js";

type Box = { minX: number; minY: number; maxX: number; maxY: number };
type AnnotationRecord = {
  file: string;
  page: number;
  index: number;
  page_width?: number;
  page_height?: number;
  subtype: string;
  color: string;
  color_family: string;
  author?: string;
  subject?: string;
  state?: string;
  state_model?: string;
  has_text: boolean;
  text_excerpt?: string;
  has_appearance: boolean;
  box?: Box;
  area?: number;
};

type FileInventory = {
  file: string;
  bytes: number;
  pages: number;
  scanned_pages: number;
  annotations: number;
  markup_annotations: number;
  text_bearing_markups: number;
  geometry_only_markups: number;
  appearance_stream_markups: number;
  by_color_family: Record<string, number>;
  by_subtype: Record<string, number>;
  likely_composite_groups: number;
  sample_text: string[];
};

type CompositeGroupRecord = {
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

type MarkReviewRecord = {
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
  review_status: string;
  review_operation: string;
  review_target: string;
  review_notes: string;
};

type ReviewQueueRecord = CompositeGroupRecord & {
  priority_rank: number;
  bucket: string;
  bucket_reason: string;
  review_status: string;
  review_operation: string;
  review_target: string;
  review_notes: string;
};

type CorpusInventoryReport = {
  schema_version: 1;
  generated_at: string;
  source_dir: string;
  input_count: number;
  scanned_file_count: number;
  total_bytes: number;
  total_pages: number;
  scanned_pages: number;
  annotations: number;
  markup_annotations: number;
  text_bearing_markups: number;
  geometry_only_markups: number;
  appearance_stream_markups: number;
  likely_composite_groups: number;
  by_color_family: Record<string, number>;
  by_subtype: Record<string, number>;
  group_classification: {
    group_count: number;
    by_operation: Record<string, number>;
    by_target: Record<string, number>;
    manual_review_count: number;
  };
  review_queue: {
    count: number;
    by_bucket: Record<string, number>;
  };
  mark_review_queue: {
    count: number;
    by_bucket: Record<string, number>;
    by_operation: Record<string, number>;
    by_target: Record<string, number>;
  };
  files: FileInventory[];
  groups: CompositeGroupRecord[];
  text_marks: AnnotationRecord[];
  mark_review_items: MarkReviewRecord[];
  samples: AnnotationRecord[];
};

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function numberFlag(argv: string[], name: string): number | undefined {
  const raw = flagValue(argv, name);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function suppressNoisyPdfWarnings(): void {
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalLog = console.log.bind(console);
  const shouldSuppress = (args: unknown[]): boolean => {
    const message = args.map((arg) => String(arg)).join(" ");
    return (
      /FreeTextAnnotation: OffscreenCanvas is not supported/i.test(message) ||
      /Unable to load font data/i.test(message) ||
      /getPathGenerator - ignoring character/i.test(message) ||
      /XFA - an error occurred during parsing of rich text/i.test(message) ||
      /AnnotationBorderStyle\.setWidth - ignoring width/i.test(message) ||
      /Indexing all PDF objects/i.test(message)
    );
  };
  console.warn = (...args: unknown[]) => {
    if (shouldSuppress(args)) return;
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (shouldSuppress(args)) return;
    originalError(...args);
  };
  console.log = (...args: unknown[]) => {
    if (shouldSuppress(args)) return;
    originalLog(...args);
  };
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value && typeof value === "object" && typeof (value as any).str === "string") return textOf((value as any).str);
  return "";
}

function colorValues(rgb: unknown): [number, number, number] | null {
  const values =
    Array.isArray(rgb)
      ? rgb
      : ArrayBuffer.isView(rgb)
        ? Array.from(rgb as unknown as ArrayLike<number>)
        : rgb && typeof rgb === "object" && typeof (rgb as any).length === "number"
          ? Array.from(rgb as ArrayLike<number>)
          : null;
  if (!values || values.length < 3) return null;
  const normalize = (x: unknown) => {
    const n = Number(x);
    if (!Number.isFinite(n)) return NaN;
    if (n <= 1) return Math.max(0, Math.min(255, Math.round(n * 255)));
    return Math.max(0, Math.min(255, Math.round(n)));
  };
  const r = normalize(values[0]);
  const g = normalize(values[1]);
  const b = normalize(values[2]);
  if (![r, g, b].every(Number.isFinite)) return null;
  return [r, g, b];
}

function colorName(rgb: unknown): string {
  const values = colorValues(rgb);
  return values ? `rgb(${values[0]},${values[1]},${values[2]})` : "unknown";
}

function colorFamily(rgb: unknown): string {
  const values = colorValues(rgb);
  if (!values) return "unknown";
  const [r, g, b] = values;
  if (r >= 120 && r > g + 35 && r > b + 35) return "red";
  if (g >= 140 && g > r + 35 && g > b + 35) return "green";
  if (b >= 120 && b > r + 30 && b > g + 20) return "blue";
  if (r >= 180 && g >= 80 && g <= 190 && b < 80) return "orange";
  if (r >= 170 && g >= 170 && b < 120) return "yellow";
  if (r < 80 && g < 80 && b < 80) return "black";
  if (r > 210 && g > 210 && b > 210) return "white";
  return "other";
}

function isMarkupSubtype(subtype: string): boolean {
  return /^(Text|FreeText|Line|Square|Circle|Polygon|PolyLine|Highlight|Underline|Squiggly|StrikeOut|Stamp|Caret|Ink|FileAttachment|Sound)$/i.test(subtype);
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function annotationBox(a: any): Box | undefined {
  const rect = Array.isArray(a?.rect) ? a.rect : Array.isArray(a?.rectangle) ? a.rectangle : null;
  if (!rect || rect.length < 4) return undefined;
  const x1 = finiteNumber(rect[0]);
  const y1 = finiteNumber(rect[1]);
  const x2 = finiteNumber(rect[2]);
  const y2 = finiteNumber(rect[3]);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return undefined;
  return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
}

function boxArea(box: Box | undefined): number {
  if (!box) return 0;
  return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY);
}

function boxDistance(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
  const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
  return Math.hypot(dx, dy);
}

function buildCompositeGroups(records: AnnotationRecord[]): CompositeGroupRecord[] {
  const byPage = new Map<number, AnnotationRecord[]>();
  for (const r of records) {
    if (!r.box || !isMarkupSubtype(r.subtype)) continue;
    const arr = byPage.get(r.page) ?? [];
    arr.push(r);
    byPage.set(r.page, arr);
  }
  const groups: CompositeGroupRecord[] = [];
  for (const pageRecords of byPage.values()) {
    const candidates = pageRecords.filter((r) => r.box && (r.has_text || boxArea(r.box) > 0)).slice(0, 600);
    const parent = candidates.map((_, index) => index);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!;
        x = parent[x]!;
      }
      return x;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]!;
        const b = candidates[j]!;
        if (a.box && b.box && boxDistance(a.box, b.box) <= 36) union(i, j);
      }
    }
    const components = new Map<number, AnnotationRecord[]>();
    for (let i = 0; i < candidates.length; i++) {
      const root = find(i);
      const arr = components.get(root) ?? [];
      arr.push(candidates[i]!);
      components.set(root, arr);
    }
    let pageGroupIndex = 0;
    for (const component of components.values()) {
      if (component.length < 2) continue;
      pageGroupIndex++;
      const text = component.map((r) => r.text_excerpt).filter(Boolean).join(" ");
      const subtypes = Array.from(new Set(component.map((r) => r.subtype))).sort();
      const colors = Array.from(new Set(component.map((r) => r.color_family))).sort();
      const boxes = component.map((r) => r.box).filter((box): box is Box => !!box);
      const box = boxes.length
        ? {
            minX: Math.min(...boxes.map((b) => b.minX)),
            minY: Math.min(...boxes.map((b) => b.minY)),
            maxX: Math.max(...boxes.map((b) => b.maxX)),
            maxY: Math.max(...boxes.map((b) => b.maxY))
          }
        : undefined;
      const classification = classifyRedlineCorpusText({
        file_path: component[0]!.file,
        text: [text, `subtypes ${subtypes.join(" ")}`, `colors ${colors.join(" ")}`].join(" ")
      });
      groups.push({
        file: component[0]!.file,
        page: component[0]!.page,
        group_index: pageGroupIndex,
        ...(component[0]!.page_width ? { page_width: component[0]!.page_width } : {}),
        ...(component[0]!.page_height ? { page_height: component[0]!.page_height } : {}),
        ...(box ? { box } : {}),
        annotation_indices: component.map((r) => r.index).sort((a, b) => a - b),
        mark_count: component.length,
        text_mark_count: component.filter((r) => r.has_text).length,
        geometry_only_count: component.filter((r) => !r.has_text).length,
        colors,
        subtypes,
        text_excerpt: text.slice(0, 500),
        operation_class: classification.operation_class,
        target_class: classification.target_class,
        context_class: classification.context_class,
        confidence: classification.confidence,
        ...(classification.manual_review_reason ? { manual_review_reason: classification.manual_review_reason } : {})
      });
    }
  }
  return groups;
}

function addCount(map: Record<string, number>, key: string, count = 1): void {
  map[key] = (map[key] ?? 0) + count;
}

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function markdownTable(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((v) => String(v ?? "").replace(/\|/g, "\\|")).join(" | ")} |`)
  ].join("\n");
}

function reviewBucket(group: CompositeGroupRecord): { bucket: string; priority_rank: number; bucket_reason: string } {
  const op = group.operation_class;
  const target = group.target_class;
  const haystack = `${group.text_excerpt} ${group.subtypes.join(" ")} ${op} ${target}`.toLowerCase();
  const mepTargets = new Set(["duct", "pipe", "mep_accessory", "receptacle", "light"]);
  const mepOperations = new Set(["route", "tap_branch", "reroute_offset", "size_transition", "type_change"]);
  const mepTerms = /\b(duct|pipe|piping|damper|diffuser|grille|register|vav|sprinkler|san|cw|hw|chws|chwr|vent|mep|receptacle|light|fixture)\b/i;
  const graphicsTargets = new Set(["cad_link", "view_filter", "view_template", "category_graphics", "schedule", "sheet"]);
  if (mepTargets.has(target)) {
    const opRank = mepOperations.has(op) ? 1 : 4;
    return {
      bucket: "modeled_mep_candidate",
      priority_rank: 10 + opRank,
      bucket_reason: `MEP target ${target}`
    };
  }
  if (mepOperations.has(op) && mepTerms.test(haystack)) {
    return {
      bucket: "modeled_mep_candidate",
      priority_rank: 15,
      bucket_reason: `MEP operation ${op} with local MEP terms`
    };
  }
  if (graphicsTargets.has(target) || op === "graphics_override") {
    return {
      bucket: "graphics_documentation_candidate",
      priority_rank: 20,
      bucket_reason: graphicsTargets.has(target) ? `graphics/documentation target ${target}` : "graphics override operation"
    };
  }
  if ((target === "text" || target === "tag") && op !== "unknown") {
    return {
      bucket: "annotation_text_candidate",
      priority_rank: 30,
      bucket_reason: `known ${op} operation on ${target}`
    };
  }
  if (op === "unknown" || target === "unknown" || group.geometry_only_count > group.text_mark_count) {
    return {
      bucket: "unknown_geometry_candidate",
      priority_rank: 40 + Math.min(20, group.geometry_only_count),
      bucket_reason: group.geometry_only_count > group.text_mark_count ? "geometry-heavy composite group" : "unknown local intent"
    };
  }
  return {
    bucket: "low_priority_text_noise",
    priority_rank: 90,
    bucket_reason: "low-confidence text/status markup"
  };
}

function buildReviewQueue(groups: CompositeGroupRecord[]): ReviewQueueRecord[] {
  return groups
    .map((group) => {
      const bucket = reviewBucket(group);
      return {
        ...group,
        ...bucket,
        review_status: "",
        review_operation: "",
        review_target: "",
        review_notes: ""
      };
    })
    .sort((a, b) =>
      a.priority_rank - b.priority_rank ||
      b.confidence - a.confidence ||
      b.mark_count - a.mark_count ||
      a.file.localeCompare(b.file) ||
      a.page - b.page ||
      a.group_index - b.group_index
    );
}

function normalizedMarkText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9#."'/-]+/g, " ").replace(/\s+/g, " ").trim();
}

function roundedCenterKey(mark: AnnotationRecord): string {
  const b = mark.box;
  if (!b) return "no-box";
  const cx = Math.round(((b.minX + b.maxX) / 2) / 10) * 10;
  const cy = Math.round(((b.minY + b.maxY) / 2) / 10) * 10;
  return `${cx}:${cy}`;
}

export function classifyInventoryMarkBucket(args: { text: string; subtype?: string; colorFamily?: string; operation: string; target: string }): { bucket: string; priority_rank: number; bucket_reason: string } {
  const text = normalizedMarkText([args.text, args.subtype ? `subtype ${args.subtype}` : "", args.colorFamily ? `color ${args.colorFamily}` : ""].filter(Boolean).join(" "));
  const hasFlowValue = /\b(cfm|gpm|mbh|btuh|ton|tons|fpm|l\/s)\b/i.test(text);
  const hasDuctSize = /\b\d{1,3}\s*(?:x|")\s*\d{1,3}\b/i.test(text) || /\b\d{1,3}\s*(?:dia|diameter|ø)\b/i.test(text);
  const explicitAction = /\b(add|delete|remove|move|shift|relocate|route|reroute|connect|tap|branch|change|revise|resize|lineweight|line weight|hidden|hide|tag|label|show|provide|install|place|set|update|replace|correct)\b/i.test(text);
  const explicitGraphics = /\b(lineweight|line weight|hidden|halftone|future|filter|template|visibility|display|dashed|screened)\b/i.test(text);
  const hasStatusMetadata = /\bsubtype highlight\b|\bcolor (?:yellow|green|blue|orange|white)\b|\bhighlight(?:er|ed)?\b|\bstatus (?:mark|markup|highlight)\b/i.test(text);
  const hasCompletionOrReferenceText = /\b(no action required|not actionable|already (?:done|complete|completed)|completed|done|verified|reviewed|for reference only|reference only|highlight only|status only)\b/i.test(text);
  const hasMepOrValueText = /\b(?:duct|pipe|piping|damper|diffuser|grille|vav|receptacle|light|fixture|cfm|gpm|mbh|btuh|\d{1,3}\s*(?:x|×)\s*\d{1,3})\b/i.test(text);
  if (!explicitAction && (hasCompletionOrReferenceText || (hasStatusMetadata && hasMepOrValueText))) {
    const reason = hasCompletionOrReferenceText
      ? "status/reference highlight without actionable directive"
      : "highlight/status MEP value without explicit action verb";
    return { bucket: "status_reference_mark", priority_rank: 58, bucket_reason: reason };
  }
  if (hasDuctSize) {
    return { bucket: "modeled_mep_mark", priority_rank: 9, bucket_reason: "duct/pipe size mark is an implied model size change" };
  }
  if (hasFlowValue && !explicitAction) {
    return { bucket: "calculation_or_reference_mark", priority_rank: 12, bucket_reason: "flow/calculation text without explicit size or action verb" };
  }
  if (["duct", "pipe", "mep_accessory", "receptacle", "light"].includes(args.target)) {
    return { bucket: "modeled_mep_mark", priority_rank: 10, bucket_reason: `MEP target ${args.target}` };
  }
  if (["route", "tap_branch", "reroute_offset", "size_transition", "type_change"].includes(args.operation)) {
    return { bucket: "modeled_mep_mark", priority_rank: 11, bucket_reason: `MEP operation ${args.operation}` };
  }
  if (["cad_link", "view_filter", "view_template", "category_graphics", "schedule", "sheet"].includes(args.target) || (args.operation === "graphics_override" && explicitGraphics)) {
    return { bucket: "graphics_documentation_mark", priority_rank: 20, bucket_reason: "graphics/documentation target or operation" };
  }
  if ((args.target === "text" || args.target === "tag") && args.operation !== "unknown") {
    return { bucket: "annotation_text_mark", priority_rank: 30, bucket_reason: `known ${args.operation} operation on ${args.target}` };
  }
  return { bucket: "manual_review_mark", priority_rank: 60, bucket_reason: "text exists but action/target is not clear" };
}

function markBucket(mark: AnnotationRecord, operation: string, target: string): { bucket: string; priority_rank: number; bucket_reason: string } {
  return classifyInventoryMarkBucket({ text: mark.text_excerpt ?? "", subtype: mark.subtype, colorFamily: mark.color_family, operation, target });
}

function inferModeledMepOperation(textExcerpt: string, fallback: string): string {
  const text = normalizedMarkText(textExcerpt);
  if (/\b(delete|remove|omit|not required|no damper here)\b/i.test(text)) return "delete";
  if (/\b(move|shift|relocate)\b/i.test(text)) return "move";
  if (/\b(reroute|route around|avoid|conflict|does not conflict|clear for takeoff|penetration location|modify ductwork as required|adjust duct)\b/i.test(text)) return "reroute_offset";
  if (/\b(tap|branch|takeoff|take off)\b/i.test(text)) return "tap_branch";
  if (/\b(upsize|resize|size|wide|tall|dia|diameter|cfm|gpm)\b/i.test(text)) return "size_transition";
  if (/\b(change revit family|change family|type|rectangular|round|fire smoke|fsd)\b/i.test(text)) return "type_change";
  if (/\b(add|provide|show|tag|assign|schedule|draw|place)\b/i.test(text)) return "add";
  return fallback === "graphics_override" ? "unknown" : fallback;
}

function buildMarkReviewQueue(marks: AnnotationRecord[]): MarkReviewRecord[] {
  const counts = new Map<string, number>();
  for (const mark of marks) {
    const key = `${mark.file}|${mark.page}|${roundedCenterKey(mark)}|${normalizedMarkText(mark.text_excerpt ?? "")}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const queue: MarkReviewRecord[] = [];
  for (const mark of marks) {
    if (!mark.has_text || !mark.text_excerpt || !mark.box || !isMarkupSubtype(mark.subtype)) continue;
    const key = `${mark.file}|${mark.page}|${roundedCenterKey(mark)}|${normalizedMarkText(mark.text_excerpt)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const classification = classifyRedlineCorpusText({
      file_path: mark.file,
      text: [mark.text_excerpt, `subtype ${mark.subtype}`, `color ${mark.color_family}`].join(" ")
    });
    const bucket = markBucket(mark, classification.operation_class, classification.target_class);
    const calcTarget = /\b(cfm|duct|dia|ø|damper|vav|ahu|ef|ra|sa|ea|oa)\b/i.test(mark.text_excerpt) || /\b\d{1,3}\s*[x"]\s*\d{1,3}\b/i.test(mark.text_excerpt) ? "duct" : "unknown";
    const operationClass =
      bucket.bucket === "calculation_or_reference_mark"
        ? "calculation_reference"
        : bucket.bucket === "modeled_mep_mark" && bucket.bucket_reason.includes("size mark")
          ? "size_transition"
        : bucket.bucket === "modeled_mep_mark"
          ? inferModeledMepOperation(mark.text_excerpt, classification.operation_class)
        : bucket.bucket === "manual_review_mark" && classification.operation_class === "graphics_override"
          ? "unknown"
          : classification.operation_class;
    const targetClass = bucket.bucket === "calculation_or_reference_mark" ? calcTarget : classification.target_class;
    queue.push({
      file: mark.file,
      page: mark.page,
      index: mark.index,
      ...(mark.page_width ? { page_width: mark.page_width } : {}),
      ...(mark.page_height ? { page_height: mark.page_height } : {}),
      ...(mark.box ? { box: mark.box } : {}),
      subtype: mark.subtype,
      color: mark.color,
      color_family: mark.color_family,
      text_excerpt: mark.text_excerpt,
      operation_class: operationClass,
      target_class: targetClass,
      context_class: classification.context_class,
      confidence: classification.confidence,
      ...bucket,
      duplicate_count: counts.get(key) ?? 1,
      review_status: "",
      review_operation: "",
      review_target: "",
      review_notes: ""
    });
  }
  return queue.sort((a, b) =>
    a.priority_rank - b.priority_rank ||
    b.confidence - a.confidence ||
    b.duplicate_count - a.duplicate_count ||
    a.file.localeCompare(b.file) ||
    a.page - b.page ||
    a.index - b.index
  );
}

function markReviewMarkdown(queue: MarkReviewRecord[]): string {
  const byBucket: Record<string, number> = {};
  const byOperation: Record<string, number> = {};
  const byTarget: Record<string, number> = {};
  for (const mark of queue) {
    addCount(byBucket, mark.bucket);
    addCount(byOperation, mark.operation_class);
    addCount(byTarget, mark.target_class);
  }
  const rows = (bucket: string) => queue.filter((m) => m.bucket === bucket).slice(0, 30).map((m) => [
    m.file,
    m.page,
    m.index,
    m.operation_class,
    m.target_class,
    m.confidence.toFixed(2),
    m.duplicate_count,
    m.text_excerpt.slice(0, 140)
  ]);
  return [
    "# Redline Corpus Mark Review Queue",
    "",
    "This is the finer-grained queue. Each row is anchored to a single text-bearing PDF markup, not a whole proximity group.",
    "",
    "## Buckets",
    "",
    markdownTable(["bucket", "count"], sortedCountRows(byBucket)),
    "",
    "## Understood Operation Summary",
    "",
    markdownTable(["operation", "count"], sortedCountRows(byOperation).slice(0, 30)),
    "",
    "## Understood Target Summary",
    "",
    markdownTable(["target", "count"], sortedCountRows(byTarget).slice(0, 30)),
    "",
    "## Calculation Or Reference Marks",
    "",
    markdownTable(["file", "page", "mark", "operation", "target", "confidence", "dupes", "text"], rows("calculation_or_reference_mark")),
    "",
    "## Modeled MEP Marks",
    "",
    markdownTable(["file", "page", "mark", "operation", "target", "confidence", "dupes", "text"], rows("modeled_mep_mark")),
    "",
    "## Graphics And Documentation Marks",
    "",
    markdownTable(["file", "page", "mark", "operation", "target", "confidence", "dupes", "text"], rows("graphics_documentation_mark")),
    "",
    "## Manual Review Marks",
    "",
    markdownTable(["file", "page", "mark", "operation", "target", "confidence", "dupes", "text"], rows("manual_review_mark"))
  ].join("\n");
}

function reviewQueueMarkdown(queue: ReviewQueueRecord[]): string {
  const byBucket: Record<string, number> = {};
  for (const item of queue) addCount(byBucket, item.bucket);
  const section = (title: string, bucket: string) => {
    const rows = queue.filter((item) => item.bucket === bucket).slice(0, 25).map((item) => [
      item.priority_rank,
      item.file,
      item.page,
      item.group_index,
      item.mark_count,
      item.colors.join("|"),
      item.operation_class,
      item.target_class,
      item.confidence.toFixed(2),
      item.text_excerpt.slice(0, 120)
    ]);
    return [
      `## ${title}`,
      "",
      rows.length
        ? markdownTable(["rank", "file", "page", "group", "marks", "colors", "operation", "target", "confidence", "excerpt"], rows)
        : "_No rows._"
    ].join("\n");
  };
  return [
    "# Redline Corpus Group Review Queue",
    "",
    "This queue is for human labeling of composite visual regions. Treat the auto-classification as a triage hint, not truth.",
    "",
    "## Labeling Rules",
    "",
    "- Review each row as a composite visual region on the PDF page, not as isolated annotation text.",
    "- Green, yellow, blue, and orange are status/markup colors in this corpus; do not infer intent from color alone.",
    "- Use the blank `review_*` CSV columns for the corrected operation, target, status, and notes.",
    "- Promote modeled MEP rows to live benchmark requests only after the exact Revit ids, points, sizes, system/level context, cleanup, and visual gate context are known.",
    "",
    "## Buckets",
    "",
    markdownTable(["bucket", "count"], sortedCountRows(byBucket)),
    "",
    section("Modeled MEP Candidates", "modeled_mep_candidate"),
    "",
    section("Graphics And Documentation Candidates", "graphics_documentation_candidate"),
    "",
    section("Annotation/Text Candidates", "annotation_text_candidate"),
    "",
    section("Unknown Geometry Candidates", "unknown_geometry_candidate")
  ].join("\n");
}

async function inventoryPdf(filePath: string, sourceDir: string, maxPages?: number): Promise<{ file: FileInventory; samples: AnnotationRecord[]; groups: CompositeGroupRecord[]; textMarks: AnnotationRecord[] }> {
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const pdfjs = await loadPdfJsForNode();
  const doc = await pdfjs.getDocument(buildPdfJsDocumentOptions(data)).promise;
  const pages = Number(doc.numPages) || 0;
  const scannedPages = Math.min(pages, maxPages ?? pages);
  const rel = path.relative(sourceDir, filePath);
  const records: AnnotationRecord[] = [];
  const file: FileInventory = {
    file: rel,
    bytes: data.byteLength,
    pages,
    scanned_pages: scannedPages,
    annotations: 0,
    markup_annotations: 0,
    text_bearing_markups: 0,
    geometry_only_markups: 0,
    appearance_stream_markups: 0,
    by_color_family: {},
    by_subtype: {},
    likely_composite_groups: 0,
    sample_text: []
  };
  for (let pageNumber = 1; pageNumber <= scannedPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.0 });
    const pageWidth = Number((viewport as any)?.width);
    const pageHeight = Number((viewport as any)?.height);
    let annotations: any[] = [];
    try {
      const raw = await page.getAnnotations();
      if (Array.isArray(raw)) annotations = raw;
    } catch {
      annotations = [];
    }
    file.annotations += annotations.length;
    for (let i = 0; i < annotations.length; i++) {
      const a = annotations[i];
      const subtype = textOf(a?.subtype) || "Unknown";
      const isMarkup = isMarkupSubtype(subtype);
      const contents = [
        textOf(a?.contents),
        textOf(a?.contentsObj),
        Array.isArray(a?.textContent) ? a.textContent.map(textOf).filter(Boolean).join(" ") : ""
      ].filter(Boolean).join(" ");
      const family = colorFamily(a?.color);
      const record: AnnotationRecord = {
        file: rel,
        page: pageNumber,
        index: i + 1,
        ...(Number.isFinite(pageWidth) && pageWidth > 0 ? { page_width: pageWidth } : {}),
        ...(Number.isFinite(pageHeight) && pageHeight > 0 ? { page_height: pageHeight } : {}),
        subtype,
        color: colorName(a?.color),
        color_family: family,
        author: textOf(a?.titleObj) || textOf(a?.title) || textOf(a?.T) || undefined,
        subject: textOf(a?.subject) || textOf(a?.subj) || undefined,
        state: textOf(a?.state) || textOf(a?.State) || undefined,
        state_model: textOf(a?.stateModel) || textOf(a?.StateModel) || undefined,
        has_text: contents.length > 0,
        text_excerpt: contents ? contents.slice(0, 240) : undefined,
        has_appearance: !!a?.appearance || !!a?.ap || !!a?.AP,
        box: annotationBox(a)
      };
      record.area = boxArea(record.box);
      records.push(record);
      addCount(file.by_subtype, subtype);
      addCount(file.by_color_family, family);
      if (isMarkup) {
        file.markup_annotations++;
        if (record.has_text) {
          file.text_bearing_markups++;
          if (file.sample_text.length < 8 && record.text_excerpt) file.sample_text.push(record.text_excerpt);
        } else {
          file.geometry_only_markups++;
        }
        if (record.has_appearance) file.appearance_stream_markups++;
      }
    }
  }
  const groups = buildCompositeGroups(records);
  file.likely_composite_groups = groups.length;
  const textMarks = records.filter((r) => r.has_text && !!r.text_excerpt && !!r.box && isMarkupSubtype(r.subtype));
  return { file, samples: textMarks.slice(0, 30), groups, textMarks };
}

function sortedCountRows(counts: Record<string, number>): unknown[][] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => [k, v]);
}

function reportMarkdown(report: CorpusInventoryReport): string {
  const fileRows = report.files.map((f) => [
    f.file,
    f.pages,
    f.scanned_pages,
    f.markup_annotations,
    f.text_bearing_markups,
    f.geometry_only_markups,
    f.likely_composite_groups,
    Object.entries(f.by_color_family).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}:${v}`).join(", ")
  ]);
  return [
    "# Redline Corpus Inventory",
    "",
    `Source: ${report.source_dir}`,
    `Generated: ${report.generated_at}`,
    "",
    "## Summary",
    "",
    markdownTable(["metric", "value"], [
      ["files", report.input_count],
      ["pages", report.total_pages],
      ["scanned_pages", report.scanned_pages],
      ["annotations", report.annotations],
      ["markup_annotations", report.markup_annotations],
      ["text_bearing_markups", report.text_bearing_markups],
      ["geometry_only_markups", report.geometry_only_markups],
      ["appearance_stream_markups", report.appearance_stream_markups],
      ["likely_composite_groups", report.likely_composite_groups]
    ]),
    "",
    "## Color Families",
    "",
    markdownTable(["color_family", "count"], sortedCountRows(report.by_color_family)),
    "",
    "## Annotation Subtypes",
    "",
    markdownTable(["subtype", "count"], sortedCountRows(report.by_subtype).slice(0, 30)),
    "",
    "## Composite Group Classification",
    "",
    markdownTable(["metric", "value"], [
      ["group_count", report.group_classification.group_count],
      ["manual_review_count", report.group_classification.manual_review_count]
    ]),
    "",
    markdownTable(["operation", "count"], sortedCountRows(report.group_classification.by_operation).slice(0, 20)),
    "",
    markdownTable(["target", "count"], sortedCountRows(report.group_classification.by_target).slice(0, 20)),
    "",
    "## Group Review Queue",
    "",
    markdownTable(["bucket", "count"], sortedCountRows(report.review_queue.by_bucket)),
    "",
    "## Mark Review Queue",
    "",
    markdownTable(["metric", "value"], [
      ["mark_count", report.mark_review_queue.count]
    ]),
    "",
    markdownTable(["bucket", "count"], sortedCountRows(report.mark_review_queue.by_bucket)),
    "",
    "Detailed queue artifacts:",
    "",
    "- `redline_corpus_group_review_queue.csv`: ranked group rows with blank manual labeling columns.",
    "- `redline_corpus_group_review_queue.md`: top candidates by bucket and labeling rules.",
    "- `redline_corpus_mark_review_queue.csv`: finer-grained text-mark rows for mark-by-mark review.",
    "- `redline_corpus_mark_review_queue.md`: understood action summaries and top mark examples.",
    "",
    "## Files",
    "",
    markdownTable(["file", "pages", "scanned", "markups", "text", "geometry_only", "composite_groups", "top_colors"], fileRows),
    "",
    "## Notes",
    "",
    "- Green/blue/orange marks are preserved in this raw inventory; downstream visual normalization should operate on generated copies only.",
    "- Many PDF annotations include appearance streams. Updating `/C` metadata alone may not change rendered visual color until the appearance stream is regenerated or rewritten.",
    "- Geometry-only and clustered marks should be reviewed as composite visual regions, not isolated text comments."
  ].join("\n");
}

async function main(): Promise<void> {
  if (!process.argv.includes("--verbose")) suppressNoisyPdfWarnings();
  const sourceArg = flagValue(process.argv, "--source");
  if (!sourceArg) {
    console.error("Usage: npm run redline:inventory-corpus -- --source <pdf-folder> [--output <folder>] [--max-pages <n>]");
    process.exit(2);
  }
  const sourceDir = path.resolve(sourceArg);
  const outputDir = path.resolve(flagValue(process.argv, "--output") ?? path.join(repoRoot(), "local-work", "redline-corpus-inventory"));
  const maxPages = numberFlag(process.argv, "--max-pages");
  await ensureDir(outputDir);
  const files = (await fs.promises.readdir(sourceDir))
    .filter((name) => /\.pdf$/i.test(name))
    .map((name) => path.join(sourceDir, name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  const report: CorpusInventoryReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_dir: sourceDir,
    input_count: files.length,
    scanned_file_count: 0,
    total_bytes: 0,
    total_pages: 0,
    scanned_pages: 0,
    annotations: 0,
    markup_annotations: 0,
    text_bearing_markups: 0,
    geometry_only_markups: 0,
    appearance_stream_markups: 0,
    likely_composite_groups: 0,
    by_color_family: {},
    by_subtype: {},
    group_classification: {
      group_count: 0,
      by_operation: {},
      by_target: {},
      manual_review_count: 0
    },
    review_queue: {
      count: 0,
      by_bucket: {}
    },
    mark_review_queue: {
      count: 0,
      by_bucket: {},
      by_operation: {},
      by_target: {}
    },
    files: [],
    groups: [],
    text_marks: [],
    mark_review_items: [],
    samples: []
  };

  for (const filePath of files) {
    const item = await inventoryPdf(filePath, sourceDir, maxPages);
    report.files.push(item.file);
    report.samples.push(...item.samples);
    report.groups.push(...item.groups);
    report.text_marks.push(...item.textMarks);
    report.scanned_file_count++;
    report.total_bytes += item.file.bytes;
    report.total_pages += item.file.pages;
    report.scanned_pages += item.file.scanned_pages;
    report.annotations += item.file.annotations;
    report.markup_annotations += item.file.markup_annotations;
    report.text_bearing_markups += item.file.text_bearing_markups;
    report.geometry_only_markups += item.file.geometry_only_markups;
    report.appearance_stream_markups += item.file.appearance_stream_markups;
    report.likely_composite_groups += item.file.likely_composite_groups;
    for (const [key, count] of Object.entries(item.file.by_color_family)) addCount(report.by_color_family, key, count);
    for (const [key, count] of Object.entries(item.file.by_subtype)) addCount(report.by_subtype, key, count);
    for (const group of item.groups) {
      addCount(report.group_classification.by_operation, group.operation_class);
      addCount(report.group_classification.by_target, group.target_class);
      if (group.manual_review_reason) report.group_classification.manual_review_count++;
    }
  }
  report.group_classification.group_count = report.groups.length;
  const reviewQueue = buildReviewQueue(report.groups);
  report.review_queue.count = reviewQueue.length;
  for (const item of reviewQueue) addCount(report.review_queue.by_bucket, item.bucket);
  const markReviewQueue = buildMarkReviewQueue(report.text_marks);
  report.mark_review_items = markReviewQueue;
  report.mark_review_queue.count = markReviewQueue.length;
  for (const item of markReviewQueue) {
    addCount(report.mark_review_queue.by_bucket, item.bucket);
    addCount(report.mark_review_queue.by_operation, item.operation_class);
    addCount(report.mark_review_queue.by_target, item.target_class);
  }

  const jsonPath = path.join(outputDir, "redline_corpus_inventory.json");
  const csvPath = path.join(outputDir, "redline_corpus_inventory_files.csv");
  const sampleCsvPath = path.join(outputDir, "redline_corpus_inventory_samples.csv");
  const groupCsvPath = path.join(outputDir, "redline_corpus_inventory_groups.csv");
  const reviewQueueCsvPath = path.join(outputDir, "redline_corpus_group_review_queue.csv");
  const reviewQueueMarkdownPath = path.join(outputDir, "redline_corpus_group_review_queue.md");
  const markReviewQueueCsvPath = path.join(outputDir, "redline_corpus_mark_review_queue.csv");
  const markReviewQueueMarkdownPath = path.join(outputDir, "redline_corpus_mark_review_queue.md");
  const markdownPath = path.join(outputDir, "redline_corpus_inventory.md");
  await writeJsonFile(jsonPath, report);
  await writeTextFile(csvPath, [
    ["file", "bytes", "pages", "scanned_pages", "annotations", "markup_annotations", "text_bearing_markups", "geometry_only_markups", "appearance_stream_markups", "likely_composite_groups", "by_color_family", "by_subtype"].join(","),
    ...report.files.map((f) => [
      f.file,
      f.bytes,
      f.pages,
      f.scanned_pages,
      f.annotations,
      f.markup_annotations,
      f.text_bearing_markups,
      f.geometry_only_markups,
      f.appearance_stream_markups,
      f.likely_composite_groups,
      JSON.stringify(f.by_color_family),
      JSON.stringify(f.by_subtype)
    ].map(csvCell).join(","))
  ].join("\n"));
  await writeTextFile(sampleCsvPath, [
    ["file", "page", "index", "subtype", "color", "color_family", "author", "subject", "state", "state_model", "has_appearance", "text_excerpt"].join(","),
    ...report.samples.slice(0, 500).map((s) => [
      s.file,
      s.page,
      s.index,
      s.subtype,
      s.color,
      s.color_family,
      s.author ?? "",
      s.subject ?? "",
      s.state ?? "",
      s.state_model ?? "",
      s.has_appearance,
      s.text_excerpt ?? ""
    ].map(csvCell).join(","))
  ].join("\n"));
  await writeTextFile(groupCsvPath, [
    ["file", "page", "group_index", "page_width", "page_height", "box_min_x", "box_min_y", "box_max_x", "box_max_y", "annotation_indices", "mark_count", "text_mark_count", "geometry_only_count", "colors", "subtypes", "operation_class", "target_class", "context_class", "confidence", "manual_review_reason", "text_excerpt"].join(","),
    ...report.groups.map((g) => [
      g.file,
      g.page,
      g.group_index,
      g.page_width ?? "",
      g.page_height ?? "",
      g.box?.minX ?? "",
      g.box?.minY ?? "",
      g.box?.maxX ?? "",
      g.box?.maxY ?? "",
      g.annotation_indices.join("|"),
      g.mark_count,
      g.text_mark_count,
      g.geometry_only_count,
      g.colors.join("|"),
      g.subtypes.join("|"),
      g.operation_class,
      g.target_class,
      g.context_class,
      g.confidence,
      g.manual_review_reason ?? "",
      g.text_excerpt
    ].map(csvCell).join(","))
  ].join("\n"));
  await writeTextFile(reviewQueueCsvPath, [
    ["priority_rank", "bucket", "bucket_reason", "file", "page", "group_index", "page_width", "page_height", "box_min_x", "box_min_y", "box_max_x", "box_max_y", "annotation_indices", "mark_count", "text_mark_count", "geometry_only_count", "colors", "subtypes", "operation_class", "target_class", "context_class", "confidence", "manual_review_reason", "text_excerpt", "review_status", "review_operation", "review_target", "review_notes"].join(","),
    ...reviewQueue.map((g) => [
      g.priority_rank,
      g.bucket,
      g.bucket_reason,
      g.file,
      g.page,
      g.group_index,
      g.page_width ?? "",
      g.page_height ?? "",
      g.box?.minX ?? "",
      g.box?.minY ?? "",
      g.box?.maxX ?? "",
      g.box?.maxY ?? "",
      g.annotation_indices.join("|"),
      g.mark_count,
      g.text_mark_count,
      g.geometry_only_count,
      g.colors.join("|"),
      g.subtypes.join("|"),
      g.operation_class,
      g.target_class,
      g.context_class,
      g.confidence,
      g.manual_review_reason ?? "",
      g.text_excerpt,
      g.review_status,
      g.review_operation,
      g.review_target,
      g.review_notes
    ].map(csvCell).join(","))
  ].join("\n"));
  await writeTextFile(reviewQueueMarkdownPath, reviewQueueMarkdown(reviewQueue));
  await writeTextFile(markReviewQueueCsvPath, [
    ["priority_rank", "bucket", "bucket_reason", "file", "page", "index", "page_width", "page_height", "box_min_x", "box_min_y", "box_max_x", "box_max_y", "subtype", "color", "color_family", "operation_class", "target_class", "context_class", "confidence", "duplicate_count", "text_excerpt", "review_status", "review_operation", "review_target", "review_notes"].join(","),
    ...markReviewQueue.map((m) => [
      m.priority_rank,
      m.bucket,
      m.bucket_reason,
      m.file,
      m.page,
      m.index,
      m.page_width ?? "",
      m.page_height ?? "",
      m.box?.minX ?? "",
      m.box?.minY ?? "",
      m.box?.maxX ?? "",
      m.box?.maxY ?? "",
      m.subtype,
      m.color,
      m.color_family,
      m.operation_class,
      m.target_class,
      m.context_class,
      m.confidence,
      m.duplicate_count,
      m.text_excerpt,
      m.review_status,
      m.review_operation,
      m.review_target,
      m.review_notes
    ].map(csvCell).join(","))
  ].join("\n"));
  await writeTextFile(markReviewQueueMarkdownPath, markReviewMarkdown(markReviewQueue));
  await writeTextFile(markdownPath, reportMarkdown(report));

  console.log(JSON.stringify({
    ok: true,
    source_dir: sourceDir,
    output_dir: outputDir,
    input_count: report.input_count,
    pages: report.total_pages,
    scanned_pages: report.scanned_pages,
    annotations: report.annotations,
    markup_annotations: report.markup_annotations,
    by_color_family: report.by_color_family,
    text_bearing_markups: report.text_bearing_markups,
    geometry_only_markups: report.geometry_only_markups,
    likely_composite_groups: report.likely_composite_groups,
    group_classification: report.group_classification,
    review_queue: report.review_queue,
    mark_review_queue: report.mark_review_queue,
    json: jsonPath,
    csv: csvPath,
    sample_csv: sampleCsvPath,
    group_csv: groupCsvPath,
    review_queue_csv: reviewQueueCsvPath,
    review_queue_markdown: reviewQueueMarkdownPath,
    mark_review_queue_csv: markReviewQueueCsvPath,
    mark_review_queue_markdown: markReviewQueueMarkdownPath,
    markdown: markdownPath
  }, null, 2));
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await main();
}
