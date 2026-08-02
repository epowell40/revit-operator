import { randomUUID } from "node:crypto";
import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { persistence, type MutationContinuationRecord } from "../persistence/persistence_manager.js";
import {
  interpretScheduleValueReplacementIntent,
  normalizeScheduleValueReplacementIntent,
  type ScheduleValueReplacementIntentInterpreter,
  type ScheduleValueReplacementIntentV1
} from "../schedule_value_replacement_intent.js";

type ActiveState = {
  intent: ScheduleValueReplacementIntentV1;
  stage: "schedule_discovery" | "preflight" | "apply";
  schedule_ids?: number[];
  schedule_labels?: string[];
  plan_hash?: string;
  planned_count?: number;
  expires_at: number;
  schedule_discovery_action_id: string;
  preflight_action_id: string;
  apply_action_id: string;
};

type QuarantinedState = {
  stage: "quarantined";
  expires_at: number;
  terminal_reason: string;
};

type State = ActiveState | QuarantinedState;

export type ScheduleValueReplacementContinuationStore = {
  createMutationContinuation<T>(args: {
    sessionId: string;
    operationId: string;
    kind: string;
    expiresAt: number;
    state: T;
  }): boolean;
  replaceMutationContinuation<T>(args: {
    sessionId: string;
    operationId: string;
    kind: string;
    expiresAt: number;
    expectedRevision: number;
    state: T;
  }): boolean;
  readMutationContinuation<T>(args: {
    sessionId: string;
    operationId: string;
  }): MutationContinuationRecord<T> | null;
  deleteMutationContinuation(args: {
    sessionId: string;
    operationId: string;
    expectedRevision?: number;
  }): boolean;
  quarantineMalformedMutationContinuation<T>(args: {
    sessionId: string;
    operationId: string;
    kind: string;
    expiresAt: number;
    state: T;
  }): boolean;
};

const TTL_MS = 10 * 60_000;
const OPERATION_ID = "schedule-value-replacement";
const CONTINUATION_KIND = "revit.schedule-value-replacement";
const testSessionIds = new Set<string>();

function payload(result: ToolResult | undefined): Record<string, unknown> | null {
  const value = result?.result_json;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function matchingResult(
  req: ChatRequest,
  actionId: string,
  method: "GET" | "POST",
  path: string
): ToolResult | undefined {
  return req.tool_results?.find(item =>
    item.action_id === actionId &&
    item.method === method &&
    item.path === path
  );
}

function replacementResult(req: ChatRequest, actionId: string): ToolResult | undefined {
  return matchingResult(req, actionId, "POST", "/revit/replace-schedule-values");
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function response(
  message: string,
  actions: ActionCall[] = [],
  status?: "complete" | "blocked" | "failed"
): ChatResponse {
  return {
    version: "operator.backend.v1",
    assistant_message: message,
    actions,
    ...(status
      ? {
          schedule_update_receipt: {
            schema: "revit-operator.schedule-update-receipt.v1" as const,
            terminal: true as const,
            status,
            bounded: true as const,
            verified: status === "complete"
          }
        }
      : {})
  };
}

function body(
  intent: ScheduleValueReplacementIntentV1,
  apply: boolean,
  planHash?: string,
  scheduleIds?: number[]
): Record<string, unknown> {
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

function replacementAction(
  id: string,
  state: ActiveState,
  apply: boolean,
  planHash?: string
): ActionCall {
  return {
    action_id: id,
    method: "POST",
    path: "/revit/replace-schedule-values",
    body: body(state.intent, apply, planHash, state.schedule_ids)
  };
}

function scheduleDiscoveryAction(
  intent: ScheduleValueReplacementIntentV1,
  actionId: string
): ActionCall {
  return {
    action_id: actionId,
    method: "POST",
    path: "/revit/schedules",
    body: { action: "list", query: intent.schedule_query, exact: false, max: 201 }
  };
}

function newActionId(stage: "schedule-discovery" | "preflight" | "apply"): string {
  return "schedule-value-replacement-" + stage + "-" + randomUUID();
}

function scopeLabel(state: ActiveState): string {
  if (state.schedule_labels?.length) {
    return "schedule" + (state.schedule_labels.length === 1 ? "" : "s") + " " + state.schedule_labels.join(", ");
  }
  return "schedules placed on " + state.intent.sheet_numbers.join(", ");
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
    categories.length ? "Category" + (categories.length === 1 ? "" : "ies") + ": " + categories.join(", ") : "",
    families.length ? "Famil" + (families.length === 1 ? "y" : "ies") + ": " + families.join(", ") : "",
    parameters.length ? "Parameter" + (parameters.length === 1 ? "" : "s") + ": " + parameters.join(", ") : "",
    "Affected schedule sheets: " + (sheets.length ? sheets.join(", ") : "none reported")
  ].filter(Boolean);
  return parts.join(". ") + ".";
}

function resolvedSchedules(
  data: Record<string, unknown> | null,
  intent: ScheduleValueReplacementIntentV1
): Array<{ id: number; name: string }> {
  const terms = intent.schedule_name_all_terms.map(term => term.toLocaleLowerCase());
  return objectRows(data?.items)
    .map(item => ({ id: count(item.id), name: text(item.name) }))
    .filter(item =>
      item.id > 0 &&
      item.name &&
      terms.every(term => item.name.toLocaleLowerCase().includes(term))
    );
}

function changeSummary(value: unknown, limit = 25): string {
  if (!Array.isArray(value)) return "";
  const rows = value.slice(0, limit).map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const row = item as Record<string, unknown>;
    const id = count(row.elementId || row.sourceElementId);
    return id && text(row.parameterName)
      ? id + " " + text(row.parameterName) + ": " + text(row.before) + " -> " + text(row.after)
      : "";
  }).filter(Boolean);
  return rows.join("; ") + (value.length > limit ? "; plus " + (value.length - limit) + " more in the action receipt" : "");
}

