import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout, resolveExistingFileUnderWorkspace } from "../workspace.js";
import { extractFloorPlanWithGemini } from "./gemini_floorplan_extract.js";

export type ZippyBimToolConfig = {
  configured: boolean;
  base_url: string | null;
  request_timeout_ms: number;
  default_scale_ratio: number;
  door_import_beta_enabled: boolean;
};

export type ZippyBimExtractor = "zippybim" | "gemini";

export type ZippyBimPdfSource = {
  relative_path: string;
  filename: string;
  bytes: number;
  modified_at: string;
  source: "uploads" | "prints";
};

export type ZippyBimGeometryMetadata = {
  source?: string;
  units?: string;
  scale?: number;
  notes?: string;
  origin?: number[];
  bounds?: number[];
  sheet_width?: number;
  sheet_height?: number;
  raster_image?: string;
  raster_dpi?: number;
  raster_pixel_width?: number;
  raster_pixel_height?: number;
  policy_tag?: string;
  extractor?: ZippyBimExtractor;
  preview_relative_path?: string;
};

export type ZippyBimWallElement = {
  id: string;
  element: "wall";
  path: [[number, number], [number, number]];
  thickness?: number;
  height?: number;
};

export type ZippyBimDoorElement = {
  id: string;
  element: "door";
  position: [number, number];
  width?: number;
  height?: number;
};

export type ZippyBimRawSegmentElement = {
  id: string;
  element: "raw_segment";
  path: [[number, number], [number, number]];
};

export type ZippyBimGeometryElement = ZippyBimWallElement | ZippyBimDoorElement | ZippyBimRawSegmentElement;

export type ZippyBimGeometryDocument = {
  metadata: ZippyBimGeometryMetadata;
  elements: ZippyBimGeometryElement[];
  debug?: unknown;
};

export type ZippyBimJobSummary = {
  wall_count: number;
  door_count: number;
  raw_segment_count: number;
  warnings: string[];
};

export type ZippyBimJobResult = {
  source_relative_path: string;
  source_filename: string;
  created_at: string;
  geometry: ZippyBimGeometryDocument;
  summary: ZippyBimJobSummary;
};

export type ZippyBimJobParams = {
  relative_path: string;
  extractor: ZippyBimExtractor;
  scale_ratio: number;
  crop_min_x: number;
  crop_min_y: number;
  crop_max_y: number;
  detect_doors: boolean;
};

export type ZippyBimJobStatus = "queued" | "running" | "succeeded" | "failed";

export type ZippyBimJobRecord = {
  id: string;
  status: ZippyBimJobStatus;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  source_relative_path: string;
  source_filename: string;
  params: ZippyBimJobParams;
  summary?: ZippyBimJobSummary | null;
  error?: string | null;
};

export type CreateZippyBimJobInput = {
  relative_path: string;
  extractor?: ZippyBimExtractor;
  scale_ratio?: number;
  crop_min_x?: number;
  crop_min_y?: number;
  crop_max_y?: number;
  detect_doors?: boolean;
};

type RawPointPair = [[number, number], [number, number]];

const runningJobs = new Map<string, Promise<void>>();

function nowIso(): string {
  return new Date().toISOString();
}

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max);
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeRelativePath(raw: unknown): string {
  const trimmed = typeof raw === "string" ? raw.trim().replace(/\\/g, "/").replace(/^\/+/, "") : "";
  if (!trimmed) throw new Error("relative_path is required.");
  return trimmed;
}

function normalizeExtractor(raw: unknown): ZippyBimExtractor {
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return normalized === "gemini" ? "gemini" : "zippybim";
}

function readConfig(): ZippyBimToolConfig {
  const base_url = clip(process.env.OPERATOR_ZIPPYBIM_BASE_URL, 500) || null;
  const timeoutRaw = Number.parseInt(process.env.OPERATOR_ZIPPYBIM_TIMEOUT_MS ?? "", 10);
  const request_timeout_ms = Number.isFinite(timeoutRaw) ? Math.max(10_000, Math.min(30 * 60_000, timeoutRaw)) : 10 * 60_000;
  const scaleRaw = Number.parseFloat(process.env.OPERATOR_ZIPPYBIM_DEFAULT_SCALE_RATIO ?? "");
  const default_scale_ratio = Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 0.010416666;
  const door_import_beta_enabled = asBoolean(process.env.OPERATOR_ZIPPYBIM_ENABLE_DOOR_IMPORT ?? "", false);
  return {
    configured: !!base_url,
    base_url,
    request_timeout_ms,
    default_scale_ratio,
    door_import_beta_enabled
  };
}

