import type { ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { interpretAecSemanticTask, type AecSemanticTaskInterpreter } from "../aec_semantic_task_interpreter.js";
import type { AecSemanticTaskV1 } from "../aec_semantic_task.js";
import { continueExactIdentifierQuery, planAecQueryTask, type AecQueryPlanV1, type AecQueryWorkflowId } from "./aec_query_plan.js";

type QueryState = { task: AecSemanticTaskV1; workflow_id: AecQueryWorkflowId; stage: number; evidence: Record<string, unknown>; expires_at: number };
type QueryReceiptStatus = NonNullable<ChatResponse["aec_query_receipt"]>["status"];
const states = new Map<string, QueryState>();
const TTL_MS = 5 * 60_000;

function purge(now = Date.now()): void { for (const [key, state] of states) if (state.expires_at <= now) states.delete(key); }
function key(req: ChatRequest): string { return req.session_id; }
function response(message: string, actions: ChatResponse["actions"] = [], receipt?: { workflow_id: AecQueryWorkflowId; status: QueryReceiptStatus }): ChatResponse {
  return {
    version: "operator.backend.v1",
    assistant_message: message,
    actions,
    ...(receipt ? { aec_query_receipt: { schema: "revit-operator.aec-query-receipt.v1" as const, terminal: true as const, status: receipt.status, workflow_id: receipt.workflow_id, bounded: true as const, broadened: false as const } } : {})
  };
}
function resultPayload(result: ToolResult | undefined): Record<string, unknown> | null { const value = result?.result_json; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function matchingResult(req: ChatRequest, actionId: string): ToolResult | undefined { return req.tool_results?.find(result => result.action_id === actionId); }

function completeOrphanedDocumentSheetCount(req: ChatRequest): ChatResponse | null {
  const result = req.tool_results?.find(candidate =>
    candidate.action_id === "aec-query-document-sheets" &&
    candidate.method === "POST" &&
    candidate.path === "/revit/sheets"
  );
  if (!result) return null;
  if (result.status !== "done") {
    return response(`I could not complete the bounded sheet-count query: ${result.error || "the Revit read action failed"}. No model changes were made.`, [], { workflow_id: "query.document_sheets", status: "failed" });
  }
  const count = countFromPayload(resultPayload(result));
  if (count === null) {
    return response("The bounded sheet-count query completed, but the Revit result did not report a trustworthy count, so I did not guess. No model changes were made.", [], { workflow_id: "query.document_sheets", status: "failed" });
  }
  return response(`${count} sheet${count === 1 ? "" : "s"} matched in the whole Revit document. The result came from the scoped document sheets workflow; no model changes were made.`, [], { workflow_id: "query.document_sheets", status: "complete" });
}

function countFromPayload(payload: Record<string, unknown> | null): number | null {
  for (const key of ["count", "totalMatches", "total", "totalSheets"]) {
    if (Number.isSafeInteger(payload?.[key]) && (payload?.[key] as number) >= 0) return payload?.[key] as number;
  }
  for (const key of ["elementIds", "elements", "items", "results"]) if (Array.isArray(payload?.[key])) return (payload?.[key] as unknown[]).length;
  return null;
}

function subjectLabel(task: AecSemanticTaskV1): string {
  if (task.subject.semantic_class === "sheet" || task.subject.categories.some(category => category.toLocaleUpperCase() === "OST_SHEETS")) return "sheet";
  return task.subject.semantic_class === "other" ? (task.subject.terms[0] ?? "matching elements") : task.subject.semantic_class.replaceAll("_", " ");
}

function scopeLabel(task: AecSemanticTaskV1): string {
  if (task.scope.rooms[0]) return `Room ${task.scope.rooms[0]}`;
  if (task.scope.spaces[0]) return `Space ${task.scope.spaces[0]}`;
  if (task.scope.levels[0]) return task.scope.levels[0];
  if (task.scope.views[0]) return task.scope.views[0].name ?? `view ${task.scope.views[0].id}`;
  if (task.scope.sheets[0]) return `sheet ${task.scope.sheets[0]}`;
  if (task.scope.systems[0]) return `system ${task.scope.systems[0]}`;
  if (task.scope.kind === "selection") return "the current selection";
  if (task.scope.kind === "document") return task.scope.document ?? "the whole Revit document";
  return "the requested scope";
}

function resultItems(payload: Record<string, unknown> | null, limit = 20): Array<Record<string, unknown>> {
  for (const key of ["elements", "items", "results"]) {
    const value = payload?.[key];
    if (Array.isArray(value)) return value.filter(item => item && typeof item === "object" && !Array.isArray(item)).slice(0, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
  }
  return [];
}

function boundedElementIds(payload: Record<string, unknown> | null, limit: number, hardCap = 20): number[] {
  const raw = Array.isArray(payload?.elementIds) ? payload.elementIds : [];
  return raw.filter(id => Number.isSafeInteger(id) && (id as number) > 0).slice(0, Math.max(1, Math.min(hardCap, limit))) as number[];
}

function resultArray(value: unknown, limit = 20): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)).slice(0, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>
    : [];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
  if (Number.isSafeInteger(value)) return String(value);
  return null;
}

function itemSummary(item: Record<string, unknown>): string {
  const id = textValue(item.elementId) ?? textValue(item.id);
  const name = textValue(item.name);
  const family = textValue(item.familyName);
  const type = textValue(item.typeName);
  const category = textValue(item.category) ?? textValue(item.builtInCategory);
  const level = textValue(item.levelName);
  const room = textValue(item.roomNumber);
  const familyType = [family, type && type !== family ? type : null].filter(Boolean).join(" / ");
  const identity = [id ? `id ${id}` : null, familyType || name, category].filter(Boolean).join(" — ") || "bounded result";
  const location = [level, room ? `Room ${room}` : null].filter(Boolean).join(", ");
  return location ? `${identity} (${location})` : identity;
}

function wantsCountOnly(task: AecSemanticTaskV1): boolean {
  return /(?:return|respond(?: with)?|give me)?\s*(?:just|only)\s+(?:the\s+)?count\b|\bcount\s+only\b/i.test(task.evidence.user_text);
}

function completeScheduleInventory(task: AecSemanticTaskV1, workflow: AecQueryWorkflowId, result: ToolResult): ChatResponse {
  if (result.status !== "done") return response(`I could not complete the bounded schedule query: ${result.error || "the Revit read action failed"}. No model changes were made.`, [], { workflow_id: workflow, status: "failed" });
  const payload = resultPayload(result);
  const items = resultItems(payload, 500);
  const returned = payload?.returned;
  const count = Number.isSafeInteger(returned) ? returned as number : items.length;
  const wantsAirHandlers = /\b(?:ahu|air\s+handlers?|air[- ]handling\s+units?)\b/i.test(task.evidence.user_text);
  if (wantsAirHandlers) {
    const candidates = items.filter(item => /\bAHU\b|AIR HANDLING UNIT/i.test(textValue(item.name) ?? ""));
    const primary = candidates.find(item => /^AIR HANDLING UNIT SCHEDULE$/i.test(textValue(item.name) ?? ""));
    const ordered = primary ? [primary, ...candidates.filter(item => item !== primary)] : candidates;
    if (ordered.length === 0) return response(`I found ${count} schedule${count === 1 ? "" : "s"}, but none had an air-handler or AHU name, so I did not guess. No model changes were made.`, [], { workflow_id: workflow, status: "not_found" });
    const asksForInventory =
      /\b(?:list|inventory)\b/i.test(task.evidence.user_text) ||
      /\ball\b[^.?!]*\bschedules\b/i.test(task.evidence.user_text) ||
      /\b(?:what|which)\b[^.?!]*\bschedules\b/i.test(task.evidence.user_text);
    if (primary && !asksForInventory) {
      return response(`I found AIR HANDLING UNIT SCHEDULE (id ${textValue(primary.id) ?? "unknown"}). I think that's the schedule you mean. Would you like me to open it? No view was activated and no model changes were made.`, [], { workflow_id: workflow, status: "found" });
    }
    const labels = ordered.slice(0, 12).map(item => `${textValue(item.name) ?? "unnamed schedule"} (id ${textValue(item.id) ?? "unknown"})`);
    const strongest = primary ? ` The strongest direct match is ${labels[0]}.` : "";
    const related = primary && labels.length > 1 ? ` Related AHU schedules: ${labels.slice(1).join("; ")}.` : !primary ? ` Matching schedules: ${labels.join("; ")}.` : "";
    return response(`I found ${count} schedule${count === 1 ? "" : "s"}.${strongest}${related} No view was activated and no model changes were made.`, [], { workflow_id: workflow, status: ordered.length === 1 ? "found" : "ambiguous" });
  }
  const labels = items.slice(0, 12).map(item => `${textValue(item.name) ?? "unnamed schedule"} (id ${textValue(item.id) ?? "unknown"})`);
  const detail = labels.length ? ` First ${labels.length}: ${labels.join("; ")}.` : "";
  const truncation = count > labels.length ? " Additional schedules were not expanded into the response." : "";
  return response(`I found ${count} schedule${count === 1 ? "" : "s"}.${detail}${truncation} No model changes were made.`, [], { workflow_id: workflow, status: "complete" });
}

function completeSingleAction(task: AecSemanticTaskV1, workflow: AecQueryWorkflowId, result: ToolResult): ChatResponse {
  if (result.status !== "done") return response(`I could not complete the bounded ${task.operation} query: ${result.error || "the Revit read action failed"}.`, [], { workflow_id: workflow, status: "failed" });
  const payload = resultPayload(result);
  const count = countFromPayload(payload);
  if (workflow === "query.document_sheets" && task.operation === "count" && count !== null && wantsCountOnly(task)) {
    return response(String(count), [], { workflow_id: workflow, status: "complete" });
  }
  const scope = scopeLabel(task);
  const countText = count === null ? "The bounded query completed" : `${count} ${subjectLabel(task)}${count === 1 ? "" : "s"} matched`;
  if (["list", "inspect", "locate"].includes(task.operation)) {
    const items = resultItems(payload);
    const details = items.slice(0, Math.min(12, task.execution.max_results)).map(itemSummary);
    const truncation = payload?.truncated === true || (count !== null && count > details.length)
      ? ` Showing ${details.length} bounded result${details.length === 1 ? "" : "s"}; additional matches were not expanded into the response.`
      : "";
    const detailText = details.length ? ` Results: ${details.join("; ")}.` : "";
    return response(`${countText} in ${scope}.${detailText}${truncation} No model changes were made.`, [], { workflow_id: workflow, status: "complete" });
  }
  return response(`${countText} in ${scope}. The result came from the scoped ${workflow.replace("query.", "").replaceAll("_", " ")} workflow; no model changes were made.`, [], { workflow_id: workflow, status: "complete" });
}

function resultIsIncomplete(payload: Record<string, unknown> | null): boolean {
  return payload?.truncated === true || payload?.scanCapReached === true || payload?.itemsComplete === false;
}

function requestsSecondaryIdentityMatches(task: AecSemanticTaskV1): boolean {
  return /\b(?:acronyms?|abbreviations?|abbreviated|designations?|designators?|codes?|coded|tags?|tagged|labels?|labeled|labelled|related\s+components?|associated\s+fittings?)\b/i.test(task.evidence.user_text);
}

function selectPrimaryDocumentIdentityMatches(task: AecSemanticTaskV1, payload: Record<string, unknown> | null): {
  items: Array<Record<string, unknown>>;
  elementIds: number[] | null;
  excludedSecondaryCount: number;
} {
  const items = resultItems(payload, 500);
  const expansionCount = Number(payload?.identityExpansionCount);
  if (
    requestsSecondaryIdentityMatches(task) ||
    !Number.isFinite(expansionCount) ||
    expansionCount <= 0 ||
    payload?.itemsComplete !== true ||
    resultIsIncomplete(payload)
  ) return { items, elementIds: null, excludedSecondaryCount: 0 };

  const direct = items.filter(item => {
    const match = objectValue(item.identityMatch);
    const fields = Array.isArray(match?.matchedFields)
      ? match.matchedFields.filter(field => typeof field === "string") as string[]
      : [];
    return fields.some(field => !field.toLocaleLowerCase().startsWith("parameter:"));
  });
  const elementIds = direct
    .map(item => Number(item.elementId ?? item.id))
    .filter(id => Number.isSafeInteger(id) && id > 0);
  if (direct.length === 0 || direct.length === items.length || elementIds.length !== direct.length) {
    return { items, elementIds: null, excludedSecondaryCount: 0 };
  }
  return { items: direct, elementIds, excludedSecondaryCount: items.length - direct.length };
}

function secondaryIdentityExclusionText(count: number): string {
  return count > 0
    ? ` I excluded ${count} candidate${count === 1 ? "" : "s"} that matched only an abbreviated parameter value rather than the requested identity.`
    : "";
}

function documentIdentityGroups(items: Array<Record<string, unknown>>): string[] {
  const groups = new Map<string, { count: number; family: string | null; type: string | null; category: string | null }>();
  for (const item of items) {
    const family = textValue(item.familyName);
    const type = textValue(item.typeName) ?? textValue(item.name);
    const category = textValue(item.category) ?? textValue(item.builtInCategory);
    const key = `${family ?? ""}\u0000${type ?? ""}\u0000${category ?? ""}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { count: 1, family, type, category });
  }
  return [...groups.values()].slice(0, 12).map(group => {
    const identity = [group.category, group.family ? `family ${group.family}` : null, group.type ? `type ${group.type}` : null].filter(Boolean).join(", ") || "unclassified model elements";
    return `${group.count} ${identity}`;
  });
}

function rowCells(value: unknown): string[] {
  const row = objectValue(value);
  return Array.isArray(row?.cells) ? row.cells.map(cell => typeof cell === "string" ? cell.trim() : "") : [];
}

function isIdentityScheduleHeader(value: string): boolean {
  const tokens = value.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [];
  return tokens.some(token => ["desig", "designation", "mark", "tag", "identifier", "id", "number"].includes(token));
}

function normalizeScheduleHeader(value: string): string {
  return (value.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ");
}

export function __testOnlyIdentityScheduleKeyColumn(headers: string[], modelParameterNames: string[]): number {
  const modelNames = new Set(modelParameterNames.map(normalizeScheduleHeader).filter(Boolean));
  const candidates = headers
    .map((header, index) => ({ header, index }))
    .filter(candidate => isIdentityScheduleHeader(candidate.header) && modelNames.has(normalizeScheduleHeader(candidate.header)));
  return candidates.length === 1 ? candidates[0].index : -1;
}

function summarizeMatchingSchedule(scheduleResult: ToolResult | undefined, modelItems: Array<Record<string, unknown>> = [], modelItemsComplete = true): string {
  if (!scheduleResult) return "";
  if (scheduleResult.status !== "done" || scheduleResult.method !== "POST" || scheduleResult.path !== "/revit/schedules") {
    return " The matching schedule preview could not be read, so I am not inferring scheduled manufacturer/model facts.";
  }
  const payload = resultPayload(scheduleResult);
  if (textValue(payload?.status) !== "Ok" || textValue(payload?.action) !== "detail") return "";
  const schedule = objectValue(payload?.schedule);
  const scheduleName = textValue(schedule?.name) ?? "matching schedule";
  const scheduleId = textValue(schedule?.id);
  const fields = Array.isArray(payload?.fields) ? payload.fields.map(objectValue).filter(Boolean) as Array<Record<string, unknown>> : [];
  const table = objectValue(payload?.table);
  const header = objectValue(table?.header);
  const body = objectValue(table?.body);
  const headerRows = Array.isArray(header?.rows) ? header.rows.map(rowCells).filter(cells => cells.some(Boolean)) : [];
  const bodyRows = Array.isArray(body?.rows) ? body.rows.map(rowCells).filter(cells => cells.some(Boolean)) : [];
  if (bodyRows.length === 0) return ` The project also has ${scheduleName}${scheduleId ? ` (id ${scheduleId})` : ""}, but its bounded preview returned no data rows.`;
  const expectedColumns = Math.max(0, ...bodyRows.map(row => row.length));
  const fieldHeaders = fields
    .filter(field => field.isHidden !== true)
    .sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0))
    .map(field => textValue(field.heading) ?? textValue(field.name) ?? "")
    .slice(0, expectedColumns);
  const sectionHeaders = headerRows
    .map((cells, index) => ({ cells, index, nonEmpty: cells.filter(Boolean).length }))
    .filter(candidate => candidate.nonEmpty > 0 && candidate.cells.length >= expectedColumns)
    .sort((left, right) => right.nonEmpty - left.nonEmpty || right.index - left.index)[0]?.cells.slice(0, expectedColumns) ?? [];
  const headers = fieldHeaders.length === expectedColumns && fieldHeaders.some(Boolean) ? fieldHeaders : sectionHeaders;
  if (headers.length === 0) {
    return ` The project also has ${scheduleName}${scheduleId ? ` (id ${scheduleId})` : ""}, with ${bodyRows.length} visible data rows, but the bounded preview did not include usable column headers, so I am not inferring schedule facts or discrepancies.`;
  }
  const firstBodyRowIsHeader = bodyRows[0]?.length >= headers.length
    && headers.every((value, index) => normalizeScheduleHeader(value) === normalizeScheduleHeader(bodyRows[0][index] ?? ""));
  const dataRows = firstBodyRowIsHeader ? bodyRows.slice(1) : bodyRows;
  if (dataRows.length === 0) return ` The project also has ${scheduleName}${scheduleId ? ` (id ${scheduleId})` : ""}, but its bounded preview returned no data rows.`;
  const constantFacts: string[] = [];
  for (let column = 0; column < headers.length; column++) {
    const header = headers[column] || `column ${column + 1}`;
    const values = [...new Set(dataRows.map(row => row[column] ?? "").filter(Boolean))];
    if (values.length === 1 && !/^(?:comments?|remarks?)$/i.test(header)) constantFacts.push(`${header} ${values[0]}`);
  }
  const modelParameterEvidence = modelItems
    .map(item => {
      const identityParameter = objectValue(item.identityParameterEvidence);
      if (identityParameter) {
        return {
          parameterName: textValue(identityParameter.parameterName),
          text: textValue(identityParameter.text)
        };
      }
      return {
        parameterName: textValue(item.matchedParameterName),
        text: textValue(item.matchedText)
      };
    })
    .filter((item): item is { parameterName: string; text: string } => Boolean(item.parameterName && item.text));
  const modelParameterEvidenceComplete = modelItemsComplete && modelItems.length > 0 && modelParameterEvidence.length === modelItems.length;
  const keyColumn = modelParameterEvidenceComplete
    ? __testOnlyIdentityScheduleKeyColumn(headers, modelParameterEvidence.map(item => item.parameterName))
    : -1;
  const scheduleKeys = keyColumn >= 0
    ? [...new Set(dataRows.map(row => row[keyColumn] ?? "").filter(Boolean))]
    : [];
  const matchingParameterName = keyColumn >= 0 ? headers[keyColumn] : null;
  const modelKeys = matchingParameterName
    ? [...new Set(modelParameterEvidence
      .filter(item => normalizeScheduleHeader(item.parameterName) === normalizeScheduleHeader(matchingParameterName))
      .map(item => item.text))]
    : [];
  const modelOnly = modelKeys.filter(value => !scheduleKeys.some(key => key.toLocaleLowerCase() === value.toLocaleLowerCase())).sort();
  const scheduleOnly = scheduleKeys.filter(value => !modelKeys.some(key => key.toLocaleLowerCase() === value.toLocaleLowerCase())).sort();
  const rowsOmitted = Number.isFinite(Number(body?.rowsOmitted)) ? Math.max(0, Math.floor(Number(body?.rowsOmitted))) : 0;
  const rowsComplete = body?.rowsComplete !== false && body?.hasMoreRows !== true && rowsOmitted === 0;
  const rowWord = rowsComplete ? String(dataRows.length) : `at least ${dataRows.length}`;
  const keyText = scheduleKeys.length > 0 ? ` and ${scheduleKeys.length} unique ${matchingParameterName} values` : "";
  const factText = constantFacts.length > 0 ? ` Every returned row reports ${constantFacts.join(", ")}.` : "";
  const modelKeyText = modelKeys.length > 0 ? ` The physical instances carry ${modelKeys.length} unique ${matchingParameterName} values.` : "";
  const discrepancy = !modelItemsComplete
    ? " The model discovery result is incomplete, so I am not claiming an exhaustive model/schedule discrepancy."
    : keyColumn < 0 && modelItems.length > 0
    ? " I could not identify one unique schedule key column matching the returned model identity-parameter evidence, so I am not claiming a model/schedule discrepancy."
    : !rowsComplete
    ? " The schedule preview is incomplete, so I am not claiming an exhaustive model/schedule discrepancy."
    : modelOnly.length || scheduleOnly.length
    ? ` Schedule/model discrepancy: ${modelOnly.length} model-only value${modelOnly.length === 1 ? "" : "s"}${modelOnly.length ? ` (${modelOnly.join(", ")})` : ""}; ${scheduleOnly.length} schedule-only value${scheduleOnly.length === 1 ? "" : "s"}${scheduleOnly.length ? ` (${scheduleOnly.join(", ")})` : ""}.`
    : modelKeys.length > 0 ? " The model and schedule key sets agree." : "";
  return ` The project also has ${scheduleName}${scheduleId ? ` (id ${scheduleId})` : ""}, with ${rowWord} visible data rows${keyText}.${factText}${modelKeyText}${discrepancy}`;
}

function completeDocumentIdentity(task: AecSemanticTaskV1, result: ToolResult, scheduleResult?: ToolResult): ChatResponse {
  if (result.status !== "done" || result.method !== "POST" || result.path !== "/revit/find-elements") {
    return response(`I could not complete the bounded whole-document identity search: ${result.error || "the Revit discovery action failed"}. No model changes were made.`, [], { workflow_id: "query.document_elements", status: "failed" });
  }
  const payload = resultPayload(result);
  const selected = selectPrimaryDocumentIdentityMatches(task, payload);
  const items = selected.items;
  const count = selected.elementIds ? selected.elementIds.length : countFromPayload(payload) ?? items.length;
  if (count === 0) {
    if (resultIsIncomplete(payload)) {
      return response(`The bounded whole-document identity search reached a result or scan limit before finding a match, so I cannot honestly say that no ${subjectLabel(task)} exist. Narrow the identity or provide a grounded category and I can continue. No model changes were made.`, [], { workflow_id: "query.document_elements", status: "failed" });
    }
    return response(`I did not find a physical model instance matching ${subjectLabel(task)} across instance name, family, type, category, or Mark. No model changes were made.`, [], { workflow_id: "query.document_elements", status: "not_found" });
  }
  const groups = documentIdentityGroups(items);
  const identityText = groups.length ? ` They are ${groups.join("; ")}.` : " Their identity details were not returned, so I did not guess what they are.";
  const scheduleText = summarizeMatchingSchedule(scheduleResult, items, !resultIsIncomplete(payload));
  const excludedText = secondaryIdentityExclusionText(selected.excludedSecondaryCount);
  const incomplete = resultIsIncomplete(payload)
    ? " The bounded result limit or scan cap was reached, so this is a partial inventory rather than a claim that no additional matches exist."
    : "";
  return response(`I found ${count} physical model instance${count === 1 ? "" : "s"} matching ${subjectLabel(task)}.${identityText}${excludedText}${scheduleText}${incomplete} No model changes were made.`, [], { workflow_id: "query.document_elements", status: resultIsIncomplete(payload) ? "ambiguous" : "complete" });
}

function candidateLabel(candidate: Record<string, unknown>): string | null {
  const number = textValue(candidate.number);
  const name = textValue(candidate.name);
  const kind = textValue(candidate.spatialKind) ?? "Room";
  if (!number && !name) return null;
  return `${kind} ${[number, name].filter(Boolean).join(" — ")}`;
}

type SpatialItemSummary = {
  label: string;
  status: "resolved" | "ambiguous" | "unresolved";
  device: string;
  resolvedLocation?: string;
};

function spatialItemLabel(item: Record<string, unknown>): SpatialItemSummary {
  const id = textValue(item.elementId) ?? textValue(item.id) ?? "unknown";
  const mark = textValue(item.mark);
  const device = mark ? `${mark} (element ${id})` : `element ${id}`;
  const spatial = objectValue(item.spatialContext);
  const status = textValue(spatial?.status);
  const roomNumber = textValue(item.roomNumber);
  const roomName = textValue(item.roomName);
  const spatialKind = textValue(item.spatialKind) ?? "Room";
  const level = textValue(item.levelName);
  if (status === "resolved" && (roomNumber || roomName)) {
    const selected = objectValue(spatial?.selected);
    const sourceScope = textValue(selected?.sourceScope);
    const linkName = textValue(selected?.linkInstanceName);
    const provenance = sourceScope === "linked" || sourceScope === "link" ? ` via linked model${linkName ? ` ${linkName}` : ""}` : "";
    const resolvedLocation = `${spatialKind} ${[roomNumber, roomName].filter(Boolean).join(" — ")}${level ? `, ${level}` : ""}${provenance}`;
    return { label: `${device}: ${resolvedLocation}`, status: "resolved", device, resolvedLocation };
  }
  if (status === "ambiguous") {
    const matches = resultArray(spatial?.matches, 8).map(candidateLabel).filter((value): value is string => Boolean(value));
    return { label: `${device}: room assignment is ambiguous${matches.length ? ` among ${matches.join(", ")}` : ""}${level ? `, ${level}` : ""}`, status: "ambiguous", device };
  }
  const nearest = resultArray(spatial?.nearestCandidates, 3).map(candidateLabel).filter((value): value is string => Boolean(value));
  return { label: `${device}: room unresolved${level ? `, ${level}` : ""}${nearest.length ? `; nearest candidates (not assignments): ${nearest.join(", ")}` : ""}`, status: "unresolved", device };
}

function spatialAnswerSections(labels: SpatialItemSummary[]): string {
  const resolvedGroups = new Map<string, string[]>();
  for (const item of labels) {
    if (item.status !== "resolved" || !item.resolvedLocation) continue;
    const devices = resolvedGroups.get(item.resolvedLocation) ?? [];
    devices.push(item.device);
    resolvedGroups.set(item.resolvedLocation, devices);
  }
  const resolvedCount = labels.filter(item => item.status === "resolved").length;
  const ambiguous = labels.filter(item => item.status === "ambiguous");
  const unresolved = labels.filter(item => item.status === "unresolved");
  const roomWord = resolvedGroups.size === 1 ? "room" : "rooms";
  const lines = [`Resolved locations (${resolvedCount} devices across ${resolvedGroups.size} ${roomWord}):`];
  if (resolvedGroups.size === 0) lines.push("- None.");
  for (const [location, devices] of [...resolvedGroups.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))) {
    lines.push(`- ${location}: ${devices.sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).join(", ")}`);
  }
  lines.push(`Ambiguous assignments (${ambiguous.length}):`);
  lines.push(...(ambiguous.length ? ambiguous.map(item => `- ${item.label}`) : ["- None."]));
  lines.push(`Unresolved devices (${unresolved.length}):`);
  lines.push(...(unresolved.length ? unresolved.map(item => `- ${item.label}`) : ["- None."]));
  return lines.join("\n");
}

function completeDocumentSpatial(task: AecSemanticTaskV1, state: QueryState, result: ToolResult): ChatResponse {
  if (result.status !== "done" || result.method !== "POST" || result.path !== "/revit/locate-elements") {
    return response(`I found matching model instances but could not resolve their room locations: ${result.error || "the spatial action failed"}. No model changes were made.`, [], { workflow_id: "query.document_elements", status: "failed" });
  }
  const payload = resultPayload(result);
  const allRows = resultItems(payload, 500);
  const rootResolution = textValue(payload?.spatialResolution);
  const rootVerticalScope = textValue(payload?.spatialVerticalScope);
  const rowsHaveSameLevelReceipt = allRows.every(row =>
    textValue(objectValue(row.spatialContext)?.spatialVerticalScope) === "same_level"
  );
  if (rootResolution !== "geometry_with_nearest" ||
      rootVerticalScope !== "same_level" ||
      !rowsHaveSameLevelReceipt) {
    return response("I found matching model instances, but Revit did not return consistent geometry_with_nearest/same_level provenance for every spatial row, so I cannot state their room numbers. No model changes were made.", [], { workflow_id: "query.document_elements", status: "failed" });
  }
  const rows = allRows.filter(item => item.isNested !== true);
  const rowIds = new Set(rows.map(item => Number(item.elementId ?? item.id)).filter(id => Number.isSafeInteger(id) && id > 0));
  const missingIds = (Array.isArray(payload?.requestedElementIdsMissing) ? payload.requestedElementIdsMissing : [])
    .filter(id => Number.isSafeInteger(id) && (id as number) > 0 && !rowIds.has(id as number))
    .slice(0, 500) as number[];
  if (rows.length === 0 && missingIds.length === 0) {
    return response(`I found matching model instances, but Revit returned no top-level spatial rows, so I cannot state their room numbers. No model changes were made.`, [], { workflow_id: "query.document_elements", status: "failed" });
  }
  const labels = [
    ...rows.map(spatialItemLabel),
    ...missingIds.map(id => ({ label: `element ${id}: room unresolved; Revit did not return a spatial row for this requested element`, status: "unresolved" as const, device: `element ${id}` }))
  ];
  const resolved = labels.filter(item => item.status === "resolved").length;
  const ambiguous = labels.filter(item => item.status === "ambiguous").length;
  const unresolved = labels.length - resolved - ambiguous;
  const identityGroups = documentIdentityGroups(resultArray(state.evidence.discovery_items, 500));
  const identityText = identityGroups.length ? ` They are ${identityGroups.join("; ")}.` : "";
  const excludedText = secondaryIdentityExclusionText(Number(state.evidence.secondary_identity_matches_excluded) || 0);
  const discoveryIncomplete = state.evidence.discovery_incomplete === true;
  const spatialIncomplete = resultIsIncomplete(payload) || missingIds.length > 0;
  const incomplete = discoveryIncomplete || spatialIncomplete
    ? " The discovery or spatial result was bounded/incomplete, so additional matching devices may exist."
    : "";
  const sections = spatialAnswerSections(labels);
  return response(`I found ${labels.length} top-level physical model instance${labels.length === 1 ? "" : "s"} matching ${subjectLabel(task)}.${identityText}${excludedText} Room results: ${resolved} resolved, ${ambiguous} ambiguous, ${unresolved} unresolved.\n\n${sections}${incomplete}\n\nNo model changes were made.`, [], { workflow_id: "query.document_elements", status: ambiguous > 0 || unresolved > 0 || discoveryIncomplete || spatialIncomplete ? "ambiguous" : "complete" });
}

function exactCompletion(task: AecSemanticTaskV1, state: QueryState, result: ToolResult): ChatResponse {
  if (result.status !== "done") return response(`I found the exact identifier but could not read its placement context: ${result.error || "the context query failed"}. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "failed" });
  const context = resultPayload(result) ?? {};
  const candidate = state.evidence.candidate && typeof state.evidence.candidate === "object" ? state.evidence.candidate as Record<string, unknown> : {};
  const room = context.room && typeof context.room === "object" ? context.room as Record<string, unknown> : null;
  const identifier = task.subject.identifiers[0]?.value ?? "The element";
  const elementId = context.elementId ?? candidate.id ?? "unknown";
  const familyType = [context.familyName, context.typeName].filter(value => typeof value === "string" && value).join(" / ");
  const level = typeof context.levelName === "string" && context.levelName ? context.levelName : "level not reported";
  const roomText = room && (room.number || room.name) ? `Room ${[room.number, room.name].filter(Boolean).join(" — ")}` : "no room/space association reported";
  const location = context.center && typeof context.center === "object" ? JSON.stringify(context.center) : "not reported";
  const system = typeof context.systemName === "string" && context.systemName ? ` System: ${context.systemName}.` : "";
  const bestView = context.bestView && typeof context.bestView === "object" ? context.bestView as Record<string, unknown> : null;
  const viewText = bestView?.name ? ` Best view: ${bestView.name} (id ${bestView.id ?? "unknown"}).` : "";
  return response(`${identifier} is element ${elementId}${familyType ? ` (${familyType})` : ""}, on ${level}, with ${roomText}. Its model location is ${location}.${system}${viewText} No model changes were made.`, [], { workflow_id: state.workflow_id, status: "found" });
}

