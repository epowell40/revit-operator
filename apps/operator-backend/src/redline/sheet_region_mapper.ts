type UvRect = {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
};

type UvPoint = {
  u: number;
  v: number;
};

type PixelBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

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

export type MapSheetRegionsRequest = {
  image_width: number;
  image_height: number;
  boxes: Array<Partial<PixelBox> & Record<string, unknown>>;
  sheet_outline: Partial<UvRect>;
  viewport_geometry?: Array<ViewportGeometry & Record<string, unknown>>;
  title_blocks?: Array<TitleBlockGeometry & Record<string, unknown>>;
};

type RegionTargetKind = "viewport" | "titleblock" | "sheet";

type RegionTarget = {
  kind: RegionTargetKind;
  id: number | null;
  view_id: number | null;
  score: number;
  overlap_ratio: number;
  contains_center: boolean;
  center_distance_norm: number;
  reason: string;
  view_hint?: {
    normalized_x: number;
    normalized_y: number;
    rotation: string;
  };
};

type RegionMapping = {
  index: number;
  pixel_box: PixelBox;
  normalized_box: { minX: number; minY: number; maxX: number; maxY: number };
  sheet_box: UvRect;
  sheet_center: UvPoint;
  targets: RegionTarget[];
  primary_target: RegionTarget;
};

