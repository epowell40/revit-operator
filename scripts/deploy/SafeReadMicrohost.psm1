Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'SafeReadPackageV2.psm1')
return

$script:SafeReadSchema = 'safe-read-microhost-release/v1'
$script:SafeReadAttestationSchema = 'safe-read-microhost-attestation/v1'
$script:SafeReadDllName = 'RevitBridge.SafeRead.Addin.dll'
$script:SafeReadManifestName = 'RevitBridge.SafeRead.addin.template'
$script:SafeReadAssemblyToken = '__SAFE_READ_ASSEMBLY_PATH__'
$script:MainRevitOperatorAddInId = 'B2883307-2852-4740-9833-281048674F77'

function Get-SafeReadSha256 {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function ConvertTo-SafeReadObject {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function ConvertTo-SafeReadHashtable {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$InputObject)
  $result = [ordered]@{}
  foreach ($property in $InputObject.PSObject.Properties) {
    if ($null -eq $property.Value) { $result[$property.Name] = $null; continue }
    if ($property.Value -is [System.Collections.IEnumerable] -and $property.Value -isnot [string]) {
      $result[$property.Name] = @($property.Value | ForEach-Object {
        if ($_.PSObject -and $_.PSObject.Properties.Count -gt 0) { ConvertTo-SafeReadHashtable $_ } else { $_ }
      })
    } elseif ($property.Value -is [System.Management.Automation.PSCustomObject]) {
      $result[$property.Name] = ConvertTo-SafeReadHashtable $property.Value
    } else { $result[$property.Name] = $property.Value }
  }
  $result
}

function ConvertTo-SafeReadCanonicalJson {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$InputObject)
  # Input is deliberately constructed in ordered property order; Compress makes the byte receipt unambiguous.
  ($InputObject | ConvertTo-Json -Depth 12 -Compress)
}

function Get-SafeReadExpectedTarget {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$RevitYear)
  switch ($RevitYear) {
    '2023' { return @{ Framework = 'net48'; ApiVersion = '2023' } }
    '2024' { return @{ Framework = 'net48'; ApiVersion = '2024' } }
    '2025' { return @{ Framework = 'net8.0-windows'; ApiVersion = '2025' } }
    default { throw "Unsupported SafeRead Revit year '$RevitYear'. Only 2023, 2024, and 2025 are permitted." }
  }
}

function Assert-SafeReadIdentity {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$Identity)
  foreach ($required in @('Name', 'AddInId', 'FullClassName', 'VendorId', 'VendorDescription')) {
    if ([string]::IsNullOrWhiteSpace([string]$Identity.$required)) { throw "SafeRead add-in identity is missing '$required'." }
  }
  $guid = [guid]::Empty
  if (-not [guid]::TryParse([string]$Identity.AddInId, [ref]$guid)) { throw "SafeRead AddInId is not a GUID: $($Identity.AddInId)" }
  if ($guid.Guid.ToUpperInvariant() -eq $script:MainRevitOperatorAddInId) { throw 'SafeRead AddInId must be distinct from the main RevitOperator manifest identity.' }
  if ($Identity.FullClassName -notmatch '^RevitBridge\.SafeRead\.') { throw "SafeRead FullClassName must be under RevitBridge.SafeRead: $($Identity.FullClassName)" }
}

function Assert-SafeReadRelativePath {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  if ([IO.Path]::IsPathRooted($Path) -or $Path -match '(^|[\\/])\.\.([\\/]|$)' -or $Path -match ':') { throw "Unsafe SafeRead relative path: $Path" }
  if ($Path -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$') { throw "Invalid SafeRead relative path: $Path" }
}

function Get-SafeReadDefaultSignature {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  [pscustomobject]@{
    Status = [string]$signature.Status
    Thumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
  }
}

function Invoke-SafeReadSignatureVerification {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string[]]$AllowedSignerThumbprints,
    [scriptblock]$SignatureVerifier
  )
  $result = if ($SignatureVerifier) { & $SignatureVerifier $Path } else { Get-SafeReadDefaultSignature -Path $Path }
  if ($null -eq $result -or [string]$result.Status -ne 'Valid') { throw "SafeRead assembly signature is not Valid: $Path" }
  $thumbprint = ([string]$result.Thumbprint).Replace(' ', '').ToUpperInvariant()
  $allowed = @($AllowedSignerThumbprints | ForEach-Object { ([string]$_).Replace(' ', '').ToUpperInvariant() })
  if ([string]::IsNullOrWhiteSpace($thumbprint) -or $allowed -notcontains $thumbprint) { throw "SafeRead assembly signer is not in the release allowlist: $Path" }
}

