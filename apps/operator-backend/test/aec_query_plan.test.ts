import assert from "node:assert/strict";
import test from "node:test";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import { continueExactIdentifierQuery, planAecQueryTask } from "../src/deterministic/aec_query_plan.js";

function task(): AecSemanticTaskV1 {
  return {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: "locate",
    subject: { kind: "exact_identifier", semantic_class: "mechanical_equipment", terms: ["AHU"], categories: ["OST_MechanicalEquipment"], family_name: null, type_name: null, system_name: null, identifiers: [{ parameter: "Mark", value: "AHU-1", match: "case_insensitive_exact" }] },
    scope: { kind: "active_context", document: null, levels: [], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null },
    reference: { strategy: "none", source_description: null, source_room: null },
    mutation: { kind: "none", requested: false },
    outputs: ["summary", "element_ids", "spatial_context", "best_view"],
    execution: { max_results: 10, max_primary_actions: 2, allow_document_fallback: false, requires_visual_verification: false },
    confidence: { value: 0.98, ambiguity: "none", reasons: ["exact mark"] },
    evidence: { user_text: "Where is AHU-1?" }
  };
}

test("exact AHU lookup pushes category and Mark predicate into one compact bridge action", () => {
  const plan = planAecQueryTask(task());
  assert.equal(plan.status, "ready");
  assert.equal(plan.workflow_id, "query.exact_identifier");
  assert.deepEqual(plan.actions, [{ action_id: "aec-query-exact-identifier", method: "POST", path: "/revit/find-elements-by-parameter", body: { category: "OST_MechanicalEquipment", parameterName: "Mark", op: "equals", value: "AHU-1", limit: 10 } }]);
  assert.equal(plan.evidence.document_payload_requested, false);
});

test("unique exact lookup continues directly to bounded placement context; ambiguity stops", () => {
  const unique = continueExactIdentifierQuery(task(), { action_id: "a", method: "POST", path: "/revit/find-elements-by-parameter", status: "done", result_json: { count: 1, elements: [{ id: 123, category: "OST_MechanicalEquipment", parameterName: "Mark", value: "AHU-1" }] } });
  assert.equal(unique.status, "ready");
  assert.deepEqual(unique.actions, [{ action_id: "aec-query-exact-context", method: "POST", path: "/revit/get-placement-context", body: { elementId: 123, maxNearbyHosts: 3 } }]);

  const ambiguous = continueExactIdentifierQuery(task(), { action_id: "a", method: "POST", path: "/revit/find-elements-by-parameter", status: "done", result_json: { elements: [{ id: 1 }, { id: 2 }] } });
  assert.equal(ambiguous.status, "blocked");
  assert.deepEqual((ambiguous.evidence.candidates as any[]).map(item => item.id), [1, 2]);
});

test("alternative Mark-or-Name identity stays one bounded OR lookup instead of falling through", () => {
  const value = task();
  value.subject.categories = ["Mechanical Equipment"];
  value.subject.identifiers = [
    { parameter: "Mark", value: "AHU-1", match: "exact" },
    { parameter: "Name", value: "AHU-1", match: "exact" }
  ];
  const plan = planAecQueryTask(value);
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions[0], { action_id: "aec-query-exact-identifier", method: "POST", path: "/revit/find-elements-by-parameter", body: { category: "Mechanical Equipment", limit: 10, predicates: [{ parameterName: "Mark", op: "equals", value: "AHU-1" }, { parameterName: "Name", op: "equals", value: "AHU-1" }], matchMode: "any" } });
});

test("room count uses room-contents rather than a document-wide element query", () => {
  const value = task();
  value.operation = "count";
  value.subject = { kind: "category", semantic_class: "receptacle", terms: ["receptacle"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "room", rooms: ["403"] };
  value.outputs = ["count", "element_ids", "summary"];
  const plan = planAecQueryTask(value);
  assert.equal(plan.workflow_id, "query.room_contents");
  assert.deepEqual(plan.actions[0], { action_id: "aec-query-room-contents", method: "POST", path: "/revit/room-contents", body: { roomNumber: "403", mode: "auto", verticalScope: "room", limit: 10, categories: ["OST_ElectricalFixtures"], includeKeywords: ["receptacle"] } });
});

test("planner pushes canonical level/category predicates and fails closed when native pushdown is impossible", () => {
  const namedView = task();
  namedView.scope = { ...namedView.scope, kind: "view", views: [{ id: null, name: "L4 - POWER" }] };
  assert.match(planAecQueryTask(namedView).blockers[0], /resolved to one exact view id/);
  const level = task();
  level.subject = { ...level.subject, kind: "category", identifiers: [] };
  level.scope = { ...level.scope, kind: "level", levels: ["LEVEL 4"] };
  assert.deepEqual(planAecQueryTask(level).actions[0], { action_id: "aec-query-level-elements", method: "POST", path: "/revit/locate-elements", body: { categories: ["OST_MechanicalEquipment"], levelNames: ["LEVEL 4"], limit: 10 } });
  level.subject.categories = [];
  assert.match(planAecQueryTask(level).blockers[0], /canonical OST_ category/);
  const bad: any = structuredClone(task());
  bad.scope.phase = "NEW CONSTRUCTION";
  assert.match(planAecQueryTask(bad).blockers[0], /scope\.phase/);
});
