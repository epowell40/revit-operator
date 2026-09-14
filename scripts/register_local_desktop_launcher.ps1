[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$LauncherPath,
  [ValidateSet('User', 'Process')]
  [string]$EnvironmentTarget = 'User'
)

$ErrorActionPreference = 'Stop'

# Revit checks this explicit setting before an older installed package's shim.
# Registration is separate from process ownership: never stop a different
# Sidecar or weaken its release checks just to make the ribbon button open.
$resolvedLauncher = (Resolve-Path -LiteralPath $LauncherPath -ErrorAction Stop).ProviderPath
if (-not (Test-Path -LiteralPath $resolvedLauncher -PathType Leaf) -or
    [IO.Path]::GetExtension($resolvedLauncher) -ine '.ps1') {
  throw 'The local Operator launcher must be an existing PowerShell script.'
}

$previousLauncher = [Environment]::GetEnvironmentVariable('OPERATOR_DESKTOP_LAUNCHER_PATH', $EnvironmentTarget)
[Environment]::SetEnvironmentVariable('OPERATOR_DESKTOP_LAUNCHER_PATH', $resolvedLauncher, $EnvironmentTarget)
if ([Environment]::GetEnvironmentVariable('OPERATOR_DESKTOP_LAUNCHER_PATH', $EnvironmentTarget) -cne $resolvedLauncher) {
  throw 'The local Operator launcher registration could not be verified.'
}

[pscustomobject]@{
  launcher_path = $resolvedLauncher
  previous_launcher_path = $previousLauncher
  environment_target = $EnvironmentTarget
} | ConvertTo-Json -Compress
