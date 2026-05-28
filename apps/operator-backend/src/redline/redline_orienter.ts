import {
  analyzeRedlineFile,
  type RedlineAnalyzeRequest,
  type RedlineAnalyzeResponse
} from "./redline_analyzer.js";
import { mapSheetRegions, type MapSheetRegionsResponse } from "./sheet_region_mapper.js";

type UvRect = { minU: number; minV: number; maxU: number; maxV: number };
type ViewportGeometry = {
  viewportId?: number | null;
  viewId?: number | null;
  rotation?: string | null;
  box?: Partial<UvRect> | null;
};
type TitleBlockGeometry = {
  elementId?: number | null;
  boundingBox?: Partial<UvRect> | null;
};

export type RedlineOrientRequest = RedlineAnalyzeRequest & {
  image_width?: number;
  image_height?: number;
  boxes?: Array<Record<string, unknown>>;
  sheet_outline?: Partial<UvRect>;
  viewport_geometry?: Array<ViewportGeometry & Record<string, unknown>>;
  title_blocks?: Array<TitleBlockGeometry & Record<string, unknown>>;
};

export type RedlineOrientResponse = {
  ok: boolean;
  analysis: RedlineAnalyzeResponse;
  mapping?: MapSheetRegionsResponse;
  orientation_hints: string[];
  suggested_revit_calls: Array<{
    method: "POST";
    path: string;
    body: Record<string, unknown>;
  }>;
  warning?: string;
};

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function dedupeCalls(calls: Array<{ method: "POST"; path: string; body: Record<string, unknown> }>): Array<{ method: "POST"; path: string; body: Record<string, unknown> }> {
  const out: Array<{ method: "POST"; path: string; body: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  for (const c of calls) {
    const key = `${c.method}|${c.path}|${JSON.stringify(c.body ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function coerceBoxes(raw: unknown): Array<{ x: number; y: number; w: number; h: number }> {
  const arr = Array.isArray(raw) ? raw : [];
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const x = toFiniteNumber((item as any).x);
    const y = toFiniteNumber((item as any).y);
    const w = toFiniteNumber((item as any).w);
    const h = toFiniteNumber((item as any).h);
    if (x === null || y === null || w === null || h === null) continue;
    if (w <= 0 || h <= 0) continue;
    out.push({ x, y, w, h });
  }
  return out;
}

export async function orientRedlineFile(req: RedlineOrientRequest): Promise<RedlineOrientResponse> {
  const analysis = await analyzeRedlineFile(req);

  const hints = [...(analysis.orientation_hints ?? [])];
  const suggested = [...(analysis.suggested_revit_calls ?? [])];
  if (!analysis.ok) {
    return {
      ok: false,
      analysis,
      orientation_hints: hints,
      suggested_revit_calls: dedupeCalls(suggested),
      warning: analysis.warning ?? "Redline analysis failed."
    };
  }

  const width = toFiniteNumber(req.image_width) ?? toFiniteNumber(analysis.image_meta?.width) ?? null;
  const height = toFiniteNumber(req.image_height) ?? toFiniteNumber(analysis.image_meta?.height) ?? null;
  const explicitBoxes = coerceBoxes(req.boxes);
  const markBoxes = Array.isArray(analysis.mark_regions)
    ? analysis.mark_regions
        .map(r => ({
          x: toFiniteNumber((r as any).x),
          y: toFiniteNumber((r as any).y),
          w: toFiniteNumber((r as any).w),
          h: toFiniteNumber((r as any).h)
        }))
        .filter(x => x.x !== null && x.y !== null && x.w !== null && x.h !== null && (x.w as number) > 0 && (x.h as number) > 0)
        .map(x => ({ x: x.x as number, y: x.y as number, w: x.w as number, h: x.h as number }))
    : [];
  const boxes = explicitBoxes.length > 0 ? explicitBoxes : markBoxes;

  const hasMappingInputs =
    !!(req.sheet_outline && typeof req.sheet_outline === "object") &&
    Array.isArray(req.viewport_geometry) &&
    req.viewport_geometry.length > 0;

  if (!hasMappingInputs) {
    if (boxes.length > 0) {
      hints.push("Found mark regions but no sheet mapping geometry was provided; call /revit/sheets detail with includeSheetOutline/includeViewportGeometry/includeTitleBlockGeometry, then re-run mapping.");
    } else {
      hints.push("No region boxes available for mapping. Use baseline_file_path for diff or inspect vision_artifacts manually.");
    }
    return {
      ok: true,
      analysis,
      orientation_hints: Array.from(new Set(hints)),
      suggested_revit_calls: dedupeCalls(suggested)
    };
  }

  if (width === null || height === null || width <= 1 || height <= 1) {
    hints.push("Sheet mapping skipped because image_width/image_height are missing and could not be inferred from analysis.");
    return {
      ok: true,
      analysis,
      orientation_hints: Array.from(new Set(hints)),
      suggested_revit_calls: dedupeCalls(suggested),
      warning: "Missing image dimensions for mapping."
    };
  }

  if (boxes.length === 0) {
    hints.push("Sheet mapping skipped because no boxes were supplied and no mark_regions were available.");
    return {
      ok: true,
      analysis,
      orientation_hints: Array.from(new Set(hints)),
      suggested_revit_calls: dedupeCalls(suggested),
      warning: "No mark boxes available for mapping."
    };
  }

  const mapping = mapSheetRegions({
    image_width: width,
    image_height: height,
    boxes,
    sheet_outline: req.sheet_outline ?? {},
    viewport_geometry: Array.isArray(req.viewport_geometry) ? req.viewport_geometry : [],
    title_blocks: Array.isArray(req.title_blocks) ? req.title_blocks : []
  });

  hints.push(...(mapping.orientation_hints ?? []));
  suggested.push(...(mapping.suggested_revit_calls ?? []));

  return {
    ok: analysis.ok && mapping.ok,
    analysis,
    mapping,
    orientation_hints: Array.from(new Set(hints)),
    suggested_revit_calls: dedupeCalls(suggested),
    ...(mapping.warning ? { warning: mapping.warning } : {})
  };
}

