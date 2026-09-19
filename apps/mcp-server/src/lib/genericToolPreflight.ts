import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";

export type GenericToolContract = {
  method?: string;
  path?: string;
  required_fields?: string[];
  request_schema?: unknown;
  input_schema_id?: string;
};

export type GenericToolValidationIssue = {
  field_path: string;
  expected_type: string;
  actual_type: string;
  safe_correction_eligibility: "provider_corrected_arguments_required" | "declared_deterministic_coercion";
  correction_action: "provider_resubmit" | "wrap_scalar_as_singleton_array";
  expected_constraint: Readonly<{
    kind: "required" | "json_type" | "enum" | "numeric_range" | "string_length" | "array_length" | "property_set" | "schema_depth" | "schema_bounds" | "schema_alternative";
    type?: string;
    allowed_values?: readonly (string | number | boolean | null)[];
    minimum?: number;
    maximum?: number;
    min_length?: number;
    max_length?: number;
    min_items?: number;
    max_items?: number;
  }>;
  message: string;
};

const MAX_VALIDATION_ISSUES = 64;
const MAX_SCHEMA_DEPTH = 24;
const MAX_FIELD_PATH_LENGTH = 512;
const MAX_SCHEMA_VISITS = 100_000;
const MAX_SCHEMA_ALTERNATIVES = 16;
type ValidationBudget = { remaining: number; exhausted: boolean };

function boundedScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value.slice(0, 256);
  return undefined;
}

function pushIssue(issues: GenericToolValidationIssue[], issue: GenericToolValidationIssue): void {
  if (issues.length >= MAX_VALIDATION_ISSUES) return;
  issues.push({
    ...issue,
    field_path: issue.field_path.slice(0, MAX_FIELD_PATH_LENGTH),
    message: issue.message.slice(0, 2_000)
  });
}

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
  input_schema_id?: string;
  input_schema_digest?: string;
  validation_issues?: GenericToolValidationIssue[];
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

