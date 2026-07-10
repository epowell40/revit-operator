import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "../contracts.js";
import { getOrCreateOperatorToken } from "../operator_token.js";
import { persistence } from "../persistence/persistence_manager.js";
import { compactIncomingToolResult } from "../tool_result_compaction.js";

export type DirectBridgeResult = {
  ok: boolean;
  method: "GET" | "POST";
  path: string;
  result_json?: unknown;
  error?: string;
  duration_ms: number;
  attachments?: Array<{ kind: "image"; mime: string; filename?: string; local_path?: string }>;
};

export type BridgeRequestOptions = {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const directBridgeAvailabilityByUrl = new Map<string, { ok: boolean; checked_at_ms: number }>();
const DIRECT_BRIDGE_AVAILABILITY_TTL_MS = 60 * 1000;

export function inferBridgeUrl(): string {
  return (process.env.REVIT_BRIDGE_URL ?? "http://localhost:5000").trim().replace(/\/+$/, "");
}

function inferBridgeTimeoutMs(): number {
  return Math.max(2_000, Number.parseInt(process.env.OPERATOR_REDLINE_FAST_PATH_TIMEOUT_MS ?? "30000", 10) || 30_000);
}

async function requestBridgeJson(
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
  options: BridgeRequestOptions = {}
): Promise<unknown> {
  const token = options.token ?? getOrCreateOperatorToken();
  const controller = new AbortController();
  const timeoutMs = Math.max(1, options.timeoutMs ?? inferBridgeTimeoutMs());
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "X-Operator-Token": token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await (options.fetchImpl ?? fetch)(`${options.baseUrl ?? inferBridgeUrl()}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(raw || `${method} ${pathname} failed with HTTP ${res.status}`);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } finally {
    clearTimeout(timer);
  }
}

export async function canUseDirectBridgeFastPath(options: BridgeRequestOptions = {}): Promise<boolean> {
  const mode = (process.env.OPERATOR_REDLINE_FAST_PATH_DIRECT_BRIDGE ?? "auto").trim().toLowerCase();
  if (mode === "0" || mode === "false" || mode === "off" || mode === "disabled") return false;

  const baseUrl = options.baseUrl ?? inferBridgeUrl();
  const now = Date.now();
  const cached = directBridgeAvailabilityByUrl.get(baseUrl);
  if (cached && now - cached.checked_at_ms <= DIRECT_BRIDGE_AVAILABILITY_TTL_MS) {
    return cached.ok;
  }

  let ok = false;
  try {
    const probe = await requestBridgeJson("GET", "/revit/context", undefined, { ...options, baseUrl });
    ok = !!probe && typeof probe === "object";
  } catch {
    ok = false;
  }

  directBridgeAvailabilityByUrl.set(baseUrl, { ok, checked_at_ms: now });
  return ok;
}

export function inferImageAttachmentMime(localPath: string): string {
  const ext = path.extname(localPath).toLowerCase();
  return ext === ".png" ? "image/png" : "image/jpeg";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readNestedString(value: unknown, keys: string[]): string {
  let cur: unknown = value;
  for (const key of keys) {
    const obj = asRecord(cur);
    if (!obj) return "";
    cur = obj[key];
  }
  return typeof cur === "string" ? cur.trim() : "";
}

function extractBridgeImageAttachmentPaths(pathname: string, data: unknown): string[] {
  const p = (pathname ?? "").trim().toLowerCase();
  const paths: string[] = [];
  const add = (candidate: string) => {
    const v = (candidate ?? "").trim();
    if (v && !paths.includes(v)) paths.push(v);
  };

  if (
    p === "/revit/export-view-frame" ||
    p === "/revit/export-view-region" ||
    p === "/revit/export-image" ||
    p === "/revit/export-visible-elements" ||
    p === "/revit/highlight-and-export"
  ) {
    add(readNestedString(data, ["path"]));
  }

  if (p === "/revit/mep-route-workflow") {
    add(readNestedString(data, ["visualVerification", "capture", "path"]));
    add(readNestedString(data, ["visualVerification", "capturePath"]));
  }

  return paths;
}

export async function callBridgeActionDirect(
  sessionId: string,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown
): Promise<DirectBridgeResult> {
  const startedAt = Date.now();
  try {
    persistence.appendToolCall(sessionId, {
      ts: new Date(startedAt).toISOString(),
      kind: "mcp.tool_call",
      session_id: sessionId,
      tool: pathname,
      server: "revit-bridge",
      arguments: { method, body: body ?? null },
      status: "requested"
    });
  } catch {
    // ignore
  }

  try {
    const data = await requestBridgeJson(method, pathname, body);
    const durationMs = Date.now() - startedAt;
    const attachments: DirectBridgeResult["attachments"] = [];
    for (const localPath of extractBridgeImageAttachmentPaths(pathname, data)) {
      attachments.push({
        kind: "image",
        mime: inferImageAttachmentMime(localPath),
        filename: path.basename(localPath),
        local_path: localPath
      });
    }
    try {
      persistence.appendToolOutput(sessionId, {
        ts: new Date().toISOString(),
        kind: "mcp.tool_result",
        session_id: sessionId,
        tool: pathname,
        server: "revit-bridge",
        status: "success",
        result: data,
        error: null
      });
    } catch {
      // ignore
    }
    return { ok: true, method, path: pathname, result_json: data, duration_ms: durationMs, ...(attachments.length > 0 ? { attachments } : {}) };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : "Unknown bridge error";
    try {
      persistence.appendToolOutput(sessionId, {
        ts: new Date().toISOString(),
        kind: "mcp.tool_result",
        session_id: sessionId,
        tool: pathname,
        server: "revit-bridge",
        status: "failed",
        result: null,
        error: message
      });
    } catch {
      // ignore
    }
    return { ok: false, method, path: pathname, error: message, duration_ms: durationMs };
  }
}

export function readAbsoluteImageDataUrl(localPath: string, maxBytes?: number | null): string | null {
  try {
    const normalized = (localPath ?? "").trim();
    if (!normalized) return null;
    const ext = path.extname(normalized).toLowerCase();
    if (ext !== ".png" && ext !== ".jpg" && ext !== ".jpeg") return null;
    const st = fs.statSync(normalized);
    const limit = Math.max(128 * 1024, Number.parseInt(String(maxBytes ?? "3000000"), 10) || 3_000_000);
    if (!st.isFile() || st.size <= 0 || st.size > limit) return null;
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${fs.readFileSync(normalized).toString("base64")}`;
  } catch {
    return null;
  }
}

export function toToolResultFromDirectBridgeResult(result: DirectBridgeResult): ToolResult {
  return compactIncomingToolResult({
    action_id: randomUUID(),
    method: result.method,
    path: result.path,
    status: result.ok ? "done" : "failed",
    ...(result.ok ? { result_json: result.result_json ?? null } : {}),
    ...(result.ok ? {} : { error: result.error ?? "Bridge action failed." }),
    ...(Number.isFinite(result.duration_ms) ? { duration_ms: result.duration_ms } : {}),
    ...(Array.isArray(result.attachments) && result.attachments.length > 0 ? { attachments: result.attachments } : {})
  });
}

export async function __testOnlyRequestBridgeJson(
  method: "GET" | "POST",
  pathname: string,
  body: unknown,
  options: BridgeRequestOptions
): Promise<unknown> {
  return await requestBridgeJson(method, pathname, body, options);
}

export function __testOnlyExtractBridgeImageAttachmentPaths(pathname: string, data: unknown): string[] {
  return extractBridgeImageAttachmentPaths(pathname, data);
}

export function __testOnlyClearDirectBridgeAvailabilityCache(): void {
  directBridgeAvailabilityByUrl.clear();
}
