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
  const bridgeRequests: Array<{ method: string; path: string; token: string; grant: string }> = [];
  const bridge = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = String(req.headers["x-operator-token"] ?? "");
    const grant = String(req.headers["x-operator-write-grant"] ?? "");
    bridgeRequests.push({ method: req.method ?? "", path: requestUrl.pathname, token, grant });
    res.setHeader("Content-Type", "application/json");
    if (token !== "mcp-stdio-smoke-token") {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "bad token" }));
      return;
    }
    if (requestUrl.pathname === "/revit/ping") {
      res.end(JSON.stringify({ status: "ok", source: "stdio-smoke" }));
      return;
    }
    if (requestUrl.pathname === "/revit/tool-registry") {
      res.end(JSON.stringify({
        version: "operator.tool_registry.v1",
        tools: [
          { method: "GET", path: "/revit/context", group: "Core", risk: "low", title: "Context", description: "Current context" },
          { method: "POST", path: "/revit/test-write", group: "Test", risk: "medium", title: "Test Write", description: "Smoke write" }
        ]
      }));
      return;
    }
    if (requestUrl.pathname === "/revit/context") {
      res.end(JSON.stringify({ document: "Snowdon", view: "L4 - Power" }));
      return;
    }
    if (requestUrl.pathname === "/revit/test-write") {
      if (grant !== "grant-token") {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "missing grant" }));
        return;
      }
      res.end(JSON.stringify({ applied: true, source: "stdio-smoke" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  const bridgePort = await listen(bridge);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-mcp-stdio-"));
  fs.writeFileSync(path.join(workspace, "write_grant.json"), JSON.stringify({
    token: "grant-token",
    expires_at_utc: new Date(Date.now() + 60_000).toISOString()
  }), "utf8");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "dist", "server.js")],
    cwd: process.cwd(),
    env: {
      ...env,
      OPERATOR_API_BASE_URL: `http://127.0.0.1:${backendPort}`,
      REVIT_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
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
      await closeServer(bridge);
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

  const ping = await withTimeout(client.callTool({ name: "revit_ping", arguments: {} }), "calling Revit ping over stdio");
  assert.match((ping as any).content[0].text, /stdio-smoke/);

  const search = await withTimeout(client.callTool({
    name: "revit_search_tools",
    arguments: { query: "context", method: "GET" }
  }), "searching bridge tools over stdio");
  assert.match((search as any).content[0].text, /\/revit\/context/);

  const context = await withTimeout(client.callTool({
    name: "revit_call_tool",
    arguments: { method: "GET", path: "/revit/context", requireKnownPath: true }
  }), "calling a generic bridge read over stdio");
  assert.match((context as any).content[0].text, /L4 - Power/);

  const write = await withTimeout(client.callTool({
    name: "revit_call_tool",
    arguments: { method: "POST", path: "/revit/test-write", body: { apply: true }, requireKnownPath: true }
  }), "calling a grant-backed generic bridge write over stdio");
  assert.match((write as any).content[0].text, /"applied": true/);
  assert.equal(bridgeRequests.every(request => request.token === "mcp-stdio-smoke-token"), true);
  assert.equal(bridgeRequests.some(request => request.path === "/revit/test-write" && request.grant === "grant-token"), true);

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
