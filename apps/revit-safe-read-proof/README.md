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

The manifest is an input lock, not an authorization policy. Proof profile
`revit-safe-read-sheet-count-kernel/v1` is compiled into the verifier and owns
the only accepted entry point, public ABI, primitive result closure, operation
kinds, and exact Revit read-symbol families. `allowedSensitiveSymbols` must be
empty. Regenerating source hashes and every observed inventory cannot authorize
`Document.Save`, `Document.Delete`, transactions, mutating setters, reflection,
or dynamic invocation.

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
per Revit year and a canonical `proof.receipt.json`. The receipt binds the whole
manifest, fixed profile, exact verifier/Roslyn bundle, source set, installed
Revit API locks, SDK/framework locks, and whole unsigned artifact SHA-256. Its
schema is in `schemas/receipt.schema.json`.

The production manifest is generated without caller-controlled source,
reference, policy, or expected-inventory seams:

```powershell
./production/New-ProductionManifest.ps1 -OutputPath C:\absolute\production.manifest.json
dotnet RevitSafeReadProof.dll check `
  --manifest C:\absolute\production.manifest.json `
  --output-dir C:\absolute\empty-proof-output
```

It locks the single production `RevitCertifiedExecution.cs` compile source and
the installed Revit 2023/2024/2025 `RevitAPI.dll` files. Unlisted sibling C# and
project files are inert because only `source.files` enter the direct compiler
response.

Packaging must bind an Authenticode candidate to the exact receipted unsigned
artifact with the canonical full-PE equivalence gate:

```powershell
dotnet RevitSafeReadProof.dll equivalence `
  --unsigned-artifact C:\absolute\unsigned\RevitOperator.SafeReadCertifiedExecution.Revit2025.dll `
  --candidate-artifact C:\absolute\signed\RevitOperator.SafeReadCertifiedExecution.Revit2025.dll `
  --proof-receipt C:\absolute\unsigned\proof.receipt.json `
  --revit-year 2025 `
  --output-dir C:\absolute\empty-output
```

This writes `artifact.equivalence.json`. The candidate may differ only in the
PE checksum, security-directory entry, at most seven required zero alignment
bytes, and a structurally valid Authenticode `WIN_CERTIFICATE` table ending
exactly at EOF. Arbitrary overlay bytes and every resource, section, header,
native, metadata, and IL change fail closed. `canonicalPeSha256` hashes the full
receipted PE with only the checksum and security-directory entry zeroed.

`fingerprint` remains a diagnostic metadata/IL inventory command. It is not a
post-sign trust gate and packaging must not use it for provenance.

`inventory` is a deliberately non-certifying authoring command. It applies all
locks and fail-closed policy checks, then writes the observed exact inventories
to the caller output directory so they can be reviewed and frozen into a
manifest. It never upgrades itself to a successful proof.

## Tests

`tests/run.ps1` builds the tool and fake Revit API fixtures via direct
compiler response files, verifies two positive checks for all three Revit
targets across CRLF/LF source bytes, inventories the installed real 2023/2024/
2025 `RevitAPI.dll` references, compares deterministic output and receipts,
rejects truncated and valid-PE malformed-IL artifacts, verifies canonical
Authenticode equivalence, rejects overlay/header tampering, and runs 41
adversarial falsifiers. Eight mutation/reflection cases regenerate and re-freeze
their exact observed inventories before check mode proves they still fail.

```powershell
./tests/run.ps1
```

All test/build artifacts go under a caller-owned temporary directory. The test
does not create `bin`, `obj`, package caches, or generated files in this tree.
