export type DynamicToolObservation = {
  server: string | null;
  tool: string;
  status: string | null;
  arguments: unknown;
  duration_ms: number | null;
  result: unknown;
  error: string | null;
  success: boolean | null;
};

export function isMissingCodexThreadError(error: unknown): boolean {
  return /thread not found/i.test(error instanceof Error ? error.message : String(error));
}

export function adaptDynamicToolCompletedItem(item: any): DynamicToolObservation | null {
  if (item?.type !== "dynamicToolCall" || typeof item.tool !== "string") return null;
  const contentItems = Array.isArray(item.contentItems) ? item.contentItems : null;
  const failureText = item.success === false && contentItems
    ? contentItems
        .filter((entry: any) => entry?.type === "inputText" && typeof entry.text === "string")
        .map((entry: any) => entry.text.trim())
        .filter(Boolean)
        .join("\n")
    : "";
  return {
    server: typeof item.namespace === "string" ? item.namespace : null,
    tool: item.tool,
    status: typeof item.status === "string" ? item.status : null,
    arguments: item.arguments ?? null,
    duration_ms: typeof item.durationMs === "number" ? item.durationMs : null,
    result: contentItems,
    error: failureText || (item.success === false ? "Dynamic tool call failed without an error body." : null),
    success: typeof item.success === "boolean" ? item.success : null
  };
}
