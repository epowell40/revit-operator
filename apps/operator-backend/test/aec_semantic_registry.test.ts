import assert from "node:assert/strict";
import test from "node:test";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import type { AecSemanticTaskInterpreter } from "../src/aec_semantic_task_interpreter.js";
import { maybeRunSemanticAecWorkflow } from "../src/deterministic/aec_workflow_registry.js";
import { __testOnlyClearAecQueryStates } from "../src/deterministic/aec_query_runtime.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testOnlyClearAecScopeWorkPackageStates } from "../src/deterministic/aec_scope_work_package_runtime.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

function base(userText: string): AecSemanticTaskV1 { return { schema: AEC_SEMANTIC_TASK_V1_SCHEMA, operation: "locate", subject: { kind: "exact_identifier", semantic_class: "mechanical_equipment", terms: ["AHU"], categories: ["OST_MechanicalEquipment"], family_name: null, type_name: null, system_name: null, identifiers: [{ parameter: "Mark", value: "AHU-1", match: "case_insensitive_exact" }] }, scope: { kind: "active_context", document: null, levels: [], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null }, reference: { strategy: "none", source_description: null, source_room: null }, mutation: { kind: "none", requested: false }, outputs: ["summary", "element_ids", "parameters", "spatial_context", "best_view"], execution: { max_results: 10, max_primary_actions: 2, allow_document_fallback: false, requires_visual_verification: false }, confidence: { value: 0.98, ambiguity: "none", reasons: ["grounded"] }, evidence: { user_text: userText } }; }
function req(userText: string, session = "semantic-registry", tool_results?: ChatRequest["tool_results"]): ChatRequest { return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: session, message_id: `${session}-${tool_results?.length ?? 0}`, user_text: tool_results ? "" : userText, tool_results }; }

test("registry routes natural exact-equipment query through the new bounded semantic runtime", async () => {
  __testOnlyClearAecQueryStates();
  const prompt = "What level and area is AHU-1 in?";
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return base(prompt); } };
  const first = await maybeRunSemanticAecWorkflow(req(prompt), undefined, interpreter);
  assert.deepEqual(first?.actions.map(action => action.path), ["/revit/find-elements-by-parameter"]);
  const second = await maybeRunSemanticAecWorkflow(req("", "semantic-registry", [{ action_id: "aec-query-exact-identifier", method: "POST", path: "/revit/find-elements-by-parameter", status: "done", result_json: { elements: [{ id: 91, value: "AHU-1" }] } }]), undefined, interpreter);
  assert.deepEqual(second?.actions.map(action => action.path), ["/revit/get-placement-context"]);
});

test("plain underspecified room receptacle layout adapts into the released analog workflow without reference trigger words", async () => {
  const prompt = "Layout receptacles in room 403.";
  const value = base(prompt);
  value.operation = "layout";
  value.subject = { kind: "class", semantic_class: "receptacle", terms: ["convenience power outlets"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "room", rooms: ["403"] };
  value.reference = { strategy: "current_project_precedent", source_description: null, source_room: null };
  value.mutation = { kind: "create", requested: true };
  value.outputs = ["summary", "element_ids", "verification"];
  value.execution.requires_visual_verification = true;
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const decision = await maybeRunSemanticAecWorkflow(req(prompt, "plain-layout"), undefined, interpreter);
  assert.deepEqual(decision?.actions.map(action => action.path), ["/revit/plan-room-receptacles-from-analog"]);
  assert.equal((decision?.actions[0].body as any).targetRoomNumber, "403");
  assert.equal((decision?.actions[0].body as any).sourceRoomNumber, undefined);
});

test("explicit source room remains structured through the compatibility adapter", async () => {
  const prompt = "Design receptacles in 403 based on Room 405.";
  const value = base(prompt); value.operation = "layout"; value.subject = { kind: "class", semantic_class: "receptacle", terms: ["receptacle layout"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] }; value.scope = { ...value.scope, kind: "room", rooms: ["403"] }; value.reference = { strategy: "explicit", source_description: "Room 405", source_room: "405" }; value.mutation = { kind: "create", requested: true }; value.outputs = ["summary", "verification"]; value.execution.requires_visual_verification = true;
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const decision = await maybeRunSemanticAecWorkflow(req(prompt, "source-layout"), undefined, interpreter);
  assert.equal((decision?.actions[0].body as any).sourceRoomNumber, "405");
});

test("registry turns a semantically resolved level design into a persistent bounded view query", async () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT; const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-registry-scope-")); process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    __testOnlyClearAecScopeWorkPackageStates(); const prompt = "Take care of the Level 4 power-plan package."; const value = base(prompt);
    value.operation = "layout"; value.subject = { kind: "class", semantic_class: "electrical_equipment", terms: ["power plans"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] }; value.scope = { ...value.scope, kind: "level", levels: ["L4"] }; value.reference = { strategy: "current_project_precedent", source_description: null, source_room: null }; value.mutation = { kind: "create", requested: true }; value.outputs = ["summary", "verification"]; value.execution = { max_results: 100, max_primary_actions: 8, allow_document_fallback: false, requires_visual_verification: true };
    const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
    const decision = await maybeRunSemanticAecWorkflow(req(prompt, "scope-registry"), undefined, interpreter);
    assert.deepEqual(decision?.actions, [{ action_id: "aec-scope-resolve-levels", method: "POST", path: "/revit/query", body: { category: "OST_Levels", limit: 500 } }]);
  } finally { __closeForTests(); if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
