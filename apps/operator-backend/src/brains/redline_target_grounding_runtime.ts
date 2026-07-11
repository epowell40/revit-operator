import { randomUUID } from "node:crypto";
import { groundRedlineEvidenceTarget } from "../redline/redline_target_grounding.js";
import { normalizeAecIntentEvidenceV1 } from "../aec_intent_evidence.js";
import type { WorkbenchActionResult } from "../workbench/workbench_runner.js";
import { callBridgeActionDirect } from "./direct_revit_bridge.js";

type GroundingPath = "/revit/sheets" | "/revit/get-titleblock-info";
export type GroundingBridgeCall = (sessionId: string, method: "POST", path: GroundingPath, body: Record<string, unknown>) => Promise<{ ok: boolean; method: "GET" | "POST"; path: string; result_json?: unknown }>;
export type RedlineGroundingRuntimeDeps = { callBridge?: GroundingBridgeCall; createActionId?: () => string; };

function original(results: readonly WorkbenchActionResult[]): WorkbenchActionResult[] { return results.map((item) => ({ ...item, ...(item.details ? { details: { ...item.details } } : {}) })); }
function record(value: unknown): Record<string, unknown> | null { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null; }
function exact(value: unknown, expected: Record<string, unknown>): boolean { const item = record(value); return !!item && Object.keys(item).length === Object.keys(expected).length && Object.entries(expected).every(([key, entry]) => item[key] === entry); }
function actionId(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.length <= 512; }
function fingerprinted(evidence: ReturnType<typeof normalizeAecIntentEvidenceV1>): boolean { const fingerprint = evidence.target.document?.fingerprint, sources = new Set(evidence.evidence.filter((item) => (item.kind === "pdf_page" || item.kind === "pdf_annotation" || item.kind === "sheet_region") && item.source.kind === "adapter" && /^artifact:\/\//.test(item.uri ?? "") && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/i.test(item.sha256)).map((item) => item.sha256!.toLowerCase())); return typeof fingerprint === "string" && /^[a-f0-9]{64}$/i.test(fingerprint) && sources.size === 1 && sources.has(fingerprint.toLowerCase()); }

/** Executes the two accepted no-write discovery reads once and exposes only grounded evidence. */
export async function groundInitialRedlineWorkbenchResults(sessionId: string, results: readonly WorkbenchActionResult[], deps: RedlineGroundingRuntimeDeps = {}): Promise<WorkbenchActionResult[]> {
  const unchanged = original(results), candidates = unchanged.filter((item) => item.ok && item.type === "analyze_redline" && record(item.details)?.aec_intent_evidence);
  if (candidates.length !== 1) return unchanged;
  const candidate = candidates[0]!, details = record(candidate.details), evidence = details?.aec_intent_evidence;
  let normalized; try { normalized = normalizeAecIntentEvidenceV1(evidence); } catch { return unchanged; }
  const sheetNumber = normalized.target.status === "ambiguous" && typeof normalized.target.sheet?.number === "string" ? normalized.target.sheet.number : "", proposals = normalized.intent.proposed_actions;
  if (!fingerprinted(normalized) || normalized.intent.domain !== "redline" || normalized.intent.action !== "interpret_redline" || !sheetNumber || proposals.length !== 2 || proposals[0]?.tool !== "/revit/sheets" || proposals[1]?.tool !== "/revit/get-titleblock-info" || proposals.some((proposal) => proposal.requires_apply) || !exact(proposals[0]?.body, { action: "detail", sheetNumber, includePlacedViews: true, includeViewports: true, includeViewportGeometry: true, includeTitleBlocks: true, includeSheetOutline: true }) || !exact(proposals[1]?.body, { sheetNumber })) return unchanged;
  const create = deps.createActionId ?? randomUUID, firstId = create(), secondId = create();
  if (!actionId(firstId) || !actionId(secondId) || firstId === secondId) return unchanged;
  const actions = [{ action_id: firstId, method: "POST" as const, path: "/revit/sheets" as const, body: { action: "detail", sheetNumber, includePlacedViews: true, includeViewports: true, includeViewportGeometry: true, includeTitleBlocks: true, includeSheetOutline: true } }, { action_id: secondId, method: "POST" as const, path: "/revit/get-titleblock-info" as const, body: { sheetNumber } }];
  const call = deps.callBridge ?? callBridgeActionDirect as GroundingBridgeCall, received: Array<Record<string, unknown>> = [];
  for (const action of actions as Array<{ action_id: string; method: "POST"; path: GroundingPath; body: Record<string, unknown> }>) {
    let result; try { result = await call(sessionId, action.method, action.path, action.body); } catch { return unchanged; }
    if (!result.ok || result.method !== action.method || result.path !== action.path || !record(result.result_json)) return unchanged;
    received.push({ action_id: action.action_id, method: action.method, path: action.path, status: "done", result_json: result.result_json });
  }
  const grounded = groundRedlineEvidenceTarget(evidence, { actions, results: received });
  if (!grounded || grounded.target.status !== "ambiguous" || grounded.target.sheet?.id === undefined || grounded.target.view?.id === undefined) return unchanged;
  return unchanged.map((item) => item === candidate ? { ...item, details: { ...details, aec_intent_evidence: grounded } } : item);
}
