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
});
