import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { interpretScheduleValueReplacementIntent, type ScheduleValueReplacementIntentInterpreter, type ScheduleValueReplacementIntentV1 } from "../schedule_value_replacement_intent.js";

type State = { intent: ScheduleValueReplacementIntentV1; stage: "preflight" | "apply"; plan_hash?: string; planned_count?: number; expires_at: number };
const states = new Map<string, State>();
const TTL_MS = 10 * 60_000;

function purge(): void { const now = Date.now(); for (const [key, state] of states) if (state.expires_at <= now) states.delete(key); }
function payload(result: ToolResult | undefined): Record<string, unknown> | null { const value = result?.result_json; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function result(req: ChatRequest, actionId: string): ToolResult | undefined { return req.tool_results?.find(item => item.action_id === actionId && item.method === "POST" && item.path === "/revit/replace-schedule-values"); }
function count(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function response(message: string, actions: ActionCall[] = [], status?: "complete" | "blocked" | "failed"): ChatResponse {
  return {
    version: "operator.backend.v1",
    assistant_message: message,
    actions,
    ...(status ? { schedule_update_receipt: { schema: "revit-operator.schedule-update-receipt.v1" as const, terminal: true as const, status, bounded: true as const, verified: status === "complete" } } : {})
  };
}

function body(intent: ScheduleValueReplacementIntentV1, apply: boolean, planHash?: string): Record<string, unknown> {
  return {
    sheetNumbers: intent.sheet_numbers,
    fieldNames: intent.field_names,
    valueContains: intent.find,
    ...(intent.expected_value ? { expectedValue: intent.expected_value } : {}),
    replaceFrom: intent.find,
    replaceTo: intent.replace,
    ...(intent.max_changes ? { maxChanges: intent.max_changes } : {}),
    ...(planHash ? { expectedPlanHash: planHash } : {}),
    apply,
    dryRun: !apply,
    maxSchedules: 200,
    maxCandidates: 5000
  };
}

function action(id: string, intent: ScheduleValueReplacementIntentV1, apply: boolean, planHash?: string): ActionCall {
  return { action_id: id, method: "POST", path: "/revit/replace-schedule-values", body: body(intent, apply, planHash) };
}

function changeSummary(value: unknown, limit = 25): string {
  if (!Array.isArray(value)) return "";
  const rows = value.slice(0, limit).map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const row = item as Record<string, unknown>;
    const id = count(row.elementId || row.sourceElementId);
    return id && text(row.parameterName) ? `${id} ${text(row.parameterName)}: ${text(row.before)} -> ${text(row.after)}` : "";
  }).filter(Boolean);
  return rows.join("; ") + (value.length > limit ? `; plus ${value.length - limit} more in the action receipt` : "");
}

