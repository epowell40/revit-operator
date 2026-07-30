# SafeRead certified microhost

This is an isolated release path for the certified SafeRead host. It is **not a readiness claim** and does not start Revit, enable the feature, modify the main RevitOperator payload or `RevitBridge.addin`, or change the bridge URL, launcher, or ports.

The certified identity is fixed to the integrated public core:

- host assembly: `RevitOperator.SafeReadHost.dll`
- template/install names: `RevitOperator.SafeReadHost.addin.template` and `RevitOperator.SafeReadHost.addin`
- class: `RevitOperator.SafeReadHost.App`
- AddInId in every year directory: `AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E`
- name/vendor fields: the exact values in `apps/revit-safe-read-host/addin/RevitOperator.SafeReadHost.addin.template`

The XML verifier disables DTD processing, requires exactly one `Application` AddIn, rejects extra/reordered/duplicate fields, and compares parsed exact values including `VendorDescription`. Installed assembly paths are written through an XML DOM so reserved characters are escaped without changing the parsed value.

The public cross-runtime wire contract is `contracts/safe-read/contract.v1.json`. It freezes the executor and product identities, route/method/body, exact six custom headers, discovery/success/failure/attestation field order, capability and receipt patterns, backend endpoints, and the computed body/request/effect/route/policy hashes. Backend, MCP, production-host, and package tests independently load that file and recompute or compare their runtime values; local copies of the same literals are not accepted as a golden test.

## Proof and build contract

The production proof boundary is the one compiled source file in `RevitOperator.SafeReadCertifiedExecution`. The verifier locks the exact normalized source bytes, SDK/compiler/reference packs, installed Revit 2023/2024/2025 API assemblies, policy, inventories, ABI, metadata, and IL. A successful `check` emits all three executor DLLs plus one `revit-safe-read-certified-kernel/v1` receipt. Excluded legacy source and build output are not part of that compilation input; authoring a production manifest should therefore stage a hash-checked copy of the one compiled source in an otherwise empty caller-owned directory.

`build_saferead_package_v2.ps1` consumes `revit-operator.safe-read-package-build-input.v3`. The compatibility filename is retained, but v2 inputs are rejected. The builder owns the fixed production manifest generation and proof check. Each target declares exactly one `host` and one `certified_executor`. The executor cannot be supplied or rebuilt by the package input: it is copied only from the successful proof receipt. Runtime dependencies are derived transitively and included as exact `runtime_dependency` entries. The current host does not ship `System.IO.FileSystem.AccessControl` as a package dependency: Revit 2023/2024 resolve those APIs from .NET Framework, and Revit 2025 resolves them from the .NET 8 shared runtime. An unreferenced copy in a package is rejected.

The builder runs the host for Revit 2023/2024 as `net48` x64 and Revit 2025 as `net8.0-windows` x64 against that year's actual `RevitAPI.dll`. It inspects PE metadata, target-framework attributes, MVIDs, architecture, and embedded Revit API reference versions. A cross-year DLL or API is rejected. Every DLL is signed before its final size/hash receipt. After signing, the builder invokes the proof tool's strict `equivalence` command. Only the PE checksum, security-directory entry, required alignment padding, and a structurally valid Authenticode certificate table may differ from the proof-emitted executor; arbitrary overlay or managed-code changes are rejected.

Each target carries `safe_read_runtime_attestation.v1.json` plus its external pin. It uses only the exact backend static schema and binds the historical `host_*` tuple fields to the separately proofed, signed certified executor—not the transport host shell. Hashes use lowercase `sha256:<64 hex>` form. Dynamic host-instance, document, client, request, and attempt bindings remain runtime-only. Pin package metadata through a deployment-owned channel and pass that external value to verification/installation; never derive trust from the package being installed.

A releasable package must also retain durable source provenance that binds it to the exact committed source identities and archived source content used by the build. That provenance must travel with the release, be covered by the package trust chain, and be verified before installation. Its serialized shape belongs to the package version; this architecture note intentionally does not define a parallel schema.

## Verify, activate, and roll back

`verify_saferead_microhost_bundle.ps1` rejects missing/extra files, malformed or traversing paths, release/attestation drift, mixed year/framework/platform/API payloads, incorrect identity/XML, invalid signatures, and non-allowlisted signers.

