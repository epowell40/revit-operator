import assert from "node:assert/strict";
import test from "node:test";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import { __testOnlyAecSemanticTaskSchema, interpretAecSemanticTask, type AecSemanticTaskInterpreter } from "../src/aec_semantic_task_interpreter.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";

function semanticTask(userText: string): AecSemanticTaskV1 {
  return {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: "locate",
    subject: { kind: "exact_identifier", semantic_class: "mechanical_equipment", terms: ["AHU"], categories: ["OST_MechanicalEquipment"], family_name: null, type_name: null, system_name: null, identifiers: [{ parameter: "Mark", value: "AHU-1", match: "case_insensitive_exact" }] },
    scope: { kind: "active_context", document: null, levels: [], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null },
    reference: { strategy: "none", source_description: null, source_room: null }, mutation: { kind: "none", requested: false },
    outputs: ["summary", "element_ids", "parameters", "spatial_context", "best_view"], execution: { max_results: 10, max_primary_actions: 2, allow_document_fallback: false, requires_visual_verification: false },
    confidence: { value: 0.98, ambiguity: "none", reasons: ["exact mark"] }, evidence: { user_text: userText }
  };
}

test("provider-neutral semantic interpreter preserves authoritative natural-language evidence", async () => {
  const prompts = ["Where is AHU-1?", "Can you locate AHU-1 for me?", "What level and room is AHU-1 on?", "Find the equipment marked AHU-1."];
  for (const prompt of prompts) {
    const interpreter: AecSemanticTaskInterpreter = { async interpret(input) { return semanticTask(`provider paraphrase of ${input.user_text}`); } };
    const task = await interpretAecSemanticTask({ version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "s", message_id: "m", user_text: prompt }, interpreter);
    assert.equal(task?.evidence.user_text, prompt);
    assert.equal(task?.subject.identifiers[0].value, "AHU-1");
    assert.equal(task?.execution.allow_document_fallback, false);
  }
});

test("semantic interpreter skips continuations and rejects unsupported provider fields", async () => {
  let calls = 0;
  const interpreter: AecSemanticTaskInterpreter = { async interpret(input) { calls++; return semanticTask(input.user_text); } };
  const continuation: ChatRequest = { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "s", message_id: "m", user_text: "Where is AHU-1?", tool_results: [{ action_id: "a", method: "POST", path: "/revit/find-elements-by-parameter", status: "done" }] };
  assert.equal(await interpretAecSemanticTask(continuation, interpreter), null);
  assert.equal(calls, 0);
  const bad: AecSemanticTaskInterpreter = { async interpret(input) { return { ...semanticTask(input.user_text), invented: true }; } };
  assert.equal(await interpretAecSemanticTask({ version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "s", message_id: "m", user_text: "Where is AHU-1?" }, bad), null);
  assert.equal((__testOnlyAecSemanticTaskSchema as any).additionalProperties, false);
});

test("provider mixed scope with one concrete field is narrowed to that exact scope", async () => {
  const prompt = "Lay out the mechanical plans on Level 4 across applicable views and sheets.";
  const value = semanticTask(prompt) as any;
  value.operation = "layout";
  value.subject = { ...value.subject, kind: "class", semantic_class: "view", terms: ["mechanical plans"], categories: [], identifiers: [] };
  value.scope = { ...value.scope, kind: "mixed", levels: ["Level 4"] };
  value.reference = { strategy: "current_project_precedent", source_description: "adjacent completed mechanical sheets", source_room: null };
  value.mutation = { kind: "update", requested: true };
  value.execution.requires_visual_verification = true;
  const task = await interpretAecSemanticTask({ version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "scope", message_id: "m", user_text: prompt }, { async interpret() { return value; } });
  assert.equal(task?.scope.kind, "level");
  assert.deepEqual(task?.scope.levels, ["Level 4"]);
});

test("target scope remains separate from precedent evidence", async () => {
  const prompt = "Lay out Level 4 mechanical plans using Level 3, Level 5, M103, and M105 as precedent.";
  const value = semanticTask(prompt) as any; value.operation = "layout"; value.subject.semantic_class = "mechanical_equipment";
  value.scope = { ...value.scope, kind: "level", levels: ["Level 4"] };
  value.reference = { strategy: "explicit", source_description: "Level 3, Level 5, M103, and M105 precedent", source_room: null };
  value.mutation = { kind: "update", requested: true }; value.execution.requires_visual_verification = true;
  const task = await interpretAecSemanticTask({ version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "precedent", message_id: "m", user_text: prompt }, { async interpret() { return value; } });
  assert.deepEqual(task?.scope.levels, ["Level 4"]); assert.deepEqual(task?.scope.sheets, []); assert.equal(task?.scope.document, null); assert.match(task?.reference.source_description ?? "", /M103/);
});

