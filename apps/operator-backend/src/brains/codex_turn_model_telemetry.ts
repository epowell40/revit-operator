import type { ModelCallReceipt } from "../contracts.js";
import { appendEvent } from "../memory/sqlite_store.js";
import { createCodexRawModelCallReceipt } from "../model_call_telemetry.js";
import type { AgentModelSettings } from "../speed_config.js";
import type { CodexThreadStartProfile } from "./codex_turn_profile.js";

type CodexNotification = {
  method?: string;
  threadId?: string;
  params?: Record<string, unknown>;
};

export function codexTelemetryThreadKey(profile: CodexThreadStartProfile): string {
  // Thread resume cannot opt an old thread into raw Responses API events.
  // Versioning the key starts one telemetry-capable durable thread per profile.
  return `${profile.threadKey}:raw-usage-v2`;
}

export function createCodexTurnModelTelemetry(args: {
  sessionId: string;
  threadId: string;
  turnId: string;
  settings: AgentModelSettings;
  startedAtUtc: string;
}): { receipts: ModelCallReceipt[]; observe: (notification: CodexNotification) => void } {
  const receipts: ModelCallReceipt[] = [];
  let actualModel = args.settings.model;
  return {
    receipts,
    observe(notification) {
      if (!notification || notification.threadId !== args.threadId) return;
      const params = notification.params || {};
      if (notification.method === "model/rerouted") {
        if (params.turnId && params.turnId !== args.turnId) return;
        const candidate = params.toModel ?? params.newModel ?? params.model ?? params.to;
        if (typeof candidate === "string" && candidate.trim()) actualModel = candidate.trim();
        return;
      }
      if (notification.method !== "rawResponse/completed" || params.turnId !== args.turnId) return;
      const receipt = createCodexRawModelCallReceipt({
        params,
        requested_model: args.settings.model,
        actual_model: actualModel,
        reasoning_effort: args.settings.reasoning_effort,
        started_at_utc: args.startedAtUtc,
        turn_id: args.turnId
      });
      if (!receipt || receipts.some(existing => existing.call_id === receipt.call_id)) return;
      receipts.push(receipt);
      try {
        appendEvent(args.sessionId, "assistant", "codex.model_call.completed", receipt);
      } catch {
        // The response receipt remains authoritative for benchmark collection.
      }
    }
  };
}
