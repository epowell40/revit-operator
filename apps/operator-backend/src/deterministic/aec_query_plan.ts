import type { ActionCall, ToolResult } from "../contracts.js";
import { normalizeAecSemanticTaskV1, type AecSemanticTaskV1 } from "../aec_semantic_task.js";

export type AecQueryWorkflowId =
  | "query.blocked"
  | "query.compare_scopes"
  | "query.exact_identifier"
  | "query.room_contents"
  | "query.level_elements"
  | "query.document_schedules"
  | "query.document_sheets"
  | "query.document_elements"
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

function isSheetInventory(task: AecSemanticTaskV1): boolean {
  return task.subject.semantic_class === "sheet"
    || task.subject.categories.some(category => category.toLocaleUpperCase() === "OST_SHEETS")
    || task.subject.terms.some(term => /(?:^|\s)sheets?(?:\s|$)/i.test(term));
}

function isScheduleInventory(task: AecSemanticTaskV1): boolean {
  const text = [...task.subject.terms, task.evidence.user_text].join(" ");
  return /\bschedules?\b/i.test(text);
}

function documentIdentityTerms(task: AecSemanticTaskV1): string[] {
  const values = [task.subject.family_name, task.subject.type_name, ...task.subject.terms];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string" && value.trim().length >= 2)
    .map(value => value.trim().slice(0, 128).toLocaleLowerCase()))]
    .slice(0, 8);
}

function isSpatialDocumentQuestion(task: AecSemanticTaskV1): boolean {
  return /\b(?:where|located?|locations?|rooms?|spaces?|positions?|coordinates?|levels?|floors?|zones?)\b/i.test(task.evidence.user_text);
}

function hasExplicitDocumentClassScope(task: AecSemanticTaskV1): boolean {
  if (task.scope.kind !== "active_context") return false;
  if (!["category", "class", "family", "type", "elements", "generic"].includes(task.subject.kind)) return false;
  if (task.scope.levels.length || task.scope.rooms.length || task.scope.spaces.length || task.scope.areas.length ||
      task.scope.views.length || task.scope.sheets.length || task.scope.systems.length || task.scope.element_ids.length ||
      task.scope.region !== null) return false;
  const text = task.evidence.user_text;
  return /\b(?:all|each|every)\b/i.test(text) ||
    /\b(?:this|current|whole|entire)\s+(?:project|model|document)\b/i.test(text) ||
    /\bthroughout\s+(?:the\s+)?(?:project|model|document)\b/i.test(text);
}

function naturalScheduleQuery(identityTerms: string[]): string | null {
  const source = identityTerms.find(term => term.split(/\s+/).filter(Boolean).length >= 2) ?? identityTerms[0];
  if (!source) return null;
  return source
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.length > 3 && /s$/i.test(word) && !/ss$/i.test(word) ? word.slice(0, -1) : word)
    .join(" ")
    .slice(0, 128) || null;
}

function planBoundedComparison(task: AecSemanticTaskV1): AecQueryPlanV1 {
  if (task.execution.max_primary_actions < 2) return blocked("A bounded comparison requires two primary scoped reads.");
  if (!["category", "class"].includes(task.subject.kind) || task.subject.categories.length === 0) return blocked("Bounded comparison currently requires one explicit category or class with a canonical category predicate.");
  if (task.outputs.some(output => ["parameters", "spatial_context", "best_view", "verification"].includes(output))) return blocked("Bounded comparison currently supports inventory count/IDs/summary only; parameter and geometry comparisons require a dedicated workflow.");

  const labels: string[] = [];
  const actions: ActionCall[] = [];
  const add = (index: number, label: string, path: string, body: Record<string, unknown>) => {
    labels.push(label);
    actions.push(action(`aec-query-compare-${index === 0 ? "a" : "b"}`, path, body));
  };

  if (task.scope.kind === "room" && task.scope.rooms.length === 2) {
    task.scope.rooms.forEach((room, index) => {
      const body: Record<string, unknown> = { roomNumber: room, mode: "auto", verticalScope: "room", limit: task.execution.max_results, categories: task.subject.categories };
      if (task.subject.terms.length) body.includeKeywords = task.subject.terms;
      add(index, `Room ${room}`, "/revit/room-contents", body);
    });
  } else if (task.scope.kind === "level" && task.scope.levels.length === 2) {
    if (task.subject.categories.some(category => !category.startsWith("OST_"))) return blocked("Level comparison requires canonical OST_ categories so both native collectors remain predicate-pushed.");
    task.scope.levels.forEach((level, index) => add(index, level, "/revit/locate-elements", { categories: task.subject.categories, levelNames: [level], limit: task.execution.max_results }));
  } else if (task.scope.kind === "view" && task.scope.views.length === 2 && task.scope.views.every(view => Number.isSafeInteger(view.id) && (view.id as number) > 0)) {
    task.scope.views.forEach((view, index) => add(index, view.name ?? `view ${view.id}`, "/revit/find-elements", { viewId: view.id, ...categoryBody(task), limit: task.execution.max_results }));
  } else if (task.scope.kind === "sheet" && task.scope.sheets.length === 2) {
    task.scope.sheets.forEach((sheet, index) => add(index, `sheet ${sheet}`, "/revit/find-elements", { sheetNumber: sheet, includeSheetElements: true, includeViewportElements: true, ...categoryBody(task), limit: task.execution.max_results }));
  } else {
    return blocked("Compare requires exactly two resolved rooms, levels, view IDs, or sheet numbers in one scope kind.");
  }

  return { status: "ready", workflow_id: "query.compare_scopes", actions, blockers: [], evidence: { predicate_pushed: true, document_payload_requested: false, comparison_labels: labels } };
}

