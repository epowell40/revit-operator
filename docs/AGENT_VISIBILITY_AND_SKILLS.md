# Agent Visibility and Skills

This explains what "skills" and files each runtime can actually see in the public-core layout.

## 1) Codex coding agent

The coding agent receives files in the current checkout, repository instructions such as `AGENTS.md`, and installed Codex skills from the local Codex home.

Folders such as `prompts/` and `skills/` are repository content. They are not automatically installed Codex skills, but they are loaded by the Operator backend as described below.

## 2) Operator backend brain

When `apps/operator-backend` uses the Codex or OpenAI brain, it injects the manifest-defined skill-library bundle through:

- `apps/operator-backend/src/skills/skill_library.ts`
- `skills/skill_library_manifest.json`

Current injected sources include:

- manifest-defined public docs under `prompts/**`, `skills/**`, and selected `docs/**`;
- local skill docs from `OPERATOR_LOCAL_SKILLS_DIR`, `skills/local/`, or `%LOCALAPPDATA%\RevitOperator\Skills\`;
- workspace macro skills under `%LOCALAPPDATA%\RevitOperator\Workspace\skills\`.

Machine-local and user-private skills should remain outside versioned public content.

## 3) MCP tool visibility

Codex app-server MCP registration is managed by:

- `apps/operator-backend/src/codex/config.ts`

The public MCP server entrypoint is:

- `apps/mcp-server/dist/server.js`

This stdio server is also the supported external-harness boundary for Codex, Claude Code, and other MCP hosts. It exposes live tool discovery plus generic and typed Revit calls without requiring the Operator pane. See `docs/EXTERNAL_AGENT_HARNESS.md` for configuration, diagnostics, and bounded write approval.

## Quick checks

```powershell
git status -sb
git ls-files | Select-String "node_modules|/dist/"
Get-Content -Raw apps/operator-backend/src/skills/skill_library.ts
Get-Content -Raw skills/skill_library_manifest.json
```
