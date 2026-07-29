# SafeRead microhost package scaffold

This is an isolated package path for a future read-only SafeRead Revit bridge. It is **not a readiness claim**, does not enable the feature, and does not modify the established RevitOperator installer, bridge URL, launcher, ports, or `RevitBridge.addin`.

The package is deliberately separate:

- Payload filename: `RevitBridge.SafeRead.Addin.dll`.
- Revit manifest filename: `RevitBridge.SafeRead.addin`.
- The AddInId, class, name, and vendor identity come only from the build input manifest; the main RevitOperator AddInId is rejected.
- Targets are fixed: Revit 2023 and 2024 use `net48`; 2025 uses `net8.0-windows`. The release must contain all three and cannot mix their framework/API metadata.

## Build input and receipt

Create an input JSON using `safe-read-microhost-input/v1`. Each target supplies `revitYear`, `framework`, `apiVersion`, `sourceDll`, and `identity` (`Name`, `AddInId`, `FullClassName`, `VendorId`, `VendorDescription`). The input also supplies an explicit `allowedSignerThumbprints` allowlist.

Run `build_saferead_microhost_bundle.ps1` with an existing output directory, `signtool.exe`, and a signing thumbprint. The build copies the source DLL into an immutable target staging tree, signs it there, then calculates final hashes and writes `release-manifest.json`. It writes a small `deployment-attestation.json` bound to that final manifest.

The SHA-256 of `deployment-attestation.json` is printed by the builder. Store that value in the deployment-owned release channel and supply it as `-AttestationPinSha256` during verification and installation. Do not obtain the pin from an untrusted bundle at install time. A changed manifest, changed attestation, or stale pin fails closed.

## Verify and install

`verify_saferead_microhost_bundle.ps1` checks the exact release root and target trees: there may be no missing or extra files; file hashes/sizes, release ID, year/framework/API binding, identity, manifest template, Authenticode status, and signer allowlist must all match. Production verification uses `Get-AuthenticodeSignature`; tests inject a verifier and do not require a real certificate.

`install_saferead_microhost_bundle.ps1` requires an explicit SafeRead `-DestinationRoot` and explicit `-RevitAddinsRoot`. It copies to a versioned staging directory, re-verifies after the copy and again after promotion, then atomically replaces only `active-release.json`. It creates only `RevitBridge.SafeRead.addin` beneath the supplied Revit add-ins root, leaving an existing `RevitBridge.addin` untouched. `-RollbackReleaseId` re-verifies the earlier installed version using its externally stored pin before atomically reactivating it.

No command here starts Revit, changes the main operator payload, or proves a loaded add-in. A signed package, Pester pass, or manifest installation alone is not live Revit/UI validation.
