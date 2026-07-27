import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";

const ACTION_ID = "schedule-read-detail";
const SCHEDULE_PATH = "/revit/schedules";
const ROW_READ_TTL_MS = 5 * 60_000;
type ScheduleRowReadIntent = { scheduleName: string; entityLabel: string; rowKey: string; rowField: "Number" | "Mark"; targetField: "Name" | "Number" };
const rowReadStates = new Map<string, { intent: ScheduleRowReadIntent; expiresAt: number }>();

function response(message: string, actions: ActionCall[] = [], status?: "complete" | "failed"): ChatResponse {
  return { version: "operator.backend.v1", assistant_message: message, actions, ...(status ? { aec_query_receipt: { schema: "revit-operator.aec-query-receipt.v1" as const, terminal: true as const, status, workflow_id: "query.schedule_detail", bounded: true as const, broadened: false as const } } : {}) };
}
function explicitScheduleId(value: string): number | null { const match = value.match(/\bschedule\b(?:(?![.!?\r\n]).){0,64}?\b(?:id|#)\s*[:#]?\s*(\d{1,15})\b/i); if (!match) return null; const id = Number(match[1]); return Number.isSafeInteger(id) && id > 0 ? id : null; }
function isReadRequest(value: string): boolean { const affirmative = value.replace(/\b(?:do\s+not|don't|without)\s+(?:change|update|edit|set|replace|rename|delete|remove|add|create|apply|write)(?:ing)?\b/gi, ""); return !/\b(change|update|edit|set|replace|rename|delete|remove|add|create|apply|write)\b/i.test(affirmative) && /\b(inspect|read|report|return|list|count|summari[sz]e|show|display|what|how\s+many|column|row|heading|field|value|data)\b/i.test(value); }
function toolResult(req: ChatRequest): ToolResult | undefined { return req.tool_results?.find(item => item.action_id === ACTION_ID && item.method === "POST" && item.path === SCHEDULE_PATH); }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function integer(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }
function cellText(value: unknown): string { return value === null || value === undefined ? "" : String(value).trim(); }
function inline(value: string): string { return `\`${value.replace(/`/g, "'")}\``; }
function normalizedHeading(value: string): string { return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ""); }
function purgeRowReadStates(): void { const now = Date.now(); for (const [key, value] of rowReadStates) if (value.expiresAt <= now) rowReadStates.delete(key); }
function authoritativeUserText(req: ChatRequest): string { const context = record(req.context), ui = record(context?.ui); return text(ui?.authoritative_user_text) || (req.user_text || "").trim(); }
function scheduleRowReadIntent(value: string): ScheduleRowReadIntent | null {
  if (!isReadRequest(value)) return null;
  const scheduleName = value.match(/\b(?:in|on)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 &/._-]*?\s+Schedule)\b/i)?.[1]?.trim();
  const entity = value.match(/\b(space|room|item|equipment|device)\s+(?:number\s+)?([A-Za-z0-9][A-Za-z0-9._\/-]*)\b/i);
  if (!scheduleName || !entity) return null;
  const targetField = /\b(?:named|name|called)\b/i.test(value) ? "Name" : /\b(?:numbered|number)\b/i.test(value) ? "Number" : null;
  if (!targetField) return null;
  const entityLabel = entity[1]![0]!.toLocaleUpperCase() + entity[1]!.slice(1).toLocaleLowerCase();
  return { scheduleName, entityLabel, rowKey: entity[2]!.trim(), rowField: ["space", "room"].includes(entity[1]!.toLocaleLowerCase()) ? "Number" : "Mark", targetField };
}
function summarizeRow(result: ToolResult, intent: ScheduleRowReadIntent): ChatResponse {
  if (result.status !== "done") return response(`I could not read ${intent.entityLabel} ${intent.rowKey} in ${intent.scheduleName}: ${result.error || "the bounded Revit schedule read failed"}. No model changes were made.`, [], "failed");
  const data = record(result.result_json), schedule = record(data?.schedule), table = record(data?.table), body = record(table?.body);
  const fields = Array.isArray(data?.fields) ? data.fields.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const headings = fields.map(item => text(item.heading) || text(item.name)).filter(Boolean);
  const rawRows = Array.isArray(body?.rows) ? body.rows.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const rows = rawRows.map(item => Array.isArray(item.cells) ? item.cells.map(cellText) : []), returnedRows = integer(body?.returnedRows);
  if (body?.hasMoreRows !== false || returnedRows === null || rows.length !== returnedRows) return response(`I could not prove a complete row lookup for ${intent.entityLabel} ${intent.rowKey} in ${intent.scheduleName}; the bounded schedule result was incomplete. No model changes were made.`, [], "failed");
  const rowIndex = headings.findIndex(heading => normalizedHeading(heading) === normalizedHeading(intent.rowField)), targetIndex = headings.findIndex(heading => normalizedHeading(heading) === normalizedHeading(intent.targetField));
  if (rowIndex < 0 || targetIndex < 0) return response(`I found ${intent.scheduleName}, but it does not expose both ${intent.rowField} and ${intent.targetField} as displayed columns. No model changes were made.`, [], "failed");
  const firstMatchesHeadings = rows.length > 0 && headings.filter((heading, index) => normalizedHeading(rows[0]?.[index] || "") === normalizedHeading(heading)).length >= Math.min(2, headings.length);
  const dataRows = firstMatchesHeadings ? rows.slice(1) : rows, matches = dataRows.filter(row => (row[rowIndex] || "").toLocaleLowerCase() === intent.rowKey.toLocaleLowerCase());
  if (matches.length !== 1) { const reason = matches.length === 0 ? "was not present" : `matched ${matches.length} displayed rows`; return response(`${intent.entityLabel} ${intent.rowKey} ${reason} in ${intent.scheduleName}, so I did not guess a value. No model changes were made.`, [], matches.length === 0 ? "complete" : "failed"); }
  const observed = matches[0]?.[targetIndex] || "";
  if (!observed) return response(`${intent.entityLabel} ${intent.rowKey} has a blank ${intent.targetField} in ${intent.scheduleName}. No model changes were made.`, [], "complete");
  return response(`${intent.entityLabel} ${intent.rowKey} — ${intent.targetField}: ${inline(observed)} in ${inline(text(schedule?.name) || intent.scheduleName)}. No model changes were made.`, [], "complete");
}
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
export function maybeRunDeterministicScheduleRead(req: ChatRequest): ChatResponse | null {
  purgeRowReadStates(); const continuation = toolResult(req), rowReadState = rowReadStates.get(req.session_id);
  if (continuation && rowReadState) { rowReadStates.delete(req.session_id); return summarizeRow(continuation, rowReadState.intent); }
  if (continuation) return summarize(continuation); if ((req.tool_results?.length ?? 0) > 0) return null;
  const userText = authoritativeUserText(req), rowIntent = scheduleRowReadIntent(userText);
  if (rowIntent) { rowReadStates.set(req.session_id, { intent: rowIntent, expiresAt: Date.now() + ROW_READ_TTL_MS }); return response(`I’m reading ${rowIntent.entityLabel} ${rowIntent.rowKey} from ${rowIntent.scheduleName} in one bounded, read-only call.`, [{ action_id: ACTION_ID, method: "POST", path: SCHEDULE_PATH, body: { action: "detail", query: rowIntent.scheduleName, exact: true, requireUniqueQuery: true, includeFields: true, includeData: true, maxRows: 500, maxColumns: 100 } }]); }
  const scheduleId = explicitScheduleId(userText); if (scheduleId === null || !isReadRequest(userText)) return null;
  return response("I’m reading that exact schedule directly from live Revit in one bounded, read-only call.", [{ action_id: ACTION_ID, method: "POST", path: SCHEDULE_PATH, body: { action: "detail", scheduleId, exact: false, includeFields: true, includeData: true, maxRows: 500, maxColumns: 100 } }]);
}
export function __testOnlyClearScheduleReadStates(): void { rowReadStates.clear(); }
