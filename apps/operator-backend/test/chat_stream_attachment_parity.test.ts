import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { ChatRequest } from "../src/contracts.js";

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

function request(sessionId: string): ChatRequest {
  return {
    version: "operator.backend.v1",
    session_id: sessionId,
    message_id: `${sessionId}-message`,
    user_text: "Open the floor plan import tool for this PDF.",
    user_attachments: [
      {
        id: "redline-pdf",
        relative_path: "artifacts/uploads/redline.pdf",
        filename: "redline.pdf",
        sha256: "a".repeat(64),
        mime: "application/pdf"
      }
    ]
  };
}

function attachmentFromActions(actions: any[]): any {
  return actions[0]?.body?.initialPayload?.attachments?.[0];
}

test("stream and non-stream chat pass the same canonical attachment context to the brain", async (t) => {
  const port = await availablePort();
  const token = "stream-attachment-parity-token";
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_TOKEN: token,
      OPERATOR_BRAIN: "rule",
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0"
    },
    stdio: "ignore"
  });
  t.after(async () => stop(child));

  const base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-operator-token": token };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await fetch(`${base}/health`);
      if (health.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const regularResponse = await fetch(`${base}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(request("regular"))
  });
  assert.equal(regularResponse.status, 200);
  const regular: any = await regularResponse.json();

  const streamResponse = await fetch(`${base}/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify(request("stream"))
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  const actionEvent = streamText
    .split("\n\n")
    .find((event) => event.startsWith("event: actions\n"));
  assert.ok(actionEvent, `missing actions event in ${streamText}`);
  const stream: any = JSON.parse(actionEvent!.split("\n").find((line) => line.startsWith("data: "))!.slice(6));

  assert.deepEqual(attachmentFromActions(stream.actions), attachmentFromActions(regular.actions));
  assert.deepEqual(attachmentFromActions(stream.actions), {
    id: "redline-pdf",
    relative_path: "artifacts/uploads/redline.pdf",
    filename: "redline.pdf",
    sha256: "a".repeat(64),
    mime: "application/pdf"
  });
});
