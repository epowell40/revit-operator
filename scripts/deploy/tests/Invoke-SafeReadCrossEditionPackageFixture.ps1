[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepositoryRoot,
  [Parameter(Mandatory)][string]$OutputRoot
)
$ErrorActionPreference='Stop'
$pwsh=(Get-Command pwsh -ErrorAction Stop).Source
$powershell=(Get-Command powershell.exe -ErrorAction Stop).Source
$root=[IO.Path]::GetFullPath($OutputRoot)
[IO.Directory]::CreateDirectory($root)|Out-Null

function Invoke-Edition([string]$Label,[string]$Exe,[string[]]$Arguments){
  $output=@(& $Exe @Arguments 2>&1)
  if($LASTEXITCODE -ne 0){throw "$Label failed with exit $LASTEXITCODE`: $([string]::Join(' | ',@($output)))"}
  $output|ForEach-Object{Write-Host $_}
}

$buildScript=Join-Path $PSScriptRoot 'Invoke-SafeReadRealPackageFixture.ps1'
$admissionFixture=Join-Path $PSScriptRoot 'Test-SafeReadAdmissionRealPackageFixture.ps1'
$ps7Root=Join-Path $root 'ps7-build';$ps7ReceiptPath=Join-Path $root 'ps7-build.receipt.json'
[IO.Directory]::CreateDirectory($ps7Root)|Out-Null
Invoke-Edition 'PS7 package build' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$buildScript,'-RepositoryRoot',$RepositoryRoot,'-OutputRoot',$ps7Root,'-ReceiptPath',$ps7ReceiptPath)
$ps7Receipt=Get-Content -LiteralPath $ps7ReceiptPath -Raw|ConvertFrom-Json
$ps7ManifestRoot=Join-Path $ps7Root ('future '+[char]0x00DC+' & installed release');$ps7AdmissionBy5=Join-Path $root 'ps7-package.admission.ps5.json';$ps7AdmissionBy7=Join-Path $root 'ps7-package.admission.ps7.json'
Invoke-Edition 'PS5 admission preparation for PS7 package' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$admissionFixture,'-Prepare','-BundleRoot',[string]$ps7Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps7Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps7ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps7AdmissionBy5)
Invoke-Edition 'PS7 admission preparation for PS7 package' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$admissionFixture,'-Prepare','-BundleRoot',[string]$ps7Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps7Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps7ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps7AdmissionBy7)
$ps7AdmissionHash5=(Get-FileHash -LiteralPath $ps7AdmissionBy5 -Algorithm SHA256).Hash;$ps7AdmissionHash7=(Get-FileHash -LiteralPath $ps7AdmissionBy7 -Algorithm SHA256).Hash
if($ps7AdmissionHash5 -cne $ps7AdmissionHash7){throw 'PS5 and PS7 produced different canonical admission receipts for the PS7 package.'}
Invoke-Edition 'PS5 verification of PS7 package and admission' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$admissionFixture,'-BundleRoot',[string]$ps7Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps7Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps7ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps7AdmissionBy7)

$ps5Root=Join-Path $root 'ps5-build';$ps5ReceiptPath=Join-Path $root 'ps5-build.receipt.json'
[IO.Directory]::CreateDirectory($ps5Root)|Out-Null
Invoke-Edition 'PS5 package build' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$buildScript,'-RepositoryRoot',$RepositoryRoot,'-OutputRoot',$ps5Root,'-ReceiptPath',$ps5ReceiptPath)
$ps5Receipt=Get-Content -LiteralPath $ps5ReceiptPath -Raw|ConvertFrom-Json
$ps5ManifestRoot=Join-Path $ps5Root ('future '+[char]0x00DC+' & installed release');$ps5AdmissionBy5=Join-Path $root 'ps5-package.admission.ps5.json';$ps5AdmissionBy7=Join-Path $root 'ps5-package.admission.ps7.json'
Invoke-Edition 'PS5 admission preparation for PS5 package' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$admissionFixture,'-Prepare','-BundleRoot',[string]$ps5Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps5Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps5ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps5AdmissionBy5)
Invoke-Edition 'PS7 admission preparation for PS5 package' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$admissionFixture,'-Prepare','-BundleRoot',[string]$ps5Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps5Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps5ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps5AdmissionBy7)
$ps5AdmissionHash5=(Get-FileHash -LiteralPath $ps5AdmissionBy5 -Algorithm SHA256).Hash;$ps5AdmissionHash7=(Get-FileHash -LiteralPath $ps5AdmissionBy7 -Algorithm SHA256).Hash
if($ps5AdmissionHash5 -cne $ps5AdmissionHash7){throw 'PS5 and PS7 produced different canonical admission receipts for the PS5 package.'}
Invoke-Edition 'PS7 verification of PS5 package and admission' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$admissionFixture,'-BundleRoot',[string]$ps5Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps5Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps5ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps5AdmissionBy5)

[pscustomobject]@{ps7Build=$ps7Receipt;ps5Build=$ps5Receipt;ps7PackageAdmissionSha256=('sha256:'+$ps7AdmissionHash7.ToLowerInvariant());ps5PackageAdmissionSha256=('sha256:'+$ps5AdmissionHash7.ToLowerInvariant());crossEditionVerified=$true}
