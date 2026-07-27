import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { interpretScheduleCellUpdateIntent, parseGroupedScheduleBulkClarification, type ScheduleCellUpdateIntentInterpreter, type ScheduleCellUpdateIntentV1 } from "../schedule_cell_update_intent.js";

type State = { intent: ScheduleCellUpdateIntentV1; stage: "preflight" | "apply"; expected_guard?: string; expires_at: number };
const states = new Map<string, State>();
const TTL_MS = 5 * 60_000;

function purge(): void { const now = Date.now(); for (const [key, state] of states) if (state.expires_at <= now) states.delete(key); }
function payload(result: ToolResult | undefined): Record<string, unknown> | null { const value = result?.result_json; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function result(req: ChatRequest, actionId: string): ToolResult | undefined {
  return req.tool_results?.find(item => item.action_id === actionId && item.method === "POST" && item.path === "/revit/update-schedule-cell");
}
function response(message: string, actions: ActionCall[] = [], status?: "complete" | "blocked" | "failed"): ChatResponse {
  return {
    version: "operator.backend.v1",
    assistant_message: message,
    actions,
    ...(status ? { schedule_update_receipt: { schema: "revit-operator.schedule-update-receipt.v1" as const, terminal: true as const, status, bounded: true as const, verified: status === "complete" } } : {})
  };
}
function body(intent: ScheduleCellUpdateIntentV1, apply: boolean, expectedGuard?: string): Record<string, unknown> {
  return {
    ...(intent.schedule_name ? { scheduleQuery: intent.schedule_name, scheduleExact: true } : {}),
    rowKey: intent.row_key,
    ...(intent.row_field ? { rowField: intent.row_field } : {}),
    targetField: intent.target_field,
    ...(expectedGuard || intent.expected_value ? { expectedValue: expectedGuard || intent.expected_value } : {}),
    value: intent.value,
    apply,
    dryRun: !apply
  };
}
function action(id: string, intent: ScheduleCellUpdateIntentV1, apply: boolean, expectedGuard?: string): ActionCall {
  return { action_id: id, method: "POST", path: "/revit/update-schedule-cell", body: body(intent, apply, expectedGuard) };
}
function blockedReason(value: Record<string, unknown> | null, fallback: string): string {
  const reason = typeof value?.blockedReason === "string" && value.blockedReason.trim() ? value.blockedReason.trim() : fallback;
  const question = typeof value?.clarificationQuestion === "string" && value.clarificationQuestion.trim()
    ? value.clarificationQuestion.trim()
    : "";
  return question ? `${reason} ${question}` : reason;
}
function displayValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.display === "string" && record.display.trim() ? record.display.trim() : typeof record.raw === "string" && record.raw.trim() ? record.raw.trim() : null;
}

export async function maybeRunDeterministicScheduleCellUpdate(req: ChatRequest, interpreter?: ScheduleCellUpdateIntentInterpreter): Promise<ChatResponse | null> {
  purge();
  const key = req.session_id;
  const state = states.get(key);
  if (state && (req.tool_results?.length ?? 0) > 0) {
    if (state.stage === "preflight") {
      const preflight = result(req, "schedule-cell-update-preflight");
      if (!preflight) {
        states.delete(key);
        return response("The schedule-update preflight returned an unexpected continuation, so I stopped instead of broadening or guessing. No model changes were made.", [], "failed");
      }
      if (preflight.status !== "done") {
        states.delete(key);
        return response(`I could not preflight the schedule update: ${preflight.error || "the native schedule resolver failed"}. No model changes were made.`, [], "failed");
      }
      const data = payload(preflight);
      if (data?.status !== "Dry Run" || data.applied !== false || !data.candidate) {
        states.delete(key);
        return response(`${blockedReason(data, "The schedule row or field did not resolve uniquely.")} No model changes were made.`, [], "blocked");
      }
      const observedGuard = displayValue(data.before);
      if (!observedGuard) {
        states.delete(key);
        return response("The schedule row resolved, but the native preflight did not return its current displayed value. I stopped because the apply could not be guarded against a stale change. No model changes were made.", [], "failed");
      }
      states.set(key, { ...state, stage: "apply", expected_guard: observedGuard, expires_at: Date.now() + TTL_MS });
      return response(`I resolved ${state.intent.row_key} to one editable '${state.intent.target_field}' schedule field and the old-value check passed. I’m applying the bounded update now.`, [action("schedule-cell-update-apply", state.intent, true, observedGuard)]);
    }

    const applied = result(req, "schedule-cell-update-apply");
    if (!applied) {
      states.delete(key);
      return response("The schedule-update apply step returned an unexpected continuation, so I stopped instead of broadening, replaying, or guessing.", [], "failed");
    }
    states.delete(key);
    if (applied.status !== "done") return response(`The schedule update did not complete: ${applied.error || "the native write failed"}.`, [], "failed");
    const data = payload(applied);
    if (data?.status !== "Applied and Verified" || data.applied !== true || data.verified !== true || data.verificationFailedCount !== 0) {
      return response(`${blockedReason(data, "The schedule write did not produce a verified committed value.")} I am not claiming the schedule was updated.`, [], "failed");
    }
    const observed = displayValue(data.after) ?? state.intent.value;
    return response(`Updated ${state.intent.row_key} — ${state.intent.target_field} to ${observed} and verified the committed schedule-backed parameter readback.`, [], "complete");
  }

  if ((req.tool_results?.length ?? 0) > 0) {
    const orphaned = req.tool_results?.some(item =>
      ["schedule-cell-update-preflight", "schedule-cell-update-apply"].includes(item.action_id) &&
      item.method === "POST" && item.path === "/revit/update-schedule-cell");
    return orphaned
      ? response("The bounded schedule-update continuation state expired or was lost, so I stopped instead of replaying or guessing. Submit the original request again to run a fresh preflight. No additional model changes were made.", [], "failed")
      : null;
  }
  const authoritativeText = (() => {
    const context = req.context && typeof req.context === "object" && !Array.isArray(req.context) ? req.context as Record<string, unknown> : null;
    const ui = context?.ui && typeof context.ui === "object" && !Array.isArray(context.ui) ? context.ui as Record<string, unknown> : null;
    return typeof ui?.authoritative_user_text === "string" && ui.authoritative_user_text.trim()
      ? ui.authoritative_user_text.trim()
      : (req.user_text ?? "").trim();
  })();
  const grouped = parseGroupedScheduleBulkClarification(authoritativeText);
  if (grouped) {
    return response(
      `The ${grouped.schedule_name} request sounds like a grouped-row bulk edit: change mixed ${grouped.target_field} to ${grouped.value}. That could update many backing model elements. Which scope do you want—one exact device or room, a selected set, or every device in the schedule? No model changes were made.`,
      [],
      "blocked"
    );
  }
  const intent = await interpretScheduleCellUpdateIntent(req, interpreter);
  if (!intent) return null;
  if (intent.confidence.ambiguity === "material" || intent.confidence.value < 0.8) {
    return response("I can update an existing schedule row, but I need one exact row identifier, one target column, and the requested new value. No model changes were made.", [], "blocked");
  }
  states.set(key, { intent, stage: "preflight", expires_at: Date.now() + TTL_MS });
  return response(`I’m resolving ${intent.row_key} and '${intent.target_field}' against itemized Revit schedules, including the backing parameter and current displayed value, before changing anything.`, [action("schedule-cell-update-preflight", intent, false)]);
}

export function __testOnlyClearScheduleCellUpdateStates(): void { states.clear(); }
