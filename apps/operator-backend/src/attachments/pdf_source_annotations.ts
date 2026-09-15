import {
  buildPdfAnnotationCoordinateMapper, extractPdfVectorPointSequence,
  mapPdfVectorPointsToUnit, normalizePdfRectToUnit
} from "../redline/pdf_annotation_geometry.js";

const MAX_ANNOTATIONS = 64;
const MAX_ITEM_CHARACTERS = 6_000;
const MAX_CONTENT_CHARACTERS = 500;

type SourceAnnotation = {
  source_index: number;
  subtype: string;
  contents: string;
  contents_truncated: boolean;
  geometry_status: "complete" | "not_supported_vector" | "malformed_or_outside_page" | "omitted_for_output_budget";
  rgb?: number[];
  annotation_bounds?: { min_u: number; min_v: number; max_u: number; max_v: number };
  vertices?: Array<{ u: number; v: number }>;
  vertex_count?: number;
  closed?: boolean;
};

function numericSequence(value: unknown, maxLength = 4_000): number[] | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as ArrayLike<unknown>;
  if (!Number.isSafeInteger(raw.length) || raw.length < 1 || raw.length > maxLength) return null;
  const values = Array.from(raw);
  return values.every((item): item is number => typeof item === "number" && Number.isFinite(item)) ? values : null;
}

/** Projects reference content only. The image remains necessary to interpret marks. */
export function projectPdfSourceAnnotations(annotations: readonly unknown[], viewport: unknown, pageView: unknown) {
  const mapper = buildPdfAnnotationCoordinateMapper({ viewport, pageView });
  if (!mapper) throw new Error("Invalid annotation page coordinate system.");
  const items: SourceAnnotation[] = [];
  let used = 0, omitted = 0, hidden = 0, unavailable = 0;
  for (let index = 0; index < annotations.length; index++) {
    const raw = annotations[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { omitted++; continue; }
    const a = raw as Record<string, unknown>;
    if (typeof a.annotationFlags === "number" && Number.isInteger(a.annotationFlags)
      && (a.annotationFlags & (1 | 2 | 32)) !== 0) { hidden++; continue; }
    if (items.length >= MAX_ANNOTATIONS) { omitted++; continue; }
    const subtype = typeof a.subtype === "string" ? a.subtype.slice(0, 80) : "Unknown";
    const contents = a.contentsObj && typeof a.contentsObj === "object"
      ? (a.contentsObj as Record<string, unknown>).str : undefined;
    const sourceText = typeof contents === "string" ? contents : "";
    const item: SourceAnnotation = {
      source_index: index + 1, subtype, contents: sourceText.slice(0, MAX_CONTENT_CHARACTERS),
      contents_truncated: sourceText.length > MAX_CONTENT_CHARACTERS, geometry_status: "not_supported_vector"
    };
    const color = numericSequence(a.color, 3);
    if (color?.length === 3 && color.every(c => Number.isInteger(c) && c >= 0 && c <= 255)) item.rgb = color;
    const rect = numericSequence(a.rect, 4);
    if (rect?.length === 4) {
      const box = normalizePdfRectToUnit(rect as [number, number, number, number], mapper);
      if (box) item.annotation_bounds = { min_u: box.minX, min_v: box.minY, max_u: box.maxX, max_v: box.maxY };
    }
    if (["Line", "PolyLine", "Polygon"].includes(subtype)) {
      const coordinates = numericSequence(subtype === "Line" ? a.lineCoordinates : a.vertices);
      const points = coordinates ? extractPdfVectorPointSequence(subtype, coordinates) : [];
      const normalized = points.length ? mapPdfVectorPointsToUnit(points, mapper) : [];
      if (normalized.length === points.length && points.length >= 2) {
        item.geometry_status = "complete";
        item.vertex_count = normalized.length;
        item.vertices = normalized.map(p => ({ u: p.x, v: p.y }));
        if (subtype === "Polygon") item.closed = true;
      } else item.geometry_status = "malformed_or_outside_page";
    }
    let serialized = JSON.stringify(item);
    // Never return a truncated vector as a complete line or polygon.
    if (serialized.length + 1 > MAX_ITEM_CHARACTERS - used && item.vertices) {
      delete item.vertices;
      item.geometry_status = "omitted_for_output_budget";
      serialized = JSON.stringify(item);
    }
    if (serialized.length + 1 > MAX_ITEM_CHARACTERS - used) { omitted++; continue; }
    if (item.geometry_status !== "complete") unavailable++;
    used += serialized.length + 1;
    items.push(item);
  }
  return {
    source_annotation_count: annotations.length, returned_annotation_count: items.length,
    hidden_annotation_count: hidden, omitted_annotation_count: omitted,
    returned_annotations_without_vector_geometry: unavailable,
    coordinate_system: "full displayed page; normalized u right, v down; origin top left",
    bounds_meaning: "annotation rectangles, not route centerlines; bounds may be clipped to the page",
    source_content_only: true, items
  };
}
