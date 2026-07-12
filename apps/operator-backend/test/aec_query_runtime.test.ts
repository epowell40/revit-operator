import assert from "node:assert/strict";
import test from "node:test";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import type { AecSemanticTaskInterpreter } from "../src/aec_semantic_task_interpreter.js";
import { __testOnlyClearAecQueryStates, maybeRunAecSemanticQuery } from "../src/deterministic/aec_query_runtime.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";

function ahu(): AecSemanticTaskV1 { return { schema: AEC_SEMANTIC_TASK_V1_SCHEMA, operation: "locate", subject: { kind: "exact_identifier", semantic_class: "mechanical_equipment", terms: ["AHU"], categories: ["OST_MechanicalEquipment"], family_name: null, type_name: null, system_name: null, identifiers: [{ parameter: "Mark", value: "AHU-1", match: "case_insensitive_exact" }] }, scope: { kind: "active_context", document: null, levels: [], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null }, reference: { strategy: "none", source_description: null, source_room: null }, mutation: { kind: "none", requested: false }, outputs: ["summary", "element_ids", "parameters", "spatial_context", "best_view"], execution: { max_results: 10, max_primary_actions: 2, allow_document_fallback: false, requires_visual_verification: false }, confidence: { value: 0.98, ambiguity: "none", reasons: ["exact mark"] }, evidence: { user_text: "Where is AHU-1?" } }; }
function request(session: string, tool_results?: ChatRequest["tool_results"]): ChatRequest { return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: session, message_id: `m-${tool_results?.length ?? 0}`, user_text: tool_results ? "" : "Where is AHU-1?", tool_results }; }

test("exact identifier runtime completes in two primary actions without broad payload", async () => {
  __testOnlyClearAecQueryStates();
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return ahu(); } };
  const first = await maybeRunAecSemanticQuery(request("ahu"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/find-elements-by-parameter"]);
  const second = await maybeRunAecSemanticQuery(request("ahu", [{ action_id: "aec-query-exact-identifier", method: "POST", path: "/revit/find-elements-by-parameter", status: "done", result_json: { count: 1, elements: [{ id: 123, value: "AHU-1" }] } }]), interpreter);
  assert.deepEqual(second.response?.actions.map(action => action.path), ["/revit/get-placement-context"]);
  const third = await maybeRunAecSemanticQuery(request("ahu", [{ action_id: "aec-query-exact-context", method: "POST", path: "/revit/get-placement-context", status: "done", result_json: { elementId: 123, familyName: "AHU", typeName: "SIZE 1", levelName: "LEVEL 4", systemName: "SUPPLY AIR", bestView: { id: 44, name: "L4 HVAC" }, room: { number: "401", name: "MECHANICAL" }, center: { x: 1, y: 2, z: 3 } } }]), interpreter);
  assert.equal(third.response?.actions.length, 0);
  assert.match(third.response?.assistant_message ?? "", /AHU-1 is element 123/);
  assert.match(third.response?.assistant_message ?? "", /LEVEL 4/);
  assert.match(third.response?.assistant_message ?? "", /Room 401/);
  assert.match(third.response?.assistant_message ?? "", /System: SUPPLY AIR/);
  assert.match(third.response?.assistant_message ?? "", /Best view: L4 HVAC \(id 44\)/);
  assert.deepEqual(third.response?.aec_query_receipt, { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status: "found", workflow_id: "query.exact_identifier", bounded: true, broadened: false });
});

