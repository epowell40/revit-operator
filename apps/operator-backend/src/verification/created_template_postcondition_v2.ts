import { createdViewIdsFromIdentitiesV2 } from './view_owned_detailing_v2.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const failed = (value: Row) => value.isError === true || value.ok === false || value.success === false || Boolean(value.error) || value.dryRun === true;

/** Proves the new named template exists on the native-created identity.
 * Source-derived settings still require paired source/template readback; this
 * predicate does not infer provenance or copied state from a name or an ID. */
export function createdTemplateSatisfiedV2(request: Row, payload: unknown, identities: readonly string[]): boolean {
  if (request.dryRun === true) return false;
  let root = row(payload);
  if (failed(root)) return false;
  if (!('view' in root) && !('views' in root) && !('status' in root) && Array.isArray(root.content) && root.content.length === 1) {
    const block = row(root.content[0]);
    if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length > 1_000_000) return false;
    try { root = row(JSON.parse(block.text)); } catch { return false; }
  }
  if (failed(root)) return false;
  const targets = createdViewIdsFromIdentitiesV2(identities);
  let view: Row;
  if (root.status === 'Ok' && root.action === 'get' && root.dryRun === false) view = row(root.view);
  else if (root.status === 'ok' && root.action === 'list' && root.truncated === false && Array.isArray(root.views) && root.returned === root.views.length) {
    const matches = root.views.map(row).filter(v => positiveId(v.id) && targets.includes(v.id));
    if (matches.length !== 1) return false;
    view = matches[0]!;
  } else return false;
  if (!positiveId(view.id) || !targets.includes(view.id) || view.isTemplate !== true) return false;
  if (request.sourceViewId != null && (!positiveId(request.sourceViewId) || view.id === request.sourceViewId)) return false;
  if (request.name != null && (typeof request.name !== 'string' || !request.name.trim() || view.name !== request.name.trim().slice(0, 120).trim())) return false;
  for (const key of ['scale', 'detailLevel', 'discipline']) {
    if (request[key] == null) continue;
    if (typeof request[key] === 'string' && typeof view[key] === 'string') {
      if (request[key].trim().toLowerCase() !== view[key].trim().toLowerCase()) return false;
    } else if (request[key] !== view[key]) return false;
  }
  return true;
}
