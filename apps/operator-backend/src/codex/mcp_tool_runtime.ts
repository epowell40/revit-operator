import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { operatorBackendAuthRequestMeta, type OperatorBackendAuthV1 } from "../operator_backend_auth.js";
import { OperatorBackendAuthLeaseRegistry, type OperatorBackendAuthLease } from "./operator_backend_auth_lease.js";

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function toolTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.OPERATOR_MCP_TOOL_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(parsed)) return 240_000;
  return Math.max(1_000, Math.min(30 * 60_000, parsed));
}

export function resolveOperatorMcpServerSpec(backendCwd: string): { serverJs: string; cwd: string } {
  const candidates = [
    path.resolve(backendCwd, "..", "mcp-server", "dist", "server.js"),
    path.resolve(backendCwd, "..", "apps", "mcp-server", "dist", "server.js")
  ];
  const serverJs = candidates.find(candidate => fs.existsSync(candidate));
  if (!serverJs) throw new Error(`Could not locate the Revit Operator MCP server. Checked: ${candidates.join(", ")}`);
  return { serverJs, cwd: path.dirname(path.dirname(serverJs)) };
}

export const EAGER_OPERATOR_MCP_TOOLS = new Set([
  "operator_runtime_probe",
  "operator_discover_capabilities",
  "operator_record_execution_strategy",
  "operator_request_clarification",
  "operator_submit_noop_completion",
  "operator_submit_read_completion",
  "revit_ping",
  "revit_get_context",
  "revit_open_model",
  "revit_list_sheets",
  "revit_list_schedules",
  "revit_update_schedule_cell",
  "revit_replace_schedule_values",
  "revit_set_parameters",
  "revit_write_grant_status",
  "revit_search_tools",
  "revit_tool_registry",
  "revit_tool_doc",
  "revit_tool_examples",
  "revit_call_tool"
]);

export class CodexMcpToolRuntime {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private starting: Promise<void> | null = null;
  private stderrTail = "";
  private dynamicNamespace: unknown | null = null;
  private readonly backendAuthLeases = new OperatorBackendAuthLeaseRegistry();

  constructor(private readonly opts: {
    backendCwd: string;
    workspaceRoot: string;
    codexHome: string;
    spawnEnv: NodeJS.ProcessEnv;
  }) {}

  private async ensureStarted(): Promise<void> {
    if (this.client) return;
    if (this.starting) return await this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<void> {
    const spec = resolveOperatorMcpServerSpec(this.opts.backendCwd);
    const env = stringEnvironment({
      ...this.opts.spawnEnv,
      OPERATOR_WORKSPACE_ROOT: this.opts.workspaceRoot,
      CODEX_HOME: this.opts.codexHome
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [spec.serverJs],
      cwd: spec.cwd,
      env,
      stderr: "pipe"
    });
    transport.stderr?.on("data", chunk => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-16_384);
    });
    const client = new Client({ name: "revit-operator-backend-mcp-adapter", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      this.transport = transport;
      this.client = client;
    } catch (error) {
      try { await transport.close(); } catch {}
      const detail = this.stderrTail.trim();
      throw new Error(`Could not start the Revit Operator MCP runtime.${detail ? ` stderr: ${detail}` : ""}`, { cause: error });
    }
  }

  beginBackendAuthLease(sessionId: string, auth: OperatorBackendAuthV1): OperatorBackendAuthLease {
    return this.backendAuthLeases.begin(sessionId, auth);
  }

  bindBackendAuthLeaseTurn(lease: OperatorBackendAuthLease, turnId: string): void {
    this.backendAuthLeases.bindTurn(lease, turnId);
  }

  endBackendAuthLease(lease: OperatorBackendAuthLease | null): void {
    this.backendAuthLeases.end(lease);
  }

  async callTool(tool: string, args: unknown, binding?: { turnId?: unknown; sessionId?: unknown }): Promise<any> {
    await this.ensureStarted();
    const client = this.client;
    if (!client) throw new Error("Revit Operator MCP runtime is not connected.");
    const timeout = toolTimeoutMs(this.opts.spawnEnv);
    try {
      const auth = this.backendAuthLeases.resolve(binding?.turnId, binding?.sessionId);
      return await client.callTool(
        {
          name: tool,
          arguments: args && typeof args === "object" ? args as Record<string, unknown> : {},
          _meta: operatorBackendAuthRequestMeta(auth)
        },
        undefined,
        { timeout, maxTotalTimeout: timeout }
      );
    } catch (error) {
      throw new Error(
        `[operator_mcp_tool_error] ${tool} failed and was not automatically replayed because its outcome may be unknown: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  async getDynamicToolNamespace(): Promise<any> {
    if (this.dynamicNamespace) return this.dynamicNamespace;
    await this.ensureStarted();
    const client = this.client;
    if (!client) throw new Error("Revit Operator MCP runtime is not connected.");
    const timeout = toolTimeoutMs(this.opts.spawnEnv);
    const listed = await client.listTools(undefined, { timeout, maxTotalTimeout: timeout });
    this.dynamicNamespace = {
      type: "namespace",
      name: "revit_operator",
      description: "Revit Operator MCP tools. Start with concise semantic capability/substrate discovery when the representation is unclear; inspect exact typed contracts only after choosing a path. Discovery and strategy telemetry never authorize execution.",
      tools: listed.tools.map(tool => ({
        type: "function",
        name: tool.name,
        description: tool.description ?? "Revit Operator tool",
        inputSchema: tool.inputSchema,
        deferLoading: !EAGER_OPERATOR_MCP_TOOLS.has(tool.name)
      }))
    };
    return this.dynamicNamespace;
  }

  stop(): void {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.dynamicNamespace = null;
    this.backendAuthLeases.clear();
    void (async () => {
      try { await client?.close(); } catch {}
      try { await transport?.close(); } catch {}
    })();
  }
}

export type { OperatorBackendAuthLease } from "./operator_backend_auth_lease.js";
