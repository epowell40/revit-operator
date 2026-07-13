import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { renderClaudeAddCommand, renderClaudeMcpConfig, renderCodexMcpConfig } from "./externalAgentConfig.js";

const options = {
  serverEntryPath: path.resolve("apps/mcp-server/dist/server.js"),
  workspaceRoot: path.resolve("tmp/operator workspace")
};

test("renders one canonical Codex stdio MCP server", () => {
  const config = renderCodexMcpConfig(options);
  assert.match(config, /\[mcp_servers\.revit_operator\]/);
  assert.equal((config.match(/\[mcp_servers\./g) ?? []).length, 1);
  assert.match(config, /command = "node"/);
  assert.match(config, /OPERATOR_WORKSPACE_ROOT/);
  assert.match(config, new RegExp(`cwd = ${JSON.stringify(path.dirname(path.dirname(options.serverEntryPath))).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(config, /cwd = .*dist/);
  assert.match(config, /tool_timeout_sec = 240/);
  assert.match(config, /required = true/);
});

test("renders Claude project JSON and a correctly separated stdio CLI command", () => {
  const parsed = JSON.parse(renderClaudeMcpConfig(options));
  const server = parsed.mcpServers["revit-operator"];
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, [options.serverEntryPath]);
  assert.equal(server.env.OPERATOR_WORKSPACE_ROOT, options.workspaceRoot);

  const command = renderClaudeAddCommand(options, "user");
  assert.match(command, /^claude mcp add --env /);
  assert.match(command, /--transport stdio --scope user revit-operator -- node /);
});
