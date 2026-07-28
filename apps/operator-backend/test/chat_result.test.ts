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
    ? { "content-type": "application/json", authorization: `Bearer ${signJwt({ sub: "owner-a", user_id: "owner-a", tenant_id: "tenant-1", roles: ["user"], iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 300 }, overrides.OPERATOR_JWT_SECRET || "")}` }
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

test("public chat result lookup is authenticated, pending, exact, and preserves actions", async (t) => {
  const { base, headers, workspace } = await startBackend(t);
  const sessionId = `public-session-${randomUUID()}`;
  const messageId = `public-message-${randomUUID()}`;
  const query = `/chat/result?session_id=${encodeURIComponent(sessionId)}&message_id=${encodeURIComponent(messageId)}`;

  const unauthorized = await fetch(`${base}${query}`);
  assert.equal(unauthorized.status, 401);

  const pending = await fetch(`${base}${query}`, { headers });
  assert.equal(pending.status, 202);
  assert.deepEqual(await pending.json(), { status: "pending", session_id: sessionId, message_id: messageId });

  const request = {
    version: "operator.backend.v1",
    session_id: sessionId,
    message_id: messageId,
    user_text: "ping"
  };
  const posted = await fetch(`${base}/chat`, { method: "POST", headers, body: JSON.stringify(request) });
  assert.equal(posted.status, 200);
  const expected = await posted.json() as any;
  assert.equal(expected.actions.length, 1);
  assert.equal(expected.actions[0].path, "/revit/ping");

  const recovered = await fetch(`${base}${query}`, { headers });
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), expected);

  const persistedPath = path.join(workspace, "runs", "sessions", sessionId, "chat_results", `${messageId}.json`);
  assert.ok(fs.existsSync(persistedPath), persistedPath);
  const persisted = JSON.parse(fs.readFileSync(persistedPath, "utf8"));
  assert.equal(persisted.status, "complete");
  assert.deepEqual(persisted.response, expected);

  const macroMessageId = `public-macro-${randomUUID()}`;
  const macroQuery = `/chat/result?session_id=${encodeURIComponent(sessionId)}&message_id=${encodeURIComponent(macroMessageId)}`;
  const macroPosted = await fetch(`${base}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ version: "operator.backend.v1", session_id: sessionId, message_id: macroMessageId, user_text: 'create proposal Add a bounded public test with {"summary":"late result"}' })
  });
  assert.equal(macroPosted.status, 200);
  const macroExpected = await macroPosted.json();
  const macroRecovered = await fetch(`${base}${macroQuery}`, { headers });
  assert.equal(macroRecovered.status, 200);
  assert.deepEqual(await macroRecovered.json(), macroExpected);
});

test("public chat result lookup enforces authenticated session ownership", async (t) => {
  const secret = "public-chat-result-ownership-secret";
  const { base } = await startBackend(t, {
    OPERATOR_AUTH_MODE: "principal_jwt",
    OPERATOR_JWT_SECRET: secret,
    OPERATOR_JWT_ISSUER: "",
    OPERATOR_JWT_AUDIENCE: ""
  });
  const now = Math.floor(Date.now() / 1000);
  const token = (userId: string) => signJwt({ sub: userId, user_id: userId, tenant_id: "tenant-1", roles: ["user"], iat: now - 5, exp: now + 300 }, secret);
  const ownerHeaders = { authorization: `Bearer ${token("owner-a")}` };
  const otherHeaders = { authorization: `Bearer ${token("owner-b")}` };

  const created = await fetch(`${base}/session/new`, { method: "POST", headers: ownerHeaders });
  assert.equal(created.status, 200);
  const { session_id } = await created.json() as { session_id: string };
  const query = `/chat/result?session_id=${encodeURIComponent(session_id)}&message_id=late-message`;

  const ownerPending = await fetch(`${base}${query}`, { headers: ownerHeaders });
  assert.equal(ownerPending.status, 202);
  const otherLookup = await fetch(`${base}${query}`, { headers: otherHeaders });
  assert.equal(otherLookup.status, 403);
  assert.deepEqual(await otherLookup.json(), { error: "Forbidden (session is not bound to this principal)." });
});

test("public chat error results are durable terminal envelopes", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-public-chat-error-"));
  const previousWorkspace = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = workspace;
  try {
    const persistence = new PersistenceManager();
    persistence.persistChatError({ sessionId: "error-session", messageId: "error-message", error: "provider failed after the request was accepted" });
    const record = persistence.readChatResult({ sessionId: "error-session", messageId: "error-message" });
    assert.deepEqual(record && { status: record.status, session_id: record.session_id, message_id: record.message_id, error: record.status === "error" ? record.error : null }, {
      status: "error",
      session_id: "error-session",
      message_id: "error-message",
      error: "provider failed after the request was accepted"
    });
  } finally {
    if (previousWorkspace === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousWorkspace;
  }
});

test("public chat result route returns a 200 terminal error envelope", async (t) => {
  const { base, headers, workspace } = await startBackend(t);
  const previousWorkspace = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = workspace;
  try {
    const persistence = new PersistenceManager();
    persistence.persistChatError({ sessionId: "route-error-session", messageId: "route-error-message", error: "persisted route error" });
  } finally {
    if (previousWorkspace === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousWorkspace;
  }
  const response = await fetch(`${base}/chat/result?session_id=route-error-session&message_id=route-error-message`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "error", session_id: "route-error-session", message_id: "route-error-message", error: "persisted route error" });
});
