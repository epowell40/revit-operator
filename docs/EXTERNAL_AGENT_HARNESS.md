# External Agent Harness

Revit Operator can expose its public Revit bridge and tool registry to Codex, Claude Code, or any other MCP-compatible local agent without opening or using the Operator pane.

The external harness still requires:

- Revit running with the Revit Operator add-in loaded;
- Node.js 20 or later;
- the public MCP server built locally;
- the same machine-local Revit Operator workspace used by the add-in.

The Operator UI and its chat/agent loop are optional. The Revit add-in is not optional because it owns the in-process Revit API execution context.

## Build and diagnose

From the public repository root:

```powershell
npm --prefix apps/mcp-server install
npm --prefix apps/mcp-server run build
npm --prefix apps/mcp-server run external-agent -- doctor
npm --prefix apps/mcp-server run external-agent -- smoke
```

`doctor` checks the built stdio entrypoint, shared workspace token, live bridge ping, and current write-grant state. It does not modify the model.

`smoke` launches the built MCP server as a separate stdio child process, discovers its tools, and performs live read-only ping, registry-search, context, and write-grant-status calls. This verifies the same transport boundary an external agent host uses; it also does not modify the model.

## Generate host configuration

Print machine-correct Codex and Claude Code snippets with absolute paths:

```powershell
npm --prefix apps/mcp-server run external-agent -- config --host all
```

Use `--host codex` or `--host claude` for one host. The helper prints configuration; it does not edit user-level agent files.

### Codex

Add the generated `[mcp_servers.revit_operator]` block to `~/.codex/config.toml` or a trusted project `.codex/config.toml`, then start a new Codex task. The generated block uses one canonical server registration, stdio transport, the built `dist/server.js`, the shared workspace, and a four-minute Revit tool timeout.

Codex's current MCP configuration reference documents `command`, `args`, `cwd`, and `env` for stdio servers: <https://learn.chatgpt.com/docs/extend/mcp#configure-with-configtoml>.

### Claude Code

The helper prints both a PowerShell-safe `claude mcp add` command and a `.mcp.json` entry. For example, the generated command follows this shape:

```powershell
claude mcp add --env 'OPERATOR_WORKSPACE_ROOT=C:\path\to\Workspace' --transport stdio --scope local revit-operator -- node 'C:\path\to\apps\mcp-server\dist\server.js'
```

Claude Code requires `--` before the stdio command and supports local, project, and user scopes: <https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server>.

## Use the tools

The external agent can begin with:

- `revit_ping` and `revit_get_context` for connection/context;
- `revit_search_tools` to search the live Revit tool registry;
- `revit_call_tool` to call any known `/revit/*` primitive by method and path;
- typed tools such as `operator_plan_semantic_mep_route` where a bounded semantic planner exists.

Ask the host agent to search before guessing endpoint names. For a generic call, prefer `requireKnownPath: true` so a stale or invented path fails closed.

## Pane-free write approval

Read-only tools work without the Operator pane. Medium/high-risk bridge writes still require an explicit, short-lived write grant in addition to the shared Operator token.

Issue one deliberate write approval from a terminal:

```powershell
# One medium/high-risk request, valid for at most 10 minutes
npm --prefix apps/mcp-server run external-agent -- grant --mode once --acknowledge-writes

# Multiple requests in a bounded work session, valid for at most 15 minutes
npm --prefix apps/mcp-server run external-agent -- grant --mode session --acknowledge-writes
```

The helper intentionally:

- requires the explicit `--acknowledge-writes` flag;
- supports only `once` and `session` modes;
- caps grant lifetime at 10 or 15 minutes;
- does not expose YOLO mode;
- omits the secret grant token from terminal output.

The add-in validates and, for `once`, consumes the same signed workspace grant used by the Operator pane. This is a local consent barrier against accidental writes, not a remote security boundary. Keep the bridge on loopback, protect the workspace, and do not share `operator_token.txt` or `write_grant.json`.

## Architecture boundary

```text
Codex / Claude Code / other MCP host
                |
                | stdio MCP
                v
apps/mcp-server/dist/server.js
                |
                | authenticated loopback HTTP
                v
Revit Operator add-in bridge in Revit
                |
                v
Revit API + active model
```

The Operator backend is not required for generic bridge discovery and calls. It is required for tools that intentionally route through backend semantic planners, such as the semantic MEP planner. Hosted/commercial services are not required for local use.

## Verification

The MCP test suite starts the built server as a real child stdio process and verifies:

- tool discovery;
- authenticated bridge ping;
- registry search;
- generic read execution;
- grant-backed generic write execution;
- rejection of unsupported semantic write controls before backend execution.

Run it with:

```powershell
npm --prefix apps/mcp-server test
```
