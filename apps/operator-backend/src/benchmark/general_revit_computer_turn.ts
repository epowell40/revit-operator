import { settleTimedOutComputerRun } from "./computer_run_settlement.js";
import { localProcessIsAlive, type LocalRevitProcessGuardTarget } from "./local_revit_process_liveness.js";
import { modelCallReceiptsFromSources } from "./general_revit_model_telemetry.js";

type JsonRecord = Record<string, unknown>;
type RequestJson = (baseUrl: string, pathname: string, options?: RequestInit, timeoutMs?: number) => Promise<JsonRecord>;

export type GeneralRevitComputerTurnResult = {
  runResponse: JsonRecord;
  state: JsonRecord;
  transportError: string;
  timeoutSettlement: JsonRecord | null;
  contextLossSettlement: JsonRecord | null;
  modelTelemetryRecovery: JsonRecord | null;
  messageId: string;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export function pendingComputerClarification(state: JsonRecord): JsonRecord {
  for (const candidate of [state.pendingClarification, state.assignmentClarification, state.clarificationRequest]) {
    const row = record(candidate);
    if (String(row.clarification_id || row.id || "").trim()) return row;
  }
  return {};
}

export async function executeGeneralRevitComputerTurn(args: {
  baseUrl: string;
  caseId: string;
  prompt: string;
  messageId: string;
  processGuard: LocalRevitProcessGuardTarget | null;
  speedSettings: JsonRecord | null;
  timeoutMs: number;
  requestJson: RequestJson;
  recoverTimedOutModelTelemetry: (baseUrl: string, state: JsonRecord) => Promise<JsonRecord>;
  clarificationResponse?: { clarification_id: string; supplied_values: Record<string, string | number | boolean | null> };
}): Promise<GeneralRevitComputerTurnResult> {
  let runResponse: JsonRecord = {};
  let transportError = "";
  try {
    runResponse = await args.requestJson(args.baseUrl, "/api/computer/run", {
      method: "POST",
      body: JSON.stringify({
        prompt: args.prompt,
        message_id: args.messageId,
        ...(args.clarificationResponse ? {
          clarification_response: {
            schema: "revit-operator.benchmark-authenticated-clarification-response/v1",
            clarification_id: args.clarificationResponse.clarification_id,
            supplied_values: args.clarificationResponse.supplied_values
          }
        } : {}),
        ...(args.speedSettings ? {
          speed_settings: args.speedSettings,
          outer_model: args.speedSettings.outer_model,
          outer_reasoning_effort: args.speedSettings.outer_reasoning_effort
        } : {})
      })
    }, Math.min(args.timeoutMs, 30_000));
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }
  const pollingDeadline = Date.now() + args.timeoutMs;
  let state = await args.requestJson(args.baseUrl, "/api/computer/state", {}, 30_000);
  let contextLossSettlement: JsonRecord | null = null;
  while (state.running === true && Date.now() < pollingDeadline) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    if (args.processGuard && !localProcessIsAlive(args.processGuard.processId)) {
      const contextLossError = [
        `The exact local Revit process ${args.processGuard.processId} exited or was replaced while case ${args.caseId} was running.`,
        args.processGuard.documentTitle ? `Expected document '${args.processGuard.documentTitle}'.` : "",
        args.processGuard.executorId ? `Expected executor '${args.processGuard.executorId}'.` : "",
        "The benchmark stopped its own Operator turn instead of waiting for courier deadlines or grading a different Revit process."
      ].filter(Boolean).join(" ");
      transportError = transportError ? `${transportError} ${contextLossError}` : contextLossError;
      contextLossSettlement = await settleTimedOutComputerRun({
        initialState: state,
        stopRun: async () => { await args.requestJson(args.baseUrl, "/api/computer/stop", { method: "POST" }, 10_000); },
        readState: () => args.requestJson(args.baseUrl, "/api/computer/state", {}, 5_000),
        settleTimeoutMs: 30_000,
        pollIntervalMs: 250
      });
      state = record(contextLossSettlement.state);
      if (state.running === true) throw new Error(`${contextLossError} The stopped Operator turn did not become idle; the benchmark is stopping instead of contaminating later cases.`);
      break;
    }
    state = await args.requestJson(args.baseUrl, "/api/computer/state", {}, 30_000);
  }
  let timeoutSettlement: JsonRecord | null = null;
  if (state.running === true) {
    if (!transportError) transportError = `Computer run exceeded ${args.timeoutMs}ms.`;
    timeoutSettlement = await settleTimedOutComputerRun({
      initialState: state,
      stopRun: async () => { await args.requestJson(args.baseUrl, "/api/computer/stop", { method: "POST" }, 10_000); },
      readState: () => args.requestJson(args.baseUrl, "/api/computer/state", {}, 5_000),
      settleTimeoutMs: 30_000,
      pollIntervalMs: 250
    });
    state = record(timeoutSettlement.state);
    if (state.running === true) throw new Error(`Case ${args.caseId} exceeded ${args.timeoutMs}ms and the timed-out Operator run did not become idle; the benchmark is stopping instead of contaminating later cases with live-context contention.`);
  }
  let modelTelemetryRecovery: JsonRecord | null = null;
  if ((timeoutSettlement || contextLossSettlement) && modelCallReceiptsFromSources(state).length === 0) {
    try {
      modelTelemetryRecovery = await args.recoverTimedOutModelTelemetry(args.baseUrl, state);
      const recoveredReceipts = modelCallReceiptsFromSources(modelTelemetryRecovery);
      if (recoveredReceipts.length > 0) state = { ...state, modelCallReceipts: recoveredReceipts };
    } catch (error) {
      modelTelemetryRecovery = { status: "error", error: error instanceof Error ? error.message : String(error), model_call_receipts: [] };
    }
  }
  return { runResponse, state, transportError, timeoutSettlement, contextLossSettlement, modelTelemetryRecovery, messageId: args.messageId };
}
