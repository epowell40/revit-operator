import type { ToolAttachment, ToolResult } from "./contracts.js";

const DEFAULT_CHAT_MAX_REQUEST_BYTES = 12 * 1024 * 1024;

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function approxJsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function pickNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickFirstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = pickNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function pickBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function pickFirstBool(...values: unknown[]): boolean | null {
  for (const value of values) {
    const bool = pickBool(value);
    if (bool !== null) return bool;
  }
  return null;
}

function pickVector(value: unknown): { x: number; y: number; z: number } | null {
  const obj = asObject(value);
  if (!obj) return null;
  const x = pickNumber(obj.x);
  const y = pickNumber(obj.y);
  const z = pickNumber(obj.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function pickTransform(value: unknown): {
  origin: { x: number; y: number; z: number } | null;
  basisX: { x: number; y: number; z: number } | null;
  basisY: { x: number; y: number; z: number } | null;
  basisZ: { x: number; y: number; z: number } | null;
} | null {
  const obj = asObject(value);
  if (!obj) return null;
  return {
    origin: pickVector(obj.origin),
    basisX: pickVector(obj.basisX),
    basisY: pickVector(obj.basisY),
    basisZ: pickVector(obj.basisZ)
  };
}

function pickImageProjection(value: unknown): { x: number | null; y: number | null; normalizedX: number | null; normalizedY: number | null; insideFrame: boolean | null } | null {
  const obj = asObject(value);
  if (!obj) return null;
  return {
    x: pickFirstNumber(obj.x, obj.xPx, obj.x_px),
    y: pickFirstNumber(obj.y, obj.yPx, obj.y_px),
    normalizedX: pickFirstNumber(obj.normalizedX, obj.normalized_x),
    normalizedY: pickFirstNumber(obj.normalizedY, obj.normalized_y),
    insideFrame: pickFirstBool(obj.insideFrame, obj.inside_frame)
  };
}

function pickProjectedPoint(value: unknown): { model: { x: number; y: number; z: number } | null; image: { x: number | null; y: number | null; normalizedX: number | null; normalizedY: number | null; insideFrame: boolean | null } | null } | null {
  const obj = asObject(value);
  if (!obj) return null;
  return {
    model: pickVector(obj.model),
    image: pickImageProjection(obj.image)
  };
}

function pickImageRect(value: unknown): Record<string, unknown> | null {
  const obj = asObject(value);
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const key of [
    "minX",
    "minY",
    "maxX",
    "maxY",
    "normalizedMinX",
    "normalizedMinY",
    "normalizedMaxX",
    "normalizedMaxY",
    "minNormalizedX",
    "minNormalizedY",
    "maxNormalizedX",
    "maxNormalizedY",
    "minU",
    "minV",
    "maxU",
    "maxV",
    "intersectsFrame"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    out[key] = obj[key];
  }
  const normalizedMinX = pickFirstNumber(obj.normalizedMinX, obj.normalized_min_x, obj.minNormalizedX, obj.min_normalized_x);
  const normalizedMinY = pickFirstNumber(obj.normalizedMinY, obj.normalized_min_y, obj.minNormalizedY, obj.min_normalized_y);
  const normalizedMaxX = pickFirstNumber(obj.normalizedMaxX, obj.normalized_max_x, obj.maxNormalizedX, obj.max_normalized_x);
  const normalizedMaxY = pickFirstNumber(obj.normalizedMaxY, obj.normalized_max_y, obj.maxNormalizedY, obj.max_normalized_y);
  const intersectsFrame = pickFirstBool(obj.intersectsFrame, obj.intersects_frame);
  if (normalizedMinX !== null) out.normalizedMinX = normalizedMinX;
  if (normalizedMinY !== null) out.normalizedMinY = normalizedMinY;
  if (normalizedMaxX !== null) out.normalizedMaxX = normalizedMaxX;
  if (normalizedMaxY !== null) out.normalizedMaxY = normalizedMaxY;
  if (intersectsFrame !== null) out.intersectsFrame = intersectsFrame;
  return Object.keys(out).length > 0 ? out : null;
}

function pickCountEntries(values: string[], maxEntries = 8): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, maxEntries)
    .map(([key, count]) => ({ key, count }));
}

function getVisibleElementSpatialNumber(obj: Record<string, unknown>): string | null {
  const room = asObject(obj.room);
  const space = asObject(obj.space);
  const associatedSpatial = asObject(obj.associatedSpatial);
  const taggedSpatial = asObject(obj.taggedSpatial);
  return pickString(obj.roomNumber, obj.spaceNumber, obj.associatedSpatialNumber, associatedSpatial?.number, taggedSpatial?.number, room?.number, space?.number);
}