function actualType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function schemaViolations(value: unknown, schemaValue: unknown, field: string, violations: GenericToolValidationIssue[], depth: number, budget: ValidationBudget): void {
  if (budget.remaining-- <= 0) { budget.exhausted = true; return; }
  if (field.length > MAX_FIELD_PATH_LENGTH) { budget.exhausted = true; return; }
  if (violations.length >= MAX_VALIDATION_ISSUES) return;
  if (depth > MAX_SCHEMA_DEPTH) {
    budget.exhausted = true;
    pushIssue(violations, {
      field_path: field,
      expected_type: `schema_depth<=${MAX_SCHEMA_DEPTH}`,
      actual_type: "schema_depth_exceeded",
      safe_correction_eligibility: "provider_corrected_arguments_required",
      correction_action: "provider_resubmit",
      expected_constraint: { kind: "schema_depth" },
      message: `${field} exceeds the bounded schema validation depth`
    });
    return;
  }
  const schema = record(schemaValue);
  if (!schema) return;
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    if (schema[keyword] === undefined) continue;
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives) || alternatives.length === 0 || alternatives.length > MAX_SCHEMA_ALTERNATIVES) {
      budget.exhausted = true; return;
    }
    const results: GenericToolValidationIssue[][] = [];
    for (const alternative of alternatives) {
      if (!record(alternative)) { budget.exhausted = true; return; }
      const issues: GenericToolValidationIssue[] = [];
      schemaViolations(value, alternative, field, issues, depth + 1, budget);
      results.push(issues);
      if (budget.exhausted) return;
    }
    const matches = results.filter(issues => issues.length === 0).length;
    if (keyword === "allOf") {
      for (const issues of results) for (const issue of issues) pushIssue(violations, issue);
    } else if (keyword === "oneOf" ? matches !== 1 : matches === 0) {
      const descriptions = alternatives.map(alternative => {
        const row = record(alternative)!;
        return (Array.isArray(row.required) ? `required: ${row.required.join(", ")}` : `type: ${row.type ?? "schema-defined"}`).slice(0, 256);
      });
      pushIssue(violations, {
        field_path: field, expected_type: keyword === "oneOf" ? "exactly_one_schema" : "at_least_one_schema",
        actual_type: actualType(value), safe_correction_eligibility: "provider_corrected_arguments_required",
        correction_action: "provider_resubmit", expected_constraint: { kind: "schema_alternative", type: keyword, allowed_values: descriptions },
        message: `${field} must satisfy ${keyword === "oneOf" ? "exactly one" : "at least one"} published alternative (${descriptions.join("; ")}); matched ${matches}`
      });
      // Nullable objects should explain the actual nested error (for example
      // body.limit > 2000). Only one explicitly typed structural branch may
      // contribute details; never guess between overlapping object variants.
      if (matches === 0) {
        const matchingTypes = alternatives.map((alternative, index) => ({type:record(alternative)!.type,index}))
          .filter(({type}) => typeof type === 'string' && (type === actualType(value)
            || type === 'number' && actualType(value) === 'integer'));
        if (matchingTypes.length === 1) for (const issue of results[matchingTypes[0]!.index]!) pushIssue(violations, issue);
      }
    }
  }
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
    const message = `${field} must be ${type === "integer" ? "an integer" : `of type ${type}`}`;
    pushIssue(violations, {
      field_path: field,
      expected_type: type || "schema-defined",
      actual_type: actualType(value),
      safe_correction_eligibility: schema["x-operator-scalar-to-array"] === true
        ? "declared_deterministic_coercion"
        : "provider_corrected_arguments_required",
      correction_action: schema["x-operator-scalar-to-array"] === true && type === "array"
        ? "wrap_scalar_as_singleton_array"
        : "provider_resubmit",
      expected_constraint: { kind: "json_type", ...(type ? { type } : {}) },
      message
    });
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    const message = `${field} must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`;
    pushIssue(violations, {
      field_path: field, expected_type: "enum", actual_type: actualType(value),
      safe_correction_eligibility: "provider_corrected_arguments_required", correction_action: "provider_resubmit",
      expected_constraint: {
        kind: "enum",
        allowed_values: schema.enum.map(boundedScalar).filter((candidate): candidate is string | number | boolean | null => candidate !== undefined).slice(0, 32)
      },
      message
    });
    return;
  }

  const numberValue = finiteNumber(value);
  const minimum = finiteNumber(schema.minimum);
  const maximum = finiteNumber(schema.maximum);
  if (numberValue !== null && minimum !== null && numberValue < minimum) {
    const message = `${field} must be at least ${minimum}`;
    pushIssue(violations, { field_path: field, expected_type: `minimum:${minimum}`, actual_type: actualType(value), safe_correction_eligibility: "provider_corrected_arguments_required", correction_action: "provider_resubmit", expected_constraint: { kind: "numeric_range", minimum, ...(maximum !== null ? { maximum } : {}) }, message });
  }
  if (numberValue !== null && maximum !== null && numberValue > maximum) {
    const message = `${field} must be at most ${maximum}`;
    pushIssue(violations, { field_path: field, expected_type: `maximum:${maximum}`, actual_type: actualType(value), safe_correction_eligibility: "provider_corrected_arguments_required", correction_action: "provider_resubmit", expected_constraint: { kind: "numeric_range", ...(minimum !== null ? { minimum } : {}), maximum }, message });
  }

  if (typeof value === "string") {
    const minLength = finiteNumber(schema.minLength);
    const maxLength = finiteNumber(schema.maxLength);
    if (minLength !== null && value.length < minLength) {
      const message = `${field} must contain at least ${minLength} characters`;
      pushIssue(violations, { field_path: field, expected_type: `minLength:${minLength}`, actual_type: "string", safe_correction_eligibility: "provider_corrected_arguments_required", correction_action: "provider_resubmit", expected_constraint: { kind: "string_length", min_length: minLength, ...(maxLength !== null ? { max_length: maxLength } : {}) }, message });
    }
    if (maxLength !== null && value.length > maxLength) {
      const message = `${field} must contain at most ${maxLength} characters`;
      pushIssue(violations, { field_path: field, expected_type: `maxLength:${maxLength}`, actual_type: "string", safe_correction_eligibility: "provider_corrected_arguments_required", correction_action: "provider_resubmit", expected_constraint: { kind: "string_length", ...(minLength !== null ? { min_length: minLength } : {}), max_length: maxLength }, message });
    }
  }

  if (Array.isArray(value)) {
    const minItems = finiteNumber(schema.minItems);
    const maxItems = finiteNumber(schema.maxItems);
    if (minItems !== null && value.length < minItems) {
      const message = `${field} must contain at least ${minItems} items`;
      pushIssue(violations, { field_path: field, expected_type: `minItems:${minItems}`, actual_type: "array", safe_correction_eligibility: "provider_corrected_arguments_required", correction_action: "provider_resubmit", expected_constraint: { kind: "array_length", min_items: minItems, ...(maxItems !== null ? { max_items: maxItems } : {}) }, message });
    }
    if (maxItems !== null && value.length > maxItems) {
      const message = `${field} must contain at most ${maxItems} items`;
      pushIssue(violations, { field_path: field, expected_type: `maxItems:${maxItems}`, actual_type: "array", safe_correction_eligibility: "provider_corrected_arguments_required", correction_action: "provider_resubmit", expected_constraint: { kind: "array_length", ...(minItems !== null ? { min_items: minItems } : {}), max_items: maxItems }, message });
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length && !budget.exhausted && violations.length < MAX_VALIDATION_ISSUES; index++)
        schemaViolations(value[index], schema.items, `${field}[${index}]`, violations, depth + 1, budget);
    }
  }

  const objectValue = record(value);
  const properties = record(schema.properties) ?? (schema.additionalProperties === false ? {} : null);
  if (objectValue && Array.isArray(schema.required)) {
    if (schema.required.length > MAX_VALIDATION_ISSUES || schema.required.some(name => typeof name !== "string" || name.length > MAX_FIELD_PATH_LENGTH - 5)) {
      budget.exhausted = true; return;
    }
    for (const name of schema.required as string[]) {
      if (!Object.prototype.hasOwnProperty.call(objectValue, name) || objectValue[name] === undefined) {
        pushIssue(violations, { field_path: `${field}.${name}`, expected_type: "present", actual_type: "missing",
          safe_correction_eligibility: "provider_corrected_arguments_required", correction_action: "provider_resubmit",
          expected_constraint: { kind: "required" }, message: `${field}.${name} is required` });
      }
    }
  }
  if (objectValue && properties) {
    if (schema.additionalProperties === false) {
      const allowed = Object.keys(properties).sort();
      for (const name of Object.keys(objectValue).filter((candidate) => !Object.prototype.hasOwnProperty.call(properties, candidate)).sort()) {
        pushIssue(violations, {
          field_path: `${field}.${name}`,
          expected_type: "declared_property",
          actual_type: "unknown_property",
          safe_correction_eligibility: "provider_corrected_arguments_required",
          correction_action: "provider_resubmit",
          expected_constraint: { kind: "property_set", allowed_values: allowed.slice(0, 32) },
          message: `${field}.${name} is not a declared property`
        });
      }
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (budget.exhausted || violations.length >= MAX_VALIDATION_ISSUES) break;
      if (Object.prototype.hasOwnProperty.call(objectValue, name) && objectValue[name] !== undefined) {
        schemaViolations(objectValue[name], propertySchema, `${field}.${name}`, violations, depth + 1, budget);
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
  const inputSchemaId = contract?.input_schema_id?.trim() || `operator-native/POST:${path}/input/v1`;
  const inputSchemaDigest = payloadDigestV2({
    method: "POST",
    path,
    required_fields: required,
    request_schema: contract?.request_schema ?? null
  }).digest;
  if (required.length > MAX_VALIDATION_ISSUES || required.some(field => field.length > MAX_FIELD_PATH_LENGTH - 5)) {
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
      invalid_fields: ["body"],
      input_schema_id: inputSchemaId,
      input_schema_digest: inputSchemaDigest,
      validation_issues: [{
        field_path: "body",
        expected_type: `required_fields<=${MAX_VALIDATION_ISSUES};field_path<=${MAX_FIELD_PATH_LENGTH}`,
        actual_type: "schema_contract_out_of_bounds",
        safe_correction_eligibility: "provider_corrected_arguments_required",
        correction_action: "provider_resubmit",
        expected_constraint: { kind: "schema_bounds" },
        message: "The published input contract exceeds bounded schema-diagnostic limits."
      }],
      error: "The published input contract exceeds bounded schema-diagnostic limits. Refresh or repair the capability contract before retrying."
    };
  }
  const missing = required.filter(field => !root
    || !Object.prototype.hasOwnProperty.call(root, field)
    || root[field] === undefined
    || (root[field] === null && record(record(contract?.request_schema)?.properties)?.[field] === undefined));
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
      invalid_fields: missing.map(field => `body.${field}`),
      input_schema_id: inputSchemaId,
      input_schema_digest: inputSchemaDigest,
      validation_issues: missing.slice(0, MAX_VALIDATION_ISSUES).map(field => ({
        field_path: `body.${field}`,
        expected_type: "required",
        actual_type: "missing",
        safe_correction_eligibility: "provider_corrected_arguments_required",
        correction_action: "provider_resubmit",
        expected_constraint: { kind: "required" as const },
        message: `body.${field} is required`
      })),
      error: `POST ${path} is missing required ${noun}: ${missing.join(", ")}. Inspect the exact tool contract and retry with a corrected request.`.slice(0, 2_000)
    };
  }

  const violations: GenericToolValidationIssue[] = [];
  const budget: ValidationBudget = { remaining: MAX_SCHEMA_VISITS, exhausted: false };
  schemaViolations(body === undefined ? {} : body, contract?.request_schema, "body", violations, 0, budget);
  if (budget.exhausted) {
    violations.splice(0, violations.length, { field_path: "body", expected_type: "bounded_schema_validation", actual_type: "schema_contract_out_of_bounds",
      safe_correction_eligibility: "provider_corrected_arguments_required", correction_action: "provider_resubmit",
      expected_constraint: { kind: "schema_bounds" }, message: "The published input contract exceeds bounded validation work or alternative limits." });
  }
  if (violations.length === 0) return null;
  const invalidFields = [...new Set(violations.map((violation) => violation.field_path))];
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
    input_schema_id: inputSchemaId,
    input_schema_digest: inputSchemaDigest,
    validation_issues: violations,
    error: `POST ${path} violates the published tool contract: ${violations.map((violation) => violation.message).join("; ")}. Inspect the exact tool contract and retry with a corrected request.`
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
