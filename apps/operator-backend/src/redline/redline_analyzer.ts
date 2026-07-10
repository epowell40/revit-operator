import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import { ocrImage } from "../tools/ocr.js";
import { ensureWorkspaceLayout, resolveExistingFileUnderWorkspace } from "../workspace.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";
import {
  buildPdfPageBatches,
  buildPdfPageCoverage,
  resolvePdfPageBudget,
  resolvePdfPageStart,
  type PdfPageBatch,
  type PdfPageCoverage
} from "./pdf_intake_policy.js";
import {
  extractSheetCandidatesFromFilename,
  extractSheetCandidatesFromText,
  isLikelySheetPattern,
  mergeSheetCandidates,
  normalizeSheetNumber,
  type RedlineSheetCandidate
} from "./sheet_candidate_classifier.js";
import {
  buildPdfAnnotationCoordinateMapper,
  clampPixelBoxToImage,
  extractInkListsPdf,
  extractPdfPointSequence,
  mapInkListsToUnit,
  mapPdfPointsToUnit,
  normalizedRectToPixelBox,
  normalizeInkListsToUnitBoxes,
  normalizePdfMarkupAnnotationToUnitBox,
  normBoxCenter,
  normBoxDistance,
  normBoxHeight,
  normBoxIntersectionArea,
  normBoxWidth,
  unionPdfBoxes,
  type PdfAnnotationBox,
  type PdfAnnotationPoint
} from "./pdf_annotation_geometry.js";

export { extractSheetCandidatesFromFilename, extractSheetCandidatesFromText } from "./sheet_candidate_classifier.js";
export type { RedlineSheetCandidate } from "./sheet_candidate_classifier.js";
export { testOnlyNormalizePdfRectToUnit as __testOnlyNormalizePdfRectToUnit } from "./pdf_annotation_geometry.js";

export type RedlineAnalyzeRequest = {
  file_path: string;
  expected_sheet?: string;
  max_pages?: number;
  page_start?: number;
  include_pdf_annotations?: boolean;
  include_ocr_for_images?: boolean;
  timeout_ms?: number;
  baseline_file_path?: string;
};

type PdfAnnotationSummary = {
  total: number;
  markup_total: number;
  red_markup_total: number;
  delete_like_total: number;
  by_subtype: Array<{ subtype: string; count: number }>;
  sample: Array<{
    subtype: string;
    color?: string;
    is_red_like: boolean;
    is_delete_like?: boolean;
    rect?: [number, number, number, number];
    contents?: string;
  }>;
};

type PdfPageSummary = {
  page: number;
  text_excerpt: string;
  text_chars: number;
  sheet_candidates: RedlineSheetCandidate[];
  annotation_summary?: PdfAnnotationSummary;
};

type PdfVectorAnnotation = {
  page: number;
  annotation_index: number;
  id?: string;
  subtype: string;
  color?: string;
  is_red_like: boolean;
  is_delete_like?: boolean;
  contents?: string;
  rect_pdf?: [number, number, number, number];
  box_norm?: PdfAnnotationBox;
  vertices_pdf?: PdfAnnotationPoint[];
  vertices_norm?: PdfAnnotationPoint[];
  ink_lists_pdf?: PdfAnnotationPoint[][];
  ink_lists_norm?: PdfAnnotationPoint[][];
  related_annotation_indices?: number[];
  related_text?: string;
  related_group?: number;
};

export type RedlineRouteCandidate = {
  candidate_index: number;
  label_text: string;
  mep_kind_hint?: "duct" | "pipe";
  size_text?: string;
  airflow_cfm?: number;
  system_hint?: string;
  geometry_role?: "route_geometry" | "callout_only" | "unknown";
  actionability?: "actionable" | "reference_only" | "review";
  intent_blockers?: string[];
  target_annotation_indices: number[];
  label_annotation_indices: number[];
  vertices_norm: PdfAnnotationPoint[];
  box_norm: PdfAnnotationBox;
  alignment_image_path?: string;
  alignment_crop_norm?: PdfAnnotationBox;
  confidence: number;
  reason: string;
};

export type RedlineMepIntentHint = {
  geometryRole: "route_geometry" | "callout_only" | "unknown";
  actionability: "actionable" | "reference_only" | "review";
  kind?: "duct" | "pipe";
  sizeText?: string;
  airflowCfm?: number;
  systemHint?: string;
  confidence: number;
  blockers: string[];
};

export type RedlineAnalyzeResponse = {
  ok: boolean;
  file_path: string;
  full_path: string;
  kind: "pdf" | "image" | "unknown";
  bytes: number;
  page_count?: number;
  page_coverage?: PdfPageCoverage;
  pdf_package?: {
    native_comment_count: number;
    native_comment_pages: number[];
    visual_batch_size: number;
    visual_batches: PdfPageBatch[];
    visual_analysis_status: "pending" | "not_required";
  };
  likely_sheet: boolean;
  primary_sheet_number: string | null;
  sheet_candidates: RedlineSheetCandidate[];
  pages?: PdfPageSummary[];
  ocr?: {
    ok: boolean;
    text_excerpt: string;
    text_chars: number;
    error?: string;
  };
  baseline_diff?: {
    ok: boolean;
    compared: boolean;
    error?: string;
    boxes?: Array<{ x: number; y: number; w: number; h: number; area: number }>;
  };
  image_meta?: {
    width: number;
    height: number;
  };
  mark_regions?: Array<{
    index: number;
    source: "baseline_diff" | "red_markup_detect" | "pdf_annotation";
    x: number;
    y: number;
    w: number;
    h: number;
    area: number;
    wall_local_normalized_chainage?: number;
    wall_local_axis?: "vertical" | "horizontal";
    wall_local_span_px?: [number, number];
    wall_local_source?: "nearby_visible_wall_line";
    annotation_subtype?: string;
    annotation_color?: string;
    annotation_is_red_like?: boolean;
    annotation_is_delete_like?: boolean;
    annotation_contents?: string;
    annotation_page?: number;
    annotation_index?: number;
    annotation_id?: string;
    annotation_rect_pdf?: [number, number, number, number];
    annotation_box_norm?: PdfAnnotationBox;
    annotation_vertices_pdf?: PdfAnnotationPoint[];
    annotation_vertices_norm?: PdfAnnotationPoint[];
    annotation_related_indices?: number[];
    annotation_related_text?: string;
    related_group?: number;
  }>;
  annotation_groups?: Array<{
    group_index: number;
    region_indices: number[];
    reason: string;
  }>;
  route_candidates?: RedlineRouteCandidate[];
  pdf_annotations?: PdfVectorAnnotation[];
  vision_artifacts?: {
    preview_image_path?: string;
    annotated_image_path?: string;
    crop_image_paths?: string[];
    warning?: string;
  };
  orientation_hints: string[];
  suggested_revit_calls: Array<{
    method: "POST";
    path: string;
    body: Record<string, unknown>;
  }>;
  warning?: string;
};

