# SafeRead package scaffold

This is an isolated release path for the certified SafeRead host. It is **not a readiness claim** and does not start Revit, enable the feature, modify the main RevitOperator payload or `RevitBridge.addin`, or change the bridge URL, launcher, or ports.

The certified identity is fixed to the integrated public core:

- host assembly: `RevitOperator.SafeReadHost.dll`
- template/install names: `RevitOperator.SafeReadHost.addin.template` and `RevitOperator.SafeReadHost.addin`
- class: `RevitOperator.SafeReadHost.App`
- AddInId in every year directory: `AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E`
- name/vendor fields: the exact values in `apps/revit-safe-read-host/addin/RevitOperator.SafeReadHost.addin.template`

The XML verifier disables DTD processing, requires exactly one `Application` AddIn, rejects extra/reordered/duplicate fields, and compares parsed exact values including `VendorDescription`. Installed assembly paths are written through an XML DOM so reserved characters are escaped without changing the parsed value.

## Build contract

`build_saferead_package_v2.ps1` consumes `revit-operator.safe-read-package-build-input.v2`. Each of the exact three targets declares `revitYear`, `framework`, `platform: x64`, `revitApiPath`, and an exact `requiredPayload` list. A required payload entry declares `fileName`, `role`, and `revitApiBound`; it may supply `projectPath`/`outputPath` or `sourceDll`. The host role defaults to the real `apps/revit-safe-read-host` project and output layout. This list can add the certified-execution DLL when that core split lands without weakening exact-tree validation.

The builder runs each declared project for Revit 2023/2024 as `net48` x64 and Revit 2025 as `net8.0-windows` x64 against that year's actual `RevitAPI.dll`. It inspects PE metadata, target-framework attributes, MVIDs, architecture, and embedded Revit API reference versions. A cross-year DLL or API is rejected. Every DLL is signed before its final size/hash receipt; production uses Authenticode and a signer allowlist, while tests inject sign/signature operations and require no certificate.

`deployment-attestation.json` binds the final release manifest and emits only static, backend-shaped runtime tuples. Hashes use lowercase `sha256:<64 hex>` form. The package attestation intentionally excludes dynamic host-instance and document bindings; deployment/runtime code must add those separately. Pin the attestation hash through a deployment-owned channel and pass that external value to verification/installation—never derive the trusted pin from the package being installed.

## Verify, activate, and roll back

`verify_saferead_microhost_bundle.ps1` rejects missing/extra files, malformed or traversing paths, release/attestation drift, mixed year/framework/platform/API payloads, incorrect identity/XML, invalid signatures, and non-allowlisted signers.

`install_saferead_package_v2.ps1` (also reached by the compatibility `install_saferead_microhost_bundle.ps1` entry point) requires explicit SafeRead destination and Revit add-ins roots. It copies into a versioned stage, re-verifies after copy and promotion, then renders and verifies all three final `.addin` files before changing live activation state. Live manifest writes are recoverable; the active pointer changes only after all three succeed. Any partial-write failure restores the prior three manifests and pointer coherently. Rollback release IDs are regex-validated, resolved beneath the versioned releases root, and revalidated against their stored external attestation pin.

Passing source builds and Pester tests is package evidence only. Loaded-DLL identity and real Revit/UI behavior remain unverified until a separate controlled deployment and GUI test.