export async function maybeRunDeterministicScheduleValueReplacement(req: ChatRequest, interpreter?: ScheduleValueReplacementIntentInterpreter): Promise<ChatResponse | null> {
  purge();
  const key = req.session_id;
  const state = states.get(key);
  if (state && (req.tool_results?.length ?? 0) > 0) {
    if (state.stage === "preflight") {
      const preflight = result(req, "schedule-value-replacement-preflight");
      if (!preflight) {
        states.delete(key);
        return response("The schedule replacement preflight returned an unexpected continuation, so I stopped without broadening or guessing. No model changes were made.", [], "failed");
      }
      if (preflight.status !== "done") {
        states.delete(key);
        return response(`The schedule replacement preflight failed: ${preflight.error || "the native resolver failed"}. No model changes were made.`, [], "failed");
      }
      const data = payload(preflight);
      if (data?.status === "No Matches" && data.verified === true && count(data.remainingMatchCount) === 0) {
        states.delete(key);
        return response(`I inspected the schedules placed on ${state.intent.sheet_numbers.join(", ")} and found no exact '${state.intent.find}' matches in ${state.intent.field_names.join("/")} fields. No model changes were made.`, [], "complete");
      }
      if (data?.status !== "Dry Run" || data.applied !== false) {
        states.delete(key);
        return response(`${text(data?.blockedReason) || "The sheet-scoped replacement plan could not be resolved safely."} No model changes were made.`, [], "blocked");
      }
      const planHash = text(data.planHash);
      const writable = count(data.writableCandidateCount);
      if (!/^[0-9a-f]{64}$/i.test(planHash) || writable === 0) {
        states.delete(key);
        return response(`${text(data.blockedReason) || "No writable host-model instance designation matched the exact sheet-scoped plan."} No model changes were made.`, [], "blocked");
      }
      if (state.intent.max_changes && writable > state.intent.max_changes) {
        states.delete(key);
        return response(`The safe test permits ${state.intent.max_changes} change, but ${writable} writable matches resolved. I stopped without changing the model.`, [], "blocked");
      }
      states.set(key, { ...state, stage: "apply", plan_hash: planHash, planned_count: writable, expires_at: Date.now() + TTL_MS });
      return response(`I resolved ${writable} exact writable schedule-backed designation value${writable === 1 ? "" : "s"} on ${state.intent.sheet_numbers.join(", ")} and bound the apply step to plan ${planHash.slice(0, 12)}. Applying and verifying now.`, [action("schedule-value-replacement-apply", state.intent, true, planHash)]);
    }

    const applied = result(req, "schedule-value-replacement-apply");
    states.delete(key);
    if (!applied) return response("The schedule replacement apply step returned an unexpected continuation, so I stopped instead of replaying it.", [], "failed");
    if (applied.status !== "done") return response(`The schedule replacement did not complete: ${applied.error || "the native write failed"}.`, [], "failed");
    const data = payload(applied);
    const changed = count(data?.changedCount);
    const remaining = count(data?.remainingMatchCount);
    const failures = count(data?.verificationFailedCount);
    const summary = changeSummary(data?.changed);
    if (data?.status === "Applied and Verified" && data.applied === true && data.verified === true && data.complete === true && failures === 0 && remaining === 0 && changed === state.planned_count) {
      return response(`Updated and verified ${changed} schedule-backed designation value${changed === 1 ? "" : "s"} on ${state.intent.sheet_numbers.join(", ")}. ${summary || "Exact element, parameter, old, and new values are in the action receipt."} Remaining '${state.intent.find}' matches: 0. The handler did not save or synchronize the model.`, [], "complete");
    }
    if (data?.applied === true && data.verified === true) {
      return response(`Applied and verified ${changed} writable replacement${changed === 1 ? "" : "s"}, but ${remaining} matching schedule-backed value${remaining === 1 ? " remains" : "s remain"} unresolved. ${summary} The exact unresolved elements and reasons are in the action receipt; the handler did not save or synchronize the model.`, [], "failed");
    }
    return response(`${text(data?.blockedReason) || "The atomic schedule replacement did not produce a complete verified result."} I am not claiming completion.`, [], "failed");
  }

  if ((req.tool_results?.length ?? 0) > 0) {
    const orphaned = req.tool_results?.some(item => ["schedule-value-replacement-preflight", "schedule-value-replacement-apply"].includes(item.action_id) && item.path === "/revit/replace-schedule-values");
    return orphaned ? response("The bounded schedule-replacement continuation state expired or was lost, so I stopped instead of replaying a write. Submit the original request again for a fresh plan. No additional model changes were made.", [], "failed") : null;
  }

  const intent = await interpretScheduleValueReplacementIntent(req, interpreter);
  if (!intent) return null;
  if (intent.confidence.ambiguity === "material" || intent.confidence.value < 0.8) {
    return response("I can perform the schedule-backed replacement, but I need explicit sheet numbers, the schedule field concept, and the exact literal find/replace pair. For a one-item test I also need the exact current designation. No model changes were made.", [], "blocked");
  }
  states.set(key, { intent, stage: "preflight", expires_at: Date.now() + TTL_MS });
  return response(`I’m inspecting only schedules placed on ${intent.sheet_numbers.join(", ")} for exact ${intent.field_names.join("/")} values containing '${intent.find}', then I’ll bind any writable instance replacements to a dry-run plan hash before applying.`, [action("schedule-value-replacement-preflight", intent, false)]);
}

export function __testOnlyClearScheduleValueReplacementStates(): void { states.clear(); }