function extLower(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function truncate(s: string, maxChars: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= maxChars ? t : `${t.slice(0, maxChars)}…(truncated)`;
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function colorToName(rgb: unknown): { name: string; isRedLike: boolean } {
  const values =
    Array.isArray(rgb)
      ? rgb
      : ArrayBuffer.isView(rgb)
        ? Array.from(rgb as unknown as ArrayLike<number>)
        : rgb && typeof rgb === "object" && typeof (rgb as any).length === "number"
          ? Array.from(rgb as ArrayLike<number>)
          : null;
  if (!values || values.length < 3) return { name: "unknown", isRedLike: false };
  const rRaw = Number(values[0]);
  const gRaw = Number(values[1]);
  const bRaw = Number(values[2]);
  if (!Number.isFinite(rRaw) || !Number.isFinite(gRaw) || !Number.isFinite(bRaw)) return { name: "unknown", isRedLike: false };

  const normalize = (x: number) => {
    if (x <= 1.0) return Math.max(0, Math.min(255, Math.round(x * 255)));
    return Math.max(0, Math.min(255, Math.round(x)));
  };
  const r = normalize(rRaw);
  const g = normalize(gRaw);
  const b = normalize(bRaw);

  const isRedLike = r >= 120 && r > g + 35 && r > b + 35;
  const name = `rgb(${r},${g},${b})`;
  return { name, isRedLike };
}

function isDeleteLikeAnnotation(args: { subtype: string; contents: string }): boolean {
  const subtype = (args.subtype ?? "").trim().toLowerCase();
  if (subtype === "strikeout") return true;
  const c = (args.contents ?? "").toLowerCase();
  if (!c) return false;
  return /\b(delete|remove|demo|demolish|demolition|erase|omit|strike|x\s*out|take\s*out)\b/i.test(c);
}

function groupNearbyRegions(args: {
  regions: Array<{ index: number; x: number; y: number; w: number; h: number }>;
  imageWidth: number;
  imageHeight: number;
}): Array<{ group_index: number; region_indices: number[]; reason: string }> {
  const regions = args.regions
    .filter((r) => Number.isFinite(r.index) && r.index > 0 && r.w > 0 && r.h > 0)
    .slice(0, 160);
  if (regions.length < 2) return [];

  const n = regions.length;
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let p = parent[x]!;
    while (p !== parent[p]!) {
      parent[p] = parent[parent[p]!]!;
      p = parent[p]!;
    }
    parent[x] = p;
    return p;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const diag = Math.max(1, Math.hypot(args.imageWidth, args.imageHeight));
  const nearThreshold = Math.max(40, Math.round(diag * 0.045));
  const centerDistNormThreshold = 0.075;

  for (let i = 0; i < n; i++) {
    const a = regions[i]!;
    const ax = a.x + a.w * 0.5;
    const ay = a.y + a.h * 0.5;
    for (let j = i + 1; j < n; j++) {
      const b = regions[j]!;
      const bx = b.x + b.w * 0.5;
      const by = b.y + b.h * 0.5;
      const dist = Math.hypot(ax - bx, ay - by);
      const maxDim = Math.max(a.w, a.h, b.w, b.h);
      const nearByDistance = dist <= Math.max(nearThreshold, maxDim * 1.25);
      const nearByNormalized = (dist / diag) <= centerDistNormThreshold;
      const expandedOverlap =
        boxIntersectionArea(
          { x: a.x - 24, y: a.y - 24, w: a.w + 48, h: a.h + 48 },
          { x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48 }
        ) > 0;
      if (nearByDistance || nearByNormalized || expandedOverlap) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = groups.get(root) ?? [];
    arr.push(regions[i]!.index);
    groups.set(root, arr);
  }

  const out = [...groups.values()]
    .map((ids) => ids.filter((x, idx, all) => all.indexOf(x) === idx).sort((a, b) => a - b))
    .filter((ids) => ids.length > 1)
    .sort((a, b) => b.length - a.length)
    .slice(0, 24)
    .map((region_indices, idx) => ({
      group_index: idx + 1,
      region_indices,
      reason: "nearby_annotation_marks"
    }));
  return out;
}

function readImageDimensionsFast(fullPath: string): { width: number; height: number } | null {
  try {
    const ext = extLower(fullPath);
    const buf = fs.readFileSync(fullPath);
    if (ext === ".png" && buf.length >= 24) {
      const sig = "89504e470d0a1a0a";
      if (buf.slice(0, 8).toString("hex") !== sig) return null;
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    if (ext === ".jpg" || ext === ".jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        i += 2;
        if (marker === 0xd8 || marker === 0xd9) continue;
        if (i + 1 >= buf.length) break;
        const len = (buf[i] << 8) + buf[i + 1];
        if (!Number.isFinite(len) || len < 2 || i + len > buf.length) break;
        const isSof =
          marker === 0xc0 ||
          marker === 0xc1 ||
          marker === 0xc2 ||
          marker === 0xc3 ||
          marker === 0xc5 ||
          marker === 0xc6 ||
          marker === 0xc7 ||
          marker === 0xc9 ||
          marker === 0xca ||
          marker === 0xcb ||
          marker === 0xcd ||
          marker === 0xce ||
          marker === 0xcf;
        if (isSof && i + 7 < buf.length) {
          const height = (buf[i + 3] << 8) + buf[i + 4];
          const width = (buf[i + 5] << 8) + buf[i + 6];
          if (width > 0 && height > 0) return { width, height };
        }
        i += len;
      }
    }
  } catch {
    // ignore
  }
  return null;
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

function tryResolveUploadBasename(inputPath: string): { fullPath: string; relativePath: string } | null {
  const raw = (inputPath ?? "").trim().replace(/\\/g, "/");
  if (!raw) return null;
  const base = path.basename(raw).trim();
  if (!base || base === "." || base === "..") return null;

  const candidates = new Set<string>();
  const pushCandidate = (v: string) => {
    const s = (v ?? "").trim().toLowerCase();
    if (!s) return;
    if (s === "." || s === "..") return;
    candidates.add(s);
  };

  pushCandidate(base);
  // Handle timestamp-prefixed upload names, e.g.:
  // - 20260301000440_M000_Cover_Sheet.pdf
  // - 20260228_091734_M000_Cover_Sheet.pdf
  pushCandidate(base.replace(/^\d{14}[_-]/, ""));
  pushCandidate(base.replace(/^\d{8}[_-]\d{6}[_-]/, ""));
  pushCandidate(base.replace(/^\d{8}[_-]\d{4,6}[_-]/, ""));
  pushCandidate(base.replace(/^\d+[_-]/, ""));

  try {
    const ws = ensureWorkspaceLayout();
    const uploadsDir = path.join(ws.artifacts, "uploads");
    if (!fs.existsSync(uploadsDir)) return null;

    const files = fs
      .readdirSync(uploadsDir)
      .map((name) => ({
        name,
        full: path.join(uploadsDir, name)
      }))
      .filter((x) => {
        try {
          const st = fs.statSync(x.full);
          return st.isFile();
        } catch {
          return false;
        }
      })
      .filter((x) => {
        const n = x.name.toLowerCase();
        for (const c of candidates) {
          if (n === c || n.endsWith(`_${c}`)) return true;
        }
        return false;
      })
      .map((x) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(x.full).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { ...x, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (files.length === 0) return null;
    const picked = files[0]!;
    const rel = path.relative(ws.root, picked.full).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return null;
    return { fullPath: picked.full, relativePath: rel };
  } catch {
    return null;
  }
}

function escapeRegexLiteral(s: string): string {
  return (s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function filenameHasSheetToken(fileName: string, sheetToken: string): boolean {
  const token = normalizeSheetNumber(sheetToken);
  if (!token) return false;
  const re = new RegExp(`(?:^|[^A-Z0-9])${escapeRegexLiteral(token)}(?:$|[^A-Z0-9])`, "i");
  return re.test(fileName ?? "");
}

function findLikelyPrintedBaselinePdf(args: {
  sourceFullPath: string;
  primarySheet?: string | null;
  filenameSheet?: string | null;
}): { fullPath: string; relativePath: string } | null {
  try {
    const ws = ensureWorkspaceLayout();
    const printsDir = path.join(ws.artifacts, "prints");
    if (!fs.existsSync(printsDir)) return null;

    const normalizedTokens = [...new Set([args.primarySheet ?? "", args.filenameSheet ?? ""])]
      .map((x) => normalizeSheetNumber(x))
      .filter((x) => isLikelySheetPattern(x));
    if (normalizedTokens.length === 0) return null;

    const sourceNorm = path.normalize(args.sourceFullPath);
    const stack: string[] = [printsDir];
    const candidates: Array<{ fullPath: string; score: number; mtimeMs: number }> = [];
    let scanned = 0;

    while (stack.length > 0 && scanned < 5000) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (scanned >= 5000) break;
        const full = path.join(dir, ent.name);
        scanned++;
        if (ent.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!ent.isFile()) continue;
        if (path.extname(ent.name).toLowerCase() !== ".pdf") continue;
        if (path.normalize(full) === sourceNorm) continue;

        const name = ent.name;
        const lower = name.toLowerCase();
        let score = 0;
        for (const token of normalizedTokens) {
          if (filenameHasSheetToken(name, token)) {
            score += 70;
            if (lower.startsWith(token.toLowerCase())) score += 10;
          } else if (lower.includes(token.toLowerCase())) {
            score += 30;
          }
        }
        if (lower.includes("redline") || lower.includes("markup") || lower.includes("comment")) score -= 60;
        if (score <= 0) continue;

        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        candidates.push({ fullPath: full, score, mtimeMs });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
    const picked = candidates[0]!;
    const rel = path.relative(ws.root, picked.fullPath).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return null;
    return { fullPath: picked.fullPath, relativePath: rel };
  } catch {
    return null;
  }
}

function boxIntersectionArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}

function dedupePixelBoxes<T extends { x: number; y: number; w: number; h: number; area: number }>(boxes: T[], maxBoxes: number): T[] {
  const sorted = [...boxes].sort((a, b) => b.area - a.area);
  const out: T[] = [];
  for (const box of sorted) {
    let duplicate = false;
    for (const kept of out) {
      const inter = boxIntersectionArea(box, kept);
      if (inter <= 0) continue;
      const minArea = Math.max(1, Math.min(box.w * box.h, kept.w * kept.h));
      if (inter / minArea >= 0.88) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) out.push(box);
    if (out.length >= maxBoxes) break;
  }
  return out;
}

function dedupePixelBoxesPreferDetail<T extends { x: number; y: number; w: number; h: number; area: number }>(boxes: T[], maxBoxes: number): T[] {
  const sorted = [...boxes].sort((a, b) => a.area - b.area);
  const out: T[] = [];
  for (const box of sorted) {
    let duplicate = false;
    for (const kept of out) {
      const inter = boxIntersectionArea(box, kept);
      if (inter <= 0) continue;
      const minArea = Math.max(1, Math.min(box.w * box.h, kept.w * kept.h));
      if (inter / minArea >= 0.9) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) out.push(box);
    if (out.length >= maxBoxes) break;
  }
  return out.sort((a, b) => b.area - a.area);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePngRgbPixels(fullImagePath: string): { width: number; height: number; channels: number; rowBytes: number; pixels: Buffer } | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(fullImagePath);
  } catch {
    return null;
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(sig)) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0 || idat.length === 0) return null;
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) return null;

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const rowBytes = width * channels;
  if (raw.length < height * (rowBytes + 1)) return null;

  const pixels = Buffer.alloc(height * rowBytes);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++] ?? 0;
    const rowStart = y * rowBytes;
    const prevStart = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[src++] ?? 0;
      const left = x >= channels ? pixels[rowStart + x - channels]! : 0;
      const up = y > 0 ? pixels[prevStart + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prevStart + x - channels]! : 0;
      let decoded = value;
      if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
      else if (filter === 4) decoded = value + paethPredictor(left, up, upLeft);
      else if (filter !== 0) return null;
      pixels[rowStart + x] = decoded & 0xff;
    }
  }
  return { width, height, channels, rowBytes, pixels };
}

function estimateWallLocalChainagesFromPng(
  fullImagePath: string,
  boxes: Array<{ x: number; y: number; w: number; h: number; area: number }>
): Array<{ normalized_chainage: number; axis: "vertical" | "horizontal"; span_px: [number, number] } | null> | null {
  const decoded = decodePngRgbPixels(fullImagePath);
  if (!decoded) return null;
  const { width, height, channels, rowBytes, pixels } = decoded;
  const at = (x: number, y: number): [number, number, number, number] => {
    const p = y * rowBytes + x * channels;
    return [pixels[p] ?? 0, pixels[p + 1] ?? 0, pixels[p + 2] ?? 0, channels === 4 ? pixels[p + 3] ?? 255 : 255];
  };
  const isRedish = (rgb: [number, number, number, number]): boolean => {
    const [r, g, b, a] = rgb;
    return a >= 32 && r > 140 && r > g * 1.5 && r > b * 1.5 && g < 125 && b < 125;
  };
  const isStructure = (rgb: [number, number, number, number]): boolean => {
    if (isRedish(rgb)) return false;
    const [r, g, b, a] = rgb;
    if (a < 32) return false;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    return mx < 235 && mx - mn < 48;
  };
  const inferSide = (cx: number, cy: number): "left" | "right" | "top" | "bottom" => {
    const choices: Array<["left" | "right" | "top" | "bottom", number]> = [
      ["left", cx / Math.max(1, width)],
      ["right", 1 - cx / Math.max(1, width)],
      ["top", cy / Math.max(1, height)],
      ["bottom", 1 - cy / Math.max(1, height)]
    ];
    choices.sort((a, b) => a[1] - b[1]);
    return choices[0]![0];
  };
  const runsFromPositions = (vals: number[]): Array<[number, number]> => {
    if (vals.length === 0) return [];
    const runs: Array<[number, number]> = [];
    let s = vals[0]!;
    let prev = s;
    for (const v of vals.slice(1)) {
      if (v <= prev + 2) {
        prev = v;
      } else {
        if (prev - s >= 12) runs.push([s, prev]);
        s = prev = v;
      }
    }
    if (prev - s >= 12) runs.push([s, prev]);
    return runs;
  };
  const mergeRuns = (runs: Array<[number, number]>, gap: number): Array<[number, number]> => {
    const merged: Array<[number, number]> = [];
    for (const [a, b] of runs) {
      const last = merged[merged.length - 1];
      if (!last || a - last[1] > gap) merged.push([a, b]);
      else last[1] = b;
    }
    return merged;
  };

  return boxes.map((box) => {
    const cx = box.x + box.w * 0.5;
    const cy = box.y + box.h * 0.5;
    const side = inferSide(cx, cy);
    const vertical = side === "left" || side === "right";
    const search = Math.round(Math.max(90, Math.min(180, (vertical ? height : width) * 0.18)));
    const gap = Math.round(Math.max(24, Math.min(55, (vertical ? height : width) * 0.06)));
    const containPad = Math.max(20, vertical ? box.h : box.w);
    const minSpan = Math.max(80, (vertical ? height : width) * 0.12);
    const candidates: Array<{ score: number; normalized: number; span: [number, number]; axis: "vertical" | "horizontal" }> = [];
    if (vertical) {
      for (let x = Math.max(0, Math.floor(cx) - search); x <= Math.min(width - 1, Math.floor(cx) + search); x++) {
        const vals: number[] = [];
        for (let y = 0; y < height; y++) if (isStructure(at(x, y))) vals.push(y);
        for (const [a, b] of mergeRuns(runsFromPositions(vals), gap)) {
          const span = b - a;
          if (span < minSpan) continue;
          if (!(a <= cy + containPad && b >= cy - containPad)) continue;
          const sidePenalty =
            side === "left" && x > cx + box.w * 0.4 ? 35 :
              side === "right" && x < cx - box.w * 0.4 ? 35 : 0;
          const rawNormalized = (cy - a) / Math.max(1, span);
          if (rawNormalized < -0.02 || rawNormalized > 1.02) continue;
          candidates.push({
            score: Math.abs(x - cx) + sidePenalty - span * 0.01,
            normalized: Math.max(0.04, Math.min(0.96, rawNormalized)),
            span: [a, b],
            axis: "vertical"
          });
        }
      }
    } else {
      for (let y = Math.max(0, Math.floor(cy) - search); y <= Math.min(height - 1, Math.floor(cy) + search); y++) {
        const vals: number[] = [];
        for (let x = 0; x < width; x++) if (isStructure(at(x, y))) vals.push(x);
        for (const [a, b] of mergeRuns(runsFromPositions(vals), gap)) {
          const span = b - a;
          if (span < minSpan) continue;
          if (!(a <= cx + containPad && b >= cx - containPad)) continue;
          const sidePenalty =
            side === "top" && y > cy + box.h * 0.4 ? 35 :
              side === "bottom" && y < cy - box.h * 0.4 ? 35 : 0;
          const rawNormalized = (cx - a) / Math.max(1, span);
          if (rawNormalized < -0.02 || rawNormalized > 1.02) continue;
          candidates.push({
            score: Math.abs(y - cy) + sidePenalty - span * 0.01,
            normalized: Math.max(0.04, Math.min(0.96, rawNormalized)),
            span: [a, b],
            axis: "horizontal"
          });
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0];
    return best
      ? {
          normalized_chainage: Number(best.normalized.toFixed(6)),
          axis: best.axis,
          span_px: best.span
        }
      : null;
  });
}

export const __testOnlyEstimateWallLocalChainagesFromPng = estimateWallLocalChainagesFromPng;

function detectRedMarkupBoxesFromPng(fullImagePath: string): Array<{ x: number; y: number; w: number; h: number; area: number }> | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(fullImagePath);
  } catch {
    return null;
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(sig)) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0 || idat.length === 0) return null;
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) return null;

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const rowBytes = width * channels;
  if (raw.length < height * (rowBytes + 1)) return null;

  const pixels = Buffer.alloc(height * rowBytes);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++] ?? 0;
    const rowStart = y * rowBytes;
    const prevStart = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[src++] ?? 0;
      const left = x >= channels ? pixels[rowStart + x - channels]! : 0;
      const up = y > 0 ? pixels[prevStart + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prevStart + x - channels]! : 0;
      let decoded = value;
      if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
      else if (filter === 4) decoded = value + paethPredictor(left, up, upLeft);
      else if (filter !== 0) return null;
      pixels[rowStart + x] = decoded & 0xff;
    }
  }

  const red = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const p = rowStart + x * channels;
      const r = pixels[p] ?? 0;
      const g = pixels[p + 1] ?? 0;
      const b = pixels[p + 2] ?? 0;
      const a = channels === 4 ? pixels[p + 3] ?? 255 : 255;
      if (a >= 32 && r >= 130 && r > g + 35 && r > b + 35) red[y * width + x] = 1;
    }
  }

  const visited = new Uint8Array(width * height);
  const boxes: Array<{ x: number; y: number; w: number; h: number; area: number }> = [];
  const stack: number[] = [];
  for (let i = 0; i < red.length; i++) {
    if (!red[i] || visited[i]) continue;
    visited[i] = 1;
    stack.length = 0;
    stack.push(i);
    let minX = i % width;
    let maxX = minX;
    let minY = Math.floor(i / width);
    let maxY = minY;
    let area = 0;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      area += 1;
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x + 1 < width ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y + 1 < height ? idx + width : -1
      ];
      for (const n of neighbors) {
        if (n < 0 || visited[n] || !red[n]) continue;
        visited[n] = 1;
        stack.push(n);
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (area < 70 || w * h < 140) continue;
    boxes.push({ x: minX, y: minY, w, h, area });
  }
  return boxes.sort((a, b) => b.area - a.area).slice(0, 36);
}

function sanitizeDiffBoxes(
  boxes: Array<{ x: number; y: number; w: number; h: number; area: number }>,
  imageWidth: number,
  imageHeight: number
): { boxes: Array<{ x: number; y: number; w: number; h: number; area: number }>; warning?: string } {
  const pageArea = Math.max(1, imageWidth * imageHeight);
  const usable = boxes
    .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h) && b.w > 0 && b.h > 0)
    .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, area: b.area }))
    .sort((a, b) => (b.w * b.h) - (a.w * a.h));
  if (usable.length === 0) return { boxes: [] };

  const maxRatio = Math.max(...usable.map((b) => (b.w * b.h) / pageArea));
  const sumRatio = usable.reduce((sum, b) => sum + (b.w * b.h) / pageArea, 0);
  if (maxRatio >= 0.88 || sumRatio >= 1.25) {
    return {
      boxes: [],
      warning: "Baseline comparison looked misaligned (very large diff area); skipped baseline boxes."
    };
  }
  return { boxes: dedupePixelBoxes(usable, 24) };
}

