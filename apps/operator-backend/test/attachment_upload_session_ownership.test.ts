import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

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

test("attachment upload requires explicit session binding in shared-token mode", async (t) => {
  const port = await availablePort();
  const token = "attachment-session-binding-token";
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_AUTH_MODE: "shared_token",
      OPERATOR_TOKEN: token,
      OPERATOR_WORKSPACE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-upload-owner-")),
      OPERATOR_BRAIN: "rule"
    },
    stdio: "ignore"
  });
  t.after(async () => stop(child));

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const headers = { "x-operator-token": token, "content-type": "application/json" };
  const createdResponse = await fetch(`${base}/session/new`, { method: "POST", headers });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as { session_id: string };
  const missingSessionResponse = await fetch(`${base}/attachments/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filename: "redline.txt", mime: "text/plain", data_base64: Buffer.from("redline", "utf8").toString("base64") })
  });
  assert.equal(missingSessionResponse.status, 400);
  assert.match(await missingSessionResponse.text(), /session_id is required/i);

  const boundUploadResponse = await fetch(`${base}/attachments/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ session_id: created.session_id, filename: "redline.txt", mime: "text/plain", data_base64: Buffer.from("redline", "utf8").toString("base64") })
  });
  assert.equal(boundUploadResponse.status, 200);
});
