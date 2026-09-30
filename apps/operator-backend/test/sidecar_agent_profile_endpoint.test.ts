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

for (const installation of [false, true])
test(`health exposes the backend-authored Sidecar agent profile handshake (local installation ${installation})`, async (t) => {
  const port = await availablePort();
  const token = "sidecar-agent-profile-health-test-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-sidecar-profile-"));
  const entry = import.meta.url.endsWith(".ts")
    ? ["--import", "tsx", path.join(process.cwd(), "src", "index.ts")]
    : [path.join(process.cwd(), "dist", "src", "index.js")];
  const child = spawn(process.execPath, entry, {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_TOKEN: token,
      OPERATOR_AUTH_MODE: "shared_token",
      OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0",
      OPERATOR_BRAIN: "codex",
      OPERATOR_API_BASE_URL: `http://127.0.0.1:${port}`,
      OPERATOR_ASSIGNMENT_KERNEL_V2: "1",
      OPERATOR_LOCAL_EXECUTOR_PROFILE: installation ? "codex_v2_advisory_v1" : "",
      OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS: "",
      OPERATOR_OPENAI_API_KEY: "",
      OPENAI_API_KEY: "",
      REVIT_OPERATOR_MODE: "development",
      OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
      OPERATOR_HOSTED_ENABLED: "0"
    },
    stdio: "ignore"
  });
  t.after(async () => {
    await stop(child);
    // Node 20's synchronous removal does not retry an initial directory EBUSY.
    // Await asynchronous removal using the same bounded retry allowance.
    const owned = path.resolve(workspace);
    assert.equal(path.dirname(owned), path.resolve(os.tmpdir()));
    assert.ok(path.basename(owned).startsWith("revit-operator-sidecar-profile-"));
    await fs.promises.rm(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  const expectedExecutor = installation ? { schema: "revit-operator.local-executor-capability/v1", source: "backend_configuration",
    profile: "codex_v2_advisory_v1", executor: "codex", assignment_kernel: 2, execution_policy: "local_advisory_v1" } : null;
  assert.deepEqual(desktopConfig.local_executor, expectedExecutor);
  assert.equal(desktopConfig.available, false, "API-key computer availability does not confer executor selection");
  const forged = await fetchJson(`http://127.0.0.1:${port}/desktop/computer/config?OPERATOR_LOCAL_EXECUTOR_PROFILE=codex_v2_advisory_v1&local_executor=codex`, token);
  assert.deepEqual(forged.local_executor, expectedExecutor, "request fields cannot choose the installation profile");
  assert.equal((await fetch(`http://127.0.0.1:${port}/desktop/computer/config`)).status, 401);
});