function extractMepSizeText(text: string): string | undefined {
  const rectangular = text.match(/\b(\d{1,2})\s*(?:"|in|inch|inches)?\s*[x×]\s*(\d{1,2})\b/i);
  if (rectangular) return `${Number.parseInt(rectangular[1]!, 10)}x${Number.parseInt(rectangular[2]!, 10)}`;
  const round = text.match(/\b(\d{1,2}(?:\.\d+)?)\s*-?\s*(?:"|in|inch|inches)\b/i);
  if (!round) return undefined;
  const n = Number.parseFloat(round[1]!);
  return Number.isInteger(n) ? `${n}"` : `${n}"`;
}

function extractAirflowCfm(text: string): number | undefined {
  const match = /\b(\d{2,6})\s*cfm\b/i.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function systemHintFromMepText(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/\bsupply\s+air\b|\bsa\b|\bsupply\b/.test(lower)) return "supply air";
  if (/\breturn\s+air\b|\bra\b|\breturn\b/.test(lower)) return "return air";
  if (/\bexhaust\s+air\b|\bea\b|\bexhaust\b/.test(lower)) return "exhaust air";
  if (/\boutside\s+air\b|\boa\b/.test(lower)) return "outside air";
  if (/\bdomestic\s+cold\s+water\b|\bdcw\b|\bcold\s+water\b/.test(lower)) return "domestic cold water";
  if (/\bdomestic\s+hot\s+water\b|\bdhw\b|\bhot\s+water\b/.test(lower)) return "domestic hot water";
  if (/\bsanitary\b|\bsan\b/.test(lower)) return "sanitary";
  if (/\bvent\b/.test(lower)) return "vent";
  if (/\bchw\b|\bchilled\s+water\b/.test(lower)) return "chilled water";
  if (/\bhhw\b|\bheating\s+hot\s+water\b/.test(lower)) return "heating hot water";
  return undefined;
}

export function inferMepIntentFromRedlineText(args: { text: string; hasRouteGeometry?: boolean }): RedlineMepIntentHint {
  const text = truncate(args.text, 2000);
  const kind = mepKindHintFromText(text);
  const sizeText = extractMepSizeText(text);
  const airflowCfm = extractAirflowCfm(text);
  const systemHint = systemHintFromMepText(text);
  const hasRouteGeometry = args.hasRouteGeometry === true;
  const hasMepFact = !!kind || !!sizeText || airflowCfm !== undefined || !!systemHint;
  const explicitAction = /\b(add|provide|install|route|run|extend|connect|tap|take\s*off|branch|reroute|offset|resize|size|change|revise|update|move|delete|remove)\b/i.test(text);
  const referenceOnly = /\b(no\s+action\s+required|for\s+reference\s+only|reference\s+only|highlight\s+only|status\s+only|already\s+(?:done|complete|completed|reviewed)|existing\s+only)\b/i.test(text);
  const blockers: string[] = [];
  if (!hasMepFact) blockers.push("no_mep_size_airflow_system_or_kind_detected");
  if (hasMepFact && !hasRouteGeometry && !explicitAction) blockers.push("route_geometry_not_detected");

  const geometryRole = hasRouteGeometry
    ? "route_geometry"
    : hasMepFact && !explicitAction
      ? "callout_only"
      : "unknown";
  const actionability = referenceOnly ? "reference_only" : explicitAction || hasRouteGeometry ? "actionable" : "review";
  let confidence = 0.35;
  if (hasMepFact) confidence += 0.2;
  if (kind) confidence += 0.12;
  if (sizeText) confidence += 0.12;
  if (airflowCfm !== undefined) confidence += 0.08;
  if (systemHint) confidence += 0.08;
  if (hasRouteGeometry) confidence += 0.15;
  if (referenceOnly) confidence = Math.min(confidence, 0.72);
  if (blockers.length > 0) confidence = Math.min(confidence, 0.68);

  return {
    geometryRole,
    actionability,
    ...(kind ? { kind } : {}),
    ...(sizeText ? { sizeText } : {}),
    ...(airflowCfm !== undefined ? { airflowCfm } : {}),
    ...(systemHint ? { systemHint } : {}),
    confidence: Math.max(0.05, Math.min(0.95, Number(confidence.toFixed(2)))),
    blockers
  };
}

function textLooksMepRouteLabel(text: string): boolean {
  const hasSize = !!extractMepSizeText(text);
  return hasSize && /\b(duct|supply|return|exhaust|lined|pipe|piping|water|sanitary|vent)\b/i.test(text);
}

function mepKindHintFromText(text: string): "duct" | "pipe" | undefined {
  const lower = text.toLowerCase();
  const pipeLike = /\b(pipe|piping|domestic|sanitary|vent|water)\b/.test(lower);
  const explicitDuctLike = /\b(duct|ductwork|supply\s+air|return\s+air|exhaust\s+air|hvac)\b/.test(lower) || /\b\d{1,2}\s*(?:x|×)\s*\d{1,2}\b/i.test(text);
  const ductLike = explicitDuctLike || /\b(supply|return|exhaust)\b/.test(lower);
  if (pipeLike && !explicitDuctLike) return "pipe";
  if (ductLike) return "duct";
  return undefined;
}

function isTrueTextUnderline(routeBox: PdfAnnotationBox, labelBox: PdfAnnotationBox): boolean {
  const routeWidth = normBoxWidth(routeBox);
  const routeHeight = normBoxHeight(routeBox);
  const labelWidth = normBoxWidth(labelBox);
  const labelHeight = normBoxHeight(labelBox);
  if (routeWidth <= 0 || labelWidth <= 0 || labelHeight <= 0) return false;
  const thinHorizontal = routeWidth > routeHeight * 4 && routeHeight <= 0.02;
  const vectorCenterY = (routeBox.minY + routeBox.maxY) * 0.5;
  const lowerBandMin = labelBox.minY + labelHeight * 0.58;
  const inLowerBand = vectorCenterY >= lowerBandMin && vectorCenterY <= labelBox.maxY + labelHeight * 0.2;
  return thinHorizontal && inLowerBand && routeWidth / labelWidth >= 0.55;
}

function routeCandidateVertices(annotation: PdfVectorAnnotation): PdfAnnotationPoint[] {
  if (Array.isArray(annotation.vertices_norm) && annotation.vertices_norm.length >= 2) return annotation.vertices_norm;
  if (Array.isArray(annotation.ink_lists_norm)) {
    const longest = [...annotation.ink_lists_norm].sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= 2) return longest;
  }
  if (!annotation.box_norm) return [];
  const box = annotation.box_norm;
  return [
    { x: box.minX, y: (box.minY + box.maxY) * 0.5 },
    { x: box.maxX, y: (box.minY + box.maxY) * 0.5 }
  ];
}

function buildRedlineRouteCandidates(annotations: PdfVectorAnnotation[]): RedlineRouteCandidate[] {
  const labels = annotations.filter((a) => annotationSubtypeLooksText(a.subtype) && !!a.box_norm && textLooksMepRouteLabel(a.contents ?? ""));
  const vectors = annotations.filter((a) => annotationSubtypeLooksRoute(a.subtype) && !!a.box_norm);
  const candidates: RedlineRouteCandidate[] = [];
  for (const vector of vectors) {
    const vbox = vector.box_norm!;
    const relatedLabels = labels
      .map((label) => {
        const lbox = label.box_norm!;
        const explicit = Array.isArray(vector.related_annotation_indices) && vector.related_annotation_indices.includes(label.annotation_index);
        const labelText = label.contents ?? "";
        const centerDist = normBoxDistance(vbox, lbox);
        const yDist = Math.abs(normBoxCenter(vbox).y - normBoxCenter(lbox).y);
        const xOverlap = normBoxIntersectionArea(
          { minX: vbox.minX, minY: 0, maxX: vbox.maxX, maxY: 1 },
          { minX: lbox.minX, minY: 0, maxX: lbox.maxX, maxY: 1 }
        );
        const nearby = explicit || centerDist <= 0.2 || (xOverlap > 0 && yDist <= 0.18);
        if (!nearby) return null;
        const underline = isTrueTextUnderline(vbox, lbox);
        const score = (explicit ? 0.3 : 0) + Math.max(0, 0.35 - centerDist) + (xOverlap > 0 ? 0.1 : 0) - (underline ? 0.7 : 0);
        return { label, labelText, centerDist, underline, score };
      })
      .filter((r): r is NonNullable<typeof r> => !!r)
      .sort((a, b) => b.score - a.score);
    const best = relatedLabels[0];
    const fallbackLabel = vector.related_text && textLooksMepRouteLabel(vector.related_text)
      ? { labelText: vector.related_text, label: null as PdfVectorAnnotation | null, centerDist: 0.12, underline: false, score: 0.42 }
      : null;
    const chosen = best ?? fallbackLabel;
    if (!chosen || chosen.underline) continue;
    const vertices = routeCandidateVertices(vector);
    if (vertices.length < 2) continue;
    const boxes = [vbox, ...(chosen.label?.box_norm ? [chosen.label.box_norm] : [])];
    const box = unionPdfBoxes(boxes);
    if (!box) continue;
    const intent = inferMepIntentFromRedlineText({ text: chosen.labelText, hasRouteGeometry: true });
    candidates.push({
      candidate_index: candidates.length + 1,
      label_text: chosen.labelText,
      ...(intent.kind ? { mep_kind_hint: intent.kind } : {}),
      ...(intent.sizeText ? { size_text: intent.sizeText } : {}),
      ...(intent.airflowCfm !== undefined ? { airflow_cfm: intent.airflowCfm } : {}),
      ...(intent.systemHint ? { system_hint: intent.systemHint } : {}),
      geometry_role: intent.geometryRole,
      actionability: intent.actionability,
      ...(intent.blockers.length > 0 ? { intent_blockers: intent.blockers } : {}),
      target_annotation_indices: [vector.annotation_index],
      label_annotation_indices: chosen.label ? [chosen.label.annotation_index] : [],
      vertices_norm: vertices,
      box_norm: box,
      confidence: Math.max(0.55, Math.min(0.94, 0.55 + chosen.score)),
      reason:
        chosen.label
          ? "Route vector is spatially associated with nearby MEP callout text; the text labels the route geometry."
          : "Route vector has MEP callout text embedded as related annotation metadata."
    });
  }
  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 12);
}

function annotationSubtypeLooksRoute(subtype: string): boolean {
  return /^(ink|line|polyline|polygon)$/i.test(subtype);
}

function annotationSubtypeLooksText(subtype: string): boolean {
  return /^(freetext|text|typewriter)$/i.test(subtype);
}

function relatePdfAnnotations(annotations: PdfVectorAnnotation[]): void {
  for (const route of annotations) {
    if (!annotationSubtypeLooksRoute(route.subtype) || !route.box_norm) continue;
    const related = annotations
      .filter((candidate) => {
        if (candidate.annotation_index === route.annotation_index || candidate.page !== route.page || !candidate.box_norm) return false;
        if (!annotationSubtypeLooksText(candidate.subtype) || !candidate.contents) return false;
        const overlap = normBoxIntersectionArea(route.box_norm!, candidate.box_norm);
        if (overlap > 0) return true;
        return normBoxDistance(route.box_norm!, candidate.box_norm) <= 0.08;
      })
      .sort((a, b) => {
        const ao = normBoxIntersectionArea(route.box_norm!, a.box_norm!);
        const bo = normBoxIntersectionArea(route.box_norm!, b.box_norm!);
        return bo - ao || normBoxDistance(route.box_norm!, a.box_norm!) - normBoxDistance(route.box_norm!, b.box_norm!);
      });
    if (related.length === 0) continue;
    route.related_annotation_indices = related.map((r) => r.annotation_index);
    route.related_text = related.map((r) => r.contents).filter(Boolean).join("; ");
    for (const label of related) {
      label.related_annotation_indices = Array.from(new Set([...(label.related_annotation_indices ?? []), route.annotation_index]));
      if (!label.related_text && route.contents) label.related_text = route.contents;
    }
  }
}

function isPdfMarkupSubtype(subtype: string): boolean {
  const markSubtypes = new Set([
    "Highlight",
    "Underline",
    "StrikeOut",
    "Squiggly",
    "Ink",
    "Line",
    "Square",
    "Circle",
    "Polygon",
    "PolyLine",
    "Stamp",
    "FreeText",
    "Caret",
    "Text"
  ]);
  return markSubtypes.has(subtype);
}

export function __testOnlyIsDeleteLikeAnnotation(args: { subtype: string; contents: string }): boolean {
  return isDeleteLikeAnnotation(args);
}

export function __testOnlyGroupNearbyRegions(args: {
  regions: Array<{ index: number; x: number; y: number; w: number; h: number }>;
  imageWidth: number;
  imageHeight: number;
}): Array<{ group_index: number; region_indices: number[]; reason: string }> {
  return groupNearbyRegions(args);
}

export function __testOnlyBuildRedlineRouteCandidates(annotations: PdfVectorAnnotation[]): RedlineRouteCandidate[] {
  return buildRedlineRouteCandidates(annotations);
}

function boxCenter(box: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: box.x + box.w * 0.5, y: box.y + box.h * 0.5 };
}

function boxContainsPoint(box: { x: number; y: number; w: number; h: number }, p: { x: number; y: number }): boolean {
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}

function boxesLikelyMatch(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  const inter = boxIntersectionArea(a, b);
  if (inter <= 0) return false;
  const areaA = Math.max(1, a.w * a.h);
  const areaB = Math.max(1, b.w * b.h);
  const overlapSmall = inter / Math.min(areaA, areaB);
  if (overlapSmall >= 0.06) return true;
  const ca = boxCenter(a);
  const cb = boxCenter(b);
  return boxContainsPoint(a, cb) || boxContainsPoint(b, ca);
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return fallback;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function redlinePdfAutoInstallEnabled(): boolean {
  return parseBool(process.env.OPERATOR_REDLINE_PDF_AUTO_INSTALL, true);
}

function redlinePdfDpi(): number {
  const n = Number.parseInt(process.env.OPERATOR_REDLINE_PDF_DPI ?? "150", 10);
  if (!Number.isFinite(n)) return 150;
  return Math.max(72, Math.min(300, n));
}

async function bestEffortConvertPdfToJpegPages(args: {
  fullPdfPath: string;
  pageStart?: number;
  maxPages: number;
  dpi: number;
  timeoutMs: number;
  allowAutoInstall: boolean;
}): Promise<{ ok: boolean; page_paths: string[]; warning?: string }> {
  const ws = ensureWorkspaceLayout();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rid = Math.random().toString(36).slice(2, 8);
  const outDir = path.join(ws.root, "artifacts", "redline", `${stamp}_${rid}_pdf`);
  fs.mkdirSync(outDir, { recursive: true });

  const nodeRendered = await bestEffortRenderPdfWithNodeCanvas({
    fullPdfPath: args.fullPdfPath,
    outDir,
    pageStart: args.pageStart,
    maxPages: args.maxPages,
    dpi: args.dpi
  });
  if (nodeRendered.ok && nodeRendered.page_paths.length > 0) {
    return {
      ok: true,
      page_paths: nodeRendered.page_paths
        .map((p) => toWorkspaceRelativePath(p))
        .filter((p): p is string => !!p)
    };
  }

  const py = `
import json
import os
import glob
import shutil
import subprocess
import sys
import site

pdf_path = ${JSON.stringify(args.fullPdfPath)}
out_dir = ${JSON.stringify(outDir)}
max_pages = int(${JSON.stringify(Math.max(1, Math.min(8, args.maxPages)))})
page_start = int(${JSON.stringify(Math.max(1, Math.floor(args.pageStart ?? 1)))})
dpi = int(${JSON.stringify(Math.max(72, Math.min(300, args.dpi)))})
allow_auto_install = ${args.allowAutoInstall ? "True" : "False"}
user_base = os.environ.get("OPERATOR_PYTHON_USER_BASE", "/var/lib/revitoperator/python-user")

os.makedirs(out_dir, exist_ok=True)
paths = []
errors = []
method = ""

def add_user_site():
    try:
        os.environ["PYTHONUSERBASE"] = user_base
    except Exception:
        pass
    py_tag = f"python{sys.version_info.major}.{sys.version_info.minor}"
    sp = os.path.join(user_base, "lib", py_tag, "site-packages")
    if os.path.isdir(sp) and sp not in sys.path:
        sys.path.insert(0, sp)
    try:
        site.addsitedir(sp)
    except Exception:
        pass

def pip_install(pkg):
    try:
        os.makedirs(user_base, exist_ok=True)
        cache_dir = os.path.join(user_base, ".cache", "pip")
        os.makedirs(cache_dir, exist_ok=True)
        env = dict(os.environ)
        env["PYTHONUSERBASE"] = user_base
        env["PIP_CACHE_DIR"] = cache_dir
        cmd = [sys.executable, "-m", "pip", "install", "--user", "--disable-pip-version-check", "--quiet", pkg]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
        if r.returncode != 0:
            stderr = (r.stderr or "").strip()
            errors.append(f"pip:{pkg}:{stderr[:200]}")
            return False
        add_user_site()
        return True
    except Exception as e:
        errors.append(f"pip:{pkg}:{e}")
        return False

def render_fitz():
    global paths, method
    add_user_site()
    import fitz
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

try:
    render_fitz()
except Exception as e:
    errors.append(f"fitz:{e}")

if not paths and allow_auto_install:
    if pip_install("pymupdf"):
        try:
            render_fitz()
            if paths:
                method = method or "fitz+pip"
        except Exception as e:
            errors.append(f"fitz+pip:{e}")

if not paths:
    try:
        exe = shutil.which("pdftoppm")
        if exe:
            prefix = os.path.join(out_dir, "page")
            last_page = min(page_start + max_pages - 1, page_start + max(0, max_pages - 1))
            r = subprocess.run([exe, "-jpeg", "-f", str(page_start), "-l", str(last_page), "-r", str(dpi), pdf_path, prefix], capture_output=True, text=True)
            if r.returncode == 0:
                paths = sorted(glob.glob(prefix + "-*.jpg"))
                if paths:
                    method = "pdftoppm"
            else:
                errors.append(f"pdftoppm:{(r.stderr or '').strip()[:240]}")
        else:
            errors.append("pdftoppm:missing")
    except Exception as e:
        errors.append(f"pdftoppm:{e}")

paths = [x for x in paths if os.path.isfile(x)]
if paths:
    print(json.dumps({"ok": True, "method": method, "page_paths": paths}))
else:
    print(json.dumps({"ok": False, "error": "; ".join(errors) if errors else "No PDF converter available.", "page_paths": []}))
`;

  const r = await runPythonJson(py, Math.max(4_000, args.timeoutMs));
  if (!r.ok && !r.stdout.trim()) {
    return { ok: false, page_paths: [], warning: truncate(r.stderr || "PDF conversion failed.", 320) };
  }
  try {
    const parsed = JSON.parse((r.stdout || "").trim()) as any;
    const relPaths = Array.isArray(parsed?.page_paths)
      ? parsed.page_paths
          .map((p: any) => (typeof p === "string" ? toWorkspaceRelativePath(p) : null))
          .filter((p: string | null): p is string => !!p)
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

async function bestEffortRenderPdfWithNodeCanvas(args: {
  fullPdfPath: string;
  outDir: string;
  pageStart?: number;
  maxPages: number;
  dpi: number;
}): Promise<{ ok: boolean; page_paths: string[]; warning?: string }> {
  try {
    const canvasMod = await (Function("specifier", "return import(specifier)")("@napi-rs/canvas") as Promise<any>);
    const createCanvas = canvasMod?.createCanvas;
    if (typeof createCanvas !== "function") return { ok: false, page_paths: [], warning: "@napi-rs/canvas createCanvas is unavailable." };
    const pdfjs = await loadPdfJsForNode();
    const bytes = fs.readFileSync(args.fullPdfPath);
    const doc = await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(bytes))).promise;
    const pageStart = Math.max(1, Math.min(Number(doc.numPages ?? 0) || 1, Math.floor(args.pageStart ?? 1)));
    const count = Math.max(0, Math.min(8, args.maxPages, Number(doc.numPages ?? 0) - pageStart + 1));
    const scale = Math.max(72, Math.min(300, args.dpi)) / 72;
    const paths: string[] = [];
    for (let offset = 0; offset < count; offset++) {
      const pageNumber = pageStart + offset;
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const out = path.join(args.outDir, `page_${String(pageNumber).padStart(4, "0")}.png`);
      fs.writeFileSync(out, canvas.toBuffer("image/png"));
      paths.push(out);
    }
    return { ok: paths.length > 0, page_paths: paths };
  } catch (err) {
    return {
      ok: false,
      page_paths: [],
      warning: err instanceof Error ? err.message : "Node PDF rasterization failed."
    };
  }
}

async function bestEffortDetectRedMarkupBoxes(args: {
  fullImagePath: string;
  timeoutMs: number;
  allowAutoInstall: boolean;
}): Promise<{ ok: boolean; boxes: Array<{ x: number; y: number; w: number; h: number; area: number }>; warning?: string }> {
  const jsPngBoxes = detectRedMarkupBoxesFromPng(args.fullImagePath);
  if (jsPngBoxes && jsPngBoxes.length > 0) {
    return { ok: true, boxes: jsPngBoxes };
  }

  const py = `
import json
import os
import subprocess
import sys
import site

image_path = ${JSON.stringify(args.fullImagePath)}
allow_auto_install = ${args.allowAutoInstall ? "True" : "False"}
user_base = os.environ.get("OPERATOR_PYTHON_USER_BASE", "/var/lib/revitoperator/python-user")

def add_user_site():
    try:
        os.environ["PYTHONUSERBASE"] = user_base
    except Exception:
        pass
    py_tag = f"python{sys.version_info.major}.{sys.version_info.minor}"
    sp = os.path.join(user_base, "lib", py_tag, "site-packages")
    if os.path.isdir(sp) and sp not in sys.path:
        sys.path.insert(0, sp)
    try:
        site.addsitedir(sp)
    except Exception:
        pass

def ensure_pillow():
    add_user_site()
    try:
        from PIL import Image
        return True, None
    except Exception as e:
        if not allow_auto_install:
            return False, f"PIL not available: {e}"
        try:
            os.makedirs(user_base, exist_ok=True)
            cache_dir = os.path.join(user_base, ".cache", "pip")
            os.makedirs(cache_dir, exist_ok=True)
            env = dict(os.environ)
            env["PYTHONUSERBASE"] = user_base
            env["PIP_CACHE_DIR"] = cache_dir
            cmd = [sys.executable, "-m", "pip", "install", "--user", "--disable-pip-version-check", "--quiet", "pillow"]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
            if r.returncode != 0:
                return False, f"pip pillow failed: {(r.stderr or '').strip()[:200]}"
            add_user_site()
            from PIL import Image
            return True, None
        except Exception as ex:
            return False, f"PIL install failed: {ex}"

ok, err = ensure_pillow()
if not ok:
    print(json.dumps({"ok": False, "error": err, "boxes": []}))
    raise SystemExit(0)

from PIL import Image
try:
    img = Image.open(image_path).convert("RGB")
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e), "boxes": []}))
    raise SystemExit(0)

pix = img.load()
w, h = img.size
visited = set()
boxes = []
dirs = ((1,0),(-1,0),(0,1),(0,-1))

def is_red_like(r,g,b):
    return r >= 130 and r > g + 35 and r > b + 35

for y in range(h):
    for x in range(w):
        r,g,b = pix[x,y]
        if not is_red_like(r,g,b):
            continue
        key = (x,y)
        if key in visited:
            continue
        stack = [key]
        visited.add(key)
        minx = maxx = x
        miny = maxy = y
        area = 0
        while stack:
            cx, cy = stack.pop()
            area += 1
            if cx < minx: minx = cx
            if cx > maxx: maxx = cx
            if cy < miny: miny = cy
            if cy > maxy: maxy = cy
            for dx,dy in dirs:
                nx, ny = cx + dx, cy + dy
                if nx < 0 or ny < 0 or nx >= w or ny >= h:
                    continue
                if (nx,ny) in visited:
                    continue
                rr,gg,bb = pix[nx,ny]
                if not is_red_like(rr,gg,bb):
                    continue
                visited.add((nx,ny))
                stack.append((nx,ny))
        bw = maxx - minx + 1
        bh = maxy - miny + 1
        rect_area = bw * bh
        if area < 70 or rect_area < 140:
            continue
        boxes.append({"x": int(minx), "y": int(miny), "w": int(bw), "h": int(bh), "area": int(area)})

boxes.sort(key=lambda b: b["area"], reverse=True)
print(json.dumps({"ok": True, "boxes": boxes[:36]}))
`;

  const r = await runPythonJson(py, Math.max(3_000, args.timeoutMs));
  if (!r.ok && !r.stdout.trim()) {
    return { ok: false, boxes: [], warning: truncate(r.stderr || "Red-mark detection failed.", 300) };
  }
  try {
    const parsed = JSON.parse((r.stdout || "").trim()) as any;
    const boxes = Array.isArray(parsed?.boxes)
      ? (parsed.boxes as any[])
          .map((b: any) => ({
            x: Number(b?.x),
            y: Number(b?.y),
            w: Number(b?.w),
            h: Number(b?.h),
            area: Number(b?.area)
          }))
          .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h) && b.w > 0 && b.h > 0)
      : [];
    return {
      ok: !!parsed?.ok,
      boxes,
      ...(typeof parsed?.error === "string" && parsed.error.trim() ? { warning: truncate(parsed.error, 260) } : {})
    };
  } catch {
    return { ok: false, boxes: [], warning: truncate(r.stdout || r.stderr || "Red-mark parse failed.", 300) };
  }
}

