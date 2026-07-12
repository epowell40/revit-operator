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