export function getZippyBimConfig(): ZippyBimToolConfig {
  return readConfig();
}

function getGeminiAvailability(): { enabled: boolean; key_configured: boolean; available: boolean; error?: string } {
  const enabled = asBoolean(process.env.OPERATOR_GEMINI_VISION_ENABLED ?? "", true);
  const key_configured = !!clip(process.env.OPERATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY, 400);
  return {
    enabled,
    key_configured,
    available: enabled && key_configured,
    ...(!enabled ? { error: "Gemini vision integration is disabled." } : !key_configured ? { error: "Gemini API key is missing." } : {})
  };
}

function jobsRoot(): string {
  const root = path.join(ensureWorkspaceLayout().artifacts, "zippybim", "jobs");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function jobDir(jobId: string): string {
  return path.join(jobsRoot(), jobId);
}

function jobRecordPath(jobId: string): string {
  return path.join(jobDir(jobId), "job.json");
}

function jobResultPath(jobId: string): string {
  return path.join(jobDir(jobId), "result.json");
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function sanitizeJobRecord(raw: unknown): ZippyBimJobRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const job = raw as Partial<ZippyBimJobRecord>;
  const id = clip(job.id, 80);
  const statusRaw = clip(job.status, 40).toLowerCase();
  const status: ZippyBimJobStatus =
    statusRaw === "running" || statusRaw === "succeeded" || statusRaw === "failed" ? (statusRaw as ZippyBimJobStatus) : "queued";
  const source_relative_path = clip(job.source_relative_path, 500);
  const source_filename = clip(job.source_filename, 260);
  if (!id || !source_relative_path || !source_filename) return null;

  const paramsRaw = job.params ?? ({} as Partial<ZippyBimJobParams>);
  const params: ZippyBimJobParams = {
    relative_path: source_relative_path,
    extractor: normalizeExtractor((paramsRaw as Partial<ZippyBimJobParams>).extractor),
    scale_ratio: asNumber((paramsRaw as Partial<ZippyBimJobParams>).scale_ratio, readConfig().default_scale_ratio),
    crop_min_x: asNumber((paramsRaw as Partial<ZippyBimJobParams>).crop_min_x, 0),
    crop_min_y: asNumber((paramsRaw as Partial<ZippyBimJobParams>).crop_min_y, 0),
    crop_max_y: asNumber((paramsRaw as Partial<ZippyBimJobParams>).crop_max_y, 100),
    detect_doors: asBoolean((paramsRaw as Partial<ZippyBimJobParams>).detect_doors, false)
  };

  return {
    id,
    status,
    created_at: clip(job.created_at, 80) || nowIso(),
    updated_at: clip(job.updated_at, 80) || nowIso(),
    started_at: clip(job.started_at, 80) || null,
    finished_at: clip(job.finished_at, 80) || null,
    source_relative_path,
    source_filename,
    params,
    summary: job.summary ?? null,
    error: clip(job.error, 2000) || null
  };
}

function readJob(jobId: string): ZippyBimJobRecord | null {
  return sanitizeJobRecord(readJsonFile(jobRecordPath(jobId)));
}

function saveJob(job: ZippyBimJobRecord): void {
  writeJsonFile(jobRecordPath(job.id), job);
}

export function listZippyBimJobs(limit = 20): ZippyBimJobRecord[] {
  const root = jobsRoot();
  const dirs = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : [];
  const items = dirs
    .map(dir => readJob(dir))
    .filter((job): job is ZippyBimJobRecord => !!job)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, Math.max(1, Math.min(limit, 100)));
  return items;
}

export function getZippyBimJob(jobId: string): ZippyBimJobRecord | null {
  return readJob(clip(jobId, 120));
}

export function getZippyBimJobResult(jobId: string): ZippyBimJobResult | null {
  const id = clip(jobId, 120);
  if (!id) return null;
  return readJsonFile<ZippyBimJobResult>(jobResultPath(id));
}

function walkPdfFiles(rootDir: string, source: ZippyBimPdfSource["source"], out: ZippyBimPdfSource[], workspaceRoot: string): void {
  if (!fs.existsSync(rootDir)) return;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkPdfFiles(full, source, out, workspaceRoot);
      continue;
    }
    if (path.extname(entry.name).toLowerCase() !== ".pdf") continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const relative_path = path.relative(workspaceRoot, full).replace(/\\/g, "/");
    out.push({
      relative_path,
      filename: path.basename(full),
      bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
      source
    });
  }
}

