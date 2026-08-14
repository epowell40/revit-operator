export type GenericToolContract = {
  method?: string;
  path?: string;
  required_fields?: string[];
};

export type GenericToolPreflightFailure = {
  schema: "revit-operator.mcp-pre-dispatch-failure.v1";
  ok: false;
  code: "mcp_request_validation_failed";
  phase: "request_validation";
  retryable: true;
  request_dispatched: false;
  outcome_unknown: false;
  method: "POST";
  path: string;
  missing_required_fields: string[];
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
