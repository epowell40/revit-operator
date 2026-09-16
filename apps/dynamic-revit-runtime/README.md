# Dynamic Revit Runtime packaging

`DynamicRevitRuntime.sln` is the hermetic build and test boundary for the generated-code worker, trusted sandbox supervisor, SDK, package verifier, and their tests. It intentionally excludes Autodesk-dependent host compilation so ordinary public CI does not need proprietary Revit assemblies.

The trusted host strategy is declared by `manifests/revit-host-capabilities.v1.json`:

- Revit 2023 and 2024 use the `net48` host adapter.
- Revit 2025 and 2026 use the `net8.0-windows` host adapter.
- Revit 2027 uses the `net10.0-windows` host adapter and requires .NET SDK 10 for packaging.
- Protocol and SDK semantics are shared, while each year may advertise a distinct `sdkDomains` set as API differences emerge.
- The supervisor requires `targetRevitYear` in live-task configuration and matches the bootstrap pipe's kernel-observed server process against the selected trusted `Revit.exe` identity.

On a controlled Windows runner with Revit 2023–2027 installed, `scripts/build_dynamic_runtime_package.ps1` publishes the supervisor and worker, builds all five host adapters, writes `dynamic-revit-runtime-package.v1.json`, then verifies every bound artifact. The public manifest contains hashes and version identities only. Artifact signing and private deployment authorization remain separate release concerns.

The verifier hashes the complete supervisor and worker directory trees, then independently binds the SDK manifest/file, sandbox policy, effective supervisor host manifest, package host manifest, and per-year host artifacts. It fails closed on missing or changed content, path traversal/reparse points, duplicate artifact paths, framework/year mismatches, an unexpected SDK manifest identity, and sandbox metadata that differs from the hashed policy.

`manifests/dynamic-revit-observations-core.v1.json` binds observation selectors, envelopes, canonical hashing, and limits to the SDK and runtime package identities. Consult the selected host's capability and activation receipts for available observation and mutation routes. Packaging a contract or host adapter does not grant execution authority. See `docs/GENERATED_CODE_REVIEW.md` in the public repository for the distinction between generated SDK programs and unrestricted Revit API execution.