export function listZippyBimPdfSources(limit = 30): ZippyBimPdfSource[] {
  const ws = ensureWorkspaceLayout();
  const items: ZippyBimPdfSource[] = [];
  walkPdfFiles(path.join(ws.artifacts, "uploads"), "uploads", items, ws.root);
  walkPdfFiles(path.join(ws.artifacts, "prints"), "prints", items, ws.root);

  const deduped = new Map<string, ZippyBimPdfSource>();
  for (const item of items) {
    const existing = deduped.get(item.relative_path.toLowerCase());
    if (!existing || existing.modified_at < item.modified_at) {
      deduped.set(item.relative_path.toLowerCase(), item);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at))
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

function makeAbortSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export async function getZippyBimHealth(): Promise<Record<string, unknown>> {
  const config = readConfig();
  const gemini = getGeminiAvailability();
  const remoteBase = {
    configured: !!config.base_url,
    base_url: config.base_url,
    request_timeout_ms: config.request_timeout_ms,
    default_scale_ratio: config.default_scale_ratio,
    door_import_beta_enabled: config.door_import_beta_enabled
  };
  if (!config.base_url) {
    return {
      ok: gemini.available,
      configured: gemini.available,
      base_url: null,
      request_timeout_ms: config.request_timeout_ms,
      default_scale_ratio: config.default_scale_ratio,
      door_import_beta_enabled: config.door_import_beta_enabled,
      remote: {
        ok: false,
        ...remoteBase,
        error: "OPERATOR_ZIPPYBIM_BASE_URL is not configured."
      },
      gemini,
      extractors: [
        { id: "zippybim", label: "ZippyBIM Remote", available: false, ok: false, error: "OPERATOR_ZIPPYBIM_BASE_URL is not configured." },
        { id: "gemini", label: "Gemini Vision (Experimental)", available: gemini.available, ok: gemini.available, ...(gemini.error ? { error: gemini.error } : {}) }
      ],
      error: gemini.available ? null : "No floor plan extractor is currently available."
    };
  }

  try {
    const response = await fetch(new URL("/health", config.base_url), {
      method: "GET",
      signal: makeAbortSignal(Math.min(config.request_timeout_ms, 15_000))
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ok: response.ok || gemini.available,
      configured: true,
      base_url: config.base_url,
      request_timeout_ms: config.request_timeout_ms,
      default_scale_ratio: config.default_scale_ratio,
      door_import_beta_enabled: config.door_import_beta_enabled,
      remote: {
        ok: response.ok,
        ...remoteBase,
        remote: payload
      },
      gemini,
      extractors: [
        { id: "zippybim", label: "ZippyBIM Remote", available: true, ok: response.ok, ...(response.ok ? {} : { error: clip((payload as any)?.error, 300) || `ZippyBIM health request failed (${response.status}).` }) },
        { id: "gemini", label: "Gemini Vision (Experimental)", available: gemini.available, ok: gemini.available, ...(gemini.error ? { error: gemini.error } : {}) }
      ]
    };
  } catch (error) {
    return {
      ok: gemini.available,
      configured: true,
      base_url: config.base_url,
      request_timeout_ms: config.request_timeout_ms,
      default_scale_ratio: config.default_scale_ratio,
      door_import_beta_enabled: config.door_import_beta_enabled,
      remote: {
        ok: false,
        ...remoteBase,
        error: error instanceof Error ? error.message : String(error)
      },
      gemini,
      extractors: [
        { id: "zippybim", label: "ZippyBIM Remote", available: true, ok: false, error: error instanceof Error ? error.message : String(error) },
        { id: "gemini", label: "Gemini Vision (Experimental)", available: gemini.available, ok: gemini.available, ...(gemini.error ? { error: gemini.error } : {}) }
      ],
      error: gemini.available ? null : (error instanceof Error ? error.message : String(error))
    };
  }
}

function normalizePointPair(value: unknown): RawPointPair | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const a = value[0];
  const b = value[1];
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) return null;
  const ax = Number(a[0]);
  const ay = Number(a[1]);
  const bx = Number(b[0]);
  const by = Number(b[1]);
  if (![ax, ay, bx, by].every(Number.isFinite)) return null;
  return [
    [ax, ay],
    [bx, by]
  ];
}

function normalizePosition(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (![x, y].every(Number.isFinite)) return null;
  return [x, y];
}

