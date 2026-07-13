import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import type { AecSemanticTaskV1 } from "../aec_semantic_task.js";
import { appendGoalProgress } from "../goals/service.js";

export type ResolvedTagView = { id: number; name: string; levelName?: string | null };

type ViewState = ResolvedTagView & {
  element_ids: number[];
  created_tag_ids: number[];
  last_error_count: number;
};

type RuntimeState = {
  task: AecSemanticTaskV1;
  stage: "inventory" | "dry_run" | "apply" | "verify";
  views: ViewState[];
  action_ids: string[];
  action_view_ids: Record<string, number>;
  apply_variant: number;
  hard_failure: string | null;
};

const states = new Map<string, RuntimeState>();
const MAX_VIEWS = 20;
const MAX_TARGETS_PER_VIEW = 5000;
const APPLY_VARIANTS: ReadonlyArray<Record<string, number>> = [
  {},
  { tagWidthPaperInches: 0.55, tagHeightPaperInches: 0.30, clearancePaperInches: 0.03 },
  { tagWidthPaperInches: 0.45, tagHeightPaperInches: 0.25, clearancePaperInches: 0 },
  { tagWidthPaperInches: 0.45, tagHeightPaperInches: 0.45, clearancePaperInches: 0 },
  { tagWidthPaperInches: 0.50, tagHeightPaperInches: 0.80, clearancePaperInches: 0 }
];

function response(message: string, actions: ActionCall[] = []): ChatResponse {
  return { version: "operator.backend.v1", assistant_message: message, actions };
}

function terminal(sessionId: string, message: string, status: "complete" | "failed"): ChatResponse {
  states.delete(sessionId);
  return {
    ...response(message),
    aec_query_receipt: {
      schema: "revit-operator.aec-query-receipt.v1",
      terminal: true,
      status,
      workflow_id: "tag.level_views",
      bounded: true,
      broadened: false
    }
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveIds(value: unknown, max = MAX_TARGETS_PER_VIEW): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is number => Number.isSafeInteger(id) && id > 0))].slice(0, max + 1);
}

function resultsFor(req: ChatRequest, state: RuntimeState): ToolResult[] {
  const incoming = Array.isArray(req.tool_results) ? req.tool_results : [];
  return incoming.filter(result => state.action_ids.includes(result.action_id));
}

function exactBatchOrFailure(req: ChatRequest, state: RuntimeState): { results: ToolResult[]; error: string | null } {
  const results = resultsFor(req, state);
  if (results.length !== state.action_ids.length) return { results, error: "The exact per-view action batch was not fully observed." };
  if (new Set(results.map(result => result.action_id)).size !== state.action_ids.length) return { results, error: "A per-view action result was duplicated." };
  const failed = results.filter(result => result.status !== "done");
  return { results, error: failed.length ? `${failed.length} bounded per-view action(s) failed.` : null };
}

function viewForResult(state: RuntimeState, result: ToolResult): ViewState | null {
  const viewId = state.action_view_ids[result.action_id];
  return state.views.find(view => view.id === viewId) ?? null;
}

function profile(task: AecSemanticTaskV1): "mep" | "electrical" | "architectural" | "auto" {
  switch (task.subject.semantic_class) {
    case "air_terminal":
    case "mechanical_equipment":
    case "plumbing_fixture": return "mep";
    case "receptacle":
    case "electrical_equipment":
    case "light_fixture": return "electrical";
    default: return "auto";
  }
}

function tagBody(state: RuntimeState, view: ViewState, dryRun: boolean, variant = 0): Record<string, unknown> {
  return {
    viewId: view.id,
    elementIds: view.element_ids,
    onlyUntagged: true,
    placementMode: "geometry_aware",
    placementProfile: profile(state.task),
    addLeader: true,
    ensureTagCategoryVisible: true,
    maxRepairAttempts: 180,
    max: view.element_ids.length,
    dryRun,
    ...APPLY_VARIANTS[Math.max(0, Math.min(APPLY_VARIANTS.length - 1, variant))]
  };
}

function actionsFor(state: RuntimeState, stage: RuntimeState["stage"], views: ViewState[], variant = 0): ActionCall[] {
  const actions = views.map(view => {
    const action_id = `aec-level-tag-${stage}-${view.id}${stage === "apply" ? `-v${variant + 1}` : ""}`;
    const body = stage === "inventory"
      ? { viewId: view.id, categories: state.task.subject.categories, limit: MAX_TARGETS_PER_VIEW }
      : tagBody(state, view, stage !== "apply", variant);
    return { action_id, method: "POST" as const, path: stage === "inventory" ? "/revit/find-elements" : "/revit/tag-elements", body };
  });
  state.stage = stage;
  state.action_ids = actions.map(action => action.action_id);
  state.action_view_ids = Object.fromEntries(actions.map((action, index) => [action.action_id, views[index]!.id]));
  return actions;
}

