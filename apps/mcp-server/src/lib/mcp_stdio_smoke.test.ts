import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 8_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out while ${label}.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine smoke-test backend port.");
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("MCP stdio server registers repaired tools and rejects semantic write controls before backend execution", async (t) => {
  let backendRequests = 0;
  const backend = http.createServer((_req, res) => {
    backendRequests += 1;
    res.statusCode = 500;
    res.end("unexpected backend request");
  });
  const backendPort = await listen(backend);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-mcp-stdio-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "dist", "server.js")],
    cwd: process.cwd(),
    env: {
      ...env,
      OPERATOR_API_BASE_URL: `http://127.0.0.1:${backendPort}`,
      OPERATOR_TOKEN: "mcp-stdio-smoke-token",
      OPERATOR_WORKSPACE_ROOT: workspace
    },
    stderr: "pipe"
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "revit-operator-stdio-smoke", version: "1.0.0" }, { capabilities: {} });

  t.after(async () => {
    try {
      await withTimeout(client.close(), "closing MCP client", 5_000);
    } finally {
      await withTimeout(transport.close(), "closing MCP child transport", 5_000);
      await closeServer(backend);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  try {
    await withTimeout(client.connect(transport), "initializing MCP stdio server");
  } catch (error) {
    throw new Error(`${String(error)}\nMCP stderr:\n${stderr.join("")}`);
  }

  const tools = await withTimeout(client.listTools(), "listing MCP tools");
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of [
    "operator_plan_semantic_mep_route",
    "fire_damper_audit",
    "validate_ies_files",
    "check_photometrics",
    "audit_lpd"
  ]) {
    assert.equal(names.has(name), true, `Missing MCP tool: ${name}`);
  }

  for (const writeControl of ["apply", "write"] as const) {
    const result = await withTimeout(client.callTool({
      name: "operator_plan_semantic_mep_route",
      arguments: { userText: "Extend piping from the main to that sink.", [writeControl]: true }
    }), `rejecting semantic ${writeControl} control`);
    assert.equal((result as any).isError, true, `${writeControl} must be rejected as an MCP InvalidParams input error.`);
    const text = (result as any).content.map((item: any) => item.text ?? "").join("\n");
    assert.match(text, /Input validation error: Invalid arguments for tool operator_plan_semantic_mep_route/i);
  }
  assert.equal(backendRequests, 0, "Invalid semantic planner controls must be rejected before any backend fetch.");
});
