import type { CodexNotificationEnvelope } from "../codex/app_server.js";
import type { CodexMcpToolRuntime } from "../codex/mcp_tool_runtime.js";
import { recordRevitToolOutcome } from "../codex/revit_tool_contract_memory.js";
import { appendEvent, appendNotification } from "../memory/sqlite_store.js";
import { persistence } from "../persistence/persistence_manager.js";
import {
  isSuccessfulAuthoritativeWebEvidenceCall,
  type AuthoritativeWebEvidenceRequirement
} from "./authoritative_web_evidence.js";
import { adaptDynamicToolCompletedItem } from "./codex_tool_observation.js";
import {
  isSuccessfulFreshRevitEvidence,
  type FreshRevitEvidenceRequirement
} from "./revit_turn_evidence.js";

type NotificationTelemetry = {
  observe(notification: CodexNotificationEnvelope): void;
};

type AssignmentTurnObserver = {
  observe(value: unknown): void;
};

export type CodexTurnNotificationSnapshot = {
  assistantText: string;
  assistantDeltas: string;
  hasFreshRevitEvidence: boolean;
  hasAuthoritativeWebEvidence: boolean;
};

/** Runtime stage text is descriptive, never an assertion that an effect succeeded. */
function toolProgressStage(item: any): string | undefined {
  if (!["dynamicToolCall", "mcpToolCall"].includes(item?.type)) return undefined;
  const tool = typeof item.tool === "string" ? item.tool : "";
  if (["operator_evaluate_assignment_criteria"].includes(tool)) return "Checking the result…";
  if (["operator_request_assignment_input", "request_user_input"].includes(tool)) return "Preparing a question…";
  if (["operator_discover_capabilities", "revit_search_tools", "revit_tool_doc"].includes(tool)) return "Finding the right tool…";
  if (tool === "operator_retrieve_evidence") return "Reviewing the collected information…";
  if (/capture/.test(tool)) return "Capturing the view…";
  if (/excel|xlsx/.test(tool)) return "Preparing the workbook…";
  if (/^revit_(get|list|find|query)/.test(tool)) return "Reading model information…";
  return "Working through the next step…";
}

function shouldNotifyCodexToolCalls(): boolean {
  const value = (process.env.OPERATOR_NOTIFY_CODEX_TOOL_CALLS ?? "1").toString().trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "no";
}