function collectWarnings(raw: any, summary: ZippyBimJobSummary): string[] {
  const warnings: string[] = [];
  if (summary.wall_count === 0) warnings.push("Prediction returned no wall segments.");

  const maybeDoorReason = clip(raw?.debug?.door_detection_unavailable_reason, 300);
  if (maybeDoorReason) warnings.push(maybeDoorReason);

  const maybeNotes = raw?.log?.notes;
  if (Array.isArray(maybeNotes)) {
    for (const note of maybeNotes) {
      const text = clip(note, 300);
      if (text && !warnings.includes(text)) warnings.push(text);
      if (warnings.length >= 8) break;
    }
  }

  return warnings.slice(0, 8);
}

export function normalizeZippyBimPrediction(raw: unknown, sourceRelativePath: string, sourceFilename: string): ZippyBimJobResult {
  const doc = raw && typeof raw === "object" ? (raw as any) : {};
  const metaRaw = doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {};
  const elementsRaw = Array.isArray(doc.elements) ? doc.elements : [];
  const elements: ZippyBimGeometryElement[] = [];
  let wall_count = 0;
  let door_count = 0;
  let raw_segment_count = 0;

  for (const item of elementsRaw) {
    if (!item || typeof item !== "object") continue;
    const elementType = clip((item as any).element, 40).toLowerCase();
    if (elementType === "wall") {
      const pathPair = normalizePointPair((item as any).path);
      if (!pathPair) continue;
      wall_count++;
      elements.push({
        id: clip((item as any).id, 80) || `wall_${wall_count}`,
        element: "wall",
        path: pathPair,
        thickness: isFiniteNumber((item as any).thickness) ? (item as any).thickness : undefined,
        height: isFiniteNumber((item as any).height) ? (item as any).height : undefined
      });
      continue;
    }

    if (elementType === "door") {
      const position = normalizePosition((item as any).position);
      if (!position) continue;
      door_count++;
      elements.push({
        id: clip((item as any).id, 80) || `door_${door_count}`,
        element: "door",
        position,
        width: isFiniteNumber((item as any).width) ? (item as any).width : undefined,
        height: isFiniteNumber((item as any).height) ? (item as any).height : undefined
      });
      continue;
    }

    if (elementType === "raw_segment") {
      const pathPair = normalizePointPair((item as any).path);
      if (!pathPair) continue;
      raw_segment_count++;
      elements.push({
        id: clip((item as any).id, 80) || `segment_${raw_segment_count}`,
        element: "raw_segment",
        path: pathPair
      });
    }
  }

  const summary: ZippyBimJobSummary = {
    wall_count,
    door_count,
    raw_segment_count,
    warnings: []
  };
  summary.warnings = collectWarnings(doc, summary);

  const metadata: ZippyBimGeometryMetadata = {
    source: clip(metaRaw.source, 200) || "ZippyBIM",
    units: clip(metaRaw.units, 40) || "feet",
    scale: isFiniteNumber(metaRaw.scale) ? metaRaw.scale : 1,
    notes: clip(metaRaw.notes, 1000) || undefined,
    origin: Array.isArray(metaRaw.origin) ? metaRaw.origin.map((v: unknown) => Number(v)).filter(Number.isFinite) : undefined,
    bounds: Array.isArray(metaRaw.bounds) ? metaRaw.bounds.map((v: unknown) => Number(v)).filter(Number.isFinite) : undefined,
    sheet_width: isFiniteNumber(metaRaw.sheet_width) ? metaRaw.sheet_width : undefined,
    sheet_height: isFiniteNumber(metaRaw.sheet_height) ? metaRaw.sheet_height : undefined,
    raster_image: clip(metaRaw.raster_image, 8_000_000) || undefined,
    raster_dpi: isFiniteNumber(metaRaw.raster_dpi) ? metaRaw.raster_dpi : undefined,
    raster_pixel_width: isFiniteNumber(metaRaw.raster_pixel_width) ? metaRaw.raster_pixel_width : undefined,
    raster_pixel_height: isFiniteNumber(metaRaw.raster_pixel_height) ? metaRaw.raster_pixel_height : undefined,
    policy_tag: clip(metaRaw.policy_tag, 120) || undefined
  };

  return {
    source_relative_path: sourceRelativePath,
    source_filename: sourceFilename,
    created_at: nowIso(),
    geometry: {
      metadata,
      elements,
      debug: doc.debug ?? undefined
    },
    summary
  };
}

