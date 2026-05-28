# Troubleshooting (Revit Operator)

## When do I need to restart what?

- **Changed backend / MCP code (Node/TS)**: restart the backend (no Revit restart needed).
  - `./start_operator_backend.ps1 -Restart`
- **Changed the Revit add-in (C# DLLs)**: you must restart Revit (Revit locks the loaded DLLs).
- **Changed both**: restart backend, then restart Revit.

## Common errors

### “Transport closed”
This usually means the **Codex app-server ⇄ MCP tool transport** dropped (the MCP server process exited or the connection was reset).

Try (in order):
1) Restart the backend: `./start_operator_backend.ps1 -Restart`
2) If you just rebuilt add-in DLLs, restart Revit.
3) Sanity-check the Revit bridge is alive:
   - `Invoke-RestMethod http://localhost:5000/revit/ping`
3) Check logs under `%LOCALAPPDATA%\\RevitOperator\\Workspace\\logs\\`:
   - `operator-backend-audit.jsonl`
   - `mcp-server-audit.jsonl`

### 401 Unauthorized: “Missing bearer or basic authentication in header … /v1/responses”
Codex/OpenAI auth is missing for the process that’s making requests.

1) Run `codex login`
2) Restart the backend: `./start_operator_backend.ps1 -Restart`

Notes:
- The backend runs Codex with `CODEX_HOME=%LOCALAPPDATA%\\RevitOperator\\Workspace\\.codex`.
- On startup it copies `%USERPROFILE%\\.codex\\auth.json` into that folder if needed.
- Recommended config: set `OPERATOR_BRAIN=auto` so the backend prefers Codex auth when present, but can fall back to `OPENAI_API_KEY` if you set it.

### 428 Setup Required: “No model credentials detected …”
The backend auth bootstrap gate is on and no model credentials are configured yet.

1) Run `codex login` and restart backend, **or**
2) Set `OPENAI_API_KEY` (for example in `operator-backend/.env.local`) and restart backend

Optional override (dev/offline only): set `OPERATOR_REQUIRE_AUTH_BOOTSTRAP=0`.

### 403 “Write requires approval (missing/invalid X‑Operator‑Write‑Grant)”
Writes are blocked unless the Operator pane mints a short-lived write grant.

1) In Revit → Operator pane → **Writes** → pick **Allow this session** or **YOLO**
2) Retry the action

Notes:
- The token is stored at `%LOCALAPPDATA%\\RevitOperator\\Workspace\\write_grant.json` and expires.

## Finding exported files

Exports are written under the Workspace:
- Workspace root: `%LOCALAPPDATA%\\RevitOperator\\Workspace\\`
- Prints: `artifacts\\prints\\`

In the Operator pane you can click:
- `[Open prints folder](op://open-folder?path=artifacts/prints)`
