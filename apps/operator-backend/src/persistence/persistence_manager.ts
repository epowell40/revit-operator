import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ActionCall, type ChatResponse, type ToolResult, type UserAttachment } from "../contracts.js";
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

export type ChatResultRecord =
  | {
      schema_version: 1;
      status: "complete";
      session_id: string;
      message_id: string;
      completed_at: string;
      response: ChatResponse;
    }
  | {
      schema_version: 1;
      status: "error";
      session_id: string;
      message_id: string;
      completed_at: string;
      error: string;
    };

function chatResultPath(sessionId: string, messageId: string): string {
  const p = runBundlePaths(sessionId);
  return path.join(p.sessionDir, "chat_results", `${safeDirName(messageId)}.json`);
}

function writeAllSync(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const wrote = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (!Number.isFinite(wrote) || wrote <= 0) throw new Error("Failed to write chat result.");
    offset += wrote;
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const buf = Buffer.from(JSON.stringify(value), "utf8");
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    writeAllSync(fd, buf);
    try {
      fs.fsyncSync(fd);
    } catch {
      // Best-effort on filesystems without fsync support.
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(tempPath)) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

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

  persistChatResponse(args: { sessionId: string; messageId: string; response: ChatResponse }): void {
    const sessionId = (args.sessionId ?? "").toString().trim();
    const messageId = (args.messageId ?? "").toString().trim();
    if (!sessionId) throw new Error("sessionId is required.");
    if (!messageId) throw new Error("messageId is required.");
    this.ensureSession(sessionId);
    const record: ChatResultRecord = {
      schema_version: 1,
      status: "complete",
      session_id: sessionId,
      message_id: messageId,
      completed_at: nowIso(),
      response: args.response
    };
    atomicWriteJson(chatResultPath(sessionId, messageId), record);
  }

  persistChatError(args: { sessionId: string; messageId: string; error: string }): void {
    const sessionId = (args.sessionId ?? "").toString().trim();
    const messageId = (args.messageId ?? "").toString().trim();
    if (!sessionId) throw new Error("sessionId is required.");
    if (!messageId) throw new Error("messageId is required.");
    this.ensureSession(sessionId);
    const record: ChatResultRecord = {
      schema_version: 1,
      status: "error",
      session_id: sessionId,
      message_id: messageId,
      completed_at: nowIso(),
      error: (args.error ?? "Unknown error").toString()
    };
    atomicWriteJson(chatResultPath(sessionId, messageId), record);
  }

  readChatResult(args: { sessionId: string; messageId: string }): ChatResultRecord | null {
    const sessionId = (args.sessionId ?? "").toString().trim();
    const messageId = (args.messageId ?? "").toString().trim();
    if (!sessionId) throw new Error("sessionId is required.");
    if (!messageId) throw new Error("messageId is required.");
    const filePath = chatResultPath(sessionId, messageId);
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ChatResultRecord>;
    if (
      parsed.schema_version !== 1 ||
      parsed.session_id !== sessionId ||
      parsed.message_id !== messageId ||
      (parsed.status !== "complete" && parsed.status !== "error")
    ) {
      throw new Error("Invalid persisted chat result.");
    }
    return parsed as ChatResultRecord;
  }
}

export const persistence = new PersistenceManager();
