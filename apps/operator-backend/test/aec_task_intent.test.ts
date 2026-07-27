import assert from "node:assert/strict";
import test from "node:test";
import { AEC_TASK_INTENT_V1_SCHEMA, isAecTaskIntentV1, normalizeAecTaskIntentV1, type AecTaskIntentV1 } from "../src/aec_task_intent.js";
import type { AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import { interpretAecTaskIntent, type AecTaskIntentInterpreter } from "../src/aec_task_intent_interpreter.js";
import { resolveAecTaskIntentHttp } from "../src/aec_task_intent_http.js";
import { maybeRunSemanticAecWorkflow, resolveAecWorkflow } from "../src/deterministic/aec_workflow_registry.js";
import { __testOnlyClearAecTaskIntentTokens, issueAecTaskIntentToken } from "../src/aec_task_intent_cache.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";

const prompts = [
  "Lay out the receptacles in Room 403 based on our office standards.",
  "Place receptacles in Room 403 to match our typical layouts and standards.",
  "Design the receptacle layout in Room 403, based on Room 405.",
  "Make 403's outlet plan consistent with the comparable unit next door.",
  "Bring the electrical-device arrangement in space 403 up to our normal dwelling-unit practice.",
  "Use 405 as the example and complete the power outlets for 403.",
  "Room 403 needs its convenience outlets laid out the way we normally do these live/work units.",
  "Populate the empty unit 403 with the same receptacle design logic as the standard unit.",
  "Please finish the wall and counter outlet scheme for 403 using the project precedent.",
  "Replicate the functional receptacle roles from room 405 into room 403, adjusted for its geometry."
];

function rawIntent(userText: string, sourceRoom: string | null = null): AecTaskIntentV1 {
  return {
    schema: AEC_TASK_INTENT_V1_SCHEMA,
    operation: "layout",
    object_class: "receptacle",
    target: { document: null, view: null, room_number: "403", element_ids: [] },
    reference: { kind: sourceRoom ? "room" : "office_standard", room_number: sourceRoom },
    mutation: { kind: "create", requested: true },
    spatial_constraints: [],
    confidence: { value: 0.96, ambiguity: "none", reasons: ["task and target are explicit"] },
    evidence: { user_text: userText }
  };
}

function request(userText: string): ChatRequest {
  return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "semantic-routing-test", message_id: "m", user_text: userText };
}

test("AecTaskIntentV1 is a strict bounded serializable contract with authoritative request evidence", () => {
  const source = rawIntent("model paraphrase", "405");
  const normalized = normalizeAecTaskIntentV1(source, prompts[2]);
  assert.equal(normalized.evidence.user_text, prompts[2]);
  assert.equal(normalized.reference.room_number, "405");
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized);
  assert.ok(isAecTaskIntentV1(normalized));

  for (const invalid of [
    { ...source, confidence: { ...source.confidence, value: Number.NaN } },
    { ...source, target: { ...source.target, element_ids: [1, 1] } },
    { ...source, reference: { kind: "office_standard", room_number: "405" } },
    { ...source, mutation: { kind: "none", requested: true } },
    { ...source, target: { ...source.target, room_number: "405" } },
    { ...source, evidence: { user_text: "x".repeat(4001) } }
  ]) assert.throws(() => normalizeAecTaskIntentV1(invalid));
});

test("provider-neutral semantic results route ten materially different utterances through one deterministic registry entry", async () => {
  for (const [index, prompt] of prompts.entries()) {
    let observed = "";
    const interpreter: AecTaskIntentInterpreter = {
      async interpret(input) {
        observed = input.user_text;
        return rawIntent("provider may paraphrase this", index === 2 || index === 5 || index === 9 ? "405" : null);
      }
    };
    const intent = await interpretAecTaskIntent(request(prompt), interpreter);
    assert.equal(observed, prompt);
    assert.equal(intent?.evidence.user_text, prompt);
    const resolution = intent ? resolveAecWorkflow(intent) : null;
    assert.equal(resolution?.workflow_id, "electrical.receptacle_layout_from_analog");
    assert.equal(resolution?.intent.target.room_number, "403");
  }
});

test("registry fails closed for low confidence, material ambiguity, unrelated operations, and single-device placement", () => {
  const base = rawIntent(prompts[0]);
  const cases: AecTaskIntentV1[] = [
    { ...base, confidence: { ...base.confidence, value: 0.5 } },
    { ...base, confidence: { ...base.confidence, ambiguity: "material" } },
    { ...base, operation: "inspect", mutation: { kind: "none", requested: false } },
    { ...base, operation: "place", target: { ...base.target, element_ids: [123] } },
    { ...base, object_class: "light_fixture" }
  ];
  for (const intent of cases) assert.equal(resolveAecWorkflow(intent), null);
});

