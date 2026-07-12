import type { ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { interpretAecSemanticTask, type AecSemanticTaskInterpreter } from "../aec_semantic_task_interpreter.js";
import type { AecSemanticTaskV1 } from "../aec_semantic_task.js";
import { continueExactIdentifierQuery, planAecQueryTask, type AecQueryPlanV1, type AecQueryWorkflowId } from "./aec_query_plan.js";

type QueryState = { task: AecSemanticTaskV1; workflow_id: AecQueryWorkflowId; stage: number; evidence: Record<string, unknown>; expires_at: number };
const states = new Map<string, QueryState>();
const TTL_MS = 5 * 60_000;

function purge(now = Date.now()): void { for (const [key, state] of states) if (state.expires_at <= now) states.delete(key); }
function key(req: ChatRequest): string { return req.session_id; }
function response(message: string, actions: ChatResponse["actions"] = []): ChatResponse { return { version: "operator.backend.v1", assistant_message: message, actions }; }
function resultPayload(result: ToolResult | undefined): Record<string, unknown> | null { const value = result?.result_json; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function matchingResult(req: ChatRequest, actionId: string): ToolResult | undefined { return req.tool_results?.find(result => result.action_id === actionId); }

function countFromPayload(payload: Record<string, unknown> | null): number | null {
  if (Number.isSafeInteger(payload?.count) && (payload?.count as number) >= 0) return payload?.count as number;
  for (const key of ["elements", "items", "results"]) if (Array.isArray(payload?.[key])) return (payload?.[key] as unknown[]).length;
  return null;
}

function subjectLabel(task: AecSemanticTaskV1): string {
  return task.subject.semantic_class === "other" ? (task.subject.terms[0] ?? "matching elements") : task.subject.semantic_class.replaceAll("_", " ");
}

function completeSingleAction(task: AecSemanticTaskV1, workflow: AecQueryWorkflowId, result: ToolResult): ChatResponse {
  if (result.status !== "done") return response(`I could not complete the bounded ${task.operation} query: ${result.error || "the Revit read action failed"}.`);
  const payload = resultPayload(result);
  const count = countFromPayload(payload);
  const scope = task.scope.rooms[0] ? `Room ${task.scope.rooms[0]}` : task.scope.views[0]?.name ?? task.scope.sheets[0] ?? "the requested scope";
  const countText = count === null ? "The bounded query completed" : `${count} ${subjectLabel(task)}${count === 1 ? "" : "s"} matched`;
  return response(`${countText} in ${scope}. The result came from the scoped ${workflow.replace("query.", "").replaceAll("_", " ")} workflow; no model changes were made.`);
}

function exactCompletion(task: AecSemanticTaskV1, state: QueryState, result: ToolResult): ChatResponse {
  if (result.status !== "done") return response(`I found the exact identifier but could not read its placement context: ${result.error || "the context query failed"}. No model changes were made.`);
  const context = resultPayload(result) ?? {};
  const candidate = state.evidence.candidate && typeof state.evidence.candidate === "object" ? state.evidence.candidate as Record<string, unknown> : {};
  const room = context.room && typeof context.room === "object" ? context.room as Record<string, unknown> : null;
  const identifier = task.subject.identifiers[0]?.value ?? "The element";
  const elementId = context.elementId ?? candidate.id ?? "unknown";
  const familyType = [context.familyName, context.typeName].filter(value => typeof value === "string" && value).join(" / ");
  const level = typeof context.levelName === "string" && context.levelName ? context.levelName : "level not reported";
  const roomText = room && (room.number || room.name) ? `Room ${[room.number, room.name].filter(Boolean).join(" — ")}` : "no room/space association reported";
  const location = context.center && typeof context.center === "object" ? JSON.stringify(context.center) : "not reported";
  const system = typeof context.systemName === "string" && context.systemName ? ` System: ${context.systemName}.` : "";
  const bestView = context.bestView && typeof context.bestView === "object" ? context.bestView as Record<string, unknown> : null;
  const viewText = bestView?.name ? ` Best view: ${bestView.name} (id ${bestView.id ?? "unknown"}).` : "";
  return response(`${identifier} is element ${elementId}${familyType ? ` (${familyType})` : ""}, on ${level}, with ${roomText}. Its model location is ${location}.${system}${viewText} No model changes were made.`);
}

async function begin(req: ChatRequest, interpreter?: AecSemanticTaskInterpreter): Promise<{ task: AecSemanticTaskV1 | null; response: ChatResponse | null }> {
  const task = await interpretAecSemanticTask(req, interpreter);
  if (!task) return { task: null, response: null };
  const plan = planAecQueryTask(task);
  if (plan.status !== "ready" || !plan.workflow_id || plan.actions.length === 0) return { task, response: null };
  states.set(key(req), { task, workflow_id: plan.workflow_id, stage: 0, evidence: plan.evidence, expires_at: Date.now() + TTL_MS });
  return { task, response: response("I’m resolving this directly in the smallest supported Revit scope.", plan.actions) };
}

function continueRun(req: ChatRequest, state: QueryState): ChatResponse | null {
  if (state.workflow_id === "query.exact_identifier" && state.stage === 0) {
    const result = matchingResult(req, "aec-query-exact-identifier");
    if (!result) return null;
    const next = continueExactIdentifierQuery(state.task, result);
    if (next.status === "ready" && next.actions.length) {
      states.set(key(req), { ...state, stage: 1, evidence: { ...state.evidence, ...next.evidence }, expires_at: Date.now() + TTL_MS });
      return response("I found one exact match and am reading only its placement context.", next.actions);
    }
    states.delete(key(req));
    if (next.status === "blocked") return response(`I found multiple candidates for ${state.task.subject.identifiers[0]?.value ?? "that identifier"}; I did not guess or broaden the search. No model changes were made.`);
    return response(`I did not find an exact match for ${state.task.subject.identifiers[0]?.value ?? "that identifier"} in the requested category and scope. No model changes were made.`);
  }
  if (state.workflow_id === "query.exact_identifier" && state.stage === 1) {
    const result = matchingResult(req, "aec-query-exact-context") ?? matchingResult(req, "aec-query-exact-scope");
    if (!result) return null;
    states.delete(key(req));
    return exactCompletion(state.task, state, result);
  }
  const actionIds: Partial<Record<AecQueryWorkflowId, string>> = {
    "query.room_contents": "aec-query-room-contents",
    "query.level_elements": "aec-query-level-elements",
    "query.view_elements": "aec-query-view-elements",
    "query.sheet_elements": "aec-query-sheet-elements",
    "query.selection": "aec-query-selection"
  };
  const actionId = actionIds[state.workflow_id];
  if (!actionId) return null;
  const result = matchingResult(req, actionId);
  if (!result) return null;
  states.delete(key(req));
  return completeSingleAction(state.task, state.workflow_id, result);
}

export async function maybeRunAecSemanticQuery(req: ChatRequest, interpreter?: AecSemanticTaskInterpreter): Promise<{ task: AecSemanticTaskV1 | null; response: ChatResponse | null }> {
  purge();
  const state = states.get(key(req));
  if (state && (req.tool_results?.length ?? 0) > 0) return { task: state.task, response: continueRun(req, state) };
  if ((req.tool_results?.length ?? 0) > 0) return { task: null, response: null };
  return begin(req, interpreter);
}

export function __testOnlyClearAecQueryStates(): void { states.clear(); }
