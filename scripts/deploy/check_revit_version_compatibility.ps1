[CmdletBinding()]
param(
  [string[]]$RevitYear = @("2023", "2024", "2025", "2026"),
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release",
  [switch]$SkipMissing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$projectCandidates = @(
  (Join-Path $repoRoot "revit-bridge-addin/RevitBridge/RevitBridge.csproj"),
  (Join-Path $repoRoot "apps/revit-bridge-addin/RevitBridge/RevitBridge.csproj")
)
$project = $projectCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $project) { throw "Could not locate RevitBridge.csproj from $repoRoot." }

$results = @()
foreach ($year in @($RevitYear | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object -Unique)) {
  $apiPath = "C:\Program Files\Autodesk\Revit $year"
  if (-not (Test-Path -LiteralPath $apiPath -PathType Container)) {
    if ($SkipMissing) {
      $results += [pscustomobject]@{ RevitYear = $year; Framework = ""; Status = "SkippedMissing"; ApiPath = $apiPath }
      continue
    }
    throw "Revit $year API path is missing: $apiPath"
  }

  $yearNumber = 0
  if (-not [int]::TryParse($year, [ref]$yearNumber)) { throw "Invalid Revit year '$year'." }
  $framework = if ($yearNumber -ge 2025) { "net8.0-windows" } else { "net48" }
  $property = if ($framework -eq "net48") { "RevitApiPathNet48=$apiPath" } else { "RevitApiPathNet8=$apiPath" }

  Write-Host "Building Revit $year compatibility target ($framework)..."
  & dotnet build $project -c $Configuration -f $framework "-p:RevitYear=$year" "-p:RevitVersion=$year" "-p:$property" --nologo --verbosity:minimal
  if ($LASTEXITCODE -ne 0) { throw "Revit $year compatibility build failed with exit code $LASTEXITCODE." }
  $results += [pscustomobject]@{ RevitYear = $year; Framework = $framework; Status = "Passed"; ApiPath = $apiPath }
}

$results | Format-Table -AutoSize
if (@($results | Where-Object { $_.Status -eq "Passed" }).Count -eq 0) { throw "No Revit compatibility target was built." }
Write-Host "Supported Revit compatibility gate passed."
