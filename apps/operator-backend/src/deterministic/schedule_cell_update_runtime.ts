import { randomUUID } from "node:crypto";
import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { persistence, type MutationContinuationRecord } from "../persistence/persistence_manager.js";
import { interpretScheduleCellUpdateIntent, normalizeScheduleCellUpdateIntent, parseGroupedScheduleBulkClarification, type ScheduleCellUpdateIntentInterpreter, type ScheduleCellUpdateIntentV1 } from "../schedule_cell_update_intent.js";

type ActiveState = {
  intent: ScheduleCellUpdateIntentV1;
  stage: "preflight" | "apply";
  expected_guard?: string;
  expires_at: number;
  preflight_action_id: string;
  apply_action_id: string;
};
type QuarantinedState = { stage: "quarantined"; expires_at: number; terminal_reason: string };
type State = ActiveState | QuarantinedState;
export type ScheduleCellUpdateContinuationStore = {
  writeMutationContinuation<T>(args: { sessionId: string; operationId: string; kind: string; expiresAt: number; state: T }): void;
  createMutationContinuation<T>(args: { sessionId: string; operationId: string; kind: string; expiresAt: number; state: T }): boolean;
  replaceMutationContinuation<T>(args: { sessionId: string; operationId: string; kind: string; expiresAt: number; expectedRevision: number; state: T }): boolean;
  readMutationContinuation<T>(args: { sessionId: string; operationId: string }): MutationContinuationRecord<T> | null;
  deleteMutationContinuation(args: { sessionId: string; operationId: string; expectedRevision?: number }): boolean;
  quarantineMalformedMutationContinuation<T>(args: { sessionId: string; operationId: string; kind: string; expiresAt: number; state: T }): boolean;
};
const TTL_MS = 5 * 60_000;
const OPERATION_ID = "schedule-cell-update";
const CONTINUATION_KIND = "revit.schedule-cell-update";
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

type LoadedState = { state: ActiveState | null; revision: number | null; problem: "expired" | "invalid" | "quarantined" | null };

function stateLooksValid(value: unknown): value is State {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<State>;
  if (state.stage === "quarantined") {
    return typeof state.expires_at === "number" && Number.isFinite(state.expires_at) && typeof state.terminal_reason === "string" && Boolean(state.terminal_reason.trim());
  }
  if (state.stage !== "preflight" && state.stage !== "apply") return false;
  if (typeof state.expires_at !== "number" || !Number.isFinite(state.expires_at)) return false;
  if (typeof state.preflight_action_id !== "string" || !state.preflight_action_id.trim() || typeof state.apply_action_id !== "string" || !state.apply_action_id.trim() || state.preflight_action_id === state.apply_action_id) return false;
  if (state.stage === "apply" && (typeof state.expected_guard !== "string" || !state.expected_guard.trim())) return false;
  const intent = state.intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return false;
  const evidence = intent.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || typeof evidence.user_text !== "string") return false;
  try {
    normalizeScheduleCellUpdateIntent(intent, evidence.user_text);
    return true;
  } catch {
    return false;
  }
}
const testSessionIds = new Set<string>();

function newActionId(stage: "preflight" | "apply"): string {
  return `schedule-cell-update-${stage}-${randomUUID()}`;
}

function isScheduleUpdateActionId(value: string): boolean {
  return value === "schedule-cell-update-preflight" || value === "schedule-cell-update-apply" || /^schedule-cell-update-(preflight|apply)-[0-9a-f-]+$/i.test(value);
}

function retireState(sessionId: string, revision: number, store: ScheduleCellUpdateContinuationStore, reason: string): boolean {
  try {
    const deleted = store.deleteMutationContinuation({ sessionId, operationId: OPERATION_ID, expectedRevision: revision });
    if (deleted) {
      testSessionIds.delete(sessionId);
      return true;
    }
    return false;
  } catch {
    // A failed delete is converted into a terminal tombstone when the store still permits a CAS write.
  }
  try {
    store.replaceMutationContinuation({
      sessionId,
      operationId: OPERATION_ID,
      kind: CONTINUATION_KIND,
      expiresAt: Date.now() + TTL_MS,
      expectedRevision: revision,
      state: { stage: "quarantined", expires_at: Date.now() + TTL_MS, terminal_reason: reason }
    });
  } catch {
    // Preserve the failed response; replay remains blocked by the action-id and revision guards.
  }
  return false;
}
function quarantineState(sessionId: string, revision: number, store: ScheduleCellUpdateContinuationStore, reason: string): boolean {
  const expiresAt = Date.now() + TTL_MS;
  try {
    return store.replaceMutationContinuation({
      sessionId,
      operationId: OPERATION_ID,
      kind: CONTINUATION_KIND,
      expiresAt,
      expectedRevision: revision,
      state: { stage: "quarantined", expires_at: expiresAt, terminal_reason: reason }
    });
  } catch {
    return false;
  }
}

