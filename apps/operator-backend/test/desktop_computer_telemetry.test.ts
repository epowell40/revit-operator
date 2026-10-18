import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getDesktopComputerProviderErrorReceipt,
  relayDesktopComputerResponse,
  relayBoundDesktopComputerResponse
} from "../src/desktop_computer.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { modelEvidenceEnvelope } from "../src/evidence/model_context_budget.js";
import { createGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";

test("bound desktop HTTP relay retains canonical in-flight and usage without verifying work", async () => {
  const previous = { key: process.env.OPERATOR_OPENAI_API_KEY, base: process.env.OPERATOR_OPENAI_BASE_URL,
    workspace: process.env.OPERATOR_WORKSPACE_ROOT };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bound-desktop-relay-"));
  let goalId = "";
  let requests = 0;
  let upstreamRequest: any;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data',chunk=>chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      upstreamRequest=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests++;
      const snapshot = getAssignmentKernelSnapshotV2(goalId)!;
      assert.equal(snapshot.in_flight_provider_call_ids.length, 1);
      assert.equal(snapshot.quiescent, false);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "bound-upstream", status: "completed", model: "gpt-6.1-sol", output: [],
        usage: { input_tokens: 21, output_tokens: 5, total_tokens: 26 } }));
    });
  });
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = workspace;
    process.env.OPERATOR_OPENAI_API_KEY = "test-key";
    process.env.OPERATOR_OPENAI_BASE_URL = `http://127.0.0.1:${await listen(server)}`;
    __testOnlyResetGoalListCache();
    const goal = createGoal({ title: "Read PDF", objective: "Inspect the existing PDF.", created_by: "test-principal",
      acceptance_criteria: ["Report the result."], status: "active", related_session_id: "bound-desktop",
      work_budget: { requested_effect: "read" } });
    goalId = goal.id;
    const binding = createAssignmentKernelForGoalV2({ goal, run_id: "bound-desktop-run" });
    const result = await relayBoundDesktopComputerResponse({ model: "gpt-6.1-sol", reasoning_effort: "medium", input: "Inspect PDF", message_id: "direct-request-a" },
      { ...binding, kernelVersion: 2 });
    assert.equal(requests, 1);
    assert.match(upstreamRequest.instructions, /normally omit source revision clouds and revision tags/);
    assert.match(upstreamRequest.instructions, /actual authorized project revision/);
    assert.match(JSON.stringify(upstreamRequest.input), /operator.desktop-assignment-feedback.v1/);
    assert.match(JSON.stringify(upstreamRequest.input), /Inspect PDF/);
    assert.equal(result.model_call_receipt.call_id, "bound-upstream");
    assert.equal(result.status, "completed");
    assert.deepEqual(result.provider_response_usage, {
      schema: "revit-operator.provider-response-usage/v1", session_id: binding.session_id,
      message_id: "direct-request-a", disposition: "completed", raw_response_ids: ["bound-upstream"]
    });
    const snapshot = getAssignmentKernelSnapshotV2(goalId)!;
    assert.equal(snapshot.quiescent, true);
    assert.equal(snapshot.outcome, "active");
    assert.equal(snapshot.provider_call_ids.length, 1);
    assert.equal(Object.values(snapshot.provider_calls)[0]!.usage!.total_tokens, 26);
    assert.equal(Object.values(snapshot.provider_calls)[0]!.model, "gpt-6.1-sol");
    assert.deepEqual(Object.values(snapshot.provider_calls)[0]!.upstream_receipt, {
      call_id: result.model_call_receipt.call_id, route: "desktop_computer",
      model: result.model_call_receipt.model, requested_model: result.model_call_receipt.requested_model,
      started_at_utc: result.model_call_receipt.started_at_utc, duration_ms: result.model_call_receipt.duration_ms
    });
  } finally {
    if (previous.key === undefined) delete process.env.OPERATOR_OPENAI_API_KEY; else process.env.OPERATOR_OPENAI_API_KEY = previous.key;
    if (previous.base === undefined) delete process.env.OPERATOR_OPENAI_BASE_URL; else process.env.OPERATOR_OPENAI_BASE_URL = previous.base;
    if (previous.workspace === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous.workspace;
    __testOnlyResetGoalListCache();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("desktop relay preserves incomplete provider status even when its text looks like a valid review", {concurrency:false}, async () => {
  const previous={key:process.env.OPERATOR_OPENAI_API_KEY,base:process.env.OPERATOR_OPENAI_BASE_URL};
  let submitted:any;
  const server=http.createServer((request,response)=>{
    const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(Buffer.from(chunk)));request.on('end',()=>{
      submitted=JSON.parse(Buffer.concat(chunks).toString('utf8'));response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({id:'resp_incomplete_review',status:'incomplete',model:'gpt-6.1-sol',
        output:[{type:'message',content:[{type:'output_text',text:'{"checks":[{"id":"gap","status":"matched"}]}'}]}],
        usage:{input_tokens:10,output_tokens:5,total_tokens:15}}));
    });
  });
  try{
    process.env.OPERATOR_OPENAI_API_KEY='test-key';process.env.OPERATOR_OPENAI_BASE_URL=`http://127.0.0.1:${await listen(server)}`;
    const r=await relayDesktopComputerResponse({model:'gpt-6.1-sol',reasoning_effort:'medium',instructions:'Independent visual review.',tools:[],input:[{role:'user',content:[{type:'input_text',text:'Inspect the current sheet.'},{type:'input_image',image_url:'data:image/png;base64,aW1hZ2U=',detail:'original'}]}]});
    assert.equal(r.status,'incomplete');assert.match(r.output_text,/matched/);assert.equal(r.model_call_receipt.tokens.total_tokens,15);
    assert.deepEqual(submitted.tools,[]);assert.equal(submitted.previous_response_id,undefined);assert.equal(submitted.input[0].content[1].type,'input_image');
  }finally{if(previous.key===undefined)delete process.env.OPERATOR_OPENAI_API_KEY;else process.env.OPERATOR_OPENAI_API_KEY=previous.key;if(previous.base===undefined)delete process.env.OPERATOR_OPENAI_BASE_URL;else process.env.OPERATOR_OPENAI_BASE_URL=previous.base;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

async function listen(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function availablePort(): Promise<number> {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url: string, token: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { "x-operator-token": token } });
      if (response.ok) return;
    } catch {
      // Retry while the backend child starts.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for backend health at ${url}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
}

test("desktop relay preserves outer-model usage for Luna at literal max", { concurrency: false }, async () => {
  let requestBody: any = null;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp_desktop_luna",
        object: "response",
        status: "completed",
        model: "gpt-5.6-luna",
        output: [],
        usage: {
          input_tokens: 210,
          input_tokens_details: { cached_tokens: 150 },
          output_tokens: 55,
          output_tokens_details: { reasoning_tokens: 34 },
          total_tokens: 265
        }
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = {
    key: process.env.OPERATOR_OPENAI_API_KEY,
    baseUrl: process.env.OPERATOR_OPENAI_BASE_URL,
    workspace: process.env.OPERATOR_WORKSPACE_ROOT
  };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-desktop-evidence-"));
  try {
    process.env.OPERATOR_OPENAI_API_KEY = "test-key";
    process.env.OPERATOR_OPENAI_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPERATOR_WORKSPACE_ROOT = workspace;
    const scope = { session_id: "desktop-session", assignment_id: "desktop-assignment" };
    const stored = storeEvidence({ scope, source: "desktop-test", trust_level: "host_observed", raw: { count: 509, rows: "x".repeat(20_000) } });
    const result = await relayDesktopComputerResponse({
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      input: [{ type: "function_call_output", call_id: "tool-call", output: JSON.stringify(modelEvidenceEnvelope([stored.projection])) }],
      evidence_scope: scope
    });

    assert.equal(requestBody.model, "gpt-5.6-luna");
    assert.equal(requestBody.reasoning.effort, "max");
    assert.equal(result.model_call_receipt.route, "desktop_computer");
    assert.equal(result.model_call_receipt.call_id, "resp_desktop_luna");
    assert.equal(result.model_call_receipt.success, true);
    assert.deepEqual(result.model_call_receipt.tokens, {
      input_tokens: 210,
      cached_input_tokens: 150,
      output_tokens: 55,
      reasoning_output_tokens: 34,
      total_tokens: 265
    });
    const telemetry = fs.readFileSync(path.join(workspace, "evidence", "telemetry.jsonl"), "utf8")
      .trim().split(/\r?\n/).map(line => JSON.parse(line));
    const modelEvent = telemetry.find(event => event.source === "desktop_computer_model_context");
    assert.equal(modelEvent.model_call_id, "resp_desktop_luna");
    assert.equal(modelEvent.assignment_id, scope.assignment_id);
    assert.ok(modelEvent.projected_bytes_sent > 0);
    assert.ok(modelEvent.duplicate_bytes_avoided > 0);
  } finally {
    if (previous.key === undefined) delete process.env.OPERATOR_OPENAI_API_KEY;
    else process.env.OPERATOR_OPENAI_API_KEY = previous.key;
    if (previous.baseUrl === undefined) delete process.env.OPERATOR_OPENAI_BASE_URL;
    else process.env.OPERATOR_OPENAI_BASE_URL = previous.baseUrl;
    if (previous.workspace === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous.workspace;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("desktop relay rejects unsafe explicit model and effort values before dispatch", { concurrency: false }, async () => {
  const previous = process.env.OPERATOR_OPENAI_API_KEY;
  process.env.OPERATOR_OPENAI_API_KEY = "test-key";
  try {
    for (const [request, expectedMessage] of [
      [{ model: "../../bad model", input: "test" }, /bounded provider model identifier/],
      [{ reasoning_effort: "maximum", input: "test" }, /none, low, medium, high, xhigh, or max/],
      [{ model: "gpt-6.1-sol", reasoning_effort: "none", input: "test" }, /requires reasoning effort low, medium, high, xhigh, or max/]
    ]) {
      try {
        await relayDesktopComputerResponse(request as any);
        assert.fail("Expected pre-dispatch validation to fail.");
      } catch (error) {
        assert.match(error instanceof Error ? error.message : "", expectedMessage as RegExp);
        assert.equal(getDesktopComputerProviderErrorReceipt(error), null);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_OPENAI_API_KEY;
    else process.env.OPERATOR_OPENAI_API_KEY = previous;
  }
});

test("desktop relay does not claim a provider call when API configuration is missing", { concurrency: false }, async () => {
  const previous = {
    operatorKey: process.env.OPERATOR_OPENAI_API_KEY,
    fallbackKey: process.env.OPENAI_API_KEY
  };
  delete process.env.OPERATOR_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await relayDesktopComputerResponse({ input: "test" });
    assert.fail("Expected missing API configuration to fail.");
  } catch (error) {
    assert.match(error instanceof Error ? error.message : "", /OPERATOR_OPENAI_API_KEY/);
    assert.equal(getDesktopComputerProviderErrorReceipt(error), null);
  } finally {
    if (previous.operatorKey === undefined) delete process.env.OPERATOR_OPENAI_API_KEY;
    else process.env.OPERATOR_OPENAI_API_KEY = previous.operatorKey;
    if (previous.fallbackKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.fallbackKey;
  }
});

test("desktop endpoint returns one content-free failed receipt for a dispatched provider error", { concurrency: false }, async (t) => {
  const rawProviderMessage = "provider raw body contains prompt=DO_NOT_EXPOSE and secret=sk-private";
  let providerCalls = 0;
  let delayedSuccess = false;
  const provider = http.createServer((_request, response) => {
    providerCalls += 1;
    if (delayedSuccess) {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "late-http-response", model: "gpt-5.6-luna", output: [{ type: "message", content: [{ type: "output_text", text: "retained result" }] }],
          usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 } }));
      }, 100);
      return;
    }
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        message: rawProviderMessage,
        type: "invalid_request_error",
        code: "mock_provider_failure"
      }
    }));
  });
  const providerPort = await listen(provider);
  const backendPort = await availablePort();
  const token = "desktop-provider-error-receipt-test-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-desktop-receipt-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(backendPort),
      OPERATOR_TOKEN: token,
      OPERATOR_AUTH_MODE: "shared_token",
      OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0",
      OPERATOR_OPENAI_API_KEY: "test-key",
      OPERATOR_OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}`,
      OPERATOR_HOSTED_ENABLED: "0"
    },
    stdio: "ignore"
  });
  t.after(async () => {
    await stop(child);
    await new Promise<void>(resolve => provider.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await waitForHealth(`http://127.0.0.1:${backendPort}/health`, token);
  const sessionId = "desktop-provider-error-bound-session";
  const unbound = await fetch(`http://127.0.0.1:${backendPort}/desktop/computer/respond`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-token": token },
    body: JSON.stringify({ session_id: sessionId, model: "gpt-5.6-luna", reasoning_effort: "max", input: "unbound" })
  });
  assert.equal(unbound.status, 500);
  assert.match(await unbound.text(), /desktop_computer_assignment_binding_required/);
  assert.equal(providerCalls, 0);
  const goalResponse = await fetch(`http://127.0.0.1:${backendPort}/api/agent-goal`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-token": token },
    body: JSON.stringify({
      session_id: sessionId,
      title: "Bound desktop provider telemetry",
      objective: "Prove provider failure telemetry remains bound.",
      acceptance_criteria: ["The provider boundary returns one safe receipt."],
      work_budget: { mode: "sidecar_computer", source: "operator_desktop" },
      work_items: [{ id: "provider-call", title: "Call the provider", status: "in_progress" }],
      start_assignment_run: true,
      assignment_run_id: "desktop-provider-error-run",
      assignment_run_actor: "operator_desktop_outer_agent"
    })
  });
  assert.equal(goalResponse.status, 200);
  const binding = (await goalResponse.json() as any).assignment_run;
  const response = await fetch(`http://127.0.0.1:${backendPort}/desktop/computer/respond`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-operator-token": token
    },
    body: JSON.stringify({
      session_id: sessionId,
      assignment_id: binding.assignment_id,
      assignment_run_id: binding.run_id,
      assignment_generation: binding.generation,
      message_id: "retained-error-request",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      input: "sensitive prompt that must not be returned"
    })
  });

  assert.equal(response.status, 500);
  const responseText = await response.text();
  const payload = JSON.parse(responseText) as any;
  assert.equal(payload.error, "Desktop computer provider request failed.");
  assert.equal(providerCalls, 1);
  assert.equal(payload.model_call_receipts.length, 1);
  assert.deepEqual(payload.model_call_receipts[0], {
    schema: "revit-operator.model-call-receipt.v1",
    call_id: payload.model_call_receipts[0].call_id,
    provider: "openai",
    route: "desktop_computer",
    requested_model: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    reasoning_effort: "max",
    started_at_utc: payload.model_call_receipts[0].started_at_utc,
    duration_ms: payload.model_call_receipts[0].duration_ms,
    success: false,
    response_status: null,
    error_code: "mock_provider_failure",
    tokens: {
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      total_tokens: null
    }
  });
  assert.match(payload.model_call_receipts[0].call_id, /^[0-9a-f-]{36}$/);
  assert.match(payload.model_call_receipts[0].started_at_utc, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Number.isInteger(payload.model_call_receipts[0].duration_ms), true);
  assert.equal(responseText.includes(rawProviderMessage), false);
  assert.equal(responseText.includes("sensitive prompt"), false);
  assert.equal(responseText.includes("sk-private"), false);
  const recoveryBody = { session_id: sessionId, assignment_id: binding.assignment_id,
    assignment_run_id: binding.run_id, assignment_generation: binding.generation, message_id: "retained-error-request" };
  const recover = (body: unknown, authToken = token) => fetch(`http://127.0.0.1:${backendPort}/desktop/computer/result`, {
    method: "POST", headers: { "content-type": "application/json", "x-operator-token": authToken }, body: JSON.stringify(body) });
  const recovered = await recover(recoveryBody);
  assert.equal(recovered.status, 200);
  const saved = await recovered.json() as any;
  assert.equal(saved.status, "error");
  assert.deepEqual(saved.failure.model_call_receipts, payload.model_call_receipts);
  assert.notEqual((await recover(recoveryBody, "wrong-token")).status, 200);
  assert.notEqual((await recover({ ...recoveryBody, assignment_generation: binding.generation + 1 })).status, 200);
  assert.notEqual((await recover({ ...recoveryBody, session_id: "wrong-session" })).status, 200);
  delayedSuccess = true;
  const abort = new AbortController();
  const lateBody = { ...recoveryBody, message_id: "late-http-request", model: "gpt-5.6-luna", reasoning_effort: "max", input: "late" };
  const lost = fetch(`http://127.0.0.1:${backendPort}/desktop/computer/respond`, {
    method: "POST", headers: { "content-type": "application/json", "x-operator-token": token },
    body: JSON.stringify(lateBody), signal: abort.signal });
  const lostObserved = assert.rejects(lost, /abort/i);
  while (providerCalls < 2) await new Promise(resolve => setTimeout(resolve, 5));
  abort.abort(); await lostObserved;
  let late: any;
  for (let i=0;i<100;i++) {
    late = await (await recover({ ...recoveryBody, message_id: "late-http-request" })).json();
    if(late.status === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(late.status, "complete"); assert.equal(late.response.id, "late-http-response");
  assert.equal(late.response.model_call_receipt.tokens.total_tokens, 13);
  const telemetryBody = { ...recoveryBody, message_id: "late-http-request", telemetry_only: true };
  const accounting = await recover(telemetryBody);
  assert.equal(accounting.status, 200);
  const projection = await accounting.json() as any;
  assert.equal(projection.status, "complete");
  assert.deepEqual(projection.telemetry.model_call_receipt, late.response.model_call_receipt);
  assert.deepEqual(projection.telemetry.provider_response_usage, late.response.provider_response_usage);
  assert.equal(projection.response, undefined);
  assert.equal(projection.telemetry.output, undefined);
  assert.notEqual((await recover(telemetryBody, "wrong-token")).status, 200);
  assert.notEqual((await recover({...telemetryBody, assignment_generation:binding.generation+1})).status, 200);
  assert.notEqual((await recover({...telemetryBody, session_id:"wrong-session"})).status, 200);
  const duplicate = await fetch(`http://127.0.0.1:${backendPort}/desktop/computer/respond`, {
    method: "POST", headers: { "content-type": "application/json", "x-operator-token": token }, body: JSON.stringify(lateBody) });
  assert.notEqual(duplicate.status, 200); assert.equal(providerCalls, 2);
});
