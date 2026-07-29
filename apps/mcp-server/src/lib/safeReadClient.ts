import { randomUUID } from "node:crypto";
import { assertToolExposure } from "./toolExposurePolicy.js";
import {
  discoverSafeReadInstance,
  SafeReadDiscoveryError,
  SAFE_READ_SHEETS_COUNT_PATH,
  type SafeReadDiscoveryOptions
} from "./safeReadDiscovery.js";

export const SAFE_READ_SHEETS_COUNT_BODY = '{"schema":"revit-operator.safe-read.sheets-count.request.v1"}';
export const SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA = "revit-operator.safe-read.sheets-count.response.v1";
export const SAFE_READ_FAILURE_SCHEMA = "revit-operator.safe-read.failure.v1";
export const SAFE_READ_RESPONSE_MAX_BYTES = 4096;
export const SAFE_READ_REQUEST_HEADERS = Object.freeze({
  startupToken: "X-RevitOperator-SafeRead-Startup-Token",
  hostInstanceId: "X-RevitOperator-SafeRead-Host-Instance-Id",
  documentSessionId: "X-RevitOperator-SafeRead-Document-Session-Id",
  clientSessionId: "X-RevitOperator-SafeRead-Client-Session-Id",
  requestId: "X-RevitOperator-SafeRead-Request-Id",
  attemptId: "X-RevitOperator-SafeRead-Attempt-Id"
} as const);
export const SAFE_READ_REQUEST_HEADER_NAMES = Object.freeze(Object.values(SAFE_READ_REQUEST_HEADERS));

const CLIENT_SESSION_ID = randomUUID();
const FAILURE_KEYS = ["schema", "code", "error", "retryable", "request_dispatched", "outcome_unknown", "phase"] as const;
const SUCCESS_KEYS = ["schema", "count"] as const;
const SAFE_FAILURE_TEXT = /^[^\u0000-\u001F\u007F]{1,512}$/;
const SAFE_FAILURE_CODE = /^[a-z][a-z0-9_]{0,127}$/;
const SAFE_PHASE = /^[a-z][a-z0-9_]{0,127}$/;
const CANONICAL_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class SafeReadResponseTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SafeReadResponseTransportError";
  }
}

export type SafeReadSheetsCountResponse = Readonly<{
  schema: typeof SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA;
  count: number;
}>;

export type SafeReadStructuredFailure = Readonly<{
  schema: typeof SAFE_READ_FAILURE_SCHEMA;
  code: string;
  error: string;
  retryable: boolean;
  request_dispatched: boolean;
  outcome_unknown: boolean;
  phase: string;
}>;

export class SafeReadCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly request_dispatched: boolean,
    readonly outcome_unknown: boolean,
    readonly phase: string,
    readonly status?: number,
    readonly failure?: SafeReadStructuredFailure,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "SafeReadCallError";
  }
}

export type SafeReadClientOptions = Readonly<{
  discovery?: SafeReadDiscoveryOptions;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  idFactory?: () => string;
}>;

export function safeReadClientSessionId(): string {
  return CLIENT_SESSION_ID;
}

