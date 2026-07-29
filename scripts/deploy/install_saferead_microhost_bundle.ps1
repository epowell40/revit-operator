[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Install')][string]$BundleRoot,
  [Parameter(Mandatory, ParameterSetName = 'Install')][string]$AttestationPinSha256,
  [Parameter(Mandatory, ParameterSetName = 'Rollback')][string]$RollbackReleaseId,
  [Parameter(Mandatory)][string]$DestinationRoot,
  [Parameter(Mandatory)][string]$RevitAddinsRoot,
  [scriptblock]$SignatureVerifier,
  [scriptblock]$AssemblyInspector,
  [scriptblock]$ManifestWriter
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install_saferead_package_v2.ps1') @PSBoundParameters
return
