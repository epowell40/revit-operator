import type { ToolResult } from "./contracts.js";
import { appendEvent } from "./memory/sqlite_store.js";
import { describeVisibleElementsInventory } from "./tool_result_compaction.js";

function summarizeFailureAttachments(attachments: ToolResult["attachments"] | undefined): { total: number; image_count: number } | null {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return null;
  const imageCount = list.filter(a => a && typeof a === "object" && (a as any).kind === "image").length;
  return { total: list.length, image_count: imageCount };
}

export function appendToolFailureEvent(sessionId: string, messageId: string, r: ToolResult): void {
  if (r.status !== "failed") return;
  const attachmentSummary = summarizeFailureAttachments(r.attachments);
  appendEvent(sessionId, "assistant", "tool.failure", {
    message_id: messageId,
    action_id: r.action_id,
    method: r.method,
    path: r.path,
    status: r.status,
    ...(typeof r.error === "string" && r.error.trim() ? { error: r.error.trim() } : {}),
    ...(typeof r.failure_kind === "string" && r.failure_kind.trim() ? { failure_kind: r.failure_kind.trim() } : {}),
    ...(typeof r.failure_code === "string" && r.failure_code.trim() ? { failure_code: r.failure_code.trim() } : {}),
    ...(typeof r.failure_hint === "string" && r.failure_hint.trim() ? { failure_hint: r.failure_hint.trim() } : {}),
    ...(typeof r.duration_ms === "number" ? { duration_ms: Math.round(r.duration_ms) } : {}),
    ...(attachmentSummary ? { attachments: attachmentSummary } : {})
  });
}

export function summarizeToolResult(r: ToolResult): string {
  const bits = [`${r.status.toUpperCase()} ${r.method} ${r.path} (action_id=${r.action_id})`];
  if (typeof r.duration_ms === "number") bits.push(`duration_ms=${Math.round(r.duration_ms)}`);
  if (r.error) bits.push(`error=${r.error}`);
  if (r.failure_code) bits.push(`failure_code=${r.failure_code}`);
  if (r.failure_kind) bits.push(`failure_kind=${r.failure_kind}`);
  const attachments = r.attachments ?? [];
  const imageCount = attachments.filter(a => a && typeof a === "object" && (a as any).kind === "image").length;
  if (imageCount > 0) bits.push(`attachments=image(${imageCount})`);

  try {
    if (r.path === "/revit/quantify" && r.result_json && typeof r.result_json === "object") {
      const result = r.result_json as any;
      if (typeof result?.summary?.total === "number") bits.push(`total=${result.summary.total}`);
      const resultSetId = typeof result?.resultSetId === "string" ? result.resultSetId.trim() : "";
      if (resultSetId) bits.push(`resultSetId=${resultSetId.slice(0, 12)}…`);
      const groups = result?.summary?.groups;
      if (groups && typeof groups === "object") {
        const entries = Object.entries(groups as Record<string, unknown>)
          .filter(([, value]) => typeof value === "number")
          .sort((a, b) => (b[1] as number) - (a[1] as number))
          .slice(0, 5);
        if (entries.length > 0) bits.push(`top_groups=${entries.map(([key, value]) => `${key}:${value}`).join(",")}`);
      }
    }
    if (["/revit/export-image", "/revit/export-view-frame", "/revit/export-view-region", "/revit/export-visible-elements",
      "/revit/highlight-and-export", "/revit/mep-route-workflow"].includes(r.path)
      && r.result_json && typeof r.result_json === "object") {
      const result = r.result_json as any;
      if (typeof result.path === "string") bits.push(`path=${result.path}`);
      if (typeof result?.visualVerification?.capture?.path === "string") bits.push(`path=${result.visualVerification.capture.path}`);
    }
    if (r.path === "/revit/export-visible-elements") {
      const inventory = describeVisibleElementsInventory(r.result_json);
      if (inventory?.count !== null && inventory?.count !== undefined) bits.push(`count=${inventory.count}`);
      if (inventory?.sampled) bits.push(`sampled=${inventory.sampled}`);
      if (inventory?.topCategories.length) bits.push(`top_categories=${inventory.topCategories.slice(0, 3).join(",")}`);
      if (inventory?.topRooms.length) bits.push(`top_rooms=${inventory.topRooms.slice(0, 3).join(",")}`);
    }
  } catch {
    // Diagnostic summarization never changes tool settlement.
  }
  return bits.join(" | ");
}
