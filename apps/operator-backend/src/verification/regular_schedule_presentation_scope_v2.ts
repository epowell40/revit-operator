const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const identity = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 1024;

function inventory(value: unknown) {
  const tx = object(value), added = tx.added_element_ids, modified = tx.modified_element_ids, deleted = tx.deleted_element_ids;
  if (![added, modified, deleted].every(a => Array.isArray(a) && a.length <= 2048 && a.every(positive) && new Set(a).size === a.length)
      || deleted.length || added.some((id: number) => modified.includes(id))) return null;
  return {added: added as number[], modified: modified as number[]};
}

function scope(value: unknown, id: number, uid: string) {
  const v = object(value);
  if (v.schema !== 'operator.regular_schedule_presentation_scope.v1' || v.complete !== true
      || v.coverage !== 'configuration_cell_text_style_geometry_v1' || v.targetId !== id || v.targetUniqueId !== uid
      || !Number.isSafeInteger(v.totalUnrequestedCells) || v.totalUnrequestedCells < 0 || v.totalUnrequestedCells > 20000
      || !Array.isArray(v.unrequestedSchedules) || v.unrequestedSchedules.length > 100
      || !Array.isArray(v.dependencies) || v.dependencies.length > 1024) return null;
  const schedules = new Map<number, Record<string, any>>(), dependencies = new Map<number, Record<string, any>>();
  for (const raw of v.unrequestedSchedules) {
    const row = object(raw);
    if (!positive(row.scheduleId) || row.scheduleId === id || !identity(row.uniqueId) || !hash(row.semanticHash) || schedules.has(row.scheduleId)) return null;
    schedules.set(row.scheduleId, row);
  }
  for (const raw of v.dependencies) {
    const row = object(raw);
    if (!positive(row.id) || row.id === id || !identity(row.uniqueId) || !Number.isSafeInteger(row.ownerViewId)
        || typeof row.className !== 'string' || !row.className.startsWith('Autodesk.Revit.DB.') || dependencies.has(row.id)) return null;
    dependencies.set(row.id, row);
  }
  return {schedules, dependencies, cells: v.totalUnrequestedCells};
}

const sameDependency = (a: Record<string, any> | undefined, b: Record<string, any> | undefined) =>
  !!a && !!b && a.id === b.id && a.uniqueId === b.uniqueId && a.className === b.className && a.ownerViewId === b.ownerViewId;

/** A wider native event inventory needs complete unchanged schedule fingerprints AND native dependency evidence. */
export function regularSchedulePresentationScopeMatchesV2(scheduleId: number, uniqueId: string, applied: unknown, fresh: unknown): boolean {
  const a = object(applied), r = object(fresh), tx = inventory(a.transaction);
  if (!tx || !tx.modified.includes(scheduleId)) return false;
  if (!tx.added.length && tx.modified.every(id => id === scheduleId)) return true; // Preserve the original exact-inventory contract.
  const before = scope(a.presentationScopeBefore, scheduleId, uniqueId), after = scope(a.presentationScopeAfter, scheduleId, uniqueId), now = scope(r.scope, scheduleId, uniqueId);
  if (!before || !after || !now || before.cells !== after.cells || before.cells !== now.cells
      || before.schedules.size !== after.schedules.size || before.schedules.size !== now.schedules.size) return false;
  for (const [id, old] of before.schedules) {
    const post = after.schedules.get(id), current = now.schedules.get(id);
    if (!post || !current || post.uniqueId !== old.uniqueId || current.uniqueId !== old.uniqueId
        || post.semanticHash !== old.semanticHash || current.semanticHash !== old.semanticHash) return false;
  }
  for (const id of tx.modified.filter(id => id !== scheduleId)) {
    if (before.schedules.has(id)) continue;
    if (after.dependencies.get(id)?.className !== 'Autodesk.Revit.DB.Element' || !sameDependency(before.dependencies.get(id), after.dependencies.get(id)) || !sameDependency(after.dependencies.get(id), now.dependencies.get(id))) return false;
  }
  for (const id of tx.added)
    if (before.dependencies.has(id) || after.dependencies.get(id)?.className !== 'Autodesk.Revit.DB.Element' || !sameDependency(after.dependencies.get(id), now.dependencies.get(id))) return false;
  return true;
}

/** Native receipt identities must agree with the exhaustive retained payload, including added dependencies. */
export function regularSchedulePresentationInventoryMatchesV2(payload: unknown, targets: unknown): boolean {
  const tx = inventory(object(payload).transaction);
  if (!tx || !Array.isArray(targets) || new Set(targets).size !== targets.length) return false;
  const expected = [...tx.added, ...tx.modified].map(id => 'element_id:' + id).sort();
  return expected.length === targets.length && expected.every((id, i) => id === [...targets].sort()[i]);
}
