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
  const x = pickFirstNumber(obj.x, obj.xPx, obj.x_px);
  const y = pickFirstNumber(obj.y, obj.yPx, obj.y_px);
  const normalizedX = pickFirstNumber(obj.normalizedX, obj.normalized_x);
  const normalizedY = pickFirstNumber(obj.normalizedY, obj.normalized_y);
  if (!((x !== null && y !== null) || (normalizedX !== null && normalizedY !== null))) return null;
  return {
    x,
    y,
    normalizedX,
    normalizedY,
    insideFrame: pickFirstBool(obj.insideFrame, obj.inside_frame)
  };
}

function pickExplicitImageProjection(value: unknown): ReturnType<typeof pickImageProjection> {
  const obj = asObject(value);
  if (!obj) return null;
  const hasExplicitImageCoordinates = ["xPx", "x_px", "yPx", "y_px", "normalizedX", "normalized_x", "normalizedY", "normalized_y"]
    .some(key => Object.prototype.hasOwnProperty.call(obj, key));
  return hasExplicitImageCoordinates ? pickImageProjection(obj) : null;
}

function pickProjectedPoint(value: unknown): { model: { x: number; y: number; z: number } | null; image: { x: number | null; y: number | null; normalizedX: number | null; normalizedY: number | null; insideFrame: boolean | null } | null } | null {
  const obj = asObject(value);
  if (!obj) return null;
  const nested = asObject(obj.point);
  const model = pickVector(obj.model) ?? pickVector(obj.xyz) ?? pickVector(obj)
    ?? pickVector(nested?.model) ?? pickVector(nested?.xyz) ?? pickVector(nested);
  const image = pickImageProjection(obj.image) ?? pickExplicitImageProjection(obj)
    ?? pickImageProjection(nested?.image) ?? pickExplicitImageProjection(nested);
  return model || image ? { model, image } : null;
}

function pickModelRect(value: unknown): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number }; center: { x: number; y: number; z: number } | null } | null {
  const obj = asObject(value);
  if (!obj) return null;
  const min = pickVector(obj.min ?? obj.minimum);
  const max = pickVector(obj.max ?? obj.maximum);
  if (!min || !max) return null;
  return { min, max, center: pickVector(obj.center) };
}

function pickCanonicalGeometry(value: unknown): Record<string, unknown> | null {
  const geometry = asObject(value);
  if (!geometry) return null;
  const kind = boundedString(pickString(geometry.kind, geometry.type)?.toLowerCase() ?? null, 64);
  const point = pickProjectedPoint(geometry.point ?? geometry.xyz ?? geometry.origin);
  const midpoint = pickProjectedPoint(geometry.midpoint);
  const start = pickProjectedPoint(geometry.start ?? geometry.startPoint ?? geometry.start_point);
  const end = pickProjectedPoint(geometry.end ?? geometry.endPoint ?? geometry.end_point);
  const bounds = pickModelRect(geometry.bounds ?? geometry.bbox ?? geometry.boundingBox);
  const rawPoints = geometry.points ?? geometry.vertices;
  const points = Array.isArray(rawPoints)
    ? rawPoints.slice(0, 64).map(pickProjectedPoint).filter((item): item is NonNullable<ReturnType<typeof pickProjectedPoint>> => !!item)
    : [];
  if (!kind && !point && !midpoint && !start && !end && !bounds && points.length === 0) return null;
  return {
    kind,
    point,
    midpoint,
    start,
    end,
    bounds,
    points: points.length > 0 ? points : null
  };
}

function boundedString(value: unknown, maxChars: number): string | null {
  return typeof value === "string" && value.length <= maxChars ? value : null;
}

function boundedScalar(value: unknown, maxStringChars = 512): string | number | boolean | null {
  if (typeof value === "string") return boundedString(value, maxStringChars);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return null;
}

function boundedNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function saturatingSafeAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) return Number.MAX_SAFE_INTEGER;
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function sanitizeTargetLevel(value: unknown): { id: number | null; name: string | null; elevationFt: number | null } | null {
  if (typeof value === "string") {
    const name = boundedString(value, 512);
    return name ? { id: null, name, elevationFt: null } : null;
  }
  const level = asObject(value);
  if (!level) return null;
  const id = boundedNonNegativeInteger(level.id ?? level.levelId ?? level.level_id);
  const name = boundedString(level.name ?? level.levelName ?? level.level_name, 512);
  const elevationFt = pickNumber(level.elevationFt ?? level.elevation_ft ?? level.elevation);
  return id !== null || name !== null || elevationFt !== null ? { id, name, elevationFt } : null;
}

