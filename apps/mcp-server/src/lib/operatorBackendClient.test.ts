import test from "node:test";
import assert from "node:assert/strict";
import { createOperatorBackendClient, EVIDENCE_RETRIEVE_PATH, SEMANTIC_MEP_ROUTE_PLAN_PATH } from "./operatorBackendClient.js";

test("semantic MEP backend client uses only the fixed authenticated planner path", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createOperatorBackendClient({
    baseUrl: "http://self-hosted.example:7007/",
    token: "operator-test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, handled: true, status: "needs_discovery" }), { status: 200 });
    }
  });

  await client.planSemanticMepRoute({
    userText: "Extend piping from the main to the sink.",
    viewId: 101,
    roomNumber: "405",
    levelName: "L4",
    toolResults: [],
    ...( { path: "/tools/not-allowed", apply: true } as Record<string, unknown>)
  } as any);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `http://self-hosted.example:7007${SEMANTIC_MEP_ROUTE_PLAN_PATH}`);
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-operator-token"), "operator-test-token");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    user_text: "Extend piping from the main to the sink.",
    view_id: 101,
    room_number: "405",
    level_name: "L4",
    tool_results: []
  });
});

test("evidence backend client uses the fixed authenticated focused-retrieval path", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createOperatorBackendClient({
    baseUrl: "http://self-hosted.example:7007/",
    token: "operator-test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, result: { returned_bytes: 40 } }), { status: 200 });
    }
  });
  const request = {
    evidence_id: `ev1_${"a".repeat(32)}`,
    scope: { session_id: "session-a", assignment_id: "assignment-a" },
    purpose: "verify exact orientation",
    fields: ["result.orientation"],
    max_bytes: 4_096
  };
  await client.retrieveEvidence(request);
  assert.equal(calls[0]?.url, `http://self-hosted.example:7007${EVIDENCE_RETRIEVE_PATH}`);
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-operator-token"), "operator-test-token");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), request);
});