export function planAecQueryTask(value: unknown): AecQueryPlanV1 {
  let task: AecSemanticTaskV1;
  try { task = normalizeAecSemanticTaskV1(value); } catch (error) {
    return blocked(error instanceof Error ? error.message : "Invalid semantic task");
  }
  if (!READ_OPERATIONS.has(task.operation)) return blocked(`Operation '${task.operation}' is not a read query.`);
  if (task.confidence.ambiguity === "material" || task.confidence.value < 0.75) return blocked("Material task ambiguity must be resolved before deterministic query execution.");
  if (task.operation === "compare") return planBoundedComparison(task);
  if (isScheduleInventory(task)) {
    return {
      status: "ready",
      workflow_id: "query.document_schedules",
      actions: [action("aec-query-document-schedules", "/revit/schedules", { action: "list", query: "", max: 500 })],
      blockers: [],
      evidence: { predicate_pushed: true, document_payload_requested: true, bounded_schedule_inventory: true }
    };
  }
  if (task.operation === "focus" && task.subject.kind !== "exact_identifier") return blocked("Focus currently requires one exact identifier so the target view and element can be resolved without guessing.");
  if (task.operation === "focus" && task.execution.max_primary_actions < 3) return blocked("Exact-element focus requires three bounded actions: identity lookup, placement context, and view activation.");
  const explicitDocumentClassScope = hasExplicitDocumentClassScope(task);
  const documentScope = task.scope.kind === "document" || explicitDocumentClassScope;

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

  if (documentScope && isSheetInventory(task)) {
    const countOnly = task.operation === "count";
    return {
      status: "ready",
      workflow_id: "query.document_sheets",
      actions: [action("aec-query-document-sheets", "/revit/sheets", countOnly
        ? { action: "list", offset: 0, limit: 1 }
        : { action: "list", offset: 0, limit: task.execution.max_results })],
      blockers: [],
      evidence: { predicate_pushed: true, document_payload_requested: false, exact_document_inventory: true }
    };
  }

  if (documentScope && ["category", "class", "family", "type", "elements", "generic"].includes(task.subject.kind)) {
    const groundedCategoryBody = task.subject.kind === "category" ? categoryBody(task) : {};
    const identityTerms = Object.keys(groundedCategoryBody).length > 0 ? [] : documentIdentityTerms(task);
    if (identityTerms.length === 0 && Object.keys(groundedCategoryBody).length === 0) {
      return blocked("Whole-document element discovery requires an identity term or an explicit canonical category; an unfiltered document scan is not allowed.");
    }
    const needsSpatial = isSpatialDocumentQuestion(task);
    if (needsSpatial && task.execution.max_primary_actions < 2) {
      return blocked("Whole-document location queries require two bounded actions: identity discovery and geometry-aware spatial resolution.");
    }
    const limit = 500;
    const actions = [action("aec-query-document-elements", "/revit/find-elements", {
      ...groundedCategoryBody,
      ...(task.subject.family_name ? { familyNameContains: task.subject.family_name } : {}),
      ...(task.subject.type_name ? { typeNameContains: task.subject.type_name } : {}),
      ...(identityTerms.length ? { identityTerms, expandIdentityAcronymsInParameters: true } : {}),
      physicalElementsOnly: true,
      topLevelInstancesOnly: true,
      limit
    })];
    const scheduleQuery = !needsSpatial && task.execution.max_primary_actions >= 2 ? naturalScheduleQuery(identityTerms) : null;
    if (scheduleQuery) {
      actions.push(action("aec-query-document-element-schedule", "/revit/schedules", {
        action: "detail",
        query: scheduleQuery,
        exact: false,
        requireUniqueQuery: true,
        includeFields: true,
        includeData: true,
        rowOffset: 0,
        columnOffset: 0,
        maxRows: 500,
        maxColumns: 40
      }));
    }
    return {
      status: "ready",
      workflow_id: "query.document_elements",
      actions,
      blockers: [],
      evidence: {
        predicate_pushed: true,
        document_payload_requested: false,
        identity_terms: identityTerms,
        inferred_categories_ignored: task.subject.kind !== "category" && task.subject.categories.length > 0,
        max_primary_actions: task.execution.max_primary_actions,
        result_limit: limit,
        needs_spatial: needsSpatial,
        schedule_detail_requested: Boolean(scheduleQuery),
        schedule_query: scheduleQuery,
        scope_promoted_from_active_context: explicitDocumentClassScope
      }
    };
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
