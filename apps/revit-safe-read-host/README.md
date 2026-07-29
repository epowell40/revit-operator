# Revit Operator Safe Read Host

This tree builds a second, standalone `IExternalApplication` with permanent
AddIn ID `AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E`. It has no project, source-link,
or runtime dependency on the primary bridge, its shared libraries, or its
handler assembly.

Production is split into two assemblies. `RevitOperator.SafeReadHost` owns
loopback HTTP, discovery, environment configuration, static-attestation
validation, backend authorization, receipt verification, replay state,
document sessions, deadlines, and the capacity-one ExternalEvent state
machine. `RevitOperator.SafeReadCertifiedExecution` is deliberately much
smaller: its only compiled source is a synchronous mutation-free sheet-count
kernel plus a sealed primitive result DTO. It references `RevitAPI` only. The
project reference is host to certified execution only.

The host owns one loopback-only endpoint:

```text
POST /revit/certified/sheets/count
```

The request entity is the exact UTF-8 byte sequence:

```json
{"schema":"revit-operator.safe-read.sheets-count.request.v1"}
```

The six external headers are
`X-RevitOperator-SafeRead-Startup-Token`,
`X-RevitOperator-SafeRead-Host-Instance-Id`,
`X-RevitOperator-SafeRead-Document-Session-Id`,
`X-RevitOperator-SafeRead-Client-Session-Id`,
`X-RevitOperator-SafeRead-Request-Id`, and
`X-RevitOperator-SafeRead-Attempt-Id`. There is no external nonce: the host
generates a fresh 32-byte nonce after admission and never publishes it.

The concrete authorization client sends exact snake-case preauthorization and
final-authorization bodies to one configured origin, unwraps only the exact
success envelopes, and verifies the nonce-derived HMAC inside the host
assembly. Each POST first proves that the fixed origin is connectable. A proven
pre-connect failure is a known retryable denial; after POST dispatch, response
reset, loss, or cancellation is preserved as
`request_dispatched=true,outcome_unknown=true,retryable=false`. Complete exact
backend failure envelopes retain their structured retry/dispatch truth.
Missing/malformed configuration, redirect, unknown JSON field, stale receipt,
replay, or binding mismatch denies execution.

Production JSON parsing is one purpose-built bounded implementation shared by
net48 and net8. It accepts only objects, strings, and booleans needed by the
frozen SafeRead contracts. Duplicate or reordered keys, wrong types, arrays,
numbers, null, whitespace/trailing content, invalid UTF-8/escapes/surrogates,
and depth/size overflow fail closed. The host has no `System.Text.Json`
dependency, avoiding conflicting strong-name identities in the flat Revit
2023/2024 payload.

Startup also requires `safe_read_runtime_attestation.v1.json` and
`safe_read_runtime_attestation.v1.sha256` beside the host DLL. The host verifies
the external pin before parsing the exact backend-format manifest, rejects
expired/revoked or wrong-route policy state, and remeasures the loaded certified
executor and Revit API assemblies against its runtime tuple.

Per-instance discovery is published atomically beneath
`%LOCALAPPDATA%\RevitOperator\SafeRead\instances`. The host applies and then
re-verifies a protected Windows ACL containing only the owning user, SYSTEM,
and local administrators; it rejects reparse points and unsafe ACLs before
using discovery or deployment-attestation files. It never reads or writes the
primary bridge URL, operator token, or primary add-in manifest.

Every admitted request snapshots a monotonic document revision/session.
`DocumentChanged` rotates the binding even when a document remains dirty;
save, save-as, document switch, and close transitions rotate or clear it. The
production ExternalEvent handler rechecks that binding immediately before the
certified executor can run.

## Build and test

```powershell
dotnet test .\tests\RevitOperator.SafeReadHost.Tests\RevitOperator.SafeReadHost.Tests.csproj -c Release
dotnet run --project .\tests\RevitOperator.SafeReadHost.ParserVectors\RevitOperator.SafeReadHost.ParserVectors.csproj -c Release -f net48
dotnet run --project .\tests\RevitOperator.SafeReadHost.ParserVectors\RevitOperator.SafeReadHost.ParserVectors.csproj -c Release -f net8.0-windows
dotnet msbuild .\src\RevitOperator.SafeReadCertifiedExecution\RevitOperator.SafeReadCertifiedExecution.csproj -getItem:Compile -p:TargetFramework=net8.0-windows -p:RevitYear=2025
dotnet build .\src\RevitOperator.SafeReadHost\RevitOperator.SafeReadHost.csproj -c Release -f net48 -p:RevitYear=2023 -p:RevitApiPath="C:\Program Files\Autodesk\Revit 2023"
dotnet build .\src\RevitOperator.SafeReadHost\RevitOperator.SafeReadHost.csproj -c Release -f net48 -p:RevitYear=2024 -p:RevitApiPath="C:\Program Files\Autodesk\Revit 2024"
dotnet build .\src\RevitOperator.SafeReadHost\RevitOperator.SafeReadHost.csproj -c Release -f net8.0-windows -p:RevitYear=2025 -p:RevitApiPath="C:\Program Files\Autodesk\Revit 2025"
```

The test project compiles the production `HostKernel`, host orchestrator,
attestation/discovery path, and Revit execution adapter against deterministic
Revit stubs. The certified project also fails its build unless the evaluated
`@(Compile)` set contains exactly `RevitCertifiedExecution.cs`.

`REVIT_OPERATOR_SAFE_READ_PORT` is optional. If present, it must be an exact
decimal port from `5040` through `5050`; invalid values fail startup.

`REVIT_OPERATOR_SAFE_READ_AUTH_ORIGIN` is read once at startup and must be a
pathless HTTPS origin, or an HTTP origin on `127.0.0.1`. It does not enable
authorization by itself. Configure exactly one of
`REVIT_OPERATOR_SAFE_READ_AUTH_BEARER` or
`REVIT_OPERATOR_SAFE_READ_AUTH_TOKEN`; both missing or both present fail
startup. See [THREAT_BOUNDARY.md](THREAT_BOUNDARY.md) for ACL and trust limits.
