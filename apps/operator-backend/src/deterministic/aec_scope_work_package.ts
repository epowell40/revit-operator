import type { ActionCall } from "../contracts.js";
import { normalizeAecSemanticTaskV1, type AecSemanticTaskV1 } from "../aec_semantic_task.js";

export const AEC_SCOPE_WORK_PACKAGE_V1_SCHEMA = "revit-operator.aec-scope-work-package.v1" as const;

export type AecScopeWorkItemV1 = {
  id: string;
  title: string;
  status: "pending" | "ready";
  scope: Record<string, unknown>;
  depends_on: string[];
  planned_actions: string[];
};

export type AecScopeWorkPackageV1 = {
  schema: typeof AEC_SCOPE_WORK_PACKAGE_V1_SCHEMA;
  status: "ready" | "blocked" | "not_applicable";
  summary: string;
  work_items: AecScopeWorkItemV1[];
  assumptions: Array<{ id: string; statement: string; status: "accepted" | "proposed"; basis: string }>;
  discovery_actions: ActionCall[];
  blockers: string[];
};

const PACKAGE_OPERATIONS = new Set(["layout", "place", "move", "tag", "annotate", "view", "sheet"]);

function empty(status: AecScopeWorkPackageV1["status"], summary: string, blockers: string[] = []): AecScopeWorkPackageV1 {
  return { schema: AEC_SCOPE_WORK_PACKAGE_V1_SCHEMA, status, summary, work_items: [], assumptions: [], discovery_actions: [], blockers };
}

function semanticGroups(task: AecSemanticTaskV1): string[] {
  switch (task.subject.semantic_class) {
    case "receptacle":
    case "electrical_equipment": return ["power"];
    case "light_fixture": return ["lighting"];
    case "air_terminal":
    case "mechanical_equipment": return ["mechanical"];
    case "plumbing_fixture": return ["plumbing"];
    default: return [];
  }
}

function action(actionId: string, path: string, body: Record<string, unknown>): ActionCall {
  return { action_id: actionId, method: "POST", path, body };
}

function packageItems(task: AecSemanticTaskV1, scope: Record<string, unknown>, resolutionAction: string): AecScopeWorkItemV1[] {
  const operation = task.operation === "tag" ? "tag" : task.operation === "annotate" ? "annotate" : "design";
  return [
    { id: "scope.resolve", title: "Resolve the exact bounded Revit scope", status: "ready", scope, depends_on: [], planned_actions: [resolutionAction] },
    { id: "scope.inspect", title: "Inspect current model and view state in the resolved scope", status: "pending", scope, depends_on: ["scope.resolve"], planned_actions: ["bounded per-view model inventory", "capture before-state evidence"] },
    { id: "precedent.resolve", title: "Resolve applicable current-project precedent and office assumptions", status: "pending", scope, depends_on: ["scope.inspect"], planned_actions: ["compare nearby completed scope", "record accepted or rejected assumptions"] },
    { id: `${operation}.plan`, title: `Prepare the bounded ${operation} plan`, status: "pending", scope, depends_on: ["precedent.resolve"], planned_actions: ["dry-run exact target actions", "record proposed element/view ids"] },
    { id: `${operation}.execute`, title: `Execute and read back the bounded ${operation} work`, status: "pending", scope, depends_on: [`${operation}.plan`], planned_actions: ["explicit apply after successful dry-run", "deterministic readback"] },
    { id: "verify.visual", title: "Perform focused visual QA and bounded repair", status: "pending", scope, depends_on: [`${operation}.execute`], planned_actions: ["focused capture", "repair only evidenced defects", "final readback"] }
  ];
}

