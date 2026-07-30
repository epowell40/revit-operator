[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$AttestationPinSha256,
  [string]$AdmissionReceiptPath,
  [string]$ExpectedManifestAssemblyRoot
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadPackageV2.psm1') -Force
$receipt = Assert-SafeReadBundle -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256
$receipt | Format-List
if([string]::IsNullOrWhiteSpace($AdmissionReceiptPath) -xor [string]::IsNullOrWhiteSpace($ExpectedManifestAssemblyRoot)){throw 'AdmissionReceiptPath and ExpectedManifestAssemblyRoot must be supplied together.'}
if(-not[string]::IsNullOrWhiteSpace($AdmissionReceiptPath)){
  $admission=Assert-SafeReadAdmissionReceipt -ReceiptPath $AdmissionReceiptPath -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ExpectedManifestAssemblyRoot $ExpectedManifestAssemblyRoot
  $admission | Format-List
  Write-Host 'SafeRead admission receipt verification passed.'
}
Write-Host 'SafeRead package verification passed.'
