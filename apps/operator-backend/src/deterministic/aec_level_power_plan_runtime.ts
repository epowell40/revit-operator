import type { ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import type { AecSemanticTaskV1 } from "../aec_semantic_task.js";
import { appendGoalProgress, getActiveGoalForSession, updateGoal } from "../goals/service.js";

type ResolvedView = { id: number; name: string; levelName: string | null };
type Inventory = { view: ResolvedView; elementIds: number[]; inventoryActionId: string };
type RuntimeState = {
  task: AecSemanticTaskV1;
  views: ResolvedView[];
  stage: "inventory" | "summary" | "frame";
  actionIds: string[];
  inventories: Inventory[];
  summaries: Map<number, Array<Record<string, unknown>>>;
  evidenceActionIds: string[];
};

const states = new Map<string, RuntimeState>();
const POWER_INSPECTION_CATEGORIES = ["OST_ElectricalFixtures", "OST_ElectricalEquipment", "OST_Wire"] as const;
const MAX_PILOT_VIEWS = 2;
const MAX_ELEMENTS_PER_VIEW = 500;

function response(message: string, actions: ChatResponse["actions"] = []): ChatResponse {
  return { version: "operator.backend.v1", assistant_message: message, actions };
}

function terminal(message: string, status: "complete" | "failed"): ChatResponse {
  return {
    ...response(message),
    aec_query_receipt: {
      schema: "revit-operator.aec-query-receipt.v1",
      terminal: true,
      status,
      workflow_id: "query.level_power_plan_pilot",
      bounded: true,
      broadened: false
    }
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function isPowerPlanTask(task: AecSemanticTaskV1): boolean {
  return task.scope.kind === "level" &&
    task.operation === "layout" &&
    task.mutation.requested &&
    (task.subject.semantic_class === "electrical_equipment" || task.subject.semantic_class === "receptacle");
}

function actionId(viewId: number, suffix: string): string { return `aec-power-view-${viewId}-${suffix}`; }

function inventoryActions(views: ResolvedView[]): ChatResponse["actions"] {
  return views.map(view => ({
    action_id: actionId(view.id, "inventory"),
    method: "POST" as const,
    path: "/revit/find-elements",
    body: { viewId: view.id, categories: [...POWER_INSPECTION_CATEGORIES], limit: MAX_ELEMENTS_PER_VIEW }
  }));
}

function matchingResults(req: ChatRequest, actionIds: string[]): ToolResult[] {
  const wanted = new Set(actionIds);
  return (req.tool_results ?? []).filter(result => wanted.has(result.action_id));
}

function exactPositiveIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const raw of value) {
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0) return null;
    ids.push(raw as number);
  }
  return new Set(ids).size === ids.length ? ids : null;
}

function parseInventory(view: ResolvedView, result: ToolResult): Inventory | null {
  if (result.status !== "done" || result.path !== "/revit/find-elements") return null;
  const payload = object(result.result_json);
  const scope = object(payload?.scope);
  const scopedViewIds = exactPositiveIds(scope?.viewIds);
  const ids = exactPositiveIds(payload?.elementIds);
  const resolvedCategories = Array.isArray(payload?.resolvedCategories) ? payload.resolvedCategories : [];
  const resolvedTokens = new Set(resolvedCategories.map(row => text(object(row)?.builtInToken)).filter(Boolean));
  if (!payload || !ids || ids.length > MAX_ELEMENTS_PER_VIEW || payload.truncated === true || payload.categoryFilterApplied !== true) return null;
  if (text(scope?.kind).toLocaleLowerCase() !== "view" || !scopedViewIds || scopedViewIds.length !== 1 || scopedViewIds[0] !== view.id) return null;
  if (POWER_INSPECTION_CATEGORIES.some(category => !resolvedTokens.has(category))) return null;
  return { view, elementIds: ids, inventoryActionId: result.action_id };
}

function summaryActions(inventories: Inventory[]): ChatResponse["actions"] {
  return inventories.filter(item => item.elementIds.length > 0).map(item => ({
    action_id: actionId(item.view.id, "summary"),
    method: "POST" as const,
    path: "/revit/get-element-summary",
    body: { viewId: item.view.id, elementIds: item.elementIds }
  }));
}

function frameActions(views: ResolvedView[]): ChatResponse["actions"] {
  return views.map(view => ({
    action_id: actionId(view.id, "frame"),
    method: "POST" as const,
    path: "/revit/export-view-frame",
    body: { viewId: view.id, imageSize: 1600, includeMapping: true }
  }));
}

function categoryCounts(rows: Array<Record<string, unknown>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const category = text(row.category) || "Uncategorized";
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])));
}

