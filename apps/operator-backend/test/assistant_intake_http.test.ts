import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { PersistenceManager } from "../src/persistence/persistence_manager.js";

async function availablePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve) => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address() as { port: number };
      socket.close(() => resolve(address.port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerPart = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest("base64url");
  return `${headerPart}.${payloadPart}.${signature}`;
}

async function startBackend(t: { after: (fn: () => Promise<void>) => void }, overrides: Record<string, string> = {}) {
  const port = await availablePort();
  const token = "public-chat-result-test-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-public-chat-result-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_TOKEN: token,
      OPERATOR_BRAIN: "rule",
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0",
      OPERATOR_WORKSPACE_ROOT: workspace,
      ...overrides
    },
    stdio: "ignore"
  });
  t.after(async () => stop(child));

  const base = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = overrides.OPERATOR_AUTH_MODE === "principal_jwt"
    ? { "content-type": "application/json", authorization: `Bearer ${signJwt({ sub: "owner-a", user_id: "owner-a", tenant_id: "tenant-1", license_id: "tenant-1", roles: ["user"], iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 300 }, overrides.OPERATOR_JWT_SECRET || "")}` }
    : { "content-type": "application/json", "x-operator-token": token };
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const health = await fetch(`${base}/health`, { headers });
      if (health.ok) return { base, headers, workspace };
    } catch {
      // wait for startup
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("backend did not become ready");
}

test("context and batch availability endpoints enforce session ownership without contacting Revit", async t => {
  const secret = "intake-context-test-secret";
  const { base, headers } = await startBackend(t, { OPERATOR_AUTH_MODE: "principal_jwt", OPERATOR_JWT_SECRET: secret,
    OPERATOR_JWT_ISSUER: "", OPERATOR_JWT_AUDIENCE: "", REVIT_BRIDGE_URL: "http://127.0.0.1:1" });
  const created = await fetch(`${base}/session/new`, { method: "POST", headers });
  assert.equal(created.status, 200, await created.clone().text());
  const { session_id } = await created.json() as any;
  const now = Math.floor(Date.now() / 1000);
  const other = { "content-type": "application/json", authorization: `Bearer ${signJwt({ sub: "other", user_id: "other", tenant_id: "tenant-1", license_id: "tenant-1", iat: now - 5, exp: now + 300 }, secret)}` };
  const request = { version: "operator.backend.v1", session_id, message_id: "question", user_text: "What is static pressure in an HVAC duct? Keep it to two sentences." };
  const policy = async (body: unknown, auth: any = headers) => fetch(`${base}/chat/context-policy`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  assert.equal((await policy(request, { "content-type": "application/json" })).status, 401);
  assert.equal((await policy(request, other)).status, 403);
  assert.equal((await policy({ ...request, tool_results: {} })).status, 400);
  const reply = await policy(request);
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { schema: "revit-operator.chat-context-policy.v1", session_id, message_id: "question", requires_revit_context: false });
  for (const body of [{ ...request, user_text: "What is the diameter of the selected duct?" }, { ...request, assignment_id: "task" }]) {
    assert.equal((await (await policy(body)).json() as any).requires_revit_context, true);
  }
  const availability = `/api/revit-batch/availability?session_id=${encodeURIComponent(session_id)}&executor_kind=revit_delegate`;
  assert.equal((await fetch(`${base}${availability}`)).status, 401);
  assert.equal((await fetch(`${base}${availability}`, { headers: other })).status, 403);
  assert.equal((await fetch(`${base}/api/revit-batch/availability`, { headers })).status, 400);
  assert.deepEqual(await (await fetch(`${base}${availability}`, { headers })).json(), { schema: "revit-operator.batch-availability.v1", ok: true, available: false });
  const binding = { session_id, target_executor_id: "executor-a", project_fingerprint: "a".repeat(64) };
  const creation = await fetch(`${base}/api/revit-batch/jobs`, { method: "POST", headers, body: JSON.stringify({ ...binding,
    job_type: "delegated_revit_task_batch", title: "Availability fixture", approval: { required: false },
    items: [{ id: "one", index: 1, task_prompt: "Inspect the selected duct." }] }) });
  assert.equal(creation.status, 200, await creation.text());
  assert.equal((await (await fetch(`${base}${availability}`, { headers })).json() as any).available, true);
  // Availability does not weaken the claim's required live document/executor fence.
  const unbound = await fetch(`${base}/api/revit-batch/claim-next`, { method: "POST", headers, body: JSON.stringify({ session_id, executor_id: "executor-a" }) });
  assert.equal(unbound.status, 400);
  const wrong = await fetch(`${base}/api/revit-batch/claim-next`, { method: "POST", headers,
    body: JSON.stringify({ ...binding, project_fingerprint: "b".repeat(64), executor_id: "executor-a" }) });
  assert.equal(wrong.status, 200); assert.equal((await wrong.json() as any).item, null);
});