function hasVisibleElementImageAnchor(obj: Record<string, unknown>): boolean {
  const anchor = asObject(obj.anchor);
  const anchorImage = asObject(anchor?.image);
  if (pickBool(anchorImage?.insideFrame) === true) return true;
  const geometry = asObject(obj.geometry);
  const point = asObject(geometry?.point);
  const pointImage = asObject(point?.image);
  if (pickBool(pointImage?.insideFrame) === true) return true;
  const bbox = asObject(obj.bbox);
  const bboxImage = asObject(bbox?.image);
  return pickBool(bboxImage?.intersectsFrame) === true;
}

function hasVisibleElementCircuitEvidence(obj: Record<string, unknown>): boolean {
  const parameters = asObject(obj.parameters);
  const parameterGroups = asObject(obj.parameterGroups);
  const electrical = asObject(parameterGroups?.electrical);
  const electricalCircuit = asObject(obj.electricalCircuit);
  return !!pickString(
    parameters?.Panel,
    parameters?.panel,
    electrical?.Panel,
    electrical?.panel,
    parameters?.["Circuit Number"],
    parameters?.Circuit,
    parameters?.circuitNumber,
    parameters?.circuit,
    electrical?.["Circuit Number"],
    electrical?.Circuit,
    electrical?.circuitNumber,
    electrical?.circuit,
    electricalCircuit?.primaryLabel,
    electricalCircuit?.panel,
    electricalCircuit?.circuit,
    obj.circuitLabel
  );
}

function getVisibleElementTextPayload(obj: Record<string, unknown>): string | null {
  const parameters = asObject(obj.parameters);
  const text = pickString(
    obj.visibleText,
    obj.visible_text,
    obj.text,
    obj.textValue,
    obj.text_value,
    obj.Text,
    obj.Label,
    obj.label,
    obj.Value,
    obj.value,
    parameters?.["Text String"],
    parameters?.Text,
    parameters?.text,
    parameters?.Label,
    parameters?.label,
    parameters?.Value,
    parameters?.value
  );
  return text && text.trim() ? text.trim() : null;
}

function scoreVisibleElementForCompactionSample(value: unknown): number {
  const obj = asObject(value);
  if (!obj) return Number.NEGATIVE_INFINITY;
  const builtIn = pickString(obj.builtInCategory, obj.categoryToken)?.toLowerCase() ?? "";
  const category = pickString(obj.category)?.toLowerCase() ?? "";
  const name = pickString(obj.name, obj.familyName, obj.typeName)?.toLowerCase() ?? "";
  const visibleText = getVisibleElementTextPayload(obj)?.toLowerCase() ?? "";
  const isElectrical =
    builtIn.includes("electrical") ||
    builtIn.includes("communication") ||
    builtIn.includes("firealarm") ||
    builtIn.includes("lightingdevice") ||
    category.includes("electrical") ||
    category.includes("communication") ||
    category.includes("fire alarm") ||
    /\b(receptacle|outlet|duplex|gfci|gfi|switch|device|power|data|voice|telecom|telephone|comm|communication|fire alarm|strobe|horn|nurse call|call station)\b/.test(name);
  const isSpatialLabel =
    builtIn.includes("mepspaces") ||
    builtIn.includes("rooms") ||
    builtIn.includes("roomtag") ||
    builtIn.includes("mepspacetag") ||
    builtIn.includes("textnote") ||
    builtIn.includes("genericannotation") ||
    category.includes("room tag") ||
    category === "spaces" ||
    category === "rooms" ||
    category.includes("space tag") ||
    category.includes("annotation") ||
    category.includes("text") ||
    /\b(room|unit|space|live\s*\/?\s*work|p\s*\d{2,6}\s*\/\s*\d{1,4})\b/.test(visibleText);
  return (
    (isElectrical ? 100 : 0) +
    (isSpatialLabel ? 115 : 0) +
    (getVisibleElementSpatialNumber(obj) ? 40 : 0) +
    (hasVisibleElementCircuitEvidence(obj) ? 35 : 0) +
    (hasVisibleElementImageAnchor(obj) ? 20 : 0) +
    (asObject(obj.host) || obj.hostId ? 10 : 0) +
    (asObject(obj.orientation) ? 5 : 0)
  );
}

const DURABLE_REGISTRATION_CATEGORIES = new Set([
  "ost_walls",
  "ost_stairs",
  "ost_stairsruns",
  "ost_stairslandings",
  "ost_shaftopening",
  "ost_columns",
  "ost_structuralcolumns",
  "ost_grids"
]);

function visibleElementCategoryToken(value: unknown): string {
  const obj = asObject(value);
  return obj
    ? (pickString(obj.builtInCategory, obj.categoryToken, obj.category) ?? "").toLowerCase()
    : "";
}

