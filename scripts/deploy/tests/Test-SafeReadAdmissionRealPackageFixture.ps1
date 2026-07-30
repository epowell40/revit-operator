[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$AttestationPinSha256,
  [Parameter(Mandatory)][string]$ManifestAssemblyRoot,
  [Parameter(Mandatory)][string]$CoordinationRoot,
  [Parameter(Mandatory)][string]$ReceiptPath,
  [switch]$Prepare
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '..\SafeReadPackageV2.psm1') -Force
$safeReadModule=Get-Module SafeReadPackageV2
$signatureVerifier={param($Path)[pscustomobject]@{Status='Valid';Thumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}}
$receiptFull=[IO.Path]::GetFullPath($ReceiptPath)
if($Prepare){
  $receiptFull=Resolve-SafeReadAdmissionOutputPath -OutputPath $ReceiptPath -CoordinationRoot $CoordinationRoot -BundleRoot $BundleRoot -ManifestAssemblyRoot $ManifestAssemblyRoot
  $receipt=&$safeReadModule {param($BundleRoot,$AttestationPinSha256,$ManifestAssemblyRoot,$SignatureVerifier)New-SafeReadAdmissionReceiptCore -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ManifestAssemblyRoot $ManifestAssemblyRoot -SignatureVerifier $SignatureVerifier} $BundleRoot $AttestationPinSha256 $ManifestAssemblyRoot $signatureVerifier
  [IO.File]::WriteAllText($receiptFull,(ConvertTo-SafeReadCanonicalJson $receipt),[Text.UTF8Encoding]::new($false))
}
$verified=&$safeReadModule {param($ReceiptPath,$BundleRoot,$AttestationPinSha256,$ManifestAssemblyRoot,$SignatureVerifier)Assert-SafeReadAdmissionReceiptCore -ReceiptPath $ReceiptPath -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ExpectedManifestAssemblyRoot $ManifestAssemblyRoot -SignatureVerifier $SignatureVerifier} $receiptFull $BundleRoot $AttestationPinSha256 $ManifestAssemblyRoot $signatureVerifier
[pscustomobject]@{edition=[string]$PSVersionTable.PSEdition;version=[string]$PSVersionTable.PSVersion;releaseId=[string]$verified.releaseId;receiptSha256=Get-SafeReadSha256 $receiptFull;targets=@($verified.targets).Count}
