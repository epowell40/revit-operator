# Revit Operator Safe Read Host

This tree builds a second, standalone `IExternalApplication` with permanent
AddIn ID `AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E`. It has no project, source-link,
or runtime dependency on the primary bridge, its shared libraries, or its
handler assembly.

Production is split into two assemblies. `RevitOperator.SafeReadHost` owns
loopback HTTP, discovery, environment configuration, runtime measurement, and
outbound backend HTTP. `RevitOperator.SafeReadCertifiedExecution` owns the
final-receipt verification boundary, sealed one-use token, document session,
capacity-one ExternalEvent state machine, and sheet-count kernel. The project
reference is host to certified execution only.

The host owns one loopback-only endpoint:

```text
POST /revit/certified/sheets/count
```

The request entity is the exact UTF-8 byte sequence:

```json
{"schema":"revit-operator.safe-read.sheets-count.request.v1"}
```

The six external headers are `X-RevitOperator-SafeRead-Token`, `HostInstance`,
`DocumentSession`, `ClientSession`, `RequestId`, and `AttemptId` (the last five
use the same `X-RevitOperator-SafeRead-` prefix). There is no external nonce:
the host generates a fresh 32-byte nonce after admission and never publishes it.

The concrete authorization client sends exact snake-case preauthorization and
final-authorization bodies to one configured origin, unwraps only the exact
success envelopes, and delegates nonce-derived HMAC verification to the
certified assembly. Missing/malformed configuration, timeout, redirect,
unknown JSON field, stale receipt, replay, or binding mismatch denies execution.

Per-instance discovery is published atomically beneath
`%LOCALAPPDATA%\RevitOperator\SafeRead\instances`. It never reads or writes the
primary bridge URL, operator token, or primary add-in manifest.

## Build and test

```powershell
dotnet test .\tests\RevitOperator.SafeReadHost.Tests\RevitOperator.SafeReadHost.Tests.csproj -c Release
dotnet build .\src\RevitOperator.SafeReadHost\RevitOperator.SafeReadHost.csproj -c Release -f net48 -p:RevitYear=2023 -p:RevitApiPath="C:\Program Files\Autodesk\Revit 2023"
dotnet build .\src\RevitOperator.SafeReadHost\RevitOperator.SafeReadHost.csproj -c Release -f net48 -p:RevitYear=2024 -p:RevitApiPath="C:\Program Files\Autodesk\Revit 2024"
dotnet build .\src\RevitOperator.SafeReadHost\RevitOperator.SafeReadHost.csproj -c Release -f net8.0-windows -p:RevitYear=2025 -p:RevitApiPath="C:\Program Files\Autodesk\Revit 2025"
```

`REVIT_OPERATOR_SAFE_READ_PORT` is optional. If present, it must be an exact
decimal port from `5040` through `5050`; invalid values fail startup.

`REVIT_OPERATOR_SAFE_READ_AUTH_ORIGIN` is read once at startup and must be a
pathless HTTPS origin, or an HTTP origin on `127.0.0.1`. It does not enable
authorization by itself. Configure exactly one of
`REVIT_OPERATOR_SAFE_READ_AUTH_BEARER` or
`REVIT_OPERATOR_SAFE_READ_AUTH_TOKEN`; both missing or both present fail
startup. See [THREAT_BOUNDARY.md](THREAT_BOUNDARY.md) for ACL and trust limits.
