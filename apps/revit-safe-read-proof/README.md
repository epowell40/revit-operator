# Revit Safe Read Proof Engine

This directory contains a standalone, fail-closed verifier and direct Roslyn
emitter for the synchronous `RevitOperator.SafeReadCertifiedExecution` kernel.
It certifies only one mutation-free `Execute(Document)` read kernel and its
sealed primitive result DTO. Authentication, transport, ExternalEvent state,
timeouts, replay defense, serialization, and the production host are explicitly
outside this proof boundary.

The verifier accepts one whole-assembly manifest. The manifest freezes:

- the SDK, `csc.dll`, Roslyn binaries, language version, and compiler options;
- per-variant framework target and x64 platform: .NET Framework 4.8 for Revit
  2023/2024 and `net8.0-windows` for Revit 2025;
- separate, exact identity and SHA-256 locks for `RevitAPI.dll` for exactly
  Revit 2023, 2024, and 2025; `RevitAPIUI.dll` is outside the kernel boundary;
- an explicit exact `.cs` compile-source set after BOM-free UTF-8/LF
  normalization (project files and other non-C# metadata are excluded);
- exact syntax, declared type/member, symbol-binding, serialization-closure,
  method/CFG/edge/operation/call, metadata, resource, and IL inventories; and
- the complete public ABI discovered independently from policy, the exact
  `Execute(Document)` entry point, and its independently derived result closure.

Anything not frozen is rejected. This includes diagnostics of every severity
(including suppressed diagnostics), source shadows such as CS0436, duplicate
assembly identities, Revit type forwarders, unknown operations, unreachable
CFG blocks, initializers/finalizers/base chains, source polymorphism, dynamic,
delegates, lambdas/local functions, operators/conversions, reflection, P/Invoke,
and I/O/network/transport-host/process/environment/non-role threading access.
Network and file APIs are never allowlistable in the certified execution
assembly; transport belongs in a separate, non-certified assembly.

The security boundary assumes the local operating system, local administrator,
the installed .NET SDK/reference pack, and Autodesk Revit are trusted. This tool
does not attempt to defend against a malicious local administrator, compromised
OS/runtime, or compromised Revit process. It proves only that the locked bytes
and compiler inputs match the frozen whole-assembly policy.

## Hermetic bootstrap

The proof tool itself is built by an absolute `dotnet csc.dll` invocation. It
uses generated, hash-receipted response files with `/noconfig`, `/nostdlib+`,
`/deterministic+`, and fixed options. MSBuild is not used, so ambient
`Directory.Build.props` and `Directory.Build.targets` files are not evaluated.
Bootstrap output is explicitly **not** certified host output.

```powershell
$temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
./bootstrap.ps1 -Check -OutputRoot $temp
dotnet "$temp/tool/RevitSafeReadProof.dll" check `
  --manifest C:\absolute\candidate.manifest.json `
  --output-dir "$temp/candidate"
```

`check` writes only beneath the caller-provided output directory. A successful
run emits one deterministic `RevitOperator.SafeReadCertifiedExecution.RevitYEAR.dll`
per Revit year and a canonical `proof.receipt.json`. Each artifact record binds
the whole unsigned verifier-emitted SHA-256 plus a managed metadata/IL
fingerprint that remains stable across Authenticode signing. The receipt schema
is in `schemas/receipt.schema.json`.

Packaging can re-inspect an unsigned or Authenticode-signed artifact without
recompiling it:

```powershell
dotnet RevitSafeReadProof.dll fingerprint `
  --artifact C:\absolute\RevitOperator.SafeReadCertifiedExecution.dll `
  --output-dir C:\absolute\empty-output
```

This writes `artifact.fingerprint.json`. `managedCodeSha256` is SHA-256 of the
UTF-8 bytes `metadata:<metadata-inventory-sha256>\nil:<il-inventory-sha256>`;
the PE certificate table is not part of either inventory. The raw artifact
`sha256` still provides the mandatory pre-sign provenance check.

`inventory` is a deliberately non-certifying authoring command. It applies all
locks and fail-closed policy checks, then writes the observed exact inventories
to the caller output directory so they can be reviewed and frozen into a
manifest. It never upgrades itself to a successful proof.

## Tests

`tests/run.ps1` builds the tool and fake Revit API fixtures via direct
compiler response files, verifies two positive checks for all three Revit
targets across CRLF/LF source bytes, inventories the installed real 2023/2024/
2025 `RevitAPI.dll` references, compares deterministic output and
receipts, fingerprints all emitted artifacts, rejects malformed artifacts with
a receipt, and runs 34 adversarial falsifiers. Target/platform, public ABI,
ambient `Directory.Build.*`, multi-source, and repository-write falsifiers are
included.

```powershell
./tests/run.ps1
```

All test/build artifacts go under a caller-owned temporary directory. The test
does not create `bin`, `obj`, package caches, or generated files in this tree.