function errorKinds(payload: Record<string, unknown>): string[] {
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  return errors.map(raw => object(raw)?.failureKind).filter((kind): kind is string => typeof kind === "string" && kind.length > 0);
}

function startDryRun(req: ChatRequest, state: RuntimeState): ChatResponse {
  const active = state.views.filter(view => view.element_ids.length > 0);
  if (!active.length) {
    appendGoalProgress(req.session_id, {
      summary: "Exact per-view inventory found no matching tag targets; no model action was required.",
      work_items: state.views.flatMap(view => [
        { id: `view.${view.id}.inspect`, title: `Inspect ${view.name}`, status: "complete", scope: { view_id: view.id }, result_summary: "No matching target elements." },
        { id: `view.${view.id}.execute`, title: `Execute the requested work in ${view.name}`, status: "complete", scope: { view_id: view.id }, result_summary: "No-op; the exact target inventory was empty." },
        { id: `view.${view.id}.verify`, title: `Visually verify and repair ${view.name}`, status: "complete", scope: { view_id: view.id }, result_summary: "No created tags to verify." }
      ])
    });
    return terminal(req.session_id, `No matching elements were present in the ${state.views.length} exact resolved view(s), so no tags were created.`, "complete");
  }
  const actions = actionsFor(state, "dry_run", active);
  states.set(req.session_id, state);
  return response(`I inventoried ${active.reduce((sum, view) => sum + view.element_ids.length, 0)} exact target element(s) across ${active.length} view(s). I am dry-running geometry-aware tag placement before any write.`, actions);
}

function continueInventory(req: ChatRequest, state: RuntimeState, results: ToolResult[]): ChatResponse {
  for (const result of results) {
    const view = viewForResult(state, result);
    const payload = object(result.result_json);
    if (!view || !payload) return terminal(req.session_id, "A bounded inventory result was malformed; no tag action was attempted.", "failed");
    const ids = positiveIds(payload.elementIds);
    const reportedCount = number(payload.count);
    if (payload.truncated === true || ids.length > MAX_TARGETS_PER_VIEW || (reportedCount !== null && reportedCount > MAX_TARGETS_PER_VIEW)) {
      return terminal(req.session_id, `The exact inventory for ${view.name} exceeded the ${MAX_TARGETS_PER_VIEW}-element per-view budget; no tag action was attempted.`, "failed");
    }
    if (reportedCount !== null && reportedCount !== ids.length) {
      return terminal(req.session_id, `The exact inventory receipt for ${view.name} did not account for every returned target id; no tag action was attempted.`, "failed");
    }
    view.element_ids = ids;
    appendGoalProgress(req.session_id, {
      summary: `Inventoried ${ids.length} exact tag target(s) in ${view.name}.`,
      work_item: { id: `view.${view.id}.inspect`, title: `Inspect ${view.name}`, status: "complete", scope: { view_id: view.id }, evidence_refs: [`action:${result.action_id}`], result_summary: `${ids.length} exact target element id(s).` }
    });
    if (ids.length === 0) {
      appendGoalProgress(req.session_id, {
        summary: `${view.name} has no matching targets, so its execution and verification work items are no-ops.`,
        work_items: [
          { id: `view.${view.id}.execute`, title: `Execute the requested work in ${view.name}`, status: "complete", scope: { view_id: view.id }, result_summary: "No-op; exact target inventory was empty." },
          { id: `view.${view.id}.verify`, title: `Visually verify and repair ${view.name}`, status: "complete", scope: { view_id: view.id }, result_summary: "No created tags to verify." }
        ]
      });
    }
  }
  return startDryRun(req, state);
}