export type MapSheetRegionsResponse = {
  ok: boolean;
  image_width: number;
  image_height: number;
  sheet_outline: UvRect;
  regions: RegionMapping[];
  summary: {
    region_count: number;
    viewport_regions: number;
    titleblock_regions: number;
    sheet_regions: number;
    unique_view_ids: number[];
  };
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeRect(r: Partial<UvRect>): UvRect | null {
  const minU = toFiniteNumber(r.minU);
  const minV = toFiniteNumber(r.minV);
  const maxU = toFiniteNumber(r.maxU);
  const maxV = toFiniteNumber(r.maxV);
  if (minU === null || minV === null || maxU === null || maxV === null) return null;
  const loU = Math.min(minU, maxU);
  const hiU = Math.max(minU, maxU);
  const loV = Math.min(minV, maxV);
  const hiV = Math.max(minV, maxV);
  if (hiU - loU <= 1e-9 || hiV - loV <= 1e-9) return null;
  return { minU: loU, minV: loV, maxU: hiU, maxV: hiV };
}

function rectArea(r: UvRect): number {
  return Math.max(0, r.maxU - r.minU) * Math.max(0, r.maxV - r.minV);
}

function intersectArea(a: UvRect, b: UvRect): number {
  const minU = Math.max(a.minU, b.minU);
  const minV = Math.max(a.minV, b.minV);
  const maxU = Math.min(a.maxU, b.maxU);
  const maxV = Math.min(a.maxV, b.maxV);
  if (maxU <= minU || maxV <= minV) return 0;
  return (maxU - minU) * (maxV - minV);
}

function containsPoint(r: UvRect, p: UvPoint): boolean {
  return p.u >= r.minU && p.u <= r.maxU && p.v >= r.minV && p.v <= r.maxV;
}

function centerDistanceNorm(r: UvRect, p: UvPoint): number {
  if (containsPoint(r, p)) return 0;
  const du = p.u < r.minU ? r.minU - p.u : p.u > r.maxU ? p.u - r.maxU : 0;
  const dv = p.v < r.minV ? r.minV - p.v : p.v > r.maxV ? p.v - r.maxV : 0;
  const diag = Math.max(1e-9, Math.hypot(r.maxU - r.minU, r.maxV - r.minV));
  return Math.hypot(du, dv) / diag;
}

function scoreTarget(region: UvRect, center: UvPoint, target: UvRect, kind: RegionTargetKind): {
  score: number;
  overlapRatio: number;
  containsCenter: boolean;
  distanceNorm: number;
} {
  const overlap = intersectArea(region, target);
  const overlapRatio = overlap / Math.max(rectArea(region), 1e-9);
  const containsCenter = containsPoint(target, center);
  const distanceNorm = centerDistanceNorm(target, center);

  let score = 0;
  score += Math.min(1, overlapRatio) * 0.72;
  if (containsCenter) score += 0.22;
  score += Math.max(0, 0.10 - Math.min(0.10, distanceNorm * 0.10));
  if (kind === "viewport") score += 0.02;
  if (kind === "titleblock") score += 0.01;

  return {
    score: clamp(score, 0, 1),
    overlapRatio,
    containsCenter,
    distanceNorm
  };
}

function normalizeRotation(raw: string | null | undefined): "none" | "clockwise" | "counterclockwise" | "upsidedown" {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "none";
  if (s.includes("counterclockwise") || s.includes("counter_clockwise") || s.includes("ccw")) return "counterclockwise";
  if (s.includes("clockwise") || s.includes("cw")) return "clockwise";
  if (s.includes("upside") || s.includes("180")) return "upsidedown";
  return "none";
}

function mapSheetToViewNormalized(args: {
  center: UvPoint;
  viewport: UvRect;
  rotation: string | null | undefined;
}): { x: number; y: number; rotation: string } {
  const vw = Math.max(1e-9, args.viewport.maxU - args.viewport.minU);
  const vh = Math.max(1e-9, args.viewport.maxV - args.viewport.minV);
  const tx = clamp((args.center.u - args.viewport.minU) / vw, 0, 1); // left->right
  const ty = clamp((args.viewport.maxV - args.center.v) / vh, 0, 1); // top->bottom
  const rot = normalizeRotation(args.rotation);

  let x = tx;
  let y = ty;
  if (rot === "clockwise") {
    x = ty;
    y = 1 - tx;
  } else if (rot === "counterclockwise") {
    x = 1 - ty;
    y = tx;
  } else if (rot === "upsidedown") {
    x = 1 - tx;
    y = 1 - ty;
  }

  return {
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    rotation: rot
  };
}

function parsePixelBox(v: Partial<PixelBox>): PixelBox | null {
  const x = toFiniteNumber(v.x);
  const y = toFiniteNumber(v.y);
  const w = toFiniteNumber(v.w);
  const h = toFiniteNumber(v.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function mapPixelBoxToSheet(args: {
  box: PixelBox;
  imageWidth: number;
  imageHeight: number;
  sheet: UvRect;
}): { normalized: { minX: number; minY: number; maxX: number; maxY: number }; sheetBox: UvRect; center: UvPoint } {
  const x0 = clamp(args.box.x, 0, args.imageWidth);
  const y0 = clamp(args.box.y, 0, args.imageHeight);
  const x1 = clamp(args.box.x + args.box.w, 0, args.imageWidth);
  const y1 = clamp(args.box.y + args.box.h, 0, args.imageHeight);

  const minX = Math.min(x0, x1) / args.imageWidth;
  const maxX = Math.max(x0, x1) / args.imageWidth;
  const minY = Math.min(y0, y1) / args.imageHeight;
  const maxY = Math.max(y0, y1) / args.imageHeight;

  const su = args.sheet.minU;
  const sv = args.sheet.minV;
  const wu = args.sheet.maxU - args.sheet.minU;
  const hv = args.sheet.maxV - args.sheet.minV;

  const u0 = su + minX * wu;
  const u1 = su + maxX * wu;
  const vTop = args.sheet.maxV - minY * hv;
  const vBottom = args.sheet.maxV - maxY * hv;

  const sheetBox: UvRect = {
    minU: Math.min(u0, u1),
    maxU: Math.max(u0, u1),
    minV: Math.min(vBottom, vTop),
    maxV: Math.max(vBottom, vTop)
  };
  const center: UvPoint = {
    u: (sheetBox.minU + sheetBox.maxU) * 0.5,
    v: (sheetBox.minV + sheetBox.maxV) * 0.5
  };

  return {
    normalized: { minX, minY, maxX, maxY },
    sheetBox,
    center
  };
}

export function mapSheetRegions(req: MapSheetRegionsRequest): MapSheetRegionsResponse {
  const imageWidth = toFiniteNumber(req.image_width);
  const imageHeight = toFiniteNumber(req.image_height);
  if (imageWidth === null || imageHeight === null || imageWidth <= 1 || imageHeight <= 1) {
    return {
      ok: false,
      image_width: Number(req.image_width) || 0,
      image_height: Number(req.image_height) || 0,
      sheet_outline: { minU: 0, minV: 0, maxU: 0, maxV: 0 },
      regions: [],
      summary: { region_count: 0, viewport_regions: 0, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [] },
      orientation_hints: ["image_width and image_height must be positive numbers."],
      suggested_revit_calls: [],
      warning: "Invalid image dimensions."
    };
  }

  const sheet = normalizeRect(req.sheet_outline);
  if (!sheet) {
    return {
      ok: false,
      image_width: imageWidth,
      image_height: imageHeight,
      sheet_outline: { minU: 0, minV: 0, maxU: 0, maxV: 0 },
      regions: [],
      summary: { region_count: 0, viewport_regions: 0, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [] },
      orientation_hints: ["sheet_outline must include minU/minV/maxU/maxV."],
      suggested_revit_calls: [],
      warning: "Invalid sheet outline."
    };
  }

  const boxes = Array.isArray(req.boxes) ? req.boxes : [];
  const viewports = (Array.isArray(req.viewport_geometry) ? req.viewport_geometry : [])
    .map((v) => ({
      viewportId: toFiniteNumber(v.viewportId ?? null),
      viewId: toFiniteNumber(v.viewId ?? null),
      rotation: typeof v.rotation === "string" ? v.rotation : null,
      box: normalizeRect((v.box ?? {}) as Partial<UvRect>)
    }))
    .filter((v) => v.box !== null);
  const titleBlocks = (Array.isArray(req.title_blocks) ? req.title_blocks : [])
    .map((t) => ({
      elementId: toFiniteNumber(t.elementId ?? null),
      box: normalizeRect((t.boundingBox ?? {}) as Partial<UvRect>)
    }))
    .filter((t) => t.box !== null);

  const regions: RegionMapping[] = [];
  const viewIdSet = new Set<number>();

  for (let i = 0; i < boxes.length; i++) {
    const parsed = parsePixelBox(boxes[i] ?? {});
    if (!parsed) continue;

    const mapped = mapPixelBoxToSheet({ box: parsed, imageWidth, imageHeight, sheet });
    const targets: RegionTarget[] = [];

    for (const vp of viewports) {
      if (!vp.box) continue;
      const s = scoreTarget(mapped.sheetBox, mapped.center, vp.box, "viewport");
      if (s.score < 0.04) continue;
      const vh = mapSheetToViewNormalized({ center: mapped.center, viewport: vp.box, rotation: vp.rotation });
      targets.push({
        kind: "viewport",
        id: vp.viewportId === null ? null : Math.round(vp.viewportId),
        view_id: vp.viewId === null ? null : Math.round(vp.viewId),
        score: s.score,
        overlap_ratio: s.overlapRatio,
        contains_center: s.containsCenter,
        center_distance_norm: s.distanceNorm,
        reason: s.containsCenter ? "center_inside_viewport" : s.overlapRatio > 0 ? "overlaps_viewport" : "near_viewport",
        view_hint: {
          normalized_x: vh.x,
          normalized_y: vh.y,
          rotation: vh.rotation
        }
      });
    }

    for (const tb of titleBlocks) {
      if (!tb.box) continue;
      const s = scoreTarget(mapped.sheetBox, mapped.center, tb.box, "titleblock");
      if (s.score < 0.04) continue;
      targets.push({
        kind: "titleblock",
        id: tb.elementId === null ? null : Math.round(tb.elementId),
        view_id: null,
        score: s.score,
        overlap_ratio: s.overlapRatio,
        contains_center: s.containsCenter,
        center_distance_norm: s.distanceNorm,
        reason: s.containsCenter ? "center_inside_titleblock" : s.overlapRatio > 0 ? "overlaps_titleblock" : "near_titleblock"
      });
    }

    targets.sort((a, b) => b.score - a.score || b.overlap_ratio - a.overlap_ratio);
    const primary: RegionTarget =
      targets[0] ??
      {
        kind: "sheet",
        id: null,
        view_id: null,
        score: 0.08,
        overlap_ratio: 0,
        contains_center: true,
        center_distance_norm: 0,
        reason: "no_specific_target_match"
      };

    if (primary.view_id !== null) viewIdSet.add(primary.view_id);

    regions.push({
      index: i + 1,
      pixel_box: parsed,
      normalized_box: mapped.normalized,
      sheet_box: mapped.sheetBox,
      sheet_center: mapped.center,
      targets,
      primary_target: primary
    });
  }

  let viewportRegions = 0;
  let titleblockRegions = 0;
  let sheetRegions = 0;
  for (const r of regions) {
    if (r.primary_target.kind === "viewport") viewportRegions++;
    else if (r.primary_target.kind === "titleblock") titleblockRegions++;
    else sheetRegions++;
  }

  const orientationHints: string[] = [];
  if (regions.length === 0) {
    orientationHints.push("No valid region boxes were provided.");
  } else {
    orientationHints.push(`Mapped ${regions.length} region(s) from image pixels into sheet UV space.`);
    if (viewportRegions > 0) {
      orientationHints.push(
        `${viewportRegions} region(s) primarily target a viewport; export those views and convert view_hint normalized points to /revit/pick-at-pixel coordinates.`
      );
    }
    if (titleblockRegions > 0) {
      orientationHints.push(`${titleblockRegions} region(s) primarily target titleblock/sheet annotation zones.`);
    }
    if (sheetRegions > 0) {
      orientationHints.push(`${sheetRegions} region(s) did not map strongly to viewport/titleblock geometry.`);
    }
  }

  const suggestedCalls: MapSheetRegionsResponse["suggested_revit_calls"] = [];
  for (const viewId of [...viewIdSet].sort((a, b) => a - b).slice(0, 12)) {
    suggestedCalls.push({
      method: "POST",
      path: "/revit/export-view-frame",
      body: { viewId, includeMapping: true }
    });
  }
  if (titleblockRegions > 0) {
    suggestedCalls.push({
      method: "POST",
      path: "/revit/get-titleblock-info",
      body: {}
    });
  }

  return {
    ok: true,
    image_width: imageWidth,
    image_height: imageHeight,
    sheet_outline: sheet,
    regions,
    summary: {
      region_count: regions.length,
      viewport_regions: viewportRegions,
      titleblock_regions: titleblockRegions,
      sheet_regions: sheetRegions,
      unique_view_ids: [...viewIdSet].sort((a, b) => a - b)
    },
    orientation_hints: orientationHints,
    suggested_revit_calls: suggestedCalls
  };
}
