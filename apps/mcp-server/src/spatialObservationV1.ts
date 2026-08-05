import * as fs from "node:fs";
import * as path from "node:path";
import { getWorkspaceRoot } from "./lib/workspace.js";

export const SPATIAL_OBSERVATION_V1_SCHEMA_VERSION = "spatial-observation/v1";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type SpatialObservationInput = {
  viewId?: number;
  imageSize?: number;
  categories?: string[];
  excludeCategories?: string[];
  includeLinked?: boolean;
  modelBounds?: number[];
  limit?: number;
};

export type SpatialObservationCall = (route: string, method: "POST", body: Record<string, unknown>) => Promise<unknown>;
export type SpatialObservationImageReadResult =
  | { ok: true; data: string; mimeType: "image/png" | "image/jpeg" }
  | { ok: false; reason: string };
export type SpatialObservationImageReader = (imagePath: string, maxBytes: number) => SpatialObservationImageReadResult;
export type SpatialObservationImageReadHooks = {
  afterResolve?: () => void;
  afterOpen?: () => void;
};

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requireFrameContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Malformed visible-elements frame contract: ${message}`);
}

function sourceScopedIdFor(item: Record<string, any>, elementId: number | null): string | null {
  const source = asObject(item.source);
  const existing = stringValue(item.sourceScopedId, item.source_scoped_id, source?.scopedId, source?.sourceScopedId);
  if (existing) return existing;
  if (elementId === null) return null;
  const scope = stringValue(source?.scope, item.sourceScope, item.source_scope)?.toLowerCase();
  const linkInstanceId = positiveInteger(source?.linkInstanceId ?? source?.link_instance_id ?? item.linkInstanceId ?? item.link_instance_id);
  if (scope === "linked" && linkInstanceId !== null) return `link:${linkInstanceId}:${elementId}`;
  return scope === "host" ? `host:${elementId}` : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function affinePoint(value: unknown): [number, number, number] | null {
  return Array.isArray(value) && value.length === 3 && value.every(finiteNumber)
    ? value as [number, number, number]
    : null;
}

function validAffineMapping(value: Record<string, any>): boolean {
  if (value.mode !== "2d_affine") return false;
  const topLeft = affinePoint(value.topLeftXyz);
  const topRight = affinePoint(value.topRightXyz);
  const bottomLeft = affinePoint(value.bottomLeftXyz);
  if (!topLeft || !topRight || !bottomLeft) return false;

  const top = topRight.map((coordinate, index) => coordinate - topLeft[index]) as [number, number, number];
  const bottom = bottomLeft.map((coordinate, index) => coordinate - topLeft[index]) as [number, number, number];
  const normalize = (vector: [number, number, number]): [number, number, number] | null => {
    const scale = Math.max(...vector.map(Math.abs));
    if (scale === 0) return null;
    const length = Math.hypot(...vector.map(coordinate => coordinate / scale));
    return vector.map(coordinate => coordinate / scale / length) as [number, number, number];
  };
  const topUnit = normalize(top);
  const bottomUnit = normalize(bottom);
  if (!topUnit || !bottomUnit) return false;
  const crossMagnitude = Math.hypot(
    topUnit[1] * bottomUnit[2] - topUnit[2] * bottomUnit[1],
    topUnit[2] * bottomUnit[0] - topUnit[0] * bottomUnit[2],
    topUnit[0] * bottomUnit[1] - topUnit[1] * bottomUnit[0]
  );
  return crossMagnitude > 1e-12;
}
function validVector(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 3 && value.every(finiteNumber);
  const obj = asObject(value);
  return !!obj && finiteNumber(obj.x) && finiteNumber(obj.y) && finiteNumber(obj.z);
}

function validImagePoint(value: unknown): boolean {
  const obj = asObject(value);
  if (!obj) return false;
  return (finiteNumber(obj.normalizedX ?? obj.normalized_x) && finiteNumber(obj.normalizedY ?? obj.normalized_y))
    || (finiteNumber(obj.x ?? obj.xPx ?? obj.x_px) && finiteNumber(obj.y ?? obj.yPx ?? obj.y_px));
}

function validExplicitImagePoint(value: unknown): boolean {
  const obj = asObject(value);
  if (!obj) return false;
  return (finiteNumber(obj.normalizedX ?? obj.normalized_x) && finiteNumber(obj.normalizedY ?? obj.normalized_y))
    || (finiteNumber(obj.xPx ?? obj.x_px) && finiteNumber(obj.yPx ?? obj.y_px));
}

function validProjectedPoint(value: unknown): boolean {
  if (validVector(value)) return true;
  const point = asObject(value);
  if (!point) return false;
  if (validVector(point.model) || validVector(point.xyz) || validImagePoint(point.image) || validExplicitImagePoint(point)) return true;
  return point.point !== value && validProjectedPoint(point.point);
}

function validAnchor(value: unknown): boolean {
  const anchor = asObject(value);
  if (!anchor) return false;
  return validProjectedPoint(anchor);
}

function validImageRect(value: unknown): boolean {
  const obj = asObject(value);
  if (!obj) return false;
  return finiteNumber(obj.normalizedMinX ?? obj.normalized_min_x)
    && finiteNumber(obj.normalizedMinY ?? obj.normalized_min_y)
    && finiteNumber(obj.normalizedMaxX ?? obj.normalized_max_x)
    && finiteNumber(obj.normalizedMaxY ?? obj.normalized_max_y);
}

function validModelRect(value: unknown): boolean {
  const obj = asObject(value);
  return !!obj && validVector(obj.min ?? obj.minimum) && validVector(obj.max ?? obj.maximum);
}

function validGeometry(value: unknown): boolean {
  const geometry = asObject(value);
  if (!geometry) return false;
  const kind = stringValue(geometry.kind, geometry.type)?.toLowerCase();
  if (kind === "none") return false;
  if (validProjectedPoint(geometry.point ?? geometry.xyz ?? geometry.origin)) return true;
  if (validProjectedPoint(geometry.start ?? geometry.startPoint ?? geometry.start_point)
    && validProjectedPoint(geometry.end ?? geometry.endPoint ?? geometry.end_point)) return true;
  if (validModelRect(geometry.bounds ?? geometry.bbox ?? geometry.boundingBox)) return true;
  const points = geometry.points ?? geometry.vertices;
  return Array.isArray(points) && points.length > 0 && points.every(validProjectedPoint);
}

function groundingStatus(item: Record<string, any>): "anchored" | "bbox" | "geometry" | "ungrounded" {
  if (validAnchor(item.anchor)) return "anchored";
  const bbox = asObject(item.bbox);
  if (validImageRect(bbox?.image) || validModelRect(bbox?.model)) return "bbox";
  return validGeometry(item.geometry) ? "geometry" : "ungrounded";
}

function normalizeItem(value: unknown): Record<string, unknown> {
  const item = asObject(value);
  if (!item) throw new Error("Malformed visible-elements frame contract: items must contain objects.");
  const elementId = positiveInteger(item.elementId ?? item.element_id ?? item.id);
  const sourceScopedId = sourceScopedIdFor(item, elementId);
  return { ...item, ...(elementId !== null ? { elementId } : {}), ...(sourceScopedId ? { sourceScopedId } : {}), groundingStatus: groundingStatus(item) };
}

/** Preserves native evidence while binding every coordinate to this one frame. */
export function normalizeSpatialObservationV1(payload: unknown): Record<string, unknown> {
  const root = asObject(payload);
  requireFrameContract(root, "response must be an object");
  const frameId = stringValue(root.frameId, root.frame_id);
  const image = asObject(root.image);
  const imagePath = stringValue(root.path, root.imagePath, root.image_path, image?.path, image?.imagePath);
  const widthPx = positiveInteger(root.widthPx ?? root.width_px ?? image?.widthPx ?? image?.width_px);
  const heightPx = positiveInteger(root.heightPx ?? root.height_px ?? image?.heightPx ?? image?.height_px);
  const view = asObject(root.view);
  const viewId = positiveInteger(root.viewId ?? root.view_id ?? view?.id);
  const viewName = stringValue(root.viewName, root.view_name, view?.name);
  const viewType = stringValue(root.viewType, root.view_type, view?.type);
  const mapping = asObject(root.mapping);
  const rawItems = Array.isArray(root.items) ? root.items : Array.isArray(root.elements) ? root.elements : null;
  const count = nonNegativeInteger(root.count);
  const scanned = nonNegativeInteger(root.scanned);
  const truncated = typeof root.truncated === "boolean" ? root.truncated : null;
  requireFrameContract(frameId, "frameId is required");
  requireFrameContract(imagePath, "image path is required");
  requireFrameContract(widthPx, "positive widthPx is required");
  requireFrameContract(heightPx, "positive heightPx is required");
  requireFrameContract(viewId !== null || viewName, "view identity is required");
  requireFrameContract(mapping, "mapping object is required");
  requireFrameContract(validAffineMapping(mapping), "mapping must use 2d_affine with three finite XYZ corners and non-degenerate axes");
  requireFrameContract(rawItems, "items array is required");
  requireFrameContract(count !== null && scanned !== null && truncated !== null, "count, scanned, and truncated are required");
  requireFrameContract(count === rawItems.length, "count must equal items.length");
  requireFrameContract(scanned >= count, "scanned must be at least count");
  const items = rawItems.map(normalizeItem);
  const seenSourceScopedIds = new Set<string>();
  for (const item of items) {
    const sourceScopedId = stringValue(item.sourceScopedId, item.source_scoped_id);
    requireFrameContract(sourceScopedId, "each item requires sourceScopedId");
    requireFrameContract(!seenSourceScopedIds.has(sourceScopedId), `sourceScopedId must be unique within one observation: ${sourceScopedId}`);
    seenSourceScopedIds.add(sourceScopedId);
  }
  return {
    ...root, schemaVersion: SPATIAL_OBSERVATION_V1_SCHEMA_VERSION,
    observationId: stringValue(root.observationId, root.observation_id, frameId)!, frameId, path: imagePath, widthPx, heightPx,
    view: { ...(view ?? {}), ...(viewId !== null ? { id: viewId } : {}), ...(viewName ? { name: viewName } : {}), ...(viewType ? { type: viewType } : {}) },
    ...(viewId !== null ? { viewId } : {}), ...(viewName ? { viewName } : {}), ...(viewType ? { viewType } : {}),
    targetLevel: root.targetLevel ?? root.target_level ?? null, image: { ...image, path: imagePath, widthPx, heightPx }, mapping, count, scanned, truncated, items
  };
}

export function normalizeSpatialObservationInput(input: SpatialObservationInput): Record<string, unknown> {
  const imageSize = input.imageSize ?? 2200;
  const limit = input.limit ?? 500;
  if (!Number.isSafeInteger(imageSize) || imageSize < 256 || imageSize > 4096) throw new Error("imageSize must be an integer from 256 to 4096.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error("limit must be an integer from 1 to 2000.");
  if (input.viewId !== undefined && (!Number.isSafeInteger(input.viewId) || input.viewId <= 0)) throw new Error("viewId must be a positive integer.");
  const categories = (value: string[] | undefined, name: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (value.length > 64 || value.some(v => typeof v !== "string" || !v.trim() || v.length > 128)) throw new Error(`${name} must contain at most 64 nonempty category names up to 128 characters.`);
    return [...new Set(value.map(v => v.trim()))];
  };
  if (input.modelBounds !== undefined && (!Array.isArray(input.modelBounds) || input.modelBounds.length !== 6 || input.modelBounds.some(value => typeof value !== "number" || !Number.isFinite(value)))) throw new Error("modelBounds must be exactly [minX,minY,minZ,maxX,maxY,maxZ].");
  const included = categories(input.categories, "categories");
  const excluded = categories(input.excludeCategories, "excludeCategories");
  return {
    ...(input.viewId !== undefined ? { viewId: input.viewId } : {}), imageSize,
    ...(included ? { categories: included } : {}), ...(excluded ? { excludeCategories: excluded } : {}),
    ...(input.includeLinked !== undefined ? { includeLinked: input.includeLinked } : {}), ...(input.modelBounds ? { modelBounds: [...input.modelBounds] } : {}),
    limit, includeMapping: true, includeGeometry: true
  };
}

function isUnderDir(candidatePath: string, rootDir: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootDir);
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return process.platform === "win32"
    ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
    : candidate.startsWith(prefix);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function approvedObservationRoots(): { configuredRoot: string; lexicalRoots: string[]; realRoots: string[] } {
  const configuredRoot = path.resolve(getWorkspaceRoot());
  const lexicalRoots = [configuredRoot];
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) lexicalRoots.push(path.resolve(localAppData, "RevitOperator", "Workspace"));

  const realRoots: string[] = [];
  for (const root of lexicalRoots) {
    try {
      const realRoot = fs.realpathSync(root);
      if (fs.statSync(realRoot).isDirectory() && !realRoots.some(existing => samePath(existing, realRoot))) {
        realRoots.push(realRoot);
      }
    } catch {
      if (samePath(root, configuredRoot)) throw new Error("configured workspace root is unavailable");
    }
  }
  return { configuredRoot, lexicalRoots, realRoots };
}

function isUnderAnyDir(candidatePath: string, roots: string[]): boolean {
  return roots.some(root => isUnderDir(candidatePath, root));
}

function sniffImageMime(data: Buffer): "image/png" | "image/jpeg" | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return null;
}

function sameFileIdentity(opened: fs.BigIntStats, current: fs.BigIntStats): boolean {
  return opened.dev !== 0n && opened.ino !== 0n
    && opened.dev === current.dev
    && opened.ino === current.ino;
}

export function readSpatialObservationImage(
  imagePath: string,
  maxBytes = MAX_IMAGE_BYTES,
  hooks: SpatialObservationImageReadHooks = {}
): SpatialObservationImageReadResult {
  let fd: number | null = null;
  try {
    const boundedMaxBytes = Math.max(1, Math.floor(maxBytes));
    const roots = approvedObservationRoots();
    const candidate = path.isAbsolute(imagePath) ? path.resolve(imagePath) : path.resolve(roots.configuredRoot, imagePath);
    if (!isUnderAnyDir(candidate, roots.lexicalRoots)) return { ok: false, reason: "image path is outside the workspace or native capture root" };
    const targetRealPath = fs.realpathSync(candidate);
    if (!isUnderAnyDir(targetRealPath, roots.realRoots)) return { ok: false, reason: "image resolves outside the workspace or native capture root" };
    const approvedStat = fs.statSync(targetRealPath, { bigint: true });
    if (!approvedStat.isFile() || approvedStat.dev === 0n || approvedStat.ino === 0n) {
      return { ok: false, reason: "workspace image does not have a stable regular-file identity" };
    }

    hooks.afterResolve?.();
    const noFollow = Number((fs.constants as Record<string, unknown>).O_NOFOLLOW ?? 0);
    fd = fs.openSync(targetRealPath, fs.constants.O_RDONLY | noFollow);
    hooks.afterOpen?.();
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(stat, approvedStat)) return { ok: false, reason: "opened image identity does not match the approved workspace file" };
    const currentRealPath = fs.realpathSync(candidate);
    if (!samePath(currentRealPath, targetRealPath) || !isUnderAnyDir(currentRealPath, roots.realRoots)) {
      return { ok: false, reason: "image path changed while opening" };
    }
    const currentStat = fs.statSync(candidate, { bigint: true });
    if (!sameFileIdentity(stat, currentStat)) return { ok: false, reason: "opened image identity does not match the workspace path" };
    if (!stat.isFile() || stat.size <= 0n) return { ok: false, reason: "image is not a nonempty regular file" };
    if (stat.size > BigInt(boundedMaxBytes)) return { ok: false, reason: "image exceeds the MCP image limit" };

    const buffer = Buffer.allocUnsafe(boundedMaxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset === 0) return { ok: false, reason: "image is empty" };
    if (offset > boundedMaxBytes) return { ok: false, reason: "image exceeds the MCP image limit" };
    const data = buffer.subarray(0, offset);
    const mimeType = sniffImageMime(data);
    if (!mimeType) return { ok: false, reason: "image is not a supported PNG or JPEG payload" };
    return { ok: true, data: data.toString("base64"), mimeType };
  } catch {
    return { ok: false, reason: "image could not be securely opened" };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export async function observeModelV1(input: SpatialObservationInput, callNative: SpatialObservationCall, readImage: SpatialObservationImageReader = readSpatialObservationImage): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> }> {
  const payload = await callNative("/revit/export-visible-elements", "POST", normalizeSpatialObservationInput(input));
  const observation = normalizeSpatialObservationV1(payload);
  const image = readImage(String(observation.path), MAX_IMAGE_BYTES);
  if (!image.ok) {
    const warnings = Array.isArray(observation.warnings) ? observation.warnings : [];
    warnings.push(`Observation image unavailable: ${image.reason}; structured frame evidence is preserved.`);
    observation.warnings = warnings;
  }
  return { content: [{ type: "text", text: JSON.stringify(observation, null, 2) }, ...(image.ok ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }] : [])] };
}
