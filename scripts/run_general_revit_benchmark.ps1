[CmdletBinding()]
param(
  [ValidateSet("smoke", "redline", "long-horizon", "production", "code-execution", "full")]
  [string]$Suite = "smoke",
  [string]$Sidecar = "http://127.0.0.1:3908",
  [switch]$Apply,
  [switch]$RequireCompletion,
  [switch]$ListCases,
  [string]$Baseline = "",
  [string]$Label = ""
)

$ErrorActionPreference = "Stop"
$publicRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $publicRoot "apps\operator-backend"
$outputDir = Join-Path $backendRoot "local-work\benchmarks\general-revit"

if (-not (Test-Path -LiteralPath $backendRoot)) {
  throw "Operator backend was not found at $backendRoot"
}

$runnerArgs = @(
  "run", "probe:general-revit-capabilities", "--",
  "--suite", $Suite,
  "--sidecar", $Sidecar,
  "--output-dir", $outputDir
)
if ($Apply) { $runnerArgs += "--apply" }
if ($RequireCompletion) { $runnerArgs += "--require-completion" }
if ($ListCases) { $runnerArgs += "--list-cases" }
if ($Baseline) { $runnerArgs += @("--baseline", (Resolve-Path -LiteralPath $Baseline).Path) }
if ($Label) { $runnerArgs += @("--label", $Label) }

Push-Location $backendRoot
try {
  & npm @runnerArgs
  $benchmarkExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($benchmarkExitCode -ne 0) {
  throw "The benchmark reported one or more refused or failed cases. See $outputDir for the truthful result."
}

if (-not $ListCases) {
  Write-Host "Benchmark summary: $(Join-Path $outputDir 'latest.md')"
  Write-Host "Machine-readable result: $(Join-Path $outputDir 'latest.json')"
}
