[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$AttestationPinSha256
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '..\SafeReadPackageV2.psm1') -Force
$receipt=Assert-SafeReadBundle `
  -BundleRoot $BundleRoot `
  -AttestationPinSha256 $AttestationPinSha256 `
  -SignatureVerifier {param($Path)[pscustomobject]@{Status='Valid';Thumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}}
[pscustomobject]@{edition=[string]$PSVersionTable.PSEdition;version=[string]$PSVersionTable.PSVersion;releaseId=$receipt.ReleaseId;targets=@($receipt.Targets).Count}