function quarantineMalformedState(sessionId: string, store: ScheduleCellUpdateContinuationStore, reason: string): boolean {
  const expiresAt = Date.now() + TTL_MS;
  try {
    return store.quarantineMalformedMutationContinuation({
      sessionId,
      operationId: OPERATION_ID,
      kind: CONTINUATION_KIND,
      expiresAt,
      state: { stage: "quarantined", expires_at: expiresAt, terminal_reason: reason }
    });
  } catch {
    return false;
  }
}


function terminalResponse(sessionId: string, revision: number, store: ScheduleCellUpdateContinuationStore, message: string, status: "complete" | "blocked" | "failed", reason: string): ChatResponse {
  if (!retireState(sessionId, revision, store, reason)) return response("I stopped safely, but could not retire the schedule continuation record. No model changes were made; inspect the stored continuation before retrying.", [], "failed");
  return response(message, [], status);
}
function nonTerminalResponse(message: string): ChatResponse {
  return response(message + " This response is non-terminal; the active continuation remains guarded for its expected result.", []);
}


function loadState(sessionId: string, store: ScheduleCellUpdateContinuationStore): LoadedState {
  try {
    const record = store.readMutationContinuation<State>({ sessionId, operationId: OPERATION_ID });
    if (!record) return { state: null, revision: null, problem: null };
    const stateValid = stateLooksValid(record.state);
    const expired = record.expires_at <= Date.now() || (stateValid && record.state.expires_at <= Date.now());
    if (record.kind !== CONTINUATION_KIND || expired || !stateValid) {
      if (expired && record.kind === CONTINUATION_KIND && stateValid) {
        retireState(sessionId, record.revision, store, "expired continuation");
        return { state: null, revision: record.revision, problem: "expired" };
      }
      const quarantined = quarantineState(sessionId, record.revision, store, "invalid continuation");
      return { state: null, revision: record.revision, problem: quarantined ? "quarantined" : "invalid" };
    }
    if (record.state.stage === "quarantined") return { state: null, revision: record.revision, problem: "quarantined" };
    return { state: record.state, revision: record.revision, problem: null };
  } catch {
    const quarantined = quarantineMalformedState(sessionId, store, "invalid persisted continuation");
    return { state: null, revision: null, problem: quarantined ? "quarantined" : "invalid" };
  }
}

function replaceState(sessionId: string, state: ActiveState, revision: number, store: ScheduleCellUpdateContinuationStore): boolean {
  return store.replaceMutationContinuation({ sessionId, operationId: OPERATION_ID, kind: CONTINUATION_KIND, expiresAt: state.expires_at, expectedRevision: revision, state });
}

function createState(sessionId: string, state: ActiveState, store: ScheduleCellUpdateContinuationStore): boolean {
  testSessionIds.add(sessionId);
  return store.createMutationContinuation({ sessionId, operationId: OPERATION_ID, kind: CONTINUATION_KIND, expiresAt: state.expires_at, state });
}

