# Agent runtime and MCP review — 2026-09-13

## OpenAI

The [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) provides an OpenAI-managed Codex harness with durable sessions, compaction and recovery. [Session input](https://developers.openai.com/api/docs/guides/agents-api/sessions) starts work when idle and steers an active turn. Its [architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture) supports application-handled functions without a sandbox, or an optional hosted/self-hosted environment.

Operator already uses the local Codex app-server as its canonical agent. Keep it for this qualified batch: it supplies the harness while the workstation retains local files, Revit access and the existing authenticated transaction boundary. Moving to the managed API requires an explicit session/event adapter, durable function-call reconciliation, cancellation/usage mapping, and parity qualification. Replacing the provider alone does not establish exactly-once Revit effects. Do not add an unused second runner or migrate native write authority into a hosted sandbox.

Adopt the immediately useful behavior at the existing boundary: actual visual input, explicit live search, complete continuation observations, and durable assignment/effect ownership. [Responses compaction](https://developers.openai.com/api/docs/guides/compaction) is available for standalone Responses loops, but layering it over the Codex harness would duplicate context ownership. Auxiliary structured interpreters remain on Responses.

## Public Revit MCP implementations

Reviewed [KenLP/RevitMCPServer architecture](https://github.com/KenLP/RevitMCPServer/blob/main/docs/ARCHITECTURE.md) and its [MIT license](https://github.com/KenLP/RevitMCPServer/blob/main/LICENSE), copyright 2026 Le Phu. Its dispatcher owns transactions, atomic batches and structured changes. Operator already owns transactions and durable effect/readback contracts, so transplanting another dispatcher would add a conflicting authority. Use its simple command/transport separation as a comparison criterion when reducing legacy workflow coupling.

Reviewed [Demolinator/revit-mcp-server](https://github.com/Demolinator/revit-mcp-server/tree/40af5a7860b4470ad8f80ea327cf4a9cd31ca0a6), [MIT license](https://github.com/Demolinator/revit-mcp-server/blob/40af5a7860b4470ad8f80ea327cf4a9cd31ca0a6/LICENSE), copyright 2025 Juan Rodriguez. Its duct/pipe/system creation source uses dedicated Revit API calls and local transactions. Operator already implements these plus branch, connector, reroute and readback workflows. No new gap justified copying these implementations in this batch.

No third-party implementation code was copied. Preserve the upstream MIT notice if future work copies a substantial portion. Proprietary tools and repositories without a verified license are capability references only.

## Cleanup boundary

The old `openai_brain` executable route is already retired, but the module still supplies supported deterministic and secondary-provider workflow helpers. Remove unreferenced helpers and its unused streaming entry; retain working helpers until they can be mechanically extracted with their behavioral tests. Do not mistake a large module or historical evidence directory for safe-to-delete code.
