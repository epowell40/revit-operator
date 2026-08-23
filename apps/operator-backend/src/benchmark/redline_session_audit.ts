import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";
import { hydratePersistedToolOutputRecord } from "../evidence/evidence_store.js";

type JsonObject = Record<string, unknown>;

export type RedlineSessionAuditCheck = {
  key: string;
  passed: boolean;
  detail: string;
};

export type RedlineSessionAudit = {
  ok: boolean;
  session_dir: string;
  session_id: string | null;
  summary: {
    user_prompt: string | null;
    attachment_count: number;
    assistant_message_count: number;
    revit_action_count: number;
    failed_tool_count: number;
    created_element_ids: number[];
  };
  checks: RedlineSessionAuditCheck[];
  failed_tools: Array<{ tool: string; status: string; sample: string }>;
};

function readJsonl(filePath: string, maxLines = 20_000): JsonObject[] {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const rows: JsonObject[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (rows.length >= maxLines) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const row = parsed as JsonObject;
        rows.push(filePath.endsWith("tool_outputs.jsonl") ? hydratePersistedToolOutputRecord(row) : row);
      }
    } catch {
      // Ignore partial/corrupt JSONL lines; run bundles are append-only.
    }
  }
  return rows;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function resolveSessionDir(args: { sessionDir?: string; sessionId?: string }): string {
  if (args.sessionDir && args.sessionDir.trim()) return path.resolve(args.sessionDir.trim());
  const sessionId = (args.sessionId ?? "").trim();
  if (!sessionId) throw new Error("redline-session-audit requires --session-dir or --session-id.");
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return path.join(ensureWorkspaceLayout().runsSessions, safe);
}

function actionPath(row: JsonObject): string {
  const action = row.action && typeof row.action === "object" ? row.action as JsonObject : null;
  return str(action?.path);
}

function actionBody(row: JsonObject): JsonObject | null {
  const action = row.action && typeof row.action === "object" ? row.action as JsonObject : null;
  return action?.body && typeof action.body === "object" && !Array.isArray(action.body) ? action.body as JsonObject : null;
}

function resultPath(row: JsonObject): string {
  const toolResult = row.tool_result && typeof row.tool_result === "object" ? row.tool_result as JsonObject : null;
  return str(toolResult?.path);
}

function resultStatus(row: JsonObject): string {
  const toolResult = row.tool_result && typeof row.tool_result === "object" ? row.tool_result as JsonObject : null;
  return str(toolResult?.status || row.status).toLowerCase();
}

function resultJson(row: JsonObject): JsonObject | null {
  const toolResult = row.tool_result && typeof row.tool_result === "object" ? row.tool_result as JsonObject : null;
  const value = toolResult?.result_json ?? row.result;
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function collectCreatedIds(rows: JsonObject[]): number[] {
  const out = new Set<number>();
  const scan = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    const obj = value as JsonObject;
    for (const key of ["createdElementId", "created_element_id", "elementId", "element_id"]) {
      const id = int(obj[key]);
      if (id !== null && id > 0) out.add(id);
    }
    for (const key of ["createdElementIds", "created_element_ids", "createdIds", "created_ids"]) {
      const ids = Array.isArray(obj[key]) ? obj[key] : [];
      for (const raw of ids) {
        const id = int(raw);
        if (id !== null && id > 0) out.add(id);
      }
    }
    for (const key of ["placements", "items", "created", "results"]) scan(obj[key]);
  };
  for (const row of rows) {
    if (resultPath(row) !== "/revit/create-similar-from-instance" && resultPath(row) !== "/revit/place-family-instance-on-host") continue;
    const status = resultStatus(row);
    if (status && status !== "done" && status !== "success" && status !== "ok") continue;
    scan(resultJson(row));
  }
  return [...out].sort((a, b) => a - b);
}

function hasCircuitEvidence(rows: JsonObject[], createdIds: number[]): boolean {
  const created = new Set(createdIds);
  for (const row of rows) {
    const pathName = resultPath(row);
    if (pathName === "/revit/assign-electrical-circuit") return true;
    if (pathName !== "/revit/get-parameters" && pathName !== "/revit/create-similar-from-instance") continue;
    const payload = resultJson(row);
    const text = JSON.stringify(payload ?? {});
    if (!/(Panel|Circuit Number|electricalCircuit|primaryLabel|panelName|circuitNumber)/i.test(text)) continue;
    if (created.size === 0) return true;
    for (const id of created) {
      if (text.includes(String(id))) return true;
    }
  }
  return false;
}

function check(key: string, passed: boolean, detail: string): RedlineSessionAuditCheck {
  return { key, passed, detail };
}