function visibleElementNormalizedPoint(value: unknown): { x: number; y: number } | null {
  const obj = asObject(value);
  if (!obj) return null;
  const projected = [
    asObject(asObject(obj.anchor)?.image),
    asObject(asObject(asObject(obj.geometry)?.point)?.image),
    asObject(asObject(asObject(obj.geometry)?.midpoint)?.image)
  ];
  for (const image of projected) {
    const x = pickFirstNumber(image?.normalizedX, image?.normalized_x);
    const y = pickFirstNumber(image?.normalizedY, image?.normalized_y);
    if (x !== null && y !== null) return { x, y };
  }
  const bboxImage = asObject(asObject(obj.bbox)?.image);
  const minX = pickFirstNumber(
    bboxImage?.normalizedMinX,
    bboxImage?.normalized_min_x,
    bboxImage?.minNormalizedX,
    bboxImage?.min_normalized_x
  );
  const minY = pickFirstNumber(
    bboxImage?.normalizedMinY,
    bboxImage?.normalized_min_y,
    bboxImage?.minNormalizedY,
    bboxImage?.min_normalized_y
  );
  const maxX = pickFirstNumber(
    bboxImage?.normalizedMaxX,
    bboxImage?.normalized_max_x,
    bboxImage?.maxNormalizedX,
    bboxImage?.max_normalized_x
  );
  const maxY = pickFirstNumber(
    bboxImage?.normalizedMaxY,
    bboxImage?.normalized_max_y,
    bboxImage?.maxNormalizedY,
    bboxImage?.max_normalized_y
  );
  return minX !== null && minY !== null && maxX !== null && maxY !== null
    ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
    : null;
}

function isProtectedVisibleElementTextAnchor(value: unknown): boolean {
  const obj = asObject(value);
  if (!obj) return false;
  const text = (getVisibleElementTextPayload(obj) ?? pickString(obj.name) ?? "").trim();
  if (!text) return false;
  const builtIn = pickString(obj.builtInCategory, obj.categoryToken)?.toLowerCase() ?? "";
  const category = pickString(obj.category)?.toLowerCase() ?? "";
  const textLikeCategory =
    builtIn.includes("mepspaces") ||
    builtIn.includes("rooms") ||
    builtIn.includes("roomtag") ||
    builtIn.includes("mepspacetag") ||
    builtIn.includes("textnote") ||
    builtIn.includes("genericannotation") ||
    category === "spaces" ||
    category === "rooms" ||
    category.includes("room tag") ||
    category.includes("space tag") ||
    category.includes("annotation") ||
    category.includes("text");
  if (!textLikeCategory) return false;
  return /\b(room|unit|space|live\s*\/?\s*work|suite|apt|apartment)\b/i.test(text) ||
    /\bP\s*[A-Z]?\d{2,6}[A-Z]?\s*\/\s*\d{1,4}\b/i.test(text) ||
    /^[A-Z]?\d{2,6}[A-Z]?$/i.test(text);
}

