import crypto from "node:crypto";
import fs from "node:fs";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";
import {
  extractSheetVectorTextV1,
  type SheetVectorTextExtractionReceiptV1
} from "./sheet_vector_text.js";

export type PixelPointV1 = { x: number; y: number };
export type PixelBoundsV1 = { min: PixelPointV1; max: PixelPointV1 };

export type SheetVectorElementTopologyInputV1 = {
  schema_version: 1;
  source_pdf_path: string;
  source_pdf_sha256: string;
  registered_render_path: string;
  registered_render_sha256: string;
  render_width_px: number;
  render_height_px: number;
  page?: number;
  include_pixel_bounds?: PixelBoundsV1;
  junction_tolerance_px?: number;
  maximum_groups?: number;
  maximum_segments?: number;
  maximum_junctions?: number;
};

export type SheetVectorElementSegmentV1 = {
  segment_id: string;
  kind: "line" | "cubic_bezier";
  start: PixelPointV1;
  end: PixelPointV1;
  control_points?: [PixelPointV1, PixelPointV1];
};

export type SheetVectorElementGroupV1 = {
  source_group_id: string;
  source_view_region_id: string | null;
  pixel_bounds: PixelBoundsV1;
  path_count: number;
  segment_count: number;
  text_fragments: string[];
  segments: SheetVectorElementSegmentV1[];
  evidence_basis: "pdf_marked_content_and_vector_paths";
};

export type SheetVectorEndpointJunctionV1 = {
  junction_id: string;
  first: { source_group_id: string; segment_id: string; endpoint: "start" | "end"; point: PixelPointV1 };
  second: { source_group_id: string; segment_id: string; endpoint: "start" | "end"; point: PixelPointV1 };
  distance_px: number;
  evidence_basis: "cross_group_vector_endpoint_proximity";
};

export type SheetVectorElementTopologyReceiptV1 = {
  schema: "operator.sheet_vector_element_topology.v1";
  source_pdf_sha256: string;
  registered_render_sha256: string;
  page: number;
  render_width_px: number;
  render_height_px: number;
  source_render_verification: SheetVectorTextExtractionReceiptV1["source_render_verification"];
  marked_content_supported: boolean;
  include_pixel_bounds: PixelBoundsV1 | null;
  junction_tolerance_px: number;
  operator_summary: {
    operator_count: number;
    marked_content_element_occurrence_count: number;
    marked_content_group_count: number;
    vector_path_count: number;
    vector_segment_count: number;
    unsupported_path_operation_count: number;
    emitted_group_count: number;
    emitted_segment_count: number;
  };
  groups: SheetVectorElementGroupV1[];
  endpoint_junctions: SheetVectorEndpointJunctionV1[];
  native_write_allowed: false;
  capability_boundary: string;
};

type MutableGroup = {
  sourceGroupId: string;
  sourceViewRegionId: string | null;
  bounds: PixelBoundsV1 | null;
  pathCount: number;
  textFragments: Set<string>;
  segments: SheetVectorElementSegmentV1[];
};

type MarkedFrame = { elementName: string | null; viewRegionName: string | null };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label}_must_be_integer_${minimum}_through_${maximum}`);
  }
  return result;
}

function finite(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label}_must_be_finite`);
  return result;
}

