# SafeRead certified microhost

This is an isolated release path for the certified SafeRead host. It is **not a readiness claim** and does not start Revit, enable the feature, modify the main RevitOperator payload or `RevitBridge.addin`, or change the bridge URL, launcher, or ports.

The certified identity is fixed to the integrated public core:

- host assembly: `RevitOperator.SafeReadHost.dll`
- template/install names: `RevitOperator.SafeReadHost.addin.template` and `RevitOperator.SafeReadHost.addin`
- class: `RevitOperator.SafeReadHost.App`
- AddInId in every year directory: `AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E`
- name/vendor fields: the exact values in `apps/revit-safe-read-host/addin/RevitOperator.SafeReadHost.addin.template`

The XML verifier disables DTD processing, requires exactly one `Application` AddIn, rejects extra/reordered/duplicate fields, and compares parsed exact values including `VendorDescription`. Installed assembly paths are written through an XML DOM so reserved characters are escaped without changing the parsed value.

## Proof and build contract

The production proof boundary is the one compiled source file in `RevitOperator.SafeReadCertifiedExecution`. The verifier locks the exact normalized source bytes, SDK/compiler/reference packs, installed Revit 2023/2024/2025 API assemblies, policy, inventories, ABI, metadata, and IL. A successful `check` emits all three executor DLLs plus one `revit-safe-read-certified-kernel/v1` receipt. Excluded legacy source and build output are not part of that compilation input; authoring a production manifest should therefore stage a hash-checked copy of the one compiled source in an otherwise empty caller-owned directory.

`build_saferead_package_v2.ps1` consumes `revit-operator.safe-read-package-build-input.v2`. Each target declares exactly one `host` and one `certified_executor`. The executor cannot be supplied or rebuilt by the package input: it is copied only from the successful proof receipt. The host defaults to the real project/output layout. Runtime dependencies are derived transitively and included as exact `runtime_dependency` entries.

The builder runs the host for Revit 2023/2024 as `net48` x64 and Revit 2025 as `net8.0-windows` x64 against that year's actual `RevitAPI.dll`. It inspects PE metadata, target-framework attributes, MVIDs, architecture, and embedded Revit API reference versions. A cross-year DLL or API is rejected. Every DLL is signed before its final size/hash receipt. After signing, the builder invokes the standalone proof tool's `fingerprint` command through `-ProofToolPath` and requires the executor's managed metadata/IL fingerprint to equal the verifier-emitted unsigned artifact. The raw signed SHA-256 is intentionally different and remains the runtime/package binding.

Each target carries `safe_read_runtime_attestation.v1.json` plus its external pin. It uses only the exact backend static schema and binds the historical `host_*` tuple fields to the separately proofed, signed certified executor—not the transport host shell. Hashes use lowercase `sha256:<64 hex>` form. Dynamic host-instance, document, client, request, and attempt bindings remain runtime-only. Pin package metadata through a deployment-owned channel and pass that external value to verification/installation; never derive trust from the package being installed.

## Verify, activate, and roll back

`verify_saferead_microhost_bundle.ps1` rejects missing/extra files, malformed or traversing paths, release/attestation drift, mixed year/framework/platform/API payloads, incorrect identity/XML, invalid signatures, and non-allowlisted signers.

`install_saferead_package_v2.ps1` (also reached by the compatibility `install_saferead_microhost_bundle.ps1` entry point) requires explicit SafeRead destination and Revit add-ins roots. It copies into a versioned stage, re-verifies after copy and promotion, then renders and verifies all three final `.addin` files before changing live activation state. Live manifest writes are recoverable; the active pointer changes only after all three succeed. Any partial-write failure restores the prior three manifests and pointer coherently. Rollback release IDs are regex-validated, resolved beneath the versioned releases root, and revalidated against their stored external attestation pin.

Passing source builds and Pester tests is package evidence only. Loaded-DLL identity and real Revit/UI behavior remain unverified until a separate controlled deployment and GUI test.
