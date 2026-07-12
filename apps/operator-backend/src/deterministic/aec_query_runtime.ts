import type { ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { interpretAecSemanticTask, type AecSemanticTaskInterpreter } from "../aec_semantic_task_interpreter.js";
import type { AecSemanticTaskV1 } from "../aec_semantic_task.js";
import { continueExactIdentifierQuery, planAecQueryTask, type AecQueryPlanV1, type AecQueryWorkflowId } from "./aec_query_plan.js";

type QueryState = { task: AecSemanticTaskV1; workflow_id: AecQueryWorkflowId; stage: number; evidence: Record<string, unknown>; expires_at: number };
type QueryReceiptStatus = NonNullable<ChatResponse["aec_query_receipt"]>["status"];
const states = new Map<string, QueryState>();
const TTL_MS = 5 * 60_000;

function purge(now = Date.now()): void { for (const [key, state] of states) if (state.expires_at <= now) states.delete(key); }
function key(req: ChatRequest): string { return req.session_id; }
function response(message: string, actions: ChatResponse["actions"] = [], receipt?: { workflow_id: AecQueryWorkflowId; status: QueryReceiptStatus }): ChatResponse {
  return {
    version: "operator.backend.v1",
    assistant_message: message,
    actions,
    ...(receipt ? { aec_query_receipt: { schema: "revit-operator.aec-query-receipt.v1" as const, terminal: true as const, status: receipt.status, workflow_id: receipt.workflow_id, bounded: true as const, broadened: false as const } } : {})
  };
}
function resultPayload(result: ToolResult | undefined): Record<string, unknown> | null { const value = result?.result_json; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function matchingResult(req: ChatRequest, actionId: string): ToolResult | undefined { return req.tool_results?.find(result => result.action_id === actionId); }

function countFromPayload(payload: Record<string, unknown> | null): number | null {
  if (Number.isSafeInteger(payload?.count) && (payload?.count as number) >= 0) return payload?.count as number;
  for (const key of ["elementIds", "elements", "items", "results"]) if (Array.isArray(payload?.[key])) return (payload?.[key] as unknown[]).length;
  return null;
}

function subjectLabel(task: AecSemanticTaskV1): string {
  return task.subject.semantic_class === "other" ? (task.subject.terms[0] ?? "matching elements") : task.subject.semantic_class.replaceAll("_", " ");
}

function scopeLabel(task: AecSemanticTaskV1): string {
  if (task.scope.rooms[0]) return `Room ${task.scope.rooms[0]}`;
  if (task.scope.spaces[0]) return `Space ${task.scope.spaces[0]}`;
  if (task.scope.levels[0]) return task.scope.levels[0];
  if (task.scope.views[0]) return task.scope.views[0].name ?? `view ${task.scope.views[0].id}`;
  if (task.scope.sheets[0]) return `sheet ${task.scope.sheets[0]}`;
  if (task.scope.systems[0]) return `system ${task.scope.systems[0]}`;
  if (task.scope.kind === "selection") return "the current selection";
  return "the requested scope";
}

function resultItems(payload: Record<string, unknown> | null): Array<Record<string, unknown>> {
  for (const key of ["elements", "items", "results"]) {
    const value = payload?.[key];
    if (Array.isArray(value)) return value.filter(item => item && typeof item === "object" && !Array.isArray(item)).slice(0, 20) as Array<Record<string, unknown>>;
  }
  return [];
}

function boundedElementIds(payload: Record<string, unknown> | null, limit: number): number[] {
  const raw = Array.isArray(payload?.elementIds) ? payload.elementIds : [];
  return raw.filter(id => Number.isSafeInteger(id) && (id as number) > 0).slice(0, Math.max(1, Math.min(20, limit))) as number[];
}

function resultArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)).slice(0, 20) as Array<Record<string, unknown>>
    : [];
}

function textValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
  if (Number.isSafeInteger(value)) return String(value);
  return null;
}