export function buildRedlineSessionAudit(args: {
  sessionDir?: string;
  sessionId?: string;
  maxToolCalls?: number;
  maxAssistantMessages?: number;
}): RedlineSessionAudit {
  const sessionDir = resolveSessionDir(args);
  const requestRows = readJsonl(path.join(sessionDir, "request_log.jsonl"));
  const agentRows = readJsonl(path.join(sessionDir, "agent_log.jsonl"));
  const callRows = readJsonl(path.join(sessionDir, "tool_calls.jsonl"));
  const outputRows = readJsonl(path.join(sessionDir, "tool_outputs.jsonl"));

  const sessionId = requestRows.map((row) => str(row.session_id)).find(Boolean) ?? agentRows.map((row) => str(row.session_id)).find(Boolean) ?? null;
  const userPrompt = [...requestRows].reverse().map((row) => str(row.user_text)).find(Boolean) ?? null;
  const attachmentCount = requestRows.reduce((sum, row) => sum + (Array.isArray(row.user_attachments) ? row.user_attachments.length : 0), 0);
  const assistantMessages = agentRows.filter((row) => row.kind === "assistant.turn" && str(row.text));
  const assistantText = assistantMessages.map((row) => str(row.text)).join("\n");
  const actionPaths = callRows.map(actionPath).filter(Boolean);
  const resultPaths = outputRows.map(resultPath).filter(Boolean);
  const allPaths = [...actionPaths, ...resultPaths];
  const createSimilarCalls = callRows.filter((row) => actionPath(row) === "/revit/create-similar-from-instance");
  const createSimilarPreview = createSimilarCalls.some((row) => actionBody(row)?.dryRun === true);
  const createSimilarApply = createSimilarCalls.some((row) => actionBody(row)?.dryRun === false);
  const createdIds = collectCreatedIds(outputRows);
  const failedTools = outputRows
    .map((row) => {
      const status = resultStatus(row);
      const pathName = resultPath(row) || str(row.tool) || str(row.path);
      if (!status || status === "done" || status === "success" || status === "ok") return null;
      return {
        tool: pathName || "unknown",
        status,
        sample: JSON.stringify(resultJson(row) ?? row).slice(0, 400)
      };
    })
    .filter((row): row is { tool: string; status: string; sample: string } => row !== null);
  const maxToolCalls = Math.max(1, Math.floor(args.maxToolCalls ?? 25));
  const maxAssistantMessages = Math.max(1, Math.floor(args.maxAssistantMessages ?? 10));
  const noPickBlocker = /no_pick_hints|did not recover usable pick locations/i.test(assistantText);
  const hasCompletionText = /placed and verified|verification passed|created element|created receptacle/i.test(assistantText);

  const checks = [
    check("redline_attachment_present", attachmentCount > 0, `${attachmentCount} attachment(s) in request log`),
    check("no_no_pick_blocker", !noPickBlocker, noPickBlocker ? "assistant reported no_pick_hints" : "no no-pick blocker text found"),
    check("tool_call_budget", actionPaths.length <= maxToolCalls, `${actionPaths.length}/${maxToolCalls} Revit action call(s)`),
    check("assistant_message_budget", assistantMessages.length <= maxAssistantMessages, `${assistantMessages.length}/${maxAssistantMessages} assistant message(s)`),
    check("room_context_queried", allPaths.some((p) => p === "/revit/rooms" || p === "/revit/room-contents"), "requires /revit/rooms or /revit/room-contents"),
    check("wall_or_exemplar_ranked", allPaths.some((p) => p === "/revit/resolve-room-wall" || p === "/revit/rank-similar-devices-on-wall"), "requires wall resolution or similar-device ranking"),
    check("create_similar_previewed", createSimilarPreview, "requires /revit/create-similar-from-instance dryRun=true"),
    check("create_similar_applied", createSimilarApply || createdIds.length > 0, createdIds.length > 0 ? `created ids: ${createdIds.join(", ")}` : "requires apply or created id evidence"),
    check("focused_capture_done", allPaths.some((p) => p === "/revit/export-view-region" || p === "/revit/export-view-frame"), "requires focused or mapped view capture"),
    check("hosted_audit_done", allPaths.includes("/revit/audit-hosted-instance-placement"), "requires hosted placement audit"),
    check("circuit_evidence_done", hasCircuitEvidence(outputRows, createdIds), "requires source/created circuit readback or assignment evidence"),
    check("no_failed_tools", failedTools.length === 0, `${failedTools.length} failed tool result(s)`),
    check("completion_reported", hasCompletionText, hasCompletionText ? "assistant reported placement verification" : "no completion text found")
  ];

  return {
    ok: checks.every((item) => item.passed),
    session_dir: sessionDir,
    session_id: sessionId,
    summary: {
      user_prompt: userPrompt,
      attachment_count: attachmentCount,
      assistant_message_count: assistantMessages.length,
      revit_action_count: actionPaths.length,
      failed_tool_count: failedTools.length,
      created_element_ids: createdIds
    },
    checks,
    failed_tools: failedTools
  };
}
