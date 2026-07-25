import { getOrCreateOperatorToken, getWriteGrantToken } from "./workspace.js";
import { callRevitViaCourier } from "./revitCourier.js";

// Use localhost or environment variable
export const REVIT_BRIDGE_URL = process.env.REVIT_BRIDGE_URL || "http://localhost:5000";

export type RevitBridgeErrorCode =
  | "revit_bridge_timeout"
  | "revit_bridge_unavailable"
  | "revit_bridge_http_error"
  | "revit_bridge_invalid_response";

export class RevitBridgeCallError extends Error {
  readonly code: RevitBridgeErrorCode;
  readonly retryable: boolean;
  readonly method: string;
  readonly path: string;

  constructor(input: {
    code: RevitBridgeErrorCode;
    message: string;
    retryable: boolean;
    method: string;
    path: string;
    cause?: unknown;
  }) {
    super(`[${input.code}] ${input.message} retryable=${input.retryable}.`, { cause: input.cause });
    this.name = "RevitBridgeCallError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.method = input.method;
    this.path = input.path;
  }
}

function requestTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.OPERATOR_REVIT_REQUEST_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(parsed)) return 120_000;
  return Math.max(250, Math.min(15 * 60_000, parsed));
}

function bridgeUrl(): string {
  return (process.env.REVIT_BRIDGE_URL || REVIT_BRIDGE_URL).replace(/\/+$/, "");
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error || "unknown error");
}

export async function callRevit<T = unknown>(path: string, method: string = "GET", body?: unknown): Promise<T> {
  const transport = (process.env.OPERATOR_REVIT_TRANSPORT || "direct").trim().toLowerCase();
  if (transport === "courier") return await callRevitViaCourier<T>(path, method, body);
  if (transport !== "direct") throw new Error(`Unsupported OPERATOR_REVIT_TRANSPORT: ${transport}`);

  const token = getOrCreateOperatorToken();
  const serializedBody =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const upperMethod = String(method || "GET").trim().toUpperCase();

  const doFetch = async (): Promise<Response> => {
    const url = `${bridgeUrl()}${path}`;
    const controller = new AbortController();
    const timeoutMs = requestTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const writeGrant = getWriteGrantToken();
    const options: RequestInit = {
      method: upperMethod,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Operator-Token": token } : {}),
        ...(writeGrant ? { "X-Operator-Write-Grant": writeGrant } : {}),
      },
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    };

    try {
      return await fetch(url, options);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RevitBridgeCallError({
          code: "revit_bridge_timeout",
          message: `${upperMethod} ${path} exceeded ${timeoutMs} ms while waiting for the Revit bridge. Revit may be busy; inspect its UI before retrying.`,
          retryable: true,
          method: upperMethod,
          path,
          cause: error,
        });
      }
      throw new RevitBridgeCallError({
        code: "revit_bridge_unavailable",
        message: `${upperMethod} ${path} could not reach ${bridgeUrl()}. Revit may be closed or the bridge may not be listening. Cause: ${errorDetail(error)}`,
        retryable: true,
        method: upperMethod,
        path,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let response = await doFetch();
  if (!response.ok) {
    let details = "";
    try { details = await response.text(); } catch { /* ignore */ }

    const isGrantError =
      response.status === 403 &&
      /write requires approval|x-operator-write-grant|write grant/i.test(details);

    // Write grant files can refresh in the add-in moments before a write.
    // Retry once so MCP calls recover without manual mode toggling.
    if (isGrantError && upperMethod !== "GET" && path !== "/revit/write-grant-status") {
      await new Promise(resolve => setTimeout(resolve, 150));
      response = await doFetch();
      if (response.ok) return (await response.json()) as T;
      try { details = await response.text(); } catch { /* ignore */ }
    }

    throw new RevitBridgeCallError({
      code: "revit_bridge_http_error",
      message: `${upperMethod} ${path} received HTTP ${response.status}${details ? `: ${details}` : ""}`,
      retryable: response.status === 408 || response.status === 409 || response.status === 423 || response.status === 429 || response.status >= 500,
      method: upperMethod,
      path,
    });
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new RevitBridgeCallError({
      code: "revit_bridge_invalid_response",
      message: `${upperMethod} ${path} returned a non-JSON response.`,
      retryable: false,
      method: upperMethod,
      path,
      cause: error,
    });
  }
}
