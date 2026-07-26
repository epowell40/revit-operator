import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { interpretScheduleValueReplacementIntent, type ScheduleValueReplacementIntentInterpreter, type ScheduleValueReplacementIntentV1 } from "../schedule_value_replacement_intent.js";

type State = {
  intent: ScheduleValueReplacementIntentV1;
  stage: "schedule_discovery" | "preflight" | "apply";
  schedule_ids?: number[];
  schedule_labels?: string[];
  plan_hash?: string;
  planned_count?: number;
  expires_at: number;
};
const states = new Map<string, State>();
const TTL_MS = 10 * 60_000;

function purge(): void { const now = Date.now(); for (const [key, state] of states) if (state.expires_at <= now) states.delete(key); }
function payload(result: ToolResult | undefined): Record<string, unknown> | null { const value = result?.result_json; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function matchingResult(req: ChatRequest, actionId: string, path: string): ToolResult | undefined {
  return req.tool_results?.find(item => item.action_id === actionId && item.method === "POST" && item.path === path);
}
function replacementResult(req: ChatRequest, actionId: string): ToolResult | undefined {
  return matchingResult(req, actionId, "/revit/replace-schedule-values");
}
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

function body(intent: ScheduleValueReplacementIntentV1, apply: boolean, planHash?: string, scheduleIds?: number[]): Record<string, unknown> {
  return {
    ...(scheduleIds?.length ? { scheduleIds } : { sheetNumbers: intent.sheet_numbers }),
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

function replacementAction(id: string, state: State, apply: boolean, planHash?: string): ActionCall {
  return { action_id: id, method: "POST", path: "/revit/replace-schedule-values", body: body(state.intent, apply, planHash, state.schedule_ids) };
}

function scheduleDiscoveryAction(intent: ScheduleValueReplacementIntentV1): ActionCall {
  return {
    action_id: "schedule-value-replacement-schedule-discovery",
    method: "POST",
    path: "/revit/schedules",
    body: { action: "list", query: intent.schedule_query, exact: false, max: 201 }
  };
}

function scopeLabel(state: State): string {
  if (state.schedule_labels?.length) return `schedule${state.schedule_labels.length === 1 ? "" : "s"} ${state.schedule_labels.join(", ")}`;
  return `schedules placed on ${state.intent.sheet_numbers.join(", ")}`;
}

function objectRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>
    : [];
}

function uniqueText(values: unknown[]): string[] {
  return [...new Set(values.map(text).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function scopeEvidenceSummary(value: unknown): string {
  const rows = objectRows(value);
  const categories = uniqueText(rows.map(row => row.category));
  const families = uniqueText(rows.map(row => row.familyName));
  const parameters = uniqueText(rows.map(row => row.parameterName));
  const sheets = uniqueText(rows.flatMap(row => objectRows(row.schedules).map(schedule => schedule.sheetNumber)));
  const parts = [
    categories.length ? `Category${categories.length === 1 ? "" : "ies"}: ${categories.join(", ")}` : "",
    families.length ? `Famil${families.length === 1 ? "y" : "ies"}: ${families.join(", ")}` : "",
    parameters.length ? `Parameter${parameters.length === 1 ? "" : "s"}: ${parameters.join(", ")}` : "",
    `Affected schedule sheets: ${sheets.length ? sheets.join(", ") : "none reported"}`
  ].filter(Boolean);
  return parts.join(". ") + ".";
}

function resolvedSchedules(data: Record<string, unknown> | null, intent: ScheduleValueReplacementIntentV1): Array<{ id: number; name: string }> {
  const terms = intent.schedule_name_all_terms.map(term => term.toLocaleLowerCase());
  return objectRows(data?.items)
    .map(item => ({ id: count(item.id), name: text(item.name) }))
    .filter(item => item.id > 0 && item.name && terms.every(term => item.name.toLocaleLowerCase().includes(term)));
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
    if (state.stage === "schedule_discovery") {
      const discovery = matchingResult(req, "schedule-value-replacement-schedule-discovery", "/revit/schedules");
      if (!discovery) {
        states.delete(key);
        return response("The schedule discovery step returned an unexpected continuation, so I stopped without broadening or guessing. No model changes were made.", [], "failed");
      }
      if (discovery.status !== "done") {
        states.delete(key);
        return response(`The schedule discovery step failed: ${discovery.error || "the native schedule list failed"}. No model changes were made.`, [], "failed");
      }
      const data = payload(discovery);
      const rawItems = objectRows(data?.items);
      if (data?.status !== "Ok" || rawItems.length > 200) {
        states.delete(key);
        return response("The bounded schedule discovery did not return a complete result within the 200-schedule safety limit. No model changes were made.", [], "blocked");
      }
      const schedules = resolvedSchedules(data, state.intent);
      if (schedules.length === 0) {
        states.delete(key);
        return response(`No schedule name matched every required term (${state.intent.schedule_name_all_terms.join(", ")}), so I stopped instead of broadening to unrelated equipment schedules. No model changes were made.`, [], "blocked");
      }
      const next = {
        ...state,
        stage: "preflight" as const,
        schedule_ids: schedules.map(schedule => schedule.id),
        schedule_labels: schedules.map(schedule => schedule.name),
        expires_at: Date.now() + TTL_MS
      };
      states.set(key, next);
      return response(`I resolved ${scopeLabel(next)} and am inspecting only its exact ${state.intent.field_names.join("/")} values containing '${state.intent.find}'.`, [replacementAction("schedule-value-replacement-preflight", next, false)]);
    }

    if (state.stage === "preflight") {
      const preflight = replacementResult(req, "schedule-value-replacement-preflight");
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
        return response(`I inspected ${scopeLabel(state)} and found no exact '${state.intent.find}' matches in ${state.intent.field_names.join("/")} fields. No model changes were made.`, [], "complete");
      }
      if (data?.status !== "Dry Run" || data.applied !== false) {
        states.delete(key);
        return response(`${text(data?.blockedReason) || "The schedule-scoped replacement plan could not be resolved safely."} No model changes were made.`, [], "blocked");
      }
      const planHash = text(data.planHash);
      const writable = count(data.writableCandidateCount);
      if (!/^[0-9a-f]{64}$/i.test(planHash) || writable === 0) {
        states.delete(key);
        return response(`${text(data.blockedReason) || "No writable host-model instance designation matched the exact schedule-scoped plan."} No model changes were made.`, [], "blocked");
      }
      if (state.intent.max_changes && writable > state.intent.max_changes) {
        states.delete(key);
        return response(`The safe test permits ${state.intent.max_changes} change, but ${writable} writable matches resolved. I stopped without changing the model.`, [], "blocked");
      }
      states.set(key, { ...state, stage: "apply", plan_hash: planHash, planned_count: writable, expires_at: Date.now() + TTL_MS });
      return response(`I resolved ${writable} exact writable schedule-backed designation value${writable === 1 ? "" : "s"} in ${scopeLabel(state)} and bound the apply step to plan ${planHash.slice(0, 12)}. Applying and verifying now.`, [replacementAction("schedule-value-replacement-apply", state, true, planHash)]);
    }

    const applied = replacementResult(req, "schedule-value-replacement-apply");
    states.delete(key);
    if (!applied) return response("The schedule replacement apply step returned an unexpected continuation, so I stopped instead of replaying it.", [], "failed");
    if (applied.status !== "done") return response(`The schedule replacement did not complete: ${applied.error || "the native write failed"}.`, [], "failed");
    const data = payload(applied);
    const changed = count(data?.changedCount);
    const remaining = count(data?.remainingMatchCount);
    const failures = count(data?.verificationFailedCount);
    const summary = changeSummary(data?.changed);
    const scopeEvidence = scopeEvidenceSummary(data?.changed);
    if (data?.status === "Applied and Verified" && data.applied === true && data.verified === true && data.complete === true && failures === 0 && remaining === 0 && changed === state.planned_count) {
      return response(`Updated and verified ${changed} schedule-backed designation value${changed === 1 ? "" : "s"} in ${scopeLabel(state)}. ${scopeEvidence} ${summary || "Exact element, parameter, old, and new values are in the action receipt."} Remaining '${state.intent.find}' matches: 0. The handler did not save or synchronize the model.`, [], "complete");
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
    return response("I can perform the schedule-backed replacement, but I need explicit sheet numbers or an exact schedule class, the schedule field concept, and the exact literal find/replace pair. For a one-item test I also need the exact current designation. No model changes were made.", [], "blocked");
  }
  if (intent.schedule_query) {
    states.set(key, { intent, stage: "schedule_discovery", expires_at: Date.now() + TTL_MS });
    return response(`I’m resolving only schedule names containing '${intent.schedule_query}' and every required term (${intent.schedule_name_all_terms.join(", ")}) before inspecting any values.`, [scheduleDiscoveryAction(intent)]);
  }
  const initial: State = { intent, stage: "preflight", expires_at: Date.now() + TTL_MS };
  states.set(key, initial);
  return response(`I’m inspecting only ${scopeLabel(initial)} for exact ${intent.field_names.join("/")} values containing '${intent.find}', then I’ll bind any writable instance replacements to a dry-run plan hash before applying.`, [replacementAction("schedule-value-replacement-preflight", initial, false)]);
}

export function __testOnlyClearScheduleValueReplacementStates(): void { states.clear(); }
