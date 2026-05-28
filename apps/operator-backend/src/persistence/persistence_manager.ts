import fs from "node:fs";
import path from "node:path";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ActionCall, type ToolResult, type UserAttachment } from "../contracts.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import { atomicAppendJsonlLine } from "./jsonl.js";

export type RunBundlePaths = {
  sessionDir: string;
  manifestPath: string;
  requestLogPath: string;
  agentLogPath: string;
  toolCallsPath: string;
  toolOutputsPath: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeDirName(id: string): string {
  const s = (id ?? "").toString().trim();
  if (!s) return "unknown_session";
  // Keep it conservative for Windows paths.
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function runBundlePaths(sessionId: string): RunBundlePaths {
  const layout = ensureWorkspaceLayout();
  const dir = path.join(layout.runsSessions, safeDirName(sessionId));
  return {
    sessionDir: dir,
    manifestPath: path.join(dir, "manifest.json"),
    requestLogPath: path.join(dir, "request_log.jsonl"),
    agentLogPath: path.join(dir, "agent_log.jsonl"),
    toolCallsPath: path.join(dir, "tool_calls.jsonl"),
    toolOutputsPath: path.join(dir, "tool_outputs.jsonl")
  };
}

function writeManifestIfMissing(sessionId: string, extra?: Record<string, unknown>): void {
  const p = runBundlePaths(sessionId);
  try {
    fs.mkdirSync(p.sessionDir, { recursive: true });
  } catch {
    // ignore
  }
  if (fs.existsSync(p.manifestPath)) return;

  const manifest = {
    schema_version: 1,
    created_at: nowIso(),
    session_id: sessionId,
    backend: { contract_version: OPERATOR_BACKEND_CONTRACT_VERSION },
    host: { pid: process.pid, platform: process.platform, node: process.version },
    ...(extra ? { extra } : {})
  };

  try {
    fs.writeFileSync(p.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  } catch {
    // ignore
  }
}

export type ToolCallRecord =
  | {
      ts: string;
      kind: "revit.action";
      session_id: string;
      message_id: string;
      action: ActionCall;
    }
  | {
      ts: string;
      kind: "skill.op";
      session_id: string;
      message_id: string;
      op: "stage" | "install" | "disable" | "enable";
      skill_id?: string | null;
      skill_name?: string | null;
    }
  | {
      ts: string;
      kind: "mcp.tool_call";
      session_id: string;
      tool: string;
      server?: string | null;
      arguments?: unknown;
      status?: string | null;
      duration_ms?: number | null;
      turn_id?: string | null;
      thread_id?: string | null;
    }
  | {
      ts: string;
      kind: "web.fetch";
      session_id: string;
      request_id: string;
      url: string;
    };

export type ToolOutputRecord =
  | {
      ts: string;
      kind: "revit.result";
      session_id: string;
      message_id: string;
      tool_result: ToolResult;
    }
  | {
      ts: string;
      kind: "skill.op.result";
      session_id: string;
      message_id: string;
      op: "stage" | "install" | "disable" | "enable";
      ok: boolean;
      skill_id?: string | null;
      error?: string | null;
      paths?: Record<string, string | null>;
    }
  | {
      ts: string;
      kind: "mcp.tool_result";
      session_id: string;
      tool: string;
      server?: string | null;
      status?: string | null;
      duration_ms?: number | null;
      result?: unknown;
      error?: string | null;
      turn_id?: string | null;
      thread_id?: string | null;
    }
  | {
      ts: string;
      kind: "web.evidence";
      session_id: string;
      request_id: string;
      url: string;
      ok: boolean;
      citation_id?: string;
      evidence_dir?: string;
      error?: string;
      paywall?: boolean;
    };

export class PersistenceManager {
  private ensured = new Set<string>();

  private ensureKey(sessionId: string): string {
    const root = ensureWorkspaceLayout().root;
    return `${root}::${sessionId}`;
  }

  ensureSession(sessionId: string, extra?: Record<string, unknown>): RunBundlePaths {
    const id = (sessionId ?? "").toString().trim();
    if (!id) throw new Error("sessionId is required.");
    const key = this.ensureKey(id);
    if (!this.ensured.has(key)) {
      writeManifestIfMissing(id, extra);
      this.ensured.add(key);
    }
    return runBundlePaths(id);
  }

  appendUserTurn(args: {
    sessionId: string;
    messageId: string;
    userText: string;
    toolResultsCount: number;
    userAttachments?: UserAttachment[];
  }): void {
    const p = this.ensureSession(args.sessionId);
    const ts = nowIso();
    atomicAppendJsonlLine(p.requestLogPath, {
      ts,
      kind: "user.turn",
      session_id: args.sessionId,
      message_id: args.messageId,
      user_text: args.userText,
      tool_results_count: args.toolResultsCount,
      user_attachments: Array.isArray(args.userAttachments)
        ? args.userAttachments.map(a => ({
            id: a.id,
            relative_path: a.relative_path ?? null,
            filename: a.filename ?? null,
            bytes: a.bytes ?? null,
            sha256: a.sha256 ?? null,
            mime: a.mime ?? null,
            created_at: a.created_at ?? null
          }))
        : []
    });
    atomicAppendJsonlLine(p.agentLogPath, { ts, kind: "event", session_id: args.sessionId, message_id: args.messageId, event: "USER_TURN_RECEIVED" });
  }

  appendAssistantTurn(args: { sessionId: string; messageId: string; text: string }): void {
    const p = this.ensureSession(args.sessionId);
    atomicAppendJsonlLine(p.agentLogPath, {
      ts: nowIso(),
      kind: "assistant.turn",
      session_id: args.sessionId,
      message_id: args.messageId,
      text: args.text
    });
  }

  appendToolCall(sessionId: string, record: ToolCallRecord): void {
    const p = this.ensureSession(sessionId);
    atomicAppendJsonlLine(p.toolCallsPath, record);
  }

  appendToolOutput(sessionId: string, record: ToolOutputRecord): void {
    const p = this.ensureSession(sessionId);
    atomicAppendJsonlLine(p.toolOutputsPath, record);
  }
}

export const persistence = new PersistenceManager();
