import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export type PlanTracePoint = { x: number; y: number };

export type PlanTraceExtractionInput = {
  schema_version: 1;
  source_image_path: string;
  source_image_sha256: string;
  target_rgb: { r: number; g: number; b: number };
  maximum_color_distance: number;
  minimum_chroma?: number;
  minimum_alpha?: number;
  scope_polygon?: PlanTracePoint[];
  minimum_component_pixels?: number;
  simplify_tolerance_px?: number;
  interpretation_mode?: "ink_centerline" | "outlined_network_centerline";
  maximum_interior_span_px?: number;
  minimum_parallel_support_px?: number;
};

export type PlanTracePolyline = {
  points: PlanTracePoint[];
  length_px: number;
  closed: boolean;
};

export type PlanTraceComponent = {
  component_id: string;
  pixel_count: number;
  skeleton_pixel_count: number;
  bounds_px: { min: PlanTracePoint; max: PlanTracePoint };
  polylines: PlanTracePolyline[];
};

export type PlanTraceExtractionReceipt = {
  schema_version: 1;
  source_image_sha256: string;
  width_px: number;
  height_px: number;
  extraction_policy: {
    target_rgb: { r: number; g: number; b: number };
    maximum_color_distance: number;
    minimum_chroma: number;
    minimum_alpha: number;
    scope_polygon: PlanTracePoint[] | null;
    minimum_component_pixels: number;
    simplify_tolerance_px: number;
    interpretation_mode?: "outlined_network_centerline";
    maximum_interior_span_px?: number;
    minimum_parallel_support_px?: number;
  };
  extraction_policy_sha256: string;
  matched_pixel_count: number;
  retained_pixel_count: number;
  derived_fill_pixel_count?: number;
  components: PlanTraceComponent[];
  usage_constraints: string[];
};

export type PlanTracePreviewArtifact = {
  path: string;
  sha256: string;
  width_px: number;
  height_px: number;
};

type PixelBuffer = { width: number; height: number; data: Uint8ClampedArray };

const NEIGHBORS_8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1]
];

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  const checked = finite(value, label);
  if (!Number.isInteger(checked) || checked < min || checked > max) {
    throw new Error(`${label}_must_be_integer_between_${min}_and_${max}`);
  }
  return checked;
}

function positiveInteger(value: unknown, label: string): number {
  const checked = finite(value, label);
  if (!Number.isSafeInteger(checked) || checked <= 0) throw new Error(`${label}_must_be_positive_integer`);
  return checked;
}

function checkedPoint(value: PlanTracePoint, label: string): PlanTracePoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  return { x: finite(value.x, `${label}_x`), y: finite(value.y, `${label}_y`) };
}

function checkedSha256(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("source_image_sha256_must_be_sha256");
  return normalized;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function indexOf(x: number, y: number, width: number): number {
  return y * width + x;
}

function cross(a: PlanTracePoint, b: PlanTracePoint, c: PlanTracePoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: PlanTracePoint, a: PlanTracePoint, b: PlanTracePoint): boolean {
  const epsilon = 1e-7;
  if (Math.abs(cross(a, b, point)) > epsilon) return false;
  return point.x >= Math.min(a.x, b.x) - epsilon && point.x <= Math.max(a.x, b.x) + epsilon
    && point.y >= Math.min(a.y, b.y) - epsilon && point.y <= Math.max(a.y, b.y) + epsilon;
}

function segmentsIntersect(a: PlanTracePoint, b: PlanTracePoint, c: PlanTracePoint, d: PlanTracePoint): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
    && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  return pointOnSegment(c, a, b) || pointOnSegment(d, a, b)
    || pointOnSegment(a, c, d) || pointOnSegment(b, c, d);
}

