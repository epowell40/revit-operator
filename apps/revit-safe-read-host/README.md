# Revit Operator Safe Read Host

This tree builds a second, standalone `IExternalApplication` with permanent
AddIn ID `AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E`. It has no project, source-link,
or runtime dependency on the primary bridge, its shared libraries, or its
handler assembly.

The host owns one loopback-only endpoint:

```text
POST /revit/certified/sheets/count
```

The request entity is the exact UTF-8 byte sequence:

```json
{"schema":"revit-operator.safe-read.sheets-count.request.v1"}
```

The wired public runtime is intentionally deny-by-default. The authorization
protocol types and fixed-origin client boundary are present, but the add-in
uses the deny-all client and supplies no runtime attestation. It therefore
cannot execute the Revit count until a separate integration supplies and
cryptographically verifies the frozen preauthorization/final-authorization
receipt contract.

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
authorization by itself.
