import { getOrCreateOperatorToken, getWriteGrantToken } from "./workspace.js";
import { callRevitViaCourier } from "./revitCourier.js";

// Use localhost or environment variable
export const REVIT_BRIDGE_URL = process.env.REVIT_BRIDGE_URL || "http://localhost:5000";

export type RevitBridgeTransportErrorCode =
  | "revit_bridge_timeout"
  | "revit_bridge_unavailable"
  | "revit_bridge_http_error"
  | "revit_bridge_invalid_response";

export type RevitBridgeErrorCode = RevitBridgeTransportErrorCode;

export type RevitBridgeErrorDetails = Readonly<Record<string, unknown>>;

export class RevitBridgeCallError extends Error {
  readonly code: RevitBridgeErrorCode;
  readonly transportCode: RevitBridgeTransportErrorCode;
  readonly retryable: boolean;
  readonly outcome_unknown: boolean;
  readonly outcomeUnknown: boolean;
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly bridgeCode?: string;
  readonly phase?: string;
  readonly host_health?: string;
  readonly opens_circuit?: boolean;
  readonly correlation_id?: string;
  readonly deadline_class?: string;
  readonly deadline_ms?: number;
  readonly bridgeDetails?: RevitBridgeErrorDetails;

  constructor(input: {
    code: RevitBridgeErrorCode;
    transportCode?: RevitBridgeTransportErrorCode;
    message: string;
    retryable: boolean;
    outcomeUnknown?: boolean;
    method: string;
    path: string;
    status?: number;
    bridgeDetails?: RevitBridgeErrorDetails;
    cause?: unknown;
  }) {
    const outcomeUnknown = input.outcomeUnknown === true;
    const retryable = outcomeUnknown ? false : input.retryable;
    const outcomeSuffix = outcomeUnknown ? " outcome_unknown=true" : "";
    super(`[${input.code}] ${input.message} retryable=${retryable}${outcomeSuffix}.`, { cause: input.cause });
    this.name = "RevitBridgeCallError";
    this.code = input.code;
    this.transportCode = input.transportCode ?? input.code;
    this.retryable = retryable;
    this.outcome_unknown = outcomeUnknown;
    this.outcomeUnknown = outcomeUnknown;
    this.method = input.method;
    this.path = input.path;
    this.status = input.status;
    this.bridgeDetails = input.bridgeDetails;

    const details = input.bridgeDetails;
    this.bridgeCode = stringField(details, "code");
    this.phase = stringField(details, "phase");
    this.host_health = stringField(details, "host_health");
    this.opens_circuit = booleanField(details, "opens_circuit");
    this.correlation_id = stringField(details, "correlation_id");
    this.deadline_class = stringField(details, "deadline_class");
    this.deadline_ms = numberField(details, "deadline_ms");
  }
}

function stringField(details: RevitBridgeErrorDetails | undefined, name: string): string | undefined {
  const value = details?.[name];
  return typeof value === "string" ? value : undefined;
}

function booleanField(details: RevitBridgeErrorDetails | undefined, name: string): boolean | undefined {
  const value = details?.[name];
  return typeof value === "boolean" ? value : undefined;
}

function numberField(details: RevitBridgeErrorDetails | undefined, name: string): number | undefined {
  const value = details?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseBridgeErrorDetails(details: string): RevitBridgeErrorDetails | undefined {
  if (!details.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(details);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Legacy bridge errors can be plain text.
  }
  return undefined;
}

function isMutatingMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
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

const PROVEN_PRE_DISPATCH_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isProvenPreDispatchFailure(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  const errorCodes: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || (typeof current !== "object" && typeof current !== "function") || visited.has(current)) {
      continue;
    }
    visited.add(current);

    const record = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string") errorCodes.push(record.code);
    if (record.cause !== undefined) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }

  return errorCodes.length > 0 && errorCodes.every(code => PROVEN_PRE_DISPATCH_ERROR_CODES.has(code));
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
        const outcomeUnknown = isMutatingMethod(upperMethod);
        throw new RevitBridgeCallError({
          code: "revit_bridge_timeout",
          message: `${upperMethod} ${path} exceeded ${timeoutMs} ms while waiting for the Revit bridge. ${outcomeUnknown ? "The request may already have started; reconcile its outcome in Revit before any retry." : "Revit may be busy; inspect its UI before retrying."}`,
          retryable: !outcomeUnknown,
          outcomeUnknown,
          method: upperMethod,
          path,
          cause: error,
        });
      }
      const mutating = isMutatingMethod(upperMethod);
      const preDispatchFailure = isProvenPreDispatchFailure(error);
      const outcomeUnknown = mutating && !preDispatchFailure;
      throw new RevitBridgeCallError({
        code: "revit_bridge_unavailable",
        message: outcomeUnknown
          ? `${upperMethod} ${path} lost its connection to ${bridgeUrl()} after dispatch could not be ruled out. The request may already have started; reconcile its outcome in Revit before any retry. Cause: ${errorDetail(error)}`
          : `${upperMethod} ${path} could not reach ${bridgeUrl()}. Revit may be closed or the bridge may not be listening. Cause: ${errorDetail(error)}`,
        retryable: !mutating || preDispatchFailure,
        outcomeUnknown,
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
      if (!response.ok) {
        try { details = await response.text(); } catch { /* ignore */ }
      }
    }

    if (!response.ok) {
      const bridgeDetails = parseBridgeErrorDetails(details);
      const bridgeOutcomeUnknown = booleanField(bridgeDetails, "outcome_unknown");
      const outcomeUnknown = bridgeOutcomeUnknown ?? (response.status === 408 && isMutatingMethod(upperMethod));
      const bridgeRetryable = booleanField(bridgeDetails, "retryable");
      const statusRetryable = response.status === 408 || response.status === 409 || response.status === 423 || response.status === 429 || response.status >= 500;

      throw new RevitBridgeCallError({
        code: "revit_bridge_http_error",
        transportCode: "revit_bridge_http_error",
        message: `${upperMethod} ${path} received HTTP ${response.status}${details ? `: ${details}` : ""}`,
        retryable: outcomeUnknown ? false : (bridgeRetryable ?? statusRetryable),
        outcomeUnknown,
        method: upperMethod,
        path,
        status: response.status,
        bridgeDetails,
      });
    }
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    const outcomeUnknown = isMutatingMethod(upperMethod);
    throw new RevitBridgeCallError({
      code: "revit_bridge_invalid_response",
      message: `${upperMethod} ${path} returned an invalid or incomplete JSON response.${outcomeUnknown ? " The request may already have completed; reconcile its outcome in Revit before any retry." : ""}`,
      retryable: !outcomeUnknown,
      outcomeUnknown,
      method: upperMethod,
      path,
      cause: error,
    });
  }
}
