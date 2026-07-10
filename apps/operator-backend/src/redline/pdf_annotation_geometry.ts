export type PdfAnnotationPoint = { x: number; y: number };
export type PdfAnnotationBox = { minX: number; minY: number; maxX: number; maxY: number };

export type PdfAnnotationCoordinateMapper = {
  width: number;
  height: number;
  mapPoint: (x: number, y: number) => PdfAnnotationPoint | null;
};

function toFiniteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

export function buildPdfAnnotationCoordinateMapper(args: {
  viewport: any;
  pageView: unknown;
}): PdfAnnotationCoordinateMapper | null {
  const viewportWidth = Number(args.viewport?.width);
  const viewportHeight = Number(args.viewport?.height);
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) return null;

  const convert = typeof args.viewport?.convertToViewportPoint === "function"
    ? args.viewport.convertToViewportPoint.bind(args.viewport)
    : null;
  if (convert) {
    return {
      width: viewportWidth,
      height: viewportHeight,
      mapPoint: (x: number, y: number) => {
        const output = convert(x, y);
        if (!Array.isArray(output) || output.length < 2) return null;
        const px = Number(output[0]);
        const py = Number(output[1]);
        return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : null;
      }
    };
  }

  const view = Array.isArray(args.pageView) && args.pageView.length >= 4 ? args.pageView : null;
  if (!view) return null;
  const x0 = Number(view[0]);
  const y0 = Number(view[1]);
  const x1 = Number(view[2]);
  const y1 = Number(view[3]);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (spanX <= 0 || spanY <= 0) return null;

  return {
    width: viewportWidth,
    height: viewportHeight,
    mapPoint: (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return {
        x: ((x - minX) / spanX) * viewportWidth,
        y: ((maxY - y) / spanY) * viewportHeight
      };
    }
  };
}

export function normalizePdfRectToUnit(
  rect: [number, number, number, number],
  mapper: PdfAnnotationCoordinateMapper
): PdfAnnotationBox | null {
  if (mapper.width <= 0 || mapper.height <= 0) return null;
  const [x0, y0, x1, y1] = rect.map(Number) as [number, number, number, number];
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const corners = [
    mapper.mapPoint(x0, y0),
    mapper.mapPoint(x0, y1),
    mapper.mapPoint(x1, y0),
    mapper.mapPoint(x1, y1)
  ].filter((point): point is PdfAnnotationPoint => !!point);
  if (corners.length < 2) return null;

  const left = Math.max(0, Math.min(mapper.width, Math.min(...corners.map((point) => point.x))));
  const right = Math.max(0, Math.min(mapper.width, Math.max(...corners.map((point) => point.x))));
  const top = Math.max(0, Math.min(mapper.height, Math.min(...corners.map((point) => point.y))));
  const bottom = Math.max(0, Math.min(mapper.height, Math.max(...corners.map((point) => point.y))));
  if (right <= left || bottom <= top) return null;

  const box = { minX: left / mapper.width, minY: top / mapper.height, maxX: right / mapper.width, maxY: bottom / mapper.height };
  if (box.maxX - box.minX <= 1e-6 || box.maxY - box.minY <= 1e-6) return null;
  if (box.maxX <= 0 || box.minX >= 1 || box.maxY <= 0 || box.minY >= 1) return null;
  return {
    minX: Math.max(0, Math.min(1, box.minX)),
    minY: Math.max(0, Math.min(1, box.minY)),
    maxX: Math.max(0, Math.min(1, box.maxX)),
    maxY: Math.max(0, Math.min(1, box.maxY))
  };
}

