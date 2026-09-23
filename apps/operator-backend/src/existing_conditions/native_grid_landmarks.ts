import type { CandidateVisibleFrameMapping } from "./candidate_visible_registration.js";
import type { ExistingConditionsPlanPoint } from "./registration.js";

type GridAxis = { element_id: number; name: string; start: ExistingConditionsPlanPoint; end: ExistingConditionsPlanPoint };
export type TrustedGridLandmarks = { frame: CandidateVisibleFrameMapping; axes: GridAxis[]; operation_id: string; evidence_id: string };

function row(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function point(value: unknown): ExistingConditionsPlanPoint | null {
  const model = row(row(value).model);
  return Number.isFinite(model.x) && Number.isFinite(model.y) ? { x: model.x, y: model.y } : null;
}

export function nativeGridAxes(payload: unknown): GridAxis[] {
  const items = row(payload).items;
  if (!Array.isArray(items)) throw new Error("existing_conditions_registration_native_grid_items_missing");
  return items.flatMap(value => {
    const item = row(value), geometry = row(item.geometry);
    if (item.categoryToken !== "OST_Grids" || !Number.isSafeInteger(item.elementId) || item.elementId <= 0
        || item.sourceScopedId !== `host:${item.elementId}` || geometry.kind !== "curve" || geometry.isStraight !== true) return [];
    const start = point(geometry.start), end = point(geometry.end);
    if (!start || !end || Math.hypot(end.x - start.x, end.y - start.y) < 1e-6) return [];
    return [{ element_id: item.elementId, name: String(item.name ?? ""), start, end }];
  });
}

export function nativeGridIntersection(axes: GridAxis[], ids: [number, number]): ExistingConditionsPlanPoint {
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1] || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("existing_conditions_registration_native_grid_pair_invalid");
  }
  const selected = ids.map(id => axes.filter(axis => axis.element_id === id));
  if (selected.some(matches => matches.length !== 1)) throw new Error("existing_conditions_registration_native_grid_missing_or_ambiguous");
  const [a, b] = selected.map(matches => matches[0]!);
  const ax = a.end.x - a.start.x, ay = a.end.y - a.start.y;
  const bx = b.end.x - b.start.x, by = b.end.y - b.start.y;
  const cross = ax * by - ay * bx;
  if (Math.abs(cross) < 1e-8 * Math.hypot(ax, ay) * Math.hypot(bx, by)) throw new Error("existing_conditions_registration_native_grids_parallel");
  const dx = b.start.x - a.start.x, dy = b.start.y - a.start.y;
  const t = (dx * by - dy * bx) / cross;
  const s = (dx * ay - dy * ax) / cross;
  if (t < -0.01 || t > 1.01 || s < -0.01 || s > 1.01) throw new Error("existing_conditions_registration_native_grid_intersection_outside_axes");
  return { x: a.start.x + t * ax, y: a.start.y + t * ay };
}