function stateLooksValid(value: unknown): value is State {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<ActiveState> & Partial<QuarantinedState>;
  if (state.stage === "quarantined") {
    return typeof state.expires_at === "number" &&
      Number.isFinite(state.expires_at) &&
      typeof state.terminal_reason === "string" &&
      Boolean(state.terminal_reason.trim());
  }
  if (state.stage !== "schedule_discovery" && state.stage !== "preflight" && state.stage !== "apply") return false;
  if (typeof state.expires_at !== "number" || !Number.isFinite(state.expires_at)) return false;
  const actionIds = [
    state.schedule_discovery_action_id,
    state.preflight_action_id,
    state.apply_action_id
  ];
  if (
    actionIds.some(actionId => typeof actionId !== "string" || !actionId.trim()) ||
    new Set(actionIds).size !== actionIds.length
  ) return false;
  if (
    state.schedule_ids !== undefined &&
    (!Array.isArray(state.schedule_ids) ||
      state.schedule_ids.length > 200 ||
      state.schedule_ids.some(id => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0))
  ) return false;
  if (
    state.schedule_labels !== undefined &&
    (!Array.isArray(state.schedule_labels) ||
      state.schedule_labels.length > 200 ||
      state.schedule_labels.some(label => typeof label !== "string" || !label.trim()))
  ) return false;
  if (state.plan_hash !== undefined && !/^[0-9a-f]{64}$/i.test(text(state.plan_hash))) return false;
  if (
    state.planned_count !== undefined &&
    (typeof state.planned_count !== "number" || !Number.isSafeInteger(state.planned_count) || state.planned_count < 0)
  ) return false;
  const intent = state.intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return false;
  const evidence = intent.evidence;
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    typeof evidence.user_text !== "string"
  ) return false;
  try {
    normalizeScheduleValueReplacementIntent(intent, evidence.user_text);
    return true;
  } catch {
    return false;
  }
}

type LoadedState = {
  state: ActiveState | null;
  revision: number | null;
  problem: "expired" | "invalid" | "quarantined" | null;
};