`install_saferead_package_v2.ps1` (also reached by the compatibility `install_saferead_microhost_bundle.ps1` entry point) requires explicit SafeRead destination and Revit add-ins roots. It copies into a versioned stage, re-verifies after copy and promotion, then renders and verifies all three final `.addin` files before changing live activation state. Live manifest writes are recoverable; the active pointer changes only after all three succeed. Any partial-write failure restores the prior three manifests and pointer coherently. Rollback release IDs are regex-validated, resolved beneath the versioned releases root, and revalidated against their stored external attestation pin.

The installer protects every release parent and file, including the runtime-attestation JSON and pin, with protected ACLs granting only the current owner, LocalSystem, and Administrators. The host applies the same contract to its discovery parent and atomic publication file, and rejects inherited, broad-principal, or reparse-point state.

### OperatorDeploy admission

OperatorDeploy schema v3 provides the transactional activation path for this production identity. The release manifest reconciles the package layout explicitly: one evidence component maps the package root, and three Revit components map `targets/2023`, `targets/2024`, and `targets/2025`. The final assembly in each component is `payload/RevitOperator.SafeReadHost.dll`.

Create the admission receipt only after the exact OperatorDeploy manifest and final versioned release root are known:

```powershell
.\scripts\deploy\prepare_saferead_admission_receipt.ps1 `
  -BundleRoot <SAFE_READ_PACKAGE_ROOT> `
  -AttestationPinSha256 <EXTERNALLY_DELIVERED_PACKAGE_PIN> `
  -ManifestAssemblyRoot <FINAL_OPERATORDEPLOY_RELEASE_ROOT> `
  -CoordinationRoot <EXTERNAL_COORDINATION_ROOT> `
  -OutputPath <EXTERNAL_RECEIPT_PATH> `
  -OperatorDeployManifestPath <SCHEMA_V3_OPERATORDEPLOY_MANIFEST>
```

Supplying `-OperatorDeployManifestPath` emits `revit-operator.safe-read-admission-receipt.v2`. The receipt pins the exact manifest bytes and final layout. Receipt serialization and `.addin` rendering are canonical UTF-8 without a byte-order mark; the XML declaration also says `utf-8`, so PowerShell 7 and Windows PowerShell 5.1 produce the same bytes.

The deployment coordinator must deliver the receipt's SHA-256 and the package pin independently of the package and manifest. OperatorDeploy requires those external values on install, update, repair, and bundle-only validation, copies the admitted receipt into the release, and persists its identity in state and the activation journal. It then independently recomputes package, proof, PE, runtime-attestation, manifest, and final-layout facts immediately before activation and rechecks them during installed validation, repair, rollback, and crash recovery.

The legacy receipt-v1 standalone installer path remains available. Receipt v2 is the required contract for production SafeRead activation through OperatorDeploy.

## CI and remaining release boundary

The Windows pull-request lane is hermetic: it runs the 168 production-host tests, executes the strict JSON parser vectors under both .NET Framework 4.8 and .NET 8, runs generated-reference proof positives and falsifiers, and runs package security tests with Pester installed independently under PowerShell 7 and Windows PowerShell 5.1. Its result explicitly marks the installed-Revit inventory and eight real-API regenerated adversaries as outside that lane.

The opt-in `safe-read-installed-revit-release` job runs only on a self-hosted runner labelled `revit-certified`. It fails if any Revit 2023/2024/2025 API prerequisite is missing, then runs both strict-parser targets, all three host builds, the full 41-negative/eight-regenerated production proof gate, and one bidirectional cross-edition fixture: PowerShell 7 builds a real three-year package that Windows PowerShell 5.1 verifies, then Windows PowerShell 5.1 builds one that PowerShell 7 verifies. Package pins are build-instance-specific trust values; this gate verifies cross-edition construction and consumption, not byte-for-byte reproducibility. It never silently converts a missing release prerequisite into a skip.

Passing source builds, proof checks, and package tests is source/package evidence only. Real Authenticode signing, installation, loaded-DLL identity, backend deployment/attestation publication, feature-policy exposure, and real Revit/UI behavior remain unverified until a separate controlled release and GUI test. The current certification policy remains fail-closed and does not expose SafeRead.