export function buildAecScopeWorkPackage(value: unknown): AecScopeWorkPackageV1 {
  let task: AecSemanticTaskV1;
  try { task = normalizeAecSemanticTaskV1(value); } catch (error) {
    return empty("blocked", "The semantic task is invalid.", [error instanceof Error ? error.message : "Invalid semantic task"]);
  }
  if (!PACKAGE_OPERATIONS.has(task.operation) || !task.mutation.requested) return empty("not_applicable", "This task does not require a persistent design work package.");
  if (task.confidence.ambiguity === "material" || task.confidence.value < 0.75) return empty("blocked", "Material task ambiguity blocks autonomous decomposition.", ["Resolve the task meaning before creating executable work items."]);

  if (task.scope.kind === "level" && task.scope.levels.length > 0 && task.scope.levels.length <= 8) {
    const groups = semanticGroups(task);
    const scope = { kind: "level", levels: task.scope.levels, semantic_groups: groups, resolved_view_ids: [] };
    return {
      schema: AEC_SCOPE_WORK_PACKAGE_V1_SCHEMA,
      status: "ready",
      summary: `Resolve bounded ${groups[0] ?? "plan"} views for ${task.scope.levels.join(", ")} before model work.`,
      work_items: packageItems(task, scope, "POST /revit/views with exact level predicates"),
      assumptions: [
        { id: "scope.level", statement: `The requested level scope is exactly ${task.scope.levels.join(", ")}.`, status: "accepted", basis: "provider-neutral semantic task" },
        ...(groups.length ? [{ id: "scope.discipline", statement: `Use ${groups.join("/")} plan views unless live metadata disproves that classification.`, status: "proposed" as const, basis: "structured semantic class" }] : [])
      ],
      discovery_actions: [action("aec-scope-resolve-levels", "/revit/query", { category: "OST_Levels", limit: 500 })],
      blockers: []
    };
  }

  if (task.scope.kind === "view" && task.scope.views.length > 0 && task.scope.views.length <= 32) {
    const ids = task.scope.views.map(view => view.id).filter((id): id is number => Number.isSafeInteger(id) && (id as number) > 0);
    const names = task.scope.views.map(view => view.name).filter((name): name is string => typeof name === "string" && name.length > 0);
    if (ids.length + names.length < task.scope.views.length) return empty("blocked", "Every requested view must have an exact id or exact name.", ["Unresolved view scope would risk silent widening."]);
    const body: Record<string, unknown> = { action: "list", includeTemplates: false, offset: 0, limit: 50 };
    if (ids.length) body.viewIds = ids;
    if (names.length) body.viewNames = names;
    const scope = { kind: "view", views: task.scope.views, resolved_view_ids: ids };
    return { schema: AEC_SCOPE_WORK_PACKAGE_V1_SCHEMA, status: "ready", summary: "Resolve the exact requested views before model work.", work_items: packageItems(task, scope, "POST /revit/views with exact id/name predicates"), assumptions: [{ id: "scope.views", statement: "Only the exact requested views are in scope.", status: "accepted", basis: "provider-neutral semantic task" }], discovery_actions: [action("aec-scope-resolve-views", "/revit/views", body)], blockers: [] };
  }

  if (task.scope.kind === "sheet" && task.scope.sheets.length > 0 && task.scope.sheets.length <= 8) {
    const scope = { kind: "sheet", sheets: task.scope.sheets, resolved_sheet_ids: [] };
    return { schema: AEC_SCOPE_WORK_PACKAGE_V1_SCHEMA, status: "ready", summary: "Resolve each exact sheet and its placed views before sheet or model work.", work_items: packageItems(task, scope, "POST /revit/sheets detail for each exact sheet number"), assumptions: [{ id: "scope.sheets", statement: `Only sheets ${task.scope.sheets.join(", ")} are in scope.`, status: "accepted", basis: "provider-neutral semantic task" }], discovery_actions: task.scope.sheets.map((sheet, index) => action(`aec-scope-resolve-sheet-${index + 1}`, "/revit/sheets", { action: "detail", sheetNumber: sheet, includePlacedViews: true, includeViewports: true, includeViewportGeometry: true, includeTitleBlocks: true, includeSheetOutline: true })), blockers: [] };
  }

  if (task.scope.kind === "area") return empty("blocked", "Area scope is represented but lacks a released exact area-to-view resolver.", ["Do not substitute a document-wide scan or guess from a partial area name."]);
  return empty("not_applicable", `Scope '${task.scope.kind}' is not handled by the bounded scope work-package planner.`);
}