export async function maybeRunDeterministicScheduleCellUpdate(req: ChatRequest, interpreter?: ScheduleCellUpdateIntentInterpreter, store: ScheduleCellUpdateContinuationStore = persistence): Promise<ChatResponse | null> {
  const loaded = loadState(req.session_id, store);
  const state = loaded.state;
  const revision = loaded.revision;
  const hasToolResults = (req.tool_results?.length ?? 0) > 0;
  if (hasToolResults) {
    if (loaded.problem) {
      const reason = loaded.problem === "expired" ? "expired or was lost" : loaded.problem === "quarantined" ? "quarantined after a cleanup failure" : "invalid or corrupted";
      return response("The bounded schedule-update continuation state was " + reason + ", so I stopped instead of replaying or guessing. Submit the original request again to run a fresh preflight. No additional model changes were made.", [], "failed");
    }
    if (state) {
      if (state.stage === "preflight") {
        const preflight = result(req, state.preflight_action_id);
        if (!preflight) {
          return nonTerminalResponse("The schedule-update preflight returned an unexpected continuation, so I did not accept it or clear the active continuation. No model changes were made.");
        }
        if (preflight.status !== "done") {
          return terminalResponse(req.session_id, revision ?? 0, store, "I could not preflight the schedule update: " + (preflight.error || "the native schedule resolver failed") + ". No model changes were made.", "failed", "preflight failed");
        }
        const data = payload(preflight);
        if (data?.status !== "Dry Run" || data.applied !== false || !data.candidate) {
          return terminalResponse(req.session_id, revision ?? 0, store, blockedReason(data, "The schedule row or field did not resolve uniquely.") + " No model changes were made.", "blocked", "preflight did not resolve one editable candidate");
        }
        const observedGuard = displayValue(data.before);
        if (!observedGuard) {
          return terminalResponse(req.session_id, revision ?? 0, store, "The schedule row resolved, but the native preflight did not return its current displayed value. I stopped because the apply could not be guarded against a stale change. No model changes were made.", "failed", "preflight omitted current displayed value");
        }
        const nextState: ActiveState = { ...state, stage: "apply", expected_guard: observedGuard, expires_at: Date.now() + TTL_MS };
        try {
          if (revision === null || !replaceState(req.session_id, nextState, revision, store)) {
            return response("The schedule preflight continuation changed concurrently, so I stopped before apply. No model changes were made.", [], "failed");
          }
        } catch {
          if (revision !== null && retireState(req.session_id, revision, store, "could not persist guarded apply state")) return response("The schedule preflight succeeded, but I could not durably record its observed old value. I stopped before apply; no model changes were made.", [], "failed");
          return response("The schedule preflight succeeded, but I could not durably record or safely retire its guarded state. I stopped before apply; no model changes were made.", [], "failed");
        }
        return response("I resolved " + state.intent.row_key + " to one editable '" + state.intent.target_field + "' schedule field and the old-value check passed. I’m applying the bounded update now.", [action(state.apply_action_id, state.intent, true, observedGuard)]);
      }

      const applied = result(req, state.apply_action_id);
      if (!applied) {
        return nonTerminalResponse("The schedule-update apply step returned an unexpected continuation, so I did not accept it or clear the active continuation.");
      }
      if (revision === null || !retireState(req.session_id, revision, store, "apply result received")) {
        return response("The schedule update returned, but I could not clear its continuation record. I am not claiming the schedule was updated; inspect the Revit receipt before retrying.", [], "failed");
      }
      if (applied.status !== "done") return response("The schedule update did not complete: " + (applied.error || "the native write failed") + ".", [], "failed");
      const data = payload(applied);
      if (data?.status !== "Applied and Verified" || data.applied !== true || data.verified !== true || data.verificationFailedCount !== 0) {
        return response(blockedReason(data, "The schedule write did not produce a verified committed value.") + " I am not claiming the schedule was updated.", [], "failed");
      }
      const observed = displayValue(data.after) ?? state.intent.value;
      return response("Updated " + state.intent.row_key + " — " + state.intent.target_field + " to " + observed + " and verified the committed schedule-backed parameter readback.", [], "complete");
    }

    const orphaned = req.tool_results?.some(item =>
      isScheduleUpdateActionId(item.action_id) &&
      item.method === "POST" && item.path === "/revit/update-schedule-cell");
    return orphaned
      ? response("The bounded schedule-update continuation state expired or was lost, so I stopped instead of replaying or guessing. Submit the original request again to run a fresh preflight. No additional model changes were made.", [], "failed")
      : null;
  }
  if (loaded.problem) {
    const reason = loaded.problem === "expired" ? "expired or was lost" : loaded.problem === "quarantined" ? "quarantined after a cleanup failure" : "invalid or corrupted";
    return response("The bounded schedule-update continuation state was " + reason + ", so I stopped instead of replacing it. Submit the original request again only after inspecting the continuation record. No model changes were made.", [], "failed");
  }
  if (state) return response("A bounded schedule update is already in progress for this session. I stopped the new request so an older preflight result cannot be applied to a different intent.", [], "blocked");

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
      "The " + grouped.schedule_name + " request sounds like a grouped-row bulk edit: change mixed " + grouped.target_field + " to " + grouped.value + ". That could update many backing model elements. Which scope do you want—one exact device or room, a selected set, or every device in the schedule? No model changes were made.",
      [],
      "blocked"
    );
  }
  const intent = await interpretScheduleCellUpdateIntent(req, interpreter);
  if (!intent) return null;
  if (intent.confidence.ambiguity === "material" || intent.confidence.value < 0.8) {
    return response("I can update an existing schedule row, but I need one exact row identifier, one target column, and the requested new value. No model changes were made.", [], "blocked");
  }
  const nextState: ActiveState = { intent, stage: "preflight", expires_at: Date.now() + TTL_MS, preflight_action_id: newActionId("preflight"), apply_action_id: newActionId("apply") };
  try {
    if (!createState(req.session_id, nextState, store)) return response("A bounded schedule update is already in progress for this session, so I stopped before creating a second continuation. No model changes were made.", [], "blocked");
  } catch {
    return response("I understood the bounded schedule update, but I could not durably record its preflight state. No model changes were made.", [], "failed");
  }
  return response("I’m resolving " + intent.row_key + " and '" + intent.target_field + "' against itemized Revit schedules, including the backing parameter and current displayed value, before changing anything.", [action(nextState.preflight_action_id, intent, false)]);
}

export function __testOnlyClearScheduleCellUpdateStates(): void {
  for (const sessionId of testSessionIds) {
    try {
      persistence.deleteMutationContinuation({ sessionId, operationId: OPERATION_ID });
    } catch {
      // Best-effort cleanup for tests; production paths use the CAS retirement above.
    }
  }
  testSessionIds.clear();
}
