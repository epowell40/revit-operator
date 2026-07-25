# Tool contract memory and quarantine

Revit Operator keeps schema repair and unsafe-tool control in the backend harness rather than the Revit DLL. This lets local and self-hosted installations improve tool selection without restarting Revit or deleting any registered handler.

## Failed-then-successful contract memory

Every hosted Codex/MCP tool failure receives one compact receipt with:

- exact tool or Revit method/path identity;
- one operational classification: `contract`, `routing`, `scheduler`, `revit_context`, `unsupported_api`, `implementation_defect`, `environment_dependency`, or `unknown`;
- bounded, shape-only arguments;
- session/thread/turn correlation and timestamp;
- a bounded diagnostic summary.

A correction is promoted only when:

1. the failure is a schema/validation/required-field error;
2. a later call to the same exact tool or Revit method/path succeeds;
3. the accepted argument shape differs from the failed shape; and
4. the success occurs within seven days.

Pending failures are scoped to the originating Codex thread (or session when no thread exists), so concurrent chats cannot teach each other a false repair.

The harness injects the newest accepted shapes into later Codex turns as hints. Current live tool documentation remains authoritative, so a remembered correction cannot override a changed contract.

Numeric identifiers and ordinary user strings are stored as placeholders. Contract literals such as `action`, `mode`, `method`, `path`, and booleans are retained because they are the reusable part of the repair. Credential-like fields and diagnostic fragments are redacted. The store is capped at 64 pending failures, 128 corrections, and 256 classified failure receipts.

Default location:

```text
Workspace/memory/revit_tool_contract_memory.json
```

For tests or a custom self-hosted layout, set `OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH` to an absolute file path.

Writes use a temporary file plus atomic replacement. The last valid primary is retained as `.bak`; a corrupt primary is read from that backup instead of silently discarding quarantine and correction history.

## Evidence-based quarantine

Quarantine is explicit; an ordinary tool failure never hides a tool automatically. A quarantine record requires an exact tool name or exact Revit method/path plus a concrete reason. Evidence can cite a regression receipt, issue, or diagnostic artifact.

While a record is active:

- exact execution is rejected before MCP dispatch with `revit_tool_quarantined`;
- the route is removed from intent-based `revit_search_tools` results;
- the implementation, full registry entry, documentation, and history remain available for diagnosis and repair; and
- later turns receive a bounded warning not to call it autonomously.

Clearing a quarantine does not delete the record. It sets `active:false` and records `cleared_at`, preserving the defect and repair history.

The runtime APIs are exported from:

```text
apps/operator-backend/src/codex/revit_tool_contract_memory.ts
```

- `setRevitToolQuarantine(...)`
- `findActiveToolQuarantine(...)`
- `formatRevitToolContractMemoryForPrompt(...)`
- `recordRevitToolOutcome(...)`

Quarantine should be activated only for a reproducible defect or unacceptable safety behavior. Unprobed, environment-dependent, or merely inconvenient tools should remain visible with conservative audit evidence rather than being silently removed.

## Verification

Focused tests prove:

- restart-persistent failed/successful pairing;
- credential and identifier redaction;
- rejection of non-contract and identical-argument false corrections;
- all eight failure classifications;
- exact-route quarantine enforcement before MCP dispatch;
- autonomous search filtering; and
- cleared-history retention.

See `apps/operator-backend/test/revit_tool_contract_memory.test.ts` and `apps/operator-backend/test/revit_tool_parallel_guard.test.ts`.
