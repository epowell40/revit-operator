import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SIDECAR_AGENT_PROFILE_SCHEMA } from "../src/capabilities/sidecar_agent_profile.js";

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", () => resolve()).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url: string, token: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { "x-operator-token": token } });
      if (response.ok) return await response.json() as Record<string, unknown>;
    } catch {
      // Retry while the child process starts.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for backend health at ${url}`);
}

async function fetchJson(url: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { "x-operator-token": token } });
  assert.equal(response.status, 200);
  return await response.json() as Record<string, unknown>;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
}

test("health exposes the backend-authored Sidecar agent profile handshake", async (t) => {
  const port = await availablePort();
  const token = "sidecar-agent-profile-health-test-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-sidecar-profile-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_TOKEN: token,
      OPERATOR_AUTH_MODE: "shared_token",
      OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0",
      OPERATOR_BRAIN: "codex",
      REVIT_OPERATOR_MODE: "development",
      OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
      OPERATOR_HOSTED_ENABLED: "0"
    },
    stdio: "ignore"
  });
  t.after(async () => {
    await stop(child);
    // Windows can retain SQLite WAL/SHM handles for a few milliseconds after
    // the backend process exits. Keep teardown bounded, but do not turn that
    // transient filesystem state into a product-handshake failure.
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const health = await waitForHealth(`http://127.0.0.1:${port}/health`, token);
  const expectedProfile = {
    schema: SIDECAR_AGENT_PROFILE_SCHEMA,
    source: "backend_environment",
    runtime_mode: "development",
    tool_exposure_profile: "laboratory",
    capability_profile: "general_agent_laboratory",
    general_agent_ready: true,
    reason_code: "GENERAL_AGENT_DEVELOPMENT_LABORATORY_READY"
  };
  assert.deepEqual(health.sidecar_agent_profile, expectedProfile);

  const desktopConfig = await fetchJson(`http://127.0.0.1:${port}/desktop/computer/config`, token);
  assert.deepEqual(desktopConfig.sidecar_agent_profile, expectedProfile);
});
