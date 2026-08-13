[CmdletBinding()]
param(
  [ValidateSet("smoke", "redline", "challenge", "terse", "research", "long-horizon", "production", "code-execution", "full")]
  [string]$Suite = "smoke",
  [string]$Fixture = "",
  [string]$Sidecar = "http://127.0.0.1:3907",
  [int]$TimeoutMs = 300000,
  [switch]$Apply,
  [switch]$Ui,
  [switch]$RequireCompletion,
  [switch]$ListCases,
  [switch]$RescoreOnly,
  [string]$Resume = "",
  [string]$Baseline = "",
  [string]$Label = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $repoRoot "apps\operator-backend"
$outputDir = Join-Path $repoRoot "local-work\benchmarks\general-revit"

if (-not (Test-Path -LiteralPath $backendRoot)) {
  throw "Operator backend was not found at $backendRoot"
}
if ($Fixture -and $Fixture -notin @("snowdon_hvac", "snowdon_plumbing", "snowdon_electrical")) {
  throw "Fixture must be snowdon_hvac, snowdon_plumbing, or snowdon_electrical."
}

$runnerArgs = @(
  "run", "probe:general-revit-capabilities", "--",
  "--suite", $Suite,
  "--sidecar", $Sidecar,
  "--timeout-ms", $TimeoutMs,
  "--output-dir", $outputDir
)
if ($Fixture) { $runnerArgs += @("--fixture", $Fixture) }
if ($Apply) { $runnerArgs += "--apply" }
if ($Ui) { $runnerArgs += "--ui" }
if ($RequireCompletion) { $runnerArgs += "--require-completion" }
if ($ListCases) { $runnerArgs += "--list-cases" }
if ($RescoreOnly) { $runnerArgs += "--rescore-only" }
if ($Resume) { $runnerArgs += @("--resume", (Resolve-Path -LiteralPath $Resume).Path) }
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
