import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { getActiveGoalForSession, setAgentGoal } from "../src/goals/service.js";
import { __testOnlyClearAecScopeWorkPackageStates, maybeRunAecScopeWorkPackage } from "../src/deterministic/aec_scope_work_package_runtime.js";

function task(prompt: string): AecSemanticTaskV1 { return { schema: AEC_SEMANTIC_TASK_V1_SCHEMA, operation: "layout", subject: { kind: "class", semantic_class: "electrical_equipment", terms: ["power plan"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] }, scope: { kind: "level", document: null, levels: ["L4"], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null }, reference: { strategy: "current_project_precedent", source_description: null, source_room: null }, mutation: { kind: "create", requested: true }, outputs: ["summary", "verification"], execution: { max_results: 100, max_primary_actions: 8, allow_document_fallback: false, requires_visual_verification: true }, confidence: { value: 0.95, ambiguity: "low", reasons: ["level and discipline resolved"] }, evidence: { user_text: prompt } }; }
function tagTask(prompt: string): AecSemanticTaskV1 { return { ...task(prompt), operation: "tag", subject: { kind: "category", semantic_class: "air_terminal", terms: ["air terminals"], categories: ["OST_DuctTerminal"], family_name: null, type_name: null, system_name: null, identifiers: [] }, reference: { strategy: "none", source_description: null, source_room: null } }; }
function req(session: string, prompt = "", tool_results?: ChatRequest["tool_results"]): ChatRequest { return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: session, message_id: `${session}-${tool_results?.length ?? 0}`, user_text: prompt, tool_results }; }
const levelResult = { action_id: "aec-scope-resolve-levels", method: "POST" as const, path: "/revit/query", status: "done" as const, result_json: [{ id: 1362791, name: "L4", category: "Levels" }] };

