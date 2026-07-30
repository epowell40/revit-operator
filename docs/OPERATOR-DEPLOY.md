# OperatorDeploy architecture and release notes

## Current portable channel

The portable channel is a transactional, per-user deployment utility embedded in a complete workstation package. It uses versioned release directories rather than overwriting the loaded Revit add-in directory in place.

- Installed releases: `%LOCALAPPDATA%\RevitOperator\releases\<releaseVersion>\`
- Deployment state: `%LOCALAPPDATA%\RevitOperator\deployment\state.json`
- Activation journal: `%LOCALAPPDATA%\RevitOperator\deployment\activation-journal.v1.json`
- Deployment logs: `%LOCALAPPDATA%\RevitOperator\logs\deployment\`
- Existing machine configuration: `%LOCALAPPDATA%\RevitOperator\config\` (preserved)
- Existing user workspace and auth cache: `%LOCALAPPDATA%\RevitOperator\Workspace\` and `config\` (preserved)
- Revit manifests: `%APPDATA%\Autodesk\Revit\Addins\<year>\<profile.manifestFileName>`

Each `.addin` file points at a verified versioned release. Updating or rolling back changes the complete per-year manifest set only after the target payload passes SHA-256 validation. This avoids a mixed set of primary bridge, SafeRead host, logic, and common assemblies.

## Manifest schemas and add-in ownership

Schema v1 remains supported and retains its original single-add-in contract: a `revit-addin` component activates `RevitBridge.dll` through `RevitBridge.addin`, class `RevitBridge.App`, and AddInId `B2883307-2852-4740-9833-281048674F77`.

Schema v2 declares generic `revitAddinProfiles` and makes each `revit-addin` component reference one profile with `revitAddinProfileId`. A profile owns only these declarative values:

```json
{
  "id": "safe-read",
  "manifestFileName": "RevitOperator.SafeReadHost.addin",
  "assemblyPath": "payload/RevitOperator.SafeReadHost.dll",
  "type": "Application",
  "name": "Revit Operator Safe Read Host",
  "fullClassName": "RevitOperator.SafeReadHost.App",
  "addInId": "AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E",
  "vendorId": "BIMT",
  "vendorDescription": "BIMTools Revit Operator Safe Read Host"
}
```

Profile IDs, manifest filenames, and AddInIds must be unique. Paths and basenames are traversal-safe, every represented Revit year must contain exactly one component for every declared profile, and `--revit-version <year>` selects that whole per-year set. Unknown or duplicate JSON properties are rejected. The SafeRead manifest filename, class, assembly path, and assembly basename are reserved case-insensitively; its AddInId is reserved by parsed GUID value, so alternate `B`, `N`, `P`, `X`, whitespace, or case forms cannot evade the reservation. Any profile that collides with one of those markers must match every canonical field above exactly and use schema v3 with external admission. The rendered XML and receipt field both use the exact uppercase `D` AddInId shown above; cosmetic, textual-alias, or case-only drift is rejected.

Required components must declare at least one file. An optional component may declare zero files for compatibility and is treated as a directory-less no-op: staging, preservation, installed validation, and SafeRead exact inventory do not create or require an empty component directory.

Schema v3 is required for the exact production SafeRead identity shown above. A schema-v3 SafeRead release must also declare one `safe-read-evidence` component, three `revit-addin` components for Revit 2023/2024/2025, and this admission mapping:

```json
{
  "safeReadAdmission": {
    "schema": "revit-operator.operator-deploy-safe-read.v1",
    "profileId": "safe-read",
    "packageRoot": "SafeReadPackage-<release>",
    "evidenceComponentId": "safe-read-evidence",
    "targets": [
      { "revitYear": "2023", "componentId": "safe-read-2023" },
      { "revitYear": "2024", "componentId": "safe-read-2024" },
      { "revitYear": "2025", "componentId": "safe-read-2025" }
    ]
  }
}
```

Each target component maps the package's exact `targets/<year>` tree to the final component directory and activates `payload/RevitOperator.SafeReadHost.dll`. Filtering a production SafeRead deployment to one Revit year is rejected: admission and activation cover all three years as one unit. Generic non-SafeRead v1/v2 releases remain compatible.

OperatorDeploy serializes operations through one named deployment mutex. State schema v3 records the exact installer-owned manifest path, assembly path, identity, and manifest hash. Before the first live control mutation, activation validates ownership and rejects reparse points, writes a durable journal containing only the exact controls the transaction intends to change, and records their before/after fingerprints. Each write or deletion uses compare-and-swap semantics, the complete target set is validated, and state is committed last. A foreign control created or modified during activation is never overwritten or removed.

On startup, an interrupted transaction is recovered before any command proceeds and only while Revit is closed. Recovery first verifies that every control still matches either its journaled before-image or the transaction's intended after-image, then restores transaction changes with state restored last. If any control has a third-party fingerprint, recovery alters nothing, moves the journal to `activation-journal.quarantine-*.json`, and blocks later deployment operations pending manual inspection. Once state and all controls match the committed after-images, the journal is retired. Schema-v1/v2 state is migrated when the next successful operation establishes schema-v3 ownership.

Installed state has one global `currentRelease`. Consequently, `rollback --revit-version <year>` is rejected; rollback must switch the complete global release. The year filter remains available for install, update, repair, validation selection, and dry-run planning.

### SafeRead admission trust boundary

Production SafeRead install, update, repair, and bundle-only validation require all three external command-line inputs:

```text
--safe-read-admission-receipt <absolute-external-path>
--safe-read-admission-receipt-sha256 sha256:<64-lowercase-hex>
--safe-read-package-pin-sha256 sha256:<64-lowercase-hex>
```

The receipt and both trust pins must come from deployment coordination outside the package, the complete `%LOCALAPPDATA%\RevitOperator` managed product tree (including deployment state and every sibling release), and the Revit add-ins tree. OperatorDeploy never reads a trusted receipt hash or package pin from the release manifest. The receipt path must be one canonical absolute path without dot-segment aliases; Windows device and NT object-manager namespaces are rejected. OperatorDeploy opens the receipt once through a stable handle that denies concurrent writes and deletion, resolves the handle's final long DOS/UNC path, binds its volume/file identity and metadata before and after the read, and applies the external-root checks to that resolved object. Reparse points and files with more than one hard link are rejected. An 8.3 or other alias cannot change the boundary decision, and an unsupported filesystem/UNC provider that cannot supply the required Windows identity fails closed.

The receipt schema is `revit-operator.safe-read-admission-receipt.v2`. It binds the exact OperatorDeploy manifest bytes, package root, three target mappings, source/proof/runtime facts, final rendered manifest facts, and the exact final layout hash. Immediately before activation, OperatorDeploy independently re-hashes the final staged tree, checks exact file sets and proof/package records, re-inspects host and executor PE facts, revalidates runtime-attestation bindings, regenerates all three `.addin` manifests, and compares the receipt's final-layout hash. Source-package inventory is enumerated explicitly without recursive traversal: every directory or file is checked for reparse status before descent or later admitted reads, and the inventory is checked again afterward. The managed candidate release is also an exact allowlist: it may contain only `manifest.json`, the persisted receipt, every declared component file, and their implied directories. Reparse points are rejected from the managed product root through the release root and at every descendant entry; the exact layout is checked both before and after admission reads.

The admitted receipt bytes are copied to `<release>\.operator-deploy\safe-read-admission.receipt.v2.json`. Their external hash, package pin, manifest hash, layout hash, and per-year identities are persisted in both deployment state and the activation journal. Installed validation, repair, rollback, and crash recovery reverify that binding. A missing external pin, stale or detached receipt, wrong release root/year, copied tree, extra/missing file, manifest drift, payload tamper, or replayed journal fails closed before activation. If an interrupted candidate no longer verifies after one or more live controls were written, recovery first CAS-restores or disables transaction-owned controls, preserves foreign controls and every candidate-root slot for inspection, handles state last, and only then quarantines the journal.

This gate consumes the independently produced SafeRead proof and admission receipt. It does not itself authorize a tool, expose a route, or establish publisher authenticity from SHA-256 alone.

## Commands and exit behavior

```text
OperatorDeploy.exe install --manifest manifest.json
OperatorDeploy.exe update --manifest manifest.json
OperatorDeploy.exe validate
OperatorDeploy.exe validate --manifest manifest.json --bundle-only
OperatorDeploy.exe repair --manifest manifest.json
OperatorDeploy.exe rollback
OperatorDeploy.exe status
OperatorDeploy.exe diagnostics
```

Append the three external SafeRead options above to `install`, `update`, `repair`, or `validate --bundle-only` when the manifest contains the production SafeRead identity. Installed `validate` and `rollback` load and reverify the binding already persisted in state.

The utility returns stable nonzero exit codes for invalid arguments, invalid manifests, hash mismatches, blocked Revit processes, permission failures, installation failures, validation failures, missing installed state, and unsupported operations. Each run also writes `last-result.json`.

## Security boundary

SHA-256 detects corruption but does not establish publisher authenticity. The release builder supports Authenticode signing of `OperatorDeploy.exe` with a certificate selected by thumbprint. Signing is a build-machine operation; the private key must never be copied to the target workstation or repository.

Do not enable automatic internet download-and-execute until all of these are implemented and enforced:

1. `OperatorDeploy.exe` is Authenticode-signed and its signature is verified before first use.
2. Release payload binaries are signed where practical.
3. Update metadata is authenticated, preferably by a detached signed manifest with an embedded public verification key.
4. Update transport is HTTPS and redirect destinations are restricted to an allowlist.
5. Downgrade, replay, and incompatible-backend protections are enforced.

An EV certificate stored on a hardware token is suitable for an interactive release workstation. It is not automatically suitable for unattended CI because PIN entry and token presence are intentionally interactive. Cloud signing or a managed signing service is the later unattended-release option.

## Build

Unsigned local build:

```powershell
.\scripts\deploy\build_operator_deploy.ps1 -Configuration Release
```

Interactive hardware-token signing:

```powershell
.\scripts\deploy\build_operator_deploy.ps1 -Configuration Release -SigningThumbprint <CERT_THUMBPRINT> -SignToolPath <PATH_TO_SIGNTOOL.EXE>
```

The script runs the updater tests before publishing a self-contained Windows x64 single-file executable. The signing path signs and then verifies the executable.

Sign a built Revit payload on the release workstation before manifest hashes are generated:

```powershell
.\scripts\deploy\sign_revit_operator_payload.ps1 -PayloadDir <PAYLOAD_DIRECTORY> -SigningThumbprint <CERT_THUMBPRINT> -SignToolPath <PATH_TO_SIGNTOOL.EXE>
```

This signs and verifies only the first-party `RevitBridge*.dll` assemblies. The hardware-token private key remains on the release workstation; target workstations receive only signed binaries.

## Intentionally deferred

- Per-machine installation and MSI/Intune/SCCM deployment remain the IT-managed channel.
- Uninstall is deferred because safe ownership detection and retention rules must be finalized first.
- Automatic background installation is not supported: Revit must be closed before activation.
- Automatic internet update checks/downloads remain gated on signed update metadata.
