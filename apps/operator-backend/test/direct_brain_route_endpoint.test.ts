import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";

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
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { headers: { "x-operator-token": token } });
      if (response.ok) return;
    } catch {
      // retry while the child starts
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for backend at ${url}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
}

test("direct provider flag bypasses macro interception for /chat and /chat/stream", async (t) => {
  let providerCalls = 0;
  const provider = http.createServer((_req, res) => {
    providerCalls += 1;
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              assistant_message: "Selected Gemini provider.",
              actions: []
            })
          }]
        }
      }]
    }));
  });
  const providerPort = await listen(provider);
  const backendPort = await availablePort();
  const token = "direct-brain-route-test-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-direct-brain-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(backendPort),
      OPERATOR_TOKEN: token,
      OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0",
      OPERATOR_BRAIN: "gemini",
      OPERATOR_GEMINI_API_KEY: "test-key",
      OPERATOR_GEMINI_AGENT_MODEL: "gemini-test",
      OPERATOR_GEMINI_AGENT_BASE_URL: `http://127.0.0.1:${providerPort}/v1beta`
    },
    stdio: "ignore"
  });
  t.after(async () => {
    await stop(child);
    await new Promise<void>(resolve => provider.close(() => resolve()));
  });

  await waitForHealth(`http://127.0.0.1:${backendPort}/health`, token);
  const headers = {
    "content-type": "application/json",
    "x-operator-token": token
  };
  const body = (sessionId: string, messageId: string) => JSON.stringify({
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: sessionId,
    message_id: messageId,
    user_text: "show project profile",
    context: { operator_brain_route: "direct" }
  });

  const nonStreaming = await fetch(`http://127.0.0.1:${backendPort}/chat`, {
    method: "POST",
    headers,
    body: body("direct-nonstream", "message-1")
  });
  assert.equal(nonStreaming.status, 200);
  assert.equal((await nonStreaming.json() as any).assistant_message, "Selected Gemini provider.");

  const streaming = await fetch(`http://127.0.0.1:${backendPort}/chat/stream`, {
    method: "POST",
    headers,
    body: body("direct-stream", "message-1")
  });
  assert.equal(streaming.status, 200);
  assert.match(await streaming.text(), /Selected Gemini provider\./);
  assert.equal(providerCalls, 2);
});
