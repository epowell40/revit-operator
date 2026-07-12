import type { ActionCall, ToolResult } from "../contracts.js";
import { normalizeAecSemanticTaskV1, type AecSemanticTaskV1 } from "../aec_semantic_task.js";

export type AecQueryWorkflowId =
  | "query.exact_identifier"
  | "query.room_contents"
  | "query.level_elements"
  | "query.view_elements"
  | "query.sheet_elements"
  | "query.selection";

export type AecQueryPlanV1 = {
  status: "ready" | "blocked" | "complete";
  workflow_id: AecQueryWorkflowId | null;
  actions: ActionCall[];
  blockers: string[];
  evidence: Record<string, unknown>;
};

const READ_OPERATIONS = new Set(["locate", "count", "list", "inspect", "compare", "focus"]);

function action(actionId: string, path: string, body: Record<string, unknown>): ActionCall {
  return { action_id: actionId, method: "POST", path, body };
}

function blocked(...blockers: string[]): AecQueryPlanV1 {
  return { status: "blocked", workflow_id: null, actions: [], blockers, evidence: {} };
}

function numericViewId(task: AecSemanticTaskV1): number | null {
  if (task.scope.views.length !== 1) return null;
  return task.scope.views[0].id;
}

function categoryBody(task: AecSemanticTaskV1): Record<string, unknown> {
  return task.subject.categories.length === 1
    ? { category: task.subject.categories[0] }
    : task.subject.categories.length > 1 ? { categories: task.subject.categories } : {};
}

export function planAecQueryTask(value: unknown): AecQueryPlanV1 {
  let task: AecSemanticTaskV1;
  try { task = normalizeAecSemanticTaskV1(value); } catch (error) {
    return blocked(error instanceof Error ? error.message : "Invalid semantic task");
  }
  if (!READ_OPERATIONS.has(task.operation)) return blocked(`Operation '${task.operation}' is not a read query.`);
  if (task.confidence.ambiguity === "material" || task.confidence.value < 0.75) return blocked("Material task ambiguity must be resolved before deterministic query execution.");

  if (task.subject.kind === "exact_identifier") {
    if (task.subject.identifiers.length === 0 || task.subject.identifiers.length > 8) return blocked("Exact-identifier queries require 1 to 8 bounded identifier predicates.");
    if (task.scope.kind === "view" && numericViewId(task) === null) return blocked("Named view scope must be resolved to one exact view id before element lookup.");
    if (["area", "sheet", "region"].includes(task.scope.kind) || (task.scope.kind === "mixed" && (task.scope.areas.length > 0 || task.scope.sheets.length > 0 || task.scope.region !== null))) {
      return blocked(`Exact-identifier lookup does not support '${task.scope.kind}' scope without a bounded scope resolver.`);
    }
    const body: Record<string, unknown> = {
      ...categoryBody(task),
      limit: Math.min(task.execution.max_results, 100)
    };
    if (task.subject.identifiers.length === 1) {
      const identifier = task.subject.identifiers[0];
      body.parameterName = identifier.parameter;
      body.op = identifier.match === "contains" ? "contains" : "equals";
      body.value = identifier.value;
    } else {
      body.predicates = task.subject.identifiers.map(identifier => ({ parameterName: identifier.parameter, op: identifier.match === "contains" ? "contains" : "equals", value: identifier.value }));
      body.matchMode = "any";
    }
    const viewId = numericViewId(task);
    if (viewId !== null) body.viewId = viewId;
    const systemName = task.subject.system_name ?? (task.scope.systems.length === 1 ? task.scope.systems[0] : null);
    if (systemName) body.systemName = systemName;
    return {
      status: "ready",
      workflow_id: "query.exact_identifier",
      actions: [action("aec-query-exact-identifier", "/revit/find-elements-by-parameter", body)],
      blockers: [],
      evidence: { predicate_pushed: true, document_payload_requested: false, max_primary_actions: task.execution.max_primary_actions }
    };
  }

  if (task.scope.kind === "room" && task.scope.rooms.length === 1) {
    if (!["category", "class", "family", "type", "elements", "generic"].includes(task.subject.kind)) return blocked(`Subject '${task.subject.kind}' is not supported by room contents.`);
    const body: Record<string, unknown> = { roomNumber: task.scope.rooms[0], mode: "auto", verticalScope: "room", limit: task.execution.max_results };
    if (task.subject.categories.length) body.categories = task.subject.categories;
    if (task.subject.terms.length) body.includeKeywords = task.subject.terms;
    return { status: "ready", workflow_id: "query.room_contents", actions: [action("aec-query-room-contents", "/revit/room-contents", body)], blockers: [], evidence: { predicate_pushed: true, document_payload_requested: false } };
  }

  if (task.scope.kind === "view" && numericViewId(task) !== null) {
    const body: Record<string, unknown> = { viewId: numericViewId(task), ...categoryBody(task), limit: task.execution.max_results };
    if (task.subject.family_name) body.familyNameContains = task.subject.family_name;
    if (task.subject.type_name) body.typeNameContains = task.subject.type_name;
    return { status: "ready", workflow_id: "query.view_elements", actions: [action("aec-query-view-elements", "/revit/find-elements", body)], blockers: [], evidence: { predicate_pushed: true, document_payload_requested: false } };
  }

  if (task.scope.kind === "sheet" && task.scope.sheets.length === 1) {
    const body: Record<string, unknown> = { sheetNumber: task.scope.sheets[0], includeSheetElements: true, includeViewportElements: true, ...categoryBody(task), limit: task.execution.max_results };
    return { status: "ready", workflow_id: "query.sheet_elements", actions: [action("aec-query-sheet-elements", "/revit/find-elements", body)], blockers: [], evidence: { predicate_pushed: true, document_payload_requested: false } };
  }

  if (task.scope.kind === "selection" && task.scope.element_ids.length) {
    return { status: "ready", workflow_id: "query.selection", actions: [action("aec-query-selection", "/revit/locate-elements", { elementIds: task.scope.element_ids, limit: task.execution.max_results })], blockers: [], evidence: { predicate_pushed: true, document_payload_requested: false } };
  }

  if (task.scope.kind === "level" && task.scope.levels.length === 1) {
    if (!task.subject.categories.length || task.subject.categories.some(category => !category.startsWith("OST_"))) return blocked("Level queries require at least one canonical OST_ category so both predicates can be pushed into the native collector.");
    return { status: "ready", workflow_id: "query.level_elements", actions: [action("aec-query-level-elements", "/revit/locate-elements", { categories: task.subject.categories, levelNames: task.scope.levels, limit: task.execution.max_results })], blockers: [], evidence: { predicate_pushed: true, document_payload_requested: false } };
  }
  if (task.scope.kind === "active_context") return blocked("Active context must resolve to an exact view, room, selection, or explicit document opt-in before category queries.");
  return blocked(`No bounded query workflow supports scope '${task.scope.kind}' and subject '${task.subject.kind}'.`);
}

