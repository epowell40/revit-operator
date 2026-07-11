import { AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS, AEC_INTENT_EVIDENCE_MAX_IDENTIFIER_CHARS, AEC_INTENT_EVIDENCE_MAX_STRING_CHARS, normalizeAecIntentEvidenceV1, type AecIntentEvidenceV1 } from "../aec_intent_evidence.js";

export type TrustedRedlineDiscoveryContext = { actions: unknown; results: unknown };
type JsonRecord = Record<string, unknown>;
type ProposalPath = "/revit/sheets" | "/revit/get-titleblock-info";
type Action = { action_id: string; path: ProposalPath; body: JsonRecord };
type Result = { action_id: string; path: ProposalPath; result_json: JsonRecord };
type Grounded = { sheetId: number; viewId: number; viewName: string; sheetNumber: string };

const proposalPaths = new Set<ProposalPath>(["/revit/sheets", "/revit/get-titleblock-info"]);
const modelViewTypes = new Set(["FloorPlan", "CeilingPlan", "EngineeringPlan", "AreaPlan", "Section", "Elevation", "ThreeD"]);

function record(value: unknown): JsonRecord | null { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value as JsonRecord : null; }
function text(value: unknown, max = AEC_INTENT_EVIDENCE_MAX_IDENTIFIER_CHARS): string | null { return typeof value === "string" && value.trim() && value.length <= max ? value : null; }
function positiveInteger(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null; }
function canonical(value: unknown, stack = new WeakSet<object>(), depth = 0): string | null {
  if (depth > 32 || value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return null;
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return value.length <= AEC_INTENT_EVIDENCE_MAX_STRING_CHARS ? JSON.stringify(value) : null;
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (!value || typeof value !== "object" || stack.has(value)) return null;
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (value.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key))) || Object.keys(value).length !== value.length) return null;
      const items: string[] = [];
      for (const item of value) { const part = canonical(item, stack, depth + 1); if (part === null) return null; items.push(part); }
      return `[${items.join(",")}]`;
    }
    const item = record(value); if (!item || Object.keys(item).length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS) return null;
    const parts: string[] = [];
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(item, key) : undefined;
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    }
    for (const key of Object.keys(item).sort()) { const part = canonical(item[key], stack, depth + 1); if (part === null) return null; parts.push(`${JSON.stringify(key)}:${part}`); }
    return `{${parts.join(",")}}`;
  } finally { stack.delete(value); }
}
function sameJson(left: unknown, right: unknown): boolean { const a = canonical(left), b = canonical(right); return a !== null && a === b; }
function exactBody(value: unknown, expected: Record<string, unknown>): JsonRecord | null {
  const item = record(value); if (!item || canonical(item) === null || Object.keys(item).length !== Object.keys(expected).length) return null;
  for (const [key, expectedValue] of Object.entries(expected)) if (!(key in item) || !sameJson(item[key], expectedValue)) return null;
  return item;
}
function exactDedup(value: unknown): JsonRecord[] | null {
  if (!Array.isArray(value) || value.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS) return null;
  const out: JsonRecord[] = [], seen = new Set<string>();
  for (const raw of value) { const item = record(raw), key = canonical(raw); if (!item || key === null) return null; if (!seen.has(key)) { seen.add(key); out.push(item); } }
  return out;
}
function actions(value: unknown): Action[] | null {
  const source = exactDedup(value); if (!source) return null;
  const out: Action[] = [];
  for (const item of source) {
    const action_id = text(item.action_id), path = item.path, body = record(item.body);
    if (!action_id || item.method !== "POST" || typeof path !== "string" || !proposalPaths.has(path as ProposalPath) || !body || canonical(body) === null) return null;
    out.push({ action_id, path: path as ProposalPath, body });
  }
  return out;
}
function results(value: unknown): Result[] | null {
  const source = exactDedup(value); if (!source) return null;
  const out: Result[] = [];
  for (const item of source) {
    const action_id = text(item.action_id), path = item.path, result_json = record(item.result_json);
    if (!action_id || item.method !== "POST" || item.status !== "done" || typeof path !== "string" || !proposalPaths.has(path as ProposalPath) || !result_json || canonical(result_json) === null) return null;
    out.push({ action_id, path: path as ProposalPath, result_json });
  }
  return out;
}
function one<T>(items: T[]): T | null { return items.length === 1 ? items[0]! : null; }
function candidateViews(value: unknown, count: unknown): { id: number; name: string }[] | null {
  if (!Array.isArray(value) || !Number.isInteger(count) || count !== value.length || value.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS || canonical(value) === null) return null;
  const byId = new Map<number, { id: number; name: string; type: string; scale: number; viewportIds: number[]; key: string }>();
  for (const raw of value) {
    const item = record(raw), id = positiveInteger(item?.viewId), name = text(item?.name), type = text(item?.viewType), scale = item?.scale;
    const viewportIds = Array.isArray(item?.viewportIds) && item.viewportIds.every((entry) => positiveInteger(entry) !== null) ? item.viewportIds as number[] : null;
    if (!item || !id || !name || !type || typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || !viewportIds) return null;
    if (!modelViewTypes.has(type)) continue;
    const key = canonical({ id, name, type, scale, viewportIds }); if (key === null) return null;
    const prior = byId.get(id); if (prior && prior.key !== key) return null;
    byId.set(id, { id, name, type, scale, viewportIds, key });
  }
  return [...byId.values()].map(({ id, name }) => ({ id, name }));
}
function fingerprintedRedline(base: AecIntentEvidenceV1): boolean {
  const fingerprint = base.target.document?.fingerprint;
  if (base.intent.domain !== "redline" || base.intent.action !== "interpret_redline" || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(fingerprint)) return false;
  const sourceFingerprints = new Set(base.evidence.filter((item) => (item.kind === "pdf_page" || item.kind === "pdf_annotation" || item.kind === "sheet_region") && item.source.kind === "adapter" && /^artifact:\/\//.test(item.uri ?? "") && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/i.test(item.sha256)).map((item) => item.sha256!.toLowerCase()));
  return sourceFingerprints.size === 1 && sourceFingerprints.has(fingerprint.toLowerCase());
}
function ground(base: AecIntentEvidenceV1, context: TrustedRedlineDiscoveryContext): Grounded | null {
  if (!fingerprintedRedline(base) || base.target.status !== "ambiguous") return null;
  const sheetNumber = text(base.target.sheet?.number); if (!sheetNumber || base.intent.proposed_actions.length !== 2) return null;
  const sheetProposal = one(base.intent.proposed_actions.filter((proposal) => proposal.tool === "/revit/sheets"));
  const titleProposal = one(base.intent.proposed_actions.filter((proposal) => proposal.tool === "/revit/get-titleblock-info"));
  if (!sheetProposal || !titleProposal || sheetProposal.requires_apply || titleProposal.requires_apply) return null;
  const sheetBody = exactBody(sheetProposal.body, { action: "detail", sheetNumber, includePlacedViews: true, includeViewports: true, includeViewportGeometry: true, includeTitleBlocks: true, includeSheetOutline: true });
  const titleBody = exactBody(titleProposal.body, { sheetNumber });
  if (!sheetBody || !titleBody) return null;
  const actionSource = actions(context.actions), resultSource = results(context.results); if (!actionSource || !resultSource || actionSource.length !== 2 || resultSource.length !== 2) return null;
  const sheetAction = one(actionSource.filter((action) => action.path === "/revit/sheets" && sameJson(action.body, sheetBody)));
  const titleAction = one(actionSource.filter((action) => action.path === "/revit/get-titleblock-info" && sameJson(action.body, titleBody)));
  if (!sheetAction || !titleAction || sheetAction.action_id === titleAction.action_id) return null;
  const sheetResult = one(resultSource.filter((result) => result.action_id === sheetAction.action_id && result.path === sheetAction.path))?.result_json;
  const titleResult = one(resultSource.filter((result) => result.action_id === titleAction.action_id && result.path === titleAction.path))?.result_json;
  if (!sheetResult || !titleResult || sheetResult.status !== "Ok" || sheetResult.action !== "detail" || sheetResult.isPlaceholder !== false || titleResult.ok !== true) return null;
  const sheetElementId = positiveInteger(sheetResult.sheetElementId), sheetId = positiveInteger(sheetResult.sheetId), sheetViewId = positiveInteger(sheetResult.viewId), resultNumber = text(sheetResult.sheetNumber), titleSheetId = positiveInteger(titleResult.sheetId), titleSheetViewId = positiveInteger(titleResult.sheetViewId), titleNumber = text(titleResult.sheetNumber), titleInstanceId = positiveInteger(titleResult.titleblockInstanceId), titleTypeId = positiveInteger(titleResult.titleblockTypeId);
  if (!sheetElementId || !sheetId || !sheetViewId || !resultNumber || !titleSheetId || !titleSheetViewId || !titleNumber || !titleInstanceId || !titleTypeId || sheetElementId !== sheetId || sheetId !== sheetViewId || sheetId !== titleSheetId || sheetId !== titleSheetViewId || resultNumber !== sheetNumber || titleNumber !== sheetNumber || sheetResult.titleBlockCount !== 1 || titleResult.titleblockCount !== 1) return null;
  const titleblocks = Array.isArray(sheetResult.titleBlocks) ? sheetResult.titleBlocks : [];
  if (titleblocks.length !== 1 || positiveInteger(record(titleblocks[0])?.elementId) !== titleInstanceId || positiveInteger(record(titleblocks[0])?.typeId) !== titleTypeId) return null;
  const views = candidateViews(sheetResult.placedViews, sheetResult.placedViewCount); if (!views || views.length !== 1) return null;
  return { sheetId, viewId: views[0]!.id, viewName: views[0]!.name, sheetNumber };
}

/** Pure target enrichment from trusted read-only composition input; it never invokes or persists tools. */
export function groundRedlineEvidenceTarget(input: unknown, context: TrustedRedlineDiscoveryContext): AecIntentEvidenceV1 | undefined {
  let base: AecIntentEvidenceV1;
  try { base = normalizeAecIntentEvidenceV1(input); } catch { return undefined; }
  const value = ground(base, context); if (!value) return base;
  return normalizeAecIntentEvidenceV1({ ...base, target: { ...base.target, status: "ambiguous", sheet: { number: value.sheetNumber, id: value.sheetId }, view: { id: value.viewId, name: value.viewName } } });
}