function itemSummary(item: Record<string, unknown>): string {
  const id = textValue(item.elementId) ?? textValue(item.id);
  const name = textValue(item.name) ?? textValue(item.typeName) ?? textValue(item.familyName);
  const category = textValue(item.category) ?? textValue(item.builtInCategory);
  const level = textValue(item.levelName);
  const room = textValue(item.roomNumber);
  const identity = [id ? `id ${id}` : null, name, category].filter(Boolean).join(" — ") || "bounded result";
  const location = [level, room ? `Room ${room}` : null].filter(Boolean).join(", ");
  return location ? `${identity} (${location})` : identity;
}

function completeSingleAction(task: AecSemanticTaskV1, workflow: AecQueryWorkflowId, result: ToolResult): ChatResponse {
  if (result.status !== "done") return response(`I could not complete the bounded ${task.operation} query: ${result.error || "the Revit read action failed"}.`, [], { workflow_id: workflow, status: "failed" });
  const payload = resultPayload(result);
  const count = countFromPayload(payload);
  const scope = scopeLabel(task);
  const countText = count === null ? "The bounded query completed" : `${count} ${subjectLabel(task)}${count === 1 ? "" : "s"} matched`;
  if (["list", "inspect", "locate"].includes(task.operation)) {
    const items = resultItems(payload);
    const details = items.slice(0, Math.min(12, task.execution.max_results)).map(itemSummary);
    const truncation = payload?.truncated === true || (count !== null && count > details.length)
      ? ` Showing ${details.length} bounded result${details.length === 1 ? "" : "s"}; additional matches were not expanded into the response.`
      : "";
    const detailText = details.length ? ` Results: ${details.join("; ")}.` : "";
    return response(`${countText} in ${scope}.${detailText}${truncation} No model changes were made.`, [], { workflow_id: workflow, status: "complete" });
  }
  return response(`${countText} in ${scope}. The result came from the scoped ${workflow.replace("query.", "").replaceAll("_", " ")} workflow; no model changes were made.`, [], { workflow_id: workflow, status: "complete" });
}

