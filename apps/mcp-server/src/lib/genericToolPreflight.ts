export type GenericToolContract = {
  method?: string;
  path?: string;
  required_fields?: string[];
  request_schema?: unknown;
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
  invalid_fields?: string[];
  error: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function schemaViolations(value: unknown, schemaValue: unknown, field: string, violations: string[]): void {
  const schema = record(schemaValue);
  if (!schema) return;
  const type = typeof schema.type === "string" ? schema.type : "";
  let typeMatches = true;
  if (type === "object") typeMatches = !!record(value);
  else if (type === "array") typeMatches = Array.isArray(value);
  else if (type === "string") typeMatches = typeof value === "string";
  else if (type === "boolean") typeMatches = typeof value === "boolean";
  else if (type === "integer") typeMatches = typeof value === "number" && Number.isInteger(value);
  else if (type === "number") typeMatches = typeof value === "number" && Number.isFinite(value);
  else if (type === "null") typeMatches = value === null;
  if (!typeMatches) {
    violations.push(`${field} must be ${type === "integer" ? "an integer" : `of type ${type}`}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    violations.push(`${field} must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`);
    return;
  }

  const numberValue = finiteNumber(value);
  const minimum = finiteNumber(schema.minimum);
  const maximum = finiteNumber(schema.maximum);
  if (numberValue !== null && minimum !== null && numberValue < minimum) {
    violations.push(`${field} must be at least ${minimum}`);
  }
  if (numberValue !== null && maximum !== null && numberValue > maximum) {
    violations.push(`${field} must be at most ${maximum}`);
  }

  if (typeof value === "string") {
    const minLength = finiteNumber(schema.minLength);
    const maxLength = finiteNumber(schema.maxLength);
    if (minLength !== null && value.length < minLength) violations.push(`${field} must contain at least ${minLength} characters`);
    if (maxLength !== null && value.length > maxLength) violations.push(`${field} must contain at most ${maxLength} characters`);
  }

  if (Array.isArray(value)) {
    const minItems = finiteNumber(schema.minItems);
    const maxItems = finiteNumber(schema.maxItems);
    if (minItems !== null && value.length < minItems) violations.push(`${field} must contain at least ${minItems} items`);
    if (maxItems !== null && value.length > maxItems) violations.push(`${field} must contain at most ${maxItems} items`);
    if (schema.items !== undefined) {
      value.forEach((item, index) => schemaViolations(item, schema.items, `${field}[${index}]`, violations));
    }
  }

  const objectValue = record(value);
  const properties = record(schema.properties);
  if (objectValue && properties) {
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(objectValue, name) && objectValue[name] !== undefined && objectValue[name] !== null) {
        schemaViolations(objectValue[name], propertySchema, `${field}.${name}`, violations);
      }
    }
  }
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
  const root = record(body);
  const missing = required.filter(field => !root
    || !Object.prototype.hasOwnProperty.call(root, field)
    || root[field] === undefined
    || root[field] === null);
  if (missing.length > 0) {
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

  const violations: string[] = [];
  if (body !== undefined && body !== null) schemaViolations(body, contract?.request_schema, "body", violations);
  if (violations.length === 0) return null;
  const invalidFields = [...new Set(violations.map((violation) => violation.match(/^body(?:\[[^\]]+\]|\.[^ ]+)*/)?.[0] || "body"))];
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
    invalid_fields: invalidFields,
    error: `POST ${path} violates the published tool contract: ${violations.join("; ")}. Inspect the exact tool contract and retry with a corrected request.`
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