async function begin(req: ChatRequest, interpreter?: AecSemanticTaskInterpreter): Promise<{ task: AecSemanticTaskV1 | null; response: ChatResponse | null }> {
  const task = await interpretAecSemanticTask(req, interpreter);
  if (!task) return { task: null, response: null };
  const plan = planAecQueryTask(task);
  if (plan.status === "blocked" && ["locate", "count", "list", "inspect", "compare", "focus"].includes(task.operation)) {
    const reason = plan.blockers.join(" ") || "No bounded deterministic workflow supports that query shape.";
    return { task, response: response(`I could not run this query without broadening or guessing: ${reason} No model changes were made.`, [], { workflow_id: "query.blocked", status: "failed" }) };
  }
  if (plan.status !== "ready" || !plan.workflow_id || plan.actions.length === 0) return { task, response: null };
  states.set(key(req), { task, workflow_id: plan.workflow_id, stage: 0, evidence: plan.evidence, expires_at: Date.now() + TTL_MS });
  return { task, response: response("I’m resolving this directly in the smallest supported Revit scope.", plan.actions) };
}

function continueRun(req: ChatRequest, state: QueryState): ChatResponse | null {
  if (state.workflow_id === "query.compare_scopes") {
    const first = matchingResult(req, "aec-query-compare-a");
    const second = matchingResult(req, "aec-query-compare-b");
    if (!first || !second) return null;
    states.delete(key(req));
    if (first.status !== "done" || second.status !== "done") {
      const error = first.status !== "done" ? first.error : second.error;
      return response(`I could not complete both bounded comparison reads: ${error || "one scoped read failed"}. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "failed" });
    }
    const firstPayload = resultPayload(first);
    const secondPayload = resultPayload(second);
    const firstCount = countFromPayload(firstPayload);
    const secondCount = countFromPayload(secondPayload);
    const labels = Array.isArray(state.evidence.comparison_labels) ? state.evidence.comparison_labels.filter(label => typeof label === "string").slice(0, 2) as string[] : [];
    const firstLabel = labels[0] ?? "Scope A";
    const secondLabel = labels[1] ?? "Scope B";
    if (firstCount === null || secondCount === null) return response("Both bounded reads completed, but one result did not report a trustworthy count, so I did not infer a comparison. No model changes were made.", [], { workflow_id: state.workflow_id, status: "failed" });
    if (firstPayload?.truncated === true || secondPayload?.truncated === true) return response(`${firstLabel} returned at least ${firstCount} and ${secondLabel} returned at least ${secondCount}, but a result limit was reached, so no exact difference is claimed. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "failed" });
    const delta = secondCount - firstCount;
    const difference = delta === 0 ? "The counts are equal." : `${secondLabel} has ${Math.abs(delta)} ${subjectLabel(state.task)}${Math.abs(delta) === 1 ? "" : "s"} ${delta > 0 ? "more" : "fewer"} than ${firstLabel}.`;
    return response(`${firstLabel}: ${firstCount}. ${secondLabel}: ${secondCount}. ${difference} Both reads were scoped and predicate-pushed; no model changes were made.`, [], { workflow_id: state.workflow_id, status: "complete" });
  }
  if (state.workflow_id === "query.document_elements" && state.stage === 0) {
    const result = matchingResult(req, "aec-query-document-elements");
    if (!result) return null;
    const scheduleResult = matchingResult(req, "aec-query-document-element-schedule");
    if (state.evidence.schedule_detail_requested === true && !scheduleResult) return null;
    const payload = resultPayload(result);
    const selected = selectPrimaryDocumentIdentityMatches(state.task, payload);
    const count = selected.elementIds ? selected.elementIds.length : countFromPayload(payload) ?? 0;
    const wantsSpatial = state.evidence.needs_spatial === true;
    if (result.status === "done" && result.method === "POST" && result.path === "/revit/find-elements" && count > 0 && wantsSpatial) {
      const resultLimit = Number.isSafeInteger(state.evidence.result_limit) ? state.evidence.result_limit as number : state.task.execution.max_results;
      const ids = (selected.elementIds ?? boundedElementIds(payload, resultLimit, 500)).slice(0, Math.max(1, Math.min(500, resultLimit)));
      if (ids.length === 0) {
        states.delete(key(req));
        return response("The bounded identity search reported matches but returned no valid element IDs, so I could not guess which devices to locate. No model changes were made.", [], { workflow_id: state.workflow_id, status: "failed" });
      }
      states.set(key(req), {
        ...state,
        stage: 1,
        evidence: {
          ...state.evidence,
          discovery_count: count,
          discovery_incomplete: resultIsIncomplete(payload),
          discovery_items: selected.items,
          secondary_identity_matches_excluded: selected.excludedSecondaryCount
        },
        expires_at: Date.now() + TTL_MS
      });
      return response("I found the physical instances and am resolving each one against phase-matched host and linked Rooms without treating nearest candidates as assignments.", [{
        action_id: "aec-query-document-element-locations",
        method: "POST",
        path: "/revit/locate-elements",
        body: {
          elementIds: ids,
          limit: Math.min(500, ids.length + 1),
          spatialResolution: "geometry_with_nearest",
          spatialVerticalScope: "same_level",
          spatialKindPreference: "room",
          includeHostRooms: true,
          includeHostSpaces: false,
          includeLinkedRooms: true,
          nearestCandidateLimit: 5
        }
      }]);
    }
    states.delete(key(req));
    return completeDocumentIdentity(state.task, result, scheduleResult);
  }
  if (state.workflow_id === "query.document_elements" && state.stage === 1) {
    const result = matchingResult(req, "aec-query-document-element-locations");
    if (!result) return null;
    states.delete(key(req));
    return completeDocumentSpatial(state.task, state, result);
  }
  if (state.workflow_id === "query.exact_identifier" && state.stage === 0) {
    const result = matchingResult(req, "aec-query-exact-identifier");
    if (!result) return null;
    const next = continueExactIdentifierQuery(state.task, result);
    if (next.status === "ready" && next.actions.length) {
      states.set(key(req), { ...state, stage: 1, evidence: { ...state.evidence, ...next.evidence }, expires_at: Date.now() + TTL_MS });
      return response("I found one exact match and am reading only its placement context.", next.actions);
    }
    states.delete(key(req));
    if (next.status === "blocked") return response(`I found multiple candidates for ${state.task.subject.identifiers[0]?.value ?? "that identifier"}; I did not guess or broaden the search. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "ambiguous" });
    return response(`I did not find an exact match for ${state.task.subject.identifiers[0]?.value ?? "that identifier"} in the requested category and scope. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "not_found" });
  }
  if (state.workflow_id === "query.exact_identifier" && state.stage === 1) {
    const result = matchingResult(req, "aec-query-exact-context") ?? matchingResult(req, "aec-query-exact-scope");
    if (!result) return null;
    if (state.task.operation === "focus") {
      if (result.status !== "done") {
        states.delete(key(req));
        return response(`I found the exact identifier but could not resolve a safe view for focus: ${result.error || "the context query failed"}. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "failed" });
      }
      const context = resultPayload(result) ?? {};
      const candidate = state.evidence.candidate && typeof state.evidence.candidate === "object" ? state.evidence.candidate as Record<string, unknown> : {};
      const elementId = context.elementId ?? candidate.id;
      const bestView = context.bestView && typeof context.bestView === "object" && !Array.isArray(context.bestView) ? context.bestView as Record<string, unknown> : {};
      if (!Number.isSafeInteger(elementId) || (elementId as number) <= 0 || !Number.isSafeInteger(bestView.id) || (bestView.id as number) <= 0) {
        states.delete(key(req));
        return response("I found the element but no exact graphical view could be resolved, so I did not guess or change the active view. No model changes were made.", [], { workflow_id: state.workflow_id, status: "failed" });
      }
      states.set(key(req), { ...state, stage: 2, evidence: { ...state.evidence, context }, expires_at: Date.now() + TTL_MS });
      return response("I found the exact element and its best graphical view; I’m focusing that element now.", [{ action_id: "aec-query-exact-focus", method: "POST", path: "/revit/activate-view", body: { viewId: bestView.id, showElementIds: [elementId] } }]);
    }
    states.delete(key(req));
    return exactCompletion(state.task, state, result);
  }
  if (state.workflow_id === "query.exact_identifier" && state.stage === 2) {
    const result = matchingResult(req, "aec-query-exact-focus");
    if (!result) return null;
    states.delete(key(req));
    if (result.status !== "done") return response(`I found the exact element but could not focus its view: ${result.error || "view activation failed"}. No model elements were changed.`, [], { workflow_id: state.workflow_id, status: "failed" });
    const payload = resultPayload(result) ?? {};
    const identifier = state.task.subject.identifiers[0]?.value ?? "The element";
    const activeView = textValue(payload.activeViewName) ?? (textValue(payload.activeViewId) ? `view ${textValue(payload.activeViewId)}` : "the resolved view");
    return response(`Focused ${identifier} in ${activeView}. No model elements were changed.`, [], { workflow_id: state.workflow_id, status: "found" });
  }
  if (state.workflow_id !== "query.exact_identifier" && state.stage === 1) {
    const result = matchingResult(req, "aec-query-scoped-summaries");
    if (!result) return null;
    states.delete(key(req));
    if (result.status !== "done") return response(`The bounded ${state.task.operation} query found matching IDs, but their compact summaries could not be read: ${result.error || "the summary action failed"}. No model changes were made.`, [], { workflow_id: state.workflow_id, status: "failed" });
    const count = Number.isSafeInteger(state.evidence.result_count) ? state.evidence.result_count as number : resultArray(result.result_json).length;
    const synthetic: ToolResult = {
      ...result,
      result_json: { count, truncated: state.evidence.result_truncated === true, items: resultArray(result.result_json) }
    };
    return completeSingleAction(state.task, state.workflow_id, synthetic);
  }
  const actionIds: Partial<Record<AecQueryWorkflowId, string>> = {
    "query.room_contents": "aec-query-room-contents",
    "query.level_elements": "aec-query-level-elements",
    "query.document_schedules": "aec-query-document-schedules",
    "query.document_sheets": "aec-query-document-sheets",
    "query.view_elements": "aec-query-view-elements",
    "query.sheet_elements": "aec-query-sheet-elements",
    "query.selection": "aec-query-selection"
  };
  const actionId = actionIds[state.workflow_id];
  if (!actionId) return null;
  const result = matchingResult(req, actionId);
  if (!result) return null;
  if (state.workflow_id === "query.document_schedules") {
    states.delete(key(req));
    return completeScheduleInventory(state.task, state.workflow_id, result);
  }
  if (result.status === "done" && ["list", "inspect", "locate"].includes(state.task.operation) && state.task.execution.max_primary_actions >= 2) {
    const payload = resultPayload(result);
    const ids = boundedElementIds(payload, state.task.execution.max_results);
    if (ids.length > 0 && resultItems(payload).length === 0) {
      states.set(key(req), {
        ...state,
        stage: 1,
        evidence: { ...state.evidence, result_count: countFromPayload(payload) ?? ids.length, result_truncated: payload?.truncated === true },
        expires_at: Date.now() + TTL_MS
      });
      return response("I found the bounded IDs and am reading compact summaries only for those matches.", [{ action_id: "aec-query-scoped-summaries", method: "POST", path: "/revit/get-element-summary", body: { elementIds: ids } }]);
    }
  }
  states.delete(key(req));
  return completeSingleAction(state.task, state.workflow_id, result);
}

export async function maybeRunAecSemanticQuery(req: ChatRequest, interpreter?: AecSemanticTaskInterpreter): Promise<{ task: AecSemanticTaskV1 | null; response: ChatResponse | null }> {
  purge();
  const state = states.get(key(req));
  if (state && (req.tool_results?.length ?? 0) > 0) return { task: state.task, response: continueRun(req, state) };
  if ((req.tool_results?.length ?? 0) > 0) return { task: null, response: completeOrphanedDocumentSheetCount(req) };
  return begin(req, interpreter);
}

export function __testOnlyClearAecQueryStates(): void { states.clear(); }
