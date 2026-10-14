import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  ASSIGNMENT_CLARIFICATION_PATH,
  createOperatorBackendClient,
  EVIDENCE_RETRIEVE_PATH,
  EXISTING_CONDITIONS_INTERPRETATION_PATH,
  EXISTING_CONDITIONS_REGISTRATION_PATH,
  NOOP_COMPLETION_CLAIM_PATH,
  READ_COMPLETION_CLAIM_PATH,
  OperatorCompletionDeliveryError,
  SEMANTIC_MEP_ROUTE_PLAN_PATH
} from "./operatorBackendClient.js";
import {
  OPERATOR_BACKEND_AUTH_V1,
  OperatorBackendAuthError,
  buildOperatorBackendAuthHeaders,
  runWithOperatorBackendAuth
} from "./operatorBackendAuth.js";

test("completion receipt retries one lost acknowledgement with identical body and authority over real HTTP", async () => {
  const bodies: string[] = [], headers: Array<{ token: string | undefined; handoff: string | undefined }> = [];
  let committedReceipt = "";
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    bodies.push(body);
    headers.push({token: req.headers["x-operator-token"] as string, handoff: req.headers["x-operator-assignment-handoff"] as string});
    if (!committedReceipt) committedReceipt = body;
    assert.equal(body, committedReceipt, "an acknowledgement retry cannot change the already committed receipt");
    if (bodies.length === 1) { req.socket.destroy(); return; }
    res.setHeader("Content-Type", "application/json"); res.end('{"ok":true,"result_id":"same-result"}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as {port:number}).port;
    const client = createOperatorBackendClient({baseUrl:`http://127.0.0.1:${port}`,token:"test-only-delivery"});
    const body = {operation_id:"one-native-commit",mcp_result:{result_id:"same-result",native_transaction_state:"committed"}};
    assert.deepEqual(await client.settleAssignmentOperationV2(body), {ok:true,result_id:"same-result"});
    assert.equal(bodies.length, 2); assert.equal(bodies[0], JSON.stringify(body)); assert.equal(bodies[0], bodies[1]);
    assert.deepEqual(headers, Array(2).fill({token:"test-only-delivery",handoff:"operation_handoff_v1"}));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("receipt transport retry is bounded and preserves first failure; other posts never retry", async () => {
  const first = new TypeError("fetch failed", {cause:Object.assign(new Error("lost socket"),{code:"UND_ERR_SOCKET"})});
  const second = new TypeError("fetch failed", {cause:Object.assign(new Error("reset"),{code:"ECONNRESET"})});
  let calls = 0;
  const client = createOperatorBackendClient({token:"test-only",fetchImpl:async()=>{calls++;throw calls===1?first:second;}});
  await assert.rejects(client.settleAssignmentOperationV2({}), (error:unknown)=>{
    assert(error instanceof OperatorCompletionDeliveryError); assert.equal(error.cause,first);assert.equal(error.first_failure,first);
    assert.equal(error.last_failure,second);assert.equal(error.transport_code,"UND_ERR_SOCKET");return true;
  });
  assert.equal(calls,2);
  for (const action of [()=>client.openAssignmentChildOperationV2({}),()=>client.markAssignmentOperationDispatchV2({}),
    ()=>client.manageAssignmentWorkPlanV2({}),()=>client.retrieveEvidence({})]) {
    calls=0;await assert.rejects(action(),error=>error===first);assert.equal(calls,1);
  }
});

test("receipt retry never retries HTTP rejection, invalid JSON, credential errors, or unclassified exceptions", async () => {
  for (const failure of [new Response('{"error":"binding mismatch"}',{status:400}),new Response('denied',{status:401}),
    new Response('{"ok":', {status:200}),new TypeError("invalid URL"),
    new TypeError("fetch failed",{cause:Object.assign(new Error("TLS"),{code:"CERT_HAS_EXPIRED"})})]) {
    let calls=0;
    const client=createOperatorBackendClient({token:"test-only",fetchImpl:async()=>{calls++;if(failure instanceof Error)throw failure;return failure;}});
    await assert.rejects(client.settleAssignmentOperationV2({}));assert.equal(calls,1);
  }
});

test("receipt retry also handles interrupted response bytes without retrying malformed JSON", async () => {
  let calls=0;
  const client=createOperatorBackendClient({token:"test-only",fetchImpl:async()=>{
    calls++;
    if(calls===1)return {ok:true,json:async()=>{throw Object.assign(new TypeError("terminated"),{cause:{code:"UND_ERR_SOCKET"}});}} as unknown as Response;
    return new Response('{"ok":true}',{status:200});
  }});
  assert.deepEqual(await client.settleAssignmentOperationV2({operation_id:"same"}),{ok:true});assert.equal(calls,2);
});

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

test("existing-conditions interpretation client uses only the fixed authenticated validation path", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createOperatorBackendClient({
    baseUrl: "http://self-hosted.example:7007/",
    token: "operator-test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, native_write_allowed: false }), { status: 200 });
    }
  });
  const request = { schema_version: 1, session_id: "session-a", response: { schema_version: 1 } };
  await client.validateExistingConditionsInterpretation(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `http://self-hosted.example:7007${EXISTING_CONDITIONS_INTERPRETATION_PATH}`);
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-operator-token"), "operator-test-token");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), request);
});

test("existing-conditions registration client uses only the fixed authenticated registration path", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createOperatorBackendClient({
    baseUrl: "http://self-hosted.example:7007/",
    token: "operator-test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ native_write_allowed: false, registration: { verified: true } }), { status: 200 });
    }
  });
  const request = { schema_version: 1, interpretation_evidence_id: `ev1_${"a".repeat(32)}`, controls: [] };
  await client.registerExistingConditionsInterpretation(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `http://self-hosted.example:7007${EXISTING_CONDITIONS_REGISTRATION_PATH}`);
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-operator-token"), "operator-test-token");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), request);
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

test("read-completion backend client uses the fixed authenticated canonical claim path", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createOperatorBackendClient({
    baseUrl: "http://self-hosted.example:7007/",
    token: "operator-test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, claim_id: "claim-1", status: "pending" }), { status: 202 });
    }
  });
  const request = {
    schema: "revit-operator.assignment-read-completion-claim/v1",
    assignment_id: "assignment-a", run_id: "run-a", generation: 1, session_id: "session-a",
    criteria: [], result: { kind: "inventory", assertions: [] }
  };
  await client.submitReadCompletionClaim(request);
  assert.equal(calls[0]?.url, `http://self-hosted.example:7007${READ_COMPLETION_CLAIM_PATH}`);
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-operator-token"), "operator-test-token");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), request);
});