function validatePolygon(value: PlanTracePoint[] | undefined, width: number, height: number): PlanTracePoint[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length < 3 || value.length > 128) {
    throw new Error("scope_polygon_must_have_3_to_128_vertices");
  }
  const polygon = value.map((entry, index) => checkedPoint(entry, `scope_polygon_${index}`));
  for (const [index, vertex] of polygon.entries()) {
    if (vertex.x < 0 || vertex.x > width || vertex.y < 0 || vertex.y > height) {
      throw new Error(`scope_polygon_vertex_outside_image:${index}`);
    }
    const next = polygon[(index + 1) % polygon.length]!;
    if (vertex.x === next.x && vertex.y === next.y) {
      throw new Error(`scope_polygon_duplicate_consecutive_vertex:${index}`);
    }
  }
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  if (Math.abs(twiceArea) <= 1e-7) throw new Error("scope_polygon_has_zero_area");
  for (let first = 0; first < polygon.length; first += 1) {
    const firstNext = (first + 1) % polygon.length;
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondNext = (second + 1) % polygon.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(polygon[first]!, polygon[firstNext]!, polygon[second]!, polygon[secondNext]!)) {
        throw new Error(`scope_polygon_self_intersects:${first}:${second}`);
      }
    }
  }
  return polygon;
}

function pointInPolygon(x: number, y: number, polygon: PlanTracePoint[]): boolean {
  const point = { x, y };
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (pointOnSegment(point, a, b)) return true;
    if ((a.y > y) !== (b.y > y)
      && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function connectedComponents(mask: Uint8Array, width: number, height: number): number[][] {
  const visited = new Uint8Array(mask.length);
  const result: number[][] = [];
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    const component: number[] = [];
    const queue = [seed];
    visited[seed] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!;
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      for (const [dx, dy] of NEIGHBORS_8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighbor = indexOf(nx, ny, width);
        if (mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    result.push(component);
  }
  return result;
}

function contiguousRuns(values: number[]): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let index = 0; index <= values.length; index += 1) {
    if (index < values.length && values[index]) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      runs.push({ start, end: index - 1 });
      start = -1;
    }
  }
  return runs;
}

function retainSupportedGapFill(
  proposals: Uint8Array,
  width: number,
  height: number,
  minimumParallelSupport: number,
  supportAxis: "x" | "y"
): Uint8Array {
  const retained = new Uint8Array(proposals.length);
  for (const component of connectedComponents(proposals, width, height)) {
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    for (const pixel of component) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const support = supportAxis === "x" ? maxX - minX + 1 : maxY - minY + 1;
    if (support < minimumParallelSupport) continue;
    for (const pixel of component) retained[pixel] = 1;
  }
  return retained;
}

function fillOutlinedNetworkInteriors(
  boundaryMask: Uint8Array,
  width: number,
  height: number,
  maximumInteriorSpan: number,
  minimumParallelSupport: number
): { mask: Uint8Array; derivedFillPixelCount: number } {
  const rowProposals = new Uint8Array(boundaryMask.length);
  for (let y = 0; y < height; y += 1) {
    const row = Array.from({ length: width }, (_, x) => boundaryMask[indexOf(x, y, width)]!);
    const runs = contiguousRuns(row);
    for (let index = 0; index < runs.length - 1; index += 1) {
      const left = runs[index]!;
      const right = runs[index + 1]!;
      const gap = right.start - left.end - 1;
      if (gap <= 0 || gap > maximumInteriorSpan) continue;
      for (let x = left.end + 1; x < right.start; x += 1) rowProposals[indexOf(x, y, width)] = 1;
    }
  }
  const columnProposals = new Uint8Array(boundaryMask.length);
  for (let x = 0; x < width; x += 1) {
    const column = Array.from({ length: height }, (_, y) => boundaryMask[indexOf(x, y, width)]!);
    const runs = contiguousRuns(column);
    for (let index = 0; index < runs.length - 1; index += 1) {
      const top = runs[index]!;
      const bottom = runs[index + 1]!;
      const gap = bottom.start - top.end - 1;
      if (gap <= 0 || gap > maximumInteriorSpan) continue;
      for (let y = top.end + 1; y < bottom.start; y += 1) columnProposals[indexOf(x, y, width)] = 1;
    }
  }
  const supportedRows = retainSupportedGapFill(rowProposals, width, height, minimumParallelSupport, "y");
  const supportedColumns = retainSupportedGapFill(columnProposals, width, height, minimumParallelSupport, "x");
  const result = boundaryMask.slice();
  let derivedFillPixelCount = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (!result[index] && (supportedRows[index] || supportedColumns[index])) {
      result[index] = 1;
      derivedFillPixelCount += 1;
    }
  }
  return { mask: result, derivedFillPixelCount };
}

