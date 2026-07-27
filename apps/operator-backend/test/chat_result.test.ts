import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

test("authenticated chat result lookup returns pending then the exact response", async (t) => {
  const port = await availablePort();
  const token = "public-chat-result-test-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-public-chat-result-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: { ...process.env, OPERATOR_BACKEND_PORT: String(port), OPERATOR_TOKEN: token, OPERATOR_BRAIN: "rule", OPERATOR_WORKSPACE_ROOT: workspace },
    stdio: "ignore"
  });
  t.after(async () => stop(child));
  const base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-operator-token": token };
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`, { headers })).ok) break;
    } catch {
      // wait for startup
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  const sessionId = `public-session-${randomUUID()}`;
  const messageId = `public-message-${randomUUID()}`;
  const query = `/chat/result?session_id=${encodeURIComponent(sessionId)}&message_id=${encodeURIComponent(messageId)}`;
  assert.equal((await fetch(`${base}${query}`)).status, 401);
  const pending = await fetch(`${base}${query}`, { headers });
  assert.equal(pending.status, 202);

  const posted = await fetch(`${base}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ version: "operator.backend.v1", session_id: sessionId, message_id: messageId, user_text: "ping" })
  });
  assert.equal(posted.status, 200);
  const expected = await posted.json();
  const recovered = await fetch(`${base}${query}`, { headers });
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), expected);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, "runs", "sessions", sessionId, "chat_results", `${messageId}.json`), "utf8")).status, "complete");

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

test("public persistence stores a terminal chat error envelope", () => {
  const previousWorkspace = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-public-chat-error-"));
  try {
    const persistence = new PersistenceManager();
    persistence.persistChatError({ sessionId: "error-session", messageId: "error-message", error: "terminal provider error" });
    const record = persistence.readChatResult({ sessionId: "error-session", messageId: "error-message" });
    assert.equal(record?.status, "error");
    assert.equal(record?.error, "terminal provider error");
  } finally {
    if (previousWorkspace === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousWorkspace;
  }
});

test("public chat result route returns a 200 terminal error envelope", async (t) => {
  const port = await availablePort();
  const token = "public-chat-result-error-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-public-chat-route-error-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: { ...process.env, OPERATOR_BACKEND_PORT: String(port), OPERATOR_TOKEN: token, OPERATOR_BRAIN: "rule", OPERATOR_WORKSPACE_ROOT: workspace },
    stdio: "ignore"
  });
  t.after(async () => stop(child));
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-operator-token": token };
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`, { headers })).ok) break;
    } catch {
      // wait for startup
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
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
