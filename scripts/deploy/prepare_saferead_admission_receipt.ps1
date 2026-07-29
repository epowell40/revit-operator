[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$AttestationPinSha256,
  [Parameter(Mandatory)][string]$ManifestAssemblyRoot,
  [Parameter(Mandatory)][string]$OutputPath,
  [scriptblock]$SignatureVerifier,
  [scriptblock]$AssemblyInspector
)

$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadPackageV2.psm1') -Force

$outputFull=[IO.Path]::GetFullPath($OutputPath)
if(Test-Path -LiteralPath $outputFull){throw "Refusing to overwrite an existing SafeRead admission receipt: $outputFull"}
$parent=Split-Path -Parent $outputFull
if(-not(Test-Path -LiteralPath $parent -PathType Container)){New-Item -ItemType Directory -Path $parent|Out-Null}
$receipt=New-SafeReadAdmissionReceipt -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ManifestAssemblyRoot $ManifestAssemblyRoot -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector
[IO.File]::WriteAllText($outputFull,(ConvertTo-SafeReadCanonicalJson $receipt),[Text.UTF8Encoding]::new($false))
[void](Assert-SafeReadAdmissionReceipt -ReceiptPath $outputFull -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ExpectedManifestAssemblyRoot $ManifestAssemblyRoot -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector)
[pscustomobject]@{receiptPath=$outputFull;receiptSha256=Get-SafeReadSha256 $outputFull;releaseId=[string]$receipt.releaseId;manifestAssemblyRoot=[string]$receipt.manifestAssemblyRoot}
