import type { ToolResult } from "../contracts.js";
import { assembleBoundedEvidenceContext } from "../evidence/model_context_budget.js";
import { compactIncomingToolResult } from "../tool_result_compaction.js";

function truncateForCodex(value: string, maxChars = 1600): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…(truncated)`;
}

function summarizeResultJsonForCodex(result: ToolResult): string | null {
  try {
    const resultJson = compactIncomingToolResult(result).result_json;
    if (resultJson === undefined) return null;
    const path = (result.path ?? "").trim().toLowerCase();
    const includeJson = new Set([
      "/revit/export-visible-elements", "/revit/export-view-frame", "/revit/export-view-region",
      "/revit/pick-candidate-cluster", "/revit/get-placement-context", "/revit/resolve-room-wall",
      "/revit/project-point-to-host-frame", "/revit/mep-route-workflow", "/revit/mep-branch-network-workflow",
      "/revit/edit-mep-route-elements", "/revit/reroute-mep-route-segment",
      "/revit/audit-hosted-instance-placement", "/tools/redline/verify-visual"
    ]).has(path);
    if (!includeJson) return null;
    const raw = JSON.stringify(resultJson);
    return raw ? truncateForCodex(raw) : null;
  } catch {
    return null;
  }
}

export function formatToolResultsForCodex(
  toolResults: ToolResult[] | undefined,
  telemetry?: { session_id: string; assignment_id?: string | null; model_call_id?: string | null }
): string {
  const list = Array.isArray(toolResults) ? toolResults : [];
  if (list.length === 0) return "";
  const lines = ["Tool results (this step):"];
  let index = 0;
  for (const result of list) {
    index++;
    if (index > 12) {
      lines.push(`- … (${list.length - 12} more tool results)`);
      break;
    }
    if (!result || typeof result !== "object") continue;
    lines.push(`- [${index}] ${String(result.status || "").toUpperCase()} ${result.method} ${result.path} (action_id=${result.action_id})`);
    const failureCode = typeof result.failure_code === "string" ? result.failure_code.trim() : "";
    if (failureCode) lines.push(`  - failure_code: ${failureCode}`);
    const projections = Array.isArray(result.evidence_projections) ? result.evidence_projections : [];
    if (projections.length > 0) {
      const bounded = telemetry
        ? assembleBoundedEvidenceContext({ projections, ...telemetry, source: "codex_tool_results" })
        : { projections, omitted: 0 };
      for (const projection of bounded.projections) lines.push(`  - evidence: ${JSON.stringify(projection)}`);
      if (bounded.omitted > 0) lines.push(`  - evidence_budget: ${bounded.omitted} projection(s) omitted; retrieve a named evidence_id with a focused selector if needed.`);
      continue;
    }
    const images = (Array.isArray(result.attachments) ? result.attachments : [])
      .filter(attachment => attachment && typeof attachment === "object" && (attachment as any).kind === "image");
    for (const attachment of images.slice(0, 3)) {
      const localPath = typeof (attachment as any).local_path === "string" ? (attachment as any).local_path.trim() : "";
      const filename = typeof (attachment as any).filename === "string" ? (attachment as any).filename.trim() : "";
      const mime = typeof (attachment as any).mime === "string" ? (attachment as any).mime.trim() : "";
      if (localPath) lines.push(`  - image: ${filename || localPath} (local_path=${localPath}${mime ? `, mime=${mime}` : ""})`);
      else if (filename) lines.push(`  - image: ${filename}${mime ? ` (mime=${mime})` : ""}`);
    }
    const summary = summarizeResultJsonForCodex(result);
    if (summary) lines.push(`  - result_json: ${summary}`);
  }
  return lines.join("\n");
}