test("runtime persists scope package then completes bounded per-view power-plan inspection", () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT; const root = fs.mkdtempSync(path.join(os.tmpdir(), "aec-scope-runtime-")); process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    __testOnlyClearAecScopeWorkPackageStates(); const prompt = "Lay out the power plans on Level 4.";
    const first = maybeRunAecScopeWorkPackage(req("scope-runtime", prompt), task(prompt));
    assert.deepEqual(first?.actions.map(action => action.path), ["/revit/query"]);
    assert.equal(getActiveGoalForSession("scope-runtime")?.work_items.find(item => item.id === "scope.resolve")?.status, "ready");
    const second = maybeRunAecScopeWorkPackage(req("scope-runtime", "", [levelResult]));
    assert.deepEqual(second?.actions, [{ action_id: "aec-scope-resolve-views", method: "POST", path: "/revit/views", body: { action: "list", levelNames: ["L4"], includeTemplates: false, offset: 0, limit: 50, semanticGroups: ["power"] } }]);
    const third = maybeRunAecScopeWorkPackage(req("scope-runtime", "", [{ action_id: "aec-scope-resolve-views", method: "POST", path: "/revit/views", status: "done", result_json: { status: "ok", count: 2, returned: 2, truncated: false, appliedFilters: ["exclude_templates", "level_names_exact", "semantic_groups"], views: [{ id: 101, name: "L4 - Power", levelName: "L4", type: "FloorPlan" }, { id: 102, name: "L4 - Power Enlarged", levelName: "L4", type: "FloorPlan" }] } }]));
    assert.deepEqual(third?.actions.map(action => [action.path, action.body]), [
      ["/revit/find-elements", { viewId: 101, categories: ["OST_ElectricalFixtures", "OST_ElectricalEquipment", "OST_Wire"], limit: 500 }],
      ["/revit/find-elements", { viewId: 102, categories: ["OST_ElectricalFixtures", "OST_ElectricalEquipment", "OST_Wire"], limit: 500 }]
    ]);
    const inventory = (viewId: number, ids: number[]) => ({ action_id: `aec-power-view-${viewId}-inventory`, method: "POST" as const, path: "/revit/find-elements", status: "done" as const, result_json: { status: "Ok", scope: { kind: "View", viewIds: [viewId], sheetId: null }, elementIds: ids, categoryFilterApplied: true, resolvedCategories: [{ builtInToken: "OST_ElectricalFixtures" }, { builtInToken: "OST_ElectricalEquipment" }, { builtInToken: "OST_Wire" }], truncated: false, warnings: [] } });
    const fourth = maybeRunAecScopeWorkPackage(req("scope-runtime", "", [inventory(101, [1001, 1002]), inventory(102, [])]));
    assert.deepEqual(fourth?.actions, [{ action_id: "aec-power-view-101-summary", method: "POST", path: "/revit/get-element-summary", body: { viewId: 101, elementIds: [1001, 1002] } }]);
    const fifth = maybeRunAecScopeWorkPackage(req("scope-runtime", "", [{ action_id: "aec-power-view-101-summary", method: "POST", path: "/revit/get-element-summary", status: "done", result_json: [{ id: 1001, found: true, category: "Electrical Fixtures", name: "Duplex" }, { id: 1002, found: true, category: "Electrical Equipment", name: "Panel" }] }]));
    assert.deepEqual(fifth?.actions.map(action => [action.path, action.body]), [["/revit/export-view-frame", { viewId: 101, imageSize: 1600, includeMapping: true }], ["/revit/export-view-frame", { viewId: 102, imageSize: 1600, includeMapping: true }]]);
    const sixth = maybeRunAecScopeWorkPackage(req("scope-runtime", "", [
      { action_id: "aec-power-view-101-frame", method: "POST", path: "/revit/export-view-frame", status: "done", result_json: { frameId: "frame-101", viewId: 101 } },
      { action_id: "aec-power-view-102-frame", method: "POST", path: "/revit/export-view-frame", status: "done", result_json: { frameId: "frame-102", viewId: 102 } }
    ]));
    assert.deepEqual(sixth?.actions, []);
    assert.equal(sixth?.aec_query_receipt?.workflow_id, "query.level_power_plan_pilot");
    assert.equal(sixth?.aec_query_receipt?.status, "complete");
    const goal = getActiveGoalForSession("scope-runtime");
    assert.equal(goal?.work_items.find(item => item.id === "scope.resolve")?.status, "complete");
    assert.deepEqual((goal?.work_items.find(item => item.id === "scope.resolve")?.scope as any)?.resolved_view_ids, [101, 102]);
    assert.equal(goal?.work_items.find(item => item.id === "view.101.inspect")?.status, "complete");
    assert.match(goal?.work_items.find(item => item.id === "view.101.inspect")?.result_summary ?? "", /Electrical Fixtures: 1/);
    assert.equal(goal?.work_items.find(item => item.id === "view.102.inspect")?.status, "complete");
    assert.match(goal?.work_items.find(item => item.id === "view.102.inspect")?.result_summary ?? "", /0 bounded power-plan elements/);
    assert.equal(goal?.work_items.find(item => item.id === "precedent.resolve")?.status, "ready");
    assert.deepEqual(goal?.work_items.find(item => item.id === "precedent.resolve")?.depends_on, ["view.101.inspect", "view.102.inspect"]);
    assert.deepEqual(goal?.work_items.find(item => item.id === "design.plan")?.depends_on, ["precedent.resolve"]);
    assert.equal(goal?.work_items.find(item => item.id === "design.execute")?.status, "skipped");
    assert.deepEqual(goal?.work_items.find(item => item.id === "view.101.execute")?.depends_on, ["view.101.inspect", "design.plan"]);
    assert.equal(goal?.work_items.find(item => item.id === "view.102.verify")?.status, "pending");
    assert.deepEqual(goal?.work_items.find(item => item.id === "verify.visual")?.depends_on, ["view.101.verify", "view.102.verify"]);
    assert.equal(goal?.assumptions.find(item => item.id === "power.no_implicit_write")?.status, "accepted");
    assert.match(goal?.assumptions.find(item => item.id === "power.view.101.baseline")?.statement ?? "", /2 bounded power-plan element/);
    assert.equal(goal?.current_phase, "precedent_resolution");
    assert.match(goal?.current_step ?? "", /exact current-project or office-standard power-plan precedent/);
  } finally { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); }
});