export function safeReadFailurePayload(error: SafeReadCallError): SafeReadStructuredFailure {
  return Object.freeze({
    schema: SAFE_READ_FAILURE_SCHEMA,
    code: error.code,
    error: error.message,
    retryable: error.retryable,
    request_dispatched: error.request_dispatched,
    outcome_unknown: error.outcome_unknown,
    phase: error.phase
  });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function configuredRevitYear(): number | undefined {
  const raw = process.env.OPERATOR_SAFE_READ_REVIT_YEAR;
  if (raw === undefined) return undefined;
  if (!/^\d{4}$/.test(raw)) {
    throw new SafeReadCallError("safe_read_configuration_invalid", "OPERATOR_SAFE_READ_REVIT_YEAR must be a four-digit year.", false, false, false, "configuration");
  }
  return Number(raw);
}

function timeoutMs(value: number | undefined): number {
  const fromEnv = Number.parseInt(process.env.OPERATOR_SAFE_READ_REQUEST_TIMEOUT_MS ?? "", 10);
  const requested = value ?? (Number.isFinite(fromEnv) ? fromEnv : 15_000);
  const finite = Number.isFinite(requested) ? requested : 15_000;
  return Math.max(1, Math.min(30_000, Math.floor(finite)));
}

function definitelyPreDispatch(error: unknown): boolean {
  const known = new Set(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  const codes: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || (typeof current !== "object" && typeof current !== "function") || visited.has(current)) continue;
    visited.add(current);
    const row = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof row.code === "string") codes.push(row.code);
    if (row.cause !== undefined) pending.push(row.cause);
    if (Array.isArray(row.errors)) pending.push(...row.errors);
  }
  return codes.length > 0 && codes.every(code => known.has(code));
}

function abortError(): DOMException {
  return new DOMException("The certified SafeRead request deadline elapsed.", "AbortError");
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); }
    );
  });
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SAFE_READ_RESPONSE_MAX_BYTES)) {
    await response.body?.cancel("SafeRead response declared an invalid or oversized body.").catch(() => undefined);
    throw new Error("SafeRead response exceeds the byte limit.");
  }
  if (!response.body) throw new SafeReadResponseTransportError("SafeRead response body is unavailable after dispatch.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelReader = () => { void reader.cancel(abortError()).catch(() => undefined); };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await awaitWithAbort(reader.read(), signal);
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw new SafeReadResponseTransportError("SafeRead response transport ended before the complete body was received.", error);
      }
      if (signal.aborted) throw new SafeReadResponseTransportError("SafeRead response deadline elapsed before the complete body was received.", abortError());
      if (next.done) break;
      total += next.value.byteLength;
      if (total > SAFE_READ_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new Error("SafeRead response exceeds the byte limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== total) {
    throw new SafeReadResponseTransportError("SafeRead response body was truncated after dispatch.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseSuccess(value: unknown): SafeReadSheetsCountResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, SUCCESS_KEYS) || row.schema !== SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA
    || !Number.isInteger(row.count) || (row.count as number) < 0 || (row.count as number) > 100_000) return null;
  return Object.freeze({ schema: SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA, count: row.count as number });
}

function parseFailure(value: unknown): SafeReadStructuredFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, FAILURE_KEYS) || row.schema !== SAFE_READ_FAILURE_SCHEMA
    || typeof row.code !== "string" || !SAFE_FAILURE_CODE.test(row.code)
    || typeof row.error !== "string" || !SAFE_FAILURE_TEXT.test(row.error)
    || typeof row.phase !== "string" || !SAFE_PHASE.test(row.phase)
    || typeof row.retryable !== "boolean" || typeof row.request_dispatched !== "boolean" || typeof row.outcome_unknown !== "boolean") return null;
  if (row.outcome_unknown === true && (row.retryable !== false || row.request_dispatched !== true)) return null;
  return Object.freeze({
    schema: SAFE_READ_FAILURE_SCHEMA,
    code: row.code,
    error: row.error,
    retryable: row.retryable,
    request_dispatched: row.request_dispatched,
    outcome_unknown: row.outcome_unknown,
    phase: row.phase
  });
}

function invalidResponse(status: number | undefined, cause?: unknown): SafeReadCallError {
  return new SafeReadCallError(
    "safe_read_invalid_response",
    "Certified SafeRead host returned an invalid or incomplete response after request dispatch.",
    false,
    true,
    true,
    "response",
    status,
    undefined,
    cause
  );
}

function transportOutcomeUnknown(cause?: unknown): SafeReadCallError {
  return new SafeReadCallError(
    "safe_read_transport_outcome_unknown",
    "Certified SafeRead transport ended after dispatch could not be ruled out; do not retry automatically.",
    false,
    true,
    true,
    "transport",
    undefined,
    undefined,
    cause
  );
}

