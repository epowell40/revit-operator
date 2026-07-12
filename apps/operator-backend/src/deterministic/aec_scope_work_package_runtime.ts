import type { ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import type { AecSemanticTaskV1 } from "../aec_semantic_task.js";
import { appendGoalProgress, getActiveGoalForSession, setAgentGoal } from "../goals/service.js";
import { buildAecScopeWorkPackage, type AecScopeWorkPackageV1 } from "./aec_scope_work_package.js";
import { resolveLevelIdentities, type ResolvedLevelIdentity } from "./aec_level_identity.js";
import { __testOnlyClearAecLevelTagRuntime, maybeContinueAecLevelTagRuntime, startAecLevelTagRuntime } from "./aec_level_tag_runtime.js";

type RuntimeState = { task: AecSemanticTaskV1; package: AecScopeWorkPackageV1; stage: "levels" | "scope"; action_ids: string[]; evidence_action_ids: string[]; resolved_levels: ResolvedLevelIdentity[] };
const states = new Map<string, RuntimeState>();

function response(message: string, actions: ChatResponse["actions"] = []): ChatResponse {
  return { version: "operator.backend.v1", assistant_message: message, actions };
}
function terminal(message: string, status: "complete" | "failed"): ChatResponse {
  return { ...response(message), aec_query_receipt: { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status, workflow_id: "query.scope_work_package", bounded: true, broadened: false } };
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function idsFromViews(results: ToolResult[]): Array<{ id: number; name: string; levelName: string | null; type: string | null }> {
  const rows: Array<{ id: number; name: string; levelName: string | null; type: string | null }> = [];
  for (const result of results) {
    const payload = object(result.result_json);
    const views = Array.isArray(payload?.views) ? payload.views : [];
    for (const raw of views) {
      const row = object(raw); if (!row || !Number.isSafeInteger(row.id) || (row.id as number) <= 0 || !text(row.name)) continue;
      rows.push({ id: row.id as number, name: text(row.name), levelName: text(row.levelName) || null, type: text(row.type) || null });
    }
  }
  return [...new Map(rows.map(row => [row.id, row])).values()].slice(0, 50);
}

function idsFromSheets(results: ToolResult[]): Array<{ id: number; name: string; sheet: string }> {
  const rows: Array<{ id: number; name: string; sheet: string }> = [];
  for (const result of results) {
    const payload = object(result.result_json); if (!payload) continue;
    const sheetNumber = text(payload.sheetNumber ?? object(payload.sheet)?.number);
    const placed = Array.isArray(payload.placedViews) ? payload.placedViews : Array.isArray(object(payload.sheet)?.placedViews) ? object(payload.sheet)?.placedViews as unknown[] : [];
    for (const raw of placed) {
      const row = object(raw); if (!row) continue;
      const id = row.viewId ?? row.id; const name = text(row.viewName ?? row.name);
      if (Number.isSafeInteger(id) && (id as number) > 0 && name) rows.push({ id: id as number, name, sheet: sheetNumber });
    }
  }
  return [...new Map(rows.map(row => [row.id, row])).values()].slice(0, 50);
}

function continuation(req: ChatRequest, state: RuntimeState): ChatResponse {
  const results = Array.isArray(req.tool_results) ? req.tool_results.filter(result => state.action_ids.includes(result.action_id)) : [];
  if (results.length !== state.action_ids.length || results.some(result => result.status !== "done")) {
    appendGoalProgress(req.session_id, { summary: "Exact scope discovery failed; no design action was attempted.", work_item: { id: "scope.resolve", title: "Resolve the exact bounded Revit scope", status: "blocked", blocker: "One or more bounded scope discovery actions failed.", evidence_refs: results.map(result => `action:${result.action_id}`) } });
    states.delete(req.session_id);
    return terminal("I could not resolve the exact bounded view/sheet scope, so I stopped before any model change. The blocker and action receipts are preserved in the active work package.", "failed");
  }
  if (state.stage === "levels") {
    const resolution = resolveLevelIdentities(state.task.scope.levels, results[0]?.result_json);
    if (resolution.status !== "resolved") {
      const blocker = resolution.blockers.join(" ");
      appendGoalProgress(req.session_id, { summary: blocker, work_item: { id: "scope.resolve", title: "Resolve the exact bounded Revit scope", status: "blocked", blocker, evidence_refs: results.map(result => `action:${result.action_id}`) } });
      states.delete(req.session_id);
      return terminal(`${blocker} I made no model changes and did not broaden the level scope.`, "failed");
    }
    const semanticGroups = state.package.assumptions.some(item => item.id === "scope.discipline")
      ? ((state.package.work_items[0]?.scope.semantic_groups as string[] | undefined) ?? []) : [];
    const body: Record<string, unknown> = { action: "list", levelNames: resolution.levels.map(level => level.name), includeTemplates: false, offset: 0, limit: 50 };
    if (semanticGroups.length) body.semanticGroups = semanticGroups;
    const viewAction = { action_id: "aec-scope-resolve-views", method: "POST" as const, path: "/revit/views", body };
    states.set(req.session_id, { ...state, stage: "scope", action_ids: [viewAction.action_id], evidence_action_ids: [...state.evidence_action_ids, ...results.map(result => result.action_id)], resolved_levels: resolution.levels });
    appendGoalProgress(req.session_id, { summary: `Resolved ${resolution.levels.map(level => `${level.requested} -> ${level.name} (${level.id})`).join(", ")}; querying exact matching views next.`, assumptions: resolution.levels.map(level => ({ id: `scope.level.${level.id}`, statement: `User level '${level.requested}' resolves uniquely to live level '${level.name}' id ${level.id}.`, status: "accepted", basis: `bounded level inventory; ${level.match}`, evidence_refs: results.map(result => `action:${result.action_id}`) })) });
    return response(`I resolved the requested level to ${resolution.levels.map(level => `${level.name} (id ${level.id})`).join(", ")} and am now querying only exact matching graphical views.`, [viewAction]);
  }
  const resolved = state.task.scope.kind === "sheet" ? idsFromSheets(results) : idsFromViews(results);
  const anyTruncated = results.some(result => object(result.result_json)?.truncated === true);
  const overBudget = results.some(result => {
    const payload = object(result.result_json);
    return typeof payload?.count === "number" && payload.count > 50;
  });
  const expectedLevels = state.resolved_levels.length ? state.resolved_levels.map(level => level.name) : state.task.scope.levels;
  const levelMismatch = state.task.scope.kind === "level" && resolved.some(view => !("levelName" in view) || !view.levelName || !expectedLevels.some(level => level.toLocaleLowerCase() === view.levelName!.toLocaleLowerCase()));
  const missingFilterReceipt = state.task.scope.kind === "level" && results.some(result => {
    const filters = object(result.result_json)?.appliedFilters;
    return !Array.isArray(filters) || !filters.includes("level_names_exact") || (state.package.assumptions.some(item => item.id === "scope.discipline") && !filters.includes("semantic_groups"));
  });
  if (resolved.length === 0 || anyTruncated || overBudget || levelMismatch || missingFilterReceipt) {
    const blocker = resolved.length === 0
      ? "No exact matching graphical views were returned."
      : anyTruncated || overBudget
        ? "The bounded view query exceeded its 50-view work budget; exact whole-scope coverage is not proven."
        : levelMismatch
          ? "The view query returned a level outside the exact requested scope."
          : "The view query did not return the required exact-filter receipt.";
    appendGoalProgress(req.session_id, { summary: blocker, work_item: { id: "scope.resolve", title: "Resolve the exact bounded Revit scope", status: "blocked", blocker, evidence_refs: results.map(result => `action:${result.action_id}`) } });
    states.delete(req.session_id);
    return terminal(`${blocker} I made no model changes and preserved the bounded discovery evidence for the next repair.`, "failed");
  }
  const scopes = resolved.map(view => ({ kind: "view", view_id: view.id, view_name: view.name, ...(state.task.scope.kind === "sheet" ? { sheet_number: (view as any).sheet } : { level_name: (view as any).levelName }) }));
  const inspectIds = resolved.map(view => `view.${view.id}.inspect`);
  const verifyIds = resolved.map(view => `view.${view.id}.verify`);
  const planItem = state.package.work_items.find(item => item.id.endsWith(".plan"));
  const executeItem = state.package.work_items.find(item => item.id.endsWith(".execute"));
  const visualItem = state.package.work_items.find(item => item.id === "verify.visual");
  const resolvedScope = { original: state.task.scope, resolved_levels: state.resolved_levels, resolved: scopes, resolved_view_ids: resolved.map(view => view.id) };
  const perView = resolved.flatMap(view => [
    { id: `view.${view.id}.inspect`, title: `Inspect ${view.name}`, status: "ready", scope: scopes.find(scope => scope.view_id === view.id), depends_on: ["scope.resolve"], planned_actions: ["bounded view inventory", "before-state capture"] },
    { id: `view.${view.id}.execute`, title: `Execute the requested work in ${view.name}`, status: "pending", scope: scopes.find(scope => scope.view_id === view.id), depends_on: [`view.${view.id}.inspect`, planItem?.id ?? "precedent.resolve"], planned_actions: ["dry-run", "apply", "deterministic readback"] },
    { id: `view.${view.id}.verify`, title: `Visually verify and repair ${view.name}`, status: "pending", scope: scopes.find(scope => scope.view_id === view.id), depends_on: [`view.${view.id}.execute`], planned_actions: ["focused visual QA", "bounded repair", "final evidence"] }
  ]);
  const aggregateUpdates = [
    { id: "precedent.resolve", title: "Resolve applicable current-project precedent and office assumptions", status: "pending", scope: resolvedScope, depends_on: inspectIds, planned_actions: ["compare nearby completed scope", "record accepted or rejected assumptions"] },
    ...(planItem ? [{ ...planItem, status: "pending", scope: resolvedScope, depends_on: ["precedent.resolve"] }] : []),
    ...(executeItem ? [{ ...executeItem, status: "skipped", scope: resolvedScope, result_summary: "Materialized into exact per-view execution work items." }] : []),
    ...(visualItem ? [{ ...visualItem, status: "pending", scope: resolvedScope, depends_on: verifyIds, result_summary: "Consolidate per-view visual verification after every resolved view passes." }] : [])
  ];
  appendGoalProgress(req.session_id, {
    summary: `Resolved ${resolved.length} exact graphical view(s) into bounded persistent work items.`,
    work_items: [
      { id: "scope.resolve", title: "Resolve the exact bounded Revit scope", status: "complete", scope: resolvedScope, evidence_refs: [...state.evidence_action_ids, ...results.map(result => result.action_id)].map(id => `action:${id}`), result_summary: `${resolved.length} exact view(s) resolved.` },
      { id: "scope.inspect", title: "Inspect current model and view state in the resolved scope", status: "skipped", scope: { resolved: scopes }, result_summary: "Materialized into per-view inspection work items." },
      ...aggregateUpdates,
      ...perView
    ]
  });
  const tagRuntime = startAecLevelTagRuntime(req, state.task, resolved.map(view => ({
    id: view.id,
    name: view.name,
    levelName: "levelName" in view ? view.levelName : null
  })));
  states.delete(req.session_id);
  if (tagRuntime) return tagRuntime;
  return terminal(`I resolved ${resolved.length} exact graphical view(s) and persisted separate inspect, execute, and visual-verification work items for each. No model changes were made during scope resolution.`, "complete");
}

export function maybeRunAecScopeWorkPackage(req: ChatRequest, task?: AecSemanticTaskV1 | null): ChatResponse | null {
  const tagContinuation = maybeContinueAecLevelTagRuntime(req);
  if (tagContinuation) return tagContinuation;
  const existingState = states.get(req.session_id);
  if (existingState && Array.isArray(req.tool_results) && req.tool_results.length > 0) return continuation(req, existingState);
  if (!task || (req.user_text ?? "").trim().length === 0 || (req.tool_results?.length ?? 0) > 0) return null;
  const workPackage = buildAecScopeWorkPackage(task);
  if (workPackage.status !== "ready" || workPackage.discovery_actions.length === 0) return null;
  const active = getActiveGoalForSession(req.session_id);
  const objective = task.evidence.user_text.trim();
  if (active && active.related_session_id && active.related_session_id !== req.session_id) return null;
  const context = req.context && typeof req.context === "object" && !Array.isArray(req.context) ? req.context as Record<string, unknown> : null;
  const ui = context?.ui && typeof context.ui === "object" && !Array.isArray(context.ui) ? context.ui as Record<string, unknown> : null;
  const authoritative = typeof ui?.authoritative_user_text === "string" ? ui.authoritative_user_text.trim() : "";
  const replaceableAutoGoal = !!active && active.created_by === "auto_goal:chat" && active.related_session_id === req.session_id && authoritative === objective && (active.work_items?.length ?? 0) === 0 && (active.evidence_log?.length ?? 0) === 0 && (active.action_log?.length ?? 0) === 0 && (active.validation_log?.length ?? 0) === 0;
  if (active && active.objective.trim().toLocaleLowerCase() !== objective.toLocaleLowerCase() && !replaceableAutoGoal) return null;
  setAgentGoal(req.session_id, {
    title: `Scoped Revit work: ${objective.slice(0, 90)}`,
    objective,
    success_criteria: ["Every resolved view/sheet work item has deterministic readback evidence.", "Focused visual QA passes without unresolved obstruction or placement defects.", "No scope is silently widened beyond verified ids."],
    current_phase: "scope_resolution",
    current_step: "Resolve exact bounded views and sheets",
    progress_summary: workPackage.summary,
    work_items: workPackage.work_items,
    assumptions: workPackage.assumptions,
    work_budget: { mode: "semantic_scope_work_package", max_resolved_views: 50, discovery_actions: workPackage.discovery_actions.length }
  });
  states.set(req.session_id, { task, package: workPackage, stage: task.scope.kind === "level" ? "levels" : "scope", action_ids: workPackage.discovery_actions.map(action => action.action_id), evidence_action_ids: [], resolved_levels: [] });
  return response(`${workPackage.summary} I am resolving exact live Revit scope first; this is read-only and will not execute model changes.`, workPackage.discovery_actions);
}

export function __testOnlyClearAecScopeWorkPackageStates(): void { states.clear(); __testOnlyClearAecLevelTagRuntime(); }
