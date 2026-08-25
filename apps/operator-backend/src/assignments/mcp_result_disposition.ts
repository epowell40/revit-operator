type JsonMap = Record<string, unknown>;

export type McpResultDisposition = {
  is_error: boolean;
  proven_before_native_dispatch: boolean;
  failure_code: string | null;
  failure_kind: string | null;
  reason: string | null;
};

function object(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : null;
}

function boundedText(value: unknown, max = 2_000): string {
  if (typeof value === "string") return value.trim().slice(0, max);
  try { return JSON.stringify(value).slice(0, max); } catch { return ""; }
}

function protocolErrorCode(value: unknown): number | string | null {
  const row = object(value);
  if (!row) return null;
  if ((typeof row.code === "number" || typeof row.code === "string") && `${row.code}`.trim()) return row.code;
  const error = object(row.error);
  return error && (typeof error.code === "number" || typeof error.code === "string") && `${error.code}`.trim()
    ? error.code : null;
}

function resultText(value: unknown): string {
  const row = object(value);
  if (!row) return boundedText(value);
  const content = Array.isArray(row.content) ? row.content.flatMap(item => {
    const part = object(item);
    return part && typeof part.text === "string" ? [part.text] : [];
  }).join(" ") : "";
  return `${boundedText(row.error)} ${boundedText(row.message)} ${content}`.trim().slice(0, 4_000);
}

/**
 * Classifies only the MCP protocol boundary. An MCP CallToolResult may report
 * `isError` after its tool has already reached Revit, so generic tool errors
 * remain dispatch-uncertain. JSON-RPC -32602 input validation is different:
 * the MCP SDK rejects it before invoking the registered tool handler and is
 * therefore authoritative proof that no native dispatch occurred.
 */
export function classifyMcpResultDisposition(value: unknown): McpResultDisposition {
  const row = object(value);
  if (row?.isError !== true) {
    return { is_error: false, proven_before_native_dispatch: false, failure_code: null, failure_kind: null, reason: null };
  }
  const code = protocolErrorCode(value);
  const detail = resultText(value);
  const invalidParams = `${code}` === "-32602"
    || (/\bMCP error\s+-32602\b/i.test(detail)
      && /\b(?:input validation error|invalid arguments for tool)\b/i.test(detail));
  return invalidParams ? {
    is_error: true,
    proven_before_native_dispatch: true,
    failure_code: "mcp_invalid_params_-32602",
    failure_kind: "schema_rejection_before_dispatch",
    reason: detail || "MCP rejected invalid tool arguments before invoking the tool handler."
  } : {
    is_error: true,
    proven_before_native_dispatch: false,
    failure_code: "mcp_tool_error",
    failure_kind: "tool_result_error",
    reason: detail || "MCP tool returned an error result."
  };
}
