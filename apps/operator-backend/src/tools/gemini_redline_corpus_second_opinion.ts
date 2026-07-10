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

type CorpusInventoryReport = {
  source_dir: string;
  mark_review_items?: MarkReviewRecord[];
};

export type GeminiSecondOpinionItem = {
  id: string;
  actionable: boolean | "unclear";
  operation: string;
  target: string;
  requirements: string[];
  confidence: number;
  rationale: string;
  size_or_value?: string | null;
  visual_context_needed?: "none" | "tight" | "context" | "page";
};

type GeminiSecondOpinionResponse = {
  items: GeminiSecondOpinionItem[];
};

type OutputRecord = GeminiSecondOpinionItem & {
  schema_version: 1;
  generated_at: string;
  model: string;
  local: {
    file: string;
    page: number;
    mark_index: number;
    bucket: string;
    operation: string;
    target: string;
    confidence: number;
    text_excerpt: string;
  };
  disagreement: {
    operation: boolean;
    target: boolean;
    actionability: boolean;
  };
};

type RunSummary = {
  schema_version: 1;
  generated_at: string;
  inventory: string;
  output_dir: string;
  requested_bucket: string;
  requested_limit: number | null;
  batch_size: number;
  considered_count: number;
  skipped_existing_count: number;
  analyzed_count: number;
  model_counts: Record<string, number>;
  by_actionable: Record<string, number>;
  by_operation: Record<string, number>;
  by_target: Record<string, number>;
  disagreement_count: number;
  output_jsonl: string;
  output_csv: string;
};

const SECOND_OPINION_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          actionable: { enum: [true, false, "unclear"] },
          operation: {
            type: "string",
            enum: [
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
            ]
          },
          target: {
            type: "string",
            enum: [
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
            ]
          },
          requirements: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "model_write",
                "visual_gate",
                "connector_or_readback_audit",
                "native_readback",
                "post_change_capture",
                "cleanup",
                "manual_visual_region_review"
              ]
            }
          },
          confidence: { type: "number" },
          size_or_value: { type: "string" },
          visual_context_needed: { type: "string", enum: ["none", "tight", "context", "page"] },
          rationale: { type: "string" }
        },
        required: ["id", "actionable", "operation", "target", "requirements", "confidence", "visual_context_needed", "rationale"]
      }
    }
  },
  required: ["items"]
} as const;

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function numberFlag(argv: string[], name: string): number | undefined {
  const raw = flagValue(argv, name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return fallback;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function addCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function markId(mark: MarkReviewRecord): string {
  return `mark:${mark.file}:p${mark.page}:a${mark.index}`;
}

function normalizeToken(value: unknown, fallback = "unknown"): string {
  const s = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return s || fallback;
}

function normalizeActionable(value: unknown): boolean | "unclear" {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "actionable") return true;
  if (s === "false" || s === "no" || s === "not_actionable" || s === "no_action_required") return false;
  return "unclear";
}

function normalizeConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 0.5;
  if (n > 1 && n <= 100) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

function normalizeRequirements(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[;,]/)
      : [];
  return raw.map((x) => normalizeToken(x, "")).filter(Boolean).slice(0, 8);
}

function normalizeVisualContext(value: unknown): GeminiSecondOpinionItem["visual_context_needed"] {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "none" || s === "tight" || s === "context" || s === "page") return s;
  return "context";
}