async function bestEffortRenderImageRegions(args: {
  fullPath: string;
  regions: Array<{ x: number; y: number; w: number; h: number; area: number }>;
  timeoutMs: number;
  allowAutoInstall?: boolean;
}): Promise<{ annotated_path?: string; crop_paths: string[]; warning?: string }> {
  const safeRegions = args.regions
    .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h) && b.w > 0 && b.h > 0)
    .sort((a, b) => b.area - a.area)
    .slice(0, 12);
  if (safeRegions.length === 0) return { crop_paths: [] };

  const ws = ensureWorkspaceLayout();
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const rid = Math.random().toString(36).slice(2, 8);
  const outDir = path.join(ws.root, "artifacts", "redline", `${stamp}_${rid}`);
  fs.mkdirSync(outDir, { recursive: true });
  const annotatedAbs = path.join(outDir, "marked_regions.png");

  const nodeRendered = await bestEffortRenderImageRegionsWithNodeCanvas({
    fullPath: args.fullPath,
    regions: safeRegions,
    outDir,
    annotatedAbs
  });
  if (nodeRendered.crop_paths.length > 0 || nodeRendered.annotated_path) return nodeRendered;

  const py = `
import json
import os
import subprocess
import sys
import site

allow_auto_install = ${args.allowAutoInstall === true ? "True" : "False"}
user_base = os.environ.get("OPERATOR_PYTHON_USER_BASE", "/var/lib/revitoperator/python-user")

def add_user_site():
    try:
        os.environ["PYTHONUSERBASE"] = user_base
    except Exception:
        pass
    py_tag = f"python{sys.version_info.major}.{sys.version_info.minor}"
    sp = os.path.join(user_base, "lib", py_tag, "site-packages")
    if os.path.isdir(sp) and sp not in sys.path:
        sys.path.insert(0, sp)
    try:
        site.addsitedir(sp)
    except Exception:
        pass

def ensure_pillow():
    add_user_site()
    try:
        from PIL import Image, ImageDraw
        return True, None
    except Exception as e:
        if not allow_auto_install:
            return False, f"PIL not available: {e}"
        try:
            os.makedirs(user_base, exist_ok=True)
            cache_dir = os.path.join(user_base, ".cache", "pip")
            os.makedirs(cache_dir, exist_ok=True)
            env = dict(os.environ)
            env["PYTHONUSERBASE"] = user_base
            env["PIP_CACHE_DIR"] = cache_dir
            cmd = [sys.executable, "-m", "pip", "install", "--user", "--disable-pip-version-check", "--quiet", "pillow"]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
            if r.returncode != 0:
                return False, f"pip pillow failed: {(r.stderr or '').strip()[:200]}"
            add_user_site()
            from PIL import Image, ImageDraw
            return True, None
        except Exception as ex:
            return False, f"PIL install failed: {ex}"

ok, err = ensure_pillow()
if not ok:
    print(json.dumps({"ok": False, "error": err, "crop_paths": []}))
    sys.exit(0)

try:
    from PIL import Image, ImageDraw
except Exception as e:
    print(json.dumps({"ok": False, "error": f"PIL not available: {e}", "crop_paths": []}))
    sys.exit(0)

image_path = ${JSON.stringify(args.fullPath)}
out_dir = ${JSON.stringify(outDir)}
annotated_abs = ${JSON.stringify(annotatedAbs)}
regions = ${JSON.stringify(safeRegions)}
os.makedirs(out_dir, exist_ok=True)

try:
    img = Image.open(image_path).convert("RGB")
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e), "crop_paths": []}))
    sys.exit(0)

draw = ImageDraw.Draw(img)
crop_paths = []
for i, b in enumerate(regions, start=1):
    x = int(round(b.get("x", 0)))
    y = int(round(b.get("y", 0)))
    w = int(round(b.get("w", 0)))
    h = int(round(b.get("h", 0)))
    if w <= 0 or h <= 0:
        continue
    x2 = x + w
    y2 = y + h
    margin = max(8, int(max(w, h) * 0.12))
    l = max(0, x - margin)
    t = max(0, y - margin)
    r = min(img.width, x2 + margin)
    btm = min(img.height, y2 + margin)
    if r <= l or btm <= t:
        continue
    crop = img.crop((l, t, r, btm))
    crop_abs = os.path.join(out_dir, f"region_{i:02d}.png")
    crop.save(crop_abs)
    crop_paths.append(crop_abs)

    draw.rectangle([x, y, x2, y2], outline=(255, 0, 0), width=4)
    draw.text((max(0, x + 2), max(0, y - 18)), f"#{i}", fill=(255, 0, 0))

img.save(annotated_abs)
print(json.dumps({"ok": True, "annotated_path": annotated_abs, "crop_paths": crop_paths}))
`;

  const r = await runPythonJson(py, Math.max(3_000, args.timeoutMs));
  if (!r.ok && !r.stdout.trim()) {
    return { crop_paths: [], warning: truncate(r.stderr || "Failed to render marked regions.", 280) };
  }
  try {
    const parsed = JSON.parse((r.stdout || "").trim()) as any;
    if (!parsed || typeof parsed !== "object") return { crop_paths: [], warning: "Invalid region-render JSON output." };
    const annotatedRel =
      typeof parsed.annotated_path === "string" && parsed.annotated_path.trim()
        ? toWorkspaceRelativePath(parsed.annotated_path.trim()) ?? undefined
        : undefined;
    const cropRel = Array.isArray(parsed.crop_paths)
      ? parsed.crop_paths
          .map((p: any) => (typeof p === "string" ? toWorkspaceRelativePath(p) : null))
          .filter((p: string | null): p is string => !!p)
      : [];
    const warning = typeof parsed.error === "string" && parsed.error.trim() ? truncate(parsed.error, 280) : undefined;
    return {
      ...(annotatedRel ? { annotated_path: annotatedRel } : {}),
      crop_paths: cropRel,
      ...(warning ? { warning } : {})
    };
  } catch {
    return { crop_paths: [], warning: truncate(r.stdout || r.stderr || "Region-render parse failed.", 280) };
  }
}