test("interpreter is skipped for continuations and oversized text", async () => {
  let calls = 0;
  const interpreter: AecTaskIntentInterpreter = { async interpret() { calls++; return rawIntent("unused"); } };
  const continuation = { ...request(prompts[0]), tool_results: [{ action_id: "a", method: "GET" as const, path: "/revit/ping", status: "done" as const }] };
  assert.equal(await interpretAecTaskIntent(continuation, interpreter), null);
  assert.equal(await interpretAecTaskIntent(request("x".repeat(4001)), interpreter), null);
  assert.equal(calls, 0);
});

test("read-only semantic HTTP adapter returns only validated intent and registry resolution", async () => {
  __testOnlyClearAecTaskIntentTokens();
  const interpreter: AecTaskIntentInterpreter = { async interpret(input) { return rawIntent(input.user_text, "405"); } };
  const result = await resolveAecTaskIntentHttp({ request: prompts[2], session_id: "semantic-session", message_id: "semantic-message" }, interpreter);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.handled, true);
  assert.equal(result.body.workflow_id, "electrical.receptacle_layout_from_analog");
  assert.equal(typeof result.body.intent_token, "string");
  assert.equal((result.body.intent as AecTaskIntentV1).evidence.user_text, prompts[2]);
  assert.equal((result.body.intent as AecTaskIntentV1).reference.room_number, "405");
  assert.deepEqual(await resolveAecTaskIntentHttp(null, interpreter), { status: 400, body: { ok: false, error: "Invalid JSON body" } });
  assert.deepEqual(await resolveAecTaskIntentHttp({}, interpreter), { status: 400, body: { ok: false, error: "user_text is required" } });
});

test("semantic HTTP adapter resolves named-object topology without a provider or intent token", async () => {
  let calls = 0;
  const prompt = "What are the shock arrestors connected to? Summarize the pipe system and flag any that aren't connected. Don't change anything.";
  const result = await resolveAecTaskIntentHttp(
    { user_text: prompt, session_id: "topology-preflight", message_id: "m" },
    { async interpret() { calls++; return null; } }
  );
  assert.equal(calls, 0);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.handled, true);
  assert.equal(result.body.workflow_id, "query.document_elements");
  assert.equal(result.body.intent_token, null);
  assert.equal((result.body.intent as AecSemanticTaskV1).evidence.user_text, prompt);
  assert.deepEqual((result.body.intent as AecSemanticTaskV1).subject.terms, ["shock arrestors"]);
});

test("semantic HTTP adapter routes service-accessory action requests without an outer model", async () => {
  let calls = 0;
  const prompt = "Add a shock arrestor to the domestic water piping serving the toilet in room 2968T.";
  const result = await resolveAecTaskIntentHttp(
    { user_text: prompt, session_id: "service-accessory-preflight", message_id: "m" },
    { async interpret() { calls++; return null; } }
  );
  assert.equal(calls, 0);
  assert.equal(result.status, 200);
  assert.equal(result.body.handled, true);
  assert.equal(result.body.workflow_id, "mep.service_accessory_preflight");
  assert.equal(result.body.intent_token, null);
  assert.equal((result.body.intent as any).room_number, "2968T");
  assert.equal((result.body.intent as any).target.text, "toilet");
  assert.equal((result.body.intent as any).evidence.user_text, prompt);
});

test("backend-issued semantic intent token survives one session boundary and cannot be replayed", async () => {
  __testOnlyClearAecTaskIntentTokens();
  const prompt = "Do the same thing in Room 409.";
  const token = issueAecTaskIntentToken({ ...rawIntent(prompt), target: { document: null, view: null, room_number: "409", element_ids: [] } });
  let interpreterCalls = 0;
  const fallback: AecTaskIntentInterpreter = { async interpret() { interpreterCalls += 1; return null; } };
  const first = await maybeRunSemanticAecWorkflow({ ...request(prompt), context: { aec_task_intent_token: token } }, fallback);
  assert.equal(first?.actions[0]?.path, "/revit/plan-room-receptacles-from-analog");
  assert.equal((first?.actions[0]?.body as any)?.targetRoomNumber, "409");
  assert.equal(interpreterCalls, 0);
  assert.equal(await maybeRunSemanticAecWorkflow({ ...request(prompt), context: { aec_task_intent_token: token } }, fallback), null);
  assert.equal(interpreterCalls, 1);
});
