import type { ToolResult } from "./contracts.js";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" && value.length <= max ? value.trim() : "";
}

export function resultSucceeded(result: ToolResult): boolean {
  if (result.status !== "done") return false;
  const body = objectValue(result.result_json);
  return body.ok !== false && body.success !== false;
}

export function mcpResultSucceeded(result: unknown): boolean {
  const root = objectValue(result);
  if (root.isError === true) return false;
  const rootError = boundedString(root.error, 4_000);
  if (rootError && root.ok !== true && root.success !== true) return false;
  const content = Array.isArray(root.content) ? root.content : [];
  for (const item of content) {
    const text = boundedString(objectValue(item).text, 2_000_000);
    if (!text) continue;
    if (/^(?:RevitCourierError|OperatorToolUserError|Error):|^\[(?:teammate_loop_blocked|revit_tool_quarantined|assignment_(?:paused|blocked))\]/i.test(text.trim())) return false;
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    try {
      const parsed = objectValue(JSON.parse(text));
      if (parsed.ok === false || parsed.success === false) return false;
    } catch {}
  }
  return true;
}