test("exact identifier not-found is an authoritative bounded terminal receipt", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu();
  value.subject.identifiers = [
    { parameter: "Mark", value: "AHU-1", match: "case_insensitive_exact" },
    { parameter: "Name", value: "AHU-1", match: "case_insensitive_exact" }
  ];
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const first = await maybeRunAecSemanticQuery(request("ahu-missing"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/find-elements-by-parameter"]);
  const done = await maybeRunAecSemanticQuery(request("ahu-missing", [{ action_id: "aec-query-exact-identifier", method: "POST", path: "/revit/find-elements-by-parameter", status: "done", result_json: { count: 0, elements: [] } }]), interpreter);
  assert.equal(done.response?.actions.length, 0);
  assert.match(done.response?.assistant_message ?? "", /did not find an exact match/i);
  assert.deepEqual(done.response?.aec_query_receipt, { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status: "not_found", workflow_id: "query.exact_identifier", bounded: true, broadened: false });
});

test("room count runtime reports once from scoped room contents", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu(); value.operation = "count"; value.subject = { kind: "category", semantic_class: "receptacle", terms: ["receptacle"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] }; value.scope = { ...value.scope, kind: "room", rooms: ["403"] }; value.outputs = ["count", "element_ids", "summary"];
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const first = await maybeRunAecSemanticQuery(request("count"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/room-contents"]);
  const done = await maybeRunAecSemanticQuery(request("count", [{ action_id: "aec-query-room-contents", method: "POST", path: "/revit/room-contents", status: "done", result_json: { count: 14, elements: new Array(14).fill({}) } }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /14 receptacles matched in Room 403/);
  assert.match(done.response?.assistant_message ?? "", /no model changes/i);
  assert.deepEqual(done.response?.aec_query_receipt, { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status: "complete", workflow_id: "query.room_contents", bounded: true, broadened: false });
});

test("scoped list returns bounded element identity and location details instead of count-only prose", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu();
  value.operation = "list";
  value.subject = { kind: "category", semantic_class: "air_terminal", terms: ["air terminals"], categories: ["OST_DuctTerminal"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "view", views: [{ id: 44, name: "L4 HVAC" }] };
  value.outputs = ["summary", "element_ids", "spatial_context"];
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const first = await maybeRunAecSemanticQuery(request("list-view"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/find-elements"]);
  const second = await maybeRunAecSemanticQuery(request("list-view", [{ action_id: "aec-query-view-elements", method: "POST", path: "/revit/find-elements", status: "done", result_json: { elementIds: [101, 102], items: [], truncated: false } }]), interpreter);
  assert.deepEqual(second.response?.actions, [{ action_id: "aec-query-scoped-summaries", method: "POST", path: "/revit/get-element-summary", body: { elementIds: [101, 102] } }]);
  const done = await maybeRunAecSemanticQuery(request("list-view", [{ action_id: "aec-query-scoped-summaries", method: "POST", path: "/revit/get-element-summary", status: "done", result_json: [{ id: 101, name: "Supply Diffuser", category: "Air Terminals", found: true }, { id: 102, name: "Return Grille", category: "Air Terminals", found: true }] }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /id 101 — Supply Diffuser — Air Terminals/);
  assert.match(done.response?.assistant_message ?? "", /id 102 — Return Grille — Air Terminals/);
  assert.doesNotMatch(done.response?.assistant_message ?? "", /\[object Object\]/);
});

test("exact focus resolves identity and context before one native view activation", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu(); value.operation = "focus"; value.execution.max_primary_actions = 3;
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const first = await maybeRunAecSemanticQuery(request("focus"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/find-elements-by-parameter"]);
  const second = await maybeRunAecSemanticQuery(request("focus", [{ action_id: "aec-query-exact-identifier", method: "POST", path: "/revit/find-elements-by-parameter", status: "done", result_json: { elements: [{ id: 123, value: "AHU-1" }] } }]), interpreter);
  assert.deepEqual(second.response?.actions.map(action => action.path), ["/revit/get-placement-context"]);
  const third = await maybeRunAecSemanticQuery(request("focus", [{ action_id: "aec-query-exact-context", method: "POST", path: "/revit/get-placement-context", status: "done", result_json: { elementId: 123, bestView: { id: 44, name: "L4 HVAC" } } }]), interpreter);
  assert.deepEqual(third.response?.actions, [{ action_id: "aec-query-exact-focus", method: "POST", path: "/revit/activate-view", body: { viewId: 44, showElementIds: [123] } }]);
  const done = await maybeRunAecSemanticQuery(request("focus", [{ action_id: "aec-query-exact-focus", method: "POST", path: "/revit/activate-view", status: "done", result_json: { ok: true, activeViewId: 44, activeViewName: "L4 HVAC", shownElementIds: [123] } }]), interpreter);
  assert.equal(done.response?.assistant_message, "Focused AHU-1 in L4 HVAC. No model elements were changed.");
  assert.equal(done.response?.aec_query_receipt?.status, "found");
});

test("unsupported semantic query terminates authoritatively instead of falling through and broadening", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu(); value.operation = "compare";
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const done = await maybeRunAecSemanticQuery(request("blocked-compare"), interpreter);
  assert.equal(done.response?.actions.length, 0);
  assert.match(done.response?.assistant_message ?? "", /without broadening or guessing/);
  assert.deepEqual(done.response?.aec_query_receipt, { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status: "failed", workflow_id: "query.blocked", bounded: true, broadened: false });
});
