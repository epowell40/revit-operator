import assert from "node:assert/strict";
import test from "node:test";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import type { AecSemanticTaskInterpreter } from "../src/aec_semantic_task_interpreter.js";
import { __testOnlyClearAecQueryStates } from "../src/deterministic/aec_query_runtime.js";
import { maybeRunSemanticAecWorkflow } from "../src/deterministic/aec_workflow_registry.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";

type Case = { prompt: string; task: () => AecSemanticTaskV1; path: string };

function base(prompt: string): AecSemanticTaskV1 { return { schema: AEC_SEMANTIC_TASK_V1_SCHEMA, operation: "locate", subject: { kind: "exact_identifier", semantic_class: "mechanical_equipment", terms: ["air handling unit"], categories: ["OST_MechanicalEquipment"], family_name: null, type_name: null, system_name: null, identifiers: [{ parameter: "Mark", value: "AHU-1", match: "case_insensitive_exact" }] }, scope: { kind: "active_context", document: null, levels: [], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null }, reference: { strategy: "none", source_description: null, source_room: null }, mutation: { kind: "none", requested: false }, outputs: ["summary", "element_ids", "spatial_context", "best_view"], execution: { max_results: 20, max_primary_actions: 2, allow_document_fallback: false, requires_visual_verification: false }, confidence: { value: 0.96, ambiguity: "none", reasons: ["bounded task"] }, evidence: { user_text: prompt } }; }
function roomCount(prompt: string): AecSemanticTaskV1 { const value = base(prompt); value.operation = "count"; value.subject = { kind: "category", semantic_class: "receptacle", terms: ["receptacle"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] }; value.scope = { ...value.scope, kind: "room", rooms: ["403"] }; value.outputs = ["count", "element_ids", "summary"]; return value; }
function viewList(prompt: string): AecSemanticTaskV1 { const value = base(prompt); value.operation = "list"; value.subject = { kind: "category", semantic_class: "air_terminal", terms: ["air terminal"], categories: ["OST_DuctTerminal"], family_name: null, type_name: null, system_name: null, identifiers: [] }; value.scope = { ...value.scope, kind: "view", views: [{ id: 1709383, name: "L4 HVAC" }] }; value.outputs = ["element_ids", "summary"]; return value; }
function selectionInspect(prompt: string): AecSemanticTaskV1 { const value = base(prompt); value.operation = "inspect"; value.subject = { kind: "elements", semantic_class: "family_instance", terms: ["selected devices"], categories: [], family_name: null, type_name: null, system_name: null, identifiers: [] }; value.scope = { ...value.scope, kind: "selection", element_ids: [101, 102] }; value.outputs = ["parameters", "spatial_context", "summary"]; return value; }

const cases: Case[] = [
  ...["Where is AHU-1?", "Find AHU-1.", "What room contains AHU-1?", "Show me the location of the unit marked AHU-1.", "Which level is air handler AHU-1 on?"].map(prompt => ({ prompt, task: () => base(prompt), path: "/revit/find-elements-by-parameter" })),
  ...["How many receptacles are in Room 403?", "Count the outlets in 403.", "Give me the Room 403 receptacle total.", "What is the device count for convenience outlets in room 403?", "Tally electrical receptacles within 403."].map(prompt => ({ prompt, task: () => roomCount(prompt), path: "/revit/room-contents" })),
  ...["List the air terminals in this L4 HVAC view.", "Which diffusers are shown on the Level 4 HVAC plan?", "Enumerate duct terminals visible in L4 HVAC.", "Give me the air-device IDs on this mechanical plan.", "What air terminals belong to view L4 HVAC?"].map(prompt => ({ prompt, task: () => viewList(prompt), path: "/revit/find-elements" })),
  ...["Inspect these two selected devices.", "Tell me about the selected elements.", "Read the placement context for my selection.", "What are elements 101 and 102?", "Summarize the current two-device selection."].map(prompt => ({ prompt, task: () => selectionInspect(prompt), path: "/revit/locate-elements" }))
];

test("twenty materially different read-query paraphrases use typed bounded workflows without text-trigger routing", async () => {
  assert.equal(cases.length, 20);
  for (const [index, item] of cases.entries()) {
    __testOnlyClearAecQueryStates();
    let observed = "";
    const interpreter: AecSemanticTaskInterpreter = { async interpret(input) { observed = input.user_text; return item.task(); } };
    const decision = await maybeRunSemanticAecWorkflow({ version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: `paraphrase-${index}`, message_id: "m", user_text: item.prompt }, undefined, interpreter);
    assert.equal(observed, item.prompt);
    assert.equal(decision?.actions.length, 1, item.prompt);
    assert.equal(decision?.actions[0].path, item.path, item.prompt);
    assert.notEqual((decision?.actions[0].body as any)?.allowDocumentScan, true, item.prompt);
  }
});