function findingSummary(inventory: Inventory, rows: Array<Record<string, unknown>>): string {
  if (inventory.elementIds.length === 0) return "0 bounded power-plan elements were visible in this exact view.";
  const counts = categoryCounts(rows);
  const detail = Object.entries(counts).map(([category, count]) => `${category}: ${count}`).join(", ");
  return `${inventory.elementIds.length} bounded power-plan element(s) were visible. ${detail}.`;
}

function block(req: ChatRequest, state: RuntimeState, message: string, results: ToolResult[]): ChatResponse {
  appendGoalProgress(req.session_id, {
    summary: message,
    work_items: state.views.map(view => ({
      id: `view.${view.id}.inspect`,
      title: `Inspect ${view.name}`,
      status: "blocked",
      scope: { kind: "view", view_id: view.id, view_name: view.name, level_name: view.levelName },
      blocker: message,
      evidence_refs: results.map(result => `action:${result.action_id}`)
    }))
  });
  states.delete(req.session_id);
  return terminal(`${message} I made no model changes and did not widen the verified Level scope.`, "failed");
}

function finish(req: ChatRequest, state: RuntimeState, frameResults: ToolResult[]): ChatResponse {
  const invalidFrame = frameResults.some(result => result.status !== "done" || result.path !== "/revit/export-view-frame" || !object(result.result_json));
  if (frameResults.length !== state.views.length || invalidFrame) return block(req, state, "A focused per-view visual frame failed, so the bounded inspection receipt is incomplete.", frameResults);

  const inspectIds = state.views.map(view => `view.${view.id}.inspect`);
  const findings = state.inventories.map(inventory => {
    const rows = state.summaries.get(inventory.view.id) ?? [];
    return { inventory, rows, summary: findingSummary(inventory, rows) };
  });
  appendGoalProgress(req.session_id, {
    summary: `Completed bounded read-only power-plan inspection in ${state.views.length} exact Level view(s); no placement or model write was inferred.`,
    assumptions: [
      {
        id: "power.inspection_profile",
        statement: `Power-plan inspection is bounded to ${POWER_INSPECTION_CATEGORIES.join(", ")} in the exact resolved views.`,
        status: "accepted",
        basis: "structured electrical semantic class and released read-only pilot profile",
        evidence_refs: [...state.evidenceActionIds, ...frameResults.map(result => result.action_id)].map(id => `action:${id}`)
      },
      {
        id: "power.no_implicit_write",
        statement: "Existing visible content is evidence, not authorization to create, move, or delete elements without an exact dry-run target and verified precedent.",
        status: "accepted",
        basis: "bounded mutation safety policy"
      },
      ...findings.map(({ inventory, summary }) => ({
        id: `power.view.${inventory.view.id}.baseline`,
        statement: `${inventory.view.name}: ${summary}`,
        status: "accepted" as const,
        basis: "exact view inventory plus element summary and exported visual frame",
        evidence_refs: [inventory.inventoryActionId, ...(inventory.elementIds.length ? [actionId(inventory.view.id, "summary")] : []), actionId(inventory.view.id, "frame")].map(id => `action:${id}`)
      }))
    ],
    work_items: [
      ...findings.map(({ inventory, summary }) => ({
        id: `view.${inventory.view.id}.inspect`,
        title: `Inspect ${inventory.view.name}`,
        status: "complete",
        scope: { kind: "view", view_id: inventory.view.id, view_name: inventory.view.name, level_name: inventory.view.levelName },
        depends_on: ["scope.resolve"],
        planned_actions: ["bounded power-category inventory", "exact element summaries", "before-state visual frame"],
        evidence_refs: [inventory.inventoryActionId, ...(inventory.elementIds.length ? [actionId(inventory.view.id, "summary")] : []), actionId(inventory.view.id, "frame")].map(id => `action:${id}`),
        result_summary: summary
      })),
      {
        id: "precedent.resolve",
        title: "Resolve applicable current-project precedent and office assumptions",
        status: "ready",
        depends_on: inspectIds,
        planned_actions: ["resolve an exact adjacent-level or office-standard power-plan precedent", "compare category/type/placement evidence", "record accepted or rejected assumptions"],
        result_summary: "The exact Level baseline is inspected. A separate verified precedent is still required before proposing placements."
      },
      {
        id: "design.plan",
        title: "Prepare the bounded design plan",
        status: "pending",
        depends_on: ["precedent.resolve"],
        planned_actions: ["produce exact per-view target ids and coordinates", "dry-run bounded actions", "record a repair/revert strategy"],
        result_summary: "No broad write plan was invented from inventory counts alone."
      }
    ]
  });
  const goal = getActiveGoalForSession(req.session_id);
  if (goal) updateGoal(goal.id, { current_phase: "precedent_resolution", current_step: "Resolve exact current-project or office-standard power-plan precedent" });
  states.delete(req.session_id);
  const details = findings.map(({ inventory, summary }) => `${inventory.view.name} (${inventory.view.id}): ${summary}`).join(" ");
  return terminal(`I completed the bounded Level power-plan pilot inspection. ${details} I preserved the per-view evidence and next action—resolve an exact precedent before any dry-run or model write.`, "complete");
}

