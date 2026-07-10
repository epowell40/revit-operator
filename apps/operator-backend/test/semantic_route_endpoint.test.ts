import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  assert.equal(response.ok, true);
  assert.equal(response.handled, true);
  assert.equal(response.status, "needs_discovery");
  assert.equal(response.plan.kind, "pipe");
  assert.equal(response.plan.operation, "branch_to_target");
  assert.ok(response.next_actions.length > 0);
  assert.ok(response.next_actions.every((action: any) => action.path === "/revit/find-elements"));
});
