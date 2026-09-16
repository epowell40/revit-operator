type Row = Record<string, any>;
const row = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const near = (a: unknown, b: unknown): boolean => finite(a) && finite(b) && Math.abs(a - b) <= 1e-4;
function point(v: unknown): number[] | null {
  const p = row(v);
  const a = Array.isArray(p.xyz) ? p.xyz : [p.x, p.y, p.z];
  return a.length === 3 && a.every(finite) ? a : null;
}
const samePoint = (a: unknown, b: number[]): boolean => {
  const p = point(a);
  return p !== null && p.every((value, i) => near(value, b[i]));
};
function length(v: unknown): number | null {
  // Unsupported length syntax abstains; native parsing remains authoritative.
  const m = String(v ?? "").trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(inches|inch|in|\"|feet|foot|ft|')?$/i);
  if (!m) return null;
  const n = Number(m[1]) / (/^(feet|foot|ft|')$/i.test(m[2] ?? "") ? 1 : 12);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function size(raw: unknown, requestedShape: unknown): Row | null {
  const parts = String(raw ?? "").trim().split(/[xX×]/);
  const shape = String(requestedShape ?? "").trim().toLowerCase().replace(/^rectangle$/, "rectangular");
  if (parts.length === 1) {
    const diameterFt = length(parts[0]);
    return diameterFt !== null && (!shape || shape === "round") ? { shape: "round", diameterFt } : null;
  }
  if (parts.length !== 2 || shape && !["rectangular", "oval"].includes(shape)) return null;
  const widthFt = length(parts[0]), heightFt = length(parts[1]);
  return widthFt !== null && heightFt !== null ? { shape: shape || "rectangular", widthFt, heightFt } : null;
}

/** Bounded proof for explicit model-coordinate duct previews, never placement intent. */
export function admitsMepDuctPreview(path: string, payload: unknown, requestBody: unknown): boolean {
  const r = row(payload), q = row(requestBody);
  if (r.status !== "Dry Run" || r.dryRun !== true || r.kind !== "duct" || r.rolledBack !== true
      || q.dryRun !== true || q.verify === false || q.connectToExisting === true || q.requireExistingEndpointConnections === true) return false;
  let points: (number[] | null)[], sizes: unknown[];
  if (path === "/revit/create-duct") {
    if (q.frameId && [q.startPoint, q.endPoint].some(p => !Array.isArray(row(p).xyz))) return false;
    points = [q.startPoint ? point(q.startPoint) : point({ x: q.startX, y: q.startY, z: q.startZ }),
      q.endPoint ? point(q.endPoint) : point({ x: q.endX, y: q.endY, z: q.endZ })];
    sizes = [q.ductSize || (q.width && q.height ? `${q.width}x${q.height}` : q.diameter)];
  } else {
    if (q.kind && q.kind !== "duct" || !Array.isArray(q.points) || q.points.length < 2 || q.points.length > 200) return false;
    points = q.points.map(point);
    sizes = points.slice(1).map((_, i) => q.segmentSizes?.[i] || q.ductSize || q.diameter);
  }
  if (points.some(p => p === null)) return false;
  const selected = row(r.selected), selectedType = row(selected.ductType);
  if (!Number.isSafeInteger(selectedType.id) || selectedType.id <= 0
      || q.ductTypeId !== undefined && q.ductTypeId !== null && q.ductTypeId !== selectedType.id
      || q.levelId !== undefined && q.levelId !== null && q.levelId !== row(selected.level).id) return false;
  if (q.ductType && ![selectedType.name, selectedType.familyName].some(name => typeof name === "string" && name.toLowerCase().includes(String(q.ductType).trim().toLowerCase()))) return false;
  if (q.levelName && String(row(selected.level).name).toLowerCase() !== String(q.levelName).toLowerCase()) return false;
  if (q.systemType && String(row(selected.systemType).name).toLowerCase() !== String(q.systemType).toLowerCase()) return false;
  if (!Array.isArray(r.createdElementIds) || r.createdElementIds.length !== 0
      || !Array.isArray(r.createdFittingIds) || r.createdFittingIds.length !== 0
      || !Array.isArray(r.segments) || r.segments.length !== points.length - 1 || r.segmentCount !== r.segments.length
      || !Array.isArray(r.plannedPoints) || r.plannedPoints.length !== points.length
      || !Array.isArray(r.dryRunElementIds) || r.dryRunElementIds.length !== r.segments.length
      || new Set(r.dryRunElementIds).size !== r.segments.length
      || r.internalConnectionsVerified !== true) return false;
  if (!r.plannedPoints.every((p: unknown, i: number) => samePoint(p, points[i]!))) return false;
  let total = 0;
  for (let i = 0; i < r.segments.length; i++) {
    const s = row(r.segments[i]), nativeSize = row(s.nativeSizeReadback), geometry = row(s.nativeGeometryReadback);
    const a = points[i]!, b = points[i + 1]!, expected = size(sizes[i], q.ductShape);
    const distance = Math.hypot(...a.map((value, axis) => value - b[axis]!));
    if (!expected || distance <= 1e-6 || s.index !== i || !Number.isSafeInteger(s.id) || s.id <= 0 || s.id !== r.dryRunElementIds[i]
        || !samePoint(s.start, a) || !samePoint(s.end, b) || !near(s.lengthFt, distance)
        || !samePoint(geometry.start, a) || !samePoint(geometry.end, b) || !near(geometry.lengthFt, distance)
        || nativeSize.shape !== expected.shape || selectedType.shape !== expected.shape) return false;
    for (const dimension of ["widthFt", "heightFt", "diameterFt"]) {
      if (expected[dimension] !== undefined && (!near(nativeSize[dimension], expected[dimension]) || !near(row(s.chosenSize)[dimension], expected[dimension]))) return false;
    }
    total += distance;
  }
  return near(r.totalLengthFt, total);
}
