# Revit Operator Backend

Public local/self-host backend for Revit Operator.

This package is the open-core backend used by the Revit add-in and MCP bridge. It includes local chat/session handling, Revit tool routing, native view/redline analysis, goal-mode support, benchmarks, artifacts, sample skills, and local/shared-token authentication.

Private hosted/commercial services are intentionally excluded from this public package. That includes BIMTools hosted admin consoles, production EC2 deployment wiring, customer analytics, billing/license gates, and hosted JWT auth.

## Local Setup

```powershell
cd apps/operator-backend
npm install
npm run build
npm test
```

Use the repository-level `.env.example` or this package's `.env.example` as a starting point for local configuration. Do not commit real `.env` files.

Default public-safe auth is shared-token mode:

```text
OPERATOR_AUTH_MODE=shared_token
OPERATOR_TOKEN=
```

If `OPERATOR_TOKEN` is not set, local scripts can generate a per-session token and share it with the add-in through the local workspace.

The provider-neutral `principal_jwt` contract is also available for a private or self-hosted identity adapter. It uses generic `OPERATOR_JWT_*` settings and `tenant_id` / `user_id` claims; provider-specific verification and hosted product policy remain outside this public package. In `hosted` runtime mode the full shell-capable workbench is always disabled. Outside hosted mode, principal auth may enable it only with an explicit `OPERATOR_WORKBENCH_ENABLED=true` opt-in.

## Primary Agent Providers

The local/self-host backend can use these primary planning brains:

- `OPERATOR_BRAIN=codex`
- `OPERATOR_BRAIN=openai`
- `OPERATOR_BRAIN=gemini`
- `OPERATOR_BRAIN=anthropic` (or the `claude` alias)
- `OPERATOR_BRAIN=rule`

Gemini example:

```dotenv
OPERATOR_BRAIN=gemini
OPERATOR_GEMINI_API_KEY=...
OPERATOR_GEMINI_AGENT_MODEL=gemini-3.5-flash
```

Claude Opus 4.8 example:

```dotenv
OPERATOR_BRAIN=anthropic
OPERATOR_ANTHROPIC_API_KEY=...
OPERATOR_ANTHROPIC_MODEL=claude-opus-4-8
OPERATOR_ANTHROPIC_EFFORT=xhigh
```

The Gemini and Anthropic brains use provider-native structured JSON output.
They receive the shared Operator instructions, bounded recent history, current
Revit context, compacted tool results, and bounded image attachments. They
return the next smallest Bridge action or tightly coupled action group; the
host executes it and supplies the result on the next turn.

## Redline And Spatial Tools

The public backend includes the generic redline/native placement improvements:

- visual redline analysis and view alignment helpers
- goal-mode routing for uncertain/spatial tasks
- room/wall/exemplar routing for hosted device placement
- post-write verification and focused capture expectations
- readiness and session-audit benchmark commands

These are generic Revit API workflows and are usable by the native add-in and by sidecar agents that call the same backend/Revit bridge endpoints.

## Private Overlay

The private BIMTools overlay may add hosted deployment, admin analytics, customer-scoped auth, EC2 runbooks, private skills, and website/download packaging. Keep those changes in `revit-operator-private`.