export function normalizedRectToPixelBox(args: {
  norm: PdfAnnotationBox;
  imageWidth: number;
  imageHeight: number;
  minMarginPx?: number;
}): { x: number; y: number; w: number; h: number; area: number } | null {
  const width = Math.max(1, Math.floor(args.imageWidth));
  const height = Math.max(1, Math.floor(args.imageHeight));
  const minX = Math.max(0, Math.min(1, args.norm.minX));
  const minY = Math.max(0, Math.min(1, args.norm.minY));
  const maxX = Math.max(0, Math.min(1, args.norm.maxX));
  const maxY = Math.max(0, Math.min(1, args.norm.maxY));
  if (maxX <= minX || maxY <= minY) return null;

  let x0 = Math.floor(minX * width);
  let y0 = Math.floor(minY * height);
  let x1 = Math.ceil(maxX * width);
  let y1 = Math.ceil(maxY * height);
  const margin = Math.max(args.minMarginPx ?? 10, Math.round(Math.max(x1 - x0, y1 - y0) * 0.12));
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(width, x1 + margin);
  y1 = Math.min(height, y1 + margin);
  if (x1 <= x0 || y1 <= y0) return null;
  const boxWidth = x1 - x0;
  const boxHeight = y1 - y0;
  if (boxWidth * boxHeight < 60) return null;
  return { x: x0, y: y0, w: boxWidth, h: boxHeight, area: boxWidth * boxHeight };
}

function flattenNumericPairSequence(raw: unknown): number[] {
  if (!raw || typeof raw !== "object") return [];
  const length = toFiniteNumber((raw as any).length);
  if (length === null || length <= 0) return [];
  const output: number[] = [];
  for (let index = 0; index < Math.min(50_000, Math.floor(length)); index += 1) {
    const value = toFiniteNumber((raw as any)[index]);
    if (value !== null) output.push(value);
  }
  return output;
}

export function extractPdfPointSequence(raw: unknown): PdfAnnotationPoint[] {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw) && raw.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    const points = raw
      .map((item) => ({ x: toFiniteNumber((item as any).x ?? (item as any).X), y: toFiniteNumber((item as any).y ?? (item as any).Y) }))
      .filter((point): point is { x: number; y: number } => point.x !== null && point.y !== null);
    if (points.length > 0) return points.slice(0, 2000);
  }
  const coordinates = flattenNumericPairSequence(raw);
  const points: PdfAnnotationPoint[] = [];
  for (let index = 0; index + 1 < coordinates.length; index += 2) {
    points.push({ x: coordinates[index]!, y: coordinates[index + 1]! });
  }
  return points.slice(0, 2000);
}

export function mapPdfPointsToUnit(points: PdfAnnotationPoint[], mapper: PdfAnnotationCoordinateMapper): PdfAnnotationPoint[] {
  if (mapper.width <= 0 || mapper.height <= 0) return [];
  const output: PdfAnnotationPoint[] = [];
  for (const point of points) {
    const mapped = mapper.mapPoint(point.x, point.y);
    if (!mapped) continue;
    if (mapped.x < -10_000 || mapped.x > mapper.width + 10_000 || mapped.y < -10_000 || mapped.y > mapper.height + 10_000) continue;
    output.push({
      x: Math.max(0, Math.min(1, mapped.x / mapper.width)),
      y: Math.max(0, Math.min(1, mapped.y / mapper.height))
    });
  }
  return output;
}

export function extractInkListsPdf(inkLists: unknown): PdfAnnotationPoint[][] {
  if (!Array.isArray(inkLists)) return [];
  return inkLists
    .map(extractPdfPointSequence)
    .filter((stroke) => stroke.length >= 2)
    .slice(0, 200);
}

export function mapInkListsToUnit(strokes: PdfAnnotationPoint[][], mapper: PdfAnnotationCoordinateMapper): PdfAnnotationPoint[][] {
  return strokes
    .map((stroke) => mapPdfPointsToUnit(stroke, mapper))
    .filter((stroke) => stroke.length >= 2)
    .slice(0, 200);
}

