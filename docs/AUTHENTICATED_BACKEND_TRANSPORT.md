# Authenticated internal backend transport

## Contract

MCP tools that call Operator backend endpoints use
`revit-operator.operator-backend-auth/v1`. The discriminated mode is known
before dispatch:

- `shared_token` emits only `X-Operator-Token`.
- `principal_jwt` emits only `Authorization: Bearer`.

The generic schema is `contracts/operator_backend_auth.v1.schema.json`.
Credentials are request/turn capabilities, not model inputs or durable
evidence. The envelope binds the selected mode and exact allowed backend
origin.

## Hosted handoff

The outer HTTP authentication gateway validates the caller first. For an
executable Codex/Revit turn, the backend opens a bounded auth lease before
provider call 1. The dynamic MCP adapter sends the credential to its trusted
stdio child only in MCP request metadata. The MCP registration boundary binds
that metadata to the current handler through process-local async context; tool
arguments never contain it.

The lease is bound to the exact session and Codex turn and removed at turn
cleanup. Cached MCP processes do not receive a static Bearer in their process
environment.

## Fail-closed behavior

- Missing auth blocks an executable turn before inference.
- Conflicting credential forms are rejected before fetch.
- A credential is never forwarded to a different origin.
- Principal credentials require TLS except for an exactly fenced loopback
  origin.
- A 401 is terminal for that request. The client does not retry, switch modes,
  or downgrade to a shared token.
- Backend routes still revalidate principal, session, Assignment,
  run/generation, and evidence ownership. Transport authentication does not
  bypass canonical authorization.

## Secret handling

Credential values must not be included in model context, tool arguments,
audit records, EvidenceRefs, Work Packets, benchmark artifacts, or error text.
The backend client redacts credential-like response details defensively. Hosted
credential acquisition and refresh remain private composition concerns.
