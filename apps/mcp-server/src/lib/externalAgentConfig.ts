import path from "node:path";

export type ExternalAgentConfigOptions = {
  serverEntryPath: string;
  workspaceRoot: string;
};

function tomlString(value: string): string {
  return JSON.stringify(path.normalize(value));
}

function serverWorkingDirectory(serverEntryPath: string): string {
  const entryDirectory = path.dirname(serverEntryPath);
  return path.basename(entryDirectory).toLowerCase() === "dist"
    ? path.dirname(entryDirectory)
    : entryDirectory;
}

export function renderCodexMcpConfig(options: ExternalAgentConfigOptions): string {
  const serverEntryPath = path.resolve(options.serverEntryPath);
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const serverCwd = serverWorkingDirectory(serverEntryPath);
  return [
    "[mcp_servers.revit_operator]",
    'command = "node"',
    `args = [${tomlString(serverEntryPath)}]`,
    `cwd = ${tomlString(serverCwd)}`,
    `env = { OPERATOR_WORKSPACE_ROOT = ${tomlString(workspaceRoot)} }`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 240",
    "required = true",
    ""
  ].join("\n");
}

export function renderClaudeMcpConfig(options: ExternalAgentConfigOptions): string {
  const serverEntryPath = path.resolve(options.serverEntryPath);
  const workspaceRoot = path.resolve(options.workspaceRoot);
  return JSON.stringify({
    mcpServers: {
      "revit-operator": {
        type: "stdio",
        command: "node",
        args: [serverEntryPath],
        env: {
          OPERATOR_WORKSPACE_ROOT: workspaceRoot
        }
      }
    }
  }, null, 2) + "\n";
}

export function renderClaudeAddCommand(options: ExternalAgentConfigOptions, scope: "local" | "project" | "user" = "local"): string {
  const serverEntryPath = path.resolve(options.serverEntryPath);
  const workspaceRoot = path.resolve(options.workspaceRoot);
  return [
    "claude mcp add",
    `--env ${quotePowerShellArg(`OPERATOR_WORKSPACE_ROOT=${workspaceRoot}`)}`,
    "--transport stdio",
    `--scope ${scope}`,
    "revit-operator",
    "-- node",
    quotePowerShellArg(serverEntryPath)
  ].join(" ");
}

function quotePowerShellArg(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}
