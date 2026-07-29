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
$verifyScript=Join-Path $PSScriptRoot 'Test-SafeReadRealPackageFixture.ps1'
$ps7Root=Join-Path $root 'ps7-build';$ps7ReceiptPath=Join-Path $root 'ps7-build.receipt.json'
[IO.Directory]::CreateDirectory($ps7Root)|Out-Null
Invoke-Edition 'PS7 package build' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$buildScript,'-RepositoryRoot',$RepositoryRoot,'-OutputRoot',$ps7Root,'-ReceiptPath',$ps7ReceiptPath)
$ps7Receipt=Get-Content -LiteralPath $ps7ReceiptPath -Raw|ConvertFrom-Json
Invoke-Edition 'PS5 verification of PS7 package' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$verifyScript,'-BundleRoot',[string]$ps7Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps7Receipt.attestationPinSha256)

$ps5Root=Join-Path $root 'ps5-build';$ps5ReceiptPath=Join-Path $root 'ps5-build.receipt.json'
[IO.Directory]::CreateDirectory($ps5Root)|Out-Null
Invoke-Edition 'PS5 package build' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$buildScript,'-RepositoryRoot',$RepositoryRoot,'-OutputRoot',$ps5Root,'-ReceiptPath',$ps5ReceiptPath)
$ps5Receipt=Get-Content -LiteralPath $ps5ReceiptPath -Raw|ConvertFrom-Json
Invoke-Edition 'PS7 verification of PS5 package' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$verifyScript,'-BundleRoot',[string]$ps5Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps5Receipt.attestationPinSha256)

[pscustomobject]@{ps7Build=$ps7Receipt;ps5Build=$ps5Receipt;crossEditionVerified=$true}
