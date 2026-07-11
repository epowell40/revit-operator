import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMepSemanticRoutePlan } from "../src/deterministic/mep_semantic_route.js";

async function findAvailablePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await fetch(url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for backend at ${url}`);
}

async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill();
  await new Promise<void>((resolve) => process.once("exit", () => resolve()));
}

test("public semantic MEP endpoint requires auth and returns read-only discovery actions", async (t) => {
  const port = await findAvailablePort();
  const token = "semantic-route-endpoint-test-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-semantic-route-"));
  const endpoint = `http://127.0.0.1:${port}/tools/mep/semantic-route-plan`;
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_TOKEN: token,
      OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0"
    },
    stdio: "ignore"
  });
  t.after(async () => {
    await stop(child);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  await waitForServer(endpoint);

  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_text: "Extend piping from the main to that sink." })
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-token": token },
    body: JSON.stringify({ user_text: "Extend piping from the main to that sink.", view_id: 101, room_number: "405" })
  });
  assert.equal(authorized.status, 200);
  const response = await authorized.json() as any;
  const { aec_intent_evidence, ...legacyResponse } = response;
  assert.deepEqual(legacyResponse, JSON.parse(JSON.stringify(resolveMepSemanticRoutePlan({
    user_text: "Extend piping from the main to that sink.",
    view_id: 101,
    room_number: "405",
    tool_results: []
  }))));
  assert.equal(aec_intent_evidence.schema, "revit-operator.aec-intent-evidence.v1");
  assert.equal(response.ok, true);
  assert.equal(response.handled, true);
  assert.equal(response.status, "needs_discovery");
  assert.equal(response.plan.kind, "pipe");
  assert.equal(response.plan.operation, "branch_to_target");
  assert.ok(response.next_actions.length > 0);
  assert.ok(response.next_actions.every((action: any) => action.path === "/revit/find-elements"));
});

test("public semantic MEP endpoint accepts Sidecar request aliases with canonical precedence", async (t) => {
  const port = await findAvailablePort();
  const token = "semantic-route-endpoint-test-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-semantic-route-alias-"));
  const endpoint = `http://127.0.0.1:${port}/tools/mep/semantic-route-plan`;
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], { env: { ...process.env, OPERATOR_BACKEND_PORT: String(port), OPERATOR_TOKEN: token, OPERATOR_WORKSPACE_ROOT: workspace, OPERATOR_MEMORY_AUTO_TURN_NOTES: "0" }, stdio: "ignore" });
  t.after(async () => { await stop(child); fs.rmSync(workspace, { recursive: true, force: true }); });
  await waitForServer(endpoint);
  const headers = { "content-type": "application/json", "x-operator-token": token };
  const liveText = "Assess extending domestic plumbing piping from an existing main to the sink in Room 405. Do not modify the model. Identify discovery required before routing.";
  const requestTextFixture = "Assess a potential piping extension from the main to the sink in Room 405. Identify the sink, main, connectors, and routing constraints that must be discovered before planning. Confirm Room 405 boundaries and level context. Do not modify the model or execute any next_actions.";
  const sidecar = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ requestText: requestTextFixture }) });
  assert.equal(sidecar.status, 200);
  const response = await sidecar.json() as any;
  const { aec_intent_evidence, ...legacyResponse } = response;
  assert.deepEqual(legacyResponse, JSON.parse(JSON.stringify(resolveMepSemanticRoutePlan({ user_text: requestTextFixture, tool_results: [] }))));
  assert.deepEqual(aec_intent_evidence.evidence[0].source, { kind: "request", field: "user_text" });
  assert.equal(aec_intent_evidence.evidence[0].text, requestTextFixture);
  assert.equal(aec_intent_evidence.target.status, "unresolved");
  assert.equal(aec_intent_evidence.target.location.room_or_space, "405");
  assert.equal(response.plan.operation, "branch_to_target");
  assert.deepEqual(response.next_actions.map((action: any) => action.path), ["/revit/find-elements", "/revit/find-elements"]);
  assert.ok(aec_intent_evidence.intent.proposed_actions.every((action: any) => action.tool === "/revit/find-elements" && action.requires_apply === false));
  assert.ok(aec_intent_evidence.verification.observed.every((gate: any) => gate.status === "not_run"));
  const userTextWins = "Extend piping from the main to the sink in room 401.";
  const camelTextWins = "Extend piping from the main to the sink in room 402.";
  const snake = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ user_text: userTextWins, userText: camelTextWins, request: liveText, requestText: requestTextFixture }) });
  assert.equal((await snake.json() as any).aec_intent_evidence.evidence[0].text, userTextWins);
  const camel = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ userText: camelTextWins, request: liveText, requestText: requestTextFixture }) });
  assert.equal((await camel.json() as any).aec_intent_evidence.evidence[0].text, camelTextWins);
  const request = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ request: liveText, requestText: requestTextFixture }) });
  assert.equal((await request.json() as any).aec_intent_evidence.evidence[0].text, liveText);
  const ignored = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ requestText: { user_text: liveText } }) });
  assert.equal(ignored.status, 200);
  const ignoredResponse = await ignored.json() as any;
  assert.equal(ignoredResponse.handled, false);
  assert.equal(ignoredResponse.status, "not_applicable");
});