function summarizeVisibleElementItem(value: unknown): Record<string, unknown> | null {
  const obj = asObject(value);
  if (!obj) return null;
  const host = asObject(obj.host);
  const source = asObject(obj.source);
  const room = asObject(obj.room);
  const space = asObject(obj.space);
  const associatedSpatial = asObject(obj.associatedSpatial);
  const taggedSpatial = asObject(obj.taggedSpatial);
  const bbox = asObject(obj.bbox);
  const geometry = asObject(obj.geometry);
  const orientation = asObject(obj.orientation);
  const hostProvenance = asObject(obj.hostProvenance);
  const parameters = asObject(obj.parameters);
  const parameterGroups = asObject(obj.parameterGroups);
  const electricalParameters = asObject(parameterGroups?.electrical);
  const electricalCircuit = asObject(obj.electricalCircuit);
  const bboxModel = bbox ? asObject(bbox.model) : null;
  const bboxCenter = bboxModel ? pickVector(bboxModel.center) : null;
  const geometryKind = pickString(geometry?.kind);
  const parameterSummary: Record<string, unknown> = {};
  for (const key of ["Panel", "panel", "Circuit Number", "Circuit", "circuitNumber", "circuit"]) {
    if (parameters && Object.prototype.hasOwnProperty.call(parameters, key)) parameterSummary[key] = parameters[key];
  }
  const electricalSummary: Record<string, unknown> = {};
  for (const key of ["Panel", "panel", "Circuit Number", "Circuit", "circuitNumber", "circuit"]) {
    if (electricalParameters && Object.prototype.hasOwnProperty.call(electricalParameters, key)) {
      electricalSummary[key] = electricalParameters[key];
    }
  }
  const summary: Record<string, unknown> = {
    elementId: obj.elementId ?? null,
    uniqueId: obj.uniqueId ?? null,
    sourceScopedId: obj.sourceScopedId ?? null,
    sourceScope: pickString(source?.scope) ?? null,
    name: obj.name ?? null,
    category: obj.category ?? null,
    builtInCategory: obj.builtInCategory ?? null,
    categoryToken: obj.categoryToken ?? null,
    typeName: obj.typeName ?? null,
    familyName: obj.familyName ?? null,
    visibleText: getVisibleElementTextPayload(obj),
    levelName: obj.levelName ?? null,
    hostId: obj.hostId ?? null,
    hostScopedId: obj.hostScopedId ?? null,
    hostCategory: obj.hostCategory ?? null,
    hostBuiltInCategory: obj.hostBuiltInCategory ?? null,
    hostProvenance:
      hostProvenance
        ? {
            source: hostProvenance.source ?? null,
            hostScopedId: hostProvenance.hostScopedId ?? null,
            linkInstanceId: hostProvenance.linkInstanceId ?? null,
            linkInstanceName: hostProvenance.linkInstanceName ?? null,
            linkedElementId: hostProvenance.linkedElementId ?? null,
            linkedElementScopedId: hostProvenance.linkedElementScopedId ?? null
          }
        : null,
    host:
      host
        ? {
            id: host.id ?? null,
            scopedId: host.scopedId ?? null,
            sourceScopedId: host.sourceScopedId ?? null,
            category: host.category ?? null,
            builtInCategory: host.builtInCategory ?? null,
            name: host.name ?? null,
            resolvedFrom: host.resolvedFrom ?? null,
            linkInstanceId: host.linkInstanceId ?? null
          }
        : null,
    room:
      room
        ? {
            id: room.id ?? null,
            number: room.number ?? null,
            name: room.name ?? null
          }
        : null,
    space:
      space
        ? {
            id: space.id ?? null,
            number: space.number ?? null,
            name: space.name ?? null
          }
        : null,
    associatedSpatial:
      associatedSpatial
        ? {
            id: associatedSpatial.id ?? null,
            number: associatedSpatial.number ?? null,
            name: associatedSpatial.name ?? null,
            type: associatedSpatial.type ?? associatedSpatial.kind ?? null
          }
        : null,
    taggedSpatial:
      taggedSpatial
        ? {
            id: taggedSpatial.id ?? null,
            number: taggedSpatial.number ?? null,
            name: taggedSpatial.name ?? null,
            type: taggedSpatial.type ?? taggedSpatial.kind ?? null
          }
        : null,
    parameters: Object.keys(parameterSummary).length > 0 ? parameterSummary : null,
    parameterGroups:
      Object.keys(electricalSummary).length > 0
        ? {
            electrical: electricalSummary
          }
        : null,
    electricalCircuit:
      electricalCircuit
        ? {
            primaryLabel: electricalCircuit.primaryLabel ?? null,
            panel: electricalCircuit.panel ?? null,
            circuit: electricalCircuit.circuit ?? null,
            systemId: electricalCircuit.systemId ?? null
          }
        : null,
    anchor: pickProjectedPoint(obj.anchor),
    bbox:
      bbox
        ? {
            center: bboxCenter,
            image: pickImageRect(bbox.image)
          }
        : null,
    geometry:
      geometryKind
        ? {
            kind: geometryKind,
            point: pickProjectedPoint(geometry?.point),
            midpoint: pickProjectedPoint(geometry?.midpoint)
          }
        : null,
    orientation:
      orientation
        ? {
            facing: pickVector(orientation.facing),
            hand: pickVector(orientation.hand),
            curveDirection: pickVector(orientation.curveDirection),
            rotationRadians: orientation.rotationRadians ?? null,
            planAzimuthRadians: orientation.planAzimuthRadians ?? null,
            planAzimuthSource: orientation.planAzimuthSource ?? null,
            mirrored: orientation.mirrored ?? null,
            handFlipped: orientation.handFlipped ?? null,
            facingFlipped: orientation.facingFlipped ?? null,
            transform: pickTransform(orientation.transform),
            sourceToHostTransform: pickTransform(orientation.sourceToHostTransform)
          }
        : null
  };
  return summary;
}