function resultJson(result: ToolResult | undefined): Record<string, unknown> | null {
  const value = result?.result_json;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function continueExactIdentifierQuery(value: unknown, result: ToolResult | undefined): AecQueryPlanV1 {
  let task: AecSemanticTaskV1;
  try { task = normalizeAecSemanticTaskV1(value); } catch (error) { return blocked(error instanceof Error ? error.message : "Invalid semantic task"); }
  if (result?.status !== "done" || result.path !== "/revit/find-elements-by-parameter") return blocked("Exact-identifier lookup result is missing or failed.");
  const payload = resultJson(result);
  const elements = Array.isArray(payload?.elements) ? payload.elements.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>> : [];
  if (elements.length === 0) return { status: "complete", workflow_id: "query.exact_identifier", actions: [], blockers: [], evidence: { match_status: "not_found", candidates: [] } };
  if (elements.length > 1) return { status: "blocked", workflow_id: "query.exact_identifier", actions: [], blockers: ["Identifier resolved to multiple elements; deterministic mutation or focus is not safe."], evidence: { match_status: "ambiguous", candidates: elements.slice(0, task.execution.max_results) } };
  const id = elements[0].id;
  if (!Number.isSafeInteger(id) || (id as number) <= 0) return blocked("Exact-identifier result did not contain a valid element id.");
  const needsScopedCheck = task.scope.rooms.length > 0 || task.scope.spaces.length > 0 || task.scope.levels.length > 0;
  if (needsScopedCheck) {
    const body: Record<string, unknown> = { elementIds: [id], limit: 1 };
    if (task.scope.levels.length) body.levelNames = task.scope.levels;
    if (task.scope.rooms.length) body.roomNumber = task.scope.rooms[0];
    return { status: "ready", workflow_id: "query.exact_identifier", actions: [action("aec-query-exact-scope", "/revit/locate-elements", body)], blockers: [], evidence: { match_status: "unique", candidate: elements[0], predicate_pushed: true } };
  }
  const needsContext = task.outputs.some(output => ["spatial_context", "best_view", "verification"].includes(output));
  if (needsContext && task.execution.max_primary_actions >= 2) {
    return { status: "ready", workflow_id: "query.exact_identifier", actions: [action("aec-query-exact-context", "/revit/get-placement-context", { elementId: id, maxNearbyHosts: 3 })], blockers: [], evidence: { match_status: "unique", candidate: elements[0] } };
  }
  return { status: "complete", workflow_id: "query.exact_identifier", actions: [], blockers: [], evidence: { match_status: "unique", candidate: elements[0] } };
}
