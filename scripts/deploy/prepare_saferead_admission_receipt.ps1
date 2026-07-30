[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$AttestationPinSha256,
  [Parameter(Mandatory)][string]$ManifestAssemblyRoot,
  [Parameter(Mandatory)][string]$CoordinationRoot,
  [Parameter(Mandatory)][string]$OutputPath,
  [string]$OperatorDeployManifestPath
)

$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadPackageV2.psm1') -Force

$outputFull=Resolve-SafeReadAdmissionOutputPath -OutputPath $OutputPath -CoordinationRoot $CoordinationRoot -BundleRoot $BundleRoot -ManifestAssemblyRoot $ManifestAssemblyRoot
$receipt=New-SafeReadAdmissionReceipt -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ManifestAssemblyRoot $ManifestAssemblyRoot -OperatorDeployManifestPath $OperatorDeployManifestPath
$published=Publish-SafeReadAdmissionReceipt -OutputPath $outputFull -CoordinationRoot $CoordinationRoot -BundleRoot $BundleRoot -ManifestAssemblyRoot $ManifestAssemblyRoot -Receipt $receipt
if($published -cne $outputFull){throw 'SafeRead admission receipt publication returned an unexpected path.'}
[void](Assert-SafeReadAdmissionReceipt -ReceiptPath $outputFull -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ExpectedManifestAssemblyRoot $ManifestAssemblyRoot -OperatorDeployManifestPath $OperatorDeployManifestPath)
[pscustomobject]@{receiptPath=$outputFull;receiptSha256=Get-SafeReadSha256 $outputFull;releaseId=[string]$receipt.releaseId;manifestAssemblyRoot=[string]$receipt.manifestAssemblyRoot}
