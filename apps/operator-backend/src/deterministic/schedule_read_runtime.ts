import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";

const ACTION_ID = "schedule-read-detail";
const SCHEDULE_PATH = "/revit/schedules";

function response(message: string, actions: ActionCall[] = [], status?: "complete" | "failed"): ChatResponse {
  return { version: "operator.backend.v1", assistant_message: message, actions, ...(status ? { aec_query_receipt: { schema: "revit-operator.aec-query-receipt.v1" as const, terminal: true as const, status, workflow_id: "query.schedule_detail", bounded: true as const, broadened: false as const } } : {}) };
}
function explicitScheduleId(value: string): number | null { const match = value.match(/\bschedule\b(?:(?![.!?\r\n]).){0,64}?\b(?:id|#)\s*[:#]?\s*(\d{1,15})\b/i); if (!match) return null; const id = Number(match[1]); return Number.isSafeInteger(id) && id > 0 ? id : null; }
function isReadRequest(value: string): boolean { return !/\b(change|update|edit|set|replace|rename|delete|remove|add|create|apply|write)\b/i.test(value) && /\b(inspect|read|report|return|list|count|summari[sz]e|show|display|what|how\s+many|column|row|heading|field|value|data)\b/i.test(value); }
function toolResult(req: ChatRequest): ToolResult | undefined { return req.tool_results?.find(item => item.action_id === ACTION_ID && item.method === "POST" && item.path === SCHEDULE_PATH); }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function integer(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }
function cellText(value: unknown): string { return value === null || value === undefined ? "" : String(value).trim(); }
function inline(value: string): string { return `\`${value.replace(/`/g, "'")}\``; }
function normalizedHeading(value: string): string { return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ""); }
function summarize(result: ToolResult): ChatResponse {
  if (result.status !== "done") return response(`I could not read the requested schedule: ${result.error || "the bounded Revit schedule read failed"}. No model changes were made.`, [], "failed");
  const data = record(result.result_json), schedule = record(data?.schedule), table = record(data?.table), body = record(table?.body);
  const fields = Array.isArray(data?.fields) ? data.fields.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const headings = fields.map(item => text(item.heading) || text(item.name)).filter(Boolean);
  const rawRows = Array.isArray(body?.rows) ? body.rows.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const rows = rawRows.map(item => Array.isArray(item.cells) ? item.cells.map(cellText) : []), totalRows = integer(body?.totalRows), returnedRows = integer(body?.returnedRows);
  const completeRows = body?.hasMoreRows === false && returnedRows !== null && rows.length === returnedRows;
  const firstMatchesHeadings = headings.length > 0 && rows.length > 0 && headings.filter((heading, index) => normalizedHeading(rows[0]?.[index] || "") === normalizedHeading(heading)).length >= Math.min(2, headings.length);
  const candidateDataRows = firstMatchesHeadings ? rows.slice(1) : rows, nonblankDataRows = completeRows ? candidateDataRows.filter(row => row.some(Boolean)) : [], blankRows = completeRows ? candidateDataRows.length - nonblankDataRows.length : 0;
  const scheduleId = integer(schedule?.id), scheduleName = text(schedule?.name) || "requested schedule";
  const parts = [`Schedule ${inline(scheduleName)}${scheduleId !== null ? ` (ID ${inline(String(scheduleId))})` : ""}.`];
  if (totalRows !== null) parts.push(`Revit Body totalRows: **${totalRows}**.`);
  if (completeRows) parts.push(`Nonblank data rows: **${nonblankDataRows.length}** (excluded ${firstMatchesHeadings ? "1 column-heading row" : "0 heading rows"}${blankRows ? ` and ${blankRows} wholly blank row${blankRows === 1 ? "" : "s"}` : ""} from the complete returned Body rows).`);
  if (headings.length) parts.push(`Column headings (${headings.length}): ${headings.map(inline).join(", ")}.`);
  const designationIndex = headings.findIndex(heading => ["desig", "designation"].includes(normalizedHeading(heading)));
  if (designationIndex >= 0 && completeRows) { const values = candidateDataRows.map(row => row[designationIndex] || "").filter(Boolean).slice(0, 2); if (values.length) parts.push(`First ${values.length} nonblank ${inline(headings[designationIndex]!)} value${values.length === 1 ? "" : "s"}: ${values.map(inline).join(", ")}.`); }
  parts.push("Read-only live Revit inspection completed; no model changes were made."); return response(parts.join(" "), [], "complete");
}
export function maybeRunDeterministicScheduleRead(req: ChatRequest): ChatResponse | null { const continuation = toolResult(req); if (continuation) return summarize(continuation); if ((req.tool_results?.length ?? 0) > 0) return null; const userText = (req.user_text || "").trim(), scheduleId = explicitScheduleId(userText); if (scheduleId === null || !isReadRequest(userText)) return null; return response("I’m reading that exact schedule directly from live Revit in one bounded, read-only call.", [{ action_id: ACTION_ID, method: "POST", path: SCHEDULE_PATH, body: { action: "detail", scheduleId, exact: false, includeFields: true, includeData: true, maxRows: 500, maxColumns: 100 } }]); }
