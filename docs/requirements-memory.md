# Durable requirements memory

Revit Operator keeps durable engineering requirements separately from its free-form daily and long-term recall notes. The v1 ledger is append-only and lives at:

`%LOCALAPPDATA%\RevitOperator\Workspace\memory\requirements.v1.jsonl`

In hosted mode, the workspace is isolated by tenant/license and user before the ledger is opened. V1 scope labels are therefore namespaces inside one user's isolated workspace; they are not yet a shared office or client library across multiple users.

## Scope and precedence

Every record has one exact scope:

- `engineer` — an individual preference.
- `office` — an office standard.
- `client` — a client requirement.
- `project` — a project-specific requirement.

For the same requirement key, precedence is `project > client > office > engineer`. Equal-precedence records with different text are a blocking conflict; the planner does not use “latest wins.” Retired, future, expired, and explicitly superseded revisions do not apply.

Each create, revision, and retirement appends a full revision with a stable requirement ID, monotonic revision, effective dates, provenance, evidence references, and supersession links. Revisions require the exact current revision number.

## Operator commands

Examples:

```text
remember engineer preference tags.leaders: Keep leaders short and uncrossed.
remember project requirement equipment.clearance: Show power-side service clearances.
remember requirement office bimtools tags.case: Use ALL CAPS.
remember requirement client hospital-a rooms.naming: Preserve the client room naming standard.
show requirements
explain requirements tags leaders
```

The project command derives a stable project scope from the active Revit document path (or title when the model has no path). Office/client generic commands require an explicit scope ID.

## HTTP API

All `/memory/*` routes require authentication, including the legacy project-profile routes.

- `GET /memory/requirements`
- `POST /memory/requirements`
- `POST /memory/requirements/revise`
- `POST /memory/requirements/retire`
- `POST /memory/requirements/resolve`

`resolve` returns a deterministic receipt containing exact applied and suppressed IDs/revisions, conflicts, scope references, and a SHA-256 receipt hash. A conflict, receipt overflow, unreadable ledger, or changed receipt blocks the integrated Level power-plan workflow before further Revit actions.

## Compatibility boundary

The existing `project_profile.json`, `remember project standard`, and free-form JSONL recall remain supported. They are not automatically rewritten or deleted. New durable requirements are not mirrored into generic memory, avoiding a second stale source of truth.