function retireState(
  sessionId: string,
  revision: number,
  store: ScheduleValueReplacementContinuationStore,
  reason: string
): boolean {
  try {
    const deleted = store.deleteMutationContinuation({
      sessionId,
      operationId: OPERATION_ID,
      expectedRevision: revision
    });
    if (deleted) {
      testSessionIds.delete(sessionId);
      return true;
    }
    return false;
  } catch {
    // A failed delete is converted into a terminal tombstone when possible.
  }
  try {
    store.replaceMutationContinuation({
      sessionId,
      operationId: OPERATION_ID,
      kind: CONTINUATION_KIND,
      expiresAt: Date.now() + TTL_MS,
      expectedRevision: revision,
      state: {
        stage: "quarantined",
        expires_at: Date.now() + TTL_MS,
        terminal_reason: reason
      }
    });
  } catch {
    // Preserve the failed response; replay remains blocked by correlation guards.
  }
  return false;
}

function quarantineState(
  sessionId: string,
  revision: number,
  store: ScheduleValueReplacementContinuationStore,
  reason: string
): boolean {
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

function quarantineMalformedState(
  sessionId: string,
  store: ScheduleValueReplacementContinuationStore,
  reason: string
): boolean {
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

function terminalResponse(
  sessionId: string,
  revision: number,
  store: ScheduleValueReplacementContinuationStore,
  message: string,
  status: "complete" | "blocked" | "failed",
  reason: string
): ChatResponse {
  if (!retireState(sessionId, revision, store, reason)) {
    return response(
      "I stopped safely, but could not retire the schedule-replacement continuation record. No model changes were made; inspect the stored continuation before retrying.",
      [],
      "failed"
    );
  }
  return response(message, [], status);
}

function nonTerminalResponse(message: string): ChatResponse {
  return response(
    message + " This response is non-terminal; the active continuation remains guarded for its expected result.",
    []
  );
}

function loadState(
  sessionId: string,
  store: ScheduleValueReplacementContinuationStore
): LoadedState {
  try {
    const record = store.readMutationContinuation<State>({
      sessionId,
      operationId: OPERATION_ID
    });
    if (!record) return { state: null, revision: null, problem: null };
    const valid = stateLooksValid(record.state);
    const expired = record.expires_at <= Date.now() || (valid && record.state.expires_at <= Date.now());
    if (record.kind !== CONTINUATION_KIND || expired || !valid) {
      if (expired && record.kind === CONTINUATION_KIND && valid) {
        retireState(sessionId, record.revision, store, "expired continuation");
        return { state: null, revision: record.revision, problem: "expired" };
      }
      const quarantined = quarantineState(sessionId, record.revision, store, "invalid continuation");
      return {
        state: null,
        revision: record.revision,
        problem: quarantined ? "quarantined" : "invalid"
      };
    }
    if (record.state.stage === "quarantined") {
      return { state: null, revision: record.revision, problem: "quarantined" };
    }
    return { state: record.state, revision: record.revision, problem: null };
  } catch {
    const quarantined = quarantineMalformedState(sessionId, store, "invalid persisted continuation");
    return {
      state: null,
      revision: null,
      problem: quarantined ? "quarantined" : "invalid"
    };
  }
}

function replaceState(
  sessionId: string,
  state: ActiveState,
  revision: number,
  store: ScheduleValueReplacementContinuationStore
): boolean {
  return store.replaceMutationContinuation({
    sessionId,
    operationId: OPERATION_ID,
    kind: CONTINUATION_KIND,
    expiresAt: state.expires_at,
    expectedRevision: revision,
    state
  });
}

function createState(
  sessionId: string,
  state: ActiveState,
  store: ScheduleValueReplacementContinuationStore
): boolean {
  testSessionIds.add(sessionId);
  return store.createMutationContinuation({
    sessionId,
    operationId: OPERATION_ID,
    kind: CONTINUATION_KIND,
    expiresAt: state.expires_at,
    state
  });
}

function isScheduleValueReplacementActionId(value: string): boolean {
  return value === "schedule-value-replacement-schedule-discovery" ||
    value === "schedule-value-replacement-preflight" ||
    value === "schedule-value-replacement-apply" ||
    /^schedule-value-replacement-(schedule-discovery|preflight|apply)-[0-9a-f-]+$/i.test(value);
}

function isScheduleValueReplacementToolResult(result: ToolResult): boolean {
  if (result.method !== "POST" || !isScheduleValueReplacementActionId(result.action_id)) return false;
  return result.path === "/revit/schedules" || result.path === "/revit/replace-schedule-values";
}

export async function maybeRunDeterministicScheduleValueReplacement(
  req: ChatRequest,
  interpreter?: ScheduleValueReplacementIntentInterpreter,
  store: ScheduleValueReplacementContinuationStore = persistence
): Promise<ChatResponse | null> {
  const loaded = loadState(req.session_id, store);
  const state = loaded.state;
  const revision = loaded.revision;
  const hasToolResults = (req.tool_results?.length ?? 0) > 0;

  if (hasToolResults) {
    if (loaded.problem) {
      const reason = loaded.problem === "expired"
        ? "expired or was lost"
        : loaded.problem === "quarantined"
          ? "quarantined after a cleanup failure"
          : "invalid or corrupted";
      return response(
        "The bounded schedule-replacement continuation state was " + reason +
          ", so I stopped instead of replaying or guessing. Submit the original request again to run a fresh plan. No additional model changes were made.",
        [],
        "failed"
      );
    }

    if (state) {
      if (state.stage === "schedule_discovery") {
        const discovery = matchingResult(req, state.schedule_discovery_action_id, "POST", "/revit/schedules");
        if (!discovery) {
          return nonTerminalResponse(
            "The schedule discovery step returned an unexpected continuation, so I did not accept it or broaden the schedule scope."
          );
        }
        if (discovery.status !== "done") {
          return terminalResponse(
            req.session_id,
            revision ?? 0,
            store,
            "The schedule discovery step failed: " + (discovery.error || "the native schedule list failed") + ". No model changes were made.",
            "failed",
            "schedule discovery failed"
          );
        }
        const data = payload(discovery);
        const rawItems = objectRows(data?.items);
        if (data?.status !== "Ok" || rawItems.length > 200) {
          return terminalResponse(
            req.session_id,
            revision ?? 0,
            store,
            "The bounded schedule discovery did not return a complete result within the 200-schedule safety limit. No model changes were made.",
            "blocked",
            "schedule discovery exceeded bound"
          );
        }
        const schedules = resolvedSchedules(data, state.intent);
        if (schedules.length === 0) {
          return terminalResponse(
            req.session_id,
            revision ?? 0,
            store,
            "No schedule name matched every required term (" + state.intent.schedule_name_all_terms.join(", ") +
              "), so I stopped instead of broadening to unrelated equipment schedules. No model changes were made.",
            "blocked",
            "no exact schedule name match"
          );
        }
        const next: ActiveState = {
          ...state,
          stage: "preflight",
          schedule_ids: schedules.map(schedule => schedule.id),
          schedule_labels: schedules.map(schedule => schedule.name),
          expires_at: Date.now() + TTL_MS
        };
        try {
          if (revision === null || !replaceState(req.session_id, next, revision, store)) {
            return response(
              "The schedule discovery continuation changed concurrently, so I stopped before inspecting values. No model changes were made.",
              [],
              "failed"
            );
          }
        } catch {
          return response(
            "The schedule discovery succeeded, but I could not durably record its exact schedule scope. I stopped before inspecting values. No model changes were made.",
            [],
            "failed"
          );
        }
        return response(
          "I resolved " + scopeLabel(next) + " and am inspecting only its exact " +
            state.intent.field_names.join("/") + " values containing '" + state.intent.find + "'.",
          [replacementAction(state.preflight_action_id, next, false)]
        );
      }

      if (state.stage === "preflight") {
        const preflight = replacementResult(req, state.preflight_action_id);
        if (!preflight) {
          return nonTerminalResponse(
            "The schedule replacement preflight returned an unexpected continuation, so I did not accept it or clear the active continuation."
          );
        }
        if (preflight.status !== "done") {
          return terminalResponse(
            req.session_id,
            revision ?? 0,
            store,
            "The schedule replacement preflight failed: " + (preflight.error || "the native resolver failed") + ". No model changes were made.",
            "failed",
            "schedule replacement preflight failed"
          );
        }
        const data = payload(preflight);
        if (data?.status === "No Matches" && data.verified === true && count(data.remainingMatchCount) === 0) {
          return terminalResponse(
            req.session_id,
            revision ?? 0,
            store,
            "I inspected " + scopeLabel(state) + " and found no exact '" + state.intent.find +
              "' matches in " + state.intent.field_names.join("/") + " fields. No model changes were made.",
            "complete",
            "verified no matches"
          );
        }
        if (data?.status !== "Dry Run" || data.applied !== false) {
          return terminalResponse(
            req.session_id,
            revision ?? 0,
            store,
            (text(data?.blockedReason) || "The schedule-scoped replacement plan could not be resolved safely.") +
              " No model changes were made.",
            "blocked",
            "preflight did not resolve a safe plan"
          );
        }
        const planHash = text(data.planHash);
        const writable = count(data.writableCandidateCount);
        if (!/^[0-9a-f]{64}$/i.test(planHash) || writable === 0) {
          return terminalResponse(
            req.session_id,
            revision ?? 0,
            store,
            (text(data.blockedReason) || "No writable host-model instance designation matched the exact schedule-scoped plan.") +
              " No model changes were made.",
            "blocked",
            "preflight omitted a usable plan hash or writable count"
          );
        }
        if (state.intent.max_changes && writable > state.intent.max_changes) {
          return terminalResponse(
            req.session_id,
            revision ?? 0,
            store,
            "The safe test permits " + state.intent.max_changes + " change, but " + writable +
              " writable matches resolved. I stopped without changing the model.",
            "blocked",
            "preflight exceeded max changes"
          );
        }
        const next: ActiveState = {
          ...state,
          stage: "apply",
          plan_hash: planHash,
          planned_count: writable,
          expires_at: Date.now() + TTL_MS
        };
        try {
          if (revision === null || !replaceState(req.session_id, next, revision, store)) {
            return response(
              "The schedule replacement preflight continuation changed concurrently, so I stopped before apply. No model changes were made.",
              [],
              "failed"
            );
          }
        } catch {
          return response(
            "The schedule replacement preflight succeeded, but I could not durably record its plan hash. I stopped before apply; no model changes were made.",
            [],
            "failed"
          );
        }
        return response(
          "I resolved " + writable + " exact writable schedule-backed designation value" +
            (writable === 1 ? "" : "s") + " in " + scopeLabel(state) +
            " and bound the apply step to plan " + planHash.slice(0, 12) + ". Applying and verifying now.",
          [replacementAction(state.apply_action_id, next, true, planHash)]
        );
      }

      const applied = replacementResult(req, state.apply_action_id);
      if (!applied) {
        return nonTerminalResponse(
          "The schedule replacement apply step returned an unexpected continuation, so I did not accept it or clear the active continuation."
        );
      }
      if (revision === null || !retireState(req.session_id, revision, store, "apply result received")) {
        return response(
          "The schedule replacement returned, but I could not clear its continuation record. I am not claiming the schedule was updated; inspect the Revit receipt before retrying.",
          [],
          "failed"
        );
      }
      if (applied.status !== "done") {
        return response(
          "The schedule replacement did not complete: " + (applied.error || "the native write failed") + ".",
          [],
          "failed"
        );
      }
      const data = payload(applied);
      const reportedPlanHash = text(data?.planHash);
      if (reportedPlanHash && reportedPlanHash !== state.plan_hash) {
        return response(
          "The schedule replacement receipt carried a plan hash different from the persisted preflight plan. I am not claiming completion.",
          [],
          "failed"
        );
      }
      const changed = count(data?.changedCount);
      const remaining = count(data?.remainingMatchCount);
      const failures = count(data?.verificationFailedCount);
      const summary = changeSummary(data?.changed);
      const scopeEvidence = scopeEvidenceSummary(data?.changed);
      if (
        data?.status === "Applied and Verified" &&
        data.applied === true &&
        data.verified === true &&
        data.complete === true &&
        failures === 0 &&
        remaining === 0 &&
        changed === state.planned_count
      ) {
        return response(
          "Updated and verified " + changed + " schedule-backed designation value" +
            (changed === 1 ? "" : "s") + " in " + scopeLabel(state) + ". " +
            scopeEvidence + " " +
            (summary || "Exact element, parameter, old, and new values are in the action receipt.") +
            " Remaining '" + state.intent.find + "' matches: 0. The handler did not save or synchronize the model.",
          [],
          "complete"
        );
      }
      if (data?.applied === true && data.verified === true) {
        return response(
          "Applied and verified " + changed + " writable replacement" +
            (changed === 1 ? "" : "s") + ", but " + remaining +
            " matching schedule-backed value" + (remaining === 1 ? " remains" : "s remain") +
            " unresolved. " + summary +
            " The exact unresolved elements and reasons are in the action receipt; the handler did not save or synchronize the model.",
          [],
          "failed"
        );
      }
      return response(
        (text(data?.blockedReason) || "The atomic schedule replacement did not produce a complete verified result.") +
          " I am not claiming completion.",
        [],
        "failed"
      );
    }

    const orphaned = req.tool_results?.some(isScheduleValueReplacementToolResult);
    return orphaned
      ? response(
          "The bounded schedule-replacement continuation state expired or was lost, so I stopped instead of replaying a write. Submit the original request again for a fresh plan. No additional model changes were made.",
          [],
          "failed"
        )
      : null;
  }

  if (loaded.problem) {
    const reason = loaded.problem === "expired"
      ? "expired or was lost"
      : loaded.problem === "quarantined"
        ? "quarantined after a cleanup failure"
        : "invalid or corrupted";
    return response(
      "The bounded schedule-replacement continuation state was " + reason +
        ", so I stopped instead of replacing it. Submit the original request again only after inspecting the continuation record. No model changes were made.",
      [],
      "failed"
    );
  }

  if (state) {
    return response(
      "A bounded schedule replacement is already in progress for this session. I stopped the new request so an older preflight result cannot be applied to a different intent.",
      [],
      "blocked"
    );
  }

  const intent = await interpretScheduleValueReplacementIntent(req, interpreter);
  if (!intent) return null;
  if (intent.confidence.ambiguity === "material" || intent.confidence.value < 0.8) {
    return response(
      "I can perform the schedule-backed replacement, but I need explicit sheet numbers or an exact schedule class, the schedule field concept, and the exact literal find/replace pair. For a one-item test I also need the exact current designation. No model changes were made.",
      [],
      "blocked"
    );
  }

  const next: ActiveState = {
    intent,
    stage: intent.schedule_query ? "schedule_discovery" : "preflight",
    expires_at: Date.now() + TTL_MS,
    schedule_discovery_action_id: newActionId("schedule-discovery"),
    preflight_action_id: newActionId("preflight"),
    apply_action_id: newActionId("apply")
  };
  try {
    if (!createState(req.session_id, next, store)) {
      return response(
        "A bounded schedule replacement is already in progress for this session, so I stopped before creating a second continuation. No model changes were made.",
        [],
        "blocked"
      );
    }
  } catch {
    return response(
      "I understood the bounded schedule replacement, but I could not durably record its continuation state. No model changes were made.",
      [],
      "failed"
    );
  }

  if (next.stage === "schedule_discovery") {
    return response(
      "I’m resolving only schedule names containing '" + intent.schedule_query +
        "' and every required term (" + intent.schedule_name_all_terms.join(", ") +
        ") before inspecting any values.",
      [scheduleDiscoveryAction(intent, next.schedule_discovery_action_id)]
    );
  }
  return response(
    "I’m inspecting only " + scopeLabel(next) + " for exact " +
      intent.field_names.join("/") + " values containing '" + intent.find +
      "', then I’ll bind any writable instance replacements to a dry-run plan hash before applying.",
    [replacementAction(next.preflight_action_id, next, false)]
  );
}

export function __testOnlyClearScheduleValueReplacementStates(): void {
  for (const sessionId of testSessionIds) {
    try {
      persistence.deleteMutationContinuation({
        sessionId,
        operationId: OPERATION_ID
      });
    } catch {
      // Best-effort cleanup for tests; production paths use CAS retirement above.
    }
  }
  testSessionIds.clear();
}