test("Sidecar authoritative user text overrides model-authored delegate expansion", async () => {
  let seen: any = null;
  const original = "Lay out the mechanical plans on Level 4.";
  const delegated = "Target M104, M204, Plan HVAC L4, RCP HVAC L4, Level 3, Level 4, and Level 5.";
  const interpreter: AecSemanticTaskInterpreter = { async interpret(input) { seen = input; const value = semanticTask(input.user_text) as any; value.operation = "layout"; value.subject.semantic_class = "mechanical_equipment"; value.scope = { ...value.scope, kind: "level", levels: ["Level 4"] }; value.reference = { strategy: "current_project_precedent", source_description: "project precedent", source_room: null }; value.mutation = { kind: "update", requested: true }; value.execution.requires_visual_verification = true; return value; } };
  const task = await interpretAecSemanticTask({ version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "authoritative", message_id: "m", user_text: delegated, context: { ui: { authoritative_user_text: original } } }, interpreter);
  assert.equal(seen.user_text, original); assert.equal(seen.delegated_task_text, delegated); assert.equal(task?.evidence.user_text, original); assert.deepEqual(task?.scope.levels, ["Level 4"]);
});

test("explicit schedule inventory bypasses the provider interpreter", async () => {
  let calls = 0;
  const task = await interpretAecSemanticTask({ version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "schedule-fast-path", message_id: "m", user_text: "open the best matching view", context: { ui: { authoritative_user_text: "Show me the schedules and the one for the air handlers." } } }, { async interpret() { calls++; return null; } });
  assert.equal(calls, 0);
  assert.equal(task?.operation, "list");
  assert.equal(task?.subject.semantic_class, "view");
  assert.deepEqual(task?.subject.terms, ["schedule", "air handlers"]);
  assert.equal(task?.scope.kind, "document");
  assert.equal(task?.mutation.requested, false);
});

test("named-object topology questions bypass the provider without treating negative write constraints as mutations", async () => {
  const prompts = [
    "What are the shock arrestors connected to? Summarize the pipe system and flag any that aren't connected. Don't change anything.",
    "What do the VAV boxes connect to?",
    "Which duct system are the supply diffusers connected to?",
    "Inspect the pump connectors.",
    "Are any expansion tanks disconnected?"
  ];
  for (const prompt of prompts) {
    let calls = 0;
    const task = await interpretAecSemanticTask(
      { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "topology-fast-path", message_id: "m", user_text: prompt },
      { async interpret() { calls++; return null; } }
    );
    assert.equal(calls, 0, prompt);
    assert.equal(task?.operation, "inspect", prompt);
    assert.equal(task?.subject.kind, "class", prompt);
    assert.equal(task?.scope.kind, "active_context", prompt);
    assert.equal(task?.mutation.requested, false, prompt);
    assert.equal(task?.execution.max_primary_actions, 2, prompt);
  }
});

test("named-object topology fast path fails closed for mutation and pronoun-only requests", async () => {
  for (const prompt of ["Connect the shock arrestors to CW 5.", "What is it connected to?", "Disconnect the expansion tanks."]) {
    let calls = 0;
    await interpretAecSemanticTask(
      { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "topology-guard", message_id: "m", user_text: prompt },
      { async interpret() { calls++; return null; } }
    );
    assert.equal(calls, 1, prompt);
  }
});

test("explicit shock-arrestor inventory preserves literal identity instead of a guessed plumbing category", async () => {
  let calls = 0;
  const prompt = "Can you find the shock arrestors in this project and tell me what they are?";
  const misclassified = semanticTask(prompt) as any;
  misclassified.operation = "inspect";
  misclassified.subject = { kind: "category", semantic_class: "plumbing_fixture", terms: ["plumbing fixtures"], categories: ["OST_PlumbingFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  misclassified.scope = { ...misclassified.scope, kind: "document", document: "current model" };
  misclassified.execution = { ...misclassified.execution, allow_document_fallback: true };
  const task = await interpretAecSemanticTask({ version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "shock-fast-path", message_id: "m", user_text: prompt }, { async interpret() { calls++; return misclassified; } });
  assert.equal(calls, 1);
  assert.equal(task?.operation, "inspect");
  assert.equal(task?.subject.kind, "class");
  assert.equal(task?.subject.semantic_class, "other");
  assert.deepEqual(task?.subject.terms, ["shock arrestors"]);
  assert.deepEqual(task?.subject.categories, []);
  assert.equal(task?.scope.kind, "document");
  assert.equal(task?.execution.max_primary_actions, 2);
});

test("explicit shock-arrestor location request keeps the literal device identity and spatial output", async () => {
  const prompt = "Where are the shock arrestors? Provide the room numbers for each device location.";
  const misclassified = semanticTask(prompt) as any;
  misclassified.subject = { kind: "category", semantic_class: "plumbing_fixture", terms: ["plumbing fixtures"], categories: ["OST_PlumbingFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  const task = await interpretAecSemanticTask({ version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "shock-location-fast-path", message_id: "m", user_text: prompt }, { async interpret() { return misclassified; } });
  assert.equal(task?.operation, "locate");
  assert.deepEqual(task?.subject.terms, ["shock arrestors"]);
  assert.equal(task?.outputs.includes("spatial_context"), true);
  assert.equal(task?.execution.max_primary_actions, 2);
});

test("schedule mutations do not enter the read-only fast path", async () => {
  let calls = 0;
  await interpretAecSemanticTask({ version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "schedule-mutation", message_id: "m", user_text: "Change the air handler schedule value." }, { async interpret(input) { calls++; return semanticTask(input.user_text); } });
  assert.equal(calls, 1);
});
