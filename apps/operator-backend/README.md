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