function stableId(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 20)}`;
}

function validateBounds(value: unknown): PixelBoundsV1 | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sheet_vector_topology_include_pixel_bounds_invalid");
  const candidate = value as PixelBoundsV1;
  const result = {
    min: {
      x: finite(candidate.min?.x, "sheet_vector_topology_include_min_x"),
      y: finite(candidate.min?.y, "sheet_vector_topology_include_min_y")
    },
    max: {
      x: finite(candidate.max?.x, "sheet_vector_topology_include_max_x"),
      y: finite(candidate.max?.y, "sheet_vector_topology_include_max_y")
    }
  };
  if (result.min.x > result.max.x || result.min.y > result.max.y) throw new Error("sheet_vector_topology_include_pixel_bounds_inverted");
  return result;
}

function numericArray(value: unknown): number[] {
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, Number);
  if (!Array.isArray(value)) return [];
  if (value.length === 1 && ArrayBuffer.isView(value[0])) return Array.from(value[0] as unknown as ArrayLike<number>, Number);
  return value.map(Number);
}

function markedName(args: unknown): string {
  if (!Array.isArray(args) || args.length === 0) return "";
  const first = args[0] as any;
  return clean(typeof first === "string" ? first : first?.name);
}

function transformPoint(pdfjs: any, matrix: number[], x: number, y: number): PixelPointV1 {
  const transformed = pdfjs.Util.transform(matrix, [1, 0, 0, 1, x, y]);
  return { x: Number(transformed[4]), y: Number(transformed[5]) };
}

function expandBounds(bounds: PixelBoundsV1 | null, point: PixelPointV1): PixelBoundsV1 {
  if (!bounds) return { min: { ...point }, max: { ...point } };
  bounds.min.x = Math.min(bounds.min.x, point.x);
  bounds.min.y = Math.min(bounds.min.y, point.y);
  bounds.max.x = Math.max(bounds.max.x, point.x);
  bounds.max.y = Math.max(bounds.max.y, point.y);
  return bounds;
}

function intersects(first: PixelBoundsV1, second: PixelBoundsV1): boolean {
  return first.min.x <= second.max.x && first.max.x >= second.min.x && first.min.y <= second.max.y && first.max.y >= second.min.y;
}

function showText(args: unknown): string {
  if (!Array.isArray(args) || !Array.isArray(args[0])) return "";
  return clean((args[0] as any[]).map(item => typeof item === "object" && item ? clean(item.unicode) : "").join(""));
}

function activeMarkedFrame(stack: MarkedFrame[]): MarkedFrame {
  let elementName: string | null = null;
  let viewRegionName: string | null = null;
  for (const frame of stack) {
    if (frame.viewRegionName) viewRegionName = frame.viewRegionName;
    if (frame.elementName) elementName = frame.elementName;
  }
  return { elementName, viewRegionName };
}

function endpointJunctions(
  groups: SheetVectorElementGroupV1[],
  tolerance: number,
  maximumJunctions: number
): SheetVectorEndpointJunctionV1[] {
  type Endpoint = SheetVectorEndpointJunctionV1["first"];
  const buckets = new Map<string, Endpoint[]>();
  const result: SheetVectorEndpointJunctionV1[] = [];
  const seen = new Set<string>();
  const bucketKey = (x: number, y: number): string => `${Math.floor(x / tolerance)}:${Math.floor(y / tolerance)}`;
  for (const group of groups) {
    for (const segment of group.segments) {
      for (const endpoint of ["start", "end"] as const) {
        const point = segment[endpoint];
        const candidate: Endpoint = { source_group_id: group.source_group_id, segment_id: segment.segment_id, endpoint, point };
        const bucketX = Math.floor(point.x / tolerance);
        const bucketY = Math.floor(point.y / tolerance);
        for (let y = bucketY - 1; y <= bucketY + 1; y += 1) {
          for (let x = bucketX - 1; x <= bucketX + 1; x += 1) {
            for (const other of buckets.get(`${x}:${y}`) ?? []) {
              if (other.source_group_id === candidate.source_group_id) continue;
              const distance = Math.hypot(other.point.x - point.x, other.point.y - point.y);
              if (distance > tolerance) continue;
              const pair = [
                `${other.source_group_id}:${other.segment_id}:${other.endpoint}`,
                `${candidate.source_group_id}:${candidate.segment_id}:${candidate.endpoint}`
              ].sort();
              const unique = pair.join("|");
              if (seen.has(unique)) continue;
              seen.add(unique);
              result.push({
                junction_id: stableId("junction", unique),
                first: other,
                second: candidate,
                distance_px: distance,
                evidence_basis: "cross_group_vector_endpoint_proximity"
              });
              if (result.length > maximumJunctions) throw new Error("sheet_vector_topology_maximum_junctions_exceeded");
            }
          }
        }
        const key = bucketKey(point.x, point.y);
        const bucket = buckets.get(key) ?? [];
        bucket.push(candidate);
        buckets.set(key, bucket);
      }
    }
  }
  return result;
}

export async function extractSheetVectorElementTopologyV1(
  input: SheetVectorElementTopologyInputV1
): Promise<SheetVectorElementTopologyReceiptV1> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) {
    throw new Error("sheet_vector_topology_requires_schema_v1");
  }
  const maximumGroups = integer(input.maximum_groups ?? 20_000, "sheet_vector_topology_maximum_groups", 1, 100_000);
  const maximumSegments = integer(input.maximum_segments ?? 500_000, "sheet_vector_topology_maximum_segments", 1, 2_000_000);
  const maximumJunctions = integer(input.maximum_junctions ?? 50_000, "sheet_vector_topology_maximum_junctions", 1, 500_000);
  const tolerance = finite(input.junction_tolerance_px ?? 1.5, "sheet_vector_topology_junction_tolerance_px");
  if (tolerance <= 0 || tolerance > 25) throw new Error("sheet_vector_topology_junction_tolerance_px_must_be_above_0_through_25");
  const includeBounds = validateBounds(input.include_pixel_bounds);

  // Reuse the strict hash, page, dimensions, aspect, and pixel-support gate. Vector
  // grouping is never accepted against a merely similar or independently rendered sheet.
  const verification = await extractSheetVectorTextV1({
    schema_version: 1,
    source_pdf_path: input.source_pdf_path,
    source_pdf_sha256: input.source_pdf_sha256,
    registered_render_path: input.registered_render_path,
    registered_render_sha256: input.registered_render_sha256,
    render_width_px: input.render_width_px,
    render_height_px: input.render_height_px,
    page: input.page,
    maximum_entries: 20_000
  });

  const pdfBytes = fs.readFileSync(clean(input.source_pdf_path));
  const pdfjs: any = await loadPdfJsForNode();
  let document: any = null;
  try {
    document = await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(pdfBytes))).promise;
    const page = await document.getPage(verification.page);
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: verification.render_width_px / Number(baseViewport.width) });
    const operatorList = await page.getOperatorList();
    const functions: number[] = Array.from(operatorList?.fnArray ?? [], Number);
    const argumentsList: unknown[] = Array.from(operatorList?.argsArray ?? []);
    const markedStack: MarkedFrame[] = [];
    const transformStack: number[][] = [];
    let transform: number[] = Array.from(viewport.transform, Number);
    const groups = new Map<string, MutableGroup>();
    let markedContentElementOccurrenceCount = 0;
    let vectorPathCount = 0;
    let vectorSegmentCount = 0;
    let unsupportedPathOperationCount = 0;
    let pathCurrent: PixelPointV1 | null = null;
    let pathSubpathStart: PixelPointV1 | null = null;
    let pathGroupId: string | null = null;
    const sourceGroupIds = new Map<string, string>();
    const sourceViewRegionIds = new Map<string, string>();
    const observedSourceGroupIds = new Set<string>();
    const opaqueSourceId = (mapping: Map<string, string>, prefix: string, rawName: string): string => {
      const existing = mapping.get(rawName);
      if (existing) return existing;
      // Use first-appearance ordinal rather than the raw export identifier in
      // the digest. This prevents a small native ID space from being recovered
      // by dictionary attack while remaining stable for the same PDF stream.
      const created = stableId(prefix, verification.source_pdf_sha256, verification.page, mapping.size + 1);
      mapping.set(rawName, created);
      return created;
    };
    const pathTerminatingOperators = new Set<number>([
      pdfjs.OPS.stroke,
      pdfjs.OPS.closeStroke,
      pdfjs.OPS.fill,
      pdfjs.OPS.eoFill,
      pdfjs.OPS.fillStroke,
      pdfjs.OPS.eoFillStroke,
      pdfjs.OPS.closeFillStroke,
      pdfjs.OPS.closeEOFillStroke,
      pdfjs.OPS.endPath
    ]);

    for (let index = 0; index < functions.length; index += 1) {
      const fn = functions[index];
      const args = argumentsList[index];
      if (fn === pdfjs.OPS.save) {
        transformStack.push([...transform]);
        continue;
      }
      if (fn === pdfjs.OPS.restore) {
        transform = transformStack.pop() ?? Array.from(viewport.transform, Number);
        continue;
      }
      if (fn === pdfjs.OPS.transform) {
        const matrix = numericArray(args);
        if (matrix.length >= 6 && matrix.slice(0, 6).every(Number.isFinite)) transform = pdfjs.Util.transform(transform, matrix.slice(0, 6));
        continue;
      }
      if (fn === pdfjs.OPS.beginMarkedContent || fn === pdfjs.OPS.beginMarkedContentProps) {
        const name = markedName(args);
        const elementName = /^Element\d+(?:-\d+)?$/.test(name) ? name : null;
        const viewRegionName = /^ViewRegion\d+(?:-\d+)?$/.test(name) ? name : null;
        markedStack.push({ elementName, viewRegionName });
        if (elementName) {
          markedContentElementOccurrenceCount += 1;
          observedSourceGroupIds.add(opaqueSourceId(sourceGroupIds, "group", elementName));
        }
        continue;
      }
      if (fn === pdfjs.OPS.endMarkedContent) {
        markedStack.pop();
        continue;
      }
      if (pathTerminatingOperators.has(fn)) {
        pathCurrent = null;
        pathSubpathStart = null;
        pathGroupId = null;
        continue;
      }
      const active = activeMarkedFrame(markedStack);
      if (!active.elementName) continue;
      const sourceGroupId = opaqueSourceId(sourceGroupIds, "group", active.elementName);
      let group = groups.get(sourceGroupId);
      if (!group) {
        if (groups.size >= maximumGroups) throw new Error("sheet_vector_topology_maximum_groups_exceeded");
        group = {
          sourceGroupId,
          sourceViewRegionId: active.viewRegionName
            ? opaqueSourceId(sourceViewRegionIds, "region", active.viewRegionName)
            : null,
          bounds: null,
          pathCount: 0,
          textFragments: new Set<string>(),
          segments: []
        };
        groups.set(sourceGroupId, group);
      }
      if (fn === pdfjs.OPS.showText) {
        const text = showText(args);
        if (text) group.textFragments.add(text);
        continue;
      }
      if (fn !== pdfjs.OPS.constructPath || !Array.isArray(args)) continue;

      const operations = numericArray(args[0]);
      const data = numericArray(args[1]);
      let dataIndex = 0;
      // PDF.js may flush a long current path across multiple constructPath
      // operators. Preserve the current point only while the same marked group
      // owns the path; painting operators above terminate it.
      let current: PixelPointV1 | null = pathGroupId === sourceGroupId ? pathCurrent : null;
      let subpathStart: PixelPointV1 | null = pathGroupId === sourceGroupId ? pathSubpathStart : null;
      let pathAdded = false;
      const addSegment = (kind: "line" | "cubic_bezier", start: PixelPointV1, end: PixelPointV1, controlPoints?: [PixelPointV1, PixelPointV1]): void => {
        if (kind === "line" && start.x === end.x && start.y === end.y) return;
        vectorSegmentCount += 1;
        if (vectorSegmentCount > maximumSegments) throw new Error("sheet_vector_topology_maximum_segments_exceeded");
        const segment: SheetVectorElementSegmentV1 = {
          segment_id: stableId("segment", sourceGroupId, index, group!.segments.length, kind, start, end, controlPoints),
          kind,
          start,
          end,
          ...(controlPoints ? { control_points: controlPoints } : {})
        };
        group!.segments.push(segment);
        group!.bounds = expandBounds(group!.bounds, start);
        group!.bounds = expandBounds(group!.bounds, end);
        for (const point of controlPoints ?? []) group!.bounds = expandBounds(group!.bounds, point);
        pathAdded = true;
      };
      const readPoint = (): PixelPointV1 | null => {
        if (dataIndex + 1 >= data.length) return null;
        const x = data[dataIndex++]!;
        const y = data[dataIndex++]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return transformPoint(pdfjs, transform, x, y);
      };

      for (const operation of operations) {
        if (operation === pdfjs.OPS.moveTo) {
          const point = readPoint();
          if (!point) { unsupportedPathOperationCount += 1; break; }
          current = point;
          subpathStart = point;
        } else if (operation === pdfjs.OPS.lineTo) {
          const point = readPoint();
          if (!current || !point) { unsupportedPathOperationCount += 1; break; }
          addSegment("line", current, point);
          current = point;
        } else if (operation === pdfjs.OPS.curveTo || operation === pdfjs.OPS.curveTo2 || operation === pdfjs.OPS.curveTo3) {
          if (!current) { unsupportedPathOperationCount += 1; break; }
          let firstControl: PixelPointV1 | null;
          let secondControl: PixelPointV1 | null;
          let end: PixelPointV1 | null;
          if (operation === pdfjs.OPS.curveTo) {
            firstControl = readPoint(); secondControl = readPoint(); end = readPoint();
          } else if (operation === pdfjs.OPS.curveTo2) {
            firstControl = current; secondControl = readPoint(); end = readPoint();
          } else {
            firstControl = readPoint(); end = readPoint(); secondControl = end;
          }
          if (!firstControl || !secondControl || !end) { unsupportedPathOperationCount += 1; break; }
          addSegment("cubic_bezier", current, end, [firstControl, secondControl]);
          current = end;
        } else if (operation === pdfjs.OPS.closePath) {
          if (current && subpathStart && (current.x !== subpathStart.x || current.y !== subpathStart.y)) {
            addSegment("line", current, subpathStart);
          }
          current = subpathStart;
        } else if (operation === pdfjs.OPS.rectangle) {
          if (dataIndex + 3 >= data.length) { unsupportedPathOperationCount += 1; break; }
          const x = data[dataIndex++]!; const y = data[dataIndex++]!;
          const width = data[dataIndex++]!; const height = data[dataIndex++]!;
          const corners = [
            transformPoint(pdfjs, transform, x, y),
            transformPoint(pdfjs, transform, x + width, y),
            transformPoint(pdfjs, transform, x + width, y + height),
            transformPoint(pdfjs, transform, x, y + height)
          ];
          for (let corner = 0; corner < 4; corner += 1) addSegment("line", corners[corner]!, corners[(corner + 1) % 4]!);
          current = corners[0]!;
          subpathStart = corners[0]!;
        } else {
          unsupportedPathOperationCount += 1;
          break;
        }
      }
      if (pathAdded) {
        group.pathCount += 1;
        vectorPathCount += 1;
      }
      pathCurrent = current;
      pathSubpathStart = subpathStart;
      pathGroupId = sourceGroupId;
    }

    const emittedGroups = [...groups.values()]
      .filter(group => group.bounds && group.segments.length > 0 && (!includeBounds || intersects(group.bounds, includeBounds)))
      .map(group => ({
        source_group_id: group.sourceGroupId,
        source_view_region_id: group.sourceViewRegionId,
        pixel_bounds: group.bounds!,
        path_count: group.pathCount,
        segment_count: group.segments.length,
        text_fragments: [...group.textFragments].sort(),
        segments: group.segments,
        evidence_basis: "pdf_marked_content_and_vector_paths" as const
      }))
      .sort((first, second) => first.source_group_id.localeCompare(second.source_group_id));
    const junctions = endpointJunctions(emittedGroups, tolerance, maximumJunctions);

    return {
      schema: "operator.sheet_vector_element_topology.v1",
      source_pdf_sha256: verification.source_pdf_sha256,
      registered_render_sha256: verification.registered_render_sha256,
      page: verification.page,
      render_width_px: verification.render_width_px,
      render_height_px: verification.render_height_px,
      source_render_verification: verification.source_render_verification,
      marked_content_supported: observedSourceGroupIds.size > 0,
      include_pixel_bounds: includeBounds,
      junction_tolerance_px: tolerance,
      operator_summary: {
        operator_count: functions.length,
        marked_content_element_occurrence_count: markedContentElementOccurrenceCount,
        marked_content_group_count: observedSourceGroupIds.size,
        vector_path_count: vectorPathCount,
        vector_segment_count: vectorSegmentCount,
        unsupported_path_operation_count: unsupportedPathOperationCount,
        emitted_group_count: emittedGroups.length,
        emitted_segment_count: emittedGroups.reduce((sum, group) => sum + group.segment_count, 0)
      },
      groups: emittedGroups,
      endpoint_junctions: junctions,
      native_write_allowed: false,
      capability_boundary: "PDF marked-content grouping and vector endpoints are optional source-only topology evidence. Hashed groups do not identify native Revit elements and cannot establish family, host, system, circuit, elevation, size, connectivity, or write authority; visual registration and native readback remain required."
    };
  } finally {
    try { await document?.destroy?.(); } catch { /* best effort */ }
  }
}
