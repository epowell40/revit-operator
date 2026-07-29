[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$AttestationPinSha256,
  [scriptblock]$SignatureVerifier
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadMicrohost.psm1') -Force
$receipt = Assert-SafeReadBundle -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -SignatureVerifier $SignatureVerifier
$receipt | Format-List
Write-Host 'SafeRead microhost bundle verification passed.'
