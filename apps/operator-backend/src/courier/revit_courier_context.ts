import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

export type RevitCourierTurnContextLease = {
  token: string;
  workspace_root: string;
  session_id: string;
  message_id: string;
  target_executor_id?: string;
  target_document_title?: string;
  target_document_path?: string;
};

const activeByWorkspace = new Map<string, RevitCourierTurnContextLease>();

function enabled(): boolean {
  return (process.env.OPERATOR_REVIT_TRANSPORT || "direct").trim().toLowerCase() === "courier";
}

function contextPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "config", "revit-courier-context.json");
}

function writeContext(workspaceRoot: string, value: unknown): void {
  const filePath = contextPath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

export function beginRevitCourierTurnContext(input: { session_id: string; message_id: string; ttl_ms: number; target_executor_id?: string; target_document_title?: string; target_document_path?: string }): RevitCourierTurnContextLease | null {
  if (!enabled()) return null;
  const sessionId = (input.session_id || "").trim();
  const messageId = (input.message_id || "").trim();
  if (!sessionId) throw new Error("Hosted Revit courier requires a session_id.");
  const workspaceRoot = ensureWorkspaceLayout().root;
  const existing = activeByWorkspace.get(workspaceRoot);
  if (existing) {
    throw new Error(`Hosted Revit courier is busy with session ${existing.session_id}; retry after its active Codex turn finishes.`);
  }
  const lease: RevitCourierTurnContextLease = {
    token: randomUUID(),
    workspace_root: workspaceRoot,
    session_id: sessionId,
    message_id: messageId,
    target_executor_id: (input.target_executor_id || "").trim() || undefined,
    target_document_title: (input.target_document_title || "").trim() || undefined,
    target_document_path: (input.target_document_path || "").trim() || undefined
  };
  activeByWorkspace.set(workspaceRoot, lease);
  const ttlMs = Math.max(30_000, Math.min(60 * 60_000, input.ttl_ms || 20 * 60_000));
  writeContext(workspaceRoot, {
    version: "revit-operator.revit-courier-context.v1",
    active: true,
    token: lease.token,
    session_id: sessionId,
    message_id: messageId,
    target_executor_id: lease.target_executor_id,
    target_document_title: lease.target_document_title,
    target_document_path: lease.target_document_path,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMs).toISOString()
  });
  return lease;
}

export function endRevitCourierTurnContext(lease: RevitCourierTurnContextLease | null | undefined): void {
  if (!lease) return;
  const active = activeByWorkspace.get(lease.workspace_root);
  if (!active || active.token !== lease.token) return;
  activeByWorkspace.delete(lease.workspace_root);
  writeContext(lease.workspace_root, {
    version: "revit-operator.revit-courier-context.v1",
    active: false,
    token: lease.token,
    session_id: lease.session_id,
    message_id: lease.message_id,
    target_executor_id: lease.target_executor_id,
    target_document_title: lease.target_document_title,
    target_document_path: lease.target_document_path,
    finished_at: new Date().toISOString(),
    expires_at: new Date().toISOString()
  });
}