function extractBalancedJsonObjects(text: string, maxObjects = 16): string[] {
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
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") inString = true;
      else if (ch === "{") depth++;
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

export function parseGeminiSecondOpinion(raw: string): GeminiSecondOpinionResponse {
  const candidates = [raw, ...extractBalancedJsonObjects(raw)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      if (items.length === 0) continue;
      return {
        items: items.map((item) => {
          const obj = item && typeof item === "object" ? item as Record<string, unknown> : {};
          return {
            id: String(obj.id ?? "").trim(),
            actionable: normalizeActionable(obj.actionable),
            operation: normalizeToken(obj.operation),
            target: normalizeToken(obj.target),
            requirements: normalizeRequirements(obj.requirements),
            confidence: normalizeConfidence(obj.confidence),
            rationale: String(obj.rationale ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
            size_or_value: typeof obj.size_or_value === "string" ? obj.size_or_value.trim().slice(0, 120) : null,
            visual_context_needed: normalizeVisualContext(obj.visual_context_needed)
          };
        }).filter((item) => item.id)
      };
    } catch {
      // Try the next extracted object.
    }
  }
  throw new Error("Gemini response did not contain a parseable { items: [...] } JSON object.");
}

export function buildGeminiSecondOpinionPrompt(items: Array<{ id: string; mark: MarkReviewRecord }>): string {
  const payload = items.map(({ id, mark }) => ({
    id,
    file: mark.file,
    page: mark.page,
    mark_index: mark.index,
    subtype: mark.subtype,
    color_family: mark.color_family,
    text: mark.text_excerpt,
    local_bucket: mark.bucket,
    local_operation: mark.operation_class,
    local_target: mark.target_class,
    local_reason: mark.bucket_reason
  }));
  return [
    "You are reviewing real engineering PDF redline markups for Revit model/document updates.",
    "Classify each mark independently as a second opinion over the local classifier.",
    "",
    "Important domain rules:",
    "- Do not treat lime green, blue, orange, or red color alone as actionability; team status workflows can recolor completed/open marks.",
    "- A duct/pipe size text mark such as 16x14, 16\"x14\", 26 dia, or 4\" CHW is usually actionable: the size/value is the requested model size. Nearby CFM/GPM may be calculation context.",
    "- A CFM/GPM value without an explicit modeled/documented change can be calculation/reference, but size plus flow usually means the size is the change.",
    "- Some actionable requests are composites, so mark-level classification may be uncertain. Use actionable=\"unclear\" when context is insufficient.",
    "- Set visual_context_needed to none only when the mark text alone is enough. Use tight for a single clear text mark, context when nearby geometry/text is needed, and page when sheet-wide relationships or grouping are needed.",
    "- Prefer conservative labels. Do not invent exact locations or dimensions absent from the mark text.",
    "",
    "Allowed operations: add, delete, move, reroute_offset, tap_branch, size_transition, type_change, graphics_override, text_edit, tag, route, rotate, calculation_reference, no_action_required, unknown.",
    "Allowed targets: duct, pipe, mep_accessory, receptacle, light, tag, text, sheet, schedule, view_filter, category_graphics, cad_link, viewport, unknown.",
    "Requirements may include: model_write, visual_gate, connector_or_readback_audit, native_readback, post_change_capture, cleanup, manual_visual_region_review.",
    "",
    "Return only JSON with this shape:",
    "{\"items\":[{\"id\":\"...\",\"actionable\":true,\"operation\":\"size_transition\",\"target\":\"duct\",\"requirements\":[\"model_write\",\"visual_gate\"],\"confidence\":0.82,\"size_or_value\":\"16x14\",\"visual_context_needed\":\"context\",\"rationale\":\"short reason\"}]}",
    "",
    "Marks:",
    JSON.stringify(payload)
  ].join("\n");
}

function geminiApiKey(): string {
  return (process.env.OPERATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "").trim();
}

function geminiModel(): string {
  return (process.env.OPERATOR_GEMINI_MODEL || "gemini-3.5-flash").trim();
}

function geminiModelCandidates(preferred: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (m: string | undefined) => {
    const s = (m ?? "").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  const prefNorm = preferred.toLowerCase();
  push(prefNorm === "gemini-3-flash" ? "gemini-3-flash-preview" : preferred);
  if (prefNorm.startsWith("gemini-3.5")) {
    push("gemini-3.5-flash");
    push("gemini-3-flash-preview");
  }
  if (prefNorm.startsWith("gemini-3")) {
    push("gemini-3-flash-preview");
    push("gemini-3-flash");
  }
  for (const fallback of (process.env.OPERATOR_GEMINI_MODEL_FALLBACKS || "").split(",")) push(fallback);
  if (prefNorm.startsWith("gemini-3")) push("gemini-2.5-flash");
  return out;
}

function geminiBaseUrl(): string {
  return (process.env.OPERATOR_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").trim().replace(/\/+$/, "");
}

function geminiTimeoutMs(): number {
  const n = Number.parseInt(process.env.OPERATOR_GEMINI_TIMEOUT_MS ?? "90000", 10);
  return Number.isFinite(n) ? clamp(n, 2_000, 180_000) : 90_000;
}

async function callGemini(prompt: string): Promise<{ model: string; parsed: GeminiSecondOpinionResponse }> {
  if (!parseBool(process.env.OPERATOR_GEMINI_VISION_ENABLED, true)) throw new Error("Gemini integration is disabled by OPERATOR_GEMINI_VISION_ENABLED.");
  const key = geminiApiKey();
  if (!key) throw new Error("Gemini API key is not configured. Set OPERATOR_GEMINI_API_KEY or GEMINI_API_KEY.");
  const timeoutMs = geminiTimeoutMs();
  let lastError: Error | null = null;
  for (const model of geminiModelCandidates(geminiModel())) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const endpoint = `${geminiBaseUrl()}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseFormat: {
              text: {
                mimeType: "APPLICATION_JSON",
                schema: SECOND_OPINION_RESPONSE_SCHEMA
              }
            }
          }
        })
      });
      const body = await response.text();
      if (!response.ok) {
        lastError = new Error(`Gemini ${model} HTTP ${response.status}: ${body.slice(0, 500)}`);
        if (response.status === 400 || response.status === 404) continue;
        throw lastError;
      }
      const api = JSON.parse(body) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = api.candidates?.flatMap((c) => c.content?.parts?.map((p) => p.text ?? "") ?? []).join("\n").trim() ?? "";
      if (!text) throw new Error(`Gemini ${model} returned no text content.`);
      return { model, parsed: parseGeminiSecondOpinion(text) };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("Gemini request failed.");
}

function readExistingIds(jsonlPath: string): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(jsonlPath)) return ids;
  for (const line of fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { id?: string };
      if (obj.id) ids.add(obj.id);
    } catch {
      // Ignore partial/corrupt lines; later summary output remains auditable.
    }
  }
  return ids;
}

function readExistingRecords(jsonlPath: string): OutputRecord[] {
  const records: OutputRecord[] = [];
  if (!fs.existsSync(jsonlPath)) return records;
  for (const line of fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as OutputRecord;
      if (obj.id && obj.local) records.push(obj);
    } catch {
      // Ignore partial/corrupt lines; resume will fill missing ids.
    }
  }
  return records;
}

function buildOutputRecord(model: string, mark: MarkReviewRecord, item: GeminiSecondOpinionItem): OutputRecord {
  const localActionable = mark.bucket !== "calculation_or_reference_mark" && mark.bucket !== "manual_review_mark";
  const operationDisagreement = item.operation !== "unknown" && item.operation !== normalizeToken(mark.operation_class);
  const targetDisagreement = item.target !== "unknown" && item.target !== normalizeToken(mark.target_class);
  const actionabilityDisagreement = item.actionable !== "unclear" && item.actionable !== localActionable;
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    model,
    ...item,
    local: {
      file: mark.file,
      page: mark.page,
      mark_index: mark.index,
      bucket: mark.bucket,
      operation: mark.operation_class,
      target: mark.target_class,
      confidence: mark.confidence,
      text_excerpt: mark.text_excerpt
    },
    disagreement: {
      operation: operationDisagreement,
      target: targetDisagreement,
      actionability: actionabilityDisagreement
    }
  };
}

function writeCsv(csvPath: string, records: OutputRecord[]): void {
  const rows = [
    ["id", "file", "page", "mark_index", "local_bucket", "local_operation", "local_target", "gemini_actionable", "gemini_operation", "gemini_target", "gemini_confidence", "size_or_value", "visual_context_needed", "requirements", "disagree_operation", "disagree_target", "disagree_actionability", "text_excerpt", "rationale"],
    ...records.map((r) => [
      r.id,
      r.local.file,
      r.local.page,
      r.local.mark_index,
      r.local.bucket,
      r.local.operation,
      r.local.target,
      r.actionable,
      r.operation,
      r.target,
      r.confidence,
      r.size_or_value ?? "",
      r.visual_context_needed ?? "context",
      r.requirements.join(";"),
      r.disagreement.operation,
      r.disagreement.target,
      r.disagreement.actionability,
      r.local.text_excerpt,
      r.rationale
    ])
  ];
  writeTextFile(csvPath, rows.map((row) => row.map(csvCell).join(",")).join("\n"));
}

async function analyzeBatch(batch: Array<{ id: string; mark: MarkReviewRecord }>, jsonlPath: string): Promise<OutputRecord[]> {
  try {
    const { model, parsed } = await callGemini(buildGeminiSecondOpinionPrompt(batch));
    const byId = new Map(parsed.items.map((item) => [item.id, item]));
    const records = batch.map(({ id, mark }) => buildOutputRecord(model, mark, byId.get(id) ?? {
      id,
      actionable: "unclear" as const,
      operation: "unknown",
      target: "unknown",
      requirements: ["manual_visual_region_review"],
      confidence: 0.1,
      rationale: "Gemini did not return this mark id.",
      size_or_value: null,
      visual_context_needed: "context" as const
    }));
    fs.appendFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return records;
  } catch (error) {
    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      const left = await analyzeBatch(batch.slice(0, mid), jsonlPath);
      const right = await analyzeBatch(batch.slice(mid), jsonlPath);
      return [...left, ...right];
    }
    const { id, mark } = batch[0] as { id: string; mark: MarkReviewRecord };
    const record = buildOutputRecord("gemini_error", mark, {
      id,
      actionable: "unclear",
      operation: "unknown",
      target: "unknown",
      requirements: ["manual_visual_region_review"],
      confidence: 0,
      rationale: `Gemini batch failed: ${error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)}`,
      size_or_value: null,
      visual_context_needed: "page"
    });
    fs.appendFileSync(jsonlPath, JSON.stringify(record) + "\n", "utf8");
    return [record];
  }
}

function summarize(args: {
  inventoryPath: string;
  outputDir: string;
  requestedBucket: string;
  requestedLimit: number | null;
  batchSize: number;
  consideredCount: number;
  skippedExistingCount: number;
  records: OutputRecord[];
  jsonlPath: string;
  csvPath: string;
}): RunSummary {
  const summary: RunSummary = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    inventory: args.inventoryPath,
    output_dir: args.outputDir,
    requested_bucket: args.requestedBucket,
    requested_limit: args.requestedLimit,
    batch_size: args.batchSize,
    considered_count: args.consideredCount,
    skipped_existing_count: args.skippedExistingCount,
    analyzed_count: args.records.length,
    model_counts: {},
    by_actionable: {},
    by_operation: {},
    by_target: {},
    disagreement_count: 0,
    output_jsonl: args.jsonlPath,
    output_csv: args.csvPath
  };
  for (const r of args.records) {
    addCount(summary.model_counts, r.model);
    addCount(summary.by_actionable, String(r.actionable));
    addCount(summary.by_operation, r.operation);
    addCount(summary.by_target, r.target);
    if (r.disagreement.operation || r.disagreement.target || r.disagreement.actionability) summary.disagreement_count++;
  }
  return summary;
}

async function main(): Promise<void> {
  const inventoryArg = flagValue(process.argv, "--inventory");
  if (!inventoryArg) {
    console.error("Usage: npm run redline:gemini-corpus -- --inventory <redline_corpus_inventory.json> [--output <folder>] [--bucket manual_review_mark] [--limit 400] [--batch-size 40] [--resume]");
    process.exit(2);
  }
  const inventoryPath = path.resolve(inventoryArg);
  const outputDir = path.resolve(flagValue(process.argv, "--output") ?? path.join(repoRoot(), "local-work", "redline-corpus", "gemini-second-opinion"));
  const bucket = flagValue(process.argv, "--bucket") ?? "";
  const limit = numberFlag(process.argv, "--limit");
  const batchSize = clamp(numberFlag(process.argv, "--batch-size") ?? 40, 1, 80);
  const resume = process.argv.includes("--resume");
  const dryRun = process.argv.includes("--dry-run");
  const report = JSON.parse(fs.readFileSync(inventoryPath, "utf8")) as CorpusInventoryReport;
  const marks = (report.mark_review_items ?? [])
    .filter((mark) => !bucket || mark.bucket === bucket)
    .slice(0, limit ?? undefined);
  ensureDir(outputDir);

  const jsonlPath = path.join(outputDir, "gemini_redline_second_opinion.jsonl");
  const csvPath = path.join(outputDir, "gemini_redline_second_opinion.csv");
  const summaryPath = path.join(outputDir, "gemini_redline_second_opinion_summary.json");
  const existing = resume ? readExistingIds(jsonlPath) : new Set<string>();
  const queue = marks.map((mark) => ({ id: markId(mark), mark })).filter((item) => !existing.has(item.id));

  if (dryRun) {
    const summary = summarize({
      inventoryPath,
      outputDir,
      requestedBucket: bucket,
      requestedLimit: limit ?? null,
      batchSize,
      consideredCount: marks.length,
      skippedExistingCount: marks.length - queue.length,
      records: [],
      jsonlPath,
      csvPath
    });
    writeJsonFile(summaryPath, summary);
    console.log(`Dry run: ${queue.length}/${marks.length} marks would be sent to Gemini in ${Math.ceil(queue.length / batchSize)} batch(es).`);
    return;
  }

  const records: OutputRecord[] = resume ? readExistingRecords(jsonlPath) : [];
  if (!resume && fs.existsSync(jsonlPath)) fs.rmSync(jsonlPath);
  for (let offset = 0; offset < queue.length; offset += batchSize) {
    const batch = queue.slice(offset, offset + batchSize);
    const batchRecords = await analyzeBatch(batch, jsonlPath);
    records.push(...batchRecords);
    console.log(`Gemini corpus second opinion: ${Math.min(offset + batch.length, queue.length)}/${queue.length} analyzed this run, ${records.length}/${marks.length} total.`);
  }

  writeCsv(csvPath, records);
  const summary = summarize({
    inventoryPath,
    outputDir,
    requestedBucket: bucket,
    requestedLimit: limit ?? null,
    batchSize,
    consideredCount: marks.length,
    skippedExistingCount: marks.length - queue.length,
    records,
    jsonlPath,
    csvPath
  });
  writeJsonFile(summaryPath, summary);
  writeTextFile(path.join(outputDir, "gemini_redline_second_opinion_summary.md"), [
    "# Gemini Redline Corpus Second Opinion",
    "",
    `Generated: ${summary.generated_at}`,
    `Inventory: ${summary.inventory}`,
    `Analyzed: ${summary.analyzed_count}`,
    `Skipped existing: ${summary.skipped_existing_count}`,
    `Disagreements: ${summary.disagreement_count}`,
    "",
    "## Operations",
    ...Object.entries(summary.by_operation).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Targets",
    ...Object.entries(summary.by_target).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`)
  ].join("\n"));
  console.log(`Gemini corpus second opinion complete: ${summary.analyzed_count} mark(s).`);
  console.log(`Summary: ${summaryPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
