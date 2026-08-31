[CmdletBinding()]
param(
  [ValidateSet("smoke", "redline", "challenge", "terse", "research", "long-horizon", "production", "code-execution", "full")]
  [string]$Suite = "smoke",
  [string]$Fixture = "",
  [string]$FixtureRoot = "C:\Program Files\Autodesk\Revit 2024\Samples",
  [string[]]$Case = @(),
  [ValidateSet("controlled_capability", "ambient_context", "safe_readiness", "committed_apply")]
  [string]$Lane = "safe_readiness",
  [string]$ProtocolV2Envelope = "",
  [switch]$LegacyProtocolV1,
  [switch]$ReleaseCanary,
  [string]$ExternalHoldout = "",
  [string]$OutputDir = "",
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
$backendCandidates = @(
  (Join-Path $repoRoot "apps\operator-backend"),
  (Join-Path $repoRoot "operator-backend")
)
$backendRoot = $backendCandidates |
  Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
  Select-Object -First 1
$resolvedBenchmarkOutputDir = if ($OutputDir) { [IO.Path]::GetFullPath($OutputDir) } else { Join-Path $repoRoot "local-work\benchmarks\general-revit" }

if (-not $backendRoot) {
  throw "Operator backend was not found in any supported repository layout: $($backendCandidates -join ', ')"
}
if ($Fixture -and $Fixture -notin @("snowdon_hvac", "snowdon_plumbing", "snowdon_electrical")) {
  throw "Fixture must be snowdon_hvac, snowdon_plumbing, or snowdon_electrical."
}
if ($ReleaseCanary -and -not $ProtocolV2Envelope) { throw "ReleaseCanary requires ProtocolV2Envelope." }
if (-not $ListCases -and -not $ProtocolV2Envelope -and -not $LegacyProtocolV1) { throw "New benchmark runs require ProtocolV2Envelope. Use LegacyProtocolV1 only for retained historical flights." }
if ($ReleaseCanary -and $Resume) { throw "ReleaseCanary is non-resumed by default." }
if (($Lane -eq "committed_apply") -ne [bool]$Apply) { throw "Lane committed_apply and Apply must be selected together." }
if ($ExternalHoldout -and -not $OutputDir) { throw "ExternalHoldout requires an explicit external OutputDir." }

$runnerArgs = @(
  "run", "probe:general-revit-capabilities", "--",
  "--suite", $Suite,
  "--sidecar", $Sidecar,
  "--timeout-ms", $TimeoutMs,
  "--output-dir", $resolvedBenchmarkOutputDir
)
if ($Fixture) { $runnerArgs += @("--fixture", $Fixture) } elseif ($Lane -ne "ambient_context") { $runnerArgs += "--orchestrate-fixtures" }
$runnerArgs += @("--fixture-root", $FixtureRoot)
if ($Case.Count -gt 0) { $runnerArgs += @("--case", ($Case -join ",")) }
if ($ProtocolV2Envelope) { $runnerArgs += @("--protocol-v2-envelope", (Resolve-Path -LiteralPath $ProtocolV2Envelope).Path, "--lane", $Lane) }
if ($LegacyProtocolV1) { $runnerArgs += "--legacy-protocol-v1" }
if ($ReleaseCanary) { $runnerArgs += "--release-canary" }
if ($ExternalHoldout) { $runnerArgs += @("--external-holdout", (Resolve-Path -LiteralPath $ExternalHoldout).Path) }
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
  throw "The benchmark reported one or more refused or failed cases. See $resolvedBenchmarkOutputDir for the truthful result."
}

if (-not $ListCases) {
  Write-Host "Benchmark summary: $(Join-Path $resolvedBenchmarkOutputDir 'latest.md')"
  Write-Host "Machine-readable result: $(Join-Path $resolvedBenchmarkOutputDir 'latest.json')"
}