function pickFiniteTriple(value: unknown): [number, number, number] | null {
  if (Array.isArray(value) && value.length === 3 && value.every(item => typeof item === "number" && Number.isFinite(item))) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }
  const vector = pickVector(value);
  return vector ? [vector.x, vector.y, vector.z] : null;
}

function sanitizeObservationMapping(value: unknown): Record<string, unknown> | null {
  const mapping = asObject(value);
  if (!mapping) return null;
  return {
    mode: boundedString(mapping.mode, 64),
    topLeftXyz: pickFiniteTriple(mapping.topLeftXyz),
    topRightXyz: pickFiniteTriple(mapping.topRightXyz),
    bottomLeftXyz: pickFiniteTriple(mapping.bottomLeftXyz),
    modelUnits: boundedString(mapping.modelUnits, 32),
    frameBasis: boundedString(mapping.frameBasis, 64),
    rasterWidthPx: boundedNonNegativeInteger(mapping.rasterWidthPx),
    rasterHeightPx: boundedNonNegativeInteger(mapping.rasterHeightPx),
    rasterAspect: pickNumber(mapping.rasterAspect),
    frameAspect: pickNumber(mapping.frameAspect),
    cropBoxAspect: pickNumber(mapping.cropBoxAspect),
    aspectMismatch: pickNumber(mapping.aspectMismatch),
    aspectCorrectionApplied: pickBool(mapping.aspectCorrectionApplied),
    aspectCorrectionAxis: boundedString(mapping.aspectCorrectionAxis, 16),
    notes: boundedString(mapping.notes, 1024)
  };
}

function sanitizeWarnings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 12).flatMap(item => {
    const warning = boundedString(item, 512);
    return warning === null ? [] : [warning];
  });
}

function sanitizeResultBounds(value: unknown): Record<string, unknown> | null {
  const bounds = asObject(value);
  if (!bounds) return null;
  const model = pickModelRect(bounds.model ?? bounds);
  const image = pickImageRect(bounds.image);
  return model || image ? { model, image } : null;
}

