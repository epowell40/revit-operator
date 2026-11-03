# Dynamic Revit Runtime packaging

Native C# is a normal read/write execution option for the authenticated local
or self-hosted General Agent on Revit 2023–2027. Configure the backend and MCP with
`REVIT_OPERATOR_MODE=local` (or `self_hosted`),
`OPERATOR_TOOL_EXPOSURE_PROFILE=general`, `OPERATOR_BRAIN=codex`,
`OPERATOR_AUTH_MODE=shared_token`, `OPERATOR_ASSIGNMENT_KERNEL_V2=1`, and the existing local provider credentials.
The ordinary desktop catalog exposes the exact C# schema directly to the same
actor. Keep the native Revit process in its ordinary local/general profile;
no `OPERATOR_NATIVE_PROGRAM_EXECUTION` developer opt-in is needed.

Named tools remain useful for simple operations. Use custom C# for reads,
aggregation or bounded edits that benefit from code. Code runs through the
existing compiler/sandbox and authenticated native launcher, with current task,
source and document binding, transaction controls, independent readback and
Pause/unknown-effect safeguards. A successful program is not task verification.
Hosted/production backends enable the existing assignment kernel with
`OPERATOR_ASSIGNMENT_KERNEL_V2=1` and `OPERATOR_REVIT_TRANSPORT=courier`.
This selects the supported task controller, not a development profile or extra
write authority. Existing tasks keep their recorded owner/history.
Hosted/production actors use the existing authenticated courier to run source
on the selected Windows Revit workstation, then retain source/document-bound
native evidence in the existing task. EC2 does not launch Windows compilers.
The workstation needs the matching add-in plus packaged dynamic runtime.
Missing runtime, wrong identity or lost response never cause an automatic retry. Exact development/laboratory
configuration and the old native opt-in remain compatible for existing tests.

`OPERATOR_CERTIFICATION_PROTECTED_LABORATORY` belongs only to certification
evidence generation, not ordinary UI qualification.

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