function continueDryRun(req: ChatRequest, state: RuntimeState, results: ToolResult[]): ChatResponse {
  const applyViews: ViewState[] = [];
  for (const result of results) {
    const view = viewForResult(state, result);
    const payload = object(result.result_json);
    if (!view || !payload) return terminal(req.session_id, "A geometry-aware dry-run receipt was malformed; no tags were created.", "failed");
    const target = number(payload.targetCount);
    const planned = number(payload.plannedToTag);
    const skipped = number(payload.skippedAlreadyTagged);
    const plans = Array.isArray(object(payload.geometry)?.plans) ? object(payload.geometry)!.plans as unknown[] : [];
    const plansHaveCandidates = plans.every(raw => {
      const count = number(object(raw)?.candidateCount);
      return count !== null && count > 0 && count <= 180;
    });
    if (target !== view.element_ids.length || planned === null || skipped === null || planned + skipped !== target || plans.length !== planned || !plansHaveCandidates) {
      return terminal(req.session_id, `The geometry-aware dry-run for ${view.name} did not prove exact target coverage; no tags were created.`, "failed");
    }
    if (planned > 0) applyViews.push(view);
    appendGoalProgress(req.session_id, {
      summary: `Dry-run proved ${planned} pending and ${skipped} already-tagged target(s) in ${view.name}.`,
      work_item: { id: `view.${view.id}.execute`, title: `Execute the requested work in ${view.name}`, status: planned > 0 ? "ready" : "complete", scope: { view_id: view.id }, evidence_refs: [`action:${result.action_id}`], result_summary: planned > 0 ? `${planned} collision-planned tag(s) ready to apply.` : "All exact targets were already tagged." }
    });
  }
  if (!applyViews.length) return scheduleVerify(req, state);
  state.apply_variant = 0;
  const actions = actionsFor(state, "apply", applyViews, state.apply_variant);
  states.set(req.session_id, state);
  return response(`The dry-run proved exact coverage. I am applying tags in ${applyViews.length} view(s); every kept tag must pass measured-geometry collision readback.`, actions);
}

function scheduleVerify(req: ChatRequest, state: RuntimeState): ChatResponse {
  const active = state.views.filter(view => view.element_ids.length > 0);
  const actions = actionsFor(state, "verify", active);
  states.set(req.session_id, state);
  return response("I finished the bounded apply/repair passes and am running a final no-op readback to prove every exact target is tagged once or report the remaining gap.", actions);
}

function continueApply(req: ChatRequest, state: RuntimeState, results: ToolResult[]): ChatResponse {
  const retryViews: ViewState[] = [];
  for (const result of results) {
    const view = viewForResult(state, result);
    const payload = object(result.result_json);
    if (!view || !payload) return terminal(req.session_id, "A tag apply receipt was malformed; deterministic completion is not proven.", "failed");
    const target = number(payload.targetCount);
    const tagged = number(payload.taggedCount);
    const skipped = number(payload.skippedAlreadyTagged);
    const errors = number(payload.errorCount);
    if (target !== view.element_ids.length || tagged === null || skipped === null || errors === null || tagged + skipped + errors !== target) {
      return terminal(req.session_id, `The apply receipt for ${view.name} did not account for every exact target. I stopped without claiming completion; any returned created ids remain in the action receipt.`, "failed");
    }
    const createdIds = positiveIds(payload.tagIds);
    if (createdIds.length !== tagged) {
      return terminal(req.session_id, `The apply receipt for ${view.name} reported ${tagged} created tag(s) but did not return the same number of unique created ids. I stopped without retrying or claiming completion.`, "failed");
    }
    view.created_tag_ids.push(...createdIds);
    view.created_tag_ids = [...new Set(view.created_tag_ids)];
    view.last_error_count = errors;
    const kinds = errorKinds(payload);
    const retryableKinds = new Set(["tag_unresolved_collision", "tag_unresolved_leader_collision"]);
    const retryable = errors > 0 && kinds.length === errors && kinds.every(kind => retryableKinds.has(kind));
    if (errors > 0 && retryable) retryViews.push(view);
    else if (errors > 0) state.hard_failure = `${errors} non-retryable tag error(s) remained in ${view.name}.`;
    appendGoalProgress(req.session_id, {
      summary: `Apply pass ${state.apply_variant + 1} in ${view.name}: ${tagged} created, ${skipped} already tagged, ${errors} safely rejected.`,
      work_item: { id: `view.${view.id}.execute`, title: `Execute the requested work in ${view.name}`, status: errors > 0 ? "ready" : "complete", scope: { view_id: view.id }, evidence_refs: [`action:${result.action_id}`], result_summary: `${view.created_tag_ids.length} tag id(s) created by this workflow; ${errors} target(s) remain.` }
    });
  }
  if (retryViews.length && state.apply_variant + 1 < APPLY_VARIANTS.length) {
    state.apply_variant += 1;
    const actions = actionsFor(state, "apply", retryViews, state.apply_variant);
    states.set(req.session_id, state);
    return response(`Measured readback safely rejected ${retryViews.reduce((sum, view) => sum + view.last_error_count, 0)} crowded placement(s). I am retrying only those views with bounded alternate candidate spacing.`, actions);
  }
  return scheduleVerify(req, state);
}