function pickImageRect(value: unknown): Record<string, unknown> | null {
  const obj = asObject(value);
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const key of ["minX", "minY", "maxX", "maxY", "minU", "minV", "maxU", "maxV"] as const) {
    const number = pickNumber(obj[key]);
    if (number !== null) out[key] = number;
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
    const trimmed = value.trim().slice(0, 256);
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

function visibleElementGroundingStatus(obj: Record<string, unknown>): "anchored" | "bbox" | "geometry" | "ungrounded" {
  if (pickProjectedPoint(obj.anchor)) return "anchored";
  const bbox = asObject(obj.bbox);
  const imageRect = pickImageRect(bbox?.image);
  const completeImageRect = !!imageRect && (
    ["normalizedMinX", "normalizedMinY", "normalizedMaxX", "normalizedMaxY"].every(key => pickNumber(imageRect[key]) !== null)
    || ["minX", "minY", "maxX", "maxY"].every(key => pickNumber(imageRect[key]) !== null)
  );
  if (completeImageRect || !!pickModelRect(bbox?.model)) return "bbox";
  const geometry = pickCanonicalGeometry(obj.geometry);
  const geometryKind = pickString(geometry?.kind)?.toLowerCase();
  if (geometry && geometryKind !== "none") {
    if (geometry.point || geometry.midpoint || geometry.bounds) return "geometry";
    if (geometry.start && geometry.end) return "geometry";
    if (Array.isArray(geometry.points) && geometry.points.length > 0) return "geometry";
  }
  return "ungrounded";
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
  const geometry = pickCanonicalGeometry(obj.geometry);
  const orientation = asObject(obj.orientation);
  const hostProvenance = asObject(obj.hostProvenance);
  const parameters = asObject(obj.parameters);
  const parameterGroups = asObject(obj.parameterGroups);
  const electricalParameters = asObject(parameterGroups?.electrical);
  const electricalCircuit = asObject(obj.electricalCircuit);
  const rawBboxModel = bbox ? asObject(bbox.model) : null;
  const bboxModel = pickModelRect(bbox?.model);
  const bboxCenter = bboxModel?.center ?? pickVector(rawBboxModel?.center);
  const bboxImage = pickImageRect(bbox?.image);
  const parameterSummary: Record<string, unknown> = {};
  for (const key of ["Panel", "panel", "Circuit Number", "Circuit", "circuitNumber", "circuit"]) {
    if (parameters && Object.prototype.hasOwnProperty.call(parameters, key)) {
      const scalar = boundedScalar(parameters[key]);
      if (scalar !== null) parameterSummary[key] = scalar;
    }
  }
  const electricalSummary: Record<string, unknown> = {};
  for (const key of ["Panel", "panel", "Circuit Number", "Circuit", "circuitNumber", "circuit"]) {
    if (electricalParameters && Object.prototype.hasOwnProperty.call(electricalParameters, key)) {
      const scalar = boundedScalar(electricalParameters[key]);
      if (scalar !== null) electricalSummary[key] = scalar;
    }
  }
  const summary: Record<string, unknown> = {
    elementId: boundedNonNegativeInteger(obj.elementId),
    uniqueId: boundedString(obj.uniqueId, 256),
    sourceScopedId: boundedString(obj.sourceScopedId, 256),
    groundingStatus: visibleElementGroundingStatus(obj),
    source:
      source
        ? {
            scope: boundedString(source.scope, 64),
            linkInstanceId: boundedNonNegativeInteger(source.linkInstanceId ?? source.link_instance_id),
            linkInstanceName: boundedString(source.linkInstanceName ?? source.link_instance_name, 512),
            sourceDocumentTitle: boundedString(source.sourceDocumentTitle ?? source.source_document_title, 512)
          }
        : null,
    sourceScope: boundedString(source?.scope, 64),
    name: boundedString(obj.name, 512),
    category: boundedString(obj.category, 256),
    builtInCategory: boundedString(obj.builtInCategory, 256),
    categoryToken: boundedString(obj.categoryToken, 256),
    typeName: boundedString(obj.typeName, 512),
    familyName: boundedString(obj.familyName, 512),
    visibleText: boundedString(getVisibleElementTextPayload(obj), 1024),
    levelName: boundedString(obj.levelName, 512),
    hostId: boundedNonNegativeInteger(obj.hostId),
    hostScopedId: boundedString(obj.hostScopedId, 256),
    hostCategory: boundedString(obj.hostCategory, 256),
    hostBuiltInCategory: boundedString(obj.hostBuiltInCategory, 256),
    hostProvenance:
      hostProvenance
        ? {
            source: boundedString(hostProvenance.source, 128),
            hostScopedId: boundedString(hostProvenance.hostScopedId, 256),
            linkInstanceId: boundedNonNegativeInteger(hostProvenance.linkInstanceId),
            linkInstanceName: boundedString(hostProvenance.linkInstanceName, 512),
            linkedElementId: boundedNonNegativeInteger(hostProvenance.linkedElementId),
            linkedElementScopedId: boundedString(hostProvenance.linkedElementScopedId, 256)
          }
        : null,
    host:
      host
        ? {
            id: boundedNonNegativeInteger(host.id),
            scopedId: boundedString(host.scopedId, 256),
            sourceScopedId: boundedString(host.sourceScopedId, 256),
            category: boundedString(host.category, 256),
            builtInCategory: boundedString(host.builtInCategory, 256),
            name: boundedString(host.name, 512),
            resolvedFrom: boundedString(host.resolvedFrom, 256),
            linkInstanceId: boundedNonNegativeInteger(host.linkInstanceId)
          }
        : null,
    room:
      room
        ? {
            id: boundedNonNegativeInteger(room.id),
            number: boundedString(room.number, 128),
            name: boundedString(room.name, 512)
          }
        : null,
    space:
      space
        ? {
            id: boundedNonNegativeInteger(space.id),
            number: boundedString(space.number, 128),
            name: boundedString(space.name, 512)
          }
        : null,
    associatedSpatial:
      associatedSpatial
        ? {
            id: boundedNonNegativeInteger(associatedSpatial.id),
            number: boundedString(associatedSpatial.number, 128),
            name: boundedString(associatedSpatial.name, 512),
            type: boundedString(associatedSpatial.type ?? associatedSpatial.kind, 128)
          }
        : null,
    taggedSpatial:
      taggedSpatial
        ? {
            id: boundedNonNegativeInteger(taggedSpatial.id),
            number: boundedString(taggedSpatial.number, 128),
            name: boundedString(taggedSpatial.name, 512),
            type: boundedString(taggedSpatial.type ?? taggedSpatial.kind, 128)
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
            primaryLabel: boundedString(electricalCircuit.primaryLabel, 256),
            panel: boundedString(electricalCircuit.panel, 256),
            circuit: boundedString(electricalCircuit.circuit, 256),
            systemId: boundedScalar(electricalCircuit.systemId, 256)
          }
        : null,
    anchor: pickProjectedPoint(obj.anchor),
    bbox:
      bbox
        ? {
            center: bboxCenter,
            model: bboxModel,
            image: bboxImage
          }
        : null,
    geometry,
    orientation:
      orientation
        ? {
            facing: pickVector(orientation.facing),
            hand: pickVector(orientation.hand),
            curveDirection: pickVector(orientation.curveDirection),
            rotationRadians: pickNumber(orientation.rotationRadians),
            planAzimuthRadians: pickNumber(orientation.planAzimuthRadians),
            planAzimuthSource: boundedString(orientation.planAzimuthSource, 128),
            mirrored: pickBool(orientation.mirrored),
            handFlipped: pickBool(orientation.handFlipped),
            facingFlipped: pickBool(orientation.facingFlipped),
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
    const summarizedItems = (obj.itemsSampled as unknown[])
      .slice(0, maxItems)
      .map(summarizeVisibleElementItem)
      .filter((item): item is Record<string, unknown> => !!item);
    const sliceEntries = (key: string): Array<{ key: string; count: number }> | null => {
      const entries = summary && Array.isArray(summary[key]) ? (summary[key] as unknown[]) : null;
      if (!entries) return null;
      return entries.slice(0, maxCountEntries).flatMap(entry => {
        const record = asObject(entry);
        const label = boundedString(record?.key, 256);
        const count = boundedNonNegativeInteger(record?.count);
        return label && count !== null ? [{ key: label, count }] : [];
      });
    };
    const image = asObject(obj.image);
    const coverage = asObject(obj.coverage);
    const modelBounds = asObject(obj.modelBoundsFt);
    const mapping = asObject(obj.mapping);
    return {
      _compacted: true,
      compaction: "visible-elements-inventory-summary",
      approx_json_chars: boundedNonNegativeInteger(obj.approx_json_chars) ?? approxJsonChars(value),
      ...(typeof obj.ok === "boolean" ? { ok: obj.ok } : {}),
      compactionSchemaVersion: "spatial-observation-summary/v1",
      sourceSchemaVersion: null,
      observationId: boundedString(obj.observationId, 256) ?? boundedString(obj.frameId, 256),
      frameId: boundedString(obj.frameId, 256),
      viewId: boundedNonNegativeInteger(obj.viewId),
      viewType: boundedString(obj.viewType, 128),
      viewName: boundedString(obj.viewName, 512),
      path: boundedString(obj.path, 2048),
      image: {
        path: boundedString(image?.path, 2048) ?? boundedString(obj.path, 2048),
        widthPx: boundedNonNegativeInteger(image?.widthPx ?? obj.widthPx),
        heightPx: boundedNonNegativeInteger(image?.heightPx ?? obj.heightPx)
      },
      widthPx: boundedNonNegativeInteger(obj.widthPx),
      heightPx: boundedNonNegativeInteger(obj.heightPx),
      targetLevel: sanitizeTargetLevel(obj.targetLevel),
      count: boundedNonNegativeInteger(obj.count) ?? summarizedItems.length,
      scanned: boundedNonNegativeInteger(obj.scanned),
      truncated: pickBool(obj.truncated),
      coverage: {
        count: boundedNonNegativeInteger(coverage?.count ?? obj.count) ?? summarizedItems.length,
        scanned: boundedNonNegativeInteger(coverage?.scanned ?? obj.scanned),
        truncated: pickBool(coverage?.truncated ?? obj.truncated),
        resultBounds: sanitizeResultBounds(coverage?.resultBounds)
      },
      ...(typeof obj.modelBoundsApplied === "boolean" ? { modelBoundsApplied: obj.modelBoundsApplied } : {}),
      ...(modelBounds && pickVector(modelBounds.min) && pickVector(modelBounds.max)
        ? { modelBoundsFt: { min: pickVector(modelBounds.min), max: pickVector(modelBounds.max) } }
        : {}),
      ...(mapping ? { mapping: sanitizeObservationMapping(mapping) } : {}),
      itemsSampled: summarizedItems,
      itemsOmitted:
        boundedNonNegativeInteger(obj.itemsOmitted) !== null
          ? saturatingSafeAdd(boundedNonNegativeInteger(obj.itemsOmitted)!, Math.max(0, (obj.itemsSampled as unknown[]).length - maxItems))
          : null,
      summary:
        summary
          ? {
              categoryCounts: sliceEntries("categoryCounts") ?? [],
              roomCounts: sliceEntries("roomCounts") ?? [],
              spaceCounts: sliceEntries("spaceCounts") ?? [],
              hostCategoryCounts: sliceEntries("hostCategoryCounts") ?? [],
              familyTypeCounts: sliceEntries("familyTypeCounts") ?? []
            }
          : null,
      warnings: sanitizeWarnings(obj.warnings)
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
    compactionSchemaVersion: "spatial-observation-summary/v1",
    sourceSchemaVersion: null,
    observationId: boundedString(obj.observationId ?? obj.observation_id, 256) ?? boundedString(obj.frameId ?? obj.frame_id, 256),
    frameId: boundedString(obj.frameId ?? obj.frame_id, 256),
    viewId: boundedNonNegativeInteger(obj.viewId ?? obj.view_id),
    viewType: boundedString(obj.viewType ?? obj.view_type, 128),
    viewName: boundedString(obj.viewName ?? obj.view_name, 512),
    path: boundedString(obj.path, 2048),
    image: {
      path: boundedString(asObject(obj.image)?.path, 2048) ?? boundedString(obj.path, 2048),
      widthPx: boundedNonNegativeInteger(asObject(obj.image)?.widthPx ?? obj.widthPx),
      heightPx: boundedNonNegativeInteger(asObject(obj.image)?.heightPx ?? obj.heightPx)
    },
    widthPx: boundedNonNegativeInteger(obj.widthPx),
    heightPx: boundedNonNegativeInteger(obj.heightPx),
    targetLevel: sanitizeTargetLevel(obj.targetLevel ?? obj.target_level),
    count: boundedNonNegativeInteger(obj.count) ?? items.length,
    scanned: boundedNonNegativeInteger(obj.scanned),
    truncated: pickBool(obj.truncated),
    coverage: {
      count: boundedNonNegativeInteger(obj.count) ?? items.length,
      scanned: boundedNonNegativeInteger(obj.scanned),
      truncated: pickBool(obj.truncated),
      resultBounds: sanitizeResultBounds(obj.resultBounds ?? obj.result_bounds)
    },
    ...(typeof obj.modelBoundsApplied === "boolean"
      ? { modelBoundsApplied: obj.modelBoundsApplied }
      : {}),
    ...(modelBoundsMin && modelBoundsMax
      ? { modelBoundsFt: { min: modelBoundsMin, max: modelBoundsMax } }
      : {}),
    ...(mapping ? { mapping: sanitizeObservationMapping(mapping) } : {}),
    summary: {
      categoryCounts: pickCountEntries(categories, maxCountEntries),
      roomCounts: pickCountEntries(roomKeys, maxCountEntries),
      spaceCounts: pickCountEntries(spaceKeys, maxCountEntries),
      hostCategoryCounts: pickCountEntries(hostCategories, maxCountEntries),
      familyTypeCounts: pickCountEntries(familyTypes, maxCountEntries)
    },
    warnings: sanitizeWarnings(obj.warnings),
    itemsSampled: sampledItems,
    itemsOmitted: Math.max(0, items.length - sampledItems.length)
  };

  return compacted;
}

export function compactParameterReadResultForPrompt(value: unknown, options?: { maxEvidence?: number; maxElementIds?: number }): unknown {
  const obj = asObject(value);
  if (!obj) return value;
  const items = Array.isArray(obj.items) ? obj.items : [];
  const exactLiteral = pickString(obj.valueEquals);
  const containsLiteral = pickString(obj.valueContains);
  const literal = exactLiteral ?? containsLiteral;
  const literalLower = literal?.toLowerCase() ?? "";
  const caseSensitive = pickBool(obj.caseSensitive) === true;
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
      const literalMatch = literalLower
        ? exactLiteral
          ? caseSensitive ? parameterValue === literal : valueLower === literalLower
          : caseSensitive ? parameterValue.includes(literal!) : valueLower.includes(literalLower)
        : false;
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
    valueContains: containsLiteral,
    valueEquals: exactLiteral,
    caseSensitive,
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
    const rawRows = Array.isArray(row?.rows) ? row.rows : [];
    const rows = rawRows.slice(0, maxRows);
    const inheritedRowsOmitted = Number.isFinite(Number(row?.rowsOmitted)) ? Math.max(0, Math.floor(Number(row?.rowsOmitted))) : 0;
    const rowsOmitted = inheritedRowsOmitted + Math.max(0, rawRows.length - rows.length);
    return {
      totalRows: row?.totalRows ?? null,
      totalColumns: row?.totalColumns ?? null,
      rowOffset: row?.rowOffset ?? null,
      columnOffset: row?.columnOffset ?? null,
      returnedRows: row?.returnedRows ?? null,
      returnedColumns: row?.returnedColumns ?? null,
      hasMoreRows: row?.hasMoreRows ?? null,
      nextRowOffset: row?.nextRowOffset ?? null,
      hasMoreColumns: row?.hasMoreColumns ?? null,
      nextColumnOffset: row?.nextColumnOffset ?? null,
      rows,
      rowsOmitted,
      rowsComplete: row?.rowsComplete !== false && row?.hasMoreRows !== true && rowsOmitted === 0
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
    table: table ? { header: compactRows(table.header, 25), body: compactRows(table.body, 500) } : null
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
  } else if (pathName === "/revit/locate-elements") {
    resultJson = compactLocateElementsResultForPrompt(result.result_json);
  } else if (pathName === "/revit/find-elements") {
    resultJson = compactFindElementsResultForPrompt(result.result_json);
  }

  return {
    ...result,
    ...(attachments ? { attachments } : {}),
    ...(resultJson !== undefined ? { result_json: resultJson } : {})
  };
}

export function compactFindElementsResultForPrompt(
  value: unknown,
  options: { maxItems?: number; maxElementIds?: number } = {}
): unknown {
  const root = asObject(value);
  if (!root || !Array.isArray(root.elementIds)) return value;
  const maxItems = Math.max(1, Math.min(500, options.maxItems ?? 500));
  const maxElementIds = Math.max(1, Math.min(500, options.maxElementIds ?? 500));
  const rawItems = Array.isArray(root.items) ? root.items : [];
  const items = rawItems.slice(0, maxItems).map(value => {
    const item = asObject(value) ?? {};
    const identityMatch = asObject(item.identityMatch);
    const identityParameterEvidence = asObject(item.identityParameterEvidence);
    return {
      elementId: item.elementId ?? item.id ?? null,
      category: item.category ?? null,
      builtInCategory: item.builtInCategory ?? null,
      name: item.name ?? null,
      familyName: item.familyName ?? null,
      typeName: item.typeName ?? null,
      mark: item.mark ?? null,
      superComponentId: item.superComponentId ?? null,
      isNested: item.isNested ?? false,
      identityMatch: identityMatch ? {
        score: identityMatch.score ?? null,
        matchedTerm: identityMatch.matchedTerm ?? null,
        matchedTokens: Array.isArray(identityMatch.matchedTokens) ? identityMatch.matchedTokens.slice(0, 16) : [],
        matchedFields: Array.isArray(identityMatch.matchedFields) ? identityMatch.matchedFields.slice(0, 8) : []
      } : null,
      identityParameterEvidence: identityParameterEvidence ? {
        text: identityParameterEvidence.text ?? null,
        textNormalized: identityParameterEvidence.textNormalized ?? null,
        source: identityParameterEvidence.source ?? null,
        parameterName: identityParameterEvidence.parameterName ?? null
      } : null,
      matchedText: item.matchedText ?? null,
      matchedTextSource: item.matchedTextSource ?? null,
      matchedParameterName: item.matchedParameterName ?? null,
      ownerViewId: item.ownerViewId ?? null,
      sourceViewId: item.sourceViewId ?? null
    };
  });
  const elementIds = root.elementIds
    .filter(id => Number.isSafeInteger(id) && (id as number) > 0)
    .slice(0, maxElementIds);
  const inheritedItemsOmitted = Number.isFinite(Number(root.itemsOmitted)) ? Math.max(0, Math.floor(Number(root.itemsOmitted))) : 0;
  const inheritedIdsOmitted = Number.isFinite(Number(root.elementIdsOmitted)) ? Math.max(0, Math.floor(Number(root.elementIdsOmitted))) : 0;
  const itemsOmitted = inheritedItemsOmitted + Math.max(0, rawItems.length - items.length);
  const elementIdsOmitted = inheritedIdsOmitted + Math.max(0, root.elementIds.length - elementIds.length);
  return {
    _compacted: true,
    compaction: "find-elements-identity",
    status: root.status ?? null,
    scope: root.scope ?? null,
    count: root.count ?? root.elementIds.length,
    elementIds,
    elementIdsOmitted,
    categoryFilterApplied: root.categoryFilterApplied === true,
    resolvedCategories: Array.isArray(root.resolvedCategories) ? root.resolvedCategories.slice(0, 100) : [],
    textFilterApplied: root.textFilterApplied === true,
    textSearch: root.textSearch ?? null,
    identityFilterApplied: root.identityFilterApplied === true,
    identityTerms: Array.isArray(root.identityTerms) ? root.identityTerms.slice(0, 8) : [],
    physicalElementsOnlyApplied: root.physicalElementsOnlyApplied === true,
    topLevelInstancesOnlyApplied: root.topLevelInstancesOnlyApplied === true,
    identityAcronymExpansionApplied: root.identityAcronymExpansionApplied === true,
    identityAcronyms: Array.isArray(root.identityAcronyms) ? root.identityAcronyms.slice(0, 8) : [],
    identitySeedCategoryIds: Array.isArray(root.identitySeedCategoryIds) ? root.identitySeedCategoryIds.slice(0, 100) : [],
    identityExpansionCount: root.identityExpansionCount ?? 0,
    identityExpansionScanCapReached: root.identityExpansionScanCapReached === true,
    items,
    itemsOmitted,
    truncated: root.truncated === true,
    scanCapReached: root.scanCapReached === true,
    itemsComplete: root.itemsComplete !== false && root.truncated !== true && root.scanCapReached !== true && itemsOmitted === 0 && elementIdsOmitted === 0,
    warnings: Array.isArray(root.warnings) ? root.warnings.slice(0, 20) : []
  };
}

export function compactLocateElementsResultForPrompt(
  value: unknown,
  options: { maxItems?: number } = {}
): unknown {
  const root = asObject(value);
  if (!root || !Array.isArray(root.items)) return value;

  const maxItems = Math.max(1, Math.min(2000, options.maxItems ?? 500));
  const inheritedOmitted = (record: Record<string, unknown> | null, key: string): number => {
    const numeric = Number(record?.[key]);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
  };
  const compactSpatialCandidate = (value: unknown): Record<string, unknown> | null => {
    const candidate = asObject(value);
    if (!candidate) return null;
    const equivalentSourceIds = Array.isArray(candidate.equivalentSourceIds)
      ? candidate.equivalentSourceIds
      : [];
    const equivalentPhaseNames = Array.isArray(candidate.equivalentPhaseNames)
      ? candidate.equivalentPhaseNames
      : [];
    return {
      spatialKind: candidate.spatialKind ?? null,
      number: candidate.number ?? null,
      name: candidate.name ?? null,
      levelName: candidate.levelName ?? null,
      spatialId: candidate.spatialId ?? null,
      sourceScopedId: candidate.sourceScopedId ?? null,
      sourceScope: candidate.sourceScope ?? null,
      linkInstanceId: candidate.linkInstanceId ?? null,
      linkInstanceName: candidate.linkInstanceName ?? null,
      sourceDocumentTitle: candidate.sourceDocumentTitle ?? null,
      phaseId: candidate.phaseId ?? null,
      phaseName: candidate.phaseName ?? null,
      method: candidate.method ?? null,
      boundaryDistanceFt: candidate.boundaryDistanceFt ?? null,
      levelDeltaFt: candidate.levelDeltaFt ?? null,
      equivalentSourceIds: equivalentSourceIds.slice(0, 20),
      equivalentSourceIdsOmitted:
        inheritedOmitted(candidate, "equivalentSourceIdsOmitted") +
        Math.max(0, equivalentSourceIds.length - 20),
      equivalentPhaseNames: equivalentPhaseNames.slice(0, 20),
      equivalentPhaseNamesOmitted:
        inheritedOmitted(candidate, "equivalentPhaseNamesOmitted") +
        Math.max(0, equivalentPhaseNames.length - 20)
    };
  };
  const compactSpatialContext = (value: unknown): Record<string, unknown> | null => {
    const context = asObject(value);
    if (!context) return null;
    const matches = Array.isArray(context.matches) ? context.matches : [];
    const nearestCandidates = Array.isArray(context.nearestCandidates) ? context.nearestCandidates : [];
    const compactMatches = context.status === "resolved"
      ? []
      : matches.slice(0, 20).map(compactSpatialCandidate).filter(Boolean);
    const compactNearest = nearestCandidates.slice(0, 20).map(compactSpatialCandidate).filter(Boolean);
    return {
      status: context.status ?? null,
      spatialKindPreference: context.spatialKindPreference ?? null,
      spatialVerticalScope: context.spatialVerticalScope ?? context.spatial_vertical_scope ?? null,
      method: context.method ?? null,
      phaseFallbackUsed: context.phaseFallbackUsed ?? context.phase_fallback_used ?? false,
      unresolvedReason: context.unresolvedReason ?? context.unresolved_reason ?? null,
      representativePoint: context.representativePoint ?? context.representative_point ?? null,
      selected: compactSpatialCandidate(context.selected),
      matches: compactMatches,
      matchesOmitted:
        inheritedOmitted(context, "matchesOmitted") +
        (context.status === "resolved" ? 0 : Math.max(0, matches.length - compactMatches.length)),
      nearestCandidates: compactNearest,
      nearestCandidatesOmitted:
        inheritedOmitted(context, "nearestCandidatesOmitted") +
        Math.max(0, nearestCandidates.length - compactNearest.length)
    };
  };

  const items = root.items.slice(0, maxItems).map((value) => {
    const item = asObject(value) ?? {};
    return {
      elementId: item.elementId ?? item.element_id ?? item.id ?? null,
      category: item.category ?? null,
      builtInCategory: item.builtInCategory ?? item.built_in_category ?? null,
      name: item.name ?? null,
      typeId: item.typeId ?? item.type_id ?? null,
      typeName: item.typeName ?? item.type_name ?? null,
      familyName: item.familyName ?? item.family_name ?? null,
      mark: item.mark ?? null,
      levelName: item.levelName ?? item.level_name ?? null,
      roomNumber: item.roomNumber ?? item.room_number ?? null,
      roomName: item.roomName ?? item.room_name ?? null,
      spatialKind: item.spatialKind ?? item.spatial_kind ?? null,
      spatialId: item.spatialId ?? item.spatial_id ?? null,
      hostId: item.hostId ?? item.host_id ?? null,
      superComponentId: item.superComponentId ?? item.super_component_id ?? null,
      topLevelParentId: item.topLevelParentId ?? item.top_level_parent_id ?? null,
      isNested: item.isNested ?? item.is_nested ?? false,
      nearDistanceFt: item.nearDistanceFt ?? item.near_distance_ft ?? null,
      center: item.center ?? null,
      spatialContext: compactSpatialContext(item.spatialContext ?? item.spatial_context)
    };
  });

  const itemsOmitted = inheritedOmitted(root, "itemsOmitted") + Math.max(0, root.items.length - items.length);
  return {
    _compacted: true,
    compaction: "locate-elements-spatial-context",
    status: root.status ?? null,
    count: root.count ?? root.items.length,
    requestedElementCount: root.requestedElementCount ?? null,
    requestedElementIdsMissing: Array.isArray(root.requestedElementIdsMissing) ? root.requestedElementIdsMissing.slice(0, 500) : [],
    requestedElementIdsMissingCount: root.requestedElementIdsMissingCount ?? 0,
    truncated: root.truncated === true,
    spatialResolution: root.spatialResolution ?? null,
    spatialVerticalScope: root.spatialVerticalScope ?? root.spatial_vertical_scope ?? null,
    items,
    itemsOmitted,
    itemsComplete: root.itemsComplete !== false && itemsOmitted === 0,
    warnings: Array.isArray(root.warnings) ? root.warnings.slice(0, 20) : []
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
