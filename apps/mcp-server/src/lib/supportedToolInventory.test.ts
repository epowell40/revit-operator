import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SUPPORTED_MCP_ALIASES, isSupportedNativeTool } from "./supportedToolInventory.js";
import { filterRegistryEntriesForSearch, isKnownToolExposureRoute, isToolRouteExposedForSearch } from "./toolExposurePolicy.js";

const nativeSource = fs.readFileSync(path.resolve(process.cwd(), "../revit-bridge-addin/RevitBridge/Operator/OperatorToolManifest.cs"), "utf8");
const implemented = [...nativeSource.matchAll(/new OperatorToolInfo\("[^"\r\n]+",\s*"(GET|POST)",\s*"([^"]+)"/g)]
  .map(match => ({ method: match[1]!, path: match[2]! }));
const excluded = implemented.filter(route => !isSupportedNativeTool(route.method, route.path));

test("fixed supported inventory narrows search before all laboratory and hosted overrides", () => {
  assert.equal(implemented.length, 216);
  assert.equal(excluded.length, 114);
  for (const mode of ["development", "hosted", "production"]) {
    const env = { REVIT_OPERATOR_MODE: mode, OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" };
    assert.equal(filterRegistryEntriesForSearch(implemented, env).length, 102);
    for (const route of excluded) {
      assert.equal(isKnownToolExposureRoute(route.method, route.path, env), false);
      assert.equal(isToolRouteExposedForSearch(route.method, route.path, env), false);
    }
  }
});

test("actual MCP list generic call and tool documentation cannot expose or dispatch excluded routes", async () => {
  let requests = 0;
  const backend = http.createServer((_request, response) => { requests++; response.statusCode = 500; response.end("Unexpected excluded request"); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "supported-inventory-stdio-"));
  try {
    for (const mode of ["development", "hosted"]) {
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), "dist/server.js")], cwd: process.cwd(), stderr: "pipe",
        env: { ...process.env, REVIT_OPERATOR_MODE: mode, OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
          OPERATOR_TOKEN: "test-only", OPERATOR_OPENAI_API_KEY: "test-only", OPERATOR_AUTH_MODE: "shared_token",
          OPERATOR_WORKSPACE_ROOT: workspace, OPERATOR_API_BASE_URL: `http://127.0.0.1:${address.port}`, REVIT_BRIDGE_URL: `http://127.0.0.1:${address.port}` } });
      transport.stderr?.on("data", () => {});
      const client = new Client({ name: "supported-inventory-boundary", version: "1.0.0" }, { capabilities: {} });
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...SUPPORTED_MCP_ALIASES].sort());
        for (const route of excluded.filter(route => route.path.startsWith("/revit/"))) {
          const denied = await client.callTool({ name: "revit_call_tool", arguments: { ...route, body: {}, requireKnownPath: false },
            _meta: { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" } });
          assert.equal(denied.isError, true, route.path);
          assert.match(JSON.stringify(denied.content), /outside the supported product inventory/i);
          for (const name of ["revit_tool_doc", "revit_tool_examples"]) {
            const doc = await client.callTool({ name, arguments: route });
            assert.equal(doc.isError, true, `${name} leaked ${route.path}`);
          }
        }
        for (const path of ["/revit/not-a-real-tool", "/revit/dynamic-runtime/bootstrap"]) {
          const denied = await client.callTool({ name: "revit_call_tool", arguments: { method: "POST", path, requireKnownPath: false } });
          assert.equal(denied.isError, true);
        }
        const probe = await client.callTool({ name: "operator_runtime_probe", arguments: {} });
        assert.notEqual(probe.isError, true);
        assert.equal(requests, 0, "Excluded calls and introspection must stop before any backend or native network request.");
      } finally { await client.close(); await transport.close(); }
    }
  } finally {
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
    // Exact temporary folder created by this test; no caller-controlled deletion path.
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
