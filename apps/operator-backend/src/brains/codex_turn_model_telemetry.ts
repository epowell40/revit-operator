import type { ModelCallReceipt } from "../contracts.js";
import { parseProviderTurnUsageV1, PROVIDER_TURN_USAGE_V1_SCHEMA, type ProviderTurnUsageV1 } from "@revitoperator/assignment-kernel-v2-contracts/provider-turn-usage";
import { appendEvent } from "../memory/sqlite_store.js";
import { createCodexRawModelCallReceipt } from "../model_call_telemetry.js";
import type { AgentModelSettings } from "../speed_config.js";
import type { CodexThreadStartProfile } from "./codex_turn_profile.js";

type CodexNotification = {
  method?: string;
  threadId?: string;
  params?: Record<string, unknown>;
};

type UsageBreakdown = {
  inputTokens: number; cachedInputTokens: number; outputTokens: number;
  reasoningOutputTokens: number; totalTokens: number; cacheWriteInputTokens: number | null;
};

export type CodexUsageSnapshot = { last: UsageBreakdown; total: UsageBreakdown };

function usageBreakdown(value: unknown): UsageBreakdown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
  if (!keys.every(key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)) return null;
  if (Number(row.cachedInputTokens) > Number(row.inputTokens)
    || Number(row.reasoningOutputTokens) > Number(row.outputTokens)) return null;
  const cacheWrite = row.cacheWriteInputTokens;
  if (cacheWrite != null && (!Number.isSafeInteger(cacheWrite) || Number(cacheWrite) < 0)) return null;
  return {
    inputTokens: Number(row.inputTokens), cachedInputTokens: Number(row.cachedInputTokens),
    outputTokens: Number(row.outputTokens), reasoningOutputTokens: Number(row.reasoningOutputTokens),
    totalTokens: Number(row.totalTokens), cacheWriteInputTokens: cacheWrite == null ? null : Number(cacheWrite)
  };
}

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
  onReceipt?: (receipt: ModelCallReceipt) => void;
}): {
  receipts: ModelCallReceipt[]; compactions: string[];
  usageSnapshot: () => CodexUsageSnapshot | null;
  finish: (messageId: string, disposition: Exclude<ProviderTurnUsageV1["disposition"], "not_started">) => ProviderTurnUsageV1;
  observe: (notification: CodexNotification) => void;
} {
  const receipts: ModelCallReceipt[] = [];
  const compactions: string[] = [];
  let actualModel = args.settings.model;
  let latestUsage: CodexUsageSnapshot | null = null;
  return {
    receipts,
    compactions,
    usageSnapshot: () => latestUsage === null ? null : structuredClone(latestUsage),
    finish(messageId, disposition) {
      const coverage = parseProviderTurnUsageV1({ schema: PROVIDER_TURN_USAGE_V1_SCHEMA,
        session_id: args.sessionId, message_id: messageId, thread_id: args.threadId,
        turn_id: args.turnId, disposition, raw_response_ids: receipts.map(receipt => receipt.call_id) });
      try {
        appendEvent(args.sessionId, "assistant", "codex.turn.usage_coverage", {
          ...coverage, thread_usage_snapshot: latestUsage,
          context_compaction_count: compactions.length
        });
      } catch {
        // The returned host record still exposes missing receipts to the caller.
      }
      return coverage;
    },
    observe(notification) {
      if (!notification || notification.threadId !== args.threadId) return;
      const params = notification.params || {};
      if (notification.method === "thread/tokenUsage/updated" && params.turnId === args.turnId) {
        const usage = params.tokenUsage as Record<string, unknown> | undefined;
        const last = usageBreakdown(usage?.last);
        const total = usageBreakdown(usage?.total);
        if (!last || !total) return;
        const snapshot = { last, total };
        if (JSON.stringify(snapshot) === JSON.stringify(latestUsage)) return;
        latestUsage = snapshot;
        try {
          appendEvent(args.sessionId, "assistant", "codex.token_usage.updated", {
            thread_id: args.threadId, turn_id: args.turnId,
            usage_source: "app_server_thread_token_usage_snapshot", ...snapshot
          });
        } catch {
          // The last snapshot is also retained in the turn completion event.
        }
        // Cumulative snapshots may reset at compaction and have no response ID.
        // Never sum them or impersonate raw provider receipts/budget admissions.
        return;
      }
      if (notification.method === "item/completed" && params.turnId === args.turnId) {
        const item = params.item as { type?: unknown; id?: unknown } | undefined;
        if (item?.type === "contextCompaction" && typeof item.id === "string" && item.id.length > 0 && !compactions.includes(item.id)) {
          compactions.push(item.id);
          try {
            appendEvent(args.sessionId, "assistant", "codex.context_compaction.completed", {
              thread_id: args.threadId, turn_id: args.turnId, item_id: item.id,
              completed_after_provider_calls: receipts.length
            });
          } catch {
            // Diagnostic failure cannot alter the durable mutation ledger.
          }
        }
        return;
      }
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
      args.onReceipt?.(receipt);
      try {
        appendEvent(args.sessionId, "assistant", "codex.model_call.completed", receipt);
      } catch {
        // The response receipt remains authoritative for benchmark collection.
      }
    }
  };
}