export function unionPdfBoxes(boxes: PdfAnnotationBox[]): PdfAnnotationBox | null {
  if (boxes.length === 0) return null;
  return {
    minX: Math.min(...boxes.map((box) => box.minX)),
    minY: Math.min(...boxes.map((box) => box.minY)),
    maxX: Math.max(...boxes.map((box) => box.maxX)),
    maxY: Math.max(...boxes.map((box) => box.maxY))
  };
}

export function normBoxCenter(box: PdfAnnotationBox): PdfAnnotationPoint {
  return { x: (box.minX + box.maxX) * 0.5, y: (box.minY + box.maxY) * 0.5 };
}

export function normBoxIntersectionArea(a: PdfAnnotationBox, b: PdfAnnotationBox): number {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  return maxX <= minX || maxY <= minY ? 0 : (maxX - minX) * (maxY - minY);
}

export function normBoxDistance(a: PdfAnnotationBox, b: PdfAnnotationBox): number {
  const left = normBoxCenter(a);
  const right = normBoxCenter(b);
  return Math.hypot(left.x - right.x, left.y - right.y);
}

export function normBoxWidth(box: PdfAnnotationBox): number {
  return Math.max(0, box.maxX - box.minX);
}

export function normBoxHeight(box: PdfAnnotationBox): number {
  return Math.max(0, box.maxY - box.minY);
}

export function normalizeInkListsToUnitBoxes(inkLists: unknown, mapper: PdfAnnotationCoordinateMapper): PdfAnnotationBox[] {
  if (!Array.isArray(inkLists) || mapper.width <= 0 || mapper.height <= 0) return [];
  const output: PdfAnnotationBox[] = [];
  for (const stroke of inkLists) {
    const mapped = mapPdfPointsToUnit(extractPdfPointSequence(stroke), mapper);
    if (mapped.length < 2) continue;
    const box = unionPdfBoxes(mapped.map((point) => ({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y })));
    if (!box || box.maxX <= box.minX || box.maxY <= box.minY) continue;
    output.push(box);
  }
  return output;
}

export function normalizePdfMarkupAnnotationToUnitBox(args: {
  annotation: any;
  mapper: PdfAnnotationCoordinateMapper;
}): PdfAnnotationBox | null {
  const subtype = typeof args.annotation?.subtype === "string" ? args.annotation.subtype.trim() : "";
  if (!subtype) return null;
  if (subtype === "Text" && typeof args.annotation?.inReplyTo === "string" && args.annotation.inReplyTo.trim()) return null;
  if (subtype === "Ink") {
    const inkBox = unionPdfBoxes(normalizeInkListsToUnitBoxes(args.annotation?.inkLists, args.mapper));
    if (inkBox) return inkBox;
  }
  const rect = Array.isArray(args.annotation?.rect) && args.annotation.rect.length >= 4
    ? args.annotation.rect.slice(0, 4).map(Number) as [number, number, number, number]
    : null;
  return rect ? normalizePdfRectToUnit(rect, args.mapper) : null;
}

export function clampPixelBoxToImage(
  box: { x: number; y: number; w: number; h: number },
  imageWidth: number,
  imageHeight: number
): { x: number; y: number; w: number; h: number; area: number } | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(Math.max(1, imageWidth), Math.ceil(box.x + box.w));
  const y1 = Math.min(Math.max(1, imageHeight), Math.ceil(box.y + box.h));
  if (x1 <= x0 || y1 <= y0) return null;
  const width = x1 - x0;
  const height = y1 - y0;
  return width * height < 30 ? null : { x: x0, y: y0, w: width, h: height, area: width * height };
}

export function testOnlyNormalizePdfRectToUnit(args: {
  rect: [number, number, number, number];
  pageView: [number, number, number, number];
  viewportWidth: number;
  viewportHeight: number;
}): PdfAnnotationBox | null {
  const mapper = buildPdfAnnotationCoordinateMapper({
    viewport: { width: args.viewportWidth, height: args.viewportHeight },
    pageView: args.pageView
  });
  return mapper ? normalizePdfRectToUnit(args.rect, mapper) : null;
}
