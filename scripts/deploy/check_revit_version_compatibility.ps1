[CmdletBinding()]
param(
  [string[]]$RevitYear = @("2023", "2024", "2025", "2026", "2027"),
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release",
  [switch]$SkipMissing,
  [string]$DotNetPath = "dotnet",
  [string]$Revit2027DotNetPath = ""
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
  $framework = switch ($yearNumber) {
    2023 { "net48" }; 2024 { "net48" }; 2025 { "net8.0-windows" }; 2026 { "net8.0-windows" }; 2027 { "net10.0-windows" }
    default { throw "Unsupported Revit year: $year" }
  }
  $property = if ($framework -eq "net48") { "RevitApiPathNet48=$apiPath" } elseif ($framework -eq "net10.0-windows") { "RevitApiPathNet10=$apiPath" } else { "RevitApiPathNet8=$apiPath" }

  $targetDotNetPath = if ($year -eq "2027" -and -not [string]::IsNullOrWhiteSpace($Revit2027DotNetPath)) { $Revit2027DotNetPath } else { $DotNetPath }
  # The 2027 target graph must not replace committed net48/net8 dependency locks.
  $lockArgs = if ($year -eq "2027") { @('-p:NuGetLockFilePath=obj/Revit2027/packages.lock.json', '-p:RestorePackagesWithLockFile=true') } else { @() }
  Write-Host "Building Revit $year compatibility target ($framework) with '$targetDotNetPath'..."
  & $targetDotNetPath build $project -c $Configuration -f $framework "-p:RevitYear=$year" "-p:RevitVersion=$year" "-p:$property" @lockArgs --nologo --verbosity:minimal
  if ($LASTEXITCODE -ne 0) { throw "Revit $year compatibility build failed with exit code $LASTEXITCODE." }
  $results += [pscustomobject]@{ RevitYear = $year; Framework = $framework; Status = "Passed"; ApiPath = $apiPath }
}

$results | Format-Table -AutoSize
if (@($results | Where-Object { $_.Status -eq "Passed" }).Count -eq 0) { throw "No Revit compatibility target was built." }
Write-Host "Supported Revit compatibility gate passed."