test("hosted principal-JWT completion reaches the canonical endpoint with Bearer before dispatch", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const principalJwt = "header.payload.signature";
  const client = createOperatorBackendClient({
    baseUrl: "https://operator.example/",
    authMode: "principal_jwt",
    token: principalJwt,
    fetchImpl: async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") !== `Bearer ${principalJwt}`) {
        return new Response(JSON.stringify({ error: "Unauthorized (missing/invalid Authorization: Bearer token)." }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, claim_id: "claim-hosted", status: "accepted" }), { status: 202 });
    }
  });

  const result = await client.submitReadCompletionClaim({
    schema: "revit-operator.assignment-read-completion-claim/v1",
    assignment_id: "assignment-hosted",
    run_id: "run-hosted",
    generation: 1,
    session_id: "session-hosted",
    criteria: [{ criterion: "Return the requested inventory.", assertion_ids: ["inventory"] }],
    result: { kind: "inventory", assertions: [{ assertion_id: "inventory" }] }
  }) as any;

  assert.equal(result.status, "accepted");
  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${principalJwt}`);
  assert.equal(headers.has("x-operator-token"), false);
});

test("one auth abstraction applies principal JWT to interaction, evidence, completion, and semantic backend calls", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const client = createOperatorBackendClient({
    baseUrl: "https://operator.example",
    authMode: "principal_jwt",
    token: "principal-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  await client.requestAssignmentClarification({ assignment_id: "assignment-a" });
  await client.retrieveEvidence({ evidence_id: `ev1_${"b".repeat(32)}` });
  await client.submitNoopCompletionClaim({ assignment_id: "assignment-a" });
  await client.planSemanticMepRoute({ userText: "Route one bounded branch." });
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    ASSIGNMENT_CLARIFICATION_PATH,
    EVIDENCE_RETRIEVE_PATH,
    NOOP_COMPLETION_CLAIM_PATH,
    SEMANTIC_MEP_ROUTE_PLAN_PATH
  ]);
  for (const call of calls) {
    assert.equal(call.headers.get("authorization"), "Bearer principal-token");
    assert.equal(call.headers.has("x-operator-token"), false);
  }
});

test("request-scoped MCP metadata supplies auth without exposing it in tool arguments", async () => {
  const auth = {
    schema: OPERATOR_BACKEND_AUTH_V1,
    mode: "principal_jwt" as const,
    credential: "metadata-principal-token",
    allowed_origin: "https://operator.example"
  };
  let observedHeaders = new Headers();
  await runWithOperatorBackendAuth({ "revit-operator/backend-auth": auth }, async () => {
    const client = createOperatorBackendClient({
      baseUrl: "https://operator.example",
      fetchImpl: async (_url, init) => {
        observedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });
    await client.submitReadCompletionClaim({ assignment_id: "assignment-a" });
  });
  assert.equal(observedHeaders.get("authorization"), "Bearer metadata-principal-token");
  assert.equal(observedHeaders.has("x-operator-token"), false);
});

test("bearer origin fencing rejects a foreign target before fetch", async () => {
  let fetches = 0;
  const client = createOperatorBackendClient({
    baseUrl: "https://foreign.example",
    auth: {
      schema: OPERATOR_BACKEND_AUTH_V1,
      mode: "principal_jwt",
      credential: "origin-fenced-token",
      allowed_origin: "https://operator.example"
    },
    fetchImpl: async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    }
  });
  await assert.rejects(() => client.submitReadCompletionClaim({}), (error: unknown) => {
    assert.equal(error instanceof OperatorBackendAuthError && error.code, "OPERATOR_BACKEND_AUTH_ORIGIN_DENIED");
    assert.doesNotMatch(String(error), /origin-fenced-token/);
    return true;
  });
  assert.equal(fetches, 0);
});

test("conflicting credential forms fail closed before fetch", async () => {
  let fetches = 0;
  const client = createOperatorBackendClient({
    baseUrl: "https://operator.example",
    token: "second-token",
    auth: {
      schema: OPERATOR_BACKEND_AUTH_V1,
      mode: "principal_jwt",
      credential: "first-token",
      allowed_origin: "https://operator.example"
    },
    fetchImpl: async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    }
  });
  await assert.rejects(() => client.retrieveEvidence({}), /OPERATOR_BACKEND_AUTH_CONFLICT/);
  assert.equal(fetches, 0);
});

test("principal 401 is not retried or downgraded and credentials are redacted", async () => {
  const credential = "expired-principal-token";
  const requests: Headers[] = [];
  const client = createOperatorBackendClient({
    baseUrl: "https://operator.example",
    authMode: "principal_jwt",
    token: credential,
    fetchImpl: async (_url, init) => {
      requests.push(new Headers(init?.headers));
      return new Response(`expired Authorization: Bearer ${credential}`, { status: 401 });
    }
  });
  await assert.rejects(() => client.submitReadCompletionClaim({}), (error: unknown) => {
    assert.match(String(error), /status 401/);
    assert.doesNotMatch(String(error), new RegExp(credential));
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.has("x-operator-token"), false);
});

test("principal mode never falls back to an available shared token", async () => {
  let fetches = 0;
  const client = createOperatorBackendClient({
    baseUrl: "https://operator.example",
    authMode: "principal_jwt",
    env: { OPERATOR_TOKEN: "available-shared-token" },
    fetchImpl: async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    }
  });
  await assert.rejects(() => client.submitReadCompletionClaim({}), /OPERATOR_BACKEND_AUTH_MISSING/);
  assert.equal(fetches, 0);
});

test("principal credentials require TLS except for an exactly fenced loopback origin", () => {
  const insecure = {
    schema: OPERATOR_BACKEND_AUTH_V1,
    mode: "principal_jwt" as const,
    credential: "bearer",
    allowed_origin: "http://operator.example"
  };
  assert.throws(() => buildOperatorBackendAuthHeaders(insecure, "http://operator.example/path"), /OPERATOR_BACKEND_AUTH_INSECURE_BEARER/);
  const loopback = { ...insecure, allowed_origin: "http://127.0.0.1:7007" };
  assert.equal(buildOperatorBackendAuthHeaders(loopback, "http://127.0.0.1:7007/path").get("authorization"), "Bearer bearer");
});


test("compact child handoff preference is confined to the three authenticated operation methods", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createOperatorBackendClient({ baseUrl: "http://127.0.0.1:12345", token: "handoff-test-token",
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"ok":true}', { status: 200 }); } });
  const input = { operation_id: "child-1", arbitrary_model_field: "unchanged" };
  await client.openAssignmentChildOperationV2(input);
  await client.markAssignmentOperationDispatchV2(input);
  await client.settleAssignmentOperationV2(input);
  await client.manageAssignmentWorkPlanV2(input);
  await client.retrieveEvidence(input);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    "/api/assignments/v2/operations/children", "/api/assignments/v2/operations/dispatch", "/api/assignments/v2/operations/results",
    "/api/assignments/v2/work-plan", "/evidence/retrieve"]);
  calls.forEach((call, index) => {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("X-Operator-Assignment-Handoff"), index < 3 ? "operation_handoff_v1" : null);
    assert.equal(headers.get("X-Operator-Token"), "handoff-test-token");
    assert.deepEqual(JSON.parse(String(call.init?.body)), input);
  });
});
