# OperatorDeploy architecture and release notes

## Current portable channel

The portable channel is a transactional, per-user deployment utility embedded in a complete workstation package. It uses versioned release directories rather than overwriting the loaded Revit add-in directory in place.

- Installed releases: `%LOCALAPPDATA%\RevitOperator\releases\<releaseVersion>\`
- Deployment state: `%LOCALAPPDATA%\RevitOperator\deployment\state.json`
- Deployment logs: `%LOCALAPPDATA%\RevitOperator\logs\deployment\`
- Existing machine configuration: `%LOCALAPPDATA%\RevitOperator\config\` (preserved)
- Existing user workspace and auth cache: `%LOCALAPPDATA%\RevitOperator\Workspace\` and `config\` (preserved)
- Revit manifest: `%APPDATA%\Autodesk\Revit\Addins\<year>\RevitBridge.addin`

The `.addin` file points at a verified versioned release. Updating or rolling back changes that small pointer only after the target payload passes SHA-256 validation. This avoids a mixed set of `RevitBridge`, logic, and common assemblies.

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
