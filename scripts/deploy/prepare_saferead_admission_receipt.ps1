[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$AttestationPinSha256,
  [Parameter(Mandatory)][string]$ManifestAssemblyRoot,
  [Parameter(Mandatory)][string]$CoordinationRoot,
  [Parameter(Mandatory)][string]$OutputPath
)

$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadPackageV2.psm1') -Force

$outputFull=Resolve-SafeReadAdmissionOutputPath -OutputPath $OutputPath -CoordinationRoot $CoordinationRoot -BundleRoot $BundleRoot -ManifestAssemblyRoot $ManifestAssemblyRoot
$receipt=New-SafeReadAdmissionReceipt -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ManifestAssemblyRoot $ManifestAssemblyRoot
[IO.File]::WriteAllText($outputFull,(ConvertTo-SafeReadCanonicalJson $receipt),[Text.UTF8Encoding]::new($false))
[void](Assert-SafeReadAdmissionReceipt -ReceiptPath $outputFull -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ExpectedManifestAssemblyRoot $ManifestAssemblyRoot)
[pscustomobject]@{receiptPath=$outputFull;receiptSha256=Get-SafeReadSha256 $outputFull;releaseId=[string]$receipt.releaseId;manifestAssemblyRoot=[string]$receipt.manifestAssemblyRoot}