function transitions(values: number[]): number {
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === 0 && values[(i + 1) % values.length] === 1) count += 1;
  }
  return count;
}

// Zhang-Suen thinning reduces thick plotted ink to a deterministic one-pixel centerline.
function skeletonize(componentMask: Uint8Array, width: number, height: number): Uint8Array {
  const result = componentMask.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (const phase of [0, 1] as const) {
      const remove: number[] = [];
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const center = indexOf(x, y, width);
          if (!result[center]) continue;
          const p2 = result[indexOf(x, y - 1, width)]!;
          const p3 = result[indexOf(x + 1, y - 1, width)]!;
          const p4 = result[indexOf(x + 1, y, width)]!;
          const p5 = result[indexOf(x + 1, y + 1, width)]!;
          const p6 = result[indexOf(x, y + 1, width)]!;
          const p7 = result[indexOf(x - 1, y + 1, width)]!;
          const p8 = result[indexOf(x - 1, y, width)]!;
          const p9 = result[indexOf(x - 1, y - 1, width)]!;
          const ring = [p2, p3, p4, p5, p6, p7, p8, p9];
          const count = ring.reduce((sum, value) => sum + value, 0);
          if (count < 2 || count > 6 || transitions(ring) !== 1) continue;
          const first = phase === 0 ? p2 * p4 * p6 : p2 * p4 * p8;
          const second = phase === 0 ? p4 * p6 * p8 : p2 * p6 * p8;
          if (first === 0 && second === 0) remove.push(center);
        }
      }
      if (remove.length > 0) {
        changed = true;
        for (const pixel of remove) result[pixel] = 0;
      }
    }
  }
  return result;
}

function skeletonNeighbors(pixel: number, mask: Uint8Array, width: number, height: number): number[] {
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  const result: number[] = [];
  for (const [dx, dy] of NEIGHBORS_8) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
    // Do not add a diagonal graph edge across an already connected orthogonal
    // corner. This prevents one-pixel junctions from exploding into tiny cycles.
    if (dx !== 0 && dy !== 0
      && (mask[indexOf(x + dx, y, width)] || mask[indexOf(x, y + dy, width)])) continue;
    const neighbor = indexOf(nx, ny, width);
    if (mask[neighbor]) result.push(neighbor);
  }
  return result.sort((a, b) => a - b);
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function pixelPoint(pixel: number, width: number): PlanTracePoint {
  return { x: pixel % width, y: Math.floor(pixel / width) };
}

