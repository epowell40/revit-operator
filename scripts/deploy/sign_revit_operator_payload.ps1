[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadDir,
  [Parameter(Mandatory = $true)]
  [string]$SigningThumbprint,
  [Parameter(Mandatory = $true)]
  [string]$SignToolPath,
  [string]$TimestampUrl = "http://ts.ssl.com"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PayloadDir = [IO.Path]::GetFullPath($PayloadDir)
if (-not (Test-Path -LiteralPath $PayloadDir -PathType Container)) { throw "Revit Operator payload directory not found: $PayloadDir" }
if (-not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) { throw "signtool.exe not found: $SignToolPath" }
if ($SigningThumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw "SigningThumbprint must be a 40-character certificate SHA-1 thumbprint." }

$targets = @(Get-ChildItem -LiteralPath $PayloadDir -File | Where-Object Name -Match '^RevitBridge(?:\.[A-Za-z0-9_-]+)?\.dll$' | Sort-Object Name)
if ($targets.Count -lt 3) {
  throw "Expected at least RevitBridge.dll, RevitBridge.Logic.dll, and RevitBridge.Common.dll under $PayloadDir; found $($targets.Count)."
}

foreach ($target in $targets) {
  & $SignToolPath sign /sha1 $SigningThumbprint /tr $TimestampUrl /td sha256 /fd sha256 $target.FullName
  if ($LASTEXITCODE -ne 0) { throw "signtool failed for $($target.FullName) with exit code $LASTEXITCODE" }
  & $SignToolPath verify /pa /v $target.FullName
  if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed for $($target.FullName)" }
  $signature = Get-AuthenticodeSignature -LiteralPath $target.FullName
  if ("$($signature.Status)" -ne "Valid") { throw "PowerShell Authenticode validation failed for $($target.FullName): $($signature.StatusMessage)" }
  if ($signature.SignerCertificate.Thumbprint -ne $SigningThumbprint) { throw "Unexpected signer for $($target.FullName): $($signature.SignerCertificate.Thumbprint)" }
  Write-Host "Signed and verified: $($target.FullName)"
}

Write-Host "Signed $($targets.Count) first-party Revit Operator assemblies."
