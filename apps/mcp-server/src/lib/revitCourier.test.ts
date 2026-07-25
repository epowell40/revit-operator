import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callRevitViaCourier } from "./revitCourier.js";

async function waitForJob(root: string): Promise<{ id: string; dir: string }> {
  const jobsRoot = path.join(root, "artifacts", "revit-courier", "jobs");
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(jobsRoot)) {
      const id = fs.readdirSync(jobsRoot).find(name => fs.existsSync(path.join(jobsRoot, name, "job.json")));
      if (id) return { id, dir: path.join(jobsRoot, id) };
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for courier test job.");
}

test("MCP courier publishes a correlated job and resolves its durable result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "revit-courier-context.json"), JSON.stringify({
    version: "revit-operator.revit-courier-context.v1",
    active: true,
    session_id: "session-a",
    message_id: "message-a",
    expires_at: new Date(Date.now() + 60_000).toISOString()
  }), "utf8");

  const pending = callRevitViaCourier<{ status: string }>("/revit/ping", "GET");
  const jobRef = await waitForJob(root);
  const job = JSON.parse(fs.readFileSync(path.join(jobRef.dir, "job.json"), "utf8"));
  assert.equal(job.session_id, "session-a");
  assert.equal(job.path, "/revit/ping");
  assert.equal(job.method, "GET");
  fs.writeFileSync(path.join(jobRef.dir, "result.json"), JSON.stringify({
    version: "revit-operator.revit-tool-result.v1",
    id: jobRef.id,
    correlation_id: jobRef.id,
    status: "succeeded",
    result: { status: "ok" },
    retryable: false
  }), "utf8");
  assert.deepEqual(await pending, { status: "ok" });
});
