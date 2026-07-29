[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Install')][string]$BundleRoot,
  [Parameter(Mandatory, ParameterSetName = 'Install')][string]$AttestationPinSha256,
  [Parameter(Mandatory, ParameterSetName = 'Rollback')][string]$RollbackReleaseId,
  [Parameter(Mandatory)][string]$DestinationRoot,
  [Parameter(Mandatory)][string]$RevitAddinsRoot,
  [scriptblock]$SignatureVerifier
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadMicrohost.psm1') -Force

function Set-SafeReadRevitManifests {
  param([Parameter(Mandatory)][string]$ReleaseRoot, [Parameter(Mandatory)]$Receipt)
  foreach ($target in @($Receipt.Targets)) {
    $yearDirectory = Join-Path $RevitAddinsRoot ([string]$target.revitYear)
    New-Item -ItemType Directory -Force -Path $yearDirectory | Out-Null
    $template = Get-Content -LiteralPath (Join-Path $ReleaseRoot ("targets\\{0}\\manifest\\RevitBridge.SafeRead.addin.template" -f $target.revitYear)) -Raw
    $assembly = Join-Path $ReleaseRoot ("targets\\{0}\\payload\\RevitBridge.SafeRead.Addin.dll" -f $target.revitYear)
    $output = $template.Replace('__SAFE_READ_ASSEMBLY_PATH__', [Security.SecurityElement]::Escape($assembly))
    Write-SafeReadAtomicFile -Path (Join-Path $yearDirectory 'RevitBridge.SafeRead.addin') -Content $output
  }
}

New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
$releasesRoot = Join-Path $DestinationRoot 'releases'; New-Item -ItemType Directory -Force -Path $releasesRoot | Out-Null
$pinsRoot = Join-Path $DestinationRoot 'pins'; New-Item -ItemType Directory -Force -Path $pinsRoot | Out-Null
$activePath = Join-Path $DestinationRoot 'active-release.json'
if ($PSCmdlet.ParameterSetName -eq 'Rollback') {
  $releaseRoot = Join-Path $releasesRoot $RollbackReleaseId
  if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) { throw "SafeRead rollback release does not exist: $RollbackReleaseId" }
  $pin = (ConvertTo-SafeReadObject (Join-Path $pinsRoot ("{0}.json" -f $RollbackReleaseId))).attestationPinSha256
  $receipt = Assert-SafeReadBundle -BundleRoot $releaseRoot -AttestationPinSha256 $pin -SignatureVerifier $SignatureVerifier
} else {
  $sourceReceipt = Assert-SafeReadBundle -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -SignatureVerifier $SignatureVerifier
  $releaseRoot = Join-Path $releasesRoot $sourceReceipt.ReleaseId
  if (Test-Path -LiteralPath $releaseRoot) { throw "SafeRead release already installed: $($sourceReceipt.ReleaseId)" }
  $stage = Join-Path $releasesRoot ('.{0}.{1}.staging' -f $sourceReceipt.ReleaseId, [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    Get-ChildItem -LiteralPath (Resolve-Path -LiteralPath $BundleRoot).Path -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force }
    $receipt = Assert-SafeReadBundle -BundleRoot $stage -AttestationPinSha256 $AttestationPinSha256 -SignatureVerifier $SignatureVerifier
    Move-Item -LiteralPath $stage -Destination $releaseRoot
    $receipt = Assert-SafeReadBundle -BundleRoot $releaseRoot -AttestationPinSha256 $AttestationPinSha256 -SignatureVerifier $SignatureVerifier
    [IO.File]::WriteAllText((Join-Path $pinsRoot ("{0}.json" -f $receipt.ReleaseId)), (ConvertTo-SafeReadCanonicalJson ([ordered]@{ attestationPinSha256 = $AttestationPinSha256.ToUpperInvariant() })), [Text.UTF8Encoding]::new($false))
  } catch { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }; throw }
}
# The activation pointer is a one-file atomic replacement. Revit manifests are SafeRead-only and never alter RevitBridge.addin.
Write-SafeReadAtomicFile -Path $activePath -Content (ConvertTo-SafeReadCanonicalJson ([ordered]@{ releaseId = $receipt.ReleaseId; releaseManifestSha256 = $receipt.ReleaseManifestSha256 }))
Set-SafeReadRevitManifests -ReleaseRoot $releaseRoot -Receipt $receipt
Write-Host "SafeRead microhost active release: $($receipt.ReleaseId)"