function continueVerify(req: ChatRequest, state: RuntimeState, results: ToolResult[]): ChatResponse {
  let complete = !state.hard_failure;
  const summaries: string[] = [];
  for (const result of results) {
    const view = viewForResult(state, result);
    const payload = object(result.result_json);
    const target = number(payload?.targetCount);
    const skipped = number(payload?.skippedAlreadyTagged);
    const planned = number(payload?.plannedToTag);
    const passed = !!view && target === view.element_ids.length && skipped === target && planned === 0;
    complete = complete && passed;
    if (view) {
      summaries.push(`${view.name}: ${skipped ?? 0}/${view.element_ids.length} tagged`);
      appendGoalProgress(req.session_id, {
        summary: passed ? `Final deterministic tag readback passed in ${view.name}.` : `Final deterministic tag readback did not prove complete coverage in ${view.name}.`,
        work_items: [
          { id: `view.${view.id}.execute`, title: `Execute the requested work in ${view.name}`, status: passed ? "complete" : "blocked", scope: { view_id: view.id }, evidence_refs: [`action:${result.action_id}`], blocker: passed ? null : "Not every exact target is tagged.", result_summary: `${skipped ?? 0}/${view.element_ids.length} exact target(s) reported already tagged.` },
          { id: `view.${view.id}.verify`, title: `Visually verify and repair ${view.name}`, status: passed ? "ready" : "blocked", scope: { view_id: view.id }, depends_on: [`view.${view.id}.execute`], evidence_refs: [`action:${result.action_id}`], blocker: passed ? null : "Deterministic coverage is incomplete.", result_summary: passed ? "Deterministic readback passed; focused visual QA remains queued." : "Visual QA cannot close an incomplete deterministic apply." }
        ]
      });
    }
  }
  if (!complete) {
    return terminal(req.session_id, `${state.hard_failure ?? "One or more exact targets remain untagged."} ${summaries.join("; ")}. I stopped without claiming visual completion; receipts and created tag ids are preserved in the active goal.`, "failed");
  }
  appendGoalProgress(req.session_id, {
    summary: `Deterministic level/view tagging completed: ${summaries.join("; ")}. Focused visual QA remains the next queued work item.`,
    work_item: { id: "verify.visual", title: "Perform focused visual QA and bounded repair", status: "ready", depends_on: state.views.map(view => `view.${view.id}.verify`), result_summary: "Every exact target passed deterministic already-tagged readback; visual inspection is not yet claimed." }
  });
  return terminal(req.session_id, `I tagged the exact resolved scope and verified deterministic coverage: ${summaries.join("; ")}. No duplicates were added by retries. Focused visual QA is queued as the remaining step rather than interrupting you for confirmation.`, "complete");
}

export function startAecLevelTagRuntime(req: ChatRequest, task: AecSemanticTaskV1, views: ResolvedTagView[]): ChatResponse | null {
  if (task.operation !== "tag" || !task.mutation.requested) return null;
  if (!task.subject.categories.length || task.subject.categories.length > 8 || !views.length || views.length > MAX_VIEWS) {
    return terminal(req.session_id, "The tag task lacks a bounded exact category/view scope, so no model action was attempted.", "failed");
  }
  const state: RuntimeState = {
    task,
    stage: "inventory",
    views: views.map(view => ({ ...view, element_ids: [], created_tag_ids: [], last_error_count: 0 })),
    action_ids: [],
    action_view_ids: {},
    apply_variant: 0,
    hard_failure: null
  };
  const actions = actionsFor(state, "inventory", state.views);
  states.set(req.session_id, state);
  return response(`I resolved ${views.length} exact graphical view(s). I am inventorying only ${task.subject.categories.join(", ")} in each view before any tag write.`, actions);
}

export function maybeContinueAecLevelTagRuntime(req: ChatRequest): ChatResponse | null {
  const state = states.get(req.session_id);
  if (!state || !Array.isArray(req.tool_results) || req.tool_results.length === 0) return null;
  const batch = exactBatchOrFailure(req, state);
  if (batch.error) {
    appendGoalProgress(req.session_id, { summary: `${batch.error} No broader search or unobserved retry was attempted.` });
    return terminal(req.session_id, `${batch.error} I stopped without widening scope or claiming completion.`, "failed");
  }
  switch (state.stage) {
    case "inventory": return continueInventory(req, state, batch.results);
    case "dry_run": return continueDryRun(req, state, batch.results);
    case "apply": return continueApply(req, state, batch.results);
    case "verify": return continueVerify(req, state, batch.results);
  }
}

export function __testOnlyClearAecLevelTagRuntime(): void { states.clear(); }