export function compactVisibleElementsResult(
  value: unknown,
  opts?: {
    maxItems?: number;
    maxCountEntries?: number;
  }
): unknown {
  const obj = asObject(value);
  if (!obj) return value;

  const items = Array.isArray(obj.items) ? obj.items : [];
  const maxItems = Math.max(1, Math.min(80, opts?.maxItems ?? 24));
  const maxCountEntries = Math.max(1, Math.min(16, opts?.maxCountEntries ?? 8));

  if (obj._compacted === true && Array.isArray(obj.itemsSampled)) {
    const summary = asObject(obj.summary);
    const sliceEntries = (key: string): unknown[] | null => {
      const entries = summary && Array.isArray(summary[key]) ? (summary[key] as unknown[]) : null;
      return entries ? entries.slice(0, maxCountEntries) : null;
    };
    return {
      ...obj,
      itemsSampled: (obj.itemsSampled as unknown[]).slice(0, maxItems),
      itemsOmitted:
        typeof obj.itemsOmitted === "number"
          ? Math.max(0, Math.round(obj.itemsOmitted) + Math.max(0, (obj.itemsSampled as unknown[]).length - maxItems))
          : obj.itemsOmitted ?? null,
      summary:
        summary
          ? {
              ...summary,
              ...(sliceEntries("categoryCounts") ? { categoryCounts: sliceEntries("categoryCounts") } : {}),
              ...(sliceEntries("roomCounts") ? { roomCounts: sliceEntries("roomCounts") } : {}),
              ...(sliceEntries("spaceCounts") ? { spaceCounts: sliceEntries("spaceCounts") } : {}),
              ...(sliceEntries("hostCategoryCounts") ? { hostCategoryCounts: sliceEntries("hostCategoryCounts") } : {}),
              ...(sliceEntries("familyTypeCounts") ? { familyTypeCounts: sliceEntries("familyTypeCounts") } : {})
            }
          : null
    };
  }

  const rankedItems = items
    .map((item, index) => ({ item, index, score: scoreVisibleElementForCompactionSample(item), protectedText: isProtectedVisibleElementTextAnchor(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = new Map<number, (typeof rankedItems)[number]>();
  const protectedTextLimit = Math.min(8, Math.max(1, Math.ceil(maxItems / 3)));
  for (const entry of rankedItems.filter((item) => item.protectedText).slice(0, protectedTextLimit)) {
    if (selected.size >= maxItems) break;
    selected.set(entry.index, entry);
  }
  const actionableCount = rankedItems.filter((entry) => entry.score >= 40).length;
  if (actionableCount < Math.ceil(maxItems / 2)) {
    const durable = rankedItems.filter((entry) =>
      DURABLE_REGISTRATION_CATEGORIES.has(visibleElementCategoryToken(entry.item))
    );
    const representedCategories = new Set<string>();
    for (const entry of durable) {
      if (selected.size >= maxItems) break;
      const category = visibleElementCategoryToken(entry.item);
      if (representedCategories.has(category)) continue;
      representedCategories.add(category);
      selected.set(entry.index, entry);
    }
    const representedTiles = new Set<string>();
    for (const entry of durable) {
      if (selected.size >= maxItems) break;
      const point = visibleElementNormalizedPoint(entry.item);
      if (!point) continue;
      const category = visibleElementCategoryToken(entry.item);
      const tileX = Math.max(0, Math.min(3, Math.floor(point.x * 4)));
      const tileY = Math.max(0, Math.min(3, Math.floor(point.y * 4)));
      const key = `${category}:${tileX}:${tileY}`;
      if (representedTiles.has(key)) continue;
      representedTiles.add(key);
      selected.set(entry.index, entry);
    }
  }
  for (const entry of rankedItems) {
    if (selected.size >= maxItems) break;
    selected.set(entry.index, entry);
  }
  const sampledItems = [...selected.values()]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => summarizeVisibleElementItem(entry.item))
    .filter((x): x is Record<string, unknown> => !!x);

  const categories: string[] = [];
  const roomKeys: string[] = [];
  const spaceKeys: string[] = [];
  const hostCategories: string[] = [];
  const familyTypes: string[] = [];

  for (const item of items) {
    const it = asObject(item);
    if (!it) continue;
    const room = asObject(it.room);
    const space = asObject(it.space);
    const associatedSpatial = asObject(it.associatedSpatial);
    const taggedSpatial = asObject(it.taggedSpatial);
    const host = asObject(it.host);
    categories.push(pickString(it.categoryToken, it.builtInCategory, it.category) ?? "(unknown)");
    const roomNumber = pickString(room?.number);
    const spaceNumber = pickString(space?.number);
    const associatedNumber = pickString(associatedSpatial?.number);
    const taggedNumber = pickString(taggedSpatial?.number);
    if (roomNumber) roomKeys.push(roomNumber);
    if (spaceNumber) spaceKeys.push(spaceNumber);
    if (!roomNumber && associatedNumber) roomKeys.push(associatedNumber);
    if (!spaceNumber && associatedNumber) spaceKeys.push(associatedNumber);
    if (!roomNumber && !associatedNumber && taggedNumber) roomKeys.push(taggedNumber);
    if (!spaceNumber && !associatedNumber && taggedNumber) spaceKeys.push(taggedNumber);
    const hostCategory = pickString(it.hostBuiltInCategory, it.hostCategory, host?.builtInCategory, host?.category);
    if (hostCategory) hostCategories.push(hostCategory);
    const familyType = [pickString(it.familyName), pickString(it.typeName)].filter((x): x is string => !!x).join(" / ");
    if (familyType) familyTypes.push(familyType);
  }

  const mapping = asObject(obj.mapping);
  const modelBounds = asObject(obj.modelBoundsFt ?? obj.model_bounds_ft);
  const modelBoundsMin = pickVector(modelBounds?.min);
  const modelBoundsMax = pickVector(modelBounds?.max);
  const compacted: Record<string, unknown> = {
    _compacted: true,
    compaction: "visible-elements-inventory-summary",
    approx_json_chars: approxJsonChars(value),
    ...(typeof obj.ok === "boolean" ? { ok: obj.ok } : {}),
    frameId: obj.frameId ?? null,
    viewId: obj.viewId ?? null,
    viewType: obj.viewType ?? null,
    viewName: obj.viewName ?? null,
    path: obj.path ?? null,
    widthPx: obj.widthPx ?? null,
    heightPx: obj.heightPx ?? null,
    targetLevel: obj.targetLevel ?? obj.target_level ?? null,
    count: typeof obj.count === "number" ? obj.count : items.length,
    scanned: obj.scanned ?? null,
    truncated: obj.truncated ?? null,
    ...(typeof obj.modelBoundsApplied === "boolean"
      ? { modelBoundsApplied: obj.modelBoundsApplied }
      : {}),
    ...(modelBoundsMin && modelBoundsMax
      ? { modelBoundsFt: { min: modelBoundsMin, max: modelBoundsMax } }
      : {}),
    ...(mapping
      ? {
          mapping: {
            mode: mapping.mode ?? null,
            topLeftXyz: mapping.topLeftXyz ?? null,
            topRightXyz: mapping.topRightXyz ?? null,
            bottomLeftXyz: mapping.bottomLeftXyz ?? null,
            modelUnits: mapping.modelUnits ?? null,
            frameBasis: mapping.frameBasis ?? null,
            rasterWidthPx: mapping.rasterWidthPx ?? null,
            rasterHeightPx: mapping.rasterHeightPx ?? null,
            rasterAspect: mapping.rasterAspect ?? null,
            frameAspect: mapping.frameAspect ?? null,
            cropBoxAspect: mapping.cropBoxAspect ?? null,
            aspectMismatch: mapping.aspectMismatch ?? null,
            aspectCorrectionApplied: mapping.aspectCorrectionApplied ?? null,
            aspectCorrectionAxis: mapping.aspectCorrectionAxis ?? null,
            notes: mapping.notes ?? null
          }
        }
      : {}),
    summary: {
      categoryCounts: pickCountEntries(categories, maxCountEntries),
      roomCounts: pickCountEntries(roomKeys, maxCountEntries),
      spaceCounts: pickCountEntries(spaceKeys, maxCountEntries),
      hostCategoryCounts: pickCountEntries(hostCategories, maxCountEntries),
      familyTypeCounts: pickCountEntries(familyTypes, maxCountEntries)
    },
    warnings: Array.isArray(obj.warnings) ? obj.warnings.slice(0, 12) : null,
    itemsSampled: sampledItems,
    itemsOmitted: Math.max(0, items.length - sampledItems.length)
  };

  return compacted;
}

export function compactParameterReadResultForPrompt(value: unknown, options?: { maxEvidence?: number; maxElementIds?: number }): unknown {
  const obj = asObject(value);
  if (!obj) return value;
  const items = Array.isArray(obj.items) ? obj.items : [];
  const literal = pickString(obj.valueContains);
  const literalLower = literal?.toLowerCase() ?? "";
  const maxEvidence = Math.max(1, Math.min(100, options?.maxEvidence ?? 16));
  const maxElementIds = Math.max(1, Math.min(500, options?.maxElementIds ?? 500));
  const evidence: Array<Record<string, unknown> & { _score: number; _order: number }> = [];
  let order = 0;

  for (const rawItem of items) {
    const item = asObject(rawItem);
    if (!item) continue;
    const elementId = pickFirstNumber(item.id, item.elementId, item.element_id);
    const details = Array.isArray(item.parameterDetails) ? item.parameterDetails : [];
    for (const rawDetail of details) {
      const detail = asObject(rawDetail);
      if (!detail) continue;
      const parameterName = pickString(detail.name);
      const parameterValue = typeof detail.value === "string" ? detail.value : detail.value == null ? "" : String(detail.value);
      if (!parameterName || !parameterValue) continue;
      const nameLower = parameterName.toLowerCase();
      const valueLower = parameterValue.toLowerCase();
      const literalMatch = literalLower ? valueLower.includes(literalLower) : false;
      const designationMatch = /\bdesig(?:nation)?\.?\b/i.test(parameterName);
      const shockMatch = /shock\s*arrest|(?:^|[-_\s])sa(?:[-_\s]|$)/i.test(`${parameterName} ${parameterValue} ${pickString(item.name) ?? ""}`);
      const codeMatch = /-[a-z0-9]+-/i.test(parameterValue);
      const isReadOnly = pickBool(detail.isReadOnly);
      const score = (literalMatch ? 1000 : 0) + (designationMatch ? 500 : 0) + (shockMatch ? 250 : 0) + (codeMatch ? 100 : 0) + (isReadOnly === false ? 25 : 0);
      evidence.push({
        elementId,
        elementName: pickString(item.name),
        category: pickString(item.category),
        parameterName,
        value: parameterValue,
        storageType: pickString(detail.storageType),
        isReadOnly,
        parameterId: pickFirstNumber(detail.parameterId),
        literalMatch,
        _score: score,
        _order: order++
      });
    }
  }

  evidence.sort((a, b) => b._score - a._score || a._order - b._order);
  const relevant = literal
    ? evidence.filter((entry) => entry.literalMatch)
    : evidence.filter((entry) => entry._score >= 100);
  const selectedPool = relevant.length > 0 ? relevant : evidence;
  const matchingElementIds = Array.from(new Set(selectedPool.map((entry) => entry.elementId).filter((id): id is number => typeof id === "number"))).slice(0, maxElementIds);
  const parameterCounts = new Map<string, number>();
  for (const entry of selectedPool) {
    const name = String(entry.parameterName);
    parameterCounts.set(name, (parameterCounts.get(name) ?? 0) + 1);
  }
  const evidenceSample = selectedPool.slice(0, maxEvidence).map(({ _score, _order, ...entry }) => entry);

  return {
    _compacted: true,
    compaction: "parameter-evidence-summary",
    selector: obj.selector ?? null,
    hostModelOnly: obj.hostModelOnly ?? null,
    instanceOnly: obj.instanceOnly ?? null,
    valueContains: literal,
    writableOnly: obj.writableOnly ?? null,
    totalScanned: obj.totalScanned ?? null,
    totalMatched: obj.totalMatched ?? null,
    returnedCount: obj.returnedCount ?? items.length,
    offset: obj.offset ?? null,
    hasMore: obj.hasMore ?? null,
    nextOffset: obj.nextOffset ?? null,
    matchingElementIds,
    matchingElementIdsOmitted: Math.max(0, new Set(selectedPool.map((entry) => entry.elementId).filter((id) => typeof id === "number")).size - matchingElementIds.length),
    parameterCounts: Array.from(parameterCounts.entries()).map(([name, count]) => ({ name, count })).slice(0, 20),
    evidenceSample,
    evidenceOmitted: Math.max(0, selectedPool.length - evidenceSample.length),
    errors: items.map((entry) => asObject(entry)?.error).filter((entry) => typeof entry === "string").slice(0, 20)
  };
}

export function compactScheduleReadResultForPrompt(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return value;
  const compactRows = (section: unknown, maxRows: number) => {
    const row = asObject(section);
    return {
      totalRows: row?.totalRows ?? null,
      totalColumns: row?.totalColumns ?? null,
      rowOffset: row?.rowOffset ?? null,
      returnedRows: row?.returnedRows ?? null,
      hasMoreRows: row?.hasMoreRows ?? null,
      nextRowOffset: row?.nextRowOffset ?? null,
      rows: Array.isArray(row?.rows) ? row.rows.slice(0, maxRows) : []
    };
  };
  const table = asObject(obj.table);
  return {
    action: obj.action ?? null,
    status: obj.status ?? null,
    returned: obj.returned ?? null,
    query: obj.query ?? null,
    items: Array.isArray(obj.items) ? obj.items.slice(0, 200) : null,
    schedule: obj.schedule ?? null,
    fields: Array.isArray(obj.fields) ? obj.fields.slice(0, 80) : null,
    table: table ? { header: compactRows(table.header, 10), body: compactRows(table.body, 30) } : null
  };
}

export function compactIncomingToolResult(result: ToolResult): ToolResult {
  const pathName = (result.path ?? "").trim().toLowerCase();
  const attachments = Array.isArray(result.attachments)
    ? result.attachments.map((attachment) => compactAttachment(attachment, pathName))
    : result.attachments;

  let resultJson = result.result_json;
  if (pathName === "/revit/export-visible-elements") {
    resultJson = compactVisibleElementsResult(result.result_json, { maxItems: 24, maxCountEntries: 8 });
  } else if (pathName === "/revit/views") {
    resultJson = compactViewsResult(result.result_json);
  }

  return {
    ...result,
    ...(attachments ? { attachments } : {}),
    ...(resultJson !== undefined ? { result_json: resultJson } : {})
  };
}

export function compactViewsResult(
  value: unknown,
  options: { maxItems?: number; maxJsonChars?: number } = {}
): unknown {
  const root = asObject(value);
  const views = Array.isArray(value)
    ? value
    : Array.isArray(root?.views)
      ? root.views
      : null;
  if (!views) return value;

  const maxItems = Math.max(1, Math.min(100, options.maxItems ?? 24));
  const maxJsonChars = Math.max(4_000, Math.min(200_000, options.maxJsonChars ?? 24_000));
  const approxChars = approxJsonChars(value);
  if (views.length <= maxItems && approxChars <= maxJsonChars) return value;

  const typeNames = views
    .map(item => asObject(item))
    .map(item => pickString(item?.type, item?.viewType))
    .filter((item): item is string => !!item);
  const sampled = views.slice(0, maxItems);
  const sourceCount = root && typeof root.count === "number" ? root.count : views.length;

  return {
    _compacted: true,
    compaction: "views-index-summary",
    approx_json_chars: approxChars,
    status: root?.status ?? "ok",
    count: sourceCount,
    returned: root?.returned ?? views.length,
    source_truncated: root?.truncated === true,
    result_clipped: true,
    appliedFilters: Array.isArray(root?.appliedFilters) ? root.appliedFilters : [],
    typeCounts: pickCountEntries(typeNames, 12),
    viewsSampled: sampled,
    viewsOmitted: Math.max(0, views.length - sampled.length),
    guidance:
      "This is an incomplete index receipt. Never infer that a view is absent from viewsSampled. Query POST /revit/views with exact viewNames/viewIds or bounded nameContainsAny predicates before reporting absence or selecting an id."
  };
}

function isRevitVisualEvidencePath(pathName: string): boolean {
  return (
    pathName === "/revit/export-view-frame" ||
    pathName === "/revit/export-view-region" ||
    pathName === "/revit/export-image" ||
    pathName === "/revit/export-visible-elements" ||
    pathName === "/revit/highlight-and-export" ||
    pathName === "/revit/mep-route-workflow" ||
    pathName === "/revit/edit-mep-route-elements" ||
    pathName === "/revit/create-similar-from-instance" ||
    pathName === "/revit/place-family-instance-on-host" ||
    pathName === "/revit/adjust-hosted-instance-on-host"
  );
}

function compactAttachment(attachment: ToolAttachment, pathName: string): ToolAttachment {
  if (!attachment || typeof attachment !== "object") return attachment;
  if (attachment.kind !== "image") return attachment;
  const defaultMaxInlineChars = isRevitVisualEvidencePath(pathName) ? 3_600_000 : 500_000;
  const maxInlineEnv = isRevitVisualEvidencePath(pathName)
    ? process.env.OPERATOR_VISUAL_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS
    : process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
  const maxInlineChars = Math.max(0, Number.parseInt(maxInlineEnv ?? `${defaultMaxInlineChars}`, 10) || defaultMaxInlineChars);
  const dataBase64 =
    typeof attachment.data_base64 === "string" && attachment.data_base64.trim().length > 0
      ? attachment.data_base64.trim()
      : "";
  return {
    kind: attachment.kind,
    mime: attachment.mime,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(dataBase64 && dataBase64.length <= maxInlineChars ? { data_base64: dataBase64 } : {}),
    ...(attachment.local_path ? { local_path: attachment.local_path } : {})
  };
}

export function getChatRequestLimitBytes(): number {
  return clampInt(process.env.OPERATOR_CHAT_MAX_REQUEST_BYTES, DEFAULT_CHAT_MAX_REQUEST_BYTES, 1_000_000, 64_000_000);
}

export function describeVisibleElementsInventory(value: unknown): {
  count: number | null;
  sampled: number;
  topCategories: string[];
  topRooms: string[];
} | null {
  const compacted = asObject(compactVisibleElementsResult(value, { maxItems: 12, maxCountEntries: 5 }));
  if (!compacted) return null;
  const summary = asObject(compacted.summary);
  const categoryCounts = Array.isArray(summary?.categoryCounts) ? summary.categoryCounts : [];
  const roomCounts = Array.isArray(summary?.roomCounts) ? summary.roomCounts : [];
  const topCategories = categoryCounts
    .map((entry) => asObject(entry))
    .map((entry) => pickString(entry?.key))
    .filter((entry): entry is string => !!entry);
  const topRooms = roomCounts
    .map((entry) => asObject(entry))
    .map((entry) => pickString(entry?.key))
    .filter((entry): entry is string => !!entry);

  return {
    count: typeof compacted.count === "number" ? compacted.count : null,
    sampled: Array.isArray(compacted.itemsSampled) ? compacted.itemsSampled.length : 0,
    topCategories,
    topRooms
  };
}
