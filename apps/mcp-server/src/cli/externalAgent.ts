import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { renderClaudeAddCommand, renderClaudeMcpConfig, renderCodexMcpConfig } from "../lib/externalAgentConfig.js";
import { createExternalWriteGrant, type ExternalWriteGrantMode, writeExternalWriteGrant } from "../lib/externalWriteGrant.js";
import { getOperatorToken, getWorkspaceRoot } from "../lib/workspace.js";

type ParsedArgs = Record<string, string | boolean | string[]> & { _: string[] };

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i] ?? "";
    if (!item.startsWith("--")) {
      out._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function serverEntryPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
}

function configOptions() {
  return { serverEntryPath: serverEntryPath(), workspaceRoot: getWorkspaceRoot() };
}

function serverWorkingDirectory(entry: string): string {
  const entryDirectory = path.dirname(entry);
  return path.basename(entryDirectory).toLowerCase() === "dist"
    ? path.dirname(entryDirectory)
    : entryDirectory;
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray((result as any).content)) return "";
  return (result as any).content.map((item: any) => typeof item?.text === "string" ? item.text : "").filter(Boolean).join("\n");
}

async function smoke(): Promise<void> {
  const entry = serverEntryPath();
  if (!fs.existsSync(entry)) throw new Error(`MCP server is not built: ${entry}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: serverWorkingDirectory(entry),
    env: {
      ...inheritedEnvironment(),
      OPERATOR_WORKSPACE_ROOT: getWorkspaceRoot()
    },
    stderr: "pipe"
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "revit-operator-external-agent-smoke", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const ping = await client.callTool({ name: "revit_ping", arguments: {} });
    const search = await client.callTool({
      name: "revit_search_tools",
      arguments: { query: "current Revit context", method: "GET", limit: 5 }
    });
    const context = await client.callTool({
      name: "revit_call_tool",
      arguments: { method: "GET", path: "/revit/context", requireKnownPath: true }
    });
    const writeGrantStatus = await client.callTool({ name: "revit_write_grant_status", arguments: {} });
    const report = {
      ready: true,
      transport: "stdio",
      childProcess: entry,
      toolCount: tools.tools.length,
      requiredToolsPresent: ["revit_ping", "revit_search_tools", "revit_call_tool", "revit_write_grant_status"]
        .every(name => tools.tools.some(tool => tool.name === name)),
      bridgePing: resultText(ping),
      registrySearch: resultText(search),
      revitContext: resultText(context),
      writeGrantStatus: resultText(writeGrantStatus)
    };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.requiredToolsPresent) process.exitCode = 1;
  } catch (error) {
    const details = stderr.join("").trim();
    throw new Error(`${String(error)}${details ? `\nMCP child stderr:\n${details}` : ""}`);
  } finally {
    try {
      await client.close();
    } catch {
      await transport.close();
    }
  }
}

async function doctor(): Promise<void> {
  const entry = serverEntryPath();
  const workspaceRoot = getWorkspaceRoot();
  const operatorToken = getOperatorToken();
  const bridgeUrl = (process.env.REVIT_BRIDGE_URL || "http://localhost:5000").replace(/\/+$/, "");
  let ping: unknown = null;
  let writeGrantStatus: unknown = null;
  let bridgeError = "";
  if (operatorToken) {
    try {
      const headers = { "X-Operator-Token": operatorToken };
      const pingResponse = await fetch(`${bridgeUrl}/revit/ping`, { headers });
      if (!pingResponse.ok) {
        const details = (await pingResponse.text()).trim();
        throw new Error(`ping returned HTTP ${pingResponse.status}${details ? `: ${details}` : ""}`);
      }
      ping = await pingResponse.json();
      const grantResponse = await fetch(`${bridgeUrl}/revit/write-grant-status`, { headers });
      if (grantResponse.ok) writeGrantStatus = await grantResponse.json();
    } catch (error) {
      bridgeError = String(error);
    }
  }
  const report = {
    ready: fs.existsSync(entry) && !!operatorToken && !!ping && !bridgeError,
    node: process.version,
    mcpServerEntry: entry,
    mcpServerBuilt: fs.existsSync(entry),
    workspaceRoot,
    operatorTokenPresent: !!operatorToken,
    bridgeUrl,
    bridgePing: ping,
    writeGrantStatus,
    bridgeError: bridgeError || null
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (!report.ready) process.exitCode = 1;
}

function printHelp(): void {
  process.stdout.write([
    "Revit Operator external-agent helper",
    "",
    "  config --host codex|claude|all [--claude-scope local|project|user]",
    "  doctor",
    "  smoke",
    "  grant --mode once|session --acknowledge-writes [--ttl-minutes N]",
    "",
    "The grant command intentionally does not expose YOLO mode."
  ].join("\n") + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command === "smoke") {
    await smoke();
    return;
  }
  if (command === "config") {
    const host = String(args.host ?? "all").toLowerCase();
    const options = configOptions();
    if (host === "codex" || host === "all") {
      process.stdout.write("# Codex config.toml\n" + renderCodexMcpConfig(options));
    }
    if (host === "claude" || host === "all") {
      const scope = String(args["claude-scope"] ?? "local") as "local" | "project" | "user";
      if (!(["local", "project", "user"] as string[]).includes(scope)) throw new Error("--claude-scope must be local, project, or user.");
      process.stdout.write("# Claude Code CLI (PowerShell)\n" + renderClaudeAddCommand(options, scope) + "\n\n");
      process.stdout.write("# Claude Code .mcp.json\n" + renderClaudeMcpConfig(options));
    }
    if (!(["codex", "claude", "all"] as string[]).includes(host)) throw new Error("--host must be codex, claude, or all.");
    return;
  }
  if (command === "grant") {
    if (args["acknowledge-writes"] !== true) {
      throw new Error("Refusing to issue a write grant without --acknowledge-writes.");
    }
    const mode = String(args.mode ?? "once").toLowerCase() as ExternalWriteGrantMode;
    const ttlRaw = args["ttl-minutes"];
    const ttlMinutes = typeof ttlRaw === "string" ? Number(ttlRaw) : undefined;
    const grant = createExternalWriteGrant({
      operatorToken: getOperatorToken(),
      mode,
      ttlMinutes
    });
    const grantPath = writeExternalWriteGrant(getWorkspaceRoot(), grant);
    process.stdout.write(JSON.stringify({
      issued: true,
      mode: grant.mode,
      expires_at_utc: grant.expires_at_utc,
      uses_remaining: grant.uses_remaining,
      grant_path: grantPath,
      note: "The grant token is intentionally omitted from output."
    }, null, 2) + "\n");
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  process.stderr.write(`External-agent helper failed: ${String(error)}\n`);
  process.exitCode = 1;
});