async function callRemotePrediction(job: ZippyBimJobRecord): Promise<ZippyBimJobResult> {
  const config = readConfig();
  if (!config.base_url) throw new Error("OPERATOR_ZIPPYBIM_BASE_URL is not configured.");

  const fullPath = resolveExistingFileUnderWorkspace(job.source_relative_path);
  const fileBytes = fs.readFileSync(fullPath);
  const fileType = "application/pdf";

  const form = new FormData();
  form.set("file", new Blob([fileBytes], { type: fileType }), job.source_filename);
  form.set("scale_ratio", String(job.params.scale_ratio));
  form.set("crop_min_x", String(job.params.crop_min_x));
  form.set("crop_min_y", String(job.params.crop_min_y));
  form.set("crop_max_y", String(job.params.crop_max_y));
  form.set("detect_doors", String(job.params.detect_doors && config.door_import_beta_enabled));

  const response = await fetch(new URL("/predict", config.base_url), {
    method: "POST",
    body: form,
    signal: makeAbortSignal(config.request_timeout_ms)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text.trim() || `ZippyBIM request failed (${response.status}).`);
  }

  const payload = (await response.json()) as unknown;
  return normalizeZippyBimPrediction(payload, job.source_relative_path, job.source_filename);
}

async function callGeminiPrediction(job: ZippyBimJobRecord): Promise<ZippyBimJobResult> {
  const payload = await extractFloorPlanWithGemini({
    file_path: job.source_relative_path,
    scale_ratio: job.params.scale_ratio,
    detect_doors: !!job.params.detect_doors,
    crop_min_x: job.params.crop_min_x,
    crop_min_y: job.params.crop_min_y,
    crop_max_y: job.params.crop_max_y,
    timeout_ms: readConfig().request_timeout_ms
  });
  return normalizeZippyBimPrediction(payload, job.source_relative_path, job.source_filename);
}

async function runJob(jobId: string): Promise<void> {
  const initial = readJob(jobId);
  if (!initial) return;

  const started_at = nowIso();
  saveJob({
    ...initial,
    status: "running",
    started_at,
    updated_at: started_at,
    error: null
  });

  try {
    const result = initial.params.extractor === "gemini"
      ? await callGeminiPrediction(initial)
      : await callRemotePrediction(initial);
    writeJsonFile(jobResultPath(jobId), result);
    const finished_at = nowIso();
    saveJob({
      ...initial,
      status: "succeeded",
      started_at,
      finished_at,
      updated_at: finished_at,
      summary: result.summary,
      error: null
    });
  } catch (error) {
    const finished_at = nowIso();
    saveJob({
      ...initial,
      status: "failed",
      started_at,
      finished_at,
      updated_at: finished_at,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    runningJobs.delete(jobId);
  }
}

function ensureJobStarted(jobId: string): void {
  if (runningJobs.has(jobId)) return;
  const promise = runJob(jobId).catch(() => {
    // The job record already captures failures.
  });
  runningJobs.set(jobId, promise);
}

export function createZippyBimJob(input: CreateZippyBimJobInput): ZippyBimJobRecord {
  const config = readConfig();
  const extractor = normalizeExtractor(input.extractor);
  const gemini = getGeminiAvailability();
  if (extractor === "zippybim" && !config.base_url) throw new Error("OPERATOR_ZIPPYBIM_BASE_URL is not configured.");
  if (extractor === "gemini" && !gemini.available) throw new Error(gemini.error || "Gemini vision extractor is not available.");

  const relative_path = normalizeRelativePath(input.relative_path);
  const fullPath = resolveExistingFileUnderWorkspace(relative_path);
  if (path.extname(fullPath).toLowerCase() !== ".pdf") {
    throw new Error("ZippyBIM PDF import currently supports .pdf files only.");
  }

  const stat = fs.statSync(fullPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error("Selected PDF is empty or missing.");
  }

  const created_at = nowIso();
  const job: ZippyBimJobRecord = {
    id: randomUUID().replace(/-/g, ""),
    status: "queued",
    created_at,
    updated_at: created_at,
    started_at: null,
    finished_at: null,
    source_relative_path: relative_path,
    source_filename: path.basename(fullPath),
    params: {
      relative_path,
      extractor,
      scale_ratio: asNumber(input.scale_ratio, config.default_scale_ratio),
      crop_min_x: asNumber(input.crop_min_x, 0),
      crop_min_y: asNumber(input.crop_min_y, 0),
      crop_max_y: asNumber(input.crop_max_y, 100),
      detect_doors: asBoolean(input.detect_doors, false)
    },
    summary: null,
    error: null
  };

  saveJob(job);
  ensureJobStarted(job.id);
  return job;
}