test("power-plan pilot rejects a truncated per-view inventory without summaries or writes", () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT; const root = fs.mkdtempSync(path.join(os.tmpdir(), "aec-power-pilot-block-")); process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    __testOnlyClearAecScopeWorkPackageStates(); const session = "power-pilot-truncated"; const prompt = "Lay out the power plans on Level 4.";
    maybeRunAecScopeWorkPackage(req(session, prompt), task(prompt));
    maybeRunAecScopeWorkPackage(req(session, "", [levelResult]));
    maybeRunAecScopeWorkPackage(req(session, "", [{ action_id: "aec-scope-resolve-views", method: "POST", path: "/revit/views", status: "done", result_json: { status: "ok", count: 1, returned: 1, truncated: false, appliedFilters: ["exclude_templates", "level_names_exact", "semantic_groups"], views: [{ id: 101, name: "L4 - Power", levelName: "L4", type: "FloorPlan" }] } }]));
    const result = maybeRunAecScopeWorkPackage(req(session, "", [{ action_id: "aec-power-view-101-inventory", method: "POST", path: "/revit/find-elements", status: "done", result_json: { scope: { kind: "View", viewIds: [101] }, elementIds: [1], categoryFilterApplied: true, resolvedCategories: [{ builtInToken: "OST_ElectricalFixtures" }, { builtInToken: "OST_ElectricalEquipment" }, { builtInToken: "OST_Wire" }], truncated: true } }]));
    assert.deepEqual(result?.actions, []);
    assert.equal(result?.aec_query_receipt?.status, "failed");
    assert.match(result?.assistant_message ?? "", /malformed, truncated/i);
    assert.equal(getActiveGoalForSession(session)?.work_items.find(item => item.id === "view.101.inspect")?.status, "blocked");
  } finally { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); }
});

test("runtime blocks empty and truncated scope discovery without model actions", () => {
  for (const payload of [{ count: 0, returned: 0, truncated: false, views: [] }, { count: 60, returned: 50, truncated: true, views: [{ id: 1, name: "L4 - Power", levelName: "L4" }] }]) {
    const previous = process.env.OPERATOR_WORKSPACE_ROOT; const root = fs.mkdtempSync(path.join(os.tmpdir(), "aec-scope-block-")); process.env.OPERATOR_WORKSPACE_ROOT = root;
    try { __testOnlyClearAecScopeWorkPackageStates(); const session = `block-${payload.truncated}`; const prompt = "Complete Level 4 power plans."; maybeRunAecScopeWorkPackage(req(session, prompt), task(prompt)); maybeRunAecScopeWorkPackage(req(session, "", [levelResult])); const result = maybeRunAecScopeWorkPackage(req(session, "", [{ action_id: "aec-scope-resolve-views", method: "POST", path: "/revit/views", status: "done", result_json: payload }])); assert.deepEqual(result?.actions, []); assert.equal(getActiveGoalForSession(session)?.work_items.find(item => item.id === "scope.resolve")?.status, "blocked"); }
    finally { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("runtime rejects wrong-level and missing-filter receipts instead of trusting widened results", () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT; const root = fs.mkdtempSync(path.join(os.tmpdir(), "aec-scope-invalid-receipt-")); process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    for (const payload of [
      { count: 1, returned: 1, truncated: false, appliedFilters: ["exclude_templates", "level_names_exact", "semantic_groups"], views: [{ id: 1, name: "L3 - Power", levelName: "L3" }] },
      { count: 1, returned: 1, truncated: false, appliedFilters: ["exclude_templates"], views: [{ id: 1, name: "L4 - Power", levelName: "L4" }] },
      { count: 51, returned: 50, truncated: false, appliedFilters: ["exclude_templates", "level_names_exact", "semantic_groups"], views: [{ id: 1, name: "L4 - Power", levelName: "L4" }] }
    ]) {
      __testOnlyClearAecScopeWorkPackageStates();
      const session = `invalid-receipt-${payload.count}-${payload.appliedFilters.length}-${payload.views[0]?.levelName}`;
      const prompt = "Complete Level 4 power plans.";
      maybeRunAecScopeWorkPackage(req(session, prompt), task(prompt));
      maybeRunAecScopeWorkPackage(req(session, "", [levelResult]));
      const result = maybeRunAecScopeWorkPackage(req(session, "", [{ action_id: "aec-scope-resolve-views", method: "POST", path: "/revit/views", status: "done", result_json: payload }]));
      assert.deepEqual(result?.actions, []);
      assert.equal(getActiveGoalForSession(session)?.work_items.find(item => item.id === "scope.resolve")?.status, "blocked");
    }
  } finally { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); }
});

test("runtime blocks an unresolved level alias before querying views", () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT; const root = fs.mkdtempSync(path.join(os.tmpdir(), "aec-scope-missing-level-")); process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    __testOnlyClearAecScopeWorkPackageStates(); const session = "missing-level"; const prompt = "Complete Level 4 power plans.";
    maybeRunAecScopeWorkPackage(req(session, prompt), task(prompt));
    const result = maybeRunAecScopeWorkPackage(req(session, "", [{ ...levelResult, result_json: [{ id: 1, name: "L3" }] }]));
    assert.deepEqual(result?.actions, []);
    assert.match(result?.assistant_message ?? "", /not found/i);
    assert.equal(result?.aec_query_receipt?.status, "failed");
  } finally { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); }
});