function pointSegmentDistance(point: PlanTracePoint, a: PlanTracePoint, b: PlanTracePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function simplify(points: PlanTracePoint[], tolerance: number): PlanTracePoint[] {
  if (points.length <= 2 || tolerance === 0) return points;
  let farthest = 0;
  let farthestIndex = -1;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = pointSegmentDistance(points[i]!, points[0]!, points[points.length - 1]!);
    if (distance > farthest) {
      farthest = distance;
      farthestIndex = i;
    }
  }
  if (farthest <= tolerance || farthestIndex < 0) return [points[0]!, points[points.length - 1]!];
  const left = simplify(points.slice(0, farthestIndex + 1), tolerance);
  const right = simplify(points.slice(farthestIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function length(points: PlanTracePoint[]): number {
  return points.slice(1).reduce((sum, point, index) => {
    const previous = points[index]!;
    return sum + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0);
}

function directionIndependentPointKey(points: PlanTracePoint[]): string {
  const encode = (entries: PlanTracePoint[]) => entries.map((point) => `${point.x},${point.y}`).join(";");
  const forward = encode(points);
  const reverse = encode([...points].reverse());
  return forward < reverse ? forward : reverse;
}

function traceSkeleton(mask: Uint8Array, width: number, height: number, tolerance: number): PlanTracePolyline[] {
  const pixels: number[] = [];
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) pixels.push(i);
  const adjacency = new Map(pixels.map((pixel) => [pixel, skeletonNeighbors(pixel, mask, width, height)]));
  const expectedEdges = new Set<string>();
  for (const [pixel, neighbors] of adjacency) {
    for (const neighbor of neighbors) expectedEdges.add(edgeKey(pixel, neighbor));
  }
  type CollapsedNode = { id: number; members: number[]; representative: number };
  const nodes: CollapsedNode[] = [];
  const nodeByPixel = new Map<number, CollapsedNode>();
  const unassignedJunctions = new Set(pixels.filter((pixel) => adjacency.get(pixel)!.length > 2));

  // Thick plotted intersections commonly thin to several adjacent degree>2
  // pixels. Collapse each connected junction cluster before walking chains so
  // internal cluster edges cannot become false route branches.
  while (unassignedJunctions.size > 0) {
    const seed = unassignedJunctions.values().next().value as number;
    const members = [seed];
    unassignedJunctions.delete(seed);
    for (let cursor = 0; cursor < members.length; cursor += 1) {
      for (const neighbor of adjacency.get(members[cursor]!)!) {
        if (unassignedJunctions.delete(neighbor)) members.push(neighbor);
      }
    }
    members.sort((a, b) => a - b);
    const centroid = members.reduce(
      (sum, pixel) => ({ x: sum.x + pixel % width, y: sum.y + Math.floor(pixel / width) }),
      { x: 0, y: 0 }
    );
    centroid.x /= members.length;
    centroid.y /= members.length;
    const representative = members.reduce((best, pixel) => {
      const point = pixelPoint(pixel, width);
      const bestPoint = pixelPoint(best, width);
      const distance = Math.hypot(point.x - centroid.x, point.y - centroid.y);
      const bestDistance = Math.hypot(bestPoint.x - centroid.x, bestPoint.y - centroid.y);
      return distance < bestDistance || (distance === bestDistance && pixel < best) ? pixel : best;
    }, members[0]!);
    const node = { id: nodes.length, members, representative };
    nodes.push(node);
    for (const member of members) nodeByPixel.set(member, node);
  }
  for (const pixel of pixels.filter((entry) => adjacency.get(entry)!.length <= 1)) {
    const node = { id: nodes.length, members: [pixel], representative: pixel };
    nodes.push(node);
    nodeByPixel.set(pixel, node);
  }
  nodes.sort((a, b) => a.representative - b.representative);
  const visited = new Set<string>();
  for (const node of nodes) {
    for (const member of node.members) {
      for (const neighbor of adjacency.get(member)!) {
        if (nodeByPixel.get(neighbor)?.id === node.id) visited.add(edgeKey(member, neighbor));
      }
    }
  }
  const rawPaths: Array<{ points: PlanTracePoint[]; closed: boolean }> = [];

  const walkFromNode = (startNode: CollapsedNode, startMember: number, next: number): { points: PlanTracePoint[]; closed: boolean } => {
    const points = [pixelPoint(startNode.representative, width), pixelPoint(next, width)];
    visited.add(edgeKey(startMember, next));
    let previous = startMember;
    let current = next;
    while (true) {
      const reachedNode = nodeByPixel.get(current);
      if (reachedNode) {
        points[points.length - 1] = pixelPoint(reachedNode.representative, width);
        return { points, closed: reachedNode.id === startNode.id };
      }
      const options = adjacency.get(current)!.filter((entry) => entry !== previous && !visited.has(edgeKey(current, entry)));
      if (options.length === 0) return { points, closed: false };
      const following = options[0]!;
      visited.add(edgeKey(current, following));
      points.push(pixelPoint(following, width));
      previous = current;
      current = following;
    }
  };

  for (const node of nodes) {
    for (const member of node.members) {
      for (const neighbor of adjacency.get(member)!) {
        if (nodeByPixel.get(neighbor)?.id === node.id) continue;
        if (!visited.has(edgeKey(member, neighbor))) rawPaths.push(walkFromNode(node, member, neighbor));
      }
    }
  }

  // Any remaining edges belong to components made entirely of degree-two
  // pixels (pure loops). Walk each exactly once and close it at the start.
  for (const pixel of pixels) {
    for (const neighbor of adjacency.get(pixel)!) {
      if (visited.has(edgeKey(pixel, neighbor))) continue;
      const points = [pixelPoint(pixel, width), pixelPoint(neighbor, width)];
      visited.add(edgeKey(pixel, neighbor));
      let previous = pixel;
      let current = neighbor;
      while (current !== pixel) {
        const following = adjacency.get(current)!.find(
          (entry) => entry !== previous && !visited.has(edgeKey(current, entry))
        );
        if (following === undefined) break;
        visited.add(edgeKey(current, following));
        points.push(pixelPoint(following, width));
        previous = current;
        current = following;
      }
      rawPaths.push({ points, closed: current === pixel });
    }
  }
  const missingEdges = [...expectedEdges].filter((edge) => !visited.has(edge));
  if (missingEdges.length > 0) throw new Error(`plan_trace_graph_edge_coverage_incomplete:${missingEdges.length}`);

  const traced = rawPaths
    .map((entry) => ({
      raw_points: entry.points,
      points: entry.closed ? entry.points : simplify(entry.points, tolerance),
      length_px: length(entry.points),
      closed: entry.closed
    }))
    .filter((entry) => entry.points.length >= 2 && entry.length_px > 0);
  const simplifiedKeyCounts = new Map<string, number>();
  for (const entry of traced) {
    const key = directionIndependentPointKey(entry.points);
    simplifiedKeyCounts.set(key, (simplifiedKeyCounts.get(key) ?? 0) + 1);
  }
  // Distinct skeleton branches can share endpoints and collapse to the same
  // two-point line under simplification (common around compact fitting/symbol
  // loops). Preserve their raw paths instead of emitting duplicate geometry.
  const result = traced.map((entry) => ({
    points: (simplifiedKeyCounts.get(directionIndependentPointKey(entry.points)) ?? 0) > 1
      ? entry.raw_points
      : entry.points,
    length_px: entry.length_px,
    closed: entry.closed
  }));
  const finalKeys = new Set<string>();
  for (const entry of result) {
    const key = directionIndependentPointKey(entry.points);
    if (finalKeys.has(key)) throw new Error("plan_trace_duplicate_geometry_after_raw_path_preservation");
    finalKeys.add(key);
  }
  return result
    .sort((a, b) => b.length_px - a.length_px || a.points[0]!.y - b.points[0]!.y || a.points[0]!.x - b.points[0]!.x);
}

export function extractPlanTracesFromPixels(
  pixels: PixelBuffer,
  input: Omit<PlanTraceExtractionInput, "source_image_path">
): PlanTraceExtractionReceipt {
  if (input.schema_version !== 1) throw new Error("plan_trace_extraction_requires_schema_v1");
  const width = positiveInteger(pixels.width, "width_px");
  const height = positiveInteger(pixels.height, "height_px");
  if (!(pixels.data instanceof Uint8ClampedArray) || pixels.data.length !== width * height * 4) {
    throw new Error("rgba_pixel_buffer_length_mismatch");
  }
  const sourceHash = checkedSha256(input.source_image_sha256);
  const target = {
    r: boundedInteger(input.target_rgb?.r, "target_rgb_r", 0, 255),
    g: boundedInteger(input.target_rgb?.g, "target_rgb_g", 0, 255),
    b: boundedInteger(input.target_rgb?.b, "target_rgb_b", 0, 255)
  };
  const maximumColorDistance = finite(input.maximum_color_distance, "maximum_color_distance");
  if (maximumColorDistance < 0 || maximumColorDistance > Math.sqrt(3 * 255 ** 2)) {
    throw new Error("maximum_color_distance_out_of_range");
  }
  const minimumChroma = input.minimum_chroma == null ? 0 : finite(input.minimum_chroma, "minimum_chroma");
  if (minimumChroma < 0 || minimumChroma > 255) throw new Error("minimum_chroma_out_of_range");
  const minimumAlpha = input.minimum_alpha == null ? 1 : boundedInteger(input.minimum_alpha, "minimum_alpha", 0, 255);
  const minimumComponentPixels = input.minimum_component_pixels == null
    ? 8
    : positiveInteger(input.minimum_component_pixels, "minimum_component_pixels");
  const simplifyTolerance = input.simplify_tolerance_px == null
    ? 1
    : finite(input.simplify_tolerance_px, "simplify_tolerance_px");
  if (simplifyTolerance < 0 || simplifyTolerance > 10) throw new Error("simplify_tolerance_px_out_of_range");
  const interpretationMode = input.interpretation_mode ?? "ink_centerline";
  if (!["ink_centerline", "outlined_network_centerline"].includes(interpretationMode)) {
    throw new Error("interpretation_mode_invalid");
  }
  let maximumInteriorSpan: number | undefined;
  let minimumParallelSupport: number | undefined;
  if (interpretationMode === "outlined_network_centerline") {
    maximumInteriorSpan = positiveInteger(input.maximum_interior_span_px, "maximum_interior_span_px");
    minimumParallelSupport = positiveInteger(input.minimum_parallel_support_px, "minimum_parallel_support_px");
    if (maximumInteriorSpan > 500) throw new Error("maximum_interior_span_px_out_of_range");
    if (minimumParallelSupport > 500) throw new Error("minimum_parallel_support_px_out_of_range");
  } else if (input.maximum_interior_span_px != null || input.minimum_parallel_support_px != null) {
    throw new Error("outlined_network_parameters_require_outlined_network_centerline_mode");
  }
  const polygon = validatePolygon(input.scope_polygon, width, height);

  const mask = new Uint8Array(width * height);
  let matchedPixelCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (polygon && !pointInPolygon(x + 0.5, y + 0.5, polygon)) continue;
      const offset = indexOf(x, y, width) * 4;
      const r = pixels.data[offset]!;
      const g = pixels.data[offset + 1]!;
      const b = pixels.data[offset + 2]!;
      const a = pixels.data[offset + 3]!;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const colorDistance = Math.hypot(r - target.r, g - target.g, b - target.b);
      if (a >= minimumAlpha && chroma >= minimumChroma && colorDistance <= maximumColorDistance) {
        mask[indexOf(x, y, width)] = 1;
        matchedPixelCount += 1;
      }
    }
  }

  const interpreted = interpretationMode === "outlined_network_centerline"
    ? fillOutlinedNetworkInteriors(mask, width, height, maximumInteriorSpan!, minimumParallelSupport!)
    : { mask, derivedFillPixelCount: 0 };
  const retained = connectedComponents(interpreted.mask, width, height)
    .filter((component) => component.length >= minimumComponentPixels)
    .sort((a, b) => b.length - a.length || a[0]! - b[0]!);
  let retainedPixelCount = 0;
  const components = retained.map((component, index) => {
    retainedPixelCount += component.length;
    const componentMask = new Uint8Array(mask.length);
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    for (const pixel of component) {
      componentMask[pixel] = 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const skeleton = skeletonize(componentMask, width, height);
    const skeletonPixelCount = skeleton.reduce((sum, value) => sum + value, 0);
    return {
      component_id: `trace-component-${String(index + 1).padStart(3, "0")}`,
      pixel_count: component.length,
      skeleton_pixel_count: skeletonPixelCount,
      bounds_px: { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } },
      polylines: traceSkeleton(skeleton, width, height, simplifyTolerance)
    };
  });

  const extractionPolicy = {
    target_rgb: target,
    maximum_color_distance: maximumColorDistance,
    minimum_chroma: minimumChroma,
    minimum_alpha: minimumAlpha,
    scope_polygon: polygon,
    minimum_component_pixels: minimumComponentPixels,
    simplify_tolerance_px: simplifyTolerance
    ,...(interpretationMode === "outlined_network_centerline" ? {
      interpretation_mode: interpretationMode,
      maximum_interior_span_px: maximumInteriorSpan,
      minimum_parallel_support_px: minimumParallelSupport
    } : {})
  };
  return {
    schema_version: 1,
    source_image_sha256: sourceHash,
    width_px: width,
    height_px: height,
    extraction_policy: extractionPolicy,
    extraction_policy_sha256: digest(extractionPolicy),
    matched_pixel_count: matchedPixelCount,
    retained_pixel_count: retainedPixelCount,
    ...(interpretationMode === "outlined_network_centerline"
      ? { derived_fill_pixel_count: interpreted.derivedFillPixelCount }
      : {}),
    components,
    usage_constraints: [
      "Extracted polylines represent only raster pixels satisfying the declared color, scope, and component policy.",
      "Polyline segmentation is an image-processing artifact and must not be treated as native Revit element segmentation.",
      "Color extraction does not establish discipline, system classification, size, elevation, family, type, connectivity, or venting topology.",
      "Ambiguous, occluded, monochrome, or out-of-scope routes remain unresolved unless supported by separate source-visible evidence."
      ,...(interpretationMode === "outlined_network_centerline" ? [
        "Outlined-network centerlines are derived only where paired boundary ink has the declared span and parallel-support evidence.",
        "Derived centerlines may still include connected symbols, terminals, fittings, or compact loops and require explicit source accounting before promotion."
      ] : [])
    ]
  };
}

export async function extractPlanTraces(input: PlanTraceExtractionInput): Promise<PlanTraceExtractionReceipt> {
  const expectedHash = checkedSha256(input.source_image_sha256);
  const sourceBytes = fs.readFileSync(input.source_image_path);
  const actualHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  if (actualHash !== expectedHash) throw new Error("source_image_sha256_mismatch");
  const image = await loadImage(sourceBytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, image.width, image.height);
  return extractPlanTracesFromPixels(
    { width: image.width, height: image.height, data: imageData.data },
    input
  );
}

export async function renderPlanTraceExtractionPreview(
  sourceImagePath: string,
  receipt: PlanTraceExtractionReceipt,
  outputPath: string
): Promise<PlanTracePreviewArtifact> {
  const sourceBytes = fs.readFileSync(sourceImagePath);
  const sourceHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  if (sourceHash !== receipt.source_image_sha256) throw new Error("plan_trace_preview_source_image_sha256_mismatch");
  const image = await loadImage(sourceBytes);
  if (image.width !== receipt.width_px || image.height !== receipt.height_px) {
    throw new Error("plan_trace_preview_source_dimensions_mismatch");
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  context.fillStyle = "rgba(0, 0, 0, 0.12)";
  context.fillRect(0, 0, image.width, image.height);
  const polygon = receipt.extraction_policy.scope_polygon;
  if (polygon) {
    context.strokeStyle = "rgba(255, 196, 0, 0.95)";
    context.lineWidth = 1;
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(polygon[0]!.x, polygon[0]!.y);
    for (const point of polygon.slice(1)) context.lineTo(point.x, point.y);
    context.closePath();
    context.stroke();
    context.setLineDash([]);
  }
  for (const component of receipt.components) {
    for (const polyline of component.polylines) {
      if (polyline.points.length < 2) continue;
      context.strokeStyle = "rgba(255, 0, 180, 0.95)";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(polyline.points[0]!.x, polyline.points[0]!.y);
      for (const point of polyline.points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
      context.fillStyle = "rgba(0, 180, 255, 0.95)";
      for (const point of [polyline.points[0]!, polyline.points[polyline.points.length - 1]!]) {
        context.beginPath();
        context.arc(point.x, point.y, 1.75, 0, Math.PI * 2);
        context.fill();
      }
    }
  }
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, canvas.toBuffer("image/png"));
  return {
    path: resolved,
    sha256: sha256File(resolved),
    width_px: image.width,
    height_px: image.height
  };
}