function nextCanonicalId(factory: () => string): string {
  const value = factory();
  if (!CANONICAL_GUID.test(value)) {
    throw new SafeReadCallError("safe_read_identity_invalid", "SafeRead request identity generation failed.", false, false, false, "identity");
  }
  return value;
}

/** One high-level direct request. The microhost exclusively owns capability nonce and backend finalization. */
export async function countSheetsViaSafeRead(options: SafeReadClientOptions = {}): Promise<SafeReadSheetsCountResponse> {
  assertToolExposure({ method: "POST", path: SAFE_READ_SHEETS_COUNT_PATH, body: SAFE_READ_SHEETS_COUNT_BODY, channel: "typed_mcp" });
  let instance;
  try {
    instance = discoverSafeReadInstance({ ...options.discovery, revitYear: options.discovery?.revitYear ?? configuredRevitYear() });
  } catch (error) {
    if (error instanceof SafeReadCallError) throw error;
    const code = error instanceof SafeReadDiscoveryError ? error.code : "safe_read_discovery_unavailable";
    throw new SafeReadCallError(code, "A single live certified SafeRead host could not be discovered.", true, false, false, "discovery", undefined, undefined, error);
  }
  const makeId = options.idFactory ?? randomUUID;
  const requestId = nextCanonicalId(makeId);
  const attemptId = nextCanonicalId(makeId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(options.timeoutMs));
  try {
    let response: Response;
    try {
      const fetchPromise = (options.fetch ?? globalThis.fetch)(`${instance.endpoint}${SAFE_READ_SHEETS_COUNT_PATH.slice(1)}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          [SAFE_READ_REQUEST_HEADERS.startupToken]: instance.startup_token,
          [SAFE_READ_REQUEST_HEADERS.hostInstanceId]: instance.host_instance_id,
          [SAFE_READ_REQUEST_HEADERS.documentSessionId]: instance.document.document_session_id,
          [SAFE_READ_REQUEST_HEADERS.clientSessionId]: CLIENT_SESSION_ID,
          [SAFE_READ_REQUEST_HEADERS.requestId]: requestId,
          [SAFE_READ_REQUEST_HEADERS.attemptId]: attemptId
        },
        body: SAFE_READ_SHEETS_COUNT_BODY
      });
      response = await awaitWithAbort(fetchPromise, controller.signal);
    } catch (error) {
      const preDispatch = !controller.signal.aborted && definitelyPreDispatch(error);
      if (!preDispatch) throw transportOutcomeUnknown(error);
      throw new SafeReadCallError(
        "safe_read_unavailable",
        "Certified SafeRead host was unreachable before dispatch.",
        true,
        false,
        false,
        "transport_connect",
        undefined,
        undefined,
        error
      );
    }

    let responseText: string;
    try {
      responseText = await readBoundedResponse(response, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || error instanceof SafeReadResponseTransportError) throw transportOutcomeUnknown(error);
      throw invalidResponse(response.status, error);
    }
    if (controller.signal.aborted) throw transportOutcomeUnknown(abortError());

    let parsed: unknown;
    try { parsed = JSON.parse(responseText); } catch (error) { throw invalidResponse(response.status, error); }
    if (controller.signal.aborted) throw transportOutcomeUnknown(abortError());
    if (response.status === 200) {
      const success = parseSuccess(parsed);
      if (!success) throw invalidResponse(response.status);
      return success;
    }
    const failure = parseFailure(parsed);
    if (!failure) throw invalidResponse(response.status);
    throw new SafeReadCallError(
      failure.code,
      failure.error,
      failure.retryable,
      failure.request_dispatched,
      failure.outcome_unknown,
      failure.phase,
      response.status,
      failure
    );
  } finally {
    clearTimeout(timer);
  }
}