test("authoritative Sidecar request safely supersedes an empty same-session auto goal", () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT; const root = fs.mkdtempSync(path.join(os.tmpdir(), "aec-auto-goal-")); process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const session = "auto-goal"; const prompt = "Lay out the mechanical plans on Level 4.";
    setAgentGoal(session, { title: "expanded", objective: "Target guessed M104 and M204 sheets.", success_criteria: ["Complete or block truthfully."], created_by: "auto_goal:chat", current_phase: "observe", current_step: "preflight" } as any);
    const request = req(session, "Target guessed M104 and M204 sheets."); request.context = { ui: { authoritative_user_text: prompt } };
    const first = maybeRunAecScopeWorkPackage(request, task(prompt));
    assert.deepEqual(first?.actions.map(action => action.path), ["/revit/query"]);
    assert.equal(getActiveGoalForSession(session)?.objective, prompt);
  } finally { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolved level tag scope enters the bounded per-view tag runtime instead of stopping at a plan", () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT; const root = fs.mkdtempSync(path.join(os.tmpdir(), "aec-level-tag-integration-")); process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    __testOnlyClearAecScopeWorkPackageStates(); const session = "scope-level-tag"; const prompt = "Tag all air terminals on Level 4.";
    const first = maybeRunAecScopeWorkPackage(req(session, prompt), tagTask(prompt));
    assert.deepEqual(first?.actions.map(action => action.path), ["/revit/query"]);
    const second = maybeRunAecScopeWorkPackage(req(session, "", [levelResult]));
    assert.deepEqual((second?.actions[0]?.body as any)?.semanticGroups, ["mechanical"]);
    const third = maybeRunAecScopeWorkPackage(req(session, "", [{ action_id: "aec-scope-resolve-views", method: "POST", path: "/revit/views", status: "done", result_json: { status: "ok", count: 2, returned: 2, truncated: false, appliedFilters: ["exclude_templates", "level_names_exact", "semantic_groups"], views: [{ id: 101, name: "L4 HVAC", levelName: "L4", type: "FloorPlan" }, { id: 102, name: "L4 HVAC Enlarged", levelName: "L4", type: "FloorPlan" }] } }]));
    assert.deepEqual(third?.actions.map(action => action.path), ["/revit/find-elements", "/revit/find-elements"]);
    assert.deepEqual(third?.actions.map(action => action.body), [{ viewId: 101, categories: ["OST_DuctTerminal"], limit: 5000 }, { viewId: 102, categories: ["OST_DuctTerminal"], limit: 5000 }]);
    assert.equal(third?.aec_query_receipt, undefined);
    assert.equal(getActiveGoalForSession(session)?.work_items.find(item => item.id === "view.101.inspect")?.status, "ready");
  } finally { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); }
});