function continueRuntime(req: ChatRequest, state: RuntimeState): ChatResponse {
  const results = matchingResults(req, state.actionIds);
  if (results.length !== state.actionIds.length) return block(req, state, "One or more bounded power-plan inspection actions are missing.", results);

  if (state.stage === "inventory") {
    const inventories = state.views.map(view => parseInventory(view, results.find(result => result.action_id === actionId(view.id, "inventory"))!));
    if (inventories.some(item => item === null)) return block(req, state, "A power-plan inventory was malformed, truncated, outside its exact view, or missing the requested category-filter receipt.", results);
    const accepted = inventories as Inventory[];
    const actions = summaryActions(accepted);
    if (actions.length === 0) {
      const frames = frameActions(state.views);
      states.set(req.session_id, { ...state, stage: "frame", actionIds: frames.map(action => action.action_id), inventories: accepted, evidenceActionIds: [...state.evidenceActionIds, ...results.map(result => result.action_id)] });
      return response("The exact power views are empty for the bounded inspection categories. I am exporting focused before-state frames to preserve that finding.", frames);
    }
    states.set(req.session_id, { ...state, stage: "summary", actionIds: actions.map(action => action.action_id), inventories: accepted, evidenceActionIds: [...state.evidenceActionIds, ...results.map(result => result.action_id)] });
    return response("I completed exact per-view power inventories and am reading back only those bounded element IDs before visual inspection.", actions);
  }

  if (state.stage === "summary") {
    const summaries = new Map<number, Array<Record<string, unknown>>>();
    for (const inventory of state.inventories) {
      if (inventory.elementIds.length === 0) { summaries.set(inventory.view.id, []); continue; }
      const result = results.find(candidate => candidate.action_id === actionId(inventory.view.id, "summary"));
      if (!result || result.status !== "done" || result.path !== "/revit/get-element-summary" || !Array.isArray(result.result_json)) return block(req, state, "An exact element-summary readback failed.", results);
      const rows = result.result_json.map(object);
      const ids = rows.map(row => row?.id);
      if (rows.some(row => !row || row.found !== true) || ids.length !== inventory.elementIds.length || !inventory.elementIds.every(id => ids.includes(id))) return block(req, state, "Element-summary readback did not exactly cover the inventoried IDs.", results);
      summaries.set(inventory.view.id, rows as Array<Record<string, unknown>>);
    }
    const frames = frameActions(state.views);
    states.set(req.session_id, { ...state, stage: "frame", actionIds: frames.map(action => action.action_id), summaries, evidenceActionIds: [...state.evidenceActionIds, ...results.map(result => result.action_id)] });
    return response("The bounded IDs read back exactly. I am exporting one focused visual frame per resolved view before recording findings and next actions.", frames);
  }

  return finish(req, state, results);
}

export function startAecLevelPowerPlanPilot(req: ChatRequest, task: AecSemanticTaskV1, views: ResolvedView[]): ChatResponse | null {
  if (!isPowerPlanTask(task)) return null;
  if (views.length === 0 || views.length > MAX_PILOT_VIEWS) {
    const blocker = views.length === 0 ? "No exact power-plan view was resolved." : `The pilot supports at most ${MAX_PILOT_VIEWS} exact power-plan views, but ${views.length} were resolved.`;
    appendGoalProgress(req.session_id, { summary: blocker, work_item: { id: "scope.inspect", title: "Inspect current model and view state in the resolved scope", status: "blocked", blocker } });
    return terminal(`${blocker} I stopped without model changes rather than silently sampling or widening the scope.`, "failed");
  }
  const actions = inventoryActions(views);
  states.set(req.session_id, { task, views, stage: "inventory", actionIds: actions.map(action => action.action_id), inventories: [], summaries: new Map(), evidenceActionIds: [] });
  appendGoalProgress(req.session_id, {
    summary: `Starting a bounded read-only power-plan pilot in ${views.length} exact view(s).`,
    assumptions: [{ id: "power.no_implicit_write", statement: "The pilot inspects and records exact per-view evidence before any design proposal; no broad write scope is inferred.", status: "accepted", basis: "underspecified Level power-plan request" }]
  });
  return response(`I resolved ${views.length} exact power-plan view(s). I am now inspecting only bounded electrical fixtures, equipment, and wires in those views; no model write is planned.`, actions);
}

export function maybeContinueAecLevelPowerPlanPilot(req: ChatRequest): ChatResponse | null {
  const state = states.get(req.session_id);
  if (!state || !Array.isArray(req.tool_results) || req.tool_results.length === 0) return null;
  return continueRuntime(req, state);
}

export function __testOnlyClearAecLevelPowerPlanPilot(): void { states.clear(); }
