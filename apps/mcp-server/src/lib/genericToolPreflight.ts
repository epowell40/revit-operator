export type GenericToolContract = {
  method?: string;
  path?: string;
  required_fields?: string[];
};

export type GenericToolPreflightFailure = {
  schema: "revit-operator.mcp-pre-dispatch-failure.v1";
  ok: false;
  code: "mcp_request_validation_failed" | "mcp_registry_validation_unavailable" | "mcp_unknown_tool_path";
  phase: "request_validation" | "registry_validation";
  retryable: true;
  request_dispatched: false;
  outcome_unknown: false;
  method: "GET" | "POST";
  path: string;
  missing_required_fields?: string[];
  error: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function preflightKnownGenericToolBody(
  contract: GenericToolContract | null | undefined,
  body: unknown
): GenericToolPreflightFailure | null {
  if (`${contract?.method || ""}`.trim().toUpperCase() !== "POST") return null;
  const path = `${contract?.path || ""}`.trim();
  if (!path.startsWith("/revit/")) return null;
  const required = [...new Set((contract?.required_fields ?? [])
    .map(value => `${value || ""}`.trim())
    .filter(Boolean))];
  if (required.length === 0) return null;

  const root = record(body);
  const missing = required.filter(field => !root
    || !Object.prototype.hasOwnProperty.call(root, field)
    || root[field] === undefined
    || root[field] === null);
  if (missing.length === 0) return null;
  const noun = missing.length === 1 ? "field" : "fields";
  return {
    schema: "revit-operator.mcp-pre-dispatch-failure.v1",
    ok: false,
    code: "mcp_request_validation_failed",
    phase: "request_validation",
    retryable: true,
    request_dispatched: false,
    outcome_unknown: false,
    method: "POST",
    path,
    missing_required_fields: missing,
    error: `POST ${path} is missing required ${noun}: ${missing.join(", ")}. Inspect the exact tool contract and retry with a corrected request.`
  };
}

function normalizedMethod(method: unknown): "GET" | "POST" {
  return `${method || ""}`.trim().toUpperCase() === "GET" ? "GET" : "POST";
}

function clippedError(error: unknown): string {
  const text = `${error ?? ""}`.replace(/\s+/g, " ").trim();
  return text.length > 2_000 ? `${text.slice(0, 1_997)}...` : text;
}

export function genericToolRegistryLookupFailure(
  method: unknown,
  path: string,
  lookupError: unknown
): GenericToolPreflightFailure {
  const normalized = normalizedMethod(method);
  const detail = clippedError(lookupError) || "unknown registry lookup failure";
  return {
    schema: "revit-operator.mcp-pre-dispatch-failure.v1",
    ok: false,
    code: "mcp_registry_validation_unavailable",
    phase: "registry_validation",
    retryable: true,
    request_dispatched: false,
    outcome_unknown: false,
    method: normalized,
    path,
    error: `Registry validation for ${normalized} ${path} failed before the target request was dispatched: ${detail}. Retry the typed primitive or retry registry validation.`
  };
}

export function genericToolUnknownPathFailure(
  method: unknown,
  path: string
): GenericToolPreflightFailure {
  const normalized = normalizedMethod(method);
  return {
    schema: "revit-operator.mcp-pre-dispatch-failure.v1",
    ok: false,
    code: "mcp_unknown_tool_path",
    phase: "registry_validation",
    retryable: true,
    request_dispatched: false,
    outcome_unknown: false,
    method: normalized,
    path,
    error: `Unknown tool path for this bridge: ${normalized} ${path}. The target request was not dispatched. Run revit_search_tools or use a typed primitive before retrying.`
  };
}

export function mcpPreDispatchFailureResult(failure: GenericToolPreflightFailure): {
  isError: true;
  structuredContent: GenericToolPreflightFailure;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    structuredContent: failure,
    content: [{ type: "text", text: JSON.stringify(failure, null, 2) }]
  };
}
