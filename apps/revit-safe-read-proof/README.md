# Revit Safe Read Proof Engine

This directory contains a standalone, fail-closed verifier and direct Roslyn
emitter for the future `apps/revit-safe-read-host` source manifest. It is a
proof engine, not the production host and not a claim that the production host
has already been integrated.

The verifier accepts one whole-assembly manifest. The manifest freezes:

- the SDK, `csc.dll`, Roslyn binaries, language version, and compiler options;
- every framework reference and its defining assembly identity;
- Revit API references for exactly Revit 2023, 2024, and 2025;
- every source and embedded resource byte;
- exact syntax, declared type/member, symbol-binding, serialization-closure,
  method/CFG/edge/operation/call, metadata, resource, and IL inventories; and
- the only sensitive roles permitted for a loopback `HttpListener`,
  `Interlocked` handoff, and Revit `ExternalEvent` safe-read callback.

Anything not frozen is rejected. This includes diagnostics of every severity
(including suppressed diagnostics), source shadows such as CS0436, duplicate
assembly identities, Revit type forwarders, unknown operations, unreachable
CFG blocks, initializers/finalizers/base chains, source polymorphism, dynamic,
delegates, lambdas/local functions, operators/conversions, reflection, P/Invoke,
and non-role I/O/network/process/environment/threading access.

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
run emits one deterministic DLL per Revit year and a canonical
`proof.receipt.json`. The receipt schema is in `schemas/receipt.schema.json`.

`inventory` is a deliberately non-certifying authoring command. It applies all
locks and fail-closed policy checks, then writes the observed exact inventories
to the caller output directory so they can be reviewed and frozen into a
manifest. It never upgrades itself to a successful proof.

## Tests

`tests/run.ps1` builds the tool and fake Revit reference fixtures via direct
compiler response files, verifies the positive fixture for all three Revit
years, compares deterministic output and receipts, and then runs adversarial
falsifiers. The ambient `Directory.Build.*` falsifier demonstrates that neither
bootstrap nor candidate compilation consumes MSBuild injection.

```powershell
./tests/run.ps1
```

All test/build artifacts go under a caller-owned temporary directory. The test
does not create `bin`, `obj`, package caches, or generated files in this tree.
