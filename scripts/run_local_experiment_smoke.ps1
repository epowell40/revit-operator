[CmdletBinding()]
param(
  [switch]$DisposableExperiment,
  [string[]]$BackendTest = @(),
  [string[]]$NativeTestClass = @(),
  [ValidateSet(2023, 2024, 2025, 2026, 2027)]
  [int]$RevitYear = 2024,
  [switch]$ListTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $DisposableExperiment) {
  throw 'Opt in with -DisposableExperiment. This smoke suite is not release qualification.'
}
if (-not $ListTests -and $BackendTest.Count -eq 0) {
  throw 'Supply -BackendTest with the changed behavior and neighboring test files.'
}

# One implementation, either supported layout; never runs the other composition.
$repoRoot = Split-Path -Parent $PSScriptRoot
$appsRoot = if (Test-Path -LiteralPath (Join-Path $repoRoot 'apps/operator-backend')) {
  Join-Path $repoRoot 'apps'
} else { $repoRoot }
$backendRoot = Join-Path $appsRoot 'operator-backend'
$nativeRoot = Join-Path $appsRoot 'revit-bridge-addin/RevitBridge.Common.Tests'

# Reuse existing executable boundaries, not another manifest/certification layer.
$backendTests = @(@(
  'direct_revit_execution_authorization.test.ts',
  'assignment_kernel_v2.test.ts',
  'assignment_kernel_v2_controls.test.ts',
  'assignment_typed_native_settlement.test.ts',
  'direct_revit_bridge.test.ts'
) + $BackendTest | Sort-Object -Unique)
$nativeClasses = @(@(
  'OperatorWriteGrantAdmissionTests',
  'OperatorNativeExecutionAttestationAuthorityTests',
  'OperatorNativeMutationScopePolicyTests',
  'OperatorAttemptSettlementTests'
) + $NativeTestClass | Sort-Object -Unique)
foreach ($name in $backendTests) {
  if ($name -cnotmatch '^[a-zA-Z0-9_-]+\.test\.ts$' -or
      -not (Test-Path -LiteralPath (Join-Path $backendRoot "test/$name") -PathType Leaf)) {
    throw "Missing or invalid backend test filename: $name"
  }
}
foreach ($name in $nativeClasses) {
  if ($name -cnotmatch '^[a-zA-Z][a-zA-Z0-9_]*$' -or
      -not (Test-Path -LiteralPath (Join-Path $nativeRoot "$name.cs") -PathType Leaf)) {
    throw "Missing or invalid native test class: $name"
  }
}
$framework = if ($RevitYear -le 2024) { 'net48' } elseif ($RevitYear -le 2026) { 'net8.0-windows' } else { 'net10.0-windows' }
Write-Host "LOCAL EXPERIMENT ONLY: $repoRoot; Revit $RevitYear; $framework"
Write-Host ('Backend tests: ' + ($backendTests -join ', '))
Write-Host ('Native classes: ' + ($nativeClasses -join ', '))
if ($ListTests) { return }

function Invoke-Checked([string]$Name, [scriptblock]$Action) {
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $global:LASTEXITCODE = 0
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
  } finally {
    $timer.Stop()
    Write-Host ('EXPERIMENT_TIMING name="{0}" elapsed_seconds={1:N1}' -f $Name, $timer.Elapsed.TotalSeconds)
  }
}

Push-Location $backendRoot
try {
  Invoke-Checked 'backend build' { & npm run build }
  $compiled = @($backendTests | ForEach-Object { 'dist/test/' + $_.Replace('.ts', '.js') })
  Invoke-Checked 'backend focused safety and changed tests' {
    & node scripts/run-tests.mjs --jobs=4 @compiled
  }
} finally { Pop-Location }

$nativeProject = Join-Path $nativeRoot 'RevitBridge.Common.Tests.csproj'
$filter = @($nativeClasses | ForEach-Object { "FullyQualifiedName~RevitBridge.Common.Tests.$_" }) -join '|'
Invoke-Checked 'native safety and changed tests' {
  & dotnet test $nativeProject -c Release -f $framework "-p:RevitYear=$RevitYear" `
    --nologo --filter $filter --disable-build-servers -p:UseSharedCompilation=false -m:1
}
Write-Host 'PASS: selected deterministic checks only. Verify exact disposable fixture, loaded link, source and installed provenance before live work. No release qualification.'
