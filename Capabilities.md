# Revit Operator Capabilities

This project’s tool surface is discoverable at runtime. Instead of relying on a hand-maintained list, use the built-in introspection endpoints and the Operator pane’s **Tools** list.

## Where to see available tools
- In Revit → Operator pane → **Tools** (populated from `revit-bridge-addin/RevitBridge/Operator/OperatorToolManifest.cs`).
- `GET /revit/capabilities` (allowlisted method/path pairs).
- `GET /revit/tool-registry` (machine-readable registry for all tools; large payload).
- `POST /revit/tool-doc` with `{ "method": "POST", "path": "/revit/rooms" }` (single-tool drilldown: required fields, enums, units, examples).
- `POST /revit/tool-examples` with `{ "method": "POST", "path": "/revit/rooms" }` (golden payloads).

## Notable “daily-driver” tools
Use `POST /revit/tool-doc` / `POST /revit/tool-examples` for the authoritative contract, but some high-ROI workflows include:
- Sheet automation: `/revit/create-sheets`, `/revit/place-views`, `/revit/align-viewports`, `/revit/renumber-sheets`, `/revit/sync-sheet-names`
- Exports: `/revit/export-images`, `/revit/export-dwg`, `/revit/export-ifc` (plus `/revit/export-pdf`)
- Excel round-trip: `/revit/export-elements-xlsx`, `/revit/import-elements-xlsx-updates` (supports `dryRun` + diffs)
- MEP sizing: `/revit/trace-connected-network` (supports `includeSystemAudit`), `/revit/find-elements-by-parameter`, `/revit/resize-duct-run`, `/revit/sync-connected-sizes`, `/revit/duplicate-type-and-swap-instance`, `/revit/get-connectors`

## How to update tool docs (so Operator users can understand what they can do)
When you add/change an endpoint, keep these in sync:
- Endpoint wiring: `revit-bridge-addin/RevitBridge/Server/RevitHttpServer.cs`, `revit-bridge-addin/RevitBridge/Operator/OperatorActionRunner.cs`
- Allowlist: `revit-bridge-addin/RevitBridge/Operator/OperatorActionAllowlist.cs`, `operator-backend/src/allowlist.ts`
- Risk / approvals: `revit-bridge-addin/RevitBridge/Operator/OperatorApprovalPolicy.cs`
- Request schema validation: `revit-bridge-addin/RevitBridge/Operator/OperatorActionSchemaValidator.cs`
- Human-facing tool list (UI): `revit-bridge-addin/RevitBridge/Operator/OperatorToolManifest.cs`
- Introspection schemas + units/enums notes: `revit-bridge-addin/RevitBridge/Operator/OperatorToolIntrospection.cs` (`RequestTypesByPath` mapping)
- Runnable examples: `revit-bridge-addin/RevitBridge/Tooling/tool_examples.json` (embedded into the add-in as a resource)

## Definition of done (make a tool actually usable)
It’s easy to “add a handler” but still ship something that the agent can’t call. Before considering a tool complete:

### 1) Wire it for the right execution path(s)
- **MCP / external HTTP clients → Revit bridge (`:5000`)**: add it to `revit-bridge-addin/RevitBridge/Server/RevitHttpServer.cs`
  - Symptom when missing: `404 {"error":"Path /revit/<tool> not found"}`
- **Operator pane tool loop (in-Revit) → action runner**: add it to `revit-bridge-addin/RevitBridge/Operator/OperatorActionRunner.cs`
  - Symptom when missing: tool shows in docs but Operator can’t execute it.

### 2) Make it discoverable + callable by the agent
- Add to the add-in allowlist: `revit-bridge-addin/RevitBridge/Operator/OperatorActionAllowlist.cs`
- Add to the backend default allowlist: `operator-backend/src/allowlist.ts` (otherwise the brain may drop it, and local macro-skill gating may reject it)
- Add to manifest + schemas + examples (files listed above).

### 3) Verify the running build is the one you think it is
Use `GET /revit/capabilities` and confirm:
- The endpoint appears in `allowlist`
- `addin.location` points at the expected DLL (prevents “built it but old add-in is loaded” confusion)

### 4) Smoke-check in dev
After changes, run `.\dev_restart_all.ps1` (and restart Revit if the add-in DLLs changed), then:
- `show capabilities` (agent/UI) and confirm the tool is listed
- `describe tool /revit/<tool>` and check required fields
- Run one small test call (dry-run if supported)
