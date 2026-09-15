type Row = Record<string, any>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const finitePoint = (value: unknown): value is number[] => Array.isArray(value) && value.length === 3
  && value.every(n => typeof n === "number" && Number.isFinite(n));

/** Normalize only the reviewed straight-duct compatibility entry point. Pixel
 * elevation, implicit coordinates and extra effects cannot qualify readback. */
export function explicitCreateDuctIntentV2(input: unknown): Row | null {
  const request = record(input), body = record(request.body);
  const allowed = new Set(["levelId", "levelName", "startX", "startY", "startZ", "endX", "endY", "endZ",
    "startPoint", "endPoint", "frameId", "systemType", "ductTypeId", "ductShape", "ductSize", "dryRun"]);
  if (request.path !== "/revit/create-duct" || body.dryRun !== false
      || Object.keys(body).some(k => !allowed.has(k)) || body.ductShape !== "rectangular"
      || !Number.isSafeInteger(body.levelId) || body.levelId <= 0
      || body.ductTypeId !== undefined && (!Number.isSafeInteger(body.ductTypeId) || body.ductTypeId <= 0)) return null;
  const points: number[][] = [];
  for (const prefix of ["start", "end"]) {
    const p = body[prefix + "Point"];
    const flat = ["X", "Y", "Z"].map(axis => body[prefix + axis]);
    if (p !== undefined) {
      // xyz resolves in world space even when a frame reference accompanies it.
      if (flat.some(value => value !== undefined) || Object.keys(record(p)).length !== 1 || !finitePoint(record(p).xyz)) return null;
      points.push(record(p).xyz);
    } else {
      if (!finitePoint(flat)) return null;
      points.push(flat);
    }
  }
  return { kind: "duct", apply: true, routingMode: "polyline", ductShape: "rectangular",
    sizePolicy: "explicit_required", elevationPolicy: "explicit_required", connectSegments: false,
    connectToExisting: false, requireExistingEndpointConnections: false,
    levelId: body.levelId, ductTypeId: body.ductTypeId, ductSize: body.ductSize,
    systemType: body.systemType, points: points.map(xyz => ({ xyz })) };
}