function New-SafeReadAddinTemplate {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$Identity)
  Assert-SafeReadIdentity -Identity $Identity
  @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>$($Identity.Name)</Name>
    <Assembly>$script:SafeReadAssemblyToken</Assembly>
    <FullClassName>$($Identity.FullClassName)</FullClassName>
    <AddInId>$($Identity.AddInId)</AddInId>
    <VendorId>$($Identity.VendorId)</VendorId>
    <VendorDescription>$($Identity.VendorDescription)</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
}

function Assert-SafeReadBundle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$BundleRoot,
    [Parameter(Mandatory)][string]$AttestationPinSha256,
    [scriptblock]$SignatureVerifier
  )
  $root = (Resolve-Path -LiteralPath $BundleRoot).Path
  $manifestPath = Join-Path $root 'release-manifest.json'
  $attestationPath = Join-Path $root 'deployment-attestation.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'SafeRead bundle is missing release-manifest.json.' }
  if (-not (Test-Path -LiteralPath $attestationPath -PathType Leaf)) { throw 'SafeRead bundle is missing deployment-attestation.json.' }
  if ((Get-SafeReadSha256 $attestationPath) -ne $AttestationPinSha256.ToUpperInvariant()) { throw 'SafeRead deployment attestation pin does not match this bundle.' }
  $release = ConvertTo-SafeReadObject $manifestPath
  $attestation = ConvertTo-SafeReadObject $attestationPath
  if ($release.schemaVersion -ne $script:SafeReadSchema) { throw 'Unsupported SafeRead release manifest schema.' }
  if ($attestation.schemaVersion -ne $script:SafeReadAttestationSchema) { throw 'Unsupported SafeRead deployment attestation schema.' }
  if ([string]::IsNullOrWhiteSpace($release.releaseId) -or $release.releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'SafeRead releaseId is invalid.' }
  if ($attestation.releaseId -ne $release.releaseId -or $attestation.releaseManifestSha256 -ne (Get-SafeReadSha256 $manifestPath)) { throw 'SafeRead deployment attestation does not bind the exact release manifest.' }
  $allowed = @($release.allowedSignerThumbprints)
  if ($allowed.Count -eq 0) { throw 'SafeRead release manifest has no allowed signer thumbprints.' }
  $targets = @($release.targets)
  if ($targets.Count -ne 3) { throw 'SafeRead release must contain exactly 2023, 2024, and 2025 targets.' }
  $seenYears = @{}; $seenIds = @{}
  $expectedRootNames = @('release-manifest.json', 'deployment-attestation.json', 'targets')
  $actualRootNames = @(Get-ChildItem -LiteralPath $root -Force | ForEach-Object Name | Sort-Object)
  if (Compare-Object -ReferenceObject ($expectedRootNames | Sort-Object) -DifferenceObject $actualRootNames) { throw 'SafeRead bundle root contains missing or extra entries.' }
  $targetContainer = Join-Path $root 'targets'
  $actualTargetEntries = @(Get-ChildItem -LiteralPath $targetContainer -Force | ForEach-Object Name | Sort-Object)
  if (Compare-Object -ReferenceObject @('2023', '2024', '2025') -DifferenceObject $actualTargetEntries) { throw 'SafeRead bundle contains missing or extra target directories.' }
  foreach ($target in $targets) {
    $year = [string]$target.revitYear
    if ($seenYears.ContainsKey($year)) { throw "SafeRead release repeats Revit year $year." }; $seenYears[$year] = $true
    $expected = Get-SafeReadExpectedTarget $year
    if ($target.framework -ne $expected.Framework -or $target.apiVersion -ne $expected.ApiVersion) { throw "SafeRead target $year has mixed year/framework/API metadata." }
    Assert-SafeReadIdentity $target.identity
    $addinId = ([guid]$target.identity.AddInId).Guid.ToUpperInvariant()
    if ($seenIds.ContainsKey($addinId)) { throw "SafeRead release reuses AddInId $addinId across targets." }; $seenIds[$addinId] = $true
    $targetRoot = Join-Path $root ("targets\\{0}" -f $year)
    if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) { throw "SafeRead target directory is missing: $year" }
    $files = @($target.files)
    $requiredFiles = @('payload/RevitBridge.SafeRead.Addin.dll', 'manifest/RevitBridge.SafeRead.addin.template')
    $declaredPaths = @($files | ForEach-Object { [string]$_.path } | Sort-Object)
    if ($files.Count -ne 2 -or (Compare-Object -ReferenceObject ($requiredFiles | Sort-Object) -DifferenceObject $declaredPaths)) { throw "SafeRead target $year does not declare the exact required file tree." }
    $actualPaths = @(Get-ChildItem -LiteralPath $targetRoot -File -Recurse | ForEach-Object { $_.FullName.Substring($targetRoot.Length).TrimStart([char]92,[char]47).Replace([char]92,[char]47) } | Sort-Object)
    if (Compare-Object -ReferenceObject ($requiredFiles | Sort-Object) -DifferenceObject $actualPaths) { throw "SafeRead target $year has missing or extra payload files." }
    foreach ($file in $files) {
      Assert-SafeReadRelativePath ([string]$file.path)
      $fullPath = Join-Path $targetRoot ($file.path.Replace('/', '\\'))
      if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "SafeRead target $year is missing $($file.path)." }
      if ((Get-SafeReadSha256 $fullPath) -ne ([string]$file.sha256).ToUpperInvariant()) { throw "SafeRead target $year hash mismatch for $($file.path)." }
      if ([int64]$file.sizeBytes -ne (Get-Item -LiteralPath $fullPath).Length) { throw "SafeRead target $year size mismatch for $($file.path)." }
    }
    $dllPath = Join-Path $targetRoot 'payload\RevitBridge.SafeRead.Addin.dll'
    Invoke-SafeReadSignatureVerification -Path $dllPath -AllowedSignerThumbprints $allowed -SignatureVerifier $SignatureVerifier
    $templatePath = Join-Path $targetRoot 'manifest\RevitBridge.SafeRead.addin.template'
    $template = Get-Content -LiteralPath $templatePath -Raw
    foreach ($needle in @($target.identity.Name, $target.identity.AddInId, $target.identity.FullClassName, $target.identity.VendorId, $script:SafeReadAssemblyToken)) {
      if ($template -notlike "*$needle*") { throw "SafeRead target $year manifest template does not match its declared identity." }
    }
  }
  if (($seenYears.Keys | Sort-Object) -join ',' -ne '2023,2024,2025') { throw 'SafeRead release does not contain every supported Revit year.' }
  [pscustomobject]@{ ReleaseId = $release.releaseId; ReleaseManifestSha256 = Get-SafeReadSha256 $manifestPath; AttestationSha256 = Get-SafeReadSha256 $attestationPath; Targets = $targets }
}

function Write-SafeReadAtomicFile {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = Join-Path $directory ('.{0}.{1}.tmp' -f (Split-Path -Leaf $Path), [guid]::NewGuid().ToString('N'))
  [IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $Path) {
    # File.Replace is atomic on the target volume. Keep its recovery copy rather than deleting it implicitly.
    $backup = "{0}.previous.{1}" -f $Path, [guid]::NewGuid().ToString('N')
    [IO.File]::Replace($temporary, $Path, $backup)
  } else { Move-Item -LiteralPath $temporary -Destination $Path }
}

Export-ModuleMember -Function Assert-SafeReadBundle,ConvertTo-SafeReadCanonicalJson,ConvertTo-SafeReadHashtable,ConvertTo-SafeReadObject,Get-SafeReadExpectedTarget,Get-SafeReadSha256,New-SafeReadAddinTemplate,Write-SafeReadAtomicFile
