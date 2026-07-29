[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$AttestationPinSha256,
  [scriptblock]$SignatureVerifier,
  [scriptblock]$AssemblyInspector
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadPackageV2.psm1') -Force
$receipt = Assert-SafeReadBundle -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector
$receipt | Format-List
Write-Host 'SafeRead package verification passed.'
