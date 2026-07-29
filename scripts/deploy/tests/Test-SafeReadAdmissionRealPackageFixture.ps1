[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$AttestationPinSha256,
  [Parameter(Mandatory)][string]$ManifestAssemblyRoot,
  [Parameter(Mandatory)][string]$ReceiptPath,
  [switch]$Prepare
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '..\SafeReadPackageV2.psm1') -Force
$signatureVerifier={param($Path)[pscustomobject]@{Status='Valid';Thumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}}
$receiptFull=[IO.Path]::GetFullPath($ReceiptPath)
if($Prepare){
  if(Test-Path -LiteralPath $receiptFull){throw "Refusing to overwrite admission fixture receipt: $receiptFull"}
  $receipt=New-SafeReadAdmissionReceipt -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ManifestAssemblyRoot $ManifestAssemblyRoot -SignatureVerifier $signatureVerifier
  [IO.File]::WriteAllText($receiptFull,(ConvertTo-SafeReadCanonicalJson $receipt),[Text.UTF8Encoding]::new($false))
}
$verified=Assert-SafeReadAdmissionReceipt -ReceiptPath $receiptFull -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ExpectedManifestAssemblyRoot $ManifestAssemblyRoot -SignatureVerifier $signatureVerifier
[pscustomobject]@{edition=[string]$PSVersionTable.PSEdition;version=[string]$PSVersionTable.PSVersion;releaseId=[string]$verified.releaseId;receiptSha256=Get-SafeReadSha256 $receiptFull;targets=@($verified.targets).Count}