function exactCompletion(task: AecSemanticTaskV1, state: QueryState, result: ToolResult): ChatResponse {
  if (result.status !== "done") return response(`I found the exact identifier but could not read its placement context: ${result.error || "the context query failed"}. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "failed" });
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
  return response(`${identifier} is element ${elementId}${familyType ? ` (${familyType})` : ""}, on ${level}, with ${roomText}. Its model location is ${location}.${system}${viewText} No model changes were made.`, [], { workflow_id: state.workflow_id, status: "found" });
}

async function begin(req: ChatRequest, interpreter?: AecSemanticTaskInterpreter): Promise<{ task: AecSemanticTaskV1 | null; response: ChatResponse | null }> {
  const task = await interpretAecSemanticTask(req, interpreter);
  if (!task) return { task: null, response: null };
  const plan = planAecQueryTask(task);
  if (plan.status === "blocked" && ["locate", "count", "list", "inspect", "compare", "focus"].includes(task.operation)) {
    const reason = plan.blockers.join(" ") || "No bounded deterministic workflow supports that query shape.";
    return { task, response: response(`I could not run this query without broadening or guessing: ${reason} No model changes were made.`, [], { workflow_id: "query.blocked", status: "failed" }) };
  }
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
    if (next.status === "blocked") return response(`I found multiple candidates for ${state.task.subject.identifiers[0]?.value ?? "that identifier"}; I did not guess or broaden the search. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "ambiguous" });
    return response(`I did not find an exact match for ${state.task.subject.identifiers[0]?.value ?? "that identifier"} in the requested category and scope. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "not_found" });
  }
  if (state.workflow_id === "query.exact_identifier" && state.stage === 1) {
    const result = matchingResult(req, "aec-query-exact-context") ?? matchingResult(req, "aec-query-exact-scope");
    if (!result) return null;
    if (state.task.operation === "focus") {
      if (result.status !== "done") {
        states.delete(key(req));
        return response(`I found the exact identifier but could not resolve a safe view for focus: ${result.error || "the context query failed"}. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "failed" });
      }
      const context = resultPayload(result) ?? {};
      const candidate = state.evidence.candidate && typeof state.evidence.candidate === "object" ? state.evidence.candidate as Record<string, unknown> : {};
      const elementId = context.elementId ?? candidate.id;
      const bestView = context.bestView && typeof context.bestView === "object" && !Array.isArray(context.bestView) ? context.bestView as Record<string, unknown> : {};
      if (!Number.isSafeInteger(elementId) || (elementId as number) <= 0 || !Number.isSafeInteger(bestView.id) || (bestView.id as number) <= 0) {
        states.delete(key(req));
        return response("I found the element but no exact graphical view could be resolved, so I did not guess or change the active view. No model changes were made.", [], { workflow_id: state.workflow_id, status: "failed" });
      }
      states.set(key(req), { ...state, stage: 2, evidence: { ...state.evidence, context }, expires_at: Date.now() + TTL_MS });
      return response("I found the exact element and its best graphical view; I’m focusing that element now.", [{ action_id: "aec-query-exact-focus", method: "POST", path: "/revit/activate-view", body: { viewId: bestView.id, showElementIds: [elementId] } }]);
    }
    states.delete(key(req));
    return exactCompletion(state.task, state, result);
  }
  if (state.workflow_id === "query.exact_identifier" && state.stage === 2) {
    const result = matchingResult(req, "aec-query-exact-focus");
    if (!result) return null;
    states.delete(key(req));
    if (result.status !== "done") return response(`I found the exact element but could not focus its view: ${result.error || "view activation failed"}. No model elements were changed.`, [], { workflow_id: state.workflow_id, status: "failed" });
    const payload = resultPayload(result) ?? {};
    const identifier = state.task.subject.identifiers[0]?.value ?? "The element";
    const activeView = textValue(payload.activeViewName) ?? (textValue(payload.activeViewId) ? `view ${textValue(payload.activeViewId)}` : "the resolved view");
    return response(`Focused ${identifier} in ${activeView}. No model elements were changed.`, [], { workflow_id: state.workflow_id, status: "found" });
  }
  if (state.workflow_id !== "query.exact_identifier" && state.stage === 1) {
    const result = matchingResult(req, "aec-query-scoped-summaries");
    if (!result) return null;
    states.delete(key(req));
    if (result.status !== "done") return response(`The bounded ${state.task.operation} query found matching IDs, but their compact summaries could not be read: ${result.error || "the summary action failed"}. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "failed" });
    const count = Number.isSafeInteger(state.evidence.result_count) ? state.evidence.result_count as number : resultArray(result.result_json).length;
    const synthetic: ToolResult = {
      ...result,
      result_json: { count, truncated: state.evidence.result_truncated === true, items: resultArray(result.result_json) }
    };
    return completeSingleAction(state.task, state.workflow_id, synthetic);
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
  if (result.status === "done" && ["list", "inspect", "locate"].includes(state.task.operation) && state.task.execution.max_primary_actions >= 2) {
    const payload = resultPayload(result);
    const ids = boundedElementIds(payload, state.task.execution.max_results);
    if (ids.length > 0 && resultItems(payload).length === 0) {
      states.set(key(req), {
        ...state,
        stage: 1,
        evidence: { ...state.evidence, result_count: countFromPayload(payload) ?? ids.length, result_truncated: payload?.truncated === true },
        expires_at: Date.now() + TTL_MS
      });
      return response("I found the bounded IDs and am reading compact summaries only for those matches.", [{ action_id: "aec-query-scoped-summaries", method: "POST", path: "/revit/get-element-summary", body: { elementIds: ids } }]);
    }
  }
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
