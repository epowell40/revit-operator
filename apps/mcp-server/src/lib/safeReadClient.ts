import { assertToolExposure } from "./toolExposurePolicy.js";
import {
  discoverSafeReadInstance,
  SAFE_READ_SHEETS_COUNT_PATH,
  type SafeReadDiscoveryOptions,
  type SafeReadInstance
} from "./safeReadDiscovery.js";

export const SAFE_READ_SHEETS_COUNT_BODY = '{"schema":"revit-operator.safe-read-sheets-count-request.v1"}';

export class SafeReadCallError extends Error {
  constructor(
    readonly code: "safe_read_unavailable" | "safe_read_http_error" | "safe_read_invalid_response",
    message: string,
    readonly retryable: boolean,
    readonly outcome_unknown: boolean,
    readonly status?: number,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "SafeReadCallError";
  }
}

export type SafeReadSheetsCountResponse = Readonly<Record<string, unknown>>;
export type SafeReadClientOptions = Readonly<{
  discovery?: SafeReadDiscoveryOptions;
  fetch?: typeof globalThis.fetch;
}>;

function configuredRevitYear(): number | undefined {
  const raw = process.env.OPERATOR_SAFE_READ_REVIT_YEAR;
  if (raw === undefined) return undefined;
  if (!/^\d{4}$/.test(raw)) throw new SafeReadCallError("safe_read_unavailable", "OPERATOR_SAFE_READ_REVIT_YEAR must be a four-digit year.", true, false);
  return Number(raw);
}

/**
 * Fixed high-level SafeRead request. The receiving microhost owns the frozen
 * backend preauthorization request (route_id, host_instance_id, executor_id,
 * runtime attestation/tuple, document tuple, client/request/attempt IDs, and
 * capability_nonce_sha256), capability nonce, final receipt, and capability
 * consumption. This MCP package must not mint/store/replay those values, and
 * therefore makes exactly one final host request with no fallback to
 * callRevit(), the main bridge, or the durable courier.
 */
export async function countSheetsViaSafeRead(options: SafeReadClientOptions = {}): Promise<SafeReadSheetsCountResponse> {
  assertToolExposure({ method: "POST", path: SAFE_READ_SHEETS_COUNT_PATH, body: SAFE_READ_SHEETS_COUNT_BODY, channel: "typed_mcp" });
  const instance: SafeReadInstance = discoverSafeReadInstance({
    ...options.discovery,
    revitYear: options.discovery?.revitYear ?? configuredRevitYear()
  });
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(`${instance.endpoint}${SAFE_READ_SHEETS_COUNT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Revit-Operator-Safe-Read-Startup-Token": instance.startup_token,
        "X-Revit-Operator-Safe-Read-Host-Instance-Id": instance.host_instance_id,
        "X-Revit-Operator-Safe-Read-Document-Session-Id": instance.document.document_session_id
      },
      body: SAFE_READ_SHEETS_COUNT_BODY
    });
  } catch (error) {
    throw new SafeReadCallError("safe_read_unavailable", "Certified SafeRead host could not be reached before a response was received.", true, false, undefined, error);
  }
  if (!response.ok) {
    // The microhost consumes the backend capability during its final protocol;
    // a non-2xx result is terminal from this caller's perspective.
    throw new SafeReadCallError("safe_read_http_error", `Certified SafeRead host returned HTTP ${response.status}.`, false, true, response.status);
  }
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be an object");
    return value as SafeReadSheetsCountResponse;
  } catch (error) {
    throw new SafeReadCallError("safe_read_invalid_response", "Certified SafeRead host returned an invalid JSON response.", false, true, response.status, error);
  }
}
