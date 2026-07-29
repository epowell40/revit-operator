[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InputManifestPath,
  [Parameter(Mandatory)][string]$OutputRoot,
  [Parameter(Mandatory)][string]$SignToolPath,
  [Parameter(Mandatory)][string]$SigningThumbprint,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [Parameter(Mandatory)][scriptblock]$ManagedCodeInspector
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build_saferead_package_v2.ps1') @PSBoundParameters
return