function toolNotifyThresholdMs(): number {
  const raw = Number.parseInt(process.env.OPERATOR_NOTIFY_CODEX_TOOL_CALLS_THRESHOLD_MS ?? "2500", 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : 2500;
}

export function createCodexTurnNotificationObserver(args: {
  sessionId: string;
  threadId: string;
  turnId: string;
  modelTelemetry: NotificationTelemetry;
  assignmentObserver: AssignmentTurnObserver;
  freshEvidenceRequirement: FreshRevitEvidenceRequirement;
  webEvidenceRequirement: AuthoritativeWebEvidenceRequirement;
  mcpRuntime: Pick<CodexMcpToolRuntime, "flushAssignmentKernelV2TurnStop"> | null;
  onDelta?: (delta: string) => void;
  onProgress?: (text: string) => void;
  deferAssistantOutput?: boolean;
}): {
  observe(notification: CodexNotificationEnvelope): void;
  snapshot(): CodexTurnNotificationSnapshot;
} {
  let assistantText = "";
  let assistantDeltas = "";
  const messagePhases = new Map<string, string>();
  const messageDeltas = new Map<string, string>();
  const canStream = !args.deferAssistantOutput && !args.freshEvidenceRequirement.required && !args.webEvidenceRequirement.required;
  let hasFreshRevitEvidence = !args.freshEvidenceRequirement.required;
  let hasAuthoritativeWebEvidence = !args.webEvidenceRequirement.required;

  const observe = (notification: CodexNotificationEnvelope): void => {
    try {
      if (!notification || notification.threadId !== args.threadId) return;
      args.modelTelemetry.observe(notification);
      if (notification.method === "item/started" && notification.params?.turnId === args.turnId) {
        const item = notification.params?.item;
        const stage = toolProgressStage(item);
        if (stage) args.onProgress?.(stage);
        if (item?.type === "agentMessage" && typeof item.id === "string") messagePhases.set(item.id, item.phase ?? "unknown");
      }
      if (notification.method === "item/agentMessage/delta") {
        if (notification.params?.turnId !== args.turnId) return;
        const delta = typeof notification.params?.delta === "string" ? notification.params.delta : "";
        if (delta) {
          const id = String(notification.params?.itemId ?? "unknown");
          messageDeltas.set(id, (messageDeltas.get(id) ?? "") + delta);
          if (messagePhases.get(id) === "final_answer") {
            assistantDeltas = messageDeltas.get(id)!;
            if (canStream) args.onDelta?.(delta);
          }
        }
      }

      if (notification.method !== "item/completed" || notification.params?.turnId !== args.turnId) return;
      const item = notification.params?.item;
      if (item?.type === "agentMessage") {
        const full = typeof item.text === "string" ? item.text : "";
        const phase = item.phase ?? messagePhases.get(String(item.id));
        if (phase === "commentary") {
          if (full) args.onProgress?.(full.replace(/\s+/g, " ").trim().slice(0, 240));
        } else if (full) {
          assistantText = full; assistantDeltas = full;
          if (canStream && messagePhases.get(String(item.id)) !== "final_answer") args.onDelta?.(full);
        }
        messageDeltas.delete(String(item.id)); messagePhases.delete(String(item.id));
      }

      const dynamicTool = adaptDynamicToolCompletedItem(item);
      if (dynamicTool) {
        args.onProgress?.(dynamicTool.success === false ? "Reviewing a tool issue…" : "Reviewing the result…");
        args.assignmentObserver.observe(dynamicTool);
        if (isSuccessfulFreshRevitEvidence(args.freshEvidenceRequirement, dynamicTool)) hasFreshRevitEvidence = true;
        if (isSuccessfulAuthoritativeWebEvidenceCall(dynamicTool)) hasAuthoritativeWebEvidence = true;
        try {
          recordRevitToolOutcome({
            sessionId: args.sessionId,
            threadId: args.threadId,
            turnId: args.turnId,
            tool: dynamicTool.tool,
            arguments: dynamicTool.arguments,
            success: dynamicTool.success,
            error: dynamicTool.error
          });
        } catch {
          // Contract memory is best-effort and must never interrupt the active turn.
        }
        try {
          appendEvent(args.sessionId, "tool", "codex.dynamicToolCall", {
            thread_id: args.threadId,
            turn_id: args.turnId,
            ...dynamicTool
          });
        } catch {
          // The canonical turn observation remains available in process.
        }
        try {
          const ts = new Date().toISOString();
          persistence.appendToolCall(args.sessionId, {
            ts,
            kind: "mcp.tool_call",
            session_id: args.sessionId,
            tool: dynamicTool.tool,
            server: dynamicTool.server,
            arguments: dynamicTool.arguments,
            status: dynamicTool.status,
            duration_ms: dynamicTool.duration_ms,
            thread_id: args.threadId,
            turn_id: args.turnId
          });
          persistence.appendToolOutput(args.sessionId, {
            ts,
            kind: "mcp.tool_result",
            session_id: args.sessionId,
            tool: dynamicTool.tool,
            server: dynamicTool.server,
            status: dynamicTool.status,
            duration_ms: dynamicTool.duration_ms,
            result: dynamicTool.result,
            error: dynamicTool.error,
            thread_id: args.threadId,
            turn_id: args.turnId
          });
        } catch {
          // Durable diagnostic journaling is best-effort at this edge.
        }
        if (shouldNotifyCodexToolCalls()) {
          try {
            const slow = dynamicTool.duration_ms !== null && dynamicTool.duration_ms >= toolNotifyThresholdMs();
            const summary = dynamicTool.error
              ? `Tool ${dynamicTool.tool}: ${dynamicTool.error}`
              : `Tool ${dynamicTool.tool} completed${dynamicTool.duration_ms !== null ? ` (ms=${Math.round(dynamicTool.duration_ms)}${slow ? ", slow=true" : ""})` : ""}.`;
            appendNotification(args.sessionId, "codex.tool_call", summary, {
              server: dynamicTool.server,
              tool: dynamicTool.tool,
              status: dynamicTool.status,
              duration_ms: dynamicTool.duration_ms,
              error: dynamicTool.error,
              arguments: dynamicTool.arguments,
              result: dynamicTool.result,
              slow: slow || null
            });
          } catch {
            // Notifications do not own turn settlement.
          }
        }
        // Flush only after the completed tool envelope has been observed, so
        // successful evidence is retained before provider work is interrupted.
        args.mcpRuntime?.flushAssignmentKernelV2TurnStop(args.turnId);
      }

      if (item?.type !== "mcpToolCall") return;
      const status = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
      const error = typeof item.error === "string" ? item.error.trim() : "";
      args.onProgress?.(error || ["failed", "error"].includes(status) ? "Reviewing a tool issue…" : "Reviewing the result…");
      args.assignmentObserver.observe({
        action_id: typeof item.id === "string" ? item.id : typeof item.callId === "string" ? item.callId : null,
        server: typeof item.server === "string" ? item.server : null,
        tool: typeof item.tool === "string" ? item.tool : "mcp_tool",
        success: error ? false : status ? ["success", "ok", "done", "completed"].includes(status) : null,
        status: status || null,
        error: error || null,
        duration_ms: typeof item.durationMs === "number" ? item.durationMs : null,
        arguments: item.arguments ?? null,
        result: item.result ?? item.content ?? item.contentItems ?? null
      });
      if (isSuccessfulFreshRevitEvidence(args.freshEvidenceRequirement, {
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        status: item.status,
        error: item.error
      })) hasFreshRevitEvidence = true;
      if (isSuccessfulAuthoritativeWebEvidenceCall({
        tool: item.tool,
        status: item.status,
        error: item.error
      })) hasAuthoritativeWebEvidence = true;

      try {
        const rawError = typeof item.error === "string" ? item.error : null;
        const success = rawError
          ? false
          : status
            ? ["success", "ok", "done", "completed"].includes(status)
            : undefined;
        recordRevitToolOutcome({
          sessionId: args.sessionId,
          threadId: args.threadId,
          turnId: args.turnId,
          tool: item.tool,
          arguments: item.arguments,
          success,
          error: rawError
        });
      } catch {
        // Contract memory is best-effort and must never interrupt the active turn.
      }
      try {
        appendEvent(args.sessionId, "tool", "codex.mcpToolCall", {
          thread_id: args.threadId,
          turn_id: args.turnId,
          server: item.server,
          tool: item.tool,
          status: item.status,
          arguments: item.arguments,
          duration_ms: item.durationMs ?? null,
          result: item.result ?? null,
          error: item.error ?? null
        });
      } catch {
        // The canonical turn observation remains available in process.
      }

      try {
        const ts = new Date().toISOString();
        persistence.appendToolCall(args.sessionId, {
          ts,
          kind: "mcp.tool_call",
          session_id: args.sessionId,
          tool: item.tool ?? "tool",
          server: item.server ?? null,
          arguments: item.arguments ?? null,
          status: item.status ?? null,
          duration_ms: typeof item.durationMs === "number" ? item.durationMs : null,
          thread_id: args.threadId,
          turn_id: args.turnId
        });
        persistence.appendToolOutput(args.sessionId, {
          ts,
          kind: "mcp.tool_result",
          session_id: args.sessionId,
          tool: item.tool ?? "tool",
          server: item.server ?? null,
          status: item.status ?? null,
          duration_ms: typeof item.durationMs === "number" ? item.durationMs : null,
          result: item.result ?? null,
          error: typeof item.error === "string" ? item.error : null,
          thread_id: args.threadId,
          turn_id: args.turnId
        });
      } catch {
        // Durable diagnostic journaling is best-effort at this edge.
      }

      try {
        if (typeof item.tool === "string" && item.tool.trim() === "web_fetch_evidence") {
          const itemStatus = typeof item.status === "string" ? item.status : "";
          const ok = itemStatus === "success" || itemStatus === "ok" || itemStatus === "done";
          appendNotification(
            args.sessionId,
            "web.research.saved",
            ok ? "Saved web evidence (see tool output for paths)." : "Web evidence fetch failed (see tool output).",
            { tool: item.tool, status: item.status ?? null }
          );
        }
      } catch {
        // Notifications do not own turn settlement.
      }

      if (shouldNotifyCodexToolCalls()) {
        try {
          const itemStatus = typeof item.status === "string" ? item.status : "";
          const durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
          const itemError = typeof item.error === "string" ? item.error.trim() : "";
          const tool = typeof item.tool === "string" ? item.tool.trim() : "tool";
          const ok = ["success", "ok", "done"].includes(itemStatus.toLowerCase());
          const slow = durationMs !== null && durationMs >= toolNotifyThresholdMs();
          const payload = {
            server: item.server ?? null,
            tool: item.tool ?? null,
            status: item.status ?? null,
            duration_ms: durationMs,
            error: itemError || null,
            arguments: item.arguments ?? null,
            result: item.result ?? null,
            slow: slow || null
          };
          const suffix = [
            itemStatus ? `status=${itemStatus}` : null,
            durationMs !== null ? `ms=${Math.round(durationMs)}` : null,
            slow ? "slow=true" : null
          ].filter(Boolean).join(", ");
          const summary = itemError
            ? `Tool ${tool}: ${itemError}`
            : `Tool ${tool} ${ok ? "completed" : "finished"}${suffix ? ` (${suffix})` : ""}.`;
          appendNotification(args.sessionId, "codex.tool_call", summary, payload);
        } catch {
          // Notifications do not own turn settlement.
        }
      }
    } catch {
      // A malformed diagnostic notification must not interrupt the active turn.
    }
  };

  return {
    observe,
    snapshot: () => ({
      assistantText,
      assistantDeltas,
      hasFreshRevitEvidence,
      hasAuthoritativeWebEvidence
    })
  };
}