async function bestEffortRenderImageRegionsWithNodeCanvas(args: {
  fullPath: string;
  regions: Array<{ x: number; y: number; w: number; h: number; area: number }>;
  outDir: string;
  annotatedAbs: string;
}): Promise<{ annotated_path?: string; crop_paths: string[]; warning?: string }> {
  try {
    const canvasMod = await (Function("specifier", "return import(specifier)")("@napi-rs/canvas") as Promise<any>);
    const createCanvas = canvasMod?.createCanvas;
    const loadImage = canvasMod?.loadImage;
    if (typeof createCanvas !== "function" || typeof loadImage !== "function") return { crop_paths: [] };
    const image = await loadImage(args.fullPath);
    const width = Number(image.width);
    const height = Number(image.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { crop_paths: [] };

    const annotated = createCanvas(width, height);
    const annotatedCtx = annotated.getContext("2d");
    annotatedCtx.drawImage(image, 0, 0, width, height);
    const cropPaths: string[] = [];
    for (let i = 0; i < args.regions.length; i++) {
      const b = args.regions[i]!;
      const x = Math.max(0, Math.round(b.x));
      const y = Math.max(0, Math.round(b.y));
      const w = Math.max(1, Math.round(b.w));
      const h = Math.max(1, Math.round(b.h));
      const x2 = Math.min(width, x + w);
      const y2 = Math.min(height, y + h);
      const margin = Math.max(8, Math.round(Math.max(w, h) * 0.12));
      const l = Math.max(0, x - margin);
      const t = Math.max(0, y - margin);
      const r = Math.min(width, x2 + margin);
      const btm = Math.min(height, y2 + margin);
      if (r <= l || btm <= t) continue;

      const crop = createCanvas(r - l, btm - t);
      const cropCtx = crop.getContext("2d");
      cropCtx.drawImage(image, l, t, r - l, btm - t, 0, 0, r - l, btm - t);
      const cropAbs = path.join(args.outDir, `region_${String(i + 1).padStart(2, "0")}.png`);
      fs.writeFileSync(cropAbs, crop.toBuffer("image/png"));
      const cropRel = toWorkspaceRelativePath(cropAbs);
      if (cropRel) cropPaths.push(cropRel);

      annotatedCtx.strokeStyle = "rgb(255,0,0)";
      annotatedCtx.lineWidth = 4;
      annotatedCtx.strokeRect(x, y, x2 - x, y2 - y);
      annotatedCtx.fillStyle = "rgb(255,0,0)";
      annotatedCtx.font = "18px sans-serif";
      annotatedCtx.fillText(`#${i + 1}`, Math.max(0, x + 2), Math.max(18, y - 4));
    }
    fs.writeFileSync(args.annotatedAbs, annotated.toBuffer("image/png"));
    return {
      ...(toWorkspaceRelativePath(args.annotatedAbs) ? { annotated_path: toWorkspaceRelativePath(args.annotatedAbs)! } : {}),
      crop_paths: cropPaths
    };
  } catch (err) {
    return {
      crop_paths: [],
      warning: err instanceof Error ? truncate(err.message, 240) : "Node image region rendering failed."
    };
  }
}

async function analyzePdf(args: {
  fullPath: string;
  relativePath: string;
  expectedSheet?: string;
  maxPages: number;
  pageStart: number;
  includeAnnotations: boolean;
  baselinePath?: string;
}): Promise<RedlineAnalyzeResponse> {
  const bytes = fs.readFileSync(args.fullPath);
  const pdfData = new Uint8Array(bytes);
  const pdfjs = await loadPdfJsForNode();
  const doc = await pdfjs.getDocument(buildPdfJsDocumentOptions(pdfData)).promise;
  const pageCount = Math.max(0, Number(doc.numPages ?? 0));
  const coverage = buildPdfPageCoverage(pageCount, args.pageStart, args.maxPages);
  const firstPage = coverage.processed_page_count > 0 ? coverage.requested_page_start : 1;
  const lastPage = coverage.processed_page_count > 0 ? firstPage + coverage.processed_page_count - 1 : 0;

  const pageSummaries: PdfPageSummary[] = [];
  const fileNameCandidates = extractSheetCandidatesFromFilename({
    filePath: args.relativePath,
    expectedSheet: args.expectedSheet,
    maxCandidates: 6
  });
  const allCandidates: RedlineSheetCandidate[] = [...fileNameCandidates];
  let pdfPageImageMeta: { width: number; height: number } | undefined;
  const annotationNormBoxesPage1: Array<{
    page: number;
    annotationIndex: number;
    annotationId?: string;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    areaNorm: number;
    subtype: string;
    color: string;
    isRedLike: boolean;
    isDeleteLike: boolean;
    contents?: string;
    rectPdf?: [number, number, number, number];
    boxNorm?: PdfAnnotationBox;
    verticesPdf?: PdfAnnotationPoint[];
    verticesNorm?: PdfAnnotationPoint[];
    relatedAnnotationIndices?: number[];
    relatedText?: string;
  }> = [];
  const pdfAnnotations: NonNullable<RedlineAnalyzeResponse["pdf_annotations"]> = [];
  let annotationMarkupCountPage1 = 0;

  for (let p = firstPage; p <= lastPage; p++) {
    const page = await doc.getPage(p);
    const textContent = await page.getTextContent();
    const text = (textContent?.items ?? [])
      .map((it: any) => (typeof it?.str === "string" ? it.str : ""))
      .join(" ");
    const textExcerpt = truncate(text, 1500);
    const cands = extractSheetCandidatesFromText({
      text,
      expectedSheet: args.expectedSheet,
      page: p,
      maxCandidates: 10
    });
    allCandidates.push(...cands);

    let annotationSummary: PdfAnnotationSummary | undefined;
    if (args.includeAnnotations) {
      let annRaw: any[] = [];
      try {
        const annotations = await page.getAnnotations();
        if (Array.isArray(annotations)) annRaw = annotations as any[];
      } catch {
        annRaw = [];
      }

      const bySubtype = new Map<string, number>();
      let markupTotal = 0;
      let redMarkupTotal = 0;
      let deleteLikeTotal = 0;
      const sample: PdfAnnotationSummary["sample"] = [];
      const viewport = page.getViewport({ scale: 1.0 });
      if (p === firstPage && !pdfPageImageMeta) {
        const w = Number((viewport as any)?.width);
        const h = Number((viewport as any)?.height);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 1 && h > 1) {
          pdfPageImageMeta = { width: Math.round(w), height: Math.round(h) };
        }
      }
      const coordMapper = buildPdfAnnotationCoordinateMapper({
        viewport,
        pageView: (page as any)?.view
      });

      for (let annotationIndex0 = 0; annotationIndex0 < annRaw.length; annotationIndex0++) {
        const a = annRaw[annotationIndex0];
        const annotationIndex = annotationIndex0 + 1;
        const subtype = typeof a?.subtype === "string" ? a.subtype : "Unknown";
        bySubtype.set(subtype, (bySubtype.get(subtype) ?? 0) + 1);

        const isMarkup = isPdfMarkupSubtype(subtype);
        const colorInfo = colorToName(a?.color);
        if (isMarkup) {
          markupTotal++;
          if (p === firstPage) annotationMarkupCountPage1++;
          if (colorInfo.isRedLike) redMarkupTotal++;
          const contents =
            (typeof a?.contents === "string" && a.contents.trim()) ||
            (typeof a?.contentsObj?.str === "string" && a.contentsObj.str.trim()) ||
            (Array.isArray(a?.textContent) ? a.textContent.filter((x: unknown) => typeof x === "string").join(" ").trim() : "") ||
            "";
          const isDeleteLike = isDeleteLikeAnnotation({ subtype, contents });
          if (isDeleteLike) deleteLikeTotal++;
          const rect = Array.isArray(a?.rect) && a.rect.length >= 4
            ? [Number(a.rect[0]), Number(a.rect[1]), Number(a.rect[2]), Number(a.rect[3])] as [number, number, number, number]
            : undefined;
          const verticesPdf = extractPdfPointSequence(a?.vertices ?? a?.lineCoordinates ?? a?.quadPoints);
          const verticesNorm = coordMapper && verticesPdf.length > 0 ? mapPdfPointsToUnit(verticesPdf, coordMapper) : [];
          const inkListsPdf = subtype === "Ink" ? extractInkListsPdf(a?.inkLists) : [];
          const inkListsNorm = coordMapper && inkListsPdf.length > 0 ? mapInkListsToUnit(inkListsPdf, coordMapper) : [];
          const normBoxes =
            coordMapper
              ? subtype === "Ink"
                ? normalizeInkListsToUnitBoxes(a?.inkLists, coordMapper)
                : (() => {
                    const single = normalizePdfMarkupAnnotationToUnitBox({
                      annotation: a,
                      mapper: coordMapper
                    });
                    return single ? [single] : [];
                  })()
              : [];
          const boxNorm = unionPdfBoxes(normBoxes);
          const annotationRecord: PdfVectorAnnotation = {
            page: p,
            annotation_index: annotationIndex,
            ...(typeof a?.id === "string" && a.id.trim() ? { id: a.id.trim() } : {}),
            subtype,
            color: colorInfo.name,
            is_red_like: colorInfo.isRedLike,
            ...(isDeleteLike ? { is_delete_like: true } : {}),
            ...(contents ? { contents: truncate(contents, 240) } : {}),
            ...(rect ? { rect_pdf: rect } : {}),
            ...(boxNorm ? { box_norm: boxNorm } : {}),
            ...(verticesPdf.length > 0 ? { vertices_pdf: verticesPdf } : {}),
            ...(verticesNorm.length > 0 ? { vertices_norm: verticesNorm } : {}),
            ...(inkListsPdf.length > 0 ? { ink_lists_pdf: inkListsPdf } : {}),
            ...(inkListsNorm.length > 0 ? { ink_lists_norm: inkListsNorm } : {})
          };
          pdfAnnotations.push(annotationRecord);
          if (p === firstPage) {
            for (const norm of normBoxes) {
              const areaNorm = Math.max(0, (norm.maxX - norm.minX) * (norm.maxY - norm.minY));
              // Ignore gigantic page-spanning annotation bounds that usually indicate noisy metadata.
              if (areaNorm > 0 && areaNorm <= 0.45) {
                annotationNormBoxesPage1.push({
                  page: p,
                  annotationIndex,
                  ...(typeof a?.id === "string" && a.id.trim() ? { annotationId: a.id.trim() } : {}),
                  ...norm,
                  areaNorm,
                  subtype,
                  color: colorInfo.name,
                  isRedLike: colorInfo.isRedLike,
                  isDeleteLike,
                  ...(contents ? { contents: truncate(contents, 240) } : {}),
                  ...(rect ? { rectPdf: rect } : {}),
                  boxNorm: norm,
                  ...(verticesPdf.length > 0 ? { verticesPdf } : {}),
                  ...(verticesNorm.length > 0 ? { verticesNorm } : {})
                });
              }
            }
          }
          if (sample.length < 12) {
            sample.push({
              subtype,
              color: colorInfo.name,
              is_red_like: colorInfo.isRedLike,
              ...(isDeleteLike ? { is_delete_like: true } : {}),
              rect,
              ...(contents ? { contents: truncate(contents, 140) } : {})
            });
          }
        }
      }

      annotationSummary = {
        total: annRaw.length,
        markup_total: markupTotal,
        red_markup_total: redMarkupTotal,
        delete_like_total: deleteLikeTotal,
        by_subtype: [...bySubtype.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 16)
          .map(([subtype, count]) => ({ subtype, count })),
        sample
      };
    }

    pageSummaries.push({
      page: p,
      text_excerpt: textExcerpt,
      text_chars: text.length,
      sheet_candidates: cands,
      ...(annotationSummary ? { annotation_summary: annotationSummary } : {})
    });
  }

  relatePdfAnnotations(pdfAnnotations);
  const routeCandidates = buildRedlineRouteCandidates(pdfAnnotations);
  const pdfAnnotationByPageIndex = new Map<string, PdfVectorAnnotation>();
  for (const ann of pdfAnnotations) {
    pdfAnnotationByPageIndex.set(`${ann.page}:${ann.annotation_index}`, ann);
  }
  for (const box of annotationNormBoxesPage1) {
    const ann = pdfAnnotationByPageIndex.get(`${box.page}:${box.annotationIndex}`);
    if (!ann) continue;
    if (Array.isArray(ann.related_annotation_indices) && ann.related_annotation_indices.length > 0) {
      box.relatedAnnotationIndices = ann.related_annotation_indices;
    }
    if (ann.related_text) {
      box.relatedText = ann.related_text;
      if (!box.contents) box.contents = ann.related_text;
    }
  }

  const merged = mergeSheetCandidates(allCandidates, 20);
  const primary = merged.length > 0 ? merged[0]!.sheet_number : null;
  const likelySheet = merged.length > 0 && (merged[0]!.score >= 24 || merged[0]!.hit_count >= 2);
  const filenamePrimary = fileNameCandidates.length > 0 ? fileNameCandidates[0]!.sheet_number : null;
  const allowAutoInstall = redlinePdfAutoInstallEnabled();

  let imageMeta: { width: number; height: number } | undefined;
  let baselineDiff: RedlineAnalyzeResponse["baseline_diff"] | undefined;
  let markRegions: NonNullable<RedlineAnalyzeResponse["mark_regions"]> = [];
  let annotationGroups: NonNullable<RedlineAnalyzeResponse["annotation_groups"]> = [];
  let visionArtifacts: RedlineAnalyzeResponse["vision_artifacts"] | undefined;
  const preprocessingWarnings: string[] = [];

  let baselineFullPath = typeof args.baselinePath === "string" && args.baselinePath.trim() ? args.baselinePath : "";
  let baselineRelativePath = baselineFullPath ? toWorkspaceRelativePath(baselineFullPath) ?? "" : "";
  let baselineAutoPicked = false;
  if (!baselineFullPath) {
    const picked = findLikelyPrintedBaselinePdf({
      sourceFullPath: args.fullPath,
      primarySheet: primary,
      filenameSheet: filenamePrimary
    });
    if (picked) {
      baselineFullPath = picked.fullPath;
      baselineRelativePath = picked.relativePath;
      baselineAutoPicked = true;
    }
  }

  type AnnotationPixelRegion = {
    x: number;
    y: number;
    w: number;
    h: number;
    area: number;
    page: number;
    annotationIndex: number;
    annotationId?: string;
    subtype: string;
    color: string;
    isRedLike: boolean;
    isDeleteLike: boolean;
    contents?: string;
    rectPdf?: [number, number, number, number];
    boxNorm?: PdfAnnotationBox;
    verticesPdf?: PdfAnnotationPoint[];
    verticesNorm?: PdfAnnotationPoint[];
    relatedAnnotationIndices?: number[];
    relatedText?: string;
  };

  const mergeAnnotationRegion = (kept: AnnotationPixelRegion, duplicate: AnnotationPixelRegion) => {
    if (duplicate.contents) {
      kept.contents = kept.contents && kept.contents !== duplicate.contents
        ? `${kept.contents}; ${duplicate.contents}`
        : duplicate.contents;
    }
    kept.isRedLike = kept.isRedLike || duplicate.isRedLike;
    kept.isDeleteLike = kept.isDeleteLike || duplicate.isDeleteLike;
    if (kept.color === "unknown" && duplicate.color !== "unknown") kept.color = duplicate.color;
    const related = [...(kept.relatedAnnotationIndices ?? []), duplicate.annotationIndex, ...(duplicate.relatedAnnotationIndices ?? [])]
      .filter((n) => Number.isFinite(n));
    if (related.length > 0) kept.relatedAnnotationIndices = Array.from(new Set(related)).sort((a, b) => a - b);
    if (duplicate.relatedText) {
      kept.relatedText = kept.relatedText && kept.relatedText !== duplicate.relatedText
        ? `${kept.relatedText}; ${duplicate.relatedText}`
        : duplicate.relatedText;
    } else if (duplicate.contents && duplicate.annotationIndex !== kept.annotationIndex) {
      kept.relatedText = kept.relatedText && kept.relatedText !== duplicate.contents
        ? `${kept.relatedText}; ${duplicate.contents}`
        : duplicate.contents;
    }
    if (!kept.rectPdf && duplicate.rectPdf) kept.rectPdf = duplicate.rectPdf;
    if (!kept.boxNorm && duplicate.boxNorm) kept.boxNorm = duplicate.boxNorm;
    if (!kept.verticesPdf && duplicate.verticesPdf) kept.verticesPdf = duplicate.verticesPdf;
    if (!kept.verticesNorm && duplicate.verticesNorm) kept.verticesNorm = duplicate.verticesNorm;
  };

  const dedupeAnnotationPixelRegions = (boxes: AnnotationPixelRegion[], maxBoxes: number): AnnotationPixelRegion[] => {
    const sorted = [...boxes].sort((a, b) => a.area - b.area);
    const out: AnnotationPixelRegion[] = [];
    for (const box of sorted) {
      let duplicateOf: AnnotationPixelRegion | null = null;
      for (const kept of out) {
        const inter = boxIntersectionArea(box, kept);
        if (inter <= 0) continue;
        const minArea = Math.max(1, Math.min(box.w * box.h, kept.w * kept.h));
        if (inter / minArea >= 0.9) {
          duplicateOf = kept;
          break;
        }
      }
      if (duplicateOf) {
        mergeAnnotationRegion(duplicateOf, box);
      } else {
        out.push({ ...box });
      }
      if (out.length >= maxBoxes) break;
    }
    return out.sort((a, b) => b.area - a.area);
  };

  const buildAnnotationPixelRegions = (meta: { width: number; height: number }) =>
    annotationNormBoxesPage1.length > 0
      ? dedupeAnnotationPixelRegions(
          annotationNormBoxesPage1
            .map((n): AnnotationPixelRegion | null => {
              const raw = normalizedRectToPixelBox({
                norm: { minX: n.minX, minY: n.minY, maxX: n.maxX, maxY: n.maxY },
                imageWidth: meta.width,
                imageHeight: meta.height,
                minMarginPx: 10
              });
              if (!raw) return null;
              const clamped = clampPixelBoxToImage(raw, meta.width, meta.height);
              if (!clamped) return null;
              return {
                ...clamped,
                page: n.page,
                annotationIndex: n.annotationIndex,
                ...(n.annotationId ? { annotationId: n.annotationId } : {}),
                subtype: n.subtype,
                color: n.color,
                isRedLike: n.isRedLike,
                isDeleteLike: n.isDeleteLike,
                ...(n.contents ? { contents: n.contents } : {}),
                ...(n.rectPdf ? { rectPdf: n.rectPdf } : {}),
                ...(n.boxNorm ? { boxNorm: n.boxNorm } : {}),
                ...(n.verticesPdf ? { verticesPdf: n.verticesPdf } : {}),
                ...(n.verticesNorm ? { verticesNorm: n.verticesNorm } : {}),
                ...(n.relatedAnnotationIndices ? { relatedAnnotationIndices: n.relatedAnnotationIndices } : {}),
                ...(n.relatedText ? { relatedText: n.relatedText } : {})
              };
            })
            .filter((b): b is AnnotationPixelRegion => !!b),
          24
        )
      : [];

  const converted = await bestEffortConvertPdfToJpegPages({
    fullPdfPath: args.fullPath,
    pageStart: firstPage,
    maxPages: Math.max(1, Math.min(2, args.maxPages)),
    dpi: redlinePdfDpi(),
    timeoutMs: 45_000,
    allowAutoInstall
  });
  if (converted.ok && converted.page_paths.length > 0) {
    const previewPath = converted.page_paths[0]!;
    try {
      const previewFull = resolveExistingFileUnderWorkspace(previewPath);
      const dims = readImageDimensionsFast(previewFull);
      if (dims) imageMeta = dims;
      const meta = imageMeta;
      const annotationPixelRegions = meta ? buildAnnotationPixelRegions(meta) : [];
      const annotationPixelBoxes = annotationPixelRegions.map((r) => ({
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        area: r.area
      }));
      if (meta && annotationPixelRegions.length > 1) {
        annotationGroups = groupNearbyRegions({
          regions: annotationPixelRegions.map((r, idx) => ({
            index: idx + 1,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h
          })),
          imageWidth: meta.width,
          imageHeight: meta.height
        });
      }
      const annotationGroupByRegion = new Map<number, number>();
      for (const g of annotationGroups) {
        for (const idx of g.region_indices) {
          if (!annotationGroupByRegion.has(idx)) annotationGroupByRegion.set(idx, g.group_index);
        }
      }

      // 1) Prefer deterministic baseline diff when possible.
      if (baselineFullPath) {
        let baselineImageForDiff = "";
        const baselineExt = extLower(baselineFullPath);
        if (baselineExt === ".pdf") {
          const baselineConverted = await bestEffortConvertPdfToJpegPages({
            fullPdfPath: baselineFullPath,
            pageStart: firstPage,
            maxPages: 1,
            dpi: redlinePdfDpi(),
            timeoutMs: 45_000,
            allowAutoInstall
          });
          if (baselineConverted.ok && baselineConverted.page_paths.length > 0) {
            try {
              baselineImageForDiff = resolveExistingFileUnderWorkspace(baselineConverted.page_paths[0]!);
            } catch {
              baselineImageForDiff = "";
            }
          } else if (baselineConverted.warning) {
            preprocessingWarnings.push(`Baseline PDF convert warning: ${baselineConverted.warning}`);
          }
        } else if (baselineExt === ".png" || baselineExt === ".jpg" || baselineExt === ".jpeg" || baselineExt === ".bmp" || baselineExt === ".tif" || baselineExt === ".tiff") {
          baselineImageForDiff = baselineFullPath;
        } else {
          preprocessingWarnings.push(`Baseline file type unsupported for image diff: ${path.basename(baselineFullPath)}`);
        }

        if (baselineImageForDiff) {
          const diff = await bestEffortImageDiffBoxes(previewFull, baselineImageForDiff, 20_000);
          baselineDiff = diff;
          if (diff.ok && diff.compared && Array.isArray(diff.boxes)) {
            const sanitized = imageMeta
              ? sanitizeDiffBoxes(diff.boxes, imageMeta.width, imageMeta.height)
              : { boxes: dedupePixelBoxes(diff.boxes, 24) };
            if (sanitized.warning) preprocessingWarnings.push(sanitized.warning);
            let baselineBoxes = sanitized.boxes;
            if (baselineBoxes.length > 0 && annotationPixelBoxes.length > 0) {
              const overlapped = baselineBoxes.filter((b) => annotationPixelBoxes.some((ab) => boxesLikelyMatch(b, ab)));
              if (overlapped.length > 0) {
                baselineBoxes = overlapped;
              } else {
                baselineBoxes = [];
                preprocessingWarnings.push(
                  "Baseline diff boxes did not overlap PDF annotation metadata; ignored baseline diff to avoid reverting unrelated model changes."
                );
              }
            }
            if (baselineBoxes.length > 0) {
              markRegions = baselineBoxes.map((b, idx) => ({
                index: idx + 1,
                source: "baseline_diff" as const,
                x: b.x,
                y: b.y,
                w: b.w,
                h: b.h,
                area: b.area
              }));
            }
          }
        }
      }

      // 2) If no baseline regions, use explicit PDF annotation rectangles (captures non-red text/ink too).
      if (markRegions.length === 0 && annotationPixelBoxes.length > 0) {
        if (annotationPixelBoxes.length > 0) {
          markRegions = annotationPixelRegions.map((b, idx) => ({
            index: idx + 1,
            source: "pdf_annotation" as const,
            x: b.x,
            y: b.y,
            w: b.w,
            h: b.h,
            area: b.area,
            annotation_subtype: b.subtype,
            annotation_color: b.color,
            annotation_is_red_like: b.isRedLike,
            annotation_is_delete_like: b.isDeleteLike,
            annotation_page: b.page,
            annotation_index: b.annotationIndex,
            ...(b.annotationId ? { annotation_id: b.annotationId } : {}),
            ...(b.rectPdf ? { annotation_rect_pdf: b.rectPdf } : {}),
            ...(b.boxNorm ? { annotation_box_norm: b.boxNorm } : {}),
            ...(b.verticesPdf ? { annotation_vertices_pdf: b.verticesPdf } : {}),
            ...(b.verticesNorm ? { annotation_vertices_norm: b.verticesNorm } : {}),
            ...(b.contents ? { annotation_contents: b.contents } : {}),
            ...(b.relatedAnnotationIndices ? { annotation_related_indices: b.relatedAnnotationIndices } : {}),
            ...(b.relatedText ? { annotation_related_text: b.relatedText } : {}),
            ...(annotationGroupByRegion.has(idx + 1) ? { related_group: annotationGroupByRegion.get(idx + 1)! } : {})
          }));
        }
      }

      // 3) Last resort fallback: color-based red-pixel detection.
      if (markRegions.length === 0) {
        const detected = await bestEffortDetectRedMarkupBoxes({
          fullImagePath: previewFull,
          timeoutMs: 25_000,
          allowAutoInstall
        });
        if (detected.ok && detected.boxes.length > 0) {
          const normalized = dedupePixelBoxes(detected.boxes, 24).map((b, idx) => ({
            index: idx + 1,
            source: "red_markup_detect" as const,
            x: b.x,
            y: b.y,
            w: b.w,
            h: b.h,
            area: b.area
          }));
          markRegions = normalized;
        } else if (detected.warning) {
          preprocessingWarnings.push(detected.warning);
        }
      }

      const rendered =
        markRegions.length > 0
          ? await bestEffortRenderImageRegions({
              fullPath: previewFull,
              regions: markRegions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, area: r.area })),
              timeoutMs: 20_000,
              allowAutoInstall
            })
          : { crop_paths: [] as string[] };
      if (rendered.warning) preprocessingWarnings.push(rendered.warning);

      if (meta && routeCandidates.length > 0) {
        const routeCropPairs = routeCandidates
          .map((candidate, candidateIndex) => {
            const raw = normalizedRectToPixelBox({
              norm: candidate.box_norm,
              imageWidth: meta.width,
              imageHeight: meta.height,
              minMarginPx: Math.round(Math.max(meta.width, meta.height) * 0.08)
            });
            if (!raw) return null;
            const expanded = {
              x: raw.x,
              y: raw.y,
              w: raw.w,
              h: raw.h,
              area: raw.w * raw.h
            };
            const clamped = clampPixelBoxToImage(expanded, meta.width, meta.height);
            if (!clamped) return null;
            return { candidateIndex, region: clamped };
          })
          .filter((r): r is { candidateIndex: number; region: { x: number; y: number; w: number; h: number; area: number } } => !!r)
          .slice(0, 6);
        const routeCropRegions = routeCropPairs.map((p) => p.region);
        if (routeCropRegions.length > 0) {
          const routeRendered = await bestEffortRenderImageRegions({
            fullPath: previewFull,
            regions: routeCropRegions,
            timeoutMs: 20_000,
            allowAutoInstall
          });
          if (routeRendered.warning) preprocessingWarnings.push(routeRendered.warning);
          for (let i = 0; i < routeRendered.crop_paths.length && i < routeCropPairs.length; i++) {
            const pair = routeCropPairs[i]!;
            const candidate = routeCandidates[pair.candidateIndex];
            if (!candidate) continue;
            candidate.alignment_image_path = routeRendered.crop_paths[i];
            candidate.alignment_crop_norm = {
              minX: pair.region.x / meta.width,
              minY: pair.region.y / meta.height,
              maxX: (pair.region.x + pair.region.w) / meta.width,
              maxY: (pair.region.y + pair.region.h) / meta.height
            };
          }
        }
      }

      visionArtifacts = {
        preview_image_path: previewPath,
        ...(rendered.annotated_path ? { annotated_image_path: rendered.annotated_path } : {}),
        ...(rendered.crop_paths.length > 0 ? { crop_image_paths: rendered.crop_paths } : {}),
        ...(preprocessingWarnings.length > 0 ? { warning: truncate(preprocessingWarnings.join(" | "), 280) } : {})
      };
    } catch {
      // preview/detection is best-effort; continue with text + annotation analysis
      visionArtifacts = {
        preview_image_path: previewPath
      };
    }
  }

  if (!imageMeta && pdfPageImageMeta) {
    imageMeta = pdfPageImageMeta;
  }

  if (markRegions.length === 0 && imageMeta && annotationNormBoxesPage1.length > 0) {
    const annotationPixelRegions = buildAnnotationPixelRegions(imageMeta);
    if (annotationPixelRegions.length > 1 && annotationGroups.length === 0) {
      annotationGroups = groupNearbyRegions({
        regions: annotationPixelRegions.map((r, idx) => ({
          index: idx + 1,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h
        })),
        imageWidth: imageMeta.width,
        imageHeight: imageMeta.height
      });
    }
    const annotationGroupByRegion = new Map<number, number>();
    for (const g of annotationGroups) {
      for (const idx of g.region_indices) {
        if (!annotationGroupByRegion.has(idx)) annotationGroupByRegion.set(idx, g.group_index);
      }
    }
    markRegions = annotationPixelRegions.map((b, idx) => ({
      index: idx + 1,
      source: "pdf_annotation" as const,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      area: b.area,
      annotation_subtype: b.subtype,
      annotation_color: b.color,
      annotation_is_red_like: b.isRedLike,
      annotation_is_delete_like: b.isDeleteLike,
      annotation_page: b.page,
      annotation_index: b.annotationIndex,
      ...(b.annotationId ? { annotation_id: b.annotationId } : {}),
      ...(b.rectPdf ? { annotation_rect_pdf: b.rectPdf } : {}),
      ...(b.boxNorm ? { annotation_box_norm: b.boxNorm } : {}),
      ...(b.verticesPdf ? { annotation_vertices_pdf: b.verticesPdf } : {}),
      ...(b.verticesNorm ? { annotation_vertices_norm: b.verticesNorm } : {}),
      ...(b.contents ? { annotation_contents: b.contents } : {}),
      ...(b.relatedAnnotationIndices ? { annotation_related_indices: b.relatedAnnotationIndices } : {}),
      ...(b.relatedText ? { annotation_related_text: b.relatedText } : {}),
      ...(annotationGroupByRegion.has(idx + 1) ? { related_group: annotationGroupByRegion.get(idx + 1)! } : {})
    }));
    if (!converted.ok && converted.warning) {
      preprocessingWarnings.push(`Using PDF annotation geometry fallback because raster conversion failed: ${converted.warning}`);
    }
  }

  const hints: string[] = [];
  hints.push(
    coverage.complete
      ? `PDF package coverage complete: processed ${coverage.processed_page_count}/${coverage.page_count} page(s).`
      : `PDF package coverage partial: processed ${coverage.processed_ranges.join(", ") || "none"}; omitted ${coverage.omitted_ranges.join(", ") || "none"}.`
  );
  if (primary) {
    hints.push(`Likely sheet candidate: ${primary}. Confirm with /revit/sheets action=detail.`);
    if (filenamePrimary && primary === filenamePrimary) {
      hints.push(`Filename hint matched ${filenamePrimary}; prefer this anchor when cover/index text references other sheets.`);
    } else if (filenamePrimary) {
      hints.push(`Filename suggests ${filenamePrimary}; compare against text-derived candidate ${primary} and resolve explicitly via /revit/sheets detail.`);
    }
    hints.push("Use /revit/sheets detail with includeViewportGeometry=true to map sheet-space marks to placed views.");
  } else {
    hints.push("No strong sheet number detected from PDF text; use /revit/sheets list/query and user hint to resolve sheet.");
  }
  if (converted.warning) {
    hints.push(`PDF page rasterization warning: ${converted.warning}`);
  } else if (converted.ok && converted.page_paths.length > 0) {
    hints.push("Rasterized PDF page preview generated for visual redline understanding.");
  }
  if (baselineRelativePath) {
    hints.push(
      `Baseline compare source: ${baselineRelativePath}${baselineAutoPicked ? " (auto-discovered from artifacts/prints)" : ""}.`
    );
  }
  if (baselineDiff?.ok && baselineDiff.compared && Array.isArray(baselineDiff.boxes) && baselineDiff.boxes.length === 0) {
    hints.push("Baseline compare found no pixel differences on the analyzed page.");
  } else if (baselineDiff?.error) {
    hints.push(`Baseline compare warning: ${baselineDiff.error}`);
  }

  const baselineCount = markRegions.filter((r) => r.source === "baseline_diff").length;
  const annotationCount = markRegions.filter((r) => r.source === "pdf_annotation").length;
  const annotationDeleteLikeCount = markRegions.filter((r) => r.source === "pdf_annotation" && r.annotation_is_delete_like === true).length;
  const fallbackColorCount = markRegions.filter((r) => r.source === "red_markup_detect").length;
  if (baselineCount > 0) {
    hints.push(`Detected ${baselineCount} markup region(s) using baseline image diff against the clean sheet.`);
    if (annotationMarkupCountPage1 > 0) {
      hints.push("Safety gate: accepted baseline regions only where they overlapped PDF annotation metadata.");
    }
  } else if (annotationCount > 0) {
    hints.push(
      `Detected ${annotationCount} markup region(s) from PDF annotation metadata${annotationMarkupCountPage1 > 0 ? ` (page-1 markup annotations: ${annotationMarkupCountPage1})` : ""}.`
    );
    if (annotationDeleteLikeCount > 0) {
      hints.push(`Detected ${annotationDeleteLikeCount} delete-like annotation region(s) (strike/remove intent).`);
    }
    if (annotationGroups.length > 0) {
      hints.push(`Grouped ${annotationGroups.length} nearby annotation cluster(s) to preserve multi-mark context.`);
    }
  } else if (fallbackColorCount > 0) {
    hints.push(
      `Fallback color-based detection found ${fallbackColorCount} red region(s); review carefully because native red content can produce false positives.`
    );
  } else if (converted.ok && converted.page_paths.length > 0) {
    hints.push("No markup regions were automatically detected; fallback to Gemini visual intent extraction on the preview image.");
  }
  hints.push("For view-level markups, use /revit/export-view-frame and /revit/pick-at-pixel after identifying the target viewport/view.");

  const calls: RedlineAnalyzeResponse["suggested_revit_calls"] = [];
  if (primary) {
    calls.push({
      method: "POST",
      path: "/revit/sheets",
      body: {
        action: "detail",
        sheetNumber: primary,
        includePlacedViews: true,
        includeViewports: true,
        includeViewportGeometry: true,
        includeTitleBlocks: true
      }
    });
    calls.push({
      method: "POST",
      path: "/revit/get-titleblock-info",
      body: { sheetNumber: primary }
    });
  }

  return {
    ok: true,
    file_path: args.relativePath,
    full_path: args.fullPath,
    kind: "pdf",
    bytes: bytes.length,
    page_count: pageCount,
    page_coverage: coverage,
    pdf_package: {
      native_comment_count: pdfAnnotations.length,
      native_comment_pages: Array.from(new Set(pdfAnnotations.map((annotation) => annotation.page))).sort((a, b) => a - b),
      visual_batch_size: 8,
      visual_batches: buildPdfPageBatches(coverage.processed_page_count, coverage.processed_page_count, 8).map((batch) => ({
        ...batch,
        page_start: batch.page_start + coverage.requested_page_start - 1,
        page_end: batch.page_end + coverage.requested_page_start - 1
      })),
      visual_analysis_status: coverage.processed_page_count > 0 ? "pending" : "not_required"
    },
    likely_sheet: likelySheet,
    primary_sheet_number: primary,
    sheet_candidates: merged,
    pages: pageSummaries,
    ...(baselineDiff ? { baseline_diff: baselineDiff } : {}),
    ...(imageMeta ? { image_meta: imageMeta } : {}),
    ...(markRegions.length > 0 ? { mark_regions: markRegions } : {}),
    ...(annotationGroups.length > 0 ? { annotation_groups: annotationGroups } : {}),
    ...(routeCandidates.length > 0 ? { route_candidates: routeCandidates } : {}),
    ...(pdfAnnotations.length > 0 ? { pdf_annotations: pdfAnnotations } : {}),
    ...(visionArtifacts ? { vision_artifacts: visionArtifacts } : {}),
    orientation_hints: hints,
    suggested_revit_calls: calls
  };
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
      const child = spawn(exe, argvFor(exe), { stdio: "pipe", env: process.env });
      let stdout = "";
      let stderr = "";
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve({ ok: false, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms.`.trim() });
      }, Math.max(800, timeoutMs));

      child.stdout.on("data", d => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", d => {
        stderr += d.toString("utf8");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        const msg = e instanceof Error ? e.message : String(e);
        // Try next candidate when executable is missing.
        if (/ENOENT|not found|cannot find/i.test(msg)) return next();
        resolve({ ok: false, stdout, stderr: `${stderr}\n${msg}`.trim() });
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

async function bestEffortImageDiffBoxes(aPath: string, bPath: string, timeoutMs: number): Promise<NonNullable<RedlineAnalyzeResponse["baseline_diff"]>> {
  const py = `
import json
import sys
try:
    from PIL import Image, ImageChops
except Exception as e:
    print(json.dumps({"ok": False, "compared": False, "error": f"PIL not available: {e}"}))
    sys.exit(0)

a_path = ${JSON.stringify(aPath)}
b_path = ${JSON.stringify(bPath)}
try:
    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
except Exception as e:
    print(json.dumps({"ok": False, "compared": False, "error": str(e)}))
    sys.exit(0)

if b.size != a.size:
    b = b.resize(a.size)

diff = ImageChops.difference(a, b)
gray = diff.convert("L")
bw = gray.point(lambda p: 255 if p > 28 else 0)
bbox = bw.getbbox()
if bbox is None:
    print(json.dumps({"ok": True, "compared": True, "boxes": []}))
    sys.exit(0)

pix = bw.load()
w, h = bw.size
visited = set()
boxes = []
dirs = ((1,0),(-1,0),(0,1),(0,-1))
for y in range(h):
    for x in range(w):
        if pix[x,y] == 0:
            continue
        key = (x,y)
        if key in visited:
            continue
        stack = [key]
        visited.add(key)
        minx = maxx = x
        miny = maxy = y
        area = 0
        while stack:
            cx, cy = stack.pop()
            area += 1
            if cx < minx: minx = cx
            if cy < miny: miny = cy
            if cx > maxx: maxx = cx
            if cy > maxy: maxy = cy
            for dx,dy in dirs:
                nx, ny = cx + dx, cy + dy
                if nx < 0 or ny < 0 or nx >= w or ny >= h:
                    continue
                if pix[nx,ny] == 0:
                    continue
                nk = (nx,ny)
                if nk in visited:
                    continue
                visited.add(nk)
                stack.append(nk)
        bw0 = maxx - minx + 1
        bh0 = maxy - miny + 1
        if bw0 * bh0 < 90:
            continue
        boxes.append({"x": int(minx), "y": int(miny), "w": int(bw0), "h": int(bh0), "area": int(area)})

boxes.sort(key=lambda b: b["area"], reverse=True)
print(json.dumps({"ok": True, "compared": True, "boxes": boxes[:24]}))
`;
  const r = await runPythonJson(py, timeoutMs);
  if (!r.ok && !r.stdout.trim()) {
    return { ok: false, compared: false, error: truncate(r.stderr || "Diff failed.", 300) };
  }
  try {
    const parsed = JSON.parse(r.stdout.trim()) as any;
    if (!parsed || typeof parsed !== "object") return { ok: false, compared: false, error: "Invalid diff JSON output." };
    const boxes: Array<{ x: number; y: number; w: number; h: number; area: number }> = Array.isArray(parsed.boxes)
      ? (parsed.boxes as any[])
          .map((b: any) => ({
            x: Number(b?.x),
            y: Number(b?.y),
            w: Number(b?.w),
            h: Number(b?.h),
            area: Number(b?.area)
          }))
          .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h) && b.w > 0 && b.h > 0)
      : [];
    return {
      ok: !!parsed.ok,
      compared: !!parsed.compared,
      ...(typeof parsed.error === "string" && parsed.error.trim() ? { error: truncate(parsed.error, 280) } : {}),
      boxes
    };
  } catch {
    return { ok: false, compared: false, error: truncate(r.stdout || r.stderr || "Diff parse failed.", 320) };
  }
}

async function bestEffortEstimateWallLocalChainages(args: {
  fullImagePath: string;
  boxes: Array<{ x: number; y: number; w: number; h: number; area: number }>;
  timeoutMs: number;
}): Promise<Array<{ normalized_chainage: number; axis: "vertical" | "horizontal"; span_px: [number, number] } | null>> {
  const jsPngEstimates = estimateWallLocalChainagesFromPng(args.fullImagePath, args.boxes);
  if (jsPngEstimates && jsPngEstimates.some((row) => !!row)) return jsPngEstimates;

  const payload = JSON.stringify({
    image_path: args.fullImagePath,
    boxes: args.boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
  });
  const py = String.raw`
import json, math, sys

try:
    from PIL import Image
except Exception as e:
    print(json.dumps({"ok": False, "error": f"PIL not available: {e}"}))
    sys.exit(0)

req = json.loads(${JSON.stringify(payload)})
img = Image.open(req["image_path"]).convert("RGB")
w, h = img.size
pix = img.load()

def is_redish(rgb):
    r, g, b = rgb
    return r > 140 and r > g * 1.5 and r > b * 1.5 and g < 125 and b < 125

def is_structure(rgb):
    if is_redish(rgb):
        return False
    r, g, b = rgb
    mx = max(r, g, b)
    mn = min(r, g, b)
    return mx < 235 and (mx - mn) < 48

def infer_side(cx, cy):
    nx = cx / max(1, w)
    ny = cy / max(1, h)
    candidates = [("left", nx), ("right", 1 - nx), ("top", ny), ("bottom", 1 - ny)]
    candidates.sort(key=lambda item: item[1])
    return candidates[0][0]

def runs_from_positions(vals):
    if not vals:
        return []
    runs = []
    s = prev = vals[0]
    for v in vals[1:]:
        if v <= prev + 2:
            prev = v
        else:
            if prev - s >= 12:
                runs.append([s, prev])
            s = prev = v
    if prev - s >= 12:
        runs.append([s, prev])
    return runs

def merge_runs(runs, gap):
    merged = []
    for a, b in runs:
        if not merged or a - merged[-1][1] > gap:
            merged.append([a, b])
        else:
            merged[-1][1] = b
    return merged

def estimate_for_box(box):
    x = float(box.get("x", 0))
    y = float(box.get("y", 0))
    bw = max(1.0, float(box.get("w", 0)))
    bh = max(1.0, float(box.get("h", 0)))
    cx = x + bw * 0.5
    cy = y + bh * 0.5
    side = infer_side(cx, cy)
    vertical = side in ("left", "right")
    search = int(max(90, min(180, (h if vertical else w) * 0.18)))
    gap = int(max(24, min(55, (h if vertical else w) * 0.06)))
    contain_pad = max(20.0, bh if vertical else bw)
    min_span = max(80.0, (h if vertical else w) * 0.12)
    cands = []
    if vertical:
        start = max(0, int(cx) - search)
        end = min(w - 1, int(cx) + search)
        for xx in range(start, end + 1):
            vals = [yy for yy in range(h) if is_structure(pix[xx, yy])]
            merged = merge_runs(runs_from_positions(vals), gap)
            for a, b in merged:
                span = b - a
                if span < min_span:
                    continue
                if not (a <= cy + contain_pad and b >= cy - contain_pad):
                    continue
                side_penalty = 0
                if side == "left" and xx > cx + bw * 0.4:
                    side_penalty = 35
                if side == "right" and xx < cx - bw * 0.4:
                    side_penalty = 35
                raw_norm = (cy - a) / max(1.0, span)
                if raw_norm < -0.02 or raw_norm > 1.02:
                    continue
                score = abs(xx - cx) + side_penalty - span * 0.01
                norm = max(0.04, min(0.96, raw_norm))
                cands.append((score, norm, [int(a), int(b)], "vertical"))
    else:
        start = max(0, int(cy) - search)
        end = min(h - 1, int(cy) + search)
        for yy in range(start, end + 1):
            vals = [xx for xx in range(w) if is_structure(pix[xx, yy])]
            merged = merge_runs(runs_from_positions(vals), gap)
            for a, b in merged:
                span = b - a
                if span < min_span:
                    continue
                if not (a <= cx + contain_pad and b >= cx - contain_pad):
                    continue
                side_penalty = 0
                if side == "top" and yy > cy + bh * 0.4:
                    side_penalty = 35
                if side == "bottom" and yy < cy - bh * 0.4:
                    side_penalty = 35
                raw_norm = (cx - a) / max(1.0, span)
                if raw_norm < -0.02 or raw_norm > 1.02:
                    continue
                score = abs(yy - cy) + side_penalty - span * 0.01
                norm = max(0.04, min(0.96, raw_norm))
                cands.append((score, norm, [int(a), int(b)], "horizontal"))
    if not cands:
        return None
    cands.sort(key=lambda item: item[0])
    _, norm, span, axis = cands[0]
    return {"normalized_chainage": round(float(norm), 6), "span_px": span, "axis": axis}

out = [estimate_for_box(b) for b in req.get("boxes", [])]
print(json.dumps({"ok": True, "estimates": out}))
`;
  const r = await runPythonJson(py, Math.max(3_000, args.timeoutMs));
  if (!r.ok || !r.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(r.stdout.trim()) as any;
    if (!parsed?.ok || !Array.isArray(parsed.estimates)) return [];
    return parsed.estimates.map((row: any) => {
      const n = toFiniteNumber(row?.normalized_chainage);
      const axis = row?.axis === "vertical" || row?.axis === "horizontal" ? row.axis : null;
      const span = Array.isArray(row?.span_px) ? row.span_px : [];
      const a = toFiniteNumber(span[0]);
      const b = toFiniteNumber(span[1]);
      if (n === null || !axis || a === null || b === null) return null;
      return {
        normalized_chainage: Math.max(0.04, Math.min(0.96, Number(n.toFixed(6)))),
        axis,
        span_px: [Math.round(a), Math.round(b)] as [number, number]
      };
    });
  } catch {
    return [];
  }
}

async function analyzeImage(args: {
  fullPath: string;
  relativePath: string;
  expectedSheet?: string;
  includeOcr: boolean;
  timeoutMs: number;
  baselinePath?: string;
}): Promise<RedlineAnalyzeResponse> {
  const st = fs.statSync(args.fullPath);
  const allowAutoInstall = redlinePdfAutoInstallEnabled();
  const imageMeta = readImageDimensionsFast(args.fullPath);
  const textCandidates: RedlineSheetCandidate[] = extractSheetCandidatesFromFilename({
    filePath: args.relativePath,
    expectedSheet: args.expectedSheet,
    maxCandidates: 6
  });
  let ocrBlock: RedlineAnalyzeResponse["ocr"] | undefined;
  if (args.includeOcr) {
    const o = await ocrImage({
      image_path: args.relativePath,
      kind: "text",
      expected: null,
      timeout_ms: args.timeoutMs
    });
    if (o.ok) {
      const excerpt = truncate(o.text, 1500);
      ocrBlock = { ok: true, text_excerpt: excerpt, text_chars: o.text.length };
      textCandidates.push(
        ...extractSheetCandidatesFromText({
          text: o.text,
          expectedSheet: args.expectedSheet,
          maxCandidates: 12
        })
      );
    } else {
      ocrBlock = {
        ok: false,
        text_excerpt: "",
        text_chars: 0,
        ...(o.error ? { error: truncate(o.error, 240) } : {})
      };
    }
  }

  const merged = mergeSheetCandidates(textCandidates, 20);
  const primary = merged.length > 0 ? merged[0]!.sheet_number : null;
  const likelySheet = merged.length > 0 && (merged[0]!.score >= 24 || merged[0]!.hit_count >= 2);
  const filenamePrimary = textCandidates.find((c) => c.source === "filename")?.sheet_number ?? null;

  let baselineDiff: RedlineAnalyzeResponse["baseline_diff"] | undefined;
  if (args.baselinePath) {
    baselineDiff = await bestEffortImageDiffBoxes(args.fullPath, args.baselinePath, Math.max(4_000, args.timeoutMs));
  }
  let regionSource: "baseline_diff" | "red_markup_detect" = "baseline_diff";
  let regionBoxes =
    baselineDiff?.ok && baselineDiff.compared && Array.isArray(baselineDiff.boxes)
      ? baselineDiff.boxes
          .map((b) => ({
            x: Number(b.x),
            y: Number(b.y),
            w: Number(b.w),
            h: Number(b.h),
            area: Number(b.area)
          }))
          .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h) && b.w > 0 && b.h > 0)
          .sort((a, b) => b.area - a.area)
          .slice(0, 24)
      : [];
  const preprocessingWarnings: string[] = [];
  if (regionBoxes.length === 0) {
    const detected = await bestEffortDetectRedMarkupBoxes({
      fullImagePath: args.fullPath,
      timeoutMs: Math.max(5_000, args.timeoutMs),
      allowAutoInstall
    });
    if (detected.ok && detected.boxes.length > 0) {
      regionSource = "red_markup_detect";
      regionBoxes = dedupePixelBoxes(detected.boxes, 24);
    } else if (detected.warning) {
      preprocessingWarnings.push(detected.warning);
    }
  }
  const wallLocalChainages =
    regionBoxes.length > 0
      ? await bestEffortEstimateWallLocalChainages({
          fullImagePath: args.fullPath,
          boxes: regionBoxes,
          timeoutMs: Math.max(3_000, args.timeoutMs)
        })
      : [];
  const markRegions =
    regionBoxes.length > 0
      ? regionBoxes.map((b, idx) => ({
          index: idx + 1,
          source: regionSource,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          area: b.area,
          ...(wallLocalChainages[idx]?.normalized_chainage !== undefined
            ? {
                wall_local_normalized_chainage: wallLocalChainages[idx]!.normalized_chainage,
                wall_local_axis: wallLocalChainages[idx]!.axis,
                wall_local_span_px: wallLocalChainages[idx]!.span_px,
                wall_local_source: "nearby_visible_wall_line" as const
              }
            : {})
        }))
      : [];
  const visionArtifacts =
    regionBoxes.length > 0
      ? await bestEffortRenderImageRegions({
          fullPath: args.fullPath,
          regions: regionBoxes,
          timeoutMs: Math.max(5_000, args.timeoutMs),
          allowAutoInstall
        })
      : { crop_paths: [] as string[] };

  const hints: string[] = [];
  if (primary) {
    hints.push(`Likely sheet candidate from filename/OCR: ${primary}.`);
    if (filenamePrimary && primary === filenamePrimary) {
      hints.push(`Filename hint matched ${filenamePrimary}; use that as the default sheet anchor unless contradictory evidence appears.`);
    }
  } else {
    hints.push("No strong sheet number detected in image OCR. Confirm sheet using filename, user hint, or /revit/sheets query.");
  }
  if (baselineDiff?.ok && baselineDiff.compared && Array.isArray(baselineDiff.boxes) && baselineDiff.boxes.length > 0) {
    hints.push("Baseline diff boxes detected; map these regions to sheet/view geometry from /revit/sheets detail.");
    hints.push("Use map_sheet_regions with image dimensions + region boxes to classify viewport vs titleblock intent.");
  } else if (args.baselinePath) {
    hints.push("Baseline diff was unavailable or empty; use visual review plus /revit/sheets detail and pick-at-pixel workflow.");
  }
  if (regionSource === "red_markup_detect" && regionBoxes.length > 0) {
    hints.push("Fallback color-based detection found red mark regions in the uploaded image; map these regions to sheet/view geometry.");
  }
  if (visionArtifacts.annotated_path || (visionArtifacts.crop_paths ?? []).length > 0) {
    hints.push("Generated marked-region preview/crops; inspect visually and convert each region intent into a concrete Revit action plan.");
  }
  if (preprocessingWarnings.length > 0) {
    hints.push(`Image preprocessing warning: ${truncate(preprocessingWarnings.join(" | "), 240)}`);
  }

  const calls: RedlineAnalyzeResponse["suggested_revit_calls"] = [];
  if (primary) {
    calls.push({
      method: "POST",
      path: "/revit/sheets",
      body: {
        action: "detail",
        sheetNumber: primary,
        includePlacedViews: true,
        includeViewports: true,
        includeViewportGeometry: true,
        includeTitleBlocks: true
      }
    });
  }

  return {
    ok: true,
    file_path: args.relativePath,
    full_path: args.fullPath,
    kind: "image",
    bytes: st.size,
    ...(imageMeta ? { image_meta: imageMeta } : {}),
    likely_sheet: likelySheet,
    primary_sheet_number: primary,
    sheet_candidates: merged,
    ...(ocrBlock ? { ocr: ocrBlock } : {}),
    ...(baselineDiff ? { baseline_diff: baselineDiff } : {}),
    ...(markRegions.length > 0 ? { mark_regions: markRegions } : {}),
    ...(visionArtifacts.annotated_path || (visionArtifacts.crop_paths ?? []).length > 0 || visionArtifacts.warning
      ? {
          vision_artifacts: {
            ...(visionArtifacts.annotated_path ? { annotated_image_path: visionArtifacts.annotated_path } : {}),
            ...((visionArtifacts.crop_paths ?? []).length > 0 ? { crop_image_paths: visionArtifacts.crop_paths } : {}),
            ...(visionArtifacts.warning ? { warning: visionArtifacts.warning } : {})
          }
        }
      : {}),
    orientation_hints: hints,
    suggested_revit_calls: calls
  };
}

export async function analyzeRedlineFile(req: RedlineAnalyzeRequest): Promise<RedlineAnalyzeResponse> {
  let relative = (req.file_path ?? "").trim();
  if (!relative) {
    return {
      ok: false,
      file_path: "",
      full_path: "",
      kind: "unknown",
      bytes: 0,
      likely_sheet: false,
      primary_sheet_number: null,
      sheet_candidates: [],
      orientation_hints: ["file_path is required."],
      suggested_revit_calls: [],
      warning: "Invalid request."
    };
  }

  let fullPath = "";
  try {
    fullPath = resolveExistingFileUnderWorkspace(relative);
  } catch (e) {
    const fallback = tryResolveUploadBasename(relative);
    if (fallback) {
      fullPath = fallback.fullPath;
      relative = fallback.relativePath;
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        file_path: relative,
        full_path: "",
        kind: "unknown",
        bytes: 0,
        likely_sheet: false,
        primary_sheet_number: null,
        sheet_candidates: [],
        orientation_hints: ["File must exist under Workspace path."],
        suggested_revit_calls: [],
        warning: truncate(msg, 240)
      };
    }
  }

  let baselineFullPath = "";
  if (typeof req.baseline_file_path === "string" && req.baseline_file_path.trim()) {
    try {
      baselineFullPath = resolveExistingFileUnderWorkspace(req.baseline_file_path.trim());
    } catch {
      const fallback = tryResolveUploadBasename(req.baseline_file_path.trim());
      if (fallback) {
        baselineFullPath = fallback.fullPath;
      } else {
        baselineFullPath = "";
      }
    }
  }

  const ext = extLower(fullPath);
  const maxPages = resolvePdfPageBudget(req.max_pages);
  const pageStart = resolvePdfPageStart(req.page_start);
  const includePdfAnnotations = req.include_pdf_annotations !== false;
  const includeOcrForImages = req.include_ocr_for_images !== false;
  const timeoutMs = Math.max(1500, Math.min(180_000, Number(req.timeout_ms ?? 20_000) || 20_000));
  const expectedSheet = normalizeSheetNumber(req.expected_sheet ?? "");

  try {
    if (ext === ".pdf") {
      return await analyzePdf({
        fullPath,
        relativePath: relative,
        expectedSheet: expectedSheet || undefined,
        maxPages,
        pageStart,
        includeAnnotations: includePdfAnnotations,
        baselinePath: baselineFullPath || undefined
      });
    }

    if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".bmp" || ext === ".tif" || ext === ".tiff") {
      return await analyzeImage({
        fullPath,
        relativePath: relative,
        expectedSheet: expectedSheet || undefined,
        includeOcr: includeOcrForImages,
        timeoutMs,
        baselinePath: baselineFullPath || undefined
      });
    }

    const st = fs.statSync(fullPath);
    return {
      ok: true,
      file_path: relative,
      full_path: fullPath,
      kind: "unknown",
      bytes: st.size,
      likely_sheet: false,
      primary_sheet_number: null,
      sheet_candidates: [],
      orientation_hints: [
        "Unsupported redline file type for deep analysis.",
        "Use PDF or image inputs (.pdf/.png/.jpg) for OCR + sheet orientation."
      ],
      suggested_revit_calls: []
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const ws = ensureWorkspaceLayout();
    return {
      ok: false,
      file_path: relative,
      full_path: fullPath,
      kind: "unknown",
      bytes: 0,
      likely_sheet: false,
      primary_sheet_number: null,
      sheet_candidates: [],
      orientation_hints: [`Analyzer failed. Workspace root: ${ws.root}`],
      suggested_revit_calls: [],
      warning: truncate(msg, 320)
    };
  }
}
