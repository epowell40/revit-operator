import { conditionalActionPathEffect, pathLooksWrite } from "../action_path_mutability.js";
import { compactIncomingToolResult } from "../tool_result_compaction.js";
import type { ActionCall, ToolResult } from "../contracts.js";

const MAX_SESSIONS = 200;
const MAX_ACTIONS_PER_SESSION = 1_000;
const plannedActionsBySession = new Map<string, Map<string, ActionCall>>();

function clipped(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= max ? text : text.slice(0, max);
}

function canonicalPlannedAction(value: unknown): ActionCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const actionId = clipped(row.action_id, 200);
  const method = row.method;
  const actionPath = clipped(row.path, 2_000);
  if (!actionId || (method !== "GET" && method !== "POST") || !actionPath) return null;
  return {
    action_id: actionId,
    method,
    path: actionPath,
    ...(Object.prototype.hasOwnProperty.call(row, "body") ? { body: row.body } : {})
  };
}

export function registerServerPlannedActions(sessionIdValue: unknown, actions: unknown): void {
  const sessionId = clipped(sessionIdValue, 200);
  if (!sessionId || !Array.isArray(actions)) return;
  let sessionActions = plannedActionsBySession.get(sessionId);
  if (!sessionActions) {
    sessionActions = new Map<string, ActionCall>();
    plannedActionsBySession.set(sessionId, sessionActions);
  }
  for (const value of actions) {
    const action = canonicalPlannedAction(value);
    if (!action) continue;
    if (sessionActions.has(action.action_id)) sessionActions.delete(action.action_id);
    sessionActions.set(action.action_id, action);
  }
  while (sessionActions.size > MAX_ACTIONS_PER_SESSION) {
    const oldest = sessionActions.keys().next().value;
    if (typeof oldest !== "string") break;
    sessionActions.delete(oldest);
  }
  if (plannedActionsBySession.has(sessionId)) {
    const current = plannedActionsBySession.get(sessionId)!;
    plannedActionsBySession.delete(sessionId);
    plannedActionsBySession.set(sessionId, current);
  }
  while (plannedActionsBySession.size > MAX_SESSIONS) {
    const oldest = plannedActionsBySession.keys().next().value;
    if (typeof oldest !== "string") break;
    plannedActionsBySession.delete(oldest);
  }
}

function plannedRequestEffect(action: ActionCall): NonNullable<ToolResult["request_effect"]> {
  if (action.method === "GET") return "read";
  const conditional = conditionalActionPathEffect(action.path, action.body);
  if (conditional) return conditional;
  return pathLooksWrite(action.path, action.body) ? "apply" : "read";
}

function unplannedRequestEffect(method: "GET" | "POST", actionPath: string): NonNullable<ToolResult["request_effect"]> {
  if (method === "GET") return "read";
  // Conditional POST routes need the server-owned request body to distinguish
  // reads/previews from writes. If that plan was lost after a restart or cache
  // eviction, classify conservatively instead of allowing a bodyless fallback
  // (or client-supplied request_effect) to downgrade a possible mutation.
  const conditional = conditionalActionPathEffect(actionPath);
  // The transaction-plan route is an explicit rollback-only preview invariant.
  if (conditional === "preview") return "preview";
  if (conditional !== undefined) return "apply";
  return pathLooksWrite(actionPath) ? "apply" : "read";
}

export function normalizeIncomingToolResults(input: unknown, sessionIdValue: unknown): ToolResult[] {
  if (!Array.isArray(input)) return [];
  const sessionId = clipped(sessionIdValue, 200);
  const planned = sessionId ? plannedActionsBySession.get(sessionId) : undefined;
  const out: ToolResult[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, any>;
    const actionId = clipped(row.action_id, 200);
    if (!actionId) continue;
    if (row.method !== "GET" && row.method !== "POST") continue;
    if (typeof row.path !== "string" || !row.path.trim()) continue;
    if (row.status !== "done" && row.status !== "failed") continue;

    const serverAction = planned?.get(actionId);
    let method = row.method as "GET" | "POST";
    let actionPath = row.path.trim();
    let requestEffect: ToolResult["request_effect"];
    if (serverAction) {
      if (method !== serverAction.method || actionPath !== serverAction.path) {
        throw new Error(`Tool result transport metadata does not match server-planned action ${actionId}.`);
      }
      method = serverAction.method;
      actionPath = serverAction.path;
      requestEffect = plannedRequestEffect(serverAction);
      if (row.request_effect !== undefined && row.request_effect !== requestEffect) {
        throw new Error(`Tool result request_effect does not match server-planned action ${actionId}.`);
      }
    } else {
      requestEffect = unplannedRequestEffect(method, actionPath);
      if (row.request_effect !== undefined && row.request_effect !== requestEffect) {
        throw new Error(`Tool result request_effect does not match server fail-closed policy for unplanned action ${actionId}.`);
      }
    }

    out.push(compactIncomingToolResult({
      action_id: actionId,
      method,
      path: actionPath,
      ...(requestEffect ? { request_effect: requestEffect } : {}),
      status: row.outcome_unknown === true ? "failed" : row.status,
      ...(row.outcome_unknown === true ? { outcome_unknown: true, retryable: false } : {}),
      ...(row.outcome_unknown !== true && typeof row.retryable === "boolean" ? { retryable: row.retryable } : {}),
      ...(row.result_json !== undefined ? { result_json: row.result_json } : {}),
      ...(typeof row.error === "string" ? { error: row.error } : {}),
      ...(typeof row.failure_kind === "string" ? { failure_kind: row.failure_kind } : {}),
      ...(typeof row.failure_code === "string" ? { failure_code: row.failure_code } : {}),
      ...(typeof row.failure_hint === "string" ? { failure_hint: row.failure_hint } : {}),
      ...(typeof row.duration_ms === "number" ? { duration_ms: row.duration_ms } : {}),
      ...(Array.isArray(row.attachments) ? { attachments: row.attachments } : {})
    }));
  }
  return out;
}

export function __clearServerPlannedActionsForTests(): void {
  plannedActionsBySession.clear();
}
