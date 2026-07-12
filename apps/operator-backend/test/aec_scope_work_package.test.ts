import assert from "node:assert/strict";
import test from "node:test";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import { buildAecScopeWorkPackage } from "../src/deterministic/aec_scope_work_package.js";

function base(): AecSemanticTaskV1 {
  return { schema: AEC_SEMANTIC_TASK_V1_SCHEMA, operation: "layout", subject: { kind: "class", semantic_class: "electrical_equipment", terms: ["power plans"], categories: ["OST_ElectricalFixtures", "OST_ElectricalEquipment"], family_name: null, type_name: null, system_name: null, identifiers: [] }, scope: { kind: "level", document: null, levels: ["L4"], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null }, reference: { strategy: "current_project_precedent", source_description: null, source_room: null }, mutation: { kind: "create", requested: true }, outputs: ["summary", "verification"], execution: { max_results: 100, max_primary_actions: 8, allow_document_fallback: false, requires_visual_verification: true }, confidence: { value: 0.93, ambiguity: "low", reasons: ["bounded level"] }, evidence: { user_text: "Lay out the power plans on Level 4; let me know if you have questions." } };
}

test("level package uses structured semantic class and exact level predicate without prompt triggers", () => {
  const task = base();
  task.evidence.user_text = "Please take care of the fourth-floor deliverable.";
  const plan = buildAecScopeWorkPackage(task);
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.discovery_actions, [{ action_id: "aec-scope-resolve-levels", method: "POST", path: "/revit/query", body: { category: "OST_Levels", limit: 500 } }]);
  assert.deepEqual((plan.work_items[0].scope as any).semantic_groups, ["power"]);
  assert.equal(plan.work_items[0].status, "ready");
  assert.deepEqual(plan.work_items.slice(1).map(item => item.status), new Array(5).fill("pending"));
  assert.ok(plan.work_items.every(item => item.scope.kind === "level"));
});

test("structured mechanical discipline produces a mechanical view predicate independent of wording", () => {
  const task = base(); task.subject.semantic_class = "mechanical_equipment"; task.subject.terms = ["plan deliverable"]; task.evidence.user_text = "Please take care of it.";
  const plan = buildAecScopeWorkPackage(task);
  assert.deepEqual((plan.work_items[0].scope as any).semantic_groups, ["mechanical"]);
});

test("exact named views use exact viewNames rather than contains or document fallback", () => {
  const task = base(); task.operation = "tag"; task.subject.semantic_class = "air_terminal"; task.scope = { ...task.scope, kind: "view", levels: [], views: [{ id: null, name: "L4 - HVAC" }] }; task.mutation = { kind: "create", requested: true };
  const plan = buildAecScopeWorkPackage(task);
  assert.deepEqual((plan.discovery_actions[0].body as any).viewNames, ["L4 - HVAC"]);
  assert.equal("nameContainsAny" in (plan.discovery_actions[0].body as any), false);
});

test("sheet package resolves every exact sheet in a bounded action batch", () => {
  const task = base(); task.operation = "sheet"; task.scope = { ...task.scope, kind: "sheet", levels: [], sheets: ["E401", "E402"] }; task.mutation = { kind: "update", requested: true };
  const plan = buildAecScopeWorkPackage(task);
  assert.deepEqual(plan.discovery_actions.map(action => action.path), ["/revit/sheets", "/revit/sheets"]);
  assert.deepEqual(plan.discovery_actions.map(action => (action.body as any).sheetNumber), ["E401", "E402"]);
});

test("area scope and material ambiguity fail closed without broad discovery", () => {
  const area = base(); area.scope = { ...area.scope, kind: "area", levels: [], areas: ["West Wing"] };
  const areaPlan = buildAecScopeWorkPackage(area);
  assert.equal(areaPlan.status, "blocked"); assert.deepEqual(areaPlan.discovery_actions, []);
  const ambiguous = base(); ambiguous.confidence = { value: 0.6, ambiguity: "material", reasons: ["design vs documentation unclear"] };
  const ambiguousPlan = buildAecScopeWorkPackage(ambiguous);
  assert.equal(ambiguousPlan.status, "blocked"); assert.deepEqual(ambiguousPlan.discovery_actions, []);
});

test("read queries and narrow room design stay outside this planner", () => {
  const read = base(); read.operation = "list"; read.mutation = { kind: "none", requested: false };
  assert.equal(buildAecScopeWorkPackage(read).status, "not_applicable");
  const room = base(); room.scope = { ...room.scope, kind: "room", levels: [], rooms: ["403"] };
  assert.equal(buildAecScopeWorkPackage(room).status, "not_applicable");
});
